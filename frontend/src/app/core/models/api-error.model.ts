import { HttpErrorResponse } from '@angular/common/http';
import { API_ERROR_REASONS, type ApiErrorBody, type ApiErrorReason } from './api.model';

export const NETWORK_ERROR_MESSAGE =
  "Can't reach the PRVision API at http://localhost:3100. Is the backend running (npm run dev)?";

export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    message: string,
    /** HTTP status; 0 = network failure / API unreachable; -1 = non-HTTP or malformed response. */
    readonly status: number,
    /** The wire `error_reason`, when it is one of the 00 §14.2 codes. */
    readonly errorReason: ApiErrorReason | null,
    /** Further validation messages when the server sent `error` as a string[] (first entry is `message`). */
    readonly details: readonly string[] = [],
  ) {
    super(message);
  }

  get isNetworkError(): boolean {
    return this.status === 0;
  }

  get isNotFound(): boolean {
    return this.status === 404 || this.errorReason === 'not_found';
  }

  is(reason: ApiErrorReason): boolean {
    return this.errorReason === reason;
  }
}

/** Maps anything thrown by the Angular HTTP layer (or our own code) to ApiError. Only the 00 §14.2 error body is parsed. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return new ApiError(NETWORK_ERROR_MESSAGE, 0, null);
    return fromErrorBody(error.error, error.status);
  }
  return new ApiError(error instanceof Error ? error.message : 'Unexpected error.', -1, null);
}

function fromErrorBody(raw: unknown, status: number): ApiError {
  const body = isErrorBody(raw) ? raw : null;
  const messages = body ? (Array.isArray(body.error) ? body.error : [body.error]) : [];
  const [first, ...rest] = messages;
  return new ApiError(first ?? defaultMessageForStatus(status), status, knownReason(body?.error_reason), rest);
}

function isErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== 'object' || v === null || !('error' in v)) return false;
  const error: unknown = v.error;
  return typeof error === 'string' || (Array.isArray(error) && error.every((e) => typeof e === 'string'));
}

function knownReason(v: unknown): ApiErrorReason | null {
  return typeof v === 'string' && (API_ERROR_REASONS as readonly string[]).includes(v) ? (v as ApiErrorReason) : null;
}

function defaultMessageForStatus(status: number): string {
  if (status === 404) return 'Not found.';
  // Every input/settings reason is 400 (00 §14.12); 422 is never sent.
  if (status === 400) return 'The request was rejected as invalid.';
  if (status === 409) return 'That action conflicts with the current state.';
  if (status === 413) return 'The request is too large.';
  if (status >= 500) return 'The PRVision API hit an internal error. Check the backend log.';
  return `Request failed (HTTP ${status}).`;
}
