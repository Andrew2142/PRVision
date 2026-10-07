import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, type TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed, discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { environment } from '../../../../environments/environment';
import { LIBRARY_JOB_EVENTS_POLL_MS, LIBRARY_JOB_POLL_MS } from '../../../core/constants/polling.constants';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type LibraryJobEventView, type LibraryJobView } from '../../../core/models/harness-library.model';
import { NotificationService } from '../../../core/services/notification.service';
import { libraryJobEvent, libraryJobView } from '../../repositories/testing/library-fixtures';
import { LibraryJobDetailStore } from './library-job-detail.store';

const BASE = environment.apiBaseUrl;
const jobUrl = (id: number): string => `${BASE}/library-jobs/${String(id)}`;
const eventsUrl = (id: number): string => `${BASE}/library-jobs/${String(id)}/events`;

describe('LibraryJobDetailStore', () => {
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let injector: EnvironmentInjector;
  let store: LibraryJobDetailStore;
  let destroyed = false;

  beforeEach(() => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    injector = createEnvironmentInjector([LibraryJobDetailStore], TestBed.inject(EnvironmentInjector));
    store = injector.get(LibraryJobDetailStore);
    destroyed = false;
  });

  afterEach(() => {
    destroyPage();
    httpMock.verify({ ignoreCancelled: true });
  });

  function destroyPage(): void {
    if (destroyed) return;
    destroyed = true;
    injector.destroy();
  }
  function finish(): void {
    destroyPage();
    discardPeriodicTasks();
  }
  function jobReqs(id = 5): TestRequest[] {
    return httpMock.match((r) => r.url === jobUrl(id));
  }
  function eventReqs(id = 5): TestRequest[] {
    return httpMock.match((r) => r.url === eventsUrl(id));
  }
  function flushJob(overrides: Partial<LibraryJobView> = {}, id = 5): void {
    httpMock.expectOne((r) => r.url === jobUrl(id)).flush({ status: 200, data: libraryJobView({ id, ...overrides }) });
  }
  function flushEvents(events: LibraryJobEventView[] = [], id = 5): TestRequest {
    const req = httpMock.expectOne((r) => r.url === eventsUrl(id));
    req.flush({ status: 200, data: events });
    return req;
  }
  function drainEvents(id = 5): void {
    for (const r of eventReqs(id)) if (!r.cancelled) r.flush({ status: 200, data: [] });
  }

  it('polls the job every 2 s while active and stops at a terminal status', fakeAsync(() => {
    store.start(5);
    tick(0);
    flushJob({ status: 'running' });
    drainEvents();
    expect(store.loadState()).toBe('ready');
    tick(LIBRARY_JOB_POLL_MS - 1);
    expect(jobReqs().length).toBe(0);
    drainEvents();
    tick(1);
    flushJob({ status: 'cap_reached', completedAt: '2026-10-03T10:30:00Z' });
    expect(store.isTerminal()).toBeTrue();
    drainEvents();
    tick(LIBRARY_JOB_POLL_MS * 3);
    expect(jobReqs().length).toBe(0);
    drainEvents();
    finish();
  }));

  it('polls events every 1.5 s with afterId, oldest first, and one last time after the job ends', fakeAsync(() => {
    store.start(5);
    tick(0);
    flushJob({ status: 'running' });
    const first = flushEvents([libraryJobEvent(1), libraryJobEvent(2)]);
    expect(first.request.params.has('afterId')).toBeFalse();
    expect(first.request.params.get('limit')).toBe('500');
    tick(LIBRARY_JOB_EVENTS_POLL_MS);
    const second = flushEvents([libraryJobEvent(3)]);
    expect(second.request.params.get('afterId')).toBe('2');
    expect(store.events().map((e) => e.id)).toEqual([1, 2, 3]);
    tick(LIBRARY_JOB_POLL_MS - LIBRARY_JOB_EVENTS_POLL_MS);
    flushJob({ status: 'completed' });
    tick(LIBRARY_JOB_EVENTS_POLL_MS * 2 - LIBRARY_JOB_POLL_MS);
    flushEvents([libraryJobEvent(4, { message: 'Done.' })]);
    tick(LIBRARY_JOB_EVENTS_POLL_MS * 4);
    expect(eventReqs().length).toBe(0);
    expect(store.events().at(-1)?.message).toBe('Done.');
    finish();
  }));

  it('a terminal job on first load makes a single job request', fakeAsync(() => {
    store.start(5);
    tick(0);
    flushJob({ status: 'completed' });
    drainEvents();
    tick(LIBRARY_JOB_POLL_MS * 3);
    expect(jobReqs().length).toBe(0);
    drainEvents();
    finish();
  }));

  it('404 → not_found and both pollers stop', fakeAsync(() => {
    store.start(5);
    tick(0);
    httpMock
      .expectOne((r) => r.url === jobUrl(5))
      .flush({ status: 404, error: 'Not found', error_reason: 'not_found' }, { status: 404, statusText: 'x' });
    drainEvents();
    expect(store.loadState()).toBe('not_found');
    tick(LIBRARY_JOB_POLL_MS * 3);
    expect(jobReqs().length).toBe(0);
    expect(eventReqs().length).toBe(0);
    finish();
  }));

  it('a first-load error → error state', fakeAsync(() => {
    store.start(5);
    tick(0);
    httpMock
      .expectOne((r) => r.url === jobUrl(5))
      .flush({ status: 500, error: 'boom', error_reason: 'internal_error' }, { status: 500, statusText: 'x' });
    drainEvents();
    expect(store.loadState()).toBe('error');
    expect(store.loadError()?.message).toBe('boom');
    expect(notifications.error.calls.count()).toBe(0);
    finish();
  }));

  it('destroy stops polling', fakeAsync(() => {
    store.start(5);
    tick(0);
    flushJob({ status: 'running' });
    drainEvents();
    destroyPage();
    tick(LIBRARY_JOB_POLL_MS * 3);
    expect(jobReqs().length).toBe(0);
    expect(eventReqs().length).toBe(0);
    finish();
  }));

  describe('cancel', () => {
    function ready(): void {
      store.start(5);
      tick(0);
      flushJob({ status: 'running' });
      drainEvents();
    }

    it('202 → requested', fakeAsync(() => {
      ready();
      store.cancel();
      expect(store.cancelState()).toBe('requesting');
      httpMock
        .expectOne(`${BASE}/library-jobs/5/cancel`)
        .flush({ status: 202, data: { id: 5, status: 'cancel_requested' } }, { status: 202, statusText: 'Accepted' });
      expect(store.cancelState()).toBe('requested');
      expect(notifications.info.calls.allArgs()).toEqual([
        ['Cancellation requested. The job stops after the current batch.'],
      ]);
      finish();
    }));

    it('200 → cancelled and refreshed', fakeAsync(() => {
      ready();
      store.cancel();
      httpMock.expectOne(`${BASE}/library-jobs/5/cancel`).flush({ status: 200, data: { id: 5, status: 'cancelled' } });
      expect(notifications.info.calls.allArgs()).toEqual([['Job cancelled.']]);
      tick(0);
      flushJob({ status: 'cancelled' });
      drainEvents();
      expect(store.isTerminal()).toBeTrue();
      finish();
    }));

    it('already_terminal → info and refresh', fakeAsync(() => {
      ready();
      store.cancel();
      httpMock
        .expectOne(`${BASE}/library-jobs/5/cancel`)
        .flush(
          { status: 409, error: 'Already finished.', error_reason: 'already_terminal' },
          { status: 409, statusText: 'Conflict' },
        );
      expect(store.cancelState()).toBe('idle');
      expect(notifications.info.calls.allArgs()).toEqual([['This job had already finished.']]);
      tick(0);
      flushJob({ status: 'completed' });
      drainEvents();
      finish();
    }));

    it('other errors are toasted once', fakeAsync(() => {
      ready();
      store.cancel();
      httpMock
        .expectOne(`${BASE}/library-jobs/5/cancel`)
        .flush({ status: 500, error: 'Redis down', error_reason: 'internal_error' }, { status: 500, statusText: 'x' });
      expect(notifications.error.calls.allArgs()).toEqual([['Redis down']]);
      finish();
    }));

    it('no cancel request for a terminal job', fakeAsync(() => {
      store.start(5);
      tick(0);
      flushJob({ status: 'failed' });
      drainEvents();
      store.cancel();
      expect(store.cancelState()).toBe('idle');
      httpMock.expectNone(`${BASE}/library-jobs/5/cancel`);
      finish();
    }));
  });
});
