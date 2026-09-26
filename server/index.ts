import { existsSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type ErrorRequestHandler, type Request, type RequestHandler, type Response } from "express";
import { WebSocket, WebSocketServer } from "ws";
import type { ViteDevServer } from "vite";
import type { AssetManifest } from "../shared/types";
import { ArtError, getArtGenerationStatus, readAssets, scheduleFloorAssets, type ArtGenerationStatus } from "./art";
import { RequestGate, TokenBucket, withDeadline } from "./bounds";
import { limits, loadConfig, type ServerConfig } from "./config";
import { errorStatus, safeLog, ServiceError } from "./errors";
import { createGeminiService, type GeminiService } from "./gemini";
import { LiveBridge } from "./live";
import {
  assetManifestSchema, dialogueRequestSchema, directorContextSchema,
  parseInput, prefetchRequestSchema, ttsRequestSchema,
} from "./schemas";

export interface AssetService {
  readAssets(): Promise<AssetManifest>;
  scheduleFloorAssets(floors: number[]): Promise<void>;
  getArtGenerationStatus(): ArtGenerationStatus;
}
export interface GlasshouseServerOptions {
  config?: ServerConfig;
  gemini?: GeminiService;
  assets?: AssetService;
  web?: boolean;
}
export interface GlasshouseServer {
  app: express.Express;
  server: Server;
  listen(): Promise<AddressInfo>;
  close(): Promise<void>;
}

export function localRequestAllowed(
  headers: IncomingHttpHeaders, remoteAddress: string | undefined, port: number, requireOrigin = false, publicOrigin?: string,
): boolean {
  if (!remoteAddress || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remoteAddress)) return false;
  const host = headers.host?.toLowerCase();
  const match = host && /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?$/.exec(host);
  if (!match || Number(match[2] || 80) !== port) return false;
  const expectedOrigin = `http://${match[1]}${port === 80 ? "" : `:${port}`}`;
  const fetchSite = headers["sec-fetch-site"];
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = headers.origin;
  if (requireOrigin && !origin) return false;
  return origin === undefined || origin.toLowerCase() === expectedOrigin || origin.toLowerCase() === publicOrigin;
}

function publicError(error: unknown): ServiceError {
  if (error instanceof ServiceError) return error;
  if (error instanceof ArtError) {
    if (error.code === "CONFIGURATION") return new ServiceError(503, "ART_NOT_CONFIGURED", "Missing or invalid image-generation configuration. Cached art remains available.");
    if (error.code === "COOLDOWN") return new ServiceError(429, "ART_COOLDOWN", "Artwork generation is cooling down after a failure. Check the artwork status before retrying.", true);
    if (error.code === "INVALID_FLOORS") return new ServiceError(400, "INVALID_FLOORS", "Choose one to twelve integer floors between 1 and 12.");
    return new ServiceError(502, "ART_UNAVAILABLE", "The artwork request failed. See the artwork generation status for details.", error.retryable);
  }
  const status = errorStatus(error);
  if (status === 413) return new ServiceError(413, "BODY_TOO_LARGE", "The request body exceeds the local API size limit.");
  if (status === 415) return new ServiceError(415, "UNSUPPORTED_ENCODING", "Send uncompressed application/json to this endpoint.");
  if (status === 400 || error instanceof SyntaxError) return new ServiceError(400, "INVALID_JSON", "Send a valid JSON request body.");
  if (status === 404) return new ServiceError(404, "NOT_FOUND", "The requested resource does not exist.");
  return new ServiceError(500, "INTERNAL_ERROR", "The local server could not complete the request.");
}

