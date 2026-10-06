# 12 — Frontend Foundation (Uply-parity shell and design system)

Owner: build agent (frontend foundation)
Build wave: 2 (depends only on 00 contracts and 02 repo scaffold)
Status: implementation-ready (Revision 2: conforms to 00 §14, 01 §5.2.2/§5.3.2/§5.14 and 02 §6.11)
Donor: `~/dev/Uply-v2/tenant-frontend/` (read-only; copy and strip, never import at runtime)

Ownership rule: sheet 02 creates the frontend workspace (`package.json`, `angular.json`, `tsconfig*.json`, `eslint.config.mjs`, `.prettierrc.json`, `.postcssrc.json`, `scripts/karma-chrome.mjs`, environments, `core/constants/polling.constants.ts`). This sheet changes only the keys listed in §6.1 and §6.18 and never rewrites those files. Where this sheet and 01/02 disagree, 01/02 win and this sheet is wrong.

---

## 1. Purpose

Create the Angular 19 application skeleton for PRVision under `PRVision/frontend/` and a design system that looks and feels the same as Uply-v2's tenant frontend. Sheet 13 builds every feature screen on top of what this sheet delivers. After this sheet, a developer can run `npm start` in `frontend/`, open `http://localhost:4210`, see the PRVision shell (sidebar, top bar, theme toggle, API health indicator), move between placeholder Repositories, Visualizations and Settings pages, and hit a styled not-found page. Every shared building block that 13 needs (API access, error handling, toasts, confirm dialogs, status pills, data grid, empty/loading states, pipes, models, utilities) exists and is tested.

## 2. Scope / Out of scope

In scope:

