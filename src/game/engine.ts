import { FACTS, NPCS } from "../../shared/story";
import type {
  ActionResult, Claim, ConversationContext, CoverIdentity, Direction, DirectorContext,
  DirectorReply, Ending, FloorPlan, GameAction, GameEvent, GameState, NpcDefinition,
  NpcIntent, NpcState, Point, TranscriptEntry,
} from "../../shared/types";
import { canOccupy, distance, findPath, hasLineOfSight, isWalkable, roomAt } from "./navigation";
import { SeededRandom } from "./random";
import {
  canReadAuthorization, canReadVisitorLog, CONVERSATION_DISTANCE, COVER_FIELDS,
  ELEVATOR_DISTANCE, emptyCover, EXIT_DISTANCE, GAME_DAY_SECONDS, GAME_END_MINUTE,
  GAME_START_MINUTE, GOSSIP_EDGES, isFictionalCallback, isFictionalEmployeeId,
  isFictionalTicket, MAX_TICK_SECONDS, normalizeAlias, readableValue, RUN_SPEED,
  SECURITY_RESPONSE_SECONDS, SUSPICION_THRESHOLDS, WALK_SPEED,
} from "./rules";
import type { ActorRuntime, EngineRuntime, Incident, RumorPayload } from "./runtime";
import { actionSchema, directorSchema, saveSchema, transcriptSchema } from "./validation";
import { createFloors } from "./world";

export {
  CONVERSATION_DISTANCE, ELEVATOR_DISTANCE, EXIT_DISTANCE, GAME_DAY_SECONDS,
  GAME_END_MINUTE, GAME_START_MINUTE, normalizeAlias, SECURITY_RESPONSE_SECONDS,
  SUSPICION_THRESHOLDS,
} from "./rules";

const MAIN_POSTS = new Set(["priya", "ramesh", "dev", "anita", "kulkarni"]);
const CORE_FACTS = ["access_rules", "cfo_away", "server_room"];
const AUTO_ENCOUNTER_COOLDOWN = 45;
const AUTO_ENCOUNTER_RADIUS = 4.2;
const LOCAL_ROUTINE = "Initial routine (local fallback; awaiting Gemini).";
const LOCAL_CHATTER = [
  "The printer queue is longer than the tea queue today.",
  "I'll be back at my desk after the next meeting.",
  "Please keep the corridor clear for the delivery trolley.",
  "The boardroom booking moved again. Check the noticeboard.",
  "There's fresh tea in the pantry, if you get a minute.",
];

