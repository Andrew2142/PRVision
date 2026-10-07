import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, type TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed, fakeAsync, tick } from '@angular/core/testing';
import { environment } from '../../../../environments/environment';
import { LIVE_POLL_FAST_MS, LIVE_POLL_SLOW_MS } from '../../../core/constants/polling.constants';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type LiveSessionView } from '../../../core/models/live-session.model';
import { NotificationService } from '../../../core/services/notification.service';
import { liveHost, liveSession, readyHosts } from '../testing/live-fixtures';
import { LIVE_FRAME_ATTRIBUTE, LiveSessionStore, liveSideUrl } from './live-session.store';

const BASE = environment.apiBaseUrl;
const liveUrl = `${BASE}/visualizations/7/live`;
const PARENT = encodeURIComponent(window.location.origin);
const TWO_SESSIONS =
  'Live mode is already running for 2 other runs. Leave one of them first (it also stops by itself after 10 minutes idle).';

describe('liveSideUrl', () => {
  const host = { origin: 'http://127.0.0.1:51002', harnessUrlPath: '/.prvision-harness/index.html' };

  it('builds the sheet URL with the encoded state and parent origin (16 §14.6)', () => {
    expect(liveSideUrl(host, 11, 'Menu open', 'http://localhost:4210')).toBe(
      'http://127.0.0.1:51002/.prvision-harness/index.html?c=11&s=Menu%20open&live=1&parent=http%3A%2F%2Flocalhost%3A4210',
    );
    expect(liveSideUrl({ ...host, harnessUrlPath: '/index.html' }, 4, 'A&B=?', 'http://x')).toBe(
      'http://127.0.0.1:51002/index.html?c=4&s=A%26B%3D%3F&live=1&parent=http%3A%2F%2Fx',
    );
  });

  it('only frames 127.0.0.1 live hosts with a plain absolute path', () => {
    const bad = [
      { origin: 'http://localhost:51002', harnessUrlPath: '/index.html' },
      { origin: 'https://127.0.0.1:51002', harnessUrlPath: '/index.html' },
      { origin: 'http://127.0.0.1', harnessUrlPath: '/index.html' },
      { origin: 'http://127.0.0.1:70000', harnessUrlPath: '/index.html' },
      { origin: 'http://127.0.0.1:5100/x', harnessUrlPath: '/index.html' },
      { origin: 'http://evil.test:5100', harnessUrlPath: '/index.html' },
      { origin: 'javascript:alert(1)//', harnessUrlPath: '/index.html' },
      { origin: 'http://127.0.0.1:5100', harnessUrlPath: '//evil.test/x' },
      { origin: 'http://127.0.0.1:5100', harnessUrlPath: 'index.html' },
      { origin: 'http://127.0.0.1:5100', harnessUrlPath: '/../x.html' },
      { origin: 'http://127.0.0.1:5100', harnessUrlPath: '/index.html?x=1' },
      { origin: 'http://127.0.0.1:5100', harnessUrlPath: '/index.html#x' },
      { origin: null, harnessUrlPath: '/index.html' },
      { origin: 'http://127.0.0.1:5100', harnessUrlPath: null },
    ];
    for (const h of bad)
      expect(liveSideUrl(h, 1, 'Default', 'http://x'))
        .withContext(JSON.stringify(h))
        .toBeNull();
  });
});

