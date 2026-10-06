import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatMenuModule } from '@angular/material/menu';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router } from '@angular/router';
import {
  type CellClickedEvent,
  type ColDef,
  type ICellRendererParams,
  type RowClassRules,
  type RowClickedEvent,
} from 'ag-grid-community';
import { Subject, catchError, exhaustMap, filter, map, of, switchMap, tap } from 'rxjs';
import { DEFAULT_PAGE_SIZE, PAGE_SIZE_OPTIONS } from '../../../core/constants/pagination.constants';
import { toApiError } from '../../../core/models/api-error.model';
import { type VisualizationStatus } from '../../../core/models/domain-enums.model';
import {
  type VisualizationCreateRequest,
  type VisualizationSummaryView,
} from '../../../core/models/visualization.model';
import { ApiService } from '../../../core/services/api.service';
import { ConfirmDialogService } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { VisualizationLauncherService } from '../../../core/services/visualization-launcher.service';
import { userMessageFor } from '../../../core/utils/error-messages.util';
import { refsLabel, sourceLabel } from '../../../core/utils/labels.util';
import { parseRouteId } from '../../../core/utils/route-params.util';
import { isTerminalStatus } from '../../../core/utils/visualization-status.util';
import {
  type ActionMenuCellRendererParams,
  ActionMenuCellRendererComponent,
  type ActionMenuItem,
} from '../../../shared/components/data-grid/action-menu-cell-renderer.component';
import { type DataGridPageLoader, DataGridComponent } from '../../../shared/components/data-grid/data-grid.component';
import {
  escapeHtml,
  extractGridAction,
  formatDateTime,
  formatRelativeTime,
  isGridActionTarget,
  renderActionButton,
  renderMonospace,
  renderMutedText,
  renderStackedText,
  renderStatusPillHtml,
} from '../../../shared/components/data-grid/data-grid-helpers';
import { PageHeaderComponent } from '../../../shared/components/page-header/page-header.component';
import { resolvePill } from '../../../shared/components/status-pill/status-pill.config';

type StatusFilter = 'all' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

interface StatusFilterOption {
  value: StatusFilter;
  label: string;
  statuses?: readonly VisualizationStatus[];
}

