import { HttpErrorResponse } from '@angular/common/http';
import { ApiError, toApiError } from './api-error.model';

describe('ApiError', () => {
  it('isNotFound for 404 and not_found', () => {
    expect(new ApiError('x', 404, null).isNotFound).toBeTrue();
    expect(new ApiError('x', 400, 'not_found').isNotFound).toBeTrue();
    expect(new ApiError('x', 409, 'conflict').isNotFound).toBeFalse();
  });

  it('is(reason)', () => {
    const error = new ApiError('x', 400, 'working_tree_clean');
    expect(error.is('working_tree_clean')).toBeTrue();
    expect(error.is('conflict')).toBeFalse();
    expect(error.name).toBe('ApiError');
  });

  it('toApiError passes through ApiError', () => {
    const error = new ApiError('x', 409, 'conflict');
    expect(toApiError(error)).toBe(error);
  });

  it('non-HTTP error → status -1', () => {
    const fromError = toApiError(new Error('kaput'));
    expect(fromError.status).toBe(-1);
    expect(fromError.message).toBe('kaput');
    expect(toApiError('weird').status).toBe(-1);
    expect(toApiError(new HttpErrorResponse({ status: 404 })).message).toBe('Not found.');
  });
});
