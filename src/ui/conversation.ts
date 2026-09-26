import type { VoiceStatus } from "../../shared/types";

interface ConversationReadiness {
  active: boolean;
  paused: boolean;
  ending: boolean;
  busy: boolean;
  narrating: boolean;
  transport: "live" | "text" | "practice";
  status: VoiceStatus;
  awaitingReply: boolean;
}

export function canAnswerConversation(value: ConversationReadiness): boolean {
  return value.active && !value.paused && !value.ending && !value.busy && !value.narrating
    && (value.transport !== "live" || value.status === "listening" && !value.awaitingReply);
}
