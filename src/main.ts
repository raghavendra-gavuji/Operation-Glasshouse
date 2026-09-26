import type { ActionResult, DialogueReply, Ending, GameAction, GameEvent, GameState, NpcDefinition, VoiceStatus } from "../shared/types";
import { HANDLER_BRIEFING } from "../shared/story";
import { VoiceClient } from "./audio";
import { GameEngine, GAME_END_MINUTE, SUSPICION_THRESHOLDS, normalizeAlias } from "./game/engine";
import { OfficeRenderer } from "./renderer";
import { ArtCache } from "./ui/assets";
import { MovementInput, isTextTarget } from "./ui/controls";
import { canAnswerConversation } from "./ui/conversation";
import { DirectorLoop } from "./ui/director";
import { readApiError } from "./ui/http";
import { ENDING_COPY, clockLabel, escapeHtml, eventClock, fieldLabel, missionRank } from "./ui/mission";
import { practiceOptions, practiceText, type PracticeOption } from "./ui/practice";
import { narrationChunks, TranscriptAssembler } from "./ui/transcripts";

const SAVE_KEY = "glasshouse.mission.v1";
const get = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required interface element #${id} is missing.`);
  return element as T;
};
const show = (id: string, visible: boolean): void => { get(id).hidden = !visible; };
const text = (id: string, value: string): void => {
  const element = get(id);
  if (element.textContent !== value) element.textContent = value;
};

let engine = new GameEngine();
const art = new ArtCache();
const renderer = new OfficeRenderer(get<HTMLCanvasElement>("world"), art);
const assembler = new TranscriptAssembler();
let started = false;
let starting = false;
let conversationId: string | null = null;
let pendingEnd = false;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
let textController: AbortController | undefined;
let transport: "live" | "text" | "practice" = "text";
let voiceStatus: VoiceStatus = "idle";
let busy = false;
let liveReplyPending = false;
let microphoneMuted = false;
let soundMuted = false;
let intentionalDisconnect = true;
let narrationPlaying = false;
let audioPreparation: Promise<void> = Promise.resolve();
let savedMission: string | null = null;
let storageFailed = false;
let selectedFloor = 1;
let ledgerTab = "claims";
let activeModal: string | null = null;
let providerConfigured: boolean | null = null;
let providerHealthy = true;
let providerNoticeSource: "director" | "connection" | null = null;
let directorReady = false;
let narrationPending = false;
let encounterVersion = 0;
let pausedTransport = false;
let lastFrame = performance.now();
let lastHud = 0;
let lastPaths = 0;
let autosaveAt = 0;
let lastStateSignature = "";
const debugEntries: string[] = [];

const voice = new VoiceClient({
  onStatus(status) {
    voiceStatus = status;
    if (!intentionalDisconnect && transport === "live" && (status === "listening" || status === "speaking")) clearProviderError("connection");
    updateVoiceStatus();
  },
  onTranscript(entry) {
    if (!conversationId) return;
    const result = assembler.receive(entry.speaker, entry.text, entry.final);
    text(entry.speaker === "npc" ? "npc-caption" : "player-caption", result.text);
    if (entry.speaker === "npc") renderer.setSpeech(conversationId, result.text);
    if (result.commit) recordTranscript(entry.speaker, result.text);
    if (entry.speaker === "player") {
      liveReplyPending = true;
      updateVoiceStatus();
    }
  },
  onAction(action, requestId) {
    liveReplyPending = true;
    updateVoiceStatus();
    const result = applyGameAction(action);
    voice.respondToTool(requestId, result);
    if (conversationId) voice.updateContext(engine.getConversationContext(conversationId));
    if (result.accepted && !engine.state.activeNpcId && conversationId) waitForFarewell();
  },
  onTurnComplete() {
    liveReplyPending = false;
    finishTranscriptTurn();
    if (pendingEnd || engine.state.phase === "ended") closeConversation();
    else updateVoiceStatus();
  },
  onLevel(level) {
    get("voice-indicator").style.height = `${Math.round(6 + Math.min(1, level) * 7)}px`;
  },
  onError(message) {
    if (!started || intentionalDisconnect) return;
    debug(`Voice · error · ${message}`);
    showProviderError(`Gemini voice: ${message} You can continue by typing, or retry the connection.`);
    if (conversationId && !pendingEnd && transport === "live") {
      transport = "text";
      busy = false;
      liveReplyPending = false;
      disconnectVoice();
      updateVoiceStatus();
    }
  },
  onClose(reason) {
    if (intentionalDisconnect || !conversationId) return;
    if (pendingEnd) {
      closeConversation();
      return;
    }
    transport = "text";
    busy = false;
    liveReplyPending = false;
    showProviderError(`Gemini voice connection ended: ${reason} Typed Gemini replies remain available.`);
    updateVoiceStatus();
  },
});

const input = new MovementInput(() => started && engine.state.phase === "playing" && !engine.state.paused && !conversationId && !activeModal);
const director = new DirectorLoop({
  context: () => engine.getDirectorContext(),
  enabled: () => started && engine.state.phase === "playing" && !engine.state.paused && !engine.state.practiceMode,
  onReply(reply, latency) {
    engine.applyDirector(reply);
    providerHealthy = true;
    directorReady = true;
    clearProviderError("director");
    debug(`Gemini director · ${latency} ms · floor ${engine.state.floor} · ${reply.intents.length} decisions`);
    updateConnection();
  },
  onError(message, retryIn) {
    providerHealthy = false;
    directorReady = false;
    debug(`Gemini director · unavailable · retry in ${retryIn}s · ${message}`);
    showProviderError(`Gemini director unavailable: ${message} Retrying in ${retryIn}s. Local movement continues.`, "director");
    updateConnection();
  },
});

bindEngine();
bindInterface();
readSave();
applySettings();
installTestInspection();
art.onChange = () => {
  renderer.invalidateArt();
  updateArt();
};
art.onError = (message) => {
  text("art-status", `Art loading: ${message}`);
  debug(`Artwork · ${message}`);
  if (started) announce(`Artwork unavailable: ${message}`);
};
void art.load();
void checkProvider();
requestAnimationFrame(frame);

function bindEngine(): void {
  engine.onEncounter = (npcId) => { void startConversation(npcId); };
  engine.onFloorChange = (floor) => {
    input.clear();
    renderer.center();
    showFloorArrival(typeof floor === "number" ? floor : engine.state.floor);
    void art.prefetchFloors([engine.state.floor - 1, engine.state.floor, engine.state.floor + 1]);
    director.nudge();
    saveMission();
  };
  engine.onEvent = (event) => {
    if (event.kind === "gossip" || event.kind === "story") addGossip(event);
    if (["story", "claim", "gossip"].includes(event.kind)) director.nudge();
    if (event.kind === "claim" || event.kind === "story") saveMission();
    if (event.kind === "system" && /reject|cannot|unable|error/i.test(event.text)) announce(event.text);
  };
  engine.onEnding = (ending) => showReport(ending);
}

