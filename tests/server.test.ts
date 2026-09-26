import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { LiveServerMessage, type LiveConnectParameters } from "@google/genai";
import { WebSocket } from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FACTS, NPCS } from "../shared/story";
import type { ConversationContext, DirectorContext, DirectorReply, ServerLiveMessage } from "../shared/types";
import { RequestGate, TokenBucket, withDeadline } from "../server/bounds";
import { limits, loadConfig, projectRoot, type ServerConfig } from "../server/config";
import { ServiceError, providerError } from "../server/errors";
import { createGeminiService, parseStructuredResponse, type GeminiService, type GeminiTransport, type LiveSession } from "../server/gemini";
import { createGlasshouseServer, localRequestAllowed, type AssetService, type GlasshouseServer } from "../server/index";
import { LiveBridge } from "../server/live";
import { actionIsAllowed, allowedActionTypes, conversationInstruction, conversationSnapshot } from "../server/prompts";
import { clientLiveMessageSchema, conversationContextSchema, directorReplySchema, generationJsonSchema } from "../server/schemas";
import { generatedAudioToWav, pcmToWav, wavToPcm } from "../server/wav";

function context(npcId = "priya"): ConversationContext {
  const npc = NPCS.find(candidate => candidate.id === npcId);
  if (!npc) throw new Error("Unknown test NPC.");
  return {
    npc: structuredClone(npc), suspicion: 0, memory: "",
    cover: { name: "", company: "", role: "", host: "", callback: "", employeeId: "", ticket: "" },
    claims: [], knownFacts: [], heardRumors: [], visitorLog: null, authorization: null,
    carryingCard: false, secretKnown: false, floor: npc.floor || 1, clockMinute: 540,
  };
}
function directorContext(): DirectorContext {
  const npc = context().npc;
  return {
    floor: {
      id: 1, name: "Reception", subtitle: "Meridian", width: 32, height: 28,
      tiles: Array.from({ length: 32 * 28 }, () => "floor"), rooms: [],
      spawn: { x: 2, y: 2 }, elevator: { x: 3, y: 3 },
      palette: { floor: "#222", wall: "#444", accent: "#fff" },
    },
    player: { x: 10, y: 22, facing: "north", moving: false, carryingCard: false },
    npcs: [{
      definition: npc,
      state: {
        id: npc.id, ...npc.home, floor: 1, suspicion: 0, intent: "idle", intentReason: "",
        memory: "", bubble: null, bubbleUntil: 0, facing: "south", lastEncounterAt: -1000, reported: false,
      },
    }],
    events: [], alert: false,
  };
}
const directorReply: DirectorReply = { intents: [{ npcId: "priya", action: "idle", reason: "At reception." }], chatter: [], source: "gemini" };
const config: ServerConfig = {
  root: projectRoot, host: "127.0.0.1", port: 0, production: false, apiKey: "server-only-test-value",
  models: { text: "gemini-3.8-flash", live: "gemini-3.8-live", image: "gemini-3.1-flash-lite-image", tts: "gemini-3.8-flash-tts" },
};
const assets: AssetService = {
  readAssets: async () => ({ version: 1, status: "empty", assets: [] }),
  scheduleFloorAssets: async () => {},
  getArtGenerationStatus: () => ({ queued: [], running: [], failed: [] }),
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stubService() {
  const session = {
    sendClientContent: vi.fn<LiveSession["sendClientContent"]>(),
    sendRealtimeInput: vi.fn<LiveSession["sendRealtimeInput"]>(),
    sendToolResponse: vi.fn<LiveSession["sendToolResponse"]>(),
    close: vi.fn(),
  };
  let parameters: Omit<LiveConnectParameters, "model"> | undefined;
  const service = {
    director: vi.fn<GeminiService["director"]>(async () => directorReply),
    dialogue: vi.fn<GeminiService["dialogue"]>(async () => ({ reply: "Who are you here to see?", actions: [] })),
    tts: vi.fn<GeminiService["tts"]>(async () => pcmToWav(Buffer.alloc(640))),
    connectLive: vi.fn<GeminiService["connectLive"]>(async value => { parameters = value; return session; }),
  };
  return {
    service, session,
    get parameters() { if (!parameters) throw new Error("No Live connect yet."); return parameters; },
  };
}
function modelMessage(input: Partial<LiveServerMessage>): LiveServerMessage {
  return Object.assign(new LiveServerMessage(), input);
}
function response(value: unknown) {
  return { candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }] };
}

