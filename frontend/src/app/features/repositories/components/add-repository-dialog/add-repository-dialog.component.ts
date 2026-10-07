import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule, type ValidatorFn, Validators } from '@angular/forms';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { Subject, catchError, map, of, switchMap, timer } from 'rxjs';
import {
  LIBRARY_ESTIMATE_DEBOUNCE_MS,
  STATE_ALLOWANCE_DEFAULT,
  STATE_ALLOWANCE_OPTIONS,
} from '../../../../core/constants/ui.constants';
import { type ApiError, toApiError } from '../../../../core/models/api-error.model';
import { type ApiErrorReason } from '../../../../core/models/api.model';
import { type LibraryBuildMode } from '../../../../core/models/domain-enums.model';
import { type LibraryEstimateRequest, type LibraryEstimateView } from '../../../../core/models/harness-library.model';
import {
  type AppCandidateView,
  type AppDiscoveryView,
  type RepositoryCreateRequest,
  type RepositoryCreateResponse,
  type RepositoryView,
} from '../../../../core/models/repository.model';
import { ApiService } from '../../../../core/services/api.service';
import { errorCopyFor } from '../../../../core/utils/error-messages.util';
import { defaultSpendCap } from '../../../../core/utils/library-format.util';
import {
  GenericPopupComponent,
  type PopupConfig,
} from '../../../../shared/components/generic-popup/generic-popup.component';
import { InlineAlertComponent } from '../../../../shared/components/inline-alert/inline-alert.component';
import { frameworkLabel, toDetectedRows } from '../../repository-format';
import { LibraryEstimatePanelComponent } from '../library-estimate-panel/library-estimate-panel.component';
import { spendCapValidators } from '../../spend-cap';

/**
 * form → discovering → (apps) → library → creating/creatingApp → detected (15 §5.4.7, 16 §15.2). `creating` is the
 * create started from the single-app shortcut, `creatingApp` the one started after the app picker.
 */
type DialogPhase = 'form' | 'discovering' | 'creating' | 'apps' | 'library' | 'creatingApp' | 'detected';

type EstimateOutcome = { ok: true; estimate: LibraryEstimateView } | { ok: false; error: ApiError };

export interface AddRepositoryDialogResult {
  created: RepositoryView[];
  openId: number | null;
}

/** One row of the app picker. */
interface AppOption {
  key: string;
  app: AppCandidateView;
  frameworkLabel: string;
  /** Supported and not registered yet. */
  selectable: boolean;
}

/** Extra line under the rejection message (13 §5.6). */
export const REJECTION_TIPS: Partial<Record<ApiErrorReason, string>> = {
  not_git_repo: 'Tip: run `git rev-parse --show-toplevel` inside the project to find the root.',
  unsupported_framework:
    'Supported: Vite + React at the repository root, and Angular 17+ apps built with the application builder.',
  missing_node_modules:
    'PRVision links your existing node_modules into its worktrees, so they must be installed first.',
};

const DIALOG_WIDTH = 'min(600px, calc(100vw - 32px))';

/** `Validators.required` as a plain function (the static method trips `unbound-method`). */
const REQUIRED: ValidatorFn = (control) => Validators.required(control);

const appKey = (app: Pick<AppCandidateView, 'appRoot' | 'angularProject'>): string =>
  `${app.appRoot}|${app.angularProject ?? ''}`;

const isSelectable = (app: AppCandidateView): boolean => app.supported && app.repositoryId === null;

/**
 * MatDialog-hosted add flow (13 §5.6, 15 §5.4.7): path → app discovery → one-click create when the repository holds
 * exactly one new supported app, else an app picker → detection result. Rejections render inline.
 */
