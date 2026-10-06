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
