import { afterEach, describe, expect, it, vi } from "vitest";
import { DirectorLoop } from "../src/ui/director";
import type { DirectorContext } from "../shared/types";

function context(id = 1): DirectorContext {
  return {
    floor: { id, name: "Reception", subtitle: "Visitor services", width: 2, height: 2, tiles: ["floor", "floor", "floor", "elevator"], rooms: [], spawn: { x: .5, y: .5 }, elevator: { x: 1.5, y: 1.5 }, palette: { floor: "#ccb98f", wall: "#4b725b", accent: "#8a4c51" } },
    player: { x: .5, y: .5, facing: "south", moving: false, carryingCard: false },
    npcs: [], events: [], alert: false,
  };
}

describe("batched Gemini director scheduling", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("sends the direct context, with one request in flight despite repeated nudges", async () => {
    vi.useFakeTimers();
    let complete!: (response: Response) => void;
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const onReply = vi.fn();
    const loop = new DirectorLoop({ context: () => context(), enabled: () => true, onReply, onError: vi.fn() });
    loop.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const options = fetcher.mock.calls[0][1];
    expect(JSON.parse(String(options?.body))).toEqual(context());
    for (let index = 0; index < 20; index += 1) loop.nudge();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    complete(Response.json({ source: "gemini", intents: [], chatter: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onReply).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("discards a reply for a floor the player already left", async () => {
    vi.useFakeTimers();
    let floorId = 1;
    let complete!: (response: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise<Response>((resolve) => { complete = resolve; }));
    const onReply = vi.fn();
    const loop = new DirectorLoop({ context: () => context(floorId), enabled: () => true, onReply, onError: vi.fn() });
    loop.start();
    await vi.advanceTimersByTimeAsync(300);
    floorId = 2;
    complete(Response.json({ source: "gemini", intents: [], chatter: [] }));
    await vi.advanceTimersByTimeAsync(0);
    expect(onReply).not.toHaveBeenCalled();
    loop.stop();
  });

  it("surfaces provider errors and backs off instead of manufacturing scripted replies", async () => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "Provider quota exhausted" }, { status: 429 }));
    const onReply = vi.fn();
    const onError = vi.fn();
    const loop = new DirectorLoop({ context: () => context(), enabled: () => true, onReply, onError });
    loop.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(onError).toHaveBeenCalledWith("Provider quota exhausted", expect.any(Number));
    expect(onReply).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    loop.stop();
  });

  it("makes no requests while practice mode or pause disables the director", async () => {
    vi.useFakeTimers();
    const fetcher = vi.spyOn(globalThis, "fetch");
    const loop = new DirectorLoop({ context: () => context(), enabled: () => false, onReply: vi.fn(), onError: vi.fn() });
    loop.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).not.toHaveBeenCalled();
    loop.stop();
  });

  it("rejects success-shaped non-Gemini fallbacks", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ source: "scripted", intents: [], chatter: [] }));
    const onReply = vi.fn();
    const onError = vi.fn();
    const loop = new DirectorLoop({ context: () => context(), enabled: () => true, onReply, onError });
    loop.start();
    await vi.advanceTimersByTimeAsync(300);
    expect(onReply).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Gemini returned an invalid director response.", expect.any(Number));
    loop.stop();
  });
});
