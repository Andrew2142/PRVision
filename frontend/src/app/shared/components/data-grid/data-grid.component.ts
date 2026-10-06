/* eslint-disable @angular-eslint/prefer-signals -- ag-grid wrapper driven by ngOnChanges; sheet 12 §6.16.5 */
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  Input,
  NgZone,
  type OnChanges,
  type OnDestroy,
  Output,
  type SimpleChanges,
  ViewChild,
  inject,
} from '@angular/core';
import { type Observable, Subscription, isObservable } from 'rxjs';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  type CellClickedEvent,
  type ColDef,
  type GridApi,
  type GridOptions,
  type GridReadyEvent,
  type IDatasource,
  type IGetRowsParams,
  ModuleRegistry,
  type PaginationChangedEvent,
  type RowClickedEvent,
  type RowModelType,
} from 'ag-grid-community';
import { EmptyStateComponent, formatEmptyStateMessage } from '../empty-state/empty-state.component';
import { LoadingSpinnerComponent } from '../loading-spinner/loading-spinner.component';

ModuleRegistry.registerModules([AllCommunityModule]);

export interface DataGridPageRequest {
  page: number;
  pageSize: number;
  startRow: number;
  endRow: number;
  search?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  sortModel: IGetRowsParams['sortModel'];
  /** ag-grid types this as `any`; narrowed to unknown so callers must check it. */
  filterModel: unknown;
}

export interface DataGridPage<T = unknown> {
  items: T[];
  total: number;
}

export type DataGridPageLoader<T = unknown> = (
  request: DataGridPageRequest,
) => Observable<DataGridPage<T>> | Promise<DataGridPage<T>>;

/**
 * Uply's ag-grid wrapper (client or server paging, search toolbar, loading and empty states).
 * Documented exception to the signal-input rule: ag-grid is driven imperatively from change records.
 */
@Component({
  selector: 'app-data-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AgGridAngular, EmptyStateComponent, LoadingSpinnerComponent],
  template: `
    <div
      class="dd-ag-grid-shell w-full h-full"
      [class.dd-ag-grid-shell--empty]="!loading && !serverPagination && !rowData.length"
    >
      @if (loading) {
        <div class="dd-ag-grid-placeholder w-full h-full">
          <app-loading-spinner />
        </div>
      } @else {
        @if (searchEnabled) {
          <div class="dd-grid-search-toolbar">
            <label class="dd-grid-search-field">
              <span class="dd-grid-search-label">Search</span>
              <input
                class="dd-grid-search-input"
                type="search"
                [attr.placeholder]="searchPlaceholder"
                [value]="searchText"
                (input)="handleSearchInput($event)"
              />
            </label>
          </div>
        }

        @if (!serverPagination && !rowData.length) {
          <div class="dd-ag-grid-placeholder w-full">
            <app-empty-state [icon]="emptyIcon" [title]="emptyTitle" [message]="emptyMessage" />
          </div>
        } @else {
          <div class="dd-ag-grid-frame relative w-full h-full">
            <ag-grid-angular
              class="ag-theme-quartz dd-ag-grid-theme w-full h-full"
              [class.pointer-events-none]="serverLoading"
              [attr.aria-busy]="serverLoading"
              theme="legacy"
              [rowModelType]="resolvedRowModelType"
              [rowData]="serverPagination ? undefined : rowData"
              [columnDefs]="resolvedColumnDefs"
              [defaultColDef]="resolvedDefaultColDef"
              [gridOptions]="resolvedGridOptions"
              [rowHeight]="rowHeight"
              [pagination]="pagination"
              [paginationPageSize]="activePageSize"
              [paginationPageSizeSelector]="pageSizeOptions"
              [animateRows]="true"
              [suppressCellFocus]="true"
              [enableCellTextSelection]="true"
              [suppressDragLeaveHidesColumns]="true"
              [getRowId]="getRowId"
              [getRowHeight]="getRowHeight"
              [rowClassRules]="rowClassRules"
              [localeText]="resolvedLocaleText"
              (gridReady)="handleGridReady($event)"
              (paginationChanged)="handlePaginationChanged($event)"
              (sortChanged)="handleSortChanged()"
              (cellClicked)="cellClicked.emit($event)"
              (rowClicked)="rowClicked.emit($event)"
            />
            @if (serverLoading) {
              <div
                class="dd-ag-grid-loading-overlay absolute inset-0 z-10 flex h-full w-full items-center justify-center"
              >
                <app-loading-spinner />
              </div>
            }
          </div>
        }
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
      width: 100%;
      height: 100%;
    }

    .dd-ag-grid-shell {
      display: flex;
      min-height: 0;
      flex-direction: column;
    }

    .dd-ag-grid-frame {
      flex: 1 1 auto;
      min-height: 0;
    }

    .dd-ag-grid-loading-overlay {
      background: var(--color-bg-secondary, #ffffff);
    }

    .dd-grid-search-toolbar {
      flex: 0 0 auto;
      padding: 0.75rem 0.875rem 0.625rem;
    }

    .dd-grid-search-field {
      display: block;
      width: min(100%, 24rem);
    }

    .dd-grid-search-label {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
    }

    .dd-grid-search-input {
      width: 100%;
      min-height: 2.5rem;
      border: 1px solid var(--color-border, #cbd5e1);
      border-radius: 0.75rem;
      background: var(--color-bg-secondary, #ffffff);
      color: var(--color-text-primary, #0f172a);
      font: inherit;
      font-size: 0.875rem;
      outline: none;
      padding: 0.625rem 0.875rem;
    }

    .dd-grid-search-input:focus {
      border-color: #64748b;
      box-shadow: 0 0 0 3px rgb(100 116 139 / 0.12);
    }

    @media (max-width: 640px) {
      .dd-grid-search-field {
        width: 100%;
      }
    }
  `,
})
export class DataGridComponent implements OnChanges, OnDestroy {
  @ViewChild(AgGridAngular) private grid?: AgGridAngular;
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly zone = inject(NgZone);

