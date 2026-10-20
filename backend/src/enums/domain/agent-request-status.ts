import { enumValues, type ValueOf } from "../utility/value-of";

/** Lifecycle of one agent AI request (17 §6.1). */
export const AgentRequestStatus = {
  /** Written by the provider, waiting for a claim. */
  PENDING: "pending",
  /** Handed to an agent. */
  CLAIMED: "claimed",
  /** Response stored and valid. */
  ANSWERED: "answered",
  /** The agent gave up (message in error_message). */
  FAILED: "failed",
  /** Run cancelled, timed out or ended first. */
  CANCELLED: "cancelled"
} as const;
export type AgentRequestStatus = ValueOf<typeof AgentRequestStatus>;
export const AGENT_REQUEST_STATUS_VALUES = enumValues(AgentRequestStatus);

/** Statuses an answer or failure may still be written in. */
export const OPEN_AGENT_REQUEST_STATUSES = ["pending", "claimed"] as const satisfies readonly AgentRequestStatus[];

/** AI purposes an agent answers (`connection_test` is never sent to an agent). */
export const AgentRequestPurpose = {
  HARNESS: "harness",
  HARNESS_REPAIR: "harness_repair",
  SUMMARY: "summary"
} as const;
export type AgentRequestPurpose = ValueOf<typeof AgentRequestPurpose>;
export const AGENT_REQUEST_PURPOSE_VALUES = enumValues(AgentRequestPurpose);
