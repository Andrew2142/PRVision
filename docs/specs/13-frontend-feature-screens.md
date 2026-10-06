# 13 — Frontend Feature Screens

Owner: build agent (frontend features)
Build wave: 3–5 (Settings and Repositories in wave 3 against 05/06 contracts; Visualizations list/detail in waves 4–5 against 07, using stubbed API data until the pipeline produces real results)
Status: implementation-ready (Revision 2: conforms to 00 §14 and to 01 §5.5.4/§5.14 file and Angular rules)
Prerequisite: sheet 12 delivered (shell, design system, `ApiService`, models, shared components, pipes)

---

## 1. Purpose

Build every PRVision screen on top of the sheet-12 foundation: Settings, Repositories (list, add dialog, detail with pull requests / local branches / working tree), Visualizations history, and Visualization detail (live progress, console, AI summary, per-component base/head/diff viewer with code, structural and harness panels). The screens must look like Uply-v2's tenant frontend (sheet 12 §6.7 and §6.20 cookbook), follow the fixed practices in sheet 12 §6.0, and conform exactly to the contracts in 00.

## 2. Scope / Out of scope

In scope:

- `VisualizationLauncherService` (create → toast → navigate). All HTTP goes through sheet 12's `ApiService` typed methods (01 §5.14.3: it is the only `HttpClient` user); there are no per-feature data services.
- Screens and their sub-components listed in §4, with loading, empty, error and success states.
- Visualization detail state store with polling per 00 §12.
- Image viewer with Side-by-side / Slider / Diff overlay modes and Fit / 100% zoom.
- Unified-diff parser and renderer; structural-diff list; harness panel.
- Unsaved-changes guard for Settings (added to `app.routes.ts`).
- Unit tests for services, utilities, the store and key components.

Out of scope:

- Anything in sheet 12 (shell, theme, shared components, pipes, models, interceptor).
- Backend behaviour; the requested backend details are in §11.
- Editing or re-running harnesses, re-running single components, posting results to GitHub (D10: in-app only).
- Real-time push (SSE/WebSocket). Polling only, per 00 §12.
- E2E tests (sheet 14).

## 3. Dependencies

| Depends on | Used for |
|---|---|
| 00 §5 | Enum values (via `core/models/domain-enums.model.ts`). |
| 00 §9 + §14.4 | Endpoints, view and request shapes (§14.4 wins where they differ), paging. |
| 00 §14.2 | `error_reason` codes (complete list). |
| 00 §11 | Stage order for the stepper. |
| 00 §12 | Routes, polling: detail every 2 s, console every 1.5 s while non-terminal; stop on terminal or destroy. |
| 00 §14.10 | `npm test` single headless run. |
| 00 D5 policy note | Copy shown for the `claude_code` provider. |
| 01 §5.5.4, §5.14 | File layout (routed pages `features/<feature>/<page>/`, private components `features/<feature>/components/<name>/`), Angular practices, forms, a11y, tests. |
| 05 | `GET/PUT /api/settings`, `POST /api/settings/test-github`, `POST /api/settings/test-ai` (shapes per 00 §14.4). |
| 06 | Repository endpoints, pull requests, branches. |
| 07 | Visualization endpoints (create, list, get, console, cancel, delete) and artifact URLs. |
| 12 | Everything in its file inventory. Names used below: `ApiService` (typed methods, §12 6.12) and `ApiRequestOptions`, `ApiError`, `userMessageFor`, `errorCopyFor`, `ERROR_REASON_COPY`, `NotificationService` (`success/error/info/warn/queued/promptAction`), `ConfirmDialogService.confirm`, `ThemeService`, `PageHeaderComponent`, `StatusPillComponent`, `SegmentedControlComponent`, `InlineAlertComponent`, `EmptyStateComponent`, `LoadingSpinnerComponent`, `GenericPopupComponent`/`PopupConfig`, `DataGridComponent`/`DataGridPageLoader`, data-grid helpers, `ActionMenuCellRendererComponent`, `NotFoundPageComponent`, pipes (`relativeTime`, `dateTime`, `compactNumber`, `diffPercent`, `shortSha`, `markdown`), utils (`artifactUrl`, `isTerminalStatus`, `PIPELINE_STAGES`, `stageIndex`, `sourceLabel`, `refsLabel`, `providerLabel`, `isSafeGithubUrl`, `formatPillLabel`), constants (`DEFAULT_PAGE_SIZE`, `PAGE_SIZE_OPTIONS`, `VISUALIZATION_POLL_MS`, `CONSOLE_POLL_MS`, `POLL_FAILURE_BANNER_THRESHOLD`, `CONSOLE_BATCH_LIMIT`, `CONSOLE_MAX_PAGES_PER_TICK`, `CONSOLE_MAX_EVENTS`, `RECENT_VISUALIZATIONS_LIMIT`), `setPageTitle`. |

No new npm dependencies. `@angular/cdk/clipboard` (part of `@angular/cdk`) is used for copy buttons.

## 4. File inventory

Paths relative to `PRVision/frontend/src/app/`. Every component is standalone + OnPush. Specs sit next to sources. Routed pages live in `features/<feature>/<page>/`; components private to a feature live in `features/<feature>/components/<name>/` (01 §5.5.4). A feature never imports from another feature (the launcher is used only inside `repositories` and lives in `core/services`).

