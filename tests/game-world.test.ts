import { describe, expect, it } from "vitest";
import { FACTS, HANDLER_BRIEFING, NPCS, STORY_TITLE } from "../shared/story";
import type { FloorPlan, Point } from "../shared/types";
import { canOccupy, findPath, hasLineOfSight, isWalkable } from "../src/game/navigation";
import { GOSSIP_EDGES } from "../src/game/rules";
import { createFloors, FLOOR_HEIGHT, FLOOR_WIDTH } from "../src/game/world";

function reachableTiles(floor: FloorPlan): Map<number, number> {
  const start = Math.floor(floor.spawn.y) * floor.width + Math.floor(floor.spawn.x);
  const result = new Map([[start, 0]]);
  const queue = [start];
  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const x = current % floor.width;
    const y = Math.floor(current / floor.width);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      const next = ny * floor.width + nx;
      if (isWalkable(floor, nx, ny) && !result.has(next)) {
        result.set(next, (result.get(current) ?? 0) + 1);
        queue.push(next);
      }
    }
  }
  return result;
}

function expectRoute(floor: FloorPlan, target: Point, shortest: Map<number, number>): void {
  const path = findPath(floor, floor.spawn, target);
  const goal = { x: Math.floor(target.x) + 0.5, y: Math.floor(target.y) + 0.5 };
  expect(path[0]).toEqual(floor.spawn);
  expect(path.at(-1)).toEqual(goal);
  expect(path.length).toBe((shortest.get(Math.floor(target.y) * floor.width + Math.floor(target.x)) ?? -2) + 1);
  for (let index = 0; index < path.length; index += 1) {
    expect(canOccupy(floor, path[index]), `clear player-radius path on floor ${floor.id}`).toBe(true);
    if (index > 0) {
      expect(Math.abs(path[index].x - path[index - 1].x) + Math.abs(path[index].y - path[index - 1].y)).toBe(1);
    }
  }
}

