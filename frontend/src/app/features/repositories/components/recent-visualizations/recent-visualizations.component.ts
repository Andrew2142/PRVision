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
import { MatIconModule } from '@angular/material/icon';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { Subject, catchError, map, of, switchMap, tap } from 'rxjs';
import { RECENT_VISUALIZATIONS_LIMIT } from '../../../../core/constants/ui.constants';
import { type VisualizationSummaryView } from '../../../../core/models/visualization.model';
import { ApiService } from '../../../../core/services/api.service';
import { sourceLabel } from '../../../../core/utils/labels.util';
import { EmptyStateComponent } from '../../../../shared/components/empty-state/empty-state.component';
import { LoadingSpinnerComponent } from '../../../../shared/components/loading-spinner/loading-spinner.component';
import { StatusPillComponent } from '../../../../shared/components/status-pill/status-pill.component';
import { DateTimePipe } from '../../../../shared/pipes/date-time.pipe';
import { RelativeTimePipe } from '../../../../shared/pipes/relative-time.pipe';

/** Last five visualizations of one repository (13 §5.7.6). A snapshot: no polling, a Refresh button reloads. */
@Component({
  selector: 'app-recent-visualizations',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    RouterLink,
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatTooltipModule,
    EmptyStateComponent,
    LoadingSpinnerComponent,
    StatusPillComponent,
    RelativeTimePipe,
    DateTimePipe,
  ],
  template: `
    <mat-card
      class="h-full !rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-md)]"
    >
      <div class="mb-3 flex items-start justify-between gap-3">
        <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Recent visualizations</h3>
        <button
          mat-icon-button
          type="button"
          aria-label="Refresh recent visualizations"
          matTooltip="Refresh recent visualizations"
          [disabled]="loading()"
          (click)="reload()"
        >
          <mat-icon aria-hidden="true">refresh</mat-icon>
        </button>
      </div>
      @if (loading() && rows().length === 0) {
        <app-loading-spinner [inline]="true" [diameter]="24" />
      } @else if (failed()) {
        <p class="flex flex-wrap items-center gap-2 text-sm text-[var(--color-text-tertiary)]">
          Couldn't load recent visualizations.
          <button mat-button type="button" class="!rounded-xl" (click)="reload()">Retry</button>
        </p>
      } @else if (rows().length === 0) {
        <app-empty-state title="No visualizations yet" message="Start one with New visualization." />
      } @else {
        <ul class="divide-y divide-[color:var(--color-border)]">
          @for (row of rows(); track row.v.id) {
            <li class="flex items-start gap-3 py-3">
              <app-status-pill kind="visualization" [value]="row.v.status" class="shrink-0" />
              <div class="min-w-0 flex-1">
                <a
                  class="block truncate font-semibold text-[var(--color-text-primary)] hover:text-[var(--shell-accent)] hover:underline"
                  [routerLink]="['/visualizations', row.v.id]"
                  >{{ row.v.title }}</a
                >
                <p class="text-xs text-[var(--color-text-tertiary)]" [title]="row.v.createdAt | dateTime">
                  {{ row.v.createdAt | relativeTime }}
                </p>
              </div>
              <span
                class="max-w-[40%] shrink-0 truncate text-right text-xs font-semibold text-[var(--color-text-secondary)]"
                [title]="row.source"
                >{{ row.source }}</span
              >
            </li>
          }
        </ul>
      }
      <div class="mt-3 flex justify-end">
        <a mat-button class="!rounded-xl" routerLink="/visualizations" [queryParams]="viewAllParams()">View all →</a>
      </div>
    </mat-card>
  `,
})
export class RecentVisualizationsComponent {
  readonly repositoryId = input.required<number>();
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly loading = signal(false);
  protected readonly failed = signal(false);
  private readonly items = signal<VisualizationSummaryView[]>([]);
  protected readonly rows = computed(() => this.items().map((v) => ({ v, source: sourceLabel(v) })));
  protected readonly viewAllParams = computed(() => ({ repositoryId: this.repositoryId() }));
  private readonly load$ = new Subject<number>();

  constructor() {
    this.load$
      .pipe(
        tap(() => {
          this.loading.set(true);
          this.failed.set(false);
        }),
        switchMap((repositoryId) =>
          this.api.listVisualizations({ repositoryId, page: 1, pageSize: RECENT_VISUALIZATIONS_LIMIT }).pipe(
            map((page) => page.items),
            catchError(() => of(null)),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((items) => {
        this.loading.set(false);
        if (items) this.items.set(items);
        else this.failed.set(true);
      });
    effect(() => {
      const id = this.repositoryId();
      untracked(() => {
        this.load$.next(id);
      });
    });
  }

  protected reload(): void {
    this.load$.next(this.repositoryId());
  }
}
