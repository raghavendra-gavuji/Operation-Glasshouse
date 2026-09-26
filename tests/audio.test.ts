import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceClient, type VoiceCallbacks } from "../src/audio";
import { NPCS } from "../shared/story";
import type { ClientLiveMessage, ConversationContext, ServerLiveMessage } from "../shared/types";
import { pcmToWav } from "../server/wav";

class Track {
  enabled = true;
  readyState = "live";
  onended: (() => void) | null = null;
  constructor(readonly kind: "audio" | "video") {}
  stop = vi.fn(() => { this.readyState = "ended"; });
}
class Stream {
  track: Track;
  constructor(kind: "audio" | "video" = "audio") { this.track = new Track(kind); }
  getTracks() { return [this.track]; }
  getAudioTracks() { return this.track.kind === "audio" ? [this.track] : []; }
  getVideoTracks() { return this.track.kind === "video" ? [this.track] : []; }
}
class Node {
  connect = vi.fn();
  disconnect = vi.fn();
}
class Gain extends Node {
  gain = {
    value: 1,
    setTargetAtTime: vi.fn((value: number) => { this.gain.value = value; }),
  };
}
class AudioData {
  duration: number;
  private data: Float32Array;
  constructor(readonly numberOfChannels: number, readonly length: number, readonly sampleRate: number) {
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData() { return this.data; }
}
class Source extends Node {
  buffer: AudioData | null = null;
  onended: (() => void) | null = null;
  start = vi.fn<(when?: number) => void>();
  stop = vi.fn();
  finish() { this.onended?.(); }
}
class BrowserAudioContext {
  static instances: BrowserAudioContext[] = [];
  state = "suspended";
  sampleRate = 48000;
  currentTime = 0;
  destination = new Node();
  audioWorklet = { addModule: vi.fn(async () => {}) };
  sources: Source[] = [];
  gains: Gain[] = [];
  constructor() { BrowserAudioContext.instances.push(this); }
  resume = vi.fn(async () => { this.state = "running"; });
  close = vi.fn(async () => { this.state = "closed"; });
  createBuffer(channels: number, length: number, rate: number) { return new AudioData(channels, length, rate); }
  createBufferSource() { const source = new Source(); this.sources.push(source); return source; }
  createGain() { const gain = new Gain(); this.gains.push(gain); return gain; }
  createMediaStreamSource = vi.fn(() => new Node());
  decodeAudioData = vi.fn(async () => new AudioData(1, 2400, 24000));
}
class Worklet extends Node {
  static instances: Worklet[] = [];
  port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn(), close: vi.fn() };
  onprocessorerror: (() => void) | null = null;
  constructor() { super(); Worklet.instances.push(this); }
  frame(data: unknown) { this.port.onmessage?.({ data }); }
}
class Socket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  sent: ClientLiveMessage[] = [];
  constructor(readonly url: string) { Socket.instances.push(this); }
  send = vi.fn((value: string) => { this.sent.push(JSON.parse(value)); });
  close = vi.fn(() => { this.readyState = Socket.CLOSED; this.onclose?.({ reason: "" }); });
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  deliver(message: ServerLiveMessage) { this.onmessage?.({ data: JSON.stringify(message) }); }
  deliverRaw(data: unknown) { this.onmessage?.({ data }); }
}
class Video {
  muted = false;
  playsInline = false;
  srcObject: unknown = null;
  readyState = 2;
  videoWidth = 320;
  videoHeight = 240;
  play = vi.fn(async () => {});
  pause = vi.fn();
}
class Canvas {
  width = 0;
  height = 0;
  context = { drawImage: vi.fn() };
  getContext() { return this.context; }
  toBlob(callback: (blob: Blob | null) => void) { callback(new Blob([new Uint8Array([255, 216, 255, 217])], { type: "image/jpeg" })); }
}
class Document extends EventTarget {
  hidden = false;
  videos: Video[] = [];
  canvases: Canvas[] = [];
  createElement(tag: string) {
    if (tag === "video") { const video = new Video(); this.videos.push(video); return video; }
    if (tag === "canvas") { const canvas = new Canvas(); this.canvases.push(canvas); return canvas; }
    throw new Error("Unsupported test element.");
  }
}

