import { describe, expect, it } from "vitest";
import type { GameAction, NpcState, Point } from "../shared/types";
import { GameEngine, GAME_DAY_SECONDS } from "../src/game/engine";
import { canOccupy, distance, findPath, hasLineOfSight } from "../src/game/navigation";
import { WALK_SPEED } from "../src/game/rules";

const ALIAS = "Kavita Sen";

function actor(engine: GameEngine, id: string): NpcState {
  const npc = engine.state.npcs.find((candidate) => candidate.id === id);
  if (!npc) throw new Error(`Missing actor ${id}`);
  return npc;
}

function takeAction(engine: GameEngine, action: GameAction): void {
  const result = engine.applyAction(action);
  expect(result.accepted, result.message).toBe(true);
}

function introduce(engine: GameEngine, id: string, field: "name" | "company" | "role" | "ticket", value: string): void {
  takeAction(engine, { type: "claim", npcId: id, field, value, quote: `My ${field} is ${value}.` });
}

function walk(engine: GameEngine, goal: Point, meeting?: string): boolean {
  const floor = engine.floors[engine.state.floor - 1];
  const path = findPath(floor, engine.state.player, goal);
  expect(path.length, `reachable floor-${floor.id} destination`).toBeGreaterThan(0);
  let frames = 0;
  for (const point of path) {
    while (distance(engine.state.player, point) > 0.002) {
      if (++frames > 2000) throw new Error(`Movement stalled on floor ${engine.state.floor}: ${JSON.stringify(engine.state.player)} -> ${JSON.stringify(point)}`);
      expect(engine.state.phase).toBe("playing");
      if (engine.state.activeNpcId === meeting) return true;
      if (engine.state.activeNpcId) engine.endConversation("I need to keep my appointment. Walking away.");
      if (meeting) {
        const npc = actor(engine, meeting);
        if (distance(engine.state.player, npc) <= 2.2 && hasLineOfSight(floor, engine.state.player, npc)) {
          expect(engine.beginConversation(meeting)).toBe(true);
          return true;
        }
      }
      const delta = { x: point.x - engine.state.player.x, y: point.y - engine.state.player.y };
      const length = Math.hypot(delta.x, delta.y);
      engine.tick(Math.min(0.04, length / WALK_SPEED), { x: delta.x / length, y: delta.y / length });
      expect(canOccupy(floor, engine.state.player)).toBe(true);
    }
  }
  return meeting !== undefined && engine.state.activeNpcId === meeting;
}

function ride(engine: GameEngine, floor: number): void {
  if (engine.state.activeNpcId) engine.endConversation("Taking the elevator.");
  if (engine.state.floor === floor) return;
  walk(engine, engine.floors[engine.state.floor - 1].elevator);
  if (engine.state.activeNpcId) engine.endConversation("Taking the elevator now.");
  expect(engine.changeFloor(floor)).toBe(true);
}

function meet(engine: GameEngine, id: string): void {
  if (engine.state.activeNpcId) engine.endConversation("Next appointment.");
  const npc = actor(engine, id);
  ride(engine, npc.floor);
  const definition = engine.definitions.find((candidate) => candidate.id === id);
  if (!definition) throw new Error(`Missing definition ${id}`);
  if (walk(engine, definition.home, id)) return;
  if (walk(engine, npc, id)) return;
  expect(engine.beginConversation(id)).toBe(true);
}

function registerByWalking(engine: GameEngine): void {
  meet(engine, "priya");
  introduce(engine, "priya", "name", ALIAS);
  introduce(engine, "priya", "company", "Copperleaf Advisory");
  introduce(engine, "priya", "role", "Visitor compliance reviewer");
  takeAction(engine, { type: "register", npcId: "priya", name: ALIAS });
  engine.endConversation("Registered under one consistent cover.");
}

function learnByWalking(engine: GameEngine): void {
  meet(engine, "kulkarni");
  for (const factId of ["access_rules", "cfo_away", "server_room"]) {
    takeAction(engine, { type: "discover", npcId: "kulkarni", factId });
  }
  engine.endConversation("Learned the tower rules, CFO itinerary, and optional reconnaissance location.");
}

function exitByWalking(engine: GameEngine): void {
  ride(engine, 1);
  const exit = engine.floors[0].exit;
  if (!exit) throw new Error("Missing ground-floor exit.");
  walk(engine, exit);
  if (engine.state.activeNpcId) engine.endConversation("Leaving the building.");
  expect(engine.canExit).toBe(true);
}

