import type { Point } from "../../shared/types";

export interface ActorRuntime {
  path: Point[];
  target: Point | null;
  nextRoutineAt: number;
  modelUntil: number;
  nextFollowAt: number;
  peerId: string | null;
}

export interface ConversationRuntime {
  npcId: string;
  claimIds: string[];
  factIds: string[];
  playerTurnIds: string[];
  successfulActions: number;
  reductionUsed: boolean;
  clockRunning: boolean;
}

export interface Incident {
  id: string;
  kind: "contradiction" | "trespass" | "admission";
  npcId: string;
  at: number;
  claimIds: string[];
  roomId: string | null;
  text: string;
}

export interface RumorPayload {
  claimIds: string[];
  incidentIds: string[];
}

export interface SecurityRuntime {
  pendingAt: number | null;
  remaining: number;
  evidenceIds: string[];
  resolvedAt: number | null;
  repeatDeadline: number | null;
}

export interface EngineRuntime {
  sequence: number;
  randomState: number;
  actors: Record<string, ActorRuntime>;
  heardClaims: Record<string, string[]>;
  heardIncidents: Record<string, string[]>;
  completedConversations: Record<string, number>;
  conversation: ConversationRuntime | null;
  graceUntil: number;
  approachId: string | null;
  approachExpires: number;
  security: SecurityRuntime;
  rumorPayloads: Record<string, RumorPayload>;
  incidents: Incident[];
  usedModelEvidence: string[];
  lastRoomId: string | null;
  nextTrespassAt: number;
  nextChatterAt: number;
}
