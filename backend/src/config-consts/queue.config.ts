/**
 * BullMQ queue, job, cancellation and run-limit configuration. Values match 00 §10, §14.6 and §21 (sheet 16 §16.3).
 * Changing a name creates a new queue; do it only together with 00.
 */

/** BullMQ key prefix shared by every queue. */
export const QUEUE_PREFIX = "prvision";

/** Queue of visualization runs. */
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

/** Overall limit for one run; 07 aborts and fails the run after this (00 §14.6; 90 minutes since 00 §21). */
export const VISUALIZATION_MAX_RUNTIME_MS = 90 * 60_000;

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

// ---- Harness library jobs and live sessions (16 §16.3, §6.15) ----

/** Scan and rescan jobs: queue `harness-scans`, job name `scan`, id `scan-<libraryJobId>`. */
export const LIBRARY_SCAN_QUEUE = "harness-scans";
export const LIBRARY_SCAN_JOB = "scan";
export const LIBRARY_SCAN_JOB_ID_PREFIX = "scan-";

/** Repair jobs: queue `harness-repairs`, job name `repair`, id `repair-<libraryJobId>`. */
export const LIBRARY_REPAIR_QUEUE = "harness-repairs";
export const LIBRARY_REPAIR_JOB = "repair";
export const LIBRARY_REPAIR_JOB_ID_PREFIX = "repair-";

/** Live sessions: queue `live-sessions`, job name `live`, id `live-<liveSessionId>`. */
export const LIVE_SESSION_QUEUE = "live-sessions";
export const LIVE_SESSION_JOB = "live";
export const LIVE_SESSION_JOB_ID_PREFIX = "live-";

/** One scan and one repair at a time (each is as heavy as a run). */
export const LIBRARY_SCAN_WORKER_CONCURRENCY = 1;
export const LIBRARY_REPAIR_WORKER_CONCURRENCY = 1;

/** Library job cancellation flag: `prvision:library-cancel:<libraryJobId>`, value `1`, TTL CANCEL_KEY_TTL_SECONDS. */
export const LIBRARY_CANCEL_KEY_PREFIX = "prvision:library-cancel:";

/** Overall limit for one scan or rescan job. */
export const LIBRARY_SCAN_MAX_RUNTIME_MS = 8 * 60 * 60_000;
/** Overall limit for one repair job. */
export const LIBRARY_REPAIR_MAX_RUNTIME_MS = 30 * 60_000;

/** Live sessions running at once; also the live worker's concurrency. */
export const LIVE_MAX_SESSIONS = 2;
/** A live session stops after this long without activity (D10). */
export const LIVE_IDLE_TIMEOUT_MS = 10 * 60_000;
/** How often the frontend sends a live heartbeat. */
export const LIVE_HEARTBEAT_INTERVAL_MS = 30_000;
/** A live session stops when no heartbeat arrived for this long (the user left without a stop call). */
export const LIVE_HEARTBEAT_LOSS_MS = 90_000;
/** How often the live worker polls its session row. */
export const LIVE_POLL_INTERVAL_MS = 500;
/** Hard limit for one live session. */
export const LIVE_MAX_SESSION_MS = 4 * 60 * 60_000;
/** Time allowed to recreate the live workspace and start serving. */
export const LIVE_START_TIMEOUT_MS = 5 * 60_000;
/** Live hosts (render groups) kept running per side; least recently used is stopped first. */
export const LIVE_MAX_HOSTS_PER_SIDE = 4;
