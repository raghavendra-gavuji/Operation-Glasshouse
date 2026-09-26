import { randomUUID } from "node:crypto";
import { ActivityHandling, Modality, type FunctionCall, type LiveServerMessage, type Transcription } from "@google/genai";
import type { ActionResult, ConversationContext, ServerLiveMessage } from "../shared/types";
import { TokenBucket } from "./bounds";
import { limits } from "./config";
import { invalidResponse, providerError, safeLog, ServiceError } from "./errors";
import type { GeminiService, LiveSession } from "./gemini";
import {
  actionIsAllowed, canonicalNpc, conversationInstruction, conversationSnapshot, gameActionTool,
} from "./prompts";
import { actionArgumentsSchema, clientLiveMessageSchema, gameActionSchema, parseInput } from "./schemas";

type Emit = (message: ServerLiveMessage) => void;
interface PendingTool {
  id: string;
  name: string;
  timer: ReturnType<typeof setTimeout>;
}
export interface LiveBridgeOptions {
  setupTimeoutMs?: number;
  encounterMs?: number;
  toolTimeoutMs?: number;
  now?: () => number;
}

class TranscriptBuffer {
  private text = "";

  constructor(private readonly speaker: "player" | "npc", private readonly emit: Emit) {}

  append(transcription: Transcription): void {
    const delta = transcription.text ?? "";
    if (delta) {
      // Most events are deltas; some final transcription events repeat the full text.
      this.text = this.text && delta.startsWith(this.text) ? delta : this.text + delta;
      if (this.text.length > limits.maxTranscriptChars) throw invalidResponse();
      if (!transcription.finished) this.emit({ type: "transcript", speaker: this.speaker, text: this.text, final: false });
    }
    if (transcription.finished) this.finish();
  }

  finish(): void {
    if (this.text) this.emit({ type: "transcript", speaker: this.speaker, text: this.text, final: true });
    this.text = "";
  }
}

export class LiveBridge {
  private session?: LiveSession;
  private context?: ConversationContext;
  private started = false;
  private ready = false;
  private setupReceived = false;
  private ended = false;
  private contextChanged = false;
  private readonly connectAbort = new AbortController();
  private readonly queuedProviderEvents: LiveServerMessage[] = [];
  private readonly pending = new Map<string, PendingTool>();
  private readonly seenCalls = new Set<string>();
  private readonly completedCalls = new Map<string, ActionResult>();
  private readonly cancelledCalls = new Set<string>();
  private readonly inputTranscript: TranscriptBuffer;
  private readonly outputTranscript: TranscriptBuffer;
  private outputTextFallback = "";
  private outputHadTranscript = false;
  private inputSpeaking = false;
  private lastVideoAt = -Infinity;
  private audioStreamActive = false;
  private audioGapTimer?: ReturnType<typeof setTimeout>;
  private encounterTimer?: ReturnType<typeof setTimeout>;
  private setupTimer: ReturnType<typeof setTimeout>;
  private readonly messageBudget: TokenBucket;
  private readonly audioBudget: TokenBucket;
  private readonly textBudget: TokenBucket;
  private readonly contextBudget: TokenBucket;
  private readonly now: () => number;

  constructor(
    private readonly service: GeminiService,
    private readonly emit: Emit,
    private readonly closePeer: (code: number, reason: string) => void,
    private readonly options: LiveBridgeOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.messageBudget = new TokenBucket(150, 100, this.now);
    this.audioBudget = new TokenBucket(64_000, 33_000, this.now);
    this.textBudget = new TokenBucket(4, 0.5, this.now);
    this.contextBudget = new TokenBucket(20, 5, this.now);
    this.inputTranscript = new TranscriptBuffer("player", emit);
    this.outputTranscript = new TranscriptBuffer("npc", emit);
    this.setupTimer = setTimeout(() => this.fail(new ServiceError(408, "LIVE_START_TIMEOUT", "No encounter was started. Start a conversation to reconnect.", true)), 10_000);
  }

  get closed(): boolean { return this.ended; }