function bindInterface(): void {
  get("start-live").addEventListener("click", () => { void startMission(false); });
  get("start-practice").addEventListener("click", () => { void startMission(true); });
  get("resume-button").addEventListener("click", () => { void startMission(false, true); });
  get("retry-provider").addEventListener("click", () => { void retryProvider(); });
  get("switch-practice").addEventListener("click", () => switchToPractice());
  get("dismiss-banner").addEventListener("click", () => show("provider-banner", false));
  get("ledger-button").addEventListener("click", () => openLedger());
  get("settings-button").addEventListener("click", () => openModal("settings-dialog"));
  get("pause-button").addEventListener("click", () => pauseMission());
  get("resume-play").addEventListener("click", () => closeModal("pause-dialog"));
  get("pause-save").addEventListener("click", () => returnToTitle());
  get("sound-button").addEventListener("click", () => {
    soundMuted = !soundMuted;
    voice.setVolume(soundMuted ? 0 : engine.state.settings.volume);
    text("sound-button", soundMuted ? "Sound off" : "Sound on");
    get("sound-button").setAttribute("aria-pressed", String(soundMuted));
    get("sound-button").setAttribute("aria-label", soundMuted ? "Unmute sound" : "Mute sound");
  });
  get<HTMLInputElement>("volume-input").addEventListener("input", (event) => {
    engine.state.settings.volume = Number((event.currentTarget as HTMLInputElement).value);
    soundMuted = engine.state.settings.volume === 0;
    voice.setVolume(engine.state.settings.volume);
    text("sound-button", soundMuted ? "Sound off" : "Sound on");
    saveMission();
  });
  get<HTMLInputElement>("captions-input").addEventListener("change", (event) => {
    engine.state.settings.captions = (event.currentTarget as HTMLInputElement).checked;
    applySettings();
    saveMission();
  });
  get<HTMLInputElement>("motion-input").addEventListener("change", (event) => {
    engine.state.settings.reducedMotion = (event.currentTarget as HTMLInputElement).checked;
    applySettings();
    saveMission();
  });
  get<HTMLInputElement>("camera-input").addEventListener("change", (event) => {
    const checkbox = event.currentTarget as HTMLInputElement;
    const requested = checkbox.checked;
    checkbox.disabled = true;
    text("camera-status", requested ? "Waiting for your separate camera permission…" : "Turning camera off…");
    void voice.setCameraEnabled(requested).then(() => {
      engine.state.settings.camera = requested;
      text("camera-status", requested ? "Camera enabled for live conversations. No facial analysis or honesty scoring." : "Camera off. No facial analysis or honesty scoring.");
    }).catch((error: unknown) => {
      engine.state.settings.camera = false;
      checkbox.checked = false;
      text("camera-status", `Camera remains off: ${errorMessage(error)} You can play without it.`);
    }).finally(() => {
      checkbox.disabled = false;
      saveMission();
    });
  });
  get("reset-button").addEventListener("click", () => show("reset-confirm", true));
  get("cancel-reset").addEventListener("click", () => show("reset-confirm", false));
  get("confirm-reset").addEventListener("click", () => eraseProgress());
  get("briefing-replay").addEventListener("click", () => { void playBriefing(); });
  get("briefing-skip").addEventListener("click", () => { void playBriefing(); });
  get("leave-conversation").addEventListener("click", () => {
    if (busy) {
      textController?.abort();
      busy = false;
    }
    if (conversationId) engine.endConversation("The visitor chose to leave the conversation.");
    closeConversation();
  });
  get("mic-button").addEventListener("click", () => { void toggleMicrophone(); });
  get<HTMLFormElement>("dialogue-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const element = get<HTMLInputElement>("dialogue-input");
    const value = element.value.trim();
    if (!value || !conversationId || busy || pendingEnd) return;
    element.value = "";
    void sendReply(value);
  });
  get("elevator-button").addEventListener("click", () => openElevator());
  get("exit-button").addEventListener("click", () => {
    if (!engine.canExit) return;
    if (!engine.state.player.carryingCard) openModal("exit-dialog");
    else engine.exitBuilding();
  });
  get("confirm-exit").addEventListener("click", () => {
    closeModal("exit-dialog");
    engine.exitBuilding();
  });
  get("double-cross-button").addEventListener("click", () => {
    const result = engine.callMeeraForDoubleCross();
    if (!result.accepted) announce(result.message);
  });
  get("debug-button").addEventListener("click", toggleDebug);
  get("debug-close").addEventListener("click", toggleDebug);
  get("report-ledger").addEventListener("click", () => openLedger());
  get("replay-button").addEventListener("click", () => {
    const practice = engine.state.practiceMode;
    resetEngine();
    void startMission(practice);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-close]")) {
    button.addEventListener("click", () => closeModal(button.dataset.close ?? ""));
  }
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      closeModal(dialog.id);
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-ledger]")) {
    button.addEventListener("click", () => {
      ledgerTab = button.dataset.ledger ?? "claims";
      renderLedger();
    });
  }
  window.addEventListener("keydown", (event) => {
    if (event.key === "F1") {
      event.preventDefault();
      toggleDebug();
      return;
    }
    if (isTextTarget(event.target) || event.ctrlKey || event.metaKey || event.altKey || !started) return;
    if (activeModal === "elevator-dialog" && ["ArrowUp", "ArrowDown", "Enter"].includes(event.key)) {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (event.key === "Enter" && target?.closest("[data-close]")) return;
      event.preventDefault();
      if (event.key === "Enter") travelToFloor(target?.dataset.floor ? Number(target.dataset.floor) : selectedFloor);
      else {
        selectedFloor = Math.max(1, Math.min(12, selectedFloor + (event.key === "ArrowUp" ? 1 : -1)));
        renderElevator();
        get("floor-list").querySelector<HTMLButtonElement>(`[data-floor="${selectedFloor}"]`)?.focus({ preventScroll: true });
      }
      return;
    }
    if (activeModal) return;
    if (event.key.toLowerCase() === "l") {
      event.preventDefault();
      openLedger();
    } else if (event.key === "Escape") {
      event.preventDefault();
      pauseMission();
    } else if (event.key === "Enter" && engine.canUseElevator && !conversationId && !(event.target instanceof HTMLElement && event.target.closest("button, a"))) {
      event.preventDefault();
      openElevator();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden && started && engine.state.phase === "playing") pauseMission();
  });
  window.addEventListener("blur", () => {
    input.clear();
  });
  window.addEventListener("pagehide", () => {
    saveMission();
    disconnectVoice();
  });
}

