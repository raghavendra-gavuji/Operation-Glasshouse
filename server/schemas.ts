import { z } from "zod/v4";
import type {
  ActionResult, AssetManifest, ClientLiveMessage, ConversationContext,
  DialogueReply, DirectorContext, DirectorReply, GameAction,
} from "../shared/types";
import { limits } from "./config";
import { ServiceError } from "./errors";

const id = z.string().min(1).max(96).regex(/^[a-zA-Z0-9_-]+$/);
const shortText = z.string().max(240);
const text = z.string().max(2000);
const timestamp = z.number().finite().nonnegative();
const floorId = z.number().int().min(1).max(12);
const coordinate = z.number().finite().min(0).max(512);
const point = z.strictObject({ x: coordinate, y: coordinate });
const direction = z.enum(["north", "east", "south", "west"]);
const intentKind = z.enum(["idle", "wander", "walk_to", "follow_player", "investigate", "block_path", "emerge_from", "chat_with", "return_post"]);
export const coverFieldSchema = z.enum(["name", "company", "role", "host", "callback", "employeeId", "ticket"]);
const cover = z.strictObject({
  name: shortText, company: shortText, role: shortText, host: shortText,
  callback: shortText, employeeId: shortText, ticket: shortText,
});
const npc = z.strictObject({
  id, name: shortText.min(1), role: shortText.min(1), floor: z.number().int().min(0).max(12), home: point,
  color: z.string().max(40), voiceName: z.string().min(1).max(64).regex(/^[a-zA-Z]+$/),
  personality: text, greeting: text, knowledge: z.array(z.string().max(2000)).max(40),
});
const claim = z.strictObject({
  id, field: coverFieldSchema, value: shortText, npcId: id,
  quote: z.string().max(1000), at: timestamp, contradiction: z.boolean(),
});
const fact = z.strictObject({
  id, title: shortText, text, floor: floorId.optional(), source: shortText,
});
const rumor = z.strictObject({
  id, from: id, to: id, text, at: timestamp, delivered: z.boolean(),
});
const authorization = z.strictObject({ name: shortText, by: shortText, at: timestamp }).nullable();

export const conversationContextSchema = z.strictObject({
  npc, suspicion: z.number().finite().min(0).max(100), memory: z.string().max(6000),
  cover, claims: z.array(claim).max(160), knownFacts: z.array(fact).max(80),
  heardRumors: z.array(rumor).max(100), visitorLog: shortText.nullable(), authorization,
  carryingCard: z.boolean(), secretKnown: z.boolean(), floor: floorId,
  clockMinute: z.number().finite().min(0).max(2880),
}) satisfies z.ZodType<ConversationContext>;

const npcState = z.strictObject({
  id, x: coordinate, y: coordinate, floor: floorId,
  suspicion: z.number().finite().min(0).max(100), intent: intentKind,
  intentReason: text, memory: z.string().max(6000), bubble: text.nullable(),
  bubbleUntil: timestamp, facing: direction, lastEncounterAt: z.number().finite(),
  reported: z.boolean(),
});
const floorPlan = z.strictObject({
  id: floorId, name: shortText, subtitle: text,
  width: z.number().int().min(1).max(96), height: z.number().int().min(1).max(96),
  tiles: z.array(z.enum(["floor", "wall", "door", "desk", "elevator", "exit", "plant", "carpet"])).max(9216),
  rooms: z.array(z.strictObject({
    id, name: shortText, x: coordinate, y: coordinate,
    width: coordinate, height: coordinate, restricted: z.boolean(), color: z.string().max(40),
  })).max(80),
  spawn: point, elevator: point, exit: point.optional(),
  palette: z.strictObject({ floor: z.string().max(40), wall: z.string().max(40), accent: z.string().max(40) }),
}).refine(value => value.tiles.length === value.width * value.height, { message: "Floor tile dimensions do not match." });

export const directorContextSchema = z.strictObject({
  activeNpcId: id.nullable().optional(),
  floor: floorPlan,
  player: point.extend({ facing: direction, moving: z.boolean(), carryingCard: z.boolean() }),
  npcs: z.array(z.strictObject({ definition: npc, state: npcState })).max(64),
  events: z.array(z.strictObject({
    id, at: timestamp, kind: z.enum(["story", "suspicion", "gossip", "director", "system", "claim"]),
    text, npcId: id.optional(),
  })).max(100),
  alert: z.boolean(),
}).refine(value => {
  const ids = value.npcs.map(entry => entry.definition.id);
  return new Set(ids).size === ids.length && value.npcs.every(entry => entry.definition.id === entry.state.id);
}, { message: "NPC identities must be unique and consistent." }) satisfies z.ZodType<DirectorContext>;

export const gameActionSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("claim"), npcId: id, field: coverFieldSchema, value: shortText.min(1), quote: z.string().min(1).max(1000) }),
  z.strictObject({ type: z.literal("suspicion"), npcId: id, delta: z.number().finite().min(-25).max(30), reason: text.min(1), evidence: text.optional() }),
  z.strictObject({ type: z.literal("register"), npcId: id, name: shortText.min(1) }),
  z.strictObject({ type: z.literal("authorize"), npcId: id, name: shortText.min(1) }),
  z.strictObject({ type: z.literal("issue_card"), npcId: id, name: shortText.min(1) }),
  z.strictObject({ type: z.literal("discover"), npcId: id, factId: id }),
  z.strictObject({ type: z.literal("end_conversation"), npcId: id, summary: text.min(1) }),
  z.strictObject({ type: z.literal("security_resolution"), npcId: id, result: z.enum(["warning", "burned", "double_cross"]), reason: text.min(1) }),
]) satisfies z.ZodType<GameAction>;

