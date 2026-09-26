import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { GoogleGenAI } from "@google/genai";
import { describe, expect, it } from "vitest";
import type { GameAction, ServerLiveMessage } from "../shared/types";
import { GameEngine } from "../src/game/engine";
import { loadConfig, projectRoot } from "../server/config";
import { createGlasshouseServer } from "../server/index";
import { createGeminiService } from "../server/gemini";
import { wavToPcm } from "../server/wav";

const enabled = process.env.GLASSHOUSE_REAL_ACCEPTANCE === "1";
const introduction = "Good morning. My name is Arjun Rao. I am a contractor from SecureGate, visiting Dev in IT. My fictional ticket is MT-1042. My optional callback code is SIM-1042. Please sign me in.";

function inputPackets(pcm: Buffer, sampleRate: number): Buffer[] {
  const packets: Buffer[] = [];
  interface Processor {
    port: { onmessage: ((message: { data: { type: string; active: boolean } }) => void) | null };
    process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
  }
  let constructor: (new () => Processor) | undefined;
  class BaseProcessor {
    port = {
      onmessage: null,
      postMessage(packet: { pcm: ArrayBuffer }) { packets.push(Buffer.from(packet.pcm)); },
    };
  }
  vm.runInNewContext(readFileSync(path.join(projectRoot, "public", "pcm-processor.js"), "utf8"), {
    sampleRate, AudioWorkletProcessor: BaseProcessor,
    registerProcessor(_name: string, type: new () => Processor) { constructor = type; },
  });
  if (!constructor) throw new Error("The microphone processor did not register.");
  const processor = new constructor();
  processor.port.onmessage?.({ data: { type: "active", active: true } });
  const input = Float32Array.from({ length: pcm.length / 2 + sampleRate }, (_, index) =>
    index * 2 < pcm.length ? pcm.readInt16LE(index * 2) / 32768 : 0);
  for (let offset = 0; offset < input.length; offset += 128) {
    processor.process([[input.subarray(offset, offset + 128)]], [[new Float32Array(128)]]);
  }
  return packets;
}

