import type { AssetManifest, AssetRecord } from "../../shared/types";

export class ArtCache {
  private records = new Map<string, AssetRecord>();
  private images = new Map<string, HTMLImageElement>();
  private failed = new Set<string>();
  private prefetched = new Set<number>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private loading: Promise<void> | undefined;
  private refreshAttempts = 0;
  status: AssetManifest["status"] = "empty";
  onChange?: () => void;
  onError?: (message: string) => void;

  load(): Promise<void> {
    if (!this.loading) this.loading = this.readManifest().finally(() => { this.loading = undefined; });
    return this.loading;
  }

  private async readManifest(): Promise<void> {
    try {
      const response = await fetch("/api/assets", { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`Art manifest returned HTTP ${response.status}.`);
      const data: unknown = await response.json();
      if (!isManifest(data)) throw new Error("The art manifest has an invalid format.");
      this.status = data.status;
      for (const record of data.assets) this.records.set(record.id, record);
      for (const record of data.assets) {
        if (record.kind !== "floor" || record.id === "floor-1") this.loadImage(record);
      }
      for (const floor of this.prefetched) {
        const record = this.records.get(`floor-${floor}`);
        if (record) this.loadImage(record);
      }
      this.onChange?.();
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Could not load the generated art.");
    }
  }

  image(id: string): HTMLImageElement | undefined {
    const image = this.images.get(id);
    return image?.complete && image.naturalWidth > 0 ? image : undefined;
  }

  url(id: string): string | undefined {
    return this.records.get(id)?.url;
  }

  has(id: string): boolean {
    return this.records.has(id) && !this.failed.has(id);
  }

  async prefetchFloors(floors: number[]): Promise<void> {
    const fresh = [...new Set(floors)].filter((floor) => floor >= 1 && floor <= 12 && !this.prefetched.has(floor));
    if (fresh.length === 0) return;
    for (const floor of fresh) {
      this.prefetched.add(floor);
      const record = this.records.get(`floor-${floor}`);
      if (record) this.loadImage(record);
    }
    if (fresh.every((floor) => this.records.has(`floor-${floor}`))) return;
    try {
      const response = await fetch("/api/assets/prefetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ floors: fresh }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Floor-art prefetch returned HTTP ${response.status}.`);
      if (fresh.some((floor) => !this.records.has(`floor-${floor}`))) {
        this.refreshAttempts = 0;
        this.scheduleRefresh();
      }
    } catch (error) {
      for (const floor of fresh) this.prefetched.delete(floor);
      this.onError?.(error instanceof Error ? error.message : "Could not prefetch floor art.");
    }
  }

  private loadImage(record: AssetRecord): void {
    if (this.images.get(record.id)?.getAttribute("src") === record.url && !this.failed.has(record.id)) return;
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (this.images.get(record.id) !== image) return;
      this.failed.delete(record.id);
      this.onChange?.();
    };
    image.onerror = () => {
      if (this.images.get(record.id) !== image) return;
      this.failed.add(record.id);
      this.onError?.(`Generated artwork "${record.id}" could not be loaded.`);
    };
    image.src = record.url;
    this.images.set(record.id, image);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      void this.load().then(() => {
        const missing = [...this.prefetched].filter((floor) => !this.records.has(`floor-${floor}`));
        if (!missing.length) return;
        this.refreshAttempts += 1;
        if (this.refreshAttempts < 6) this.scheduleRefresh();
        else {
          for (const floor of missing) this.prefetched.delete(floor);
          this.onError?.(`Floor artwork is still being generated for ${missing.join(", ")}. The physical mission remains playable; revisit the lift to retry.`);
        }
      });
    }, Math.min(20_000, 4000 * 2 ** this.refreshAttempts));
  }
}

function isManifest(value: unknown): value is AssetManifest {
  if (!value || typeof value !== "object" || !("version" in value) || value.version !== 1 || !("assets" in value) || !Array.isArray(value.assets)) return false;
  if (!("status" in value) || !["ready", "partial", "empty"].includes(String(value.status))) return false;
  return value.assets.every((record: unknown) => !!record && typeof record === "object" && "id" in record && typeof record.id === "string" && "url" in record && typeof record.url === "string" && /^\/(?!\/)/.test(record.url) && "kind" in record && ["portrait", "sprite", "floor", "background", "texture"].includes(String(record.kind)) && "model" in record && typeof record.model === "string" && "generatedAt" in record && typeof record.generatedAt === "string");
}
