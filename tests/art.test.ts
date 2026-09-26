import { GenerateContentResponse, FinishReason, BlockedReason } from "@google/genai";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ASSET_CATALOG, ArtError, createAssetService, extractGeneratedImage, prepareAssetImage,
  type AssetSpec, type GeneratedImage, type ImageGenerator,
} from "../server/art.ts";

const directories: string[] = [];
const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
let source: GeneratedImage;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "glasshouse-art-test-"));
  directories.push(path);
  return path;
}

function spec(id: string): AssetSpec {
  const result = ASSET_CATALOG.find((asset) => asset.id === id);
  if (!result) throw new Error(`Unknown test asset ${id}`);
  return result;
}

function response(parts: { text?: string; thought?: boolean; inlineData?: { data: string; mimeType: string } }[]): GenerateContentResponse {
  return Object.assign(new GenerateContentResponse(), { candidates: [{ content: { parts } }], modelVersion: "gemini-test-image-version" });
}

async function spriteSource(): Promise<GeneratedImage> {
  const torso = await sharp({ create: { width: 92, height: 220, channels: 4, background: "#25464d" } }).png().toBuffer();
  const head = await sharp({ create: { width: 70, height: 66, channels: 4, background: "#b88861" } }).png().toBuffer();
  const shoe = await sharp({ create: { width: 45, height: 28, channels: 4, background: "#71533f" } }).png().toBuffer();
  const darkSpill = await sharp({ create: { width: 12, height: 90, channels: 4, background: "#5d035a" } }).png().toBuffer();
  const bytes = await sharp({ create: { width: 320, height: 480, channels: 4, background: "#ff00ff" } })
    .composite([
      { input: torso, left: 114, top: 160 },
      { input: head, left: 125, top: 96 },
      { input: shoe, left: 107, top: 376 },
      { input: shoe, left: 170, top: 376 },
      { input: darkSpill, left: 202, top: 220 },
    ]).png().toBuffer();
  return { bytes, mimeType: "image/png", model: "test-image" };
}

