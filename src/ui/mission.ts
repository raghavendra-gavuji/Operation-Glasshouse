import type { Ending, GameState } from "../../shared/types";
import { GAME_DAY_SECONDS, GAME_END_MINUTE, GAME_START_MINUTE } from "../game/engine";

export function clockLabel(minute: number): string {
  const value = Math.max(0, Math.floor(minute));
  return `${String(Math.floor(value / 60) % 24).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

export function eventClock(elapsedSeconds: number): string {
  return clockLabel(GAME_START_MINUTE + elapsedSeconds * ((GAME_END_MINUTE - GAME_START_MINUTE) / GAME_DAY_SECONDS));
}

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char);
}

export function fieldLabel(field: string): string {
  return ({ name: "Name", company: "Company", role: "Role", host: "Host", callback: "Fictional callback", employeeId: "Fictional staff ID", ticket: "Fictional ticket" } as Record<string, string>)[field] ?? field;
}

export const ENDING_COPY: Record<Ending, { title: string; description: string }> = {
  clean: { title: "Nobody saw a thing.", description: "A name on a log. A signature. One visitor keycard. Ghost leaves Meridian Tower before anyone puts the pieces together." },
  flagged: { title: "You left a story behind.", description: "The keycard is yours, but the building remembers. Somewhere upstairs, two versions of your visit are being compared." },
  burned: { title: "The cover came apart.", description: "Meera closes the file on your invented identity. Every conversation had a witness. This time, the witnesses agreed." },
  "clock-out": { title: "The building clocks out.", description: "The offices empty, the desk closes, and the visitor card stays inside. Tomorrow will need a different story." },
  "double-cross": { title: "A different kind of exit.", description: "You gave Meera something more valuable than a keycard: the Handler's secret. Ghost walks away from the operation, not just the building." },
};

export function missionRank(state: GameState): string {
  if (state.ending === "burned" || state.ending === "clock-out") return "Amateur";
  if (state.ending === "double-cross") return "Phantom";
  const contradictions = state.ledger.filter((claim) => claim.contradiction).length;
  if (state.ending === "flagged") return contradictions > 2 ? "Operative" : "Shadow";
  return contradictions === 0 ? "Phantom" : "Shadow";
}
