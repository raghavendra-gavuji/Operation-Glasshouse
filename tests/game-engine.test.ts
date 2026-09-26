import { describe, expect, it, vi } from "vitest";
import { FACTS } from "../shared/story";
import type { Claim, CoverIdentity, GameAction, NpcState, Point } from "../shared/types";
import {
  GameEngine, GAME_DAY_SECONDS, GAME_END_MINUTE, GAME_START_MINUTE, normalizeAlias,
} from "../src/game/engine";
import { canOccupy, distance } from "../src/game/navigation";

const ALIAS = "Asha Rao";
const COMPANY = "Saffron Advisory";

function game(seed = 42): GameEngine {
  const engine = new GameEngine(seed);
  engine.start(true);
  return engine;
}

function npc(engine: GameEngine, id: string): NpcState {
  const result = engine.state.npcs.find((candidate) => candidate.id === id);
  if (!result) throw new Error(`Missing test NPC ${id}`);
  return result;
}

function putPlayer(engine: GameEngine, point: Point): void {
  expect(canOccupy(engine.floors[engine.state.floor - 1], point)).toBe(true);
  engine.state.player.x = point.x;
  engine.state.player.y = point.y;
}

function travel(engine: GameEngine, floor: number): void {
  if (engine.state.activeNpcId) engine.endConversation("Leaving for another appointment.");
  if (engine.state.floor === floor) return;
  putPlayer(engine, engine.floors[engine.state.floor - 1].elevator);
  expect(engine.changeFloor(floor)).toBe(true);
}

function talk(engine: GameEngine, id: string): void {
  if (engine.state.activeNpcId) engine.endConversation("Continuing the visit elsewhere.");
  const target = npc(engine, id);
  travel(engine, target.floor);
  putPlayer(engine, target);
  expect(engine.beginConversation(id), `begin ${id}`).toBe(true);
}

function claim(engine: GameEngine, id: string, field: keyof CoverIdentity, value: string, quote?: string): Claim {
  const result = engine.applyAction({ type: "claim", npcId: id, field, value, quote: quote ?? `My ${field} is ${value}.` });
  expect(result.accepted, result.message).toBe(true);
  const recorded = engine.state.ledger.at(-1);
  if (!recorded) throw new Error("The claim was not recorded.");
  return recorded;
}

function act(engine: GameEngine, action: GameAction): void {
  const result = engine.applyAction(action);
  expect(result.accepted, result.message).toBe(true);
}

function advance(engine: GameEngine, seconds: number): void {
  let remaining = seconds;
  while (remaining > 1e-8) {
    const step = Math.min(0.25, remaining);
    engine.tick(step, { x: 0, y: 0 });
    remaining -= step;
  }
}

function register(engine: GameEngine, alias = ALIAS): void {
  talk(engine, "priya");
  claim(engine, "priya", "name", alias);
  claim(engine, "priya", "company", COMPANY);
  claim(engine, "priya", "host", "Dev");
  act(engine, { type: "register", npcId: "priya", name: alias });
  engine.endConversation("Visitor registered with the stated cover.");
}

function authorize(engine: GameEngine, alias = ALIAS): void {
  talk(engine, "dev");
  claim(engine, "dev", "name", alias);
  claim(engine, "dev", "ticket", "MT-2048");
  act(engine, { type: "authorize", npcId: "dev", name: alias });
  engine.endConversation("Dev checked the fictional ticket.");
}

function collect(engine: GameEngine, alias = ALIAS): void {
  talk(engine, "ramesh");
  claim(engine, "ramesh", "name", alias);
  act(engine, { type: "issue_card", npcId: "ramesh", name: alias });
  engine.endConversation("Collection finished.");
}

function reachExit(engine: GameEngine): void {
  travel(engine, 1);
  const exit = engine.floors[0].exit;
  if (!exit) throw new Error("Missing lobby exit.");
  putPlayer(engine, exit);
}

function learnBuildingFacts(engine: GameEngine): void {
  talk(engine, "kulkarni");
  for (const factId of ["access_rules", "cfo_away", "server_room"]) {
    act(engine, { type: "discover", npcId: "kulkarni", factId });
  }
}

function learnSecret(engine: GameEngine): void {
  learnBuildingFacts(engine);
  engine.endConversation("Learned the three building procedures over tea.");
  register(engine);
  talk(engine, "kulkarni");
  act(engine, { type: "discover", npcId: "kulkarni", factId: "handler_secret" });
  engine.endConversation("Kulkarni remembered his first-hand lead.");
}

function securityCall(engine: GameEngine, severe = false): void {
  talk(engine, "priya");
  claim(engine, "priya", "name", ALIAS);
  if (severe) {
    const second = claim(engine, "priya", "name", "Arun Rao");
    act(engine, { type: "suspicion", npcId: "priya", delta: 30, reason: "Observed name discrepancy.", evidence: second.id });
    const third = claim(engine, "priya", "name", "Amit Rao");
    act(engine, { type: "suspicion", npcId: "priya", delta: 30, reason: "A second recorded name discrepancy.", evidence: third.id });
  } else {
    npc(engine, "priya").suspicion = 85;
  }
  engine.endConversation("Desk requested a security verification.");
  expect(engine.state.ending).toBeNull();
  advance(engine, 3.5);
  expect(engine.state.activeNpcId).toBe("meera");
  expect(engine.state.meeraCalled).toBe(true);
}

function withDevRumor(): GameEngine {
  for (let seed = 1; seed <= 40; seed += 1) {
    const engine = game(seed);
    register(engine);
    if (engine.state.rumors.some((rumor) => rumor.from === "priya" && rumor.to === "dev")) return engine;
  }
  throw new Error("No seeded Priya-to-Dev note found.");
}

