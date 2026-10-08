import { ChangeDetectionStrategy, Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, type ValidatorFn, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { MatTooltipModule } from '@angular/material/tooltip';
import { EMPTY, type Observable, catchError, concatMap, finalize, map, of, tap } from 'rxjs';
import { type ApiError } from '../../../core/models/api-error.model';
import { type AiProviderKind, type Effort } from '../../../core/models/domain-enums.model';
import {
  type AiTestResultView,
  type GithubTestResultView,
  type SettingsView,
} from '../../../core/models/settings.model';
import { ApiService } from '../../../core/services/api.service';
import { NotificationService } from '../../../core/services/notification.service';
import { ThemeService } from '../../../core/services/theme.service';
import { errorCopyFor } from '../../../core/utils/error-messages.util';
import { providerLabel } from '../../../core/utils/labels.util';
import { InlineAlertComponent } from '../../../shared/components/inline-alert/inline-alert.component';
import { LoadingSpinnerComponent } from '../../../shared/components/loading-spinner/loading-spinner.component';
import { PageHeaderComponent } from '../../../shared/components/page-header/page-header.component';
import { SegmentedControlComponent } from '../../../shared/components/segmented-control/segmented-control.component';
import { type PillTone } from '../../../shared/components/status-pill/status-pill.config';
import {
  CLAUDE_CODE_POLICY_NOTE,
  DEFAULT_AI_MODEL,
  EFFORT_OPTIONS,
  PROVIDER_OPTIONS,
  THEME_OPTIONS,
} from '../settings-copy';
import {
  AI_MODEL_PATTERN,
  NO_WHITESPACE,
  type SecretClearFlags,
  type SecretField,
  anthropicKeyHint,
  anthropicKeyRequired,
  buildSettingsUpdate,
  githubTokenHint,
} from '../settings-form';

type TestState<T> =
  { state: 'idle' } | { state: 'running' } | { state: 'ok'; result: T } | { state: 'error'; error: ApiError };

/** `Validators.required` as a plain function (the static method trips `unbound-method`). */
const REQUIRED: ValidatorFn = (control) => Validators.required(control);

const AI_FIELDS = ['anthropicApiKey', 'aiProvider', 'aiModel', 'aiHarnessEffort', 'aiSummaryEffort'] as const;

/** Settings screen (13 §5.4): GitHub token, AI provider, appearance. Secrets are write-only. */
@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ReactiveFormsModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatRadioModule,
    MatButtonModule,
    MatIconModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
    PageHeaderComponent,
    SegmentedControlComponent,
    InlineAlertComponent,
    LoadingSpinnerComponent,
  ],
  templateUrl: './settings-page.component.html',
  host: { class: 'flex flex-col gap-6', '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class SettingsPageComponent {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly theme = inject(ThemeService);

  protected readonly themeOptions = THEME_OPTIONS;
  protected readonly effortOptions = EFFORT_OPTIONS;
  protected readonly policyNote = CLAUDE_CODE_POLICY_NOTE;

  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly saved = signal<SettingsView | null>(null);
  protected readonly clearFlags = signal<SecretClearFlags>({ githubToken: false, anthropicApiKey: false });
  protected readonly saving = signal(false);
  protected readonly saveError = signal<ApiError | null>(null);
  protected readonly showGithubToken = signal(false);
  protected readonly showAnthropicKey = signal(false);
  protected readonly anthropicKeyTouched = signal(false);
  protected readonly githubTest = signal<TestState<GithubTestResultView>>({ state: 'idle' });
  protected readonly aiTest = signal<TestState<AiTestResultView>>({ state: 'idle' });

  protected readonly form = this.fb.group(
    {
      githubToken: this.fb.control('', [Validators.maxLength(255), NO_WHITESPACE]),
      aiProvider: this.fb.control<AiProviderKind>('anthropic_api'),
      // 05 SettingsUpdateDTO: MaxLength(512)
      anthropicApiKey: this.fb.control('', [Validators.maxLength(512), NO_WHITESPACE]),
      aiModel: this.fb.control(DEFAULT_AI_MODEL, [
        REQUIRED,
        Validators.maxLength(100),
        Validators.pattern(AI_MODEL_PATTERN),
      ]),
      aiHarnessEffort: this.fb.control<Effort>('high'),
      aiSummaryEffort: this.fb.control<Effort>('medium'),
    },
    {
      validators: anthropicKeyRequired(
        () => this.saved()?.hasAnthropicApiKey ?? false,
        () => this.clearFlags().anthropicApiKey,
      ),
    },
  );
  private readonly formValue = toSignal(this.form.valueChanges.pipe(map(() => this.form.getRawValue())), {
    initialValue: this.form.getRawValue(),
  });
  private readonly formStatus = toSignal(this.form.statusChanges, { initialValue: this.form.status });

  protected readonly pendingUpdate = computed(() => {
    const saved = this.saved();
    return saved ? buildSettingsUpdate(saved, this.formValue(), this.clearFlags()) : {};
  });
  /** Public for settingsUnsavedChangesGuard. */
  readonly hasChanges = computed(() => Object.keys(this.pendingUpdate()).length > 0);
  protected readonly canSave = computed(() => this.hasChanges() && this.formStatus() === 'VALID' && !this.saving());
  protected readonly githubChangesPending = computed(() => 'githubToken' in this.pendingUpdate());
  protected readonly aiChangesPending = computed(() => {
    const u = this.pendingUpdate();
    return AI_FIELDS.some((k) => k in u);
  });
  protected readonly provider = computed(() => this.formValue().aiProvider);

  // GitHub card
  protected readonly githubTokenWarning = computed(() => githubTokenHint(this.formValue().githubToken));
  protected readonly githubHint = computed(() => {
    if (this.clearFlags().githubToken) return 'The saved token will be removed when you save.';
    return this.githubTokenWarning() ?? 'Read-only: Contents, Metadata, Pull requests.';
  });
  protected readonly githubSaved = computed(() => !!this.saved()?.hasGithubToken && !this.clearFlags().githubToken);
  protected readonly githubPlaceholder = computed(() =>
    this.saved()?.hasGithubToken ? 'Saved — leave blank to keep' : 'github_pat_…',
  );
  protected readonly showGithubRemove = computed(
    () => !!this.saved()?.hasGithubToken && !this.clearFlags().githubToken && !this.formValue().githubToken,
  );
  protected readonly githubStatus = computed<{ tone: PillTone; label: string }>(() => {
    const s = this.saved();
    if (!s?.hasGithubToken) return { tone: 'muted', label: 'Not configured' };
    return s.githubLogin
      ? { tone: 'success', label: `Connected as @${s.githubLogin}` }
      : { tone: 'muted', label: 'Saved, not tested' };
  });
  protected readonly githubStatusClass = computed(() => `dd-pill dd-pill--${this.githubStatus().tone}`);
  protected readonly githubTestLabel = computed(() =>
    this.githubChangesPending() ? 'Save & test' : 'Test connection',
  );
  protected readonly githubTestDisabled = computed(() => {
    const s = this.saved();
    const nothingToTest = !s?.hasGithubToken && !this.formValue().githubToken.trim();
    return nothingToTest || this.clearFlags().githubToken || this.githubTest().state === 'running' || this.saving();
  });
  protected readonly githubTestError = computed(() => {
    const t = this.githubTest();
    return t.state === 'error' ? errorCopyFor(t.error) : null;
  });

  // AI card
  protected readonly providerCards = computed(() =>
    PROVIDER_OPTIONS.map((o) => ({ ...o, selected: o.value === this.provider() })),
  );
  protected readonly showSavedKeyKeptNote = computed(
    () => this.provider() === 'claude_code' && !!this.saved()?.hasAnthropicApiKey,
  );
  protected readonly anthropicKeyWarning = computed(() => anthropicKeyHint(this.formValue().anthropicApiKey));
  protected readonly anthropicHint = computed(() =>
    this.clearFlags().anthropicApiKey ? 'The saved key will be removed when you save.' : this.anthropicKeyWarning(),
  );
  protected readonly anthropicSaved = computed(
    () => !!this.saved()?.hasAnthropicApiKey && !this.clearFlags().anthropicApiKey,
  );
  protected readonly anthropicPlaceholder = computed(() =>
    this.saved()?.hasAnthropicApiKey ? 'Saved — leave blank to keep' : 'sk-ant-…',
  );
  protected readonly showAnthropicRemove = computed(
    () => !!this.saved()?.hasAnthropicApiKey && !this.clearFlags().anthropicApiKey && !this.formValue().anthropicApiKey,
  );
  /**
   * The group error shows once the user has changed something or left the key field, so a fresh install does not
   * open with an error (13 §5.4.6). Save is disabled while it applies, so this text explains why.
   */
  protected readonly anthropicKeyMissing = computed(() => {
    this.formStatus();
    this.formValue();
    this.clearFlags();
    return this.form.hasError('anthropicKeyRequired') && (this.hasChanges() || this.anthropicKeyTouched());
  });
  protected readonly modelIsDefault = computed(() => this.formValue().aiModel === DEFAULT_AI_MODEL);
  protected readonly harnessEffortLabel = computed(() => effortLabel(this.formValue().aiHarnessEffort));
  protected readonly summaryEffortLabel = computed(() => effortLabel(this.formValue().aiSummaryEffort));
  protected readonly aiTestLabel = computed(() => (this.aiChangesPending() ? 'Save & test' : 'Test AI'));
  protected readonly aiTestDisabled = computed(
    () => this.formStatus() !== 'VALID' || this.aiTest().state === 'running' || this.saving(),
  );
  // providerLabel: 12's core/utils/labels.util.ts
  protected readonly aiTestMessage = computed(() => {
    const t = this.aiTest();
    return t.state === 'ok'
      ? `${t.result.model} via ${providerLabel(t.result.provider)} answered in ${(t.result.latencyMs / 1000).toFixed(1)} s.`
      : null;
  });
  protected readonly aiTestError = computed(() => {
    const t = this.aiTest();
    return t.state === 'error' ? errorCopyFor(t.error) : null;
  });

  // Footer
  protected readonly saveErrorCopy = computed(() => {
    const e = this.saveError();
    return e ? { ...errorCopyFor(e), details: e.details } : null;
  });
  protected readonly loadErrorMessage = computed(() => {
    const e = this.loadError();
    return e ? errorCopyFor(e).message : '';
  });

  constructor() {
    this.load();
  }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api
      .getSettings()
      .pipe(
        finalize(() => {
          this.loading.set(false);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (v) => {
          this.saved.set(v);
          this.resetFormFrom(v);
        },
        error: (e: ApiError) => {
          this.loadError.set(e);
        },
      });
  }

  private resetFormFrom(v: SettingsView): void {
    this.form.controls.githubToken.enable();
    this.form.controls.anthropicApiKey.enable();
    this.form.reset({
      githubToken: '',
      aiProvider: v.aiProvider,
      anthropicApiKey: '',
      aiModel: v.aiModel,
      aiHarnessEffort: v.aiHarnessEffort,
      aiSummaryEffort: v.aiSummaryEffort,
    });
    this.clearFlags.set({ githubToken: false, anthropicApiKey: false });
    this.showGithubToken.set(false);
    this.showAnthropicKey.set(false);
    this.anthropicKeyTouched.set(false);
  }

  /** Saves pending changes. Emits the saved view, or null when nothing was saved. Cold: subscribe to run. */
  private save(): Observable<SettingsView | null> {
    if (!this.canSave()) return of(this.hasChanges() ? null : this.saved());
    const update = this.pendingUpdate();
    this.saving.set(true);
    this.saveError.set(null);
    return this.api.updateSettings(update).pipe(
      tap((v) => {
        this.saved.set(v);
        this.resetFormFrom(v);
        this.notifications.success('Settings saved');
      }),
      catchError((e: ApiError) => {
        this.saveError.set(e);
        return of(null);
      }),
      finalize(() => {
        this.saving.set(false);
      }),
    );
  }

  protected onSaveClick(): void {
    this.form.markAllAsTouched();
    this.anthropicKeyTouched.set(true);
    this.save().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  protected markClear(field: SecretField): void {
    this.clearFlags.update((f) => ({ ...f, [field]: true }));
    this.form.controls[field].setValue('');
    this.form.controls[field].disable(); // getRawValue() still reports ''
    this.form.updateValueAndValidity();
  }

  protected undoClear(field: SecretField): void {
    this.clearFlags.update((f) => ({ ...f, [field]: false }));
    this.form.controls[field].enable();
    this.form.updateValueAndValidity();
  }

  protected toggleGithubToken(): void {
    this.showGithubToken.update((v) => !v);
  }

  protected toggleAnthropicKey(): void {
    this.showAnthropicKey.update((v) => !v);
  }

  protected onAnthropicKeyBlur(): void {
    this.anthropicKeyTouched.set(true);
  }

  protected resetModel(): void {
    this.form.controls.aiModel.setValue(DEFAULT_AI_MODEL);
  }

  /** "Save & test" when the card has unsaved changes: save first, test only if the save succeeded. */
  protected testGithub(): void {
    if (this.githubTestDisabled()) return;
    const saveFirst = this.githubChangesPending() ? this.save() : of(this.saved());
    this.githubTest.set({ state: 'running' });
    saveFirst
      .pipe(
        concatMap((v) => (v ? this.api.testGithub() : EMPTY)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (result) => {
          this.githubTest.set({ state: 'ok', result });
          this.saved.update((s) => (s ? { ...s, githubLogin: result.login } : s)); // 05 persists githubLogin
        },
        error: (error: ApiError) => {
          this.githubTest.set({ state: 'error', error });
        },
        complete: () => {
          if (this.githubTest().state === 'running') this.githubTest.set({ state: 'idle' }); // save failed
        },
      });
  }

  protected testAi(): void {
    if (this.aiTestDisabled()) return;
    const saveFirst = this.aiChangesPending() ? this.save() : of(this.saved());
    this.aiTest.set({ state: 'running' });
    saveFirst
      .pipe(
        concatMap((v) => (v ? this.api.testAi() : EMPTY)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (result) => {
          this.aiTest.set({ state: 'ok', result });
        },
        error: (error: ApiError) => {
          this.aiTest.set({ state: 'error', error });
        },
        complete: () => {
          if (this.aiTest().state === 'running') this.aiTest.set({ state: 'idle' });
        },
      });
  }

  protected discard(): void {
    const s = this.saved();
    if (s) {
      this.resetFormFrom(s);
      this.saveError.set(null);
    }
  }

  protected onBeforeUnload(event: BeforeUnloadEvent): void {
    if (this.hasChanges()) event.preventDefault();
  }
}

function effortLabel(value: Effort): string {
  return EFFORT_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