- Deltas to 02's workspace: extra dependencies in `package.json`, the `styles` arrays, budgets and schematics in `angular.json` (§6.1). New file `tailwind.config.js` (Uply copy, inert). Replace 02's `src/index.html`, `src/styles.scss`, `public/favicon.svg` and the placeholder `app.config.ts` / `app.routes.ts` / `app.component.ts` / `app.component.spec.ts`.
- `app.config.ts`, `app.routes.ts` (complete route table, with stub feature components that 13 replaces), title strategy, `app.component.ts`.
- Global styles: `src/styles.scss` (Uply copy, stripped) and `src/styles/prvision.scss` (dark theme layer plus PRVision-only classes).
- Theme service (dark default, light toggle, persisted in `localStorage` with try/catch).
- Main layout: sidebar nav (Repositories, Visualizations, Settings), top bar, content area, responsive drawer.
- Core: `ApiService` (the only `HttpClient` user, one typed method per route, 01 §5.14.3), `ApiError`, error interceptor, HTTP context token, `NotificationService`, `ConfirmDialogService`, `HealthService`, typed models for every 00 §9/§14.4 view shape plus enums, shared utilities (status helpers, error copy, artifact URLs) and constants.
- Shared components: page-header, status-pill, segmented-control, inline-alert, data-grid (+ helpers + action menu renderer), empty-state, loading-spinner, generic-popup, confirm-dialog, action-message-dialog, not-found page.
- Shared pipes: `relativeTime`, `dateTime`, `bytes`, `compactNumber`, `diffPercent`, `shortSha`, `artifactUrl`, `markdown`.
- Unit tests (Jasmine/Karma, Uply setup through 02's `scripts/karma-chrome.mjs`) for everything above.
- The Uply visual token reference (section 6.7) and a UI pattern cookbook (section 6.20) that 13 must follow.

Out of scope:

- Feature screens, the visualization store, image viewer, console panel, code diff rendering (all sheet 13).
- Backend, CORS configuration (sheet 04), root `package.json` scripts that boot everything, frontend `package.json` scripts, tsconfig, ESLint and Prettier configs (sheet 02 from 01).
- Auth, tenants, billing, branding uploads, marketing pages, onboarding, charts (Uply features that PRVision does not have).
- i18n. All copy is English.
- E2E tests (sheet 14).

## 3. Dependencies

| Depends on | What is used |
|---|---|
| 00 §4 | Frontend dev server port `4210`; backend `127.0.0.1:3100`. |
| 00 §5 | Enum values (mirrored as `as const` arrays in `core/models/domain-enums.model.ts`). |
| 00 §9 + §14.4 | Endpoint paths, pagination `{ items, page, pageSize, total }`, view shapes (§14.4 replaces the §9 rows it names), request shapes. |
| 00 §14.2 | Wire envelope `{ status, data }` / `{ status, error, error_reason }` and the complete `error_reason` list. The frontend supports only this format (no Uply raw bodies). |
| 00 §12 | Route table, folder layout, `environment.apiBaseUrl` / `environment.artifactBaseUrl`, polling intervals. |
| 00 §14.9 | Dark theme defined new in `styles/prvision.scss`; Uply light palette unchanged; `tailwind.config.js` copied but not wired; fonts and icons bundled locally. |
| 00 §14.10 | `npm test --prefix frontend` is one headless run; `test:watch` keeps watch mode (02 already defines both scripts). |
| 01 §5.2.2, §5.3.2, §5.5.4, §5.14 | tsconfig (`noUncheckedIndexedAccess`), ESLint (`strictTypeChecked`, `prefer-signals`, `prefer-on-push…`, `no-console` allows only `error`), file naming, Angular practices. Every code block in this sheet must compile and lint under them. |
| 02 §6.11 | Workspace files, `scripts/karma-chrome.mjs`, environments, `core/constants/polling.constants.ts` (`VISUALIZATION_POLL_MS`, `CONSOLE_POLL_MS`). |
| Uply donor | Files listed in section 4. |

Libraries. 02 already installs Angular 19.2, Material/CDK 19.2, ag-grid 35, Tailwind 4, `marked ^18`, RxJS 7.8, zone.js 0.15 and the Karma/Jasmine/ESLint dev tooling (same majors as Uply). This sheet adds only these runtime dependencies (`npm install --save` in `frontend/`; caret on the newest release of the major; the lockfile records exact versions):

| Package | Version | Why |
|---|---|---|
| `dompurify` | `^3.2.0` | Sanitizes markdown HTML from `marked` (ships its own types). |
| `@fontsource/manrope` | `^5.1.0` | Self-hosted Manrope (00 §14.9: bundled, works offline). |
| `material-icons` | `^1.13.12` | Self-hosted `Material Icons` font (default `mat-icon` font set). |
| `material-symbols` | `^0.27.0` | Self-hosted `Material Symbols Rounded` (sidebar icons, as in Uply). |

Dropped from Uply (02 already dropped them): `chart.js`, `ng2-charts`.

## 4. Donor map (copy verbatim / copy and adapt / strip / new)

"Copy verbatim" means byte-for-byte except import paths, plus the minimum changes needed to pass 01's tsconfig and ESLint (OnPush, `inject()`, signals, `interface` instead of object `type`, no non-null assertions, `noUncheckedIndexedAccess` guards). "Copy and adapt" means keep the markup and CSS classes (the look) but rewrite the TypeScript to the fixed practices in section 6.0. "Strip" means delete the named parts. Never silence a lint rule for a whole file to make a copied Uply file pass, except the one documented exception in §6.16.5.

| Uply source (`tenant-frontend/…`) | PRVision target (`frontend/…`) | Action |
|---|---|---|
| `.editorconfig`, `.postcssrc.json`, `.gitignore`, `eslint.config.mjs`, `tsconfig*.json`, `src/main.ts`, `src/environments/*.ts` | — | Not touched here. 02 already placed them (01 §5.2.2, §5.3.2). |
| `tailwind.config.js` | same | Copy verbatim. Do **not** wire it with `@config` (see 6.1.4). |
| `angular.json` | 02's file | Change only the keys in 6.1.2. |
| `src/index.html` | same | Replace 02's file (6.2). |
| `src/styles.scss` | same | Replace 02's placeholder with Uply's file, stripped (6.8.1). |
| — | `src/styles/prvision.scss` | New (6.8.2). |
| `src/app/app.config.ts` | same | Replace 02's placeholder (6.4). |
| `src/app/app.routes.ts` | same | Replace 02's placeholder; Uply lazy-route style (6.5). |
| `src/app/app.component.ts` (+ 02's `app.component.spec.ts`) | same | Copy markup (`dd-app-root`, `dd-glow-layer`, `dd-app-surface`); remove auth/theme effect (6.6). Rewrite 02's spec to assert the glow layer and router outlet render. |
| `layouts/main-layout/main-layout.component.ts` | same | Copy and adapt: keep sidebar classes and nav item markup; remove tenant logo, role-gated groups, user menu, getting-started guide; add top bar and responsive drawer (6.10). |
| `core/services/api.service.ts` | same | New implementation (6.12): one generic private request core plus one typed method per 00 §9/§14.4 route (01 §5.14.3). Uply's endpoints are not copied. |
| `core/services/theme.service.ts` | same | New implementation (6.9). Uply's branding color-mixing is not copied (PRVision has one fixed palette: Uply's default "Cedar Mist"). |
| `core/services/notification.service.ts` | same | Copy verbatim (already uses `inject()`); rename `runStarted()` to `queued()` (6.14). |
| `core/services/confirm-dialog.service.ts` | same | Copy verbatim. |
| `core/interceptors/error.interceptor.ts` | same | New behaviour (6.13). |
| `core/interceptors/jwt.interceptor.ts` | — | Not copied (no auth). |
| `core/services/auth.service.ts`, `core/guards/*` | — | Not copied. |
| `core/utils/*`, `core/models/*`, `core/constants/*` | — | Not copied (Uply domain). PRVision models, utils and constants are new (6.11, 6.18). |
| `shared/components/status-pill/status-pill.component.ts` | same | Copy markup (`dd-pill` + tone class); new PRVision mapping (6.16.2). |
| `shared/components/empty-state/empty-state.component.ts` | same | Copy and adapt (signal inputs, action slot). |
| `shared/components/loading-spinner/loading-spinner.component.ts` | same | Copy and adapt (inputs, a11y label). |
| `shared/components/generic-popup/generic-popup.component.ts` | same | Copy and adapt (signals, `@if`, OnPush, token colours). |
| `shared/components/confirm-dialog/confirm-dialog.component.ts` | same | Copy; swap `text-slate-700` for token colour; OnPush; `inject(MAT_DIALOG_DATA)`. |
| `shared/components/action-message-dialog/action-message-dialog.component.ts` | same | Copy; OnPush; `inject(MAT_DIALOG_DATA)`. |
| `shared/components/data-grid/data-grid.component.ts` | same | Copy; add OnPush (documented exception keeps `@Input`, 6.16.5). |
| `shared/components/data-grid/data-grid-helpers.ts` | same | Copy and strip currency helpers; replace status pill helpers (6.16.5). |
| `shared/components/data-grid/action-menu-cell-renderer.component.ts` | same | Copy; add OnPush; `items` becomes `signal<ActionMenuItem[]>([])` (set in `agInit` and `refresh`, otherwise OnPush shows stale items); `ActionMenuItem` becomes an `interface`; remove `CommonModule`. |
| `shared/components/run-console-popup`, `run-detail-popup` | — | Not copied. Their look (dark terminal panel, `<details>` expanders) is reused by 13's console panel and component card. |
| `shared/pipes/time-ago.pipe.ts` | `shared/pipes/relative-time.pipe.ts` | Copy logic; rename to `relativeTime`; add fallback arg. |
| `public/branding/*` | — | Not copied. 02's `public/favicon.svg` is kept unchanged. |

## 5. File inventory

All paths relative to `PRVision/frontend/`. "13 replaces" marks stubs that sheet 13 overwrites. "02 file" rows are files 02 created that this sheet changes in place.

| File | Responsibility |
|---|---|
| `package.json` (02 file) | Add the four dependencies in §3. Scripts unchanged. |
| `angular.json` (02 file) | Change only the keys in 6.1.2. |
| `tailwind.config.js` | Uply copy, inert (editor tooling only). |
| `src/index.html` (02 file, replaced) | Root document, default `shell--tenant-dark` class, no remote font links. |
| `src/styles.scss` (02 file, replaced) | Uply global styles, stripped. |
| `src/styles/prvision.scss` | Dark theme tokens, dark fixes, PRVision classes. |
| `src/app/app.component.ts` (+ spec; 02 files, replaced) | Root shell (glow layer + router outlet). |
| `src/app/app.config.ts` (02 file, replaced) | Providers. |
| `src/app/app.routes.ts` (02 file, replaced) | Route table. |
| `src/app/core/services/page-title.strategy.ts` | `PrvisionTitleStrategy` ("X · PRVision"). |
| `src/app/core/services/api.service.ts` (+ `.spec.ts`) | The only `HttpClient` user: typed method per route, envelope unwrapping. |
| `src/app/core/services/theme.service.ts` (+ spec) | Dark/light mode. |
| `src/app/core/services/notification.service.ts` (+ spec) | Toasts and action prompts (Uply copy). |
| `src/app/core/services/confirm-dialog.service.ts` (+ spec) | Confirm dialogs (Uply copy). |
| `src/app/core/services/health.service.ts` (+ spec) | Polls `GET /api/health`, exposes API online state. |
| `src/app/core/interceptors/error.interceptor.ts` (+ spec) | Maps errors to `ApiError`, toasts unless suppressed. |
| `src/app/core/interceptors/http-context-tokens.ts` | `SUPPRESS_ERROR_TOAST` context token (name from 01 §5.14.3). |
| `src/app/core/models/domain-enums.model.ts` | Enum value arrays + union types (00 §5). |
| `src/app/core/models/api.model.ts` | Envelope, paging, error-reason types, `HealthView`, `DeleteResult`. |
| `src/app/core/models/api-error.model.ts` (+ spec) | `ApiError` class and `toApiError()` mapper. |
| `src/app/core/models/settings.model.ts` | `SettingsView`, `SettingsUpdateRequest`, `GithubTestResultView`, `AiTestResultView`. |
| `src/app/core/models/repository.model.ts` | `RepositoryView`, `PullRequestView`, `BranchListView`, `RepositoryCreateRequest`. |
| `src/app/core/models/visualization.model.ts` | Visualization views, component view, `StructuralChange`, console, requests, cancel response. |
| `src/app/core/models/index.ts` | Barrel. |
| `src/app/core/constants/polling.constants.ts` (02 file) | Keep 02's `VISUALIZATION_POLL_MS`, `CONSOLE_POLL_MS`; add `HEALTH_POLL_MS`, `POLL_FAILURE_BANNER_THRESHOLD`. |
| `src/app/core/constants/pagination.constants.ts` | `DEFAULT_PAGE_SIZE`, `PAGE_SIZE_OPTIONS`. |
| `src/app/core/constants/ui.constants.ts` | `APP_VERSION`, `CONSOLE_BATCH_LIMIT`, `CONSOLE_MAX_PAGES_PER_TICK`, `CONSOLE_MAX_EVENTS`, `MARKDOWN_MAX_CHARS`, `RECENT_VISUALIZATIONS_LIMIT`. |
| `src/app/core/utils/error-messages.util.ts` (+ spec) | `error_reason` → user copy and suggested action. |
| `src/app/core/utils/visualization-status.util.ts` (+ spec) | Terminal check, pipeline stage list, stage index. |
| `src/app/core/utils/labels.util.ts` (+ spec) | `formatPillLabel`, source labels, ref formatting, safe GitHub URLs, `providerLabel`. |
| `src/app/core/utils/artifact-url.util.ts` (+ spec) | `artifactUrl(path)`: `/artifacts/…` → absolute URL from `environment.artifactBaseUrl` (01 §5.14.3). |
| `src/app/layouts/main-layout/main-layout.component.ts` (+ `.html`, + spec) | Sidebar, top bar, content, drawer. |
| `src/app/shared/components/page-header/page-header.component.ts` (+ spec) | Page title block with meta and actions slots. |
| `src/app/shared/components/status-pill/status-pill.component.ts` (+ spec) | `dd-pill` with PRVision mappings. |
| `src/app/shared/components/status-pill/status-pill.config.ts` | Kind → value → tone/label table. |
| `src/app/shared/components/segmented-control/segmented-control.component.ts` (+ spec) | Uply segmented button group (modes, filter chips). |
| `src/app/shared/components/inline-alert/inline-alert.component.ts` (+ spec) | Tinted info/success/warning/error banner. |
| `src/app/shared/components/empty-state/empty-state.component.ts` (+ spec) | Dotted text-only empty box. |
| `src/app/shared/components/loading-spinner/loading-spinner.component.ts` | Centered `mat-spinner`. |
| `src/app/shared/components/generic-popup/generic-popup.component.ts` (+ spec) | Dialog chrome (header/body/footer, focus trap). |
| `src/app/shared/components/confirm-dialog/confirm-dialog.component.ts` | Confirm content for `ConfirmDialogService`. |
| `src/app/shared/components/action-message-dialog/action-message-dialog.component.ts` | Prompt content for `NotificationService.promptAction`. |
| `src/app/shared/components/data-grid/data-grid.component.ts` | ag-grid wrapper (client + server paging). |
| `src/app/shared/components/data-grid/data-grid-helpers.ts` (+ spec) | Cell HTML helpers (escaped). |
| `src/app/shared/components/data-grid/action-menu-cell-renderer.component.ts` (+ spec) | Row "more" menu. |
| `src/app/shared/components/not-found-page/not-found-page.component.ts` (+ spec) | `**` route and embeddable "not found" panel. |
| `src/app/shared/pipes/relative-time.pipe.ts` (+ spec) | "3 min ago". |
| `src/app/shared/pipes/date-time.pipe.ts` (+ spec) | Locale date/time from ISO. |
| `src/app/shared/pipes/bytes.pipe.ts` (+ spec) | "1.5 KB". |
| `src/app/shared/pipes/compact-number.pipe.ts` (+ spec) | "12.3K" (token counts). |
| `src/app/shared/pipes/diff-percent.pipe.ts` (+ spec) | `diffPixelRatio` → "1.24%". |
| `src/app/shared/pipes/short-sha.pipe.ts` (+ spec) | First 7 chars. |
| `src/app/shared/pipes/artifact-url.pipe.ts` (+ spec) | Template wrapper around `artifactUrl()`. |
| `src/app/shared/pipes/markdown.pipe.ts` (+ spec) | `marked` + DOMPurify → safe HTML string. |
| `src/app/features/repositories/repository-list/repository-list.component.ts` | Stub (13 replaces). |
| `src/app/features/repositories/repository-detail/repository-detail.component.ts` | Stub (13 replaces). |
| `src/app/features/visualizations/visualization-list/visualization-list.component.ts` | Stub (13 replaces). |
| `src/app/features/visualizations/visualization-detail/visualization-detail.component.ts` | Stub (13 replaces). |
| `src/app/features/settings/settings-page/settings-page.component.ts` | Stub (13 replaces). Routed page naming per 01 §5.5.4. |

Specs live next to their source as `*.spec.ts` (Uply convention; 02's `tsconfig.spec.json` includes `src/**/*.spec.ts`).

## 6. Detailed design

### 6.0 Fixed practices (apply to every file in this sheet and 13)

- Standalone components only. No NgModules. Do not write `standalone: true` (01 §5.14.2).
- `changeDetection: ChangeDetectionStrategy.OnPush` on every component.
- Signals for state: `signal`, `computed`, `input()`, `input.required()`, `output()`, `model()`, `viewChild()`. `effect()` only for DOM/side-effect sync (theme class, popup open/close, auto-scroll, starting a poll for a new route id), never to copy one signal into another. Signal and injected fields are `readonly`; template-only members are `protected`.
- `inject()` only. No constructor parameter injection.
- Built-in control flow (`@if`, `@for` with `track`, `@switch`). No `*ngIf`, `*ngFor`, `ngClass` (use `[class.x]` or a computed class string). `track` uses a stable key (`id`, enum value, branch name, or a `key` field the parser assigns); never `$index` for server data.
- Templates hold only simple expressions: signal reads, property access, comparisons, a ternary on one condition between two literals, pipes and event handlers. String building, nested conditions, arithmetic and helper-function calls become a `computed` in the class (for per-row values in an `@for`, compute an array of view-model rows). No `$any()` (01 `template/no-any`): read DOM event values in a class method.
- Lazy `loadComponent` for every feature route; `withComponentInputBinding()` delivers route and query params to `input()` signals.
- Typed reactive forms with `NonNullableFormBuilder`; read with `getRawValue()`. No `ngModel`.
- Subscriptions end with `takeUntilDestroyed(this.destroyRef)`, complete by themselves (single HTTP call) or are created via `toSignal`. In components and component-scoped stores, single HTTP calls also get `takeUntilDestroyed` so a response arriving after navigation is dropped (13 §5.1); only root services skip it (`VisualizationLauncherService` relies on completion; `HealthService`'s poll intentionally lives as long as the app, §6.10.2). No nested `subscribe`; chain with `switchMap`/`exhaustMap`/`concatMap`.
- Polling: `timer(0, ms).pipe(exhaustMap(() => request.pipe(catchError(...))), takeWhile(pred, true), takeUntilDestroyed(this.destroyRef))`. `exhaustMap` is deliberate: a tick that fires while the previous request is still in flight is skipped, so requests never overlap and a slow backend is never starved by cancellation (which `switchMap` would do). Errors are caught inside the inner observable so one failed request does not end the poll. Polls keep running while the browser tab is hidden (00 §12 does not ask for pausing; the backend is local).
- Code must pass 01's tsconfig (`noUncheckedIndexedAccess`: index reads are `T | undefined`, use `.at()`, guards or `?? fallback`) and ESLint (`strictTypeChecked`: no non-null assertions in `src/**/*.ts` outside specs, no floating promises — prefix router navigations with `void`, `no-console` allows only `console.error`).
- Templates use token colours (`text-[var(--color-text-primary)]` etc.), not raw `slate`/`gray`/`white` utilities, so both themes work. Exception: terminal-style panels (console, code) are intentionally `bg-slate-950 text-slate-100` in both themes, as in Uply's run console.
- Uply style that differs from these practices (constructor injection, `*ngIf`, default change detection, `[(ngModel)]`) is not reproduced; only Uply's markup, classes and CSS are.

Colour-utility translation table for copied markup (apply when copying any Uply template):

| Uply utility | PRVision replacement |
|---|---|
| `text-slate-900`, `text-slate-800`, `text-gray-900` | `text-[var(--color-text-primary)]` |
| `text-slate-700`, `text-slate-600`, `text-gray-600` | `text-[var(--color-text-secondary)]` |
| `text-slate-500`, `text-slate-400`, `text-gray-500` | `text-[var(--color-text-tertiary)]` |
| `bg-white`, `bg-white/85`, `bg-white/90` | `bg-[var(--color-bg-secondary)]` |
| `bg-slate-50`, `bg-slate-50/70`, `bg-slate-100` | `bg-[var(--color-bg-tertiary)]` |
| `border-slate-200`, `border-slate-200/80`, `border-gray-100` | `border-[color:var(--color-border)]` |
| `divide-slate-100`, `divide-slate-200/80` | `divide-[color:var(--color-border)]` |
| `text-rose-600`, `text-red-600` | `text-[var(--color-error)]` |
| `text-emerald-600`, `text-green-600` | `text-[var(--color-success)]` |

### 6.1 Workspace and tooling

#### 6.1.1 `package.json`

02's file (02 §6.11.1) stays as written, including its scripts, which already match 00 §14.10:

| Script | Command | Use |
|---|---|---|
| `test` | `node scripts/karma-chrome.mjs --watch=false` | One headless Karma run (ChromeHeadless; `CHROME_BIN` defaults to Playwright's Chromium). CI and acceptance use this. |
| `test:watch` | `node scripts/karma-chrome.mjs` | Watch mode while developing. |
| `lint` | `ng lint --max-warnings 0` | 01 §5.3.2 rules. |
| `verify` | format check + lint + build + test | Definition of Done gate. |

This sheet only adds the four dependencies listed in §3. There is no `test:ci` script; do not add one.

#### 6.1.2 `angular.json` deltas

Keep 02's file (project name `frontend`, `outputPath: dist/frontend`, serve `localhost:4210`, lint target) and change exactly these keys:

| Key | 02 value | Change to |
|---|---|---|
| `schematics` | `skipTests: true` | `skipTests: false` for component, directive, guard, interceptor, pipe, service (keep component `style: scss`, `changeDetection: OnPush`). |
| `build.options.styles` | `["@angular/material/prebuilt-themes/azure-blue.css", "src/styles.scss"]` | the array below |
| `test.options.styles` | same as build | the array below |
| `build.configurations.production.budgets` | initial 750kB/1.5MB, component style 4kB/8kB | initial `1MB` warn / `2MB` error (ag-grid + marked + DOMPurify + bundled font CSS); component style unchanged |

`styles` array (order matters: base before PRVision layer, fonts first):

```json
"styles": [
  "node_modules/@fontsource/manrope/400.css",
  "node_modules/@fontsource/manrope/500.css",
  "node_modules/@fontsource/manrope/600.css",
  "node_modules/@fontsource/manrope/700.css",
  "node_modules/@fontsource/manrope/800.css",
  "node_modules/material-icons/iconfont/filled.css",
  "node_modules/material-symbols/rounded.css",
  "@angular/material/prebuilt-themes/azure-blue.css",
  "src/styles.scss",
  "src/styles/prvision.scss"
]
```

Everything else in 02's `angular.json` (polyfills, `inlineStyleLanguage`, assets, `fileReplacements`, `cli.analytics: false`) is unchanged.

#### 6.1.3 TypeScript and ESLint

Not changed by this sheet. 02 places 01 §5.2.2 (`strict`, `noUncheckedIndexedAccess`, `noPropertyAccessFromIndexSignature`, `strictTemplates`, …) and 01 §5.3.2 (`strictTypeChecked`, `prefer-on-push-component-change-detection`, `prefer-signals`, `prefer-inject`, template `prefer-control-flow`, `button-has-type`, accessibility rules, `no-console` allowing only `error`). Unused locals and parameters are caught by `@typescript-eslint/no-unused-vars`.

#### 6.1.4 Tailwind 4 and the inert `tailwind.config.js`

Uply loads Tailwind with `@use 'tailwindcss';` at the top of `styles.scss` and defines fonts in an `@theme` block. Tailwind 4 does not read `tailwind.config.js` unless a stylesheet has `@config`. Uply has no `@config`, so its config file is inert. PRVision keeps it that way on purpose:

- Wiring it would emit `--color-primary: var(--color-primary)` into Tailwind's theme layer, a self-referencing custom property that breaks every use of the token.
- Colours are reached through arbitrary values (`bg-[var(--shell-accent)]`, `text-[var(--color-text-secondary)]`), exactly as Uply's templates do.

Copy the file verbatim so editor tooling behaves like Uply. Do not add `@config`.

### 6.2 `src/index.html` and `src/main.ts`

```html
<!doctype html>
<html lang="en" class="shell--tenant-dark">
  <head>
    <meta charset="utf-8" />
    <title>PRVision</title>
    <base href="/" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="dark light" />
    <meta name="theme-color" content="#11181c" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body>
    <app-root></app-root>
  </body>
</html>
```

Differences from Uply and from 02's scaffold: no Google Fonts or icon-font `<link>`s (00 §14.9: fonts are bundled via `angular.json` so the app works offline and makes no third-party requests); default class `shell--tenant-dark` so the first paint is dark; theme colour matches the dark canvas.

`src/main.ts`: 02's file unchanged.

### 6.3 Environments

02's `environment.ts` / `environment.production.ts` are unchanged (`production`, `apiBaseUrl: 'http://localhost:3100/api'`, `artifactBaseUrl: 'http://localhost:3100'`, 00 §12). Every API URL is built from `environment.apiBaseUrl` (only in `ApiService`) and every image URL from `environment.artifactBaseUrl` (only in `artifactUrl()`, §6.17). The app version shown in the sidebar is the constant `APP_VERSION` in `core/constants/ui.constants.ts` (§6.18), not an environment field.

### 6.4 `app.config.ts`

```ts
import { ApplicationConfig, inject, provideAppInitializer, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, TitleStrategy, withComponentInputBinding, withRouterConfig } from '@angular/router';
import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { provideAnimationsAsync } from '@angular/platform-browser/animations/async';
import { MAT_FORM_FIELD_DEFAULT_OPTIONS } from '@angular/material/form-field';
import { MAT_TOOLTIP_DEFAULT_OPTIONS } from '@angular/material/tooltip';
import { MAT_DIALOG_DEFAULT_OPTIONS } from '@angular/material/dialog';
import { routes } from './app.routes';
import { errorInterceptor } from './core/interceptors/error.interceptor';
import { ThemeService } from './core/services/theme.service';
import { PrvisionTitleStrategy } from './core/services/page-title.strategy';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withComponentInputBinding(), withRouterConfig({ paramsInheritanceStrategy: 'always' })),
    { provide: TitleStrategy, useClass: PrvisionTitleStrategy },
    provideHttpClient(withInterceptors([errorInterceptor])),
    provideAnimationsAsync(),
    provideAppInitializer(() => inject(ThemeService).init()),
    {
      provide: MAT_FORM_FIELD_DEFAULT_OPTIONS,
      // Same as Uply: fill avoids the MDC outline "leading rail".
      useValue: { appearance: 'fill', subscriptSizing: 'dynamic' },
    },
    { provide: MAT_TOOLTIP_DEFAULT_OPTIONS, useValue: { showDelay: 300, hideDelay: 0, touchendHideDelay: 1500 } },
    { provide: MAT_DIALOG_DEFAULT_OPTIONS, useValue: { autoFocus: 'first-tabbable', restoreFocus: true, hasBackdrop: true } },
  ],
};
```

Notes:

- Uply's `importProvidersFrom(MatSnackBarModule, MatDialogModule)` is unnecessary in v19 (both services are `providedIn: 'root'`) and is dropped.
- `withComponentInputBinding()` lets route params (`:id`) and query params (`?status=`) arrive as component `input()`s.
- `MAT_DIALOG_DEFAULT_OPTIONS` only affects plain `MatDialog.open` calls. `ConfirmDialogService` and `promptAction` pass their own Uply options (`hasBackdrop: false`, transparent fullscreen panel) and keep Uply's look.

`PrvisionTitleStrategy`:

```ts
@Injectable({ providedIn: 'root' })
export class PrvisionTitleStrategy extends TitleStrategy {
  private readonly title = inject(Title);
  override updateTitle(snapshot: RouterStateSnapshot): void {
    const page = this.buildTitle(snapshot);
    this.title.setTitle(page ? `${page} · PRVision` : 'PRVision');
  }
}
/** For detail pages that know a better name after loading (e.g. the visualization title). */
export function setPageTitle(title: Title, page: string): void {
  title.setTitle(`${page} · PRVision`);
}
```

### 6.5 `app.routes.ts`

```ts
import { Routes } from '@angular/router';
import { MainLayoutComponent } from './layouts/main-layout/main-layout.component';

export const routes: Routes = [
  {
    path: '',
    component: MainLayoutComponent,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'repositories' },
      {
        path: 'repositories',
        title: 'Repositories',
        loadComponent: () =>
          import('./features/repositories/repository-list/repository-list.component').then((m) => m.RepositoryListComponent),
      },
      {
        path: 'repositories/:id',
        title: 'Repository',
        loadComponent: () =>
          import('./features/repositories/repository-detail/repository-detail.component').then((m) => m.RepositoryDetailComponent),
      },
      {
        path: 'visualizations',
        title: 'Visualizations',
        loadComponent: () =>
          import('./features/visualizations/visualization-list/visualization-list.component').then((m) => m.VisualizationListComponent),
      },
      {
        path: 'visualizations/:id',
        title: 'Visualization',
        loadComponent: () =>
          import('./features/visualizations/visualization-detail/visualization-detail.component').then((m) => m.VisualizationDetailComponent),
      },
      {
        path: 'settings',
        title: 'Settings',
        loadComponent: () =>
          import('./features/settings/settings-page/settings-page.component').then((m) => m.SettingsPageComponent),
      },
      {
        path: '**',
        title: 'Not found',
        loadComponent: () => import('./shared/components/not-found-page/not-found-page.component').then((m) => m.NotFoundPageComponent),
      },
    ],
  },
];
```

The layout is eager (it is always shown); features are lazy. The `**` route lives inside the layout so the sidebar stays visible. Sheet 13 adds `canDeactivate` to the settings route.

Stub feature components (13 replaces each file; class name and selector must stay):

```ts
@Component({
  selector: 'app-repository-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PageHeaderComponent, EmptyStateComponent],
  template: `
    <app-page-header title="Repositories" subtitle="Local clones registered with PRVision." />
    <app-empty-state class="mt-6" title="Coming soon" message="Built in sheet 13." />
  `,
})
export class RepositoryListComponent {}
```

Same pattern for `RepositoryDetailComponent` (`app-repository-detail`, `readonly id = input.required<string>()`), `VisualizationListComponent` (`app-visualization-list`), `VisualizationDetailComponent` (`app-visualization-detail`, `readonly id = input.required<string>()`), `SettingsPageComponent` (`app-settings-page`). Each stub has a one-case spec (`renders its page title`) so Karma never runs an empty suite.

### 6.6 `app.component.ts`

```ts
@Component({
  selector: 'app-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet],
  host: { class: 'block min-h-full' },
  template: `
    <div class="dd-app-root min-h-full">
      <div class="dd-glow-layer" aria-hidden="true"></div>
      <div class="dd-app-surface relative z-[1] min-h-full">
        <router-outlet />
      </div>
    </div>
  `,
})
export class AppComponent {}
```

### 6.7 Visual token reference (Uply parity)

PRVision uses Uply's default palette ("Cedar Mist": primary `#466a73`, secondary `#e8f0ea`, accent `#37555c`) as the light theme, unchanged. The dark theme is new: Uply ships dark-shell rules (`.shell--tenant-dark` sidebar, menus, select panels, form fields) but never activates them, and its dark card rule is overridden by a light rule of higher specificity. PRVision defines a full dark token set (in `prvision.scss`) that keeps Uply's dark sidebar gradient, dark menus and slate text ramp.

#### 6.7.1 Colour tokens

| Token | Light (Uply `:root`) | Dark (PRVision) | Used for |
|---|---|---|---|
| `--color-bg-primary` | `#f6f4ee` | `#11181c` | Page canvas, `body` |
| `--color-bg-secondary` | `#fffefb` | `#161f24` | Cards, grid panels, popups' inner sections |
| `--color-bg-tertiary` | `#f7f3ec` | `#1b262c` | Inset blocks, segmented-control track |
| `--color-bg-quaternary` | `#efe9df` | `#223038` | Deep inset |
| `--color-surface` | `#ffffff` | `#182227` | Popup panel, toasts base |
| `--color-surface-hover` | `#fbf8f2` | `#1f2b31` | Hover rows |
| `--color-surface-active` | `#f2ede4` | `#26343b` | Pressed |
| `--color-text-primary` | `#1e2931` | `#e6ecef` | Headings, body |
| `--color-text-secondary` | `#66727b` | `#a7b4bc` | Descriptions |
| `--color-text-tertiary` | `#8a949c` | `#7d8b94` | Meta, eyebrow labels |
| `--color-text-disabled` | `#b0b7bc` | `#55626a` | Disabled |
| `--color-primary` | `#466a73` | `#6f969f` | Brand teal |
| `--color-primary-hover` | `#37555c` | `#84a9b1` | |
| `--color-primary-light` | `#8fa698` | `#9fbcc3` | |
| `--color-primary-dark` | `#2d454b` | `#2d454b` | |
| `--color-primary-10/15/20` | `rgba(70,106,115,.1/.15/.2)` | `rgba(111,150,159,.1/.15/.2)` | Tints |
| `--color-on-primary` | `#ffffff` | `#ffffff` | Text on primary |
| `--color-success` | `#059669` | `#34d399` | |
| `--color-warning` | `#d97706` | `#fbbf24` | |
| `--color-error` | `#dc2626` | `#f87171` | |
| `--color-info` | `#466a73` | `#6f969f` | |
| `--color-border` | `#e6e1d7` | `#26343b` | Card/grid borders |
| `--color-border-light` | `#d7d0c3` | `#314149` | Strong borders |
| `--color-border-accent` | `#466a73` | `#6f969f` | |
| `--shell-accent` | `var(--color-primary)` | `#6f969f` | Active nav, focus, tabs, spinners |
| `--shell-accent-soft` | `rgba(70,106,115,.1)` | `rgba(111,150,159,.16)` | Icon chips, hover |
| `--shell-accent-contrast` | `#ffffff` | `#ffffff` | |
| `--shell-sidebar-border` | `rgba(70,106,115,.12)` | `rgba(148,163,184,.12)` | Sidebar dividers |
| `--secondary-color` | `var(--color-bg-tertiary)` | `#1b262c` | Form-field gradient mix |
| `--accent-color` | `var(--color-primary-dark)` | `#2d454b` | Button bg mix |
| `--shell-button-bg` (derived) | mix(accent 68%, accent-color) ≈ `#3e5e66` | ≈ `#5a7c84` | Filled primary buttons |

Derived Material tokens (`--mat-sys-primary`, `--mdc-filled-button-container-color`, tab, switch, spinner, stepper tokens) are set by Uply's shell block in `styles.scss` from `--shell-accent` and follow both themes automatically.

#### 6.7.2 Typography

| Item | Value |
|---|---|
| Font | Manrope 400/500/600/700/800 (`--font-sans`, `--font-display`; Uply also maps `--font-mono` to Manrope) |
| Code font | `ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace` (Uply's `.dd-grid-mono` stack). PRVision exposes it as `.pv-code` because Tailwind's `font-mono` is Manrope in Uply. |
| Page title | `font-display text-3xl font-bold tracking-tight` (30px/36px, 700) |
| Section title (card h3) | `text-lg font-semibold` (18px/28px) |
| Body | `text-sm` (14px/20px); descriptions `text-sm leading-6` |
| Eyebrow / stat label | `text-xs font-semibold uppercase tracking-[0.08em]` |
| Sidebar group label | `font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em]` |
| Pill | 12px/16px, weight 800 |
| Material type scale | Uply `--dd-text-*` / `--mat-sys-*` vars (Tailwind-aligned) |

#### 6.7.3 Radius, shadow, motion, spacing

| Token | Value | Typical use |
|---|---|---|
| `--radius-sm/md/lg/xl` | `0.5 / 0.75 / 1 / 1.5rem` | |
| Cards (`.mat-mdc-card`) | `1.35rem` (global), feature cards use `!rounded-2xl` (1rem) | |
| Grid panel `.dd-ag-grid-panel` | `1.35rem` | |
| Buttons | `!rounded-xl` (0.75rem) | All `mat-*-button` |
| Form field wrapper | `0.75rem` | |
| Dialog panel | `rounded-2xl` | generic-popup |
| Pills | `9999px` | |
| Shadows | `--shadow-xs, -sm, -md, -lg, -xl, -float, -glow` (Uply light values; dark overrides in 6.8.2) | Cards use `--shadow-md`, popups `--shadow-float` |
| Transitions | `--transition-fast 150ms`, `--transition-normal 250ms`, `--transition-slow 350ms` (ease-in-out) | |
| Content padding | `p-6 lg:p-8`, max width `1800px` | Main area |
| Stack spacing | `space-y-6` between page sections, `gap-4` in toolbars, `gap-3` in grids | |

#### 6.7.4 Layout dimensions

| Element | Value |
|---|---|
| Sidebar width | `w-64` (16rem / 256px), full height |
| Sidebar brand block | `px-2 py-3`, logo tile `h-11 w-11 rounded-xl` |
| Nav item | `flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium`, icon 22px |
| Top bar (PRVision addition) | `h-14` (56px), sticky, bottom border, translucent canvas + blur |
| Breakpoint for drawer | `< 1024px` (Tailwind `lg`) |

#### 6.7.5 Status pill tones (Uply `.dd-pill--*`, light; dark values in 6.8.2)

| Tone class | Border | Background | Text |
|---|---|---|---|
| `dd-pill--success` | `#c7e7d5` | `#f1faf5` | `#35745a` |
| `dd-pill--danger` | `#ecc8cf` | `#fff5f6` | `#985365` |
| `dd-pill--warning` | `#ead8a8` | `#fffaf0` | `#8b6a30` |
| `dd-pill--info` | `#c9d8ee` | `#f4f8fd` | `#4b668f` |
| `dd-pill--active` | `#bddfd9` | `#f2faf8` | `#3f746c` |
| `dd-pill--accent` | `#d9d2e8` | `#f8f6fc` | `#6f5b8e` |
| `dd-pill--muted` | `#d8dee6` | `#fafbfc` | `#667085` |
| `dd-pill--outline` | `#cbd5e1` | `#ffffff` | `#334155` |

### 6.8 Global styles

#### 6.8.1 `src/styles.scss` (copy of Uply, stripped)

Copy `tenant-frontend/src/styles.scss` (2,393 lines at the time of writing), then make these edits. Line numbers are approximate guides; match on the selectors.

1. Keep: `@use 'tailwindcss';`, both ag-grid `@import`s, the `@theme` block, the type-scale `:root` block, `html, body`, `body`, form-element font inheritance, the Material font-family override list, `.font-display`.
2. In the `:root` token block (≈ L130–205) delete the four `--dd-entry-*` variables. Keep everything else.
3. Keep `.dd-app-root` and `.dd-glow-layer` (≈ L207–220).
4. Delete every `.walkthrough-*` rule, the four `@keyframes walkthrough-*`, and the two `@media` blocks that only target walkthrough classes (≈ L222–574).
5. Delete every selector that names `.shell--brand` or `html.shell--brand` from selector lists throughout the file. Delete rules whose selector list becomes empty (for example the standalone `.shell--brand .app-sidebar` rule, ≈ L736–744).
6. Delete `.dd-alerting-pill*` selectors from the pill rules (keep the `.dd-pill*` selectors in the same rules).
7. Delete `.dd-dashboard-monitor-cell` and `.dd-dashboard-status-dot*` rules (≈ L1894–1924).
8. Delete the dark-shell rules that force ag-grid back to white: every rule whose selector starts with `.shell--tenant-dark .dd-ag-grid-theme`, `.shell--tenant-dark .dd-grid-stack__`, `.shell--tenant-dark .dd-grid-muted` or `.shell--tenant-dark .dd-grid-action` (≈ L1987–2097). **Keep** the rule `.dd-ag-grid-theme .ag-row.dd-grid-row-clickable, .dd-ag-grid-theme .ag-row.dd-grid-row-clickable .ag-cell { cursor: pointer; }` that sits in the middle of that range (≈ L2029); it is not a dark rule and 13's clickable rows need it. PRVision's dark grid lives in `prvision.scss`.
9. Keep everything else unchanged: shell Material token mapping, sidebar (`.app-sidebar`, `sidebarGradientShift`, nav colours for light and dark), cards, dialog backdrops and panels, toasts (`.dd-app-toast`, `.snackbar-*`), buttons, tabs, form fields (fill and outline), status text classes, `.dd-pill*`, grid menu trigger, `.dd-menu-danger`, dark cards/fields, grid pager (+ dark), `.settings-theme-toggle` dark rules, dark main-text remaps, `.dd-ag-grid-*`, `.dd-grid-*`, ag-grid inputs/menus, dropdown/select panel overrides, and the `html.shell--tenant-light` warm utility remap.

Acceptance check for this file: `grep -c "walkthrough\|brand\|dd-entry\|dd-dashboard\|alerting-pill" src/styles.scss` prints `0`, and `grep -c "dd-grid-row-clickable" src/styles.scss` prints at least `1`.

Two Uply rules every PRVision template must respect (they stay in `styles.scss`):

- `html.shell--tenant-light main { .text-slate-500, .text-slate-400 { color: var(--color-text-tertiary) !important } … }` remaps slate/gray/white utilities inside `main` in the light theme. A dark terminal panel inside `main` that uses `text-slate-400/500` would therefore turn warm grey in light mode. PRVision's console and code panels use the `pv-console__*` classes from `prvision.scss` instead of slate text utilities (§6.20).
- The global `.mat-mdc-card { border-radius: 1.35rem !important }` is unlayered; Tailwind's `!rounded-2xl` is a layered important utility and therefore wins. Cards that should be `1rem` must use `!rounded-2xl` (with `!`), as in Uply's monitor detail.

#### 6.8.2 `src/styles/prvision.scss` (new, loaded after `styles.scss`)

This file must not `@use 'tailwindcss'`. All selectors below are complete; copy as written.

```scss
/* ===== 1. Theme tokens ===== */
html.shell--tenant-light { color-scheme: light; }

html.shell--tenant-dark {
  color-scheme: dark;
  --color-bg-primary: #11181c;
  --color-bg-secondary: #161f24;
  --color-bg-tertiary: #1b262c;
  --color-bg-quaternary: #223038;
  --color-surface: #182227;
  --color-surface-hover: #1f2b31;
  --color-surface-active: #26343b;
  --color-text-primary: #e6ecef;
  --color-text-secondary: #a7b4bc;
  --color-text-tertiary: #7d8b94;
  --color-text-disabled: #55626a;
  --color-primary: #6f969f;
  --color-primary-hover: #84a9b1;
  --color-primary-light: #9fbcc3;
  --color-primary-dark: #2d454b;
  --color-primary-10: rgba(111, 150, 159, 0.1);
  --color-primary-15: rgba(111, 150, 159, 0.15);
  --color-primary-20: rgba(111, 150, 159, 0.2);
  --color-on-primary: #ffffff;
  --color-success: #34d399;
  --color-warning: #fbbf24;
  --color-error: #f87171;
  --color-info: #6f969f;
  --color-border: #26343b;
  --color-border-light: #314149;
  --color-border-accent: #6f969f;
  --shell-accent: #6f969f;
  --shell-accent-soft: rgba(111, 150, 159, 0.16);
  --shell-accent-contrast: #ffffff;
  --shell-sidebar-border: rgba(148, 163, 184, 0.12);
  --secondary-color: #1b262c;
  --accent-color: #2d454b;
  --shadow-xs: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-sm: 0 12px 28px -22px rgba(0, 0, 0, 0.6), 0 4px 10px -6px rgba(0, 0, 0, 0.35);
  --shadow-md: 0 20px 48px -28px rgba(0, 0, 0, 0.55), 0 10px 20px -16px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 28px 68px -34px rgba(0, 0, 0, 0.6), 0 16px 30px -20px rgba(0, 0, 0, 0.45);
  --shadow-xl: 0 40px 96px -42px rgba(0, 0, 0, 0.65), 0 22px 42px -24px rgba(0, 0, 0, 0.5);
  --shadow-float: 0 30px 72px -34px rgba(0, 0, 0, 0.7), 0 18px 34px -22px rgba(0, 0, 0, 0.5);
}

html.shell--tenant-dark .dd-glow-layer {
  background:
    radial-gradient(circle at top left, rgba(111, 150, 159, 0.1), transparent 34%),
    radial-gradient(circle at bottom right, rgba(198, 168, 117, 0.05), transparent 28%),
    var(--color-bg-primary);
}

/* ===== 2. Dark fixes for Uply rules that hard-code light values ===== */
html.shell--tenant-dark main .mat-mdc-card {
  --mdc-elevated-card-container-color: var(--color-bg-secondary);
  background-color: var(--color-bg-secondary);
  color: var(--color-text-primary);
  border-color: var(--color-border) !important;
  box-shadow: var(--shadow-md) !important;
}
html.shell--tenant-dark main .mat-mdc-form-field.mat-form-field-appearance-fill .mat-mdc-text-field-wrapper,
html.shell--tenant-dark .cdk-overlay-container .mat-mdc-form-field.mat-form-field-appearance-fill .mat-mdc-text-field-wrapper,
html.shell--tenant-dark app-generic-popup .mat-mdc-form-field.mat-form-field-appearance-fill .mat-mdc-text-field-wrapper {
  background: var(--color-bg-tertiary) !important;
  border-color: var(--color-border-light) !important;
}
html.shell--tenant-dark main .mat-mdc-form-field.mat-form-field-appearance-fill.mat-focused .mat-mdc-text-field-wrapper,
html.shell--tenant-dark app-generic-popup .mat-mdc-form-field.mat-form-field-appearance-fill.mat-focused .mat-mdc-text-field-wrapper {
  background: var(--color-bg-quaternary) !important;
  border-color: var(--shell-accent) !important;
}
html.shell--tenant-dark .mat-mdc-form-field .mdc-text-field__input,
html.shell--tenant-dark .mat-mdc-form-field textarea.mat-mdc-input-element,
html.shell--tenant-dark .mat-mdc-select-value { color: var(--color-text-primary) !important; }
html.shell--tenant-dark .mat-mdc-form-field .mat-mdc-floating-label,
html.shell--tenant-dark .mat-mdc-form-field-hint { color: var(--color-text-secondary) !important; }
html.shell--tenant-dark .mat-mdc-unelevated-button[disabled],
html.shell--tenant-dark .mat-mdc-unelevated-button.mat-mdc-button-disabled {
  --mdc-filled-button-disabled-container-color: rgba(148, 163, 184, 0.14) !important;
  --mdc-filled-button-disabled-label-text-color: rgba(226, 232, 240, 0.38) !important;
}
html.shell--tenant-dark .mat-mdc-radio-button .mdc-label,
html.shell--tenant-dark .mat-mdc-checkbox .mdc-label,
html.shell--tenant-dark .mat-mdc-slide-toggle .mdc-label { color: var(--color-text-primary); }

/* ===== 3. Dark pills ===== */
html.shell--tenant-dark {
  .dd-pill { box-shadow: none; }
  .dd-pill--success { --dd-pill-border: rgba(52, 211, 153, 0.35); --dd-pill-bg: rgba(52, 211, 153, 0.12); --dd-pill-color: #6ee7b7; }
  .dd-pill--danger  { --dd-pill-border: rgba(248, 113, 113, 0.35); --dd-pill-bg: rgba(248, 113, 113, 0.12); --dd-pill-color: #fca5a5; }
  .dd-pill--warning { --dd-pill-border: rgba(251, 191, 36, 0.35); --dd-pill-bg: rgba(251, 191, 36, 0.1); --dd-pill-color: #fcd34d; }
  .dd-pill--info    { --dd-pill-border: rgba(96, 165, 250, 0.35); --dd-pill-bg: rgba(96, 165, 250, 0.1); --dd-pill-color: #93c5fd; }
  .dd-pill--active  { --dd-pill-border: rgba(45, 212, 191, 0.35); --dd-pill-bg: rgba(45, 212, 191, 0.1); --dd-pill-color: #5eead4; }
  .dd-pill--accent  { --dd-pill-border: rgba(167, 139, 250, 0.35); --dd-pill-bg: rgba(167, 139, 250, 0.1); --dd-pill-color: #c4b5fd; }
  .dd-pill--muted   { --dd-pill-border: rgba(148, 163, 184, 0.3); --dd-pill-bg: rgba(148, 163, 184, 0.08); --dd-pill-color: #cbd5e1; }
  .dd-pill--outline { --dd-pill-border: rgba(148, 163, 184, 0.35); --dd-pill-bg: transparent; --dd-pill-color: #e2e8f0; }
}
.dd-pill__dot {
  width: 0.4rem; height: 0.4rem; border-radius: 9999px; background: currentColor; flex: 0 0 auto;
}
.dd-pill__dot--pulse { animation: pv-pulse 1.4s ease-in-out infinite; }
@keyframes pv-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }

/* ===== 4. Dark grid ===== */
html.shell--tenant-dark {
  .dd-ag-grid-shell { background: var(--color-bg-secondary); border-color: var(--color-border); }
  .dd-ag-grid-theme {
    --ag-border-color: var(--color-border);
    --ag-background-color: var(--color-bg-secondary);
    --ag-foreground-color: var(--color-text-primary);
    --ag-data-color: var(--color-text-primary);
    --ag-header-background-color: var(--color-bg-secondary);
    --ag-header-foreground-color: var(--color-text-tertiary);
    --ag-odd-row-background-color: var(--color-bg-secondary);
    --ag-row-hover-color: var(--color-surface-hover);
    --ag-selected-row-background-color: var(--color-surface-active);
    --ag-input-border-color: var(--color-border-light);
    --ag-input-background-color: var(--color-bg-tertiary);
    --ag-input-focus-border-color: var(--shell-accent);
    --ag-chrome-background-color: var(--color-bg-secondary);
    --ag-menu-background-color: #1a1c23;
    --ag-menu-border-color: #2c3340;
    --ag-control-panel-background-color: var(--color-bg-secondary);
    --ag-header-column-resize-handle-color: var(--color-border-light);
    --ag-checkbox-background-color: var(--color-bg-tertiary);
    --ag-popup-shadow: 0 24px 48px -18px rgba(15, 23, 42, 0.55), 0 0 0 1px rgba(148, 163, 184, 0.12);
  }
  .dd-ag-grid-theme .ag-paging-panel { color: var(--color-text-secondary); border-top-color: var(--color-border); }
  .dd-ag-grid-theme .ag-paging-panel .ag-paging-button { color: var(--color-text-secondary); }
  .dd-ag-grid-theme .ag-paging-panel .ag-paging-button[disabled] { color: var(--color-text-disabled); }
  /* Uply's base hover for ag menus/lists is #f8fafc !important (light); match Uply's dark Material menus. */
  .dd-ag-grid-theme .ag-menu-option:hover,
  .dd-ag-grid-theme .ag-menu-option.ag-menu-option-active,
  .dd-ag-grid-theme .ag-virtual-list-item:hover,
  .dd-ag-grid-theme .ag-list-item-hovered { background: #323a4b !important; }
  .dd-grid-stack__primary { color: var(--color-text-primary); }
  .dd-grid-stack__secondary, .dd-grid-muted { color: var(--color-text-secondary); }
  .dd-grid-action { border-color: var(--color-border-light); background: transparent; color: var(--color-text-primary); }
  .dd-grid-action:hover { background: var(--color-surface-hover); }
  .dd-grid-action--danger { border-color: rgba(248, 113, 113, 0.4); color: #fca5a5; }
  .dd-grid-action--danger:hover { background: rgba(248, 113, 113, 0.08); }
  .dd-grid-empty-state { border-color: var(--color-border-light); }
  .dd-grid-menu-trigger.mat-mdc-icon-button { color: var(--color-text-secondary); }
}

/* ===== 5. Shell additions ===== */
.app-sidebar__brand-name { color: var(--color-text-primary); }
html.shell--tenant-dark .app-sidebar__brand-name { color: #f8fafc; }
html.shell--tenant-dark .app-sidebar__muted { color: #a8b8d0; }                     /* Uply: .border-b/.border-t .text-slate-500 in dark */
html.shell--tenant-light .app-sidebar__muted,
html.shell--tenant-light .app-sidebar__group-label { color: color-mix(in srgb, var(--shell-accent) 22%, #7d888f); }
html.shell--tenant-dark .app-sidebar__group-label { color: #62748e; }               /* Uply: nav group labels stay Tailwind 4 slate-500 in dark */

.pv-topbar {
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-bg-primary) 82%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
}

.pv-skip-link {
  position: absolute; left: 1rem; top: -3rem; z-index: 60;
  border-radius: 0.75rem; background: var(--shell-accent); color: var(--shell-accent-contrast);
  padding: 0.5rem 0.875rem; font-weight: 700; transition: top var(--transition-fast);
}
.pv-skip-link:focus { top: 0.75rem; }

:where(a, button, [tabindex], input, select, textarea, summary):focus-visible {
  outline: 2px solid var(--shell-accent);
  outline-offset: 2px;
}

/* ===== 6. Code, diff, prose, image, console ===== */
.pv-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 0.78rem;
  line-height: 1.55;
}
.pv-code-block {
  margin: 0; max-height: 32rem; overflow: auto; border-radius: 0.75rem;
  border: 1px solid #1e293b; background: #020617; color: #e2e8f0; padding: 0.875rem 1rem;
}
.pv-diff-line { display: grid; grid-template-columns: 3.25rem 3.25rem minmax(0, 1fr); white-space: pre; }
.pv-diff-line__num { color: #64748b; text-align: right; padding-right: 0.75rem; user-select: none; }
.pv-diff-line--add { background: rgba(34, 197, 94, 0.14); color: #bbf7d0; }
.pv-diff-line--del { background: rgba(239, 68, 68, 0.14); color: #fecaca; }
.pv-diff-line--hunk { background: rgba(96, 165, 250, 0.1); color: #93c5fd; }
.pv-diff-line--meta { color: #94a3b8; font-weight: 700; }

.pv-prose { color: var(--color-text-primary); font-size: 0.9375rem; line-height: 1.65; overflow-wrap: anywhere; }
.pv-prose > :first-child { margin-top: 0; }
.pv-prose > :last-child { margin-bottom: 0; }
.pv-prose h1, .pv-prose h2, .pv-prose h3, .pv-prose h4 { font-weight: 700; letter-spacing: -0.01em; margin: 1.25em 0 0.5em; }
.pv-prose h1 { font-size: 1.25rem; } .pv-prose h2 { font-size: 1.125rem; } .pv-prose h3, .pv-prose h4 { font-size: 1rem; }
.pv-prose p { margin: 0.6em 0; }
.pv-prose ul, .pv-prose ol { margin: 0.6em 0; padding-left: 1.4em; }
.pv-prose ul { list-style: disc; } .pv-prose ol { list-style: decimal; }
.pv-prose li { margin: 0.25em 0; }
.pv-prose a { color: var(--shell-accent); text-decoration: underline; text-underline-offset: 2px; }
.pv-prose code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 0.85em;
  border-radius: 0.375rem; background: var(--color-bg-tertiary); padding: 0.1em 0.35em;
}
.pv-prose pre { margin: 0.8em 0; overflow: auto; border-radius: 0.75rem; background: #020617; color: #e2e8f0; padding: 0.75rem 1rem; }
.pv-prose pre code { background: transparent; padding: 0; color: inherit; }
.pv-prose blockquote { margin: 0.8em 0; border-left: 3px solid var(--color-border-light); padding-left: 0.9em; color: var(--color-text-secondary); }
.pv-prose table { width: 100%; border-collapse: collapse; margin: 0.8em 0; font-size: 0.875rem; }
.pv-prose th, .pv-prose td { border: 1px solid var(--color-border); padding: 0.35rem 0.6rem; text-align: left; }
.pv-prose hr { border: 0; border-top: 1px solid var(--color-border); margin: 1.2em 0; }

.pv-checkerboard {
  background-color: #ffffff;
  background-image:
    linear-gradient(45deg, #eef0f2 25%, transparent 25%), linear-gradient(-45deg, #eef0f2 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, #eef0f2 75%), linear-gradient(-45deg, transparent 75%, #eef0f2 75%);
  background-size: 16px 16px;
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
}

/* Terminal panel (Uply run console: bg-slate-950 text-slate-100, muted slate-400/500, level colours
   slate-300/amber-300/rose-300). Fixed colours in both themes; named classes so Uply's light-theme
   `main .text-slate-*` remap (styles.scss) cannot recolour them. */
.pv-console { background: #020617; color: #f1f5f9; }
.pv-console__subtle { color: #94a3b8; }            /* slate-400: subtitles, empty text */
.pv-console__muted { color: #64748b; }             /* slate-500: timestamps, [stage] */
.pv-console__level--info { color: #cbd5e1; }       /* slate-300 */
.pv-console__level--warn { color: #fcd34d; }       /* amber-300 */
.pv-console__level--error { color: #fda4af; }      /* rose-300 */
.pv-console__divider { border-color: rgba(255, 255, 255, 0.1); }
.pv-console__row { border-color: rgba(255, 255, 255, 0.05); }

/* ===== 7. Motion ===== */
@media (prefers-reduced-motion: reduce) {
  .app-sidebar { animation: none !important; }
  .dd-pill__dot--pulse { animation: none; }
  *, *::before, *::after { transition-duration: 0.01ms !important; scroll-behavior: auto !important; }
}

.sr-only-focusable:not(:focus):not(:focus-within) {
  position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap;
}
```

Screenshots in the image viewer sit on `.pv-checkerboard` in both themes so transparent component backgrounds read the same as in the target app's own white page.

### 6.9 Theme service

```ts
// core/services/theme.service.ts
export type ThemeMode = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'prvision.theme';
const SHELL_CLASS: Record<ThemeMode, string> = { dark: 'shell--tenant-dark', light: 'shell--tenant-light' };
const META_THEME_COLOR: Record<ThemeMode, string> = { dark: '#11181c', light: '#466a73' };

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly document = inject(DOCUMENT);
  private readonly modeSignal = signal<ThemeMode>('dark');
  readonly mode = this.modeSignal.asReadonly();
  readonly isDark = computed(() => this.modeSignal() === 'dark');

  /** Called once from provideAppInitializer. Reads storage and applies the class before first render. */
  init(): void {
    this.apply(this.readStoredMode());
  }

  toggle(): void {
    this.setMode(this.modeSignal() === 'dark' ? 'light' : 'dark');
  }

  setMode(mode: ThemeMode): void {
    this.apply(mode);
    this.persist(mode);
  }

  private apply(mode: ThemeMode): void {
    const root = this.document.documentElement;
    root.classList.remove(SHELL_CLASS.dark, SHELL_CLASS.light);
    root.classList.add(SHELL_CLASS[mode]);
    root.style.colorScheme = mode;
    this.ensureMetaThemeColor().content = META_THEME_COLOR[mode];
    this.modeSignal.set(mode);
  }

  private readStoredMode(): ThemeMode {
    try {
      return this.document.defaultView?.localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark'; // storage blocked (privacy mode, file://) — fall back silently
    }
  }

  private persist(mode: ThemeMode): void {
    try {
      this.document.defaultView?.localStorage.setItem(THEME_STORAGE_KEY, mode);
    } catch {
      // ignore: the choice still applies for this session
    }
  }

  private ensureMetaThemeColor(): HTMLMetaElement {
    let meta = this.document.querySelector<HTMLMetaElement>("meta[name='theme-color']");
    if (!meta) {
      meta = this.document.createElement('meta');
      meta.name = 'theme-color';
      this.document.head.appendChild(meta);
    }
    return meta;
  }
}
```

Rules: any stored value other than `'light'` means dark. The service never throws. Nothing else (no secrets, no settings) is stored in `localStorage`.

### 6.10 Main layout

Files: `layouts/main-layout/main-layout.component.ts` and `.html`.

#### 6.10.1 Structure

```text
┌──────────────── 256px ───────────────┬──────────────────────────────────────────────────────────┐
│ [PV] PRVision                        │ ☰(mobile)  Repositories            ● API online   [☾/☀] │ ← top bar h-14
│      Visual PR review · local        ├──────────────────────────────────────────────────────────┤
│──────────────────────────────────────│                                                          │
│ WORKSPACE                            │   <router-outlet/>                                       │
│  ▣ Repositories          (active)    │   p-6 lg:p-8, mx-auto max-w-[1800px]                     │
│  ◫ Visualizations                    │                                                          │
│ CONFIGURE                            │                                                          │
│  ⚙ Settings                          │                                                          │
│                                      │                                                          │
│──────────────────────────────────────│                                                          │
│ 💻 Local mode                         │                                                          │
│    127.0.0.1:3100 · v0.1.0           │                                                          │
└──────────────────────────────────────┴──────────────────────────────────────────────────────────┘
```

Below 1024px the sidebar becomes an off-canvas drawer (same width, `fixed inset-y-0 left-0 z-40`), opened by the top-bar menu button, over a backdrop button (`fixed inset-0 z-30 bg-[rgb(15_23_42/0.45)] backdrop-blur-sm`).

#### 6.10.2 Component

```ts
interface NavItem { path: string; label: string; icon: string; }
interface NavGroup { label: string; items: NavItem[]; }

@Component({
  selector: 'app-main-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, RouterLinkActive, MatIconModule, MatButtonModule, MatTooltipModule],
  templateUrl: './main-layout.component.html',
  host: { '(document:keydown.escape)': 'onEscape()' },
})
export class MainLayoutComponent {
  protected readonly theme = inject(ThemeService);
  protected readonly health = inject(HealthService);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly breakpoints = inject(BreakpointObserver);

  protected readonly navGroups: readonly NavGroup[] = [
    { label: 'Workspace', items: [
      { path: '/repositories', label: 'Repositories', icon: 'source' },
      { path: '/visualizations', label: 'Visualizations', icon: 'compare' },
    ] },
    { label: 'Configure', items: [{ path: '/settings', label: 'Settings', icon: 'tune' }] },
  ];
  protected readonly appVersion = APP_VERSION;                        // core/constants/ui.constants.ts
  protected readonly apiHost = new URL(environment.apiBaseUrl).host;

  protected readonly isDesktop = toSignal(
    this.breakpoints.observe('(min-width: 1024px)').pipe(map((s) => s.matches)),
    { initialValue: true },
  );
  protected readonly drawerOpen = signal(false);
  protected readonly sidebarHidden = computed(() => !this.isDesktop() && !this.drawerOpen());
  protected readonly sectionTitle = signal('');

  // Optional (not .required): the first NavigationEnd can arrive before the view queries resolve.
  private readonly scrollContainer = viewChild<ElementRef<HTMLElement>>('scrollContainer');
  private readonly firstNavLink = viewChild<ElementRef<HTMLElement>>('firstNavLink');
  private readonly menuButton = viewChild<ElementRef<HTMLElement>>('menuButton');

  constructor() {
    this.health.start(); // idempotent; polls GET /api/health every HEALTH_POLL_MS
    this.sectionTitle.set(this.deepestTitle());
    this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        this.drawerOpen.set(false);
        this.sectionTitle.set(this.deepestTitle());
        this.scrollContainer()?.nativeElement.scrollTo({ top: 0 });
      });
  }

  protected openDrawer(): void {
    this.drawerOpen.set(true);
    queueMicrotask(() => this.firstNavLink()?.nativeElement.focus());
  }
  protected closeDrawer(restoreFocus = true): void {
    if (!this.drawerOpen()) return;
    this.drawerOpen.set(false);
    if (restoreFocus) this.menuButton()?.nativeElement.focus();
  }
  protected onEscape(): void { this.closeDrawer(); }

  private deepestTitle(): string {
    let route = this.router.routerState.snapshot.root;
    while (route.firstChild) route = route.firstChild;
    return route.title ?? '';
  }
}
```

`HealthService` (core, `providedIn: 'root'`, lives for the app's lifetime):

```ts
export type ApiHealth = 'unknown' | 'online' | 'degraded' | 'offline';

@Injectable({ providedIn: 'root' })
export class HealthService {
  private readonly api = inject(ApiService);
  private readonly statusSignal = signal<ApiHealth>('unknown');
  readonly status = this.statusSignal.asReadonly();
  private started = false;

  /** Idempotent. Root service: the subscription intentionally lives as long as the app (no destroy). */
  start(): void {
    if (this.started) return;
    this.started = true;
    timer(0, HEALTH_POLL_MS)
      .pipe(
        exhaustMap(() =>
          this.api.getHealth().pipe(                         // silent: never toasts
            map((h): ApiHealth => (h.status === 'ok' ? 'online' : 'degraded')),
            catchError(() => of<ApiHealth>('offline')),
          ),
        ),
      )
      .subscribe((s) => this.statusSignal.set(s));
  }
}
```

`GET /api/health` always returns HTTP 200 with `HealthView { status: 'ok' | 'degraded'; database; redis; version }` (00 §14.4); `degraded` means Postgres or Redis is down. The top bar shows `online` → success pill "API online", `degraded` → warning pill "API degraded", `offline` → danger pill "API offline", `unknown` → muted "Connecting…".

#### 6.10.3 Template (key parts)

```html
<a class="pv-skip-link" href="#main-content">Skip to content</a>

<div class="app-shell flex h-screen min-h-0 bg-transparent font-sans">
  @if (!isDesktop() && drawerOpen()) {
    <button type="button" class="fixed inset-0 z-30 bg-[rgb(15_23_42/0.45)] backdrop-blur-sm"
            aria-label="Close navigation" (click)="closeDrawer()"></button>
  }

  <aside id="app-sidebar"
         class="app-sidebar flex w-64 shrink-0 flex-col shadow-2xl"
         [class.fixed]="!isDesktop()" [class.inset-y-0]="!isDesktop()" [class.left-0]="!isDesktop()" [class.z-40]="!isDesktop()"
         [class.transition-transform]="!isDesktop()" [class.-translate-x-full]="sidebarHidden()"
         [attr.inert]="sidebarHidden() ? '' : null"
         aria-label="Primary">
    <div class="border-b border-[color:var(--shell-sidebar-border)] px-2 py-3">
      <a routerLink="/repositories" class="flex min-w-0 items-center gap-3 px-2">
        <div class="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[var(--shell-accent)] text-base font-bold text-[var(--shell-accent-contrast)] shadow-inner">PV</div>
        <div class="min-w-0">
          <div class="app-sidebar__brand-name truncate font-display text-base font-semibold tracking-tight">PRVision</div>
          <div class="app-sidebar__muted text-xs">Visual PR review · local</div>
        </div>
      </a>
    </div>

    <nav class="flex flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden p-2" aria-label="Main">
      @for (group of navGroups; track group.label; let first = $first) {
        <div [class.pt-2]="first" [class.pt-5]="!first" class="pb-2">
          <div class="app-sidebar__group-label px-3 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em]">{{ group.label }}</div>
        </div>
        @for (item of group.items; track item.path) {
          <a #firstNavLink [routerLink]="item.path" routerLinkActive="nav-link-active" ariaCurrentWhenActive="page"
             class="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors hover:bg-white/[0.06]">
            <mat-icon class="!h-[22px] !w-[22px] !shrink-0 !text-[22px]" aria-hidden="true">{{ item.icon }}</mat-icon>
            <span>{{ item.label }}</span>
          </a>
        }
      }
    </nav>

    <div class="border-t border-[color:var(--shell-sidebar-border)] p-3">
      <div class="flex items-center gap-2.5 px-1">
        <div class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--shell-accent-soft)] text-[var(--shell-accent)]">
          <mat-icon class="!h-[18px] !w-[18px] !text-[18px]" aria-hidden="true">computer</mat-icon>
        </div>
        <div class="min-w-0">
          <div class="app-sidebar__brand-name truncate text-sm font-medium leading-tight">Local mode</div>
          <div class="app-sidebar__muted mt-0.5 text-[11px] leading-tight">{{ apiHost }} · v{{ appVersion }}</div>
        </div>
      </div>
    </div>
  </aside>

  <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
    <header class="pv-topbar sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
      <div class="flex min-w-0 items-center gap-2">
        @if (!isDesktop()) {
          <button #menuButton mat-icon-button type="button" aria-controls="app-sidebar"
                  [attr.aria-expanded]="drawerOpen()" aria-label="Open navigation" (click)="openDrawer()">
            <mat-icon>menu</mat-icon>
          </button>
        }
        <span class="truncate text-sm font-semibold text-[var(--color-text-secondary)]">{{ sectionTitle() }}</span>
      </div>
      <div class="flex items-center gap-2">
        <span role="status" aria-live="polite" class="contents">
        @switch (health.status()) {
          @case ('online') { <span class="dd-pill dd-pill--success"><span class="dd-pill__dot" aria-hidden="true"></span>API online</span> }
          @case ('degraded') { <span class="dd-pill dd-pill--warning"><span class="dd-pill__dot" aria-hidden="true"></span>API degraded</span> }
          @case ('offline') { <span class="dd-pill dd-pill--danger"><span class="dd-pill__dot" aria-hidden="true"></span>API offline</span> }
          @default { <span class="dd-pill dd-pill--muted">Connecting…</span> }
        }
        </span>
        <button mat-icon-button type="button" (click)="theme.toggle()"
                [attr.aria-label]="theme.isDark() ? 'Switch to light theme' : 'Switch to dark theme'"
                [matTooltip]="theme.isDark() ? 'Light theme' : 'Dark theme'">
          <mat-icon>{{ theme.isDark() ? 'light_mode' : 'dark_mode' }}</mat-icon>
        </button>
      </div>
    </header>

    <main id="main-content" tabindex="-1" class="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div #scrollContainer class="flex min-h-0 flex-1 flex-col overflow-y-auto p-6 lg:p-8">
        <div class="mx-auto flex min-h-0 w-full max-w-[1800px] flex-1 flex-col">
          <router-outlet />
        </div>
      </div>
    </main>
  </div>
</div>
```

Notes:

- The `#firstNavLink` template ref sits on every nav link; `viewChild` returns the first match, which is the first link.
- Nav colours come entirely from Uply's sidebar CSS (`.shell--tenant-dark .app-sidebar nav a:not(.nav-link-active)`, `.nav-link-active`, and the `.shell--tenant-light` variants). Do not add `text-slate-*` classes to nav links.
- `main` keeps the `main` element because Uply's dark/light remaps target `main …` selectors.
- `inert` removes the hidden drawer from tab order and the accessibility tree.

### 6.11 Core models

Mirror 00 §9 as amended by 00 §14.4 exactly. Field names, optionality and nullability must match the backend view DTOs. Models are `interface`s (01 lint `consistent-type-definitions`); unions stay `type`.

```ts
// core/models/domain-enums.model.ts
export const AI_PROVIDER_KINDS = ['anthropic_api', 'claude_code'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];
export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof AI_EFFORTS)[number];
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];
export const REPOSITORY_FRAMEWORKS = ['react_vite'] as const;
export type RepositoryFramework = (typeof REPOSITORY_FRAMEWORKS)[number];
export const SOURCE_TYPES = ['github_pr', 'local_branch', 'working_tree'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];
export const VISUALIZATION_STATUSES = [
  'queued', 'preparing', 'analyzing', 'generating_harnesses', 'rendering', 'diffing', 'summarizing',
  'completed', 'failed', 'cancelled',
] as const;
export type VisualizationStatus = (typeof VISUALIZATION_STATUSES)[number];
export const TERMINAL_VISUALIZATION_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type TerminalVisualizationStatus = (typeof TERMINAL_VISUALIZATION_STATUSES)[number];
export const CHANGE_KINDS = ['modified', 'added', 'removed', 'affected_parent'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];
export const RENDER_STATUSES = ['pending', 'rendered', 'partial', 'failed', 'skipped'] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];
export const VISUAL_CHANGES = ['changed', 'unchanged', 'new', 'deleted'] as const;
export type VisualChange = (typeof VISUAL_CHANGES)[number];
export const RISKS = ['none', 'check', 'likely_regression'] as const;
export type Risk = (typeof RISKS)[number];
export const CONSOLE_LEVELS = ['info', 'warn', 'error'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
```

```ts
// core/models/api.model.ts — wire format 00 §14.2 (the only format the frontend supports)
export interface ApiEnvelope<T> { status: number; data: T; }
export interface ApiErrorBody { status: number; error: string | string[]; error_reason?: string; }
export interface Paged<T> { items: T[]; page: number; pageSize: number; total: number; }
export interface PageQuery { page?: number; pageSize?: number; }
/** DELETE /api/repositories/:id and /api/visualizations/:id → 200 { id } (00 §14.4). */
export interface DeleteResult { id: number; }
/** GET /api/health, always HTTP 200 (00 §14.4). */
export interface HealthView { status: 'ok' | 'degraded'; database: boolean; redis: boolean; version: string; }
/** Complete list from 00 §14.2. */
export const API_ERROR_REASONS = [
  'validation_failed', 'not_found', 'conflict', 'forbidden_origin', 'payload_too_large', 'internal_error',
  'not_git_repo', 'unsupported_framework', 'missing_node_modules', 'no_github_remote',
  'github_token_missing', 'github_unauthorized', 'github_rate_limited', 'github_unavailable',
  'ai_not_configured', 'ai_unauthorized', 'already_terminal', 'working_tree_clean',
] as const;
export type ApiErrorReason = (typeof API_ERROR_REASONS)[number];
```

```ts
// core/models/settings.model.ts
export interface SettingsView {
  hasGithubToken: boolean; githubLogin: string | null;
  aiProvider: AiProviderKind; hasAnthropicApiKey: boolean;
  aiModel: string; aiHarnessEffort: Effort; aiSummaryEffort: Effort;
}
/**
 * PUT /api/settings — partial update (00 §14.4). Secret fields (githubToken, anthropicApiKey):
 * omitted → keep stored value; "" → clear; non-empty string → replace. `null` is never sent (the API answers 400).
 */
export interface SettingsUpdateRequest {
  githubToken?: string;
  anthropicApiKey?: string;
  aiProvider?: AiProviderKind;
  aiModel?: string;
  aiHarnessEffort?: Effort;
  aiSummaryEffort?: Effort;
}
/** POST /api/settings/test-github → 200 (00 §14.4). */
export interface GithubTestResultView { login: string; }
/** POST /api/settings/test-ai → 200 (00 §14.4). */
export interface AiTestResultView { provider: AiProviderKind; model: string; latencyMs: number; }
```

```ts
// core/models/repository.model.ts
export interface RepositoryView {
  id: number; name: string; localPath: string; githubOwner: string | null; githubRepo: string | null;
  defaultBranch: string; framework: RepositoryFramework; packageManager: PackageManager;
  viteConfigPath: string | null; tsconfigPath: string | null; entryFilePath: string | null; globalStylePaths: string[];
  lastDetectedAt: string; createdAt: string;
}
export interface PullRequestView {
  number: number; title: string; author: string; headRef: string; baseRef: string; updatedAt: string; draft: boolean; url: string;
}
export interface BranchListView { current: string | null; branches: string[]; defaultBranch: string; workingTreeDirty: boolean; }
/** POST /api/repositories (00 §14.4). A leading "~/" is expanded server-side. */
export interface RepositoryCreateRequest { localPath: string; name?: string; }
```

```ts
// core/models/visualization.model.ts
export interface VisualizationSummaryView {
  id: number; repositoryId: number; repositoryName: string; sourceType: SourceType; prNumber: number | null;
  title: string; baseRef: string; headRef: string; status: VisualizationStatus;
  componentCount: number; changedCount: number; createdAt: string; completedAt: string | null;
}
export interface AiUsageView { inputTokens: number; outputTokens: number; calls: number; }
export interface VisualizationDetailView extends VisualizationSummaryView {
  baseSha: string | null; headSha: string | null; errorMessage: string | null; summaryMarkdown: string | null;
  aiProvider: string; aiModel: string; aiUsage: AiUsageView | null;
  startedAt: string | null;
  /** Stage active when the run failed or was cancelled; null otherwise (00 §14.4). */
  failedStage: VisualizationStatus | null;
  components: VisualizationComponentView[];
}
export interface ElementAddedChange { kind: 'element_added'; path: string; tag: string; }
export interface ElementRemovedChange { kind: 'element_removed'; path: string; tag: string; }
export interface AttributeChangedChange {
  kind: 'attribute_changed'; path: string; tag: string; attribute: string; before: string | null; after: string | null;
  /** Present for `className` (00 §14.4). */
  tokensAdded?: string[]; tokensRemoved?: string[];
}
export interface TextChangedChange { kind: 'text_changed'; path: string; before: string; after: string; }
export type StructuralChange = ElementAddedChange | ElementRemovedChange | AttributeChangedChange | TextChangedChange;
export interface VisualizationComponentView {
  id: number; filePath: string; exportName: string; displayName: string; changeKind: ChangeKind;
  renderStatus: RenderStatus; visualChange: VisualChange | null; risk: Risk | null; rank: number;
  baseImageUrl: string | null; headImageUrl: string | null; diffImageUrl: string | null;   // "/artifacts/…"
  imageWidth: number | null; imageHeight: number | null; diffPixelRatio: number | null;
  codeDiff: string | null; structuralDiff: StructuralChange[] | null; aiNote: string | null;
  harnessSource: string | null; harnessNotes: string | null; baseError: string | null; headError: string | null;
  /** Why the component is in the set, e.g. "imports changed hook src/hooks/useCart.ts" (00 §14.4). */
  changeReason: string | null;
  /** Why it was not rendered; set when renderStatus is "skipped" (00 §14.4). */
  skipReason: string | null;
}
export interface ConsoleEventView { id: number; level: ConsoleLevel; stage: string; message: string; createdAt: string; }
export interface CreateVisualizationResponse { visualizationId: number; jobId: string; }
/** POST /api/visualizations → 202 (00 §14.4). Discriminated so each source type sends only its fields. */
export interface GithubPrCreateRequest { repositoryId: number; sourceType: 'github_pr'; prNumber: number; }
export interface LocalBranchCreateRequest { repositoryId: number; sourceType: 'local_branch'; headRef: string; baseRef?: string; }
/** The UI never sends baseRef for working_tree; the backend compares against the checked-out commit (07). */
export interface WorkingTreeCreateRequest { repositoryId: number; sourceType: 'working_tree'; }
export type VisualizationCreateRequest = GithubPrCreateRequest | LocalBranchCreateRequest | WorkingTreeCreateRequest;
/** POST /api/visualizations/:id/cancel: 200 → "cancelled" (job removed while queued), 202 → "cancel_requested". */
export interface CancelVisualizationResponse { id: number; status: 'cancelled' | 'cancel_requested'; }
/** `statuses` is serialized as one comma-separated `status` query param (e.g. `status=queued,rendering`). */
export interface VisualizationListQuery extends PageQuery { statuses?: readonly VisualizationStatus[]; repositoryId?: number; }
/** `afterId` is exclusive; events come back oldest first; `limit` defaults to and is capped at 500 (00 §14.4). */
export interface ConsoleQuery { afterId?: number; limit?: number; }
```

`index.ts` re-exports every model file.

### 6.12 `ApiService`

Purpose: the only class that talks to `HttpClient` (01 §5.14.3). It exposes one typed method per route in 00 §9/§14.4, builds URLs from `environment.apiBaseUrl`, converts query objects to `HttpParams`, sets the `SUPPRESS_ERROR_TOAST` context and unwraps the 00 §14.2 envelope. Features inject `ApiService` directly; there are no per-feature data services.

```ts
// core/services/api.service.ts
export type QueryValue = string | number | boolean | null | undefined;
export type QueryParams = Record<string, QueryValue>;
export interface ApiRequestOptions {
  /** true → the error interceptor does not toast; the caller renders or toasts the error itself. */
  silent?: boolean;
}
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = environment.apiBaseUrl.replace(/\/+$/, '');

  // Health (04). Always silent: the top-bar pill is the only feedback.
  getHealth(): Observable<HealthView> { return this.request('GET', 'health', { silent: true }); }

  // Settings (05)
  getSettings(o: ApiRequestOptions = {}): Observable<SettingsView> { return this.request('GET', 'settings', { silent: true, ...o }); }
  updateSettings(body: SettingsUpdateRequest, o: ApiRequestOptions = {}): Observable<SettingsView> {
    return this.request('PUT', 'settings', { body, silent: true, ...o });
  }
  testGithub(o: ApiRequestOptions = {}): Observable<GithubTestResultView> {
    return this.request('POST', 'settings/test-github', { body: {}, silent: true, ...o });
  }
  testAi(o: ApiRequestOptions = {}): Observable<AiTestResultView> {
    return this.request('POST', 'settings/test-ai', { body: {}, silent: true, ...o });
  }

  // Repositories (06)
  listRepositories(o: ApiRequestOptions = {}): Observable<RepositoryView[]> { return this.request('GET', 'repositories', { silent: true, ...o }); }
  getRepository(id: number, o: ApiRequestOptions = {}): Observable<RepositoryView> {
    return this.request('GET', `repositories/${id}`, { silent: true, ...o });
  }
  createRepository(body: RepositoryCreateRequest, o: ApiRequestOptions = {}): Observable<RepositoryView> {
    return this.request('POST', 'repositories', { body, silent: true, ...o });
  }
  redetectRepository(id: number, o: ApiRequestOptions = {}): Observable<RepositoryView> {
    return this.request('POST', `repositories/${id}/redetect`, { body: {}, silent: false, ...o });
  }
  removeRepository(id: number, o: ApiRequestOptions = {}): Observable<DeleteResult> {
    return this.request('DELETE', `repositories/${id}`, { silent: false, ...o });
  }
  listPullRequests(id: number, o: ApiRequestOptions = {}): Observable<PullRequestView[]> {
    return this.request('GET', `repositories/${id}/pull-requests`, { silent: true, ...o });
  }
  listBranches(id: number, o: ApiRequestOptions = {}): Observable<BranchListView> {
    return this.request('GET', `repositories/${id}/branches`, { silent: true, ...o });
  }

  // Visualizations (07)
  createVisualization(body: VisualizationCreateRequest, o: ApiRequestOptions = {}): Observable<CreateVisualizationResponse> {
    return this.request('POST', 'visualizations', { body, silent: true, ...o });
  }
  listVisualizations(q: VisualizationListQuery, o: ApiRequestOptions = {}): Observable<Paged<VisualizationSummaryView>> {
    return this.request('GET', 'visualizations', {
      params: {
        page: q.page ?? 1,
        pageSize: q.pageSize ?? DEFAULT_PAGE_SIZE,
        status: q.statuses?.length ? q.statuses.join(',') : undefined,   // comma list, 00 §14.4
        repositoryId: q.repositoryId,
      },
      silent: true, ...o,
    });
  }
  getVisualization(id: number, o: ApiRequestOptions = {}): Observable<VisualizationDetailView> {
    return this.request('GET', `visualizations/${id}`, { silent: true, ...o });
  }
  getConsole(id: number, q: ConsoleQuery = {}, o: ApiRequestOptions = {}): Observable<ConsoleEventView[]> {
    return this.request('GET', `visualizations/${id}/console`, { params: { afterId: q.afterId, limit: q.limit }, silent: true, ...o });
  }
  cancelVisualization(id: number, o: ApiRequestOptions = {}): Observable<CancelVisualizationResponse> {
    return this.request('POST', `visualizations/${id}/cancel`, { body: {}, silent: true, ...o });
  }
  removeVisualization(id: number, o: ApiRequestOptions = {}): Observable<DeleteResult> {
    return this.request('DELETE', `visualizations/${id}`, { silent: false, ...o });
  }

  private request<T>(method: HttpMethod, path: string, opts: { body?: unknown; params?: QueryParams; silent: boolean }): Observable<T> {
    return this.http
      .request<unknown>(method, `${this.baseUrl}/${path}`, {
        body: opts.body,
        params: toHttpParams(opts.params),
        context: new HttpContext().set(SUPPRESS_ERROR_TOAST, opts.silent),
        responseType: 'json',
      })
      .pipe(map((body) => unwrapEnvelope<T>(body)));
  }
}

export function toHttpParams(params: QueryParams | undefined): HttpParams {
  let result = new HttpParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    result = result.set(key, String(value));
  }
  return result;
}

/** 00 §14.2: every 2xx body is `{ status, data }`. Anything else is a contract breach, not data. */
export function unwrapEnvelope<T>(body: unknown): T {
  if (typeof body === 'object' && body !== null && 'data' in body) return (body as ApiEnvelope<T>).data;
  throw new ApiError('The PRVision API sent a response PRVision cannot read.', -1, 'internal_error');
}
```

Silent defaults, as a rule: every `GET` and every call whose errors the screen renders inline (settings save/tests, repository create, visualization create, cancel) is silent; the remaining mutations (`redetectRepository`, `removeRepository`, `removeVisualization`) let the interceptor toast and their callers only stop their busy state. A caller that passes `{ silent: true }` to one of those owns its error message. This is how the app never double-notifies: an error is either toasted by the interceptor or handled by the caller, never both.

A malformed 2xx body errors the observable with `ApiError(status -1, 'internal_error')`. It is thrown after the interceptor, so it is never toasted; callers render it like any other error. Paths are relative to `apiBaseUrl`, without a leading slash.

### 6.13 `ApiError`, error interceptor, context token

```ts
// core/interceptors/http-context-tokens.ts  (token name from 01 §5.14.3)
export const SUPPRESS_ERROR_TOAST = new HttpContextToken<boolean>(() => false);
```

```ts
// core/models/api-error.model.ts
export class ApiError extends Error {
  override readonly name = 'ApiError';
  constructor(
    message: string,
    /** HTTP status; 0 = network failure / API unreachable; -1 = non-HTTP or malformed response. */
    readonly status: number,
    /** The wire `error_reason`, when it is one of the 00 §14.2 codes. */
    readonly errorReason: ApiErrorReason | null,
    /** Further validation messages when the server sent `error` as a string[] (first entry is `message`). */
    readonly details: readonly string[] = [],
  ) { super(message); }
  get isNetworkError(): boolean { return this.status === 0; }
  get isNotFound(): boolean { return this.status === 404 || this.errorReason === 'not_found'; }
  is(reason: ApiErrorReason): boolean { return this.errorReason === reason; }
}

/** Maps anything thrown by HttpClient (or our own code) to ApiError. Only the 00 §14.2 error body is parsed. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof HttpErrorResponse) {
    if (error.status === 0) return new ApiError(NETWORK_ERROR_MESSAGE, 0, null);
    return fromErrorBody(error.error, error.status);
  }
  return new ApiError(error instanceof Error ? error.message : 'Unexpected error.', -1, null);
}

function fromErrorBody(raw: unknown, status: number): ApiError {
  const body = isErrorBody(raw) ? raw : null;
  const messages = body ? (Array.isArray(body.error) ? body.error : [body.error]) : [];
  const [first, ...rest] = messages;
  return new ApiError(first ?? defaultMessageForStatus(status), status, knownReason(body?.error_reason), rest);
}
function isErrorBody(v: unknown): v is ApiErrorBody {
  return typeof v === 'object' && v !== null && 'error' in v
    && (typeof (v as ApiErrorBody).error === 'string' || Array.isArray((v as ApiErrorBody).error));
}
function knownReason(v: unknown): ApiErrorReason | null {
  return typeof v === 'string' && (API_ERROR_REASONS as readonly string[]).includes(v) ? (v as ApiErrorReason) : null;
}

export const NETWORK_ERROR_MESSAGE =
  "Can't reach the PRVision API at http://localhost:3100. Is the backend running (npm run dev)?";
function defaultMessageForStatus(status: number): string {
  if (status === 404) return 'Not found.';
  if (status === 400) return 'The request was rejected as invalid.';   // every input/settings reason is 400 (00 §14.12); 422 is never sent
  if (status === 409) return 'That action conflicts with the current state.';
  if (status === 413) return 'The request is too large.';
  if (status >= 500) return 'The PRVision API hit an internal error. Check the backend log.';
  return `Request failed (HTTP ${status}).`;
}
```

```ts
// core/interceptors/error.interceptor.ts
export const errorInterceptor: HttpInterceptorFn = (req, next) => {
  const notifications = inject(NotificationService);
  return next(req).pipe(
    catchError((error: unknown) => {
      const apiError = toApiError(error);
      if (!req.context.get(SUPPRESS_ERROR_TOAST)) notifications.error(userMessageFor(apiError));
      return throwError(() => apiError);
    }),
  );
};
```

Every caller therefore receives an `ApiError` (never a raw `HttpErrorResponse`). The interceptor toasts at most once per failed request and never logs (01 lint allows only `console.error`, and request bodies may carry secrets; the browser Network tab is the debugging tool). No retry, no 401 handling (there is no auth).

`core/utils/error-messages.util.ts`:

```ts
export interface ErrorCopy {
  title: string;
  /** Fixed user copy. Omitted → the server's message is shown (it is more specific). */
  message?: string;
  actionLabel?: string;
  actionRoute?: string;
}
export const ERROR_REASON_COPY: Record<ApiErrorReason, ErrorCopy> = {
  validation_failed: { title: 'Invalid input' },
  not_found: { title: 'Not found', message: 'That item no longer exists. It may have been removed.' },
  conflict: { title: 'Not possible right now' },
  forbidden_origin: { title: 'Request blocked', message: 'The API only accepts requests from the PRVision UI at http://localhost:4210.' },
  payload_too_large: { title: 'Too large' },
  internal_error: { title: 'Something went wrong' },
  not_git_repo: { title: 'Not a git repository', message: 'That folder is not a git repository. Choose the root folder of a local clone (the one containing .git).' },
  unsupported_framework: { title: 'Unsupported project', message: 'PRVision currently supports Vite + React projects. No Vite config with a React dependency was found in that folder.' },
  missing_node_modules: { title: 'Dependencies not installed', message: "node_modules is missing. Run your package manager's install command (npm install, pnpm install or yarn) in that folder, then try again." },
  no_github_remote: { title: 'No GitHub remote', message: 'This repository has no GitHub remote, so pull requests are unavailable. Local branches and the working tree still work.' },
  github_token_missing: { title: 'GitHub token needed', message: 'Add a GitHub token in Settings to list and visualize pull requests.', actionLabel: 'Open settings', actionRoute: '/settings' },
  github_unauthorized: { title: 'GitHub rejected the token', message: 'The GitHub token was rejected. Check it has not expired and can read this repository.', actionLabel: 'Open settings', actionRoute: '/settings' },
  github_rate_limited: { title: 'GitHub rate limit reached', message: 'GitHub is rate limiting requests. Try again in a few minutes.' },
  github_unavailable: { title: 'GitHub unavailable', message: 'Could not reach GitHub. Check your network connection and try again.' },
  ai_not_configured: { title: 'AI provider not configured', actionLabel: 'Open settings', actionRoute: '/settings' },
  ai_unauthorized: { title: 'AI credentials rejected', actionLabel: 'Open settings', actionRoute: '/settings' },
  already_terminal: { title: 'Already finished', message: 'This visualization has already finished.' },
  working_tree_clean: { title: 'Nothing to visualize', message: 'The working tree has no uncommitted changes.' },
};
/** One-line text for toasts and alert bodies. */
export function userMessageFor(error: ApiError): string {
  const copy = error.errorReason ? ERROR_REASON_COPY[error.errorReason] : null;
  return copy?.message ?? error.message;
}
/** Title + message + optional settings action for inline alerts and action prompts. */
export function errorCopyFor(error: ApiError): Required<Pick<ErrorCopy, 'title' | 'message'>> & Pick<ErrorCopy, 'actionLabel' | 'actionRoute'> {
  const copy = error.errorReason ? ERROR_REASON_COPY[error.errorReason] : { title: 'Something went wrong' };
  return { ...copy, message: copy.message ?? error.message };
}
```

`ai_not_configured` and `ai_unauthorized` use the server message because sheet 05 sends provider-specific instructions (for example "Run `claude` in a terminal, sign in, then retry").

### 6.14 Notification service

Copy Uply's `notification.service.ts` verbatim (variants `default|success|error|warn|info`; bottom-right; durations: success 3000 ms, error 5000 ms, info 4000 ms, warn 5000 ms; `promptAction()` opens `ActionMessageDialogComponent` and returns `Observable<boolean>`). Rename `runStarted()` to `queued()` (same wide-toast behaviour, 14 s) and use it for "Visualization queued" messages. Toast text is set through `MatSnackBar.open(message)`, which renders text, never HTML.

### 6.15 Confirm dialog service

Copy Uply's `confirm-dialog.service.ts` verbatim, and export its dialog options as `export const GENERIC_POPUP_DIALOG_CONFIG: MatDialogConfig = { width: '100vw', maxWidth: '100vw', height: '100vh', hasBackdrop: false, disableClose: true, panelClass: 'dd-generic-popup-dialog', autoFocus: false }` (reused by `NotificationService.promptAction` and 13's add-repository dialog): `confirm(data: ConfirmDialogData): Observable<boolean>`; data `{ title, message, confirmText?, cancelText?, confirmColor?: 'primary' | 'warn' }`; opens the dialog as a transparent fullscreen panel (`panelClass: 'dd-generic-popup-dialog'`, `hasBackdrop: false`, `disableClose: true`), with the generic popup supplying blur, focus trap, Escape and focus restore. Destructive actions pass `confirmColor: 'warn'` and an explicit `confirmText` such as "Remove repository".

### 6.16 Shared components

All OnPush. Signal inputs/outputs unless stated.

#### 6.16.1 `app-page-header`

Codifies Uply's repeated header markup (monitor list, detail, settings).

| Member | Type | Notes |
|---|---|---|
| `title` | `input.required<string>()` | `<h1>` text. |
| `subtitle` | `input<string \| null>(null)` | Grey line under the title. |
| `eyebrow` | `input<string \| null>(null)` | Small uppercase label above the title. |
| `backLink` | `input<string \| readonly unknown[] \| null>(null)` | Shows Uply's `arrow_back` icon button. |
| `backLabel` | `input('Back')` | `aria-label` for the back button. |
| slot `[pageHeaderMeta]` | content | Pills/meta row under the title. |
| slot `[pageHeaderActions]` | content | Right-aligned buttons. |

```html
<header class="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
  <div class="flex min-w-0 items-start gap-3">
    @if (backLink(); as link) {
      <a mat-icon-button [routerLink]="link" [attr.aria-label]="backLabel()" class="mt-0.5 shrink-0"><mat-icon>arrow_back</mat-icon></a>
    }
    <div class="min-w-0">
      @if (eyebrow()) { <p class="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">{{ eyebrow() }}</p> }
      <h1 class="truncate font-display text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">{{ title() }}</h1>
      @if (subtitle()) { <p class="mt-1 text-sm text-[var(--color-text-secondary)]">{{ subtitle() }}</p> }
      <div class="mt-1 flex flex-wrap items-center gap-2 empty:hidden"><ng-content select="[pageHeaderMeta]" /></div>
    </div>
  </div>
  <div class="flex flex-wrap items-center justify-end gap-2 sm:gap-3 empty:hidden"><ng-content select="[pageHeaderActions]" /></div>
</header>
```

#### 6.16.2 `app-status-pill`

```ts
export type PillTone = 'success' | 'danger' | 'warning' | 'info' | 'active' | 'accent' | 'muted' | 'outline';
export type PillKind = 'visualization' | 'render' | 'visual' | 'risk' | 'change' | 'source' | 'console';
export interface PillSpec { tone: PillTone; label: string; live?: boolean; }
```

| Member | Type | Notes |
|---|---|---|
| `kind` | `input.required<PillKind>()` | Which table to use. |
| `value` | `input<string \| null \| undefined>()` | Enum value. |
| `label` | `input<string \| null>(null)` | Overrides the mapped label. |
| `ariaPrefix` | `input<string \| null>(null)` | e.g. "Status" → `aria-label="Status: Rendering"`. |
| `spec` | `computed(() => resolvePill(kind(), value()))` | |
| `pillClass` | `computed(() => 'dd-pill dd-pill--' + spec().tone)` | |
| `text` | `computed(() => label() ?? spec().label)` | |
| `ariaLabel` | `computed(() => ariaPrefix() ? \`${ariaPrefix()}: ${text()}\` : null)` | |

Template: `<span [class]="pillClass()" [attr.aria-label]="ariaLabel()">@if (spec().live) {<span class="dd-pill__dot dd-pill__dot--pulse" aria-hidden="true"></span>}{{ text() }}</span>`.

Mapping table (`status-pill.config.ts`, exported as `STATUS_PILL_MAP` and `resolvePill(kind, value)`; unknown or null value → `{ tone: 'muted', label: formatPillLabel(value ?? '—') }`):

| Kind | Value | Tone | Label | Live dot |
|---|---|---|---|---|
| visualization | `queued` | muted | Queued | no |
| visualization | `preparing` | info | Preparing | yes |
| visualization | `analyzing` | info | Analyzing | yes |
| visualization | `generating_harnesses` | info | Generating harnesses | yes |
| visualization | `rendering` | info | Rendering | yes |
| visualization | `diffing` | info | Diffing | yes |
| visualization | `summarizing` | info | Summarizing | yes |
| visualization | `completed` | success | Completed | no |
| visualization | `failed` | danger | Failed | no |
| visualization | `cancelled` | warning | Cancelled | no |
| render | `pending` | muted | Pending | no |
| render | `rendered` | success | Rendered | no |
| render | `partial` | warning | Partial render | no |
| render | `failed` | danger | Render failed | no |
| render | `skipped` | outline | Skipped | no |
| visual | `changed` | accent | Changed | no |
| visual | `unchanged` | muted | Unchanged | no |
| visual | `new` | active | New | no |
| visual | `deleted` | warning | Deleted | no |
| risk | `none` | success | No risk | no |
| risk | `check` | warning | Check | no |
| risk | `likely_regression` | danger | Likely regression | no |
| change | `modified` | outline | Modified | no |
| change | `added` | outline | Added | no |
| change | `removed` | outline | Removed | no |
| change | `affected_parent` | outline | Affected parent | no |
| source | `github_pr` | info | Pull request | no |
| source | `local_branch` | outline | Branch | no |
| source | `working_tree` | outline | Working tree | no |
| console | `info` | muted | Info | no |
| console | `warn` | warning | Warn | no |
| console | `error` | danger | Error | no |

#### 6.16.3 `app-segmented-control`

Uply's time-range button group (monitor detail "Performance trend"), generalized. Used by 13 for the image viewer modes, zoom, and component filter chips.

```ts
export interface SegmentOption<T extends string> { value: T; label: string; count?: number | null; icon?: string; disabled?: boolean; }

@Component({ selector: 'app-segmented-control', changeDetection: ChangeDetectionStrategy.OnPush, imports: [MatIconModule], template: `…` })
export class SegmentedControlComponent<T extends string> {
  readonly options = input.required<readonly SegmentOption<T>[]>();
  readonly value = model.required<T>();
  readonly ariaLabel = input.required<string>();
  readonly fullWidthOnMobile = input(true);
  protected select(option: SegmentOption<T>): void { if (!option.disabled) this.value.set(option.value); }
}
```

```html
<div role="group" [attr.aria-label]="ariaLabel()"
     class="inline-flex w-max max-w-full flex-wrap gap-1 rounded-2xl border border-[color:color-mix(in_srgb,var(--shell-accent)_10%,var(--color-border))] bg-[color:color-mix(in_srgb,var(--color-bg-tertiary)_58%,transparent)] p-1"
     [class.max-sm:w-full]="fullWidthOnMobile()">
  @for (option of options(); track option.value) {
    <button type="button" [disabled]="option.disabled" [attr.aria-pressed]="value() === option.value" (click)="select(option)"
      class="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-xl px-3 text-[0.8125rem] font-extrabold text-[var(--color-text-secondary)] transition hover:bg-[color:color-mix(in_srgb,var(--shell-accent)_7%,transparent)] hover:text-[var(--color-text-primary)] disabled:cursor-not-allowed disabled:opacity-40 max-sm:flex-1"
      [class.bg-[color:color-mix(in_srgb,var(--shell-accent)_12%,var(--color-bg-secondary))]]="value() === option.value"
      [class.!text-[var(--shell-accent)]]="value() === option.value"
      [class.shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--shell-accent)_16%,transparent)]]="value() === option.value">
      @if (option.icon) { <mat-icon class="!h-4 !w-4 !text-base" aria-hidden="true">{{ option.icon }}</mat-icon> }
      <span>{{ option.label }}</span>
      @if (option.count !== undefined && option.count !== null) {
        <span class="rounded-full bg-[var(--color-bg-tertiary)] px-1.5 text-[0.6875rem] tabular-nums">{{ option.count }}</span>
      }
    </button>
  }
</div>
```

The class-binding names above are copied from Uply. If Angular's template parser rejects a bracketed class name, move the selected-state styles into a component SCSS rule `.is-selected { … }` with the same values and bind `[class.is-selected]`.

#### 6.16.4 `app-inline-alert`

Uply's run-detail loading/error box, generalized.

| Member | Type |
|---|---|
| `tone` | `input<'info' \| 'success' \| 'warning' \| 'error'>('info')` |
| `title` | `input<string \| null>(null)` |
| `icon` | `input<string \| null>(null)` (defaults per tone: `info`, `check_circle`, `warning`, `error`) |
| default slot | message body |
| slot `[inlineAlertAction]` | optional button(s), right-aligned |

```html
<div [attr.role]="tone() === 'error' ? 'alert' : 'status'"
     class="flex flex-col gap-3 rounded-[14px] border px-4 py-3.5 text-[0.94rem] sm:flex-row sm:items-start sm:justify-between"
     [style.border-color]="'color-mix(in srgb, ' + toneVar() + ' 18%, var(--color-border))'"
     [style.background]="'color-mix(in srgb, ' + toneVar() + ' 10%, var(--color-bg-secondary))'">
  <div class="flex min-w-0 gap-3">
    <mat-icon class="mt-0.5 shrink-0" [style.color]="toneVar()" aria-hidden="true">{{ resolvedIcon() }}</mat-icon>
    <div class="min-w-0">
      @if (title()) { <p class="font-semibold text-[var(--color-text-primary)]">{{ title() }}</p> }
      <div class="text-sm leading-6 text-[var(--color-text-secondary)]"><ng-content /></div>
    </div>
  </div>
  <div class="flex shrink-0 gap-2 empty:hidden"><ng-content select="[inlineAlertAction]" /></div>
</div>
```

`toneVar()` returns `var(--color-info)` / `var(--color-success)` / `var(--color-warning)` / `var(--color-error)`.

#### 6.16.5 Data grid

`data-grid.component.ts`: copy Uply's file. Changes:

- Add `changeDetection: ChangeDetectionStrategy.OnPush` (the component already calls `cdr.markForCheck()` inside `zone.run` when server loading changes; it must also call it after `searchText` changes from the input handler).
- Documented exception to the signal-input rule (the only one in the frontend): keep `@Input()`/`@Output()`/`@ViewChild` and `ngOnChanges`, because ag-grid is driven imperatively from change records (`serverRefreshKey`, `pageSize`, `serverPageLoader`). Do not convert. The file starts with `/* eslint-disable @angular-eslint/prefer-signals -- ag-grid wrapper driven by ngOnChanges; sheet 12 §6.16.5 */`; every other 01 rule applies (mark the `EventEmitter` outputs `readonly`).
- The markup already uses `@if`. Remove `CommonModule` from `imports`.
- Keep defaults (`rowHeight 56`, `pageSize 25`, `pageSizeOptions [25,50,100]`, search toolbar). Call sites in PRVision pass `[pageSize]="DEFAULT_PAGE_SIZE"` (20) and `[pageSizeOptions]="PAGE_SIZE_OPTIONS"` ([20, 50, 100]) to match 00's paging (default 20, max 100).
- The grid shows its own spinner when `[loading]="true"` and its own empty state (Uply dotted box) for an empty client-side `rowData`; pages pass `loading`, `emptyTitle` and `emptyMessage` instead of drawing their own.

Inputs (unchanged from Uply): `rowData`, `columnDefs`, `defaultColDef`, `gridOptions`, `loading`, `emptyIcon`, `emptyTitle`, `emptyMessage`, `rowHeight`, `pagination`, `pageSize`, `pageSizeOptions`, `serverPagination`, `serverPageLoader: DataGridPageLoader`, `serverRefreshKey`, `getRowId`, `getRowHeight`, `rowClassRules`, `localeText`, `searchEnabled`, `searchPlaceholder`. Outputs: `gridReady`, `cellClicked`, `rowClicked`. Types: `DataGridPageRequest { page, pageSize, startRow, endRow, search?, sortBy?, sortDir?, sortModel, filterModel }`, `DataGridPage<T> { items: T[]; total: number }`.

Server-paging usage pattern (13 follows it):

```ts
protected readonly pageLoader: DataGridPageLoader<VisualizationSummaryView> = (req) =>
  this.api.listVisualizations({ page: req.page, pageSize: req.pageSize, statuses: this.selectedStatuses() })
    .pipe(map((p) => ({ items: p.items, total: p.total })));
```

The grid re-requests page 1 whenever `[serverRefreshKey]` changes; bind it to a `computed` string of every filter input.

`data-grid-helpers.ts`: copy, then:

- Delete `formatCurrency`, `formatCurrencyMajor` and the `stripe-currency.util` import.
- Delete `statusPillClass` and `renderStatusPill`; add:

```ts
export function renderStatusPillHtml(kind: PillKind, value: string | null | undefined, labelOverride?: string): string {
  const spec = resolvePill(kind, value);
  const dot = spec.live ? '<span class="dd-pill__dot dd-pill__dot--pulse" aria-hidden="true"></span>' : '';
  return `<span class="dd-pill dd-pill--${spec.tone}">${dot}${escapeHtml(labelOverride ?? spec.label)}</span>`;
}
```

- Note `renderPill(label, className)` passes `label` through `formatPillLabel` (title-cases `pnpm` to "Pnpm"); for raw values (package managers, refs) use `renderMonospace` or `renderStatusPillHtml` with a label override.
- Keep `escapeHtml`, `formatPillLabel` (move it to `core/utils/labels.util.ts` and re-export here), `formatDateTime`, `formatDateOnly`, `formatRelativeTime`, `renderPill`, `renderStackedText`, `renderMutedText`, `renderMonospace`, `renderActionButton`, `renderActionLink`, `renderActionGroup`, `isGridActionTarget`, `suppressGridActionMouseEvent`, `extractGridAction`.
- Rule: every value interpolated into cell HTML goes through `escapeHtml` (the helpers already do). Never pass AI or user text to a cell renderer without it.

`action-menu-cell-renderer.component.ts`: copy verbatim, add OnPush. `ActionMenuItem { action, label, icon, tone?, disabled? }`.

#### 6.16.6 `app-empty-state`

Uply's dotted, text-only box (`.dd-grid-empty-state`). Inputs: `title = input<string | null>('No data')`, `message = input<string | null>('There is nothing here yet.')`, `icon = input<string | null>(null)` (kept for call-site parity; not rendered, as in Uply). Content: `formatEmptyStateMessage(title, message)` (copied function). Add an action slot without changing the look when unused:

```html
<div class="dd-grid-empty-state justify-between gap-4">
  <span>{{ text() }}</span>
  <span class="shrink-0 empty:hidden"><ng-content select="[emptyStateAction]" /></span>
</div>
```

#### 6.16.7 `app-loading-spinner`

Inputs `diameter = input(48)`, `label = input('Loading')`, `inline = input(false)` (inline drops the `py-12` block padding). Template: `<div role="status" class="flex items-center justify-center" [class.py-12]="!inline()"><mat-spinner [diameter]="diameter()" [attr.aria-label]="label()" /><span class="sr-only">{{ label() }}</span></div>`.

#### 6.16.8 `app-generic-popup`

Copy Uply's markup and behaviour (backdrop blur, scale/translate transition 300 ms, `role="dialog"`, `aria-modal`, `aria-labelledby`, `cdkTrapFocus` with auto-capture, Escape for the topmost popup only, body scroll lock with a shared counter, focus restore on close, header `slot=header-extra`, footer with secondary stroked + primary flat buttons and the loading spinner). Rewrite the class:

- `config = input<PopupConfig>({ title: 'Popup', showCloseButton: true, showFooter: true })`, `shouldShow = input(false)`, `closeOnBackdrop = input(true)`, `closeOnEscape = input<boolean | null>(null)`, `trapFocus = input(true)`.
- Outputs via `output<void>()`: `closeRequested`, `primaryAction`, `secondaryAction`, `closePopup`, `closed`.
- `rendered` and `isVisible` become signals.
- Replace `ngOnChanges` with one effect: `effect(() => { const show = this.shouldShow(); untracked(() => show ? this.showPopup() : this.rendered() && this.hidePopup()); })`.
- `@HostListener('document:keydown.escape')` → `host: { '(document:keydown.escape)': 'onEscape($event)' }`.
- `focusDialogPanel()` focuses the first element inside the panel that has the `cdkFocusInitial` attribute when one exists, otherwise the panel itself (Uply always focused the panel, which made dialog forms need an extra Tab).
- `@Inject(DOCUMENT)` → `inject(DOCUMENT)`; `@ViewChild` → `viewChild<ElementRef<HTMLElement>>('dialogPanel')`.
- `*ngIf` → `@if`. Remove `CommonModule`.
- Colour classes per the 6.0 table: title `text-[var(--color-text-primary)]`, close button `text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)]`. Panel keeps `bg-[var(--color-surface,#fdfeff)]` and `border-[color:var(--color-border)]`.
- `PopupConfig` interface unchanged.

How dialogs are hosted (Uply pattern, kept): every modal dialog is opened through `MatDialog.open(Component, { width: '100vw', maxWidth: '100vw', height: '100vh', hasBackdrop: false, disableClose: true, panelClass: 'dd-generic-popup-dialog', autoFocus: false, data })`, and the opened component's template is `<app-generic-popup [shouldShow]="true" …>`. Material's overlay supplies the modal semantics (siblings hidden from assistive tech, focus restored to the trigger on close via `restoreFocus`), and the generic popup supplies Uply's look, the `cdkTrapFocus` focus trap, initial focus and Escape. `ConfirmDialogService`, `NotificationService.promptAction` and 13's add-repository dialog all use this; no page renders a modal `app-generic-popup` inline.

#### 6.16.9 `app-confirm-dialog`, `app-action-message-dialog`

Copy; add OnPush; `data = inject<ConfirmDialogData>(MAT_DIALOG_DATA)` / `inject(MatDialogRef)` instead of constructor injection; in confirm, change `text-slate-700` to `text-[var(--color-text-secondary)]`.

#### 6.16.10 `app-not-found-page`

Routed for `**` and embeddable by detail screens when the API returns 404.

| Member | Type | Default |
|---|---|---|
| `title` | `input<string>` | `'Page not found'` |
| `message` | `input<string>` | `"There's nothing at this address."` |
| `backLink` | `input<string>` | `'/repositories'` |
| `backLabel` | `input<string>` | `'Go to repositories'` |

```html
<section class="mx-auto flex max-w-xl flex-col items-center gap-5 py-16 text-center">
  <div class="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--shell-accent-soft)] text-[var(--shell-accent)]">
    <mat-icon aria-hidden="true">travel_explore</mat-icon>
  </div>
  <h1 class="font-display text-3xl font-bold tracking-tight text-[var(--color-text-primary)]">{{ title() }}</h1>
  <p class="text-sm leading-6 text-[var(--color-text-secondary)]">{{ message() }}</p>
  <a mat-flat-button color="primary" class="!rounded-xl" [routerLink]="backLink()">{{ backLabel() }}</a>
</section>
```

### 6.17 Pipes (all `standalone`, `pure`)

| Pipe | Class / name | Signature | Behaviour |
|---|---|---|---|
| Relative time | `RelativeTimePipe` / `relativeTime` | `(value: string \| Date \| null \| undefined, fallback = '—') => string` | Uply `TimeAgoPipe` logic ("just now", "3 min ago", "2 hr ago", "4 days ago", weeks, months, years); naive ISO without zone is treated as UTC; null/unparseable → fallback. |
| Date/time | `DateTimePipe` / `dateTime` | `(value, style: 'medium' \| 'date' \| 'time' = 'medium', fallback = '—')` | `formatDateTime` (Intl, `dateStyle: 'medium', timeStyle: 'short'`), `formatDateOnly`, `timeStyle: 'medium'` for `time`. |
| Bytes | `BytesPipe` / `bytes` | `(value: number \| null \| undefined, decimals = 1)` | 1024 base; `0 → '0 B'`, `1536 → '1.5 KB'`, units B/KB/MB/GB; negative or non-finite → `'—'`. |
| Compact number | `CompactNumberPipe` / `compactNumber` | `(value: number \| null \| undefined)` | `Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })`; null → `'—'`. Used for AI token counts. |
| Diff percent | `DiffPercentPipe` / `diffPercent` (delegates to the exported pure `formatDiffPercent(ratio)` in the same file, for component code) | `(ratio: number \| null \| undefined)` | ratio 0..1 → percent: `null → '—'`, `0 → '0%'`, `<0.01% → '<0.01%'`, `<1% → 2 decimals`, `<10% → 1 decimal`, else 0 decimals; values > 1 clamp to `'100%'`. |
| Short SHA | `ShortShaPipe` / `shortSha` | `(sha: string \| null \| undefined, length = 7)` | first `length` chars; null → `'—'`. |
| Artifact URL | `ArtifactUrlPipe` / `artifactUrl` | `(path: string \| null \| undefined) => string \| null` | Delegates to `artifactUrl(path)` in `core/utils/artifact-url.util.ts` (01 §5.14.3): returns `environment.artifactBaseUrl + path` only when `path` starts with `/artifacts/`, contains no `..` segment, no `\`, no `?`/`#` and no `//`; otherwise `null`. Component code calls the function; templates may use the pipe. This is the only place an image URL is built. |
| Markdown | `MarkdownPipe` / `markdown` | `(source: string \| null \| undefined) => string` | See below. Output is bound with `[innerHTML]`. |

Markdown pipe:

```ts
import { Pipe, PipeTransform } from '@angular/core';
import { Marked } from 'marked';
import DOMPurify, { type Config } from 'dompurify';
import { MARKDOWN_MAX_CHARS } from '../../core/constants/ui.constants';

const markdown = new Marked({ gfm: true, breaks: false });

const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'script', 'img', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'svg', 'math', 'video', 'audio'],
  FORBID_ATTR: ['style', 'class', 'id', 'srcset'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|#)/i,
};

let linkHookInstalled = false;
function ensureLinkHook(): void {
  if (linkHookInstalled) return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  linkHookInstalled = true;
}

@Pipe({ name: 'markdown' })
export class MarkdownPipe implements PipeTransform {
  transform(source: string | null | undefined): string {
    if (!source || !source.trim()) return '';
    ensureLinkHook();
    const text = source.length > MARKDOWN_MAX_CHARS ? `${source.slice(0, MARKDOWN_MAX_CHARS)}\n\n…` : source;
    const html = markdown.parse(text, { async: false });          // marked ^18 (02): sync overload returns string
    return DOMPurify.sanitize(html, PURIFY_CONFIG);              // string (RETURN_DOM options not used)
  }
}
```

Usage: `<div class="pv-prose" [innerHTML]="summary | markdown"></div>`. Angular's built-in sanitizer runs again on the bound string (defence in depth). `DomSanitizer.bypassSecurityTrust*` is forbidden anywhere in the codebase. The pipe is pure, so markdown is parsed only when the source string changes (polling that returns the same summary does not re-parse).

### 6.18 Utilities and constants

Constants live in `core/constants/<area>.constants.ts`, utilities in `core/utils/<name>.util.ts` (01 §5.5.4).

```ts
// core/constants/polling.constants.ts  (02 file: keep its two constants and JSDoc, append the rest)
export const VISUALIZATION_POLL_MS = 2_000;           // 02, 00 §12: detail poll
export const CONSOLE_POLL_MS = 1_500;                 // 02, 00 §12: console poll
export const HEALTH_POLL_MS = 30_000;
export const POLL_FAILURE_BANNER_THRESHOLD = 3;       // consecutive detail-poll failures before the inline banner

// core/constants/pagination.constants.ts
export const DEFAULT_PAGE_SIZE = 20;                  // 00 §9
export const PAGE_SIZE_OPTIONS = [20, 50, 100];       // max 100 per 00 §9

// core/constants/ui.constants.ts
export const APP_VERSION = '0.1.0';                   // keep equal to frontend/package.json "version"
export const CONSOLE_BATCH_LIMIT = 500;               // 00 §14.4: console limit default and max
export const CONSOLE_MAX_PAGES_PER_TICK = 20;
export const CONSOLE_MAX_EVENTS = 5_000;              // client-side cap (oldest dropped)
export const MARKDOWN_MAX_CHARS = 100_000;
export const RECENT_VISUALIZATIONS_LIMIT = 5;
```

```ts
// core/utils/visualization-status.util.ts
export interface PipelineStage { status: Exclude<VisualizationStatus, TerminalVisualizationStatus>; label: string; icon: string; }
export const PIPELINE_STAGES: readonly PipelineStage[] = [
  { status: 'queued', label: 'Queued', icon: 'schedule' },
  { status: 'preparing', label: 'Preparing workspace', icon: 'folder_copy' },
  { status: 'analyzing', label: 'Analyzing changes', icon: 'manage_search' },
  { status: 'generating_harnesses', label: 'Generating harnesses', icon: 'auto_awesome' },
  { status: 'rendering', label: 'Rendering', icon: 'photo_camera' },
  { status: 'diffing', label: 'Diffing', icon: 'difference' },
  { status: 'summarizing', label: 'Summarizing', icon: 'summarize' },
];
export function isTerminalStatus(status: VisualizationStatus): status is TerminalVisualizationStatus {
  return (TERMINAL_VISUALIZATION_STATUSES as readonly string[]).includes(status);
}
/** Index in PIPELINE_STAGES for a stage name (a non-terminal status or a console `stage`); -1 otherwise. */
export function stageIndex(stage: string): number {
  return PIPELINE_STAGES.findIndex((s) => s.status === stage);
}
```

Console event `stage` values are the pipeline status names (00 §14.4), so `stageIndex` serves both statuses and console stages.

```ts
// core/utils/labels.util.ts
export function formatPillLabel(value: unknown): string; // copied from Uply data-grid-helpers
export function sourceLabel(v: Pick<VisualizationSummaryView, 'sourceType' | 'prNumber' | 'headRef'>): string;
//  github_pr → "PR #42"; local_branch → "Branch feature/x"; working_tree → "Working tree"
export function refsLabel(v: Pick<VisualizationSummaryView, 'baseRef' | 'headRef' | 'sourceType'>): string;
//  "main ← feature/x"; working_tree → "<baseRef> ← working tree" (07 stores headRef "working-tree" for this type)
export function isSafeGithubUrl(url: string | null | undefined): url is string;
//  true only for strings starting with "https://github.com/"
export function providerLabel(p: string): string {
  return p === 'anthropic_api' ? 'Anthropic API' : p === 'claude_code' ? 'Claude Code' : formatPillLabel(p);
}
//  Shared by 13's Settings (Test AI result) and visualization detail (summary line); a feature never imports another feature.
```

```ts
// core/utils/artifact-url.util.ts
export function artifactUrl(path: string | null | undefined): string | null {
  if (!path || !path.startsWith('/artifacts/') || /(^|\/)\.\.(\/|$)|\\|[?#]|\/\//.test(path)) return null;
  return `${environment.artifactBaseUrl.replace(/\/+$/, '')}${path}`;
}
```

### 6.19 Not-found handling summary

- Unknown URL → `**` route → `NotFoundPageComponent` inside the shell.
- Detail screens (13) that receive `ApiError.isNotFound` render `<app-not-found-page title="Visualization not found" message="…" backLink="/visualizations" backLabel="Back to visualizations" />` and stop polling. Non-numeric `:id` is treated the same without calling the API.

### 6.20 UI pattern cookbook (13 must use these exact patterns)

Page host classes (Uply):

| Page type | Host `class` | Uply source |
|---|---|---|
| List page whose grid fills the viewport (repositories, visualizations) | `flex min-h-0 flex-1 flex-col gap-4 overflow-hidden` | monitor list |
| Detail/settings page (scrolls) | `flex flex-col gap-6` | monitor detail and settings (`space-y-6`) |

Page header: `app-page-header` (§6.16.1) reproduces Uply's header row (`flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between`, `h1.font-display.text-3xl.font-bold.tracking-tight`, back `mat-icon-button` with `arrow_back` on detail pages, meta row `mt-1 flex flex-wrap items-center gap-2`).

Card (Uply monitor detail):

```html
<mat-card class="!rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-5 shadow-[var(--shadow-md)]">
  <div class="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
    <div>
      <h3 class="text-lg font-semibold text-[var(--color-text-primary)]">Title</h3>
      <p class="mt-1 max-w-2xl text-sm text-[var(--color-text-secondary)]">Description.</p>
    </div>
    <div class="flex flex-wrap items-center gap-2"><!-- card actions --></div>
  </div>
  <!-- body -->
</mat-card>
```

Definition list inside a card (Uply "Configuration"):

```html
<dl class="divide-y divide-[color:var(--color-border)]">
  <div class="grid grid-cols-[minmax(0,1fr)_auto] gap-4 py-3">
    <dt class="text-sm text-[var(--color-text-tertiary)]">Package manager</dt>
    <dd class="text-right text-sm font-medium text-[var(--color-text-primary)]">pnpm</dd>
  </div>
</dl>
```

Stat tile (Uply dashboard KPI):

```html
<div class="flex min-h-[6rem] flex-col justify-between rounded-xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)] p-4">
  <div class="flex items-center justify-between gap-3">
    <p class="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">Changed</p>
    <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--shell-accent-soft)] text-[var(--shell-accent)]"><mat-icon class="!h-4 !w-4 !text-[18px]">difference</mat-icon></span>
  </div>
  <p class="text-2xl font-semibold tracking-tight text-[var(--color-text-primary)]">7</p>
</div>
```

Grid panel (Uply monitor list): `<div class="dd-ag-grid-panel flex min-h-0 flex-1 flex-col gap-4 p-4 sm:p-5">` toolbar row (`flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between`, left `text-sm text-[var(--color-text-tertiary)]` count label, right filter buttons) + `<div class="min-h-0 flex-1 overflow-hidden"><app-data-grid … /></div>`. The panel is `flex-1` inside the list-page host above, which gives ag-grid its height exactly as in Uply. Grid rows are `rowHeight` 56 (Uply); stacked two-line cells (`renderStackedText`) fit in 56.

Expander (Uply run detail):

```html
<details class="group overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[var(--color-bg-secondary)]">
  <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4">
    <div class="min-w-0">
      <div class="text-base font-semibold text-[var(--color-text-primary)]">Code diff</div>
      <div class="text-[0.86rem] text-[var(--color-text-tertiary)]">+12 −3</div>
    </div>
    <mat-icon class="!h-4 !w-4 !text-base text-[var(--color-text-tertiary)] transition-transform group-open:rotate-180" aria-hidden="true">expand_more</mat-icon>
  </summary>
  <div class="px-5 pb-5"><!-- content --></div>
</details>
```

Buttons:

| Role | Markup |
|---|---|
| Primary | `<button mat-flat-button color="primary" type="button" class="!rounded-xl"><mat-icon>add</mat-icon> Add repository</button>` |
| Secondary | `<button mat-stroked-button type="button" class="!rounded-xl">…</button>` |
| Toolbar/filter | `<button mat-stroked-button type="button" class="!h-10 !rounded-xl" [matMenuTriggerFor]="menu"><mat-icon>filter_list</mat-icon> Status: All</button>` |
| Destructive | `<button mat-stroked-button color="warn" type="button" class="!rounded-xl"><mat-icon>delete</mat-icon> Remove</button>` |
| Busy | `@if (busy()) { <mat-spinner diameter="18" class="!inline-block align-middle mr-2" /> } @else { <mat-icon>play_arrow</mat-icon> } {{ busy() ? 'Starting…' : 'Visualize' }}` with `[disabled]="busy()"` |
| Icon | `<button mat-icon-button type="button" aria-label="…" matTooltip="…"><mat-icon>…</mat-icon></button>` |
| Grid cell action | `renderActionButton('open', 'Open', 'primary')` |

Form field: `<mat-form-field class="w-full"><mat-label>Local path</mat-label><input matInput formControlName="localPath" autocomplete="off" spellcheck="false" /><mat-hint>…</mat-hint>@if (…) {<mat-error>…</mat-error>}</mat-form-field>` (fill appearance and Uply rounding come from global CSS).

Busy-but-loaded refresh: keep content visible and show a spinner inside the refresh button; never swap content for a full spinner on refresh.

Inset note (Uply settings): `<div class="rounded-2xl border border-[color:var(--color-border)] bg-[var(--color-bg-tertiary)] px-4 py-3 text-sm leading-6 text-[var(--color-text-secondary)]">…</div>`.

Terminal panel (Uply run console, copied class for class; slate text utilities replaced by the `pv-console__*` classes from `prvision.scss` so the light-theme remap cannot recolour them):

```html
<div class="pv-console flex flex-col overflow-hidden rounded-2xl border border-[color:var(--color-border)]">
  <div class="pv-console__divider flex items-center justify-between gap-3 border-b px-4 py-3">
    <div>
      <p class="text-sm font-bold">Pipeline console</p>
      <p class="pv-console__subtle mt-0.5 text-xs">128 events</p>
    </div>
    <!-- header pills/buttons: dd-pill dd-pill--info "Live" -->
  </div>
  <div class="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
    <div class="pv-console__row grid grid-cols-[5.5rem_4.75rem_minmax(0,1fr)] gap-3 border-b px-2 py-2 last:border-b-0">
      <time class="pv-console__muted whitespace-nowrap">12:01:03</time>
      <span class="pv-console__level--info font-bold uppercase">info</span>
      <span class="min-w-0 break-words"><span class="pv-console__muted">[rendering]</span> Rendered CartSummary head in 812 ms</span>
    </div>
  </div>
</div>
```

Empty terminal: `<div class="grid min-h-48 place-items-center px-4 py-8 text-center text-sm"><div><p class="font-display text-base font-semibold tracking-tight">No console events yet</p><p class="pv-console__subtle mt-2 text-sm">…</p></div></div>`. `font-mono` is Manrope in Uply (`@theme --font-mono`), so the console reads like Uply's; real monospace (`pv-code`) is only for code diffs and harness source.

Loading: first load → `<app-loading-spinner />` in place of the section. Empty → `<app-empty-state>`. Error → `<app-inline-alert tone="error">` with a Retry button in `inlineAlertAction`.

### 6.21 Accessibility baseline

- Skip link to `#main-content`; `main` is focusable (`tabindex="-1"`).
- Sidebar is a `nav` with `aria-label`; active link gets `aria-current="page"` via `ariaCurrentWhenActive`.
- Every icon-only button has `aria-label` and a tooltip; decorative `mat-icon`s have `aria-hidden="true"`.
- Dialogs: opened through `MatDialog` (§6.16.8), rendered by generic-popup: `role="dialog"`, `aria-modal="true"`, `aria-labelledby`, CDK focus trap auto-captured, Escape closes the topmost, Material restores focus to the trigger on close.
- Live regions: the top-bar API pill is inside `role="status"`; inline alerts are `role="status"` / `role="alert"`; 13's console uses `role="log"` with `aria-live="polite"` on the container only.
- Drawer: `aria-controls`/`aria-expanded` on the menu button, `inert` when hidden, Escape closes, focus moves to first link on open and back to the button on close.
- Status pills are text, not colour alone; tone is reinforced by the label.
- Focus ring: 2px `--shell-accent` outline via `:focus-visible` (prvision.scss §5).
- Reduced motion disables the sidebar gradient animation and pulse dots.
- Contrast: text tokens meet 4.5:1 on their intended backgrounds in both themes; filled primary button labels meet 4.5:1 (verify in devtools during acceptance).

## 7. Error handling and edge cases

| Case | Behaviour |
|---|---|
| Backend down / CORS failure | `HttpErrorResponse.status === 0` → `ApiError` with `NETWORK_ERROR_MESSAGE`; toast unless silent; top bar shows "API offline" within 30 s (health poll). |
| Error body `{ status, error, error_reason }` (00 §14.2) | Message from `error`, reason from `error_reason`. |
| `error` is `string[]` (validation) | First entry is the message; the rest in `details`. |
| Error body missing or not the 00 shape (proxy HTML, empty 502) | Message from `defaultMessageForStatus(status)`; `errorReason = null`. |
| Unknown `error_reason` | `errorReason = null`; message shown as sent. |
| 2xx body without `data` (contract breach) | Observable errors with `ApiError(-1, 'internal_error')`; never toasted; caller shows its error state. |
| 202 (cancel requested) | Normal success; body is the envelope. |
| Polling requests | All GETs are silent by default; pollers own their error UI (no toast every 2 s). |
| Backend returns `degraded` health | Top bar shows the warning pill "API degraded". |
| `localStorage` throws or holds junk | Theme falls back to dark; no exception escapes. |
| Unknown enum value from API | Status pill shows muted pill with title-cased value. |
| Artifact path not under `/artifacts/`, or with `..`, `\\`, `?`, `#` or `//` | `artifactUrl` returns `null`; image viewer (13) shows "Image unavailable". |
| Markdown input null/blank | Pipe returns `''`; caller shows its empty copy. |
| Very large markdown | Truncated at `MARKDOWN_MAX_CHARS` with an ellipsis. |
| Viewport < 1024px | Drawer navigation; content padding `p-6`. |
| Viewport < 640px | Header actions wrap below the title; segmented controls go full width. |

## 8. Logging

- The browser app has no log transport. The only logging is 02's `console.error` in `main.ts` for a bootstrap failure. The error interceptor does not log; failed requests are visible in the browser Network tab and as toasts/inline alerts.
- Never log request or response bodies, headers, or form values (settings requests carry secrets).
- ESLint `no-console` allows only `error` (01 §5.3.2).
- Pipeline console events are data shown by 13's console panel; this sheet does not produce them.

## 9. Security notes

- No `bypassSecurityTrust*` anywhere. Enforce with a lint check: `grep -rn "bypassSecurityTrust" src/ && exit 1` in CI (sheet 02 wires it) or an ESLint `no-restricted-syntax` rule on `MemberExpression[property.name=/^bypassSecurityTrust/]`.
- AI-authored text (summary markdown) goes only through `MarkdownPipe` (`marked` → DOMPurify with a strict profile: no images, styles, forms, iframes, SVG; links limited to `http(s)`, `mailto`, `#`, forced `target=_blank rel="noopener noreferrer"`), then Angular's sanitizer via `[innerHTML]`.
- AI notes, harness source, code diffs, console messages, error messages and structural diffs are rendered with interpolation (`{{ }}`), never `innerHTML`.
- ag-grid cell renderers return HTML strings; every interpolated value passes through `escapeHtml`.
- Remote images are not loaded from markdown (`img` forbidden), so AI text cannot trigger network requests.
- Artifact URLs are only built from API values that start with `/artifacts/` and contain no `..`.
- Secrets (GitHub token, Anthropic key) are never stored in `localStorage`, never logged, never put in URLs. Only the theme mode is stored.
- External links (GitHub PR URLs) render only when the URL starts with `https://github.com/` (helper `isSafeGithubUrl(url)` in `core/utils/labels.util.ts`) and always use `rel="noopener noreferrer"`.
- Fonts and icons are bundled; the app makes no third-party network requests.
- The dev server binds `localhost:4210`; the API is `127.0.0.1:3100` with CORS restricted by the backend to `FRONTEND_URL` (sheet 04).

## 10. Tests (Jasmine/Karma, `*.spec.ts` next to source)

Uply's Karma setup through 02: `npm test` (one headless ChromeHeadless run via `scripts/karma-chrome.mjs --watch=false`, 00 §14.10); `npm run test:watch` while developing. HTTP tests use `provideHttpClient(withInterceptors([errorInterceptor]))` + `provideHttpClientTesting()` and `HttpTestingController` (end each test with `httpMock.verify()`); stub `NotificationService` with `jasmine.createSpyObj`. Component tests: `TestBed.configureTestingModule({ imports: [Component], providers: [...] })`, inputs via `fixture.componentRef.setInput(...)`, query by role/text. Timer tests: `fakeAsync` + `tick`, ending with `discardPeriodicTasks()`.

| File | Cases |
|---|---|
| `app.component.spec.ts` | `renders the glow layer and a router outlet`. |
| `core/services/api.service.spec.ts` | `getSettings → GET {apiBaseUrl}/settings and unwraps {status,data}`; `every typed method hits its 00 §9/§14.4 method + path` (table-driven over all 18 methods); `updateSettings sends the body unchanged (no null secrets)`; `listVisualizations serializes statuses as one comma-separated status param`; `listVisualizations omits empty status/repositoryId`; `getConsole passes afterId and limit`; `GETs set SUPPRESS_ERROR_TOAST true by default`; `redetect/remove* set it false by default`; `explicit { silent } overrides the default`; `2xx body without data errors with ApiError status -1 and no toast`; `202 cancel response unwraps`. |
| `core/interceptors/error.interceptor.spec.ts` | `maps {status,error,error_reason} to ApiError`; `string[] error → message + details`; `status 0 yields network message`; `non-JSON error body → status default message`; `unknown reason → errorReason null`; `toasts userMessageFor(error) once when not suppressed`; `does not toast when SUPPRESS_ERROR_TOAST is true`; `rethrows ApiError instance`. |
| `core/models/api-error.model.spec.ts` | `isNotFound for 404 and not_found`; `is(reason)`; `toApiError passes through ApiError`; `non-HTTP error → status -1`. |
| `core/services/theme.service.spec.ts` | `init defaults to dark with empty storage`; `init reads light`; `invalid stored value → dark`; `getItem throwing → dark, no throw`; `setItem throwing → mode still applied`; `toggle swaps html classes and color-scheme`; `toggle persists under prvision.theme`; `updates meta theme-color`. |
| `core/services/health.service.spec.ts` (fakeAsync) | `online after {status:'ok'}`; `degraded after {status:'degraded'}`; `offline after error without toast`; `polls every HEALTH_POLL_MS`; `a slow request is not overlapped by the next tick (exhaustMap)`; `start is idempotent`. |
| `core/services/notification.service.spec.ts` | `success/error/info/warn use dd-app-toast + variant class and durations`; `queued uses snackbar-run-started and 14 s`; `promptAction maps 'action' to true`. |
| `core/services/confirm-dialog.service.spec.ts` | `true result → true`; `undefined/false → false`; `passes dd-generic-popup-dialog panel class`. |
| `core/utils/error-messages.util.spec.ts` | `every ApiErrorReason has copy` (iterate `API_ERROR_REASONS`); `userMessageFor uses fixed copy when present`; `falls back to the server message for validation_failed, conflict, ai_*`; `no reason → server message`; `settings reasons carry actionRoute /settings`. |
| `core/utils/visualization-status.util.spec.ts` | `isTerminalStatus for each status`; `stageIndex order matches PIPELINE_STAGES`; `terminal or unknown → -1`. |
| `core/utils/labels.util.spec.ts` | `sourceLabel for each source type`; `refsLabel for branch and working tree`; `formatPillLabel snake_case`; `isSafeGithubUrl accepts https://github.com/…, rejects http, javascript:, other hosts`; `providerLabel maps anthropic_api and claude_code, title-cases unknown values`. |
| `core/utils/artifact-url.util.spec.ts` | `prefixes environment.artifactBaseUrl`; `rejects non-/artifacts/ paths`; `rejects .., backslash, ?, # and //`; `null → null`. |
| `layouts/main-layout/main-layout.component.spec.ts` | `renders Repositories, Visualizations, Settings links`; `active link gets nav-link-active and aria-current`; `desktop shows sidebar without menu button`; `mobile: menu button opens drawer, Escape closes, focus returns`; `hidden drawer is inert`; `theme button toggles and updates aria-label`; `health offline/degraded/online pills`; `NavigationEnd closes drawer and sets section title`; `version text uses APP_VERSION`. |
| `shared/components/page-header/page-header.component.spec.ts` | `renders title as h1`; `subtitle optional`; `back link renders with aria-label`; `projects actions slot`. |
| `shared/components/status-pill/status-pill.component.spec.ts` | Table-driven: every row of the 6.16.2 mapping yields the class `dd-pill--<tone>` and label; `live statuses render pulse dot`; `unknown value → muted + title-cased label`; `label override`; `ariaPrefix builds aria-label`. |
| `shared/components/segmented-control/segmented-control.component.spec.ts` | `marks selected with aria-pressed=true`; `click updates model`; `disabled option ignored`; `renders count badge`. |
| `shared/components/inline-alert/inline-alert.component.spec.ts` | `error tone has role=alert`; `other tones role=status`; `renders title and projected action`. |
| `shared/components/empty-state/empty-state.component.spec.ts` | `joins title and message with sentence punctuation`; `renders action slot`. |
| `shared/components/generic-popup/generic-popup.component.spec.ts` (fakeAsync) | `renders when shouldShow true`; `Escape emits closePopup when closeOnEscape`; `backdrop click respects closeOnBackdrop`; `primary disabled while loading`; `restores focus after close`; `locks and unlocks body scroll`; `focuses [cdkFocusInitial] element when present, else the panel`; `Tab cycles inside the panel (focus trap)`. |
| `shared/components/data-grid/data-grid-helpers.spec.ts` | `escapeHtml escapes &<>"'`; `renderStatusPillHtml escapes label and uses tone class`; `renderStackedText escapes both lines`; `extractGridAction finds data-grid-action`. |
| `shared/components/data-grid/action-menu-cell-renderer.component.spec.ts` | `refresh() with new actions re-renders menu items (OnPush)`; `danger item gets dd-menu-danger`. |
| `shared/components/not-found-page/not-found-page.component.spec.ts` | `default copy and link`; `custom inputs`. |
| `features/**` stubs | One `renders its page title` case each (13 replaces them with real specs). |
| `shared/pipes/*.spec.ts` | relative-time: `just now`, `1 min ago`, `naive ISO treated as UTC`, `null → fallback`. date-time: `medium/date/time styles`, `invalid → fallback`. bytes: `0 B`, `1.5 KB`, `negative → —`. compact-number: `12345 → 12.3K`, `null → —`. diff-percent: `null`, `0`, `0.00005 → <0.01%`, `0.0123 → 1.23%`, `0.05 → 5.0%`, `0.42 → 42%`, `1.5 → 100%`. short-sha: `7 chars`, `null`. artifact-url: `delegates to artifactUrl()`. markdown: `renders headings, lists, code`, `strips <script>`, `strips onerror/onclick`, `drops javascript: href`, `drops <img>`, `adds target _blank + rel noopener`, `blank → ''`, `truncates over MARKDOWN_MAX_CHARS`. |

## 11. Acceptance criteria

Every item is checkable by command output, DevTools or a spec. 01 §5.17 Definition of Done applies.

- [ ] `cd frontend && npm ci && npm start` serves `http://localhost:4210`; the DevTools console shows no errors on any route.
- [ ] `npm run verify` passes in `frontend/` (format check, `ng lint --max-warnings 0`, production build with no budget error, `npm test` single headless run).
- [ ] `/` redirects to `/repositories`; `/visualizations`, `/settings`, `/repositories/1`, `/visualizations/1` render their stub pages inside the shell; `/nope` renders the not-found page inside the shell; `document.title` reads "Repositories · PRVision" etc.
- [ ] First load (empty storage) is dark: `<html>` has `shell--tenant-dark`, `getComputedStyle(document.body).backgroundColor` is `rgb(17, 24, 28)` (`#11181c`), sidebar shows Uply's dark teal gradient.
- [ ] The top-bar toggle switches to light: `shell--tenant-light`, body background `rgb(246, 244, 238)` (`#f6f4ee`), Uply's light sidebar; reload keeps light; `localStorage.removeItem('prvision.theme')` + reload returns to dark.
- [ ] With site data blocked in DevTools, the app loads dark without console errors.
- [ ] Light theme side by side with Uply (`npm start` in Uply-v2 tenant-frontend): computed styles match for sidebar width (256px), nav item padding (10px 12px) / radius (12px) / icon size (22px), active nav background, `h1` (30px/36px, 700, Manrope), card radius (1rem with `!rounded-2xl`, 1.35rem plain) / border / `--shadow-md`, filled button background (`--shell-button-bg`) and 12px radius, fill form field wrapper, `.dd-pill--*` colours, toasts (bottom-right, `dd-app-toast`), confirm dialog panel.
- [ ] Below 1024px the sidebar is a drawer: menu button opens it, backdrop or Escape closes it, focus moves to the first link and back to the menu button, links are not tabbable when closed (`inert`).
- [ ] Stopping the backend shows "API offline" within 30 s; starting it shows "API online"; stopping Redis only shows "API degraded".
- [ ] `grep -rn "bypassSecurityTrust" frontend/src` returns nothing; `grep -c "walkthrough\|brand\|dd-entry\|dd-dashboard\|alerting-pill" frontend/src/styles.scss` returns `0`; `grep -c "dd-grid-row-clickable" frontend/src/styles.scss` ≥ 1.
- [ ] No request to a third-party host appears in the Network tab (fonts and icons load from the dev server).
- [ ] `grep -rn "HttpClient" frontend/src/app --include=*.ts | grep -v spec` lists only `core/services/api.service.ts` (and the `provideHttpClient` call in `app.config.ts`); `grep -rn "environment.artifactBaseUrl" frontend/src/app --include=*.ts | grep -v "\.spec\.ts"` lists only `core/utils/artifact-url.util.ts` (specs such as `artifact-url.util.spec.ts` and 13's image-compare spec may read it to build expectations).
- [ ] `grep -rn "eslint-disable" frontend/src` lists only `shared/components/data-grid/data-grid.component.ts`.
- [ ] `SettingsUpdateRequest` declares `githubToken?: string` and `anthropicApiKey?: string` (no `null` in their types); `api.service.spec.ts` asserts a cleared secret is sent as `""`.
- [ ] Models in `core/models` match 00 §9 + §14.4 field-for-field (reviewer diff against 00), including `failedStage`, `changeReason`, `skipReason`, `tokensAdded/tokensRemoved`, `CancelVisualizationResponse`, `HealthView`.
- [ ] Keyboard-only: skip link works; every interactive element is reachable and shows the 2px accent focus ring.

## 12. Contract changes requested

1. Resolved — 00 §14.2 (wire envelope `{ status, data }` / `{ status, error, error_reason }`; the frontend no longer tolerates Uply's raw format).
2. Resolved — 00 §14.4 (`HealthView`).
3. Resolved — 00 §14.4 (`SettingsUpdateRequest`, `GithubTestResultView`, `AiTestResultView`, `RepositoryCreateRequest`, `VisualizationCreateRequest`, list `status` comma list, console query, cancel and delete responses).

Also resolved (Revision 2 final review):

4. **01 wire format** — Resolved — 01 §5.7.1 now specifies the 00 §14.2 envelope and mentions Uply's raw format only as the deviation it replaces. Originally: 01 §5.7.1 and §11.3 still described Uply's raw wire format (`{ statusCode, message, error }`) and 01 §5.14.3 said the interceptor parses it. This sheet follows 00 §14.2 only: `toApiError` parses only `{ status, error, error_reason }` and has no `{ statusCode, message, error }` fallback.
5. **Frontend dependencies** — Resolved — 02 delegates them to this sheet (02's `index.html` note: sheet 12 adds `@fontsource/manrope`, `material-icons`, `material-symbols` and `dompurify`). Originally: 02 §6.11.1 could list `dompurify`, `@fontsource/manrope`, `material-icons`, `material-symbols` so the scaffold lockfile already contains them; until then this sheet adds them (§3).
