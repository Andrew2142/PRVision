import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, type TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed, discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { environment } from '../../../../environments/environment';
import { CONSOLE_POLL_MS, VISUALIZATION_POLL_MS } from '../../../core/constants/polling.constants';
import { CONSOLE_BATCH_LIMIT, CONSOLE_MAX_EVENTS } from '../../../core/constants/ui.constants';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type ConsoleEventView, type VisualizationDetailView } from '../../../core/models/visualization.model';
import { NotificationService } from '../../../core/services/notification.service';
import {
  componentView,
  consoleEvent,
  consoleEvents,
  detailView,
  repairJobView,
} from '../testing/visualization-fixtures';
import { VisualizationDetailStore } from './visualization-detail.store';

const BASE = environment.apiBaseUrl;
const detailUrl = (id: number): string => `${BASE}/visualizations/${String(id)}`;
const consoleUrl = (id: number): string => `${BASE}/visualizations/${String(id)}/console`;

describe('VisualizationDetailStore', () => {
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let injector: EnvironmentInjector;
  let store: VisualizationDetailStore;
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
    // A child injector stands in for the page: destroying it is "navigating away".
    injector = createEnvironmentInjector([VisualizationDetailStore], TestBed.inject(EnvironmentInjector));
    store = injector.get(VisualizationDetailStore);
    destroyed = false;
  });

  afterEach(() => {
    destroyPage();
    httpMock.verify({ ignoreCancelled: true });
  });

  function detailReqs(id = 7): TestRequest[] {
    return httpMock.match((r) => r.url === detailUrl(id));
  }
  function consoleReqs(id = 7): TestRequest[] {
    return httpMock.match((r) => r.url === consoleUrl(id));
  }
  function flushDetail(view: Partial<VisualizationDetailView> = {}, id = 7): void {
    httpMock.expectOne((r) => r.url === detailUrl(id)).flush({ status: 200, data: detailView({ id, ...view }) });
  }
  function failDetail(status: number, id = 7, reason = 'internal_error'): void {
    httpMock
      .expectOne((r) => r.url === detailUrl(id))
      .flush({ status, error: 'nope', error_reason: reason }, { status, statusText: 'x' });
  }
  function flushConsole(events: ConsoleEventView[] = [], id = 7): TestRequest {
    const req = httpMock.expectOne((r) => r.url === consoleUrl(id));
    req.flush({ status: 200, data: events });
    return req;
  }
  function drainConsole(id = 7): void {
    for (const r of consoleReqs(id)) if (!r.cancelled) r.flush({ status: 200, data: [] });
  }
  /** "Navigating away": destroys the page injector once. */
  function destroyPage(): void {
    if (destroyed) return;
    destroyed = true;
    injector.destroy();
  }
  /** Ends a test: stop pollers and drop their timers. */
  function finish(): void {
    destroyPage();
    discardPeriodicTasks();
  }

  it('polls detail every 2000 ms until terminal then stops', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'rendering' });
    drainConsole();
    expect(store.loadState()).toBe('ready');
    tick(VISUALIZATION_POLL_MS - 1);
    expect(detailReqs().length).toBe(0);
    drainConsole();
    tick(1);
    flushDetail({ status: 'diffing' });
    drainConsole();
    tick(VISUALIZATION_POLL_MS);
    flushDetail({ status: 'completed' });
    drainConsole();
    tick(VISUALIZATION_POLL_MS * 5);
    drainConsole();
    expect(detailReqs().length).toBe(0);
    expect(store.isTerminal()).toBeTrue();
    finish();
  }));

  it('a detail request slower than 2000 ms is not overlapped or cancelled (exhaustMap)', fakeAsync(() => {
    store.start(7);
    tick(0);
    const first = httpMock.expectOne((r) => r.url === detailUrl(7));
    drainConsole();
    tick(VISUALIZATION_POLL_MS * 3);
    drainConsole();
    expect(detailReqs().length).toBe(0); // no second request while the first is in flight
    expect(first.cancelled).toBeFalse();
    first.flush({ status: 200, data: detailView({ status: 'rendering' }) });
    expect(store.status()).toBe('rendering');
    tick(VISUALIZATION_POLL_MS);
    expect(detailReqs().length).toBe(1);
    drainConsole();
    finish();
  }));

  it('polls console every 1500 ms with afterId of last event', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'rendering' });
    const first = flushConsole([consoleEvent(1), consoleEvent(2)]);
    expect(first.request.params.has('afterId')).toBeFalse();
    expect(first.request.params.get('limit')).toBe(String(CONSOLE_BATCH_LIMIT));
    tick(CONSOLE_POLL_MS - 1);
    expect(consoleReqs().length).toBe(0);
    tick(1);
    const second = flushConsole([consoleEvent(3)]);
    expect(second.request.params.get('afterId')).toBe('2');
    expect(store.consoleEvents().map((e) => e.id)).toEqual([1, 2, 3]);
    tick(CONSOLE_POLL_MS);
    expect(flushConsole().request.params.get('afterId')).toBe('3');
    detailReqs();
    finish();
  }));

  it('one console fetch after terminal then stops', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'rendering' });
    flushConsole();
    tick(CONSOLE_POLL_MS); // 1500
    flushConsole();
    tick(VISUALIZATION_POLL_MS - CONSOLE_POLL_MS); // 2000
    flushDetail({ status: 'completed' });
    tick(CONSOLE_POLL_MS * 2 - VISUALIZATION_POLL_MS); // 3000: the one fetch after terminal
    flushConsole([consoleEvent(1, { message: 'done' })]);
    tick(CONSOLE_POLL_MS * 10);
    expect(consoleReqs().length).toBe(0);
    expect(store.consoleEvents().at(-1)?.message).toBe('done');
    finish();
  }));

  it('terminal on first load → single detail request', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'completed' });
    flushConsole();
    tick(VISUALIZATION_POLL_MS * 10);
    expect(detailReqs().length).toBe(0);
    expect(consoleReqs().length).toBeLessThanOrEqual(1); // at most two console ticks in total
    finish();
  }));

  it('drains console pages when batch is full (limit 500)', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'completed' });
    flushConsole(consoleEvents(1, CONSOLE_BATCH_LIMIT));
    const next = flushConsole(consoleEvents(CONSOLE_BATCH_LIMIT + 1, 3));
    expect(next.request.params.get('afterId')).toBe(String(CONSOLE_BATCH_LIMIT));
    expect(store.consoleEvents().length).toBe(CONSOLE_BATCH_LIMIT + 3);
    finish();
  }));

  it('dedupes console events by id', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'rendering' });
    flushConsole([consoleEvent(1), consoleEvent(2)]);
    tick(CONSOLE_POLL_MS);
    flushConsole([consoleEvent(2), consoleEvent(3)]);
    expect(store.consoleEvents().map((e) => e.id)).toEqual([1, 2, 3]);
    detailReqs();
    finish();
  }));

  it('caps events and sets trimmed', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'completed' });
    const pages = Math.floor(CONSOLE_MAX_EVENTS / CONSOLE_BATCH_LIMIT);
    for (let p = 0; p < pages; p++) flushConsole(consoleEvents(p * CONSOLE_BATCH_LIMIT + 1, CONSOLE_BATCH_LIMIT));
    flushConsole(consoleEvents(pages * CONSOLE_BATCH_LIMIT + 1, 10));
    expect(store.consoleEvents().length).toBe(CONSOLE_MAX_EVENTS);
    expect(store.consoleTrimmed()).toBeTrue();
    expect(store.consoleEvents()[0]?.id).toBe(11);
    expect(store.consoleEvents().at(-1)?.id).toBe(CONSOLE_MAX_EVENTS + 10);
    finish();
  }));

  it('404 → not_found and both pollers stop', fakeAsync(() => {
    store.start(7);
    tick(0);
    failDetail(404, 7, 'not_found');
    flushConsole();
    expect(store.loadState()).toBe('not_found');
    tick(VISUALIZATION_POLL_MS * 5);
    expect(detailReqs().length).toBe(0);
    expect(consoleReqs().length).toBe(0);
    finish();
  }));

  it('first-load error → error state, keeps polling, recovers', fakeAsync(() => {
    store.start(7);
    tick(0);
    failDetail(500);
    drainConsole();
    expect(store.loadState()).toBe('error');
    expect(store.loadError()?.status).toBe(500);
    expect(notifications.error.calls.count()).toBe(0); // silent GET: shown inline only
    tick(VISUALIZATION_POLL_MS);
    flushDetail({ status: 'rendering' });
    drainConsole();
    expect(store.loadState()).toBe('ready');
    expect(store.loadError()).toBeNull();
    finish();
  }));

  it('3 consecutive failures → connectionLost, cleared by success', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'rendering' });
    drainConsole();
    for (let i = 0; i < 3; i++) {
      expect(store.connectionLost()).toBeFalse();
      tick(VISUALIZATION_POLL_MS);
      failDetail(500);
      drainConsole();
    }
    expect(store.connectionLost()).toBeTrue();
    expect(store.loadState()).toBe('ready'); // data stays on screen
    tick(VISUALIZATION_POLL_MS);
    flushDetail({ status: 'rendering' });
    drainConsole();
    expect(store.connectionLost()).toBeFalse();
    finish();
  }));

  it('start(newId) cancels old pollers and resets state', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushConsole([consoleEvent(1)]);
    flushDetail({ status: 'rendering', components: [componentView()] });
    store.setFilter('all');
    tick(VISUALIZATION_POLL_MS);
    const stale = httpMock.expectOne((r) => r.url === detailUrl(7));
    drainConsole();
    store.start(8);
    expect(stale.cancelled).toBeTrue();
    expect(store.visualizationId()).toBe(8);
    expect(store.detail()).toBeNull();
    expect(store.consoleEvents()).toEqual([]);
    expect(store.loadState()).toBe('loading');
    tick(0);
    flushDetail({ status: 'rendering' }, 8);
    drainConsole(8);
    expect(store.filter()).toBe('all'); // default again: no components
    tick(VISUALIZATION_POLL_MS * 3);
    expect(detailReqs(7).length).toBe(0);
    expect(consoleReqs(7).length).toBe(0);
    detailReqs(8);
    drainConsole(8);
    finish();
  }));

  it('destroy stops polling (no pending requests)', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'rendering' });
    flushConsole();
    tick(VISUALIZATION_POLL_MS);
    const pending = httpMock.expectOne((r) => r.url === detailUrl(7));
    drainConsole();
    destroyPage();
    expect(pending.cancelled).toBeTrue();
    tick(VISUALIZATION_POLL_MS * 5);
    expect(detailReqs().length).toBe(0);
    expect(consoleReqs().length).toBe(0);
    discardPeriodicTasks();
  }));

  it('a freshly queued run with no components yet is ready with empty lists', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'queued', components: [], startedAt: null, completedAt: null });
    flushConsole();
    expect(store.loadState()).toBe('ready');
    expect(store.components()).toEqual([]);
    expect(store.counts().all).toBe(0);
    expect(store.filter()).toBe('all');
    expect(store.isTerminal()).toBeFalse();
    finish();
  }));

  it('default filter: changed when any changed, else failed, else all', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({
      status: 'completed',
      components: [
        componentView({ id: 1, visualChange: 'changed' }),
        componentView({ id: 2, renderStatus: 'failed', visualChange: null }),
      ],
    });
    expect(store.filter()).toBe('changed');
    store.refreshNow();
    tick(0);
    flushDetail({
      status: 'completed',
      components: [
        componentView({ id: 1, visualChange: 'unchanged' }),
        componentView({ id: 2, renderStatus: 'failed', visualChange: null }),
      ],
    });
    expect(store.filter()).toBe('failed');
    store.refreshNow();
    tick(0);
    flushDetail({ status: 'completed', components: [componentView({ id: 1, visualChange: 'unchanged' })] });
    expect(store.filter()).toBe('all');
    // 16 §15.5.4: a clean global-style re-check opens on "changed" (results show only what changed).
    store.refreshNow();
    tick(0);
    flushDetail({
      status: 'completed',
      components: [
        componentView({ id: 1, visualChange: 'unchanged' }),
        componentView({ id: 2, changeKind: 'rechecked', visualChange: 'unchanged' }),
      ],
    });
    expect(store.filter()).toBe('changed');
    expect(store.filteredComponents()).toEqual([]);
    expect(store.hasRechecked()).toBeTrue();
    // A failed row still wins over the re-check rule.
    store.refreshNow();
    tick(0);
    flushDetail({
      status: 'completed',
      components: [
        componentView({ id: 1, renderStatus: 'failed', visualChange: null }),
        componentView({ id: 2, changeKind: 'rechecked', visualChange: 'unchanged' }),
      ],
    });
    expect(store.filter()).toBe('failed');
    drainConsole();
    finish();
  }));

  it('setFilter overrides default', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({
      status: 'completed',
      components: [
        componentView({ id: 1, visualChange: 'changed' }),
        componentView({ id: 2, visualChange: 'unchanged' }),
      ],
    });
    drainConsole();
    store.setFilter('unchanged');
    expect(store.filter()).toBe('unchanged');
    expect(store.filteredComponents().map((c) => c.id)).toEqual([2]);
    finish();
  }));

  it('components sorted by rank then id', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({
      status: 'completed',
      components: [
        componentView({ id: 5, rank: 2 }),
        componentView({ id: 9, rank: 0 }),
        componentView({ id: 3, rank: 2 }),
        componentView({ id: 4, rank: 1 }),
      ],
    });
    drainConsole();
    expect(store.components().map((c) => c.id)).toEqual([9, 4, 3, 5]);
    finish();
  }));

  it('stoppedStageIndex uses failedStage', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'failed', failedStage: 'generating_harnesses' });
    flushConsole([consoleEvent(1, { stage: 'preparing', level: 'error' })]);
    expect(store.stoppedStageIndex()).toBe(3);
    finish();
  }));

  describe('cancel', () => {
    function startRunning(): void {
      store.start(7);
      tick(0);
      flushDetail({ status: 'rendering' });
      drainConsole();
    }
    function cancelReq(): TestRequest {
      const req = httpMock.expectOne(`${detailUrl(7)}/cancel`);
      expect(req.request.method).toBe('POST');
      return req;
    }

    it('cancel 202 → requested', fakeAsync(() => {
      startRunning();
      store.cancel();
      expect(store.cancelState()).toBe('requesting');
      store.cancel(); // second click: no second request
      cancelReq().flush({ status: 202, data: { id: 7, status: 'cancel_requested' } }, { status: 202, statusText: 'x' });
      expect(store.cancelState()).toBe('requested');
      expect(notifications.info.calls.allArgs()).toEqual([
        ['Cancellation requested. The pipeline stops at its next checkpoint.'],
      ]);
      tick(VISUALIZATION_POLL_MS);
      flushDetail({ status: 'cancelled', failedStage: 'rendering' });
      drainConsole();
      expect(store.cancelState()).toBe('idle');
      finish();
    }));

    it('cancel 200 → info + refresh', fakeAsync(() => {
      startRunning();
      store.cancel();
      cancelReq().flush({ status: 200, data: { id: 7, status: 'cancelled' } });
      expect(notifications.info.calls.allArgs()).toEqual([['Visualization cancelled.']]);
      tick(0);
      flushDetail({ status: 'cancelled', failedStage: 'queued' }); // immediate refresh, not after 2 s
      drainConsole();
      expect(store.status()).toBe('cancelled');
      expect(notifications.error.calls.count()).toBe(0);
      finish();
    }));

    it('cancel already_terminal → info + refresh', fakeAsync(() => {
      startRunning();
      store.cancel();
      cancelReq().flush(
        { status: 409, error: 'Visualization already finished', error_reason: 'already_terminal' },
        { status: 409, statusText: 'x' },
      );
      expect(store.cancelState()).toBe('idle');
      expect(notifications.info.calls.allArgs()).toEqual([['This visualization had already finished.']]);
      expect(notifications.error.calls.count()).toBe(0);
      tick(0);
      flushDetail({ status: 'completed' });
      drainConsole();
      finish();
    }));

    it('other cancel error toasts the message once', fakeAsync(() => {
      startRunning();
      store.cancel();
      cancelReq().flush(
        { status: 500, error: 'Redis is down', error_reason: 'internal_error' },
        { status: 500, statusText: 'x' },
      );
      expect(notifications.error.calls.count()).toBe(1);
      expect(store.cancelState()).toBe('idle');
      tick(VISUALIZATION_POLL_MS);
      detailReqs();
      drainConsole();
      finish();
    }));
  });

  it('remove only when terminal', fakeAsync(() => {
    store.start(7);
    tick(0);
    flushDetail({ status: 'rendering' });
    drainConsole();
    let result: boolean | undefined;
    store.remove().subscribe((ok) => (result = ok));
    expect(result).toBeFalse();
    httpMock.expectNone(detailUrl(7));

    tick(VISUALIZATION_POLL_MS);
    flushDetail({ status: 'completed' });
    drainConsole();
    result = undefined;
    store.remove().subscribe((ok) => (result = ok));
    expect(store.deleting()).toBeTrue();
    const del = httpMock.expectOne((r) => r.method === 'DELETE' && r.url === detailUrl(7));
    del.flush({ status: 200, data: { id: 7 } });
    expect(result).toBeTrue();
    expect(store.deleting()).toBeFalse();
    finish();
  }));

  describe('repair (16 §15.5)', () => {
    it('keeps polling a finished run while a repair job runs, and stops when it ends', fakeAsync(() => {
      store.start(7);
      tick(0);
      flushDetail({ status: 'completed', activeRepairJob: repairJobView() });
      drainConsole();
      tick(VISUALIZATION_POLL_MS);
      flushDetail({ status: 'completed', activeRepairJob: repairJobView({ processedCount: 2 }) });
      drainConsole();
      tick(VISUALIZATION_POLL_MS);
      flushDetail({ status: 'completed', activeRepairJob: null });
      drainConsole();
      tick(VISUALIZATION_POLL_MS * 3);
      expect(detailReqs().length).toBe(0);
      drainConsole();
      finish();
    }));

    it('repairComponent: POST, "Repair started." and a fresh detail', fakeAsync(() => {
      store.start(7);
      tick(0);
      flushDetail({ status: 'completed' });
      drainConsole();
      store.repairComponent(11);
      expect(store.repairRequests().has(11)).toBeTrue();
      store.repairComponent(11); // a second click while in flight sends nothing
      const req = httpMock.expectOne(`${BASE}/visualizations/7/components/11/repair`);
      expect(req.request.method).toBe('POST');
      req.flush({ status: 202, data: repairJobView({ componentIds: [11] }) }, { status: 202, statusText: 'Accepted' });
      expect(store.repairRequests().has(11)).toBeFalse();
      expect(notifications.success.calls.allArgs()).toEqual([['Repair started.']]);
      tick(0);
      flushDetail({ status: 'completed', activeRepairJob: repairJobView({ componentIds: [11] }) });
      drainConsole();
      finish();
    }));

    it('repair errors are toasted with the server message and refresh the detail', fakeAsync(() => {
      store.start(7);
      tick(0);
      flushDetail({ status: 'completed' });
      drainConsole();
      store.repairComponent(11);
      httpMock
        .expectOne(`${BASE}/visualizations/7/components/11/repair`)
        .flush(
          { status: 409, error: "This component's harness does not need repair.", error_reason: 'conflict' },
          { status: 409, statusText: 'Conflict' },
        );
      expect(notifications.error.calls.allArgs()).toEqual([["This component's harness does not need repair."]]);
      tick(0);
      flushDetail({ status: 'completed' });
      drainConsole();
      finish();
    }));

    it('repairBroken: one request at a time, none while a repair job runs', fakeAsync(() => {
      store.start(7);
      tick(0);
      flushDetail({ status: 'completed', needsUpdateCount: 2 });
      drainConsole();
      store.repairBroken();
      store.repairBroken();
      const req = httpMock.expectOne(`${BASE}/visualizations/7/repair-broken`);
      req.flush({ status: 202, data: repairJobView() }, { status: 202, statusText: 'Accepted' });
      tick(0);
      flushDetail({ status: 'completed', needsUpdateCount: 2, activeRepairJob: repairJobView() });
      drainConsole();
      store.repairBroken();
      expect(store.repairAllRequesting()).toBeFalse();
      expect(store.activeRepairJob()?.kind).toBe('repair');
      httpMock.expectNone(`${BASE}/visualizations/7/repair-broken`);
      finish();
    }));
  });
});
