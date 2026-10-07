import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import {
  EMPTY,
  type Observable,
  Subject,
  catchError,
  exhaustMap,
  expand,
  filter,
  finalize,
  map,
  of,
  reduce,
  take,
  takeUntil,
  takeWhile,
  tap,
  timer,
} from 'rxjs';
import {
  CONSOLE_POLL_MS,
  POLL_FAILURE_BANNER_THRESHOLD,
  VISUALIZATION_POLL_MS,
} from '../../../core/constants/polling.constants';
import {
  CONSOLE_BATCH_LIMIT,
  CONSOLE_MAX_EVENTS,
  CONSOLE_MAX_PAGES_PER_TICK,
} from '../../../core/constants/ui.constants';
import { type ApiError, toApiError } from '../../../core/models/api-error.model';
import { type ConsoleEventView, type VisualizationDetailView } from '../../../core/models/visualization.model';
import { ApiService } from '../../../core/services/api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { RunAlertService } from '../../../core/services/run-alert.service';
import { errorCopyFor, userMessageFor } from '../../../core/utils/error-messages.util';
import { isTerminalStatus } from '../../../core/utils/visualization-status.util';
import {
  COMPONENT_FILTER_PREDICATES,
  type ComponentFilter,
  countComponents,
  defaultComponentFilter,
  resolveStoppedStageIndex,
} from './component-filters';

export type DetailLoadState = 'loading' | 'ready' | 'not_found' | 'error';
type DetailTick = { ok: true; detail: VisualizationDetailView } | { ok: false; error: ApiError };

/** A finished run keeps being polled while a repair job of it runs (16 §15.5.1). */
function keepPolling(detail: VisualizationDetailView): boolean {
  return !isTerminalStatus(detail.status) || detail.activeRepairJob !== null;
}

/**
 * Component-scoped state for `/visualizations/:id` (13 §5.9.3). Provided by the page, so its DestroyRef stops
 * both pollers when the page goes away. Detail every 2 s, console every 1.5 s, never overlapping (exhaustMap),
 * stopping on a terminal status (unless a repair runs, 16 §15.5.1), a 404, a restart or destroy (00 §12).
 */
