# Game engine integration

`engine.ts` exports `GameEngine`. Construct with an optional numeric seed, attach
callbacks, display `HANDLER_BRIEFING`, and call `start(practiceMode)` after the
player's initial gesture. `start` does nothing to an already-playing run; after
an ending it starts a fresh run with the same seed and retained preferences.

The public contract is:

```ts
constructor(seed?: number)
state: GameState
floors: FloorPlan[]
definitions: NpcDefinition[]
start(practiceMode?: boolean): void
tick(dtSeconds: number, input: { x: number; y: number; running?: boolean }): void
applyAction(action: GameAction): ActionResult
applyDirector(reply: DirectorReply): void
getDirectorContext(): DirectorContext
getConversationContext(npcId: string): ConversationContext
beginConversation(npcId: string): boolean
endConversation(summary?: string): void
changeFloor(floor: number): boolean
exitBuilding(): void
callMeeraForDoubleCross(): ActionResult
addTranscript(entry: TranscriptEntry): void
setPaused(paused: boolean): void
serialize(): string
restore(serialized: string): boolean
onEvent?: (event: GameEvent) => void
onEncounter?: (npcId: string) => void
onFloorChange?: (floor: number) => void
onEnding?: (ending: Ending) => void
```

Additional engine API:

- `canUseElevator: boolean`, `canExit: boolean` are read-only proximity queries.
- `securitySecondsRemaining: number | null` is the live incoming-call allowance.
- `setConversationClockRunning(running: boolean): void` enables that allowance
  only while the player can answer. It defaults to **false** on every encounter.
- `setConversationWaiting(waiting: boolean): void` is an inverse alias.
- `conversationClockRunning: boolean` also respects explicit pause.
- Exported constants: `GAME_START_MINUTE` (540), `GAME_END_MINUTE` (1080),
  `GAME_DAY_SECONDS` (1440), `ELEVATOR_DISTANCE` (2.4), `EXIT_DISTANCE` (1.6),
  `CONVERSATION_DISTANCE` (2.4), `SECURITY_RESPONSE_SECONDS` (30), and
  `SUSPICION_THRESHOLDS` (`verify: 40`, `stall: 70`, `escalate: 85`).
- `normalizeAlias(value: string): string` folds whitespace and case, not spelling
  or punctuation.

## Render loop and encounters

Positions are floating-point **tile coordinates**, with integer tile boundaries
and centers at `.5`. Every floor is 30 by 26; tiles are flat row-major arrays.
Render rooms, walls, doors, desks, and characters independently of generated art.
Doors are always traversable; a restricted room is a social rule, not an invisible
collision lock. NPC bodies never block the player.

Call `tick` from the animation loop. It clamps catch-up to 0.25 seconds and
substeps movement to prevent tunneling. Nine in-game hours span 1440 accepted
simulation seconds. `setPaused(true)` stops the clock, movement, gossip, and
security timers; use it for a hidden tab and an explicit pause menu. Briefing and
ending phases never advance time. Ordinary conversation does not itself pause the
mission clock, although UI/network waiting may explicitly pause the whole game.

`onEncounter` fires **after** `state.activeNpcId` has been set. Do not call
`beginConversation` a second time in that callback. Player movement stops until
the conversation ends. Offer a visible walk-away control calling
`endConversation`. Automatic encounters have a seven-second leave grace and a
45-second per-NPC cooldown; explicit nearby interaction can re-engage sooner.
There is a five-second arrival grace on a new floor.

At Meera's incoming call, set `setConversationClockRunning(true)` only while
listening or accepting text. Set it false while connecting, buffering, generating,
playing the AI's speech, or waiting for tools. Pause always wins. At timeout or an
explicit hang-up, **evidence**, not silence, determines warning versus burned.
There is only one incoming call. A new documented escalation after a warning gives
twenty seconds to exit before a further evidence-based outcome.

Model actions require the exact active NPC. `end_conversation` immediately closes
that capability; send it last in an action sequence. Late tools are rejected.
The last NPC's farewell transcript may arrive for eight simulation seconds after
closing. Transcript timestamps are assigned from the engine clock, and finalized
lines cannot be rewritten. Keep external transcript IDs unique.

## Floor controls