beforeEach(async () => {
  vi.clearAllMocks();
  source = {
    bytes: await sharp({ create: { width: 256, height: 256, channels: 3, background: "#416456" } }).png().toBuffer(),
    mimeType: "image/png",
    model: "test-image",
  };
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("asset catalog and image decoding", () => {
  it("contains exactly the required 31 unique, role-correct assets", () => {
    expect(ASSET_CATALOG).toHaveLength(31);
    expect(new Set(ASSET_CATALOG.map(({ id }) => id)).size).toBe(31);
    for (let floor = 1; floor <= 12; floor++) expect(spec(`floor-${floor}`).kind).toBe("floor");
    for (const name of ["ghost", "priya", "ramesh", "dev", "anita", "kulkarni", "meera"]) {
      expect(spec(`portrait-${name}`).kind).toBe("portrait");
      expect(spec(`sprite-${name}`).kind).toBe("sprite");
    }
    expect(spec("portrait-handler").kind).toBe("portrait");
    expect(spec("portrait-ramesh").prompt).toContain("credential-desk security guard");
    expect(spec("portrait-anita").prompt).toContain("CFO's executive assistant");
    expect(spec("portrait-kulkarni").prompt).toContain("facilities manager");
  });

  it("finds actual image data after text and ignores thought images", () => {
    const result = extractGeneratedImage(response([
      { text: "Here is the image." },
      { thought: true, inlineData: { mimeType: "image/png", data: Buffer.from("not final art").toString("base64") } },
      { inlineData: { mimeType: "image/png", data: source.bytes.toString("base64") } },
    ]), "requested-model");
    expect(result.bytes).toEqual(source.bytes);
    expect(result.model).toBe("gemini-test-image-version");
  });

  it("rejects text-only, blocked, malformed, and unsupported outputs explicitly", () => {
    expect(() => extractGeneratedImage(response([{ text: "No image available." }]), "test")).toThrow(/no image/i);
    const blocked = Object.assign(new GenerateContentResponse(), { promptFeedback: { blockReason: BlockedReason.SAFETY } });
    expect(() => extractGeneratedImage(blocked, "test")).toThrow(/declined/i);
    const candidateBlocked = Object.assign(new GenerateContentResponse(), { candidates: [{ finishReason: FinishReason.SAFETY }] });
    expect(() => extractGeneratedImage(candidateBlocked, "test")).toThrow(/declined/i);
    expect(() => extractGeneratedImage(response([{ inlineData: { mimeType: "image/png", data: "not!base64" } }]), "test")).toThrow(/invalid/i);
    expect(() => extractGeneratedImage(response([{ inlineData: { mimeType: "image/svg+xml", data: "PHN2Zz4=" } }]), "test")).toThrow(/unsupported/i);
  });

  it("converts real MIME formats to PNG rather than renaming JPEG bytes", async () => {
    const jpeg = { ...source, bytes: await sharp(source.bytes).jpeg().toBuffer(), mimeType: "image/jpeg" as const };
    const output = await prepareAssetImage(spec("portrait-ghost"), jpeg);
    expect(await sharp(output).metadata()).toMatchObject({ format: "png", width: 256, height: 256 });
    await expect(prepareAssetImage(spec("portrait-ghost"), { ...jpeg, mimeType: "image/png" })).rejects.toThrow(/declared format/);
    await expect(prepareAssetImage(spec("portrait-ghost"), { ...source, bytes: Buffer.from("not an image") })).rejects.toThrow(/decoded/);
  });
});

describe("game-ready pixel processing", () => {
  it("removes magenta without losing shoes and aligns the foot anchor", async () => {
    const pixels = await prepareAssetImage(spec("sprite-ghost"), await spriteSource());
    const { data, info } = await sharp(pixels).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 96, height: 144, channels: 4 });
    let bottom = -1;
    let left = info.width;
    let right = -1;
    let opaque = 0;
    let magenta = 0;
    for (let y = 0; y < info.height; y++) {
      for (let x = 0; x < info.width; x++) {
        const i = (y * info.width + x) * 4;
        if (!data[i + 3]) continue;
        opaque++;
        bottom = y;
        left = Math.min(left, x);
        right = Math.max(right, x);
        if (data[i] > data[i + 1] + 12 && data[i + 2] > data[i + 1] + 10) magenta++;
      }
    }
    expect(bottom).toBe(139);
    expect(Math.abs((left + right) / 2 - 47.5)).toBeLessThanOrEqual(1);
    expect(opaque).toBeGreaterThan(1_000);
    expect(opaque).toBeLessThan(96 * 144 * 0.7);
    expect(magenta).toBe(0);
    for (let i = (140 * 96 * 4) + 3; i < data.length; i += 4) expect(data[i]).toBe(0);
  });

  it("does not quietly publish unkeyable or clipped sprite art", async () => {
    await expect(prepareAssetImage(spec("sprite-ghost"), source)).rejects.toThrow(/isolated body/);
    const clipped = await sharp({ create: { width: 160, height: 240, channels: 3, background: "#ff00ff" } })
      .composite([{ input: await sharp({ create: { width: 40, height: 210, channels: 3, background: "#123456" } }).png().toBuffer(), left: 60, top: 30 }]).png().toBuffer();
    await expect(prepareAssetImage(spec("sprite-ghost"), { ...source, bytes: clipped })).rejects.toThrow(/image edge/);
  });

  it("makes both pairs of texture edges identical after pixel quantization", async () => {
    const raw = Buffer.alloc(64 * 64 * 3);
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 3;
        raw[i] = 40 + x * 2;
        raw[i + 1] = 50 + y;
        raw[i + 2] = 70;
      }
    }
    const bytes = await sharp(raw, { raw: { width: 64, height: 64, channels: 3 } }).png().toBuffer();
    const output = await prepareAssetImage(spec("texture-floor"), { ...source, bytes });
    const { data, info } = await sharp(output).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    for (let y = 0; y < info.height; y++) {
      const first = y * info.width * info.channels;
      const last = first + (info.width - 1) * info.channels;
      expect(data.subarray(first, first + info.channels)).toEqual(data.subarray(last, last + info.channels));
    }
    expect(data.subarray(0, info.width * info.channels)).toEqual(data.subarray((info.height - 1) * info.width * info.channels));
  });
});