describe("mission rules and capabilities", () => {
  it("starts at 09:00 without choosing the player's cover", () => {
    const engine = new GameEngine(123);
    advance(engine, 2);
    expect(engine.state.phase).toBe("briefing");
    expect(engine.state.elapsedSeconds).toBe(0);
    expect(Object.values(engine.state.cover)).toEqual(["", "", "", "", "", "", ""]);
    engine.start(true);
    expect(engine.state.clockMinute).toBe(540);
    expect(engine.state.activeNpcId).toBeNull();
    expect(engine.state.practiceMode).toBe(true);
    expect(engine.state.npcs.every((actor) => actor.intentReason.includes("local fallback"))).toBe(true);
    advance(engine, 0.5);
    expect(engine.state.activeNpcId).toBeNull();
    expect(engine.state.clockMinute).toBeCloseTo(540 + 0.5 * 540 / 1440);
  });

  it("makes start idempotent in a run and resets an ended run with preferences intact", () => {
    const engine = game();
    register(engine);
    engine.start(false);
    expect(engine.state.visitorLog).toBe(ALIAS);
    expect(engine.state.practiceMode).toBe(true);
    engine.state.settings.reducedMotion = true;
    reachExit(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("clock-out");
    engine.start(false);
    expect(engine.state.ending).toBeNull();
    expect(engine.state.visitorLog).toBeNull();
    expect(engine.state.clockMinute).toBe(540);
    expect(engine.state.settings.reducedMotion).toBe(true);
  });

  it("switches explicitly to practice after provider failure without losing mission progress or security answer time", () => {
    const engine = game();
    engine.setPracticeMode(false);
    register(engine);
    authorize(engine);
    securityCall(engine);
    engine.setConversationClockRunning(true);
    advance(engine, 4);
    const cover = { ...engine.state.cover };
    const ledger = structuredClone(engine.state.ledger);
    const authorization = { ...engine.state.authorization };
    const elapsed = engine.state.elapsedSeconds;
    const remaining = engine.securitySecondsRemaining;
    const context = engine.getConversationContext("meera");
    engine.enablePracticeMode();
    expect(engine.state.practiceMode).toBe(true);
    expect(engine.state.visitorLog).toBe(ALIAS);
    expect(engine.state.authorization).toEqual(authorization);
    expect(engine.state.cover).toEqual(cover);
    expect(engine.state.ledger).toEqual(ledger);
    expect(engine.state.elapsedSeconds).toBe(elapsed);
    expect(engine.state.activeNpcId).toBe("meera");
    expect(engine.securitySecondsRemaining).toBe(remaining);
    expect(engine.conversationClockRunning).toBe(false);
    expect(engine.getConversationContext("meera")).toEqual(context);
    advance(engine, 2);
    expect(engine.securitySecondsRemaining).toBe(remaining);
    engine.setPracticeMode(false);
    expect(engine.state.practiceMode).toBe(false);
    expect(engine.state.activeNpcId).toBe("meera");
    expect(() => engine.setPracticeMode(JSON.parse('"invalid"'))).toThrow(TypeError);
  });

  it("does not relabel a finished mission when a late provider failure arrives", () => {
    const engine = game();
    reachExit(engine);
    engine.exitBuilding();
    engine.setPracticeMode(false);
    expect(engine.state.practiceMode).toBe(true);
    expect(engine.state.ending).toBe("clock-out");
    engine.start(false);
    expect(engine.state.practiceMode).toBe(false);
  });

  it("requires Priya's complete fictional cover and forbids real callbacks and IDs", () => {
    const engine = game();
    talk(engine, "priya");
    claim(engine, "priya", "name", ALIAS);
    expect(engine.applyAction({ type: "register", npcId: "priya", name: ALIAS }).accepted).toBe(false);
    claim(engine, "priya", "company", COMPANY);
    expect(engine.applyAction({ type: "register", npcId: "priya", name: ALIAS }).accepted).toBe(false);
    claim(engine, "priya", "role", "Temporary compliance reviewer");
    const rejectedCallback = engine.applyAction({
      type: "claim", npcId: "priya", field: "callback", value: "+91 9876543210", quote: "Use this real phone number.",
    });
    expect(rejectedCallback.accepted).toBe(false);
    expect(engine.state.cover.callback).toBe("");
    expect(engine.state.ledger.some((entry) => entry.value.includes("9876543210"))).toBe(false);
    claim(engine, "priya", "callback", "sim-0420");
    expect(engine.state.cover.callback).toBe("SIM-0420");
    expect(engine.applyAction({
      type: "claim", npcId: "priya", field: "employeeId", value: "1234567890", quote: "My real identification.",
    }).accepted).toBe(false);
    act(engine, { type: "register", npcId: "priya", name: ALIAS });
    expect(engine.state.visitorLog).toBe(ALIAS);
    expect(engine.state.player.carryingCard).toBe(false);
  });

  it("normalizes case and whitespace only, preserving both readable labels and exact quotes", () => {
    const engine = game();
    talk(engine, "priya");
    const quote = "  I go by Asha   Rao.  ";
    claim(engine, "priya", "name", "  Asha   Rao ", quote);
    claim(engine, "priya", "name", "\tASHA \n RAO ");
    expect(engine.state.ledger[0].quote).toBe(quote);
    expect(engine.state.ledger[0].value).toBe(ALIAS);
    expect(engine.state.ledger).toHaveLength(2);
    expect(engine.state.ledger[1].contradiction).toBe(false);
    expect(npc(engine, "priya").suspicion).toBe(0);
    claim(engine, "priya", "company", COMPANY);
    claim(engine, "priya", "host", "Dev");
    act(engine, { type: "register", npcId: "priya", name: " Asha  Rao " });
    expect(engine.state.visitorLog).toBe(ALIAS);
    expect(normalizeAlias("Asha-Rao")).not.toBe(normalizeAlias("Asha Rao"));
    authorize(engine, "asha rao");
    collect(engine, "ASHA    RAO");
    expect(engine.state.player.carryingCard).toBe(true);
  });

  it("requires BOTH the log and an authorization at floor-2 collection", () => {
    const engine = game();
    talk(engine, "ramesh");
    claim(engine, "ramesh", "name", ALIAS);
    expect(engine.applyAction({ type: "issue_card", npcId: "ramesh", name: ALIAS }).message).toContain("visitor log");
    register(engine);
    talk(engine, "ramesh");
    claim(engine, "ramesh", "name", ALIAS);
    expect(engine.applyAction({ type: "issue_card", npcId: "ramesh", name: ALIAS }).message).toContain("authorization");
    expect(engine.state.player.carryingCard).toBe(false);
    authorize(engine);
    collect(engine);
    expect(engine.state.authorization?.by).toBe("dev");
    expect(engine.state.player.carryingCard).toBe(true);
  });

  it("does not issue a card for a similar but nonmatching name", () => {
    const engine = game();
    register(engine);
    authorize(engine);
    talk(engine, "ramesh");
    claim(engine, "ramesh", "name", "Asha Ray");
    const result = engine.applyAction({ type: "issue_card", npcId: "ramesh", name: "Asha Ray" });
    expect(result.accepted).toBe(false);
    expect(result.message).toContain("exact alias-matched visitor log");
    expect(engine.state.player.carryingCard).toBe(false);
    expect(engine.state.visitorLog).toBe(ALIAS);
    expect(engine.state.authorization?.name).toBe(ALIAS);
  });

  it("allows Dev's fictional ID route and authorization before registration, but never a bare alias", () => {
    const engine = game();
    talk(engine, "dev");
    claim(engine, "dev", "name", ALIAS);
    expect(engine.applyAction({ type: "authorize", npcId: "dev", name: ALIAS }).accepted).toBe(false);
    claim(engine, "dev", "employeeId", "MT-ID-3141");
    act(engine, { type: "authorize", npcId: "dev", name: ALIAS });
    expect(engine.state.visitorLog).toBeNull();
    talk(engine, "ramesh");
    claim(engine, "ramesh", "name", ALIAS);
    expect(engine.applyAction({ type: "issue_card", npcId: "ramesh", name: ALIAS }).accepted).toBe(false);
    register(engine);
    collect(engine);
    expect(engine.state.player.carryingCard).toBe(true);
  });

  it("requires learned CFO itinerary and a consistent company for Anita's alternative", () => {
    const engine = game();
    register(engine);
    talk(engine, "anita");
    claim(engine, "anita", "name", ALIAS);
    claim(engine, "anita", "company", COMPANY);
    expect(engine.applyAction({ type: "authorize", npcId: "anita", name: ALIAS }).accepted).toBe(false);
    learnBuildingFacts(engine);
    talk(engine, "anita");
    claim(engine, "anita", "name", ALIAS);
    claim(engine, "anita", "company", "Amber Advisory");
    expect(engine.applyAction({ type: "authorize", npcId: "anita", name: ALIAS }).accepted).toBe(false);
    claim(engine, "anita", "company", COMPANY);
    act(engine, { type: "authorize", npcId: "anita", name: ALIAS });
    expect(engine.state.authorization?.by).toBe("anita");
    collect(engine);
  });

  it("rejects tools before a conversation, from the wrong speaker, and after end_conversation", () => {
    const engine = game();
    const action: GameAction = { type: "claim", npcId: "priya", field: "name", value: ALIAS, quote: `I am ${ALIAS}.` };
    expect(engine.applyAction(action).accepted).toBe(false);
    talk(engine, "priya");
    expect(engine.applyAction({ ...action, npcId: "dev" }).accepted).toBe(false);
    act(engine, action);
    act(engine, { type: "end_conversation", npcId: "priya", summary: "Name given; visitor walked away." });
    expect(engine.state.activeNpcId).toBeNull();
    expect(engine.applyAction(action).accepted).toBe(false);
    expect(engine.state.ledger).toHaveLength(1);
    expect(npc(engine, "priya").memory).toContain("visitor walked away");
  });

  it.each([
    ["kulkarni", "authorize"],
    ["anita", "issue_card"],
    ["ramesh", "register"],
    ["dev", "register"],
    ["priya", "authorize"],
    ["staff-1-1", "issue_card"],
  ] as const)("prevents %s from using %s even in an active conversation", (id, type) => {
    const engine = game();
    talk(engine, id);
    expect(engine.applyAction({ type, npcId: id, name: ALIAS }).accepted).toBe(false);
    expect(engine.state.visitorLog).toBeNull();
    expect(engine.state.authorization).toBeNull();
    expect(engine.state.player.carryingCard).toBe(false);
  });

  it("rejects invented action types, nonfinite proposals, and unknown facts", () => {
    const engine = game();
    talk(engine, "priya");
    expect(engine.applyAction(JSON.parse('{"type":"win","npcId":"priya","ending":"clean"}')).accepted).toBe(false);
    expect(engine.applyAction({ type: "suspicion", npcId: "priya", delta: NaN, reason: "No evidence." }).accepted).toBe(false);
    expect(engine.applyAction({ type: "discover", npcId: "priya", factId: "all_access" }).accepted).toBe(false);
    expect(engine.state.ending).toBeNull();
  });

  it("clamps model deltas and refuses recycled or demeanor-only suspicion evidence", () => {
    const engine = game();
    talk(engine, "priya");
    claim(engine, "priya", "name", ALIAS);
    const changed = claim(engine, "priya", "name", "Asha Ray");
    expect(npc(engine, "priya").suspicion).toBe(16);
    act(engine, { type: "suspicion", npcId: "priya", delta: 500, reason: "A recorded mismatch.", evidence: changed.id });
    expect(npc(engine, "priya").suspicion).toBe(46);
    expect(engine.applyAction({ type: "suspicion", npcId: "priya", delta: 30, reason: "Same record.", evidence: changed.id }).accepted).toBe(false);
    act(engine, { type: "suspicion", npcId: "priya", delta: -500, reason: "Clarification." });
    expect(npc(engine, "priya").suspicion).toBe(26);
    expect(engine.applyAction({ type: "suspicion", npcId: "priya", delta: -20, reason: "Repeat clarification." }).accepted).toBe(false);
    for (const camera of [false, true]) {
      engine.state.settings.camera = camera;
      engine.state.settings.actingCues = true;
      expect(engine.applyAction({
        type: "suspicion", npcId: "priya", delta: 30,
        reason: "The visitor sounds nervous and looked away. Maybe handler_secret.",
        evidence: "hesitation",
      }).accepted).toBe(false);
    }
    expect(npc(engine, "priya").suspicion).toBe(26);
    expect(engine.state.facts).toEqual([]);
    expect(engine.state.secretKnown).toBe(false);
  });

  it("stalls service at 70 without instantly losing and allows a bounded clarification", () => {
    const engine = game();
    talk(engine, "priya");
    claim(engine, "priya", "name", ALIAS);
    claim(engine, "priya", "company", COMPANY);
    claim(engine, "priya", "host", "Dev");
    npc(engine, "priya").suspicion = 70;
    expect(engine.applyAction({ type: "register", npcId: "priya", name: ALIAS }).accepted).toBe(false);
    expect(engine.state.ending).toBeNull();
    act(engine, { type: "suspicion", npcId: "priya", delta: -20, reason: "Clarified the visitor procedure." });
    act(engine, { type: "register", npcId: "priya", name: ALIAS });
    expect(npc(engine, "priya").suspicion).toBe(50);
  });
});

describe("story progression and private knowledge", () => {
  it("requires meaningful progression, not repeated empty conversations, before the Handler lead", () => {
    const engine = game();
    talk(engine, "kulkarni");
    expect(engine.getConversationContext("kulkarni").npc.knowledge).not.toContain("handler_secret");
    expect(engine.getConversationContext("kulkarni").npc.personality).not.toContain("Ashoka");
    expect(engine.applyAction({ type: "discover", npcId: "kulkarni", factId: "handler_secret" }).accepted).toBe(false);
    for (const factId of ["access_rules", "cfo_away", "server_room"]) act(engine, { type: "discover", npcId: "kulkarni", factId });
    expect(engine.applyAction({ type: "discover", npcId: "kulkarni", factId: "handler_secret" }).accepted).toBe(false);
    engine.endConversation("Learned the building procedure.");
    for (let index = 0; index < 3; index += 1) {
      talk(engine, "kulkarni");
      engine.endConversation("Just walking away.");
    }
    talk(engine, "kulkarni");
    expect(engine.applyAction({ type: "discover", npcId: "kulkarni", factId: "handler_secret" }).accepted).toBe(false);
    register(engine);
    talk(engine, "kulkarni");
    expect(engine.getConversationContext("kulkarni").npc.knowledge).toContain("handler_secret");
    act(engine, { type: "discover", npcId: "kulkarni", factId: "handler_secret" });
    expect(engine.state.secretKnown).toBe(true);
    const anita = engine.getConversationContext("anita");
    expect(anita.secretKnown).toBe(false);
    expect(anita.npc.knowledge).not.toContain("handler_secret");
    expect(anita.knownFacts.some((fact) => fact.id === "handler_secret")).toBe(false);
    talk(engine, "anita");
    expect(engine.applyAction({ type: "discover", npcId: "anita", factId: "handler_secret" }).accepted).toBe(false);
  });

  it("also unlocks the lead on a first Kulkarni visit after log and authorization progress", () => {
    const engine = game();
    register(engine);
    authorize(engine);
    learnBuildingFacts(engine);
    act(engine, { type: "discover", npcId: "kulkarni", factId: "handler_secret" });
    expect(engine.state.secretKnown).toBe(true);
  });

  it("does not let an unshared global claim drive a stranger's cover, memory, or suspicion", () => {
    const engine = game();
    talk(engine, "priya");
    claim(engine, "priya", "name", ALIAS);
    claim(engine, "priya", "company", COMPANY);
    engine.endConversation("Met the visitor but did not register them.");
    const before = engine.getConversationContext("dev");
    expect(before.cover.name).toBe("");
    expect(before.cover.company).toBe("");
    expect(before.claims).toEqual([]);
    expect(before.memory).toBe("");
    expect(before.heardRumors).toEqual([]);
    expect(engine.getConversationContext("staff-4-1").visitorLog).toBeNull();
    talk(engine, "dev");
    const unsharedChange = claim(engine, "dev", "name", "Arun Rao");
    expect(unsharedChange.contradiction).toBe(true);
    expect(npc(engine, "dev").suspicion).toBe(0);
    expect(engine.getConversationContext("priya").cover.name).toBe(ALIAS);
    expect(engine.getConversationContext("ramesh").cover.name).toBe("");
  });

  it("delivers seeded gossip later and only to its actual recipients", () => {
    const engine = withDevRumor();
    const note = engine.state.rumors.find((rumor) => rumor.to === "dev");
    expect(note?.delivered).toBe(false);
    expect(engine.getConversationContext("dev").heardRumors).toEqual([]);
    expect(engine.getConversationContext("dev").cover.name).toBe("");
    advance(engine, 13);
    expect(note?.delivered).toBe(true);
    const dev = engine.getConversationContext("dev");
    expect(dev.heardRumors.every((rumor) => rumor.delivered && rumor.to === "dev")).toBe(true);
    expect(dev.cover.name).toBe(ALIAS);
    expect(dev.claims.every((entry) => entry.npcId === "priya")).toBe(true);
    const uninvolved = engine.getConversationContext("staff-8-3");
    expect(uninvolved.cover.name).toBe("");
    expect(uninvolved.claims).toEqual([]);
    expect(uninvolved.memory).toBe("");
    expect(uninvolved.heardRumors).toEqual([]);
    expect(engine.state.events.some((event) => event.kind === "gossip" && event.npcId === "dev")).toBe(true);
  });

  it("keeps the director's shared context free of private dialogue and undiscovered evidence", () => {
    const engine = game();
    register(engine);
    const context = engine.getDirectorContext();
    expect(context.npcs).toHaveLength(6);
    expect(context.npcs.every((entry) => entry.state.floor === 1)).toBe(true);
    const serialized = JSON.stringify(context);
    expect(serialized).not.toContain(ALIAS);
    expect(serialized).not.toContain(COMPANY);
    expect(serialized).not.toContain("Ashoka Capital");
    expect(context.npcs.every((entry) => entry.definition.knowledge.length === 0)).toBe(true);
  });

  it("adds optional floor-7 reconnaissance without requiring trespass or revealing the Handler", () => {
    const engine = game();
    travel(engine, 7);
    putPlayer(engine, { x: 15.5, y: 4.5 });
    advance(engine, 0.25);
    expect(engine.state.facts.map((fact) => fact.id)).toContain("server_observation");
    expect(engine.state.secretKnown).toBe(false);
    expect(engine.state.npcs.every((actor) => actor.suspicion === 0)).toBe(true);
  });

  it("bounds mutable context copies so callers cannot edit the actual engine state", () => {
    const engine = game();
    register(engine);
    const context = engine.getConversationContext("priya");
    context.cover.name = "Overwritten";
    context.claims[0].value = "Overwritten";
    context.npc.knowledge.push("handler_secret");
    const director = engine.getDirectorContext();
    director.floor.tiles[0] = "exit";
    director.player.carryingCard = true;
    expect(engine.state.cover.name).toBe(ALIAS);
    expect(engine.state.ledger[0].value).toBe(ALIAS);
    expect(engine.getConversationContext("priya").npc.knowledge).not.toContain("handler_secret");
    expect(engine.floors[0].tiles[0]).toBe("wall");
    expect(engine.state.player.carryingCard).toBe(false);
  });

  it("bounds model-context payloads while retaining full exact quotes in the ledger", () => {
    const engine = game();
    talk(engine, "priya");
    const quote = "I am Asha Rao. ".repeat(260);
    for (let index = 0; index < 170; index += 1) claim(engine, "priya", "name", ALIAS, quote);
    const context = engine.getConversationContext("priya");
    expect(engine.state.ledger).toHaveLength(170);
    expect(engine.state.ledger[0].quote).toBe(quote);
    expect(context.claims.length).toBeLessThanOrEqual(160);
    expect(context.cover.name).toBe(ALIAS);
    expect(new TextEncoder().encode(JSON.stringify(context)).length).toBeLessThan(128_000);
  });
});

describe("all five endings and fair security", () => {
  it("reaches clean by the full reception -> Dev -> collection -> exit route", () => {
    const engine = game();
    const ending = vi.fn();
    engine.onEnding = ending;
    register(engine);
    authorize(engine);
    collect(engine);
    reachExit(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("clean");
    expect(engine.state.phase).toBe("ended");
    expect(ending).toHaveBeenCalledExactlyOnceWith("clean");
    const elapsed = engine.state.elapsedSeconds;
    advance(engine, 2);
    expect(engine.state.elapsedSeconds).toBe(elapsed);
    engine.exitBuilding();
    expect(ending).toHaveBeenCalledTimes(1);
  });

  it("reaches flagged with a card after an actual recorded inconsistency", () => {
    const engine = game();
    talk(engine, "priya");
    claim(engine, "priya", "name", ALIAS);
    claim(engine, "priya", "name", "Asha Ray");
    claim(engine, "priya", "name", ALIAS);
    claim(engine, "priya", "company", COMPANY);
    claim(engine, "priya", "host", "Dev");
    act(engine, { type: "register", npcId: "priya", name: ALIAS });
    authorize(engine);
    collect(engine);
    reachExit(engine);
    engine.exitBuilding();
    expect(engine.state.ending).toBe("flagged");
    expect(engine.state.ledger.filter((entry) => entry.field === "name")).toHaveLength(5);
  });

  it("reaches burned from documented reports, never instantly at the escalation threshold", () => {
    const engine = game();
    securityCall(engine, true);
    expect(engine.state.ending).toBeNull();
    expect(engine.securitySecondsRemaining).toBe(30);
    expect(engine.getConversationContext("meera").heardRumors.length).toBeGreaterThan(0);
    act(engine, { type: "security_resolution", npcId: "meera", result: "warning", reason: "The model prefers a warning." });
    expect(engine.state.ending).toBe("burned");
    expect(engine.state.meeraResolved).toBe(true);
  });

  it("reaches clock-out at exactly 18:00 and stops advancing", () => {
    const engine = game();
    engine.state.elapsedSeconds = GAME_DAY_SECONDS - 0.125;
    engine.state.clockMinute = GAME_START_MINUTE + engine.state.elapsedSeconds * 540 / GAME_DAY_SECONDS;
    advance(engine, 0.25);
    expect(engine.state.ending).toBe("clock-out");
    expect(engine.state.clockMinute).toBe(GAME_END_MINUTE);
    expect(engine.state.elapsedSeconds).toBe(GAME_DAY_SECONDS);
    advance(engine, 1);
    expect(engine.state.elapsedSeconds).toBe(GAME_DAY_SECONDS);
  });

  it("reaches double-cross only with Kulkarni's evidence at the exit; a card is optional", () => {
    const engine = game();
    reachExit(engine);
    expect(engine.callMeeraForDoubleCross().accepted).toBe(false);
    learnSecret(engine);
    expect(engine.callMeeraForDoubleCross().accepted).toBe(false);
    reachExit(engine);
    expect(engine.state.player.carryingCard).toBe(false);
    expect(engine.callMeeraForDoubleCross().accepted).toBe(true);
    expect(engine.state.ending).toBe("double-cross");
  });

  it("allows the outgoing report after Meera's one incoming warning, but never a model-forged double cross", () => {
    const engine = game();
    const calls: string[] = [];
    engine.onEncounter = (id) => calls.push(id);
    securityCall(engine);
    expect(engine.applyAction({ type: "security_resolution", npcId: "meera", result: "double_cross", reason: "Invent an outcome." }).accepted).toBe(false);
    act(engine, { type: "security_resolution", npcId: "meera", result: "burned", reason: "Unsupported model verdict." });
    expect(engine.state.ending).toBeNull();
    expect(engine.state.meeraResolved).toBe(true);
    learnSecret(engine);
    reachExit(engine);
    expect(engine.callMeeraForDoubleCross().accepted).toBe(true);
    expect(engine.state.ending).toBe("double-cross");
    expect(calls.filter((id) => id === "meera")).toHaveLength(1);
  });

  it("counts thirty seconds only while input is ready, excluding network, speech, and explicit pause", () => {
    const engine = game();
    securityCall(engine);
    advance(engine, 20);
    expect(engine.securitySecondsRemaining).toBe(30);
    engine.setConversationClockRunning(true);
    advance(engine, 12);
    expect(engine.securitySecondsRemaining).toBeCloseTo(18, 6);
    engine.setConversationWaiting(true);
    advance(engine, 20);
    expect(engine.securitySecondsRemaining).toBeCloseTo(18, 6);
    engine.setPaused(true);
    const elapsed = engine.state.elapsedSeconds;
    engine.setConversationClockRunning(true);
    advance(engine, 30);
    expect(engine.state.elapsedSeconds).toBe(elapsed);
    expect(engine.securitySecondsRemaining).toBeCloseTo(18, 6);
    engine.setPaused(false);
    advance(engine, 18.25);
    expect(engine.state.meeraResolved).toBe(true);
    expect(engine.securitySecondsRemaining).toBeNull();
    expect(engine.state.ending).toBeNull();
    expect(engine.state.events.some((event) => event.text.includes("issued a warning"))).toBe(true);
  });

  it("lets the player explicitly leave a security call without using silence as guilt", () => {
    const engine = game();
    securityCall(engine);
    engine.endConversation();
    expect(engine.state.activeNpcId).toBeNull();
    expect(engine.state.meeraResolved).toBe(true);
    expect(engine.state.ending).toBeNull();
    expect(engine.beginConversation("meera")).toBe(false);
  });
});

describe("real-time movement, encounters, and validated direction", () => {
  it("normalizes diagonal movement and clamps a stalled frame instead of tunneling through walls", () => {
    const cardinal = game();
    const diagonal = game();
    const origin = { x: 14.5, y: 14.5 };
    putPlayer(cardinal, origin);
    putPlayer(diagonal, origin);
    cardinal.tick(0.25, { x: 1, y: 0 });
    diagonal.tick(0.25, { x: 1, y: 1 });
    expect(distance(origin, cardinal.state.player)).toBeCloseTo(0.8);
    expect(distance(origin, diagonal.state.player)).toBeCloseTo(0.8);
    const engine = game();
    putPlayer(engine, { x: 11.5, y: 20.5 });
    engine.tick(5000, { x: 1, y: 0, running: true });
    expect(engine.state.player.x).toBeLessThan(11.79);
    expect(canOccupy(engine.floors[0], engine.state.player)).toBe(true);
    expect(engine.state.elapsedSeconds).toBeCloseTo(0.25);
  });

  it("freezes the clock when paused and rejects invalid simulation inputs", () => {
    const engine = game();
    engine.setPaused(true);
    const before = { ...engine.state.player };
    advance(engine, 10);
    engine.tick(1, { x: 1, y: 1 });
    expect(engine.state.elapsedSeconds).toBe(0);
    expect(engine.state.player).toEqual(before);
    engine.setPaused(false);
    engine.tick(Infinity, { x: 0, y: 0 });
    engine.tick(0.25, { x: NaN, y: 0 });
    expect(engine.state.elapsedSeconds).toBe(0);
    expect(engine.state.events.at(-1)?.text).toContain("Simulation input rejected");
  });

  it("never makes NPC bodies solid collision traps", () => {
    const engine = game();
    const origin = { x: 14.5, y: 14.5 };
    putPlayer(engine, origin);
    for (const actor of engine.state.npcs.filter((candidate) => candidate.floor === 1)) {
      actor.x = origin.x + 0.1;
      actor.y = origin.y;
    }
    engine.tick(0.25, { x: 1, y: 0 });
    expect(engine.state.player.x).toBeCloseTo(15.3);
    expect(engine.state.player.moving).toBe(true);
  });

  it("blocks movement during dialogue, clears it immediately on walk-away, and permits manual re-engagement", () => {
    const engine = game();
    talk(engine, "priya");
    const before = { ...engine.state.player };
    engine.tick(0.25, { x: 1, y: 0 });
    expect(engine.state.player.x).toBe(before.x);
    expect(engine.state.player.moving).toBe(false);
    engine.endConversation("Walking away.");
    engine.tick(0.25, { x: 1, y: 0 });
    expect(engine.state.player.x).toBeGreaterThan(before.x);
    expect(engine.beginConversation("priya")).toBe(true);
  });

  it("approaches visible players automatically, supplies an escape grace period, and later repeats", () => {
    const engine = game(7);
    const encounters: string[] = [];
    engine.onEncounter = (id) => encounters.push(id);
    advance(engine, 5.25);
    const priya = npc(engine, "priya");
    putPlayer(engine, { x: priya.x - 2.5, y: priya.y });
    advance(engine, 4);
    expect(engine.state.activeNpcId).toBe("priya");
    expect(encounters.filter((id) => id === "priya")).toHaveLength(1);
    engine.endConversation("Leaving politely.");
    advance(engine, 6);
    expect(engine.state.activeNpcId).toBeNull();
    const x = engine.state.player.x;
    engine.tick(0.25, { x: -1, y: 0 });
    expect(engine.state.player.x).toBeLessThan(x);
    advance(engine, 47);
    expect(encounters.filter((id) => id === "priya").length).toBeGreaterThanOrEqual(2);
  });

  it("guards elevator and exit actions by physical proximity and conversation state", () => {
    const engine = game();
    expect(engine.canUseElevator).toBe(true);
    expect(engine.canExit).toBe(false);
    expect(engine.changeFloor(0)).toBe(false);
    expect(engine.changeFloor(13)).toBe(false);
    expect(engine.changeFloor(2)).toBe(true);
    expect(engine.state.floor).toBe(2);
    talk(engine, "ramesh");
    expect(engine.changeFloor(1)).toBe(false);
    engine.exitBuilding();
    expect(engine.state.ending).toBeNull();
    engine.endConversation();
    expect(engine.changeFloor(1)).toBe(false);
    travel(engine, 1);
    reachExit(engine);
    expect(engine.canExit).toBe(true);
  });

  it("validates director actors, target floors, and connected paths without teleportation", () => {
    const engine = game();
    const priya = npc(engine, "priya");
    const original = { x: priya.x, y: priya.y };
    engine.applyDirector({
      source: "gemini",
      intents: [{ npcId: "priya", action: "walk_to", target: { x: 14.5, y: 21.5 }, reason: "Greet arrivals from the corridor." }],
      chatter: [],
    });
    expect({ x: priya.x, y: priya.y }).toEqual(original);
    expect(priya.intentReason).toContain("Gemini:");
    engine.tick(0.1, { x: 0, y: 0 });
    expect(distance(original, priya)).toBeGreaterThan(0);
    expect(distance(original, priya)).toBeLessThan(0.2);
    const dev = { ...npc(engine, "dev") };
    engine.applyDirector({
      source: "gemini",
      intents: [
        { npcId: "dev", action: "walk_to", target: engine.floors[0].spawn, reason: "Wrong-floor actor." },
        { npcId: "unknown", action: "idle", reason: "Unknown actor." },
        { npcId: "priya", action: "chat_with", targetNpcId: "anita", reason: "Wrong-floor peer." },
        { npcId: "priya", action: "emerge_from", target: { x: 0.5, y: 0.5 }, reason: "A wall is not a spawn portal." },
      ],
      chatter: [],
    });
    expect(npc(engine, "dev")).toEqual(dev);
    expect(canOccupy(engine.floors[0], priya)).toBe(true);
    const floor = engine.floors[0];
    for (const [x, y] of [[4, 4], [6, 4], [5, 3], [5, 5]]) floor.tiles[y * floor.width + x] = "wall";
    const intentBefore = priya.intentReason;
    engine.applyDirector({
      source: "gemini", intents: [{ npcId: "priya", action: "walk_to", target: { x: 5.5, y: 4.5 }, reason: "Sealed room target." }], chatter: [],
    });
    expect(priya.intentReason).toBe(intentBefore);
    expect(engine.state.events.at(-1)?.text).toContain("unreachable");
  });

  it("supports actual nearby NPC-to-NPC bubbles without sharing a player's global ledger", () => {
    const engine = game();
    const other = npc(engine, "staff-1-5");
    other.x = 10.5;
    other.y = 21.5;
    engine.applyDirector({
      source: "gemini", intents: [],
      chatter: [{ from: "priya", to: other.id, text: "The next appointment is at ten." }],
    });
    expect(npc(engine, "priya").bubble).toBe("The next appointment is at ten.");
    expect(other.memory).toContain("The next appointment is at ten.");
    expect(npc(engine, "dev").memory).toBe("");
    expect(engine.state.ledger).toEqual([]);
  });

  it("exposes deep-copied actual debug routes on the active floor only", () => {
    const engine = game();
    const initial = engine.getDebugPaths();
    expect(Object.keys(initial)).toHaveLength(6);
    expect(initial.priya).toEqual([]);
    expect(initial.dev).toBeUndefined();
    expect(initial.meera).toBeUndefined();
    engine.applyDirector({
      source: "gemini",
      intents: [{ npcId: "priya", action: "walk_to", target: { x: 14.5, y: 21.5 }, reason: "Use this real route for the debug overlay." }],
      chatter: [],
    });
    const paths = engine.getDebugPaths();
    expect(paths.priya.length).toBeGreaterThan(0);
    const originalFirst = { ...paths.priya[0] };
    expect(distance(npc(engine, "priya"), originalFirst)).toBeGreaterThan(0);
    paths.priya[0].x = 999;
    paths.priya.push({ x: 999, y: 999 });
    expect(engine.getDebugPaths().priya[0]).toEqual(originalFirst);
    expect(engine.getDebugPaths().priya).not.toBe(paths.priya);
    engine.tick(0.1, { x: 0, y: 0 });
    expect(canOccupy(engine.floors[0], npc(engine, "priya"))).toBe(true);
    expect(engine.changeFloor(2)).toBe(true);
    expect(engine.getDebugPaths().priya).toBeUndefined();
    expect(engine.getDebugPaths().ramesh).toEqual([]);
  });

  it("treats witnessed restricted-room entry as evidence but does not accumulate violations while a conversation immobilizes the player", () => {
    const engine = game();
    travel(engine, 7);
    const guard = npc(engine, "staff-7-2");
    putPlayer(engine, guard);
    engine.tick(0.25, { x: 0, y: 0 });
    const suspicion = guard.suspicion;
    expect(suspicion).toBe(12);
    expect(engine.state.events.some((event) => event.kind === "suspicion" && event.text.includes("restricted"))).toBe(true);
    expect(engine.beginConversation(guard.id)).toBe(true);
    advance(engine, 25);
    expect(guard.suspicion).toBe(suspicion);
    expect(engine.state.ending).toBeNull();
  });
});

describe("versioned save and restore", () => {
  it("round-trips progress, private memories, pending gossip, paths, and deterministic randomness", () => {
    const original = withDevRumor();
    original.applyDirector({
      source: "gemini", intents: [{ npcId: "priya", action: "walk_to", target: { x: 11.5, y: 21.5 }, reason: "Check the reception doorway." }], chatter: [],
    });
    advance(original, 0.5);
    const restored = new GameEngine(900);
    expect(restored.restore(original.serialize())).toBe(true);
    expect(restored.state.paused).toBe(true);
    expect(restored.state.seed).toBe(original.state.seed);
    expect(restored.state.ledger).toEqual(original.state.ledger);
    expect(restored.state.rumors).toEqual(original.state.rumors);
    expect(restored.getConversationContext("priya")).toEqual(original.getConversationContext("priya"));
    restored.setPaused(false);
    advance(original, 13);
    advance(restored, 13);
    expect(restored.state.npcs).toEqual(original.state.npcs);
    expect(restored.state.rumors).toEqual(original.state.rumors);
    expect(restored.getConversationContext("dev")).toEqual(original.getConversationContext("dev"));
  });

  it("saves a live Meera response budget, restoring paused and waiting for fresh input readiness", () => {
    const original = game();
    securityCall(original);
    original.setConversationClockRunning(true);
    advance(original, 7);
    const restored = new GameEngine();
    expect(restored.restore(original.serialize())).toBe(true);
    expect(restored.state.activeNpcId).toBe("meera");
    expect(restored.securitySecondsRemaining).toBeCloseTo(23);
    advance(restored, 20);
    expect(restored.securitySecondsRemaining).toBeCloseTo(23);
    restored.setPaused(false);
    advance(restored, 10);
    expect(restored.securitySecondsRemaining).toBeCloseTo(23);
    restored.setConversationClockRunning(true);
    advance(restored, 3);
    expect(restored.securitySecondsRemaining).toBeCloseTo(20);
  });

  it("restores completed clean and double-cross endings without inventing a new run", () => {
    const clean = game();
    register(clean);
    authorize(clean);
    collect(clean);
    reachExit(clean);
    clean.exitBuilding();
    const first = new GameEngine();
    expect(first.restore(clean.serialize())).toBe(true);
    expect(first.state.ending).toBe("clean");
    const crossed = game();
    learnSecret(crossed);
    reachExit(crossed);
    crossed.callMeeraForDoubleCross();
    const second = new GameEngine();
    expect(second.restore(crossed.serialize())).toBe(true);
    expect(second.state.ending).toBe("double-cross");
  });

  it("rejects corrupted shapes and versions atomically with a visible diagnostic", () => {
    const engine = game(77);
    register(engine);
    const serialized = engine.serialize();
    const corruptions: ((save: ReturnType<typeof JSON.parse>) => void)[] = [
      (save) => { save.version = 2; },
      (save) => { save.state.version = 2; },
      (save) => { delete save.runtime; },
      (save) => { save.state.player.x = "not a number"; },
      (save) => { save.state.npcs[0].suspicion = -1; },
      (save) => { save.state.npcs[0].floor = 12; },
      (save) => { save.state.npcs.pop(); },
      (save) => { save.state.facts.push({ id: "invented" }); },
      (save) => { save.state.unrecognized = true; },
      (save) => { save.runtime.heardClaims.dev.push("missing-claim"); },
      (save) => { save.state.player.x = 0.5; save.state.player.y = 0.5; },
      (save) => { save.runtime.actors.priya.path = [{ x: 0.5, y: 0.5 }]; },
      (save) => { save.state.cover.name = "Fabricated"; },
      (save) => { save.state.player.carryingCard = true; },
      (save) => { save.runtime.sequence = 0; },
    ];
    for (const corrupt of corruptions) {
      const decoded = JSON.parse(serialized);
      corrupt(decoded);
      expect(engine.restore(JSON.stringify(decoded))).toBe(false);
      expect(engine.state.seed).toBe(77);
      expect(engine.state.visitorLog).toBe(ALIAS);
      expect(engine.state.phase).toBe("playing");
      expect(engine.state.player.carryingCard).toBe(false);
      expect(engine.state.events.at(-1)?.text).toContain("Save rejected:");
    }
    expect(engine.restore("{ broken json")).toBe(false);
    expect(engine.restore("null")).toBe(false);
    expect(engine.restore(JSON.stringify(engine.state))).toBe(false);
  });

  it("rejects secret and mission flags that lack their prerequisite evidence", () => {
    const engine = game();
    const secret = FACTS.find((fact) => fact.id === "handler_secret");
    const decoded = JSON.parse(engine.serialize());
    decoded.state.secretKnown = true;
    decoded.state.facts.push(secret);
    expect(engine.restore(JSON.stringify(decoded))).toBe(false);
    const authorization = JSON.parse(engine.serialize());
    authorization.state.authorization = { name: ALIAS, by: "kulkarni", at: 0 };
    expect(engine.restore(JSON.stringify(authorization))).toBe(false);
    const ended = JSON.parse(engine.serialize());
    ended.state.phase = "ended";
    ended.state.ending = "burned";
    expect(engine.restore(JSON.stringify(ended))).toBe(false);
  });

  it("keeps finalized transcripts immutable and records late NPC farewells without reopening tools", () => {
    const engine = game();
    talk(engine, "priya");
    engine.addTranscript({ id: "bad-handler", npcId: "priya", speaker: "handler", text: "Impersonated speaker.", at: 0, final: true });
    expect(engine.state.transcripts).toHaveLength(0);
    engine.addTranscript({ id: "line-1", npcId: "priya", speaker: "player", text: "I am Asha Rao.", at: Date.now(), final: true });
    expect(engine.state.transcripts[0].at).toBe(engine.state.elapsedSeconds);
    engine.addTranscript({ id: "line-1", npcId: "priya", speaker: "player", text: "A rewritten name.", at: 0, final: true });
    expect(engine.state.transcripts[0].text).toBe("I am Asha Rao.");
    act(engine, { type: "end_conversation", npcId: "priya", summary: "Reception farewell." });
    engine.addTranscript({ id: "farewell-1", npcId: "priya", speaker: "npc", text: "Have a good visit.", at: 0, final: true });
    expect(engine.state.transcripts.at(-1)?.text).toBe("Have a good visit.");
    expect(engine.state.activeNpcId).toBeNull();
    expect(engine.applyAction({ type: "register", npcId: "priya", name: ALIAS }).accepted).toBe(false);
    const restored = new GameEngine();
    expect(restored.restore(engine.serialize())).toBe(true);
  });
});
