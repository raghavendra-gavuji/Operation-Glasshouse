import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NPCS } from "../shared/story";
import type { ConversationContext, DirectorContext, ServerLiveMessage } from "../shared/types";
import { loadConfig } from "../server/config";
import { createGlasshouseServer, type GlasshouseServer } from "../server/index";
import { wavToPcm } from "../server/wav";

const enabled = process.env.GLASSHOUSE_REAL_API_SMOKE === "1";

function conversation(): ConversationContext {
  const npc = NPCS.find(value => value.id === "priya");
  if (!npc) throw new Error("Priya is missing from the story.");
  return {
    npc, suspicion: 0, memory: "",
    cover: { name: "", company: "", role: "", host: "", callback: "", employeeId: "", ticket: "" },
    claims: [], knownFacts: [], heardRumors: [], visitorLog: null, authorization: null,
    carryingCard: false, secretKnown: false, floor: 1, clockMinute: 540,
  };
}
function director(): DirectorContext {
  const npc = conversation().npc;
  return {
    floor: {
      id: 1, name: "Reception", subtitle: "Meridian Tower", width: 32, height: 28,
      tiles: Array.from({ length: 32 * 28 }, () => "floor"), rooms: [],
      spawn: { x: 10, y: 22 }, elevator: { x: 15, y: 14 },
      palette: { floor: "#222", wall: "#333", accent: "#abc" },
    },
    player: { x: 10, y: 22, facing: "north", moving: false, carryingCard: false },
    npcs: [{
      definition: npc,
      state: {
        id: npc.id, ...npc.home, floor: 1, suspicion: 0, intent: "idle", intentReason: "At reception.",
        memory: "", bubble: null, bubbleUntil: 0, facing: "south", lastEncounterAt: -1000, reported: false,
      },
    }],
    events: [], alert: false,
  };
}

