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
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { Router } from '@angular/router';
import {
  type CellClickedEvent,
  type ColDef,
  type GetRowIdParams,
  type GridApi,
  type GridReadyEvent,
  type ICellRendererParams,
  type RowClickedEvent,
  type RowClassRules,
} from 'ag-grid-community';
import { exhaustMap, filter, finalize } from 'rxjs';
import { type ApiError } from '../../../core/models/api-error.model';
import { type RepositoryView } from '../../../core/models/repository.model';
import { ApiService } from '../../../core/services/api.service';
import { ConfirmDialogService, GENERIC_POPUP_DIALOG_CONFIG } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { errorCopyFor } from '../../../core/utils/error-messages.util';
import {
  type ActionMenuCellRendererParams,
  ActionMenuCellRendererComponent,
  type ActionMenuItem,
} from '../../../shared/components/data-grid/action-menu-cell-renderer.component';
import { DataGridComponent } from '../../../shared/components/data-grid/data-grid.component';
import {
  extractGridAction,
  formatDateOnly,
  formatRelativeTime,
  isGridActionTarget,
  renderActionButton,
  renderMonospace,
  renderMutedText,
  renderStackedText,
} from '../../../shared/components/data-grid/data-grid-helpers';
import { InlineAlertComponent } from '../../../shared/components/inline-alert/inline-alert.component';
import { PageHeaderComponent } from '../../../shared/components/page-header/page-header.component';
import {
  AddRepositoryDialogComponent,
  type AddRepositoryDialogResult,
} from '../components/add-repository-dialog/add-repository-dialog.component';
import { frameworkLabel, githubSlug } from '../repository-format';

type Cell = ICellRendererParams<RepositoryView>;

/** `/repositories`: grid of registered clones, add dialog, re-detect and remove (13 §5.5). */
@Component({
  selector: 'app-repository-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    PageHeaderComponent,
    InlineAlertComponent,
    DataGridComponent,
  ],
  templateUrl: './repository-list.component.html',
  host: { class: 'flex min-h-0 flex-1 flex-col gap-4 overflow-hidden' },
})
export class RepositoryListComponent {
  /** `?add=1` opens the add dialog once after the first load. */
  readonly add = input<string>();
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly repositories = signal<RepositoryView[]>([]);
  protected readonly busyIds = signal<ReadonlySet<number>>(new Set());
  protected readonly countLabel = computed(() => {
    const n = this.repositories().length;
    return n === 1 ? '1 repository' : `${String(n)} repositories`;
  });
  protected readonly loadErrorMessage = computed(() => {
    const e = this.loadError();
    return e ? errorCopyFor(e).message : '';
  });
  protected readonly showFirstRun = computed(
    () => !this.loading() && !this.loadError() && this.repositories().length === 0,
  );

  protected readonly rowId = (p: GetRowIdParams<RepositoryView>): string => String(p.data.id);
  protected readonly rowClassRules: RowClassRules<RepositoryView> = { 'dd-grid-row-clickable': () => true };
  protected readonly defaultColDef: ColDef<RepositoryView> = { sortable: false };
  protected readonly columns: ColDef<RepositoryView>[] = [
    {
      headerName: 'View',
      colId: 'open',
      width: 96,
      cellRenderer: () => renderActionButton('open', 'Open', 'primary'),
    },
    {
      headerName: 'Repository',
      colId: 'name',
      field: 'name',
      flex: 1.6,
      minWidth: 220,
      sortable: true,
      sort: 'asc',
      // An app inside the clone (15 §5.4.7) shows its folder: <clone>/<appRoot>.
      cellRenderer: (p: Cell) =>
        p.data
          ? renderStackedText(
              p.data.name,
              p.data.appRoot === '.' ? p.data.localPath : `${p.data.localPath}/${p.data.appRoot}`,
            )
          : '',
    },
    {
      headerName: 'Framework',
      colId: 'framework',
      width: 170,
      // Angular apps also name their angular.json project (15 §5.9.1).
      cellRenderer: (p: Cell) =>
        p.data
          ? p.data.framework === 'angular' && p.data.angularProject
            ? renderStackedText(frameworkLabel(p.data.framework), `project ${p.data.angularProject}`)
            : renderStackedText(frameworkLabel(p.data.framework))
          : '',
    },
    {
      headerName: 'GitHub',
      colId: 'github',
      flex: 1,
      minWidth: 160,
      cellRenderer: (p: Cell): string => {
        const slug = p.data ? githubSlug(p.data) : null;
        return slug ? renderMonospace(slug) : renderMutedText('No GitHub remote');
      },
    },
    {
      headerName: 'Default branch',
      colId: 'defaultBranch',
      width: 160,
      cellRenderer: (p: Cell) => renderMonospace(p.data?.defaultBranch),
    },
    {
      headerName: 'Package manager',
      colId: 'packageManager',
      width: 150,
      // Raw value: renderPill would title-case "pnpm".
      cellRenderer: (p: Cell) => renderMonospace(p.data?.packageManager),
    },
    {
      headerName: 'Last detected',
      colId: 'lastDetectedAt',
      field: 'lastDetectedAt',
      width: 170,
      sortable: true,
      cellRenderer: (p: Cell) =>
        p.data
          ? renderStackedText(formatDateOnly(p.data.lastDetectedAt), formatRelativeTime(p.data.lastDetectedAt))
          : '',
    },
    {
      headerName: '',
      colId: 'menu',
      width: 64,
      cellRenderer: ActionMenuCellRendererComponent,
      cellRendererParams: {
        actions: (row: unknown): ActionMenuItem[] => this.menuFor(row as RepositoryView),
        onAction: (action: string, row: unknown) => {
          this.onAction(action, row as RepositoryView);
        },
      } satisfies Partial<ActionMenuCellRendererParams>,
    },
  ];

