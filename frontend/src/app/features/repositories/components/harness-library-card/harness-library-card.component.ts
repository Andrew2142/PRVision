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
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, exhaustMap, filter, map, of, switchMap, takeWhile, timer } from 'rxjs';
import { LIBRARY_SUMMARY_POLL_MS } from '../../../../core/constants/polling.constants';
import { type ApiError, toApiError } from '../../../../core/models/api-error.model';
import { type HarnessLibrarySummaryView, type LibraryJobView } from '../../../../core/models/harness-library.model';
import { type RepositoryView } from '../../../../core/models/repository.model';
import { ApiService } from '../../../../core/services/api.service';
import { ConfirmDialogService, GENERIC_POPUP_DIALOG_CONFIG } from '../../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../../core/services/notification.service';
import { userMessageFor } from '../../../../core/utils/error-messages.util';
import { jobProgressPercent, jobProgressText, plural } from '../../../../core/utils/library-format.util';
import { LoadingSpinnerComponent } from '../../../../shared/components/loading-spinner/loading-spinner.component';
import {
  ScanDialogComponent,
  type ScanDialogData,
  type ScanDialogLabel,
  type ScanDialogResult,
} from '../scan-dialog/scan-dialog.component';

type SummaryTick = { ok: true; summary: HarnessLibrarySummaryView } | { ok: false; error: ApiError };

/** What the card prints, derived once per summary (no helper calls in the template). */
interface LibraryCardView {
  buildModeLabel: string;
  empty: boolean;
  countsText: string;
  rescanHint: string | null;
  activeJob: { job: LibraryJobView; progressText: string; percent: number } | null;
  showScan: boolean;
  showContinue: boolean;
  showRescan: boolean;
  rescanPrimary: boolean;
}

export function libraryCardView(s: HarnessLibrarySummaryView): LibraryCardView {
  const c = s.counts;
  const parts = [`${String(c.total)} saved`, `${String(c.ready)} ready`, `${String(c.needsUpdate)} need updating`];
  if (c.withoutHarness > 0) parts.push(`${String(c.withoutHarness)} could not be written`);
  const job = s.activeJob;
  return {
    buildModeLabel: s.buildMode === 'scan' ? 'Whole app' : 'Grow as you go',
    empty: c.total === 0,
    countsText:
      c.total === 0 ? 'No saved harnesses yet. Runs add them as they go, or scan the whole app.' : parts.join(' · '),
    rescanHint: s.rescanSuggested
      ? `${String(c.otherAllowance)} saved harnesses were written with a different number of states; Rescan to apply ` +
        `${plural(s.stateAllowance, 'state')} per component.`
      : null,
    activeJob: job ? { job, progressText: jobProgressText(job), percent: jobProgressPercent(job) } : null,
    showScan: job === null && !s.canContinue,
    showContinue: job === null && s.canContinue,
    showRescan: job === null && s.buildMode === 'scan',
    rescanPrimary: s.rescanSuggested,
  };
}

/**
 * "Harness library" card of the repository page (16 §15.3): counts, the active scan with its progress, and Scan whole
 * app / Continue scan / Rescan. Polls the summary every 3 s while a scan runs. 16k adds Export and Import.
 */
@Component({
  selector: 'app-harness-library-card',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [MatButtonModule, MatCardModule, MatIconModule, MatProgressBarModule, RouterLink, LoadingSpinnerComponent],
  templateUrl: './harness-library-card.component.html',
  host: { class: 'block' },
})
export class HarnessLibraryCardComponent {
  readonly repository = input.required<RepositoryView>();
  private readonly api = inject(ApiService);
  private readonly dialog = inject(MatDialog);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly summary = signal<HarnessLibrarySummaryView | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly cancelling = signal(false);
  protected readonly view = computed(() => {
    const s = this.summary();
    return s ? libraryCardView(s) : null;
  });
  private readonly load$ = new Subject<number>();

  constructor() {
    this.load$
      .pipe(
        // switchMap: another repository (or a reload) replaces the running poll.
        switchMap((repositoryId) =>
          timer(0, LIBRARY_SUMMARY_POLL_MS).pipe(
            exhaustMap(() =>
              this.api.getLibrarySummary(repositoryId).pipe(
                map((summary): SummaryTick => ({ ok: true, summary })),
                catchError((error: unknown) => of<SummaryTick>({ ok: false, error: toApiError(error) })),
              ),
            ),
            // Keep polling while a scan runs (a failed tick during a scan keeps polling too).
            takeWhile(
              (tick) => (tick.ok ? tick.summary.activeJob !== null : (this.summary()?.activeJob ?? null) !== null),
              true,
            ),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((tick) => {
        if (tick.ok) {
          this.summary.set(tick.summary);
          this.loadFailed.set(false);
        } else if (!this.summary()) {
          this.loadFailed.set(true);
        }
      });
    effect(() => {
      // Any change of the repository (e.g. a saved state allowance) reloads the summary.
      const repo = this.repository();
      untracked(() => {
        if (this.summary()?.repositoryId !== repo.id) this.summary.set(null);
        this.reload();
      });
    });
  }

  protected reload(): void {
    this.loadFailed.set(false);
    this.load$.next(this.repository().id);
  }

  protected openScan(kind: 'scan' | 'rescan', label: ScanDialogLabel): void {
    this.dialog
      .open<ScanDialogComponent, ScanDialogData, ScanDialogResult>(ScanDialogComponent, {
        ...GENERIC_POPUP_DIALOG_CONFIG,
        data: { repository: this.repository(), kind, label },
      })
      .afterClosed()
      .pipe(
        filter((job): job is LibraryJobView => job !== undefined),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((job) => {
        void this.router.navigate(['/library-jobs', job.id]);
      });
  }

  protected confirmCancel(job: LibraryJobView): void {
    if (this.cancelling()) return;
    this.confirm
      .confirm({
        title: 'Cancel the scan?',
        message: 'Harnesses written so far are kept. The scan finishes checking the current batch, then stops.',
        confirmText: 'Cancel scan',
        cancelText: 'Keep scanning',
        confirmColor: 'warn',
      })
      .pipe(
        filter(Boolean),
        exhaustMap(() => {
          this.cancelling.set(true);
          return this.api.cancelLibraryJob(job.id).pipe(
            map((res) => ({ ok: true as const, status: res.status })),
            catchError((error: unknown) => of({ ok: false as const, error: toApiError(error) })),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => {
        this.cancelling.set(false);
        if (outcome.ok) {
          this.notifications.info(
            outcome.status === 'cancelled'
              ? 'Scan cancelled.'
              : 'Cancellation requested. The scan stops after the current batch.',
          );
        } else if (outcome.error.is('already_terminal')) {
          this.notifications.info('This scan had already finished.');
        } else {
          this.notifications.error(userMessageFor(outcome.error));
        }
        this.reload();
      });
  }
}
