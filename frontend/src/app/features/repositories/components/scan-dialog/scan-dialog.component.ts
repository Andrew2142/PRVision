import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MAT_DIALOG_DATA, MatDialogRef } from '@angular/material/dialog';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Router } from '@angular/router';
import { Subject, catchError, map, of, switchMap, timer } from 'rxjs';
import { LIBRARY_ESTIMATE_DEBOUNCE_MS, STATE_ALLOWANCE_OPTIONS } from '../../../../core/constants/ui.constants';
import { type ApiError, toApiError } from '../../../../core/models/api-error.model';
import {
  type LibraryEstimateView,
  type LibraryJobView,
  type LibraryScanCreateRequest,
} from '../../../../core/models/harness-library.model';
import { type RepositoryView } from '../../../../core/models/repository.model';
import { ApiService } from '../../../../core/services/api.service';
import { errorCopyFor } from '../../../../core/utils/error-messages.util';
import { defaultSpendCap } from '../../../../core/utils/library-format.util';
import {
  GenericPopupComponent,
  type PopupConfig,
} from '../../../../shared/components/generic-popup/generic-popup.component';
import { InlineAlertComponent } from '../../../../shared/components/inline-alert/inline-alert.component';
import { spendCapValidators } from '../../spend-cap';
import { LibraryEstimatePanelComponent } from '../library-estimate-panel/library-estimate-panel.component';

export type ScanDialogLabel = 'Scan whole app' | 'Continue scan' | 'Rescan';

/** MAT_DIALOG_DATA of the scan dialog (16 §15.3.1). */
export interface ScanDialogData {
  repository: RepositoryView;
  kind: 'scan' | 'rescan';
  label: ScanDialogLabel;
}

/** The started job, or undefined when the dialog was dismissed. */
export type ScanDialogResult = LibraryJobView | undefined;

type EstimateOutcome = { ok: true; estimate: LibraryEstimateView } | { ok: false; error: ApiError };

const DIALOG_WIDTH = 'min(560px, calc(100vw - 32px))';

/**
 * Scan whole app, Continue scan and Rescan (16 §15.3.1): the estimate of what is left to write, a spending cap (or
 * No cap), and for Rescan the states per component. Start → POST library/scans; errors render inline.
 */
@Component({
  selector: 'app-scan-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatButtonModule,
    MatCheckboxModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    GenericPopupComponent,
    InlineAlertComponent,
    LibraryEstimatePanelComponent,
  ],
  templateUrl: './scan-dialog.component.html',
})
export class ScanDialogComponent {
  protected readonly data = inject<ScanDialogData>(MAT_DIALOG_DATA);
  private readonly dialogRef = inject<MatDialogRef<ScanDialogComponent, ScanDialogResult>>(MatDialogRef);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly stateAllowanceOptions = STATE_ALLOWANCE_OPTIONS;
  protected readonly isRescan = this.data.kind === 'rescan';
  protected readonly stateAllowance = this.fb.control<number>(this.data.repository.stateAllowance);
  protected readonly spendCap = new FormControl<number | null>(null, spendCapValidators());
  protected readonly noCap = this.fb.control(false);
  protected readonly estimate = signal<LibraryEstimateView | null>(null);
  protected readonly estimateLoading = signal(false);
  protected readonly estimateError = signal<string | null>(null);
  protected readonly starting = signal(false);
  protected readonly error = signal<ApiError | null>(null);
  protected readonly errorView = computed(() => {
    const e = this.error();
    return e ? { ...errorCopyFor(e), details: e.details } : null;
  });
  protected readonly popupConfig = computed<PopupConfig>(() => ({
    title: this.data.label,
    icon: this.isRescan ? 'restart_alt' : 'travel_explore',
    width: DIALOG_WIDTH,
    primaryButtonText: 'Start',
    secondaryButtonText: 'Cancel',
    loading: this.starting(),
  }));
  private readonly estimate$ = new Subject<number>();

  constructor() {
    // switchMap: an answer for an older allowance is dropped when a newer one was asked for.
    this.estimate$
      .pipe(
        switchMap((delayMs) =>
          timer(delayMs).pipe(
            switchMap(() =>
              this.api.estimateLibrary(this.data.repository.id, {
                kind: this.data.kind,
                stateAllowance: this.stateAllowance.value,
              }),
            ),
            map((estimate): EstimateOutcome => ({ ok: true, estimate })),
            catchError((error: unknown) => of<EstimateOutcome>({ ok: false, error: toApiError(error) })),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => {
        this.onEstimate(outcome);
      });
    this.stateAllowance.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.requestEstimate(LIBRARY_ESTIMATE_DEBOUNCE_MS);
    });
    this.noCap.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((noCap) => {
      if (noCap) this.spendCap.disable();
      else this.spendCap.enable();
    });
    this.requestEstimate(0);
  }

  protected start(): void {
    if (this.starting()) return;
    if (!this.noCap.value && (this.spendCap.invalid || this.spendCap.value === null)) {
      this.spendCap.markAsTouched();
      return;
    }
    const body: LibraryScanCreateRequest = {
      kind: this.data.kind,
      spendCapUsd: this.noCap.value ? null : this.spendCap.value,
    };
    if (this.isRescan) body.stateAllowance = this.stateAllowance.value;
    this.starting.set(true);
    this.error.set(null);
    this.api
      .startLibraryScan(this.data.repository.id, body) // silent: rendered inline
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (job) => {
          this.starting.set(false);
          this.dialogRef.close(job);
        },
        error: (e: unknown) => {
          this.starting.set(false);
          this.error.set(toApiError(e));
        },
      });
  }

  /** Settings link of `ai_not_configured` / `ai_unauthorized` (the `promptAction` copy of 13). */
  protected openRoute(route: string): void {
    this.dialogRef.close(undefined);
    void this.router.navigateByUrl(route);
  }

  protected cancel(): void {
    if (!this.starting()) this.dialogRef.close(undefined);
  }

  private requestEstimate(delayMs: number): void {
    this.estimateLoading.set(true);
    this.estimateError.set(null);
    this.estimate$.next(delayMs);
  }

  private onEstimate(outcome: EstimateOutcome): void {
    this.estimateLoading.set(false);
    if (!outcome.ok) {
      this.estimate.set(null);
      this.estimateError.set(outcome.error.message);
      return;
    }
    this.estimate.set(outcome.estimate);
    if (!this.spendCap.dirty) this.spendCap.setValue(defaultSpendCap(outcome.estimate));
  }
}
