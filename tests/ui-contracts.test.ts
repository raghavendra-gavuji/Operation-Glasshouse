import { describe, expect, it } from "vitest";
import { screenToWorldInput } from "../src/ui/controls";
import { clockLabel, escapeHtml, missionRank } from "../src/ui/mission";
import { practiceOptions, practiceText } from "../src/ui/practice";
import { narrationChunks, TranscriptAssembler } from "../src/ui/transcripts";
import { apiErrorMessage, readApiError } from "../src/ui/http";
import { projectTile } from "../src/renderer";
import type { GameState, NpcDefinition } from "../shared/types";

function state(): GameState {
  return {
    version: 1, seed: 1, phase: "playing", paused: false, elapsedSeconds: 0, clockMinute: 540, floor: 1,
    player: { x: 14.5, y: 21.5, facing: "south", moving: false, carryingCard: false },
    npcs: [], cover: { name: "", company: "", role: "", host: "", callback: "", employeeId: "", ticket: "" },
    ledger: [], facts: [], rumors: [], events: [], transcripts: [], visitorLog: null, authorization: null,
    activeNpcId: "priya", meeraCalled: false, meeraResolved: false, secretKnown: false, ending: null,
    practiceMode: true, settings: { captions: true, reducedMotion: false, camera: false, actingCues: false, volume: .8 },
  };
}

function npc(id: string): NpcDefinition {
  return { id, name: id, role: "Staff", floor: 1, home: { x: 5.5, y: 5.5 }, color: "#325d50", voiceName: "Kore", personality: "", greeting: "", knowledge: [] };
}

describe("screen-relative isometric movement", () => {
  it.each([
    ["up", 0, -1, 0, -1], ["right", 1, 0, 1, 0],
    ["down", 0, 1, 0, 1], ["left", -1, 0, -1, 0],
  ])("%s points in the expected screen direction", (_name, x, y, screenX, screenY) => {
    const world = screenToWorldInput(Number(x), Number(y));
    const point = projectTile(world.x, world.y);
    expect(Math.sign(Math.abs(point.x) < .0001 ? 0 : point.x)).toBe(screenX);
    expect(Math.sign(Math.abs(point.y) < .0001 ? 0 : point.y)).toBe(screenY);
    expect(Math.hypot(world.x, world.y)).toBeCloseTo(1);
  });

  it("does not accelerate diagonal movement", () => {
    const diagonal = screenToWorldInput(1, 1);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1);
    expect(screenToWorldInput(0, 0)).toEqual({ x: 0, y: 0 });
  });
});

describe("exact live transcripts", () => {
  it("speaks long replies in bounded chunks without dropping words or splitting Unicode pairs", () => {
    const message = "A sentence about the visitor's paperwork. ".repeat(38);
    const chunks = narrationChunks(message);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1100)).toBe(true);
    expect(chunks.join(" ")).toBe(message.trim());
    const unicode = "🚪".repeat(700);
    expect(narrationChunks(unicode).join("")).toBe(unicode);
    expect(narrationChunks(unicode).every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  });
  it("replaces cumulative and corrected interim snapshots", () => {
    const assembler = new TranscriptAssembler();
    assembler.receive("player", "I am an audtor", false);
    expect(assembler.receive("player", "I am an auditor.", true)).toEqual({ text: "I am an auditor.", commit: true });
    expect(assembler.finish()).toEqual([]);
  });

  it("deduplicates a final within one turn, not the same sentence in a later turn", () => {
    const assembler = new TranscriptAssembler();
    expect(assembler.receive("npc", "Thank you.", true).commit).toBe(true);
    expect(assembler.receive("npc", "Thank you.", true).commit).toBe(false);
    assembler.finish();
    expect(assembler.receive("npc", "Thank you.", true).commit).toBe(true);
  });

  it("commits pending partials exactly once at a turn boundary", () => {
    const assembler = new TranscriptAssembler();
    assembler.receive("player", "My name is", false);
    assembler.receive("player", "My name is Leela.", false);
    assembler.receive("npc", "Good morning.", false);
    expect(assembler.finish()).toEqual([{ speaker: "player", text: "My name is Leela." }, { speaker: "npc", text: "Good morning." }]);
    expect(assembler.finish()).toEqual([]);
  });
});

