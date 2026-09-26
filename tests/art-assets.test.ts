import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { ASSET_CATALOG, createAssetService } from "../server/art.ts";
import type { AssetManifest } from "../shared/types.ts";

const directory = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "generated");

async function manifest(): Promise<AssetManifest> {
  return createAssetService({ directory }).readAssets();
}

describe("committed Gemini artwork", () => {
  it("ships every required usable asset with real Gemini provenance", async () => {
    const actual = await manifest();
    expect(actual.version).toBe(1);
    expect(actual.status).toBe("ready");
    expect(actual.assets.map(({ id }) => id).sort()).toEqual(ASSET_CATALOG.map(({ id }) => id).sort());
    for (const asset of actual.assets) {
      expect(asset.model).toMatch(/^gemini-[a-zA-Z0-9._-]+image[a-zA-Z0-9._-]*$/);
      expect(Date.parse(asset.generatedAt)).toBeLessThanOrEqual(Date.now() + 1_000);
    }
  });

  it("has unique content-addressed PNGs within the artwork size budget", async () => {
    const actual = await manifest();
    let totalBytes = 0;
    const hashes = new Set<string>();
    for (const asset of actual.assets) {
      const bytes = await readFile(join(directory, basename(asset.url)));
      const hash = createHash("sha256").update(bytes).digest("hex");
      expect(asset.url).toBe(`/generated/${asset.id}-${hash.slice(0, 16)}.png`);
      hashes.add(hash);
      totalBytes += bytes.length;
    }
    expect(hashes.size).toBe(31);
    expect(totalBytes).toBeLessThan(30 * 1024 * 1024);
  });

  it("keeps all seven bodies transparent, complete, aligned and free of magenta spill", async () => {
    const actual = await manifest();
    const sprites = actual.assets.filter(({ kind }) => kind === "sprite");
    expect(sprites).toHaveLength(7);
    for (const asset of sprites) {
      const { data, info } = await sharp(join(directory, basename(asset.url))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect(info, asset.id).toMatchObject({ width: 96, height: 144, channels: 4 });
      let opaque = 0;
      let bottom = -1;
      let left = 96;
      let right = -1;
      let spill = 0;
      let partialAlpha = 0;
      for (let y = 0; y < info.height; y++) {
        for (let x = 0; x < info.width; x++) {
          const i = (y * info.width + x) * 4;
          if (data[i + 3] !== 0 && data[i + 3] !== 255) partialAlpha++;
          if (!data[i + 3]) continue;
          opaque++;
          bottom = y;
          left = Math.min(left, x);
          right = Math.max(right, x);
          if (data[i] > data[i + 1] + 12 && data[i + 2] > data[i + 1] + 10 && Math.min(data[i], data[i + 2]) > Math.max(data[i], data[i + 2]) * 0.38) spill++;
        }
      }
      expect(bottom, asset.id).toBe(139);
      expect(left, asset.id).toBeGreaterThan(0);
      expect(right, asset.id).toBeLessThan(95);
      expect(Math.abs((left + right) / 2 - 47.5), asset.id).toBeLessThanOrEqual(2);
      expect(opaque, asset.id).toBeGreaterThan(1_000);
      expect(opaque, asset.id).toBeLessThan(96 * 144 * 0.7);
      expect(spill, asset.id).toBe(0);
      expect(partialAlpha, asset.id).toBe(0);
    }
  });

  it("ships truly repeating texture edges and crisp doubled scene pixels", async () => {
    const actual = await manifest();
    for (const asset of actual.assets.filter(({ kind }) => kind !== "sprite")) {
      const { data, info } = await sharp(join(directory, basename(asset.url))).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      let mismatches = 0;
      for (let y = 0; y < info.height; y += 2) {
        for (let x = 0; x < info.width; x += 2) {
          const i = (y * info.width + x) * info.channels;
          for (let channel = 0; channel < info.channels; channel++) {
            if (data[i + channel] !== data[i + info.channels + channel]) mismatches++;
            if (data[i + channel] !== data[i + info.width * info.channels + channel]) mismatches++;
          }
        }
      }
      expect(mismatches, asset.id).toBe(0);
      if (asset.kind !== "texture") continue;
      for (let y = 0; y < info.height; y++) {
        const first = y * info.width * info.channels;
        const last = first + (info.width - 1) * info.channels;
        expect(data.subarray(first, first + info.channels), asset.id).toEqual(data.subarray(last, last + info.channels));
      }
      expect(data.subarray(0, info.width * info.channels), asset.id)
        .toEqual(data.subarray((info.height - 1) * info.width * info.channels));
    }
  }, 15_000);
});
