/**
 * Status machine of harness library jobs (16 §10.2): scan, rescan and repair share it. Mirrors 07's guarded
 * transition (`status = from` in the update condition), so a lost guard means another writer moved the job.
 */
import { LibraryJobStatus, Table, TERMINAL_LIBRARY_JOB_STATUSES, type TerminalLibraryJobStatus } from "../../enums";
import { createLogger, type QueryHandler } from "../../utilities";

const S = LibraryJobStatus;
const log = createLogger("library");

/** Allowed transitions (16 §10.2). Terminal statuses never change again. */
export const LIBRARY_JOB_TRANSITIONS: Readonly<Record<LibraryJobStatus, readonly LibraryJobStatus[]>> = {
  queued: [S.PREPARING, S.CANCELLED, S.FAILED],
  preparing: [S.RUNNING, S.FAILED, S.CANCELLED],
  running: [S.COMPLETED, S.CAP_REACHED, S.FAILED, S.CANCELLED],
  completed: [],
  cap_reached: [],
  failed: [],
  cancelled: []
};

/** True when `from → to` is in LIBRARY_JOB_TRANSITIONS. */
export function canTransitionLibraryJob(from: LibraryJobStatus, to: LibraryJobStatus): boolean {
  return LIBRARY_JOB_TRANSITIONS[from].includes(to);
}

/** True for completed, cap_reached, failed and cancelled. */
export function isTerminalLibraryJobStatus(status: LibraryJobStatus): status is TerminalLibraryJobStatus {
  return (TERMINAL_LIBRARY_JOB_STATUSES as readonly string[]).includes(status);
}

/** Columns a transition may write besides status, started_at and completed_at. */
export interface LibraryJobTransitionFields {
  errorMessage?: string | null;
  totalCount?: number;
  scanSha?: string | null;
  currentLabel?: string | null;
}

/** A transition LIBRARY_JOB_TRANSITIONS does not allow (a programming error). */
export class LibraryJobTransitionError extends Error {
  override readonly name = "LibraryJobTransitionError";

  constructor(
    readonly from: LibraryJobStatus,
    readonly to: LibraryJobStatus
  ) {
    super(`Illegal library job transition ${from} → ${to}`);
  }
}

/**
 * Guarded compare-and-set: UPDATE … WHERE id = $jobId AND status = $from. Stamps started_at on → preparing and
 * completed_at on → terminal. Returns false when no row matched (the caller skips the job, `library.job.skipped`).
 *
 * @throws LibraryJobTransitionError for a transition the machine does not allow.
 * @throws Error when the update fails for another reason than "no row matched".
 */
export async function transitionLibraryJob(
  queryHandler: Pick<QueryHandler, "update">,
  input: {
    jobId: number;
    from: LibraryJobStatus;
    to: LibraryJobStatus;
    fields?: LibraryJobTransitionFields;
    now: Date;
  }
): Promise<boolean> {
  if (!canTransitionLibraryJob(input.from, input.to)) {
    throw new LibraryJobTransitionError(input.from, input.to);
  }
  const values: Record<string, unknown> = { ...(input.fields ?? {}), status: input.to };
  if (input.to === S.PREPARING) {
    values.startedAt = input.now;
  }
  if (isTerminalLibraryJobStatus(input.to)) {
    values.completedAt = input.now;
  }
  const result = await queryHandler.update(values, { id: input.jobId, status: input.from }, Table.HARNESS_LIBRARY_JOBS);
  if (result.status === 200) {
    log.info(
      { event: "library.job.transition", jobId: input.jobId, from: input.from, to: input.to },
      "Library job transition"
    );
    return true;
  }
  if (result.status === 404) {
    return false;
  }
  throw new Error(
    `Library job ${String(input.jobId)} ${input.from}→${input.to} update failed (${String(result.status)})`
  );
}
