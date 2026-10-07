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
  diffUrl?: string | null;
  width?: number | null;
  height?: number | null;
  diffPixelRatio?: number | null;
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
      diffUrl: '/artifacts/7/11/diff.png',
      width: 800,
      height: 600,
      diffPixelRatio: 0.042,
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
  function modeButton(label: string): HTMLButtonElement {
    const group = el.querySelector('[aria-label="Comparison mode"]');
    const b = Array.from(group?.querySelectorAll('button') ?? []).find((x) => x.textContent?.includes(label));
    if (!b) throw new Error(`no ${label}`);
    return b;
  }
  function zoomButton(label: string): HTMLButtonElement {
    const group = el.querySelector('[aria-label="Zoom"]');
    const b = Array.from(group?.querySelectorAll('button') ?? []).find((x) => x.textContent?.includes(label));
    if (!b) throw new Error(`no ${label}`);
    return b;
  }
  function select(button: HTMLButtonElement): void {
    button.click();
    fixture.detectChanges();
  }
  const imgs = (): HTMLImageElement[] => Array.from(el.querySelectorAll('img'));
  const range = (): HTMLInputElement => el.querySelector('input[type="range"]')!;

  it('side-by-side shows both images with alt text and width/height attributes', () => {
    render();
    const [base, head] = imgs();
    expect(imgs().length).toBe(2);
    expect(base?.alt).toBe('Base render of CartSummary');
    expect(head?.alt).toBe('Head render of CartSummary');
    expect(base?.getAttribute('width')).toBe('800');
    expect(base?.getAttribute('height')).toBe('600');
    expect(head?.getAttribute('draggable')).toBe('false');
    expect(Array.from(el.querySelectorAll('figcaption')).map((f) => f.textContent?.trim())).toEqual(['Base', 'Head']);
  });

  it('new component: base placeholder text, slider and diff disabled', () => {
    render({ baseUrl: null, diffUrl: null, visualChange: 'new' });
    expect(imgs().length).toBe(1);
    expect(el.textContent).toContain('Not present on base — new component');
    expect(modeButton('Slider').disabled).toBeTrue();
    expect(modeButton('Diff').disabled).toBeTrue();
  });

  it('deleted component: head placeholder', () => {
    render({ headUrl: null, diffUrl: null, visualChange: 'deleted' });
    expect(el.textContent).toContain('Removed in head — deleted component');
    expect(modeButton('Slider').disabled).toBeTrue();
  });

  it('failed side shows the render-failed placeholder', () => {
    render({ headUrl: null, diffUrl: null, visualChange: null, headError: 'TypeError: x is undefined' });
    expect(el.textContent).toContain('Render failed — see Render errors below');
  });

  it('slider: range input updates clip-path', () => {
    render();
    select(modeButton('Slider'));
    const head = imgs()[1];
    expect(head?.style.clipPath).toBe('inset(0px 0px 0px 50%)');
    range().value = '30';
    range().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(head?.style.clipPath).toBe('inset(0px 0px 0px 30%)');
  });

  it('range has aria-label and aria-valuetext', () => {
    render();
    select(modeButton('Slider'));
    expect(range().getAttribute('aria-label')).toBe('Comparison slider for CartSummary');
    expect(range().getAttribute('aria-valuetext')).toBe('50% base, 50% head');
  });

  it('ArrowRight on range increases split', () => {
    render();
    select(modeButton('Slider'));
    const input = range();
    input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    // Synthetic key events do not move a native range; do what the browser does on ArrowRight (+1 step).
    input.stepUp();
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(input.getAttribute('aria-valuetext')).toBe('51% base, 49% head');
    expect(imgs()[1]?.style.clipPath).toBe('inset(0px 0px 0px 51%)');
  });

  it('pointer drag sets split', () => {
    render();
    select(modeButton('Slider'));
    const stage = el.querySelector<HTMLElement>('[data-testid="slider-stage"]')!;
    stage.style.width = '400px';
    stage.style.height = '300px';
    const rect = stage.getBoundingClientRect();
    const at = (x: number): PointerEventInit => ({
      clientX: rect.left + x,
      clientY: rect.top + 10,
      pointerId: 1,
      bubbles: true,
    });
    stage.dispatchEvent(new PointerEvent('pointerdown', at(100)));
    fixture.detectChanges();
    expect(range().getAttribute('aria-valuetext')).toBe('25% base, 75% head');
    stage.dispatchEvent(new PointerEvent('pointermove', at(300)));
    fixture.detectChanges();
    expect(range().getAttribute('aria-valuetext')).toBe('75% base, 25% head');
    stage.dispatchEvent(new PointerEvent('pointerup', at(300)));
    stage.dispatchEvent(new PointerEvent('pointermove', at(50)));
    fixture.detectChanges();
    expect(range().getAttribute('aria-valuetext')).toBe('75% base, 25% head');
  });

  it('diff mode opacity binding and Diff only hides head', () => {
    render();
    select(modeButton('Diff'));
    const stage = (): HTMLElement => el.querySelector('[data-testid="diff-stage"]')!;
    let stageImgs = Array.from(stage().querySelectorAll('img'));
    expect(stageImgs.map((i) => i.alt)).toEqual(['Head render of CartSummary', 'Pixel differences for CartSummary']);
    expect(stageImgs[1]?.style.opacity).toBe('0.75');
    range().value = '40';
    range().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(stageImgs[1]?.style.opacity).toBe('0.4');
    expect(el.textContent).toContain('Highlighted pixels differ between base and head (4.2% of the image).');

    el.querySelector<HTMLButtonElement>('mat-slide-toggle button')!.click();
    fixture.detectChanges();
    stageImgs = Array.from(stage().querySelectorAll('img'));
    expect(stageImgs.map((i) => i.alt)).toEqual(['Pixel differences for CartSummary']);
    expect(stageImgs[0]?.style.opacity).toBe('1');
    expect(range().disabled).toBeTrue();
  });

  it('image error marks side unavailable and falls back to side mode', () => {
    render();
    select(modeButton('Slider'));
    imgs()[0]?.dispatchEvent(new Event('error'));
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="slider-stage"]')).toBeNull();
    expect(el.textContent).toContain('Image unavailable');
    expect(modeButton('Slider').disabled).toBeTrue();
    expect(modeButton('Side by side').getAttribute('aria-pressed')).toBe('true');
  });

  it('defaults to 100% zoom with image width and scroll region; Fit removes both', () => {
    render();
    expect(zoomButton('100%').getAttribute('aria-pressed')).toBe('true');
    const region = el.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('CartSummary at 100% zoom, scrollable');
    expect(region?.getAttribute('tabindex')).toBe('0');
    expect(el.querySelector<HTMLElement>('.pv-checkerboard')!.style.width).toBe('800px');
    select(zoomButton('Fit'));
    expect(el.querySelector('[role="region"]')).toBeNull();
    expect(el.querySelector<HTMLElement>('.pv-checkerboard')!.style.width).toBe('');
    select(zoomButton('100%'));
    expect(el.querySelector<HTMLElement>('.pv-checkerboard')!.style.width).toBe('800px');
  });

  it('lists 100% before Fit', () => {
    render();
    const group = el.querySelector('[aria-label="Zoom"]');
    const labels = Array.from(group?.querySelectorAll('button') ?? []).map((b) =>
      b.textContent?.includes('Fit') ? 'Fit' : '100%',
    );
    expect(labels).toEqual(['100%', 'Fit']);
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
    expect(modeButton('Slider').disabled).toBeTrue();
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
      render({ stateName: 'Overdue', visualChange: 'new', baseUrl: null, diffUrl: null });
      expect(el.textContent).toContain('Not in the base version');
      expect(el.textContent).not.toContain('new component');
      render({ stateName: 'Overdue', visualChange: 'deleted', headUrl: null, diffUrl: null });
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
        diffUrl: '/artifacts/7/11/s1/diff.png',
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

  function render(liveEnabled = true, liveTarget: LiveTarget | null = target): void {
    fixture.componentRef.setInput('label', 'CartSummary');
    fixture.componentRef.setInput('baseUrl', '/artifacts/7/11/base.png');
    fixture.componentRef.setInput('headUrl', '/artifacts/7/11/head.png');
    fixture.componentRef.setInput('diffUrl', '/artifacts/7/11/diff.png');
    fixture.componentRef.setInput('visualChange', 'changed');
    fixture.componentRef.setInput('liveEnabled', liveEnabled);
    fixture.componentRef.setInput('liveTarget', liveTarget);
    fixture.componentRef.setInput('stepSummary', ['Click button "More actions"']);
    fixture.detectChanges();
  }
  const liveButton = (): HTMLButtonElement | null => el.querySelector<HTMLButtonElement>('[data-testid="mode-live"]');
  const testId = (id: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  function chooseLive(): void {
    liveButton()?.click();
    fixture.detectChanges();
  }
  function clickStart(): TestRequest {
    testId('live-start-button')?.click();
    fixture.detectChanges();
    return httpMock.expectOne((r) => r.method === 'POST' && r.url === liveUrl);
  }
  function answer(req: TestRequest, session: Partial<LiveSessionView>, status = 200): void {
    req.flush({ status, data: liveSession(session) });
    fixture.detectChanges();
  }
  function opens(): TestRequest[] {
    return httpMock.match((r) => r.url === `${liveUrl}/open`);
  }

  it('offers Live as a fourth mode, enabled only when liveEnabled and a target are set; screenshots stay default', () => {
    render(false);
    expect(liveButton()?.textContent).toContain('Live');
    expect(liveButton()?.textContent).toContain('sensors');
    expect(liveButton()?.disabled).toBeTrue();
    render(true, null);
    expect(liveButton()?.disabled).toBeTrue();
    render(true);
    expect(liveButton()?.disabled).toBeFalse();
    expect(liveButton()?.getAttribute('aria-pressed')).toBe('false');
    expect(el.querySelectorAll('img').length).toBe(2);
  });

  it('Live is disabled where no LiveSessionStore is provided', async () => {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [ImageCompareComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
    const bare = TestBed.createComponent(ImageCompareComponent);
    bare.componentRef.setInput('label', 'CartSummary');
    bare.componentRef.setInput('liveEnabled', true);
    bare.componentRef.setInput('liveTarget', target);
    bare.detectChanges();
    const button = (bare.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('[data-testid="mode-live"]');
    expect(button?.disabled).toBeTrue();
    bare.destroy();
  });

  it('choosing Live without a session asks to start it; Start posts and shows the preparing spinner', () => {
    render();
    chooseLive();
    expect(testId('live-start')?.textContent).toContain(
      'Live mode runs the before and after components in your browser, each side on its own. Start it for this run?',
    );
    expect(testId('live-start-button')?.textContent?.trim()).toContain('Start live mode');
    expect(el.querySelector('[aria-label="Zoom"]')).toBeNull();
    expect(el.querySelectorAll('img').length).toBe(0);
    const req = clickStart();
    expect(testId('live-starting')?.textContent).toContain('Preparing the before and after code…');
    answer(req, { status: 'starting', readyAt: null }, 202);
    expect(testId('live-starting')?.textContent).toContain('Preparing the before and after code…');
    expect(opens().length).toBe(0);
  });

  it('once ready, opens the open state on both sides and shows the live compare', () => {
    render();
    chooseLive();
    answer(clickStart(), { hosts: [] }, 202);
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
    chooseLive();
    answer(clickStart(), { hosts: readyHosts() }, 202);
    opens()[0]?.flush({ status: 202, data: liveSession({ hosts: readyHosts() }) });
    fixture.componentRef.setInput('liveTarget', { ...target, stateName: 'Default' });
    fixture.detectChanges();
    const [open] = opens();
    expect(open?.request.body).toEqual({ componentId: 11, stateName: 'Default' });
    open?.flush({ status: 202, data: liveSession({ hosts: readyHosts() }) });
  });

  it('the two-session limit error is shown on the start panel', () => {
    render();
    chooseLive();
    clickStart().flush(
      { status: 409, error: TWO_SESSIONS, error_reason: 'conflict' },
      { status: 409, statusText: 'x' },
    );
    fixture.detectChanges();
    expect(testId('live-message')?.textContent?.trim()).toBe(TWO_SESSIONS);
    expect(testId('live-start-button')).not.toBeNull();
  });

  it('an idle stop says so and offers Start again', () => {
    render();
    chooseLive();
    answer(clickStart(), { status: 'stopped', stopReason: 'idle', stoppedAt: '2026-10-07T10:11:00.000Z' }, 202);
    expect(testId('live-message')?.textContent?.trim()).toBe('Live mode stopped after 10 minutes idle.');
    expect(testId('live-start-button')?.textContent).toContain('Start again');
    const again = clickStart();
    expect(again.request.body).toEqual({});
    answer(again, { id: 4, status: 'starting', readyAt: null }, 202);
    expect(testId('live-starting')).not.toBeNull();
  });

  it('a failed session shows its error with Try again', () => {
    render();
    chooseLive();
    answer(
      clickStart(),
      { status: 'failed', errorMessage: 'Could not prepare the before and after code in time.' },
      202,
    );
    expect(testId('live-message')?.textContent?.trim()).toBe('Could not prepare the before and after code in time.');
    expect(testId('live-start-button')?.textContent).toContain('Try again');
  });

  it('leaving Live mode returns to the screenshots', () => {
    render();
    chooseLive();
    const sideBySide = Array.from(el.querySelectorAll('[aria-label="Comparison mode"] button')).find((b) =>
      b.textContent?.includes('Side by side'),
    ) as HTMLButtonElement;
    sideBySide.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('img').length).toBe(2);
    expect(testId('live-start')).toBeNull();
  });
});