export async function createGlasshouseServer(options: GlasshouseServerOptions = {}): Promise<GlasshouseServer> {
  const config = options.config ?? loadConfig();
  const gemini = options.gemini ?? createGeminiService(config);
  const assets = options.assets ?? { readAssets, scheduleFloorAssets, getArtGenerationStatus };
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  const server = createServer(app);
  server.headersTimeout = 5000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 64;
  server.maxRequestsPerSocket = 200;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.websocketBytes, perMessageDeflate: false });
  const bridges = new Set<LiveBridge>();
  const requests = new Set<AbortController>();
  const gate = new RequestGate(limits.maxRequests);
  const liveStarts = new TokenBucket(4, 6 / 60);
  const liveHourly = new TokenBucket(24, 24 / 3600);
  let vite: ViteDevServer | undefined;
  let shuttingDown = false;
  const actualPort = () => {
    const address = server.address();
    return address && typeof address !== "string" ? address.port : config.port;
  };

  app.use((request, response, next) => {
    if (!localRequestAllowed(request.headers, request.socket.remoteAddress, actualPort(), false, config.publicOrigin)) {
      next(new ServiceError(403, "LOCAL_ORIGIN_REQUIRED", "Use this server's loopback URL from the same browser origin."));
      return;
    }
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });
  app.use("/api", (request, response, next) => {
    response.setHeader("Cache-Control", "no-store");
    response.vary("Origin");
    if (request.headers.origin) response.setHeader("Access-Control-Allow-Origin", request.headers.origin);
    if (shuttingDown) return next(new ServiceError(503, "SHUTTING_DOWN", "The local game server is shutting down."));
    if (request.method === "OPTIONS") {
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.sendStatus(204);
      return;
    }
    if (request.method === "POST" && !request.is("application/json")) {
      next(new ServiceError(415, "JSON_REQUIRED", "This endpoint accepts application/json only."));
      return;
    }
    next();
  });
  app.use("/api", express.json({ limit: limits.requestBytes, strict: true, inflate: false }));

  function route(
    handler: (request: Request, response: Response, signal: AbortSignal) => Promise<void>,
    operation?: "director" | "dialogue" | "tts" | "prefetch",
    timeoutMs: number = limits.requestTimeoutMs,
  ): RequestHandler {
    return (request, response, next) => {
      if (requests.size >= limits.maxRequests) {
        next(new ServiceError(429, "SERVER_BUSY", "The local API is busy. Wait for an existing request to finish.", true));
        return;
      }
      const controller = new AbortController();
      requests.add(controller);
      const onAbort = () => controller.abort(new DOMException("Browser request cancelled.", "AbortError"));
      const onClose = () => { if (!response.writableEnded) onAbort(); };
      request.once("aborted", onAbort);
      response.once("close", onClose);
      let release: (() => void) | undefined;
      void (async () => {
        try {
          release = operation ? gate.acquire(operation) : undefined;
          await withDeadline(signal => handler(request, response, signal), timeoutMs, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted && !response.headersSent && !response.destroyed) next(error);
        } finally {
          release?.();
          requests.delete(controller);
          request.removeListener("aborted", onAbort);
          response.removeListener("close", onClose);
        }
      })();
    };
  }

  app.get("/api/health", (_request, response) => {
    response.json({
      configured: Boolean(config.apiKey),
      credentialsValidated: false,
      models: config.models,
      transport: "server-proxy",
      limits: { encounterSeconds: limits.encounterMs / 1000, maxLiveConnections: limits.maxLiveConnections, requestBytes: limits.requestBytes },
      assets: assets.getArtGenerationStatus(),
    });
  });
  app.post("/api/director", route(async (request, response, signal) => {
    const context = parseInput(directorContextSchema, request.body);
    const reply = await gemini.director(context, signal);
    signal.throwIfAborted();
    response.json(reply);
  }, "director"));
  app.post("/api/dialogue", route(async (request, response, signal) => {
    const body = parseInput(dialogueRequestSchema, request.body);
    const reply = await gemini.dialogue(body.context, body.text, signal);
    signal.throwIfAborted();
    response.json(reply);
  }, "dialogue"));
  app.post("/api/tts", route(async (request, response, signal) => {
    const body = parseInput(ttsRequestSchema, request.body);
    const wav = await gemini.tts(body.text, body.voiceName, signal);
    signal.throwIfAborted();
    response.type("audio/wav").send(wav);
  }, "tts", limits.ttsTimeoutMs));
  app.get("/api/assets", route(async (_request, response, signal) => {
    const manifest = await assets.readAssets();
    signal.throwIfAborted();
    const parsed = assetManifestSchema.safeParse(manifest);
    if (!parsed.success) throw new ServiceError(502, "ART_MANIFEST_INVALID", "The generated artwork manifest is invalid.");
    response.json(parsed.data);
  }));
  app.post("/api/assets/prefetch", route(async (request, response, signal) => {
    const { floors } = parseInput(prefetchRequestSchema, request.body);
    const uniqueFloors = [...new Set(floors)];
    await assets.scheduleFloorAssets(uniqueFloors);
    signal.throwIfAborted();
    response.status(202).json({ queued: true, floors: uniqueFloors, status: assets.getArtGenerationStatus() });
  }, "prefetch"));
  app.use("/api", (_request, _response, next) => next(new ServiceError(404, "API_NOT_FOUND", "This game API endpoint does not exist.")));

  server.on("upgrade", (request, socket, head) => {
    const pathname = request.url?.split("?")[0];
    if (pathname !== "/api/live") {
      if (pathname?.startsWith("/api") || !vite) {
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
      return;
    }
    if (shuttingDown || request.method !== "GET" || !localRequestAllowed(request.headers, request.socket.remoteAddress, actualPort(), true, config.publicOrigin)) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    if (wss.clients.size >= limits.maxLiveConnections || !liveStarts.take() || !liveHourly.take()) {
      socket.end("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    wss.handleUpgrade(request, socket, head, peer => wss.emit("connection", peer, request));
  });
  wss.on("connection", peer => {
    let alive = true;
    const bridge = new LiveBridge(gemini, message => {
      if (peer.readyState !== WebSocket.OPEN) return;
      if (peer.bufferedAmount > limits.socketBufferBytes) {
        bridge.stop("The browser connection is too slow. Reconnect explicitly when it recovers.", 1008);
        return;
      }
      peer.send(JSON.stringify(message), error => {
        if (error) {
          safeLog("browser-websocket-send", error);
          bridge.stop("The browser connection failed.", 1011);
        }
      });
    }, (code, reason) => {
      if (peer.readyState === WebSocket.OPEN || peer.readyState === WebSocket.CONNECTING) peer.close(code, reason.slice(0, 100));
    });
    bridges.add(bridge);
    const heartbeat = setInterval(() => {
      if (peer.readyState !== WebSocket.OPEN) return;
      if (!alive) {
        bridge.stop("The browser stopped responding.", 1001);
        peer.terminate();
        return;
      }
      alive = false;
      peer.ping();
    }, limits.heartbeatMs);
    peer.on("pong", () => { alive = true; });
    peer.on("message", (data, binary) => {
      if (binary) return bridge.protocolError();
      let message: unknown;
      try { message = JSON.parse(data.toString()); }
      catch { bridge.protocolError(); return; }
      bridge.receive(message);
    });
    peer.on("close", () => {
      clearInterval(heartbeat);
      bridge.stop("Browser disconnected.");
      bridges.delete(bridge);
    });
    peer.on("error", error => {
      safeLog("browser-websocket", error);
      bridge.stop("The browser connection failed.", 1011);
    });
  });

  try {
    if (options.web !== false) {
      app.use("/generated", express.static(path.join(config.root, "public", "generated"), {
        dotfiles: "deny", index: false, fallthrough: false,
        setHeaders: (response, filename) => response.setHeader("Cache-Control", filename.endsWith("manifest.json") ? "no-store" : "public, max-age=31536000, immutable"),
      }));
      const dist = path.join(config.root, "dist");
      if (!config.production || !existsSync(path.join(dist, "index.html"))) {
        const { createServer: createViteServer } = await import("vite");
        vite = await createViteServer({
          root: config.root, appType: "spa",
          server: {
            middlewareMode: true, hmr: { server },
            fs: { strict: true, allow: [config.root], deny: [".env", ".env.*", "**/*.env", "*.{crt,pem}", "**/.git/**", "**/server/**"] },
          },
        });
        app.use(vite.middlewares);
      } else {
        app.use(express.static(dist, { dotfiles: "deny", index: false }));
        app.get("*", (_request, response) => response.sendFile(path.join(dist, "index.html")));
      }
    }
  } catch (error) {
    try { await close(); } catch (cleanupError) { safeLog("startup-cleanup", cleanupError); }
    throw error;
  }
  app.use((_request, _response, next) => next(new ServiceError(404, "NOT_FOUND", "The requested resource does not exist.")));
  const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const safe = publicError(error);
    safeLog("http", safe);
    if (response.headersSent || response.destroyed) return;
    if (safe.status === 429) response.setHeader("Retry-After", "10");
    response.status(safe.status).json({ error: { code: safe.code, message: safe.message, retryable: safe.retryable } });
  };
  app.use(errorHandler);

  return {
    app,
    server,
    async listen() {
      return await new Promise<AddressInfo>((resolve, reject) => {
        const onError = (error: Error) => { server.removeListener("listening", onListening); reject(error); };
        const onListening = () => {
          server.removeListener("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") return reject(new Error("The loopback server did not bind a TCP port."));
          resolve(address);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(config.port, config.host);
      });
    },
    close,
  };

  async function close(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const controller of requests) controller.abort();
    for (const bridge of bridges) bridge.stop("The game server is shutting down.", 1001);
    const forceClose = setTimeout(() => { for (const peer of wss.clients) peer.terminate(); }, 1000);
    try {
      const results = await Promise.allSettled([
        vite?.close(),
        new Promise<void>(resolve => wss.close(() => resolve())),
        new Promise<void>((resolve, reject) => {
          if (!server.listening) return resolve();
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        }),
      ]);
      const failed = results.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    } finally {
      clearTimeout(forceClose);
    }
  }
}

async function main(): Promise<void> {
  const game = await createGlasshouseServer();
  let address: AddressInfo;
  try {
    address = await game.listen();
  } catch (error) {
    try { await game.close(); } catch (cleanupError) { safeLog("startup-cleanup", cleanupError); }
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EADDRINUSE") {
      const port = "port" in error && typeof error.port === "number" ? ` ${error.port}` : "";
      throw new ServiceError(503, "PORT_IN_USE", `Port${port} is already in use. The existing server was left running. Use its URL, stop it explicitly, or choose a different PORT before starting Glasshouse again.`);
    }
    throw error;
  }
  console.info(`Operation Glasshouse listening at http://${address.address.includes(":") ? `[${address.address}]` : address.address}:${address.port}`);
  const shutdown = () => { void game.close().catch(error => { safeLog("shutdown", error); process.exitCode = 1; }); };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => {
    safeLog("startup", error);
    if (error instanceof ServiceError) console.error(error.message);
    process.exitCode = 1;
  });
}
