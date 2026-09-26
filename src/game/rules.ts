import type { CoverIdentity } from "../../shared/types";

export const GAME_START_MINUTE = 9 * 60;
export const GAME_END_MINUTE = 18 * 60;
export const GAME_DAY_SECONDS = 24 * 60;
export const MAX_TICK_SECONDS = 0.25;
export const WALK_SPEED = 3.2;
export const RUN_SPEED = 4.8;
export const ELEVATOR_DISTANCE = 2.4;
export const EXIT_DISTANCE = 1.6;
export const CONVERSATION_DISTANCE = 2.4;
export const SECURITY_RESPONSE_SECONDS = 30;
export const SUSPICION_THRESHOLDS = { verify: 40, stall: 70, escalate: 85 } as const;

export const GOSSIP_EDGES = [
  { from: "priya", to: "dev", probability: 0.4 },
  { from: "priya", to: "anita", probability: 0.6 },
  { from: "anita", to: "meera", probability: 0.8 },
  { from: "ramesh", to: "meera", probability: 0.7 },
  { from: "kulkarni", to: "ramesh", probability: 0.12 },
] as const;

export const COVER_FIELDS = ["name", "company", "role", "host", "callback", "employeeId", "ticket"] as const;

export function emptyCover(): CoverIdentity {
  return { name: "", company: "", role: "", host: "", callback: "", employeeId: "", ticket: "" };
}

export function readableValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeAlias(value: string): string {
  return readableValue(value).toLowerCase();
}

export function isFictionalCallback(value: string): boolean {
  return /^SIM-\d{4}$/i.test(value);
}

export function isFictionalTicket(value: string): boolean {
  return /^MT-[A-Z0-9]{3,12}(?:-[A-Z0-9]{1,8})?$/i.test(value);
}

export function isFictionalEmployeeId(value: string): boolean {
  return /^MT-ID-[A-Z0-9]{3,12}$/i.test(value);
}

export function canReadVisitorLog(npcId: string): boolean {
  return ["priya", "ramesh", "dev", "anita", "meera"].includes(npcId);
}

export function canReadAuthorization(npcId: string): boolean {
  return ["ramesh", "dev", "anita", "meera"].includes(npcId);
}