describe("practice UI action contract", () => {
  it("limits key mission actions to the canonical NPC roles", () => {
    const value = state();
    expect(practiceOptions(value, npc("priya")).some((option) => option.actions.some((action) => action.type === "register"))).toBe(true);
    expect(practiceOptions(value, npc("priya")).some((option) => option.actions.some((action) => action.type === "authorize"))).toBe(false);
    expect(practiceOptions(value, npc("ramesh")).some((option) => option.actions.some((action) => action.type === "issue_card"))).toBe(true);
    for (const id of ["dev", "anita"]) expect(practiceOptions(value, npc(id)).some((option) => option.actions.some((action) => action.type === "authorize"))).toBe(true);
  });

  it("retains the exact authored sentence for each extracted introduction claim", () => {
    const option = practiceOptions(state(), npc("priya"))[0];
    expect(option.actions).toHaveLength(3);
    for (const action of option.actions) {
      expect(action.type).toBe("claim");
      if (action.type === "claim") expect(action.quote).toBe(option.text);
    }
  });

  it("supports a custom typed fictional name without treating other text as AI", () => {
    const value = state();
    const typed = practiceText("My name is Tara Shah.", value, npc("priya"));
    expect(typed.actions).toEqual([{ type: "claim", npcId: "priya", field: "name", value: "Tara Shah", quote: "My name is Tara Shah." }]);
    const unknown = practiceText("Tell me something unpredictable", value, npc("priya"));
    expect(unknown.actions).toEqual([]);
    expect(unknown.reply).toContain("scripted, not Gemini");
  });

  it("uses the exact cover name on all paperwork requests", () => {
    const value = state();
    value.cover.name = "Tara Shah";
    for (const id of ["priya", "dev", "anita", "ramesh"]) {
      for (const option of practiceOptions(value, npc(id))) {
        for (const action of option.actions) {
          if (["register", "authorize", "issue_card"].includes(action.type) && "name" in action) expect(action.name).toBe("Tara Shah");
        }
      }
    }
  });

  it("never offers an incoming-call shortcut for the exit-only double cross", () => {
    const value = state();
    value.secretKnown = true;
    expect(practiceOptions(value, npc("meera")).flatMap((option) => option.actions).some((action) => action.type === "security_resolution" && action.result === "double_cross")).toBe(false);
  });
});

describe("real backend error envelopes", () => {
  it("shows the server's sanitized, actionable error message", async () => {
    expect(apiErrorMessage({ error: { code: "PROVIDER_QUOTA", message: "Gemini quota exhausted.", retryable: true } }, 429)).toBe("Gemini quota exhausted.");
    expect(apiErrorMessage({ error: "Legacy test error" }, 503)).toBe("Legacy test error");
    expect(await readApiError(new Response("not JSON", { status: 502 }))).toBe("The server returned HTTP 502 without a readable error response.");
  });
});

describe("mission presentation", () => {
  it("formats the real 9am to 6pm clock and escapes ledger content", () => {
    expect(clockLabel(540)).toBe("09:00");
    expect(clockLabel(1080)).toBe("18:00");
    expect(escapeHtml('<img src=x onerror="x">')).toBe("&lt;img src=x onerror=&quot;x&quot;&gt;");
  });

  it("ranks story outcomes, not personal attributes", () => {
    const value = state();
    value.ending = "clean";
    expect(missionRank(value)).toBe("Phantom");
    value.ending = "burned";
    expect(missionRank(value)).toBe("Amateur");
    value.ending = "double-cross";
    expect(missionRank(value)).toBe("Phantom");
  });
});