All floors use spawn `(14.5, 21.5)` and elevator center `(15.5, 23.5)`.
`changeFloor` requires speaking to nobody and being within 2.4 tiles of the core.
It can run while a floor-picker menu has paused simulation. There are no locked
elevator floors. Invalid actions return false or emit a visible system event.

The floor-1 exit center is `(14.5, 24.5)` with a 1.6-tile interaction radius.
Exiting is explicit, not triggered by merely stepping on an exit tile. Leaving
with a card ends clean or flagged; leaving early without one abandons the
assignment as clock-out. Reaching 18:00 inside also produces clock-out.
Call `callMeeraForDoubleCross()` **before** `exitBuilding()` when the exit action
menu offers a Handler report. The method checks genuine Handler evidence and
finishes double-cross without requiring a card or a real phone call.

## Deterministic dialogue gates

| Actor | Capability | Required state |
| --- | --- | --- |
| Priya, floor 1 | `register` | Stated invented name, company, and host **or** work role |
| Dev, floor 4 | `authorize` | Consistent name and a stated fictional `MT-...` ticket or `MT-ID-...` employee prop |
| Anita, floor 11 | `authorize` | Consistent name/company and previously learned `cfo_away` |
| Ramesh, floor 2 | `issue_card` | Stated alias matches both visitor log and Dev/Anita authorization exactly after case/whitespace normalization |
| Kulkarni, floor 3 | `discover` | Only known and currently available story facts |
| Meera, remote floor 0 | `security_resolution` | Active incoming call; engine computes the outcome from actual reports |

NPCs may make claims, propose bounded suspicion changes, end conversations, and
reveal only IDs in their **context's** `npc.knowledge`. Main character definitions
do not grant another character's tools. Meera is remote and is not drawn on a
floor. The cast has 65 physical actors: five or six on each floor.

Callbacks are optional and must be invented `SIM-####` codes. Never collect real
phone numbers or identification. Tickets use `MT-` plus at least three
alphanumeric characters; employee props use `MT-ID-` plus at least three.

The Handler lead requires `access_rules`, `cfo_away`, and `server_room`, plus
either both official records or a completed meaningful Kulkarni visit and two
meaningful completed conversations overall. An empty walk-away does not count.
A new claim, new fact, successful mission step, or two substantial final player
turns makes a conversation meaningful. `server_observation` is optional physical
reconnaissance from the public corridor by the floor-7 blue door; it never
substitutes for `handler_secret`.

Positive model suspicion needs an observed incident ID, or an associated claim
ID/exact quote. A feeling, accent, camera cue, or hesitation is not evidence.
Proposals clamp to -20 through +30 and meters to 0 through 100. One incident
cannot be repeatedly charged; one conversation can apply one clarification
reduction. The original claims and quotes remain intact.

## Private context and persistence

Only `getConversationContext` should feed a dialogue model. Its cover and claims
are reconstructed from that NPC's own statements and **delivered** private notes,
not the global player cover. Institutional records are visible only to the
appropriate desks. Fact and secret fields are filtered to recipient knowledge;
Anita and Priya do not learn the Handler's secret through global state. Director
context has operational state, not private conversational memories.

Gossip is seeded, delayed, and directed: Priya -> Dev .4, Priya -> Anita .6,
Anita -> Meera .8, Ramesh -> Meera .7, Kulkarni -> Ramesh .12. Only selected known
claims and actual incident references travel, never the global ledger or every
discovered fact. A formal escalation also sends its specific evidence to Meera.

Persist `serialize()` rather than just `state`: its versioned envelope includes
private knowledge, delayed payloads, routines, random state, conversations, and
remaining answer time. `restore` validates shape, version, references, geography,
story prerequisites, and mission invariants before replacing anything. Failure
keeps the current game and emits a system diagnostic. Successful live restores
are paused with conversation answer time disabled. Reconnect the active dialogue
after the player's explicit resume; restore fires `onFloorChange`, not
`onEncounter`. Treat state as read-only apart from the typed UI settings.

`navigation.ts` exports `isWalkable`, `findPath`, `canOccupy`, `distance`,
`hasLineOfSight`, and `roomAt`. A* uses four-neighbor paths, returns tile centers
including both endpoints, and returns `[]` for blocked or unreachable endpoints.
`world.ts` exports `createFloors`, `FLOOR_WIDTH`, and `FLOOR_HEIGHT`.
