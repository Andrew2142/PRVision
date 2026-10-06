import type { NonTerminalVisualizationStatus } from "../enums";

/**
 * Stage a fatal pipeline failure is attributed to (00 §14.7): every non-terminal VisualizationStatus
 * (queued + the working stages, 00 §11). 07 stores it in visualizations.failed_stage (00 §14.3).
 */
export type PipelineStage = NonTerminalVisualizationStatus;

export interface PipelineStepErrorOptions {
  /** Underlying error; logged through the err serializer, never shown to users. */
  cause?: unknown;
  /** Technical detail for logs; becomes `message`. Defaults to userMessage. */
  detail?: string;
  /** Machine hint for the orchestrator, e.g. a GitErrorCode such as "auth_failed". */
  code?: string;
}

/**
 * The only error pipeline step services (07–11) may throw. Fatal for the visualization.
 * - message:     internal detail for logs (redacted by the logger's err serializer)
 * - userMessage: one safe sentence stored in visualizations.error_message and shown in the UI
 * Per-component failures are recorded in results, never thrown.
 */
export class PipelineStepError extends Error {
  override readonly name = "PipelineStepError";
  readonly stage: PipelineStage;
  readonly userMessage: string;
  readonly code: string | null;

  constructor(stage: PipelineStage, userMessage: string, options: PipelineStepErrorOptions = {}) {
    super(options.detail ?? userMessage, { cause: options.cause });
    this.stage = stage;
    this.userMessage = userMessage;
    this.code = options.code ?? null;
  }
}

/** Type guard used by the orchestrator (07). */
export function isPipelineStepError(error: unknown): error is PipelineStepError {
  return error instanceof PipelineStepError;
}

/**
 * True for the DOMException named "AbortError" (AbortSignal.abort() without a reason, aborted fetch).
 * NOT a cancellation test: a job signal aborts with the string reason "cancelled" | "shutdown" (00 §14.6) and
 * a timeout with a TimeoutError. Decide cancellation by `signal.aborted` and `jobAbortReason(signal)` (04 §9.4).
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
