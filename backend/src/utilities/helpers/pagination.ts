import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from "../../config-consts";

/** Resolved page request: 1-based `page`, capped `pageSize`, and the matching SQL limit/offset. */
export interface PageRequest {
  page: number;
  pageSize: number;
  limit: number;
  offset: number;
}

/** Paged response shape of every list endpoint (00 §9). */
export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

/**
 * Applies the paging defaults (00 §9) to a validated PaginationQueryDTO.
 *
 * @param input - Optional `page` (1-based) and `pageSize`.
 * @returns The page request with `limit`/`offset` for QueryHandler.selectMany.
 */
export function resolvePageRequest(input: { page?: number; pageSize?: number }): PageRequest {
  const page = input.page ?? DEFAULT_PAGE;
  const pageSize = Math.min(input.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}