function context(): ConversationContext {
  const npc = NPCS.find(value => value.id === "priya");
  if (!npc) throw new Error("Missing test NPC.");
  return {
    npc, suspicion: 0, memory: "", cover: { name: "", company: "", role: "", host: "", callback: "", employeeId: "", ticket: "" },
    claims: [], knownFacts: [], heardRumors: [], visitorLog: null, authorization: null,
    carryingCard: false, secretKnown: false, floor: 1, clockMinute: 540,
  };
}
function pcm(seconds = 0.1) { return Buffer.alloc(Math.round(seconds * 24000) * 2).toString("base64"); }
async function microtasks() { for (let index = 0; index < 8; index++) await Promise.resolve(); }

describe("VoiceClient browser audio lifecycle", () => {
  let document: Document;
  let microphone: Stream;
  let camera: Stream;
  let getUserMedia: ReturnType<typeof vi.fn<(constraints: MediaStreamConstraints) => Promise<Stream>>>;
  const clients: VoiceClient[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    BrowserAudioContext.instances.length = 0;
    Socket.instances.length = 0;
    Worklet.instances.length = 0;
    document = new Document();
    microphone = new Stream();
    camera = new Stream("video");
    getUserMedia = vi.fn(async (constraints: MediaStreamConstraints) => constraints.video ? camera : microphone);
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
    vi.stubGlobal("location", { protocol: "http:", host: "127.0.0.1:4317" });
    vi.stubGlobal("AudioContext", BrowserAudioContext);
    vi.stubGlobal("AudioWorkletNode", Worklet);
    vi.stubGlobal("WebSocket", Socket);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(pcmToWav(Buffer.alloc(4800))), { headers: { "Content-Type": "audio/wav" } })));
  });
  afterEach(async () => {
    clients.forEach(client => client.dispose());
    clients.length = 0;
    await microtasks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  function client(callbacks: VoiceCallbacks = {}) { const value = new VoiceClient(callbacks); clients.push(value); return value; }
  async function connect(voice: VoiceClient) {
    const connection = voice.connect(context());
    await microtasks();
    const socket = Socket.instances.at(-1);
    if (!socket) throw new Error("No browser socket.");
    socket.open();
    socket.deliver({ type: "ready" });
    await connection;
    return socket;
  }

  it("unlocks audio and requests microphone only once, never camera at prepare", async () => {
    const voice = client();
    await voice.prepare();
    await voice.prepare();
    expect(BrowserAudioContext.instances).toHaveLength(1);
    expect(BrowserAudioContext.instances[0].resume).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getUserMedia.mock.calls[0][0].video).toBe(false);
    expect(microphone.track.enabled).toBe(false);
    expect(voice.micEnabled).toBe(true);
    expect(BrowserAudioContext.instances[0].audioWorklet.addModule).toHaveBeenCalledWith("/pcm-processor.js");
  });

  it("does not auto-request microphone or create audio from connect", async () => {
    await expect(client().connect(context())).rejects.toThrow("Begin Mission");
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(BrowserAudioContext.instances).toHaveLength(0);
  });

  it("keeps the unlocked context on mic denial, including text and narration", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    const transcript = vi.fn();
    const voice = client({ onTranscript: transcript });
    await expect(voice.prepare()).rejects.toThrow("permission");
    const audio = BrowserAudioContext.instances[0];
    expect(audio.state).toBe("running");
    expect(voice.micEnabled).toBe(false);
    const socket = await connect(voice);
    voice.sendText("My name is Nila.");
    expect(transcript).not.toHaveBeenCalled();
    socket.deliver({ type: "transcript", speaker: "player", text: "My name is Nila.", final: true });
    expect(transcript).toHaveBeenCalledOnce();
    expect(getUserMedia).toHaveBeenCalledOnce();
    voice.disconnect();
    const narration = voice.playNarration("Welcome.", "Kore");
    await vi.waitFor(() => expect(audio.sources.length).toBe(2));
    audio.sources[1].finish();
    await narration;
    expect(BrowserAudioContext.instances).toHaveLength(1);
    expect(audio.decodeAudioData).toHaveBeenCalledOnce();
  });

  it("allows an explicit microphone retry after denial without allocating a second AudioContext", async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError"));
    const voice = client();
    await expect(voice.prepare()).rejects.toThrow("permission");
    await voice.prepare();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(BrowserAudioContext.instances).toHaveLength(1);
    expect(BrowserAudioContext.instances[0].audioWorklet.addModule).toHaveBeenCalledOnce();
    expect(voice.micEnabled).toBe(true);
    expect(microphone.track.enabled).toBe(false);
  });

  it("reacquires an ended hardware track only after another explicit prepare call", async () => {
    const voice = client();
    await voice.prepare();
    microphone.track.readyState = "ended";
    microphone.track.onended?.();
    expect(getUserMedia).toHaveBeenCalledOnce();
    const replacement = new Stream();
    getUserMedia.mockResolvedValueOnce(replacement);
    await voice.prepare();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(BrowserAudioContext.instances).toHaveLength(1);
    expect(Worklet.instances[0].port.close).toHaveBeenCalledOnce();
    expect(voice.micEnabled).toBe(true);
    expect(replacement.track.enabled).toBe(false);
  });

  it("enables capture only after ready and disables it on mute, visibility and disconnect", async () => {
    const voice = client();
    await voice.prepare();
    const pending = voice.connect(context());
    await microtasks();
    const socket = Socket.instances[0];
    socket.open();
    expect(microphone.track.enabled).toBe(false);
    socket.deliver({ type: "ready" });
    await pending;
    expect(microphone.track.enabled).toBe(true);
    const processor = Worklet.instances[0];
    processor.frame({ pcm: new ArrayBuffer(640), level: 0.2 });
    expect(socket.sent.filter(value => value.type === "audio")).toHaveLength(1);
    voice.setMuted(true);
    processor.frame({ pcm: new ArrayBuffer(640), level: 0.2 });
    expect(microphone.track.enabled).toBe(false);
    expect(socket.sent.filter(value => value.type === "audio")).toHaveLength(1);
    voice.setVolume(0);
    expect(BrowserAudioContext.instances[0].gains[0].gain.value).toBe(0);
    voice.setMuted(false);
    expect(microphone.track.enabled).toBe(true);
    document.hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(microphone.track.enabled).toBe(false);
    document.hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(microphone.track.enabled).toBe(true);
    voice.disconnect();
    expect(microphone.track.enabled).toBe(false);
    processor.frame({ pcm: new ArrayBuffer(640), level: 0.2 });
    expect(socket.sent.filter(value => value.type === "audio")).toHaveLength(1);
  });

  it("never routes microphone audio directly to the speaker", async () => {
    const voice = client();
    await voice.prepare();
    const audio = BrowserAudioContext.instances[0];
    expect(audio.gains).toHaveLength(2);
    expect(audio.gains[1].gain.value).toBe(0);
    const source = audio.createMediaStreamSource.mock.results[0].value;
    expect(source.connect).toHaveBeenCalledWith(Worklet.instances[0]);
    expect(source.connect).not.toHaveBeenCalledWith(audio.destination);
  });

  it("plays little-endian PCM contiguously and fires turn completion only after drain", async () => {
    const onTurnComplete = vi.fn();
    const onPlaybackDrained = vi.fn();
    const voice = client({ onTurnComplete, onPlaybackDrained });
    await voice.prepare();
    const socket = await connect(voice);
    const bytes = Buffer.alloc(4800);
    bytes.writeInt16LE(-32768, 0);
    bytes.writeInt16LE(32767, 2);
    socket.deliver({ type: "audio", data: bytes.toString("base64"), sampleRate: 24000 });
    socket.deliver({ type: "audio", data: pcm(), sampleRate: 24000 });
    const [first, second] = BrowserAudioContext.instances[0].sources.slice(1);
    expect(first.buffer?.getChannelData()[0]).toBe(-1);
    expect(first.buffer?.getChannelData()[1]).toBeCloseTo(32767 / 32768);
    expect(second.start.mock.calls[0][0]).toBeCloseTo((first.start.mock.calls[0][0] ?? 0) + 0.1);
    socket.deliver({ type: "turn_complete" });
    expect(onTurnComplete).not.toHaveBeenCalled();
    first.finish();
    expect(onPlaybackDrained).not.toHaveBeenCalled();
    second.finish();
    expect(onPlaybackDrained).toHaveBeenCalledOnce();
    expect(onTurnComplete).toHaveBeenCalledOnce();
    expect(voice.status).toBe("listening");
  });

  it("flushes current and scheduled speech immediately on barge-in", async () => {
    const onTurnComplete = vi.fn();
    const voice = client({ onTurnComplete });
    await voice.prepare();
    const socket = await connect(voice);
    socket.deliver({ type: "audio", data: pcm(), sampleRate: 24000 });
    socket.deliver({ type: "audio", data: pcm(), sampleRate: 24000 });
    socket.deliver({ type: "interrupted" });
    for (const source of BrowserAudioContext.instances[0].sources.slice(1)) expect(source.stop).toHaveBeenCalledOnce();
    socket.deliver({ type: "turn_complete" });
    expect(onTurnComplete).not.toHaveBeenCalled();
    socket.deliver({ type: "audio", data: pcm(), sampleRate: 24000 });
    socket.deliver({ type: "turn_complete" });
    BrowserAudioContext.instances[0].sources.at(-1)?.finish();
    expect(onTurnComplete).toHaveBeenCalledOnce();
  });

  it("passes cumulative transcript snapshots through without duplicate assembly", async () => {
    const onTranscript = vi.fn();
    const voice = client({ onTranscript });
    await voice.prepare();
    const socket = await connect(voice);
    socket.deliver({ type: "transcript", speaker: "npc", text: "Wel", final: false });
    socket.deliver({ type: "transcript", speaker: "npc", text: "Welcome", final: false });
    socket.deliver({ type: "transcript", speaker: "npc", text: "Welcome", final: true });
    expect(onTranscript.mock.calls.map(([entry]) => entry.text)).toEqual(["Wel", "Welcome", "Welcome"]);
    expect(onTranscript.mock.calls[2][0].final).toBe(true);
  });

  it("does not acknowledge a tool until the engine explicitly responds", async () => {
    const onAction = vi.fn();
    const voice = client({ onAction });
    await voice.prepare();
    const socket = await connect(voice);
    const action = { type: "claim", npcId: "priya", field: "name", value: "Nila", quote: "Nila" } as const;
    socket.deliver({ type: "action", requestId: "action-1", action });
    expect(onAction).toHaveBeenCalledWith(action, "action-1");
    expect(socket.sent.some(value => value.type === "tool_result")).toBe(false);
    voice.respondToTool("action-1", { accepted: false, message: "Engine rejected." });
    expect(socket.sent.at(-1)).toEqual({ type: "tool_result", requestId: "action-1", result: { accepted: false, message: "Engine rejected." } });
  });

  it("rejects a proposed tool safely when no game engine is attached", async () => {
    const voice = client();
    await voice.prepare();
    const socket = await connect(voice);
    socket.deliver({ type: "action", requestId: "action-1", action: { type: "register", npcId: "priya", name: "Nila" } });
    expect(socket.sent.at(-1)).toMatchObject({ type: "tool_result", result: { accepted: false } });
  });

  it("bounds both outbound network pressure and queued speaker duration", async () => {
    const onError = vi.fn();
    const voice = client({ onError });
    await voice.prepare();
    const socket = await connect(voice);
    socket.bufferedAmount = 300_000;
    Worklet.instances[0].frame({ pcm: new ArrayBuffer(640), level: 0.1 });
    expect(voice.status).toBe("error");
    expect(microphone.track.enabled).toBe(false);
    expect(onError).toHaveBeenCalled();
    const next = await connect(voice);
    for (let index = 0; index < 26; index++) next.deliver({ type: "audio", data: pcm(0.5), sampleRate: 24000 });
    expect(voice.status).toBe("error");
    expect(Socket.instances).toHaveLength(2);
  });

  it("handles malformed server messages without leaving capture or pending sockets alive", async () => {
    const onError = vi.fn();
    const onClose = vi.fn();
    const voice = client({ onError, onClose });
    await voice.prepare();
    const socket = await connect(voice);
    socket.deliverRaw("{bad-json");
    expect(voice.status).toBe("error");
    expect(microphone.track.enabled).toBe(false);
    expect(socket.close).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("The voice response was malformed or could not be played. Continue with text or explicitly reconnect.");
    expect(onError).toHaveBeenCalledOnce();
  });

  it("passes the server's close reason to a reason-consuming onClose callback", async () => {
    const reasons: string[] = [];
    const voice = client({ onClose: reason => { reasons.push(reason); } });
    await voice.prepare();
    const socket = await connect(voice);
    socket.deliver({ type: "closed", reason: "The voice encounter reached its duration limit." });
    expect(reasons).toEqual(["The voice encounter reached its duration limit."]);
  });

  it("preserves a fatal server error as the close reason", async () => {
    const onClose = vi.fn();
    const voice = client({ onClose });
    await voice.prepare();
    const socket = await connect(voice);
    socket.deliver({ type: "error", message: "The voice provider rejected this encounter.", recoverable: false });
    expect(onClose).toHaveBeenCalledExactlyOnceWith("The voice provider rejected this encounter.");
  });

  it("preserves a native WebSocket close reason when no closed message arrived", async () => {
    const onClose = vi.fn();
    const voice = client({ onClose });
    await voice.prepare();
    const socket = await connect(voice);
    socket.readyState = Socket.CLOSED;
    socket.onclose?.({ reason: "The game server is shutting down." });
    expect(onClose).toHaveBeenCalledExactlyOnceWith("The game server is shutting down.");
  });

  it("provides a stable reason for an intentional disconnect", async () => {
    const onClose = vi.fn();
    const voice = client({ onClose });
    await voice.prepare();
    await connect(voice);
    voice.disconnect();
    expect(onClose).toHaveBeenCalledExactlyOnceWith("Encounter ended.");
  });

  it("measures WebSocket bounds in UTF-8 bytes rather than JavaScript characters", async () => {
    const voice = client();
    await voice.prepare();
    const socket = await connect(voice);
    voice.updateContext({ ...context(), memory: "\u20ac".repeat(140_000) });
    expect(voice.status).toBe("error");
    expect(socket.sent.some(message => message.type === "context")).toBe(false);
    expect(microphone.track.enabled).toBe(false);
  });

  it("times out setup without reconnecting and ignores late open events", async () => {
    const voice = client();
    await voice.prepare();
    const result = voice.connect(context()).catch(error => error);
    await microtasks();
    const socket = Socket.instances[0];
    const lateOpen = socket.onopen;
    await vi.advanceTimersByTimeAsync(25_001);
    expect(await result).toBeInstanceOf(Error);
    expect(voice.status).toBe("error");
    lateOpen?.();
    expect(socket.sent).toHaveLength(0);
    expect(Socket.instances).toHaveLength(1);
  });

  it("uses a separate camera consent and sends no more than one JPEG per second", async () => {
    const preview = vi.fn();
    const voice = client({ onCameraStream: preview });
    await voice.prepare();
    expect(getUserMedia).toHaveBeenCalledOnce();
    await voice.setCameraEnabled(true);
    expect(getUserMedia).toHaveBeenCalledTimes(2);
    expect(getUserMedia.mock.calls[1][0].audio).toBe(false);
    expect(camera.track.enabled).toBe(false);
    expect(preview).toHaveBeenCalledWith(camera);
    const socket = await connect(voice);
    await vi.advanceTimersByTimeAsync(3301);
    expect(socket.sent.filter(message => message.type === "video")).toHaveLength(3);
    expect(document.canvases[0].width).toBeLessThanOrEqual(320);
    expect(document.canvases[0].height).toBeLessThanOrEqual(240);
    await voice.setCameraEnabled(false);
    expect(camera.track.stop).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(3301);
    expect(socket.sent.filter(message => message.type === "video")).toHaveLength(3);
  });

  it("releases media tracks and an eventual late permission grant on dispose", async () => {
    let finish!: (stream: Stream) => void;
    getUserMedia.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const voice = client();
    const prepared = voice.prepare().catch(error => error);
    voice.dispose();
    finish(microphone);
    expect((await prepared).name).toBe("AbortError");
    expect(microphone.track.stop).toHaveBeenCalledOnce();
    expect(BrowserAudioContext.instances[0].close).toHaveBeenCalledOnce();
  });

  it("cancels narration before connecting rather than overlapping the NPC or hanging", async () => {
    const onError = vi.fn();
    const voice = client({ onError });
    await voice.prepare();
    const narration = voice.playNarration("Welcome.", "Kore").catch(error => error);
    const audio = BrowserAudioContext.instances[0];
    await vi.waitFor(() => expect(audio.sources.length).toBe(2));
    const socket = await connect(voice);
    expect((await narration).name).toBe("AbortError");
    expect(audio.sources[1].stop).toHaveBeenCalledOnce();
    expect(socket.sent[0].type).toBe("start");
    expect(onError).not.toHaveBeenCalled();
  });
});
