import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type ComponentFixture, TestBed, discardPeriodicTasks, fakeAsync, tick } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type VisualizationDetailView } from '../../../core/models/visualization.model';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { liveSession } from '../testing/live-fixtures';
import { componentView, detailView, harnessView, repairJobView } from '../testing/visualization-fixtures';
import { VisualizationDetailComponent } from './visualization-detail.component';

const BASE = environment.apiBaseUrl;

describe('VisualizationDetailComponent', () => {
  let fixture: ComponentFixture<VisualizationDetailComponent>;
  let el: HTMLElement;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let confirm: jasmine.SpyObj<ConfirmDialogService>;
  let navigate: jasmine.Spy;

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']);
    confirm = jasmine.createSpyObj<ConfirmDialogService>('ConfirmDialogService', ['confirm']);
    confirm.confirm.and.returnValue(of(true));
    await TestBed.configureTestingModule({
      imports: [VisualizationDetailComponent],
      providers: [
        provideRouter([]),
        provideNoopAnimations(),
        provideHttpClient(withInterceptors([errorInterceptor])),
        provideHttpClientTesting(),
        { provide: NotificationService, useValue: notifications },
        { provide: ConfirmDialogService, useValue: confirm },
      ],
    }).compileComponents();
    httpMock = TestBed.inject(HttpTestingController);
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(VisualizationDetailComponent);
    el = fixture.nativeElement as HTMLElement;
  });

  afterEach(() => {
    httpMock.verify({ ignoreCancelled: true });
  });

  /** Renders the page for `id` and answers the first detail and console requests. */
  function load(view: Partial<VisualizationDetailView> = {}, id = '7', section?: string): void {
    fixture.componentRef.setInput('id', id);
    if (section !== undefined) fixture.componentRef.setInput('view', section);
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(`${BASE}/visualizations/${id}`)
      .flush({ status: 200, data: detailView({ id: Number(id), ...view }) });
    for (const r of httpMock.match((req) => req.url.endsWith('/console'))) r.flush({ status: 200, data: [] });
    fixture.detectChanges();
  }
  function done(): void {
    fixture.destroy();
    httpMock.match(() => true);
    discardPeriodicTasks();
  }
  function tabs(): HTMLButtonElement[] {
    return Array.from(el.querySelectorAll<HTMLButtonElement>('[aria-label="Visualization sections"] [role="tab"]'));
  }
  function activePanel(): string | null {
    return el.querySelector('[role="tabpanel"]')?.getAttribute('data-view') ?? null;
  }
  /** Visible text of an element without its Material icon ligatures ("folder_open", "commit"). */
  function textWithoutIcons(node: Element | null): string {
    if (!node) return '';
    const copy = node.cloneNode(true) as Element;
    for (const icon of Array.from(copy.querySelectorAll('mat-icon'))) icon.remove();
    return (copy.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  function button(text: string): HTMLButtonElement | undefined {
    return Array.from(el.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.includes(text));
  }

  it('invalid id → not found without request', fakeAsync(() => {
    fixture.componentRef.setInput('id', 'abc');
    fixture.detectChanges();
    tick(5000);
    httpMock.expectNone(() => true);
    fixture.detectChanges();
    expect(el.textContent).toContain('Visualization not found');
    done();
  }));

  it('renders header meta (source, repo link, refs with short shas, status)', fakeAsync(() => {
    load({ status: 'rendering', sourceType: 'github_pr', prNumber: 42, title: 'Fix cart totals', headRef: 'fix/cart' });
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Fix cart totals');
    expect(el.textContent).toContain('PR #42');
    const repoLink = el.querySelector<HTMLAnchorElement>('a[href="/repositories/1"]');
    expect(textWithoutIcons(repoLink)).toBe('sample-react-app');
    expect(textWithoutIcons(el.querySelector('[data-testid="refs"]'))).toBe('main @ a1b2c3d to fix/cart @ d4e5f6a');
    expect(el.querySelector('[aria-label="Status: Rendering"]')).not.toBeNull();
    expect(el.querySelector('app-pipeline-stepper')).not.toBeNull();
    expect(el.querySelector('app-console-panel')).not.toBeNull();
    done();
  }));

  it('header shows the framework chip (React)', fakeAsync(() => {
    load();
    expect(el.querySelector('[data-testid="framework"]')?.textContent?.trim()).toBe('React + Vite');
    done();
  }));

  it('Angular run: framework chip, Angular wording on cards and the empty state (15 §5.9.1)', fakeAsync(() => {
    load(
      {
        framework: 'angular',
        repositoryName: 'sample-angular-monorepo · web',
        status: 'completed',
        components: [
          componentView({
            id: 1,
            rank: 0,
            displayName: 'OrderListComponent',
            filePath: 'apps/web/src/app/orders/order-list/order-list.component.ts',
            renderStatus: 'partial',
            headError: '[vite_unavailable] The Angular build failed on the head side:',
            structuralDiff: [{ kind: 'element_added', path: '@if', tag: '@if' }],
          }),
        ],
      },
      '7',
      'components',
    );
    expect(el.querySelector('[data-testid="framework"]')?.textContent?.trim()).toBe('Angular');
    const card = el.querySelector('app-component-card');
    expect(card?.textContent).toContain('Template structure');
    expect(card?.textContent).toContain('Head render failed · Build unavailable');
    done();
  }));

  it('Angular run without components names Angular components', fakeAsync(() => {
    load({ framework: 'angular', status: 'completed', components: [] }, '7', 'components');
    expect(el.textContent).toContain('None of the changed files affect Angular components PRVision can render.');
    done();
  }));

  it('working_tree head shows "working tree"', fakeAsync(() => {
    load({ sourceType: 'working_tree', headRef: 'working-tree', headSha: null });
    expect(textWithoutIcons(el.querySelector('[data-testid="refs"]'))).toBe('main @ a1b2c3d to working tree');
    done();
  }));

  it('Cancel visible only non-terminal and asks confirm', fakeAsync(() => {
    load({ status: 'rendering' });
    expect(button('Delete')).toBeUndefined();
    button('Cancel')?.click();
    expect(confirm.confirm.calls.mostRecent().args[0]).toEqual(
      jasmine.objectContaining({ title: 'Cancel this visualization?', confirmColor: 'warn' }),
    );
    httpMock
      .expectOne(`${BASE}/visualizations/7/cancel`)
      .flush({ status: 202, data: { id: 7, status: 'cancel_requested' } }, { status: 202, statusText: 'x' });
    fixture.detectChanges();
    expect(button('Cancelling…')?.disabled).toBeTrue();
    expect(notifications.info.calls.count()).toBe(1);
    done();
  }));

  it('declining the cancel confirm sends nothing', fakeAsync(() => {
    confirm.confirm.and.returnValue(of(false));
    load({ status: 'rendering' });
    button('Cancel')?.click();
    httpMock.expectNone(`${BASE}/visualizations/7/cancel`);
    expect(confirm.confirm.calls.count()).toBe(1);
    done();
  }));

  it('Delete visible only terminal, confirm → navigate', fakeAsync(() => {
    load({ status: 'completed' });
    expect(button('Cancel')).toBeUndefined();
    button('Delete')?.click();
    expect(confirm.confirm.calls.mostRecent().args[0].message).toContain('"feature/button-restyle → main"');
    const del = httpMock.expectOne((r) => r.method === 'DELETE' && r.url === `${BASE}/visualizations/7`);
    del.flush({ status: 200, data: { id: 7 } });
    expect(notifications.success.calls.allArgs()).toEqual([['Visualization deleted']]);
    expect(navigate.calls.mostRecent().args[0]).toEqual(['/visualizations']);
    done();
  }));

  it('failed shows "Failed during <stage>" from failedStage with errorMessage', fakeAsync(() => {
    load({ status: 'failed', failedStage: 'rendering', errorMessage: 'Vite could not start: port in use' });
    const alert = el.querySelector('app-inline-alert[tone="error"]');
    expect(alert?.textContent).toContain('Failed during Rendering');
    expect(alert?.textContent).toContain('Vite could not start: port in use');
    const consoleDetails = el.querySelector<HTMLDetailsElement>('app-console-panel details')!;
    expect(consoleDetails.open).toBeTrue(); // failed runs keep the console open
    done();
  }));

  it('failed without message uses the default copy', fakeAsync(() => {
    load({ status: 'failed', failedStage: 'analyzing', errorMessage: null });
    expect(el.textContent).toContain('Failed during Analyzing changes');
    expect(el.textContent).toContain('The pipeline stopped with an error. See the console for details.');
    done();
  }));

  it('cancelled shows "Cancelled during <stage>"', fakeAsync(() => {
    load({ status: 'cancelled', failedStage: 'generating_harnesses' });
    const alert = el.querySelector('app-inline-alert[tone="warning"]');
    expect(alert?.textContent).toContain('Cancelled during Generating harnesses');
    expect(alert?.textContent).toContain(
      'Results that finished before cancellation are kept in Summary and Components.',
    );
    done();
  }));

  it('filter chips show counts', fakeAsync(() => {
    load({
      status: 'completed',
      components: [
        componentView({ id: 1, visualChange: 'changed' }),
        componentView({ id: 2, visualChange: 'new', renderStatus: 'partial' }),
        componentView({ id: 3, visualChange: 'unchanged' }),
        componentView({ id: 4, visualChange: null, renderStatus: 'failed', headError: 'boom' }),
      ],
    });
    expect(activePanel()).toBe('summary');
    expect(el.querySelector('[data-tile="changed"]')?.textContent).toContain('2');
    tabs()
      .find((t) => t.textContent?.includes('Components'))
      ?.click();
    fixture.detectChanges();
    const group = el.querySelector('[aria-label="Filter components"]');
    const labels = Array.from(group?.querySelectorAll('button') ?? []).map((b) => b.textContent?.replace(/\s+/g, ''));
    expect(labels).toEqual(['Changed2', 'Unchanged1', 'Failed1', 'All4']);
    expect(el.querySelectorAll('app-component-card').length).toBe(2); // default filter: Changed
    Array.from(group?.querySelectorAll('button') ?? [])
      .find((b) => b.textContent?.includes('All'))
      ?.click();
    fixture.detectChanges();
    expect(el.querySelectorAll('app-component-card').length).toBe(4);
    done();
  }));

  it('cards render in rank order', fakeAsync(() => {
    load(
      {
        status: 'completed',
        components: [
          componentView({ id: 1, rank: 2, displayName: 'Third' }),
          componentView({ id: 2, rank: 0, displayName: 'First' }),
          componentView({ id: 3, rank: 1, displayName: 'Second' }),
        ],
      },
      '7',
      'components',
    );
    const names = Array.from(el.querySelectorAll('app-component-card h3')).map((h) => h.textContent?.trim());
    expect(names).toEqual(['First', 'Second', 'Third']);
    done();
  }));

  it('empty copy for each terminal state', fakeAsync(() => {
    load({ status: 'completed', components: [] }, '7', 'components');
    expect(el.textContent).toContain('No UI components affected');
    done();
  }));

  it('empty copy when failed, cancelled and running', fakeAsync(() => {
    load({ status: 'failed', components: [] }, '7', 'components');
    expect(el.textContent).toContain('The run stopped before any components were found.');
    fixture.componentRef.setInput('id', '8');
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(`${BASE}/visualizations/8`)
      .flush({ status: 200, data: detailView({ id: 8, status: 'cancelled' }) });
    fixture.detectChanges();
    expect(el.textContent).toContain('No components');
    fixture.componentRef.setInput('id', '9');
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(`${BASE}/visualizations/9`)
      .flush({ status: 200, data: detailView({ id: 9, status: 'queued', startedAt: null, completedAt: null }) });
    fixture.detectChanges();
    expect(el.textContent).toContain('Looking for changed components');
    expect(button('Cancel')).toBeDefined();
    done();
  }));

  it('page title set from detail', fakeAsync(() => {
    load({ title: 'Fix cart totals' });
    expect(TestBed.inject(Title).getTitle()).toBe('Fix cart totals · PRVision');
    done();
  }));

  describe('view selector (revision 5)', () => {
    const COMPLETED = {
      status: 'completed' as const,
      summaryMarkdown: 'The cart total is easier to read.',
      components: [componentView({ id: 1, visualChange: 'changed', displayName: 'CartSummary' })],
    };

    it('is a tablist with Components (count), Summary and Console under the stepper', fakeAsync(() => {
      load(COMPLETED);
      const list = el.querySelector('[role="tablist"]');
      expect(list?.getAttribute('aria-label')).toBe('Visualization sections');
      expect(tabs().map((t) => t.textContent?.replace(/\s+/g, ''))).toEqual([
        'widgetsComponents1',
        'auto_awesomeSummary',
        'terminalConsole',
      ]);
      const stepper = el.querySelector('app-pipeline-stepper')!;
      expect(stepper.compareDocumentPosition(list!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const panel = el.querySelector('[role="tabpanel"]');
      expect(panel?.id).toBe('viz-view-panel');
      expect(panel?.getAttribute('aria-labelledby')).toBe('viz-view-tab-summary');
      done();
    }));

    it('defaults to Summary for a completed run and renders only that view', fakeAsync(() => {
      load(COMPLETED);
      expect(activePanel()).toBe('summary');
      expect(tabs()[1]?.getAttribute('aria-selected')).toBe('true');
      expect(el.querySelector('app-summary-card')?.textContent).toContain('The cart total is easier to read.');
      // Components, Changed, Unchanged, Failed, plus the harness library tiles (16 §15.5.1).
      expect(Array.from(el.querySelectorAll('[data-tile]')).map((t) => t.getAttribute('data-tile'))).toEqual([
        'all',
        'changed',
        'unchanged',
        'failed',
        'reused',
        'new',
      ]);
      for (const icon of Array.from(el.querySelectorAll('[data-tile] mat-icon'))) {
        const style = getComputedStyle(icon);
        expect(style.lineHeight).toBe(style.fontSize); // glyph centred in its badge
        expect(style.width).toBe(style.fontSize);
      }
      expect(el.querySelector('app-console-panel')).toBeNull();
      expect(el.querySelector('app-component-card')).toBeNull();
      expect(el.querySelector('[aria-label="Filter components"]')).toBeNull();
      done();
    }));

    it('defaults to Console while running, failed or cancelled', fakeAsync(() => {
      load({ status: 'rendering' });
      expect(activePanel()).toBe('console');
      expect(el.querySelector('app-summary-card')).toBeNull();
      expect(el.querySelector<HTMLDetailsElement>('app-console-panel details')?.open).toBeTrue();
      fixture.componentRef.setInput('id', '8');
      fixture.detectChanges();
      tick(0);
      httpMock
        .expectOne(`${BASE}/visualizations/8`)
        .flush({ status: 200, data: detailView({ id: 8, status: 'cancelled' }) });
      fixture.detectChanges();
      expect(activePanel()).toBe('console');
      done();
    }));

    it('switches from Console to Summary when a watched run completes without a pick', fakeAsync(() => {
      load({ status: 'summarizing' });
      expect(activePanel()).toBe('console');
      tick(2000);
      httpMock.expectOne(`${BASE}/visualizations/7`).flush({ status: 200, data: detailView({ id: 7, ...COMPLETED }) });
      for (const r of httpMock.match((req) => req.url.endsWith('/console'))) r.flush({ status: 200, data: [] });
      fixture.detectChanges();
      expect(activePanel()).toBe('summary');
      done();
    }));

    it('?view= picks the view; an unknown value falls back to the default', fakeAsync(() => {
      load(COMPLETED, '7', 'console');
      expect(activePanel()).toBe('console');
      expect(tabs()[2]?.getAttribute('aria-selected')).toBe('true');
      expect(tabs()[2]?.getAttribute('tabindex')).toBe('0');
      fixture.componentRef.setInput('view', 'components');
      fixture.detectChanges();
      expect(activePanel()).toBe('components');
      expect(el.querySelectorAll('app-component-card').length).toBe(1);
      fixture.componentRef.setInput('view', 'nonsense');
      fixture.detectChanges();
      expect(activePanel()).toBe('summary');
      done();
    }));

    it('clicking a tab shows that view and stores it in ?view= (merge, replaceUrl)', fakeAsync(() => {
      load(COMPLETED);
      tabs()
        .find((t) => t.textContent?.includes('Console'))
        ?.click();
      fixture.detectChanges();
      expect(activePanel()).toBe('console');
      expect(el.querySelector('app-summary-card')).toBeNull();
      const [commands, extras] = navigate.calls.mostRecent().args as [unknown[], Record<string, unknown>];
      expect(commands).toEqual([]);
      expect(extras).toEqual(
        jasmine.objectContaining({ queryParams: { view: 'console' }, queryParamsHandling: 'merge', replaceUrl: true }),
      );
      done();
    }));

    it('arrow keys move between views', fakeAsync(() => {
      load(COMPLETED);
      tabs()[1]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      fixture.detectChanges();
      expect(activePanel()).toBe('console');
      expect(document.activeElement).toBe(tabs()[2] ?? null);
      tabs()[2]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
      fixture.detectChanges();
      expect(activePanel()).toBe('components');
      done();
    }));
  });

  it('404 shows the not-found panel', fakeAsync(() => {
    fixture.componentRef.setInput('id', '7');
    fixture.detectChanges();
    tick(0);
    httpMock
      .expectOne(`${BASE}/visualizations/7`)
      .flush(
        { status: 404, error: 'Visualization 7 not found', error_reason: 'not_found' },
        { status: 404, statusText: 'x' },
      );
    fixture.detectChanges();
    expect(el.textContent).toContain('Visualization not found');
    expect(notifications.error.calls.count()).toBe(0);
    done();
  }));

  describe('harness library (16 §15.5)', () => {
    it('the summary line reads "201 checked, 14 changed" and the global style trigger chip shows', fakeAsync(() => {
      load({ checkedCount: 201, changedCount: 14, globalStyleTrigger: 'src/index.css' });
      expect(el.querySelector('[data-testid="summary-line"]')?.textContent?.trim()).toMatch(
        /^201 checked, 14 changed · Started /,
      );
      expect(textWithoutIcons(el.querySelector('[data-testid="global-style-trigger"]'))).toBe(
        'Global style change: src/index.css — every saved harness was re-checked',
      );
      done();
    }));

    it('no trigger chip and no counts prefix for an older run', fakeAsync(() => {
      load({ checkedCount: 0 });
      expect(el.querySelector('[data-testid="global-style-trigger"]')).toBeNull();
      expect(el.querySelector('[data-testid="summary-line"]')?.textContent).not.toContain('checked');
      done();
    }));

    it('stat tiles count reused and new harnesses', fakeAsync(() => {
      load({ status: 'completed', reusedHarnessCount: 187, newHarnessCount: 3 }, '7', 'summary');
      expect(el.querySelector('[data-tile="reused"]')?.textContent).toContain('Reused harnesses');
      expect(el.querySelector('[data-tile="reused"]')?.textContent).toContain('187');
      expect(el.querySelector('[data-tile="new"]')?.textContent).toContain('New harnesses');
      expect(el.querySelector('[data-tile="new"]')?.textContent).toContain('3');
      done();
    }));

    it('a clean global-style re-check opens on Changed with "No component changed visually. <n> checked."', fakeAsync(() => {
      load(
        {
          status: 'completed',
          checkedCount: 201,
          changedCount: 0,
          globalStyleTrigger: 'src/index.css',
          components: [
            componentView({ id: 1, visualChange: 'unchanged' }),
            componentView({ id: 2, changeKind: 'rechecked', visualChange: 'unchanged' }),
          ],
        },
        '7',
        'components',
      );
      const group = el.querySelector('[aria-label="Filter components"]');
      expect(group?.querySelector('[aria-pressed="true"]')?.textContent?.replace(/\s+/g, '')).toBe('Changed0');
      expect(el.querySelectorAll('app-component-card').length).toBe(0);
      expect(el.querySelector('app-empty-state')?.textContent).toContain('No component changed visually.');
      expect(el.querySelector('app-empty-state')?.textContent).toContain('201 checked.');
      done();
    }));

    it('Repair all broken: shown on finished runs with broken harnesses; confirm names the cost', fakeAsync(() => {
      load({ status: 'completed', needsUpdateCount: 3, repairEstimateUsd: 0.84 });
      const repairAll = el.querySelector<HTMLButtonElement>('[data-testid="repair-all"]');
      expect(textWithoutIcons(repairAll)).toBe('Repair all broken');
      repairAll?.click();
      expect(confirm.confirm.calls.mostRecent().args[0].message).toBe(
        'Ask the AI to write new harnesses for 3 components? This uses AI credits, about $0.84.',
      );
      const req = httpMock.expectOne(`${BASE}/visualizations/7/repair-broken`);
      expect(req.request.method).toBe('POST');
      req.flush({ status: 202, data: repairJobView() }, { status: 202, statusText: 'Accepted' });
      expect(notifications.success.calls.allArgs()).toEqual([['Repair started.']]);
      done();
    }));

    it('Repair all broken without an estimate leaves the cost clause out', fakeAsync(() => {
      confirm.confirm.and.returnValue(of(false));
      load({ status: 'completed', needsUpdateCount: 1, repairEstimateUsd: null });
      el.querySelector<HTMLButtonElement>('[data-testid="repair-all"]')?.click();
      expect(confirm.confirm.calls.mostRecent().args[0].message).toBe(
        'Ask the AI to write new harnesses for 1 component? This uses AI credits.',
      );
      httpMock.expectNone(`${BASE}/visualizations/7/repair-broken`);
      done();
    }));

    it('while a repair runs the button is disabled with its progress', fakeAsync(() => {
      load({
        status: 'completed',
        needsUpdateCount: 2,
        activeRepairJob: repairJobView({ processedCount: 1, totalCount: 2 }),
      });
      const repairAll = el.querySelector<HTMLButtonElement>('[data-testid="repair-all"]');
      expect(repairAll?.disabled).toBeTrue();
      expect(textWithoutIcons(repairAll)).toBe('Repairing… 1 of 2');
      done();
    }));

    it('no Repair all broken while running or without broken harnesses', fakeAsync(() => {
      load({ status: 'rendering', needsUpdateCount: 2 });
      expect(el.querySelector('[data-testid="repair-all"]')).toBeNull();
      done();
    }));

    it('no Repair all broken on a clean finished run', fakeAsync(() => {
      load({ status: 'completed', needsUpdateCount: 0 });
      expect(el.querySelector('[data-testid="repair-all"]')).toBeNull();
      done();
    }));

    it('a card Repair starts the repair of that component', fakeAsync(() => {
      load(
        {
          status: 'completed',
          needsUpdateCount: 1,
          components: [
            componentView({
              id: 11,
              renderStatus: 'partial',
              headError: 'boom',
              harness: harnessView({ origin: 'library', needsUpdate: true }),
            }),
          ],
        },
        '7',
        'components',
      );
      el.querySelector<HTMLButtonElement>('app-component-card [data-testid="repair"]')?.click();
      fixture.detectChanges();
      expect(el.querySelector<HTMLButtonElement>('app-component-card [data-testid="repair"]')?.disabled).toBeTrue();
      const req = httpMock.expectOne(`${BASE}/visualizations/7/components/11/repair`);
      expect(req.request.method).toBe('POST');
      req.flush({ status: 202, data: repairJobView({ componentIds: [11] }) }, { status: 202, statusText: 'Accepted' });
      expect(notifications.success.calls.allArgs()).toEqual([['Repair started.']]);
      done();
    }));

    it('the pause asks how many new harnesses to write (16 E12)', fakeAsync(() => {
      confirm.confirm.and.returnValue(of(false));
      load({ status: 'awaiting_confirmation', componentCount: 40, newHarnessCount: 30, reusedHarnessCount: 10 });
      const popup = confirm.confirm.calls.mostRecent().args[0];
      expect(popup.title).toBe('30 new harnesses needed');
      expect(popup.confirmText).toBe('Write all 30');
      expect(popup.message).toContain(
        '10 components reuse saved harnesses. PRVision writes 12 new harnesses by default.',
      );
      const alert = el.querySelector('[data-testid="limit-choice"]');
      expect(alert?.textContent).toContain('30 new harnesses needed');
      expect(textWithoutIcons(el.querySelector('[data-testid="render-all"]'))).toBe('Write all 30');
      expect(textWithoutIcons(el.querySelector('[data-testid="render-top"]'))).toBe('Write top 12');
      expect(alert?.textContent).toContain('Cancel run');
      el.querySelector<HTMLButtonElement>('[data-testid="render-top"]')?.click();
      const req = httpMock.expectOne(`${BASE}/visualizations/7/continue`);
      expect(req.request.body).toEqual({ componentLimit: 12 });
      req.flush({ status: 202, data: { id: 7, componentLimit: 12, jobId: 'viz-7' } });
      done();
    }));

    it('more than 100 new harnesses offers the top 100', fakeAsync(() => {
      confirm.confirm.and.returnValue(of(false));
      load({ status: 'awaiting_confirmation', componentCount: 300, newHarnessCount: 240, reusedHarnessCount: 60 });
      expect(textWithoutIcons(el.querySelector('[data-testid="render-all"]'))).toBe('Write top 100');
      done();
    }));
  });

  describe('live mode (16j)', () => {
    const liveUrl = `${BASE}/visualizations/7/live`;
    const liveRow = componentView({ id: 11, harnessSource: 'export default definePrvisionHarness({ states: [] });' });
    function liveButton(): HTMLButtonElement | null {
      return el.querySelector<HTMLButtonElement>('app-component-card [data-testid="mode-live"]');
    }
    function startLive(): void {
      liveButton()?.click();
      fixture.detectChanges();
      el.querySelector<HTMLButtonElement>('[data-testid="live-start-button"]')?.click();
      fixture.detectChanges();
      httpMock
        .expectOne((r) => r.method === 'POST' && r.url === liveUrl)
        .flush(
          { status: 202, data: liveSession({ status: 'starting', readyAt: null }) },
          { status: 202, statusText: 'x' },
        );
      fixture.detectChanges();
    }

    it('Live is offered on cards of a run that can go live, for rows with a harness', fakeAsync(() => {
      load({ status: 'completed', liveAvailable: true, components: [liveRow] }, '7', 'components');
      expect(liveButton()?.disabled).toBeFalse();
      done();
    }));

    it('no Live when the run cannot go live or the row has no harness', fakeAsync(() => {
      load({ status: 'completed', liveAvailable: false, components: [liveRow] }, '7', 'components');
      expect(liveButton()?.disabled).toBeTrue();
      done();
    }));

    it('a row without a harness cannot go live', fakeAsync(() => {
      load(
        { status: 'completed', liveAvailable: true, components: [componentView({ harnessSource: null })] },
        '7',
        'components',
      );
      expect(liveButton()?.disabled).toBeTrue();
      done();
    }));

    it('leaving the run stops its live session (reason left)', fakeAsync(() => {
      load({ status: 'completed', liveAvailable: true, components: [liveRow] }, '7', 'components');
      startLive();
      expect(el.querySelector('[data-testid="live-starting"]')).not.toBeNull();
      fixture.destroy();
      const stops = httpMock.match(`${liveUrl}/stop`);
      expect(stops.length).toBe(1);
      expect(stops[0]?.request.body).toEqual({ reason: 'left' });
      httpMock.match(() => true);
      discardPeriodicTasks();
    }));

    it('leaving a run that never went live sends no stop', fakeAsync(() => {
      load({ status: 'completed', liveAvailable: true, components: [liveRow] }, '7', 'components');
      fixture.destroy();
      expect(httpMock.match(`${liveUrl}/stop`).length).toBe(0);
      httpMock.match(() => true);
      discardPeriodicTasks();
    }));

    it('switching to another run stops the live session of the previous one', fakeAsync(() => {
      load({ status: 'completed', liveAvailable: true, components: [liveRow] }, '7', 'components');
      startLive();
      fixture.componentRef.setInput('id', '8');
      fixture.detectChanges();
      tick(0);
      const stops = httpMock.match(`${liveUrl}/stop`);
      expect(stops.length).toBe(1);
      expect(stops[0]?.request.body).toEqual({ reason: 'left' });
      done();
    }));
  });
});
