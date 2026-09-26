import type { FloorPlan, Point, Room } from "../../shared/types";

const WALKABLE_TILES = new Set(["floor", "carpet", "door", "elevator", "exit"]);

export function isWalkable(floor: FloorPlan, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const tileX = Math.floor(x);
  const tileY = Math.floor(y);
  return tileX >= 0 && tileY >= 0 && tileX < floor.width && tileY < floor.height
    && WALKABLE_TILES.has(floor.tiles[tileY * floor.width + tileX]);
}

export function canOccupy(floor: FloorPlan, point: Point, radius = 0.22): boolean {
  return Number.isFinite(radius) && radius >= 0
    && isWalkable(floor, point.x - radius, point.y - radius)
    && isWalkable(floor, point.x + radius, point.y - radius)
    && isWalkable(floor, point.x - radius, point.y + radius)
    && isWalkable(floor, point.x + radius, point.y + radius);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function roomAt(floor: FloorPlan, point: Point): Room | undefined {
  return floor.rooms.find((room) =>
    point.x >= room.x && point.y >= room.y
    && point.x < room.x + room.width && point.y < room.y + room.height,
  );
}

export function hasLineOfSight(floor: FloorPlan, start: Point, end: Point): boolean {
  if (!isWalkable(floor, start.x, start.y) || !isWalkable(floor, end.x, end.y)) return false;
  const steps = Math.max(1, Math.ceil(distance(start, end) * 12));
  for (let step = 1; step < steps; step += 1) {
    const ratio = step / steps;
    if (!isWalkable(
      floor,
      start.x + (end.x - start.x) * ratio,
      start.y + (end.y - start.y) * ratio,
    )) return false;
  }
  return true;
}

interface SearchNode {
  index: number;
  cost: number;
  score: number;
  order: number;
}

class MinHeap {
  private nodes: SearchNode[] = [];

  get length(): number { return this.nodes.length; }

  private before(a: SearchNode, b: SearchNode): boolean {
    return a.score < b.score || (a.score === b.score && a.order < b.order);
  }

  push(node: SearchNode): void {
    this.nodes.push(node);
    let index = this.nodes.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (!this.before(this.nodes[index], this.nodes[parent])) break;
      [this.nodes[index], this.nodes[parent]] = [this.nodes[parent], this.nodes[index]];
      index = parent;
    }
  }

  pop(): SearchNode {
    const first = this.nodes[0];
    const last = this.nodes.pop();
    if (!first || !last) throw new RangeError("Cannot remove a node from an empty search.");
    if (this.nodes.length > 0) {
      this.nodes[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = index;
        if (left < this.nodes.length && this.before(this.nodes[left], this.nodes[next])) next = left;
        if (right < this.nodes.length && this.before(this.nodes[right], this.nodes[next])) next = right;
        if (next === index) break;
        [this.nodes[index], this.nodes[next]] = [this.nodes[next], this.nodes[index]];
        index = next;
      }
    }
    return first;
  }
}

/** Four-neighbor A*: tile centers, including both endpoints; an empty path means unreachable. */
export function findPath(floor: FloorPlan, start: Point, goal: Point): Point[] {
  if (!isWalkable(floor, start.x, start.y) || !isWalkable(floor, goal.x, goal.y)) return [];
  const startX = Math.floor(start.x);
  const startY = Math.floor(start.y);
  const goalX = Math.floor(goal.x);
  const goalY = Math.floor(goal.y);
  const startIndex = startY * floor.width + startX;
  const goalIndex = goalY * floor.width + goalX;
  const costs = new Float64Array(floor.width * floor.height).fill(Infinity);
  const parents = new Int32Array(costs.length).fill(-1);
  const open = new MinHeap();
  const heuristic = (x: number, y: number): number => Math.abs(x - goalX) + Math.abs(y - goalY);
  let order = 0;
  costs[startIndex] = 0;
  open.push({ index: startIndex, cost: 0, score: heuristic(startX, startY), order: order++ });
  const neighbors = [[1, 0], [0, 1], [-1, 0], [0, -1]] as const;

  while (open.length > 0) {
    const current = open.pop();
    if (current.cost !== costs[current.index]) continue;
    if (current.index === goalIndex) {
      const path: Point[] = [];
      for (let index = goalIndex; index !== -1; index = parents[index]) {
        path.push({ x: (index % floor.width) + 0.5, y: Math.floor(index / floor.width) + 0.5 });
      }
      return path.reverse();
    }
    const x = current.index % floor.width;
    const y = Math.floor(current.index / floor.width);
    for (const [dx, dy] of neighbors) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (!isWalkable(floor, nextX, nextY)) continue;
      const nextIndex = nextY * floor.width + nextX;
      const cost = current.cost + 1;
      if (cost >= costs[nextIndex]) continue;
      costs[nextIndex] = cost;
      parents[nextIndex] = current.index;
      open.push({ index: nextIndex, cost, score: cost + heuristic(nextX, nextY), order: order++ });
    }
  }
  return [];
}