beforeEach(() => { vi.spyOn(console, "warn").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("configuration, request schemas and budgets", () => {
  it("loads a selected dotenv file without exposing or overriding process values", async () => {
    await mkdir(path.join(projectRoot, ".cache"), { recursive: true });
    const root = await mkdtemp(path.join(projectRoot, ".cache", "server-env-"));
    try {
      await writeFile(path.join(root, ".env"), "GEMINI_API_KEY=test-only-local\nPORT=4317\n");
      await writeFile(path.join(root, "selected.env"), "GEMINI_API_KEY=test-only-selected\nPORT=4320\n");
      expect(loadConfig({ PORT: "4322" }, root).port).toBe(4322);
      const selected = loadConfig({ GLASSHOUSE_ENV_FILE: path.join(root, "selected.env") }, root);
      expect(selected.port).toBe(4320);
      expect(Boolean(selected.apiKey)).toBe(true);
      expect(() => loadConfig({ GLASSHOUSE_ENV_FILE: path.join(root, "missing.env") }, root)).toThrow("environment file");
      expect(() => loadConfig({ HOST: "0.0.0.0" }, root)).toThrow("loopback");
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("accepts remote Meera and rejects malformed media, nulls and unbounded contexts", () => {
    expect(conversationContextSchema.safeParse(context("meera")).success).toBe(true);
    expect(conversationContextSchema.safeParse({ ...context(), memory: "a".repeat(6001) }).success).toBe(false);
    for (const value of [null, [], { type: "audio", data: "not base64", sampleRate: 16000 },
      { type: "audio", data: "AAAA", sampleRate: 48000 }, { type: "text", text: "" }]) {
      expect(clientLiveMessageSchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires a literal loopback Host and the exact browser origin", () => {
    expect(localRequestAllowed({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" }, "127.0.0.1", 4317, true)).toBe(true);
    expect(localRequestAllowed({ host: "[::1]:4317", origin: "http://[::1]:4317" }, "::1", 4317, true)).toBe(true);
    for (const headers of [
      { host: "attacker.example:4317" }, { host: "localhost:99999" }, { host: "localhost:4317", origin: "null" },
      { host: "localhost:4317", origin: "http://localhost:9999" },
      { host: "localhost:4317", "sec-fetch-site": "cross-site" }, { host: "localhost:4317" },
    ]) expect(localRequestAllowed(headers, "127.0.0.1", 4317, true)).toBe(false);
    expect(localRequestAllowed({ host: "localhost:4317" }, "10.0.0.2", 4317)).toBe(false);
  });

  it("bounds concurrency and refills token buckets without growing per-client maps", () => {
    let now = 0;
    const bucket = new TokenBucket(2, 1, () => now);
    expect(bucket.take(2)).toBe(true);
    expect(bucket.take()).toBe(false);
    now = 1000;
    expect(bucket.take()).toBe(true);
    const gate = new RequestGate(1);
    const release = gate.acquire("director");
    expect(() => gate.acquire("dialogue")).toThrow("still running");
    release();
    release();
    expect(gate.acquire("dialogue")).toBeTypeOf("function");
  });

  it("aborts a bounded request even when the operation ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const pending = deferred<string>();
      let signal: AbortSignal | undefined;
      const result = withDeadline(value => { signal = value; return pending.promise; }, 20).catch(error => error);
      await vi.advanceTimersByTimeAsync(21);
      expect((await result).code).toBe("REQUEST_TIMEOUT");
      expect(signal?.aborted).toBe(true);
      pending.resolve("late");
    } finally { vi.useRealTimers(); }
  });
});

describe("Gemini response contracts and NPC authority", () => {
  it.each([
    ["priya", "register"], ["dev", "authorize"], ["anita", "authorize"], ["ramesh", "issue_card"],
    ["kulkarni", "discover"], ["meera", "security_resolution"],
  ] as const)("gives %s only its canonical role power", (id, power) => {
    const allowed = allowedActionTypes(context(id));
    expect(allowed).toContain(power);
    for (const other of ["register", "authorize", "issue_card", "security_resolution"] as const) {
      if (other !== power) expect(allowed).not.toContain(other);
    }
  });

  it("does not leak global cover, undelivered rumors or locked Handler knowledge", () => {
    const visitor = context("kulkarni");
    visitor.npc.knowledge = visitor.npc.knowledge.filter(id => id !== "handler_secret");
    visitor.cover.name = "UNINTRODUCED_ALIAS";
    visitor.secretKnown = true;
    visitor.knownFacts = FACTS;
    visitor.heardRumors = [{ id: "rumor-1", from: "dev", to: "kulkarni", text: "UNDELIVERED_SECRET", at: 1, delivered: false }];
    const snapshot = JSON.stringify(conversationSnapshot(visitor));
    expect(snapshot).not.toContain("UNINTRODUCED_ALIAS");
    expect(snapshot).not.toContain("UNDELIVERED_SECRET");
    expect(snapshot).not.toContain("handler_secret");
    expect(snapshot).not.toContain("Ashoka Capital");
    expect(conversationInstruction(visitor, true)).not.toContain(FACTS.find(fact => fact.id === "handler_secret")!.text);
    expect(actionIsAllowed({ type: "discover", npcId: "kulkarni", factId: "handler_secret" }, visitor)).toBe(false);
    expect(actionIsAllowed({ type: "authorize", npcId: "kulkarni", name: "Nila" }, visitor)).toBe(false);
    expect(actionIsAllowed({ type: "claim", npcId: "priya", field: "callback", value: "5551234", quote: "5551234" }, context())).toBe(false);
  });

  it("requires normal speech to record claims before questions without extra registration demands", () => {
    const instruction = conversationInstruction(context(), true);
    expect(instruction).toContain("Ordinary visitor identity statements MUST trigger record_identity_claims");
    expect(instruction).toContain("not just the minimum gate requirements");
    expect(instruction).toContain("Do not require a ticket, ID, callback or authorizer for registration");
    expect(instruction).toContain("Never demand identification, documents, photos");
    expect(instruction).toContain("MT-ID-1042");
  });

  it("parses schemaOutput or JSON parts, but rejects malformed/truncated output", () => {
    expect(parseStructuredResponse({ schemaOutput: directorReply }, directorReplySchema)).toEqual(directorReply);
    expect(parseStructuredResponse(response(directorReply), directorReplySchema)).toEqual(directorReply);
    expect(() => parseStructuredResponse(response({ source: "gemini" }), directorReplySchema)).toThrow("invalid");
    expect(() => parseStructuredResponse({
      candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify(directorReply) }] } }],
    }, directorReplySchema)).toThrow("invalid");
    expect(() => parseStructuredResponse({ candidates: [{ content: { parts: [{ text: "```json\n{}\n```" }] } }] }, directorReplySchema)).toThrow("invalid");
  });

  it("uses a compact provider grammar while retaining full post-generation bounds", () => {
    const schema = generationJsonSchema(directorReplySchema);
    expect(schema).toMatchObject({ properties: { source: { type: "string", enum: ["gemini"] }, intents: { type: "array" } } });
    expect(JSON.stringify(schema)).not.toMatch(/"(maxItems|minLength|maxLength|minimum|maximum|pattern|const)":/);
    expect(() => parseStructuredResponse(response({
      ...directorReply, intents: [{ npcId: "priya", action: "idle", reason: "x".repeat(301) }],
    }), directorReplySchema)).toThrow("invalid");
  });

  it("makes one batched director call with LOW reasoning and validates returned NPC IDs", async () => {
    const generate = vi.fn<GeminiTransport["generateContent"]>(async () => response(directorReply));
    const service = createGeminiService(config, { generateContent: generate, connect: vi.fn() });
    expect(await service.director(directorContext(), new AbortController().signal)).toEqual(directorReply);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].config?.thinkingConfig?.thinkingLevel).toBe("LOW");
    expect(generate.mock.calls[0][0].config?.responseJsonSchema).toBeDefined();
    generate.mockResolvedValueOnce(response({ ...directorReply, intents: [{ npcId: "outsider", action: "idle", reason: "Invalid." }] }));
    await expect(service.director(directorContext(), new AbortController().signal)).rejects.toMatchObject({ code: "GEMINI_RESPONSE_INVALID" });
  });

  it("rejects text-dialogue privileges and sanitized provider errors without fallback", async () => {
    const generate = vi.fn<GeminiTransport["generateContent"]>(async () => response({
      reply: "I'll check that.", actions: [{ type: "issue_card", npcId: "anita", name: "Nila" }],
    }));
    const service = createGeminiService(config, { generateContent: generate, connect: vi.fn() });
    await expect(service.dialogue(context("anita"), "Please issue a card.", new AbortController().signal)).rejects.toMatchObject({ code: "GEMINI_RESPONSE_INVALID" });
    generate.mockRejectedValueOnce({ status: 403, message: "secret-provider-details" });
    await expect(service.dialogue(context(), "Hi", new AbortController().signal)).rejects.not.toThrow("secret-provider-details");
    expect(providerError({ status: 429 }).status).toBe(429);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, "GEMINI_REQUEST"], [401, "GEMINI_AUTH"], [403, "GEMINI_AUTH"], [404, "GEMINI_MODEL"], [429, "GEMINI_QUOTA"], [503, "GEMINI_UNAVAILABLE"],
  ])("preserves SDK HTTP %i classification without automatic retries", async (status, code) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: { code: status, message: "PRIVATE_PROVIDER_ERROR" } }),
      { status, headers: { "Content-Type": "application/json" } },
    ));
    const service = createGeminiService(config);
    const result = await service.dialogue(context(), "Hello.", new AbortController().signal).catch(error => error);
    expect(result.code).toBe(code);
    expect(result.message).not.toContain("PRIVATE_PROVIDER_ERROR");
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("converts PCM or WAV exactly once and caches TTS by text and voice", async () => {
    const pcm = Buffer.alloc(8);
    pcm.writeInt16LE(-32768, 0);
    pcm.writeInt16LE(32767, 2);
    const wav = pcmToWav(pcm);
    expect(wavToPcm(wav).pcm.equals(pcm)).toBe(true);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(generatedAudioToWav([{ data: wav.toString("base64"), mimeType: "audio/wav" }]).equals(wav)).toBe(true);
    expect(generatedAudioToWav([{ data: pcm.toString("base64"), mimeType: "audio/pcm;rate=24000" }]).equals(wav)).toBe(true);
    expect(() => generatedAudioToWav([{ data: "AA==", mimeType: "audio/pcm;rate=24000" }])).toThrow("invalid");
    const generate = vi.fn<GeminiTransport["generateContent"]>(async () => ({
      candidates: [{ finishReason: "STOP", content: { parts: [{ inlineData: { mimeType: "audio/wav", data: wav.toString("base64") } }] } }],
    }));
    const service = createGeminiService(config, { generateContent: generate, connect: vi.fn() });
    const signal = new AbortController().signal;
    expect((await service.tts("Welcome.", "Kore", signal)).equals(wav)).toBe(true);
    await service.tts("Welcome.", "Kore", signal);
    await service.tts("Welcome.", "Charon", signal);
    expect(generate).toHaveBeenCalledTimes(2);
    await expect(service.tts("Welcome.", "UnknownVoice", signal)).rejects.toMatchObject({ status: 400 });
  });
});

