import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, type ValidatorFn, Validators } from '@angular/forms';
import { MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { type ApiError } from '../../../../core/models/api-error.model';
import { type ApiErrorReason } from '../../../../core/models/api.model';
import {
  type AppCandidateView,
  type AppDiscoveryView,
  type RepositoryView,
} from '../../../../core/models/repository.model';
import { ApiService } from '../../../../core/services/api.service';
import { errorCopyFor } from '../../../../core/utils/error-messages.util';
import {
  GenericPopupComponent,
  type PopupConfig,
} from '../../../../shared/components/generic-popup/generic-popup.component';
import { InlineAlertComponent } from '../../../../shared/components/inline-alert/inline-alert.component';
import { frameworkLabel, toDetectedRows } from '../../repository-format';

/** form → discovering → (creating | apps → creatingApp) → detected (15 §5.4.7). */
type DialogPhase = 'form' | 'discovering' | 'creating' | 'apps' | 'creatingApp' | 'detected';

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
    GenericPopupComponent,
    InlineAlertComponent,
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
  protected readonly result = signal<RepositoryView | null>(null);
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

  protected readonly onAppStep = computed(() => this.phase() === 'apps' || this.phase() === 'creatingApp');
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
    if (this.onAppStep()) {
      return {
        title: 'Choose an app',
        icon: 'apps',
        width: DIALOG_WIDTH,
        primaryButtonText: 'Add',
        secondaryButtonText: 'Back',
        loading: this.phase() === 'creatingApp',
        primaryButtonDisabled: this.selectedApp() === null,
      };
    }
    return {
      title: 'Add repository',
      icon: 'create_new_folder',
      width: DIALOG_WIDTH,
      primaryButtonText: 'Continue',
      secondaryButtonText: 'Cancel',
      loading: this.phase() === 'discovering' || this.phase() === 'creating',
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
    else this.submit();
  }

  protected onSecondary(): void {
    if (this.phase() === 'detected') {
      this.form.reset();
      this.result.set(null);
      this.error.set(null);
      this.discovery.set(null);
      this.phase.set('form');
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
      this.create(only, this.form.controls.name.value.trim(), 'form');
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
    this.create(app, this.appName.value.trim(), 'apps');
  }

  private create(app: AppCandidateView, name: string, from: 'form' | 'apps'): void {
    const discovery = this.discovery();
    if (!discovery) return;
    this.phase.set(from === 'apps' ? 'creatingApp' : 'creating');
    this.error.set(null);
    this.api
      .createRepository({
        localPath: discovery.rootPath,
        name: name || undefined,
        appRoot: app.appRoot,
        angularProject: app.angularProject ?? undefined,
        renderViewport: this.viewport.value === 'auto' ? undefined : this.viewport.value,
      }) // silent: rendered inline
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (repo) => {
          this.created.push(repo);
          this.result.set(repo);
          this.phase.set('detected');
        },
        error: (e: ApiError) => {
          this.error.set(e);
          this.phase.set(from);
        },
      });
  }

  private close(openId: number | null): void {
    this.dialogRef.close({ created: [...this.created], openId });
  }
}
