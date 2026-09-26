import { ServiceError } from "./errors";

export class TokenBucket {
  private tokens: number;
  private updatedAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.updatedAt = now();
  }

  take(amount = 1): boolean {
    const time = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + Math.max(0, time - this.updatedAt) * this.refillPerSecond / 1000);
    this.updatedAt = time;
    if (amount > this.tokens) return false;
    this.tokens -= amount;
    return true;
  }
}

export class RequestGate {
  private running = 0;
  private readonly operations = new Map<string, number>();
  private readonly hourly = new TokenBucket(360, 360 / 3600);
  private readonly buckets = {
    director: new TokenBucket(5, 20 / 60),
    dialogue: new TokenBucket(5, 24 / 60),
    tts: new TokenBucket(4, 12 / 60),
    prefetch: new TokenBucket(4, 6 / 60),
  };

  constructor(private readonly maximum = 4) {}

  acquire(operation: keyof RequestGate["buckets"]): () => void {
    const operationMaximum = operation === "tts" ? 2 : 1;
    if (this.running >= this.maximum || (this.operations.get(operation) ?? 0) >= operationMaximum) {
      throw new ServiceError(429, "SERVER_BUSY", "Another request is still running. Wait for it before trying again.", true);
    }
    if (!this.buckets[operation].take() || !this.hourly.take()) {
      throw new ServiceError(429, "LOCAL_RATE_LIMIT", "The local generation budget was reached. Wait before explicitly trying again.", true);
    }
    this.running++;
    this.operations.set(operation, (this.operations.get(operation) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.running--;
      this.operations.set(operation, (this.operations.get(operation) ?? 1) - 1);
    };
  }
}

export async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const timeout = new ServiceError(504, "REQUEST_TIMEOUT", "The request timed out. You can explicitly retry or use practice mode.", true);
  const onAbort = () => controller.abort(parent?.reason ?? new DOMException("Request cancelled.", "AbortError"));
  parent?.addEventListener("abort", onAbort, { once: true });
  if (parent?.aborted) onAbort();
  const timer = setTimeout(() => controller.abort(timeout), milliseconds);
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    abortListener = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", abortListener, { once: true });
    if (controller.signal.aborted) abortListener();
  });
  try {
    controller.signal.throwIfAborted();
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onAbort);
    if (abortListener) controller.signal.removeEventListener("abort", abortListener);
  }
}
