/**
 * List endpoint paging (00 §9: `page` 1-based, `pageSize` default 20, max 100; 00 §14.4: console limit
 * default and max 500).
 */

/** First page number. */
export const DEFAULT_PAGE = 1;

/** Default `pageSize`. */
export const DEFAULT_PAGE_SIZE = 20;

/** Max `pageSize` accepted by query DTOs. */
export const MAX_PAGE_SIZE = 100;

/** Default and max `limit` of GET /api/visualizations/:id/console (07). */
export const CONSOLE_PAGE_LIMIT_MAX = 500;