  receive(raw: unknown): void {
    if (this.ended) return;
    try {
      if (!this.messageBudget.take()) throw new ServiceError(429, "LIVE_RATE_LIMIT", "Too many live messages. Reconnect explicitly after waiting.");
      const message = parseInput(clientLiveMessageSchema, raw);
      if (message.type === "stop") {
        this.stop("Encounter ended.");
        return;
      }
      if (message.type === "start") {
        if (this.started) throw new ServiceError(400, "LIVE_ALREADY_STARTED", "A live socket can contain only one encounter.");
        this.start(message.context);
        return;
      }
      if (!this.context) throw new ServiceError(400, "LIVE_NOT_STARTED", "Start an encounter before sending live input.");
      if (message.type === "context") {
        if (!this.contextBudget.take()) throw new ServiceError(429, "LIVE_CONTEXT_RATE", "Game context updates arrived too quickly.");
        if (message.context.npc.id !== this.context.npc.id) throw new ServiceError(400, "LIVE_NPC_CHANGE", "End the current encounter before changing characters.");
        this.context = message.context;
        if (this.ready) this.sendContext();
        else this.contextChanged = true;
        return;
      }
      if (!this.ready || !this.session) throw new ServiceError(400, "LIVE_NOT_READY", "Wait until the live connection is ready before sending input.");
      switch (message.type) {
        case "audio": {
          const bytes = Buffer.from(message.data, "base64");
          if (!bytes.length || bytes.length % 2 || bytes.length > limits.maxAudioBytes) {
            throw new ServiceError(400, "INVALID_AUDIO", "Live audio must be mono 16-bit little-endian PCM at 16000 Hz.");
          }
          if (!this.audioBudget.take(bytes.length)) throw new ServiceError(429, "LIVE_AUDIO_RATE", "Audio must be streamed at its recording rate, not uploaded in a burst.");
          this.session.sendRealtimeInput({ audio: { data: message.data, mimeType: "audio/pcm;rate=16000" } });
          this.audioStreamActive = true;
          clearTimeout(this.audioGapTimer);
          // Muting or suspending capture pauses PCM without adding a new browser protocol message.
          this.audioGapTimer = setTimeout(() => this.endAudioStream(), 350);
          break;
        }
        case "video": {
          const bytes = Buffer.from(message.data, "base64");
          if (bytes.length < 4 || bytes.length > limits.maxVideoBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8
            || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
            throw new ServiceError(400, "INVALID_VIDEO", "Optional camera frames must be bounded JPEG images.");
          }
          if (this.now() - this.lastVideoAt < 1000) throw new ServiceError(429, "LIVE_VIDEO_RATE", "Optional video is limited to one frame per second.");
          this.lastVideoAt = this.now();
          this.session.sendRealtimeInput({ video: { data: message.data, mimeType: "image/jpeg" } });
          break;
        }
        case "text":
          if (!this.textBudget.take()) throw new ServiceError(429, "LIVE_TEXT_RATE", "Wait for the current exchange before sending more text.");
          this.inputTranscript.finish();
          this.emit({ type: "transcript", speaker: "player", text: message.text, final: true });
          this.endAudioStream();
          this.session.sendClientContent({ turns: [{ role: "user", parts: [{ text: message.text }] }], turnComplete: true });
          break;
        case "tool_result":
          this.toolResult(message.requestId, message.result);
          break;
      }
    } catch (error) {
      this.fail(error instanceof ServiceError ? error : providerError(error));
    }
  }

  protocolError(message = "Live messages must be valid JSON objects, not binary frames."): void {
    this.fail(new ServiceError(400, "LIVE_PROTOCOL", message));
  }

  stop(reason = "Encounter ended.", code = 1000): void {
    if (this.ended) return;
    this.ended = true;
    this.ready = false;
    clearTimeout(this.setupTimer);
    clearTimeout(this.encounterTimer);
    clearTimeout(this.audioGapTimer);
    this.connectAbort.abort();
    for (const tool of this.pending.values()) clearTimeout(tool.timer);
    this.pending.clear();
    this.queuedProviderEvents.length = 0;
    this.inputTranscript.finish();
    this.finishOutputTranscript();
    this.closeSession(this.session);
    this.session = undefined;
    this.emit({ type: "closed", reason });
    this.closePeer(code, reason);
  }

  private fail(error: ServiceError): void {
    if (this.ended) return;
    safeLog("live", error);
    this.emit({ type: "error", message: error.message, recoverable: error.retryable });
    this.stop(error.message, error.status < 500 ? 1008 : 1011);
  }