@Injectable()
export class VisualizationDetailStore {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly runAlerts = inject(RunAlertService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly restart$ = new Subject<void>();

  readonly visualizationId = signal<number | null>(null);
  readonly detail = signal<VisualizationDetailView | null>(null);
  readonly loadState = signal<DetailLoadState>('loading');
  readonly loadError = signal<ApiError | null>(null);
  readonly consecutivePollFailures = signal(0);
  readonly consoleEvents = signal<readonly ConsoleEventView[]>([]);
  readonly consoleTrimmed = signal(false);
  readonly cancelState = signal<'idle' | 'requesting' | 'requested'>('idle');
  readonly deleting = signal(false);
  private readonly chosenFilter = signal<ComponentFilter | null>(null);
  /** Component ids whose Repair request is in flight (the row shows "Repairing…" until the job lists it). */
  readonly repairRequests = signal<ReadonlySet<number>>(new Set());
  readonly repairAllRequesting = signal(false);

  readonly status = computed(() => this.detail()?.status ?? null);
  readonly isTerminal = computed(() => {
    const s = this.status();
    return s !== null && isTerminalStatus(s);
  });
  readonly connectionLost = computed(() => this.consecutivePollFailures() >= POLL_FAILURE_BANNER_THRESHOLD);
  /** A freshly queued run has no components yet; `components` is then empty, never null. */
  readonly components = computed(() =>
    [...(this.detail()?.components ?? [])].sort((a, b) => a.rank - b.rank || a.id - b.id),
  );
  readonly counts = computed(() => countComponents(this.components()));
  readonly defaultFilter = computed<ComponentFilter>(() => defaultComponentFilter(this.counts(), this.components()));
  /** The run re-checked saved harnesses because a global style changed (16 E11). */
  readonly hasRechecked = computed(() => this.components().some((c) => c.changeKind === 'rechecked'));
  readonly activeRepairJob = computed(() => this.detail()?.activeRepairJob ?? null);
  /** Polling continues after a terminal status while a repair runs. */
  private readonly polling = computed(() => {
    const d = this.detail();
    return d !== null && keepPolling(d);
  });
  readonly filter = computed<ComponentFilter>(() => this.chosenFilter() ?? this.defaultFilter());
  readonly filteredComponents = computed(() => this.components().filter(COMPONENT_FILTER_PREDICATES[this.filter()]));
  /** failedStage from the API (00 §14.4) wins; console inference only when it is null. */
  readonly stoppedStageIndex = computed(() =>
    resolveStoppedStageIndex(this.detail()?.failedStage ?? null, this.consoleEvents()),
  );
  private readonly lastEventId = computed(() => this.consoleEvents().at(-1)?.id ?? null);

  /** Starts (or restarts) both pollers for `id`. Safe to call repeatedly. */
  start(id: number): void {
    this.restart$.next();
    if (this.visualizationId() !== id) {
      this.visualizationId.set(id);
      this.detail.set(null);
      this.consoleEvents.set([]);
      this.consoleTrimmed.set(false);
      this.chosenFilter.set(null);
      this.cancelState.set('idle');
      this.loadState.set('loading');
    }
    this.loadError.set(null);
    this.consecutivePollFailures.set(0);
    this.pollDetail(id);
    this.pollConsole(id);
  }

  markNotFound(): void {
    this.restart$.next();
    this.loadState.set('not_found');
  }

  setFilter(filter: ComponentFilter): void {
    this.chosenFilter.set(filter);
  }

  refreshNow(): void {
    const id = this.visualizationId();
    if (id !== null) this.start(id);
  }

  private pollDetail(id: number): void {
    timer(0, VISUALIZATION_POLL_MS)
      .pipe(
        // exhaustMap: a tick while the previous GET is in flight is skipped (no overlap, no cancel-starvation).
        exhaustMap(() =>
          this.api.getVisualization(id).pipe(
            map((detail): DetailTick => ({ ok: true, detail })),
            catchError((error: unknown) => of<DetailTick>({ ok: false, error: toApiError(error) })),
          ),
        ),
        tap((r) => {
          if (r.ok) this.onDetail(r.detail);
          else this.onDetailError(r.error);
        }),
        takeWhile((r) => (r.ok ? keepPolling(r.detail) : !r.error.isNotFound), true),
        takeUntil(this.restart$),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private pollConsole(id: number): void {
    timer(0, CONSOLE_POLL_MS)
      .pipe(
        exhaustMap(() =>
          this.fetchConsoleAfter(id, this.lastEventId()).pipe(catchError(() => of<ConsoleEventView[]>([]))),
        ),
        tap((events) => {
          this.appendEvents(events);
        }),
        // inclusive: one more fetch after the detail turns terminal picks up the final events
        takeWhile(() => (!this.isTerminal() || this.polling()) && this.loadState() !== 'not_found', true),
        takeUntil(this.restart$),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  /** Drains pages until a short page arrives (handles large terminal runs in one tick). Oldest first (00 §14.4). */
  private fetchConsoleAfter(id: number, afterId: number | null): Observable<ConsoleEventView[]> {
    const page = (after: number | null): Observable<ConsoleEventView[]> =>
      this.api.getConsole(id, { afterId: after ?? undefined, limit: CONSOLE_BATCH_LIMIT });
    return page(afterId).pipe(
      expand((batch) => {
        const last = batch.at(-1);
        return batch.length >= CONSOLE_BATCH_LIMIT && last ? page(last.id) : EMPTY;
      }),
      take(CONSOLE_MAX_PAGES_PER_TICK),
      reduce((all, batch) => all.concat(batch), [] as ConsoleEventView[]),
    );
  }

  private appendEvents(batch: readonly ConsoleEventView[]): void {
    const last = this.lastEventId() ?? 0;
    const fresh = batch.filter((e) => e.id > last);
    if (!fresh.length) return;
    const next = [...this.consoleEvents(), ...fresh];
    if (next.length > CONSOLE_MAX_EVENTS) {
      this.consoleTrimmed.set(true);
      this.consoleEvents.set(next.slice(next.length - CONSOLE_MAX_EVENTS));
    } else {
      this.consoleEvents.set(next);
    }
  }

  private onDetail(detail: VisualizationDetailView): void {
    const previous = this.detail();
    this.detail.set(detail);
    this.runAlerts.statusChanged(previous?.id === detail.id ? previous.status : null, detail);
    this.loadState.set('ready');
    this.loadError.set(null);
    this.consecutivePollFailures.set(0);
    if (isTerminalStatus(detail.status)) this.cancelState.set('idle');
  }

  private onDetailError(error: ApiError): void {
    if (error.isNotFound) {
      this.loadState.set('not_found');
      return;
    }
    if (!this.detail()) {
      this.loadState.set('error');
      this.loadError.set(error);
      return;
    }
    this.consecutivePollFailures.update((n) => n + 1);
  }

  /** Continues a run paused for the component-limit choice (00 §19); the run is queued again. */
  continueRun(componentLimit: number): void {
    const id = this.visualizationId();
    if (id === null || this.detail()?.status !== 'awaiting_confirmation') return;
    this.api
      .continueVisualization(id, componentLimit)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.notifications.info(`Rendering up to ${String(componentLimit)} components.`);
          this.refreshNow();
        },
        error: (e: unknown) => {
          this.notifications.error(userMessageFor(toApiError(e)));
          this.refreshNow();
        },
      });
  }

  /** Repair of one card (16 §15.5.3). Silent API call: every outcome is reported here. */
  repairComponent(componentId: number): void {
    const id = this.visualizationId();
    if (id === null || this.repairRequests().has(componentId)) return;
    this.repairRequests.update((set) => new Set(set).add(componentId));
    this.api
      .repairComponent(id, componentId)
      .pipe(
        finalize(() => {
          this.repairRequests.update((set) => {
            const next = new Set(set);
            next.delete(componentId);
            return next;
          });
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.notifications.success('Repair started.');
          this.refreshNow();
        },
        error: (e: unknown) => {
          this.onRepairError(toApiError(e));
        },
      });
  }

  /** Call only after the user confirmed Repair all broken (16 §15.5.1). */
  repairBroken(): void {
    const id = this.visualizationId();
    if (id === null || this.repairAllRequesting() || this.activeRepairJob() !== null) return;
    this.repairAllRequesting.set(true);
    this.api
      .repairBroken(id)
      .pipe(
        finalize(() => {
          this.repairAllRequesting.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.notifications.success('Repair started.');
          this.refreshNow();
        },
        error: (e: unknown) => {
          this.onRepairError(toApiError(e));
        },
      });
  }

  /** AI not configured or rejected → the Settings prompt of 13; anything else → a toast; then a fresh detail. */
  private onRepairError(error: ApiError): void {
    const copy = errorCopyFor(error);
    const route = copy.actionRoute;
    if (route) {
      this.notifications
        .promptAction({
          title: copy.title,
          message: copy.message,
          actionLabel: copy.actionLabel ?? 'Open settings',
          dismissText: 'Not now',
        })
        .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
        .subscribe(() => void this.router.navigateByUrl(route));
    } else {
      this.notifications.error(userMessageFor(error));
    }
    this.refreshNow();
  }

  /** Call only after the user confirmed. cancelVisualization is silent: every outcome is toasted here, once. */
  cancel(): void {
    const id = this.visualizationId();
    if (id === null || this.isTerminal() || this.cancelState() !== 'idle') return;
    this.cancelState.set('requesting');
    this.api
      .cancelVisualization(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (res.status === 'cancelled') {
            // 200: the job was still queued and was removed
            this.notifications.info('Visualization cancelled.');
            this.refreshNow(); // pick up the terminal status immediately
          } else {
            // 202: the worker was signalled
            this.cancelState.set('requested');
            this.notifications.info('Cancellation requested. The pipeline stops at its next checkpoint.');
          }
        },
        error: (e: unknown) => {
          const error = toApiError(e);
          this.cancelState.set('idle');
          if (error.is('already_terminal')) {
            this.notifications.info('This visualization had already finished.');
            this.refreshNow();
          } else {
            this.notifications.error(userMessageFor(error));
          }
        },
      });
  }

  /** Emits true when deleted. removeVisualization is not silent: the interceptor toasts failures (incl. 409 conflict). */
  remove(): Observable<boolean> {
    const id = this.visualizationId();
    if (id === null || !this.isTerminal()) return of(false);
    this.deleting.set(true);
    return this.api.removeVisualization(id).pipe(
      map(() => true),
      catchError(() => of(false)),
      finalize(() => {
        this.deleting.set(false);
      }),
    );
  }
}