async function checkProvider(): Promise<boolean> {
  try {
    const response = await fetch("/api/health", { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`Health endpoint returned HTTP ${response.status}.`);
    const health: unknown = await response.json();
    if (!health || typeof health !== "object" || !("configured" in health) || typeof health.configured !== "boolean") throw new Error("Health endpoint returned an invalid response.");
    providerConfigured = health.configured;
    if (providerConfigured) {
      text("provider-state", "Gemini configured · Live voice and generated conversations");
      get("provider-state").classList.remove("error");
      return true;
    }
    throw new Error("No Gemini server key is configured. Set GEMINI_API_KEY in the server .env file, or choose practice.");
  } catch (error) {
    providerConfigured = false;
    text("provider-state", `Gemini unavailable. ${errorMessage(error)}`);
    get("provider-state").classList.add("error");
    return false;
  }
}

async function startMission(practice: boolean, resume = false): Promise<void> {
  if (starting || started) return;
  starting = true;
  if (!practice && !resume && providerConfigured === false) {
    void checkProvider();
    starting = false;
    text("provider-state", "Checking Gemini again. If the server key is unavailable, choose Practice without AI.");
    return;
  }
  if (resume && savedMission) {
    if (!engine.restore(savedMission)) {
      announce("That saved mission cannot be restored. Start a new mission.");
      starting = false;
      return;
    }
    practice = engine.state.practiceMode;
  } else {
    engine.start(practice);
  }
  engine.state.settings.camera = false;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) engine.state.settings.reducedMotion = true;
  started = true;
  starting = false;
  show("opening", false);
  show("mission-report", false);
  for (const id of ["topbar", "dossier", "movement-hint"]) show(id, true);
  show("touch-controls", matchMedia("(pointer: coarse)").matches || window.innerWidth <= 760);
  document.body.classList.remove("security");
  applySettings();
  engine.setPaused(false);
  if (!practice) {
    audioPreparation = voice.prepare().catch((error: unknown) => {
      showProviderError(`Microphone unavailable: ${errorMessage(error)} Continue with typed replies; camera is not required.`);
      transport = "text";
    });
    director.start();
  } else {
    transport = "practice";
    audioPreparation = Promise.resolve();
    debug("Practice · scripted dialogue · local routines · no AI requests");
  }
  if (engine.state.phase === "ended" && engine.state.ending) {
    showReport(engine.state.ending);
    return;
  }
  const activeNpc = engine.state.activeNpcId;
  if (activeNpc) {
    await startConversation(activeNpc);
  } else if (!practice && !resume) {
    void audioPreparation.then(() => {
      if (!conversationId && started && !activeModal) void playBriefing();
    });
  }
  showFloorArrival(engine.state.floor);
  void art.prefetchFloors([engine.state.floor - 1, engine.state.floor, engine.state.floor + 1]);
  updateHud();
  saveMission();
  get("world").focus({ preventScroll: true });
}

async function startConversation(npcId: string): Promise<void> {
  if (!started || engine.state.phase !== "playing" || conversationId === npcId) return;
  const npc = engine.definitions.find((definition) => definition.id === npcId);
  if (!npc) {
    announce(`A character definition is missing for ${npcId}.`);
    engine.endConversation("Conversation could not start because its character definition was unavailable.");
    return;
  }
  const version = ++encounterVersion;
  input.clear();
  disconnectVoice();
  textController?.abort();
  busy = false;
  liveReplyPending = false;
  pendingEnd = false;
  narrationPlaying = false;
  narrationPending = false;
  show("briefing-skip", false);
  text("briefing-replay", "Listen to the briefing");
  conversationId = npcId;
  assembler.clear();
  engine.setConversationWaiting(true);
  document.body.classList.add("in-conversation");
  document.body.classList.toggle("security", npcId === "meera");
  show("conversation", true);
  show("security-overlay", npcId === "meera");
  text("speaker-name", npc.name);
  text("speaker-role", npc.role);
  text("speaker-initials", npc.name.split(" ").map((part) => part[0]).slice(0, 2).join(""));
  text("npc-caption", engine.state.practiceMode ? npc.greeting : "One moment…");
  text("player-caption", "");
  get<HTMLInputElement>("dialogue-input").value = "";
  setImage("speaker-portrait", `portrait-${npcId}`);
  show("practice-options", engine.state.practiceMode);
  show("mic-button", !engine.state.practiceMode);
  if (engine.state.practiceMode) {
    transport = "practice";
    text("conversation-mode-note", "Practice mode · scripted choices, no AI.");
    recordTranscript("npc", npc.greeting);
    renderer.setSpeech(npcId, npc.greeting);
    renderPracticeOptions();
    updateVoiceStatus();
    return;
  }
  text("conversation-mode-note", "Fictional story interpretation, not a lie detector.");
  transport = "live";
  voiceStatus = "connecting";
  updateVoiceStatus();
  await audioPreparation;
  if (conversationId !== npcId || version !== encounterVersion || activeModal) return;
  voice.setMuted(microphoneMuted);
  if (!voice.micEnabled) {
    await beginTextConversation(npc, version);
    return;
  }
  try {
    intentionalDisconnect = false;
    await voice.connect(engine.getConversationContext(npcId));
    if (version !== encounterVersion || conversationId !== npcId) return;
    voice.setMuted(microphoneMuted);
    updateVoiceStatus();
  } catch (error) {
    if (version !== encounterVersion) return;
    showProviderError(`Gemini voice could not connect: ${errorMessage(error)} Typed Gemini conversation is available below.`);
    await beginTextConversation(npc, version);
  }
}

async function beginTextConversation(npc: NpcDefinition, version: number): Promise<void> {
  transport = "text";
  busy = false;
  text("npc-caption", npc.greeting);
  renderer.setSpeech(npc.id, npc.greeting);
  recordTranscript("npc", npc.greeting);
  narrationPending = true;
  updateVoiceStatus();
  engine.setConversationWaiting(true);
  try {
    await voice.playNarration(npc.greeting, npc.voiceName);
  } catch (error) {
    if (version === encounterVersion) showProviderError(`Gemini speech unavailable: ${errorMessage(error)} Captions and typed dialogue remain available.`);
  } finally {
    if (version === encounterVersion) {
      narrationPending = false;
      updateVoiceStatus();
    }
  }
}

