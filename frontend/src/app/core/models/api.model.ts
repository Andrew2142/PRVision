// Wire format 00 §14.2 (the only format the frontend supports).

export interface ApiEnvelope<T> {
  status: number;
  data: T;
}

export interface ApiErrorBody {
  status: number;
  error: string | string[];
  error_reason?: string;
}

export interface Paged<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PageQuery {
  page?: number;
  pageSize?: number;
}

/** DELETE /api/repositories/:id and /api/visualizations/:id → 200 { id } (00 §14.4). */
export interface DeleteResult {
  id: number;
}

/** GET /api/health, always HTTP 200 (00 §14.4). */
export interface HealthView {
  status: 'ok' | 'degraded';
  database: boolean;
  redis: boolean;
  version: string;
}

/** Complete list from 00 §14.2. */
export const API_ERROR_REASONS = [
  'validation_failed',
  'not_found',
  'conflict',
  'forbidden_origin',
  'payload_too_large',
  'internal_error',
  'not_git_repo',
  'unsupported_framework',
  'missing_node_modules',
  'no_github_remote',
  'github_token_missing',
  'github_unauthorized',
  'github_rate_limited',
  'github_unavailable',
  'ai_not_configured',
  'ai_unauthorized',
  'already_terminal',
  'working_tree_clean',
] as const;
export type ApiErrorReason = (typeof API_ERROR_REASONS)[number];