  private start(context: ConversationContext): void {
    const npc = canonicalNpc(context);
    this.started = true;
    this.context = context;
    clearTimeout(this.setupTimer);
    this.setupTimer = setTimeout(() => this.fail(new ServiceError(504, "LIVE_SETUP_TIMEOUT", "Gemini Live did not become ready in time. You can explicitly retry or use text mode.", true)), this.options.setupTimeoutMs ?? limits.liveSetupTimeoutMs);
    this.encounterTimer = setTimeout(() => this.fail(new ServiceError(408, "LIVE_ENCOUNTER_LIMIT", "This voice encounter reached its three-minute limit. The mission is still available; continue with text or start a new encounter.", true)), this.options.encounterMs ?? limits.encounterMs);
    const connecting = this.service.connectLive({
      config: {
        abortSignal: this.connectAbort.signal,
        responseModalities: [Modality.AUDIO],
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: npc.voiceName } } },
        systemInstruction: conversationInstruction(context, true),
        tools: [{ functionDeclarations: [gameActionTool(context)] }],
        maxOutputTokens: 2048,
        realtimeInputConfig: {
          activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
          automaticActivityDetection: { silenceDurationMs: 600, prefixPaddingMs: 100 },
        },
      },
      callbacks: {
        onmessage: message => this.providerMessage(message),
        onerror: () => this.fail(new ServiceError(502, "LIVE_TRANSPORT", "The Gemini Live connection failed. Explicitly retry or continue with text.", true)),
        onclose: () => {
          if (!this.ended) this.fail(new ServiceError(502, "LIVE_PROVIDER_CLOSED", "Gemini ended the live connection. Your game state is preserved; explicitly reconnect or use text.", true));
        },
      },
    });
    void connecting.then(session => {
      if (this.ended) {
        this.closeSession(session);
        return;
      }
      this.session = session;
      this.becomeReady();
    }).catch(error => this.fail(providerError(error)));
  }

  private closeSession(session?: LiveSession): void {
    if (!session) return;
    try { session.close(); } catch (error) { safeLog("live-close", error); }
  }

  private becomeReady(): void {
    if (this.ended || this.ready || !this.setupReceived || !this.session) return;
    this.ready = true;
    clearTimeout(this.setupTimer);
    this.emit({ type: "ready" });
    if (this.contextChanged) this.sendContext();
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: "[Scene start, not visitor speech] The visitor has just approached. Greet them in character and ask one short question. Do not invent anything the visitor said." }] }],
      turnComplete: true,
    });
    for (const message of this.queuedProviderEvents.splice(0)) this.providerMessage(message);
  }

  private sendContext(): void {
    if (!this.context || !this.session || this.ended) return;
    this.session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: `[Engine state update, not visitor speech] ${JSON.stringify(conversationSnapshot(this.context))}` }] }],
      turnComplete: false,
    });
    this.contextChanged = false;
  }

  private endAudioStream(): void {
    clearTimeout(this.audioGapTimer);
    if (!this.audioStreamActive || !this.session || this.ended) return;
    this.audioStreamActive = false;
    try { this.session.sendRealtimeInput({ audioStreamEnd: true }); }
    catch (error) { this.fail(providerError(error)); }
  }

  private providerMessage(message: LiveServerMessage): void {
    if (this.ended) return;
    try {
      if (message.setupComplete) {
        this.setupReceived = true;
        this.becomeReady();
      }
      const hasContent = message.serverContent || message.toolCall || message.toolCallCancellation || message.goAway;
      if (!this.ready) {
        if (hasContent) {
          if (this.queuedProviderEvents.length >= 16) throw invalidResponse();
          this.queuedProviderEvents.push(message);
        }
        return;
      }
      for (const id of message.toolCallCancellation?.ids ?? []) {
        this.cancelledCalls.add(id);
        for (const [requestId, pending] of this.pending) {
          if (pending.id === id) {
            clearTimeout(pending.timer);
            this.pending.delete(requestId);
          }
        }
        if (this.cancelledCalls.size > 128) throw invalidResponse();
      }
      if (message.voiceActivity?.voiceActivityType === "ACTIVITY_START") this.inputSpeaking = true;
      if (message.voiceActivity?.voiceActivityType === "ACTIVITY_END") this.inputSpeaking = false;
      const content = message.serverContent;
      if (content?.inputTranscription) this.inputTranscript.append(content.inputTranscription);
      if (content?.outputTranscription) {
        this.outputHadTranscript = true;
        this.outputTranscript.append(content.outputTranscription);
      }
      for (const part of content?.modelTurn?.parts ?? []) {
        if (part.thought) continue;
        if (part.text) {
          this.outputTextFallback += part.text;
          if (this.outputTextFallback.length > limits.maxTranscriptChars) throw invalidResponse();
        }
        if (part.inlineData) {
          const { data, mimeType } = part.inlineData;
          if (!data || data.length > 512 * 1024 || !mimeType || !/^audio\/(?:pcm|l16)(?:;.*)?$/i.test(mimeType)) throw invalidResponse();
          const rate = /(?:^|;)\s*rate=(\d+)/i.exec(mimeType);
          if (rate && Number(rate[1]) !== 24_000) throw invalidResponse();
          const bytes = Buffer.from(data, "base64");
          if (!bytes.length || bytes.length % 2) throw invalidResponse();
          this.emit({ type: "audio", data, sampleRate: 24_000 });
        }
      }
      for (const call of message.toolCall?.functionCalls ?? []) this.functionCall(call);
      if (content?.interrupted) {
        this.emit({ type: "interrupted" });
        this.finishOutputTranscript();
      }
      if (content?.generationComplete) this.finishOutputTranscript();
      if (content?.turnComplete) {
        this.finishOutputTranscript();
        if (!this.inputSpeaking) this.inputTranscript.finish();
        // A blocking tool in the same event must finish before the farewell can finish.
        if (!this.pending.size) this.emit({ type: "turn_complete" });
      }
      if (message.goAway) this.emit({ type: "error", message: "Gemini will close this encounter soon. Finish the exchange, then explicitly reconnect or use text.", recoverable: true });
    } catch (error) {
      this.fail(error instanceof ServiceError ? error : providerError(error));
    }
  }

  private finishOutputTranscript(): void {
    if (!this.outputHadTranscript && this.outputTextFallback) {
      this.outputTranscript.append({ text: this.outputTextFallback });
    }
    this.outputTranscript.finish();
    this.outputTextFallback = "";
    this.outputHadTranscript = false;
  }

  private functionCall(call: FunctionCall): void {
    if (!this.session || !this.context) throw invalidResponse();
    if (!call.id || call.id.length > 128 || !call.name || call.name.length > 96) throw invalidResponse();
    if (this.cancelledCalls.has(call.id)) return;
    const completed = this.completedCalls.get(call.id);
    if (completed) {
      this.sendToolResponse(call.id, call.name, completed);
      return;
    }
    if (this.seenCalls.has(call.id)) return;
    this.seenCalls.add(call.id);
    if (this.seenCalls.size > 96) throw new ServiceError(429, "LIVE_TOOL_LIMIT", "This encounter requested too many game actions. Continue with text or a new encounter.");
    const args = actionArgumentsSchema.safeParse(call.args);
    const parsed = args.success ? gameActionSchema.safeParse({ ...args.data, npcId: this.context.npc.id }) : undefined;
    if (call.name !== "apply_game_action" || !parsed?.success || !actionIsAllowed(parsed.data, this.context)) {
      const result = { accepted: false, message: "The proposed action is invalid, unavailable to this NPC, or unsupported by the supplied game evidence. No action was sent to the game engine." };
      this.completedCalls.set(call.id, result);
      this.sendToolResponse(call.id, call.name, result);
      return;
    }
    if (this.pending.size >= limits.maxPendingTools) {
      this.sendToolResponse(call.id, call.name, { accepted: false, message: "Too many actions are awaiting game-engine confirmation. Wait for those results." });
      return;
    }
    const requestId = randomUUID();
    const pending: PendingTool = {
      id: call.id,
      name: call.name,
      timer: setTimeout(() => {
        if (this.ended || !this.pending.delete(requestId)) return;
        const result = { accepted: false, message: "The game engine did not confirm this action in time. It was not approved." };
        this.completedCalls.set(pending.id, result);
        try { this.sendToolResponse(pending.id, pending.name, result); }
        catch (error) { this.fail(providerError(error)); }
        if (!this.ended) this.emit({ type: "error", message: "A game action timed out waiting for the engine. It was not approved.", recoverable: true });
      }, this.options.toolTimeoutMs ?? limits.toolTimeoutMs),
    };
    this.pending.set(requestId, pending);
    this.emit({ type: "action", requestId, action: parsed.data });
  }

  private toolResult(requestId: string, result: ActionResult): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.emit({ type: "error", message: "That action was already answered, cancelled, or expired; its late result was not sent to Gemini.", recoverable: true });
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    this.completedCalls.set(pending.id, result);
    this.sendToolResponse(pending.id, pending.name, result);
  }

  private sendToolResponse(id: string, name: string, result: ActionResult): void {
    if (!this.session || this.ended) return;
    this.session.sendToolResponse({ functionResponses: [{ id, name, response: { accepted: result.accepted, message: result.message } }] });
  }
}
