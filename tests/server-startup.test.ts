import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { projectRoot } from "../server/config";

describe("CLI startup failure cleanup", () => {
  it("exits after EADDRINUSE without retaining Vite watchers or disturbing the existing listener", async () => {
    await mkdir(path.join(projectRoot, ".cache"), { recursive: true });
    const directory = await mkdtemp(path.join(projectRoot, ".cache", "server-startup-"));
    const environmentFile = path.join(directory, "empty.env");
    await writeFile(environmentFile, "");
    const occupied = createServer((_request, response) => response.end("existing test listener"));
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("Test listener did not obtain a TCP port.");
    const base = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, ["--import", "tsx", path.join(projectRoot, "server", "index.ts")], {
      cwd: projectRoot,
      env: {
        ...process.env, GLASSHOUSE_ENV_FILE: environmentFile, GEMINI_API_KEY: "",
        PORT: String(address.port), HOST: "127.0.0.1", NODE_ENV: "development",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", chunk => { output = (output + chunk.toString()).slice(-16_000); });
    child.stderr.on("data", chunk => { output = (output + chunk.toString()).slice(-16_000); });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
      deadline = setTimeout(() => {
        child.kill();
        reject(new Error("The failed CLI retained resources instead of exiting."));
      }, 20_000);
    });
    try {
      const result = await exited;
      expect(result).toEqual({ code: 1, signal: null });
      expect(output).toContain("PORT_IN_USE");
      expect(output).toContain(`Port ${address.port} is already in use`);
      expect(output).toContain("existing server was left running");
      expect(output).toContain("different PORT");
      expect(await (await fetch(base)).text()).toBe("existing test listener");
      expect(occupied.listening).toBe(true);
    } finally {
      clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await new Promise<void>((resolve, reject) => {
        occupied.close(error => error ? reject(error) : resolve());
        occupied.closeAllConnections();
      });
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);
});
