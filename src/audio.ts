import type {
  ActionResult, ClientLiveMessage, ConversationContext, GameAction, ServerLiveMessage, VoiceStatus,
} from "../shared/types";

export interface VoiceCallbacks {
  onStatus?: (status: VoiceStatus) => void;
  onTranscript?: (entry: { speaker: "player" | "npc"; text: string; final: boolean }) => void;
  onAction?: (action: GameAction, requestId: string) => void;
  onLevel?: (level: number) => void;
  onError?: (message: string) => void;
  onClose?: () => void;
  onTurnComplete?: () => void;
  onPlaybackDrained?: () => void;
  onCameraStream?: (stream: MediaStream | null) => void;
}

const MAX_SOCKET_BYTES = 256 * 1024;
const MAX_QUEUED_SECONDS = 12;
const MAX_TTS_BYTES = 8 * 1024 * 1024;
const cancelled = () => new DOMException("Audio operation cancelled.", "AbortError");
const isCancelled = (error: unknown) => error instanceof Error && error.name === "AbortError";
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const string = (value: unknown, maximum = 2000): value is string => typeof value === "string" && value.length > 0 && value.length <= maximum;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const fields = ["name", "company", "role", "host", "callback", "employeeId", "ticket"];

function isAction(value: unknown): value is GameAction {
  if (!record(value) || !string(value.npcId, 96)) return false;
  switch (value.type) {
    case "claim": return string(value.field, 20) && fields.includes(value.field) && string(value.value, 240) && string(value.quote, 1000);
    case "suspicion": return finite(value.delta) && value.delta >= -25 && value.delta <= 30 && string(value.reason) && (value.evidence === undefined || string(value.evidence));
    case "register":
    case "authorize":
    case "issue_card": return string(value.name, 240);
    case "discover": return string(value.factId, 96);
    case "end_conversation": return string(value.summary);
    case "security_resolution": return ["warning", "burned", "double_cross"].includes(String(value.result)) && string(value.reason);
    default: return false;
  }
}

