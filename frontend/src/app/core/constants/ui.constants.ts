/** Shown in the sidebar footer. Keep equal to frontend/package.json "version". */
export const APP_VERSION = '0.1.0';

/** 00 §14.4: console `limit` default and max. */
export const CONSOLE_BATCH_LIMIT = 500;

/** Upper bound on console pages fetched in one poll tick. */
export const CONSOLE_MAX_PAGES_PER_TICK = 20;

/** Client-side cap on kept console events (oldest dropped). */
export const CONSOLE_MAX_EVENTS = 5_000;

/** Markdown longer than this is truncated before parsing. */
export const MARKDOWN_MAX_CHARS = 100_000;

/** Commits fetched per page in the New visualization dialog (00 §16: 1..200). */
export const COMMIT_PAGE_SIZE = 30;
/** Most commits a commit search returns (no paging while searching). */
export const COMMIT_SEARCH_LIMIT = 50;
/** Debounce before a typed commit search is sent. */
export const COMMIT_SEARCH_DEBOUNCE_MS = 300;

/** Recent visualizations shown on the repository detail page. */
export const RECENT_VISUALIZATIONS_LIMIT = 5;

/** States per component a repository may allow (16 D4); the default for new repositories (16 E23). */
export const STATE_ALLOWANCE_OPTIONS = [1, 2, 3, 4, 5] as const;
export const STATE_ALLOWANCE_DEFAULT = 3;

/** Largest library file the import dialog accepts (16k; equals the API body limit). */
export const LIBRARY_IMPORT_MAX_BYTES = 64 * 1024 * 1024;

/** Scan spending cap bounds in dollars (backend LIBRARY_SPEND_CAP_MIN_USD / MAX_USD). */
export const LIBRARY_SPEND_CAP_MIN_USD = 0.5;
export const LIBRARY_SPEND_CAP_MAX_USD = 10_000;

/** Debounce before a changed state allowance asks for a new estimate (16 §15.2). */
export const LIBRARY_ESTIMATE_DEBOUNCE_MS = 300;