describe("resumable manifest and constrained publication", () => {
  it("returns typed empty state only for an absent manifest", async () => {
    const path = await directory();
    const service = createAssetService({ directory: path, generate: async () => source, logger: silent });
    expect(await service.readAssets()).toEqual({ version: 1, assets: [], status: "empty" });
    await writeFile(join(path, "manifest.json"), "{corrupt");
    await expect(service.readAssets()).rejects.toThrow(/invalid JSON/);
  });

  it("resumes without generating again and keeps genuine model/timestamp provenance", async () => {
    const path = await directory();
    const generate = vi.fn(async () => source);
    const service = createAssetService({ directory: path, generate, logger: silent });
    const first = await service.generateAssets(["portrait-ghost"]);
    expect(first.status).toBe("partial");
    expect(first.assets[0]).toMatchObject({ id: "portrait-ghost", kind: "portrait", model: "test-image" });
    expect(first.assets[0].url).toMatch(/^\/generated\/portrait-ghost-[a-f0-9]{16}\.png$/);
    expect(Number.isFinite(Date.parse(first.assets[0].generatedAt))).toBe(true);
    expect(await service.generateAssets(["portrait-ghost"])).toEqual(first);
    expect(generate).toHaveBeenCalledTimes(1);
    expect((await readdir(path)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("rejects unsafe URLs and unknown IDs without any network generation", async () => {
    const path = await directory();
    const generate = vi.fn(async () => source);
    const service = createAssetService({ directory: path, generate, logger: silent });
    await expect(service.generateAssets(["../../secret"])).rejects.toThrow(/known asset IDs/);
    const manifest = {
      version: 1, status: "ready",
      assets: [{ id: "portrait-ghost", kind: "portrait", url: "/generated/../../secret.png", model: "test", generatedAt: new Date().toISOString() }],
    };
    await writeFile(join(path, "manifest.json"), JSON.stringify(manifest));
    await expect(service.readAssets()).rejects.toThrow(/unsafe paths/);
    expect(generate).not.toHaveBeenCalled();
  });

  it("detects missing/corrupt images instead of claiming manifest readiness", async () => {
    const path = await directory();
    const generate = vi.fn(async () => source);
    const service = createAssetService({ directory: path, generate, logger: silent });
    const manifest = await service.generateAssets(["portrait-ghost"]);
    await writeFile(join(path, basename(manifest.assets[0].url)), "invalid PNG");
    expect((await service.readAssets()).status).toBe("empty");
    expect(silent.warn).toHaveBeenCalledWith(expect.stringContaining("missing or invalid"));
    expect((await service.generateAssets(["portrait-ghost"])).assets).toHaveLength(1);
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("uses immutable URLs for exact force regeneration and leaves the old image readable", async () => {
    const path = await directory();
    const alternate = { ...source, model: "test-model-second", bytes: await sharp(source.bytes).tint("#ff9900").png().toBuffer() };
    const generate = vi.fn<ImageGenerator>().mockResolvedValueOnce(source).mockResolvedValueOnce(alternate);
    const service = createAssetService({ directory: path, generate, logger: silent });
    const first = await service.generateAssets(["portrait-ghost"]);
    const firstBytes = await readFile(join(path, basename(first.assets[0].url)));
    const second = await service.generateAssets(["portrait-ghost"], true);
    expect(second.assets[0].url).not.toBe(first.assets[0].url);
    expect(second.assets[0].model).toBe("test-model-second");
    expect(await readFile(join(path, basename(first.assets[0].url)))).toEqual(firstBytes);
    expect(JSON.parse(await readFile(join(path, "manifest.json"), "utf8"))).toEqual(second);
  });

  it("uses already generated reference images and respects dependency ordering", async () => {
    const path = await directory();
    const calls: { id: string; reference: boolean }[] = [];
    const service = createAssetService({
      directory: path, logger: silent,
      generate: async (asset, reference) => {
        calls.push({ id: asset.id, reference: Boolean(reference) });
        return source;
      },
    });
    await service.generateAssets(["portrait-priya", "portrait-ghost", "meridian-exterior"]);
    expect(calls).toEqual([
      { id: "meridian-exterior", reference: false },
      { id: "portrait-ghost", reference: true },
      { id: "portrait-priya", reference: true },
    ]);
  });

  it("recovers a dead process's asset lock rather than blocking resumable generation", async () => {
    const path = await directory();
    const lock = join(path, ".locks", "floor-1");
    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
    const service = createAssetService({ directory: path, generate: async () => source, logger: silent });
    const result = await service.generateAssets(["floor-1"]);
    expect(result.assets.map(({ id }) => id)).toEqual(["floor-1"]);
    expect(await readdir(join(path, ".locks"))).toEqual([]);
  });
});

describe("bounded nonblocking floor queue", () => {
  it("returns before image generation and runs at most two jobs, deduplicating overlapping requests", async () => {
    const path = await directory();
    let active = 0;
    let maximum = 0;
    const calls: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const service = createAssetService({
      directory: path, logger: silent,
      generate: async (asset) => {
        calls.push(asset.id);
        maximum = Math.max(maximum, ++active);
        await held;
        active--;
        return source;
      },
    });
    const scheduled = service.scheduleFloorAssets([1, 2, 3, 3]);
    await expect(Promise.race([scheduled.then(() => "queued"), delay(500).then(() => "blocked")])).resolves.toBe("queued");
    await service.scheduleFloorAssets([2, 3, 4]);
    expect(service.getArtGenerationStatus().running.length).toBeLessThanOrEqual(2);
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    release();
    await service.waitForIdle();
    expect(maximum).toBe(2);
    expect(calls.sort()).toEqual(["floor-1", "floor-2", "floor-3", "floor-4"]);
    expect((await service.readAssets()).assets).toHaveLength(4);
    expect(service.getArtGenerationStatus()).toEqual({ queued: [], running: [], failed: [] });
  });

  it("validates every floor before enqueue and refuses browser-supplied prompts", async () => {
    const generate = vi.fn(async () => source);
    const service = createAssetService({ directory: await directory(), generate, logger: silent });
    for (const floors of [[1, 13], [0], [1.2], [Number.NaN], Array.from({ length: 13 }, () => 1)]) {
      await expect(service.scheduleFloorAssets(floors)).rejects.toThrow(/at most twelve integer floors/);
    }
    expect(generate).not.toHaveBeenCalled();
    expect(service.getArtGenerationStatus()).toEqual({ queued: [], running: [], failed: [] });
  });

  it("deduplicates across independent services and merges simultaneous manifest updates without loss", async () => {
    const path = await directory();
    let active = 0;
    let maximum = 0;
    const generate = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await delay(60);
      active--;
      return source;
    });
    const first = createAssetService({ directory: path, generate, logger: silent });
    const second = createAssetService({ directory: path, generate, logger: silent });
    await Promise.all([first.scheduleFloorAssets([1, 2]), second.scheduleFloorAssets([1, 3])]);
    await Promise.all([first.waitForIdle(), second.waitForIdle()]);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(maximum).toBeLessThanOrEqual(2);
    expect((await first.readAssets()).assets.map(({ id }) => id)).toEqual(["floor-1", "floor-2", "floor-3"]);
    expect(await readdir(join(path, ".locks"))).toEqual([]);
  });

  it("bounds retries and exposes failures without leaking raw provider messages", async () => {
    const generate = vi.fn(async () => { throw { status: 429, message: "sensitive-provider-context-must-not-be-logged" }; });
    const service = createAssetService({ directory: await directory(), generate, logger: silent, retryDelayMs: 1 });
    await service.scheduleFloorAssets([1]);
    await service.waitForIdle();
    expect(generate).toHaveBeenCalledTimes(2);
    expect(service.getArtGenerationStatus().failed[0]).toMatchObject({ id: "floor-1", message: "Gemini image request failed (HTTP 429)." });
    expect(JSON.stringify(silent.error.mock.calls)).not.toContain("sensitive-provider");
    await expect(service.scheduleFloorAssets([1])).rejects.toThrow(/cooldown/);
    expect(generate).toHaveBeenCalledTimes(2);
    expect((await service.readAssets()).status).toBe("empty");
  });

  it("does not retry refusals and resumes a failed batch without losing successes", async () => {
    const generate = vi.fn(async (asset: AssetSpec) => {
      if (asset.id === "floor-2") throw new ArtError("REFUSED", "Gemini declined the image request.");
      return source;
    });
    const service = createAssetService({ directory: await directory(), generate, logger: silent, retryDelayMs: 1 });
    await expect(service.generateAssets(["floor-1", "floor-2"])).rejects.toThrow(/Completed images are saved/);
    expect(generate).toHaveBeenCalledTimes(2);
    expect((await service.readAssets()).assets.map(({ id }) => id)).toEqual(["floor-1"]);
    generate.mockImplementation(async () => source);
    await service.generateAssets(["floor-1", "floor-2"]);
    expect(generate).toHaveBeenCalledTimes(3);
    expect(service.getArtGenerationStatus().failed).toEqual([]);
  });

  it("aborts timed-out requests once instead of starting another billable attempt", async () => {
    let aborted = false;
    const generate = vi.fn<ImageGenerator>(async (_asset, _reference, signal) => {
      return new Promise<GeneratedImage>((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted = true; reject(new Error("cancelled")); }, { once: true });
      });
    });
    const service = createAssetService({ directory: await directory(), generate, logger: silent, timeoutMs: 30 });
    await service.scheduleFloorAssets([1]);
    await service.waitForIdle();
    expect(aborted).toBe(true);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(service.getArtGenerationStatus().failed[0].message).toContain("timed out");
  });

  it("serves cache without credentials but explicitly rejects generation when the key is missing", async () => {
    const path = await directory();
    const seeded = createAssetService({ directory: path, generate: async () => source, logger: silent });
    await seeded.generateAssets(["floor-1"]);
    vi.stubEnv("GEMINI_API_KEY", "");
    vi.stubEnv("GOOGLE_API_KEY", "");
    const offline = createAssetService({ directory: path, logger: silent });
    await expect(offline.scheduleFloorAssets([1])).resolves.toBeUndefined();
    await expect(offline.scheduleFloorAssets([2])).rejects.toThrow(/Missing GEMINI_API_KEY/);
    expect((await offline.readAssets()).assets).toHaveLength(1);
  });
});
