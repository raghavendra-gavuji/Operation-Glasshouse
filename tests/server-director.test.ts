import { describe, expect, it } from "vitest";
import { GameEngine } from "../src/game/engine";
import { canOccupy, findPath } from "../src/game/navigation";
import { buildDirectorPlan, validateDirectorReply } from "../server/director";
import { directorContextSchema, generationJsonSchema } from "../server/schemas";

function engine() {
  const game = new GameEngine(42);
  game.start(false);
  return game;
}

describe("full-floor director planning constraints", () => {
  it("constrains all six actors to their exact canonical IDs rather than display names", () => {
    const game = engine();
    const context = game.getDirectorContext();
    expect(context.npcs).toHaveLength(6);
    const plan = buildDirectorPlan(context);
    expect(plan.snapshot.actors.map(actor => actor.npcId)).toEqual(context.npcs.map(actor => actor.state.id));
    const encodedSchema = JSON.stringify(generationJsonSchema(plan.schema));
    expect(encodedSchema).toContain("staff-1-1");
    expect(encodedSchema).not.toContain('"farah"');
    expect(plan.schema.safeParse({
      source: "gemini", chatter: [], intents: [{ npcId: "farah", action: "idle", reason: "At work." }],
    }).success).toBe(false);
  });

  it("accepts the optional encounter field and excludes an engaged actor from every selection", () => {
    const game = engine();
    game.state.player.x = 10.5;
    game.state.player.y = 21.5;
    expect(game.beginConversation("priya")).toBe(true);
    const context = game.getDirectorContext();
    expect(directorContextSchema.safeParse(context).success).toBe(true);
    expect(context.activeNpcId).toBe("priya");
    expect(context.npcs).toHaveLength(5);
    const plan = buildDirectorPlan(context);
    expect(plan.snapshot.actors.some(actor => actor.npcId === "priya" || actor.mayChatWith.includes("priya"))).toBe(false);
    expect(plan.snapshot.allowedChatterPairs.some(pair => pair.from === "priya" || pair.to === "priya")).toBe(false);
    expect(() => validateDirectorReply({
      source: "gemini", chatter: [], intents: [{ npcId: "priya", action: "idle", reason: "Cannot overwrite a conversation." }],
    }, context)).toThrow("invalid");
  });

  it("offers only actually reachable tile centers and resolves choices into engine-valid intents", () => {
    const game = engine();
    const context = game.getDirectorContext();
    const plan = buildDirectorPlan(context);
    for (const actor of plan.snapshot.actors) {
      for (const id of actor.reachableDestinationIds) {
        const destination = plan.snapshot.destinations.find(destination => destination.id === id);
        expect(destination).toBeDefined();
        expect(canOccupy(context.floor, destination!.point)).toBe(true);
        expect(findPath(context.floor, actor.position, destination!.point).length).toBeGreaterThan(0);
      }
    }
    const providerReply = plan.schema.parse({
      source: "gemini", chatter: [],
      intents: plan.snapshot.actors.map(actor => ({
        npcId: actor.npcId, action: "walk_to",
        destinationId: actor.reachableDestinationIds.at(-1), reason: "Walk through the lobby.",
      })),
    });
    const reply = plan.complete(providerReply);
    expect(reply.intents.every(intent => intent.target && !("destinationId" in intent))).toBe(true);
    const previousEvents = game.state.events.length;
    game.applyDirector(reply);
    expect(game.state.events.slice(previousEvents).filter(event => event.kind === "system")).toEqual([]);
  });

  it("rejects unreachable or blocked targets even when their coordinates are in bounds", () => {
    const context = engine().getDirectorContext();
    expect(() => validateDirectorReply({
      source: "gemini", chatter: [],
      intents: [{ npcId: "priya", action: "walk_to", target: { x: 0.5, y: 0.5 }, reason: "Blocked wall." }],
    }, context)).toThrow("invalid");
  });

  it("uses immediate chatter only for already-near, visible, eligible pairs", () => {
    const game = engine();
    const farah = game.state.npcs.find(actor => actor.id === "staff-1-1")!;
    const suresh = game.state.npcs.find(actor => actor.id === "staff-1-2")!;
    farah.x = 14.5;
    farah.y = 21.5;
    suresh.x = 15.5;
    suresh.y = 21.5;
    const context = game.getDirectorContext();
    const plan = buildDirectorPlan(context);
    const pair = plan.snapshot.allowedChatterPairs.find(pair => pair.from === farah.id && pair.to === suresh.id);
    expect(pair).toBeDefined();
    const reply = plan.complete(plan.schema.parse({
      source: "gemini", intents: [], chatter: [{ pairId: pair!.id, text: "Tea after the meeting?" }],
    }));
    const previousEvents = game.state.events.length;
    game.applyDirector(reply);
    expect(game.state.events.slice(previousEvents).filter(event => event.kind === "system")).toEqual([]);
    expect(() => validateDirectorReply({
      source: "gemini", intents: [], chatter: [{ from: "priya", to: "staff-1-5", text: "Across the floor." }],
    }, context)).toThrow("invalid");
  });
});
