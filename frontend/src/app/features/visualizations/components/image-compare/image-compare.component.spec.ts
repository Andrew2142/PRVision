import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { environment } from '../../../../../environments/environment';
import { type VisualChange } from '../../../../core/models/domain-enums.model';
import { ImageCompareComponent } from './image-compare.component';

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
});
