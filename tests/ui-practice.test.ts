import { describe, expect, it } from "vitest";
import { GameEngine } from "../src/game/engine";
import { practiceOptions } from "../src/ui/practice";

function choose(engine: GameEngine, id: string): void {
  const npc = engine.definitions.find((definition) => definition.id === engine.state.activeNpcId);
  expect(npc, "A physical conversation is active").toBeDefined();
  const option = practiceOptions(engine.state, npc!).find((entry) => entry.id === id);
  expect(option, `Scripted practice option ${id} exists`).toBeDefined();
  for (const action of option!.actions) {
    const result = engine.applyAction(action);
    expect(result.accepted, `${id}: ${result.message}`).toBe(true);
  }
}

function lift(engine: GameEngine, floor: number): void {
  const current = engine.floors.find((plan) => plan.id === engine.state.floor)!;
  engine.state.player.x = current.elevator.x;
  engine.state.player.y = current.elevator.y;
  expect(engine.changeFloor(floor)).toBe(true);
}

function visit(engine: GameEngine, npcId: string): void {
  const definition = engine.definitions.find((npc) => npc.id === npcId)!;
  if (engine.state.floor !== definition.floor) lift(engine, definition.floor);
  const npc = engine.state.npcs.find((actor) => actor.id === npcId)!;
  engine.state.player.x = npc.x;
  engine.state.player.y = npc.y;
  expect(engine.beginConversation(npcId)).toBe(true);
}

function exitPosition(engine: GameEngine): void {
  if (engine.state.floor !== 1) lift(engine, 1);
  const exit = engine.floors.find((plan) => plan.id === 1)!.exit!;
  engine.state.player.x = exit.x;
  engine.state.player.y = exit.y;
}

function register(engine: GameEngine): void {
  visit(engine, "priya");
  choose(engine, "introduce-arjun-rao");
  choose(engine, "register");
  choose(engine, "leave");
}

function authorizeByDev(engine: GameEngine): void {
  visit(engine, "dev");
  choose(engine, "introduce-arjun-rao");
  choose(engine, "ticket");
  choose(engine, "authorize");
  choose(engine, "leave");
}

function collect(engine: GameEngine): void {
  visit(engine, "ramesh");
  choose(engine, "introduce-arjun-rao");
  choose(engine, "issue-card");
  choose(engine, "leave");
}

describe("complete practice choices against real engine gates", () => {
  it("completes the visitor-log, Dev, floor-2 collection, and clean-exit route", () => {
    const engine = new GameEngine(41);
    engine.start(true);
    register(engine);
    authorizeByDev(engine);
    collect(engine);
    expect(engine.state.visitorLog).toBe("Arjun Rao");
    expect(engine.state.authorization?.name).toBe("Arjun Rao");
    expect(engine.state.player.carryingCard).toBe(true);
    exitPosition(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("clean");
    expect(engine.state.ledger.every((claim) => !claim.contradiction)).toBe(true);
  });

  it("completes Anita's alternate route without using a camera or fictional IT ticket", () => {
    const engine = new GameEngine(42);
    engine.start(true);
    register(engine);
    visit(engine, "kulkarni");
    choose(engine, "introduce-arjun-rao");
    choose(engine, "learn-cfo_away");
    choose(engine, "leave");
    visit(engine, "anita");
    choose(engine, "introduce-arjun-rao");
    choose(engine, "authorize");
    choose(engine, "leave");
    collect(engine);
    expect(engine.state.settings.camera).toBe(false);
    expect(engine.state.cover.ticket).toBe("");
    expect(engine.state.authorization?.by).toBe("anita");
    exitPosition(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("clean");
  });

  it("earns the Handler evidence through the actual gated conversation and chooses a double-cross", () => {
    const engine = new GameEngine(43);
    engine.start(true);
    register(engine);
    authorizeByDev(engine);
    visit(engine, "kulkarni");
    choose(engine, "introduce-arjun-rao");
    choose(engine, "learn-access_rules");
    choose(engine, "learn-cfo_away");
    choose(engine, "learn-server_room");
    choose(engine, "learn-handler_secret");
    choose(engine, "leave");
    expect(engine.state.secretKnown).toBe(true);
    exitPosition(engine);
    const result = engine.callMeeraForDoubleCross();
    expect(result.accepted, result.message).toBe(true);
    expect(engine.state.ending).toBe("double-cross");
  });

  it("reaches flagged after two observed name changes even when the final paperwork matches", () => {
    const engine = new GameEngine(44);
    engine.start(true);
    visit(engine, "priya");
    choose(engine, "introduce-arjun-rao");
    choose(engine, "change-story");
    choose(engine, "change-story");
    choose(engine, "register");
    choose(engine, "leave");
    authorizeByDev(engine);
    collect(engine);
    exitPosition(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("flagged");
  });

  it("reaches burned from repeated documented contradictions, not a selected model verdict", () => {
    const engine = new GameEngine(45);
    engine.start(true);
    visit(engine, "priya");
    choose(engine, "introduce-arjun-rao");
    for (let index = 0; index < 6; index += 1) choose(engine, "change-story");
    choose(engine, "leave");
    for (let index = 0; index < 40 && engine.state.activeNpcId !== "meera"; index += 1) engine.tick(.25, { x: 0, y: 0 });
    expect(engine.state.activeNpcId).toBe("meera");
    choose(engine, "security-warning");
    expect(engine.state.ending).toBe("burned");
  });

  it("allows a deliberate early departure without inventing a sixth ending", () => {
    const engine = new GameEngine(46);
    engine.start(true);
    exitPosition(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("clock-out");
    expect(engine.state.clockMinute).toBeLessThan(1080);
  });
});