| File | Selector / symbol | Responsibility |
|---|---|---|
| `app.routes.ts` (modify) | — | Add `canDeactivate: [settingsUnsavedChangesGuard]` to the `settings` route. Nothing else changes. |
| `core/utils/route-params.util.ts` (+ spec) | `parseRouteId` | `parseRouteId(raw: string \| null \| undefined): number \| null`. |
| `core/services/visualization-launcher.service.ts` (+ spec) | `VisualizationLauncherService` | Create visualization, handle errors, toast, navigate. |
| **Settings** | | |
| `features/settings/settings-form.ts` (+ spec) | functions | Form value types, `buildSettingsUpdate`, validators, token-format hints. |
| `features/settings/settings-copy.ts` | constants | Provider descriptions, policy note, effort option labels, `DEFAULT_AI_MODEL`. |
| `features/settings/settings-page/settings-page.component.ts` + `.html` (+ spec) | `app-settings-page` / `SettingsPageComponent` | Settings screen (replaces 12 stub). |
| `features/settings/settings-unsaved-changes.guard.ts` (+ spec) | `settingsUnsavedChangesGuard` | Functional `CanDeactivateFn<SettingsPageComponent>`. |
| **Repositories** | | |
| `features/repositories/repository-format.ts` (+ spec) | functions | `toDetectedRows(repo, { includeIdentity })` → `{ label, value, mono, warn }[]` for the dialog and the detection card; `frameworkLabel`. |
| `features/repositories/repository-list/repository-list.component.ts` + `.html` (+ spec) | `app-repository-list` | Repository grid (replaces 12 stub). |
| `features/repositories/components/add-repository-dialog/add-repository-dialog.component.ts` + `.html` (+ spec) | `app-add-repository-dialog` | MatDialog-hosted: path form, detection result, rejection reasons. |
| `features/repositories/repository-detail/repository-detail.component.ts` + `.html` (+ spec) | `app-repository-detail` | Detail screen with tabs (replaces 12 stub). |
| `features/repositories/components/detection-card/detection-card.component.ts` | `app-detection-card` | Detected project settings card. |
| `features/repositories/components/pull-request-table/pull-request-table.component.ts` (+ spec) | `app-pull-request-table` | Open PRs table with Visualize. |
| `features/repositories/components/local-sources/local-sources.component.ts` (+ spec) | `app-local-sources` | Branch comparison card + Working tree card. |
| `features/repositories/components/recent-visualizations/recent-visualizations.component.ts` | `app-recent-visualizations` | Last 5 visualizations for the repo. |
| **Visualizations** | | |
| `features/visualizations/visualization-format.ts` (+ spec) | functions | `formatDuration`, `refWithSha`, `summaryLine`, `noComponentsCopy`. (`providerLabel` lives in 12's `core/utils/labels.util.ts` because Settings uses it too and a feature never imports from another feature.) |
| `features/visualizations/visualization-list/visualization-list.component.ts` + `.html` (+ spec) | `app-visualization-list` | History grid (replaces 12 stub). |
| `features/visualizations/visualization-detail/visualization-detail.component.ts` + `.html` (+ spec) | `app-visualization-detail` | Detail screen (replaces 12 stub). |
| `features/visualizations/visualization-detail/visualization-detail.store.ts` (+ spec) | `VisualizationDetailStore` | Component-scoped state + polling. |
| `features/visualizations/visualization-detail/component-filters.ts` (+ spec) | functions | Filter predicates, counts, stopped-stage resolution. |
| `features/visualizations/components/pipeline-stepper/pipeline-stepper.component.ts` (+ spec) | `app-pipeline-stepper` | 7-stage progress stepper. |
| `features/visualizations/components/console-panel/console-panel.component.ts` (+ spec) | `app-console-panel` | Live console with auto-scroll and `aria-live`. |
| `features/visualizations/components/summary-card/summary-card.component.ts` (+ spec) | `app-summary-card` | AI summary via markdown pipe. |
| `features/visualizations/components/component-card/component-card.component.ts` + `.html` (+ spec) | `app-component-card` | One component result. |
| `features/visualizations/components/image-compare/image-compare.component.ts` + `.html` + `.scss` (+ spec) | `app-image-compare` | Base/head/diff viewer. |
| `features/visualizations/components/code-diff/unified-diff.ts` (+ spec) | functions | Unified diff parser. |
| `features/visualizations/components/code-diff/code-diff.component.ts` (+ spec) | `app-code-diff` | Coloured diff renderer. |
| `features/visualizations/components/structural-diff-list/structural-diff-list.component.ts` (+ spec) | `app-structural-diff-list` | Structural changes list. |
| `features/visualizations/components/harness-panel/harness-panel.component.ts` | `app-harness-panel` | Harness source + notes. |

Styles approach for every component: Tailwind utilities and the global Uply/PRVision classes (`dd-*`, `pv-*`) in templates; colours only through tokens (12 §6.0 table). Only `image-compare` has a component `.scss` (under 1 kB). Inline templates up to ~80 lines, otherwise `.html` (01 §5.5.4).

## 5. Detailed design

### 5.1 Conventions shared by all screens

- Routed components start with `<app-page-header>` and use sheet 12 §6.20 host classes: list pages (`repository-list`, `visualization-list`) `host: { class: 'flex min-h-0 flex-1 flex-col gap-4 overflow-hidden' }` so the grid panel fills the viewport as in Uply's monitor list; detail/settings pages `host: { class: 'flex flex-col gap-6' }`.
- Route params arrive as signal inputs through `withComponentInputBinding()`: `readonly id = input.required<string>()`; query params likewise (`readonly status = input<string>()`). Convert with `parseRouteId`; `null` → render `<app-not-found-page>` without calling the API.

  ```ts
  // core/utils/route-params.util.ts
  export function parseRouteId(raw: string | null | undefined): number | null {
    if (!raw || !/^\d{1,9}$/.test(raw)) return null;
    const id = Number(raw);
    return id > 0 ? id : null;
  }
  ```

- Per-screen load state uses three signals, not a library:

  ```ts
  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly data = signal<T | null>(null);
  ```

  First load → `<app-loading-spinner />`. Error with no data → `<app-inline-alert tone="error" title="Couldn't load …">{{ message }}</app-inline-alert>` with a Retry button in `inlineAlertAction`. Error with data (a refresh failed) → keep the data and show the error alert above it. Loads are `GET`s, which are silent by default (12 §6.12), so a load error is shown exactly once, inline.
- Toast or inline, never both: a call is either left to the interceptor (non-silent defaults: `redetectRepository`, `removeRepository`, `removeVisualization`) and the caller only resets its busy state, or it is silent and the caller renders/toasts the error. Each section below states which.
- Mutating buttons show the busy pattern (sheet 12 §6.20) and are disabled while in flight. A second click never sends a second request (guard on the busy signal in the handler as well as `[disabled]`).
- Destructive actions always go through `ConfirmDialogService.confirm({ …, confirmColor: 'warn' })`, chained with `filter(Boolean), exhaustMap(() => apiCall)`; never a `subscribe` inside a `subscribe`.
- Every subscription in a component ends with `takeUntilDestroyed(this.destroyRef)` (single HTTP calls included, so a response arriving after navigation is dropped).
- Templates bind signals, `computed`s, pipes and event handlers only (12 §6.0). Labels, conditional copy and per-row values are `computed` in the class; per-row values in `@for` loops come from a computed view-model array.
- Dates in templates: `{{ x | relativeTime }}` with `[title]="x | dateTime"` for the exact time.

### 5.2 API access

Components and services inject sheet 12's `ApiService` and call its typed methods. Route → method map (defaults from 12 §6.12):

| Route (00 §9/§14.4) | `ApiService` method | Silent by default | Used by |
|---|---|---|---|
| `GET settings` | `getSettings()` | yes | Settings |
| `PUT settings` | `updateSettings(body)` | yes | Settings (inline save error) |
| `POST settings/test-github` | `testGithub()` → `GithubTestResultView { login }` | yes | Settings |
| `POST settings/test-ai` | `testAi()` → `AiTestResultView { provider, model, latencyMs }` | yes | Settings |
| `GET repositories` | `listRepositories()` → `RepositoryView[]` (array, not paged) | yes | Repository list |
| `GET repositories/:id` | `getRepository(id)` | yes | Repository detail, visualization list repo chip |
| `POST repositories` | `createRepository({ localPath, name? })` | yes | Add dialog (inline rejection) |
| `POST repositories/:id/redetect` | `redetectRepository(id)` | no | List, detail |
| `DELETE repositories/:id` | `removeRepository(id)` → `{ id }`; 409 `conflict` while a run is active | no | List, detail |
| `GET repositories/:id/pull-requests` | `listPullRequests(id)` | yes | PR table |
| `GET repositories/:id/branches` | `listBranches(id)` | yes | Local sources |
| `POST visualizations` | `createVisualization(body)` → 202 `{ visualizationId, jobId }` | yes | Launcher |
| `GET visualizations` | `listVisualizations({ page, pageSize, statuses, repositoryId })` | yes | History, recent list |
| `GET visualizations/:id` | `getVisualization(id)` | yes | Detail store |
| `GET visualizations/:id/console` | `getConsole(id, { afterId, limit })` → oldest first | yes | Detail store |
| `POST visualizations/:id/cancel` | `cancelVisualization(id)` → 200 `cancelled` / 202 `cancel_requested` / 409 `already_terminal` | yes | Detail store, history |
| `DELETE visualizations/:id` | `removeVisualization(id)` → `{ id }`; 409 `conflict` while non-terminal | no | Detail, history |

### 5.3 `VisualizationLauncherService`

One flow for every "Visualize" button (PR row, branch card, working-tree card). File `core/services/visualization-launcher.service.ts`.

```ts
@Injectable({ providedIn: 'root' })
export class VisualizationLauncherService {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);

  /**
   * Emits the new visualization id (after navigating to it) or null (after handling the error), then completes.
   * Never errors. createVisualization is silent, so this method is the only place its errors are shown.
   */
  launch(request: VisualizationCreateRequest, label: string): Observable<number | null> {
    return this.api.createVisualization(request).pipe(
      map(({ visualizationId }) => visualizationId),
      tap((visualizationId) => {
        this.notifications.queued(`Visualization queued: ${label}. Opening live progress…`);
        void this.router.navigate(['/visualizations', visualizationId]);
      }),
      catchError((error: unknown) => {
        this.handleError(toApiError(error));
        return of(null);
      }),
    );
  }

  private handleError(error: ApiError): void {
    const copy = errorCopyFor(error);
    const route = copy.actionRoute;
    if (route) {
      // github_token_missing, github_unauthorized, ai_not_configured, ai_unauthorized
      this.notifications
        .promptAction({ title: copy.title, message: copy.message, actionLabel: copy.actionLabel ?? 'Open settings', dismissText: 'Not now' })
        .pipe(filter(Boolean))
        .subscribe(() => void this.router.navigateByUrl(route));   // completes when the dialog closes
      return;
    }
    if (error.is('working_tree_clean')) { this.notifications.info(copy.message); return; }
    this.notifications.error(userMessageFor(error));
  }
}
```

`label` examples: `PR #42 · Fix cart totals`, `feature/x vs main`, `working tree on feature/x`. Callers subscribe with `takeUntilDestroyed`, set their busy signal before and clear it in `finalize`.

### 5.4 Settings (`/settings`)

#### 5.4.1 Layout

```text
Settings
Connect GitHub and choose how PRVision talks to Claude.

┌ GitHub ──────────────────────────────────────────────────────────────────────┐
│ PRVision uses a fine-grained personal access token to list pull requests and │
│ fetch PR heads. …                               [Create a token ↗]            │
│                                                                              │
│ Personal access token                                           [Saved]      │
│ [ ••••••••••••••••   placeholder: Saved — leave blank to keep ][👁] [Remove]  │
│   hint: Read-only: Contents, Metadata, Pull requests.                        │
│                                                                              │
│ ● Connected as @octocat                         [Test connection]            │
│ [inline result: ✓ Connected as @octocat  |  ✗ GitHub rejected the token …]    │
└──────────────────────────────────────────────────────────────────────────────┘
┌ AI provider ─────────────────────────────────────────────────────────────────┐
│ ┌──────────────────────────────┐ ┌──────────────────────────────────────────┐ │
│ │ (•) Anthropic API key        │ │ ( ) Claude Code (local login)            │ │
│ │ Calls the Anthropic API …    │ │ Uses the Claude Code CLI installed …     │ │
│ └──────────────────────────────┘ └──────────────────────────────────────────┘ │
│ [warning alert: Personal prototype only … ]       (claude_code only)          │
│ Anthropic API key   [Saved]  [ •••• Saved — leave blank to keep ][👁][Remove] │  (anthropic_api only)
│ Model [ claude-opus-5-5             ]  [Reset to default]                    │
│ Harness effort [ High ▾ ]          Summary effort [ Medium ▾ ]               │
│                                                   [Test AI]                  │
│ [inline result: ✓ claude-opus-5-5 via Anthropic API answered in 1.2 s]        │
└──────────────────────────────────────────────────────────────────────────────┘
┌ Appearance ──────────────────────────────────────────────────────────────────┐
│ Theme   [ Dark | Light ]                                                     │
└──────────────────────────────────────────────────────────────────────────────┘
[validation/save error inline alert, if any]
                                         [Discard changes]  [Save settings]
```

Below `md` the provider cards stack and the effort selects stack.

#### 5.4.2 Component tree

```text
SettingsPageComponent (form host; host class 'flex flex-col gap-6')
├─ app-page-header title="Settings" subtitle="Connect GitHub and choose how PRVision talks to Claude."
├─ mat-card "GitHub"      → mat-form-field(password), Remove/Undo, status pill, Test button, app-inline-alert(result)
├─ mat-card "AI provider" → mat-radio-group (two option cards), app-inline-alert(policy), key field, model field,
│                           two mat-selects, Test AI button, app-inline-alert(result)
├─ mat-card "Appearance"  → app-segmented-control (theme; not part of the form)
├─ app-inline-alert (save error)
└─ footer actions
```

#### 5.4.3 Form, state and derived values

Secret semantics (00 §14.4): omitted → keep the stored value; `""` → clear; non-empty string → replace. The frontend never sends `null` (the API answers 400).

```ts
// settings-form.ts
export interface SettingsFormValue {
  githubToken: string; aiProvider: AiProviderKind; anthropicApiKey: string;
  aiModel: string; aiHarnessEffort: Effort; aiSummaryEffort: Effort;
}
export interface SecretClearFlags { githubToken: boolean; anthropicApiKey: boolean; }
export type SecretField = keyof SecretClearFlags;

/** Only changed fields are sent. Secrets: omitted = keep, "" = clear, non-empty string = replace. */
export function buildSettingsUpdate(saved: SettingsView, form: SettingsFormValue, clear: SecretClearFlags): SettingsUpdateRequest {
  const update: SettingsUpdateRequest = {};
  const token = form.githubToken.trim();
  if (clear.githubToken) update.githubToken = ''; else if (token) update.githubToken = token;
  const key = form.anthropicApiKey.trim();
  if (clear.anthropicApiKey) update.anthropicApiKey = ''; else if (key) update.anthropicApiKey = key;
  if (form.aiProvider !== saved.aiProvider) update.aiProvider = form.aiProvider;
  const model = form.aiModel.trim();
  if (model !== saved.aiModel) update.aiModel = model;
  if (form.aiHarnessEffort !== saved.aiHarnessEffort) update.aiHarnessEffort = form.aiHarnessEffort;
  if (form.aiSummaryEffort !== saved.aiSummaryEffort) update.aiSummaryEffort = form.aiSummaryEffort;
  return update;
}

export const NO_WHITESPACE = Validators.pattern(/^\S*$/);
/** Same rule as 05's SettingsUpdateDTO.aiModel (`^[a-z0-9][a-z0-9.-]*$`, max 100), so the form never sends a model the API rejects. */
export const AI_MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;
/** Group validator: anthropic_api needs a saved key (not being cleared) or a newly typed key. */
export function anthropicKeyRequired(hasSavedKey: () => boolean, clearing: () => boolean): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const group = control as FormGroup<{ aiProvider: FormControl<AiProviderKind>; anthropicApiKey: FormControl<string> }>;
    if (group.controls.aiProvider.value !== 'anthropic_api') return null;
    const usable = (hasSavedKey() && !clearing()) || group.controls.anthropicApiKey.getRawValue().trim().length > 0;
    return usable ? null : { anthropicKeyRequired: true };
  };
}
export function githubTokenHint(value: string): string | null {
  const v = value.trim();
  if (!v || v.startsWith('github_pat_') || v.startsWith('ghp_')) return null;
  return 'This does not look like a GitHub token (expected github_pat_… or ghp_…).';
}
export function anthropicKeyHint(value: string): string | null {
  const v = value.trim();
  return !v || v.startsWith('sk-ant-') ? null : 'Anthropic API keys usually start with sk-ant-.';
}
```

```ts
// settings-page/settings-page.component.ts
type TestState<T> = { state: 'idle' } | { state: 'running' } | { state: 'ok'; result: T } | { state: 'error'; error: ApiError };

@Component({
  selector: 'app-settings-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatRadioModule,
            MatButtonModule, MatIconModule, MatProgressSpinnerModule, MatTooltipModule, PageHeaderComponent,
            StatusPillComponent, SegmentedControlComponent, InlineAlertComponent, LoadingSpinnerComponent],
  templateUrl: './settings-page.component.html',
  host: { class: 'flex flex-col gap-6', '(window:beforeunload)': 'onBeforeUnload($event)' },
})
export class SettingsPageComponent {
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly theme = inject(ThemeService);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly saved = signal<SettingsView | null>(null);
  protected readonly clearFlags = signal<SecretClearFlags>({ githubToken: false, anthropicApiKey: false });
  protected readonly saving = signal(false);
  protected readonly saveError = signal<ApiError | null>(null);
  protected readonly showGithubToken = signal(false);
  protected readonly showAnthropicKey = signal(false);
  protected readonly githubTest = signal<TestState<GithubTestResultView>>({ state: 'idle' });
  protected readonly aiTest = signal<TestState<AiTestResultView>>({ state: 'idle' });

  protected readonly form = this.fb.group(
    {
      githubToken: this.fb.control('', [Validators.maxLength(255), NO_WHITESPACE]),
      aiProvider: this.fb.control<AiProviderKind>('anthropic_api'),
      anthropicApiKey: this.fb.control('', [Validators.maxLength(512), NO_WHITESPACE]),   // 05 SettingsUpdateDTO: MaxLength(512)
      aiModel: this.fb.control(DEFAULT_AI_MODEL, [Validators.required, Validators.maxLength(100), Validators.pattern(AI_MODEL_PATTERN)]),
      aiHarnessEffort: this.fb.control<Effort>('high'),
      aiSummaryEffort: this.fb.control<Effort>('medium'),
    },
    { validators: anthropicKeyRequired(() => this.saved()?.hasAnthropicApiKey ?? false, () => this.clearFlags().anthropicApiKey) },
  );
  private readonly formValue = toSignal(this.form.valueChanges.pipe(map(() => this.form.getRawValue())), { initialValue: this.form.getRawValue() });
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
    return ['anthropicApiKey', 'aiProvider', 'aiModel', 'aiHarnessEffort', 'aiSummaryEffort'].some((k) => k in u);
  });
  protected readonly provider = computed(() => this.formValue().aiProvider);
  protected readonly githubTokenWarning = computed(() => githubTokenHint(this.formValue().githubToken));
  protected readonly anthropicKeyWarning = computed(() => anthropicKeyHint(this.formValue().anthropicApiKey));
  protected readonly githubStatus = computed<{ tone: PillTone; label: string }>(() => {
    const s = this.saved();
    if (!s?.hasGithubToken) return { tone: 'muted', label: 'Not configured' };
    return s.githubLogin ? { tone: 'success', label: `Connected as @${s.githubLogin}` } : { tone: 'muted', label: 'Saved, not tested' };
  });
  protected readonly githubTestLabel = computed(() => (this.githubChangesPending() ? 'Save & test' : 'Test connection'));
  protected readonly githubTestDisabled = computed(() => {
    const s = this.saved();
    const nothingToTest = !s?.hasGithubToken && !this.formValue().githubToken.trim();
    return nothingToTest || this.clearFlags().githubToken || this.githubTest().state === 'running' || this.saving();
  });
  protected readonly aiTestLabel = computed(() => (this.aiChangesPending() ? 'Save & test' : 'Test AI'));
  protected readonly aiTestDisabled = computed(() => this.formStatus() !== 'VALID' || this.aiTest().state === 'running' || this.saving());
  protected readonly aiTestMessage = computed(() => {        // providerLabel: 12's core/utils/labels.util.ts
    const t = this.aiTest();
    return t.state === 'ok'
      ? `${t.result.model} via ${providerLabel(t.result.provider)} answered in ${(t.result.latencyMs / 1000).toFixed(1)} s.`
      : null;
  });
  protected readonly githubTestError = computed(() => { const t = this.githubTest(); return t.state === 'error' ? errorCopyFor(t.error) : null; });
  protected readonly aiTestError = computed(() => { const t = this.aiTest(); return t.state === 'error' ? errorCopyFor(t.error) : null; });
  protected readonly saveErrorCopy = computed(() => { const e = this.saveError(); return e ? { ...errorCopyFor(e), details: e.details } : null; });

  constructor() { this.load(); }

  protected load(): void {
    this.loading.set(true);
    this.loadError.set(null);
    this.api.getSettings().pipe(finalize(() => this.loading.set(false)), takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (v) => { this.saved.set(v); this.resetFormFrom(v); },
      error: (e: ApiError) => this.loadError.set(e),
    });
  }

  private resetFormFrom(v: SettingsView): void {
    this.form.controls.githubToken.enable();
    this.form.controls.anthropicApiKey.enable();
    this.form.reset({
      githubToken: '', aiProvider: v.aiProvider, anthropicApiKey: '',
      aiModel: v.aiModel, aiHarnessEffort: v.aiHarnessEffort, aiSummaryEffort: v.aiSummaryEffort,
    });
    this.clearFlags.set({ githubToken: false, anthropicApiKey: false });
    this.showGithubToken.set(false);
    this.showAnthropicKey.set(false);
  }

  /** Saves pending changes. Emits the saved view, or null when nothing was saved. Cold: subscribe to run. */
  private save(): Observable<SettingsView | null> {
    if (!this.canSave()) return of(this.hasChanges() ? null : this.saved());
    const update = this.pendingUpdate();
    this.saving.set(true);
    this.saveError.set(null);
    return this.api.updateSettings(update).pipe(
      tap((v) => { this.saved.set(v); this.resetFormFrom(v); this.notifications.success('Settings saved'); }),
      catchError((e: ApiError) => { this.saveError.set(e); return of(null); }),
      finalize(() => this.saving.set(false)),
    );
  }
  protected onSaveClick(): void {
    this.form.markAllAsTouched();
    this.save().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  protected markClear(field: SecretField): void {
    this.clearFlags.update((f) => ({ ...f, [field]: true }));
    this.form.controls[field].setValue('');
    this.form.controls[field].disable();          // getRawValue() still reports ''
    this.form.updateValueAndValidity();
  }
  protected undoClear(field: SecretField): void {
    this.clearFlags.update((f) => ({ ...f, [field]: false }));
    this.form.controls[field].enable();
    this.form.updateValueAndValidity();
  }

  /** "Save & test" when the card has unsaved changes: save first, test only if the save succeeded. */
  protected testGithub(): void {
    const saveFirst = this.githubChangesPending() ? this.save() : of(this.saved());
    this.githubTest.set({ state: 'running' });
    saveFirst.pipe(
      concatMap((v) => (v ? this.api.testGithub() : EMPTY)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (result) => {
        this.githubTest.set({ state: 'ok', result });
        this.saved.update((s) => (s ? { ...s, githubLogin: result.login } : s));   // 05 persists githubLogin
      },
      error: (error: ApiError) => this.githubTest.set({ state: 'error', error }),
      complete: () => { if (this.githubTest().state === 'running') this.githubTest.set({ state: 'idle' }); },  // save failed
    });
  }
  protected testAi(): void {
    const saveFirst = this.aiChangesPending() ? this.save() : of(this.saved());
    this.aiTest.set({ state: 'running' });
    saveFirst.pipe(
      concatMap((v) => (v ? this.api.testAi() : EMPTY)),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: (result) => this.aiTest.set({ state: 'ok', result }),
      error: (error: ApiError) => this.aiTest.set({ state: 'error', error }),
      complete: () => { if (this.aiTest().state === 'running') this.aiTest.set({ state: 'idle' }); },
    });
  }

  protected discard(): void { const s = this.saved(); if (s) { this.resetFormFrom(s); this.saveError.set(null); } }
  protected onBeforeUnload(event: BeforeUnloadEvent): void { if (this.hasChanges()) event.preventDefault(); }
}
```

Template skeleton for one secret field (the API key field is the same with its own signals):

```html
<mat-card class="!rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-md)]">
  <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div>
      <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">GitHub</h3>
      <p class="mt-1 max-w-2xl text-sm text-[var(--color-text-secondary)]">PRVision uses a fine-grained personal access token … </p>
    </div>
    <a mat-stroked-button class="!rounded-xl" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">
      <mat-icon aria-hidden="true">open_in_new</mat-icon> Create a token
    </a>
  </div>
  <div class="flex items-start gap-2">
    <mat-form-field class="w-full">
      <mat-label>Personal access token</mat-label>
      <input matInput formControlName="githubToken" [type]="showGithubToken() ? 'text' : 'password'" name="prvision-github-token"
             autocomplete="new-password" spellcheck="false" autocapitalize="off" [placeholder]="githubPlaceholder()" />
      <button matSuffix mat-icon-button type="button" [attr.aria-pressed]="showGithubToken()"
              [attr.aria-label]="showGithubToken() ? 'Hide token' : 'Show token'" (click)="showGithubToken.set(!showGithubToken())">
        <mat-icon>{{ showGithubToken() ? 'visibility_off' : 'visibility' }}</mat-icon>
      </button>
      @if (clearFlags().githubToken) { <mat-hint>The saved token will be removed when you save.</mat-hint> }
      @else if (githubTokenWarning(); as hint) { <mat-hint>{{ hint }}</mat-hint> }
      @if (form.controls.githubToken.hasError('pattern')) { <mat-error>Remove spaces from the token.</mat-error> }
    </mat-form-field>
    @if (clearFlags().githubToken) {
      <button mat-button type="button" class="!mt-2 !rounded-xl" (click)="undoClear('githubToken')">Undo</button>
    } @else if (showGithubRemove()) {
      <button mat-stroked-button color="warn" type="button" class="!mt-2 !rounded-xl" (click)="markClear('githubToken')">Remove</button>
    }
  </div>
  <div class="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
    <span [class]="githubStatusClass()">{{ githubStatus().label }}</span>
    <button mat-stroked-button type="button" class="!rounded-xl" [disabled]="githubTestDisabled()" (click)="testGithub()">
      @if (githubTest().state === 'running') { <mat-spinner diameter="18" class="!inline-block align-middle mr-2" /> }
      @else { <mat-icon aria-hidden="true">wifi_tethering</mat-icon> }
      {{ githubTestLabel() }}
    </button>
  </div>
  @if (githubTest().state === 'ok') { <app-inline-alert class="mt-3 block" tone="success" title="Connected">{{ githubStatus().label }}.</app-inline-alert> }
  @if (githubTestError(); as err) { <app-inline-alert class="mt-3 block" tone="error" [title]="err.title">{{ err.message }}</app-inline-alert> }
</mat-card>
```

`githubStatusClass = computed(() => 'dd-pill dd-pill--' + githubStatus().tone)` (a plain pill: the label is not an enum value, so `app-status-pill` does not apply). `githubPlaceholder = computed(() => saved()?.hasGithubToken ? 'Saved — leave blank to keep' : 'github_pat_…')`; `showGithubRemove = computed(() => !!saved()?.hasGithubToken && !clearFlags().githubToken && !formValue().githubToken)`. Matching `anthropic*` computeds exist for the key field. The secret fields' `value` is never set from the server: `resetFormFrom` always writes `''`.

#### 5.4.4 Field behaviour and copy

GitHub card:

- Description: "PRVision uses a fine-grained personal access token to list pull requests and fetch their branches. Give it read-only access to **Contents**, **Metadata** and **Pull requests** for the repositories you visualize. It is encrypted on this machine and never shown again." Link "Create a token" → `https://github.com/settings/personal-access-tokens/new` (`target="_blank" rel="noopener noreferrer"`).
- Token input: `type` toggles `password`/`text` via the eye button (`aria-pressed`, `aria-label="Show token"`/"Hide token"); `autocomplete="new-password"`, `spellcheck="false"`, `autocapitalize="off"`, `name="prvision-github-token"`. (as 01 §5.14.4 requires; browsers ignore `off` on password inputs.)
- Label row shows `<span class="dd-pill dd-pill--success">Saved</span>` when `saved().hasGithubToken && !clearFlags().githubToken`.
- Placeholder: saved → "Saved — leave blank to keep"; not saved → "github_pat_…".
- "Remove" (stroked, warn) only when a token is saved and no clear is pending. When pending: field disabled (`markClear`), `<mat-hint>` "The saved token will be removed when you save." and an "Undo" text button (`undoClear`). Remove is shown only when nothing is typed; to replace a token the user just types a new one.
- Non-blocking `githubTokenWarning()` as `<mat-hint>`; `NO_WHITESPACE` error → `<mat-error>` "Remove spaces from the token."
- Status line (left of the Test button): `hasGithubToken && githubLogin` → success pill "Connected as @{{login}}"; `hasGithubToken && !githubLogin` → muted pill "Saved, not tested"; otherwise muted pill "Not configured".
- Test button: label "Save & test" when `githubChangesPending()`, else "Test connection"; disabled when (no saved token and nothing typed) or a clear is pending or `githubTest().state === 'running'` or `saving()`.
- Result (`aria-live` via inline-alert role=status/alert): ok → success "Connected as @login." (`GithubTestResultView.login`); error → `githubTestError()` title/message (`github_token_missing`, `github_unauthorized`, `github_rate_limited`, `github_unavailable`, network).

AI provider card (`settings-copy.ts`):

```ts
export const DEFAULT_AI_MODEL = 'claude-opus-5-5';
export const PROVIDER_OPTIONS: ReadonlyArray<{ value: AiProviderKind; title: string; description: string }> = [
  { value: 'anthropic_api', title: 'Anthropic API key',
    description: 'Calls the Anthropic API directly with your API key. Usage is billed to the account that owns the key.' },
  { value: 'claude_code', title: 'Claude Code (local login)',
    description: 'Uses the Claude Code CLI installed on this machine and the account it is signed in to. Run `claude` once in a terminal to sign in. No key is stored in PRVision.' },
];
export const CLAUDE_CODE_POLICY_NOTE =
  'Personal prototype only. Anthropic does not allow third-party products to route requests through Claude.ai ' +
  'subscription logins. Using your own Claude Code login is acceptable for this local prototype; before PRVision ' +
  'is shared or distributed, this option must switch to API-key authentication or be removed.';
export const THEME_OPTIONS: readonly SegmentOption<ThemeMode>[] = [
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  { value: 'light', label: 'Light', icon: 'light_mode' },
];
export const EFFORT_OPTIONS: ReadonlyArray<{ value: Effort; label: string; hint: string }> = [
  { value: 'low', label: 'Low', hint: 'Fastest, least thorough' },
  { value: 'medium', label: 'Medium', hint: 'Balanced' },
  { value: 'high', label: 'High', hint: 'Thorough (recommended for harnesses)' },
  { value: 'xhigh', label: 'Extra high', hint: 'Slower, more tokens' },
  { value: 'max', label: 'Max', hint: 'Slowest, highest token use' },
];
```

- Provider choice: `mat-radio-group formControlName="aiProvider" aria-label="AI provider"` with two option cards. Each card: `rounded-2xl border p-4` (selected: `border-[color:var(--shell-accent)] bg-[var(--shell-accent-soft)]`), containing `<mat-radio-button [value]>` with the title, and the description below in `text-sm text-[var(--color-text-secondary)]`. Clicking anywhere on the card selects (wrap in `<label>`).
- `claude_code` selected → `<app-inline-alert tone="warning" title="Subscription login">{{ CLAUDE_CODE_POLICY_NOTE }}</app-inline-alert>`. Also, if a key is saved: note "Your saved API key is kept but not used while Claude Code is selected."
- API key field: shown only for `anthropic_api`; same secret behaviour as the GitHub token (Saved pill, placeholder, eye toggle, Remove/Undo, `anthropicKeyWarning()` hint). Group error `anthropicKeyRequired` → `<mat-error>`-styled text under the field: "An API key is required for the Anthropic API provider."
- Model: text input, `<mat-hint>` "Default: claude-opus-5-5. Any model ID your provider accepts."; errors: required → "Enter a model ID."; pattern (`AI_MODEL_PATTERN`, 05's rule) → "Use a model ID such as claude-opus-5-5 (lowercase letters, digits, dots and dashes; no spaces)." "Reset to default" text button sets `DEFAULT_AI_MODEL` (hidden when already default).
- Effort selects: `mat-select` with options from `EFFORT_OPTIONS` (label + hint in the option, label only in the trigger). Hints under fields: harness "Used when writing render harnesses."; summary "Used when writing the AI summary and component notes."
- Test AI button: `aiTestLabel()` ("Save & test" when `aiChangesPending()`, else "Test AI"); `[disabled]="aiTestDisabled()"` (form invalid, running or saving). Result: ok → success alert with `aiTestMessage()` ("claude-opus-5-5 via Anthropic API answered in 1.2 s.", from `AiTestResultView { provider, model, latencyMs }`); error → `aiTestError()` (`ai_not_configured`, `ai_unauthorized` and every other failure show the server message, which sheet 05 writes per provider, e.g. "Claude Code is not signed in or not authorized. Run `claude` in a terminal, sign in, then retry.").

Appearance card: `<app-segmented-control ariaLabel="Theme" [options]="themeOptions" [value]="theme.mode()" (valueChange)="theme.setMode($event)" />` with `protected readonly themeOptions = THEME_OPTIONS`. Applies immediately; not part of Save.

Footer (`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-end`, Uply settings action row): `Discard changes` (stroked, `[disabled]="!hasChanges()"`) and `Save settings` (flat primary, `[disabled]="!canSave()"`, busy "Saving…"). Save error → `@if (saveErrorCopy(); as err) { <app-inline-alert tone="error" [title]="err.title">{{ err.message }} @if (err.details.length) { <ul class="mt-1 list-disc pl-5">@for (d of err.details; track d) { <li>{{ d }}</li> }</ul> } </app-inline-alert> }`.

#### 5.4.5 Unsaved-changes guard

```ts
export const settingsUnsavedChangesGuard: CanDeactivateFn<SettingsPageComponent> = (component) =>
  !component.hasChanges()
    ? true
    : inject(ConfirmDialogService).confirm({
        title: 'Discard unsaved changes?',
        message: 'You have settings changes that are not saved. Leave this page and discard them?',
        confirmText: 'Discard changes',
        cancelText: 'Stay',
        confirmColor: 'warn',
      });
```

`hasChanges` is public (read-only computed) for the guard.

#### 5.4.6 States

| State | UI |
|---|---|
| Loading | Header + `<app-loading-spinner />`. |
| Load error | Header + error alert "Couldn't load settings" + Retry. |
| Loaded, no token, no key | Pills "Not configured"; key required error shows only after the user touches Save (mark form touched on Save click) to avoid shouting on first view. |
| Saving | Save button busy; form stays editable; Test buttons disabled. |
| Saved | Toast "Settings saved"; secret inputs cleared; Saved pills appear. |

### 5.5 Repositories list (`/repositories`)

#### 5.5.1 Layout

```text
Repositories                                                        [+ Add repository]
Local clones of Vite + React projects that PRVision can visualize.

┌ dd-ag-grid-panel ───────────────────────────────────────────────────────────────────┐
│ 3 repositories                                                       [Search rows ] │
│ ┌──────┬─────────────────────────────┬───────────────┬─────────┬──────┬──────────┬─┐ │
│ │ View │ Repository                  │ GitHub        │ Default │ PM   │ Detected │⋮│ │
│ │[Open]│ my-shop                     │ acme/my-shop  │ main    │ pnpm │ Oct 3    │⋮│ │
│ │      │ /home/dev/projects/my-shop      │               │         │      │ 3 min ago│ │ │
│ └──────┴─────────────────────────────┴───────────────┴─────────┴──────┴──────────┴─┘ │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

Empty (no repositories): the grid panel is replaced by

```text
┌ mat-card ───────────────────────────────────────────────────────────────┐
│ [icon] Add your first repository                                        │
│ Point PRVision at a local clone of a Vite + React project. PRVision     │
│ creates its own worktrees; your working copy is never modified.         │
│                                                     [+ Add repository]  │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 5.5.2 Component

`RepositoryListComponent` (`app-repository-list`, host `flex min-h-0 flex-1 flex-col gap-4 overflow-hidden`). Injects `ApiService`, `MatDialog`, `ConfirmDialogService`, `NotificationService`, `Router`, `DestroyRef`.

State: `loading = signal(true)`, `loadError = signal<ApiError | null>(null)`, `repositories = signal<RepositoryView[]>([])`, `busyIds = signal<ReadonlySet<number>>(new Set())`. Input `add = input<string>()` (query param `?add=1` opens the dialog once after the first load). `countLabel` is a `computed`: "1 repository" / "N repositories".

Template outline:

```html
<app-page-header title="Repositories" subtitle="Local clones of Vite + React projects that PRVision can visualize.">
  <button pageHeaderActions mat-flat-button color="primary" type="button" class="!rounded-xl" (click)="openAddDialog()">
    <mat-icon aria-hidden="true">add</mat-icon> Add repository
  </button>
</app-page-header>
@if (loadError(); as err) {
  <app-inline-alert tone="error" title="Couldn't load repositories">{{ err.message }}
    <button inlineAlertAction mat-stroked-button type="button" class="!rounded-xl" (click)="load()">Retry</button>
  </app-inline-alert>
}
@if (!loading() && !loadError() && repositories().length === 0) {
  <!-- first-run card, 5.5.1 (cookbook card; primary button opens the dialog) -->
} @else if (!loadError()) {
  <div class="dd-ag-grid-panel flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-5">
    <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <p class="text-sm text-[var(--color-text-tertiary)]">{{ countLabel() }}</p>
    </div>
    <div class="min-h-0 flex-1 overflow-hidden">
      <app-data-grid [rowData]="repositories()" [columnDefs]="columns" [loading]="loading()" [pagination]="false" [rowHeight]="56"
                     [getRowId]="rowId" [rowClassRules]="rowClassRules" emptyTitle="No repositories"
                     (cellClicked)="onCellClicked($event)" (rowClicked)="onRowClicked($event)" />
    </div>
  </div>
}
```

`rowId = (p: GetRowIdParams<RepositoryView>) => String(p.data.id)`; `rowClassRules = { 'dd-grid-row-clickable': () => true }` (class fields, not template literals).

Columns (`ColDef<RepositoryView>[]`, a `readonly` class field):

| Header | colId | Renderer |
|---|---|---|
| View | `open` | `renderActionButton('open', 'Open', 'primary')`; `onCellClicked` → navigate. |
| Repository | `name` | `renderStackedText(name, localPath)`; flex 1.6; sortable, default `sort: 'asc'`. |
| GitHub | `github` | `owner/repo` via `renderMonospace`, or `renderMutedText('No GitHub remote')`. |
| Default branch | `defaultBranch` | `renderMonospace`. |
| Package manager | `packageManager` | `renderMonospace(pm)` (not `renderPill`, which would title-case "pnpm"). |
| Last detected | `lastDetectedAt` | `renderStackedText(formatDateOnly(v), formatRelativeTime(v))`; sortable. |
| (menu) | `menu` | `ActionMenuCellRendererComponent` with items: `open` (Open, `open_in_new`), `redetect` (Re-detect, `refresh`, disabled while busy), `remove` (Remove, `delete`, tone danger, disabled while busy); `onAction(action, row)`. |

Client-side sorting is enabled on Repository and Last detected only (`sortable: false` in `defaultColDef`). The API returns the array unpaged (00 §14.4); the grid shows all rows (`[pagination]="false"`).

`onRowClicked` ignores clicks whose target is a grid action (`isGridActionTarget(event.event)`).

Actions:

- Re-detect → add id to `busyIds` → `api.redetectRepository(id)` (not silent: errors such as `missing_node_modules` are toasted by the interceptor) → replace row → toast success "Re-detected {{name}}" → `finalize` removes the id.
- Remove → `confirm.confirm({ title: 'Remove repository?', message: 'PRVision will forget "{{name}}". Your local clone is not touched.', confirmText: 'Remove repository', confirmColor: 'warn' }).pipe(filter(Boolean), exhaustMap(() => api.removeRepository(id)), takeUntilDestroyed(...))` → drop row → toast success "Repository removed". A 409 `conflict` ("This repository has visualizations queued or in progress…") is toasted by the interceptor with the server message.
- Add → `openAddDialog()`: `dialog.open<AddRepositoryDialogComponent, void, AddRepositoryDialogResult>(AddRepositoryDialogComponent, GENERIC_POPUP_DIALOG_CONFIG).afterClosed()` → upsert every repository in `result.created`; if `result.openId` is set, navigate to `/repositories/:openId`. `GENERIC_POPUP_DIALOG_CONFIG` is the Uply option set from 12 §6.16.8, exported by `confirm-dialog.service.ts`.

### 5.6 Add repository dialog

Opened by `RepositoryListComponent.openAddDialog()` through `MatDialog` with `GENERIC_POPUP_DIALOG_CONFIG` (12 §6.16.8): Material supplies modal semantics and focus restore, the component's `<app-generic-popup [shouldShow]="true">` supplies Uply's look, the CDK focus trap and Escape. Width `min(560px, calc(100vw - 32px))`; backdrop click and Escape are ignored while submitting.

```ts
type DialogPhase = 'form' | 'submitting' | 'detected';
export interface AddRepositoryDialogResult { created: RepositoryView[]; openId: number | null; }

@Component({
  selector: 'app-add-repository-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ReactiveFormsModule, MatFormFieldModule, MatInputModule, MatIconModule, GenericPopupComponent, InlineAlertComponent],
  templateUrl: './add-repository-dialog.component.html',
})
export class AddRepositoryDialogComponent {
  private readonly dialogRef = inject<MatDialogRef<AddRepositoryDialogComponent, AddRepositoryDialogResult>>(MatDialogRef);
  private readonly fb = inject(NonNullableFormBuilder);
  private readonly api = inject(ApiService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly phase = signal<DialogPhase>('form');
  protected readonly error = signal<ApiError | null>(null);
  protected readonly result = signal<RepositoryView | null>(null);
  private readonly created: RepositoryView[] = [];
  protected readonly form = this.fb.group({
    localPath: this.fb.control('', [Validators.required, Validators.maxLength(4096), Validators.pattern(/^(\/|~\/).+/)]),
    name: this.fb.control('', [Validators.maxLength(200)]),          // 06 RepositoryCreateDTO.name: MaxLength(200)
  });
  protected readonly popupConfig = computed<PopupConfig>(() => this.phase() === 'detected'
    ? { title: 'Repository added', icon: 'check_circle', width: 'min(560px, calc(100vw - 32px))',
        primaryButtonText: 'Open repository', secondaryButtonText: 'Add another' }
    : { title: 'Add repository', icon: 'create_new_folder', width: 'min(560px, calc(100vw - 32px))',
        primaryButtonText: 'Add repository', secondaryButtonText: 'Cancel', loading: this.phase() === 'submitting' });
  protected readonly submitting = computed(() => this.phase() === 'submitting');
  protected readonly errorView = computed(() => {
    const e = this.error();
    return e ? { ...errorCopyFor(e), tip: REJECTION_TIPS[e.errorReason ?? 'internal_error'] ?? null, details: e.details } : null;
  });
  protected readonly detectedRows = computed(() => { const r = this.result(); return r ? toDetectedRows(r, { includeIdentity: true }) : []; });   // rows per the table below

  protected submit(): void {
    if (this.phase() !== 'form') return;
    this.form.markAllAsTouched();
    if (this.form.invalid) return;
    const { localPath, name } = this.form.getRawValue();
    this.phase.set('submitting');
    this.error.set(null);
    this.api.createRepository({ localPath: localPath.trim(), name: name.trim() || undefined })   // silent: rendered inline
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (repo) => { this.created.push(repo); this.result.set(repo); this.phase.set('detected'); },
        error: (e: ApiError) => { this.error.set(e); this.phase.set('form'); },
      });
  }
  protected onPrimary(): void {
    const r = this.result();
    if (this.phase() === 'detected' && r) this.close(r.id); else this.submit();
  }
  protected onSecondary(): void {
    if (this.phase() === 'detected') { this.form.reset(); this.result.set(null); this.error.set(null); this.phase.set('form'); }
    else this.close(null);
  }
  /** closePopup from generic-popup (X, Escape, backdrop). Ignored while a request is in flight. */
  protected onCloseRequested(): void { if (!this.submitting()) this.close(null); }
  private close(openId: number | null): void { this.dialogRef.close({ created: [...this.created], openId }); }
}
```

Template root: `<app-generic-popup [shouldShow]="true" [config]="popupConfig()" [closeOnBackdrop]="!submitting()" [closeOnEscape]="!submitting()" (primaryAction)="onPrimary()" (secondaryAction)="onSecondary()" (closePopup)="onCloseRequested()">`. `REJECTION_TIPS: Partial<Record<ApiErrorReason, string>>` holds the extra lines in the table below.

Form phase content:

```text
Local path *          [ /home/you/dev/my-app                         ]   (cdkFocusInitial)
                      Absolute path to the root of a local git clone (the folder with .git).
Display name          [ my-app                                       ]
                      Optional. Defaults to the folder name.
┌ inset note ────────────────────────────────────────────────────────────────┐
│ PRVision reads this folder and creates its own git worktrees under          │
│ ~/.prvision. Your working copy is never modified. node_modules must be      │
│ installed; it is linked, not copied.                                        │
└────────────────────────────────────────────────────────────────────────────┘
[error alert, if any]
```

Validation messages: required → "Enter the folder path."; pattern → "Use an absolute path starting with / or ~/."; maxLength → "Path is too long." Enter in the path field submits (`(keydown.enter)`).

Rejection rendering: `@if (errorView(); as err) { <app-inline-alert tone="error" [title]="err.title">{{ err.message }} … tip / details … </app-inline-alert> }` inside the dialog (the request is silent, so there is no toast). Copy from `ERROR_REASON_COPY` plus these extra lines (`REJECTION_TIPS`):

| `error_reason` | Extra line under the message |
|---|---|
| `not_git_repo` | "Tip: run `git rev-parse --show-toplevel` inside the project to find the root." |
| `unsupported_framework` | "Supported in this prototype: Vite + React with Tailwind, CSS modules or plain CSS/SCSS." |
| `missing_node_modules` | "PRVision links your existing node_modules into its worktrees, so they must be installed first." |
| `validation_failed` | Server message, then `details` as a bullet list (e.g. "localPath must be an absolute folder path"). |
| `conflict` (409, folder already registered) | Server message only (e.g. "This folder is already registered as "my-shop" (id 3)"). Sheet 06 §5.5 sends this as 409 `conflict` (also for the concurrent-insert race). |
| other / network | message only. |

Detected phase content (definition list, sheet 12 §6.20 pattern; rows from the `detectedRows` computed, `@for (row of detectedRows(); track row.label)`):

| Label | Value |
|---|---|
| Name | `name` |
| Path | `localPath` (`pv-code`) |
| Framework | "React + Vite" for `react_vite` |
| Package manager | `packageManager` |
| Default branch | `defaultBranch` (`pv-code`) |
| GitHub | `owner/repo` or "No GitHub remote (pull requests unavailable)" |
| Vite config | `viteConfigPath` or "Not found" |
| tsconfig | `tsconfigPath` or "Not found" |
| Entry file | `entryFilePath` or "Not found" |
| Global styles | `globalStylePaths` joined by line breaks, or "None found" |

If `githubOwner` is null, add an info alert: "Pull requests need a GitHub remote. Local branches and the working tree still work."

### 5.7 Repository detail (`/repositories/:id`)

> **Superseded in part by 00 §16 (Revision 4).** The Pull requests / Local tabs (§5.7.4, §5.7.5, and the tab parts of
> §5.7.1 and §5.7.2, including `?tab=`) were removed. A **New visualization** button next to Re-detect and Remove opens
> `app-new-visualization-dialog` (`features/repositories/components/new-visualization-dialog/`), a MatDialog stepper
> (Source → Select → Review & start) that folds in the PR list and branch selects and adds commit ranges. Build notes:
> `docs/build-notes/rev4.md`.

#### 5.7.1 Layout

```text
← my-shop                                                     [⟳ Re-detect] [🗑 Remove]
/home/dev/projects/my-shop
[acme/my-shop ↗] [pnpm] [default: main]

┌ Project detection ─────────────────────────┐ ┌ Recent visualizations ─────────────────┐
│ Framework       React + Vite               │ │ [Completed] Fix cart totals    PR #42  │
│ Vite config     vite.config.ts             │ │             2 hr ago                    │
│ tsconfig        tsconfig.json              │ │ [Rendering•] feature/x vs main  Branch │
│ Entry file      src/main.tsx               │ │             just now                    │
│ Global styles   src/index.css              │ │ …                         [View all →] │
│ Last detected   3 min ago                  │ └────────────────────────────────────────┘
└────────────────────────────────────────────┘

[ Pull requests (4) | Local ]                                        ← mat-tab-group

Pull requests tab:
┌ mat-card ───────────────────────────────────────────────────────────────────────────┐
│ Open pull requests                                                      [⟳ Refresh] │
│ ┌─────┬──────────────────────────────┬──────────────────────┬──────────┬───────────┐ │
│ │ #   │ Title                        │ Branches             │ Updated  │           │ │
│ │ 42  │ Fix cart totals [Draft]      │ fix/cart → main      │ 2 hr ago │[Visualize]│ │
│ │     │ by octocat                   │                      │          │ [↗]       │ │
│ └─────┴──────────────────────────────┴──────────────────────┴──────────┴───────────┘ │
└─────────────────────────────────────────────────────────────────────────────────────┘

Local tab:
┌ Compare branches ──────────────────────────┐ ┌ Working tree ───────────────────────────┐
│ Render a local branch against a base.      │ │ Uncommitted changes on feature/x        │
│ Head branch  [ feature/x        ▾ ]        │ │ Compares your uncommitted edits with    │
│ Base branch  [ main             ▾ ]        │ │ the last commit (HEAD).                 │
│                         [▶ Visualize]      │ │ [● Changes detected]     [▶ Visualize]  │
└────────────────────────────────────────────┘ │ (clean: "Working tree is clean —        │
                                               │  nothing to visualize." + disabled)     │
                                               └─────────────────────────────────────────┘
```

Grid: `grid gap-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]` for the two top cards; tabs full width below.

#### 5.7.2 Component tree and state

```text
RepositoryDetailComponent (host 'flex flex-col gap-6')
├─ app-not-found-page                     (invalid id or 404)
├─ app-loading-spinner / app-inline-alert (first load / load error + Retry)
├─ app-page-header (title=name, subtitle=localPath, backLink=/repositories; meta: GitHub link pill, PM pill, default-branch pill; actions)
├─ app-detection-card [repository]
├─ app-recent-visualizations [repositoryId]
└─ mat-tab-group [selectedIndex]="selectedTabIndex()" (selectedIndexChange)="onTabChange($event)" mat-stretch-tabs="false"
   ├─ tab "Pull requests" (lazy matTabContent) → app-pull-request-table [repository]
   └─ tab "Local"         (lazy matTabContent) → app-local-sources [repository]
```

```ts
@Component({
  selector: 'app-repository-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './repository-detail.component.html',
  host: { class: 'flex flex-col gap-6' },
  imports: [/* page header, inline alert, spinner, not-found, MatTabsModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule, detection card, recent visualizations, PR table, local sources */],
})
export class RepositoryDetailComponent {
  readonly id = input.required<string>();
  readonly tab = input<string>();                       // ?tab=local | ?tab=pulls
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly title = inject(Title);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly repositoryId = computed(() => parseRouteId(this.id()));
  protected readonly repository = signal<RepositoryView | null>(null);
  protected readonly loading = signal(true);
  protected readonly loadError = signal<ApiError | null>(null);
  protected readonly notFound = signal(false);
  protected readonly redetecting = signal(false);
  protected readonly removing = signal(false);
  protected readonly githubUrl = computed(() => {
    const r = this.repository();
    const ok = (v: string | null): v is string => !!v && /^[\w.-]+$/.test(v);
    return r && ok(r.githubOwner) && ok(r.githubRepo) ? `https://github.com/${r.githubOwner}/${r.githubRepo}` : null;
  });
  protected readonly selectedTabIndex = computed(() => {
    const t = this.tab();
    if (t === 'local') return 1;
    if (t === 'pulls') return 0;
    return this.githubUrl() ? 0 : 1;                    // no remote → Local by default
  });
  private readonly load$ = new Subject<number>();

  constructor() {
    // switchMap: navigating to another repository id cancels the previous load.
    this.load$.pipe(
      tap(() => { this.loading.set(true); this.loadError.set(null); this.notFound.set(false); }),
      switchMap((id) => this.api.getRepository(id).pipe(
        map((repo) => ({ repo, error: null })),
        catchError((error: ApiError) => of({ repo: null, error })),
      )),
      takeUntilDestroyed(this.destroyRef),
    ).subscribe(({ repo, error }) => {
      this.loading.set(false);
      if (repo) { this.repository.set(repo); setPageTitle(this.title, repo.name); }
      else if (error?.isNotFound) this.notFound.set(true);
      else this.loadError.set(error);
    });
    effect(() => {
      const id = this.repositoryId();
      untracked(() => (id === null ? this.notFound.set(true) : this.load$.next(id)));
    });
  }
  protected retry(): void { const id = this.repositoryId(); if (id !== null) this.load$.next(id); }
  protected onTabChange(index: number): void {
    void this.router.navigate([], { queryParams: { tab: index === 1 ? 'local' : 'pulls' }, queryParamsHandling: 'merge', replaceUrl: true });
  }
  protected redetect(): void { /* busy redetecting; api.redetectRepository (interceptor toasts errors) → repository.set → toast "Detection refreshed" */ }
  protected remove(): void { /* confirm (as list) → filter(Boolean) → exhaustMap(api.removeRepository) → toast "Repository removed" → navigate /repositories */ }
}
```

Header meta: GitHub pill is an `<a>` (`dd-pill dd-pill--outline`, icon `open_in_new`, `[href]="githubUrl()"`, `target="_blank" rel="noopener noreferrer"`) when `githubUrl()` is set; otherwise `dd-pill dd-pill--muted` "No GitHub remote". Package manager and default branch are `dd-pill dd-pill--outline` pills with the raw value (`pnpm`, `default: main`). Page title: `setPageTitle(title, repository.name)`.

Actions: Re-detect (stroked, busy) → `api.redetectRepository` → `repository.set` → toast "Detection refreshed" (errors toasted by the interceptor; the old values stay). Remove (stroked warn) → same confirm as the list → `api.removeRepository` → toast "Repository removed" → navigate `/repositories`; a 409 `conflict` while a run is active is toasted by the interceptor with the server message.

404 → `<app-not-found-page title="Repository not found" message="It may have been removed." backLink="/repositories" backLabel="Back to repositories" />`.

#### 5.7.3 `app-detection-card`

Selector `app-detection-card`, inline template, no outputs. Input `repository = input.required<RepositoryView>()`; `rows = computed(() => toDetectedRows(repository(), { includeIdentity: false }))`. Card (12 §6.20) with the definition list from §5.6 minus Name/Path, plus "Last detected" (`relativeTime`, title=`dateTime`). A missing Vite config or entry file renders the value "Not found" in `text-[var(--color-warning)]` with a small `warning` icon and the tooltip "Rendering may fail without it. Fix the project, then Re-detect."

#### 5.7.4 `app-pull-request-table`

Inputs: `repository = input.required<RepositoryView>()`. Injects `ApiService`, `VisualizationLauncherService`, `DestroyRef`. State: `prs = signal<PullRequestView[] | null>(null)`, `loading = signal(false)`, `error = signal<ApiError | null>(null)`, `launchingPr = signal<number | null>(null)`. Derived: `hasRemote = computed(() => !!repository().githubOwner && !!repository().githubRepo)`; `errorCopy = computed(() => error() ? errorCopyFor(error()) : null)` (use a local const to narrow); `rows` is a `computed` view model over `prs()`: `{ pr, safeUrl, visualizeLabel, openLabel }` where `safeUrl` is `pr.url` when `isSafeGithubUrl(pr.url)` else `null`, `visualizeLabel` is "Visualize pull request #42" and `openLabel` is "Open pull request #42 on GitHub".

Load in the constructor (the tab content is lazy, so it loads on first activation) and on the card's Refresh icon button: `loading.set(true)` → `api.listPullRequests(id)` (silent) → `prs.set` / `error.set` → `finalize` clears loading; `takeUntilDestroyed`. A Refresh click while loading is ignored. If `!hasRemote()`, do not call the API; render the `no_github_remote` state directly.

States:

| Condition | UI |
|---|---|
| Loading | `<app-loading-spinner />` inside the card. |
| `no_github_remote` (or no owner/repo) | `<app-empty-state title="No GitHub remote" message="Pull requests need a GitHub remote. Use the Local tab for branches and uncommitted changes." />` |
| `github_token_missing` | `<app-inline-alert tone="warning" title="GitHub token needed">…<a mat-stroked-button inlineAlertAction routerLink="/settings">Open settings</a>` |
| `github_unauthorized` | Same with `tone="error"` and copy from `ERROR_REASON_COPY`. |
| `github_rate_limited` / `github_unavailable` / `no_github_remote` from the API | Warning alert with the copy + Retry. |
| Other error | Error alert + Retry. |
| Empty list | `<app-empty-state title="No open pull requests" message="Open a pull request on GitHub, then refresh." />` |
| Rows | Table below. |

Table (semantic, Uply table styling inside the card):

```html
<div class="overflow-x-auto">
  <table class="w-full min-w-[44rem] text-sm">
    <caption class="sr-only">Open pull requests for {{ repository().name }}</caption>
    <thead>
      <tr class="border-b border-[color:var(--color-border)] text-left text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        <th scope="col" class="py-2 pr-3">#</th><th scope="col" class="py-2 pr-3">Title</th>
        <th scope="col" class="py-2 pr-3">Branches</th><th scope="col" class="py-2 pr-3">Updated</th>
        <th scope="col" class="py-2 text-right"><span class="sr-only">Actions</span></th>
      </tr>
    </thead>
    <tbody>
      @for (row of rows(); track row.pr.number) { @let pr = row.pr;
        <tr class="border-b border-[color:var(--color-border)] last:border-b-0 hover:bg-[var(--color-surface-hover)]">
          <td class="py-3 pr-3 align-top font-semibold tabular-nums text-[var(--color-text-secondary)]">{{ pr.number }}</td>
          <td class="py-3 pr-3 align-top">
            <div class="flex flex-wrap items-center gap-2">
              <span class="font-semibold text-[var(--color-text-primary)]">{{ pr.title }}</span>
              @if (pr.draft) { <span class="dd-pill dd-pill--muted">Draft</span> }
            </div>
            <div class="mt-0.5 text-xs text-[var(--color-text-tertiary)]">by {{ pr.author }}</div>
          </td>
          <td class="py-3 pr-3 align-top"><span class="pv-code text-xs">{{ pr.headRef }} → {{ pr.baseRef }}</span></td>
          <td class="py-3 pr-3 align-top text-[var(--color-text-secondary)]" [title]="pr.updatedAt | dateTime">{{ pr.updatedAt | relativeTime }}</td>
          <td class="py-3 align-top">
            <div class="flex justify-end gap-2">
              <button mat-flat-button color="primary" type="button" class="!rounded-xl" [disabled]="launchingPr() !== null"
                      (click)="visualize(pr)" [attr.aria-label]="row.visualizeLabel">
                @if (launchingPr() === pr.number) { <mat-spinner diameter="18" class="!inline-block align-middle mr-2" /> } @else { <mat-icon>play_arrow</mat-icon> }
                {{ launchingPr() === pr.number ? 'Starting…' : 'Visualize' }}
              </button>
              @if (row.safeUrl; as url) {
                <a mat-icon-button [href]="url" target="_blank" rel="noopener noreferrer"
                   [attr.aria-label]="row.openLabel" matTooltip="Open on GitHub"><mat-icon aria-hidden="true">open_in_new</mat-icon></a>
              }
            </div>
          </td>
        </tr>
      }
    </tbody>
  </table>