async function sendReply(value: string): Promise<void> {
  const npcId = conversationId;
  if (!npcId || pendingEnd || busy) return;
  const npc = engine.definitions.find((definition) => definition.id === npcId);
  if (!npc) return;
  if (engine.state.practiceMode) {
    runPracticeOption(practiceText(value, engine.state, npc));
    return;
  }
  if (transport === "live" && voiceStatus !== "error" && voiceStatus !== "idle") {
    liveReplyPending = true;
    updateVoiceStatus();
    voice.sendText(value);
    return;
  }
  transport = "text";
  busy = true;
  const version = encounterVersion;
  const controller = new AbortController();
  textController = controller;
  const timeout = setTimeout(() => controller.abort(), 30_000);
  recordTranscript("player", value);
  text("player-caption", value);
  updateVoiceStatus();
  const requestedAt = performance.now();
  try {
    const response = await fetch("/api/dialogue", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: engine.getConversationContext(npcId), text: value }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await readApiError(response));
    const result: unknown = await response.json();
    if (!isDialogueReply(result)) throw new Error("Gemini returned an invalid dialogue response.");
    if (version !== encounterVersion || conversationId !== npcId) return;
    clearProviderError("connection");
    debug(`Gemini dialogue · ${Math.round(performance.now() - requestedAt)} ms · ${npc.name}`);
    for (const action of result.actions) {
      const applied = applyGameAction(action);
      if (applied.accepted && !engine.state.activeNpcId) pendingEnd = true;
    }
    text("npc-caption", result.reply);
    renderer.setSpeech(npcId, result.reply);
    recordTranscript("npc", result.reply);
    if (pendingEnd) syncPause();
    try {
      for (const chunk of narrationChunks(result.reply)) {
        if (version !== encounterVersion) break;
        await voice.playNarration(chunk, npc.voiceName);
      }
    } catch (error) {
      if (version === encounterVersion) showProviderError(`Gemini speech unavailable: ${errorMessage(error)} The reply is still shown in captions.`);
    }
    if ((pendingEnd || engine.state.phase === "ended") && version === encounterVersion) closeConversation();
  } catch (error) {
    if (version === encounterVersion && conversationId === npcId) {
      const message = error instanceof Error && error.name === "AbortError" ? "Gemini took too long to respond." : errorMessage(error);
      showProviderError(`${message} Your mission is still here. Try sending again, retry Gemini, or explicitly choose practice.`);
      text("npc-caption", "The connection dropped. Your reply is in the ledger; you can try again.");
      debug(`Gemini dialogue · error · ${message}`);
    }
  } finally {
    clearTimeout(timeout);
    if (version === encounterVersion) {
      busy = false;
      liveReplyPending = false;
      textController = undefined;
      updateVoiceStatus();
    }
  }
}

function applyGameAction(action: GameAction): ActionResult {
  if (pendingEnd) return { accepted: false, message: "This conversation has already ended." };
  const result = engine.applyAction(action);
  debug(`Story tool · ${action.type} · ${result.accepted ? "accepted" : "rejected"} · ${result.message}`);
  if (!result.accepted) announce(result.message);
  updateHud();
  saveMission();
  return result;
}

function runPracticeOption(option: PracticeOption): void {
  if (!conversationId || pendingEnd) return;
  const npcId = conversationId;
  recordTranscript("player", option.text);
  text("player-caption", option.text);
  const results = option.actions.map((action) => applyGameAction(action));
  const rejected = results.find((result) => !result.accepted);
  const securityResolved = npcId === "meera" && !engine.state.activeNpcId;
  const reply = rejected ? rejected.message : securityResolved
    ? engine.state.ending === "burned" ? "The reports show repeated contradictions. This visit ends here, Ghost."
      : "One warning. The records do not justify ending your visit. Keep the paperwork consistent."
    : option.reply;
  text("npc-caption", reply);
  renderer.setSpeech(npcId, reply);
  recordTranscript("npc", reply);
  debug(`Practice · scripted option · ${option.id}`);
  if (!rejected && !engine.state.activeNpcId) {
    pendingEnd = true;
    syncPause();
    clearTimeout(closeTimer);
    closeTimer = setTimeout(closeConversation, 1000);
  } else {
    renderPracticeOptions();
    updateVoiceStatus();
  }
}

function renderPracticeOptions(): void {
  const container = get("practice-options");
  container.replaceChildren();
  const npc = engine.definitions.find((definition) => definition.id === conversationId);
  if (!npc) return;
  for (const option of practiceOptions(engine.state, npc)) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = option.label;
    button.dataset.practice = option.id;
    button.addEventListener("click", () => runPracticeOption(option));
    container.append(button);
  }
  get<HTMLInputElement>("dialogue-input").placeholder = "Or type: My name is Arjun Rao";
}

function waitForFarewell(): void {
  pendingEnd = true;
  voice.setMuted(true);
  engine.setConversationWaiting(true);
  syncPause();
  text("voice-status", "Finishing conversation…");
  clearTimeout(closeTimer);
  closeTimer = setTimeout(() => {
    debug("Voice · farewell close after maximum 15s wait");
    finishTranscriptTurn();
    closeConversation();
  }, 15_000);
}

function closeConversation(): void {
  clearTimeout(closeTimer);
  finishTranscriptTurn();
  encounterVersion += 1;
  textController?.abort();
  textController = undefined;
  disconnectVoice();
  if (engine.state.activeNpcId) engine.endConversation("The conversation concludes.");
  conversationId = null;
  pendingEnd = false;
  busy = false;
  liveReplyPending = false;
  narrationPending = false;
  assembler.clear();
  show("conversation", false);
  show("security-overlay", false);
  document.body.classList.remove("in-conversation", "security");
  engine.setConversationWaiting(true);
  syncPause();
  updateHud();
  saveMission();
}

function recordTranscript(speaker: "player" | "npc", content: string): void {
  if (!conversationId || !content.trim()) return;
  engine.addTranscript({ id: crypto.randomUUID(), npcId: conversationId, speaker, text: content.trim(), at: engine.state.elapsedSeconds, final: true });
  saveMission();
}

function finishTranscriptTurn(): void {
  for (const entry of assembler.finish()) recordTranscript(entry.speaker, entry.text);
}

