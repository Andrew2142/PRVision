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
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { exhaustMap, filter, finalize, switchMap } from 'rxjs';
import { toApiError } from '../../../core/models/api-error.model';
import { type LibraryJobView } from '../../../core/models/harness-library.model';
import { type ConsoleEventView } from '../../../core/models/visualization.model';
import { ApiService } from '../../../core/services/api.service';
import { ConfirmDialogService, GENERIC_POPUP_DIALOG_CONFIG } from '../../../core/services/confirm-dialog.service';
import { NotificationService } from '../../../core/services/notification.service';
import { setPageTitle } from '../../../core/services/page-title.strategy';
import { userMessageFor } from '../../../core/utils/error-messages.util';
import {
  formatUsd,
  isTerminalLibraryJob,
  jobProgressPercent,
  jobProgressText,
  libraryJobTitle,
  plural,
} from '../../../core/utils/library-format.util';
import { parseRouteId } from '../../../core/utils/route-params.util';
import { InlineAlertComponent } from '../../../shared/components/inline-alert/inline-alert.component';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner.component';
import { NotFoundPageComponent } from '../../../shared/components/not-found-page/not-found-page.component';
import { PageHeaderComponent } from '../../../shared/components/page-header/page-header.component';
import { StatusPillComponent } from '../../../shared/components/status-pill/status-pill.component';
import {
  ScanDialogComponent,
  type ScanDialogData,
  type ScanDialogResult,
} from '../../repositories/components/scan-dialog/scan-dialog.component';
import { ConsolePanelComponent } from '../../visualizations/components/console-panel/console-panel.component';
import { LibraryJobDetailStore } from './library-job-detail.store';

/** Everything the page prints for one job (16 §15.7). */
export interface LibraryJobPageView {
  title: string;
  backLink: (string | number)[];
  backLabel: string;
  progressText: string;
  percent: number;
  capText: string | null;
  countsText: string;
  currentLabel: string | null;
  allowanceText: string;
  active: boolean;
  canContinue: boolean;
  terminal: { tone: 'success' | 'warning' | 'error' | 'info'; title: string; message: string } | null;
}

export function libraryJobPageView(job: LibraryJobView): LibraryJobPageView {
  const terminal = isTerminalLibraryJob(job.status);
  const isScan = job.kind !== 'repair';
  return {
    title: libraryJobTitle(job),
    backLink:
      isScan || job.visualizationId === null
        ? ['/repositories', job.repositoryId]
        : ['/visualizations', job.visualizationId],
    backLabel: isScan || job.visualizationId === null ? 'Back to repository' : 'Back to run',
    progressText: jobProgressText(job),
    percent: jobProgressPercent(job),
    capText: job.spendCapUsd === null ? null : `Cap ${formatUsd(job.spendCapUsd)}`,
    countsText: `${String(job.writtenCount)} saved · ${String(job.failedCount)} need updating · ${String(job.skippedCount)} skipped`,
    currentLabel: terminal ? null : job.currentLabel,
    allowanceText: `${plural(job.stateAllowance, 'state')} per component`,
    active: !terminal,
    canContinue: isScan && terminal && job.status !== 'completed',
    terminal: terminalMessage(job),
  };
}

function terminalMessage(job: LibraryJobView): LibraryJobPageView['terminal'] {
  switch (job.status) {
    case 'cap_reached':
      return {
        tone: 'warning',
        title: 'Paused at cap',
        message: 'Paused at the spending cap. Continue the scan to write the rest.',
      };
    case 'failed':
      return { tone: 'error', title: 'Failed', message: job.errorMessage ?? 'The job failed.' };
    case 'completed':
      return {
        tone: 'success',
        title: 'Completed',
        message: `Done: ${String(job.writtenCount)} saved, ${String(job.failedCount)} need updating, ${String(job.skippedCount)} skipped.`,
      };
    case 'cancelled':
      return { tone: 'info', title: 'Cancelled', message: 'Everything written before the cancel is kept.' };
    default:
      return null;
  }
}

/** `/library-jobs/:id`: progress, outcome and console of a scan, rescan or repair (16 §15.7). */
@Component({
  selector: 'app-library-job-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [LibraryJobDetailStore],
  templateUrl: './library-job-detail.component.html',
  host: { class: 'flex flex-col gap-6' },
  imports: [
    MatButtonModule,
    MatCardModule,
    MatIconModule,
    MatProgressBarModule,
    MatProgressSpinnerModule,
    PageHeaderComponent,
    StatusPillComponent,
    InlineAlertComponent,
    LoadingSpinnerComponent,
    NotFoundPageComponent,
    ConsolePanelComponent,
  ],
})
export class LibraryJobDetailComponent {
  readonly id = input.required<string>();
  protected readonly store = inject(LibraryJobDetailStore);
  private readonly api = inject(ApiService);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly dialog = inject(MatDialog);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly parsedId = computed(() => parseRouteId(this.id()));
  protected readonly view = computed(() => {
    const job = this.store.job();
    return job ? libraryJobPageView(job) : null;
  });
  /** Job events in the console panel; the stage column shows the job kind. */
  protected readonly consoleEvents = computed<ConsoleEventView[]>(() => {
    const stage = this.store.job()?.kind ?? 'scan';
    return this.store.events().map((e) => ({ ...e, stage }));
  });
  protected readonly cancelLabel = computed(() => (this.store.cancelState() === 'idle' ? 'Cancel' : 'Cancelling…'));
  protected readonly loadErrorMessage = computed(() => this.store.loadError()?.message ?? '');
  protected readonly continuing = signal(false);

  constructor() {
    effect(() => {
      const id = this.parsedId();
      untracked(() => {
        if (id === null) this.store.markNotFound();
        else this.store.start(id);
      });
    });
    effect(() => {
      const v = this.view();
      if (!v) return;
      untracked(() => {
        setPageTitle(this.title, v.title);
      });
    });
  }

  protected confirmCancel(): void {
    this.confirm
      .confirm({
        title: 'Cancel this job?',
        message: 'Harnesses written so far are kept. The job finishes checking the current batch, then stops.',
        confirmText: 'Cancel job',
        cancelText: 'Keep running',
        confirmColor: 'warn',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.store.cancel();
      });
  }

  /** Continue scan: a new `scan` job writes what is still missing (16 E15). */
  protected continueScan(): void {
    const job = this.store.job();
    if (!job || this.continuing()) return;
    this.continuing.set(true);
    this.api
      .getRepository(job.repositoryId)
      .pipe(
        finalize(() => {
          this.continuing.set(false);
        }),
        switchMap((repository) =>
          this.dialog
            .open<ScanDialogComponent, ScanDialogData, ScanDialogResult>(ScanDialogComponent, {
              ...GENERIC_POPUP_DIALOG_CONFIG,
              data: { repository, kind: 'scan', label: 'Continue scan' },
            })
            .afterClosed(),
        ),
        filter((next): next is LibraryJobView => next !== undefined),
        exhaustMap((next) => this.router.navigate(['/library-jobs', next.id])),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        error: (e: unknown) => {
          this.notifications.error(userMessageFor(toApiError(e)));
        },
      });
  }
}