describe('LiveSessionStore', () => {
  let httpMock: HttpTestingController;
  let injector: EnvironmentInjector;
  let store: LiveSessionStore;
  let destroyed = false;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: jasmine.createSpyObj('NotificationService', ['error']) },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    // A child injector stands in for the detail page: destroying it is "leaving the run".
    injector = createEnvironmentInjector([LiveSessionStore], TestBed.inject(EnvironmentInjector));
    store = injector.get(LiveSessionStore);
    destroyed = false;
  });

  afterEach(() => {
    leave();
    for (const r of httpMock.match((req) => req.url === `${liveUrl}/stop`)) r.flush({ status: 200, data: {} });
    httpMock.verify({ ignoreCancelled: true });
  });

  function leave(): void {
    if (destroyed) return;
    destroyed = true;
    injector.destroy();
  }
  function ok(req: TestRequest, data: unknown, status = 200): void {
    req.flush({ status, data }, { status, statusText: 'OK' });
  }
  function fail(req: TestRequest, status: number, error: string, reason: string): void {
    req.flush({ status, error, error_reason: reason }, { status, statusText: 'x' });
  }
  function startReq(): TestRequest {
    return httpMock.expectOne((r) => r.method === 'POST' && r.url === liveUrl);
  }
  function polls(): TestRequest[] {
    return httpMock.match((r) => r.method === 'GET' && r.url === liveUrl);
  }
  function heartbeats(): TestRequest[] {
    return httpMock.match((r) => r.url === `${liveUrl}/heartbeat`);
  }
  /** Starts a session and answers with `session`. */
  function started(session: Partial<LiveSessionView> = {}): void {
    store.attach(7);
    store.start();
    ok(startReq(), liveSession(session), 202);
  }
  /** Answers every pending poll with `session`. */
  function answerPolls(session: Partial<LiveSessionView>): number {
    const pending = polls();
    for (const r of pending) ok(r, liveSession(session));
    return pending.length;
  }
  /** Ends a fakeAsync test: leave the page, answer its stop request. */
  function finish(): void {
    leave();
    for (const r of httpMock.match((req) => req.url === `${liveUrl}/stop`)) ok(r, { id: 3, status: 'stopping' });
    for (const r of heartbeats()) ok(r, { status: 'stopping' });
  }

  it('start posts once and shows starting, then the session', fakeAsync(() => {
    store.attach(7);
    store.start();
    store.start(); // a second click while the first is in flight is ignored
    expect(store.starting()).toBeTrue();
    const req = startReq();
    expect(req.request.body).toEqual({});
    ok(req, liveSession({ status: 'starting', readyAt: null }), 202);
    expect(store.starting()).toBeFalse();
    expect(store.session()?.status).toBe('starting');
    expect(store.active()).toBeTrue();
    finish();
  }));

  it('polls every 1 s while starting and every 10 s once ready', fakeAsync(() => {
    started({ status: 'starting', readyAt: null });
    tick(LIVE_POLL_FAST_MS - 1);
    expect(polls().length).toBe(0);
    tick(1);
    expect(answerPolls({ status: 'starting', readyAt: null })).toBe(1);
    tick(LIVE_POLL_FAST_MS);
    expect(answerPolls({ status: 'ready' })).toBe(1);
    tick(LIVE_POLL_FAST_MS);
    expect(polls().length).toBe(0);
    tick(LIVE_POLL_SLOW_MS - LIVE_POLL_FAST_MS);
    expect(answerPolls({ status: 'ready' })).toBe(1);
    finish();
  }));

  it('stops polling and heartbeats once the session is stopped', fakeAsync(() => {
    started();
    tick(LIVE_POLL_SLOW_MS);
    expect(answerPolls({ status: 'stopped', stopReason: 'idle', stoppedAt: '2026-10-07T10:11:00.000Z' })).toBe(1);
    expect(store.active()).toBeFalse();
    tick(60_000);
    expect(polls().length).toBe(0);
    expect(heartbeats().length).toBe(0);
    finish();
    expect(httpMock.match((r) => r.url === `${liveUrl}/stop`).length).toBe(0);
  }));

  it('409 for the two-session limit is shown as the start error', fakeAsync(() => {
    store.attach(7);
    store.start();
    fail(startReq(), 409, TWO_SESSIONS, 'conflict');
    expect(store.starting()).toBeFalse();
    expect(store.session()).toBeNull();
    expect(store.error()).toBe(TWO_SESSIONS);
    // Start again clears the error.
    store.start();
    expect(store.error()).toBeNull();
    ok(startReq(), liveSession(), 202);
    finish();
  }));

  it('ensureOpen posts once per component and state, polls fast until both hosts are ready', fakeAsync(() => {
    started();
    store.ensureOpen(11, 'Menu open');
    store.ensureOpen(11, 'Menu open');
    const open = httpMock.expectOne(`${liveUrl}/open`);
    expect(open.request.body).toEqual({ componentId: 11, stateName: 'Menu open' });
    ok(open, liveSession({ hosts: [liveHost({ side: 'base', status: 'starting', origin: null })] }), 202);
    expect(store.urlFor(11, 'Menu open', 'base')).toBeNull();
    tick(LIVE_POLL_FAST_MS);
    expect(answerPolls({ hosts: [liveHost({ side: 'base' })] })).toBe(1); // head not listed yet: still pending
    tick(LIVE_POLL_FAST_MS);
    expect(answerPolls({ hosts: readyHosts() })).toBe(1);
    tick(LIVE_POLL_FAST_MS);
    expect(polls().length).toBe(0);
    tick(LIVE_POLL_SLOW_MS - LIVE_POLL_FAST_MS);
    expect(answerPolls({ hosts: readyHosts() })).toBe(1);
    expect(store.urlFor(11, 'Menu open', 'base')).toBe(
      `http://127.0.0.1:51001/.prvision-harness/index.html?c=11&s=Menu%20open&live=1&parent=${PARENT}`,
    );
    expect(store.urlFor(11, 'Menu open', 'head')).toBe(
      `http://127.0.0.1:51002/.prvision-harness/index.html?c=11&s=Menu%20open&live=1&parent=${PARENT}`,
    );
    // Another state of the same card opens again (D10: Live follows the open state tab).
    store.ensureOpen(11, 'Default');
    ok(httpMock.expectOne(`${liveUrl}/open`), liveSession({ hosts: readyHosts() }), 202);
    finish();
  }));

  it('a one-sided state waits only for the side it exists on', fakeAsync(() => {
    started();
    store.ensureOpen(11, 'Default', { base: false, head: true });
    ok(httpMock.expectOne(`${liveUrl}/open`), liveSession({ hosts: [liveHost({ side: 'head' })] }), 202);
    tick(LIVE_POLL_FAST_MS);
    expect(polls().length).toBe(0);
    expect(store.urlFor(11, 'Default', 'base')).toBeNull();
    finish();
  }));

  it('a failed open is remembered per state and reopen retries it', fakeAsync(() => {
    started();
    store.ensureOpen(11, 'Default');
    fail(httpMock.expectOne(`${liveUrl}/open`), 409, 'Live mode is busy; try again.', 'conflict');
    expect(store.openErrorFor(11, 'Default')).toBe('Live mode is busy; try again.');
    answerPolls({}); // the store re-reads the session at once
    store.ensureOpen(11, 'Default');
    httpMock.expectNone(`${liveUrl}/open`);
    store.reopen(11, 'Default');
    expect(store.openErrorFor(11, 'Default')).toBeNull();
    ok(httpMock.expectOne(`${liveUrl}/open`), liveSession({ hosts: readyHosts() }), 202);
    finish();
  }));

  it('does not open before the session is ready', () => {
    store.attach(7);
    store.ensureOpen(11, 'Default');
    expect(httpMock.match(`${liveUrl}/open`).length).toBe(0);
  });

  it('hostFor prefers a ready host and urlFor needs a ready one', fakeAsync(() => {
    started({
      hosts: [
        liveHost({ side: 'head', status: 'stopped', origin: null }),
        liveHost({ side: 'head', groupKey: 'g2' }),
        liveHost({ side: 'base', status: 'failed', origin: null, error: 'Build failed' }),
      ],
    });
    expect(store.hostFor(11, 'head')?.groupKey).toBe('g2');
    expect(store.hostFor(11, 'base')?.error).toBe('Build failed');
    expect(store.urlFor(11, 'Default', 'base')).toBeNull();
    expect(store.hostFor(99, 'head')).toBeNull();
    finish();
  }));

  describe('heartbeat', () => {
    it('every heartbeatIntervalMs; active only after activity during the interval', fakeAsync(() => {
      started({ heartbeatIntervalMs: 30_000 });
      tick(29_999);
      expect(heartbeats().length).toBe(0);
      tick(1);
      answerPolls({});
      let [hb] = heartbeats();
      expect(hb?.request.body).toEqual({ active: false });
      ok(hb!, { status: 'ready' });

      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      tick(30_000);
      answerPolls({});
      [hb] = heartbeats();
      expect(hb?.request.body).toEqual({ active: true });
      ok(hb!, { status: 'ready' });

      // Activity is per interval.
      tick(30_000);
      answerPolls({});
      [hb] = heartbeats();
      expect(hb?.request.body).toEqual({ active: false });
      ok(hb!, { status: 'ready' });
      finish();
    }));

    it('clicks, scrolls and wheel on the page count', fakeAsync(() => {
      started();
      for (const event of [new PointerEvent('pointerdown'), new Event('scroll'), new WheelEvent('wheel')]) {
        document.dispatchEvent(event);
        tick(30_000);
        answerPolls({});
        const [hb] = heartbeats();
        expect(hb?.request.body).withContext(event.type).toEqual({ active: true });
        ok(hb!, { status: 'ready' });
      }
      finish();
    }));

    it('an activity message from a live page (markActivity) counts', fakeAsync(() => {
      started();
      store.markActivity();
      tick(30_000);
      answerPolls({});
      const [hb] = heartbeats();
      expect(hb?.request.body).toEqual({ active: true });
      ok(hb!, { status: 'ready' });
      finish();
    }));

    it('focus moving into a live iframe counts (window blur)', fakeAsync(() => {
      started();
      const frame = document.createElement('iframe');
      frame.setAttribute(LIVE_FRAME_ATTRIBUTE, '');
      document.body.appendChild(frame);
      try {
        spyOnProperty(document, 'activeElement', 'get').and.returnValue(frame);
        window.dispatchEvent(new Event('blur'));
        tick(30_000);
        answerPolls({});
        const [hb] = heartbeats();
        expect(hb?.request.body).toEqual({ active: true });
        ok(hb!, { status: 'ready' });
      } finally {
        frame.remove();
      }
      finish();
    }));

    it('a blur to anything but a live iframe does not count', fakeAsync(() => {
      started();
      window.dispatchEvent(new Event('blur'));
      tick(30_000);
      answerPolls({});
      const [hb] = heartbeats();
      expect(hb?.request.body).toEqual({ active: false });
      ok(hb!, { status: 'ready' });
      finish();
    }));

    it('a hidden tab never counts as active', fakeAsync(() => {
      started();
      const visibility = spyOnProperty(document, 'visibilityState', 'get').and.returnValue('hidden');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      store.markActivity();
      tick(30_000);
      answerPolls({});
      let [hb] = heartbeats();
      expect(hb?.request.body).toEqual({ active: false });
      ok(hb!, { status: 'ready' });
      // Visible again: the next input counts.
      visibility.and.returnValue('visible');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      tick(30_000);
      answerPolls({});
      [hb] = heartbeats();
      expect(hb?.request.body).toEqual({ active: true });
      ok(hb!, { status: 'ready' });
      finish();
    }));

    it('a 404 heartbeat marks the session stopped and fetches why (idle stop)', fakeAsync(() => {
      started();
      tick(30_000);
      answerPolls({});
      const [hb] = heartbeats();
      fail(hb!, 404, 'Live mode is not running for this run.', 'not_found');
      expect(store.session()?.status).toBe('stopped');
      expect(store.active()).toBeFalse();
      const [poll] = polls();
      ok(poll!, liveSession({ status: 'stopped', stopReason: 'idle', stoppedAt: '2026-10-07T10:11:00.000Z' }));
      expect(store.session()?.stopReason).toBe('idle');
      tick(120_000);
      expect(heartbeats().length).toBe(0);
      expect(polls().length).toBe(0);
      finish();
    }));
  });

  describe('leaving the run', () => {
    it('destroying the page stops the active session with reason left', fakeAsync(() => {
      started();
      leave();
      const stop = httpMock.expectOne(`${liveUrl}/stop`);
      expect(stop.request.method).toBe('POST');
      expect(stop.request.body).toEqual({ reason: 'left' });
      ok(stop, { id: 3, status: 'stopping' });
      tick(120_000);
      expect(heartbeats().length).toBe(0);
      expect(polls().length).toBe(0);
    }));

    it('destroying the page without a session sends nothing', () => {
      store.attach(7);
      leave();
      expect(httpMock.match(`${liveUrl}/stop`).length).toBe(0);
    });

    it('a start in flight is stopped too', fakeAsync(() => {
      store.attach(7);
      store.start();
      const start = startReq();
      leave();
      expect(httpMock.expectOne(`${liveUrl}/stop`).request.body).toEqual({ reason: 'left' });
      expect(start.cancelled).toBeTrue();
    }));

    it('pagehide sends a text/plain beacon to the stop route', fakeAsync(() => {
      const beacon = spyOn(navigator, 'sendBeacon').and.returnValue(true);
      started();
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      expect(beacon).toHaveBeenCalledTimes(1);
      const [url, body] = beacon.calls.mostRecent().args;
      expect(url).toBe(`${liveUrl}/stop`);
      expect(body instanceof Blob).toBeTrue();
      expect((body as Blob).type).toBe('text/plain');
      expect(store.session()?.status).toBe('stopping');
      // The destroy hook does not stop twice.
      leave();
      httpMock.expectNone(`${liveUrl}/stop`);
      for (const r of polls()) ok(r, liveSession({ status: 'stopped', stopReason: 'left' }));
    }));

    it('pagehide without an active session sends no beacon', () => {
      const beacon = spyOn(navigator, 'sendBeacon').and.returnValue(true);
      store.attach(7);
      window.dispatchEvent(new PageTransitionEvent('pagehide'));
      expect(beacon).not.toHaveBeenCalled();
    });

    it('attaching another run stops the previous run’s session and resets', fakeAsync(() => {
      started();
      store.attach(8);
      const stop = httpMock.expectOne(`${liveUrl}/stop`);
      expect(stop.request.body).toEqual({ reason: 'left' });
      ok(stop, { id: 3, status: 'stopping' });
      expect(store.session()).toBeNull();
      tick(60_000);
      expect(polls().length).toBe(0);
      expect(heartbeats().length).toBe(0);
      finish();
    }));

    it('stop(user) marks the session stopping and keeps polling until stopped', fakeAsync(() => {
      started();
      store.stop('user');
      ok(httpMock.expectOne(`${liveUrl}/stop`), { id: 3, status: 'stopping' });
      expect(store.session()?.status).toBe('stopping');
      expect(store.session()?.stopReason).toBe('user');
      // A poll answer from before the stop cannot move the session back to ready.
      tick(LIVE_POLL_SLOW_MS);
      answerPolls({ status: 'ready' });
      expect(store.session()?.status).toBe('stopping');
      tick(LIVE_POLL_SLOW_MS);
      answerPolls({ status: 'stopped', stopReason: 'user' });
      expect(store.session()?.status).toBe('stopped');
      tick(60_000);
      expect(polls().length).toBe(0);
      finish();
    }));
  });
});