const IN_PROGRESS: readonly VisualizationStatus[] = [
  'queued',
  'preparing',
  'analyzing',
  'awaiting_confirmation',
  'generating_harnesses',
  'rendering',
  'diffing',
  'summarizing',
];
const ALL_FILTER: StatusFilterOption = { value: 'all', label: 'All' };
const STATUS_FILTERS: readonly StatusFilterOption[] = [
  ALL_FILTER,
  { value: 'in_progress', label: 'In progress', statuses: IN_PROGRESS },
  { value: 'completed', label: 'Completed', statuses: ['completed'] },
  { value: 'failed', label: 'Failed', statuses: ['failed'] },
  { value: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];

type Cell = ICellRendererParams<VisualizationSummaryView>;

/**
 * Source pill (the `source` status-pill tone with `sourceLabel`), left-aligned and ellipsized so long branch labels
 * stay inside the cell; the full label is in the title.
 */
export function renderSourceCell(v: VisualizationSummaryView): string {
  const label = escapeHtml(sourceLabel(v));
  const tone = resolvePill('source', v.sourceType).tone;
  return `<span class="dd-pill dd-pill--${tone} !justify-start" title="${label}"><span class="min-w-0 truncate">${label}</span></span>`;
}

/** Components column: "5 changed / of 12" when completed, otherwise "12 found", or "—" with none. */
export function renderComponentsCell(v: VisualizationSummaryView): string {
  if (v.status === 'completed') return renderStackedText(`${v.changedCount} changed`, `of ${v.componentCount}`);
  return v.componentCount > 0 ? renderMutedText(`${v.componentCount} found`) : renderMutedText('—');
}

/** `/visualizations`: server-paged history with status and repository filters (13 §5.8). */
@Component({
  selector: 'app-visualization-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatIconModule, MatMenuModule, MatTooltipModule, PageHeaderComponent, DataGridComponent],
  templateUrl: './visualization-list.component.html',
  host: { class: 'flex min-h-0 flex-1 flex-col gap-4 overflow-hidden' },
})
export class VisualizationListComponent {
  /** Query params; undefined when absent (withComponentInputBinding). */
  readonly status = input<string>();
  readonly repositoryId = input<string>();
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly launcher = inject(VisualizationLauncherService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statusFilters = STATUS_FILTERS;
  protected readonly statusFilter = computed<StatusFilterOption>(
    () => STATUS_FILTERS.find((f) => f.value === this.status()) ?? ALL_FILTER,
  );
  protected readonly statusFilterLabel = computed(() => `Status: ${this.statusFilter().label}`);
  protected readonly repoFilter = computed(() => parseRouteId(this.repositoryId()));
  /** From api.getRepository(id), silent; falls back to "#<id>". */
  protected readonly repoFilterName = signal<string | null>(null);
  protected readonly repoChipLabel = computed(() => {
    const id = this.repoFilter();
    return id === null ? '' : `Repository: ${this.repoFilterName() ?? `#${id}`}`;
  });
  protected readonly hasFilters = computed(() => this.statusFilter().value !== 'all' || this.repoFilter() !== null);
  protected readonly total = signal<number | null>(null);
  protected readonly countLabel = computed(() => {
    const t = this.total();
    return t === null ? '… visualizations' : `${t} visualization${t === 1 ? '' : 's'}`;
  });
  protected readonly emptyTitle = computed(() =>
    this.hasFilters() ? 'Nothing matches these filters' : 'No visualizations yet',
  );
  protected readonly emptyMessage = computed(() =>
    this.hasFilters()
      ? 'Clear the filters to see every visualization.'
      : 'Open a repository and visualize a pull request, branch or the working tree.',
  );
  private readonly manualRefresh = signal(0);
  protected readonly refreshKey = computed(
    () => `${this.statusFilter().value}|${this.repoFilter() ?? ''}|${this.manualRefresh()}`,
  );
  protected readonly defaultColDef: ColDef = { sortable: false };
  protected readonly pageSize = DEFAULT_PAGE_SIZE;
  protected readonly pageSizeOptions = PAGE_SIZE_OPTIONS;
  protected readonly rowClassRules: RowClassRules<VisualizationSummaryView> = { 'dd-grid-row-clickable': () => true };

  protected readonly pageLoader: DataGridPageLoader<VisualizationSummaryView> = (req) =>
    this.api
      .listVisualizations({
        page: req.page,
        pageSize: req.pageSize,
        statuses: this.statusFilter().statuses,
        repositoryId: this.repoFilter() ?? undefined,
      })
      .pipe(
        tap((p) => {
          this.total.set(p.total);
        }),
        map((p) => ({ items: p.items, total: p.total })),
      );

  protected readonly columns: ColDef<VisualizationSummaryView>[] = [
    {
      headerName: 'View',
      colId: 'open',
      width: 88,
      cellRenderer: () => renderActionButton('open', 'Open', 'primary'),
    },
    {
      headerName: 'Visualization',
      colId: 'title',
      flex: 1.6,
      minWidth: 170,
      cellRenderer: (p: Cell) => (p.data ? renderStackedText(p.data.title, p.data.repositoryName) : ''),
    },
    {
      headerName: 'Source',
      colId: 'sourceType',
      flex: 1,
      minWidth: 200,
      cellRenderer: (p: Cell) => (p.data ? renderSourceCell(p.data) : ''),
    },
    {
      headerName: 'Refs',
      colId: 'refs',
      flex: 1,
      minWidth: 150,
      cellRenderer: (p: Cell) => (p.data ? renderMonospace(refsLabel(p.data)) : ''),
    },
    {
      headerName: 'Status',
      colId: 'status',
      width: 125,
      cellRenderer: (p: Cell) => (p.data ? renderStatusPillHtml('visualization', p.data.status) : ''),
    },
    {
      headerName: 'Components',
      colId: 'components',
      width: 115,
      cellRenderer: (p: Cell) => (p.data ? renderComponentsCell(p.data) : ''),
    },
    {
      headerName: 'Created',
      colId: 'createdAt',
      width: 165,
      cellRenderer: (p: Cell) =>
        p.data ? renderStackedText(formatDateTime(p.data.createdAt), formatRelativeTime(p.data.createdAt)) : '',
    },
    {
      headerName: '',
      colId: 'menu',
      width: 56,
      cellRenderer: ActionMenuCellRendererComponent,
      cellRendererParams: {
        actions: (row: unknown): ActionMenuItem[] => (row ? this.menuFor(row as VisualizationSummaryView) : []),
        onAction: (action: string, row: unknown) => {
          this.onAction(action, row as VisualizationSummaryView);
        },
      } satisfies Partial<ActionMenuCellRendererParams>,
    },
  ];

  private readonly repoName$ = new Subject<number | null>();

  constructor() {
    // switchMap: changing ?repositoryId= cancels a stale name lookup.
    this.repoName$
      .pipe(
        tap(() => {
          this.repoFilterName.set(null);
        }),
        switchMap((id) =>
          id === null
            ? of(null)
            : this.api.getRepository(id).pipe(
                map((r) => r.name),
                catchError(() => of(null)),
              ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((name) => {
        this.repoFilterName.set(name);
      });
    effect(() => {
      const id = this.repoFilter();
      untracked(() => {
        this.repoName$.next(id);
      });
    });
  }

  protected setStatusFilter(value: StatusFilter): void {
    void this.router.navigate([], {
      queryParams: { status: value === 'all' ? null : value },
      queryParamsHandling: 'merge',
    });
  }

  protected clearRepoFilter(): void {
    void this.router.navigate([], { queryParams: { repositoryId: null }, queryParamsHandling: 'merge' });
  }

  protected refresh(): void {
    this.manualRefresh.update((n) => n + 1);
  }

  protected onCellClicked(event: CellClickedEvent): void {
    const row = event.data as VisualizationSummaryView | undefined;
    if (row && extractGridAction(event.event ?? null) === 'open') this.open(row);
  }

  protected onRowClicked(event: RowClickedEvent): void {
    const row = event.data as VisualizationSummaryView | undefined;
    if (!row || isGridActionTarget(event.event ?? null)) return;
    this.open(row);
  }

  /** Items follow the row's status: Cancel only while running, Delete only once terminal. */
  protected menuFor(row: VisualizationSummaryView): ActionMenuItem[] {
    const items: ActionMenuItem[] = [{ action: 'open', label: 'Open', icon: 'open_in_new' }];
    if (isTerminalStatus(row.status) && rerunRequest(row) !== null) {
      items.push({ action: 'rerun', label: 'Re-visualize', icon: 'replay' });
    }
    if (isTerminalStatus(row.status)) items.push({ action: 'delete', label: 'Delete', icon: 'delete', tone: 'danger' });
    else items.push({ action: 'cancel', label: 'Cancel', icon: 'stop_circle' });
    return items;
  }

  protected onAction(action: string, row: VisualizationSummaryView): void {
    if (action === 'open') this.open(row);
    else if (action === 'rerun') this.rerun(row);
    else if (action === 'cancel') this.cancel(row);
    else if (action === 'delete') this.remove(row);
  }

  /** Starts a new visualization of the same source (a working tree is captured again as it is now). */
  private rerun(row: VisualizationSummaryView): void {
    const request = rerunRequest(row);
    if (request === null) return;
    this.launcher.launch(request, row.title).pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  private open(row: VisualizationSummaryView): void {
    void this.router.navigate(['/visualizations', row.id]);
  }

  private cancel(row: VisualizationSummaryView): void {
    this.confirm
      .confirm({
        title: 'Cancel this visualization?',
        message: 'The pipeline stops at its next checkpoint. Components that already finished keep their results.',
        confirmText: 'Cancel visualization',
        cancelText: 'Keep running',
        confirmColor: 'warn',
      })
      .pipe(
        filter(Boolean),
        // silent call: this handler is the only place its outcome is toasted
        exhaustMap(() => this.api.cancelVisualization(row.id)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (res) => {
          this.notifications.info(
            res.status === 'cancelled'
              ? 'Visualization cancelled.'
              : 'Cancellation requested. The pipeline stops at its next checkpoint.',
          );
          this.refresh();
        },
        error: (e: unknown) => {
          const error = toApiError(e);
          if (error.is('already_terminal')) {
            this.notifications.info('This visualization had already finished.');
            this.refresh();
          } else {
            this.notifications.error(userMessageFor(error));
          }
        },
      });
  }

  private remove(row: VisualizationSummaryView): void {
    this.confirm
      .confirm({
        title: 'Delete visualization?',
        message: `Screenshots, diffs and the summary for "${row.title}" will be deleted. This cannot be undone.`,
        confirmText: 'Delete',
        confirmColor: 'warn',
      })
      .pipe(
        filter(Boolean),
        // not silent: errors, including 409 conflict for a run that is still active, are toasted by the interceptor
        exhaustMap(() => this.api.removeVisualization(row.id)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.notifications.success('Visualization deleted');
          this.refresh();
        },
        error: () => undefined,
      });
  }
}

/** The create request that repeats a visualization's source; null when the row lacks what the source needs. */
export function rerunRequest(row: VisualizationSummaryView): VisualizationCreateRequest | null {
  const repositoryId = row.repositoryId;
  switch (row.sourceType) {
    case 'github_pr':
      return row.prNumber === null ? null : { repositoryId, sourceType: 'github_pr', prNumber: row.prNumber };
    case 'local_branch':
      return { repositoryId, sourceType: 'local_branch', headRef: row.headRef, baseRef: row.baseRef };
    case 'working_tree':
      return { repositoryId, sourceType: 'working_tree' };
    case 'commit_range':
      return row.baseSha === null || row.headSha === null
        ? null
        : {
            repositoryId,
            sourceType: 'commit_range',
            headRef: row.headRef,
            baseSha: row.baseSha,
            headSha: row.headSha,
          };
  }
}
