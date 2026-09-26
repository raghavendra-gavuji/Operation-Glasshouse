import type { DirectorContext, DirectorReply } from "../../shared/types";
import { readApiError } from "./http";

interface DirectorOptions {
  context: () => DirectorContext;
  enabled: () => boolean;
  onReply: (reply: DirectorReply, latency: number) => void;
  onError: (message: string, retryIn: number) => void;
}

export class DirectorLoop {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private controller: AbortController | undefined;
  private failures = 0;
  private running = false;
  private inFlight = false;
  private lastRequest = 0;

  constructor(private readonly options: DirectorOptions) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(300);
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.timer);
    this.controller?.abort();
  }

  retry(): void {
    this.failures = 0;
    this.nudge();
  }

  nudge(): void {
    if (!this.running || this.inFlight) return;
    this.schedule(Math.max(200, 3000 - (performance.now() - this.lastRequest)));
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer);
    if (this.running) this.timer = setTimeout(() => void this.request(), delay);
  }

  private async request(): Promise<void> {
    if (!this.running) return;
    if (!this.options.enabled()) {
      this.schedule(1000);
      return;
    }
    if (this.inFlight) return;
    this.inFlight = true;
    const context = this.options.context();
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 18_000);
    this.lastRequest = performance.now();
    let delay = 3600 + Math.random() * 1200;
    try {
      const response = await fetch("/api/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(context),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(await readApiError(response));
      }
      const reply: unknown = await response.json();
      if (!isDirectorReply(reply)) throw new Error("Gemini returned an invalid director response.");
      this.failures = 0;
      if (this.running && this.options.enabled()) {
        const current = this.options.context();
        if (current.floor.id === context.floor.id && (current.activeNpcId ?? null) === (context.activeNpcId ?? null)) {
          this.options.onReply(reply, Math.round(performance.now() - this.lastRequest));
        }
      }
    } catch (error) {
      if (this.running) {
        this.failures += 1;
        delay = Math.min(45_000, 3500 * 2 ** Math.min(this.failures, 4)) + Math.random() * 1500;
        const message = error instanceof Error && error.name === "AbortError" ? "The Gemini director timed out." : error instanceof Error ? error.message : "The Gemini director is unavailable.";
        this.options.onError(message, Math.round(delay / 1000));
      }
    } finally {
      clearTimeout(timeout);
      this.controller = undefined;
      this.inFlight = false;
      this.schedule(delay);
    }
  }
}

function isDirectorReply(value: unknown): value is DirectorReply {
  if (!value || typeof value !== "object" || !("source" in value) || value.source !== "gemini" || !("intents" in value) || !Array.isArray(value.intents) || !("chatter" in value) || !Array.isArray(value.chatter)) return false;
  return value.intents.every((intent: unknown) => !!intent && typeof intent === "object" && "npcId" in intent && typeof intent.npcId === "string" && "action" in intent && typeof intent.action === "string" && "reason" in intent && typeof intent.reason === "string")
    && value.chatter.every((item: unknown) => !!item && typeof item === "object" && "from" in item && typeof item.from === "string" && "to" in item && typeof item.to === "string" && "text" in item && typeof item.text === "string");
}
