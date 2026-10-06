import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { type Signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Router, provideRouter } from '@angular/router';
import { firstValueFrom, isObservable, of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { errorInterceptor } from '../../../core/interceptors/error.interceptor';
import { type VisualizationSummaryView } from '../../../core/models/visualization.model';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { type ActionMenuItem } from '../../../shared/components/data-grid/action-menu-cell-renderer.component';
import {
  type DataGridPage,
  type DataGridPageLoader,
  type DataGridPageRequest,
} from '../../../shared/components/data-grid/data-grid.component';
import { summaryView } from '../testing/visualization-fixtures';
import { VisualizationListComponent, renderComponentsCell } from './visualization-list.component';

const BASE = environment.apiBaseUrl;
const LIST_URL = `${BASE}/visualizations`;

/** Protected members the spec drives directly (the ag-grid wrapper is covered by sheet 12). */
interface ListInternals {
  pageLoader: DataGridPageLoader<VisualizationSummaryView>;
  refreshKey: Signal<string>;
  statusFilter: Signal<{ value: string; label: string }>;
  countLabel: Signal<string>;
  menuFor(row: VisualizationSummaryView): ActionMenuItem[];
  onAction(action: string, row: VisualizationSummaryView): void;
  setStatusFilter(value: string): void;
}

function request(page = 1, pageSize = 20): DataGridPageRequest {
  return { page, pageSize, startRow: (page - 1) * pageSize, endRow: page * pageSize, sortModel: [], filterModel: {} };
}

describe('VisualizationListComponent', () => {
  let fixture: ComponentFixture<VisualizationListComponent>;
  let el: HTMLElement;
  let list: ListInternals;
  let httpMock: HttpTestingController;
  let notifications: jasmine.SpyObj<NotificationService>;
  let confirm: jasmine.SpyObj<ConfirmDialogService>;
  let navigate: jasmine.Spy;

  beforeEach(async () => {
    notifications = jasmine.createSpyObj<NotificationService>('NotificationService', ['success', 'error', 'info']);
    confirm = jasmine.createSpyObj<ConfirmDialogService>('ConfirmDialogService', ['confirm']);
    confirm.confirm.and.returnValue(of(true));
    await TestBed.configureTestingModule({
      imports: [VisualizationListComponent],
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
    fixture = TestBed.createComponent(VisualizationListComponent);
    el = fixture.nativeElement as HTMLElement;
    list = fixture.componentInstance as unknown as ListInternals;
  });

  afterEach(() => {
    // The grid's own datasource requests are not under test here.
    for (const r of httpMock.match((req) => req.url === LIST_URL)) {
      if (!r.cancelled) r.flush({ status: 200, data: { items: [], page: 1, pageSize: 20, total: 0 } });
    }
    httpMock.verify({ ignoreCancelled: true });
  });

  function render(inputs: { status?: string; repositoryId?: string } = {}): void {
    if (inputs.status !== undefined) fixture.componentRef.setInput('status', inputs.status);
    if (inputs.repositoryId !== undefined) fixture.componentRef.setInput('repositoryId', inputs.repositoryId);
    fixture.detectChanges();
  }
  function load(req: DataGridPageRequest = request()): Promise<DataGridPage<VisualizationSummaryView>> {
    const result = list.pageLoader(req);
    if (!isObservable(result)) throw new Error('expected an Observable');
    return firstValueFrom(result);
  }
  it('renders header, toolbar and grid panel', () => {
    render();
    expect(el.querySelector('h1')?.textContent?.trim()).toBe('Visualizations');
    expect(el.textContent).toContain('Every pull request, branch, commit range and working-tree run, newest first.');
    expect(el.querySelector('.dd-ag-grid-panel app-data-grid')).not.toBeNull();
    expect(el.textContent).toContain('Status: All');
  });

  it('pageLoader sends page/pageSize', async () => {
    render();
    const pending = load(request(3, 50));
    const req = httpMock.match((r) => r.url === LIST_URL).at(-1);
    expect(req?.request.params.get('page')).toBe('3');
    expect(req?.request.params.get('pageSize')).toBe('50');
    expect(req?.request.params.has('status')).toBeFalse();
    req?.flush({ status: 200, data: { items: [summaryView()], page: 3, pageSize: 50, total: 128 } });
    const page = await pending;
    expect(page.total).toBe(128);
    expect(page.items.length).toBe(1);
    fixture.detectChanges();
    expect(list.countLabel()).toBe('128 visualizations');
  });

  it('in_progress filter sends seven statuses as one comma-separated param', async () => {
    render({ status: 'in_progress' });
    const pending = load();
    const req = httpMock.match((r) => r.url === LIST_URL).at(-1);
    expect(req?.request.params.getAll('status')).toEqual([
      'queued,preparing,analyzing,generating_harnesses,rendering,diffing,summarizing',
    ]);
    req?.flush({ status: 200, data: { items: [], page: 1, pageSize: 20, total: 0 } });
    await pending;
  });

  it('?status=failed selects Failed', () => {
    render({ status: 'failed' });
    expect(list.statusFilter().value).toBe('failed');
    expect(el.textContent).toContain('Status: Failed');
  });

  it('unknown status → All', () => {
    render({ status: 'bogus' });
    expect(list.statusFilter().value).toBe('all');
  });

  it('status menu navigates with merged query params', () => {
    render();
    list.setStatusFilter('cancelled');
    expect(navigate.calls.mostRecent().args[1]).toEqual(
      jasmine.objectContaining({ queryParams: { status: 'cancelled' }, queryParamsHandling: 'merge' }),
    );
    list.setStatusFilter('all');
    expect(navigate.calls.mostRecent().args[1]).toEqual(jasmine.objectContaining({ queryParams: { status: null } }));
  });

  it('repositoryId chip and clear', async () => {
    render({ repositoryId: '1' });
    httpMock.expectOne(`${BASE}/repositories/1`).flush({ status: 200, data: { id: 1, name: 'sample-react-app' } });
    fixture.detectChanges();
    const chip = el.querySelector('[data-testid="repo-chip"]');
    expect(chip?.textContent).toContain('Repository: sample-react-app');
    const pending = load();
    const req = httpMock.match((r) => r.url === LIST_URL).at(-1);
    expect(req?.request.params.get('repositoryId')).toBe('1');
    req?.flush({ status: 200, data: { items: [], page: 1, pageSize: 20, total: 0 } });
    await pending;
    el.querySelector<HTMLButtonElement>('[aria-label="Clear repository filter"]')!.click();
    expect(navigate.calls.mostRecent().args[1]).toEqual(
      jasmine.objectContaining({ queryParams: { repositoryId: null }, queryParamsHandling: 'merge' }),
    );
  });

  it('repository name falls back to #id when the lookup fails', () => {
    render({ repositoryId: '4' });
    httpMock
      .expectOne(`${BASE}/repositories/4`)
      .flush({ status: 404, error: 'nope', error_reason: 'not_found' }, { status: 404, statusText: 'x' });
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="repo-chip"]')?.textContent).toContain('Repository: #4');
    expect(notifications.error.calls.count()).toBe(0);
  });

  it('filter change updates refreshKey', () => {
    render();
    const first = list.refreshKey();
    render({ status: 'completed' });
    expect(list.refreshKey()).not.toBe(first);
    const second = list.refreshKey();
    el.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')!.click();
    expect(list.refreshKey()).not.toBe(second);
  });

  it('delete only offered for terminal rows', () => {
    render();
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      expect(list.menuFor(summaryView({ status })).map((i) => i.action)).toEqual(['open', 'delete']);
    }
  });

  it('cancel only for non-terminal', () => {
    render();
    for (const status of ['queued', 'rendering', 'summarizing'] as const) {
      expect(list.menuFor(summaryView({ status })).map((i) => i.action)).toEqual(['open', 'cancel']);
    }
  });

  it('components cell: changed of total when completed, found otherwise', () => {
    expect(renderComponentsCell(summaryView({ status: 'completed', changedCount: 5, componentCount: 12 }))).toContain(
      '5 changed',
    );
    expect(renderComponentsCell(summaryView({ status: 'rendering', componentCount: 12 }))).toContain('12 found');
    expect(renderComponentsCell(summaryView({ status: 'rendering', componentCount: 0 }))).toContain('—');
  });

  describe('cancel outcomes', () => {
    const row = summaryView({ id: 9, status: 'rendering' });
    const cancelUrl = `${BASE}/visualizations/9/cancel`;

    it('cancel 200 cancelled → "Visualization cancelled." toast', () => {
      render();
      const key = list.refreshKey();
      list.onAction('cancel', row);
      httpMock.expectOne(cancelUrl).flush({ status: 200, data: { id: 9, status: 'cancelled' } });
      expect(notifications.info.calls.allArgs()).toEqual([['Visualization cancelled.']]);
      expect(list.refreshKey()).not.toBe(key);
    });

    it('cancel 202 → "Cancellation requested" toast', () => {
      render();
      list.onAction('cancel', row);
      httpMock
        .expectOne(cancelUrl)
        .flush({ status: 202, data: { id: 9, status: 'cancel_requested' } }, { status: 202, statusText: 'x' });
      expect(notifications.info.calls.allArgs()).toEqual([
        ['Cancellation requested. The pipeline stops at its next checkpoint.'],
      ]);
    });

    it('cancel 409 → "already finished" toast', () => {
      render();
      list.onAction('cancel', row);
      httpMock
        .expectOne(cancelUrl)
        .flush({ status: 409, error: 'done', error_reason: 'already_terminal' }, { status: 409, statusText: 'x' });
      expect(notifications.info.calls.allArgs()).toEqual([['This visualization had already finished.']]);
    });

    it('exactly one toast per cancel outcome', () => {
      render();
      list.onAction('cancel', row);
      httpMock
        .expectOne(cancelUrl)
        .flush(
          { status: 500, error: 'Redis is down', error_reason: 'internal_error' },
          { status: 500, statusText: 'x' },
        );
      const toasts =
        notifications.info.calls.count() + notifications.error.calls.count() + notifications.success.calls.count();
      expect(toasts).toBe(1);
      expect(notifications.error.calls.count()).toBe(1);
    });

    it('declined confirm sends nothing', () => {
      confirm.confirm.and.returnValue(of(false));
      render();
      list.onAction('cancel', row);
      httpMock.expectNone(cancelUrl);
      expect(confirm.confirm.calls.count()).toBe(1);
    });
  });

  it('delete confirms, deletes, toasts once and refreshes', () => {
    render();
    const key = list.refreshKey();
    list.onAction('delete', summaryView({ id: 4, status: 'failed', title: 'Fix cart' }));
    expect(confirm.confirm.calls.mostRecent().args[0].message).toContain('"Fix cart"');
    httpMock
      .expectOne((r) => r.method === 'DELETE' && r.url === `${BASE}/visualizations/4`)
      .flush({ status: 200, data: { id: 4 } });
    expect(notifications.success.calls.allArgs()).toEqual([['Visualization deleted']]);
    expect(list.refreshKey()).not.toBe(key);
  });

  it('open navigates to the detail', () => {
    render();
    list.onAction('open', summaryView({ id: 12 }));
    expect(navigate.calls.mostRecent().args[0]).toEqual(['/visualizations', 12]);
  });
});
