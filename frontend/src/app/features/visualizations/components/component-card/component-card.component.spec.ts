import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { type VisualizationComponentView } from '../../../../core/models/visualization.model';
import { environment } from '../../../../../environments/environment';
import { componentView, harnessView, stateView } from '../../testing/visualization-fixtures';
import { ImageCompareComponent, type LiveTarget } from '../image-compare/image-compare.component';
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

  describe('states (16 §15.5.2)', () => {
    const ART = environment.artifactBaseUrl;
    const STATES = [
      stateView(0),
      stateView(1, {
        name: 'Overdue',
        visualChange: 'changed',
        diffPixelRatio: 0.03,
        steps: [{ action: 'click', target: { by: 'role', role: 'button', name: 'More actions' } }],
        stepSummary: ['Click button "More actions"', 'Hover link "Docs"'],
      }),
      stateView(2, { name: 'Menu open', visualChange: 'changed' }),
    ];
    const multi = { visualChange: 'changed' as const, states: STATES, stateCount: 3, changedStateCount: 2 };
    const srcs = (): (string | null)[] =>
      Array.from(el.querySelectorAll('app-image-compare img')).map((i) => i.getAttribute('src'));
    const tabs = (): HTMLButtonElement[] =>
      Array.from(el.querySelectorAll<HTMLButtonElement>('app-state-tabs [role="tab"]'));

    it('opens on the first changed state and passes its images down', () => {
      render(multi);
      expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
      expect(srcs()).toEqual([`${ART}/artifacts/7/11/s1/base.png`, `${ART}/artifacts/7/11/s1/head.png`]);
      expect(el.querySelector('app-image-compare img')?.getAttribute('alt')).toBe(
        'Base render of CartSummary · Overdue',
      );
      const panel = el.querySelector('[role="tabpanel"]');
      expect(panel?.id).toBe('cmp-11-states-panel');
      expect(panel?.getAttribute('aria-labelledby')).toBe('cmp-11-states-tab-1');
    });

    it('Default first when no state changed', () => {
      render({
        visualChange: 'unchanged',
        states: [stateView(0), stateView(1, { name: 'Overdue' })],
        stateCount: 2,
        changedStateCount: 0,
      });
      el.querySelector<HTMLButtonElement>('[data-testid="show-screenshots"]')?.click();
      fixture.detectChanges();
      expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    });

    it('another tab shows that state, with its steps line', () => {
      render(multi);
      expect(el.querySelector('[data-testid="state-steps"]')?.textContent?.trim()).toBe(
        'Reached by: Click button "More actions" → Hover link "Docs"',
      );
      tabs()[2]?.click();
      fixture.detectChanges();
      expect(srcs()).toEqual([`${ART}/artifacts/7/11/s2/base.png`, `${ART}/artifacts/7/11/s2/head.png`]);
      expect(el.querySelector('[data-testid="state-steps"]')).toBeNull();
    });

    it('the visual pill shows the row aggregate', () => {
      render(multi);
      expect(pills()).toContain('2 of 3 states changed');
    });

    it('the user pick survives a refreshed row', () => {
      render(multi);
      tabs()[0]?.click();
      fixture.detectChanges();
      render({ ...multi, aiNote: 'refreshed' });
      expect(tabs().map((t) => t.getAttribute('aria-selected'))).toEqual(['true', 'false', 'false']);
    });

    it('a single-state row shows no tabs and plain image labels', () => {
      render();
      expect(el.querySelector('app-state-tabs [role="tablist"]')).toBeNull();
      expect(el.querySelector('[role="tabpanel"]')).toBeNull();
      expect(el.querySelector('app-image-compare img')?.getAttribute('alt')).toBe('Base render of CartSummary');
    });

    it('a row without state rows falls back to its own images', () => {
      render({ states: [] });
      expect(srcs()).toEqual([`${ART}/artifacts/7/11/base.png`, `${ART}/artifacts/7/11/head.png`]);
    });
  });

  describe('harness status (16 §15.5.3)', () => {
    const chip = (): string | null => el.querySelector('[data-testid="harness-origin"]')?.textContent?.trim() ?? null;

    it('harness chips per origin', () => {
      render({ harness: harnessView({ origin: 'library' }) });
      expect(chip()).toBe('Saved harness');
      render({ harness: harnessView({ origin: 'written' }) });
      expect(chip()).toBe('New harness');
      render({ harness: harnessView({ origin: 'repaired' }) });
      expect(chip()).toBe('Repaired harness');
      render({ harness: harnessView({ origin: null }) });
      expect(chip()).toBeNull();
    });

    it('source changed hint', () => {
      render({ harness: harnessView({ origin: 'library', sourceChangedSinceWrite: true }) });
      expect(el.querySelector('[data-testid="harness-source-changed"]')?.textContent?.trim()).toBe(
        'The component changed since this harness was written.',
      );
      render({ harness: harnessView({ origin: 'library', sourceChangedSinceWrite: false }) });
      expect(el.querySelector('[data-testid="harness-source-changed"]')).toBeNull();
    });

    it('needs updating: warning with the failing side and Repair emits the component id', () => {
      const repaired: number[] = [];
      fixture.componentInstance.repair.subscribe((id) => repaired.push(id));
      render({
        renderStatus: 'partial',
        headError: '[render_error] TypeError: heading is undefined',
        harness: harnessView({ origin: 'library', needsUpdate: true }),
      });
      const alert = el.querySelector('[data-testid="needs-update"]');
      expect(alert?.textContent).toContain('Harness needs updating');
      expect(alert?.textContent).toContain(
        'The saved harness no longer renders this component on the head side. Repair asks the AI for a new harness and saves it to the library.',
      );
      const repair = el.querySelector<HTMLButtonElement>('[data-testid="repair"]');
      expect(repair?.textContent?.trim()).toContain('Repair');
      repair?.click();
      expect(repaired).toEqual([11]);
    });

    it('a base-only failure names the base side', () => {
      render({
        renderStatus: 'partial',
        baseError: 'boom',
        harness: harnessView({ origin: 'library', needsUpdate: true }),
      });
      expect(el.querySelector('[data-testid="needs-update"]')?.textContent).toContain('on the base side.');
    });

    it('while repairing: spinner, "Repairing…", disabled', () => {
      render({ harness: harnessView({ needsUpdate: true, repairing: true }) });
      const repair = el.querySelector<HTMLButtonElement>('[data-testid="repair"]');
      expect(repair?.disabled).toBeTrue();
      expect(repair?.textContent?.trim()).toBe('Repairing…');
      expect(repair?.querySelector('mat-spinner')).not.toBeNull();
      fixture.componentRef.setInput('component', componentView({ harness: harnessView({ needsUpdate: true }) }));
      fixture.componentRef.setInput('repairRequested', true);
      fixture.detectChanges();
      expect(el.querySelector<HTMLButtonElement>('[data-testid="repair"]')?.disabled).toBeTrue();
    });

    it('no Repair button while the run is still active', () => {
      render({ harness: harnessView({ needsUpdate: true }) }, true);
      expect(el.querySelector('[data-testid="needs-update"]')).not.toBeNull();
      expect(el.querySelector('[data-testid="repair"]')).toBeNull();
    });

    it('re-checked rows show the Re-checked pill and their reason', () => {
      render({
        changeKind: 'rechecked',
        visualChange: 'changed',
        changeReason: 'Global style changed (src/index.css); re-checked with the saved harness',
        harness: harnessView({ origin: 'library' }),
      });
      expect(pills()[0]).toBe('Re-checked');
      expect(el.querySelector('[data-testid="what-changed-main"]')?.textContent?.trim()).toBe(
        'Global style changed (src/index.css); re-checked with the saved harness',
      );
    });
  });

  describe('live inputs (16j)', () => {
    function compare(): ImageCompareComponent {
      const debug = fixture.debugElement.query(By.directive(ImageCompareComponent));
      return debug.componentInstance as ImageCompareComponent;
    }
    function liveInputs(): { enabled: boolean; target: LiveTarget | null; steps: readonly string[] } {
      const c = compare();
      return { enabled: c.liveEnabled(), target: c.liveTarget(), steps: c.stepSummary() };
    }
    const states = [
      stateView(0, { visualChange: 'unchanged' }),
      stateView(1, {
        name: 'Menu open',
        visualChange: 'new',
        onBase: false,
        baseImageUrl: null,
        stepSummary: ['Click button "More actions"'],
      }),
    ];

    it('Live follows the run, the harness and the open state', () => {
      fixture.componentRef.setInput('liveAvailable', true);
      render({ harnessSource: 'x', states, stateCount: 2, changedStateCount: 1 });
      expect(liveInputs()).toEqual({
        enabled: true,
        target: { componentId: 11, stateName: 'Menu open', onBase: false, onHead: true },
        steps: ['Click button "More actions"'],
      });
      el.querySelector<HTMLButtonElement>('app-state-tabs [data-value="0"]')?.click();
      fixture.detectChanges();
      expect(liveInputs().target).toEqual({ componentId: 11, stateName: 'Default', onBase: true, onHead: true });
    });

    it('off when the run cannot go live, the row has no harness, or the run is still active', () => {
      render({ harnessSource: 'x' });
      expect(liveInputs().enabled).toBeFalse();
      fixture.componentRef.setInput('liveAvailable', true);
      render({ harnessSource: null });
      expect(liveInputs().enabled).toBeFalse();
      render({ harnessSource: 'x' }, true);
      expect(liveInputs().enabled).toBeFalse();
    });
  });
});
