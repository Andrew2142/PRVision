/**
 * BullMQ queue, job, cancellation and run-limit configuration. Values match 00 §10 and §14.6.
 * Changing a name creates a new queue; do it only together with 00.
 */

/** BullMQ key prefix shared by every queue. */
export const QUEUE_PREFIX = "prvision";

/** The single queue PRVision uses. */
export const VISUALIZATION_QUEUE = "visualizations";

/** Job name for a visualization run. */
export const VISUALIZATION_JOB = "visualize";

/** `jobId = viz-<visualizationId>` makes enqueueing idempotent. */
export const VISUALIZATION_JOB_ID_PREFIX = "viz-";

/** One visualization at a time (CPU, Chromium and Vite servers are heavy). */
export const VISUALIZATION_WORKER_CONCURRENCY = 1;

/** No automatic retry: a rerun is a new visualization. */
export const VISUALIZATION_JOB_ATTEMPTS = 1;

/** Job history kept in Redis for inspection. */
export const JOB_RETENTION = {
  removeOnComplete: { count: 200 },
  removeOnFail: { count: 500 }
} as const;

/** BullMQ lock; renewed every half period while the event loop is free (00 §14.6). */
export const WORKER_LOCK_DURATION_MS = 300_000;

/** A stalled job (worker died, lock lost) is failed, never re-run (00 §14.6); 07's boot recovery marks the row. */
export const WORKER_MAX_STALLED_COUNT = 0;

/** Graceful `worker.close()` wait before forcing it during shutdown. */
export const WORKER_CLOSE_TIMEOUT_MS = 10_000;

/** Cancellation flag key prefix: `prvision:cancel:<visualizationId>`, value `1` (00 §10). */
export const CANCEL_KEY_PREFIX = "prvision:cancel:";

/** Cancellation flag TTL: one day (00 §10). */
export const CANCEL_KEY_TTL_SECONDS = 86_400;

/** How often QueueService polls the cancellation flag of the active job (00 §14.6). */
export const CANCEL_POLL_INTERVAL_MS = 1_000;

/** Overall limit for one run; 07 aborts and fails the run after this (00 §14.6). */
export const VISUALIZATION_MAX_RUNTIME_MS = 45 * 60_000;

/** After the run signal aborted, a step that has not settled within this is abandoned (07 awaitStep). */
export const STEP_ABORT_GRACE_MS = 30_000;

/** A queued row without a BullMQ job older than this is failed by 07's recovery. */
export const QUEUED_RECOVERY_GRACE_MS = 60_000;

/** An active row whose job is not active and that was not updated for this long is failed by 07's sweep. */
export const RUNNING_RECOVERY_GRACE_MS = 60_000;

/** Interval of 07's periodic recovery sweep. */
export const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Max rows one recovery query handles; the rest are handled by the next sweep. */
export const RECOVERY_BATCH_LIMIT = 500;

/** working_tree runs: max untracked files copied into the head worktree (07). */
export const WORKING_TREE_MAX_UNTRACKED_FILES = 2_000;

/** working_tree runs: max total bytes of untracked files copied (07). */
export const WORKING_TREE_MAX_UNTRACKED_BYTES = 200 * 1024 * 1024;

/** `head_ref` stored for working_tree visualizations (07). */
export const WORKING_TREE_HEAD_REF = "working-tree";

/** Max length of one console event message (07, 01 §5.8); longer messages are truncated with "…". */
export const CONSOLE_MESSAGE_MAX_LENGTH = 4_000;