function sameValue(a: string, b: string): boolean {
  return normalizeAlias(a) === normalizeAlias(b);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function lastClaim(claims: readonly Claim[], field: keyof CoverIdentity): Claim | undefined {
  for (let index = claims.length - 1; index >= 0; index -= 1) {
    if (claims[index].field === field) return claims[index];
  }
  return undefined;
}

function recentWithinBudget<T>(entries: readonly T[], limit: number, byteBudget: number): T[] {
  const result: T[] = [];
  const encoder = new TextEncoder();
  let bytes = 0;
  for (let index = entries.length - 1; index >= 0 && result.length < limit; index -= 1) {
    const size = encoder.encode(JSON.stringify(entries[index])).length;
    if (bytes + size > byteBudget) break;
    bytes += size;
    result.push(entries[index]);
  }
  return result.reverse();
}

export class GameEngine {
  state: GameState;
  floors: FloorPlan[];
  definitions: NpcDefinition[];
  onEvent?: (event: GameEvent) => void;
  onEncounter?: (npcId: string) => void;
  onFloorChange?: (floor: number) => void;
  onEnding?: (ending: Ending) => void;

  private runtime: EngineRuntime;
  private random: SeededRandom;

  constructor(seed = 0x474c4153) {
    if (!Number.isFinite(seed)) throw new RangeError("The game seed must be a finite number.");
    const normalizedSeed = Math.trunc(seed) >>> 0;
    this.definitions = structuredClone(NPCS);
    this.floors = createFloors(normalizedSeed);
    this.random = new SeededRandom(normalizedSeed);
    this.state = this.initialState(normalizedSeed);
    this.runtime = this.initialRuntime();
  }

  get canUseElevator(): boolean {
    return this.state.phase === "playing" && this.state.activeNpcId === null
      && distance(this.state.player, this.currentFloor.elevator) <= ELEVATOR_DISTANCE
      && hasLineOfSight(this.currentFloor, this.state.player, this.currentFloor.elevator);
  }

  get canExit(): boolean {
    const exit = this.currentFloor.exit;
    return this.state.phase === "playing" && this.state.activeNpcId === null
      && this.state.floor === 1 && exit !== undefined
      && distance(this.state.player, exit) <= EXIT_DISTANCE
      && hasLineOfSight(this.currentFloor, this.state.player, exit);
  }

  get securitySecondsRemaining(): number | null {
    return this.state.phase === "playing" && this.state.activeNpcId === "meera"
      && !this.state.meeraResolved ? this.runtime.security.remaining : null;
  }

  get conversationClockRunning(): boolean {
    return this.runtime.conversation?.clockRunning === true && !this.state.paused;
  }

  start(practiceMode = false): void {
    if (this.state.phase === "playing") return;
    if (this.state.phase === "ended") {
      const seed = this.state.seed;
      const settings = { ...this.state.settings };
      this.floors = createFloors(seed);
      this.random = new SeededRandom(seed);
      this.state = this.initialState(seed);
      this.state.settings = settings;
      this.runtime = this.initialRuntime();
    }
    this.state.phase = "playing";
    this.state.paused = false;
    this.state.practiceMode = practiceMode;
    this.runtime.graceUntil = this.state.elapsedSeconds + 5;
    this.emit("story", "09:00. Establish an invented cover at reception on floor 1. Collection is on floor 2.");
    this.emit("system", practiceMode
      ? "Practice mode: dialogue is local practice, not a Gemini response."
      : "Mission active. Movement and fallback routines do not wait for the director.");
    this.onFloorChange?.(this.state.floor);
  }

  setPracticeMode(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new TypeError("Practice mode must be a boolean.");
    if (this.state.phase === "ended") {
      this.reject("A finished mission keeps its dialogue-mode label. Choose the mode when starting a new run.");
      return;
    }
    if (this.state.practiceMode === enabled) return;
    this.state.practiceMode = enabled;
    this.setConversationClockRunning(false);
    this.emit("system", enabled
      ? "Practice mode enabled explicitly. Mission progress and the active conversation are retained; dialogue is not a Gemini response."
      : "Live dialogue mode selected. Await the provider connection before enabling answer time; mission progress is retained.");
  }

  enablePracticeMode(): void {
    this.setPracticeMode(true);
  }

  setPaused(paused: boolean): void {
    if (typeof paused !== "boolean") throw new TypeError("Pause state must be a boolean.");
    this.state.paused = paused;
    if (paused) this.state.player.moving = false;
  }

  setConversationClockRunning(running: boolean): void {
    if (typeof running !== "boolean") throw new TypeError("Conversation clock state must be a boolean.");
    if (this.runtime.conversation) this.runtime.conversation.clockRunning = running;
  }

  setConversationWaiting(waiting: boolean): void {
    if (typeof waiting !== "boolean") throw new TypeError("Conversation waiting state must be a boolean.");
    this.setConversationClockRunning(!waiting);
  }

  tick(dtSeconds: number, input: { x: number; y: number; running?: boolean }): void {
    if (this.state.phase !== "playing" || this.state.paused) {
      this.state.player.moving = false;
      return;
    }
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0
      || !input || !Number.isFinite(input.x) || !Number.isFinite(input.y)) {
      this.emit("system", "Simulation input rejected: time and movement must be finite, with nonnegative time.");
      return;
    }
    let remaining = Math.min(dtSeconds, MAX_TICK_SECONDS);
    while (remaining > 1e-9 && this.state.phase === "playing" && !this.state.paused) {
      const step = Math.min(remaining, 0.04);
      remaining -= step;
      this.state.elapsedSeconds = Math.min(GAME_DAY_SECONDS, this.state.elapsedSeconds + step);
      this.state.clockMinute = Math.min(
        GAME_END_MINUTE,
        GAME_START_MINUTE + this.state.elapsedSeconds * (GAME_END_MINUTE - GAME_START_MINUTE) / GAME_DAY_SECONDS,
      );
      if (this.state.clockMinute >= GAME_END_MINUTE) {
        this.finish("clock-out", "18:00. The visitor day has closed before you made it out.");
        break;
      }
      this.deliverRumors();
      this.advanceSecurity(step);
      if (this.state.phase !== "playing") break;
      this.movePlayer(step, input);
      this.moveActors(step);
      this.observeRestrictedRoom();
      this.observeServerDoor();
      this.considerEncounter();
      this.localChatter();
    }
    this.runtime.randomState = this.random.state;
  }

  applyAction(action: GameAction): ActionResult {
    const parsed = actionSchema.safeParse(action);
    if (!parsed.success) return this.reject("Invalid dialogue action shape. No game rule was changed.");
    const proposal = parsed.data;
    if (this.state.phase !== "playing" || this.state.activeNpcId !== proposal.npcId) {
      return this.reject("Dialogue actions require the currently active NPC conversation.");
    }
    const npc = this.npc(proposal.npcId);
    if (!npc || this.runtime.conversation?.npcId !== npc.id) {
      return this.reject("The active conversation no longer exists.");
    }
    switch (proposal.type) {
      case "claim":
        return this.recordClaim(proposal);
      case "suspicion":
        return this.proposeSuspicion(proposal, npc);
      case "register":
        return this.registerVisitor(proposal.name, npc);
      case "authorize":
        return this.authorizeVisitor(proposal.name, npc);
      case "issue_card":
        return this.issueCard(proposal.name, npc);
      case "discover":
        return this.discover(proposal.factId, npc);
      case "end_conversation":
        this.endConversation(proposal.summary);
        return { accepted: true, message: "Conversation recorded. You can walk away; later tools from this call are closed." };
      case "security_resolution":
        if (npc.id !== "meera") return this.reject("Only Meera can resolve an active security call.", npc.id);
        if (proposal.result === "double_cross") {
          return this.reject("An outgoing Handler report requires the player's explicit call at the exit.", npc.id);
        }
        return this.resolveSecurity();
    }
  }

  applyDirector(reply: DirectorReply): void {
    const parsed = directorSchema.safeParse(reply);
    if (!parsed.success) {
      this.emit("system", "Director reply rejected: invalid shape or non-Gemini source. Local routines continue.");
      return;
    }
    if (this.state.phase !== "playing") return;
    for (const intent of parsed.data.intents) this.applyIntent(intent);
    for (const chatter of parsed.data.chatter) {
      const from = this.npc(chatter.from);
      const to = this.npc(chatter.to);
      if (!from || !to || from.id === to.id || from.floor !== this.state.floor || to.floor !== this.state.floor
        || from.id === this.state.activeNpcId || to.id === this.state.activeNpcId
        || distance(from, to) > 5 || !hasLineOfSight(this.currentFloor, from, to)) {
        this.emit("system", "Director chatter rejected: speakers must be nearby, visible, local, and out of conversation.");
        continue;
      }
      this.say(from, chatter.text);
      this.appendMemory(from, `Public corridor conversation with ${this.definition(to.id).name}: ${chatter.text}`);
      this.appendMemory(to, `Heard ${this.definition(from.id).name} nearby: ${chatter.text}`);
      this.emit("director", `${this.definition(from.id).name} to ${this.definition(to.id).name}: ${chatter.text}`, from.id);
    }
  }

  getDirectorContext(): DirectorContext {
    return {
      floor: structuredClone(this.currentFloor),
      player: { ...this.state.player },
      npcs: this.state.npcs.filter((npc) => npc.floor === this.state.floor).map((npc) => ({
        definition: {
          ...structuredClone(this.definition(npc.id)),
          knowledge: [],
          personality: `${this.definition(npc.id).role}. Direct movement and ordinary public office behavior, not mission outcomes.`,
        },
        state: {
          ...npc,
          memory: `Current public routine: ${npc.intentReason}`,
          bubble: null,
        },
      })),
      events: this.state.events.filter((event) =>
        (event.kind === "director" || event.kind === "suspicion")
        && (!event.npcId || this.npc(event.npcId)?.floor === this.state.floor),
      ).slice(-40).map((event) => ({ ...event })),
      alert: this.securityAlert,
    };
  }

  getDebugPaths(): Record<string, Point[]> {
    return Object.fromEntries(this.state.npcs.filter((npc) => npc.floor === this.state.floor)
      .map((npc) => [npc.id, this.runtime.actors[npc.id].path.map((point) => ({ ...point }))]));
  }

  getConversationContext(npcId: string): ConversationContext {
    const definition = this.definition(npcId);
    const npc = this.npc(npcId);
    if (!npc) throw new RangeError(`Unknown NPC: ${npcId}`);
    const knowledge = this.availableKnowledge(npcId);
    const privateClaims = this.visibleClaims(npcId);
    const personality = npcId === "kulkarni" && !knowledge.includes("handler_secret")
      ? "A friendly facilities veteran. Explain the visitor procedure, the CFO's itinerary, and the blue door. Deeper recollections require a meaningful return visit or mission progress."
      : definition.personality;
    return {
      npc: { ...structuredClone(definition), personality, knowledge: [...knowledge] },
      suspicion: npc.suspicion,
      memory: npc.memory,
      cover: this.privateCover(npcId),
      claims: recentWithinBudget(privateClaims, 160, 48_000).map((claim) => ({ ...claim })),
      knownFacts: this.state.facts.filter((fact) => knowledge.includes(fact.id)).map((fact) => ({ ...fact })),
      heardRumors: recentWithinBudget(
        this.state.rumors.filter((rumor) => rumor.delivered && rumor.to === npcId), 100, 32_000,
      ).map((rumor) => ({ ...rumor })),
      visitorLog: canReadVisitorLog(npcId) ? this.state.visitorLog : null,
      authorization: canReadAuthorization(npcId) && this.state.authorization ? { ...this.state.authorization } : null,
      carryingCard: this.state.player.carryingCard,
      secretKnown: this.state.secretKnown && knowledge.includes("handler_secret"),
      floor: this.state.floor,
      clockMinute: this.state.clockMinute,
    };
  }

  beginConversation(npcId: string): boolean {
    if (this.state.phase !== "playing" || this.state.activeNpcId !== null) {
      this.reject("Start or resume the mission and finish the existing conversation before opening another.");
      return false;
    }
    const npc = this.npc(npcId);
    if (!npc) {
      this.reject("Cannot start a conversation with an unknown NPC.");
      return false;
    }
    if (npcId === "meera") {
      if (this.state.meeraResolved || this.state.meeraCalled || this.runtime.security.pendingAt === null
        || this.state.elapsedSeconds < this.runtime.security.pendingAt) {
        this.reject("Meera calls after a security escalation. An outgoing Handler report is available at the exit.");
        return false;
      }
      this.state.meeraCalled = true;
      this.runtime.security.pendingAt = null;
      this.runtime.security.remaining = SECURITY_RESPONSE_SECONDS;
    } else if (npc.floor !== this.state.floor || distance(npc, this.state.player) > CONVERSATION_DISTANCE
      || !hasLineOfSight(this.currentFloor, npc, this.state.player)) {
      this.reject("Move into speaking distance on the same floor, with a clear line of sight.", npc.id);
      return false;
    }
    this.runtime.approachId = null;
    this.state.activeNpcId = npcId;
    this.state.player.moving = false;
    this.runtime.conversation = {
      npcId, claimIds: [], factIds: [], playerTurnIds: [], successfulActions: 0,
      reductionUsed: false, clockRunning: false,
    };
    const actor = this.runtime.actors[npcId];
    actor.path = [];
    actor.target = null;
    npc.intent = "idle";
    npc.intentReason = "In conversation with the visitor.";
    if (npc.floor > 0) npc.facing = this.facingToward(npc, this.state.player);
    this.say(npc, this.definition(npcId).greeting);
    this.emit("story", npcId === "meera"
      ? "Meera is calling. Thirty seconds of answer time; connecting, playback, and pause do not consume it."
      : `${this.definition(npcId).name} stopped to speak. You may explicitly end the conversation and walk away.`, npcId);
    this.onEncounter?.(npcId);
    return true;
  }

  endConversation(summary = ""): void {
    const activeId = this.state.activeNpcId;
    if (!activeId) return;
    if (activeId === "meera" && !this.state.meeraResolved && this.state.phase === "playing") {
      this.resolveSecurity();
      return;
    }
    this.closeConversation(summary);
  }

  changeFloor(floor: number): boolean {
    if (!Number.isInteger(floor) || floor < 1 || floor > this.floors.length) {
      this.reject("Choose an existing floor from 1 to 12.");
      return false;
    }
    if (!this.canUseElevator) {
      this.reject("Use the elevator from its marked core after leaving the conversation.");
      return false;
    }
    if (floor === this.state.floor) return true;
    this.cancelApproach();
    this.state.floor = floor;
    this.state.player.x = this.currentFloor.spawn.x;
    this.state.player.y = this.currentFloor.spawn.y;
    this.state.player.facing = "north";
    this.state.player.moving = false;
    this.runtime.graceUntil = this.state.elapsedSeconds + 5;
    this.runtime.lastRoomId = null;
    this.emit("system", `Elevator: floor ${floor}, ${this.currentFloor.name}.`);
    this.onFloorChange?.(floor);
    return true;
  }

  exitBuilding(): void {
    if (!this.canExit) {
      this.reject("Leave the conversation and reach the floor-1 exit threshold first.");
      return;
    }
    if (!this.state.player.carryingCard) {
      this.finish("clock-out", "You left Meridian Tower without a keycard. The assignment is abandoned.");
      return;
    }
    const flagged = this.state.meeraCalled || this.runtime.incidents.length > 0
      || this.state.npcs.some((npc) => npc.reported || npc.suspicion >= SUSPICION_THRESHOLDS.verify);
    this.finish(flagged ? "flagged" : "clean", flagged
      ? "You left with the keycard, but a documented concern remains in the tower's records."
      : "You left with the keycard under one consistent cover. No report followed you out.");
  }

  callMeeraForDoubleCross(): ActionResult {
    if (!this.canExit) return this.reject("Make the outgoing in-game report at the floor-1 exit threshold.");
    if (!this.state.secretKnown || !this.hasFact("handler_secret")) {
      return this.reject("A report about the Handler needs Kulkarni's actual evidence, not a hunch.");
    }
    this.appendMemory(this.requiredNpc("meera"), "At the exit, the visitor voluntarily reported Kulkarni's first-hand Handler evidence.");
    this.finish("double-cross", "At the exit you report the Handler's deception to Meera through the in-game call. The card is no longer the mission.");
    return { accepted: true, message: "Handler evidence delivered to Meera. Double-cross ending reached; no real phone call was made." };
  }

  addTranscript(entry: TranscriptEntry): void {
    const parsed = transcriptSchema.safeParse(entry);
    if (!parsed.success) {
      this.emit("system", "Transcript rejected: invalid transcript shape.");
      return;
    }
    const transcript = parsed.data;
    if ((transcript.speaker === "handler") !== (transcript.npcId === "handler")) {
      this.emit("system", "Transcript rejected: the Handler speaker and identity must agree.");
      return;
    }
    const npc = this.npc(transcript.npcId);
    const handler = transcript.speaker === "handler" && transcript.npcId === "handler";
    const farewell = transcript.speaker === "npc" && npc
      && this.state.elapsedSeconds - npc.lastEncounterAt <= 8;
    if (!handler && (!npc || (this.state.activeNpcId !== npc.id && !farewell))) {
      this.emit("system", "Transcript rejected: speaker is not part of this conversation.");
      return;
    }
    const previous = this.state.transcripts.find((line) => line.id === transcript.id);
    if (previous && (previous.npcId !== transcript.npcId || previous.speaker !== transcript.speaker
      || (previous.final && (!transcript.final || previous.text !== transcript.text)))) {
      this.emit("system", "Transcript rejected: a finalized line or its speaker cannot be rewritten.");
      return;
    }
    const line = { ...transcript, at: previous?.at ?? this.state.elapsedSeconds };
    if (previous) Object.assign(previous, line);
    else this.state.transcripts.push(line);
    if (this.state.transcripts.length > 800) {
      const removed = this.state.transcripts.shift();
      if (removed && this.runtime.conversation) {
        this.runtime.conversation.playerTurnIds = this.runtime.conversation.playerTurnIds.filter((id) => id !== removed.id);
      }
    }
    if (line.final && line.speaker === "player" && line.text.trim().length >= 12
      && this.runtime.conversation?.npcId === line.npcId) {
      this.runtime.conversation.playerTurnIds = unique([...this.runtime.conversation.playerTurnIds, line.id]);
    }
    if (line.speaker === "npc" && npc && line.text.trim()) this.say(npc, line.text);
  }

  serialize(): string {
    this.runtime.randomState = this.random.state;
    return JSON.stringify({ format: "operation-glasshouse", version: 1, state: this.state, runtime: this.runtime });
  }

  restore(serialized: string): boolean {
    if (typeof serialized !== "string" || serialized.length > 4_000_000) {
      this.emit("system", "Save rejected: input must be a game save smaller than four megabytes.");
      return false;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(serialized);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      this.emit("system", "Save rejected: malformed JSON. The current game was not replaced.");
      return false;
    }
    const parsed = saveSchema.safeParse(decoded);
    if (!parsed.success) {
      this.emit("system", "Save rejected: unsupported version or corrupted data shape. The current game was not replaced.");
      return false;
    }
    const floors = createFloors(parsed.data.state.seed);
    const problem = this.saveProblem(parsed.data.state, parsed.data.runtime, floors);
    if (problem) {
      this.emit("system", `Save rejected: ${problem} The current game was not replaced.`);
      return false;
    }
    this.state = parsed.data.state;
    this.runtime = parsed.data.runtime;
    this.floors = floors;
    this.random = new SeededRandom(this.runtime.randomState);
    this.state.player.moving = false;
    if (this.state.phase === "playing") this.state.paused = true;
    if (this.runtime.conversation) this.runtime.conversation.clockRunning = false;
    this.emit("system", "Saved game restored. Resume explicitly; conversation answer time waits for input readiness.");
    this.onFloorChange?.(this.state.floor);
    return true;
  }

  private get currentFloor(): FloorPlan {
    return this.floors[this.state.floor - 1];
  }

  private get securityAlert(): boolean {
    return this.runtime.security.pendingAt !== null || (this.state.meeraCalled && !this.state.meeraResolved)
      || this.runtime.security.repeatDeadline !== null;
  }

  private initialState(seed: number): GameState {
    return {
      version: 1, seed, phase: "briefing", paused: false, elapsedSeconds: 0,
      clockMinute: GAME_START_MINUTE, floor: 1,
      player: { ...this.floors[0].spawn, facing: "north", moving: false, carryingCard: false },
      npcs: this.definitions.map((definition) => ({
        id: definition.id, floor: definition.floor, ...definition.home, suspicion: 0,
        intent: "idle", intentReason: LOCAL_ROUTINE, memory: "", bubble: null, bubbleUntil: 0,
        facing: "south", lastEncounterAt: -1000, reported: false,
      })),
      cover: emptyCover(), ledger: [], facts: [], rumors: [], events: [], transcripts: [],
      visitorLog: null, authorization: null, activeNpcId: null, meeraCalled: false,
      meeraResolved: false, secretKnown: false, ending: null, practiceMode: false,
      settings: { captions: true, reducedMotion: false, camera: false, actingCues: false, volume: 0.8 },
    };
  }

  private initialRuntime(): EngineRuntime {
    const actors: Record<string, ActorRuntime> = {};
    for (const definition of this.definitions) {
      actors[definition.id] = {
        path: [], target: null, nextRoutineAt: this.random.between(4, 12),
        modelUntil: 0, nextFollowAt: 0, peerId: null,
      };
    }
    return {
      sequence: 0, randomState: this.random.state, actors,
      heardClaims: Object.fromEntries(this.definitions.map((definition) => [definition.id, []])),
      heardIncidents: Object.fromEntries(this.definitions.map((definition) => [definition.id, []])),
      completedConversations: Object.fromEntries(this.definitions.map((definition) => [definition.id, 0])),
      conversation: null, graceUntil: 5, approachId: null, approachExpires: 0,
      security: { pendingAt: null, remaining: SECURITY_RESPONSE_SECONDS, evidenceIds: [], resolvedAt: null, repeatDeadline: null },
      rumorPayloads: {}, incidents: [], usedModelEvidence: [], lastRoomId: null,
      nextTrespassAt: 0, nextChatterAt: this.random.between(12, 20),
    };
  }

  private definition(npcId: string): NpcDefinition {
    const definition = this.definitions.find((npc) => npc.id === npcId);
    if (!definition) throw new RangeError(`Unknown NPC: ${npcId}`);
    return definition;
  }

  private npc(npcId: string): NpcState | undefined {
    return this.state.npcs.find((npc) => npc.id === npcId);
  }

  private requiredNpc(npcId: string): NpcState {
    const npc = this.npc(npcId);
    if (!npc) throw new RangeError(`Missing NPC state: ${npcId}`);
    return npc;
  }

  private nextId(prefix: string): string {
    this.runtime.sequence += 1;
    return `${prefix}-${this.runtime.sequence}`;
  }

  private emit(kind: GameEvent["kind"], text: string, npcId?: string, eventId?: string): GameEvent {
    const event: GameEvent = {
      id: eventId ?? this.nextId("event"), at: this.state.elapsedSeconds, kind, text,
      ...(npcId ? { npcId } : {}),
    };
    this.state.events.push(event);
    if (this.state.events.length > 500) this.state.events.shift();
    this.onEvent?.({ ...event });
    return event;
  }

  private reject(message: string, npcId?: string): ActionResult {
    this.emit("system", `Action rejected: ${message}`, npcId);
    return { accepted: false, message };
  }

  private say(npc: NpcState, text: string): void {
    npc.bubble = text;
    npc.bubbleUntil = this.state.elapsedSeconds + Math.min(10, Math.max(4, text.length / 22));
  }

  private appendMemory(npc: NpcState, text: string): void {
    npc.memory = `${npc.memory}${npc.memory ? "\n" : ""}${text}`.slice(-6000);
  }

  private hasFact(factId: string): boolean {
    return this.state.facts.some((fact) => fact.id === factId);
  }

  private secretAvailable(): boolean {
    if (!CORE_FACTS.every((factId) => this.hasFact(factId))) return false;
    const completed = Object.entries(this.runtime.completedConversations)
      .filter(([npcId]) => npcId !== "meera").reduce((sum, [, count]) => sum + count, 0);
    return (this.state.visitorLog !== null && this.state.authorization !== null)
      || (this.runtime.completedConversations.kulkarni >= 1 && completed >= 2);
  }

  private availableKnowledge(npcId: string): string[] {
    return this.definition(npcId).knowledge.filter((factId) =>
      factId !== "handler_secret" || (npcId === "kulkarni" && this.secretAvailable()),
    );
  }

  private visibleClaims(npcId: string): Claim[] {
    const heard = new Set(this.runtime.heardClaims[npcId]);
    return this.state.ledger.filter((claim) => heard.has(claim.id));
  }

  private privateCover(npcId: string): CoverIdentity {
    const cover = emptyCover();
    for (const claim of this.visibleClaims(npcId)) cover[claim.field] = claim.value;
    return cover;
  }

  private markMeaningful(): void {
    if (this.runtime.conversation) this.runtime.conversation.successfulActions += 1;
  }

  private recordClaim(action: Extract<GameAction, { type: "claim" }>): ActionResult {
    if (this.state.ledger.length >= 2000) return this.reject("The claim journal is full; existing records have been retained.", action.npcId);
    let value = readableValue(action.value);
    if (!value) return this.reject("A claim needs a nonempty value.", action.npcId);
    if (action.field === "callback") {
      if (!isFictionalCallback(value)) return this.reject("Use only an invented SIM-#### callback, never a real phone number.", action.npcId);
      value = value.toUpperCase();
    }
    if (action.field === "ticket") {
      if (!isFictionalTicket(value)) return this.reject("Tickets are fictional MT-... props with at least three letters or digits after MT-.", action.npcId);
      value = value.toUpperCase();
    }
    if (action.field === "employeeId") {
      if (!isFictionalEmployeeId(value)) return this.reject("Employee IDs must be fictional MT-ID-... props, not real identification.", action.npcId);
      value = value.toUpperCase();
    }
    const oldGlobal = lastClaim(this.state.ledger, action.field);
    const oldKnown = lastClaim(this.visibleClaims(action.npcId), action.field);
    const againstLog = action.field === "name" && canReadVisitorLog(action.npcId)
      && this.state.visitorLog !== null && !sameValue(this.state.visitorLog, value);
    const observed = Boolean(oldKnown && !sameValue(oldKnown.value, value)) || againstLog;
    const claim: Claim = {
      id: this.nextId("claim"), field: action.field, value, npcId: action.npcId,
      quote: action.quote, at: this.state.elapsedSeconds,
      contradiction: Boolean(oldGlobal && !sameValue(oldGlobal.value, value)) || observed,
    };
    this.state.ledger.push(claim);
    this.state.cover[action.field] = value;
    this.runtime.heardClaims[action.npcId].push(claim.id);
    this.runtime.conversation?.claimIds.push(claim.id);
    const npc = this.requiredNpc(action.npcId);
    this.appendMemory(npc, `Direct statement (${action.field}): "${claim.quote}" [${claim.id}]`);
    this.emit("claim", `${this.definition(npc.id).name} recorded a ${action.field} claim; earlier statements remain in the ledger.`, npc.id);
    if (observed) {
      const claimIds = oldKnown ? [oldKnown.id, claim.id] : [claim.id];
      this.addIncident(npc, "contradiction", claimIds, null,
        `${this.definition(npc.id).name} observed a ${action.field} mismatch against a statement or an accessible visitor record.`);
      const delta = action.field === "name" ? 16 : action.field === "company" ? 12 : 6;
      this.adjustSuspicion(npc, delta);
    }
    return { accepted: true, message: observed ? "Claim retained with an observed discrepancy. Both versions and the exact quote are recorded." : "Claim recorded privately for this NPC." };
  }

  private proposeSuspicion(action: Extract<GameAction, { type: "suspicion" }>, npc: NpcState): ActionResult {
    const delta = Math.max(-20, Math.min(30, action.delta));
    if (delta > 0) {
      const heard = new Set(this.runtime.heardIncidents[npc.id]);
      const incident = this.runtime.incidents.find((candidate) => heard.has(candidate.id)
        && (action.evidence === candidate.id || candidate.claimIds.some((claimId) => {
          const claim = this.state.ledger.find((entry) => entry.id === claimId);
          return claim && (action.evidence === claim.id || action.evidence === claim.quote);
        })));
      if (!incident) {
        return this.reject("Positive suspicion needs an observed discrepancy's claim ID/exact quote or a witnessed incident event ID. Demeanor is not evidence.", npc.id);
      }
      const evidenceKey = `${npc.id}-${incident.id}`;
      if (this.runtime.usedModelEvidence.includes(evidenceKey)) {
        return this.reject("That incident has already been assessed in a suspicion proposal.", npc.id);
      }
      this.runtime.usedModelEvidence.push(evidenceKey);
      this.emit("suspicion", `Evidence assessment: ${incident.text}`, npc.id);
    } else if (delta < 0) {
      if (this.runtime.conversation?.reductionUsed) {
        return this.reject("This conversation has already applied its clarification adjustment.", npc.id);
      }
      if (this.runtime.conversation) this.runtime.conversation.reductionUsed = true;
      this.emit("suspicion", `${this.definition(npc.id).name} accepted a conversational clarification. Records were not erased.`, npc.id);
    }
    this.adjustSuspicion(npc, delta);
    return { accepted: true, message: `Suspicion adjusted by a bounded ${delta}; current level ${npc.suspicion}.` };
  }

  private serviceStalled(npc: NpcState): ActionResult | null {
    return npc.suspicion >= SUSPICION_THRESHOLDS.stall
      ? this.reject("This desk is stalling at 70 suspicion. Clarify the discrepancy or resolve security before proceeding.", npc.id)
      : null;
  }

  private matchingName(name: string, npcId: string): boolean {
    const knownName = this.privateCover(npcId).name;
    return Boolean(readableValue(name) && knownName && this.state.cover.name
      && sameValue(name, knownName) && sameValue(name, this.state.cover.name));
  }

  private registerVisitor(name: string, npc: NpcState): ActionResult {
    if (npc.id !== "priya") return this.reject("Only Priya at floor-1 reception can register visitors.", npc.id);
    const stalled = this.serviceStalled(npc);
    if (stalled) return stalled;
    const cover = this.privateCover(npc.id);
    if (!this.matchingName(name, npc.id) || !cover.company || (!cover.host && !cover.role)) {
      return this.reject("Registration needs the same stated invented name, a company, and a host or plausible work role.", npc.id);
    }
    if (cover.callback && !isFictionalCallback(cover.callback)) return this.reject("A callback must be a fictional SIM-#### desk code.", npc.id);
    if (this.state.visitorLog !== null && !sameValue(this.state.visitorLog, name)) {
      return this.reject("The existing visitor log cannot be silently replaced under another alias.", npc.id);
    }
    if (this.state.authorization && !sameValue(this.state.authorization.name, name)) {
      return this.reject("Your existing authorization uses another name. Keep the two records consistent.", npc.id);
    }
    if (this.state.visitorLog) return { accepted: true, message: "That exact alias is already in the visitor log." };
    this.state.visitorLog = readableValue(name);
    this.markMeaningful();
    this.appendMemory(npc, `Registered visitor alias "${this.state.visitorLog}". This is a log entry, not a card authorization.`);
    this.emit("story", "Priya completed the visitor log. Authorization and floor-2 collection are still separate steps.", npc.id);
    return { accepted: true, message: "Registered. Obtain Dev's or Anita's authorization, then collect from Ramesh on floor 2." };
  }

  private authorizeVisitor(name: string, npc: NpcState): ActionResult {
    if (npc.id !== "dev" && npc.id !== "anita") return this.reject("Only Dev on floor 4 or Anita on floor 11 may authorize a visitor.", npc.id);
    const stalled = this.serviceStalled(npc);
    if (stalled) return stalled;
    if (!this.matchingName(name, npc.id)) return this.reject("Authorization must match the invented name actually known in this conversation.", npc.id);
    if (this.state.visitorLog && !sameValue(this.state.visitorLog, name)) {
      return this.reject("The requested authorization name does not exactly match the visitor log.", npc.id);
    }
    const cover = this.privateCover(npc.id);
    if (npc.id === "dev" && !isFictionalTicket(cover.ticket) && !isFictionalEmployeeId(cover.employeeId)) {
      return this.reject("Dev needs a fictional MT-... ticket or MT-ID-... employee prop stated to him.", npc.id);
    }
    if (npc.id === "anita") {
      if (!this.hasFact("cfo_away")) return this.reject("Learn that Rajan Mehta is in Singapore until Friday before using Anita's alternative route.", npc.id);
      if (!cover.company) return this.reject("Anita needs a company as well as the consistent visitor name.", npc.id);
      const knownCompanyClaims = this.visibleClaims(npc.id).filter((claim) => claim.field === "company");
      if (knownCompanyClaims[0] && !sameValue(knownCompanyClaims[0].value, cover.company)) {
        return this.reject("Anita's earlier company record differs. Clarify the original company or use Dev's documented ticket route.", npc.id);
      }
    }
    if (this.state.authorization && !sameValue(this.state.authorization.name, name)) {
      return this.reject("An authorization already exists for another alias; it cannot be silently rewritten.", npc.id);
    }
    if (this.state.authorization) return { accepted: true, message: "A matching authorization is already on file." };
    this.state.authorization = { name: readableValue(name), by: npc.id, at: this.state.elapsedSeconds };
    this.markMeaningful();
    this.appendMemory(npc, `Authorized "${readableValue(name)}" for visitor collection, not restricted-room entry.`);
    this.emit("story", `${this.definition(npc.id).name} authorized the alias. Ramesh handles collection on floor 2.`, npc.id);
    return { accepted: true, message: "Authorization recorded. Ramesh still needs the exact matching visitor log before issuing a card." };
  }

  private issueCard(name: string, npc: NpcState): ActionResult {
    if (npc.id !== "ramesh") return this.reject("Only Ramesh at the floor-2 collection desk can issue a keycard.", npc.id);
    const stalled = this.serviceStalled(npc);
    if (stalled) return stalled;
    if (!this.matchingName(name, npc.id)) return this.reject("State the same invented name at the collection desk.", npc.id);
    if (!this.state.visitorLog || !sameValue(this.state.visitorLog, name)) {
      return this.reject("No exact alias-matched visitor log. Priya must register that name on floor 1.", npc.id);
    }
    const authorization = this.state.authorization;
    if (!authorization || !["dev", "anita"].includes(authorization.by) || !sameValue(authorization.name, name)) {
      return this.reject("No exact alias-matched authorization from Dev or Anita. A log entry alone is not enough.", npc.id);
    }
    if (this.state.player.carryingCard) return { accepted: true, message: "You already have the visitor keycard." };
    this.state.player.carryingCard = true;
    this.markMeaningful();
    this.appendMemory(npc, `Issued one visitor card after matching the log and ${authorization.by}'s authorization.`);
    this.emit("story", "Ramesh issued the visitor keycard. Return to the floor-1 exit before 18:00.", npc.id);
    return { accepted: true, message: "Both exact records matched. Keycard collected on floor 2." };
  }

  private discover(factId: string, npc: NpcState): ActionResult {
    if (!this.availableKnowledge(npc.id).includes(factId)) {
      return this.reject(factId === "handler_secret" && npc.id === "kulkarni"
        ? "Kulkarni needs the three building facts plus meaningful prior conversation or registration and authorization before recalling that lead."
        : "This NPC cannot reveal a fact they do not know or a lead that is not yet available.", npc.id);
    }
    const fact = FACTS.find((candidate) => candidate.id === factId);
    if (!fact) return this.reject("That fact is not part of the story.", npc.id);
    if (this.hasFact(factId)) return { accepted: true, message: "That evidence is already in the journal." };
    this.state.facts.push({ ...fact });
    if (factId === "handler_secret") this.state.secretKnown = true;
    this.runtime.conversation?.factIds.push(factId);
    this.appendMemory(npc, `Shared a known building fact: ${fact.title}.`);
    this.emit("story", `${this.definition(npc.id).name} shared "${fact.title}".`, npc.id);
    return { accepted: true, message: `Journal evidence recorded: ${fact.title}.` };
  }

  private closeConversation(summary: string): void {
    const activeId = this.state.activeNpcId;
    const conversation = this.runtime.conversation;
    if (!activeId || !conversation) return;
    const npc = this.requiredNpc(activeId);
    const meaningful = conversation.claimIds.length > 0 || conversation.factIds.length > 0
      || conversation.successfulActions > 0 || conversation.playerTurnIds.length >= 2;
    if (meaningful) this.runtime.completedConversations[activeId] += 1;
    this.appendMemory(npc, `Conversation summary: ${summary.trim().slice(0, 3000) || "The visitor ended the conversation."}`);
    npc.lastEncounterAt = this.state.elapsedSeconds;
    npc.intent = "return_post";
    npc.intentReason = "Conversation ended; giving the visitor space.";
    const actor = this.runtime.actors[activeId];
    actor.path = [];
    actor.target = null;
    actor.modelUntil = 0;
    actor.nextRoutineAt = this.state.elapsedSeconds + 2;
    this.state.activeNpcId = null;
    this.runtime.conversation = null;
    this.runtime.graceUntil = this.state.elapsedSeconds + 7;
    this.runtime.approachId = null;
    if (meaningful) this.startGossip(activeId);
    this.emit("story", `${this.definition(activeId).name}'s conversation ended. You have room to leave.`, activeId);
  }

  private addIncident(npc: NpcState, kind: Incident["kind"], claimIds: string[], roomId: string | null, text: string): Incident {
    const incident: Incident = { id: this.nextId("incident"), kind, npcId: npc.id, at: this.state.elapsedSeconds, claimIds, roomId, text };
    this.runtime.incidents.push(incident);
    this.runtime.heardIncidents[npc.id].push(incident.id);
    if (npc.id === "meera") this.runtime.security.evidenceIds.push(incident.id);
    this.appendMemory(npc, `Observed evidence [${incident.id}]: ${text}`);
    this.emit("suspicion", text, npc.id, incident.id);
    return incident;
  }

  private adjustSuspicion(npc: NpcState, delta: number): void {
    const previous = npc.suspicion;
    npc.suspicion = Math.max(0, Math.min(100, npc.suspicion + delta));
    if (npc.id === "meera") return;
    if (previous < SUSPICION_THRESHOLDS.verify && npc.suspicion >= SUSPICION_THRESHOLDS.verify) {
      this.say(npc, "Let me verify the recorded details before we go further.");
      this.emit("suspicion", `${this.definition(npc.id).name} reached verification level (40).`, npc.id);
    }
    if (previous < SUSPICION_THRESHOLDS.stall && npc.suspicion >= SUSPICION_THRESHOLDS.stall) {
      this.say(npc, "I need to pause this request until the records are clarified.");
      this.emit("suspicion", `${this.definition(npc.id).name} is stalling service (70).`, npc.id);
    }
    if (npc.suspicion >= SUSPICION_THRESHOLDS.escalate) this.escalate(npc);
  }

  private escalate(npc: NpcState): void {
    if (npc.id === "meera") return;
    if (!npc.reported) {
      npc.reported = true;
      this.queueRumor(npc.id, "meera", 2.5, true);
      this.emit("suspicion", `${this.definition(npc.id).name} requested security verification. This is a warning, not an automatic loss.`, npc.id);
    }
    if (!this.state.meeraCalled) {
      if (this.runtime.security.pendingAt === null) this.runtime.security.pendingAt = this.state.elapsedSeconds + 3;
    } else if (this.state.meeraResolved && this.runtime.security.repeatDeadline === null) {
      const resolvedAt = this.runtime.security.resolvedAt ?? this.state.elapsedSeconds;
      const fresh = this.runtime.heardIncidents[npc.id].some((id) =>
        this.runtime.incidents.some((incident) => incident.id === id && incident.at > resolvedAt),
      );
      if (fresh) {
        this.queueRumor(npc.id, "meera", 2.5, true);
        this.runtime.security.repeatDeadline = this.state.elapsedSeconds + 20;
        this.emit("suspicion", "Security has a new documented report after the warning. You have twenty seconds to reach the exit; there is no second incoming call.");
      }
    }
  }

  private advanceSecurity(dt: number): void {
    for (const npc of this.state.npcs) {
      if (npc.id !== "meera" && npc.suspicion >= SUSPICION_THRESHOLDS.escalate && !npc.reported) this.escalate(npc);
    }
    if (this.runtime.security.pendingAt !== null && this.state.activeNpcId === null
      && this.state.elapsedSeconds >= this.runtime.security.pendingAt) this.beginConversation("meera");
    if (this.state.activeNpcId === "meera" && !this.state.meeraResolved && this.conversationClockRunning) {
      this.runtime.security.remaining = Math.max(0, this.runtime.security.remaining - dt);
      if (this.runtime.security.remaining <= 1e-8) this.resolveSecurity();
    }
    if (this.runtime.security.repeatDeadline !== null
      && this.state.elapsedSeconds >= this.runtime.security.repeatDeadline) {
      this.runtime.security.repeatDeadline = null;
      if (this.securityEvidenceIsBurned()) this.finish("burned", "New documented evidence after Meera's warning ended the cover.");
      else this.emit("suspicion", "Security retained a flag but has no additional evidence sufficient to burn the cover.");
    }
  }

  private securityEvidenceIsBurned(): boolean {
    const known = new Set(this.runtime.security.evidenceIds);
    const incidents = this.runtime.incidents.filter((incident) => known.has(incident.id));
    const identityConflicts = new Set(incidents.filter((incident) => incident.kind === "contradiction")
      .map((incident) => incident.claimIds[incident.claimIds.length - 1])
      .filter((claimId) => this.state.ledger.some((claim) =>
        claim.id === claimId && (claim.field === "name" || claim.field === "company"),
      )));
    const trespasses = new Set(incidents.filter((incident) => incident.kind === "trespass").map((incident) => incident.id));
    return identityConflicts.size >= 2 || trespasses.size >= 3
      || (identityConflicts.size >= 1 && trespasses.size >= 2);
  }

  private resolveSecurity(): ActionResult {
    if (this.state.phase !== "playing" || this.state.activeNpcId !== "meera"
      || !this.state.meeraCalled || this.state.meeraResolved) {
      return this.reject("There is no unresolved Meera call to resolve.");
    }
    const burned = this.securityEvidenceIsBurned();
    this.state.meeraResolved = true;
    this.runtime.security.remaining = 0;
    this.runtime.security.resolvedAt = this.state.elapsedSeconds;
    this.runtime.security.pendingAt = null;
    for (const npc of this.state.npcs) {
      npc.suspicion = Math.min(npc.suspicion, 60);
    }
    const summary = burned
      ? "Meera confirmed multiple documented identity discrepancies or repeated witnessed trespass."
      : "Meera issued a warning. The available records do not justify burning the cover.";
    this.closeConversation(summary);
    this.emit("story", summary, "meera");
    if (burned) this.finish("burned", summary);
    return {
      accepted: true,
      message: burned
        ? "Burned: the reported evidence, not speech style or the requested model verdict, established the outcome."
        : "Warning: continue or leave. Silence and hesitation are not evidence, and there will be no second incoming call.",
    };
  }

  private startGossip(from: string): void {
    for (const edge of GOSSIP_EDGES) {
      if (edge.from === from && this.random.next() < edge.probability) {
        this.queueRumor(from, edge.to, this.random.between(5, 12));
      }
    }
  }

  private queueRumor(from: string, to: string, delay: number, report = false): void {
    if (this.state.rumors.length >= 1000) {
      const deliveredIndex = this.state.rumors.findIndex((rumor) => rumor.delivered);
      if (deliveredIndex < 0) {
        this.emit("system", "The office message queue is full. No undelivered message was silently discarded.");
        return;
      }
      const [removed] = this.state.rumors.splice(deliveredIndex, 1);
      delete this.runtime.rumorPayloads[removed.id];
    }
    const known = this.visibleClaims(from);
    const identity = (["name", "company", "host"] as const)
      .map((field) => lastClaim(known, field)).filter((claim): claim is Claim => claim !== undefined);
    const incidentIds = this.runtime.heardIncidents[from].slice(report ? -100 : -3);
    const relevantIncidents = this.runtime.incidents.filter((incident) => incidentIds.includes(incident.id));
    const payload: RumorPayload = {
      claimIds: unique([...identity.map((claim) => claim.id), ...relevantIncidents.flatMap((incident) => incident.claimIds)]),
      incidentIds: [...incidentIds],
    };
    const label = identity.map((claim) => `${claim.field}: "${claim.value}"`).join("; ");
    const text = `${this.definition(from).name}: ${label || "A visitor asked about the building."}`
      + (incidentIds.length ? " There is a recorded discrepancy or witnessed restricted-room incident to verify." : "");
    const rumor = {
      id: this.nextId("rumor"), from, to, text,
      at: this.state.elapsedSeconds + delay, delivered: false,
    };
    this.state.rumors.push(rumor);
    this.runtime.rumorPayloads[rumor.id] = payload;
  }

  private deliverRumors(): void {
    for (const rumor of this.state.rumors) {
      if (rumor.delivered || rumor.at > this.state.elapsedSeconds) continue;
      const payload = this.runtime.rumorPayloads[rumor.id];
      if (!payload) throw new Error(`Missing private payload for rumor ${rumor.id}.`);
      const recipient = this.requiredNpc(rumor.to);
      const oldClaims = this.visibleClaims(recipient.id);
      const oldIncidents = new Set(this.runtime.heardIncidents[recipient.id]);
      this.runtime.heardClaims[recipient.id] = unique([...this.runtime.heardClaims[recipient.id], ...payload.claimIds]);
      this.runtime.heardIncidents[recipient.id] = unique([...this.runtime.heardIncidents[recipient.id], ...payload.incidentIds]);
      const incomingClaims = this.state.ledger.filter((claim) => payload.claimIds.includes(claim.id));
      let newlyContradictory = false;
      for (const field of ["name", "company", "host"] as const) {
        const previous = lastClaim(oldClaims, field);
        const incoming = lastClaim(incomingClaims, field);
        if (!previous || !incoming || sameValue(previous.value, incoming.value)) continue;
        const alreadyDocumented = this.runtime.incidents.some((incident) =>
          this.runtime.heardIncidents[recipient.id].includes(incident.id)
          && incident.claimIds.includes(previous.id) && incident.claimIds.includes(incoming.id),
        );
        if (alreadyDocumented) continue;
        this.addIncident(recipient, "contradiction", [previous.id, incoming.id], null,
          `${this.definition(recipient.id).name} received a ${field} statement inconsistent with a record they already knew.`);
        newlyContradictory = true;
      }
      rumor.delivered = true;
      this.appendMemory(recipient, `Delivered private note from ${this.definition(rumor.from).name}: ${rumor.text}`);
      if (recipient.id === "meera") {
        this.runtime.security.evidenceIds = unique([
          ...this.runtime.security.evidenceIds, ...this.runtime.heardIncidents.meera,
        ]);
      } else if (newlyContradictory || payload.incidentIds.some((id) => !oldIncidents.has(id))) {
        this.adjustSuspicion(recipient, 6);
      }
      this.emit("gossip", `A private note from ${this.definition(rumor.from).name} reached ${this.definition(rumor.to).name}.`, rumor.to);
    }
  }

  private movePlayer(dt: number, input: { x: number; y: number; running?: boolean }): void {
    const player = this.state.player;
    if (this.state.activeNpcId !== null) {
      player.moving = false;
      return;
    }
    const magnitude = Math.hypot(input.x, input.y);
    if (magnitude < 1e-8) {
      player.moving = false;
      return;
    }
    const factor = Math.min(1, magnitude) / magnitude;
    const speed = input.running === true ? RUN_SPEED : WALK_SPEED;
    const dx = input.x * factor * speed * dt;
    const dy = input.y * factor * speed * dt;
    const previous = { x: player.x, y: player.y };
    if (canOccupy(this.currentFloor, { x: player.x + dx, y: player.y })) player.x += dx;
    if (canOccupy(this.currentFloor, { x: player.x, y: player.y + dy })) player.y += dy;
    player.moving = distance(previous, player) > 1e-7;
    player.facing = this.facingToward(previous, { x: previous.x + dx, y: previous.y + dy });
  }

  private facingToward(from: Point, to: Point): Direction {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) > Math.abs(dy)) return dx >= 0 ? "east" : "west";
    return dy >= 0 ? "south" : "north";
  }

  private setActorTarget(npc: NpcState, target: Point): boolean {
    if (npc.floor < 1) return false;
    const floor = this.floors[npc.floor - 1];
    const actor = this.runtime.actors[npc.id];
    if (actor.path.length > 0 && actor.target
      && Math.floor(actor.target.x) === Math.floor(target.x) && Math.floor(actor.target.y) === Math.floor(target.y)) return true;
    const path = findPath(floor, npc, target);
    if (path.length === 0) return false;
    actor.path = path;
    if (distance(npc, actor.path[0]) < 0.02) actor.path.shift();
    actor.target = { x: Math.floor(target.x) + 0.5, y: Math.floor(target.y) + 0.5 };
    return true;
  }

  private routineTarget(npc: NpcState): Point {
    const definition = this.definition(npc.id);
    const floor = this.floors[npc.floor - 1];
    const homeRoom = roomAt(floor, definition.home);
    const points: Point[] = [];
    for (let y = Math.floor(definition.home.y) - 2; y <= Math.floor(definition.home.y) + 2; y += 1) {
      for (let x = Math.floor(definition.home.x) - 4; x <= Math.floor(definition.home.x) + 4; x += 1) {
        const candidate = { x: x + 0.5, y: y + 0.5 };
        if (isWalkable(floor, candidate.x, candidate.y)
          && roomAt(floor, candidate)?.id === homeRoom?.id && findPath(floor, npc, candidate).length > 0) points.push(candidate);
      }
    }
    return points.length ? this.random.pick(points) : { ...definition.home };
  }

  private chooseRoutine(npc: NpcState): void {
    const actor = this.runtime.actors[npc.id];
    const home = this.definition(npc.id).home;
    actor.modelUntil = 0;
    actor.peerId = null;
    actor.nextRoutineAt = this.state.elapsedSeconds + this.random.between(8, 18);
    const returning = distance(npc, home) > 0.3 && (MAIN_POSTS.has(npc.id) || this.random.next() < 0.4);
    if (returning) {
      npc.intent = "return_post";
      npc.intentReason = "Local fallback: returning to the assigned post.";
      this.setActorTarget(npc, home);
    } else if ((MAIN_POSTS.has(npc.id) && this.random.next() < 0.85) || this.random.next() < 0.3) {
      npc.intent = "idle";
      npc.intentReason = "Local fallback: working at the post while awaiting a director intent.";
      actor.path = [];
      actor.target = null;
    } else {
      npc.intent = "wander";
      npc.intentReason = "Local fallback: a short, deterministic office routine.";
      this.setActorTarget(npc, this.routineTarget(npc));
    }
  }

  private moveActors(dt: number): void {
    const now = this.state.elapsedSeconds;
    for (const npc of this.state.npcs) {
      if (npc.bubble !== null && npc.bubbleUntil <= now) npc.bubble = null;
      if (npc.floor !== this.state.floor || npc.id === this.state.activeNpcId) continue;
      const actor = this.runtime.actors[npc.id];
      const guard = this.definition(npc.id).role === "Security marshal" && this.securityAlert;
      const approaching = this.runtime.approachId === npc.id;
      const following = guard || approaching || (npc.intent === "follow_player" && actor.modelUntil > now);
      if (following) {
        npc.intent = "follow_player";
        if (guard) npc.intentReason = "Local security response: following a reported visitor; bodies do not block escape.";
        if (distance(npc, this.state.player) <= 1.55 && hasLineOfSight(this.currentFloor, npc, this.state.player)) {
          actor.path = [];
          actor.target = null;
          npc.facing = this.facingToward(npc, this.state.player);
        } else if (now >= actor.nextFollowAt) {
          this.setActorTarget(npc, this.state.player);
          actor.nextFollowAt = now + 0.45;
        }
      } else if (actor.modelUntil > 0 && actor.modelUntil <= now) {
        this.chooseRoutine(npc);
      } else if (actor.modelUntil === 0 && now >= actor.nextRoutineAt) {
        this.chooseRoutine(npc);
      }
      let budget = dt * (guard ? 2 : 1.15 + (npc.id.length % 4) * 0.1);
      while (budget > 1e-9 && actor.path.length > 0) {
        const next = actor.path[0];
        const length = distance(npc, next);
        if (length < 1e-7) {
          actor.path.shift();
          continue;
        }
        const amount = Math.min(length, budget);
        const position = {
          x: npc.x + (next.x - npc.x) * amount / length,
          y: npc.y + (next.y - npc.y) * amount / length,
        };
        if (!canOccupy(this.currentFloor, position)) {
          actor.path = [];
          actor.target = null;
          npc.intent = "idle";
          npc.intentReason = "Path blocked; waiting for a reachable route.";
          this.emit("system", `${this.definition(npc.id).name} stopped because a route became blocked.`, npc.id);
          break;
        }
        npc.facing = this.facingToward(npc, position);
        npc.x = position.x;
        npc.y = position.y;
        budget -= amount;
        if (amount >= length - 1e-7) actor.path.shift();
      }
      if (actor.path.length === 0) actor.target = null;
    }
  }

  private cancelApproach(): void {
    const npc = this.runtime.approachId ? this.npc(this.runtime.approachId) : undefined;
    if (npc) {
      const actor = this.runtime.actors[npc.id];
      actor.path = [];
      actor.target = null;
      actor.nextRoutineAt = this.state.elapsedSeconds + 1;
      npc.intent = "return_post";
      npc.intentReason = "Visitor moved away; giving them space.";
    }
    this.runtime.approachId = null;
  }

  private considerEncounter(): void {
    if (this.state.activeNpcId !== null || this.state.elapsedSeconds < this.runtime.graceUntil
      || this.runtime.security.pendingAt !== null) return;
    if (this.runtime.approachId) {
      const approaching = this.requiredNpc(this.runtime.approachId);
      if (approaching.floor !== this.state.floor || this.state.elapsedSeconds > this.runtime.approachExpires
        || distance(approaching, this.state.player) > 6
        || !hasLineOfSight(this.currentFloor, approaching, this.state.player)) {
        approaching.lastEncounterAt = this.state.elapsedSeconds - AUTO_ENCOUNTER_COOLDOWN + 8;
        this.cancelApproach();
        this.runtime.graceUntil = this.state.elapsedSeconds + 2;
      } else if (distance(approaching, this.state.player) <= 1.65) {
        this.beginConversation(approaching.id);
      }
      return;
    }
    const candidates = this.state.npcs.filter((npc) =>
      npc.floor === this.state.floor && this.state.elapsedSeconds - npc.lastEncounterAt >= AUTO_ENCOUNTER_COOLDOWN
      && distance(npc, this.state.player) <= (MAIN_POSTS.has(npc.id) ? AUTO_ENCOUNTER_RADIUS : 3.2)
      && hasLineOfSight(this.currentFloor, npc, this.state.player),
    ).sort((a, b) => distance(a, this.state.player) - distance(b, this.state.player) || a.id.localeCompare(b.id));
    const candidate = candidates[0];
    if (!candidate) return;
    this.runtime.approachId = candidate.id;
    this.runtime.approachExpires = this.state.elapsedSeconds + 10;
    candidate.intent = "follow_player";
    candidate.intentReason = "Local proximity response: approaching a visible visitor.";
    const actor = this.runtime.actors[candidate.id];
    actor.modelUntil = 0;
    actor.nextFollowAt = 0;
    this.setActorTarget(candidate, this.state.player);
    if (distance(candidate, this.state.player) <= 1.65) this.beginConversation(candidate.id);
  }

  private localChatter(): void {
    if (this.state.elapsedSeconds < this.runtime.nextChatterAt) return;
    this.runtime.nextChatterAt = this.state.elapsedSeconds + this.random.between(16, 26);
    const available = this.state.npcs.filter((npc) =>
      npc.floor === this.state.floor && npc.id !== this.state.activeNpcId && npc.id !== this.runtime.approachId,
    );
    if (available.length < 2) return;
    const from = this.random.pick(available);
    const to = available.find((npc) => npc.id !== from.id && distance(from, npc) <= 5
      && hasLineOfSight(this.currentFloor, from, npc));
    if (!to) return;
    const text = this.random.pick(LOCAL_CHATTER);
    this.say(from, text);
    this.emit("director", `Local fallback chatter, ${this.definition(from.id).name} to ${this.definition(to.id).name}: ${text}`, from.id);
  }

  private adjacentGoal(npc: NpcState, peer: NpcState): Point | null {
    const points = [
      { x: Math.floor(peer.x) - 0.5, y: Math.floor(peer.y) + 0.5 },
      { x: Math.floor(peer.x) + 1.5, y: Math.floor(peer.y) + 0.5 },
      { x: Math.floor(peer.x) + 0.5, y: Math.floor(peer.y) - 0.5 },
      { x: Math.floor(peer.x) + 0.5, y: Math.floor(peer.y) + 1.5 },
    ].sort((a, b) => distance(npc, a) - distance(npc, b));
    return points.find((point) => findPath(this.currentFloor, npc, point).length > 0) ?? null;
  }

  private applyIntent(intent: NpcIntent): void {
    const npc = this.npc(intent.npcId);
    if (!npc || npc.floor !== this.state.floor || npc.id === this.state.activeNpcId) {
      this.emit("system", "Director intent rejected: actor must exist on the active floor and not be in conversation.");
      return;
    }
    const peer = intent.targetNpcId ? this.npc(intent.targetNpcId) : undefined;
    if (intent.targetNpcId && (!peer || peer.floor !== npc.floor || peer.id === npc.id)) {
      this.emit("system", "Director intent rejected: target NPC must be a different actor on the same floor.", npc.id);
      return;
    }
    if (intent.target && (!canOccupy(this.currentFloor, intent.target)
      || findPath(this.currentFloor, npc, intent.target).length === 0)) {
      this.emit("system", "Director intent rejected: destination is blocked or unreachable; no actor was teleported.", npc.id);
      return;
    }
    let target: Point | null = intent.target ?? null;
    switch (intent.action) {
      case "idle":
        target = null;
        break;
      case "return_post":
        target = this.definition(npc.id).home;
        break;
      case "follow_player":
        target = this.state.player;
        break;
      case "wander":
        target = target ?? this.routineTarget(npc);
        break;
      case "chat_with":
        if (!peer) {
          this.emit("system", "Director chat intent rejected: a valid target NPC is required.", npc.id);
          return;
        }
        target = this.adjacentGoal(npc, peer);
        if (!target) {
          this.emit("system", "Director chat intent rejected: there is no reachable speaking position.", npc.id);
          return;
        }
        break;
      case "walk_to":
      case "investigate":
      case "block_path":
      case "emerge_from":
        if (!target) {
          this.emit("system", "Director movement intent rejected: a walkable target is required.", npc.id);
          return;
        }
        break;
    }
    if (target && !this.setActorTarget(npc, target)) {
      this.emit("system", "Director intent rejected: no connected path to the requested destination.", npc.id);
      return;
    }
    const actor = this.runtime.actors[npc.id];
    if (!target) {
      actor.path = [];
      actor.target = null;
    }
    if (this.runtime.approachId === npc.id) this.runtime.approachId = null;
    actor.modelUntil = this.state.elapsedSeconds + 24;
    actor.nextRoutineAt = actor.modelUntil;
    actor.peerId = peer?.id ?? null;
    actor.nextFollowAt = this.state.elapsedSeconds + 0.4;
    npc.intent = intent.action;
    npc.intentReason = `Gemini: ${intent.reason}`;
    if (intent.say) this.say(npc, intent.say);
    this.emit("director", `${this.definition(npc.id).name}: ${intent.action} (${intent.reason})`, npc.id);
  }

  private observeRestrictedRoom(): void {
    const room = roomAt(this.currentFloor, this.state.player);
    this.runtime.lastRoomId = room?.restricted ? room.id : null;
    if (!room?.restricted || this.state.activeNpcId !== null || this.state.elapsedSeconds < this.runtime.nextTrespassAt) return;
    const witnesses = this.state.npcs.filter((npc) =>
      npc.floor === this.state.floor && distance(npc, this.state.player) <= 7
      && hasLineOfSight(this.currentFloor, npc, this.state.player),
    ).sort((a, b) => distance(a, this.state.player) - distance(b, this.state.player));
    const witness = witnesses[0];
    if (!witness) return;
    this.runtime.nextTrespassAt = this.state.elapsedSeconds + 10;
    this.addIncident(witness, "trespass", [], room.id,
      `${this.definition(witness.id).name} witnessed a visitor in ${room.name}, a restricted room. Return to the public corridor.`);
    this.say(witness, "This room is restricted. Please step back into the corridor.");
    this.adjustSuspicion(witness, witness.reported ? 18 : 12);
  }

  private observeServerDoor(): void {
    if (this.state.floor !== 7 || this.hasFact("server_observation")) return;
    const blueDoor = { x: 17.5, y: 4.5 };
    if (this.state.player.x >= 17 || distance(this.state.player, blueDoor) > 2.5
      || !hasLineOfSight(this.currentFloor, this.state.player, blueDoor)) return;
    const fact = FACTS.find((candidate) => candidate.id === "server_observation");
    if (!fact) throw new Error("The corridor reconnaissance fact is missing.");
    this.state.facts.push({ ...fact });
    this.emit("story", "From the public corridor, you spotted a courier docket in the blue door's window. Optional reconnaissance recorded.");
  }

  private saveProblem(state: GameState, runtime: EngineRuntime, floors: FloorPlan[]): string | null {
    const definitions = new Map(this.definitions.map((definition) => [definition.id, definition]));
    const definitionIds = new Set(definitions.keys());
    const keysMatch = (record: object, keys: Set<string>): boolean =>
      Object.keys(record).length === keys.size && Object.keys(record).every((key) => keys.has(key));
    const idsUnique = (entries: readonly { id: string }[]): boolean =>
      new Set(entries.map((entry) => entry.id)).size === entries.length;
    const floor = floors[state.floor - 1];
    if (!canOccupy(floor, state.player)) return "The player position is outside a traversable tile.";
    if (state.npcs.length !== definitions.size || !idsUnique(state.npcs)) return "The NPC roster is incomplete or duplicated.";
    for (const npc of state.npcs) {
      const definition = definitions.get(npc.id);
      if (!definition || definition.floor !== npc.floor) return "An NPC has an unknown ID or an invalid floor.";
      if (npc.floor === 0 ? npc.x !== 0 || npc.y !== 0 : !canOccupy(floors[npc.floor - 1], npc)) {
        return "An NPC position is not traversable.";
      }
      if (npc.lastEncounterAt > state.elapsedSeconds) return "An encounter timestamp is in the future.";
    }
    for (const record of [runtime.actors, runtime.heardClaims, runtime.heardIncidents, runtime.completedConversations]) {
      if (!keysMatch(record, definitionIds)) return "Private NPC runtime records do not match the roster.";
    }
    const expectedClock = GAME_START_MINUTE + state.elapsedSeconds * (GAME_END_MINUTE - GAME_START_MINUTE) / GAME_DAY_SECONDS;
    if (state.elapsedSeconds > GAME_DAY_SECONDS || Math.abs(state.clockMinute - expectedClock) > 1e-5) return "The mission clock is inconsistent.";
    if ((state.phase === "ended") !== (state.ending !== null)) return "The ending and phase disagree.";
    if (state.phase === "playing" && state.clockMinute >= GAME_END_MINUTE) return "A closed visitor day cannot still be playing.";
    if ((runtime.conversation?.npcId ?? null) !== state.activeNpcId) return "The active conversation and private runtime disagree.";
    if (state.activeNpcId && (!definitionIds.has(state.activeNpcId) || state.phase !== "playing")) return "The active conversation is invalid.";
    if (state.activeNpcId && state.activeNpcId !== "meera"
      && definitions.get(state.activeNpcId)?.floor !== state.floor) return "An active NPC is on another floor.";
    if (runtime.approachId && (state.activeNpcId !== null
      || definitions.get(runtime.approachId)?.floor !== state.floor)) return "The encounter approach is invalid.";
    if (runtime.lastRoomId && !floor.rooms.some((room) => room.id === runtime.lastRoomId)) return "The room tracker references another floor.";
    if (state.phase === "briefing" && (state.elapsedSeconds !== 0 || state.ledger.length || state.facts.length
      || state.visitorLog || state.authorization || state.player.carryingCard || state.meeraCalled)) return "A briefing save contains mission progress.";
    if (state.meeraResolved && !state.meeraCalled) return "Security was resolved without a call.";
    if ((runtime.security.resolvedAt !== null) !== state.meeraResolved
      || (runtime.security.resolvedAt !== null && runtime.security.resolvedAt > state.elapsedSeconds)) return "The security resolution time is invalid.";
    if (state.activeNpcId === "meera" && (!state.meeraCalled || state.meeraResolved)) return "The incoming security call state is invalid.";
    if (state.phase === "playing" && state.meeraCalled && !state.meeraResolved && state.activeNpcId !== "meera") return "The unresolved security call is missing.";
    if (runtime.security.pendingAt !== null && (state.meeraCalled || state.phase !== "playing")) return "A pending security call conflicts with mission state.";
    if (runtime.security.repeatDeadline !== null && !state.meeraResolved) return "A repeat warning precedes the first security resolution.";

    const validProp = (field: keyof CoverIdentity, value: string): boolean => !value
      || (field === "callback" ? isFictionalCallback(value)
        : field === "ticket" ? isFictionalTicket(value)
          : field === "employeeId" ? isFictionalEmployeeId(value) : true);
    if (!idsUnique(state.ledger) || state.ledger.some((claim) => !definitionIds.has(claim.npcId)
      || claim.at > state.elapsedSeconds || !readableValue(claim.value) || !validProp(claim.field, claim.value))) return "The claim ledger is invalid.";
    for (const field of COVER_FIELDS) {
      if (!validProp(field, state.cover[field]) || state.cover[field] !== (lastClaim(state.ledger, field)?.value ?? "")) {
        return "The cover does not match the retained claim ledger.";
      }
    }
    const claimIds = new Set(state.ledger.map((claim) => claim.id));
    const incidentIds = new Set(runtime.incidents.map((incident) => incident.id));
    if (!idsUnique(runtime.incidents)) return "Incident IDs are duplicated.";
    for (const npcId of definitionIds) {
      if (runtime.heardClaims[npcId].some((id) => !claimIds.has(id))
        || runtime.heardIncidents[npcId].some((id) => !incidentIds.has(id))) return "Private memory references missing evidence.";
    }
    for (const incident of runtime.incidents) {
      const definition = definitions.get(incident.npcId);
      if (!definition || incident.at > state.elapsedSeconds || incident.claimIds.some((id) => !claimIds.has(id))
        || !runtime.heardIncidents[incident.npcId].includes(incident.id)) return "An incident record is inconsistent.";
      if (incident.kind === "trespass" && (!incident.roomId
        || !floors.some((plan) => plan.rooms.some((room) => room.id === incident.roomId && room.restricted)))) return "Trespass evidence references a nonexistent restricted room.";
      if (incident.kind === "contradiction" && incident.claimIds.length === 0) return "A contradiction has no recorded statement.";
    }
    if (runtime.security.evidenceIds.some((id) => !incidentIds.has(id)
      || !runtime.heardIncidents.meera.includes(id))) return "Meera's evidence was never delivered or observed.";
    if (!idsUnique(state.facts)) return "Journal evidence is duplicated.";
    for (const fact of state.facts) {
      const canonical = FACTS.find((candidate) => candidate.id === fact.id);
      if (!canonical || canonical.title !== fact.title || canonical.text !== fact.text
        || canonical.source !== fact.source || canonical.floor !== fact.floor) return "Journal evidence is unknown or corrupted.";
    }
    const facts = new Set(state.facts.map((fact) => fact.id));
    if (state.secretKnown !== facts.has("handler_secret")) return "The Handler evidence flag is inconsistent.";
    if (state.secretKnown) {
      const completed = Object.entries(runtime.completedConversations)
        .filter(([id]) => id !== "meera").reduce((sum, [, count]) => sum + count, 0);
      if (!CORE_FACTS.every((id) => facts.has(id))
        || (!(state.visitorLog && state.authorization) && !(runtime.completedConversations.kulkarni >= 1 && completed >= 2))) {
        return "The Handler lead lacks its prerequisite story progression.";
      }
    }
    if (state.visitorLog && !state.ledger.some((claim) => claim.npcId === "priya"
      && claim.field === "name" && sameValue(claim.value, state.visitorLog ?? ""))) return "The visitor log has no reception claim.";
    if (state.authorization) {
      const authorization = state.authorization;
      const known = state.ledger.filter((claim) => runtime.heardClaims[authorization.by].includes(claim.id));
      if (authorization.at > state.elapsedSeconds || !known.some((claim) =>
        claim.field === "name" && sameValue(claim.value, authorization.name))) return "The authorizer never knew that alias.";
      if (state.visitorLog && !sameValue(state.visitorLog, authorization.name)) return "The official records disagree on the alias.";
      if (authorization.by === "dev" && !known.some((claim) =>
        (claim.field === "ticket" && isFictionalTicket(claim.value))
        || (claim.field === "employeeId" && isFictionalEmployeeId(claim.value)))) return "Dev's authorization lacks a fictional credential.";
      if (authorization.by === "anita" && (!facts.has("cfo_away") || !known.some((claim) => claim.field === "company"))) {
        return "Anita's authorization lacks itinerary knowledge or a company.";
      }
    }
    if (state.player.carryingCard && (!state.visitorLog || !state.authorization
      || !sameValue(state.visitorLog, state.authorization.name))) return "A carried card lacks matching official records.";
    const atExit = state.floor === 1 && floor.exit && distance(state.player, floor.exit) <= EXIT_DISTANCE;
    if ((state.ending === "clean" || state.ending === "flagged") && (!state.player.carryingCard || !atExit)) return "The completed collection ending has no card or exit.";
    if (state.ending === "double-cross" && (!state.secretKnown || !atExit)) return "The outgoing report lacks Handler evidence or an exit.";
    if (state.ending === "burned" && (!state.meeraCalled || !state.meeraResolved)) return "A burned cover bypassed the security call.";
    if (state.ending === "clock-out" && state.clockMinute < GAME_END_MINUTE && !atExit) return "An early clock-out did not occur at the exit.";

    if (!idsUnique(state.rumors) || !keysMatch(runtime.rumorPayloads, new Set(state.rumors.map((rumor) => rumor.id)))) {
      return "Rumor records and private payloads disagree.";
    }
    for (const rumor of state.rumors) {
      if (!definitionIds.has(rumor.from) || !definitionIds.has(rumor.to) || rumor.from === rumor.to
        || (rumor.delivered && rumor.at > state.elapsedSeconds)) return "A rumor has an invalid route or delivery time.";
      const payload = runtime.rumorPayloads[rumor.id];
      if (payload.claimIds.some((id) => !claimIds.has(id) || !runtime.heardClaims[rumor.from].includes(id))
        || payload.incidentIds.some((id) => !incidentIds.has(id) || !runtime.heardIncidents[rumor.from].includes(id))) {
        return "A rumor contains evidence its sender never knew.";
      }
      if (rumor.delivered && (payload.claimIds.some((id) => !runtime.heardClaims[rumor.to].includes(id))
        || payload.incidentIds.some((id) => !runtime.heardIncidents[rumor.to].includes(id)))) return "A delivered rumor is absent from the recipient's memory.";
    }
    if (!idsUnique(state.transcripts) || state.transcripts.some((line) =>
      line.at > state.elapsedSeconds || (line.npcId !== "handler" && !definitionIds.has(line.npcId))
      || ((line.speaker === "handler") !== (line.npcId === "handler")))) return "The transcript history is inconsistent.";
    if (!idsUnique(state.events) || state.events.some((event) => event.at > state.elapsedSeconds
      || (event.npcId && !definitionIds.has(event.npcId)))) return "The event history is inconsistent.";
    const conversation = runtime.conversation;
    if (conversation && (conversation.claimIds.some((id) => !state.ledger.some((claim) =>
      claim.id === id && claim.npcId === conversation.npcId))
      || conversation.factIds.some((id) => !facts.has(id))
      || conversation.playerTurnIds.some((id) => !state.transcripts.some((line) =>
        line.id === id && line.final && line.speaker === "player" && line.npcId === conversation.npcId)))) {
      return "The active conversation references missing turns or evidence.";
    }
    for (const [npcId, actor] of Object.entries(runtime.actors)) {
      const definition = definitions.get(npcId);
      const npc = state.npcs.find((candidate) => candidate.id === npcId);
      if (!definition || !npc) return "An actor runtime has no definition.";
      if (npc.floor === 0) {
        if (actor.path.length || actor.target || actor.peerId) return "Remote Meera cannot have a physical route.";
        continue;
      }
      const plan = floors[npc.floor - 1];
      if (actor.peerId && definitions.get(actor.peerId)?.floor !== npc.floor) return "An actor's target peer is on another floor.";
      if (actor.target && (!canOccupy(plan, actor.target) || findPath(plan, npc, actor.target).length === 0)) return "An actor target is unreachable.";
      let previous: Point | null = null;
      for (const point of actor.path) {
        if (!canOccupy(plan, point) || point.x % 1 !== 0.5 || point.y % 1 !== 0.5
          || (previous && Math.abs(previous.x - point.x) + Math.abs(previous.y - point.y) !== 1)) return "An actor path crosses a wall or skips tiles.";
        previous = point;
      }
      if (actor.path.length && distance(npc, actor.path[0]) > 1.5) return "An actor route does not start near the actor.";
    }
    const generatedIds = [...state.events, ...state.ledger, ...state.rumors, ...runtime.incidents]
      .map((entry) => /^(?:event|claim|rumor|incident)-(\d+)$/.exec(entry.id));
    if (generatedIds.some((match) => !match || Number(match[1]) > runtime.sequence)) return "The event sequence counter is corrupted.";
    return null;
  }

  private finish(ending: Ending, message: string): void {
    if (this.state.phase === "ended") return;
    if (this.state.activeNpcId) this.closeConversation("The encounter ended with the mission.");
    this.state.phase = "ended";
    this.state.ending = ending;
    this.state.player.moving = false;
    this.runtime.approachId = null;
    this.runtime.security.pendingAt = null;
    this.runtime.security.repeatDeadline = null;
    this.emit("story", message);
    this.onEnding?.(ending);
  }
}