describe.skipIf(!enabled)("real gameplay acceptance, explicitly authorized", () => {
  it("proposes minimal typed claims followed by registration without inventing accepted status", async () => {
    const engine = new GameEngine(42);
    engine.start(false);
    engine.state.player.x = 10.5;
    engine.state.player.y = 21.5;
    expect(engine.beginConversation("priya")).toBe(true);
    const text = "My invented name is Arjun Rao. I'm a contractor from SecureGate visiting Dev. Please sign me in.";
    const service = createGeminiService(loadConfig());
    const reply = await service.dialogue(engine.getConversationContext("priya"), text, AbortSignal.timeout(35_000));
    const actions = reply.actions.map(action => ({ action, ...engine.applyAction(action) }));
    expect(actions.every(result => result.accepted)).toBe(true);
    expect(engine.state.visitorLog).toBe("Arjun Rao");
    expect(engine.state.ledger.some(claim => claim.field === "role")).toBe(true);
    console.info(JSON.stringify({ acceptance: "typed-registration", actions: actions.map(result => result.action.type), visitorLog: engine.state.visitorLog }));
  }, 45_000);

  it.each([false, true])("returns three engine-valid full-floor ticks, engaged=%s", async engaged => {
    const engine = new GameEngine(42);
    engine.start(false);
    if (engaged) {
      engine.state.player.x = 10.5;
      engine.state.player.y = 21.5;
      expect(engine.beginConversation("priya")).toBe(true);
    }
    const config = loadConfig();
    const ai = new GoogleGenAI({ apiKey: config.apiKey, vertexai: false, httpOptions: { apiVersion: "v1beta", timeout: 30_000 } });
    const observations: { finishReason?: string; outputTokens?: number }[] = [];
    const service = createGeminiService(config, {
      async generateContent(request) {
        const response = await ai.models.generateContent(request);
        observations.push({ finishReason: response.candidates?.[0]?.finishReason, outputTokens: response.usageMetadata?.candidatesTokenCount });
        return response;
      },
      connect: request => ai.live.connect(request),
    });
    for (let tick = 0; tick < 3; tick++) {
      const context = engine.getDirectorContext();
      expect(context.npcs).toHaveLength(engaged ? 5 : 6);
      const reply = await service.director(context, AbortSignal.timeout(35_000));
      expect(reply.intents.length).toBeGreaterThan(0);
      expect(reply.intents.every(intent => context.npcs.some(actor => actor.state.id === intent.npcId))).toBe(true);
      const previousEvents = engine.state.events.length;
      engine.applyDirector(reply);
      expect(engine.state.events.slice(previousEvents).filter(event => event.kind === "system")).toEqual([]);
    }
    expect(observations.every(observation => observation.finishReason === "STOP")).toBe(true);
    console.info(JSON.stringify({ acceptance: "full-floor-director", engaged, ticks: observations }));
  }, 120_000);

  it("records and registers a normal spoken introduction using engine-confirmed tools", async () => {
    const engine = new GameEngine(42);
    engine.start(false);
    engine.state.player.x = 10.5;
    engine.state.player.y = 21.5;
    expect(engine.beginConversation("priya")).toBe(true);
    const config = { ...loadConfig(), port: 0 };
    const upstreamCalls: { name?: string; location: string }[] = [];
    const ai = new GoogleGenAI({ apiKey: config.apiKey, vertexai: false, httpOptions: { apiVersion: "v1beta", timeout: 45_000 } });
    const service = createGeminiService(config, {
      generateContent: request => ai.models.generateContent(request),
      connect: request => ai.live.connect({
        ...request,
        callbacks: {
          ...request.callbacks,
          onmessage(message) {
            for (const call of message.toolCall?.functionCalls ?? []) upstreamCalls.push({ name: call.name, location: "toolCall" });
            for (const part of message.serverContent?.modelTurn?.parts ?? []) {
              if (part.functionCall) upstreamCalls.push({ name: part.functionCall.name, location: "modelTurn" });
            }
            request.callbacks.onmessage(message);
          },
        },
      }),
    });
    const fixture = process.env.GLASSHOUSE_ACCEPTANCE_WAV;
    const { pcm, sampleRate } = wavToPcm(fixture
      ? readFileSync(fixture)
      : await service.tts(introduction, "Puck", AbortSignal.timeout(50_000)));
    const packets = inputPackets(pcm, sampleRate);
    const game = await createGlasshouseServer({
      config, gemini: service, web: false,
      assets: {
        readAssets: async () => ({ version: 1, assets: [], status: "empty" }),
        scheduleFloorAssets: async () => { throw new Error("This check never generates artwork."); },
        getArtGenerationStatus: () => ({ queued: [], running: [], failed: [] }),
      },
    });
    const address = await game.listen();
    const base = `http://127.0.0.1:${address.port}`;
    const peer = new WebSocket(`${base.replace("http:", "ws:")}/api/live`, { origin: base });
    const proposals: { action: GameAction; accepted: boolean; message: string }[] = [];
    const transcripts: { speaker: string; text: string }[] = [];
    let ready = false;
    let turns = 0;
    let stopped = false;
    let audioBytes = 0;
    let failure: Error | undefined;
    let check: (() => void) | undefined;
    let transcriptId = 0;
    peer.on("error", () => { failure = new Error("Live acceptance transport failed."); check?.(); });
    peer.on("close", () => {
      if (!stopped) { failure = new Error("Live acceptance socket closed unexpectedly."); check?.(); }
    });
    peer.on("message", data => {
      const message: ServerLiveMessage = JSON.parse(data.toString());
      if (message.type === "ready") ready = true;
      if (message.type === "audio") audioBytes += Buffer.from(message.data, "base64").length;
      if (message.type === "turn_complete") turns++;
      if (message.type === "error") failure = new Error(message.message);
      if (message.type === "transcript" && message.final) {
        transcripts.push({ speaker: message.speaker, text: message.text });
        engine.addTranscript({
          id: `acceptance-${++transcriptId}`, npcId: "priya", speaker: message.speaker,
          text: message.text, final: true, at: engine.state.elapsedSeconds,
        });
      }
      if (message.type === "action") {
        const result = engine.applyAction(message.action);
        proposals.push({ action: message.action, ...result });
        peer.send(JSON.stringify({ type: "tool_result", requestId: message.requestId, result }));
        if (engine.state.activeNpcId) peer.send(JSON.stringify({ type: "context", context: engine.getConversationContext("priya") }));
      }
      check?.();
    });
    const until = (predicate: () => boolean, timeout = 30_000): Promise<void> => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { check = undefined; reject(new Error("Natural speech did not produce the required engine action.")); }, timeout);
      check = () => {
        if (!failure && !predicate()) return;
        clearTimeout(timer);
        check = undefined;
        if (failure) reject(failure);
        else resolve();
      };
      check();
    });
    try {
      await new Promise<void>((resolve, reject) => {
        peer.once("open", resolve);
        peer.once("error", () => reject(new Error("Live acceptance socket did not open.")));
      });
      peer.send(JSON.stringify({ type: "start", context: engine.getConversationContext("priya") }));
      await until(() => ready && turns >= 1 && audioBytes > 0);
      for (const packet of packets) {
        if (failure) throw failure;
        peer.send(JSON.stringify({ type: "audio", data: packet.toString("base64"), sampleRate: 16000 }));
        await delay(20);
      }
      await until(() => engine.state.visitorLog !== null && turns >= 2 && transcripts.some(entry => entry.speaker === "player"), 35_000);
      expect(engine.state.ledger.some(claim => claim.field === "name" && /arjun/i.test(claim.value))).toBe(true);
      expect(engine.state.ledger.some(claim => claim.field === "company")).toBe(true);
      expect(engine.state.ledger.some(claim => claim.field === "role")).toBe(true);
      expect(engine.state.ledger.some(claim => claim.field === "host")).toBe(true);
      expect(proposals.some(proposal => proposal.action.type === "register" && proposal.accepted)).toBe(true);
      for (const proposal of proposals) {
        if (proposal.action.type !== "claim" || !proposal.accepted) continue;
        const quote = proposal.action.quote;
        expect(transcripts.some(entry => entry.speaker === "player" && entry.text.includes(quote))).toBe(true);
      }
    } finally {
      console.info(JSON.stringify({
        acceptance: "spoken-introduction", pcmPackets: packets.length, audioBytes, turns,
        visitorLog: engine.state.visitorLog, proposals, transcripts, upstreamCalls, syntheticFixtureSupplied: Boolean(fixture),
      }));
      stopped = true;
      if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ type: "stop" }));
      peer.close();
      await game.close();
    }
  }, 150_000);
});