describe("Live bridge lifecycle and tool acknowledgements", () => {
  const bridges: LiveBridge[] = [];
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { bridges.forEach(bridge => bridge.stop()); bridges.length = 0; vi.useRealTimers(); });

  async function setup(npcId = "priya", options = {}) {
    const stub = stubService();
    const emitted: ServerLiveMessage[] = [];
    const close = vi.fn();
    const bridge = new LiveBridge(stub.service, message => emitted.push(message), close, options);
    bridges.push(bridge);
    bridge.receive({ type: "start", context: context(npcId) });
    await Promise.resolve();
    stub.parameters.callbacks.onmessage(modelMessage({ setupComplete: {} }));
    return { stub, emitted, close, bridge };
  }

  it("waits for setupComplete, omits unsupported thinking and starts automatically", async () => {
    const stub = stubService();
    const emitted: ServerLiveMessage[] = [];
    const bridge = new LiveBridge(stub.service, message => emitted.push(message), vi.fn());
    bridges.push(bridge);
    bridge.receive({ type: "start", context: context() });
    await Promise.resolve();
    expect(emitted).toEqual([]);
    expect(stub.parameters.config?.thinkingConfig).toBeUndefined();
    expect(stub.parameters.config?.enableAffectiveDialog).toBeUndefined();
    expect(stub.parameters.config?.speechConfig?.voiceConfig?.prebuiltVoiceConfig?.voiceName).toBe("Kore");
    stub.parameters.callbacks.onmessage(modelMessage({ setupComplete: {} }));
    expect(emitted[0]).toEqual({ type: "ready" });
    expect(stub.session.sendClientContent).toHaveBeenCalledWith(expect.objectContaining({ turnComplete: true }));
  });

  it("processes co-occurring audio, transcripts and tools without self-authorizing", async () => {
    const { stub, emitted, bridge } = await setup();
    stub.parameters.callbacks.onmessage(modelMessage({
      serverContent: {
        modelTurn: { parts: [{ text: "Welcome." }, { inlineData: { mimeType: "audio/pcm;rate=24000", data: Buffer.alloc(640).toString("base64") } }] },
        inputTranscription: { text: "Nila", finished: true }, outputTranscription: { text: "Welcome.", finished: true }, turnComplete: true,
      },
      toolCall: { functionCalls: [{ id: "provider-function-42", name: "apply_game_action", args: { type: "claim", field: "name", value: "Nila", quote: "Nila" } }] },
    }));
    expect(emitted.some(message => message.type === "audio")).toBe(true);
    expect(emitted.filter(message => message.type === "transcript" && message.speaker === "npc")).toEqual([
      { type: "transcript", speaker: "npc", text: "Welcome.", final: true },
    ]);
    const action = emitted.find(message => message.type === "action");
    if (!action || action.type !== "action") throw new Error("No action proposed.");
    expect(stub.session.sendToolResponse).not.toHaveBeenCalled();
    expect(emitted.some(message => message.type === "turn_complete")).toBe(false);
    bridge.receive({ type: "tool_result", requestId: action.requestId, result: { accepted: false, message: "Engine rejected." } });
    expect(stub.session.sendToolResponse).toHaveBeenCalledWith({
      functionResponses: [{ id: "provider-function-42", name: "apply_game_action", response: { accepted: false, message: "Engine rejected." } }],
    });
  });

  it("assembles transcript snapshots and final flags without duplicating model text", async () => {
    const { stub, emitted } = await setup();
    for (const text of ["Wel", "come"]) {
      stub.parameters.callbacks.onmessage(modelMessage({ serverContent: { modelTurn: { parts: [{ text }] }, outputTranscription: { text } } }));
    }
    stub.parameters.callbacks.onmessage(modelMessage({ serverContent: { outputTranscription: { text: "Welcome", finished: true }, generationComplete: true, turnComplete: true } }));
    expect(emitted.filter(message => message.type === "transcript")).toEqual([
      { type: "transcript", speaker: "npc", text: "Wel", final: false },
      { type: "transcript", speaker: "npc", text: "Welcome", final: false },
      { type: "transcript", speaker: "npc", text: "Welcome", final: true },
    ]);
    expect(emitted.at(-1)).toEqual({ type: "turn_complete" });
  });

  it("rejects invalid role powers instead of emitting an engine action", async () => {
    const { stub, emitted } = await setup("kulkarni");
    stub.parameters.callbacks.onmessage(modelMessage({ toolCall: { functionCalls: [{
      id: "bad-tool", name: "apply_game_action", args: { type: "authorize", name: "Nila" },
    }] } }));
    expect(emitted.some(message => message.type === "action")).toBe(false);
    expect(stub.session.sendToolResponse.mock.calls[0][0]).toMatchObject({ functionResponses: [{ response: { accepted: false } }] });
  });

  it("times out engine replies and ignores cancelled or late acknowledgements", async () => {
    const { stub, emitted, bridge } = await setup("priya", { toolTimeoutMs: 30 });
    const call = { id: "pending-tool", name: "apply_game_action", args: { type: "claim", field: "name", value: "Nila", quote: "Nila" } };
    stub.parameters.callbacks.onmessage(modelMessage({ toolCall: { functionCalls: [call] } }));
    await vi.advanceTimersByTimeAsync(31);
    expect(stub.session.sendToolResponse.mock.calls[0][0]).toMatchObject({ functionResponses: [{ id: call.id, response: { accepted: false } }] });
    const first = emitted.find(message => message.type === "action");
    if (!first || first.type !== "action") throw new Error("No tool.");
    bridge.receive({ type: "tool_result", requestId: first.requestId, result: { accepted: true, message: "Too late." } });
    expect(stub.session.sendToolResponse).toHaveBeenCalledTimes(1);
    stub.parameters.callbacks.onmessage(modelMessage({ toolCall: { functionCalls: [{ ...call, id: "cancel-tool" }] } }));
    stub.parameters.callbacks.onmessage(modelMessage({ toolCallCancellation: { ids: ["cancel-tool"] }, serverContent: { interrupted: true } }));
    await vi.advanceTimersByTimeAsync(31);
    expect(stub.session.sendToolResponse).toHaveBeenCalledTimes(1);
    expect(emitted.some(message => message.type === "interrupted")).toBe(true);
  });

  it("splits a complete spoken identity into individual claims and waits for every engine result", async () => {
    const { stub, emitted, bridge } = await setup();
    stub.parameters.callbacks.onmessage(modelMessage({ toolCall: { functionCalls: [{
      id: "identity-1", name: "record_identity_claims",
      args: {
        name: "Nila", company: "Acme", role: "contractor", host: "Dev", ticket: "", callback: "", employeeId: "",
        quote: "I'm Nila, a contractor from Acme visiting Dev.",
      },
    }] } }));
    const actions = emitted.filter(message => message.type === "action");
    expect(actions).toHaveLength(4);
    expect(actions.some(message => message.action.type === "claim" && message.action.field === "role")).toBe(true);
    expect(stub.session.sendToolResponse).not.toHaveBeenCalled();
    actions.slice(0, 3).forEach(message => bridge.receive({
      type: "tool_result", requestId: message.requestId, result: { accepted: true, message: "Claim recorded." },
    }));
    expect(stub.session.sendToolResponse).not.toHaveBeenCalled();
    bridge.receive({ type: "tool_result", requestId: actions[3].requestId, result: { accepted: false, message: "The engine rejected this field." } });
    expect(stub.session.sendToolResponse).toHaveBeenCalledOnce();
    expect(stub.session.sendToolResponse.mock.calls[0][0]).toMatchObject({
      functionResponses: [{
        id: "identity-1", name: "record_identity_claims", response: {
          accepted: false, results: [
            { accepted: true }, { accepted: true }, { accepted: true }, { accepted: false },
          ],
        },
      }],
    });
  });

  it("cancels every pending member of an identity tool without later acknowledging them", async () => {
    const { stub, emitted, bridge } = await setup("priya", { toolTimeoutMs: 20 });
    stub.parameters.callbacks.onmessage(modelMessage({ toolCall: { functionCalls: [{
      id: "identity-cancel", name: "record_identity_claims",
      args: { name: "Nila", company: "Acme", role: "contractor", host: "", callback: "", ticket: "", employeeId: "", quote: "Nila, contractor from Acme." },
    }] } }));
    const actions = emitted.filter(message => message.type === "action");
    expect(actions).toHaveLength(3);
    stub.parameters.callbacks.onmessage(modelMessage({ toolCallCancellation: { ids: ["identity-cancel"] } }));
    await vi.advanceTimersByTimeAsync(21);
    bridge.receive({ type: "tool_result", requestId: actions[0].requestId, result: { accepted: true, message: "Late result." } });
    expect(stub.session.sendToolResponse).not.toHaveBeenCalled();
  });

  it("returns partial identity acceptance only after unconfirmed members time out", async () => {
    const { stub, emitted, bridge } = await setup("priya", { toolTimeoutMs: 20 });
    stub.parameters.callbacks.onmessage(modelMessage({ toolCall: { functionCalls: [{
      id: "identity-partial", name: "record_identity_claims",
      args: { name: "Nila", company: "Acme", role: "", host: "", callback: "", ticket: "", employeeId: "", quote: "I'm Nila from Acme." },
    }] } }));
    const actions = emitted.filter(message => message.type === "action");
    bridge.receive({ type: "tool_result", requestId: actions[0].requestId, result: { accepted: true, message: "Name recorded." } });
    expect(stub.session.sendToolResponse).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(21);
    expect(stub.session.sendToolResponse).toHaveBeenCalledOnce();
    expect(stub.session.sendToolResponse.mock.calls[0][0]).toMatchObject({
      functionResponses: [{ id: "identity-partial", response: { accepted: false, results: [{ field: "name", accepted: true }, { field: "company", accepted: false }] } }],
    });
  });

  it("rejects missing identity fields explicitly instead of guessing empty values", async () => {
    const { stub, emitted } = await setup();
    stub.parameters.callbacks.onmessage(modelMessage({ toolCall: { functionCalls: [{
      id: "identity-malformed", name: "record_identity_claims", args: { name: "Nila", quote: "I'm Nila." },
    }] } }));
    expect(emitted.some(message => message.type === "action")).toBe(false);
    expect(stub.session.sendToolResponse.mock.calls[0][0]).toMatchObject({ functionResponses: [{ response: { accepted: false } }] });
  });

  it("processes a function call in model parts once even if also present in toolCall", async () => {
    const { stub, emitted } = await setup();
    const call = { id: "mirrored-call", name: "apply_game_action", args: { type: "claim", field: "name", value: "Nila", quote: "Nila" } };
    stub.parameters.callbacks.onmessage(modelMessage({
      serverContent: { modelTurn: { parts: [{ functionCall: call }] } },
      toolCall: { functionCalls: [call] },
    }));
    expect(emitted.filter(message => message.type === "action")).toHaveLength(1);
  });

  it("closes a late connect result after disconnect without starting an encounter", async () => {
    const stub = stubService();
    const pending = deferred<LiveSession>();
    stub.service.connectLive.mockReturnValueOnce(pending.promise);
    const emitted: ServerLiveMessage[] = [];
    const bridge = new LiveBridge(stub.service, message => emitted.push(message), vi.fn());
    bridges.push(bridge);
    bridge.receive({ type: "start", context: context() });
    bridge.stop();
    pending.resolve(stub.session);
    await Promise.resolve();
    expect(stub.session.close).toHaveBeenCalledOnce();
    expect(stub.session.sendClientContent).not.toHaveBeenCalled();
    expect(emitted.some(message => message.type === "ready")).toBe(false);
  });

  it("validates audio, ends paused streams and sends context without completing a turn", async () => {
    const { stub, bridge } = await setup();
    bridge.receive({ type: "audio", data: Buffer.alloc(640).toString("base64"), sampleRate: 16000 });
    expect(stub.session.sendRealtimeInput.mock.calls[0][0]).toMatchObject({ audio: { mimeType: "audio/pcm;rate=16000" } });
    await vi.advanceTimersByTimeAsync(351);
    expect(stub.session.sendRealtimeInput).toHaveBeenLastCalledWith({ audioStreamEnd: true });
    bridge.receive({ type: "context", context: context() });
    expect(stub.session.sendClientContent).toHaveBeenLastCalledWith(expect.objectContaining({ turnComplete: false }));
    bridge.receive({ type: "audio", data: "AA==", sampleRate: 16000 });
    expect(bridge.closed).toBe(true);
  });

  it("enforces setup and encounter deadlines with explicit errors", async () => {
    const { bridge, emitted, stub } = await setup("priya", { encounterMs: 30 });
    await vi.advanceTimersByTimeAsync(31);
    expect(bridge.closed).toBe(true);
    expect(emitted.some(message => message.type === "error" && message.message.includes("three-minute"))).toBe(true);
    expect(stub.session.close).toHaveBeenCalledOnce();
  });

  it("times out an opened upstream socket that never acknowledges setup", async () => {
    const stub = stubService();
    const emitted: ServerLiveMessage[] = [];
    const bridge = new LiveBridge(stub.service, message => emitted.push(message), vi.fn(), { setupTimeoutMs: 20 });
    bridges.push(bridge);
    bridge.receive({ type: "start", context: context() });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(21);
    expect(bridge.closed).toBe(true);
    expect(stub.session.close).toHaveBeenCalledOnce();
    stub.parameters.callbacks.onmessage(modelMessage({ setupComplete: {} }));
    expect(emitted.some(message => message.type === "ready")).toBe(false);
  });

  it.each([
    { data: "AAAA####", mimeType: "audio/pcm;rate=24000" },
    { data: Buffer.alloc(640).toString("base64"), mimeType: "audio/pcm;rate=24000;channels=2" },
  ])("rejects malformed provider audio instead of forwarding it", async inlineData => {
    const { bridge, stub, emitted } = await setup();
    stub.parameters.callbacks.onmessage(modelMessage({ serverContent: { modelTurn: { parts: [{ inlineData }] } } }));
    expect(bridge.closed).toBe(true);
    expect(emitted.some(message => message.type === "audio")).toBe(false);
  });
});

