import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, type TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { environment } from '../../../../../environments/environment';
import { errorInterceptor } from '../../../../core/interceptors/error.interceptor';
import { type VisualChange } from '../../../../core/models/domain-enums.model';
import { type LiveSessionView } from '../../../../core/models/live-session.model';
import { NotificationService } from '../../../../core/services/notification.service';
import { liveSession, readyHosts } from '../../testing/live-fixtures';
import { LiveSessionStore } from '../../visualization-detail/live-session.store';
import { ImageCompareComponent, type LiveTarget } from './image-compare.component';

interface Inputs {
  baseUrl?: string | null;
  headUrl?: string | null;
  width?: number | null;
  height?: number | null;
  visualChange?: VisualChange | null;
  baseError?: string | null;
  headError?: string | null;
  stateName?: string | null;
}

const ART = environment.artifactBaseUrl;

describe('ImageCompareComponent', () => {
  let fixture: ComponentFixture<ImageCompareComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ImageCompareComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
    fixture = TestBed.createComponent(ImageCompareComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  function render(inputs: Inputs = {}): void {
    const all: Required<Inputs> = {
      baseUrl: '/artifacts/7/11/base.png',
      headUrl: '/artifacts/7/11/head.png',
      width: 800,
      height: 600,
      visualChange: 'changed',
      baseError: null,
      headError: null,
      stateName: null,
      ...inputs,
    };
    fixture.componentRef.setInput('label', 'CartSummary');
    for (const [k, v] of Object.entries(all)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
  }
  const imgs = (): HTMLImageElement[] => Array.from(el.querySelectorAll('img'));

  it('side-by-side shows both images with alt text and width/height attributes', () => {
    render();
    const [base, head] = imgs();
    expect(imgs().length).toBe(2);
    expect(base?.alt).toBe('Base render of CartSummary');
    expect(head?.alt).toBe('Head render of CartSummary');
    expect(base?.getAttribute('width')).toBe('800');
    expect(base?.getAttribute('height')).toBe('600');
    expect(head?.getAttribute('draggable')).toBe('false');
    expect(Array.from(el.querySelectorAll('figcaption')).map((f) => f.textContent?.trim())).toEqual([
      'Before',
      'After',
    ]);
  });

  it('shows the screenshots only: no mode, zoom, slider or diff controls', () => {
    render();
    expect(el.querySelector('[aria-label="Comparison mode"]')).toBeNull();
    expect(el.querySelector('[aria-label="Zoom"]')).toBeNull();
    expect(el.querySelector('input[type="range"]')).toBeNull();
    expect(imgs().map((i) => i.alt)).not.toContain('Pixel differences for CartSummary');
  });

  it('loads the screenshots with CORS so they can be measured for the crop', () => {
    render();
    expect(imgs().map((i) => i.getAttribute('crossorigin'))).toEqual(['anonymous', 'anonymous']);
  });

  it('new component: base placeholder text', () => {
    render({ baseUrl: null, visualChange: 'new' });
    expect(imgs().length).toBe(1);
    expect(el.textContent).toContain('Not present on base — new component');
  });

  it('deleted component: head placeholder', () => {
    render({ headUrl: null, visualChange: 'deleted' });
    expect(imgs().length).toBe(1);
    expect(el.textContent).toContain('Removed in head — deleted component');
  });

  it('failed side shows the render-failed placeholder', () => {
    render({ headUrl: null, visualChange: null, headError: 'TypeError: x is undefined' });
    expect(el.textContent).toContain('Render failed — see Render errors below');
  });

  it('image error marks the side unavailable', () => {
    render();
    imgs()[0]?.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(imgs().length).toBe(1);
    expect(el.textContent).toContain('Image unavailable');
  });

  it('artifact URLs prefixed with environment.artifactBaseUrl via artifactUrl()', () => {
    render();
    expect(imgs().map((i) => i.getAttribute('src'))).toEqual([
      `${ART}/artifacts/7/11/base.png`,
      `${ART}/artifacts/7/11/head.png`,
    ]);
  });

  it('non-/artifacts/ URL treated as missing', () => {
    render({ baseUrl: 'https://evil.example/x.png', headUrl: '/artifacts/../etc/passwd', visualChange: null });
    expect(imgs().length).toBe(0);
    expect(el.textContent).toContain('Not rendered');
  });

  describe('state input (16 §15.5.2)', () => {
    it('a named state is part of the image labels; Default keeps the plain label', () => {
      render({ stateName: 'Menu open' });
      expect(imgs().map((i) => i.alt)).toEqual([
        'Base render of CartSummary · Menu open',
        'Head render of CartSummary · Menu open',
      ]);
      render({ stateName: 'Default' });
      expect(imgs().map((i) => i.alt)).toEqual(['Base render of CartSummary', 'Head render of CartSummary']);
    });

    it('a state only on head or only on base says which version lacks it', () => {
      render({ stateName: 'Overdue', visualChange: 'new', baseUrl: null });
      expect(el.textContent).toContain('Not in the base version');
      expect(el.textContent).not.toContain('new component');
      render({ stateName: 'Overdue', visualChange: 'deleted', headUrl: null });
      expect(el.textContent).toContain('Not in the head version');
    });

    it("a failed image of one state does not hide another state's image", () => {
      render({ stateName: 'Default' });
      imgs()[0]?.dispatchEvent(new Event('error'));
      fixture.detectChanges();
      expect(el.textContent).toContain('Image unavailable');
      render({
        stateName: 'Menu open',
        baseUrl: '/artifacts/7/11/s1/base.png',
        headUrl: '/artifacts/7/11/s1/head.png',
      });
      expect(imgs().map((i) => i.getAttribute('src'))).toEqual([
        `${ART}/artifacts/7/11/s1/base.png`,
        `${ART}/artifacts/7/11/s1/head.png`,
      ]);
      expect(el.textContent).not.toContain('Image unavailable');
    });
  });
});

describe('ImageCompareComponent Live mode (16j)', () => {
  const liveUrl = `${environment.apiBaseUrl}/visualizations/7/live`;
  const TWO_SESSIONS =
    'Live mode is already running for 2 other runs. Leave one of them first (it also stops by itself after 10 minutes idle).';
  const target: LiveTarget = { componentId: 11, stateName: 'Menu open', onBase: true, onHead: true };
  let fixture: ComponentFixture<ImageCompareComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let store: LiveSessionStore;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ImageCompareComponent],
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
    store.attach(7);
    // Live pages are never loaded in tests.
    spyOnProperty(HTMLIFrameElement.prototype, 'src', 'set');
    fixture = TestBed.createComponent(ImageCompareComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    fixture.destroy();
    store.attach(null);
    for (const r of httpMock.match((req) => req.url.startsWith(liveUrl))) r.flush({ status: 200, data: {} });
  });

  function render(liveEnabled = true, liveTarget: LiveTarget | null = target, live = false): void {
    fixture.componentRef.setInput('label', 'CartSummary');
    fixture.componentRef.setInput('baseUrl', '/artifacts/7/11/base.png');
    fixture.componentRef.setInput('headUrl', '/artifacts/7/11/head.png');
    fixture.componentRef.setInput('visualChange', 'changed');
    fixture.componentRef.setInput('liveEnabled', liveEnabled);
    fixture.componentRef.setInput('liveTarget', liveTarget);
    fixture.componentRef.setInput('stepSummary', ['Click button "More actions"']);
    fixture.componentRef.setInput('live', live);
    fixture.detectChanges();
  }
  const testId = (id: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const startRequest = (): TestRequest => httpMock.expectOne((r) => r.method === 'POST' && r.url === liveUrl);
  /** The card's Play button: the viewer starts the run's session by itself. */
  function play(): TestRequest {
    fixture.componentRef.setInput('live', true);
    fixture.detectChanges();
    return startRequest();
  }
  function clickStart(): TestRequest {
    testId('live-start-button')?.click();
    fixture.detectChanges();
    return startRequest();
  }
  function answer(req: TestRequest, session: Partial<LiveSessionView>, status = 200): void {
    req.flush({ status, data: liveSession(session) });
    fixture.detectChanges();
  }
  function opens(): TestRequest[] {
    return httpMock.match((r) => r.url === `${liveUrl}/open`);
  }

  it('live shows only when the card plays, Live is enabled and there is a target; screenshots otherwise', () => {
    render(true, target, false);
    expect(el.querySelectorAll('img').length).toBe(2);
    render(false, target, true);
    expect(el.querySelectorAll('img').length).toBe(2);
    render(true, null, true);
    expect(el.querySelectorAll('img').length).toBe(2);
    expect(httpMock.match((r) => r.method === 'POST' && r.url === liveUrl).length).toBe(0);
  });

  it('live is ignored where no LiveSessionStore is provided', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ImageCompareComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
    const bare = TestBed.createComponent(ImageCompareComponent);
    bare.componentRef.setInput('label', 'CartSummary');
    bare.componentRef.setInput('baseUrl', '/artifacts/7/11/base.png');
    bare.componentRef.setInput('headUrl', '/artifacts/7/11/head.png');
    bare.componentRef.setInput('liveEnabled', true);
    bare.componentRef.setInput('liveTarget', target);
    bare.componentRef.setInput('live', true);
    bare.detectChanges();
    const root = bare.nativeElement as HTMLElement;
    expect(root.querySelectorAll('img').length).toBe(2);
    expect(root.querySelector('[data-testid="live-starting"]')).toBeNull();
    bare.destroy();
  });

  it('playing without a session starts it and shows the preparing spinner', () => {
    render();
    const req = play();
    expect(testId('live-starting')?.textContent).toContain('Preparing the before and after code…');
    expect(el.querySelectorAll('img').length).toBe(0);
    answer(req, { status: 'starting', readyAt: null }, 202);
    expect(testId('live-starting')?.textContent).toContain('Preparing the before and after code…');
    expect(opens().length).toBe(0);
  });

  it('once ready, opens the open state on both sides and shows the live compare', () => {
    render();
    answer(play(), { hosts: [] }, 202);
    const [open] = opens();
    expect(open?.request.body).toEqual({ componentId: 11, stateName: 'Menu open' });
    open?.flush({ status: 202, data: liveSession({ hosts: readyHosts() }) });
    fixture.detectChanges();
    expect(testId('live-compare')).not.toBeNull();
    expect(testId('live-frame-base')).not.toBeNull();
    expect(testId('live-frame-head')).not.toBeNull();
  });

  it('switching the state tab while in Live opens the new state', () => {
    render();
    answer(play(), { hosts: readyHosts() }, 202);
    opens()[0]?.flush({ status: 202, data: liveSession({ hosts: readyHosts() }) });
    fixture.componentRef.setInput('liveTarget', { ...target, stateName: 'Default' });
    fixture.detectChanges();
    const [open] = opens();
    expect(open?.request.body).toEqual({ componentId: 11, stateName: 'Default' });
    open?.flush({ status: 202, data: liveSession({ hosts: readyHosts() }) });
  });

  it('the two-session limit error is shown with a retry, and is not retried by itself', () => {
    render();
    play().flush({ status: 409, error: TWO_SESSIONS, error_reason: 'conflict' }, { status: 409, statusText: 'x' });
    fixture.detectChanges();
    expect(testId('live-message')?.textContent?.trim()).toBe(TWO_SESSIONS);
    expect(testId('live-start-button')).not.toBeNull();
    expect(httpMock.match((r) => r.method === 'POST' && r.url === liveUrl).length).toBe(0);
  });

  it('an idle stop says so and offers Start again', () => {
    render();
    answer(play(), { status: 'stopped', stopReason: 'idle', stoppedAt: '2026-10-07T10:11:00.000Z' }, 202);
    expect(testId('live-message')?.textContent?.trim()).toBe('Live mode stopped after 10 minutes idle.');
    expect(testId('live-start-button')?.textContent).toContain('Start again');
    const again = clickStart();
    expect(again.request.body).toEqual({});
    answer(again, { id: 4, status: 'starting', readyAt: null }, 202);
    expect(testId('live-starting')).not.toBeNull();
  });

  it('a failed session shows its error with Try again', () => {
    render();
    answer(play(), { status: 'failed', errorMessage: 'Could not prepare the before and after code in time.' }, 202);
    expect(testId('live-message')?.textContent?.trim()).toBe('Could not prepare the before and after code in time.');
    expect(testId('live-start-button')?.textContent).toContain('Try again');
  });

  it('stopping returns to the screenshots', () => {
    render();
    play().flush({ status: 202, data: liveSession({ status: 'starting', readyAt: null }) });
    fixture.componentRef.setInput('live', false);
    fixture.detectChanges();
    expect(el.querySelectorAll('img').length).toBe(2);
    expect(testId('live-starting')).toBeNull();
  });
});