function updateVoiceStatus(): void {
  document.body.classList.toggle("text-mode", transport !== "live");
  let label = "Waiting for an encounter";
  if (conversationId) {
    if (pendingEnd) label = "Finishing conversation";
    else if (engine.state.practiceMode) label = "Practice · scripted";
    else if (transport === "text") label = busy ? "Gemini is replying…" : "Text mode · your turn";
    else label = ({ idle: "Text replies available", connecting: "Connecting to Gemini…", listening: liveReplyPending ? "Gemini is replying…" : microphoneMuted ? "Mic muted · type a reply" : "Listening to you", speaking: "Speaking", error: "Voice unavailable · type instead" })[voiceStatus];
  }
  text("voice-status", label);
  const canAnswer = canAnswerConversation({
    active: !!conversationId, busy, narrating: narrationPending, ending: pendingEnd, paused: !!activeModal,
    transport, status: voiceStatus, awaitingReply: liveReplyPending,
  });
  engine.setConversationWaiting(!canAnswer);
  get<HTMLInputElement>("dialogue-input").disabled = !conversationId || busy || pendingEnd;
  get<HTMLButtonElement>("send-reply").disabled = !conversationId || busy || pendingEnd;
  text("mic-button", microphoneMuted ? "Unmute microphone" : voice.micEnabled ? "Mute microphone" : "Enable microphone");
  updateConnection();
}

function updateConnection(): void {
  let label = engine.state.practiceMode ? "Practice · no AI" : !providerHealthy ? "Gemini director unavailable" : conversationId ? transport === "live" ? "Gemini Live voice" : "Gemini text mode" : directorReady ? "Gemini director connected" : "Gemini director connecting";
  if (!started) label = "Waiting for an encounter";
  text("connection-text", label);
  get("connection-readout").classList.toggle("error", !providerHealthy && !engine.state.practiceMode);
}

async function toggleMicrophone(): Promise<void> {
  if (!conversationId) return;
  if ((voice.micEnabled || microphoneMuted) && transport === "live" && voiceStatus !== "idle" && voiceStatus !== "error") {
    microphoneMuted = !microphoneMuted;
    voice.setMuted(microphoneMuted);
    updateVoiceStatus();
    return;
  }
  audioPreparation = voice.prepare();
  try {
    await audioPreparation;
    if (!conversationId || activeModal) return;
    microphoneMuted = false;
    liveReplyPending = false;
    transport = "live";
    disconnectVoice();
    intentionalDisconnect = false;
    await voice.connect(engine.getConversationContext(conversationId));
    voice.setMuted(false);
    updateVoiceStatus();
  } catch (error) {
    transport = "text";
    liveReplyPending = false;
    showProviderError(`Microphone remains unavailable: ${errorMessage(error)} Keep playing by typing.`);
    updateVoiceStatus();
  }
}

async function retryProvider(): Promise<void> {
  if (!engine.state.practiceMode) audioPreparation = voice.prepare().catch((error: unknown) => {
    showProviderError(`Microphone unavailable: ${errorMessage(error)} Text mode is still available.`);
  });
  if (!await checkProvider()) {
    showProviderError(get("provider-state").textContent ?? "Gemini is not configured.");
    return;
  }
  providerHealthy = true;
  show("provider-banner", false);
  director.start();
  director.retry();
  if (conversationId && !engine.state.practiceMode) {
    const npcId = conversationId;
    conversationId = null;
    await startConversation(npcId);
  }
}

function switchToPractice(): void {
  engine.enablePracticeMode();
  encounterVersion += 1;
  textController?.abort();
  busy = false;
  liveReplyPending = false;
  narrationPending = false;
  director.stop();
  show("provider-banner", false);
  if (conversationId) {
    textController?.abort();
    disconnectVoice();
    transport = "practice";
    busy = false;
    show("practice-options", true);
    show("mic-button", false);
    text("conversation-mode-note", "Practice mode · scripted choices, no AI.");
    renderPracticeOptions();
    updateVoiceStatus();
  }
  announce("Practice mode enabled. Dialogue and routines are explicitly non-AI.");
  updateHud();
  saveMission();
}

async function playBriefing(): Promise<void> {
  if (narrationPlaying) {
    narrationPlaying = false;
    disconnectVoice();
    text("briefing-replay", "Listen to the briefing");
    show("briefing-skip", false);
    return;
  }
  if (conversationId || engine.state.practiceMode) {
    announce(engine.state.practiceMode ? HANDLER_BRIEFING : "Finish this conversation before calling the Handler.");
    return;
  }
  narrationPlaying = true;
  show("briefing-skip", true);
  text("briefing-replay", "Stop the briefing");
  text("handler-note", HANDLER_BRIEFING);
  try {
    await voice.playNarration(HANDLER_BRIEFING, "Charon");
  } catch (error) {
    if (started && !conversationId && !activeModal && !(error instanceof Error && error.name === "AbortError")) showProviderError(`The Handler's spoken briefing is unavailable: ${errorMessage(error)} The written briefing remains in your dossier.`);
  } finally {
    narrationPlaying = false;
    show("briefing-skip", false);
    text("briefing-replay", "Listen to the briefing");
  }
}

function disconnectVoice(): void {
  intentionalDisconnect = true;
  voice.disconnect();
}

function openModal(id: string): void {
  if (activeModal === id) return;
  if (pendingEnd) closeConversation();
  if (activeModal) get<HTMLDialogElement>(activeModal).close();
  activeModal = id;
  input.clear();
  if (conversationId && !engine.state.practiceMode) {
    pausedTransport = true;
    encounterVersion += 1;
    textController?.abort();
    busy = false;
    liveReplyPending = false;
    narrationPending = false;
    disconnectVoice();
  }
  if (narrationPlaying) {
    disconnectVoice();
    narrationPlaying = false;
    text("briefing-replay", "Listen to the briefing");
    show("briefing-skip", false);
  }
  syncPause();
  get<HTMLDialogElement>(id).showModal();
}

function closeModal(id: string): void {
  get<HTMLDialogElement>(id).close();
  if (activeModal === id) activeModal = null;
  syncPause();
  if (conversationId && pausedTransport && !engine.state.practiceMode) {
    pausedTransport = false;
    if (transport === "live") {
      intentionalDisconnect = false;
      void voice.connect(engine.getConversationContext(conversationId)).then(() => voice.setMuted(microphoneMuted)).catch((error: unknown) => {
        transport = "text";
        showProviderError(`Voice reconnect failed: ${errorMessage(error)} Continue by typing.`);
      }).finally(updateVoiceStatus);
    } else updateVoiceStatus();
  } else updateVoiceStatus();
}

function syncPause(): void {
  engine.setPaused(!!activeModal || pendingEnd || document.hidden);
}

function pauseMission(): void {
  if (!started || engine.state.phase !== "playing") return;
  if (activeModal) {
    syncPause();
    return;
  }
  openModal("pause-dialog");
  saveMission();
}

