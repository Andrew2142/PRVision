import { ApiError } from '../models/api-error.model';
import { API_ERROR_REASONS } from '../models/api.model';
import { ERROR_REASON_COPY, errorCopyFor, userMessageFor } from './error-messages.util';

describe('error-messages.util', () => {
  it('every ApiErrorReason has copy', () => {
    for (const reason of API_ERROR_REASONS) {
      expect(ERROR_REASON_COPY[reason].title).withContext(reason).toBeTruthy();
    }
    expect(Object.keys(ERROR_REASON_COPY).sort()).toEqual([...API_ERROR_REASONS].sort());
  });

  it('userMessageFor uses fixed copy when present', () => {
    const error = new ApiError('server text', 400, 'working_tree_clean');
    expect(userMessageFor(error)).toBe('The working tree has no uncommitted changes.');
  });

  it('falls back to the server message for validation_failed, conflict, ai_*', () => {
    for (const reason of ['validation_failed', 'conflict', 'ai_not_configured', 'ai_unauthorized'] as const) {
      const error = new ApiError(`server says ${reason}`, 400, reason);
      expect(userMessageFor(error)).withContext(reason).toBe(`server says ${reason}`);
      expect(errorCopyFor(error).message).withContext(reason).toBe(`server says ${reason}`);
    }
  });

  it('no reason → server message', () => {
    const error = new ApiError('Request failed (HTTP 418).', 418, null);
    expect(userMessageFor(error)).toBe('Request failed (HTTP 418).');
    expect(errorCopyFor(error)).toEqual({ title: 'Something went wrong', message: 'Request failed (HTTP 418).' });
  });

  it('settings reasons carry actionRoute /settings', () => {
    for (const reason of [
      'github_token_missing',
      'github_unauthorized',
      'ai_not_configured',
      'ai_unauthorized',
    ] as const) {
      const copy = errorCopyFor(new ApiError('x', 400, reason));
      expect(copy.actionRoute).withContext(reason).toBe('/settings');
      expect(copy.actionLabel).withContext(reason).toBe('Open settings');
    }
  });
});
