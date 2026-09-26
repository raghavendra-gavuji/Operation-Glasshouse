export type MainNpcId = "priya" | "ramesh" | "dev" | "anita" | "kulkarni" | "meera";
export type Direction = "north" | "east" | "south" | "west";
export type TileKind = "floor" | "wall" | "door" | "desk" | "elevator" | "exit" | "plant" | "carpet";
export interface Point { x: number; y: number }
export interface Room {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  restricted: boolean;
  color: string;
}
export interface FloorPlan {
  id: number;
  name: string;
  subtitle: string;
  width: number;
  height: number;
  tiles: TileKind[];
  rooms: Room[];
  spawn: Point;
  elevator: Point;
  exit?: Point;
  palette: { floor: string; wall: string; accent: string };
}
export interface NpcDefinition {
  id: string;
  name: string;
  role: string;
  floor: number;
  home: Point;
  color: string;
  voiceName: string;
  personality: string;
  greeting: string;
  knowledge: string[];
}
export type NpcIntentKind = "idle" | "wander" | "walk_to" | "follow_player" | "investigate" | "block_path" | "emerge_from" | "chat_with" | "return_post";
export interface NpcIntent {
  npcId: string;
  action: NpcIntentKind;
  target?: Point;
  targetNpcId?: string;
  reason: string;
  say?: string;
}
export interface NpcState extends Point {
  id: string;
  floor: number;
  suspicion: number;
  intent: NpcIntentKind;
  intentReason: string;
  memory: string;
  bubble: string | null;
  bubbleUntil: number;
  facing: Direction;
  lastEncounterAt: number;
  reported: boolean;
}
export interface CoverIdentity {
  name: string;
  company: string;
  role: string;
  host: string;
  callback: string;
  employeeId: string;
  ticket: string;
}
export interface Claim {
  id: string;
  field: keyof CoverIdentity;
  value: string;
  npcId: string;
  quote: string;
  at: number;
  contradiction: boolean;
}
export interface Rumor {
  id: string;
  from: string;
  to: string;
  text: string;
  at: number;
  delivered: boolean;
}
export interface JournalFact {
  id: string;
  title: string;
  text: string;
  floor?: number;
  source: string;
}
export interface TranscriptEntry {
  id: string;
  npcId: string;
  speaker: "player" | "npc" | "handler";
  text: string;
  at: number;
  final: boolean;
}
export interface GameEvent {
  id: string;
  at: number;
  kind: "story" | "suspicion" | "gossip" | "director" | "system" | "claim";
  text: string;
  npcId?: string;
}
export type Ending = "clean" | "flagged" | "burned" | "clock-out" | "double-cross";
export interface GameState {
  version: 1;
  seed: number;
  phase: "briefing" | "playing" | "ended";
  paused: boolean;
  elapsedSeconds: number;
  clockMinute: number;
  floor: number;
  player: Point & { facing: Direction; moving: boolean; carryingCard: boolean };
  npcs: NpcState[];
  cover: CoverIdentity;
  ledger: Claim[];
  facts: JournalFact[];
  rumors: Rumor[];
  events: GameEvent[];
  transcripts: TranscriptEntry[];
  visitorLog: string | null;
  authorization: { name: string; by: string; at: number } | null;
  activeNpcId: string | null;
  meeraCalled: boolean;
  meeraResolved: boolean;
  secretKnown: boolean;
  ending: Ending | null;
  practiceMode: boolean;
  settings: { captions: boolean; reducedMotion: boolean; camera: boolean; actingCues: boolean; volume: number };
}
export type GameAction =
  | { type: "claim"; npcId: string; field: keyof CoverIdentity; value: string; quote: string }
  | { type: "suspicion"; npcId: string; delta: number; reason: string; evidence?: string }
  | { type: "register"; npcId: string; name: string }
  | { type: "authorize"; npcId: string; name: string }
  | { type: "issue_card"; npcId: string; name: string }
  | { type: "discover"; npcId: string; factId: string }
  | { type: "end_conversation"; npcId: string; summary: string }
  | { type: "security_resolution"; npcId: string; result: "warning" | "burned" | "double_cross"; reason: string };
export interface ActionResult { accepted: boolean; message: string }
export interface ConversationContext {
  npc: NpcDefinition;
  suspicion: number;
  memory: string;
  cover: CoverIdentity;
  claims: Claim[];
  knownFacts: JournalFact[];
  heardRumors: Rumor[];
  visitorLog: string | null;
  authorization: GameState["authorization"];
  carryingCard: boolean;
  secretKnown: boolean;
  floor: number;
  clockMinute: number;
}
export interface DirectorContext {
  floor: FloorPlan;
  player: GameState["player"];
  activeNpcId?: string | null;
  npcs: { definition: NpcDefinition; state: NpcState }[];
  events: GameEvent[];
  alert: boolean;
}
export interface DirectorReply {
  intents: NpcIntent[];
  chatter: { from: string; to: string; text: string }[];
  source: "gemini";
}
export interface DialogueReply { reply: string; actions: GameAction[] }
export type VoiceStatus = "idle" | "connecting" | "listening" | "speaking" | "error";
export type ClientLiveMessage =
  | { type: "start"; context: ConversationContext }
  | { type: "audio"; data: string; sampleRate: number }
  | { type: "video"; data: string }
  | { type: "text"; text: string }
  | { type: "context"; context: ConversationContext }
  | { type: "tool_result"; requestId: string; result: ActionResult }
  | { type: "stop" };
export type ServerLiveMessage =
  | { type: "ready" }
  | { type: "audio"; data: string; sampleRate: number }
  | { type: "transcript"; speaker: "player" | "npc"; text: string; final: boolean }
  | { type: "action"; requestId: string; action: GameAction }
  | { type: "interrupted" }
  | { type: "turn_complete" }
  | { type: "error"; message: string; recoverable: boolean }
  | { type: "closed"; reason: string };
export interface AssetRecord {
  id: string;
  url: string;
  kind: "portrait" | "sprite" | "floor" | "background" | "texture";
  model: string;
  generatedAt: string;
}
export interface AssetManifest {
  version: 1;
  assets: AssetRecord[];
  status: "ready" | "partial" | "empty";
}
