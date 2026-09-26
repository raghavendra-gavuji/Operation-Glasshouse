import { z } from "zod";
import type { DirectorReply, GameAction, GameState, TranscriptEntry } from "../../shared/types";
import type { EngineRuntime } from "./runtime";
import { COVER_FIELDS } from "./rules";

const finite = z.number().finite();
const time = finite.min(0).max(1e8);
const id = z.string().min(1).max(100);
const shortText = z.string().max(120);
const point = z.object({ x: finite.min(0).max(1000), y: finite.min(0).max(1000) }).strict();
const coverField = z.enum(COVER_FIELDS);
const intentKind = z.enum([
  "idle", "wander", "walk_to", "follow_player", "investigate",
  "block_path", "emerge_from", "chat_with", "return_post",
]);
const direction = z.enum(["north", "east", "south", "west"]);
const cover = z.object({
  name: shortText,
  company: shortText,
  role: shortText,
  host: shortText,
  callback: shortText,
  employeeId: shortText,
  ticket: shortText,
}).strict();

export const actionSchema: z.ZodType<GameAction> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("claim"), npcId: id, field: coverField, value: shortText.min(1),
    quote: z.string().min(1).max(4000).refine((value) => value.trim().length > 0),
  }).strict(),
  z.object({ type: z.literal("suspicion"), npcId: id, delta: finite, reason: z.string().trim().min(1).max(1000), evidence: z.string().max(4000).optional() }).strict(),
  z.object({ type: z.literal("register"), npcId: id, name: shortText.min(1) }).strict(),
  z.object({ type: z.literal("authorize"), npcId: id, name: shortText.min(1) }).strict(),
  z.object({ type: z.literal("issue_card"), npcId: id, name: shortText.min(1) }).strict(),
  z.object({ type: z.literal("discover"), npcId: id, factId: id }).strict(),
  z.object({ type: z.literal("end_conversation"), npcId: id, summary: z.string().max(3000) }).strict(),
  z.object({
    type: z.literal("security_resolution"),
    npcId: id,
    result: z.enum(["warning", "burned", "double_cross"]),
    reason: z.string().trim().min(1).max(1000),
  }).strict(),
]);

export const directorSchema: z.ZodType<DirectorReply> = z.object({
  intents: z.array(z.object({
    npcId: id,
    action: intentKind,
    target: point.optional(),
    targetNpcId: id.optional(),
    reason: z.string().trim().min(1).max(500),
    say: z.string().max(400).optional(),
  }).strict()).max(40),
  chatter: z.array(z.object({
    from: id,
    to: id,
    text: z.string().trim().min(1).max(400),
  }).strict()).max(20),
  source: z.literal("gemini"),
}).strict();

export const transcriptSchema: z.ZodType<TranscriptEntry> = z.object({
  id,
  npcId: id,
  speaker: z.enum(["player", "npc", "handler"]),
  text: z.string().max(8000),
  at: finite.min(0).max(Number.MAX_SAFE_INTEGER),
  final: z.boolean(),
}).strict();

const stateSchema: z.ZodType<GameState> = z.object({
  version: z.literal(1),
  seed: finite.int().min(0).max(0xffffffff),
  phase: z.enum(["briefing", "playing", "ended"]),
  paused: z.boolean(),
  elapsedSeconds: time,
  clockMinute: finite.min(540).max(1080),
  floor: finite.int().min(1).max(12),
  player: point.extend({ facing: direction, moving: z.boolean(), carryingCard: z.boolean() }).strict(),
  npcs: z.array(point.extend({
    id,
    floor: finite.int().min(0).max(12),
    suspicion: finite.min(0).max(100),
    intent: intentKind,
    intentReason: z.string().max(1000),
    memory: z.string().max(6000),
    bubble: z.string().max(8000).nullable(),
    bubbleUntil: time,
    facing: direction,
    lastEncounterAt: finite.min(-1e8).max(1e8),
    reported: z.boolean(),
  }).strict()).min(1).max(100),
  cover,
  ledger: z.array(z.object({
    id,
    field: coverField,
    value: shortText.min(1),
    npcId: id,
    quote: z.string().min(1).max(4000),
    at: time,
    contradiction: z.boolean(),
  }).strict()).max(2000),
  facts: z.array(z.object({
    id,
    title: z.string().max(300),
    text: z.string().max(3000),
    floor: finite.int().min(1).max(12).optional(),
    source: z.string().max(300),
  }).strict()).max(50),
  rumors: z.array(z.object({
    id, from: id, to: id, text: z.string().max(2000), at: time, delivered: z.boolean(),
  }).strict()).max(1000),
  events: z.array(z.object({
    id,
    at: time,
    kind: z.enum(["story", "suspicion", "gossip", "director", "system", "claim"]),
    text: z.string().max(8000),
    npcId: id.optional(),
  }).strict()).max(500),
  transcripts: z.array(transcriptSchema).max(800),
  visitorLog: shortText.min(1).nullable(),
  authorization: z.object({ name: shortText.min(1), by: z.enum(["dev", "anita"]), at: time }).strict().nullable(),
  activeNpcId: id.nullable(),
  meeraCalled: z.boolean(),
  meeraResolved: z.boolean(),
  secretKnown: z.boolean(),
  ending: z.enum(["clean", "flagged", "burned", "clock-out", "double-cross"]).nullable(),
  practiceMode: z.boolean(),
  settings: z.object({
    captions: z.boolean(),
    reducedMotion: z.boolean(),
    camera: z.boolean(),
    actingCues: z.boolean(),
    volume: finite.min(0).max(1),
  }).strict(),
}).strict();

const idList = z.array(id).max(2000);
const runtimeSchema: z.ZodType<EngineRuntime> = z.object({
  sequence: finite.int().min(0).max(Number.MAX_SAFE_INTEGER),
  randomState: finite.int().min(0).max(0xffffffff),
  actors: z.record(z.object({
    path: z.array(point).max(1000),
    target: point.nullable(),
    nextRoutineAt: time,
    modelUntil: time,
    nextFollowAt: time,
    peerId: id.nullable(),
  }).strict()),
  heardClaims: z.record(idList),
  heardIncidents: z.record(idList),
  completedConversations: z.record(finite.int().min(0).max(10000)),
  conversation: z.object({
    npcId: id,
    claimIds: idList,
    factIds: idList,
    playerTurnIds: idList,
    successfulActions: finite.int().min(0).max(10000),
    reductionUsed: z.boolean(),
    clockRunning: z.boolean(),
  }).strict().nullable(),
  graceUntil: time,
  approachId: id.nullable(),
  approachExpires: time,
  security: z.object({
    pendingAt: time.nullable(),
    remaining: finite.min(0).max(30),
    evidenceIds: idList,
    resolvedAt: time.nullable(),
    repeatDeadline: time.nullable(),
  }).strict(),
  rumorPayloads: z.record(z.object({ claimIds: idList, incidentIds: idList }).strict()),
  incidents: z.array(z.object({
    id,
    kind: z.enum(["contradiction", "trespass", "admission"]),
    npcId: id,
    at: time,
    claimIds: idList,
    roomId: id.nullable(),
    text: z.string().max(1000),
  }).strict()).max(2000),
  usedModelEvidence: z.array(z.string().max(300)).max(4000),
  lastRoomId: id.nullable(),
  nextTrespassAt: time,
  nextChatterAt: time,
}).strict();

export const saveSchema = z.object({
  format: z.literal("operation-glasshouse"),
  version: z.literal(1),
  state: stateSchema,
  runtime: runtimeSchema,
}).strict();