  private gridApi: GridApi<RepositoryView> | null = null;
  private addHandled = false;

  constructor() {
    this.load();
    // `?add=1` opens the dialog once, after the first load has finished (inputs are set by then).
    effect(() => {
      if (this.loading() || this.loadError() || this.add() !== '1') return;
      untracked(() => {
        this.openAddFromQueryOnce();
      });
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .listRepositories()
      .pipe(
        finalize(() => {
          this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (repos) => {
          this.repositories.set(repos);
        },
        error: (e: ApiError) => {
          this.loadError.set(e);
        },
      });
  }

  protected onGridReady(event: GridReadyEvent): void {
    this.gridApi = event.api as GridApi<RepositoryView>;
  }

  protected onCellClicked(event: CellClickedEvent): void {
    const row = event.data as RepositoryView | undefined;
    if (row && extractGridAction(event.event ?? null) === 'open') this.open(row);
  }

  protected onRowClicked(event: RowClickedEvent): void {
    const row = event.data as RepositoryView | undefined;
    if (!row || isGridActionTarget(event.event ?? null)) return;
    this.open(row);
  }

  protected openAddDialog(): void {
    this.dialog
      .open<AddRepositoryDialogComponent, undefined, AddRepositoryDialogResult>(
        AddRepositoryDialogComponent,
        GENERIC_POPUP_DIALOG_CONFIG,
      )
      .afterClosed()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (!result) return;
        for (const repo of result.created) this.upsert(repo);
        if (result.openId !== null) void this.router.navigate(['/repositories', result.openId]);
      });
  }

  private openAddFromQueryOnce(): void {
    if (this.addHandled) return;
    this.addHandled = true;
    this.openAddDialog();
  }

  private menuFor(row: RepositoryView): ActionMenuItem[] {
    const busy = this.busyIds().has(row.id);
    return [
      { action: 'open', label: 'Open', icon: 'open_in_new' },
      { action: 'redetect', label: 'Re-detect', icon: 'refresh', disabled: busy },
      { action: 'remove', label: 'Remove', icon: 'delete', tone: 'danger', disabled: busy },
    ];
  }

  private onAction(action: string, row: RepositoryView): void {
    if (action === 'open') this.open(row);
    else if (action === 'redetect') this.redetect(row);
    else if (action === 'remove') this.remove(row);
  }

  private open(row: RepositoryView): void {
    void this.router.navigate(['/repositories', row.id]);
  }

  private redetect(row: RepositoryView): void {
    if (this.busyIds().has(row.id)) return;
    this.setBusy(row.id, true);
    this.api
      .redetectRepository(row.id) // not silent: the interceptor toasts errors such as missing_node_modules
      .pipe(
        finalize(() => {
          this.setBusy(row.id, false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (repo) => {
          this.upsert(repo);
          this.notifications.success(`Re-detected ${repo.name}`);
        },
        error: () => undefined,
      });
  }

  private remove(row: RepositoryView): void {
    if (this.busyIds().has(row.id)) return;
    this.confirm
      .confirm({
        title: 'Remove repository?',
        message: `PRVision will forget "${row.name}". Your local clone is not touched.`,
        confirmText: 'Remove repository',
        confirmColor: 'warn',
      })
      .pipe(
        filter(Boolean),
        exhaustMap(() => {
          this.setBusy(row.id, true);
          // not silent: a 409 conflict (run in progress) is toasted by the interceptor with the server message
          return this.api.removeRepository(row.id).pipe(
            finalize(() => {
              this.setBusy(row.id, false);
            }),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.repositories.update((list) => list.filter((r) => r.id !== row.id));
          this.notifications.success('Repository removed');
        },
        error: () => undefined,
      });
  }

  private upsert(repo: RepositoryView): void {
    this.repositories.update((list) =>
      list.some((r) => r.id === repo.id) ? list.map((r) => (r.id === repo.id ? repo : r)) : [...list, repo],
    );
  }

  private setBusy(id: number, busy: boolean): void {
    this.busyIds.update((ids) => {
      const next = new Set(ids);
      if (busy) next.add(id);
      else next.delete(id);
      return next;
    });
    // The menu items read busyIds when rendered; refresh them so Re-detect/Remove disable while busy.
    this.gridApi?.refreshCells({ columns: ['menu'], force: true });
  }
}