function openElevator(): void {
  if (!engine.canUseElevator || conversationId) return;
  selectedFloor = engine.state.floor;
  renderElevator();
  void art.prefetchFloors([selectedFloor - 1, selectedFloor + 1]);
  openModal("elevator-dialog");
  get("floor-list").querySelector<HTMLButtonElement>(`[data-floor="${selectedFloor}"]`)?.focus({ preventScroll: true });
}

function renderElevator(): void {
  const container = get("floor-list");
  container.replaceChildren();
  previewFloor(selectedFloor);
  for (const floor of [...engine.floors].reverse()) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.floor = String(floor.id);
    button.dataset.testid = `floor-${floor.id}`;
    button.classList.toggle("selected", floor.id === selectedFloor);
    button.classList.toggle("current", floor.id === engine.state.floor);
    button.setAttribute("aria-label", `Floor ${floor.id}, ${floor.name}${floor.id === engine.state.floor ? ", current floor" : ""}`);
    button.setAttribute("aria-pressed", String(floor.id === selectedFloor));
    button.innerHTML = `<span>${String(floor.id).padStart(2, "0")}</span><div><strong>${escapeHtml(floor.name)}</strong><small>${floor.id === engine.state.floor ? "You are here" : escapeHtml(floor.subtitle)}</small></div>`;
    button.addEventListener("click", () => travelToFloor(floor.id));
    button.addEventListener("pointerenter", () => {
      void art.prefetchFloors([floor.id]);
      previewFloor(floor.id);
    });
    container.append(button);
  }
}

function previewFloor(id: number): void {
  setImage("elevator-preview-image", `floor-${id}`);
  const floor = engine.floors.find((item) => item.id === id);
  if (floor) text("elevator-preview-caption", `${String(id).padStart(2, "0")} · ${floor.name}. Atmosphere preview, not a navigation map.`);
}

function travelToFloor(floor: number): void {
  closeModal("elevator-dialog");
  if (floor === engine.state.floor) return;
  if (!engine.changeFloor(floor)) announce("Stand next to the lift and finish your conversation before choosing a floor.");
}

function openLedger(): void {
  renderLedger();
  openModal("ledger-dialog");
}

function renderLedger(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-ledger]")) button.setAttribute("aria-pressed", String(button.dataset.ledger === ledgerTab));
  const state = engine.state;
  const name = (id: string): string => escapeHtml(engine.definitions.find((npc) => npc.id === id)?.name ?? id);
  let html = "";
  if (ledgerTab === "claims") {
    if (state.ledger.length) {
      html = `<table class="ledger-table"><thead><tr><th>Time</th><th>Who heard</th><th>Claim</th><th>Exact words</th></tr></thead><tbody>${state.ledger.map((claim) => `<tr><td>${eventClock(claim.at)}</td><td>${name(claim.npcId)}</td><td>${escapeHtml(fieldLabel(claim.field))}<br><strong>${escapeHtml(claim.value)}</strong>${claim.contradiction ? '<br><span class="contradiction-tag">STORY CHANGED</span>' : ""}</td><td class="ledger-quote">“${escapeHtml(claim.quote)}”</td></tr>`).join("")}</tbody></table>`;
    } else html = emptyLedger("No claims yet. Tell someone your cover name, and the exact words will appear here.");
  } else if (ledgerTab === "facts") {
    html = state.facts.length ? state.facts.map((fact) => `<article class="fact-entry"><h3>${escapeHtml(fact.title)}</h3><p>${escapeHtml(fact.text)}</p><small>Source: ${name(fact.source)}${fact.floor ? ` · Floor ${fact.floor}` : ""}</small></article>`).join("") : emptyLedger("You haven't learned the building's secrets yet. Mr. Kulkarni on floor 3 likes a conversation.");
  } else if (ledgerTab === "rumors") {
    html = state.rumors.length ? `<table class="ledger-table"><thead><tr><th>Time</th><th>From → to</th><th>What was shared</th></tr></thead><tbody>${state.rumors.map((rumor) => `<tr><td>${eventClock(rumor.at)}</td><td>${name(rumor.from)} → ${name(rumor.to)}<br><small>${rumor.delivered ? "Delivered" : "Not yet delivered"}</small></td><td>${escapeHtml(rumor.text)}</td></tr>`).join("")}</tbody></table>` : emptyLedger("No rumors recorded. What you say may travel after a conversation ends.");
  } else {
    html = state.transcripts.length ? `<table class="ledger-table"><thead><tr><th>Time</th><th>Speaker</th><th>Exact transcript</th></tr></thead><tbody>${state.transcripts.filter((entry) => entry.final).map((entry) => `<tr><td>${eventClock(entry.at)}</td><td>${entry.speaker === "player" ? "Ghost" : entry.speaker === "handler" ? "Handler" : name(entry.npcId)}</td><td>${escapeHtml(entry.text)}</td></tr>`).join("")}</tbody></table>` : emptyLedger("Completed voice transcriptions and typed replies appear here. No microphone audio or camera video is saved.");
  }
  get("ledger-content").innerHTML = html;
}

function emptyLedger(message: string): string {
  return `<p class="ledger-empty">${escapeHtml(message)}</p>`;
}

function showReport(ending: Ending): void {
  director.stop();
  input.clear();
  voice.setMuted(true);
  disableCamera();
  saveMission();
  show("mission-report", true);
  for (const id of ["topbar", "dossier", "movement-hint", "touch-controls", "conversation", "security-overlay", "nearby-actions", "provider-banner"]) show(id, false);
  document.body.classList.remove("security", "in-conversation");
  const copy = ending === "clock-out" && engine.state.clockMinute < GAME_END_MINUTE
    ? { title: "You walked away.", description: "No keycard. No job. Ghost leaves the assignment unfinished, while the tower carries on without them." }
    : ENDING_COPY[ending];
  text("report-title", copy.title);
  text("report-description", copy.description);
  text("report-rank", missionRank(engine.state));
  setImage("report-portrait", ending === "double-cross" ? "portrait-meera" : "portrait-ghost");
  const state = engine.state;
  const witnesses = new Set(state.ledger.map((claim) => claim.npcId)).size;
  get("report-summary").innerHTML = `<p><strong>${escapeHtml(state.cover.name || "No cover identity")}</strong>${state.cover.company ? ` · ${escapeHtml(state.cover.company)}` : ""}</p><p>Departed at <strong>${clockLabel(state.clockMinute)}</strong> · ${witnesses} ${witnesses === 1 ? "witness" : "witnesses"} to your claims · ${state.ledger.filter((claim) => claim.contradiction).length} story changes</p><p>${state.visitorLog ? `Logged as <strong>${escapeHtml(state.visitorLog)}</strong>` : "Not registered"}${state.authorization ? ` · Authorized by <strong>${escapeHtml(engine.definitions.find((npc) => npc.id === state.authorization?.by)?.name ?? state.authorization.by)}</strong>` : " · No authorization"} · ${state.player.carryingCard ? "Keycard collected" : "No keycard"}</p>`;
  clearTimeout(closeTimer);
  if (conversationId) closeTimer = setTimeout(closeConversation, transport === "live" ? 20_000 : 45_000);
  else disconnectVoice();
}

