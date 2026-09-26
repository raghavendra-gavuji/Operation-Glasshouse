import { describe, expect, it } from "vitest";
import { canAnswerConversation } from "../src/ui/conversation";

const ready = {
  active: true, paused: false, ending: false, busy: false, narrating: false,
  transport: "live" as const, status: "listening" as const, awaitingReply: false,
};

describe("fair conversation answer allowance", () => {
  it("runs while a connected visitor can actively answer", () => {
    expect(canAnswerConversation(ready)).toBe(true);
  });

  it.each(["paused", "ending", "busy", "narrating", "awaitingReply"] as const)("excludes %s time", (flag) => {
    expect(canAnswerConversation({ ...ready, [flag]: true })).toBe(false);
  });

  it.each(["idle", "connecting", "speaking", "error"] as const)("does not count live %s status", (status) => {
    expect(canAnswerConversation({ ...ready, status })).toBe(false);
  });

  it("counts text/practice readiness without requiring a microphone or a voice status", () => {
    expect(canAnswerConversation({ ...ready, transport: "text", status: "error" })).toBe(true);
    expect(canAnswerConversation({ ...ready, transport: "practice", status: "idle" })).toBe(true);
    expect(canAnswerConversation({ ...ready, transport: "text", busy: true })).toBe(false);
  });

  it("never counts after the conversation is gone", () => {
    expect(canAnswerConversation({ ...ready, active: false })).toBe(false);
  });
});
