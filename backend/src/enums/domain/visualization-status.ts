import { enumValues, type ValueOf } from "../utility/value-of";

export const VisualizationStatus = {
  QUEUED: "queued",
  PREPARING: "preparing",
  ANALYZING: "analyzing",
  /** Paused after analysis: more components changed than the default limit; waiting for the user to choose. */
  AWAITING_CONFIRMATION: "awaiting_confirmation",
  GENERATING_HARNESSES: "generating_harnesses",
  RENDERING: "rendering",
  DIFFING: "diffing",
  SUMMARIZING: "summarizing",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled"
} as const;
export type VisualizationStatus = ValueOf<typeof VisualizationStatus>;
/** Name used by 00 §14.7 for the same union. */
export type VisualizationStatusValue = VisualizationStatus;
export const VISUALIZATION_STATUS_VALUES = enumValues(VisualizationStatus);

/** Statuses after which a visualization never changes again (00 §5). */
export const TERMINAL_VISUALIZATION_STATUSES = [
  "completed",
  "failed",
  "cancelled"
] as const satisfies readonly VisualizationStatus[];
export type TerminalVisualizationStatus = (typeof TERMINAL_VISUALIZATION_STATUSES)[number];

/** Statuses in which a worker is (or should be) processing the visualization. */
export const ACTIVE_VISUALIZATION_STATUSES = [
  "preparing",
  "analyzing",
  "generating_harnesses",
  "rendering",
  "diffing",
  "summarizing"
] as const satisfies readonly VisualizationStatus[];
export type ActiveVisualizationStatus = (typeof ACTIVE_VISUALIZATION_STATUSES)[number];

/** queued + active. Allowed values of visualizations.failed_stage and of PipelineStepError.stage (00 §14.3/§14.7). */
export const NON_TERMINAL_VISUALIZATION_STATUSES = [
  "queued",
  "awaiting_confirmation",
  ...ACTIVE_VISUALIZATION_STATUSES
] as const;
export type NonTerminalVisualizationStatus = (typeof NON_TERMINAL_VISUALIZATION_STATUSES)[number];

/** True when the status is terminal. */
export function isTerminalVisualizationStatus(status: VisualizationStatus): status is TerminalVisualizationStatus {
  return (TERMINAL_VISUALIZATION_STATUSES as readonly VisualizationStatus[]).includes(status);
}