export const actionArgumentsSchema = z.strictObject({
  type: z.enum(["claim", "suspicion", "register", "authorize", "issue_card", "discover", "end_conversation", "security_resolution"]),
  field: coverFieldSchema.optional(), value: shortText.optional(), quote: z.string().max(1000).optional(),
  delta: z.number().finite().min(-25).max(30).optional(), reason: text.optional(), evidence: text.optional(),
  name: shortText.optional(), factId: id.optional(), summary: text.optional(),
  result: z.enum(["warning", "burned", "double_cross"]).optional(),
});
const statedIdentity = z.string().max(120);
export const identityClaimsSchema = z.strictObject({
  name: statedIdentity.describe("The visitor's explicitly stated invented name; empty if not stated."),
  company: statedIdentity.describe("The visitor's explicitly stated company; empty if not stated."),
  role: statedIdentity.describe("The explicitly stated job or work role, e.g. contractor. Capture it even when company and host are also stated. Empty only if not stated."),
  host: statedIdentity.describe("The person or office the visitor explicitly says they are visiting; empty if not stated."),
  callback: z.union([z.literal(""), z.string().regex(/^SIM-\d{4}$/)]).describe("An explicitly stated fictional SIM-#### callback, with spoken punctuation normalized, or empty. Never include a real phone number."),
  employeeId: statedIdentity.describe("An explicitly stated fictional employee prop; empty if not stated."),
  ticket: statedIdentity.describe("An explicitly stated fictional MT-... ticket, with spoken punctuation normalized; empty if not stated."),
  quote: z.string().trim().min(1).max(1000).describe("The actual visitor utterance supporting these fields. No invented dialogue or example text."),
});
export const actionResultSchema = z.strictObject({
  accepted: z.boolean(), message: z.string().min(1).max(2000),
}) satisfies z.ZodType<ActionResult>;

export const directorReplySchema = z.strictObject({
  intents: z.array(z.strictObject({
    npcId: id, action: intentKind, target: point.optional(), targetNpcId: id.optional(),
    reason: z.string().min(1).max(300), say: z.string().max(180).optional(),
  })).max(40),
  chatter: z.array(z.strictObject({ from: id, to: id, text: z.string().min(1).max(220) })).max(3),
  source: z.literal("gemini"),
}) satisfies z.ZodType<DirectorReply>;

export const dialogueReplySchema = z.strictObject({
  reply: z.string().min(1).max(1400), actions: z.array(gameActionSchema).max(8),
}) satisfies z.ZodType<DialogueReply>;
export const dialogueRequestSchema = z.strictObject({ context: conversationContextSchema, text: z.string().trim().min(1).max(2000) });
export const ttsRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(1200), voiceName: z.string().min(1).max(64).regex(/^[a-zA-Z]+$/),
});
export const prefetchRequestSchema = z.strictObject({ floors: z.array(floorId).min(1).max(12) });
export const assetManifestSchema = z.strictObject({
  version: z.literal(1), status: z.enum(["ready", "partial", "empty"]),
  assets: z.array(z.strictObject({
    id, url: z.string().min(1).max(500), kind: z.enum(["portrait", "sprite", "floor", "background", "texture"]),
    model: shortText, generatedAt: z.string().min(1).max(80),
  })).max(500),
}) satisfies z.ZodType<AssetManifest>;

const base64 = (bytes: number) => z.string().min(4).max(Math.ceil(bytes / 3) * 4)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const clientLiveMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("start"), context: conversationContextSchema }),
  z.strictObject({ type: z.literal("audio"), data: base64(limits.maxAudioBytes), sampleRate: z.literal(16000) }),
  z.strictObject({ type: z.literal("video"), data: base64(limits.maxVideoBytes) }),
  z.strictObject({ type: z.literal("text"), text: z.string().trim().min(1).max(2000) }),
  z.strictObject({ type: z.literal("context"), context: conversationContextSchema }),
  z.strictObject({ type: z.literal("tool_result"), requestId: z.string().min(1).max(128), result: actionResultSchema }),
  z.strictObject({ type: z.literal("stop") }),
]) satisfies z.ZodType<ClientLiveMessage>;

export function parseInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new ServiceError(400, "INVALID_REQUEST", "The request does not match the game API contract.");
  return parsed.data;
}

export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const result = z.toJSONSchema(schema, { target: "draft-7" });
  delete result.$schema;
  return result;
}

export function generationJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const structuralKeys = new Set(["type", "title", "description", "enum", "required", "additionalProperties", "$ref"]);
  function compact(value: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "const") result.enum = [child];
      else if (key === "properties" || key === "$defs") {
        if (!object(child)) throw new Error("Invalid generated schema definition.");
        result[key] = Object.fromEntries(Object.entries(child).map(([name, definition]) => {
          if (!object(definition)) throw new Error("Invalid generated schema property.");
          return [name, compact(definition)];
        }));
      } else if (key === "items" && object(child)) result.items = compact(child);
      else if ((key === "anyOf" || key === "oneOf") && Array.isArray(child)) {
        result[key] = child.map(definition => {
          if (!object(definition)) throw new Error("Invalid generated schema alternative.");
          return compact(definition);
        });
      } else if (structuralKeys.has(key)) result[key] = child;
    }
    return result;
  }
  // Gemini rejects the bounded, nested response grammar with INVALID_ARGUMENT.
  // Keep its structural contract compact; the full Zod schema still validates every reply.
  return compact(jsonSchema(schema));
}
