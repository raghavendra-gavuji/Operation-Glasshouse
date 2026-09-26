import type { FloorPlan, GameState, NpcDefinition, NpcState, Point, TileKind } from "../shared/types";
import { ArtCache } from "./ui/assets";

const TILE_W = 34;
const TILE_H = 17;
const HALF_W = TILE_W / 2;
const HALF_H = TILE_H / 2;
const ink = "#19382f";
const light = "#f0d5a0";

interface Terrain {
  canvas: HTMLCanvasElement;
  origin: Point;
}

interface RenderObject {
  depth: number;
  draw: () => void;
}

interface Speech {
  text: string;
  expires: number;
}

export function projectTile(x: number, y: number): Point {
  return { x: (x - y) * HALF_W, y: (x + y) * HALF_H };
}

export class OfficeRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private camera: Point = { x: 0, y: 0 };
  private terrain = new Map<number, Terrain>();
  private currentFloor = 0;
  private readonly positions = new Map<string, Point>();
  private readonly speeches = new Map<string, Speech>();
  private ghostOutline: HTMLCanvasElement | undefined;
  private cameraReady = false;
  private pathMap: Record<string, Point[]> = {};
  debug = false;
  onResize?: () => void;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly art: ArtCache) {
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("Your browser could not create the game canvas.");
    this.ctx = context;
    this.resize();
    window.addEventListener("resize", () => {
      this.resize();
      this.onResize?.();
    });
  }

  invalidateArt(): void {
    this.terrain.clear();
    this.ghostOutline = undefined;
  }

  setSpeech(npcId: string, text: string, duration = 8000): void {
    this.speeches.set(npcId, { text, expires: performance.now() + duration });
  }

  setPaths(paths: Record<string, Point[]>): void {
    this.pathMap = paths;
  }

  center(): void {
    this.cameraReady = false;
  }

  draw(state: GameState, floor: FloorPlan, definitions: NpcDefinition[], dt: number): void {
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#142d27";
    ctx.fillRect(0, 0, this.width, this.height);
    if (state.phase === "briefing") {
      this.drawTower();
      return;
    }
    const mobile = window.innerWidth <= 760;
    const point = projectTile(state.player.x, state.player.y);
    const panelSpace = mobile ? 0 : window.innerWidth >= 1600 ? 155 : 138;
    const target = {
      x: (this.width - panelSpace) / 2 - point.x,
      y: this.height * (state.activeNpcId ? .43 : .53) - point.y,
    };
    if (!this.cameraReady || this.currentFloor !== floor.id || state.settings.reducedMotion) {
      this.camera = target;
      this.cameraReady = true;
      this.currentFloor = floor.id;
    } else {
      const easing = 1 - Math.exp(-dt * 7.5);
      this.camera.x += (target.x - this.camera.x) * easing;
      this.camera.y += (target.y - this.camera.y) * easing;
    }
    this.drawSurroundings(floor);
    ctx.save();
    ctx.translate(Math.round(this.camera.x), Math.round(this.camera.y));
    let terrain = this.terrain.get(floor.id);
    if (!terrain) {
      terrain = this.createTerrain(floor);
      this.terrain.set(floor.id, terrain);
    }
    ctx.drawImage(terrain.canvas, -terrain.origin.x, -terrain.origin.y);
    if (this.debug) this.drawNavigation(floor);
    const objects: RenderObject[] = [];
    for (let y = 0; y < floor.height; y += 1) {
      for (let x = 0; x < floor.width; x += 1) {
        const kind = floor.tiles[y * floor.width + x];
        if (kind === "wall" || kind === "desk" || kind === "plant" || kind === "door") {
          objects.push({ depth: x + y + .18, draw: () => this.drawFixture(floor, state, x, y, kind) });
        }
      }
    }
    const activeNpcs = state.npcs.filter((npc) => npc.floor === floor.id);
    for (const npc of activeNpcs) {
      const definition = definitions.find((item) => item.id === npc.id);
      objects.push({ depth: npc.x + npc.y + .08, draw: () => this.drawPerson(npc, definition, state) });
    }
    objects.push({
      depth: state.player.x + state.player.y + .1,
      draw: () => this.drawPerson({ ...state.player, id: "ghost", floor: state.floor, suspicion: 0, intent: "idle", intentReason: "", memory: "", bubble: null, bubbleUntil: 0, lastEncounterAt: 0, reported: false }, undefined, state),
    });
    objects.sort((a, b) => a.depth - b.depth);
    for (const object of objects) object.draw();
    this.drawLiftSign(floor);
    for (const npc of activeNpcs) this.drawPersonLabel(npc, definitions.find((item) => item.id === npc.id), state);
    if (!state.activeNpcId) {
      const ghost = projectTile(state.player.x, state.player.y);
      ctx.fillStyle = light;
      ctx.font = "bold 5px 'Segoe UI', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("GHOST", Math.round(ghost.x), Math.round(ghost.y + 12));
    }
    ctx.restore();
    this.drawVignette();
  }

  private resize(): void {
    this.width = Math.ceil(window.innerWidth / 2);
    this.height = Math.ceil(window.innerHeight / 2);
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.cameraReady = false;
    this.ctx.imageSmoothingEnabled = false;
  }

  private createTerrain(floor: FloorPlan): Terrain {
    const canvas = document.createElement("canvas");
    const margin = 80;
    const origin = { x: floor.height * HALF_W + margin, y: margin };
    canvas.width = (floor.width + floor.height) * HALF_W + margin * 2;
    canvas.height = (floor.width + floor.height) * HALF_H + margin * 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Unable to render office floor.");
    ctx.imageSmoothingEnabled = false;
    ctx.translate(origin.x, origin.y);
    const corners = [
      projectTile(0, 0),
      projectTile(floor.width, 0),
      projectTile(floor.width, floor.height),
      projectTile(0, floor.height),
    ];
    this.polygon(ctx, [corners[1], corners[2], { x: corners[2].x, y: corners[2].y + 16 }, { x: corners[1].x, y: corners[1].y + 16 }], "#534f3e");
    this.polygon(ctx, [corners[2], corners[3], { x: corners[3].x, y: corners[3].y + 16 }, { x: corners[2].x, y: corners[2].y + 16 }], "#3c4739");
    this.polygon(ctx, corners.map((corner) => ({ x: corner.x + 12, y: corner.y + 25 })), "#081e1a55");
    for (let sum = 0; sum < floor.width + floor.height; sum += 1) {
      for (let x = 0; x < floor.width; x += 1) {
        const y = sum - x;
        if (y < 0 || y >= floor.height) continue;
        const point = projectTile(x + .5, y + .5);
        const kind = floor.tiles[y * floor.width + x];
        const room = floor.rooms.find((entry) => x >= entry.x && x < entry.x + entry.width && y >= entry.y && y < entry.y + entry.height);
        const variant = (x * 13 + y * 7 + floor.id) % 4;
        let color = ["#c2b58c", "#c7bb92", "#cabb94", "#c6b990"][variant];
        if (kind === "carpet") color = ["#7a7960", "#808064", "#77755c", "#7e7b61"][variant];
        if (room?.restricted && kind !== "wall") color = ["#9c7b6c", "#a38370", "#a58973", "#9e8070"][variant];
        if (kind === "elevator") color = "#bc9a5c";
        if (kind === "exit") color = "#527564";
        this.diamond(ctx, point.x, point.y, TILE_W, TILE_H, color);
        ctx.strokeStyle = "#485d4120";
        ctx.lineWidth = .4;
        ctx.stroke();
        const texture = this.art.image(kind === "carpet" ? "texture-carpet" : "texture-floor");
        if (texture && kind !== "wall") {
          ctx.save();
          this.diamond(ctx, point.x, point.y, TILE_W, TILE_H);
          ctx.clip();
          ctx.globalAlpha = kind === "carpet" ? .17 : .1;
          ctx.drawImage(texture, Math.round(point.x - HALF_W), Math.round(point.y - HALF_H), TILE_W, TILE_H);
          ctx.restore();
        }
        if ((x + y) % 7 === 0 && kind === "carpet") {
          ctx.fillStyle = "#465b401c";
          ctx.fillRect(Math.round(point.x - 5), Math.round(point.y), 2, 1);
          ctx.fillRect(Math.round(point.x + 6), Math.round(point.y + 2), 3, 1);
        }
        if (kind === "elevator") {
          this.diamond(ctx, point.x, point.y, TILE_W - 3, TILE_H - 2, "#566b56");
          this.diamond(ctx, point.x, point.y, TILE_W - 10, TILE_H - 5, "#ad9c67");
        }
        if (kind === "exit") {
          ctx.save();
          ctx.translate(point.x, point.y + 1);
          ctx.transform(1, .5, -1, .5, 0, 0);
          ctx.fillStyle = "#e1ddb3";
          ctx.font = "bold 7px 'Segoe UI', sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("EXIT", 0, 0);
          ctx.restore();
        }
        if (kind === "desk") {
          this.diamond(ctx, point.x + 3, point.y + 4, TILE_W + 7, TILE_H + 3, "#253c2940");
        }
      }
    }
    ctx.save();
    this.polygon(ctx, corners);
    ctx.clip();
    for (let band = 0; band < 5; band += 1) {
      this.polygon(ctx, [
        projectTile(1 + band * 4, -.5), projectTile(2.1 + band * 4, -.5),
        projectTile(6.1 + band * 4, floor.height), projectTile(5 + band * 4, floor.height),
      ], "#ffe29b15");
    }
    ctx.restore();
    for (const room of floor.rooms) {
      const point = projectTile(room.x + Math.min(room.width / 2, 3), room.y + room.height - 1.2);
      ctx.save();
      ctx.translate(point.x, point.y);
      ctx.transform(1, .5, -.7, .5, 0, 0);
      ctx.fillStyle = room.restricted ? "#744945" : "#59664b";
      ctx.textAlign = "center";
      ctx.font = "bold 7px 'Segoe UI', sans-serif";
      ctx.fillText(room.name.toUpperCase(), 0, 0, Math.max(48, room.width * 13));
      if (room.restricted) {
        ctx.font = "4px 'Segoe UI', sans-serif";
        ctx.fillText("AUTHORIZED STAFF", 0, 8);
      }
      ctx.restore();
    }
    return { canvas, origin };
  }

  private drawFixture(floor: FloorPlan, state: GameState, x: number, y: number, kind: TileKind): void {
    const ctx = this.ctx;
    const point = projectTile(x + .5, y + .5);
    if (kind === "wall") {
      const inFront = x + y >= state.player.x + state.player.y - .4;
      const close = Math.abs(x - state.player.x) < 2 && Math.abs(y - state.player.y) < 2;
      ctx.save();
      if (inFront && close) ctx.globalAlpha = .22;
      const edge = x === 0 || y === 0;
      const height = edge ? 34 : 24;
      this.block(point.x, point.y, .99, .99, height, edge ? "#a9b493" : "#7e9b7a", edge ? "#667e65" : "#526f5a", edge ? "#3d6253" : "#355c4c");
      this.diamond(ctx, point.x, point.y - height, TILE_W * .94, TILE_H * .94, "#b9bea0");
      if (edge && (x + y) % 3 !== 0) this.windowPane(point.x, point.y, x === 0);
      if (!edge && (x + y) % 4 === 0) {
        ctx.fillStyle = "#e3d5af";
        ctx.fillRect(Math.round(point.x - 3), Math.round(point.y - 16), 6, 7);
        ctx.fillStyle = "#63765e";
        ctx.fillRect(Math.round(point.x - 2), Math.round(point.y - 14), 4, 1);
        ctx.fillRect(Math.round(point.x - 2), Math.round(point.y - 12), 3, 1);
      }
      ctx.restore();
      return;
    }
    if (kind === "desk") {
      const computer = (x + y) % 3 !== 1;
      this.block(point.x, point.y, .91, .83, 9, "#cbb27c", "#987b50", "#776444");
      this.block(point.x + 1, point.y + 1, .82, .76, 11, "#d8c497", "#b09a6e", "#95815a");
      if (computer) {
        const mirror = (x + y) % 2 === 0;
        ctx.save();
        ctx.translate(Math.round(point.x + (mirror ? -2 : 3)), Math.round(point.y - 16));
        ctx.fillStyle = "#3e5546";
        ctx.fillRect(-5, -5, 10, 8);
        ctx.fillStyle = "#8bbaa4";
        ctx.fillRect(-4, -4, 8, 5);
        ctx.fillStyle = "#c4dcb6";
        ctx.fillRect(-3, -3, 4, 1);
        ctx.fillStyle = "#435842";
        ctx.fillRect(-1, 3, 2, 4);
        ctx.fillRect(-4, 6, 7, 1);
        ctx.fillStyle = "#b9b696";
        ctx.fillRect(-5, 8, 10, 2);
        ctx.fillStyle = "#4e6958";
        ctx.fillRect(-3, 8, 6, 1);
        ctx.restore();
      }
      ctx.fillStyle = "#f3e2b9";
      ctx.fillRect(Math.round(point.x + 7), Math.round(point.y - 13), 5, 3);
      ctx.fillStyle = (x + floor.id) % 2 ? "#8b494b" : "#496c5c";
      ctx.fillRect(Math.round(point.x - 9), Math.round(point.y - 12), 3, 3);
      this.block(point.x + 3, point.y + 7, .27, .24, 6, "#785154", "#624249", "#4e3d3c");
      return;
    }
    if (kind === "plant") {
      this.diamond(ctx, point.x + 4, point.y + 3, 23, 9, "#1c4c303d");
      this.block(point.x, point.y, .34, .34, 7, "#b8946b", "#947354", "#725e41");
      const leaves = [
        [-3, -25, 6, 14, "#386b48"], [-10, -21, 8, 5, "#476e45"], [3, -22, 8, 6, "#628950"],
        [-11, -15, 9, 5, "#426742"], [2, -15, 10, 6, "#799251"], [-5, -12, 11, 5, "#5d8248"],
        [-6, -24, 4, 4, "#7f9d60"], [2, -27, 3, 5, "#849c5b"],
      ] as const;
      for (const [dx, dy, width, height, color] of leaves) {
        ctx.fillStyle = color;
        ctx.fillRect(Math.round(point.x + dx), Math.round(point.y + dy), width, height);
      }
      return;
    }
    if (kind === "door") {
      this.diamond(ctx, point.x, point.y, TILE_W - 1, TILE_H - 1, "#c1a262");
      ctx.fillStyle = "#e3cca0";
      ctx.fillRect(Math.round(point.x - 1), Math.round(point.y - 2), 2, 3);
    }
  }

  private windowPane(x: number, y: number, left: boolean): void {
    const direction = left ? -1 : 1;
    this.polygon(this.ctx, [
      { x: x + direction * 2, y: y - 26 }, { x: x + direction * 14, y: y - 32 },
      { x: x + direction * 14, y: y - 17 }, { x: x + direction * 2, y: y - 11 },
    ], "#839f8a");
    this.polygon(this.ctx, [
      { x: x + direction * 3, y: y - 25 }, { x: x + direction * 7, y: y - 27 },
      { x: x + direction * 7, y: y - 14 }, { x: x + direction * 3, y: y - 12 },
    ], "#c7cea558");
    this.ctx.strokeStyle = "#526e57";
    this.ctx.lineWidth = 1;
    this.ctx.beginPath();
    this.ctx.moveTo(Math.round(x + direction * 8), Math.round(y - 29));
    this.ctx.lineTo(Math.round(x + direction * 8), Math.round(y - 14));
    this.ctx.stroke();
  }

  private drawPerson(npc: NpcState, definition: NpcDefinition | undefined, state: GameState): void {
    const ctx = this.ctx;
    const point = projectTile(npc.x, npc.y);
    const ghost = npc.id === "ghost";
    const previous = this.positions.get(npc.id);
    const moving = ghost ? state.player.moving : !!previous && Math.hypot(npc.x - previous.x, npc.y - previous.y) > .0001;
    this.positions.set(npc.id, { x: npc.x, y: npc.y });
    const gait = moving && !state.paused && !state.settings.reducedMotion ? Math.sin(state.elapsedSeconds * 14) : 0;
    const bob = Math.abs(gait) > .5 ? -1 : 0;
    this.diamond(ctx, point.x + 2, point.y + 1, ghost ? 24 : 20, 7, "#182e2960");
    if (ghost) {
      this.diamond(ctx, point.x, point.y + 1, 23, 8);
      ctx.strokeStyle = "#ebc478a3";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    const sprite = this.art.image(`sprite-${npc.id}`) ?? (!ghost ? this.art.image(`sprite-${["dev", "ramesh", "priya", "anita", "kulkarni"][hash(npc.id) % 5]}`) : undefined);
    if (sprite) {
      const height = ghost ? 45 : 42;
      const width = height * sprite.naturalWidth / sprite.naturalHeight;
      const dx = -width / 2;
      const dy = -height * (140 / 144) + bob;
      ctx.save();
      ctx.translate(Math.round(point.x), Math.round(point.y));
      if (npc.facing === "west" || npc.facing === "north") ctx.scale(-1, 1);
      if (ghost) {
        if (!this.ghostOutline) this.ghostOutline = this.createOutline(sprite);
        if (this.ghostOutline) {
          for (const [x, y] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) ctx.drawImage(this.ghostOutline, dx + x, dy + y, width, height);
        }
      }
      ctx.drawImage(sprite, dx, dy, width, height);
      ctx.restore();
    } else {
      this.drawPixelPerson(point.x, point.y + bob, definition?.color ?? (ghost ? "#69454a" : "#5e8162"), ghost, npc.facing === "west", gait);
    }
    if (ghost && state.player.carryingCard) {
      ctx.fillStyle = "#f9de9c";
      ctx.fillRect(Math.round(point.x + 9), Math.round(point.y - 22 + bob), 4, 6);
      ctx.fillStyle = "#4c7865";
      ctx.fillRect(Math.round(point.x + 10), Math.round(point.y - 21 + bob), 2, 2);
    }
  }

  private drawPixelPerson(x: number, y: number, jacket: string, ghost: boolean, mirrored: boolean, gait: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(Math.round(x), Math.round(y));
    if (mirrored) ctx.scale(-1, 1);
    const stride = Math.round(gait * 2);
    if (ghost) {
      ctx.fillStyle = "#e5be77";
      ctx.fillRect(-6, -34, 11, 10);
      ctx.fillRect(-8, -25, 16, 18);
    }
    ctx.fillStyle = "#233e34";
    ctx.fillRect(-5, -11, 4, 9 + stride);
    ctx.fillRect(1, -11, 4, 9 - stride);
    ctx.fillStyle = "#172e28";
    ctx.fillRect(-7, -3 + stride, 6, 3);
    ctx.fillRect(1, -3 - stride, 6, 3);
    ctx.fillStyle = jacket;
    ctx.fillRect(-6, -25, 12, 17);
    ctx.fillRect(-8, -24, 4, 13 + stride);
    ctx.fillRect(5, -24, 3, 12 - stride);
    ctx.fillStyle = "#a2764f";
    ctx.fillRect(-8, -12 + stride, 3, 3);
    ctx.fillRect(5, -13 - stride, 3, 3);
    ctx.fillStyle = "#d4b78b";
    ctx.fillRect(-4, -33, 8, 9);
    ctx.fillRect(3, -29, 2, 3);
    ctx.fillStyle = "#3b4032";
    ctx.fillRect(-5, -34, 10, 4);
    ctx.fillRect(-5, -30, 2, 4);
    if (ghost) {
      ctx.fillStyle = "#e0caa3";
      ctx.fillRect(-1, -25, 3, 9);
      ctx.fillStyle = "#30463b";
      ctx.fillRect(0, -24, 1, 7);
      ctx.fillStyle = "#b09a6c";
      ctx.fillRect(4, -23, 1, 14);
      ctx.fillStyle = "#dcc591";
      ctx.fillRect(-5, -18, 4, 3);
    } else {
      ctx.fillStyle = "#c5d4b1";
      ctx.fillRect(2, -22, 3, 3);
    }
    ctx.restore();
  }

  private drawPersonLabel(npc: NpcState, definition: NpcDefinition | undefined, state: GameState): void {
    const ctx = this.ctx;
    const point = projectTile(npc.x, npc.y);
    const addressed = state.activeNpcId === npc.id;
    const distance = Math.hypot(npc.x - state.player.x, npc.y - state.player.y);
    const speech = this.speeches.get(npc.id);
    if (speech && speech.expires <= performance.now()) this.speeches.delete(npc.id);
    const bubble = speech && speech.expires > performance.now() ? speech.text : npc.bubble && npc.bubbleUntil > state.elapsedSeconds ? npc.bubble : null;
    if (bubble && distance < 10) {
      const lines = wrapText(bubble, 31).slice(0, 3);
      const width = Math.min(111, Math.max(...lines.map((line) => line.length)) * 3.15 + 14);
      const height = lines.length * 8 + 11;
      const left = Math.round(point.x - width / 2);
      const top = Math.round(point.y - 55 - height);
      ctx.fillStyle = "#122d234f";
      ctx.fillRect(left + 2, top + 2, width, height);
      ctx.fillStyle = addressed ? "#f2dfb7" : "#e1dab9";
      ctx.fillRect(left, top, width, height);
      this.polygon(ctx, [{ x: point.x - 3, y: top + height }, { x: point.x + 3, y: top + height }, { x: point.x, y: top + height + 4 }], "#e1dab9");
      ctx.fillStyle = ink;
      ctx.font = "6px 'Segoe UI', sans-serif";
      ctx.textAlign = "left";
      lines.forEach((line, index) => ctx.fillText(line, left + 7, top + 10 + index * 8));
    }
    if (addressed || distance < 5 || npc.suspicion >= 45) {
      const text = npc.id === "kulkarni" ? "Kulkarni" : definition?.name.split(" ")[0] ?? "Staff";
      ctx.font = `${addressed ? "bold " : ""}6px 'Segoe UI', sans-serif`;
      ctx.textAlign = "center";
      const width = ctx.measureText(text).width + 9;
      ctx.fillStyle = addressed ? "#edce8d" : "#183c30dc";
      ctx.fillRect(Math.round(point.x - width / 2), Math.round(point.y - 51), width, 10);
      ctx.fillStyle = addressed ? "#234934" : "#dfe3bd";
      ctx.fillText(text, Math.round(point.x), Math.round(point.y - 44));
      if (addressed || npc.suspicion > 25) {
        ctx.fillStyle = "#244936";
        ctx.fillRect(Math.round(point.x - 12), Math.round(point.y - 56), 24, 2);
        ctx.fillStyle = npc.suspicion > 70 ? "#c27b71" : npc.suspicion > 40 ? "#dab476" : "#a2bd8b";
        ctx.fillRect(Math.round(point.x - 12), Math.round(point.y - 56), Math.round(24 * npc.suspicion / 100), 2);
      }
    }
  }

  private drawLiftSign(floor: FloorPlan): void {
    const ctx = this.ctx;
    const point = projectTile(floor.elevator.x, floor.elevator.y);
    ctx.fillStyle = "#203f33";
    ctx.fillRect(Math.round(point.x - 21), Math.round(point.y - 36), 42, 12);
    ctx.fillStyle = "#e6c184";
    ctx.font = "bold 6px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("LIFT  ↑↓", Math.round(point.x), Math.round(point.y - 28));
  }

  private drawNavigation(floor: FloorPlan): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = .52;
    for (let y = 0; y < floor.height; y += 1) {
      for (let x = 0; x < floor.width; x += 1) {
        if (["floor", "carpet", "door", "elevator", "exit"].includes(floor.tiles[y * floor.width + x])) {
          const point = projectTile(x + .5, y + .5);
          this.diamond(ctx, point.x, point.y, TILE_W - 1, TILE_H - 1);
          ctx.strokeStyle = "#a9dac1";
          ctx.lineWidth = .5;
          ctx.stroke();
        }
      }
    }
    ctx.globalAlpha = 1;
    Object.entries(this.pathMap).forEach(([id, path]) => {
      if (path.length < 2) return;
      ctx.strokeStyle = ["#f6d59b", "#b2c7ed", "#e0a79c"][hash(id) % 3];
      ctx.lineWidth = 1;
      ctx.beginPath();
      path.forEach((tile, index) => {
        const point = projectTile(tile.x, tile.y);
        if (index === 0) ctx.moveTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.stroke();
    });
    ctx.restore();
  }

  private drawSurroundings(floor: FloorPlan): void {
    const ctx = this.ctx;
    const image = this.art.image(`floor-${floor.id}`);
    if (image) {
      ctx.save();
      ctx.globalAlpha = .12;
      const width = this.width * .68;
      const height = width * image.naturalHeight / image.naturalWidth;
      ctx.drawImage(image, this.width - width, 38, width, height);
      ctx.restore();
    }
    for (let i = 0; i < 8; i += 1) {
      const x = (i * 127 + floor.id * 21) % (this.width + 90) - 45;
      const y = this.height - 26 - ((i * 41) % 86);
      const width = 27 + (i % 3) * 16;
      const height = 40 + (i % 4) * 13;
      ctx.fillStyle = i % 2 ? "#1c392f" : "#1a352d";
      ctx.fillRect(x, y - height, width, height + 80);
      ctx.fillStyle = "#47604430";
      for (let row = 0; row < height; row += 9) ctx.fillRect(x + 3, y - height + row + 4, width - 6, 2);
    }
  }

  private drawVignette(): void {
    const ctx = this.ctx;
    const gradient = ctx.createRadialGradient(this.width * .44, this.height * .48, this.height * .2, this.width * .44, this.height * .48, Math.max(this.width, this.height) * .68);
    gradient.addColorStop(0, "#10291f00");
    gradient.addColorStop(1, "#061d1742");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, this.width, this.height);
  }

  private drawTower(): void {
    const ctx = this.ctx;
    const x = this.width * .75;
    const y = this.height * .66;
    for (let floor = 0; floor < 12; floor += 1) {
      this.block(x, y - floor * 13, 5, 3.9, 13, "#c1b187", "#687b58", "#466854");
      for (let window = 0; window < 7; window += 1) {
        const wx = x - 64 + window * 10;
        const wy = y - floor * 13 + 8 + window * .2;
        ctx.fillStyle = (window + floor) % 5 === 0 ? "#d9b474" : "#a3b395";
        ctx.fillRect(Math.round(wx), Math.round(wy), 6, 4);
      }
    }
    this.block(x, y - 157, 5.2, 4.1, 3, "#d1bf8b", "#758668", "#536f54");
    ctx.fillStyle = "#d6ca97";
    ctx.font = "bold 7px 'Segoe UI', sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("MERIDIAN", x, y - 157);
    this.drawVignette();
  }

  private createOutline(image: HTMLImageElement): HTMLCanvasElement | undefined {
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return undefined;
    ctx.drawImage(image, 0, 0);
    ctx.globalCompositeOperation = "source-in";
    ctx.fillStyle = "#e9c37d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    return canvas;
  }

  private block(x: number, y: number, width: number, depth: number, height: number, top: string, left: string, right: string): void {
    const a = { x: x + (-width + depth) * HALF_W / 2, y: y + (-width - depth) * HALF_H / 2 };
    const b = { x: x + (width + depth) * HALF_W / 2, y: y + (width - depth) * HALF_H / 2 };
    const c = { x: x + (width - depth) * HALF_W / 2, y: y + (width + depth) * HALF_H / 2 };
    const d = { x: x + (-width - depth) * HALF_W / 2, y: y + (-width + depth) * HALF_H / 2 };
    this.polygon(this.ctx, [d, c, { x: c.x, y: c.y - height }, { x: d.x, y: d.y - height }], left);
    this.polygon(this.ctx, [b, c, { x: c.x, y: c.y - height }, { x: b.x, y: b.y - height }], right);
    this.polygon(this.ctx, [a, b, c, d].map((point) => ({ x: point.x, y: point.y - height })), top);
  }

  private diamond(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, color?: string): void {
    this.polygon(ctx, [{ x, y: y - height / 2 }, { x: x + width / 2, y }, { x, y: y + height / 2 }, { x: x - width / 2, y }], color);
  }

  private polygon(ctx: CanvasRenderingContext2D, points: Point[], color?: string): void {
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(Math.round(point.x), Math.round(point.y));
      else ctx.lineTo(Math.round(point.x), Math.round(point.y));
    });
    ctx.closePath();
    if (color) {
      ctx.fillStyle = color;
      ctx.fill();
    }
  }
}

function wrapText(text: string, maxLength: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && line.length + word.length + 1 > maxLength) {
      lines.push(line);
      line = word;
    } else {
      line += (line ? " " : "") + word;
    }
  }
  if (line) lines.push(line);
  if (lines.length > 3) lines[2] = `${lines[2].slice(0, maxLength - 1)}…`;
  return lines;
}

function hash(value: string): number {
  let result = 0;
  for (const char of value) result = (result * 31 + char.charCodeAt(0)) >>> 0;
  return result;
}