describe("the authored Meridian Tower", () => {
  it("exports the six main characters, sixty staff, and the canonical evidence", () => {
    expect(STORY_TITLE).toBe("Operation Glasshouse");
    expect(NPCS).toHaveLength(66);
    expect(new Set(NPCS.map((npc) => npc.id)).size).toBe(66);
    expect(NPCS.filter((npc) => !npc.id.startsWith("staff-")).map((npc) => npc.id).sort())
      .toEqual(["anita", "dev", "kulkarni", "meera", "priya", "ramesh"]);
    expect(NPCS.find((npc) => npc.id === "meera")?.floor).toBe(0);
    expect(NPCS.find((npc) => npc.id === "ramesh")?.floor).toBe(2);
    expect(HANDLER_BRIEFING).toContain("FLOOR 2");
    expect(HANDLER_BRIEFING).toContain("SIM-0420");
    expect(FACTS.map((fact) => fact.id)).toEqual([
      "access_rules", "cfo_away", "server_room", "handler_secret", "server_observation",
    ]);
    expect(FACTS.find((fact) => fact.id === "cfo_away")?.text).toContain("Singapore until Friday");
    for (const npc of NPCS) {
      expect(npc.knowledge.every((id) => FACTS.some((fact) => fact.id === id))).toBe(true);
    }
    expect(NPCS.filter((npc) => npc.knowledge.includes("handler_secret")).map((npc) => npc.id)).toEqual(["kulkarni"]);
  });

  it("reproduces the same seeded world without sharing mutable floor data", () => {
    const first = createFloors(12345);
    const second = createFloors(12345);
    expect(first).toEqual(second);
    expect(createFloors(54321)).not.toEqual(first);
    first[0].tiles[0] = "floor";
    expect(second[0].tiles[0]).toBe("wall");
  });

  it.each([1, 42, 9931])("connects every walkable cell, door, elevator, and NPC home for seed %i", (seed) => {
    const floors = createFloors(seed);
    expect(floors).toHaveLength(12);
    for (const floor of floors) {
      expect(floor.width).toBe(FLOOR_WIDTH);
      expect(floor.height).toBe(FLOOR_HEIGHT);
      expect(floor.tiles).toHaveLength(30 * 26);
      const shortest = reachableTiles(floor);
      const walkableCount = floor.tiles.filter((_, index) => isWalkable(floor, index % floor.width, Math.floor(index / floor.width))).length;
      expect(shortest.size, `all rooms connect on floor ${floor.id}`).toBe(walkableCount);
      expectRoute(floor, floor.elevator, shortest);
      if (floor.exit) expectRoute(floor, floor.exit, shortest);
      const doors = floor.tiles.flatMap((tile, index) =>
        tile === "door" ? [{ x: index % floor.width, y: Math.floor(index / floor.width) }] : [],
      );
      expect(doors).toHaveLength(6);
      for (const door of doors) expectRoute(floor, door, shortest);
      const inhabitants = NPCS.filter((npc) => npc.floor === floor.id);
      expect(inhabitants.length).toBeGreaterThanOrEqual(5);
      expect(inhabitants.length).toBeLessThanOrEqual(9);
      for (const npc of inhabitants) expectRoute(floor, npc.home, shortest);
      expect(floor.rooms.some((room) => room.restricted)).toBe(true);
      expect(floor.rooms.some((room) => room.name === "Elevator core")).toBe(true);
    }
  });

  it("authors the important rooms and keeps blue-door reconnaissance distinct from collection", () => {
    const floors = createFloors(42);
    expect(floors[0].rooms.some((room) => room.name === "Reception" && !room.restricted)).toBe(true);
    expect(floors[1].rooms.some((room) => room.name === "Collection desk" && !room.restricted)).toBe(true);
    expect(floors[2].rooms.some((room) => room.name === "Facilities pantry" && !room.restricted)).toBe(true);
    expect(floors[3].rooms.some((room) => room.name === "IT service desk" && !room.restricted)).toBe(true);
    expect(floors[6].rooms.find((room) => room.id === "server-room")?.restricted).toBe(true);
    expect(floors[10].rooms.some((room) => room.name === "Anita's office" && !room.restricted)).toBe(true);
    expect(floors[10].rooms.some((room) => room.name === "Rajan Mehta's office" && room.restricted)).toBe(true);
    expect(floors.flatMap((floor) => floor.rooms).some((room) => room.name === "Restrooms")).toBe(true);
  });

  it("defines the directed, unequal recall probabilities without a global broadcast", () => {
    expect(GOSSIP_EDGES).toEqual([
      { from: "priya", to: "dev", probability: 0.4 },
      { from: "priya", to: "anita", probability: 0.6 },
      { from: "anita", to: "meera", probability: 0.8 },
      { from: "ramesh", to: "meera", probability: 0.7 },
      { from: "kulkarni", to: "ramesh", probability: 0.12 },
    ]);
  });
});

describe("tile navigation", () => {
  it("blocks walls, desks, plants, invalid coordinates, and line of sight through walls", () => {
    const floor = createFloors(42)[0];
    expect(isWalkable(floor, 0, 0)).toBe(false);
    expect(isWalkable(floor, -0.1, 4)).toBe(false);
    expect(isWalkable(floor, 30, 4)).toBe(false);
    expect(isWalkable(floor, NaN, 4)).toBe(false);
    expect(isWalkable(floor, 14.5, 21.5)).toBe(true);
    for (const tile of ["desk", "plant"] as const) {
      const index = floor.tiles.indexOf(tile);
      expect(isWalkable(floor, index % floor.width, Math.floor(index / floor.width))).toBe(false);
    }
    expect(hasLineOfSight(floor, { x: 11.5, y: 20.5 }, { x: 13.5, y: 20.5 })).toBe(false);
    expect(hasLineOfSight(floor, { x: 11.5, y: 21.5 }, { x: 13.5, y: 21.5 })).toBe(true);
  });

  it("returns empty paths for blocked or disconnected targets rather than teleporting", () => {
    const floor = createFloors(42)[0];
    expect(findPath(floor, floor.spawn, { x: 0, y: 0 })).toEqual([]);
    expect(findPath(floor, { x: Infinity, y: 0 }, floor.spawn)).toEqual([]);
    const target = { x: 5.5, y: 4.5 };
    for (const [x, y] of [[4, 4], [6, 4], [5, 3], [5, 5]]) floor.tiles[y * floor.width + x] = "wall";
    expect(isWalkable(floor, target.x, target.y)).toBe(true);
    expect(findPath(floor, floor.spawn, target)).toEqual([]);
    expect(findPath(floor, floor.spawn, floor.spawn)).toEqual([floor.spawn]);
  });
});