@Component({
  selector: 'app-add-repository-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatIconModule,
    MatRadioModule,
    MatSelectModule,
    MatCheckboxModule,
    RouterLink,
    GenericPopupComponent,
    InlineAlertComponent,
    LibraryEstimatePanelComponent,
  ],
  templateUrl: './add-repository-dialog.component.html',
})
export class AddRepositoryDialogComponent {
  private readonly dialogRef =
    inject<MatDialogRef<AddRepositoryDialogComponent, AddRepositoryDialogResult>>(MatDialogRef);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly phase = signal<DialogPhase>('form');
  protected readonly error = signal<ApiError | null>(null);
  protected readonly result = signal<RepositoryCreateResponse | null>(null);
  protected readonly discovery = signal<AppDiscoveryView | null>(null);
  protected readonly selectedKey = signal<string | null>(null);
  private readonly created: RepositoryView[] = [];
  protected readonly form = this.fb.group({
    localPath: this.fb.control('', [REQUIRED, Validators.maxLength(4096), Validators.pattern(/^(\/|~\/).+/)]),
    name: this.fb.control('', [Validators.maxLength(200)]), // 06 RepositoryCreateDTO.name: MaxLength(200)
  });
  /** Display name on the app step, prefilled with the selected app's suggested name. */
  protected readonly appName = this.fb.control('', [Validators.maxLength(200)]);
  /** Screenshot screen size; 'auto' lets the backend guess (mobile for Capacitor/Ionic apps). */
  protected readonly viewport = this.fb.control<'auto' | 'desktop' | 'tablet' | 'mobile'>('auto');

  // Library step (16 §15.2)
  protected readonly stateAllowanceOptions = STATE_ALLOWANCE_OPTIONS;
  protected readonly buildMode = this.fb.control<LibraryBuildMode>('grow');
  protected readonly stateAllowance = this.fb.control<number>(STATE_ALLOWANCE_DEFAULT);
  /** Dollars; prefilled from the estimate until the user edits it. */
  protected readonly spendCap = new FormControl<number | null>(null, spendCapValidators());
  protected readonly noCap = this.fb.control(false);
  protected readonly buildModeValue = toSignal(this.buildMode.valueChanges, { initialValue: this.buildMode.value });
  protected readonly estimate = signal<LibraryEstimateView | null>(null);
  protected readonly estimateLoading = signal(false);
  protected readonly estimateError = signal<string | null>(null);
  /** The app the library step adds, the name to give it, and the step Back returns to. */
  private readonly pendingApp = signal<AppCandidateView | null>(null);
  private pendingName = '';
  private libraryFrom: 'form' | 'apps' = 'form';
  private readonly estimate$ = new Subject<{ request: LibraryEstimateRequest; delayMs: number } | null>();

  protected readonly onAppStep = computed(() => this.phase() === 'apps');
  protected readonly onLibraryStep = computed(
    () => this.phase() === 'library' || this.phase() === 'creating' || this.phase() === 'creatingApp',
  );
  protected readonly submitting = computed(
    () => this.phase() === 'discovering' || this.phase() === 'creating' || this.phase() === 'creatingApp',
  );
  protected readonly appOptions = computed<AppOption[]>(() =>
    (this.discovery()?.apps ?? []).map((app) => ({
      key: appKey(app),
      app,
      frameworkLabel: frameworkLabel(app.framework),
      selectable: isSelectable(app),
    })),
  );
  private readonly selectedApp = computed(
    () => this.appOptions().find((option) => option.selectable && option.key === this.selectedKey())?.app ?? null,
  );
  protected readonly popupConfig = computed<PopupConfig>(() => {
    if (this.phase() === 'detected') {
      return {
        title: 'Repository added',
        icon: 'check_circle',
        width: DIALOG_WIDTH,
        primaryButtonText: 'Open repository',
        secondaryButtonText: 'Add another',
      };
    }
    if (this.onLibraryStep()) {
      return {
        title: 'Harness library',
        icon: 'library_books',
        width: DIALOG_WIDTH,
        primaryButtonText: this.buildModeValue() === 'scan' ? 'Add and scan' : 'Add',
        secondaryButtonText: 'Back',
        loading: this.phase() !== 'library',
      };
    }
    if (this.onAppStep()) {
      return {
        title: 'Choose an app',
        icon: 'apps',
        width: DIALOG_WIDTH,
        primaryButtonText: 'Continue',
        secondaryButtonText: 'Back',
        primaryButtonDisabled: this.selectedApp() === null,
      };
    }
    return {
      title: 'Add repository',
      icon: 'create_new_folder',
      width: DIALOG_WIDTH,
      primaryButtonText: 'Continue',
      secondaryButtonText: 'Cancel',
      loading: this.phase() === 'discovering',
    };
  });
  protected readonly errorView = computed(() => {
    const e = this.error();
    return e
      ? { ...errorCopyFor(e), tip: REJECTION_TIPS[e.errorReason ?? 'internal_error'] ?? null, details: e.details }
      : null;
  });
  protected readonly detectedRows = computed(() => {
    const r = this.result();
    return r ? toDetectedRows(r, { includeIdentity: true }) : [];
  });
  protected readonly noRemote = computed(() => {
    const r = this.result();
    return !!r && (!r.githubOwner || !r.githubRepo);
  });
  protected readonly scanJobId = computed(() => this.result()?.scanJobId ?? null);
  protected readonly scanStartError = computed(() => this.result()?.scanStartError ?? null);

