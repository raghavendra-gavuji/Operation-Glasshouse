import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtCache } from "../src/ui/assets";
import type { AssetRecord } from "../shared/types";

const created: TestImage[] = [];
class TestImage {
  complete = false;
  naturalWidth = 0;
  decoding = "";
  src = "";
  onload: (() => void) | undefined;
  onerror: (() => void) | undefined;
  constructor() { created.push(this); }
  getAttribute(name: string): string | null { return name === "src" ? this.src : null; }
  finish(): void { this.complete = true; this.naturalWidth = 96; this.onload?.(); }
}

function record(id: string, kind: AssetRecord["kind"] = "sprite", suffix = "a"): AssetRecord {
  return { id, kind, url: `/generated/${id}-${suffix}.png`, model: "gemini-image", generatedAt: "2026-09-26T00:00:00.000Z" };
}

function manifest(assets: AssetRecord[]): Response {
  return Response.json({ version: 1, assets, status: "ready" });
}

describe("manifest-backed image caching", () => {
  beforeEach(() => {
    created.length = 0;
    vi.stubGlobal("Image", TestImage);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("deduplicates concurrent manifest requests and only exposes loaded images", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifest([record("sprite-ghost")]));
    const cache = new ArtCache();
    await Promise.all([cache.load(), cache.load(), cache.load()]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(cache.image("sprite-ghost")).toBeUndefined();
    created[0].finish();
    expect(cache.image("sprite-ghost")).toBe(created[0]);
  });

  it("loads cached floor images ahead of travel without starting a generation request", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(manifest([record("floor-1", "floor"), record("floor-2", "floor")]));
    const cache = new ArtCache();
    await cache.load();
    await cache.prefetchFloors([2, 2, 0, 13]);
    await cache.prefetchFloors([2]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(2);
    expect(created[1].src).toContain("floor-2");
  });

  it("invalidates an image when its content-hashed manifest URL changes", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(manifest([record("sprite-ghost")])).mockResolvedValueOnce(manifest([record("sprite-ghost", "sprite", "b")]));
    const cache = new ArtCache();
    await cache.load();
    created[0].finish();
    await cache.load();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(created).toHaveLength(2);
    created[1].finish();
    expect(cache.image("sprite-ghost")).toBe(created[1]);
  });

  it("reports manifest and image errors rather than exposing broken image boxes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 503 })).mockResolvedValueOnce(manifest([record("sprite-ghost")]));
    const cache = new ArtCache();
    cache.onError = vi.fn();
    await cache.load();
    expect(cache.onError).toHaveBeenCalledWith("Art manifest returned HTTP 503.");
    await cache.load();
    created[0].onerror?.();
    expect(cache.has("sprite-ghost")).toBe(false);
    expect(cache.image("sprite-ghost")).toBeUndefined();
    expect(cache.onError).toHaveBeenCalledWith('Generated artwork "sprite-ghost" could not be loaded.');
  });

  it("rejects remote image URLs in the server manifest", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(manifest([{ ...record("sprite-ghost"), url: "https://example.invalid/image.png" }]));
    const cache = new ArtCache();
    cache.onError = vi.fn();
    await cache.load();
    expect(cache.onError).toHaveBeenCalledWith("The art manifest has an invalid format.");
    expect(created).toHaveLength(0);
  });
});