  @Input() rowData: unknown[] = [];
  @Input() columnDefs: ColDef[] = [];
  @Input() defaultColDef: ColDef = {};
  @Input() gridOptions: GridOptions = {};
  @Input() loading = false;
  @Input() emptyIcon = 'table_rows';
  @Input() emptyTitle = 'No rows';
  @Input() emptyMessage = 'There is nothing to show yet.';
  @Input() rowHeight = 56;
  @Input() pagination = true;
  @Input() pageSize = 25;
  @Input() pageSizeOptions: number[] | boolean = [25, 50, 100];
  @Input() serverPagination = false;
  @Input() serverPageLoader?: DataGridPageLoader;
  @Input() serverRefreshKey: unknown;
  @Input() getRowId?: GridOptions['getRowId'];
  @Input() getRowHeight?: GridOptions['getRowHeight'];
  @Input() rowClassRules?: GridOptions['rowClassRules'];
  @Input() localeText: Record<string, string> = {};
  @Input() searchEnabled = true;
  @Input() searchPlaceholder = 'Search rows';

  @Output() readonly gridReady = new EventEmitter<GridReadyEvent>();
  @Output() readonly cellClicked = new EventEmitter<CellClickedEvent>();
  @Output() readonly rowClicked = new EventEmitter<RowClickedEvent>();

