/** Visualization detail polling interval while status is non-terminal (00 §12). */
export const VISUALIZATION_POLL_MS = 2_000;

/** Console polling interval while status is non-terminal (00 §12). */
export const CONSOLE_POLL_MS = 1_500;

/** API health poll interval for the top-bar pill (sheet 12 §6.10.2). */
export const HEALTH_POLL_MS = 30_000;

/** Consecutive detail-poll failures before the inline banner shows (sheet 13). */
export const POLL_FAILURE_BANNER_THRESHOLD = 3;