describe("playable keyboard journeys without position shortcuts", () => {
  it.each([101, 202, 303])("completes a clean Dev-route mission with moving NPCs for seed %i", (seed) => {
    const engine = new GameEngine(seed);
    engine.start(true);
    registerByWalking(engine);
    learnByWalking(engine);
    meet(engine, "dev");
    introduce(engine, "dev", "name", ALIAS);
    introduce(engine, "dev", "ticket", "MT-7302");
    takeAction(engine, { type: "authorize", npcId: "dev", name: ALIAS });
    engine.endConversation("The fictional ticket was checked.");
    meet(engine, "ramesh");
    introduce(engine, "ramesh", "name", ALIAS);
    takeAction(engine, { type: "issue_card", npcId: "ramesh", name: ALIAS });
    engine.endConversation("Collected at the floor-2 desk.");
    exitByWalking(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("clean");
    expect(engine.state.elapsedSeconds).toBeGreaterThan(30);
    expect(engine.state.elapsedSeconds).toBeLessThan(180);
    const restored = new GameEngine();
    expect(restored.restore(engine.serialize())).toBe(true);
    expect(restored.state.ending).toBe("clean");
  });

  it("completes the floor-11 alternative with no ticket or employee ID", () => {
    const engine = new GameEngine(404);
    engine.start(true);
    registerByWalking(engine);
    learnByWalking(engine);
    meet(engine, "anita");
    introduce(engine, "anita", "name", ALIAS);
    introduce(engine, "anita", "company", "Copperleaf Advisory");
    takeAction(engine, { type: "authorize", npcId: "anita", name: ALIAS });
    engine.endConversation("Anita handled the visitor while the CFO was away.");
    meet(engine, "ramesh");
    introduce(engine, "ramesh", "name", ALIAS);
    takeAction(engine, { type: "issue_card", npcId: "ramesh", name: ALIAS });
    engine.endConversation("The two records matched.");
    exitByWalking(engine);
    engine.exitBuilding();
    expect(engine.state.cover.ticket).toBe("");
    expect(engine.state.cover.employeeId).toBe("");
    expect(engine.state.authorization?.by).toBe("anita");
    expect(engine.state.ending).toBe("clean");
  });

  it("can choose the evidence route and walk out for a double-cross without collecting a card", () => {
    const engine = new GameEngine(505);
    engine.start(true);
    registerByWalking(engine);
    learnByWalking(engine);
    meet(engine, "kulkarni");
    takeAction(engine, { type: "discover", npcId: "kulkarni", factId: "handler_secret" });
    engine.endConversation("Remembered the similar auditor and rival firm.");
    ride(engine, 7);
    walk(engine, { x: 15.5, y: 4.5 });
    expect(engine.state.facts.some((fact) => fact.id === "server_observation")).toBe(true);
    exitByWalking(engine);
    expect(engine.callMeeraForDoubleCross().accepted).toBe(true);
    expect(engine.state.player.carryingCard).toBe(false);
    expect(engine.state.ending).toBe("double-cross");
    expect(engine.state.npcs.every((npc) => npc.suspicion === 0)).toBe(true);
  });

  it("keeps all twelve floors playable and saves valid through an entire 24-minute simulated day", () => {
    const engine = new GameEngine(606);
    engine.start(true);
    let nextCheck = 0;
    let nextRide = 110;
    let visited = 1;
    let snapshots = 0;
    while (engine.state.phase === "playing") {
      if (engine.state.activeNpcId) engine.endConversation("Walking away to keep the corridor clear.");
      if (engine.state.elapsedSeconds >= nextRide && visited < 12) {
        visited += 1;
        ride(engine, visited);
        nextRide += 110;
      }
      engine.tick(0.25, { x: 0, y: 0 });
      if (engine.state.elapsedSeconds >= nextCheck) {
        for (const npc of engine.state.npcs.filter((candidate) => candidate.floor > 0)) {
          expect(canOccupy(engine.floors[npc.floor - 1], npc), `${npc.id} stays on a legal tile`).toBe(true);
        }
        const checkpoint = new GameEngine();
        expect(checkpoint.restore(engine.serialize()), engine.state.events.at(-1)?.text).toBe(true);
        expect(checkpoint.state.elapsedSeconds).toBe(engine.state.elapsedSeconds);
        snapshots += 1;
        nextCheck += 45;
      }
    }
    expect(visited).toBe(12);
    expect(snapshots).toBeGreaterThan(30);
    expect(engine.state.ending).toBe("clock-out");
    expect(engine.state.elapsedSeconds).toBe(GAME_DAY_SECONDS);
  });
});