  activePageSize = this.pageSize;
  resolvedColumnDefs: ColDef[] = this.buildColumnDefs();
  resolvedDefaultColDef: ColDef = this.buildDefaultColDef();
  resolvedGridOptions: GridOptions = this.buildGridOptions();
  resolvedLocaleText: Record<string, string> = this.buildLocaleText();
  resolvedRowModelType: RowModelType | undefined = undefined;
  serverLoading = false;
  searchText = '';
  private activeSearch = '';
  private searchDebounceTimer?: ReturnType<typeof setTimeout>;
  private pendingServerRequests = 0;
  private serverRequestGeneration = 0;
  private datasourceRegistered = false;
  private activeRequests = new Subscription();
  readonly serverDatasource: IDatasource = {
    getRows: (params) => {
      this.getServerRows(params);
    },
    destroy: () => {
      this.datasourceRegistered = false;
      this.destroyServerRequests();
    },
  };

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['pageSize']) {
      this.activePageSize = this.pageSize;
    }
    if (this.shouldRefreshResolvedGridInputs(changes)) {
      this.refreshResolvedGridOptions();
    }
    if (changes['serverPagination']) {
      this.datasourceRegistered = false;
    }

    if (changes['searchEnabled'] && !this.searchEnabled) {
      this.searchText = '';
      this.activeSearch = '';
      this.applyClientSearch();
    }

    if (!this.serverPagination) {
      if (changes['serverPagination']) {
        this.destroyServerRequests();
      }
      if (changes['rowData'] || changes['searchEnabled']) {
        this.applyClientSearch();
      }
      return;
    }

    if (
      changes['serverPagination'] ||
      changes['serverRefreshKey'] ||
      changes['serverPageLoader'] ||
      changes['pageSize']
    ) {
      this.setServerLoading(Boolean(this.serverPageLoader));
      this.resetServerRows();
    }
  }

  ngOnDestroy(): void {
    this.clearSearchDebounce();
    this.destroyServerRequests();
  }

  handleSearchInput(event: Event): void {
    this.searchText = (event.target as HTMLInputElement | null)?.value ?? '';
    this.cdr.markForCheck();
    this.clearSearchDebounce();
    this.searchDebounceTimer = setTimeout(() => {
      this.applySearchText();
    }, 300);
  }

  handleGridReady(event: GridReadyEvent): void {
    this.gridReady.emit(event);
    if (this.serverPagination) {
      this.resetServerRows();
      return;
    }
    this.applyClientSearch();
  }

  handlePaginationChanged(event: PaginationChangedEvent): void {
    if (!this.serverPagination || !event.newPageSize) return;

    const nextPageSize = event.api.paginationGetPageSize();
    if (!Number.isFinite(nextPageSize) || nextPageSize <= 0 || nextPageSize === this.activePageSize) return;

    this.activePageSize = nextPageSize;
    this.resetServerRows();
  }

  handleSortChanged(): void {
    // The infinite row model refreshes its cache and passes the new sortModel
    // to getRows. Reinstalling the datasource here can create request loops.
  }

  private shouldRefreshResolvedGridInputs(changes: SimpleChanges): boolean {
    return [
      'columnDefs',
      'defaultColDef',
      'gridOptions',
      'localeText',
      'emptyTitle',
      'emptyMessage',
      'serverPagination',
      'pageSize',
    ].some((key) => Boolean(changes[key]));
  }

  private refreshResolvedGridOptions(): void {
    this.resolvedColumnDefs = this.buildColumnDefs();
    this.resolvedDefaultColDef = this.buildDefaultColDef();
    this.resolvedGridOptions = this.buildGridOptions();
    this.resolvedLocaleText = this.buildLocaleText();
    this.resolvedRowModelType = this.serverPagination ? 'infinite' : undefined;
  }

  private buildColumnDefs(): ColDef[] {
    return this.columnDefs.map((columnDef) => ({
      ...columnDef,
      filter: false,
      floatingFilter: false,
      suppressHeaderMenuButton: columnDef.suppressHeaderMenuButton ?? true,
    }));
  }

  private buildGridOptions(): GridOptions {
    return {
      ...this.gridOptions,
      suppressMultiSort: true,
      ...(this.serverPagination ? { cacheBlockSize: this.activePageSize } : {}),
    };
  }

  private buildDefaultColDef(): ColDef {
    return {
      sortable: true,
      resizable: true,
      wrapHeaderText: true,
      autoHeaderHeight: true,
      suppressMovable: true,
      ...this.defaultColDef,
      filter: false,
      floatingFilter: false,
      suppressHeaderMenuButton: true,
    };
  }

  private buildLocaleText(): Record<string, string> {
    return {
      noRowsToShow: formatEmptyStateMessage(this.emptyTitle, this.emptyMessage),
      ...this.localeText,
    };
  }

  private applySearchText(): void {
    const nextSearch = this.searchText.trim();
    if (nextSearch === this.activeSearch) return;

    this.activeSearch = nextSearch;
    if (this.serverPagination) {
      this.resetServerRowsToFirstPage();
      return;
    }

    this.applyClientSearch();
  }

  private applyClientSearch(): void {
    const api = this.gridApi();
    if (this.serverPagination || !api) return;
    api.setGridOption('quickFilterText', this.searchEnabled ? this.activeSearch : '');
  }

  private getServerRows(params: IGetRowsParams): void {
    if (!this.serverPageLoader) {
      this.setServerLoading(false);
      params.successCallback([], 0);
      return;
    }

    const requestGeneration = this.serverRequestGeneration;
    const pageSize = Math.max(1, params.endRow - params.startRow || this.activePageSize || this.pageSize);
    const page = Math.floor(params.startRow / pageSize) + 1;
    const sort = this.normalizeSort(params.sortModel);

    this.trackServerRequestStart();

    const result = this.serverPageLoader({
      page,
      pageSize,
      startRow: params.startRow,
      endRow: params.endRow,
      search: this.searchEnabled ? this.activeSearch : undefined,
      sortBy: sort.sortBy,
      sortDir: sort.sortDir,
      sortModel: params.sortModel,
      filterModel: params.filterModel,
    });

    if (this.isObservablePage(result)) {
      const subscription = result.subscribe({
        next: (pageResult) => {
          this.completeServerRows(params, pageResult, requestGeneration);
        },
        error: () => {
          this.failServerRows(params, requestGeneration);
        },
      });
      this.activeRequests.add(subscription);
      return;
    }

    void result
      .then((pageResult) => {
        this.completeServerRows(params, pageResult, requestGeneration);
      })
      .catch(() => {
        this.failServerRows(params, requestGeneration);
      });
  }

  private normalizeSort(sortModel: IGetRowsParams['sortModel']): Pick<DataGridPageRequest, 'sortBy' | 'sortDir'> {
    const firstSort = sortModel.at(0);
    if (!firstSort) return {};

    const sortBy = firstSort.colId.trim();
    return sortBy ? { sortBy, sortDir: firstSort.sort } : {};
  }

  private completeServerRows(params: IGetRowsParams, pageResult: DataGridPage, requestGeneration: number): void {
    if (!this.isCurrentServerRequest(requestGeneration)) {
      params.failCallback();
      return;
    }

    this.trackServerRequestEnd();
    params.successCallback(pageResult.items, Math.max(0, pageResult.total));
  }

  private failServerRows(params: IGetRowsParams, requestGeneration: number): void {
    if (!this.isCurrentServerRequest(requestGeneration)) {
      params.failCallback();
      return;
    }

    this.trackServerRequestEnd();
    params.failCallback();
  }

  private trackServerRequestStart(): void {
    this.pendingServerRequests += 1;
    this.setServerLoading(true);
  }

  private trackServerRequestEnd(): void {
    this.pendingServerRequests = Math.max(0, this.pendingServerRequests - 1);
    this.setServerLoading(this.pendingServerRequests > 0);
  }

  private destroyServerRequests(): void {
    this.activeRequests.unsubscribe();
    this.activeRequests = new Subscription();
    this.pendingServerRequests = 0;
    this.setServerLoading(false);
  }

  private resetServerRowsToFirstPage(): void {
    this.gridApi()?.paginationGoToFirstPage();
    this.resetServerRows();
  }

  private resetServerRows(): void {
    const api = this.gridApi();
    if (!api) return;

    this.destroyServerRequests();
    this.serverRequestGeneration += 1;
    this.setServerLoading(Boolean(this.serverPageLoader));
    api.setGridOption('cacheBlockSize', this.activePageSize);
    if (!this.datasourceRegistered) {
      api.setGridOption('datasource', this.serverDatasource);
      this.datasourceRegistered = true;
      return;
    }

    api.purgeInfiniteCache();
  }

  /** The grid's api is assigned in its ngAfterViewInit, so it can be missing even when the ViewChild exists. */
  private gridApi(): GridApi | undefined {
    return this.grid?.api;
  }

  private clearSearchDebounce(): void {
    if (!this.searchDebounceTimer) return;
    clearTimeout(this.searchDebounceTimer);
    this.searchDebounceTimer = undefined;
  }

  private isCurrentServerRequest(requestGeneration: number): boolean {
    return requestGeneration === this.serverRequestGeneration;
  }

  private setServerLoading(isLoading: boolean): void {
    if (this.serverLoading === isLoading) return;

    this.zone.run(() => {
      this.serverLoading = isLoading;
      this.cdr.markForCheck();
    });
  }

  private isObservablePage<T>(
    value: Observable<DataGridPage<T>> | Promise<DataGridPage<T>>,
  ): value is Observable<DataGridPage<T>> {
    return isObservable(value);
  }
}
