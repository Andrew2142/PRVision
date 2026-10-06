import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { type VisualizationComponentView } from '../../../../core/models/visualization.model';
import { componentView } from '../../testing/visualization-fixtures';
import { ComponentCardComponent } from './component-card.component';

const DIFF = ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,1 +1,2 @@', '-a', '+b', '+c'].join('\n');

describe('ComponentCardComponent', () => {
  let fixture: ComponentFixture<ComponentCardComponent>;
  let el: HTMLElement;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ComponentCardComponent],
      providers: [provideNoopAnimations()],
    }).compileComponents();
    fixture = TestBed.createComponent(ComponentCardComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  function render(overrides: Partial<VisualizationComponentView> = {}, runActive = false): void {
    fixture.componentRef.setInput('component', componentView(overrides));
    fixture.componentRef.setInput('runActive', runActive);
    fixture.detectChanges();
  }
  const pills = (): string[] =>
    Array.from(el.querySelectorAll('header app-status-pill')).map((p) => p.textContent?.trim() ?? '');
  const section = (name: string): HTMLDetailsElement | null =>
    el.querySelector<HTMLDetailsElement>(`details[data-section="${name}"]`);
  function open(name: string): void {
    const d = section(name);
    if (!d) throw new Error(`no section ${name}`);
    d.open = true;
    d.dispatchEvent(new Event('toggle'));
    fixture.detectChanges();
  }

  it('pills for change kind, visual change with percent, risk', () => {
    render({ changeKind: 'modified', visualChange: 'changed', diffPixelRatio: 0.042, risk: 'likely_regression' });
    expect(pills()).toEqual(['Modified', 'Changed · 4.2%', 'Likely regression']);
    expect(el.querySelector('h3')?.textContent?.trim()).toBe('CartSummary');
    expect(el.textContent).toContain('#1');
    expect(el.textContent).toContain('src/components/CartSummary.tsx');
    expect(el.querySelector('[aria-label="Copy file path"]')).not.toBeNull();
  });

  it('changed without a ratio uses the plain label', () => {
    render({ visualChange: 'changed', diffPixelRatio: null, risk: null });
    expect(pills()).toEqual(['Modified', 'Changed']);
  });

  it('render status pill hidden when rendered', () => {
    render({ renderStatus: 'rendered' });
    expect(pills()).not.toContain('Rendered');
    render({ renderStatus: 'partial', visualChange: 'new' });
    expect(pills()).toContain('Partial render');
  });

  it('"What changed" shows the AI note as the main text and the change reason underneath', () => {
    render({
      aiNote: 'Total wraps <b>onto</b> two lines.',
      changeReason: 'imports changed hook src/hooks/useCart.ts',
      risk: 'check',
    });
    const block = el.querySelector<HTMLElement>('[data-testid="what-changed"]')!;
    expect(block.querySelector('h4')?.textContent?.trim()).toBe('What changed');
    expect(block.getAttribute('aria-labelledby')).toBe(block.querySelector('h4')?.id ?? 'missing');
    expect(block.querySelector('[data-testid="what-changed-main"]')?.textContent?.trim()).toBe(
      'Total wraps <b>onto</b> two lines.',
    );
    expect(block.querySelector('b')).toBeNull();
    expect(block.querySelector('[data-testid="change-reason"]')?.textContent?.trim()).toBe(
      'Changed because: imports changed hook src/hooks/useCart.ts',
    );
    expect(pills()).toContain('Check');
    expect(block.querySelector('[data-testid="what-changed-ai"]')?.textContent?.trim()).toBe('AI');
  });

  it('"What changed" shows the change reason as the main text when there is no AI note', () => {
    render({ aiNote: null, changeKind: 'affected_parent', changeReason: 'imports changed hook src/hooks/useCart.ts' });
    const block = el.querySelector('[data-testid="what-changed"]');
    expect(block?.querySelector('[data-testid="what-changed-main"]')?.textContent?.trim()).toBe(
      'imports changed hook src/hooks/useCart.ts',
    );
    expect(block?.querySelector('[data-testid="change-reason"]')).toBeNull();
    expect(block?.querySelector('[data-testid="what-changed-ai"]')).toBeNull();
    expect(el.querySelector('[data-testid="parent-note"]')).toBeNull();
  });

  it('"What changed" is hidden without an AI note or change reason', () => {
    render({ aiNote: null, changeReason: null });
    expect(el.querySelector('[data-testid="what-changed"]')).toBeNull();
    render({ aiNote: '   ', changeReason: '' });
    expect(el.querySelector('[data-testid="what-changed"]')).toBeNull();
  });

  it('"What changed" sits above the screenshots and replaces the old AI-note callout', () => {
    render({ aiNote: 'The header is taller.', changeReason: 'Component code changed' });
    const block = el.querySelector('[data-testid="what-changed"]')!;
    const viewer = el.querySelector('app-image-compare')!;
    expect(block.compareDocumentPosition(viewer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(el.querySelector('[data-testid="ai-note"]')).toBeNull();
    expect(Array.from(el.querySelectorAll('mat-icon')).map((i) => i.textContent?.trim())).not.toContain('psychology');
    expect(el.querySelectorAll('[data-testid="change-reason"]').length).toBe(1);
  });

  it('pending shows waiting placeholder', () => {
    render({ renderStatus: 'pending', visualChange: null }, true);
    expect(el.querySelector('app-empty-state')?.textContent).toContain('Waiting to render…');
    expect(el.querySelector('app-image-compare')).toBeNull();
    render({ renderStatus: 'pending', visualChange: null }, false);
    expect(el.querySelector('app-empty-state')?.textContent).toContain('Not rendered');
  });

  it('skipped shows skipReason, falls back to default copy', () => {
    render({ renderStatus: 'skipped', visualChange: null, skipReason: 'Render cap of 25 components reached.' });
    expect(el.querySelector('app-empty-state')?.textContent).toContain('Skipped. Render cap of 25 components reached.');
    render({ renderStatus: 'skipped', visualChange: null, skipReason: null });
    expect(el.querySelector('app-empty-state')?.textContent).toContain(
      'This component was not rendered (render cap reached or not renderable in isolation).',
    );
  });

  it('errors section open with per-side messages', () => {
    render({
      renderStatus: 'failed',
      visualChange: null,
      baseImageUrl: null,
      headImageUrl: null,
      diffImageUrl: null,
      baseError: 'Base boom',
      headError: 'Head <boom>',
    });
    const errors = section('errors');
    expect(errors?.open).toBeTrue();
    expect(errors?.textContent).toContain('Base and head failed');
    expect(errors?.textContent).toContain('Base render failed');
    expect(errors?.textContent).toContain('Head render failed');
    expect(errors?.querySelectorAll('pre')[1]?.textContent).toBe('Head <boom>');
    expect(el.textContent).toContain('Render failed — see Render errors below');
  });

  it('code diff section renders only after open', () => {
    render({ codeDiff: DIFF });
    expect(section('code')?.textContent).toContain('+2 −1');
    expect(el.querySelector('app-code-diff')).toBeNull();
    open('code');
    expect(el.querySelector('app-code-diff')).not.toBeNull();
  });

  it('affected_parent without diff or changeReason shows the generic explanation', () => {
    render({ changeKind: 'affected_parent', codeDiff: null, changeReason: null });
    expect(el.querySelector('[data-testid="parent-note"]')?.textContent).toContain(
      'Re-rendered because a component or hook it uses changed.',
    );
    expect(section('code')).toBeNull();
  });

  it('structural section count', () => {
    render({
      structuralDiff: [
        { kind: 'element_added', path: 'div > span', tag: 'span' },
        { kind: 'text_changed', path: 'h2', before: 'a', after: 'b' },
      ],
    });
    expect(section('structure')?.textContent).toContain('2 changes');
    expect(el.querySelector('app-structural-diff-list')).toBeNull();
    open('structure');
    expect(el.querySelector('app-structural-diff-list')).not.toBeNull();
    render({ structuralDiff: [] });
    expect(section('structure')).toBeNull();
  });

  it('has no render harness section, even when the run saved a harness', () => {
    render({ harnessSource: 'line1\nline2\n', harnessNotes: 'Mocked the cart store.' });
    expect(section('harness')).toBeNull();
    expect(el.textContent).not.toContain('Render harness');
  });

  describe('Angular visualizations (15 §5.9.1)', () => {
    function renderAngular(overrides: Partial<VisualizationComponentView> = {}): void {
      fixture.componentRef.setInput('framework', 'angular');
      render(overrides);
    }

    it('titles the structural section "Template structure" and the list says template differences', () => {
      renderAngular({
        structuralDiff: [
          {
            kind: 'attribute_changed',
            path: 'section > @if > @else > ul > @for > li{key={order.id}} > div[1] > app-badge',
            tag: 'app-badge',
            attribute: '[size]',
            before: null,
            after: "{'lg'}",
          },
        ],
      });
      expect(section('structure')?.textContent).toContain('Template structure');
      expect(section('structure')?.textContent).not.toContain('Structural changes');
      open('structure');
      const list = el.querySelector('app-structural-diff-list');
      expect(list?.textContent).toContain('Template differences between the base and head versions');
      expect(list?.textContent).toContain('@for > li{key={order.id}}');
    });

    it('words vite_unavailable as "Build unavailable"', () => {
      renderAngular({
        renderStatus: 'partial',
        baseError: null,
        headError: '[vite_unavailable] The Angular build failed on the head side:\nAngular build:\n- src/styles.css',
      });
      const errors = section('errors');
      expect(errors?.textContent).toContain('Head render failed · Build unavailable');
      expect(errors?.querySelector('pre')?.textContent).toContain('[build_unavailable] The Angular build failed');
      expect(errors?.textContent).not.toContain('vite_unavailable');
    });

    it('keeps other failure kinds as stored', () => {
      renderAngular({ renderStatus: 'partial', headError: "[module_load] Module load failed: NG8002: Can't bind" });
      expect(section('errors')?.textContent).toContain('Head render failed');
      expect(section('errors')?.querySelector('pre')?.textContent).toContain('[module_load] Module load failed');
    });
  });

  it('React keeps the sheet 13 wording', () => {
    render({
      renderStatus: 'partial',
      headError: '[vite_unavailable] Vite could not start',
      structuralDiff: [{ kind: 'element_added', path: 'div > span', tag: 'span' }],
    });
    expect(section('structure')?.textContent).toContain('Structural changes');
    expect(section('errors')?.textContent).toContain('Head render failed');
    expect(section('errors')?.textContent).not.toContain('Build unavailable');
    expect(section('errors')?.querySelector('pre')?.textContent).toContain('[vite_unavailable] Vite could not start');
  });

  it('replaced: "Replaced" pill, "OldName → NewName" header, both paths and the evidence in plain words (00 §17)', () => {
    render({
      displayName: 'EventFormModalComponent',
      filePath: 'src/app/events/event-form-modal/event-form-modal.component.ts',
      changeKind: 'replaced',
      changeReason: 'Replaced by EventFormModalComponent (call site swap in events-list, rename)',
      baseFilePath: 'src/app/events/event-form/event-form.component.ts',
      baseExportName: 'EventFormComponent',
      baseDisplayName: 'EventFormComponent',
      successorEvidence: [
        {
          kind: 'call_site_swap',
          detail: 'src/app/events/events-list/events-list.component.html: <app-event-form> → <app-event-form-modal>',
        },
        {
          kind: 'git_rename',
          detail:
            'src/app/events/event-form/event-form.component.ts → src/app/events/event-form-modal/event-form-modal.component.ts (51% similar)',
        },
      ],
    });
    expect(pills()[0]).toBe('Replaced');
    expect(el.querySelector('h3')?.textContent?.trim()).toBe('EventFormComponent → EventFormModalComponent');
    const paths = Array.from(el.querySelectorAll('[data-testid="component-path"]')).map((row) =>
      Array.from(row.querySelectorAll(':scope > span')).map((span) => span.textContent?.trim()),
    );
    expect(paths).toEqual([
      ['Before', 'src/app/events/event-form/event-form.component.ts'],
      ['After', 'src/app/events/event-form-modal/event-form-modal.component.ts'],
    ]);
    expect(el.querySelector('[aria-label="Copy before file path"]')).not.toBeNull();
    expect(el.querySelector('[aria-label="Copy after file path"]')).not.toBeNull();
    const what = el.querySelector('[data-testid="what-changed"]');
    expect(what?.textContent).toContain('Replaced by EventFormModalComponent');
    const evidence = Array.from(el.querySelectorAll('[data-testid="replaced-evidence"] li')).map((li) =>
      li.textContent?.trim(),
    );
    expect(evidence).toEqual([
      'events list now uses the new component instead of the old one',
      'the new file is the old file renamed and edited (51% the same)',
    ]);
    // the image viewer still gets both sides
    expect(el.querySelector('app-image-compare')).not.toBeNull();
  });

  it('non-replaced cards keep one path and no evidence list', () => {
    render({ changeKind: 'added', successorEvidence: null });
    expect(el.querySelectorAll('[data-testid="component-path"]').length).toBe(1);
    expect(el.querySelector('[data-testid="replaced-evidence"]')).toBeNull();
    expect(el.querySelector('h3')?.textContent?.trim()).toBe('CartSummary');
  });
});
