import { HttpClient, HttpContext, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { ApiError, NETWORK_ERROR_MESSAGE } from '../models/api-error.model';
import { NotificationService } from '../services/notification.service';
import { errorInterceptor } from './error.interceptor';
import { SUPPRESS_ERROR_TOAST } from './http-context-tokens';

describe('errorInterceptor', () => {
  const url = '/api/thing';
  let client: HttpClient;
  let http: HttpTestingController;
  let notifyError: jasmine.Spy<NotificationService['error']>;

  beforeEach(() => {
    notifyError = jasmine.createSpy<NotificationService['error']>('error');
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: { error: notifyError } },
      ],
    });
    client = TestBed.inject(HttpClient);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
  });

  function request(silent = false): () => unknown {
    let error: unknown;
    client
      .get(url, { context: new HttpContext().set(SUPPRESS_ERROR_TOAST, silent) })
      .subscribe({ error: (e: unknown) => (error = e) });
    return () => error;
  }

  it('maps {status,error,error_reason} to ApiError', () => {
    const error = request(true);
    http
      .expectOne(url)
      .flush(
        { status: 409, error: 'Visualization is still running', error_reason: 'conflict' },
        { status: 409, statusText: 'Conflict' },
      );
    const e = error() as ApiError;
    expect(e.status).toBe(409);
    expect(e.message).toBe('Visualization is still running');
    expect(e.errorReason).toBe('conflict');
    expect(e.details).toEqual([]);
  });

  it('string[] error → message + details', () => {
    const error = request(true);
    http.expectOne(url).flush(
      {
        status: 400,
        error: ['repositoryId must be a number', 'sourceType is required'],
        error_reason: 'validation_failed',
      },
      { status: 400, statusText: 'Bad Request' },
    );
    const e = error() as ApiError;
    expect(e.message).toBe('repositoryId must be a number');
    expect(e.details).toEqual(['sourceType is required']);
    expect(e.is('validation_failed')).toBeTrue();
  });

  it('status 0 yields network message', () => {
    const error = request(true);
    http.expectOne(url).error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    const e = error() as ApiError;
    expect(e.status).toBe(0);
    expect(e.isNetworkError).toBeTrue();
    expect(e.message).toBe(NETWORK_ERROR_MESSAGE);
  });

  it('non-JSON error body → status default message', () => {
    const error = request(true);
    http.expectOne(url).flush('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' });
    const e = error() as ApiError;
    expect(e.status).toBe(502);
    expect(e.errorReason).toBeNull();
    expect(e.message).toBe('The PRVision API hit an internal error. Check the backend log.');
  });

  it('unknown reason → errorReason null', () => {
    const error = request(true);
    http
      .expectOne(url)
      .flush(
        { status: 400, error: 'Nope', error_reason: 'brand_new_reason' },
        { status: 400, statusText: 'Bad Request' },
      );
    const e = error() as ApiError;
    expect(e.errorReason).toBeNull();
    expect(e.message).toBe('Nope');
  });

  it('toasts userMessageFor(error) once when not suppressed', () => {
    request(false);
    http
      .expectOne(url)
      .flush(
        { status: 400, error: 'raw server text', error_reason: 'not_git_repo' },
        { status: 400, statusText: 'Bad Request' },
      );
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(notifyError.calls.mostRecent().args[0]).toContain('not a git repository');
  });

  it('does not toast when SUPPRESS_ERROR_TOAST is true', () => {
    request(true);
    http
      .expectOne(url)
      .flush({ status: 500, error: 'boom', error_reason: 'internal_error' }, { status: 500, statusText: 'x' });
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('rethrows ApiError instance', () => {
    const error = request(true);
    http
      .expectOne(url)
      .flush({ status: 404, error: 'Missing', error_reason: 'not_found' }, { status: 404, statusText: 'x' });
    expect(error()).toBeInstanceOf(ApiError);
    expect((error() as ApiError).isNotFound).toBeTrue();
  });
});
