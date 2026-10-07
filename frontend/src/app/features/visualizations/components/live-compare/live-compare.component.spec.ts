import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { environment } from '../../../../../environments/environment';
import { errorInterceptor } from '../../../../core/interceptors/error.interceptor';
import { type LiveHostView } from '../../../../core/models/live-session.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { liveHost, liveSession, readyHosts } from '../../testing/live-fixtures';
import { LiveSessionStore } from '../../visualization-detail/live-session.store';
import { LiveCompareComponent, parseLivePageMessage } from './live-compare.component';

const liveUrl = `${environment.apiBaseUrl}/visualizations/7/live`;
const BASE_ORIGIN = 'http://127.0.0.1:51001';
const HEAD_ORIGIN = 'http://127.0.0.1:51002';
const PARENT = encodeURIComponent(window.location.origin);
const pageUrl = (origin: string, state = 'Menu%20open'): string =>
  `${origin}/.prvision-harness/index.html?c=11&s=${state}&live=1&parent=${PARENT}`;

describe('parseLivePageMessage', () => {
  it('reads the three page messages', () => {
    expect(parseLivePageMessage({ source: 'prvision-live', type: 'activity' })).toEqual({ type: 'activity' });
    expect(parseLivePageMessage({ source: 'prvision-live', type: 'error', message: 'boom' })).toEqual({
      type: 'error',
      message: 'boom',
    });
    const skipped = [{ index: 0, action: 'hover', reason: 'hover cannot be replayed' }];
    expect(
      parseLivePageMessage({ source: 'prvision-live', type: 'state', state: 'Menu open', replayed: 1, skipped }),
    ).toEqual({ type: 'state', state: 'Menu open', replayed: 1, skipped });
  });

  it('rejects anything else', () => {
    for (const data of [
      null,
      'activity',
      { type: 'activity' },
      { source: 'other', type: 'activity' },
      { source: 'prvision-live', type: 'navigate', url: 'x' },
      { source: 'prvision-live', type: 'error', message: 3 },
      { source: 'prvision-live', type: 'state', state: 'A', skipped: [{ index: 'x' }] },
      { source: 'prvision-live', type: 'state', skipped: [] },
    ]) {
      expect(parseLivePageMessage(data)).withContext(JSON.stringify(data)).toBeNull();
    }
  });

  it('cuts long error messages', () => {
    const msg = parseLivePageMessage({ source: 'prvision-live', type: 'error', message: 'x'.repeat(2000) });
    expect(msg?.type === 'error' ? msg.message.length : 0).toBe(500);
  });
});

