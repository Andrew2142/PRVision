/** Visualization detail polling interval while status is non-terminal (00 §12). */
export const VISUALIZATION_POLL_MS = 2_000;

/** Console polling interval while status is non-terminal (00 §12). */
export const CONSOLE_POLL_MS = 1_500;

/** API health poll interval for the top-bar pill (sheet 12 §6.10.2). */
export const HEALTH_POLL_MS = 30_000;

/** Consecutive detail-poll failures before the inline banner shows (sheet 13). */
export const POLL_FAILURE_BANNER_THRESHOLD = 3;

/** Harness library card: summary refresh while a scan runs (16 §16.5). */
export const LIBRARY_SUMMARY_POLL_MS = 3_000;

/** Library job page: job refresh while active. */
export const LIBRARY_JOB_POLL_MS = 2_000;

/** Library job page: console refresh while active. */
export const LIBRARY_JOB_EVENTS_POLL_MS = 1_500;

/** Live mode (16j): session polling while starting, and otherwise. */
export const LIVE_POLL_FAST_MS = 1_000;
export const LIVE_POLL_SLOW_MS = 10_000;