  constructor() {
    // switchMap: a newer request (or leaving the step) drops the answer of an older one.
    this.estimate$
      .pipe(
        switchMap((next) =>
          next === null
            ? of(null)
            : timer(next.delayMs).pipe(
                switchMap(() => this.api.estimateLibraryForFolder(next.request)), // silent: rendered inline
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
      if (this.phase() === 'library') this.requestEstimate(LIBRARY_ESTIMATE_DEBOUNCE_MS);
    });
    this.noCap.valueChanges.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((noCap) => {
      if (noCap) this.spendCap.disable();
      else this.spendCap.enable();
    });
  }

  /** Path step: discover the apps of the repository containing the folder. */
  protected submit(): void {
    if (this.phase() !== 'form') return;
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const { localPath } = this.form.getRawValue();
    this.phase.set('discovering');
    this.error.set(null);
    this.api
      .detectRepositoryApps({ localPath: localPath.trim() }) // silent: rendered inline
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (discovery) => {
          this.onDiscovered(discovery);
        },
        error: (e: ApiError) => {
          this.error.set(e);
          this.phase.set('form');
        },
      });
  }

  protected onPathEnter(event: Event): void {
    event.preventDefault();
    this.submit();
  }

  protected onPrimary(): void {
    const r = this.result();
    if (this.phase() === 'detected' && r) this.close(r.id);
    else if (this.phase() === 'apps') this.addSelected();
    else if (this.phase() === 'library') this.createFromLibrary();
    else this.submit();
  }

  protected onSecondary(): void {
    if (this.phase() === 'detected') {
      this.form.reset();
      this.result.set(null);
      this.error.set(null);
      this.discovery.set(null);
      this.resetLibraryStep();
      this.phase.set('form');
    } else if (this.phase() === 'library') {
      this.estimate$.next(null);
      this.error.set(null);
      this.phase.set(this.libraryFrom);
    } else if (this.phase() === 'apps') {
      this.error.set(null);
      this.phase.set('form');
    } else if (!this.submitting()) {
      this.close(null);
    }
  }

  protected selectApp(key: unknown): void {
    const option = this.appOptions().find((candidate) => candidate.key === key);
    if (!option?.selectable) return;
    this.selectedKey.set(option.key);
    this.appName.setValue(this.form.controls.name.value.trim() || option.app.suggestedName);
  }

  /** "Already added": close and open the registered repository. */
  protected openExisting(repositoryId: number): void {
    this.close(repositoryId);
  }

  /** closePopup from generic-popup (X, Escape, backdrop). Ignored while a request is in flight. */
  protected onCloseRequested(): void {
    if (!this.submitting()) this.close(null);
  }

  private onDiscovered(discovery: AppDiscoveryView): void {
    this.discovery.set(discovery);
    const [only, ...others] = discovery.apps;
    if (only && others.length === 0 && isSelectable(only)) {
      this.openLibraryStep(only, this.form.controls.name.value.trim(), 'form');
      return;
    }
    const selectable = discovery.apps.filter(isSelectable);
    const preselected =
      selectable.find((app) => discovery.hint !== null && app.appRoot === discovery.hint) ??
      (selectable.length === 1 ? selectable[0] : undefined);
    this.selectedKey.set(null);
    this.appName.setValue(this.form.controls.name.value.trim());
    if (preselected) this.selectApp(appKey(preselected));
    this.phase.set('apps');
  }

  private addSelected(): void {
    const app = this.selectedApp();
    if (!app || this.appName.invalid) return;
    this.openLibraryStep(app, this.appName.value.trim(), 'apps');
  }

  private openLibraryStep(app: AppCandidateView, name: string, from: 'form' | 'apps'): void {
    this.pendingApp.set(app);
    this.pendingName = name;
    this.libraryFrom = from;
    this.error.set(null);
    this.phase.set('library');
    this.requestEstimate(0);
  }

  private requestEstimate(delayMs: number): void {
    const discovery = this.discovery();
    const app = this.pendingApp();
    if (!discovery || !app) return;
    this.estimateLoading.set(true);
    this.estimateError.set(null);
    this.estimate$.next({
      delayMs,
      request: {
        localPath: discovery.rootPath,
        appRoot: app.appRoot,
        angularProject: app.angularProject ?? undefined,
        stateAllowance: this.stateAllowance.value,
      },
    });
  }

  private onEstimate(outcome: EstimateOutcome | null): void {
    this.estimateLoading.set(false);
    if (outcome === null) return;
    if (!outcome.ok) {
      this.estimate.set(null);
      this.estimateError.set(outcome.error.message);
      return;
    }
    this.estimate.set(outcome.estimate);
    if (!this.spendCap.dirty) this.spendCap.setValue(defaultSpendCap(outcome.estimate));
  }

  /** Library step: create the repository with its build mode, allowance and (scan only) spending cap. */
  private createFromLibrary(): void {
    const discovery = this.discovery();
    const app = this.pendingApp();
    if (!discovery || !app) return;
    const scan = this.buildMode.value === 'scan';
    if (scan && !this.noCap.value && (this.spendCap.invalid || this.spendCap.value === null)) {
      this.spendCap.markAsTouched();
      return;
    }
    const body: RepositoryCreateRequest = {
      localPath: discovery.rootPath,
      name: this.pendingName || undefined,
      appRoot: app.appRoot,
      angularProject: app.angularProject ?? undefined,
      renderViewport: this.viewport.value === 'auto' ? undefined : this.viewport.value,
      libraryBuildMode: this.buildMode.value,
      stateAllowance: this.stateAllowance.value,
    };
    if (scan) body.scanSpendCapUsd = this.noCap.value ? null : this.spendCap.value;
    const from = this.libraryFrom;
    this.phase.set(from === 'apps' ? 'creatingApp' : 'creating');
    this.error.set(null);
    this.api
      .createRepository(body) // silent: rendered inline
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (repo) => {
          this.estimate$.next(null);
          this.created.push(repo);
          this.result.set(repo);
          this.phase.set('detected');
        },
        error: (e: ApiError) => {
          this.error.set(e);
          this.phase.set('library');
        },
      });
  }

  private resetLibraryStep(): void {
    this.estimate$.next(null);
    this.pendingApp.set(null);
    this.pendingName = '';
    this.estimate.set(null);
    this.estimateError.set(null);
    this.buildMode.setValue('grow');
    this.stateAllowance.setValue(STATE_ALLOWANCE_DEFAULT, { emitEvent: false });
    this.noCap.setValue(false);
    this.spendCap.reset(null);
  }

  /** "View progress" of a scan started with the repository: the link navigates, the dialog closes. */
  protected closeForScan(): void {
    this.close(null);
  }

  private close(openId: number | null): void {
    this.dialogRef.close({ created: [...this.created], openId });
  }
}