function parseServerMessage(raw: unknown): ServerLiveMessage {
  if (typeof raw !== "string" || new TextEncoder().encode(raw).byteLength > 768 * 1024) throw new Error("The voice server sent an invalid or oversized message.");
  const value: unknown = JSON.parse(raw);
  if (record(value)) {
    switch (value.type) {
      case "ready": return { type: "ready" };
      case "interrupted": return { type: "interrupted" };
      case "turn_complete": return { type: "turn_complete" };
      case "closed":
        if (string(value.reason)) return { type: "closed", reason: value.reason };
        break;
      case "error":
        if (string(value.message) && typeof value.recoverable === "boolean") return { type: "error", message: value.message, recoverable: value.recoverable };
        break;
      case "audio":
        if (string(value.data, 512 * 1024) && value.sampleRate === 24000
          && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
          return { type: "audio", data: value.data, sampleRate: value.sampleRate };
        }
        break;
      case "transcript":
        if ((value.speaker === "player" || value.speaker === "npc") && string(value.text, 12_000) && typeof value.final === "boolean") {
          return { type: "transcript", speaker: value.speaker, text: value.text, final: value.final };
        }
        break;
      case "action":
        if (string(value.requestId, 128) && isAction(value.action)) return { type: "action", requestId: value.requestId, action: value.action };
        break;
    }
  }
  throw new Error("The voice server sent a message that does not match the game protocol.");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function microphoneError(error: unknown): string {
  if (error instanceof Error && error.name === "NotAllowedError") return "Microphone permission was declined. Audio playback is unlocked; use the labeled text alternative.";
  if (error instanceof Error && error.name === "NotFoundError") return "No microphone was found. Audio playback is available with the text alternative.";
  if (error instanceof Error && error.name === "NotReadableError") return "The microphone is busy or unavailable. Close other microphone users or continue with text.";
  return "The microphone could not be prepared. Audio playback remains available when supported; use the text alternative.";
}

interface PendingConnection {
  resolve: () => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class VoiceClient {
  private currentStatus: VoiceStatus = "idle";
  private audioContext: AudioContext | null = null;
  private output: GainNode | null = null;
  private microphone: MediaStream | null = null;
  private microphoneSource: MediaStreamAudioSourceNode | null = null;
  private processor: AudioWorkletNode | null = null;
  private silentSink: GainNode | null = null;
  private preparePromise: Promise<void> | null = null;
  private workletModule: Promise<void> | null = null;
  private mediaEpoch = 0;
  private muted = false;
  private volume = 1;
  private captureActive = false;
  private disposed = false;
  private socket: WebSocket | null = null;
  private connectionEpoch = 0;
  private active = false;
  private pendingConnection: PendingConnection | null = null;
  private context: ConversationContext | null = null;
  private lastServerError = false;
  private readonly pendingActions = new Set<string>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextPlaybackAt = 0;
  private turnComplete = false;
  private interruptedTurn = false;
  private drainNotified = true;
  private narrationAbort: AbortController | null = null;
  private narrationEpoch = 0;
  private narrationSource: AudioBufferSourceNode | null = null;
  private rejectNarration: ((error: Error) => void) | null = null;
  private camera: MediaStream | null = null;
  private cameraVideo: HTMLVideoElement | null = null;
  private cameraCanvas: HTMLCanvasElement | null = null;
  private cameraEpoch = 0;
  private cameraTimer: ReturnType<typeof setInterval> | null = null;
  private cameraFrameBusy = false;

  constructor(private readonly callbacks: VoiceCallbacks) {
    document.addEventListener("visibilitychange", this.visibilityChanged);
    window.addEventListener("pagehide", this.pageHidden);
  }

  get status(): VoiceStatus { return this.currentStatus; }
  get micEnabled(): boolean {
    return !this.muted && Boolean(this.microphone?.getAudioTracks().some(track => track.readyState === "live"));
  }

  prepare(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("This audio client has been disposed."));
    if (this.preparePromise) return this.preparePromise;
    if (this.processor && this.microphone?.getAudioTracks().some(track => track.readyState === "live")) {
      return this.audioContext?.state === "suspended" ? this.audioContext.resume() : Promise.resolve();
    }
    this.preparePromise = this.prepareAudio().finally(() => { this.preparePromise = null; });
    return this.preparePromise;
  }

  private async prepareAudio(): Promise<void> {
    const epoch = ++this.mediaEpoch;
    try {
      if (!globalThis.AudioContext) throw new Error("Web Audio is unavailable in this browser.");
      this.releaseMicrophone();
      const audio = this.audioContext ?? new AudioContext({ latencyHint: "interactive" });
      if (!this.audioContext) {
        this.audioContext = audio;
        this.output = audio.createGain();
        this.output.gain.value = this.volume;
        this.output.connect(audio.destination);
      }
      // Unlock only inside an explicit Start or Retry Microphone gesture.
      const resume = audio.resume();
      const unlock = audio.createBufferSource();
      unlock.buffer = audio.createBuffer(1, 1, audio.sampleRate);
      unlock.connect(this.output!);
      unlock.onended = () => unlock.disconnect();
      unlock.start();
      const request = navigator.mediaDevices?.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      }) ?? Promise.reject(new Error("Microphone capture requires a supported browser on localhost or HTTPS."));
      const media = request.then(stream => {
        if (this.disposed || epoch !== this.mediaEpoch) {
          stream.getTracks().forEach(track => track.stop());
          return { error: cancelled() };
        }
        stream.getAudioTracks().forEach(track => { track.enabled = false; });
        this.microphone = stream;
        return { stream };
      }, error => ({ error }));
      await resume;
      if (!audio.audioWorklet || !globalThis.AudioWorkletNode) throw new Error("AudioWorklet is not supported.");
      if (!this.workletModule) {
        this.workletModule = audio.audioWorklet.addModule("/pcm-processor.js").catch(error => {
          this.workletModule = null;
          throw error;
        });
      }
      await this.workletModule;
      const result = await media;
      if ("error" in result) throw result.error;
      if (this.disposed || epoch !== this.mediaEpoch) throw cancelled();
      this.microphoneSource = audio.createMediaStreamSource(result.stream);
      this.processor = new AudioWorkletNode(audio, "glasshouse-pcm", {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: "explicit",
      });
      this.silentSink = audio.createGain();
      this.silentSink.gain.value = 0;
      this.microphoneSource.connect(this.processor);
      this.processor.connect(this.silentSink);
      this.silentSink.connect(audio.destination);
      this.processor.port.onmessage = event => this.microphoneFrame(event.data);
      this.processor.onprocessorerror = () => {
        this.releaseMicrophone();
        this.report("Microphone processing stopped. Continue using the text alternative.");
      };
      for (const track of result.stream.getAudioTracks()) {
        track.onended = () => {
          if (!this.disposed) {
            this.refreshCapture();
            this.report("The microphone was disconnected. You can continue with text.");
          }
        };
      }
      this.refreshCapture();
      this.setStatus(this.active ? (this.sources.size ? "speaking" : "listening") : this.pendingConnection ? "connecting" : "idle");
    } catch (error) {
      this.mediaEpoch++;
      this.releaseMicrophone();
      if (this.disposed || isCancelled(error)) throw cancelled();
      const message = microphoneError(error);
      this.report(message);
      this.setStatus(this.active ? (this.sources.size ? "speaking" : "listening") : "error");
      throw new Error(message);
    }
  }

  connect(context: ConversationContext): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("This audio client has been disposed."));
    if (!this.audioContext || !this.output) {
      const error = new Error("Use Begin Mission first to unlock browser audio. No microphone is requested automatically.");
      this.report(error.message);
      return Promise.reject(error);
    }
    this.disconnect();
    const epoch = ++this.connectionEpoch;
    this.context = context;
    this.lastServerError = false;
    this.setStatus("connecting");
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.failConnection("The voice connection timed out. Retry explicitly or use text."), 25_000);
      this.pendingConnection = { resolve, reject, timer };
      void this.audioContext!.resume().then(() => {
        if (this.disposed || epoch !== this.connectionEpoch) return;
        const protocol = location.protocol === "https:" ? "wss:" : "ws:";
        const socket = new WebSocket(`${protocol}//${location.host}/api/live`);
        this.socket = socket;
        socket.onopen = () => {
          if (epoch !== this.connectionEpoch || !this.context) return;
          this.send({ type: "start", context: this.context });
        };
        socket.onmessage = event => {
          if (epoch !== this.connectionEpoch) return;
          try { this.serverMessage(parseServerMessage(event.data)); }
          catch { this.failConnection("The voice response was malformed or could not be played. Continue with text or explicitly reconnect."); }
        };
        socket.onerror = () => {
          if (epoch === this.connectionEpoch) this.failConnection("The voice connection failed. Check the local server, then explicitly retry or use text.");
        };
        socket.onclose = () => {
          if (epoch === this.connectionEpoch) this.failConnection("The voice connection closed. Your game progress is preserved; explicitly reconnect or use text.");
        };
      }).catch(() => {
        if (epoch === this.connectionEpoch) this.failConnection("Browser audio is suspended. Use a browser gesture to resume audio or continue with text.");
      });
    });
  }

  disconnect(): void {
    this.cancelNarration();
    this.closeConnection(false);
  }

  private closeConnection(error: boolean): void {
    const hadConnection = Boolean(this.socket || this.pendingConnection || this.active);
    this.connectionEpoch++;
    this.active = false;
    this.turnComplete = false;
    this.interruptedTurn = false;
    this.pendingActions.clear();
    this.refreshCapture();
    this.refreshCamera();
    this.flushPlayback();
    if (this.pendingConnection) {
      clearTimeout(this.pendingConnection.timer);
      this.pendingConnection.reject(error ? new Error("The live voice connection could not be established.") : cancelled());
      this.pendingConnection = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "stop" } satisfies ClientLiveMessage));
      if (socket.readyState < WebSocket.CLOSING) socket.close(1000, "Encounter ended");
    }
    this.context = null;
    this.setStatus(error ? "error" : "idle");
    if (hadConnection) this.callbacks.onClose?.();
  }

  private failConnection(message: string): void {
    this.report(message);
    this.closeConnection(true);
  }

  updateContext(context: ConversationContext): void {
    if (!this.context || context.npc.id !== this.context.npc.id) {
      this.report("Game context cannot change the character of an active encounter.");
      return;
    }
    this.context = context;
    if (this.active) this.send({ type: "context", context });
  }

  respondToTool(requestId: string, result: ActionResult): void {
    if (!this.pendingActions.has(requestId)) {
      this.report("This game action is no longer awaiting a response.");
      return;
    }
    if (typeof result.accepted !== "boolean" || !string(result.message)) {
      this.report("The game engine returned an invalid action result.");
      return;
    }
    this.pendingActions.delete(requestId);
    this.send({ type: "tool_result", requestId, result });
  }

  sendText(text: string): void {
    text = text.trim();
    if (!this.active || !string(text, 2000)) {
      this.report("Enter up to 2000 characters during a connected encounter, or use the text alternative.");
      return;
    }
    this.interruptedTurn = true;
    this.turnComplete = false;
    this.flushPlayback();
    this.send({ type: "text", text });
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.refreshCapture();
  }

  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) {
      this.report("Speaker volume must be a number between zero and one.");
      return;
    }
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.output && this.audioContext) this.output.gain.setTargetAtTime(this.volume, this.audioContext.currentTime, 0.015);
  }

  private refreshCapture(): void {
    const active = !this.disposed && this.active && this.micEnabled && !document.hidden;
    for (const track of this.microphone?.getAudioTracks() ?? []) track.enabled = active;
    if (this.captureActive !== active) {
      this.captureActive = active;
      this.processor?.port.postMessage({ type: "active", active });
      if (!active) this.callbacks.onLevel?.(0);
    }
  }

  private microphoneFrame(value: unknown): void {
    if (!this.captureActive || !this.active || !record(value)) return;
    if (!(value.pcm instanceof ArrayBuffer) || value.pcm.byteLength !== 640 || !finite(value.level)) {
      this.failConnection("Microphone processing produced invalid audio. Continue with text.");
      return;
    }
    this.callbacks.onLevel?.(Math.max(0, Math.min(1, value.level * 3)));
    this.send({ type: "audio", data: encodeBase64(new Uint8Array(value.pcm)), sampleRate: 16000 });
  }

  private send(message: ClientLiveMessage): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.report("The live connection is not ready.");
      return false;
    }
    if (this.socket.bufferedAmount > MAX_SOCKET_BYTES) {
      this.failConnection("The network cannot keep up with live audio. Capture stopped; use text or explicitly reconnect.");
      return false;
    }
    const encoded = JSON.stringify(message);
    if (new TextEncoder().encode(encoded).byteLength > 384 * 1024) {
      this.failConnection("The live message exceeded the local size limit.");
      return false;
    }
    this.socket.send(encoded);
    return true;
  }

  private serverMessage(message: ServerLiveMessage): void {
    switch (message.type) {
      case "ready":
        this.active = true;
        this.refreshCapture();
        this.refreshCamera();
        this.setStatus("listening");
        if (this.pendingConnection) {
          clearTimeout(this.pendingConnection.timer);
          this.pendingConnection.resolve();
          this.pendingConnection = null;
        }
        break;
      case "audio":
        this.queuePcm(message.data, message.sampleRate);
        break;
      case "transcript":
        this.callbacks.onTranscript?.({ speaker: message.speaker, text: message.text, final: message.final });
        break;
      case "action":
        if (this.pendingActions.has(message.requestId)) break;
        if (this.pendingActions.size >= 12) throw new Error("Too many pending game actions.");
        this.pendingActions.add(message.requestId);
        if (!this.callbacks.onAction) {
          this.respondToTool(message.requestId, { accepted: false, message: "No game engine is attached to this voice client." });
          break;
        }
        try { this.callbacks.onAction(message.action, message.requestId); }
        catch {
          this.report("The game engine could not apply the proposed action.");
          if (this.pendingActions.has(message.requestId)) this.respondToTool(message.requestId, { accepted: false, message: "The game action handler failed; the action was not confirmed." });
        }
        break;
      case "interrupted":
        this.interruptedTurn = true;
        this.turnComplete = false;
        this.flushPlayback();
        if (this.active) this.setStatus("listening");
        break;
      case "turn_complete":
        if (this.interruptedTurn) {
          this.interruptedTurn = false;
          break;
        }
        this.turnComplete = true;
        this.notifyDrained();
        break;
      case "error":
        this.lastServerError = true;
        this.report(message.message);
        if (!message.recoverable) this.closeConnection(true);
        break;
      case "closed":
        this.closeConnection(this.lastServerError);
        break;
    }
  }

  private queuePcm(data: string, sampleRate: number): void {
    if (!this.active || !this.audioContext || !this.output) throw new Error("Audio arrived outside an encounter.");
    const binary = atob(data);
    if (!binary.length || binary.length % 2 || binary.length > 384 * 1024) throw new Error("Invalid PCM data.");
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    const buffer = this.audioContext.createBuffer(1, bytes.length / 2, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index++) channel[index] = view.getInt16(index * 2, true) / 32768;
    const now = this.audioContext.currentTime;
    const start = Math.max(now + 0.015, this.nextPlaybackAt);
    if (start + buffer.duration - now > MAX_QUEUED_SECONDS || this.sources.size >= 512) {
      throw new Error("The live speaker queue exceeded its duration limit.");
    }
    this.interruptedTurn = false;
    this.turnComplete = false;
    this.schedule(buffer, start);
  }

  private schedule(buffer: AudioBuffer, start: number, ended?: () => void): AudioBufferSourceNode {
    if (!this.audioContext || !this.output) throw new Error("Browser audio is not prepared.");
    const source = this.audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output);
    source.onended = () => {
      if (!this.sources.delete(source)) return;
      source.disconnect();
      ended?.();
      this.notifyDrained();
    };
    source.start(start);
    this.sources.add(source);
    this.nextPlaybackAt = start + buffer.duration;
    this.drainNotified = false;
    this.setStatus("speaking");
    return source;
  }

  private notifyDrained(): void {
    if (this.sources.size) return;
    this.nextPlaybackAt = this.audioContext?.currentTime ?? 0;
    if (!this.drainNotified) {
      this.drainNotified = true;
      this.callbacks.onPlaybackDrained?.();
    }
    if (this.active) {
      this.setStatus("listening");
      if (this.turnComplete && !this.interruptedTurn) {
        this.turnComplete = false;
        this.callbacks.onTurnComplete?.();
      }
    } else if (this.currentStatus === "speaking") {
      this.setStatus("idle");
    }
  }

  private flushPlayback(): void {
    const sources = [...this.sources];
    this.sources.clear();
    for (const source of sources) {
      source.onended = null;
      source.stop();
      source.disconnect();
    }
    this.nextPlaybackAt = this.audioContext?.currentTime ?? 0;
    this.notifyDrained();
  }

  async playNarration(text: string, voiceName: string): Promise<void> {
    if (this.disposed || !this.audioContext || !this.output) throw new Error("Use Begin Mission first to unlock narration audio.");
    if (this.active || this.pendingConnection) throw new Error("Narration cannot overlap an active NPC encounter.");
    if (!string(text.trim(), 1200) || !/^[A-Za-z]{1,64}$/.test(voiceName)) throw new Error("Narration text or voice is invalid.");
    this.cancelNarration();
    const epoch = ++this.narrationEpoch;
    const controller = new AbortController();
    this.narrationAbort = controller;
    const timer = setTimeout(() => controller.abort(new Error("Narration request timed out.")), 45_000);
    try {
      await this.audioContext.resume();
      const response = await fetch("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: text.trim(), voiceName }), signal: controller.signal,
      });
      if (!response.ok) {
        let detail = `Narration request failed (HTTP ${response.status}).`;
        try {
          const error: unknown = await response.json();
          if (record(error) && record(error.error) && string(error.error.message)) detail = error.error.message;
        } catch { detail += " The server did not return a valid error response."; }
        throw new Error(detail);
      }
      if (!response.headers.get("Content-Type")?.startsWith("audio/wav")) throw new Error("The narration server returned a non-audio response.");
      const declaredSize = Number(response.headers.get("Content-Length") || 0);
      if (declaredSize > MAX_TTS_BYTES) throw new Error("Narration audio exceeds the size limit.");
      const data = await response.arrayBuffer();
      if (data.byteLength > MAX_TTS_BYTES || data.byteLength < 44) throw new Error("Narration audio is empty or oversized.");
      const buffer = await this.audioContext.decodeAudioData(data);
      if (epoch !== this.narrationEpoch || this.disposed) throw cancelled();
      controller.signal.throwIfAborted();
      if (!buffer.duration || buffer.duration > 60) throw new Error("Narration exceeds the one-minute playback limit.");
      clearTimeout(timer);
      await new Promise<void>((resolve, reject) => {
        this.rejectNarration = reject;
        this.narrationSource = this.schedule(buffer, this.audioContext!.currentTime + 0.015, () => {
          this.narrationSource = null;
          this.rejectNarration = null;
          resolve();
        });
      });
    } catch (error) {
      if (epoch !== this.narrationEpoch || isCancelled(error)) throw cancelled();
      const message = controller.signal.aborted ? "Narration timed out. Captions and text remain available."
        : error instanceof Error ? error.message : "Narration failed. Captions and text remain available.";
      this.report(message);
      throw new Error(message);
    } finally {
      clearTimeout(timer);
      if (epoch === this.narrationEpoch) this.narrationAbort = null;
    }
  }

  private cancelNarration(): void {
    this.narrationEpoch++;
    this.narrationAbort?.abort(cancelled());
    this.narrationAbort = null;
    this.rejectNarration?.(cancelled());
    this.rejectNarration = null;
    if (this.narrationSource) {
      this.sources.delete(this.narrationSource);
      this.narrationSource.onended = null;
      this.narrationSource.stop();
      this.narrationSource.disconnect();
      this.narrationSource = null;
      this.notifyDrained();
    }
  }

  async setCameraEnabled(enabled: boolean): Promise<void> {
    if (!enabled) {
      this.releaseCamera();
      return;
    }
    if (this.disposed) throw new Error("This audio client has been disposed.");
    if (this.camera) return;
    const epoch = ++this.cameraEpoch;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Camera access requires localhost or HTTPS.");
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320, max: 640 }, height: { ideal: 240, max: 480 }, facingMode: "user" }, audio: false,
      });
      if (this.disposed || epoch !== this.cameraEpoch) {
        stream.getTracks().forEach(track => track.stop());
        throw cancelled();
      }
      this.camera = stream;
      this.cameraVideo = document.createElement("video");
      this.cameraVideo.muted = true;
      this.cameraVideo.playsInline = true;
      this.cameraVideo.srcObject = stream;
      this.cameraCanvas = document.createElement("canvas");
      if (!this.cameraCanvas.getContext("2d")) throw new Error("Camera frame processing is unavailable.");
      await this.cameraVideo.play();
      if (epoch !== this.cameraEpoch || this.disposed) throw cancelled();
      for (const track of stream.getVideoTracks()) {
        track.onended = () => {
          if (this.camera === stream) {
            this.releaseCamera();
            this.report("The optional camera was disconnected. The game remains fully playable.");
          }
        };
      }
      this.callbacks.onCameraStream?.(stream);
      this.refreshCamera();
    } catch (error) {
      if (epoch !== this.cameraEpoch || isCancelled(error)) throw cancelled();
      this.releaseCamera();
      const message = "The optional camera could not be enabled. You can play the entire game without it.";
      this.report(message);
      throw new Error(message);
    }
  }

  private refreshCamera(): void {
    if (this.cameraTimer) clearInterval(this.cameraTimer);
    this.cameraTimer = null;
    const active = this.active && !this.disposed && !document.hidden;
    for (const track of this.camera?.getVideoTracks() ?? []) track.enabled = active;
    if (!active || !this.camera) return;
    this.cameraTimer = setInterval(() => this.captureCameraFrame(), 1100);
  }

  private captureCameraFrame(): void {
    const video = this.cameraVideo;
    const canvas = this.cameraCanvas;
    if (!this.active || !video || !canvas || this.cameraFrameBusy || document.hidden || video.readyState < 2) return;
    const context = canvas.getContext("2d");
    if (!context) {
      this.releaseCamera();
      this.report("Optional camera frame processing became unavailable.");
      return;
    }
    if (!video.videoWidth || !video.videoHeight) return;
    const epoch = this.cameraEpoch;
    const connection = this.connectionEpoch;
    const scale = Math.min(320 / video.videoWidth, 240 / video.videoHeight);
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    this.cameraFrameBusy = true;
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(blob => {
        void (async () => {
          try {
            if (!blob) throw new Error("Camera frame encoding failed.");
            if (blob.size > 196_608) throw new Error("Camera frame exceeds the size limit.");
            const bytes = await blob.arrayBuffer();
            if (this.active && epoch === this.cameraEpoch && connection === this.connectionEpoch && !document.hidden) {
              this.send({ type: "video", data: encodeBase64(new Uint8Array(bytes)) });
            }
          } catch {
            if (epoch === this.cameraEpoch) {
              this.releaseCamera();
              this.report("Optional camera streaming stopped because a frame could not be processed.");
            }
          } finally {
            if (epoch === this.cameraEpoch) this.cameraFrameBusy = false;
          }
        })();
      }, "image/jpeg", 0.65);
    } catch {
      this.releaseCamera();
      this.report("Optional camera streaming stopped because a frame could not be processed.");
    }
  }

  private releaseCamera(): void {
    this.cameraEpoch++;
    if (this.cameraTimer) clearInterval(this.cameraTimer);
    this.cameraTimer = null;
    for (const track of this.camera?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.camera = null;
    if (this.cameraVideo) {
      this.cameraVideo.pause();
      this.cameraVideo.srcObject = null;
    }
    this.cameraVideo = null;
    this.cameraCanvas = null;
    this.cameraFrameBusy = false;
    this.callbacks.onCameraStream?.(null);
  }

  private releaseMicrophone(): void {
    this.captureActive = false;
    this.processor?.port.postMessage({ type: "dispose" });
    if (this.processor) {
      this.processor.port.onmessage = null;
      this.processor.port.close();
      this.processor.onprocessorerror = null;
    }
    this.processor?.disconnect();
    this.microphoneSource?.disconnect();
    this.silentSink?.disconnect();
    this.processor = null;
    this.microphoneSource = null;
    this.silentSink = null;
    for (const track of this.microphone?.getTracks() ?? []) {
      track.onended = null;
      track.stop();
    }
    this.microphone = null;
    this.callbacks.onLevel?.(0);
  }

  private readonly visibilityChanged = () => {
    this.refreshCapture();
    this.refreshCamera();
  };
  private readonly pageHidden = () => this.disconnect();

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mediaEpoch++;
    this.disconnect();
    this.releaseMicrophone();
    this.releaseCamera();
    document.removeEventListener("visibilitychange", this.visibilityChanged);
    window.removeEventListener("pagehide", this.pageHidden);
    const audio = this.audioContext;
    this.audioContext = null;
    this.output = null;
    if (audio && audio.state !== "closed") {
      void audio.close().catch(() => this.report("The browser audio context could not be closed."));
    }
  }

  private setStatus(status: VoiceStatus): void {
    if (status === this.currentStatus) return;
    this.currentStatus = status;
    this.callbacks.onStatus?.(status);
  }

  private report(message: string): void {
    this.callbacks.onError?.(message);
  }
}