function updateHud(): void {
  const state = engine.state;
  const floor = engine.floors.find((item) => item.id === state.floor);
  if (!floor) return;
  text("clock", clockLabel(state.clockMinute));
  text("floor-number", String(state.floor).padStart(2, "0"));
  text("floor-name", floor.name);
  text("floor-subtitle", floor.subtitle);
  text("mode-label", state.practiceMode ? "PRACTICE / NON-AI" : "LIVE MISSION");
  text("cover-name", state.cover.name || "Name unknown");
  text("cover-company", state.cover.company || "No story on file");
  text("pass-stamp", state.player.carryingCard ? "CLEARED" : state.visitorLog ? "REGISTERED" : "UNVERIFIED");
  get("pass-stamp").classList.toggle("verified", state.player.carryingCard);
  for (const [id, complete] of [["objective-log", !!state.visitorLog], ["objective-auth", !!state.authorization], ["objective-card", state.player.carryingCard]] as const) {
    get(id).classList.toggle("complete", complete);
    get(id).setAttribute("aria-label", `${get(id).innerText.replace(/\n/g, " ")}: ${complete ? "complete" : "not complete"}`);
  }
  text("mission-hint", state.player.carryingCard ? "Card in hand. The way out is through Reception on floor 1." : state.visitorLog && state.authorization && normalizeAlias(state.visitorLog) !== normalizeAlias(state.authorization.name) ? "The names don't match. Correct the paperwork before collection." : state.authorization ? "Take the same identity to Ramesh on floor 2." : "The same name needs to appear on both pieces of paper.");
  const nearby = started && !conversationId && !activeModal && state.phase === "playing";
  show("elevator-button", nearby && engine.canUseElevator);
  show("exit-button", nearby && engine.canExit);
  text("exit-button", state.player.carryingCard ? "Leave the building" : "Leave without a keycard");
  show("double-cross-button", nearby && engine.canExit && state.secretKnown);
  show("nearby-actions", nearby && (engine.canUseElevator || engine.canExit));
  if (conversationId) {
    const suspicion = state.npcs.find((npc) => npc.id === conversationId)?.suspicion ?? 0;
    const meter = get<HTMLMeterElement>("suspicion-meter");
    meter.value = suspicion;
    meter.low = 35;
    meter.high = 70;
    meter.optimum = 0;
    meter.textContent = String(Math.round(suspicion));
    text("suspicion-label", suspicion >= SUSPICION_THRESHOLDS.escalate ? "Calling security" : suspicion >= SUSPICION_THRESHOLDS.stall ? "Stalling" : suspicion >= SUSPICION_THRESHOLDS.verify ? "Checking your story" : suspicion >= 25 ? "Curious" : "At ease");
    const remaining = engine.securitySecondsRemaining;
    text("security-timer", remaining === null ? "" : `${Math.ceil(remaining)}s`);
  }
  updateConnection();
  const signature = `${state.floor}|${state.visitorLog}|${state.authorization?.name}|${state.cover.name}|${state.player.carryingCard}|${state.facts.length}`;
  if (signature !== lastStateSignature) {
    lastStateSignature = signature;
    if (conversationId && transport === "live") voice.updateContext(engine.getConversationContext(conversationId));
  }
}

function updateArt(): void {
  setImage("exterior-image", "meridian-exterior");
  setImage("ghost-poster", "sprite-ghost");
  setImage("cover-portrait", "portrait-ghost");
  if (conversationId) setImage("speaker-portrait", `portrait-${conversationId}`);
  if (engine.state.ending) setImage("report-portrait", engine.state.ending === "double-cross" ? "portrait-meera" : "portrait-ghost");
  if (activeModal === "elevator-dialog") previewFloor(selectedFloor);
  text("art-status", art.status === "ready" ? "" : "Generated artwork is still arriving. Intentional pixel placeholders are shown where needed.");
}

function setImage(id: string, assetId: string): void {
  const image = get<HTMLImageElement>(id);
  const url = art.url(assetId);
  if (!url || !art.has(assetId)) {
    image.hidden = true;
    return;
  }
  if (image.getAttribute("src") === url) return;
  image.onload = () => { image.hidden = false; };
  image.onerror = () => {
    image.hidden = true;
    text("art-status", `Generated artwork ${assetId} could not load.`);
  };
  image.src = url;
}

function showFloorArrival(id: number): void {
  const floor = engine.floors.find((item) => item.id === id);
  if (!floor) return;
  text("arrival-number", String(id).padStart(2, "0"));
  text("arrival-name", floor.name);
  text("arrival-subtitle", floor.subtitle);
  const element = get("floor-arrival");
  element.hidden = true;
  requestAnimationFrame(() => { element.hidden = false; });
  clearTimeout(arrivalTimer);
  arrivalTimer = setTimeout(() => show("floor-arrival", false), engine.state.settings.reducedMotion ? 1800 : 3200);
}

function announce(message: string): void {
  text("screen-reader-events", message);
  text("scene-toast", message);
  show("scene-toast", true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => show("scene-toast", false), Math.min(10_000, Math.max(4200, message.length * 35)));
}

function showProviderError(message: string, source: "director" | "connection" = "connection"): void {
  providerNoticeSource = source;
  text("provider-banner-text", message);
  show("provider-banner", true);
  if (!started) {
    text("provider-state", message);
    get("provider-state").classList.add("error");
  }
}

function clearProviderError(source: "director" | "connection"): void {
  if (providerNoticeSource !== source) return;
  providerNoticeSource = null;
  show("provider-banner", false);
}

function addGossip(event: GameEvent): void {
  const feed = get("gossip-feed");
  const item = document.createElement("p");
  item.className = "gossip-item";
  item.innerHTML = `<span>${event.kind === "gossip" ? "Word travels" : clockLabel(engine.state.clockMinute)}</span> · ${escapeHtml(event.text)}`;
  feed.append(item);
  while (feed.children.length > 3) feed.firstElementChild?.remove();
  setTimeout(() => item.remove(), 11_000);
}

function debug(message: string): void {
  debugEntries.push(`<li><time>${clockLabel(engine.state.clockMinute)}</time> ${escapeHtml(message)}</li>`);
  if (debugEntries.length > 45) debugEntries.shift();
  if (renderer.debug) get("debug-entries").innerHTML = [...debugEntries].reverse().join("");
}

