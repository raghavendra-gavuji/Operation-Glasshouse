import { fileURLToPath } from "node:url";
import path from "node:path";
import dotenv from "dotenv";

export const projectRoot = fileURLToPath(new URL("..", import.meta.url));

export interface ServerConfig {
  root: string;
  host: string;
  port: number;
  production: boolean;
  apiKey: string;
  models: { text: string; live: string; image: string; tts: string };
}

export const limits = Object.freeze({
  requestBytes: 256 * 1024,
  websocketBytes: 384 * 1024,
  socketBufferBytes: 1024 * 1024,
  requestTimeoutMs: 30_000,
  ttsTimeoutMs: 45_000,
  liveSetupTimeoutMs: 20_000,
  encounterMs: 180_000,
  toolTimeoutMs: 10_000,
  heartbeatMs: 15_000,
  maxLiveConnections: 2,
  maxRequests: 4,
  maxPendingTools: 12,
  maxAudioBytes: 32_000,
  maxVideoBytes: 196_608,
  maxGeneratedAudioBytes: 8 * 1024 * 1024,
  maxTranscriptChars: 12_000,
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env, root = projectRoot): ServerConfig {
  const values: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) values[name] = value;
  const loaded = dotenv.config({ path: env.GLASSHOUSE_ENV_FILE || path.join(root, ".env"), processEnv: values });
  const missing = loaded.error && "code" in loaded.error && loaded.error.code === "ENOENT";
  if (loaded.error && (env.GLASSHOUSE_ENV_FILE || !missing)) {
    throw new Error("Unable to read the configured server environment file.");
  }
  const port = Number(values.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535.");
  }
  const host = values.HOST || "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("Operation Glasshouse only supports a loopback HOST.");
  }
  const model = (name: string, fallback: string) => {
    const value = values[name] || fallback;
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(value)) throw new Error(`Invalid ${name} model identifier.`);
    return value;
  };
  return {
    root,
    host,
    port,
    production: values.NODE_ENV === "production",
    apiKey: (values.GEMINI_API_KEY || "").trim(),
    models: {
      text: model("GEMINI_TEXT_MODEL", "gemini-3.8-flash"),
      live: model("GEMINI_LIVE_MODEL", "gemini-3.8-live"),
      image: model("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-lite-image"),
      tts: model("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts"),
    },
  };
}