</div>
```

`visualize(pr)`: return if `launchingPr() !== null`; `launchingPr.set(pr.number)`; `launcher.launch({ repositoryId: repository().id, sourceType: 'github_pr', prNumber: pr.number }, label).pipe(finalize(() => launchingPr.set(null)), takeUntilDestroyed(destroyRef)).subscribe()` with label "PR #42 · Fix cart totals" (navigation already happened on success).

#### 5.7.5 `app-local-sources`

Input `repository = input.required<RepositoryView>()`. Injects `ApiService`, `VisualizationLauncherService`, `NonNullableFormBuilder`, `DestroyRef`, `DOCUMENT`. State: `branches = signal<BranchListView | null>(null)`, `loading = signal(false)`, `error = signal<ApiError | null>(null)`, `launching = signal<'branch' | 'working_tree' | null>(null)`; typed form `form = this.fb.group({ head: this.fb.control(''), base: this.fb.control('') })`; `formValue = toSignal(form.valueChanges.pipe(map(() => form.getRawValue())), { initialValue: form.getRawValue() })`.

Derived (all `computed`): `sameBranch` (`head && head === base`); `canVisualizeBranch` (`!!head && !!base && !sameBranch && launching() === null && !loading()`); `branchOptions` (`branches.map((name) => ({ name, checkedOut: name === current }))`); `workingTreeSubtitle` ("Uncommitted changes on feature/x" or "Uncommitted changes on detached HEAD"); `dirty` (`branches()?.workingTreeDirty ?? false`); `canVisualizeWorkingTree` (`dirty && launching() === null && !loading()`).

- Loading uses one `reload$ = new Subject<void>()` piped through `exhaustMap(() => api.listBranches(id).pipe(catchError(...)))` and `takeUntilDestroyed`, fed by: the constructor (initial load), the card Refresh icon button, and `fromEvent(document.defaultView ?? window, 'focus').pipe(debounceTime(500))` so the working-tree state stays current while the user edits code in another window. `exhaustMap` ignores focus events while a request is in flight.
- After the first successful load only, initialize the form: `base = defaultBranch`; `head = current` if `current` exists and differs from `defaultBranch`, else the first branch that is not `defaultBranch`, else `''`. Later reloads keep the user's choices (reset a choice only if that branch disappeared).
- Branch selects: `mat-select formControlName` with `@for (o of branchOptions(); track o.name)` options; the checked-out branch shows a muted "(checked out)" suffix.
- Visualize (branch): `[disabled]="!canVisualizeBranch()"`. `<mat-hint>` when `sameBranch()`: "Choose two different branches." Launch: `{ repositoryId, sourceType: 'local_branch', headRef: head, baseRef: base }` (00 §14.4 field names), label "feature/x vs main".
- Working tree card:
  - Title "Working tree"; subtitle `workingTreeSubtitle()`; description "Compares your uncommitted edits, including untracked files, with the checked-out commit."
  - Dirty → `dd-pill dd-pill--warning` "Changes detected" + enabled Visualize.
  - Clean → `dd-pill dd-pill--muted` "Clean" + disabled Visualize + `<p id="wt-clean-{{repository().id}}">Working tree is clean — nothing to visualize.</p>`; the button has `aria-describedby` pointing at it.
  - Launch: `{ repositoryId, sourceType: 'working_tree' }` (no `baseRef`), label "working tree on feature/x" (or "on HEAD"). When it emits `null` (an error was handled by the launcher, e.g. `working_tree_clean` → info toast), the component reloads branches.
- Both launches: guard `launching() === null`, set `launching`, `launcher.launch(...).pipe(finalize(() => launching.set(null)), takeUntilDestroyed(...))`.
- Branch list error → inline error alert (`errorCopyFor`) + Retry; both cards' buttons disabled. Empty branch list → `<app-empty-state title="No local branches found" message="Create a branch in the clone, then refresh." />`.

#### 5.7.6 `app-recent-visualizations`

Input `repositoryId = input.required<number>()`. Loads `api.listVisualizations({ repositoryId, page: 1, pageSize: RECENT_VISUALIZATIONS_LIMIT })` (silent; failure → muted text "Couldn't load recent visualizations." + a Retry text button). Renders a `ul` from a computed `rows` view model (`{ v, source: sourceLabel(v) }`, `track row.v.id`): status pill (`kind="visualization"`), title link (`[routerLink]="['/visualizations', row.v.id]"`), `row.source`, `row.v.createdAt | relativeTime`. Loading → `<app-loading-spinner [inline]="true" [diameter]="24" />`. Empty → `<app-empty-state title="No visualizations yet" message="Visualize a pull request, branch or the working tree below." />`. Footer link "View all →" `routerLink="/visualizations" [queryParams]="viewAllParams()"` (`computed(() => ({ repositoryId: repositoryId() }))`). No polling (the list is a snapshot; a Refresh icon button reloads).

### 5.8 Visualizations history (`/visualizations`)

#### 5.8.1 Layout

```text
Visualizations
Every pull request, branch and working-tree run, newest first.

