import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  type Observable,
  Subject,
  catchError,
  exhaustMap,
  expand,
  map,
  of,
  reduce,
  take,
  takeUntil,
  takeWhile,
  tap,
  timer,
} from 'rxjs';
import { LIBRARY_JOB_EVENTS_POLL_MS, LIBRARY_JOB_POLL_MS } from '../../../core/constants/polling.constants';
import {
  CONSOLE_BATCH_LIMIT,
  CONSOLE_MAX_EVENTS,
  CONSOLE_MAX_PAGES_PER_TICK,
} from '../../../core/constants/ui.constants';
import { type ApiError, toApiError } from '../../../core/models/api-error.model';
import { type LibraryJobEventView, type LibraryJobView } from '../../../core/models/harness-library.model';
import { ApiService } from '../../../core/services/api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { userMessageFor } from '../../../core/utils/error-messages.util';
import { isTerminalLibraryJob } from '../../../core/utils/library-format.util';

export type JobLoadState = 'loading' | 'ready' | 'not_found' | 'error';
type JobTick = { ok: true; job: LibraryJobView } | { ok: false; error: ApiError };

/**
 * State of `/library-jobs/:id` (16 §15.7), provided by the page. The job every 2 s and its events every 1.5 s, never
 * overlapping (exhaustMap); both stop at a terminal status (the events after one last fetch), a 404, a restart or
 * destroy — the same rules as the visualization page.
 */
@Injectable()
export class LibraryJobDetailStore {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly restart$ = new Subject<void>();

  readonly jobId = signal<number | null>(null);
  readonly job = signal<LibraryJobView | null>(null);
  readonly loadState = signal<JobLoadState>('loading');
  readonly loadError = signal<ApiError | null>(null);
  readonly events = signal<readonly LibraryJobEventView[]>([]);
  readonly eventsTrimmed = signal(false);
  readonly cancelState = signal<'idle' | 'requesting' | 'requested'>('idle');

  readonly isTerminal = computed(() => {
    const job = this.job();
    return job !== null && isTerminalLibraryJob(job.status);
  });
  private readonly lastEventId = computed(() => this.events().at(-1)?.id ?? null);

  /** Starts (or restarts) both pollers for `id`. */
  start(id: number): void {
    this.restart$.next();
    if (this.jobId() !== id) {
      this.jobId.set(id);
      this.job.set(null);
      this.events.set([]);
      this.eventsTrimmed.set(false);
      this.cancelState.set('idle');
      this.loadState.set('loading');
    }
    this.loadError.set(null);
    this.pollJob(id);
    this.pollEvents(id);
  }

  markNotFound(): void {
    this.restart$.next();
    this.loadState.set('not_found');
  }

  refreshNow(): void {
    const id = this.jobId();
    if (id !== null) this.start(id);
  }

  /** Call only after the user confirmed. cancelLibraryJob is silent: every outcome is toasted here, once. */
  cancel(): void {
    const id = this.jobId();
    if (id === null || this.isTerminal() || this.cancelState() !== 'idle') return;
    this.cancelState.set('requesting');
    this.api
      .cancelLibraryJob(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (res) => {
          if (res.status === 'cancelled') {
            this.cancelState.set('idle');
            this.notifications.info('Job cancelled.');
            this.refreshNow();
          } else {
            this.cancelState.set('requested');
            this.notifications.info('Cancellation requested. The job stops after the current batch.');
          }
        },
        error: (e: unknown) => {
          const error = toApiError(e);
          this.cancelState.set('idle');
          if (error.is('already_terminal')) {
            this.notifications.info('This job had already finished.');
            this.refreshNow();
          } else {
            this.notifications.error(userMessageFor(error));
          }
        },
      });
  }

  private pollJob(id: number): void {
    timer(0, LIBRARY_JOB_POLL_MS)
      .pipe(
        exhaustMap(() =>
          this.api.getLibraryJob(id).pipe(
            map((job): JobTick => ({ ok: true, job })),
            catchError((error: unknown) => of<JobTick>({ ok: false, error: toApiError(error) })),
          ),
        ),
        tap((tick) => {
          if (tick.ok) this.onJob(tick.job);
          else this.onJobError(tick.error);
        }),
        takeWhile((tick) => (tick.ok ? !isTerminalLibraryJob(tick.job.status) : !tick.error.isNotFound), true),
        takeUntil(this.restart$),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private pollEvents(id: number): void {
    timer(0, LIBRARY_JOB_EVENTS_POLL_MS)
      .pipe(
        exhaustMap(() =>
          this.fetchEventsAfter(id, this.lastEventId()).pipe(catchError(() => of<LibraryJobEventView[]>([]))),
        ),
        tap((events) => {
          this.appendEvents(events);
        }),
        // inclusive: one more fetch after the job turns terminal picks up the final events
        takeWhile(() => !this.isTerminal() && this.loadState() !== 'not_found', true),
        takeUntil(this.restart$),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private fetchEventsAfter(id: number, afterId: number | null): Observable<LibraryJobEventView[]> {
    const page = (after: number | null): Observable<LibraryJobEventView[]> =>
      this.api.getLibraryJobEvents(id, { afterId: after ?? undefined, limit: CONSOLE_BATCH_LIMIT });
    return page(afterId).pipe(
      expand((batch) => {
        const last = batch.at(-1);
        return batch.length >= CONSOLE_BATCH_LIMIT && last ? page(last.id) : EMPTY;
      }),
      take(CONSOLE_MAX_PAGES_PER_TICK),
      reduce((all, batch) => all.concat(batch), [] as LibraryJobEventView[]),
    );
  }

  private appendEvents(batch: readonly LibraryJobEventView[]): void {
    const last = this.lastEventId() ?? 0;
    const fresh = batch.filter((e) => e.id > last);
    if (!fresh.length) return;
    const next = [...this.events(), ...fresh];
    if (next.length > CONSOLE_MAX_EVENTS) {
      this.eventsTrimmed.set(true);
      this.events.set(next.slice(next.length - CONSOLE_MAX_EVENTS));
    } else {
      this.events.set(next);
    }
  }

  private onJob(job: LibraryJobView): void {
    this.job.set(job);
    this.loadState.set('ready');
    this.loadError.set(null);
    if (isTerminalLibraryJob(job.status)) this.cancelState.set('idle');
  }

  private onJobError(error: ApiError): void {
    if (error.isNotFound) {
      this.loadState.set('not_found');
      return;
    }
    if (!this.job()) {
      this.loadState.set('error');
      this.loadError.set(error);
    }
  }
}