function toggleDebug(): void {
  renderer.debug = !renderer.debug;
  show("debug-panel", renderer.debug);
  if (renderer.debug) get("debug-entries").innerHTML = [...debugEntries].reverse().join("");
}

function applySettings(): void {
  const settings = engine.state.settings;
  document.body.classList.toggle("reduced-motion", settings.reducedMotion);
  document.body.classList.toggle("captions-off", !settings.captions);
  get<HTMLInputElement>("captions-input").checked = settings.captions;
  get<HTMLInputElement>("motion-input").checked = settings.reducedMotion;
  get<HTMLInputElement>("volume-input").value = String(settings.volume);
  get<HTMLInputElement>("camera-input").checked = settings.camera;
  voice.setVolume(soundMuted ? 0 : settings.volume);
}

function readSave(): void {
  try {
    savedMission = localStorage.getItem(SAVE_KEY);
    show("resume-button", !!savedMission);
  } catch (error) {
    storageFailed = true;
    text("provider-state", `Local saving is unavailable: ${errorMessage(error)} You can still play this session.`);
  }
}

function saveMission(): void {
  if (!started || storageFailed) return;
  try {
    const serialized = engine.serialize();
    localStorage.setItem(SAVE_KEY, serialized);
    savedMission = serialized;
  } catch (error) {
    storageFailed = true;
    announce(`Progress could not be saved on this device: ${errorMessage(error)}`);
  }
}

function returnToTitle(): void {
  if (conversationId) {
    engine.endConversation("The visitor pauses the operation.");
    closeConversation();
  }
  disableCamera();
  saveMission();
  director.stop();
  disconnectVoice();
  if (activeModal) get<HTMLDialogElement>(activeModal).close();
  activeModal = null;
  started = false;
  for (const id of ["topbar", "dossier", "movement-hint", "touch-controls", "nearby-actions", "conversation", "security-overlay", "mission-report", "provider-banner"]) show(id, false);
  show("opening", true);
  show("resume-button", !!savedMission);
  const preferences = { ...engine.state.settings, camera: false };
  engine = new GameEngine();
  engine.state.settings = preferences;
  bindEngine();
  renderer.center();
}

function resetEngine(): void {
  clearTimeout(closeTimer);
  if (conversationId) closeConversation();
  director.stop();
  disconnectVoice();
  disableCamera();
  if (activeModal) get<HTMLDialogElement>(activeModal).close();
  activeModal = null;
  started = false;
  const preferences = { ...engine.state.settings, camera: false };
  engine = new GameEngine();
  engine.state.settings = preferences;
  bindEngine();
  renderer.center();
  encounterVersion += 1;
  lastStateSignature = "";
}

function disableCamera(): void {
  engine.state.settings.camera = false;
  get<HTMLInputElement>("camera-input").checked = false;
  text("camera-status", "Camera off. No facial analysis or honesty scoring.");
  void voice.setCameraEnabled(false).catch((error: unknown) => announce(`Camera could not be closed: ${errorMessage(error)}`));
}

function eraseProgress(): void {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch (error) {
    announce(`Saved progress could not be erased: ${errorMessage(error)}`);
    return;
  }
  started = false;
  resetEngine();
  savedMission = null;
  storageFailed = false;
  show("reset-confirm", false);
  for (const id of ["topbar", "dossier", "movement-hint", "touch-controls", "nearby-actions", "conversation", "security-overlay", "mission-report", "resume-button", "provider-banner"]) show(id, false);
  show("opening", true);
  document.body.classList.remove("in-conversation", "security");
  announce("Local mission progress erased.");
}

function frame(now: number): void {
  const dt = Math.min(.05, Math.max(0, (now - lastFrame) / 1000));
  lastFrame = now;
  if (started && engine.state.phase === "playing") {
    engine.tick(dt, input.read());
    if (conversationId && !engine.state.activeNpcId && !pendingEnd && engine.state.phase === "playing") {
      const securityWarning = conversationId === "meera" && engine.state.meeraResolved;
      closeConversation();
      if (securityWarning) announce("Meera has issued a warning. The records do not justify ending your visit.");
    }
    if (now - lastHud > 150) {
      updateHud();
      lastHud = now;
    }
    if (now - autosaveAt > 10_000) {
      saveMission();
      autosaveAt = now;
    }
    if (renderer.debug && now - lastPaths > 1000) {
      renderer.setPaths(Object.fromEntries(Object.entries(engine.getDebugPaths()).map(([id, path]) => {
        const npc = engine.state.npcs.find((actor) => actor.id === id);
        return [id, npc && path.length ? [{ x: npc.x, y: npc.y }, ...path] : []];
      })));
      lastPaths = now;
    }
  }
  const floor = engine.floors.find((item) => item.id === engine.state.floor) ?? engine.floors[0];
  if (floor) renderer.draw(engine.state, floor, engine.definitions, dt);
  requestAnimationFrame(frame);
}

function installTestInspection(): void {
  const ids: Record<string, string> = {
    "start-live": "begin-mission", "start-practice": "practice-mode", world: "game-canvas",
    "dialogue-input": "dialogue-text", "send-reply": "dialogue-send", dossier: "mission-status",
    "elevator-button": "elevator-controls", "pause-button": "pause", "mission-report": "report",
    "exit-button": "exit-building", "double-cross-button": "double-cross", conversation: "conversation",
  };
  for (const [id, testId] of Object.entries(ids)) get(id).dataset.testid = testId;
  get("world").tabIndex = -1;
  if (import.meta.env.DEV) {
    Object.defineProperty(window, "__glasshouse", {
      value: Object.freeze({
        snapshot: (): GameState => structuredClone(engine.state),
        floors: () => structuredClone(engine.floors),
        definitions: () => structuredClone(engine.definitions),
        ui: () => ({ conversationId, transport, busy, voiceStatus, pendingEnd, activeModal, debugEntries: [...debugEntries] }),
      }),
      writable: false,
      configurable: false,
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isDialogueReply(value: unknown): value is DialogueReply {
  if (!value || typeof value !== "object" || !("reply" in value) || typeof value.reply !== "string" || !("actions" in value) || !Array.isArray(value.actions)) return false;
  return value.actions.every((action: unknown) => !!action && typeof action === "object" && "type" in action && typeof action.type === "string" && ["claim", "suspicion", "register", "authorize", "issue_card", "discover", "end_conversation", "security_resolution"].includes(action.type) && "npcId" in action && typeof action.npcId === "string");
}
