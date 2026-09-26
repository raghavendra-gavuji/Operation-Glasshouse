import type { Point } from "../../shared/types";

const movementKeys = new Set(["w", "a", "s", "d", "arrowup", "arrowleft", "arrowdown", "arrowright", "shift"]);

export function isTextTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

export function screenToWorldInput(x: number, y: number): Point {
  const worldX = x + y;
  const worldY = y - x;
  const length = Math.hypot(worldX, worldY);
  return length > 0 ? { x: worldX / length, y: worldY / length } : { x: 0, y: 0 };
}

export class MovementInput {
  private readonly keys = new Set<string>();
  private readonly touch = new Map<number, string>();

  constructor(private readonly enabled: () => boolean) {
    window.addEventListener("keydown", (event) => {
      if (isTextTarget(event.target) || !this.enabled() || event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (movementKeys.has(key)) {
        event.preventDefault();
        this.keys.add(key);
      }
    });
    window.addEventListener("keyup", (event) => this.keys.delete(event.key.toLowerCase()));
    window.addEventListener("blur", () => this.clear());
    document.addEventListener("visibilitychange", () => this.clear());
    document.addEventListener("focusin", (event) => {
      if (isTextTarget(event.target)) this.clear();
    });
    document.querySelectorAll<HTMLButtonElement>("[data-move]").forEach((button) => {
      button.addEventListener("pointerdown", (event) => {
        if (!this.enabled()) return;
        event.preventDefault();
        button.setPointerCapture(event.pointerId);
        this.touch.set(event.pointerId, button.dataset.move ?? "");
      });
      for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) {
        button.addEventListener(name, (event) => {
          if (event instanceof PointerEvent) this.touch.delete(event.pointerId);
        });
      }
    });
  }

  read(): Point & { running: boolean } {
    if (!this.enabled()) return { x: 0, y: 0, running: false };
    const touch = new Set(this.touch.values());
    const left = this.keys.has("a") || this.keys.has("arrowleft") || touch.has("left");
    const right = this.keys.has("d") || this.keys.has("arrowright") || touch.has("right");
    const up = this.keys.has("w") || this.keys.has("arrowup") || touch.has("up");
    const down = this.keys.has("s") || this.keys.has("arrowdown") || touch.has("down");
    return { ...screenToWorldInput(Number(right) - Number(left), Number(down) - Number(up)), running: this.keys.has("shift") };
  }

  clear(): void {
    this.keys.clear();
    this.touch.clear();
  }
}
