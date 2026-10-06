import { isTerminalVisualizationStatus, Table, VisualizationStatus, type AiProviderKind } from "../../enums";
import type { QueryHandler } from "../../utilities";

const S = VisualizationStatus;

/** Allowed status transitions (07 §5.1.1). Terminal statuses never change again. */
export const VISUALIZATION_TRANSITIONS: Readonly<Record<VisualizationStatus, readonly VisualizationStatus[]>> = {
  queued: [S.PREPARING, S.CANCELLED, S.FAILED],
  preparing: [S.ANALYZING, S.FAILED, S.CANCELLED],
  analyzing: [S.GENERATING_HARNESSES, S.AWAITING_CONFIRMATION, S.FAILED, S.CANCELLED],
  // Paused for the user's component-limit choice; continue re-queues the run (no worker holds it meanwhile).
  awaiting_confirmation: [S.QUEUED, S.CANCELLED, S.FAILED],
  generating_harnesses: [S.RENDERING, S.FAILED, S.CANCELLED],
  rendering: [S.DIFFING, S.FAILED, S.CANCELLED],
  diffing: [S.SUMMARIZING, S.FAILED, S.CANCELLED],
  summarizing: [S.COMPLETED, S.FAILED, S.CANCELLED],
  completed: [],
  failed: [],
  cancelled: []
};

/** True when `from → to` is in VISUALIZATION_TRANSITIONS. */
export function canTransition(from: VisualizationStatus, to: VisualizationStatus): boolean {
  return VISUALIZATION_TRANSITIONS[from].includes(to);
}

/**
 * Columns a transition may write besides status / started_at / completed_at / failed_stage.
 * ai_usage is NOT here (only 09's AiUsageRecorder writes it, 00 §14.7); summary_markdown is NOT here (11 writes it).
 */
export interface VisualizationTransitionFields {
  errorMessage?: string | null;
  aiProvider?: AiProviderKind;
  aiModel?: string;
  baseSha?: string | null;
  headSha?: string | null;
  changedCount?: number; // component_count is written only by 08 (00 §14.3)
  /** Set when the user continues a run paused in awaiting_confirmation. */
  componentLimit?: number;
}

/** A transition that VISUALIZATION_TRANSITIONS does not allow (a programming error). */
export class VisualizationTransitionError extends Error {
  constructor(
    readonly from: VisualizationStatus,
    readonly to: VisualizationStatus
  ) {
    super(`Illegal visualization transition ${from} → ${to}`);
    this.name = "VisualizationTransitionError";
  }
}

/**
 * Guarded compare-and-set: UPDATE … WHERE id = $id AND status = $from AND is_deleted = false.
 * Returns false when no row matched (someone else moved it). Stamps started_at on → preparing,
 * completed_at on → terminal, and failed_stage = from on → failed | cancelled. updated_at is stamped by QueryHandler.
 *
 * @throws VisualizationTransitionError for a transition the state machine does not allow.
 * @throws Error when the update fails for any other reason than "no row matched".
 */
export async function transitionVisualization(
  queryHandler: Pick<QueryHandler, "update">,
  input: {
    visualizationId: number;
    from: VisualizationStatus;
    to: VisualizationStatus;
    fields?: VisualizationTransitionFields;
    now: Date;
  }
): Promise<boolean> {
  if (!canTransition(input.from, input.to)) {
    throw new VisualizationTransitionError(input.from, input.to);
  }

  const values: Record<string, unknown> = { ...(input.fields ?? {}), status: input.to };
  if (input.to === VisualizationStatus.PREPARING) {
    values.startedAt = input.now;
  }
  if (isTerminalVisualizationStatus(input.to)) {
    values.completedAt = input.now;
  }
  if (input.to === VisualizationStatus.FAILED || input.to === VisualizationStatus.CANCELLED) {
    values.failedStage = input.from;
  }

  const result = await queryHandler.update(
    values,
    { id: input.visualizationId, status: input.from, isDeleted: false },
    Table.VISUALIZATIONS
  );
  if (result.status === 200) {
    return true;
  }
  if (result.status === 404) {
    return false;
  }
  throw new Error(`Visualization ${input.visualizationId} ${input.from}→${input.to} update failed (${result.status})`);
}