describe("loopback HTTP and WebSocket API", () => {
  let game: GlasshouseServer;
  let base: string;
  let stub: ReturnType<typeof stubService>;
  beforeEach(async () => {
    stub = stubService();
    game = await createGlasshouseServer({ config, gemini: stub.service, assets, web: false });
    const address = await game.listen();
    base = `http://127.0.0.1:${address.port}`;
  });
  afterEach(async () => { await game.close(); });
  const post = (base: string, endpoint: string, body: unknown) => fetch(`${base}${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body),
  });

  it("reports configuration, never key validation or browser credentials", async () => {
    const response = await fetch(`${base}/api/health`);
    const body = await response.json();
    expect(body.configured).toBe(true);
    expect(body.credentialsValidated).toBe(false);
    expect(body.models).toEqual(config.models);
    expect(JSON.stringify(body).includes(config.apiKey)).toBe(false);
  });

  it("accepts DIRECT director context and rejects wrapped or malformed bodies", async () => {
    expect((await post(base, "/api/director", directorContext())).status).toBe(200);
    expect(stub.service.director).toHaveBeenCalledOnce();
    expect((await post(base, "/api/director", { context: directorContext() })).status).toBe(400);
    const malformed = await fetch(`${base}/api/dialogue`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
    expect(malformed.status).toBe(400);
    expect((await malformed.json()).error.code).toBe("INVALID_JSON");
  });

  it("enforces body, media type and same-origin bounds before generation", async () => {
    const wrongOrigin = await fetch(`${base}/api/dialogue`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "https://elsewhere.invalid" },
      body: JSON.stringify({ context: context(), text: "Hello." }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect((await fetch(`${base}/api/tts`, { method: "POST", body: "hello" })).status).toBe(415);
    expect((await post(base, "/api/dialogue", { text: "x".repeat(limits.requestBytes + 1) })).status).toBe(413);
    expect(stub.service.dialogue).not.toHaveBeenCalled();
  });

  it("serves WAV bytes, a typed empty manifest and asynchronous prefetch", async () => {
    const tts = await post(base, "/api/tts", { text: "Welcome.", voiceName: "Kore" });
    expect(tts.headers.get("content-type")).toContain("audio/wav");
    expect(Buffer.from(await tts.arrayBuffer()).toString("ascii", 0, 4)).toBe("RIFF");
    expect(await (await fetch(`${base}/api/assets`)).json()).toEqual({ version: 1, assets: [], status: "empty" });
    expect((await post(base, "/api/assets/prefetch", { floors: [1, 2, 2] })).status).toBe(202);
    expect((await post(base, "/api/assets/prefetch", { floors: [13] })).status).toBe(400);
    expect((await fetch(`${base}/api/missing`)).status).toBe(404);
  });

  it("rejects concurrent paid requests instead of queuing unbounded work", async () => {
    const pending = deferred<DirectorReply>();
    stub.service.director.mockReturnValueOnce(pending.promise);
    const first = post(base, "/api/director", directorContext());
    await vi.waitFor(() => expect(stub.service.director).toHaveBeenCalledOnce());
    expect((await post(base, "/api/director", directorContext())).status).toBe(429);
    pending.resolve(directorReply);
    expect((await first).status).toBe(200);
  });

  it("bounds asynchronous asset reads as well as paid requests", async () => {
    const pending = deferred<Awaited<ReturnType<AssetService["readAssets"]>>>();
    const read = vi.spyOn(assets, "readAssets").mockReturnValue(pending.promise);
    const requests = Array.from({ length: limits.maxRequests }, () => fetch(`${base}/api/assets`));
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(limits.maxRequests));
    expect((await fetch(`${base}/api/assets`)).status).toBe(429);
    pending.resolve({ version: 1, assets: [], status: "empty" });
    expect((await Promise.all(requests)).every(response => response.status === 200)).toBe(true);
  });

  it("propagates browser request cancellation to the provider", async () => {
    let providerSignal: AbortSignal | undefined;
    stub.service.dialogue.mockImplementationOnce(async (_context, _text, signal) => {
      providerSignal = signal;
      return await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    });
    const controller = new AbortController();
    const request = fetch(`${base}/api/dialogue`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ context: context(), text: "Hello." }), signal: controller.signal,
    }).catch(error => error);
    await vi.waitFor(() => expect(providerSignal).toBeDefined());
    controller.abort();
    await request;
    await vi.waitFor(() => expect(providerSignal?.aborted).toBe(true));
  });

  it("returns safe errors rather than raw provider data", async () => {
    stub.service.dialogue.mockRejectedValueOnce(new Error("DO_NOT_RETURN_SECRET"));
    const reply = await post(base, "/api/dialogue", { context: context(), text: "Hello." });
    expect(reply.status).toBe(500);
    expect((await reply.text()).includes("DO_NOT_RETURN_SECRET")).toBe(false);
  });

  it("requires a WebSocket Origin and closes malformed messages cleanly", async () => {
    const endpoint = `${base.replace("http:", "ws:")}/api/live`;
    const denied = new WebSocket(endpoint);
    const deniedStatus = await new Promise<number>((resolve, reject) => {
      denied.on("error", () => {});
      denied.on("unexpected-response", (_request, response) => { response.resume(); denied.terminate(); resolve(response.statusCode ?? 0); });
      denied.on("open", () => { denied.close(); reject(new Error("Missing-origin socket was accepted.")); });
    });
    expect(deniedStatus).toBe(403);
    const peer = new WebSocket(endpoint, { origin: base });
    await new Promise<void>((resolve, reject) => { peer.once("open", resolve); peer.once("error", reject); });
    const messages: ServerLiveMessage[] = [];
    peer.on("message", data => messages.push(JSON.parse(data.toString())));
    const closed = new Promise<number>(resolve => peer.once("close", code => resolve(code)));
    peer.send("{broken");
    expect(await closed).toBe(1008);
    expect(messages.some(message => message.type === "error")).toBe(true);
    expect(stub.service.connectLive).not.toHaveBeenCalled();
  });
});