describe.skipIf(!enabled)("explicitly authorized real Gemini API smoke", () => {
  let game: GlasshouseServer;
  let base: string;
  beforeAll(async () => {
    const config = loadConfig();
    if (!config.apiKey) throw new Error("Real API smoke requires server credentials via .env or GLASSHOUSE_ENV_FILE.");
    game = await createGlasshouseServer({
      config: { ...config, port: 0 }, web: false,
      assets: {
        readAssets: async () => ({ version: 1, assets: [], status: "empty" }),
        scheduleFloorAssets: async () => { throw new Error("Image generation is not part of this voice smoke check."); },
        getArtGenerationStatus: () => ({ queued: [], running: [], failed: [] }),
      },
    });
    const address = await game.listen();
    base = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => { await game?.close(); });
  function post(endpoint: string, body: unknown) {
    return fetch(`${base}${endpoint}`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(55_000),
    });
  }

  it("returns real Flash structured director and dialogue replies", async () => {
    const tick = await post("/api/director", director());
    const tickBody = await tick.json();
    expect(tick.status, JSON.stringify(tickBody.error)).toBe(200);
    expect(tickBody.source).toBe("gemini");
    expect(Array.isArray(tickBody.intents)).toBe(true);
    const dialogue = await post("/api/dialogue", {
      context: conversation(), text: "Hello. I am looking at the fictional office directory. Ask me one short question; do not change any visitor records yet.",
    });
    const dialogueBody = await dialogue.json();
    expect(dialogue.status, JSON.stringify(dialogueBody.error)).toBe(200);
    expect(dialogueBody.reply.length).toBeGreaterThan(0);
    expect(Array.isArray(dialogueBody.actions)).toBe(true);
    console.info(JSON.stringify({ smoke: "flash-rest", directorIntents: tickBody.intents.length, dialogueCharacters: dialogueBody.reply.length }));
  }, 120_000);

  it("returns distinct WAV voices and reuses the bounded narration cache", async () => {
    const text = "Welcome to Meridian Tower.";
    const koreReply = await post("/api/tts", { text, voiceName: "Kore" });
    expect(koreReply.status).toBe(200);
    const kore = Buffer.from(await koreReply.arrayBuffer());
    const charonReply = await post("/api/tts", { text, voiceName: "Charon" });
    expect(charonReply.status).toBe(200);
    const charon = Buffer.from(await charonReply.arrayBuffer());
    expect(wavToPcm(kore).sampleRate).toBe(24000);
    expect(wavToPcm(charon).sampleRate).toBe(24000);
    expect(kore.length).toBeGreaterThan(10_000);
    expect(charon.length).toBeGreaterThan(10_000);
    const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
    expect(digest(kore) === digest(charon)).toBe(false);
    const repeat = await post("/api/tts", { text, voiceName: "Kore" });
    expect(repeat.status).toBe(200);
    expect(Buffer.from(await repeat.arrayBuffer()).equals(kore)).toBe(true);
    console.info(JSON.stringify({ smoke: "tts-rest", voices: ["Kore", "Charon"], wavBytes: [kore.length, charon.length], cacheReused: true }));
  }, 120_000);

  it("proxies real Live audio/transcription and waits for a rejected engine tool result", async () => {
    const peer = new WebSocket(`${base.replace("http:", "ws:")}/api/live`, { origin: base });
    let audioBytes = 0;
    let npcTranscriptCharacters = 0;
    let turns = 0;
    let actions = 0;
    let ready = false;
    let stopped = false;
    let failure: Error | undefined;
    let check: (() => void) | undefined;
    peer.on("error", () => { failure = new Error("The local Live smoke socket failed."); check?.(); });
    peer.on("close", () => { if (!stopped) { failure = new Error("Live closed before the smoke check finished."); check?.(); } });
    peer.on("message", data => {
      const message: ServerLiveMessage = JSON.parse(data.toString());
      if (message.type === "ready") ready = true;
      if (message.type === "audio") {
        expect(message.sampleRate).toBe(24000);
        audioBytes += Buffer.from(message.data, "base64").length;
      }
      if (message.type === "transcript" && message.speaker === "npc" && message.final) npcTranscriptCharacters += message.text.length;
      if (message.type === "turn_complete") turns++;
      if (message.type === "error") failure = new Error(message.message);
      if (message.type === "action") {
        actions++;
        peer.send(JSON.stringify({
          type: "tool_result", requestId: message.requestId,
          result: { accepted: false, message: "The smoke-test game engine deliberately rejected this proposal. No record was changed. Ask one short clarification question." },
        }));
      }
      check?.();
    });
    function until(predicate: () => boolean): Promise<void> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { check = undefined; reject(new Error("Live smoke response timed out.")); }, 45_000);
        check = () => {
          if (failure || predicate()) {
            clearTimeout(timer);
            check = undefined;
            if (failure) reject(failure);
            else resolve();
          }
        };
        check();
      });
    }
    try {
      await new Promise<void>((resolve, reject) => {
        peer.once("open", resolve);
        peer.once("error", () => reject(new Error("The local Live socket did not open.")));
        peer.once("unexpected-response", (_request, response) => { response.resume(); reject(new Error(`Local Live upgrade returned HTTP ${response.statusCode}.`)); });
      });
      peer.send(JSON.stringify({ type: "start", context: conversation() }));
      await until(() => ready && audioBytes > 0 && npcTranscriptCharacters > 0 && turns >= 1);
      const firstTurnBytes = audioBytes;
      const firstTurns = turns;
      const firstActions = actions;
      peer.send(JSON.stringify({
        type: "text",
        text: "For this fictional game, my invented name is Nila. Please record exactly my name with apply_game_action type claim, field name, value Nila, quote My invented name is Nila, and wait for the game engine. Do not register me or issue anything.",
      }));
      await until(() => actions > firstActions && turns > firstTurns && audioBytes > firstTurnBytes);
      console.info(JSON.stringify({ smoke: "live-proxy", ready, audioBytes, npcTranscriptCharacters, turns, engineRejectedProposals: actions }));
    } finally {
      stopped = true;
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "stop" }));
      peer.close();
    }
  }, 120_000);
});