describe('LiveCompareComponent', () => {
  let fixture: ComponentFixture<LiveCompareComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let store: LiveSessionStore;
  let srcSet: jasmine.Spy<(v: string) => void>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [LiveCompareComponent],
      providers: [
        provideNoopAnimations(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        LiveSessionStore,
        { provide: NotificationService, useValue: jasmine.createSpyObj('NotificationService', ['error']) },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    store = TestBed.inject(LiveSessionStore);
    // The pages are never loaded in tests: the src setter is recorded instead.
    srcSet = spyOnProperty(HTMLIFrameElement.prototype, 'src', 'set');
    fixture = TestBed.createComponent(LiveCompareComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    fixture.destroy();
    store.attach(null); // stops the session like leaving the run
    for (const r of httpMock.match((req) => req.url.startsWith(liveUrl))) r.flush({ status: 200, data: {} });
  });

  /** A ready session with `hosts`, then the component for component 11, state "Menu open". */
  function render(hosts: LiveHostView[] = readyHosts(), inputs: Partial<Record<string, unknown>> = {}): void {
    store.attach(7);
    store.start();
    httpMock
      .expectOne((r) => r.method === 'POST' && r.url === liveUrl)
      .flush({ status: 202, data: liveSession({ hosts }) });
    const all: Record<string, unknown> = {
      componentId: 11,
      stateName: 'Menu open',
      label: 'CartSummary',
      onBase: true,
      onHead: true,
      stepSummary: ['Hover link "Docs"', 'Click button "More actions"'],
      ...inputs,
    };
    for (const [k, v] of Object.entries(all)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
  }
  const frame = (side: 'base' | 'head'): HTMLIFrameElement | null =>
    el.querySelector<HTMLIFrameElement>(`[data-testid="live-frame-${side}"]`);
  const text = (testId: string): string => el.querySelector(`[data-testid="${testId}"]`)?.textContent?.trim() ?? '';
  function srcCalls(f: HTMLIFrameElement | null): string[] {
    return srcSet.calls
      .all()
      .filter((c) => c.object === f)
      .map((c) => c.args[0]);
  }
  function post(side: 'base' | 'head', data: unknown, origin = side === 'base' ? BASE_ORIGIN : HEAD_ORIGIN): void {
    const source = frame(side)?.contentWindow ?? null;
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
    fixture.detectChanges();
  }

  it('shows two independent iframes, Before and After, sandboxed, pointed at their own live host', () => {
    render();
    const base = frame('base');
    const head = frame('head');
    expect(base).not.toBeNull();
    expect(head).not.toBeNull();
    expect(text('live-side-base')).toContain('Before');
    expect(text('live-side-head')).toContain('After');
    for (const f of [base, head]) {
      expect(f?.getAttribute('sandbox')).toBe('allow-scripts allow-same-origin allow-forms');
      expect(f?.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(f?.hasAttribute('data-prvision-live-frame')).toBeTrue();
    }
    expect(base?.title).toBe('Before: CartSummary · Menu open (live)');
    expect(head?.title).toBe('After: CartSummary · Menu open (live)');
    expect(srcCalls(base)).toEqual([pageUrl(BASE_ORIGIN)]);
    expect(srcCalls(head)).toEqual([pageUrl(HEAD_ORIGIN)]);
  });

  it('Reload reloads only that side', () => {
    render();
    el.querySelector<HTMLButtonElement>('[data-testid="live-reload-head"]')?.click();
    fixture.detectChanges();
    expect(srcCalls(frame('head'))).toEqual([pageUrl(HEAD_ORIGIN), pageUrl(HEAD_ORIGIN)]);
    expect(srcCalls(frame('base'))).toEqual([pageUrl(BASE_ORIGIN)]);
  });

  it('switching the state points both sides at the new state', () => {
    render();
    fixture.componentRef.setInput('stateName', 'Default');
    fixture.detectChanges();
    expect(srcCalls(frame('base')).at(-1)).toBe(pageUrl(BASE_ORIGIN, 'Default'));
    expect(srcCalls(frame('head')).at(-1)).toBe(pageUrl(HEAD_ORIGIN, 'Default'));
    expect(frame('head')?.title).toBe('After: CartSummary (live)');
  });

  describe('messages', () => {
    it('activity from a live side keeps the session alive', () => {
      render();
      const mark = spyOn(store, 'markActivity');
      post('head', { source: 'prvision-live', type: 'activity' });
      post('base', { source: 'prvision-live', type: 'activity' });
      expect(mark).toHaveBeenCalledTimes(2);
    });

    it('ignores messages from another origin, another window or without the prvision-live source', () => {
      render();
      const mark = spyOn(store, 'markActivity');
      post('head', { source: 'prvision-live', type: 'activity' }, BASE_ORIGIN); // base's origin, head's window
      post('head', { source: 'prvision-live', type: 'activity' }, 'http://evil.test');
      post('head', { type: 'activity' });
      post('head', { source: 'other', type: 'activity' });
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { source: 'prvision-live', type: 'activity' },
          origin: HEAD_ORIGIN,
          source: window,
        }),
      );
      window.dispatchEvent(
        new MessageEvent('message', { data: { source: 'prvision-live', type: 'activity' }, origin: HEAD_ORIGIN }),
      );
      expect(mark).not.toHaveBeenCalled();
    });

    it('skipped steps show the do-it-yourself banner with the step summary; reload clears it', () => {
      render();
      expect(el.querySelector('[data-testid="live-skipped"]')).toBeNull();
      post('head', {
        source: 'prvision-live',
        type: 'state',
        state: 'Menu open',
        replayed: 1,
        skipped: [{ index: 0, action: 'hover', reason: 'hover cannot be replayed in live mode' }],
      });
      expect(text('live-skipped-text')).toBe(
        'Some steps can\'t be replayed live (hover). Do them yourself: Hover link "Docs".',
      );
      el.querySelector<HTMLButtonElement>('[data-testid="live-reload-head"]')?.click();
      fixture.detectChanges();
      expect(el.querySelector('[data-testid="live-skipped"]')).toBeNull();
    });

    it('a state message for another state or without skipped steps shows no banner', () => {
      render();
      const skipped = [{ index: 0, action: 'hover', reason: 'x' }];
      post('base', { source: 'prvision-live', type: 'state', state: 'Default', replayed: 0, skipped });
      post('head', { source: 'prvision-live', type: 'state', state: 'Menu open', replayed: 2, skipped: [] });
      expect(el.querySelector('[data-testid="live-skipped"]')).toBeNull();
    });

    it('an error from a side shows "The <side> side threw"', () => {
      render();
      post('base', { source: 'prvision-live', type: 'error', message: 'Cannot read properties of undefined' });
      expect(text('live-thrown-text-base')).toBe('The base side threw: Cannot read properties of undefined');
      expect(el.querySelector('[data-testid="live-thrown-head"]')).toBeNull();
    });
  });

  it('a side the state does not exist on says so and gets no iframe', () => {
    render([liveHost({ side: 'head' })], { onBase: false });
    expect(frame('base')).toBeNull();
    expect(text('live-absent-base')).toContain('Not in the base version');
    expect(frame('head')).not.toBeNull();
    fixture.componentRef.setInput('onBase', true);
    fixture.componentRef.setInput('onHead', false);
    fixture.detectChanges();
    expect(text('live-absent-head')).toContain('Not in the head version');
  });

  it('a starting host shows progress and an inactive Reload', () => {
    render([liveHost({ side: 'base', status: 'starting', origin: null }), liveHost({ side: 'head' })]);
    expect(text('live-starting-base')).toContain('Starting the build server…');
    expect(el.querySelector<HTMLButtonElement>('[data-testid="live-reload-base"]')?.disabled).toBeTrue();
    expect(el.querySelector<HTMLButtonElement>('[data-testid="live-reload-head"]')?.disabled).toBeFalse();
  });

  it('a failed host shows its error with Try again, which reopens the state', () => {
    render([
      liveHost({ side: 'base', status: 'failed', origin: null, error: 'Vite could not start: port in use' }),
      liveHost({ side: 'head' }),
    ]);
    expect(text('live-failed-base')).toContain('Vite could not start: port in use');
    expect(frame('head')).not.toBeNull(); // the other side is unaffected
    const reopen = spyOn(store, 'reopen');
    el.querySelector<HTMLButtonElement>('[data-testid="live-retry-base"]')?.click();
    expect(reopen).toHaveBeenCalledOnceWith(11, 'Menu open', { base: true, head: true });
  });

  it('a host with an address that is not a 127.0.0.1 live host is never framed', () => {
    render([liveHost({ side: 'base', origin: 'http://evil.test:51001' }), liveHost({ side: 'head' })]);
    expect(frame('base')).toBeNull();
    expect(text('live-failed-base')).toContain('This side did not report a PRVision live address.');
  });
});
