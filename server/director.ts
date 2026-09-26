import { z } from "zod/v4";
import type { DirectorContext, DirectorReply, NpcIntent, Point } from "../shared/types";
import { canOccupy, distance, findPath, hasLineOfSight } from "../src/game/navigation";
import { invalidResponse, ServiceError } from "./errors";

interface Destination {
  id: string;
  label: string;
  point: Point;
}
interface ChatterPair { id: string; from: string; to: string }

export function eligibleDirectorNpcs(context: DirectorContext): DirectorContext["npcs"] {
  return context.npcs.filter(({ state }) => state.floor === context.floor.id
    && state.id !== context.activeNpcId && state.intentReason !== "In conversation with the visitor.");
}

function speakingPositionExists(context: DirectorContext, from: Point, to: Point): boolean {
  const center = { x: Math.floor(to.x) + 0.5, y: Math.floor(to.y) + 0.5 };
  return [[-1, 0], [1, 0], [0, -1], [0, 1]].some(([dx, dy]) => {
    const point = { x: center.x + dx, y: center.y + dy };
    return canOccupy(context.floor, point) && findPath(context.floor, from, point).length > 0;
  });
}

export function validateDirectorReply(reply: DirectorReply, context: DirectorContext): DirectorReply {
  const actors = new Map(eligibleDirectorNpcs(context).map(npc => [npc.definition.id, npc]));
  const seen = new Set<string>();
  for (const intent of reply.intents) {
    const actor = actors.get(intent.npcId);
    if (!actor || seen.has(intent.npcId)) throw invalidResponse();
    seen.add(intent.npcId);
    if (intent.target && (!canOccupy(context.floor, intent.target) || !findPath(context.floor, actor.state, intent.target).length)) throw invalidResponse();
    const peer = intent.targetNpcId ? actors.get(intent.targetNpcId) : undefined;
    if (intent.targetNpcId && (!peer || intent.targetNpcId === intent.npcId)) throw invalidResponse();
    if (intent.action === "chat_with" && (!peer || !speakingPositionExists(context, actor.state, peer.state))) throw invalidResponse();
    if (["walk_to", "emerge_from", "investigate", "block_path"].includes(intent.action) && !intent.target) throw invalidResponse();
    const destination = intent.action === "follow_player" ? context.player
      : intent.action === "return_post" ? actor.definition.home : undefined;
    if (destination && (!canOccupy(context.floor, destination) || !findPath(context.floor, actor.state, destination).length)) throw invalidResponse();
  }
  for (const item of reply.chatter) {
    const from = actors.get(item.from);
    const to = actors.get(item.to);
    if (!from || !to || from === to || distance(from.state, to.state) > 5
      || !hasLineOfSight(context.floor, from.state, to.state)) throw invalidResponse();
  }
  return reply;
}

export function buildDirectorPlan(context: DirectorContext) {
  const actors = eligibleDirectorNpcs(context);
  if (!actors.length) throw new ServiceError(400, "DIRECTOR_NO_ACTORS", "There are no available actors to direct on this floor.");
  const ids = actors.map(actor => actor.definition.id);
  const destinations: Destination[] = [];
  const addDestination = (id: string, label: string, point: Point) => {
    if (canOccupy(context.floor, point) && destinations.length < 48) destinations.push({ id, label, point });
  };
  for (const actor of actors) {
    addDestination(`post-${actor.definition.id}`, `${actor.definition.name}'s assigned post`, actor.definition.home);
  }
  for (const room of context.floor.rooms) {
    const center = { x: room.x + room.width / 2, y: room.y + room.height / 2 };
    let nearest: Point | undefined;
    for (let y = Math.max(0, Math.floor(room.y)); y < Math.min(context.floor.height, room.y + room.height); y++) {
      for (let x = Math.max(0, Math.floor(room.x)); x < Math.min(context.floor.width, room.x + room.width); x++) {
        const point = { x: x + 0.5, y: y + 0.5 };
        if (canOccupy(context.floor, point) && (!nearest || distance(point, center) < distance(nearest, center))) nearest = point;
      }
    }
    if (nearest) addDestination(`room-${room.id}`, room.name, nearest);
  }
  addDestination("elevator", "Elevator lobby", context.floor.elevator);
  if (context.floor.exit) addDestination("exit", "Public exit", context.floor.exit);
  if (!destinations.length) throw new ServiceError(400, "DIRECTOR_NO_DESTINATIONS", "The supplied floor has no usable actor destinations.");
  const destinationById = new Map(destinations.map(destination => [destination.id, destination]));
  const pairs: ChatterPair[] = [];
  for (const from of actors) for (const to of actors) {
    if (from === to || distance(from.state, to.state) > 3 || !hasLineOfSight(context.floor, from.state, to.state)) continue;
    pairs.push({ id: `pair-${pairs.length + 1}`, from: from.definition.id, to: to.definition.id });
  }
  const pairById = new Map(pairs.map(pair => [pair.id, pair]));
  const base = {
    npcId: z.enum(ids),
    reason: z.string().trim().min(1).max(300),
    say: z.string().max(180).optional(),
  };
  const intent = z.discriminatedUnion("action", [
    z.strictObject({ ...base, action: z.enum(["idle", "wander", "return_post", "follow_player"]) }),
    z.strictObject({
      ...base, action: z.enum(["walk_to", "investigate", "block_path", "emerge_from"]),
      destinationId: z.enum(destinations.map(destination => destination.id)),
    }),
    z.strictObject({ ...base, action: z.literal("chat_with"), targetNpcId: z.enum(ids) }),
  ]);
  const schema = z.strictObject({
    intents: z.array(intent).max(Math.min(40, actors.length)),
    chatter: z.array(z.strictObject({
      pairId: z.enum(pairs.length ? pairs.map(pair => pair.id) : ["no-pairs-available"]),
      text: z.string().trim().min(1).max(180),
    })).max(pairs.length ? 3 : 0),
    source: z.literal("gemini"),
  });
  type Plan = z.infer<typeof schema>;
  return {
    schema,
    snapshot: {
      floor: { id: context.floor.id, name: context.floor.name },
      activeNpcId: context.activeNpcId ?? null,
      player: context.player,
      alert: context.alert,
      destinations,
      allowedChatterPairs: pairs,
      actors: actors.map(({ definition, state }) => ({
        npcId: definition.id, displayName: definition.name, role: definition.role,
        position: { x: state.x, y: state.y }, suspicion: state.suspicion, currentIntent: state.intent,
        reachableDestinationIds: destinations.filter(destination => findPath(context.floor, state, destination.point).length).map(destination => destination.id),
        mayFollowPlayer: canOccupy(context.floor, context.player) && findPath(context.floor, state, context.player).length > 0,
        mayChatWith: actors.filter(peer => peer.state.id !== state.id && speakingPositionExists(context, state, peer.state)).map(peer => peer.state.id),
      })),
    },
    complete(plan: Plan): DirectorReply {
      const intents: NpcIntent[] = plan.intents.map(intent => {
        if ("destinationId" in intent) {
          const destination = destinationById.get(intent.destinationId);
          if (!destination) throw invalidResponse();
          return { npcId: intent.npcId, action: intent.action, reason: intent.reason, say: intent.say, target: { ...destination.point } };
        }
        return intent;
      });
      const chatter = plan.chatter.map(item => {
        const pair = pairById.get(item.pairId);
        if (!pair) throw invalidResponse();
        return { from: pair.from, to: pair.to, text: item.text };
      });
      return validateDirectorReply({ intents, chatter, source: plan.source }, context);
    },
  };
}
