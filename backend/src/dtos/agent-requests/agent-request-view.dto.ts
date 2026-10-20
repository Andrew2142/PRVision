import type { AgentRequestPurpose, AgentRequestStatus } from "../../enums";
import type { AgentRequestImage } from "../../types";
import { toIsoString, toIsoStringOrNull } from "../../utilities";

/** The row fields the views read (AgentRequestStore returns them). */
export interface AgentRequestRow {
  id: number;
  visualizationId: number;
  purpose: AgentRequestPurpose;
  status: AgentRequestStatus;
  systemPrompt: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  images: AgentRequestImage[];
  createdAt: Date;
  claimedAt: Date | null;
  answeredAt: Date | null;
}

/** GET /api/visualizations/:id/agent-requests (17 §8). */
export interface AgentRequestSummaryView {
  id: number;
  visualizationId: number;
  purpose: AgentRequestPurpose;
  status: AgentRequestStatus;
  createdAt: string;
  claimedAt: string | null;
  answeredAt: string | null;
}

/** POST /api/visualizations/:id/agent-requests/claim (17 §8): everything an agent needs to answer. */
export interface AgentRequestView extends AgentRequestSummaryView {
  system: string;
  prompt: string;
  jsonSchema: Record<string, unknown>;
  images: AgentRequestImage[];
}

/** POST /api/agent-requests/:id/answer and /fail. */
export interface AgentRequestUpdateResponse {
  id: number;
  status: "answered" | "failed";
}

export function toAgentRequestSummaryView(row: AgentRequestRow): AgentRequestSummaryView {
  return {
    id: row.id,
    visualizationId: row.visualizationId,
    purpose: row.purpose,
    status: row.status,
    createdAt: toIsoString(row.createdAt),
    claimedAt: toIsoStringOrNull(row.claimedAt),
    answeredAt: toIsoStringOrNull(row.answeredAt)
  };
}

export function toAgentRequestView(row: AgentRequestRow): AgentRequestView {
  return {
    ...toAgentRequestSummaryView(row),
    system: row.systemPrompt,
    prompt: row.prompt,
    jsonSchema: row.jsonSchema,
    images: row.images
  };
}
