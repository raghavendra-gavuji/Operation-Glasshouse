import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot, type ServerConfig } from "../server/config";
import { createGlasshouseServer, type AssetService } from "../server/index";

const assets: AssetService = {
  readAssets: async () => ({ version: 1, assets: [], status: "empty" }),
  scheduleFloorAssets: async () => {},
  getArtGenerationStatus: () => ({ queued: [], running: [], failed: [] }),
};
const config: ServerConfig = {
  root: projectRoot, host: "127.0.0.1", port: 0, production: false, apiKey: "",
  models: { text: "gemini-3.8-flash", live: "gemini-3.8-live", image: "gemini-3.1-flash-lite-image", tts: "gemini-3.8-flash-tts" },
};

describe("same-origin web delivery", () => {
  it("integrates Vite and serves the real audio module and worklet without credentials", async () => {
    const game = await createGlasshouseServer({ config, assets });
    try {
      const address = await game.listen();
      const base = `http://127.0.0.1:${address.port}`;
      const health = await (await fetch(`${base}/api/health`)).json();
      expect(health.configured).toBe(false);
      const audio = await fetch(`${base}/src/audio.ts`);
      expect(audio.status).toBe(200);
      expect(await audio.text()).toContain("class VoiceClient");
      const worklet = await fetch(`${base}/pcm-processor.js`);
      expect(worklet.status).toBe(200);
      expect(await worklet.text()).toContain('registerProcessor("glasshouse-pcm"');
      const missing = await fetch(`${base}/api/not-a-route`);
      expect(missing.status).toBe(404);
      expect(missing.headers.get("Content-Type")).toContain("application/json");
      const serverSource = await fetch(`${base}/server/config.ts`);
      expect(serverSource.status).not.toBe(200);
    } finally { await game.close(); }
  }, 30_000);

  it("serves production dist and limits SPA fallback to non-API GET requests", async () => {
    await mkdir(path.join(projectRoot, ".cache"), { recursive: true });
    const root = await mkdtemp(path.join(projectRoot, ".cache", "server-web-"));
    await mkdir(path.join(root, "dist"), { recursive: true });
    await writeFile(path.join(root, "dist", "index.html"), "<!doctype html><title>Glasshouse routing fixture</title><main>Routing fixture</main>");
    const game = await createGlasshouseServer({ config: { ...config, root, production: true }, assets });
    try {
      const address = await game.listen();
      const base = `http://127.0.0.1:${address.port}`;
      const page = await fetch(`${base}/mission/room`);
      expect(page.status).toBe(200);
      expect(page.headers.get("Content-Type")).toContain("text/html");
      expect(await page.text()).toContain("Routing fixture");
      const missingApi = await fetch(`${base}/api/no-such-route`);
      expect(missingApi.status).toBe(404);
      expect(missingApi.headers.get("Content-Type")).toContain("application/json");
      expect((await fetch(`${base}/mission/room`, { method: "POST" })).status).toBe(404);
    } finally {
      await game.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