┌ dd-ag-grid-panel ──────────────────────────────────────────────────────────────────────────┐
│ 128 visualizations          [Repository: my-shop ✕]  [⚲ Status: All ▾]  [⟳ Refresh]         │
│ ┌──────┬─────────────────────────┬────────────┬──────────────────┬───────────┬──────┬─────┬─┐ │
│ │ View │ Visualization           │ Source     │ Refs             │ Status    │ Comp │ Crt │⋮│ │
│ │[Open]│ Fix cart totals         │ [PR #42]   │ main ← fix/cart  │[Completed]│ 5/12 │ 2h  │⋮│ │
│ │      │ my-shop                 │            │                  │           │chg'd │     │ │ │
│ └──────┴─────────────────────────┴────────────┴──────────────────┴───────────┴──────┴─────┴─┘ │
│                                                   Page size [20▾]  1–20 of 128  ‹ ›          │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### 5.8.2 Component

`VisualizationListComponent` (`app-visualization-list`, host `flex min-h-0 flex-1 flex-col gap-4 overflow-hidden`). Inputs from query params: `status = input<string>()` (one of `in_progress`, `completed`, `failed`, `cancelled`), `repositoryId = input<string>()`.

```ts
type StatusFilter = 'all' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
interface StatusFilterOption { value: StatusFilter; label: string; statuses?: readonly VisualizationStatus[]; }
const IN_PROGRESS: readonly VisualizationStatus[] =
  ['queued', 'preparing', 'analyzing', 'generating_harnesses', 'rendering', 'diffing', 'summarizing'];
const ALL_FILTER: StatusFilterOption = { value: 'all', label: 'All' };
const STATUS_FILTERS: readonly StatusFilterOption[] = [
  ALL_FILTER,
  { value: 'in_progress', label: 'In progress', statuses: IN_PROGRESS },
  { value: 'completed', label: 'Completed', statuses: ['completed'] },
  { value: 'failed', label: 'Failed', statuses: ['failed'] },
  { value: 'cancelled', label: 'Cancelled', statuses: ['cancelled'] },
];

export class VisualizationListComponent {
  readonly status = input<string>();
  readonly repositoryId = input<string>();
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly statusFilters = STATUS_FILTERS;
  protected readonly statusFilter = computed<StatusFilterOption>(() =>
    STATUS_FILTERS.find((f) => f.value === this.status()) ?? ALL_FILTER);
  protected readonly repoFilter = computed(() => parseRouteId(this.repositoryId()));
  protected readonly repoFilterName = signal<string | null>(null);   // api.getRepository(id), silent; falls back to "#<id>"
  protected readonly hasFilters = computed(() => this.statusFilter().value !== 'all' || this.repoFilter() !== null);
  protected readonly total = signal<number | null>(null);
  protected readonly countLabel = computed(() => { const t = this.total(); return t === null ? '… visualizations' : `${t} visualization${t === 1 ? '' : 's'}`; });
  protected readonly emptyTitle = computed(() => (this.hasFilters() ? 'Nothing matches these filters' : 'No visualizations yet'));
  protected readonly emptyMessage = computed(() => (this.hasFilters()
    ? 'Clear the filters to see every visualization.'
    : 'Open a repository and visualize a pull request, branch or the working tree.'));
  private readonly manualRefresh = signal(0);
  protected readonly refreshKey = computed(() => `${this.statusFilter().value}|${this.repoFilter() ?? ''}|${this.manualRefresh()}`);
  protected readonly defaultColDef: ColDef = { sortable: false };
  protected readonly pageSize = DEFAULT_PAGE_SIZE;
  protected readonly pageSizeOptions = PAGE_SIZE_OPTIONS;

  protected readonly pageLoader: DataGridPageLoader<VisualizationSummaryView> = (req) =>
    this.api
      .listVisualizations({ page: req.page, pageSize: req.pageSize, statuses: this.statusFilter().statuses,
                            repositoryId: this.repoFilter() ?? undefined })
      .pipe(tap((p) => this.total.set(p.total)), map((p) => ({ items: p.items, total: p.total })));

  protected setStatusFilter(value: StatusFilter): void {
    void this.router.navigate([], { queryParams: { status: value === 'all' ? null : value }, queryParamsHandling: 'merge' });
  }
  protected clearRepoFilter(): void {
    void this.router.navigate([], { queryParams: { repositoryId: null }, queryParamsHandling: 'merge' });
  }
  protected refresh(): void { this.manualRefresh.update((n) => n + 1); }
}
```

The repo-filter name loads in an `effect` on `repoFilter()` through a `Subject` + `switchMap(api.getRepository)` pipeline (same shape as the repository detail load), so changing the query param cancels a stale request.

Template outline: page header (title "Visualizations", subtitle "Every pull request, branch and working-tree run, newest first."), then `<div class="dd-ag-grid-panel flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-5">` with the toolbar row and `<div class="min-h-0 flex-1 overflow-hidden"><app-data-grid [serverPagination]="true" [serverPageLoader]="pageLoader" [serverRefreshKey]="refreshKey()" [pageSize]="pageSize" [pageSizeOptions]="pageSizeOptions" [searchEnabled]="false" [rowHeight]="56" [columnDefs]="columns" [defaultColDef]="defaultColDef" [rowClassRules]="rowClassRules" [emptyTitle]="emptyTitle()" [emptyMessage]="emptyMessage()" (cellClicked)="onCellClicked($event)" (rowClicked)="onRowClicked($event)" /></div>` (Uply monitor list structure).

Columns (all `sortable: false`; server order is `createdAt` desc):

| Header | colId | Renderer |
|---|---|---|
| View | `open` | `renderActionButton('open', 'Open', 'primary')` |
| Visualization | `title` | `renderStackedText(title, repositoryName)`, flex 1.6 |
| Source | `sourceType` | `renderStatusPillHtml('source', sourceType, sourceLabel(row))` |
| Refs | `refs` | `renderMonospace(refsLabel(row))` |
| Status | `status` | `renderStatusPillHtml('visualization', status)` |
| Components | `components` | completed: `renderStackedText("5 changed", "of 12")`; otherwise `renderMutedText("12 found")`, or `'—'` when `componentCount` is 0 |
| Created | `createdAt` | `renderStackedText(formatDateTime(createdAt), formatRelativeTime(createdAt))` |
| (menu) | `menu` | `open`; `cancel` (Cancel, `stop_circle`, only non-terminal); `delete` (Delete, `delete`, danger, only terminal). Items come from `actions: (row) => …` so they follow the row's status. |

Toolbar (`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`): count label `countLabel()` in `text-sm text-[var(--color-text-tertiary)]`; repository chip when `repoFilter()` (`dd-pill dd-pill--outline` with a close icon button `aria-label="Clear repository filter"`); status menu button (`mat-stroked-button !h-10 !rounded-xl`, `filter_list` icon, label "Status: {{ statusFilter().label }}", `mat-menu xPosition="before"` items from `statusFilters` with a `check` icon on the selected one — Uply monitor list filter); Refresh icon button (`aria-label="Refresh"`, tooltip).

Row actions:

- Cancel → confirm (same copy as §5.9.4) → `filter(Boolean)`, `exhaustMap(() => api.cancelVisualization(id))` (silent) → response `status: 'cancelled'` → toast info "Visualization cancelled." (same text as the detail store); `'cancel_requested'` → toast info "Cancellation requested. The pipeline stops at its next checkpoint." → `refresh()`. Error `already_terminal` → toast info "This visualization had already finished." → `refresh()`; any other error → `notifications.error(userMessageFor(e))` (the call is silent, so this is the only toast).
- Delete → confirm `{ title: 'Delete visualization?', message: 'Screenshots, diffs and the summary for "{{title}}" will be deleted. This cannot be undone.', confirmText: 'Delete', confirmColor: 'warn' }` → `exhaustMap(() => api.removeVisualization(id))` (not silent: errors, including 409 `conflict` for a run that is still active, are toasted by the interceptor) → toast success "Visualization deleted" → `refresh()`.

There is no automatic refresh on this page (00 §12 polls only detail and console). The Refresh button is the update path.

### 5.9 Visualization detail (`/visualizations/:id`)

#### 5.9.1 Layout

```text
← Fix cart totals rounding                                         [■ Cancel]  (non-terminal)
                                                                   [🗑 Delete] (terminal)
[Pull request] PR #42 · my-shop · main @ a1b2c3d ← fix/cart @ d4e5f6a   [Rendering •]
Started Oct 3, 12:01 PM · claude-opus-5-5 via Anthropic API · 41.2K in / 3.1K out tokens

┌ mat-card: Pipeline ───────────────────────────────────────────────────────────────────────┐
│ ✓ Queued ── ✓ Preparing ── ✓ Analyzing ── ✓ Harnesses ── ◉ Rendering ── ○ Diffing ── ○ Summ. │
└───────────────────────────────────────────────────────────────────────────────────────────┘
[warning: Lost connection to the PRVision API. Retrying every 2 s…]          (connectionLost)
[error: Failed during Rendering — <errorMessage>]                            (failed; stage from failedStage)
[warning: Cancelled during Rendering — results finished before it are below] (cancelled)

┌ pv-console (Uply run console) ────────────────────────────────────────────────────────────┐
│ ▾ Pipeline console                          [All | Issues]  [Copy]  [● Live]             │
│   128 events                                                                               │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│ 12:01:03  INFO   [rendering] Rendered CartSummary head in 812 ms                            │
│ 12:01:04  WARN   [rendering] CartBadge: console error "Missing provider" (mocked)           │
│ …                                                                    [↓ Jump to latest]    │
└───────────────────────────────────────────────────────────────────────────────────────────┘

┌ AI summary ─────────────────────────────────────┐ ┌ Components ───┐ ┌ Changed ──────┐
│ ## What changed                                  │ │ 12            │ │ 5             │
│ - CartSummary total now …                        │ ├ Unchanged ────┤ ├ Failed ───────┤
│ (markdown, .pv-prose)                            │ │ 6             │ │ 1             │
└──────────────────────────────────────────────────┘ └───────────────┘ └───────────────┘

Components                         [ Changed 5 | Unchanged 6 | Failed 1 | All 12 ]
┌ component card ───────────────────────────────────────────────────────────────────────────┐
│ #1  CartSummary                    [Modified] [Changed · 4.2%] [Check]                       │
│ src/components/CartSummary.tsx  [copy]                                                      │
│ Changed because: imports changed hook src/hooks/useCart.ts   (changeReason, affected_parent) │
│ ┃ AI: Total now wraps onto two lines at narrow widths; check the mobile layout.             │
│ [Side by side | Slider | Diff]                                      [Fit | 100%]             │
│ ┌ Base ─────────────────────────────┐ ┌ Head ─────────────────────────────┐                  │
│ │           (screenshot)            │ │           (screenshot)            │                  │
│ └───────────────────────────────────┘ └───────────────────────────────────┘                  │
│ ▸ Code diff                                                       +12 −3                    │
│ ▸ Structural changes                                              4                         │
│ ▸ Render harness                                                  2 mocked modules · notes  │
└───────────────────────────────────────────────────────────────────────────────────────────┘
(next cards…)
```

Responsive: summary + stat tiles use `grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]`; tiles are `grid grid-cols-2 gap-3`. Side-by-side images stack below `md`. The stepper becomes a vertical list below `md`.

#### 5.9.2 Component tree

```text
VisualizationDetailComponent  (providers: [VisualizationDetailStore])
├─ app-not-found-page                      (invalid id or 404)
├─ app-loading-spinner / app-inline-alert  (first load / first-load error)
├─ app-page-header  (title, backLink=/visualizations; meta pills; actions Cancel/Delete)
├─ app-pipeline-stepper [status] [stoppedStageIndex]
├─ app-inline-alert × (connection lost | failed | cancelled)
├─ app-console-panel [events] [live] [trimmed] [defaultOpen]
├─ app-summary-card [markdown] [status] [aiModel]
├─ stat tiles (inline markup)
├─ app-segmented-control (component filter)
└─ @for component → app-component-card [component] [runActive]
     ├─ app-image-compare
     ├─ <details> app-code-diff
     ├─ <details> app-structural-diff-list
     └─ <details> app-harness-panel
```

#### 5.9.3 Store: `VisualizationDetailStore`

Provided by the component (`providers: [VisualizationDetailStore]`), so it is created and destroyed with the page and its `DestroyRef` stops all polling on navigation away.

```ts
// ComponentFilter is declared in component-filters.ts (no import cycle between store and filters).
export type DetailLoadState = 'loading' | 'ready' | 'not_found' | 'error';
type DetailTick = { ok: true; detail: VisualizationDetailView } | { ok: false; error: ApiError };

@Injectable()
export class VisualizationDetailStore {
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
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

  readonly status = computed(() => this.detail()?.status ?? null);
  readonly isTerminal = computed(() => { const s = this.status(); return s !== null && isTerminalStatus(s); });
  readonly connectionLost = computed(() => this.consecutivePollFailures() >= POLL_FAILURE_BANNER_THRESHOLD);
  readonly components = computed(() =>
    [...(this.detail()?.components ?? [])].sort((a, b) => a.rank - b.rank || a.id - b.id));
  readonly counts = computed(() => countComponents(this.components()));
  readonly defaultFilter = computed<ComponentFilter>(() => {
    const c = this.counts();
    return c.changed > 0 ? 'changed' : c.failed > 0 ? 'failed' : 'all';
  });
  readonly filter = computed<ComponentFilter>(() => this.chosenFilter() ?? this.defaultFilter());
  readonly filteredComponents = computed(() => this.components().filter(COMPONENT_FILTER_PREDICATES[this.filter()]));
  /** failedStage from the API (00 §14.4) wins; console inference only when it is null. */
  readonly stoppedStageIndex = computed(() => resolveStoppedStageIndex(this.detail()?.failedStage ?? null, this.consoleEvents()));
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

  markNotFound(): void { this.restart$.next(); this.loadState.set('not_found'); }
  setFilter(filter: ComponentFilter): void { this.chosenFilter.set(filter); }
  refreshNow(): void { const id = this.visualizationId(); if (id !== null) this.start(id); }

  private pollDetail(id: number): void {
    timer(0, VISUALIZATION_POLL_MS)
      .pipe(
        // exhaustMap: a tick while the previous GET is in flight is skipped (no overlap, no cancel-starvation).
        exhaustMap(() =>
          this.api.getVisualization(id).pipe(
            map((detail): DetailTick => ({ ok: true, detail })),
            catchError((error: ApiError) => of<DetailTick>({ ok: false, error })),
          ),
        ),
        tap((r) => (r.ok ? this.onDetail(r.detail) : this.onDetailError(r.error))),
        takeWhile((r) => (r.ok ? !isTerminalStatus(r.detail.status) : !r.error.isNotFound), true),
        takeUntil(this.restart$),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private pollConsole(id: number): void {
    timer(0, CONSOLE_POLL_MS)
      .pipe(
        exhaustMap(() => this.fetchConsoleAfter(id, this.lastEventId()).pipe(catchError(() => of<ConsoleEventView[]>([])))),
        tap((events) => this.appendEvents(events)),
        // inclusive: one more fetch after the detail turns terminal picks up the final events
        takeWhile(() => !this.isTerminal() && this.loadState() !== 'not_found', true),
        takeUntil(this.restart$),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  /** Drains pages until a short page arrives (handles large terminal runs in one tick). Oldest first (00 §14.4). */
  private fetchConsoleAfter(id: number, afterId: number | null): Observable<ConsoleEventView[]> {
    const page = (after: number | null) => this.api.getConsole(id, { afterId: after ?? undefined, limit: CONSOLE_BATCH_LIMIT });
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
    this.detail.set(detail);
    this.loadState.set('ready');
    this.loadError.set(null);
    this.consecutivePollFailures.set(0);
    if (isTerminalStatus(detail.status)) this.cancelState.set('idle');
  }

  private onDetailError(error: ApiError): void {
    if (error.isNotFound) { this.loadState.set('not_found'); return; }
    if (!this.detail()) { this.loadState.set('error'); this.loadError.set(error); return; }
    this.consecutivePollFailures.update((n) => n + 1);
  }

  /** Call only after the user confirmed. cancelVisualization is silent: every outcome is toasted here, once. */
  cancel(): void {
    const id = this.visualizationId();
    if (id === null || this.isTerminal() || this.cancelState() !== 'idle') return;
    this.cancelState.set('requesting');
    this.api.cancelVisualization(id).pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (res) => {
        if (res.status === 'cancelled') {                 // 200: job was still queued and was removed
          this.notifications.info('Visualization cancelled.');
          this.refreshNow();                              // pick up the terminal status immediately
        } else {                                          // 202: worker signalled
          this.cancelState.set('requested');
          this.notifications.info('Cancellation requested. The pipeline stops at its next checkpoint.');
        }
      },
      error: (e: ApiError) => {
        this.cancelState.set('idle');
        if (e.is('already_terminal')) { this.notifications.info('This visualization had already finished.'); this.refreshNow(); }
        else this.notifications.error(userMessageFor(e));
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
      finalize(() => this.deleting.set(false)),
    );
  }
}
```

Polling rules satisfied (00 §12): detail every 2 s, console every 1.5 s; requests never overlap (`exhaustMap`); both stop when status is terminal (detail via inclusive `takeWhile`; console after one final fetch), on 404, on restart, and on destroy. A terminal visualization opened fresh costs one detail call and at most two console ticks. Polls are not paused while the tab is hidden (not required by 00 §12).

`component-filters.ts`:

```ts
export type ComponentFilter = 'changed' | 'unchanged' | 'failed' | 'all';
export interface ComponentCounts { all: number; changed: number; unchanged: number; failed: number; }
const CHANGED: ReadonlySet<VisualChange> = new Set(['changed', 'new', 'deleted']);
export function isFailed(c: VisualizationComponentView): boolean {
  return c.renderStatus === 'failed' || (c.renderStatus === 'partial' && !!(c.baseError || c.headError));
}
export const COMPONENT_FILTER_PREDICATES: Record<ComponentFilter, (c: VisualizationComponentView) => boolean> = {
  changed: (c) => c.visualChange !== null && CHANGED.has(c.visualChange),
  unchanged: (c) => c.visualChange === 'unchanged',
  failed: isFailed,
  all: () => true,
};
export function countComponents(list: readonly VisualizationComponentView[]): ComponentCounts {
  return {
    all: list.length,
    changed: list.filter(COMPONENT_FILTER_PREDICATES.changed).length,
    unchanged: list.filter(COMPONENT_FILTER_PREDICATES.unchanged).length,
    failed: list.filter(isFailed).length,
  };
}
/**
 * Stage index where a failed/cancelled run stopped. `failedStage` (00 §14.4) wins; when it is null (older rows),
 * fall back to the console: last error event's stage, else last event's stage, else 0.
 */
export function resolveStoppedStageIndex(failedStage: VisualizationStatus | null, events: readonly ConsoleEventView[]): number {
  if (failedStage) { const idx = stageIndex(failedStage); if (idx >= 0) return idx; }
  const reversed = [...events].reverse();
  for (const e of reversed) { if (e.level === 'error') { const idx = stageIndex(e.stage); if (idx >= 0) return idx; } }
  for (const e of reversed) { const idx = stageIndex(e.stage); if (idx >= 0) return idx; }
  return 0;
}
```

`pending` and `skipped` components appear only under All. A component may count in more than one bucket.

#### 5.9.4 `VisualizationDetailComponent`

```ts
interface DetailHeaderView {
  title: string; sourceType: SourceType; sourceLabel: string; repositoryId: number; repositoryName: string;
  refsText: string; status: VisualizationStatus; summaryLine: string;
  failedTitle: string | null; cancelledTitle: string | null; errorMessage: string;
  noComponentsTitle: string; noComponentsMessage: string;
}

@Component({
  selector: 'app-visualization-detail',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [VisualizationDetailStore],
  templateUrl: './visualization-detail.component.html',
  host: { class: 'flex flex-col gap-6' },
  imports: [/* page header, status pill, segmented control, inline alert, spinner, not-found, stepper, console, summary, card, RouterLink, MatCardModule, MatButtonModule, MatIconModule, MatProgressSpinnerModule */],
})
export class VisualizationDetailComponent {
  readonly id = input.required<string>();
  protected readonly store = inject(VisualizationDetailStore);
  private readonly confirm = inject(ConfirmDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly router = inject(Router);
  private readonly title = inject(Title);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly parsedId = computed(() => parseRouteId(this.id()));
  /** Everything the header and alerts print, derived once per detail change (no helper calls in the template). */
  protected readonly header = computed<DetailHeaderView | null>(() => {
    const v = this.store.detail();
    if (!v) return null;
    const stage = PIPELINE_STAGES[this.store.stoppedStageIndex()]?.label ?? null;
    return {
      title: v.title, sourceType: v.sourceType, sourceLabel: sourceLabel(v), repositoryId: v.repositoryId, repositoryName: v.repositoryName,
      refsText: `${refWithSha(v.baseRef, v.baseSha)} ← ${v.sourceType === 'working_tree' ? 'working tree' : refWithSha(v.headRef, v.headSha)}`,
      status: v.status, summaryLine: summaryLine(v),
      failedTitle: v.status === 'failed' ? (stage ? `Failed during ${stage}` : 'Visualization failed') : null,
      cancelledTitle: v.status === 'cancelled' ? (stage ? `Cancelled during ${stage}` : 'Cancelled') : null,
      errorMessage: v.errorMessage || 'The pipeline stopped with an error. See the console for details.',
      ...noComponentsCopy(v.status),
    };
  });
  protected readonly filterOptions = computed<SegmentOption<ComponentFilter>[]>(() => {
    const c = this.store.counts();
    return [
      { value: 'changed', label: 'Changed', count: c.changed },
      { value: 'unchanged', label: 'Unchanged', count: c.unchanged },
      { value: 'failed', label: 'Failed', count: c.failed },
      { value: 'all', label: 'All', count: c.all },
    ];
  });
  protected readonly statTiles = computed(() => {
    const c = this.store.counts();
    return [
      { key: 'all', label: 'Components', value: c.all, icon: 'widgets' },
      { key: 'changed', label: 'Changed', value: c.changed, icon: 'difference' },
      { key: 'unchanged', label: 'Unchanged', value: c.unchanged, icon: 'check_circle' },
      { key: 'failed', label: 'Failed', value: c.failed, icon: 'error' },
    ];
  });
  protected readonly consoleDefaultOpen = computed(() => !this.store.isTerminal() || this.store.status() === 'failed');
  protected readonly cancelLabel = computed(() => (this.store.cancelState() === 'idle' ? 'Cancel' : 'Cancelling…'));

  constructor() {
    effect(() => {
      const id = this.parsedId();
      untracked(() => (id === null ? this.store.markNotFound() : this.store.start(id)));
    });
    effect(() => {
      const t = this.store.detail()?.title;
      if (t) untracked(() => setPageTitle(this.title, t));
    });
  }

  protected confirmCancel(): void {
    this.confirm.confirm({
      title: 'Cancel this visualization?',
      message: 'The pipeline stops at its next checkpoint. Components that already finished keep their results.',
      confirmText: 'Cancel visualization', cancelText: 'Keep running', confirmColor: 'warn',
    }).pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef)).subscribe(() => this.store.cancel());
  }

  protected confirmDelete(): void {
    const title = this.store.detail()?.title ?? 'this visualization';
    this.confirm.confirm({
      title: 'Delete visualization?',
      message: `Screenshots, diffs and the summary for "${title}" will be deleted. This cannot be undone.`,
      confirmText: 'Delete', confirmColor: 'warn',
    }).pipe(filter(Boolean), exhaustMap(() => this.store.remove()), takeUntilDestroyed(this.destroyRef))
      .subscribe((ok) => { if (ok) { this.notifications.success('Visualization deleted'); void this.router.navigate(['/visualizations']); } });
  }
}
```

`noComponentsCopy(status)` (in `visualization-format.ts`) returns `{ noComponentsTitle, noComponentsMessage }` per the copy below.

Template skeleton:

```html
@switch (store.loadState()) {
  @case ('not_found') {
    <app-not-found-page title="Visualization not found" message="It may have been deleted."
                        backLink="/visualizations" backLabel="Back to visualizations" />
  }
  @case ('loading') { <app-loading-spinner label="Loading visualization" /> }
  @case ('error') {
    <app-inline-alert tone="error" title="Couldn't load this visualization">
      {{ store.loadError()?.message }}
      <button inlineAlertAction mat-stroked-button type="button" class="!rounded-xl" (click)="store.refreshNow()">Retry</button>
    </app-inline-alert>
  }
  @case ('ready') {
    @if (header(); as h) {
      <app-page-header [title]="h.title" backLink="/visualizations" backLabel="Back to visualizations">
        <ng-container pageHeaderMeta>
          <app-status-pill kind="source" [value]="h.sourceType" [label]="h.sourceLabel" />
          <a class="text-sm font-medium text-[var(--shell-accent)] hover:underline" [routerLink]="['/repositories', h.repositoryId]">{{ h.repositoryName }}</a>
          <span class="pv-code text-xs text-[var(--color-text-secondary)]">{{ h.refsText }}</span>
          <app-status-pill kind="visualization" [value]="h.status" ariaPrefix="Status" />
        </ng-container>
        <ng-container pageHeaderActions>
          @if (!store.isTerminal()) {
            <button mat-stroked-button color="warn" type="button" class="!rounded-xl"
                    [disabled]="store.cancelState() !== 'idle'" (click)="confirmCancel()">
              @if (store.cancelState() === 'requesting') { <mat-spinner diameter="18" class="!inline-block align-middle mr-2" /> } @else { <mat-icon aria-hidden="true">stop_circle</mat-icon> }
              {{ cancelLabel() }}
            </button>
          } @else {
            <button mat-stroked-button color="warn" type="button" class="!rounded-xl" [disabled]="store.deleting()" (click)="confirmDelete()">
              <mat-icon aria-hidden="true">delete</mat-icon> Delete
            </button>
          }
        </ng-container>
      </app-page-header>
      <p class="-mt-4 text-sm text-[var(--color-text-tertiary)]">{{ h.summaryLine }}</p>

      <mat-card class="!rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-md)]">
        <app-pipeline-stepper [status]="h.status" [stoppedStageIndex]="store.stoppedStageIndex()" />
      </mat-card>

      @if (store.connectionLost()) {
        <app-inline-alert tone="warning" title="Connection lost">Lost connection to the PRVision API. Retrying every 2 seconds…</app-inline-alert>
      }
      @if (h.failedTitle; as t) {
        <app-inline-alert tone="error" [title]="t"><span class="whitespace-pre-wrap">{{ h.errorMessage }}</span></app-inline-alert>
      }
      @if (h.cancelledTitle; as t) {
        <app-inline-alert tone="warning" [title]="t">Results that finished before cancellation are shown below.</app-inline-alert>
      }

      <app-console-panel [events]="store.consoleEvents()" [live]="!store.isTerminal()" [trimmed]="store.consoleTrimmed()"
                         [defaultOpen]="consoleDefaultOpen()" />

      <div class="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <app-summary-card [markdown]="store.detail()?.summaryMarkdown ?? null" [status]="h.status" [aiModel]="store.detail()?.aiModel ?? ''" />
        <div class="grid grid-cols-2 content-start gap-3">
          @for (t of statTiles(); track t.key) { <!-- 12 §6.20 stat tile: label t.label, value t.value, icon t.icon --> }
        </div>
      </div>

      <section class="flex flex-col gap-4" aria-labelledby="components-heading">
        <div class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 id="components-heading" class="text-lg font-semibold text-[var(--color-text-primary)]">Components</h2>
          @if (store.components().length) {
            <app-segmented-control ariaLabel="Filter components" [options]="filterOptions()"
                                   [value]="store.filter()" (valueChange)="store.setFilter($event)" />
          }
        </div>
        @if (!store.components().length) {
          <app-empty-state [title]="h.noComponentsTitle" [message]="h.noComponentsMessage" />
        } @else if (!store.filteredComponents().length) {
          <app-empty-state title="Nothing in this filter" message="Choose another filter to see the remaining components." />
        } @else {
          @for (c of store.filteredComponents(); track c.id) {
            <app-component-card [component]="c" [runActive]="!store.isTerminal()" />
          }
        }
      </section>
    }
  }
}
```

The template calls no helper functions; everything it prints comes from `header()`, `filterOptions()`, `statTiles()` and store signals.

No-components copy: non-terminal → "Looking for changed components" / "Components appear here once change analysis finishes."; completed → "No UI components affected" / "None of the changed files affect React components PRVision can render."; failed/cancelled → "No components" / "The run stopped before any components were found."

`visualization-format.ts`:

```ts
export function refWithSha(ref: string, sha: string | null): string { return sha ? `${ref} @ ${sha.slice(0, 7)}` : ref; }
// providerLabel(p) ("Anthropic API" / "Claude Code" / formatPillLabel fallback) is imported from 12's core/utils/labels.util.ts;
// Settings uses the same helper for the Test AI result, so it cannot live in this feature.
export function formatDuration(ms: number): string;   // 950 → "<1s", 4200 → "4s", 192000 → "3m 12s", 3_900_000 → "1h 5m"
/**
 * "Started Oct 3, 12:01 PM · took 3m 12s · claude-opus-5-5 via Anthropic API · 41.2K in / 3.1K out tokens · 14 AI calls"
 * Absolute start time (a relative one would go stale on a finished run, whose header no longer recomputes).
 * "took" only when completedAt is set; parts omitted when unknown.
 */
export function summaryLine(v: VisualizationDetailView): string;
export function noComponentsCopy(status: VisualizationStatus): { noComponentsTitle: string; noComponentsMessage: string };
```

#### 5.9.5 `app-pipeline-stepper`

Selector `app-pipeline-stepper`, inline template, no outputs. Inputs: `status = input.required<VisualizationStatus>()`, `stoppedStageIndex = input<number>(0)` (the store passes `resolveStoppedStageIndex(failedStage, console)`, so `failedStage` from the API decides where a failed or cancelled run stopped; the console is only a fallback when it is null).

```ts
type StepState = 'done' | 'current' | 'pending' | 'failed' | 'cancelled';
const STEP_VIEW: Record<StepState, { circle: string; label: string; sr: string }> = { /* classes and hidden text from the table below */ };
protected readonly steps = computed(() => {
  const status = this.status();
  const current = stageIndex(status);
  return PIPELINE_STAGES.map((stage, i) => {
    let state: StepState;
    if (status === 'completed') state = 'done';
    else if (status === 'failed' || status === 'cancelled') {
      const stop = this.stoppedStageIndex();
      state = i < stop ? 'done' : i === stop ? (status === 'failed' ? 'failed' : 'cancelled') : 'pending';
    } else state = i < current ? 'done' : i === current ? 'current' : 'pending';
    const view = STEP_VIEW[state];
    const icon = state === 'done' ? 'check' : state === 'failed' ? 'close' : state === 'cancelled' ? 'block' : stage.icon;
    return { ...stage, state, icon, circleClass: view.circle, labelClass: view.label, srText: view.sr,
             ariaCurrent: state === 'current' ? 'step' : null, last: i === PIPELINE_STAGES.length - 1 };
  });
});
```

The template only reads these fields (`@for (s of steps(); track s.status)`), so every class decision is in the `computed`.

Markup: `<ol class="flex flex-col gap-3 md:flex-row md:items-center md:gap-0" aria-label="Pipeline progress">`, each `<li class="flex items-center gap-2 md:flex-1" [attr.aria-current]="s.ariaCurrent">` with:

| State | Circle (h-8 w-8 rounded-full) | Icon | Label style | Hidden text |
|---|---|---|---|---|
| done | `bg-[var(--shell-accent)] text-[var(--shell-accent-contrast)]` | `check` | secondary | "(done)" |
| current | `border-2 border-[var(--shell-accent)] text-[var(--shell-accent)]` + pulse ring | stage icon | primary, semibold | "(in progress)" |
| pending | `border border-[color:var(--color-border-light)] text-[var(--color-text-disabled)]` | stage icon | tertiary | "(pending)" |
| failed | `bg-[var(--color-error)] text-white` | `close` | error colour | "(failed here)" |
| cancelled | `bg-[var(--color-warning)] text-white` | `block` | warning colour | "(cancelled here)" |

Connector between items on `md+`: `h-px flex-1 mx-2` coloured accent when the left step is done, otherwise `--color-border`. The pulse ring respects reduced motion (class `dd-pill__dot--pulse` style animation on an absolutely positioned ring).

#### 5.9.6 `app-console-panel`

Selector `app-console-panel`, inline template, no outputs. Injects `Clipboard`, `NotificationService`. Inputs: `events = input.required<readonly ConsoleEventView[]>()`, `live = input(false)`, `trimmed = input(false)`, `defaultOpen = input(true)`.

State: `userOpen = signal<boolean | null>(null)` (null until the user toggles), `levelFilter = signal<'all' | 'issues'>('all')` (Issues = warn + error), `renderLimit = signal(500)`, `stickToBottom = signal(true)`, `seenCount = signal(0)`. The scroller is `viewChild<ElementRef<HTMLElement>>('scroller')` (optional: it only exists while open).

Derived (`computed`): `open = userOpen() ?? defaultOpen()` (open while running, collapses itself when a run completes, stays open on failure, and never fights a user toggle; no effect copies one signal into another); `filtered` (events by level); `rows = filtered.slice(-renderLimit()).map((e) => ({ e, levelClass: 'pv-console__level--' + e.level }))`; `hiddenEarlier = max(0, filtered.length - renderLimit())`; `unseen = max(0, rows.length - seenCount())`; `subtitle` ("128 events" + " · oldest events trimmed" when `trimmed()`); `ariaLive = live() ? 'polite' : 'off'`; `levelOptions` (`[{ value: 'all', label: 'All' }, { value: 'issues', label: 'Issues', count: warn + error }]`).

- Toggle: `<details [open]="open()" (toggle)="onToggle($event)">`; `onToggle` reads `(event.target as HTMLDetailsElement).open` and stores it in `userOpen` only when it differs from `open()` (a programmatic change also fires `toggle`).
- "Show earlier events (N)" text button above the rows when `hiddenEarlier() > 0`; adds 500 to `renderLimit`.
- Auto-scroll: the scroller's `(scroll)` handler sets `stickToBottom` to `scrollHeight - scrollTop - clientHeight < 24` and, when at the bottom, `seenCount.set(rows().length)`. One `effect` (DOM side effect, allowed) reads `rows().length` and, when `stickToBottom()`, schedules `requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; seenCount.set(rows().length) })`. "Jump to latest" button (`arrow_downward`, label "Jump to latest (N new)" from `unseen()`) shows when `unseen() > 0`, scrolls down and sets `stickToBottom` true.
- Copy: CDK `Clipboard.copy(text)` with lines `HH:mm:ss LEVEL [stage] message` built in a method from `filtered()`; toast success "Console copied".
- Accessibility: the scroller has `role="log" [attr.aria-live]="ariaLive()" aria-relevant="additions" aria-label="Pipeline console"` and `tabindex="0"` (keyboard-scrollable region). Rows are appended, never re-rendered (`track r.e.id`), so a screen reader announces only new lines; a finished run's backlog is not announced (`aria-live="off"`).

Markup (Uply run-detail expander around the Uply run-console terminal; 12 §6.20):

```html
<details class="group overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)]"
         [open]="open()" (toggle)="onToggle($event)">
  <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
    <div class="min-w-0">
      <div class="text-base font-semibold text-[var(--color-text-primary)]">Console</div>
      <div class="text-[0.86rem] text-[var(--color-text-tertiary)]">{{ subtitle() }}</div>
    </div>
    <div class="flex items-center gap-2">
      @if (live()) { <span class="dd-pill dd-pill--info"><span class="dd-pill__dot dd-pill__dot--pulse" aria-hidden="true"></span>Live</span> }
      @else { <span class="dd-pill dd-pill--muted">Finished</span> }
      <mat-icon class="!h-4 !w-4 !text-base text-[var(--color-text-tertiary)] transition-transform group-open:rotate-180" aria-hidden="true">expand_more</mat-icon>
    </div>
  </summary>
  <div class="flex flex-col gap-3 px-5 pb-5">
    <div class="flex flex-wrap items-center justify-between gap-3">
      <app-segmented-control ariaLabel="Console level" [options]="levelOptions()" [value]="levelFilter()" (valueChange)="levelFilter.set($event)" [fullWidthOnMobile]="false" />
      <button mat-stroked-button type="button" class="!rounded-xl" (click)="copy()"><mat-icon aria-hidden="true">content_copy</mat-icon> Copy</button>
    </div>
    <div class="pv-console relative overflow-hidden rounded-2xl border border-[color:var(--color-border)]">
      @if (!rows().length) {
        <div class="grid min-h-48 place-items-center px-4 py-8 text-center text-sm">
          <div><p class="font-display text-base font-semibold tracking-tight">No console events yet</p>
               <p class="pv-console__subtle mt-2 text-sm">Events appear here as the pipeline runs.</p></div>
        </div>
      } @else {
        <div #scroller class="max-h-[22rem] overflow-auto p-3 font-mono text-xs leading-relaxed" tabindex="0" role="log"
             aria-relevant="additions" aria-label="Pipeline console" [attr.aria-live]="ariaLive()" (scroll)="onScroll()">
          @for (r of rows(); track r.e.id) {
            <div class="pv-console__row grid grid-cols-[5.5rem_4.75rem_minmax(0,1fr)] gap-3 border-b px-2 py-2 last:border-b-0">
              <time class="pv-console__muted whitespace-nowrap" [attr.datetime]="r.e.createdAt">{{ r.e.createdAt | dateTime:'time' }}</time>
              <span class="font-bold uppercase" [class]="r.levelClass">{{ r.e.level }}</span>
              <span class="min-w-0 whitespace-pre-wrap break-words"><span class="pv-console__muted">[{{ r.e.stage }}]</span> {{ r.e.message }}</span>
            </div>
          }
        </div>
      }
      <!-- "Jump to latest" button: absolute bottom-3 right-3, dd-pill dd-pill--info styled <button type="button"> -->
    </div>
  </div>
</details>
```

`[class]="r.levelClass"` replaces only the bound classes; keep `font-bold uppercase` as static classes on the same element (Angular merges static `class` with `[class]` bindings).

#### 5.9.7 `app-summary-card`

Selector `app-summary-card`, inline template, no outputs. Inputs: `markdown = input<string | null>(null)`, `status = input.required<VisualizationStatus>()`, `aiModel = input<string>('')`. Derived: `isTerminal = computed(() => isTerminalStatus(status()))`, `emptyMessage = computed(() => status() === 'completed' ? 'The AI did not produce a summary for this run.' : 'The run stopped before the summary step.')`.

```html
<mat-card class="!rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-md)]">
  <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-lg font-semibold text-[var(--color-text-primary)]">AI summary</h2>
    <span class="dd-pill dd-pill--outline" title="Written by {{ aiModel() }}">AI-generated</span>
  </div>
  @if (markdown()) {
    <div class="pv-prose" [innerHTML]="markdown() | markdown"></div>
    <p class="mt-4 text-xs text-[var(--color-text-tertiary)]">Written by {{ aiModel() }}. Check it against the screenshots below.</p>
  } @else if (!isTerminal()) {
    <div class="space-y-2" aria-hidden="true">
      <div class="h-3 w-3/4 animate-pulse rounded bg-[var(--color-bg-tertiary)]"></div>
      <div class="h-3 w-full animate-pulse rounded bg-[var(--color-bg-tertiary)]"></div>
      <div class="h-3 w-2/3 animate-pulse rounded bg-[var(--color-bg-tertiary)]"></div>
    </div>
    <p class="mt-3 text-sm text-[var(--color-text-secondary)]">The summary is written after rendering and diffing finish.</p>
  } @else {
    <app-empty-state title="No summary" [message]="emptyMessage()" />
  }
</mat-card>
```

Never use `bypassSecurityTrustHtml`; the markdown pipe returns a DOMPurify-sanitized string and Angular sanitizes it again.

#### 5.9.8 `app-component-card`

Selector `app-component-card`, `templateUrl`, no outputs. Inputs: `component = input.required<VisualizationComponentView>()`, `runActive = input(false)`.

State: `openSections = signal<ReadonlySet<'code' | 'structure' | 'harness' | 'errors'>>(new Set(['errors']))` (sections render their content only when open; `onToggle(section, event)` adds/removes from the set; `isOpen(section)` is not called from the template — use the per-section `computed`s `codeOpen`, `structureOpen`, `harnessOpen`).

Derived (`computed`), so the template stays free of logic:

| Name | Value |
|---|---|
| `headingId` | `` `cmp-${component().id}` `` |
| `rankLabel` | `` `#${component().rank + 1}` `` |
| `exportLabel` | `` `export ${exportName}` `` when `exportName` is neither `default` nor `displayName`, else `null` |
| `visualLabel` | "Changed · 4.2%" when `visualChange === 'changed'` and `diffPixelRatio !== null` (`formatDiffPercent()` from 12's diff-percent pipe file), else `null` (pill default label) |
| `showRenderPill` | `renderStatus !== 'rendered'` |
| `riskColor` | `likely_regression: var(--color-error)`, `check: var(--color-warning)`, `none: var(--color-success)`, null → `var(--color-border-light)` |
| `diffStats` | `codeDiff === null ? null : countDiffStats(codeDiff)` (narrow with a local const; no `!`) |
| `diffStatsLabel` | "+12 −3" |
| `structuralCount` | `structuralDiff?.length ?? 0` |
| `harnessSummary` | "2 mocked modules · notes" style line, or "Notes only" |
| `hasErrors` | `!!(baseError \|\| headError)` |
| `errorBlocks` | `[{ side: 'Base', text: baseError }, { side: 'Head', text: headError }]` filtered to non-null |
| `pendingText` | `runActive() ? 'Waiting to render…' : 'Not rendered'` |
| `skipMessage` | `skipReason ?? 'This component was not rendered (render cap reached or not renderable in isolation).'` (00 §14.4 `skipReason`) |
| `reasonText` | `changeReason`, prefixed "Changed because: " — shown for every change kind when present |
| `showParentNote` | `changeKind === 'affected_parent' && !codeDiff && !changeReason` (generic fallback line) |

Card markup outline:

```html
<article class="rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-sm)]"
         [attr.aria-labelledby]="headingId()">
  <header class="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
    <div class="min-w-0">
      <div class="flex flex-wrap items-baseline gap-2">
        <span class="text-xs font-semibold tabular-nums text-[var(--color-text-tertiary)]">{{ rankLabel() }}</span>
        <h3 [id]="headingId()" class="truncate text-lg font-semibold text-[var(--color-text-primary)]">{{ component().displayName }}</h3>
        @if (exportLabel(); as label) {
          <span class="pv-code text-xs text-[var(--color-text-tertiary)]">{{ label }}</span>
        }
      </div>
      <div class="mt-1 flex min-w-0 items-center gap-1">
        <span class="pv-code truncate text-xs text-[var(--color-text-secondary)]" [title]="component().filePath">{{ component().filePath }}</span>
        <button mat-icon-button type="button" class="!h-7 !w-7 !p-0" [cdkCopyToClipboard]="component().filePath"
                aria-label="Copy file path" matTooltip="Copy path"><mat-icon class="!text-base" aria-hidden="true">content_copy</mat-icon></button>
      </div>
      @if (reasonText(); as reason) { <p class="mt-1 text-xs text-[var(--color-text-tertiary)]">{{ reason }}</p> }
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <app-status-pill kind="change" [value]="component().changeKind" />
      @if (component().visualChange) {
        <app-status-pill kind="visual" [value]="component().visualChange" [label]="visualLabel()" />
      }
      @if (showRenderPill()) { <app-status-pill kind="render" [value]="component().renderStatus" /> }
      @if (component().risk) { <app-status-pill kind="risk" [value]="component().risk" ariaPrefix="Risk" /> }
    </div>
  </header>

  @if (component().aiNote) {
    <div class="mt-4 flex gap-3 rounded-xl border-l-4 bg-[var(--color-bg-tertiary)] px-4 py-3 text-sm leading-6 text-[var(--color-text-secondary)]"
         [style.border-left-color]="riskColor()">
      <mat-icon class="mt-0.5 shrink-0 !text-[18px] text-[var(--color-text-tertiary)]" aria-hidden="true">psychology</mat-icon>
      <p class="whitespace-pre-line"><span class="sr-only">AI note: </span>{{ component().aiNote }}</p>
    </div>
  }

  <div class="mt-4">
    @switch (component().renderStatus) {
      @case ('pending') { <app-empty-state [title]="pendingText()" [message]="null" /> }
      @case ('skipped') { <app-empty-state title="Skipped" [message]="skipMessage()" /> }
      @default {
        <app-image-compare [label]="component().displayName" [baseUrl]="component().baseImageUrl" [headUrl]="component().headImageUrl"
          [diffUrl]="component().diffImageUrl" [width]="component().imageWidth" [height]="component().imageHeight"
          [diffPixelRatio]="component().diffPixelRatio"
          [visualChange]="component().visualChange" [baseError]="component().baseError" [headError]="component().headError" />
      }
    }
  </div>

  <div class="mt-4 flex flex-col gap-3">
    <!-- each <details> uses the 12 §6.20 expander markup; the summary title / subtitle are shown after "·" here -->
    @if (hasErrors()) { <details … open (toggle)="onToggle('errors', $event)"> Render errors · @for (b of errorBlocks(); track b.side) { …block… } </details> }
    @if (component().codeDiff; as diff) { <details … (toggle)="onToggle('code', $event)"> Code diff · {{ diffStatsLabel() }} @if (codeOpen()) { <app-code-diff [diff]="diff" /> } </details> }
    @else if (showParentNote()) { <p class="text-xs text-[var(--color-text-tertiary)]">Re-rendered because a component or hook it uses changed. Its own file has no diff.</p> }
    @if (component().structuralDiff; as changes) { @if (changes.length) { <details … (toggle)="onToggle('structure', $event)"> Structural changes · {{ structuralCount() }} @if (structureOpen()) { <app-structural-diff-list [changes]="changes" /> } </details> } }
    @if (component().harnessSource || component().harnessNotes) { <details … (toggle)="onToggle('harness', $event)"> Render harness · {{ harnessSummary() }} @if (harnessOpen()) { <app-harness-panel [source]="component().harnessSource" [notes]="component().harnessNotes" /> } </details> }
  </div>
</article>
```

Pending and skipped components show Uply's dotted, text-only empty box (`app-empty-state`); the skipped text is the API's `skipReason` when present.

Render-errors section (open by default): one block per failing side:

```html
<div class="rounded-xl border border-[color:color-mix(in_srgb,var(--color-error)_18%,var(--color-border))] p-3">
  <p class="text-sm font-semibold text-[var(--color-error)]">{{ b.side }} render failed</p>
  <pre class="pv-code pv-code-block mt-2 max-h-48 whitespace-pre-wrap break-words">{{ b.text }}</pre>
</div>
```

#### 5.9.9 `app-image-compare`

Selector `app-image-compare`, `templateUrl` + `styleUrl`, no outputs. Inputs: `label = input.required<string>()`, `baseUrl`, `headUrl`, `diffUrl` (`input<string | null>(null)`, raw `/artifacts/…` paths from the API), `width`, `height`, `diffPixelRatio` (`input<number | null>(null)`), `visualChange = input<VisualChange | null>(null)`, `baseError`, `headError` (`input<string | null>(null)`). Image `src` values come only from `artifactUrl()` (12 §6.18), which prefixes `environment.artifactBaseUrl`.

State and derived values:

```ts
type CompareMode = 'side' | 'slider' | 'diff';
type ZoomMode = 'fit' | 'actual';
protected readonly mode = signal<CompareMode>('side');
protected readonly zoom = signal<ZoomMode>('fit');
protected readonly split = signal(50);             // % of width showing base (left)
protected readonly diffOpacity = signal(75);       // %
protected readonly diffOnly = signal(false);
protected readonly dragging = signal(false);
protected readonly failedLoads = signal<ReadonlySet<'base' | 'head' | 'diff'>>(new Set());

protected readonly baseSrc = computed(() => this.failedLoads().has('base') ? null : artifactUrl(this.baseUrl()));
protected readonly headSrc = computed(() => this.failedLoads().has('head') ? null : artifactUrl(this.headUrl()));
protected readonly diffSrc = computed(() => this.failedLoads().has('diff') ? null : artifactUrl(this.diffUrl()));
protected readonly canSlide = computed(() => !!this.baseSrc() && !!this.headSrc());
protected readonly canDiff = computed(() => !!this.diffSrc() && !!this.headSrc());
protected readonly effectiveMode = computed<CompareMode>(() =>
  (this.mode() === 'slider' && !this.canSlide()) || (this.mode() === 'diff' && !this.canDiff()) ? 'side' : this.mode());
protected readonly aspectRatio = computed(() => {
  const w = this.width(), h = this.height();
  return w && h ? `${w} / ${h}` : null;
});
protected readonly modeOptions = computed<SegmentOption<CompareMode>[]>(() => [
  { value: 'side', label: 'Side by side', icon: 'view_column' },
  { value: 'slider', label: 'Slider', icon: 'compare', disabled: !this.canSlide() },
  { value: 'diff', label: 'Diff', icon: 'difference', disabled: !this.canDiff() },
]);
protected readonly zoomOptions: SegmentOption<ZoomMode>[] = [
  { value: 'fit', label: 'Fit', icon: 'fit_screen' }, { value: 'actual', label: '100%', icon: 'crop_free' },
];
// View models so the template only reads values:
protected readonly baseAlt = computed(() => `Base render of ${this.label()}`);
protected readonly headAlt = computed(() => `Head render of ${this.label()}`);
protected readonly sides = computed(() => [
  { key: 'base' as const, caption: 'Base', src: this.baseSrc(), alt: this.baseAlt(), placeholder: this.placeholderFor('base') },
  { key: 'head' as const, caption: 'Head', src: this.headSrc(), alt: this.headAlt(), placeholder: this.placeholderFor('head') },
]);   // placeholderFor(side) returns { icon, text } per the table below (reads signals, so it tracks them)
protected readonly frameWidth = computed(() => (this.zoom() === 'actual' ? this.width() : null));   // px
protected readonly zoomRegionLabel = computed(() => `${this.label()} at 100% zoom, scrollable`);
protected readonly clipPath = computed(() => `inset(0 0 0 ${this.split()}%)`);
protected readonly sliderLabel = computed(() => `Comparison slider for ${this.label()}`);
protected readonly sliderValueText = computed(() => `${this.split()}% base, ${100 - this.split()}% head`);
protected readonly diffImageOpacity = computed(() => (this.diffOnly() ? 1 : this.diffOpacity() / 100));
protected readonly diffOpacityText = computed(() => `${this.diffOpacity()}%`);
protected readonly diffAlt = computed(() => `Pixel differences for ${this.label()}`);
protected readonly diffLegend = computed(() => {
  const r = this.diffPixelRatio();
  return r === null ? 'Highlighted pixels differ between base and head.'
    : `Highlighted pixels differ between base and head (${formatDiffPercent(r)} of the image).`;
});

protected markFailed(side: 'base' | 'head' | 'diff'): void {
  this.failedLoads.update((s) => new Set(s).add(side));
}
/** Range inputs: read the value in the class (templates may not use $any, 01 template/no-any). */
protected onSplitInput(event: Event): void { this.split.set(Number((event.target as HTMLInputElement).value)); }
protected onOpacityInput(event: Event): void { this.diffOpacity.set(Number((event.target as HTMLInputElement).value)); }
```

Placeholder text for a missing side (`placeholderFor(side)`):

| Condition | Icon | Text |
|---|---|---|
| base missing and `visualChange === 'new'` | `add_box` | "Not present on base — new component" |
| head missing and `visualChange === 'deleted'` | `delete` | "Removed in head — deleted component" |
| side has an error | `error` | "Render failed — see Render errors below" |
| URL present but image failed to load | `broken_image` | "Image unavailable" |
| otherwise | `hourglass_empty` | "Not rendered" |

Toolbar: `<app-segmented-control ariaLabel="Comparison mode" [options]="modeOptions()" [value]="effectiveMode()" (valueChange)="mode.set($event)" />` and `<app-segmented-control ariaLabel="Zoom" [options]="zoomOptions" [value]="zoom()" (valueChange)="zoom.set($event)" />`, `flex flex-wrap items-center justify-between gap-3`.

Viewport wrapper: fit → `w-full`; actual → `max-h-[70vh] overflow-auto rounded-xl border` with `tabindex="0" role="region" [attr.aria-label]="zoomRegionLabel()"`; the image frames get `[style.width.px]="frameWidth()"`. Every `<img>` also gets `[attr.width]="width()" [attr.height]="height()"` (01 §5.14.2: intrinsic size from `imageWidth`/`imageHeight`, so layout does not jump while loading) and `draggable="false"`.

Side-by-side:

```html
<div class="grid gap-4 md:grid-cols-2">
  @for (side of sides(); track side.key) {
    <figure class="min-w-0">
      <figcaption class="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
        {{ side.caption }}
      </figcaption>
      <div class="pv-checkerboard overflow-hidden rounded-xl border border-[color:var(--color-border)]" [style.aspect-ratio]="aspectRatio()" [style.width.px]="frameWidth()">
        @if (side.src; as url) {
          <img [src]="url" [alt]="side.alt" [attr.width]="width()" [attr.height]="height()" loading="lazy" decoding="async" draggable="false"
               class="block h-auto w-full object-contain object-left-top" (error)="markFailed(side.key)" />
        } @else {
          <div class="grid h-full min-h-40 place-items-center gap-2 bg-[var(--color-bg-tertiary)] p-6 text-center text-sm text-[var(--color-text-tertiary)]">
            <mat-icon aria-hidden="true">{{ side.placeholder.icon }}</mat-icon><span>{{ side.placeholder.text }}</span>
          </div>
        }
      </div>
    </figure>
  }
</div>
```

Slider:

```html
<div class="pv-checkerboard relative select-none overflow-hidden rounded-xl border border-[color:var(--color-border)] touch-none"
     [style.aspect-ratio]="aspectRatio()" (pointerdown)="onPointerDown($event)" (pointermove)="onPointerMove($event)"
     (pointerup)="dragging.set(false)" (pointercancel)="dragging.set(false)">
  <img [src]="baseSrc()" [alt]="baseAlt()" class="absolute inset-0 h-full w-full object-contain object-left-top" draggable="false" />
  <img [src]="headSrc()" [alt]="headAlt()" class="absolute inset-0 h-full w-full object-contain object-left-top" draggable="false"
       [style.clip-path]="clipPath()" />
  <div class="pointer-events-none absolute inset-y-0 w-0.5 bg-[var(--shell-accent)] shadow" [style.left.%]="split()" aria-hidden="true"></div>
  <span class="dd-pill dd-pill--muted absolute left-2 top-2">Base</span>
  <span class="dd-pill dd-pill--muted absolute right-2 top-2">Head</span>
</div>
<label class="mt-3 flex items-center gap-3 text-sm text-[var(--color-text-secondary)]">
  <span class="shrink-0">Base</span>
  <input type="range" min="0" max="100" step="1" class="w-full accent-[var(--shell-accent)]"
         [value]="split()" (input)="onSplitInput($event)"
         [attr.aria-label]="sliderLabel()" [attr.aria-valuetext]="sliderValueText()" />
  <span class="shrink-0">Head</span>
</label>
```

`onPointerDown` sets `dragging` and calls `(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)`, then updates `split` from `(event.clientX - rect.left) / rect.width`, clamped 0–100 and rounded. Keyboard: the native range handles Arrow keys (±1), PageUp/PageDown (±10), Home/End. In 100% zoom the stage width is `width()` px inside the scroll region.

Diff overlay:

```html
<div class="pv-checkerboard relative overflow-hidden rounded-xl border border-[color:var(--color-border)]" [style.aspect-ratio]="aspectRatio()">
  @if (!diffOnly()) { <img [src]="headSrc()" [alt]="headAlt()" class="absolute inset-0 h-full w-full object-contain object-left-top" draggable="false" /> }
  <img [src]="diffSrc()" [alt]="diffAlt()" class="absolute inset-0 h-full w-full object-contain object-left-top" draggable="false"
       [style.opacity]="diffImageOpacity()" (error)="markFailed('diff')" />
</div>
<div class="mt-3 flex flex-wrap items-center gap-4 text-sm text-[var(--color-text-secondary)]">
  <label class="flex flex-1 items-center gap-3">Diff opacity
    <input type="range" min="0" max="100" step="5" class="w-full accent-[var(--shell-accent)]" [disabled]="diffOnly()"
           [value]="diffOpacity()" (input)="onOpacityInput($event)" [attr.aria-valuetext]="diffOpacityText()" />
  </label>
  <mat-slide-toggle [checked]="diffOnly()" (change)="diffOnly.set($event.checked)">Diff only</mat-slide-toggle>
</div>
<p class="mt-2 text-xs text-[var(--color-text-tertiary)]">{{ diffLegend() }}</p>
```

`diffPixelRatio = input<number | null>(null)` is bound from the component card (`[diffPixelRatio]="component().diffPixelRatio"`).

`image-compare.component.scss` stays under 1 kB (only `:host { display: block; }` and `input[type=range] { cursor: pointer; }`).

#### 5.9.10 `unified-diff.ts` and `app-code-diff`

```ts
export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';
/** `key` is the line's position in the parsed diff; used as the @for track key (01: no $index). */
export interface DiffLine { key: number; kind: DiffLineKind; oldNo: number | null; newNo: number | null; text: string; }
const META_PREFIXES = ['diff --git', 'index ', '--- ', '+++ ', 'new file mode', 'deleted file mode',
  'similarity index', 'rename from', 'rename to', 'old mode', 'new mode', 'Binary files'];
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parseUnifiedDiff(diff: string): DiffLine[] {
  const lines = diff.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out: DiffLine[] = [];
  const meta = (text: string): DiffLine => ({ kind: 'meta', oldNo: null, newNo: null, text });
  let oldNo = 0, newNo = 0, inHunk = false;
  for (const raw of lines) {
    if (raw.startsWith('diff --git')) { inHunk = false; out.push(meta(raw)); continue; }   // new file section
    const hunk = HUNK.exec(raw);
    if (hunk) { oldNo = Number(hunk[1]); newNo = Number(hunk[2]); inHunk = true; out.push({ kind: 'hunk', oldNo: null, newNo: null, text: raw }); continue; }
    if (!inHunk) { out.push(meta(raw)); continue; }   // index/mode/---/+++/rename lines before the first hunk
    if (raw.startsWith('+')) out.push({ kind: 'add', oldNo: null, newNo: newNo++, text: raw.slice(1) });
    else if (raw.startsWith('-')) out.push({ kind: 'del', oldNo: oldNo++, newNo: null, text: raw.slice(1) });
    else if (raw.startsWith('\\')) out.push({ kind: 'note', oldNo: null, newNo: null, text: raw });
    else out.push({ kind: 'context', oldNo: oldNo++, newNo: newNo++, text: raw.startsWith(' ') ? raw.slice(1) : raw });
  }
  return out;
}
export function countDiffStats(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const l of parseUnifiedDiff(diff)) { if (l.kind === 'add') added++; else if (l.kind === 'del') removed++; }
  return { added, removed };
}
```

Header lines (`index`, mode lines, `---`, `+++`, renames; listed in `META_PREFIXES` for reference) are recognised by position: anything before the first `@@` of a file section is meta, and `diff --git` starts a new section. Inside a hunk, a line such as `--- x` is therefore a deletion of the text `-- x`. Git always emits `diff --git` per file, which is what 08 stores. The tests in §9 pin this.

The parser assigns `key: out.length` when it pushes each line (shown abbreviated above).

`app-code-diff` (selector `app-code-diff`, inline template, no outputs): input `diff = input.required<string>()`; `lines = computed(() => parseUnifiedDiff(this.diff()))`; `limit = signal(2000)`; `rows = computed(() => this.lines().slice(0, this.limit()).map((l) => ({ ...l, cls: 'pv-diff-line pv-diff-line--' + l.kind, marker: MARKER[l.kind] })))` with `MARKER: Record<DiffLineKind, string> = { add: '+', del: '-', context: ' ', meta: '', hunk: '', note: '' }` (`pv-diff-line--context` and `--note` have no rule, so they render plain); `hiddenCount = computed(() => Math.max(0, lines().length - limit()))`; `showAll()` sets `limit` to `lines().length`.

```html
<pre class="pv-code pv-code-block" tabindex="0" role="region" aria-label="Unified code diff"><code>@for (r of rows(); track r.key) {<span [class]="r.cls"><span class="pv-diff-line__num">{{ r.oldNo }}</span><span class="pv-diff-line__num">{{ r.newNo }}</span><span>{{ r.marker }}{{ r.text }}</span></span>}</code></pre>
@if (hiddenCount() > 0) {
  <button mat-button type="button" (click)="showAll()">Show all {{ lines().length }} lines</button>
}
```

`{{ null }}` renders as empty text, so null line numbers need no `??`. The `+`/`-` marker stays visible so meaning does not depend on colour. Content is interpolated text; never `innerHTML`.

#### 5.9.11 `app-structural-diff-list`

Selector `app-structural-diff-list`, inline template, no outputs. Input `changes = input.required<readonly StructuralChange[]>()`. Map to rows in TypeScript (no template narrowing); `rows = computed(() => changes().slice(0, limit()).map(toRow))`, `limit = signal(200)`:

```ts
interface StructuralRow {
  key: number; pillClass: string; kindLabel: string; target: string; path: string;
  before: TruncatedText | null; after: TruncatedText | null;
  /** className changes (00 §14.4 tokensAdded/tokensRemoved): shown as token chips instead of before/after. */
  tokensAdded: string[]; tokensRemoved: string[];
}
interface TruncatedText { shown: string; full: string; }   // shown = first 300 chars + "…"
function toRow(c: StructuralChange, key: number): StructuralRow {
  const base = { key, path: c.path, before: null, after: null, tokensAdded: [], tokensRemoved: [] };
  switch (c.kind) {
    case 'element_added': return { ...base, pillClass: 'dd-pill dd-pill--success', kindLabel: 'Added', target: `<${c.tag}>` };
    case 'element_removed': return { ...base, pillClass: 'dd-pill dd-pill--danger', kindLabel: 'Removed', target: `<${c.tag}>` };
    case 'attribute_changed': {
      const tokens = c.tokensAdded !== undefined || c.tokensRemoved !== undefined;
      return { ...base, pillClass: 'dd-pill dd-pill--info', kindLabel: 'Attribute', target: `<${c.tag}> ${c.attribute}`,
               before: tokens ? null : truncate(c.before ?? '∅'), after: tokens ? null : truncate(c.after ?? '∅'),
               tokensAdded: c.tokensAdded ?? [], tokensRemoved: c.tokensRemoved ?? [] };
    }
    case 'text_changed': return { ...base, pillClass: 'dd-pill dd-pill--accent', kindLabel: 'Text', target: 'text',
                                  before: truncate(c.before), after: truncate(c.after) };
  }
}
```

Intro line: "DOM differences between the base and head renders." Each row (`@for (r of rows(); track r.key)`): `<span [class]="r.pillClass">{{ r.kindLabel }}</span>`, target in `pv-code`, path in `pv-code text-[var(--color-text-tertiary)]` (truncate, full in `title`). Then either token chips — removed tokens as `dd-pill dd-pill--danger` "− token", added as `dd-pill dd-pill--success` "+ token" (wrap, `gap-1`) — or a two-line block `− {{ r.before.shown }}` (`text-[var(--color-error)]`, `[title]="r.before.full"`) / `+ {{ r.after.shown }}` (`text-[var(--color-success)]`). Show the first 200 rows; "Show all N" button sets `limit` to the full length.

#### 5.9.12 `app-harness-panel`

Selector `app-harness-panel`, inline template, no outputs. Injects `NotificationService`. Inputs: `source = input<string | null>(null)`, `notes = input<string | null>(null)`. Derived: `headerLabel` (`computed`): "PRVisionHarness.tsx · 42 lines", or `null` without source.

Content: intro "AI-written harness that renders this component in isolation with mocked props, providers and modules. The same harness renders base and head, so differences come only from the component code."; notes paragraph (`whitespace-pre-line`, interpolated) under a "Notes" label; source in `<pre class="pv-code pv-code-block" tabindex="0">` with a header row `headerLabel()` and a Copy button (`[cdkCopyToClipboard]="source()"`, `(cdkCopyToClipboardCopied)` → toast "Harness copied"). Missing source → "No harness source was saved."

### 5.10 Navigation map

| From | Action | To |
|---|---|---|
| Sidebar | Repositories / Visualizations / Settings | `/repositories`, `/visualizations`, `/settings` |
| Repositories list | Row click, Open, menu Open | `/repositories/:id` |
| Add dialog (detected) | Open repository | `/repositories/:id` |
| Repository detail | Visualize (PR, branch, working tree) → success | `/visualizations/:newId` |
| Repository detail | Launch fails with settings reason → prompt "Open settings" | `/settings` |
| Repository detail | Recent row | `/visualizations/:id` |
| Repository detail | View all | `/visualizations?repositoryId=:id` |
| Repository detail | Remove → confirm → done | `/repositories` |
| PR table | GitHub icon | external `pr.url` (new tab) |
| Visualizations list | Row click, Open | `/visualizations/:id` |
| Visualization detail | Back, after Delete | `/visualizations` |
| Visualization detail | Repository link | `/repositories/:repositoryId` |
| PR/token alerts | Open settings | `/settings` |
| Settings with unsaved changes | Any navigation | confirm "Discard unsaved changes?" |

## 6. Error handling and edge cases

| Case | Behaviour |
|---|---|
| Backend down on first load of any screen | Inline error alert with Retry (loads are silent, so no toast); top bar shows API offline (12). |
| Backend drops during detail polling | Polling continues; after 3 consecutive failures the "Connection lost" warning shows; it clears on the next success. |
| Visualization deleted elsewhere while open | Next poll gets 404 → not-found panel; polling stops. |
| Navigating from one visualization to another (same component instance) | `id` input changes → `store.start(newId)` → `restart$` cancels old pollers; state resets. |
| Non-numeric or zero id in URL | Not-found panel, no request. |
| Console backlog larger than one page | `expand` drains up to 20 pages (10,000 events) per tick; the client keeps the last `CONSOLE_MAX_EVENTS` and shows "Oldest events trimmed". |
| Slow API (a request takes longer than the poll interval) | `exhaustMap` skips ticks while a request is in flight; requests never overlap. |
| Duplicate console events (restart while a page was in flight) | Filtered by `id > lastEventId`. |
| Console request fails | Ignored for that tick (silent); next tick retries. |
| Status flips to terminal between detail and console ticks | Console makes one more fetch after terminal (inclusive `takeWhile`). |
| Cancel while still queued | 200 `{ status: 'cancelled' }` → info toast "Visualization cancelled." + immediate refresh (shows the cancelled state at once). |
| Cancel while running | 202 `{ status: 'cancel_requested' }` → button stays "Cancelling…" until the status is terminal. |
| Cancel on an already-finished run | 409 `already_terminal` → info toast + immediate refresh. |
| Delete or remove while a run is active | 409 `conflict` → interceptor toasts the server message; nothing changes. The UI offers Delete only for terminal runs, so this happens only through a race. |
| Failed or cancelled run | Stepper marks `failedStage` (00 §14.4); falls back to console inference when `failedStage` is null. The alert title names the stage ("Failed during Rendering"). |
| Skipped component | Empty box with the API's `skipReason` (fallback copy when null). |
| Double-click Visualize | Buttons disabled while `launching`. |
| Create returns `working_tree_clean` | Info toast; working-tree card reloads and shows "clean". |
| Create returns `github_token_missing` / `ai_not_configured` / `*_unauthorized` | Action prompt with "Open settings". |
| PR list: repository without GitHub remote | No API call; "No GitHub remote" empty state. |
| Branch list: detached HEAD | `current` null → working-tree subtitle "detached HEAD"; head select defaults to first non-default branch. |
| Head and base branch equal | Visualize disabled with hint. |
| Component with `renderStatus: 'partial'` and `visualChange: 'new'` | Base placeholder "Not present on base — new component"; slider/diff disabled. |
| Both sides failed | Two "Render failed" placeholders + Render errors section open; still shows code/harness sections. |
| Artifact image 404 / load error | `(error)` marks the side failed → "Image unavailable"; modes that need it disable. |
| Base and head images of different sizes | Stacked modes use `object-contain object-left-top`, so both anchor top-left; aspect ratio from `imageWidth/imageHeight`. |
| `imageWidth/Height` null | No aspect-ratio box; images size naturally. |
| `diffPixelRatio` null on a changed component | Pill shows "Changed" without a percent (`visualLabel()` is null, so the pill's default label is used). |
| `className` attribute change with token lists | Structural list shows "+ token" / "− token" chips instead of the long before/after strings. |
| Huge code diff | First 2,000 lines, then "Show all". |
| Huge structural diff | First 200 rows, then "Show all". |
| Summary markdown with HTML/script/images | Sanitized by the pipe: scripts, event handlers, images, styles removed. |
| Settings: user wants to replace a saved token | Types the new value (Remove is hidden while text is present); Save sends the new string. Remove → field disabled until Undo or Save; Save then sends `""` for that field (00 §14.4), never `null`. |
| Settings: provider switched to claude_code with no API key | Valid (key not required); key field hidden. |
| Settings: navigate away with changes | Guard confirm; browser tab close → native beforeunload prompt. |
| Settings: Save returns `validation_failed` | Error alert with `details` list; form keeps values. |
| Test GitHub with unsaved token | "Save & test" saves first; test runs only if save succeeded. |
| Add repository with trailing slash or `~` path | Sent trimmed as typed; the backend expands a leading `~/` (00 §14.4). |
| Add repository for an already-registered folder | 409 with the server message inside the dialog ("This folder is already registered as …"). |
| Repository removed elsewhere while detail open | Next action returns 404 → toast; reload shows not-found. |

## 7. Logging

- No `console.*` calls in feature code (01 lint allows only `console.error`, and nothing here needs it). Failed requests are visible in the browser Network tab and as inline alerts or toasts (sheet 12 §8).
- The store does not log poll failures individually; the UI banner is the signal.
- Never log form values, request bodies, or secret field contents. The settings page never passes secret values to anything but `ApiService.updateSettings`.
- Console events are shown, not produced, by the frontend.

## 8. Security notes

- Secrets: GitHub token and Anthropic key inputs are `type=password` (toggleable), `autocomplete="new-password"`, never pre-filled from the server (the API only returns `hasGithubToken`/`hasAnthropicApiKey`), cleared from the form immediately after a successful save, held only by the form control and the derived in-memory `formValue` signal, never in `localStorage`, URLs, logs or toasts.
- "Saved" indicators are derived from booleans only.
- AI summary: `[innerHTML]="markdown | markdown"` only (DOMPurify + Angular sanitizer). No `bypassSecurityTrust*`.
- AI notes, harness notes/source, code diffs, structural diff values, error messages and console messages are interpolated text.
- Image `src` values come only from `artifactUrl()` (12 §6.18), which accepts `/artifacts/…` paths without `..`, `\\`, `?`, `#` or `//` and prefixes `environment.artifactBaseUrl`.
- External links: PR URLs render only when `isSafeGithubUrl(url)`; repository GitHub links are built from owner/repo matching `^[\w.-]+$`; all use `target="_blank" rel="noopener noreferrer"`.
- ag-grid cell HTML is built with the escaped helpers only.
- The Claude Code provider shows the D5 policy note whenever selected.
- Local path input is free text sent to the local backend, which validates it (06); the frontend does not touch the filesystem.

## 9. Tests (Jasmine/Karma)

Uply's Karma setup through 02: `npm test` runs once headless (00 §14.10), `npm run test:watch` while developing. HTTP tests use `provideHttpClient(withInterceptors([errorInterceptor]))` + `provideHttpClientTesting()` and end with `httpMock.verify()`; component tests use `TestBed` with `fixture.componentRef.setInput(...)`, stubbed services (`jasmine.createSpyObj`) and `provideRouter([])` or `RouterTestingHarness`; MatDialog-hosted components are tested through `MatDialog.open` with `provideNoopAnimations()`; polling tests use `fakeAsync` + `tick`, ending with `discardPeriodicTasks()`.

| File | Cases |
|---|---|
| `core/utils/route-params.util.spec.ts` | `'42' → 42`; `'0' → null`; `'abc' → null`; `'1e3' → null`; `undefined → null`. |
| `core/services/visualization-launcher.service.spec.ts` | `success toasts queued and navigates to /visualizations/:id`; `github_token_missing prompts and navigates to /settings on accept`; `ai_not_configured prompts`; `working_tree_clean info toast, no navigation`; `other error toasts message once (createVisualization is silent, interceptor does not toast)`; `never errors (emits null)`. |
| `features/settings/settings-form.spec.ts` | `blank secret omitted`; `typed secret trimmed and sent`; `clear flag sends "" (never null)`; `clear wins over typed value`; `whitespace-only secret omitted`; `unchanged non-secret fields omitted`; `changed provider/model/efforts included`; `AI_MODEL_PATTERN accepts claude-opus-5-5 and rejects uppercase, spaces and a leading dot (05's rule)`; `anthropicKeyRequired: error when provider anthropic_api, no saved key, nothing typed`; `no error when saved key exists`; `error when saved key being cleared`; `no error for claude_code`; `githubTokenHint`/`anthropicKeyHint` cases. |
| `features/settings/settings-page/settings-page.component.spec.ts` | `shows spinner then form`; `load error renders inline alert without toast`; `Saved pill and placeholder when hasGithubToken`; `secret input never receives a server value`; `Remove sets pending clear, disables input, Undo restores`; `Remove hidden while a value is typed`; `Save disabled when no changes`; `Save sends only pendingUpdate and resets secret fields`; `Remove + Save sends githubToken ""`; `save error renders details`; `Test connection label becomes Save & test when token typed`; `Save & test saves then tests (one PUT, then one POST)`; `Save & test does not test when save fails`; `GitHub test success shows Connected as @login and updates the status pill`; `github_unauthorized result shows error copy`; `claude_code shows policy note and hides key field`; `Test AI success shows model, provider label and latency from AiTestResultView`; `theme segmented control calls ThemeService.setMode`. |
| `features/settings/settings-unsaved-changes.guard.spec.ts` | `true when no changes`; `asks confirm when changes`; `returns confirm result`. |
| `features/repositories/repository-format.spec.ts` | `toDetectedRows includeIdentity adds Name and Path rows, false omits them`; `null viteConfigPath/tsconfigPath/entryFilePath render "Not found"`; `missing Vite config and entry file are flagged warn`; `empty globalStylePaths render "None found"`; `no GitHub remote renders "No GitHub remote (pull requests unavailable)"`; `paths and refs are marked mono`; `frameworkLabel react_vite → "React + Vite"`. |
| `features/repositories/repository-list/repository-list.component.spec.ts` | `renders grid with rows at rowHeight 56`; `package manager rendered raw (pnpm, not Pnpm)`; `empty state with Add button when none`; `load error inline, no toast`; `?add=1 opens dialog once`; `dialog result upserts created rows and navigates when openId set`; `remove asks confirm then deletes row`; `redetect replaces row`. |
| `features/repositories/components/add-repository-dialog/add-repository-dialog.component.spec.ts` | `opened via MatDialog: focus starts in the path field and Tab stays inside the dialog`; `path required and absolute`; `submits trimmed path and optional name`; `primary shows loading while submitting`; `Escape and backdrop ignored while submitting`; each of `not_git_repo`, `unsupported_framework`, `missing_node_modules` renders title, message and tip with no toast; `validation_failed renders details`; `409 renders the server message`; `success switches to detected view with all fields`; `no remote shows info alert`; `Open repository closes with openId`; `Add another resets and keeps created list`; `Cancel closes with created []`. |
| `features/repositories/repository-detail/repository-detail.component.spec.ts` | `invalid id → not found without request`; `404 → not found`; `id change cancels the previous load`; `defaults to Local tab when no GitHub remote`; `?tab=local selects Local`; `tab change updates query param`; `GitHub link only for safe owner/repo`; `remove confirm navigates to list`; `remove 409 conflict toasts once and stays`. |
| `features/repositories/components/pull-request-table/pull-request-table.component.spec.ts` | `no remote → empty state, no request`; `github_token_missing → warning with Open settings link`; `github_unauthorized → error`; `github_rate_limited → warning + Retry`; `empty list copy`; `Visualize calls launcher with github_pr payload and disables all buttons while launching`; `unsafe pr.url hides GitHub link`. |
| `features/repositories/components/local-sources/local-sources.component.spec.ts` | `initial head = current when not default`; `initial base = defaultBranch`; `reload keeps user choices`; `Visualize disabled when head equals base`; `branch launch payload uses headRef/baseRef`; `working tree card disabled with clean copy when workingTreeDirty=false`; `enabled with Changes detected when dirty`; `working_tree launch payload has no baseRef`; `reloads branches on window focus (debounced, no overlap)`; `reloads after launcher emits null`. |
| `features/visualizations/visualization-format.spec.ts` | `refWithSha with and without sha`; `formatDuration boundaries`; `summaryLine uses absolute start time and omits unknown parts`; `noComponentsCopy per status`. |
| `features/visualizations/visualization-list/visualization-list.component.spec.ts` | `pageLoader sends page/pageSize`; `in_progress filter sends seven statuses as one comma-separated param`; `?status=failed selects Failed`; `unknown status → All`; `repositoryId chip and clear`; `filter change updates refreshKey`; `delete only offered for terminal rows`; `cancel only for non-terminal`; `cancel 200 cancelled → "Visualization cancelled." toast`; `cancel 202 → "Cancellation requested" toast`; `cancel 409 → "already finished" toast`; `exactly one toast per cancel outcome`. |
| `features/visualizations/visualization-detail/component-filters.spec.ts` | `changed includes new/deleted`; `failed includes partial with error, excludes partial new`; `counts`; `resolveStoppedStageIndex: failedStage wins over console`; `falls back to last error stage when failedStage null`; `falls back to last known stage`; `unknown → 0`. |
| `features/visualizations/visualization-detail/visualization-detail.store.spec.ts` (fakeAsync) | `polls detail every 2000 ms until terminal then stops`; `a detail request slower than 2000 ms is not overlapped or cancelled (exhaustMap)`; `polls console every 1500 ms with afterId of last event`; `one console fetch after terminal then stops`; `terminal on first load → single detail request`; `drains console pages when batch is full (limit 500)`; `dedupes console events by id`; `caps events and sets trimmed`; `404 → not_found and both pollers stop`; `first-load error → error state, keeps polling, recovers`; `3 consecutive failures → connectionLost, cleared by success`; `start(newId) cancels old pollers and resets state`; `destroy stops polling (no pending requests)`; `default filter: changed when any changed, else failed, else all`; `setFilter overrides default`; `components sorted by rank then id`; `stoppedStageIndex uses failedStage`; `cancel 202 → requested`; `cancel 200 → info + refresh`; `cancel already_terminal → info + refresh`; `remove only when terminal`. |
| `features/visualizations/visualization-detail/visualization-detail.component.spec.ts` | `renders header meta (source, repo link, refs with short shas, status)`; `working_tree head shows "working tree"`; `Cancel visible only non-terminal and asks confirm`; `Delete visible only terminal, confirm → navigate`; `failed shows "Failed during <stage>" from failedStage with errorMessage`; `cancelled shows "Cancelled during <stage>"`; `filter chips show counts`; `cards render in rank order`; `empty copy for each terminal state`; `page title set from detail`. |
| `features/visualizations/components/pipeline-stepper/pipeline-stepper.component.spec.ts` | `rendering: first four done, rendering current (aria-current=step), rest pending`; `completed: all done`; `failed at index 3: 0–2 done, 3 failed, rest pending`; `cancelled marks stop stage cancelled`; `queued: first current`; `hidden state text present for each step`. |
| `features/visualizations/components/console-panel/console-panel.component.spec.ts` | `renders level, stage and message as text (HTML not interpreted)`; `uses pv-console__* classes, no text-slate-* classes`; `role=log and aria-live=polite while live`; `aria-live=off when not live`; `auto-scrolls when at bottom`; `does not scroll when user scrolled up and shows Jump to latest with unseen count`; `Issues filter hides info`; `Show earlier increases render limit`; `opens by default while live and collapses when defaultOpen becomes false unless user toggled`; `copy writes plain text`. |
| `features/visualizations/components/summary-card/summary-card.component.spec.ts` | `renders markdown headings/lists`; `strips script and img from summary`; `skeleton while running and null`; `empty copy when completed and null`; `empty copy when failed`. |
| `features/visualizations/components/component-card/component-card.component.spec.ts` | `pills for change kind, visual change with percent, risk`; `render status pill hidden when rendered`; `AI note shown as text`; `changeReason line shown when present`; `pending shows waiting placeholder`; `skipped shows skipReason, falls back to default copy`; `errors section open with per-side messages`; `code diff section renders only after open`; `affected_parent without diff or changeReason shows the generic explanation`; `structural section count`; `harness section present only with source or notes`. |
| `features/visualizations/components/image-compare/image-compare.component.spec.ts` | `side-by-side shows both images with alt text and width/height attributes`; `new component: base placeholder text, slider and diff disabled`; `deleted component: head placeholder`; `slider: range input updates clip-path`; `range has aria-label and aria-valuetext`; `ArrowRight on range increases split` (dispatch keyboard + input events); `pointer drag sets split`; `diff mode opacity binding and Diff only hides head`; `image error marks side unavailable and falls back to side mode`; `100% zoom sets image width and scroll region`; `artifact URLs prefixed with environment.artifactBaseUrl via artifactUrl()`; `non-/artifacts/ URL treated as missing`. |
| `features/visualizations/components/code-diff/unified-diff.spec.ts` | `parses headers as meta`; `hunk header sets line numbers`; `add/del/context numbering`; `"\ No newline" is note`; `CRLF input`; `content line "--- x" inside a hunk is a deletion`; `multiple files in one diff`; `keys are unique and sequential`; `countDiffStats`. |
| `features/visualizations/components/code-diff/code-diff.component.spec.ts` | `applies line classes`; `keeps +/- prefix visible`; `renders <script> text literally`; `limits to 2000 lines with Show all`. |
| `features/visualizations/components/structural-diff-list/structural-diff-list.component.spec.ts` | `one row per kind with correct pill tone and label`; `null attribute values shown as ∅`; `className change with tokensAdded/tokensRemoved shows token chips instead of before/after`; `long values truncated with title`; `Show all after 200`. |

## 10. Acceptance criteria

01 §5.17 Definition of Done applies. Every item is checkable by DevTools (Network/Elements/Console), a command, or a named spec.

Settings

- [ ] Loading `/settings` with a saved token shows "Saved" pills and placeholders; no secret value is present in the DOM (Elements: both secret inputs have an empty `value`).
- [ ] Network tab: saving with blank secret fields sends a PUT body without `githubToken`/`anthropicApiKey` keys; Remove + Save sends `"githubToken": ""`; no PUT body ever contains `null`; a typed value is sent once and the field is empty afterward.
- [ ] Choosing Claude Code shows the subscription-login policy note and hides the API key field; choosing Anthropic API with no saved key blocks Save with "An API key is required…".
- [ ] Test connection shows "Connected as @login" for a valid token and the `github_unauthorized` copy for a bad one; Test AI shows model + provider + latency or the server's message.
- [ ] Leaving with unsaved changes asks for confirmation.

Repositories

- [ ] Adding a valid Vite + React clone shows the detected values and "Open repository" navigates to its detail.
- [ ] Adding a non-git folder, a non-React folder and a project without `node_modules` each shows the specific title, message and tip inside the dialog, with no toast.
- [ ] The add dialog keeps keyboard focus inside while open (Tab cycles), Escape closes it, and focus returns to the "Add repository" button.
- [ ] Repository list supports Open, Re-detect and Remove (with confirm); empty state appears with no repositories; the grid fills the viewport height like Uply's monitor list.
- [ ] Repository detail: PR tab lists open PRs; without a token it shows the "GitHub token needed" alert with a working "Open settings" link; without a remote it shows "No GitHub remote" and defaults to the Local tab.
- [ ] Local tab: branch Visualize is disabled for identical branches; the Working tree card is disabled with "Working tree is clean — nothing to visualize." on a clean repo, and becomes enabled after editing a file and re-focusing the window.
- [ ] Every Visualize button navigates to `/visualizations/:id` after a "queued" toast; Network shows the body uses `headRef`/`baseRef` for branches and no `baseRef` for the working tree.

Visualizations

- [ ] History grid pages server-side (20/50/100), filters by status (All/In progress/Completed/Failed/Cancelled; In progress sends `status=queued,preparing,…` as one param) and by repository via query params, and survives reload with filters intact.
- [ ] Detail of a running visualization: Network shows `GET /visualizations/:id` every ~2 s and `GET …/console?afterId=…` every ~1.5 s, never two of the same request in flight at once (throttle the network to "Slow 3G" to check); both stop within one interval after the status becomes terminal; navigating away stops them immediately.
- [ ] Stepper shows done/current/pending correctly during a run; a failed run marks the `failedStage` stage red and the alert reads "Failed during <stage>"; a cancelled run marks it amber.
- [ ] Console auto-scrolls while at the bottom, stops when the user scrolls up (Jump to latest appears), is announced politely by a screen reader (VoiceOver/Orca spot check), and its text keeps the same colours in light and dark themes.
- [ ] AI summary renders markdown (headings, lists, code); a summary containing `<img src=x onerror=alert(1)>` or `<script>` renders no image and runs nothing.
- [ ] Filter chips show correct counts; default is Changed when any changed component exists.
- [ ] Component cards are ordered by rank and show name, file, change reason, change kind, visual change + diff %, risk + AI note; skipped cards show the API's `skipReason`.
- [ ] Image viewer: Side-by-side, Slider and Diff work; slider is operable with the keyboard (Tab to the range, arrows move the split); Fit/100% toggles; a new component shows the base placeholder and disables Slider/Diff; a deleted component shows the head placeholder; every `<img src>` starts with `http://localhost:3100/artifacts/`.
- [ ] Code diff shows coloured added/removed lines with line numbers; structural diff (with className token chips) and harness sections expand; per-side render errors appear in the Render errors section.
- [ ] Cancel asks for confirmation, then shows "Cancelling…" until terminal (or "Visualization cancelled" at once for a queued run); Delete (terminal only) confirms and returns to the list. Each outcome produces exactly one toast.
- [ ] Both themes render every screen legibly (no dark text on dark surfaces, no white grid in dark mode).
- [ ] `npm run verify` passes in `frontend/`; `grep -rnE "bypassSecurityTrust|\*ngIf|\*ngFor|ngModel|\$any\(|constructor\((private|public)" frontend/src/app/features` returns nothing; `grep -rn "track \$index" frontend/src/app` returns nothing.

## 11. Contract changes requested

1. Resolved — 00 §14.4 (`PUT /api/settings` partial update; secrets omitted = keep, `""` = clear, `null` = 400).
2. Resolved — 00 §14.4 (`POST /api/settings/test-github` → `{ login }`).
3. Resolved — 00 §14.4 (`POST /api/settings/test-ai` → `{ provider, model, latencyMs }`).
4. Resolved — 00 §14.4 (`GET /api/repositories` returns an array).
5. Resolved — 00 §14.4 (`RepositoryCreateRequest { localPath, name? }`, `~/` expanded server-side).
6. Resolved — 06 §5.5/§5.6.4 and 00 §14.2/§14.12: `GET /api/repositories/:id/pull-requests` returns open PRs only, in GitHub's `updated` desc order, at most 300; errors `no_github_remote` (400), `github_token_missing` (400), `github_unauthorized` (400, also for a repository the token cannot see), `github_rate_limited` (429), `github_unavailable` (502), `validation_failed` (400, GitHub 422) and `not_found` (404, repository row). The PR table states in §5.7.4 cover each.
7. Resolved — 06 §5.5 `listBranches()` and 04 `GitClient.listBranches` (`--sort=-committerdate`): local branches only, **most recent commit first** (not alphabetical), truncated to 500 with `current` and `defaultBranch` always included; `current` null on detached HEAD; `workingTreeDirty` includes untracked non-ignored files; a missing folder or git failure is 400 `not_git_repo`. The branch selects show the API order unchanged.
8. Resolved — 00 §14.4 (`VisualizationCreateRequest` with `headRef`/`baseRef`; 202 `CreateVisualizationResponse`).
9. Resolved — 00 §14.4 (list `status` is a comma-separated list).
10. Resolved — 00 §14.4 (console `afterId` exclusive, `limit` default and max 500, oldest first).
11. Resolved — 00 §14.4 (console `stage` values are the pipeline status names).
12. Resolved — 00 §14.4 (cancel: 200 `cancelled` / 202 `cancel_requested` / 409 `already_terminal`).
13. Resolved — 00 §14.4 (`DELETE /api/visualizations/:id` → 200 `{ id }`; 409 `conflict` while non-terminal).
14. Resolved — 00 §14.4 (`failedStage` on `VisualizationDetailView`; the stepper uses it and falls back to console inference only when null).
15. Resolved — 00 §14.11. Original note: for `working_tree`, the `baseRef` comment says it "defaults to repository.defaultBranch", while sheet 07 compares the working tree with the checked-out commit (`current ?? "HEAD"`). The UI sends no `baseRef` and describes the comparison as "with the checked-out commit" (07's behaviour). The lead should confirm 07's semantics in 00.
