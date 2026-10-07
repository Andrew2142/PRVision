# 00 — Overview and Shared Contracts

Owner: lead (not assigned to a build agent)
Status: authoritative. Every other spec sheet must conform to the names, paths, types and values in this file. If a sheet needs to change a contract, change it here first and note it in the sheet's "Contract changes" section.

**Revision 2 (section 14) and Revision 3 (section 15, Angular) resolve the contract change requests raised by the sheet authors. Later revisions win over earlier sections.**

## 1. Product summary

PRVision is a local-first developer tool. It turns a GitHub pull request, a local branch, or uncommitted working-tree changes into a visual review: for every UI component the change touches it shows the component rendered **before** (base) and **after** (head), a pixel diff, a structural diff when rendering fails, and an AI-written summary.

It does **not** run the target app. Each changed component is rendered in isolation in headless Chromium, through the target repo's own Vite, using a render harness written by AI (props, fixtures, providers, module mocks). The **same harness** renders base and head so differences come only from the component code. AI never draws UI; real code renders the pixels.

Prototype target: Vite + React projects (Tailwind, CSS modules, plain CSS/SCSS). Angular and Next.js targets are post-prototype.

## 2. Locked product decisions

| # | Decision | Choice |
|---|---|---|
| D1 | Form factor | Local web app. `npm run dev` boots infra, backend, worker and UI. Opened at `http://localhost:4210`. |
| D2 | Backend stack | Node 20+, TypeScript (strict), Express 5, Drizzle ORM + PostgreSQL 16, BullMQ + Redis 7, Playwright Chromium. Postgres and Redis in Docker Compose. |
| D3 | Architecture style | `docs/ARCHITECTURE_GUIDELINES.md` (copied from Uply-v2) is binding: composition root, explicit routes, thin controllers, DTO validation, generated models, `QueryHandler`, `ResponseHandler`, `AuthContext`, BullMQ worker, `node:test` service tests. |
| D4 | Frontend stack | Angular 19 standalone components, Angular Material 19, Tailwind CSS 4, SCSS, RxJS 7.8 + signals. Visual design matches Uply-v2's tenant frontend. |
| D5 | AI | Two providers behind one interface: Anthropic API key (`@anthropic-ai/sdk`) and locally installed Claude Code (`@anthropic-ai/claude-agent-sdk`). Default model `claude-opus-5-5`. |
| D6 | GitHub | Fine-grained personal access token, encrypted at rest. `@octokit/rest`. |
| D7 | Source checkout | User registers an existing local clone. PRVision creates its own git worktrees under the data dir and symlinks the user's `node_modules`. The user's working copy is never modified. |
| D8 | Inputs | `github_pr`, `local_branch`, `working_tree`. |
| D9 | Auth | None. Single local user. Server binds `127.0.0.1`. `LocalAuthMiddleware` populates `AuthContext` with a fixed local user. |
| D10 | Output | In-app only. No PR comments. |
| D11 | Repo | Standalone at `~/dev/PRVision`. Uply-v2 is a code donor only (copy and strip; never a runtime dependency). |
| D12 | Platforms | Linux and macOS. |

Policy constraint (D5): Anthropic does not allow third-party products to route requests through users' Claude.ai subscription logins. Using the developer's own Claude Code login is acceptable for this personal prototype only. Before distribution, the Claude Code provider must require API-key auth or be removed.

## 3. Spec sheet map and build order

| Sheet | Title | Depends on | Build wave |
|---|---|---|---|
| 01 | Engineering standards (Node, TypeScript, Express, Drizzle, Angular) | 00 | reference for all |
| 02 | Repository scaffold, tooling and configuration | 00, 01 | 1 |
| 03 | Database schema, migrations and models | 02 | 2 |
| 04 | Backend core infrastructure | 02, 03 | 2 |
| 05 | Settings and AI providers | 03, 04 | 3 |
| 06 | Repositories and GitHub | 03, 04 | 3 |
| 07 | Visualizations API, worker orchestration and workspace preparation | 03, 04, 06 | 3 |
| 08 | Change analysis | 04, 07 | 4 |
| 09 | Harness generation (AI prompting) | 05, 08 | 4 |
| 10 | Render engine | 07, 09 | 5 |
| 11 | Image diff, structural diff and AI summary | 05, 08, 10 | 5 |
| 12 | Frontend foundation (Uply-parity shell) | 02 | 2 |
| 13 | Frontend feature screens | 12, API contracts in 05–07 | 3–5 |
| 14 | Testing, fixtures and QA | all | continuous; fixture repo in wave 2 |

Agents may start a sheet as soon as its dependencies' **contracts** (this file) are fixed; they do not need the dependency's implementation if they code against the interfaces below and stub them in tests.

## 4. Fixed paths, ports and environment

```text
PRVision/
  package.json  docker-compose.yml  .env.example  README.md
  docs/ARCHITECTURE_GUIDELINES.md
  docs/specs/00-…14-*.md
  backend/      (Express API + worker)
  frontend/     (Angular app)
  tests/backend/  tests/backend/helpers/  tests/fixtures/
  tools/create-fixture-repo.mjs
```

| Thing | Value |
|---|---|
| Backend port / host | `3100` / `127.0.0.1` |
| Frontend dev server | `4210` |
| Postgres (Docker) | host port `5433`, db/user/password `prvision` |
| Redis (Docker) | host port `6380` |
| Data dir | `PRVISION_DATA_DIR`, default `~/.prvision` |
| Worktrees | `<dataDir>/worktrees/<visualizationId>/{base,head}` |
| Artifacts | `<dataDir>/artifacts/<visualizationId>/<componentId>/{base,head,diff}.png` |
| Fixture repo | `<dataDir>/fixtures/sample-react-app` |
| Harness folder inside a worktree | `.prvision-harness/` |
| Git refs PRVision may create in the user's clone | `refs/prvision/pr-<n>` |

Environment variables (complete list; validated at boot by `config-validation.ts`):

| Variable | Required | Default | Used by |
|---|---|---|---|
| `NODE_ENV` | no | `development` | all |
| `PORT` | no | `3100` | app |
| `HOST` | no | `127.0.0.1` | app |
| `FRONTEND_URL` | no | `http://localhost:4210` | CORS |
| `DATABASE_URL` | yes | — | DB |
| `REDIS_URL` | yes | — | Redis/BullMQ |
| `PRVISION_SECRET_KEY` | yes | generated by `setup-env.mjs` (32 random bytes, base64) | `Encryption` |
| `PRVISION_DATA_DIR` | no | `~/.prvision` | artifact store, worktrees |
| `LOG_LEVEL` | no | `info` | logger |

## 5. Enums (exact values)

Files under `backend/src/enums/domain/`, re-exported from `backend/src/enums/index.ts`. Use TypeScript `as const` objects plus a derived union type (not TS `enum`), mirrored in Postgres as `text` columns with `CHECK` constraints generated from the same arrays (see sheet 03).

```ts
export const AiProviderKind = { ANTHROPIC_API: "anthropic_api", CLAUDE_CODE: "claude_code" } as const;
export const AiEffort = { LOW: "low", MEDIUM: "medium", HIGH: "high", XHIGH: "xhigh", MAX: "max" } as const;
export const RepositoryFramework = { REACT_VITE: "react_vite" } as const;
export const PackageManager = { NPM: "npm", PNPM: "pnpm", YARN: "yarn" } as const;
export const VisualizationSourceType = { GITHUB_PR: "github_pr", LOCAL_BRANCH: "local_branch", WORKING_TREE: "working_tree" } as const;
export const VisualizationStatus = {
  QUEUED: "queued", PREPARING: "preparing", ANALYZING: "analyzing",
  GENERATING_HARNESSES: "generating_harnesses", RENDERING: "rendering",
  DIFFING: "diffing", SUMMARIZING: "summarizing",
  COMPLETED: "completed", FAILED: "failed", CANCELLED: "cancelled",
} as const;
export const TERMINAL_VISUALIZATION_STATUSES = ["completed", "failed", "cancelled"] as const;
export const ComponentChangeKind = { MODIFIED: "modified", ADDED: "added", REMOVED: "removed", AFFECTED_PARENT: "affected_parent" } as const;
export const ComponentRenderStatus = { PENDING: "pending", RENDERED: "rendered", PARTIAL: "partial", FAILED: "failed", SKIPPED: "skipped" } as const;
export const ComponentVisualChange = { CHANGED: "changed", UNCHANGED: "unchanged", NEW: "new", DELETED: "deleted" } as const;
export const ComponentRisk = { NONE: "none", CHECK: "check", LIKELY_REGRESSION: "likely_regression" } as const;
export const ConsoleLevel = { INFO: "info", WARN: "warn", ERROR: "error" } as const;
```

`Table` enum (`backend/src/enums/utility/table.ts`): `APP_SETTINGS = "app_settings"`, `REPOSITORIES = "repositories"`, `VISUALIZATIONS = "visualizations"`, `VISUALIZATION_COMPONENTS = "visualization_components"`, `VISUALIZATION_CONSOLE_EVENTS = "visualization_console_events"`.

## 6. Database tables (names and columns are fixed; types, indexes and constraints are detailed in sheet 03)

Common columns: `id serial primary key`, `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`. Soft-delete tables add `is_deleted boolean not null default false`. Drizzle property names are camelCase of the column names.

- `app_settings` (single row, `id = 1`): `github_token_encrypted`, `github_login`, `ai_provider`, `anthropic_api_key_encrypted`, `ai_model`, `ai_harness_effort`, `ai_summary_effort`.
- `repositories` (soft): `name`, `local_path` (unique among non-deleted), `github_owner`, `github_repo`, `default_branch`, `framework`, `package_manager`, `vite_config_path`, `tsconfig_path`, `entry_file_path`, `global_style_paths` (jsonb string[]), `last_detected_at`.
- `visualizations` (soft): `repository_id` (fk), `source_type`, `pr_number`, `title`, `base_ref`, `head_ref`, `base_sha`, `head_sha`, `status`, `error_message`, `summary_markdown`, `ai_provider`, `ai_model`, `ai_usage` (jsonb), `job_id`, `component_count`, `changed_count`, `started_at`, `completed_at`.
- `visualization_components`: `visualization_id` (fk, cascade), `file_path`, `export_name`, `display_name`, `change_kind`, `render_status`, `visual_change`, `risk`, `rank`, `harness_source`, `harness_notes`, `mocked_modules` (jsonb), `base_image_path`, `head_image_path`, `diff_image_path`, `image_width`, `image_height`, `diff_pixel_ratio` (numeric(8,6)), `code_diff`, `structural_diff` (jsonb), `ai_note`, `base_error`, `head_error`.
- `visualization_console_events`: `visualization_id` (fk, cascade), `level`, `stage`, `message`, `created_at` only (append-only, no `updated_at`).

## 7. Backend module map (file → class), owned by sheet

```text
backend/src/
  app.ts, worker.ts                                       04
  routes/index.ts                                         04 (each feature sheet adds its routes)
  config-consts/{app,queue,render,ai,pagination}.config.ts, config-validation.ts   02 (values), 04 (validation)
  middleware/local-auth-middleware.ts                     04
  utilities/
    handlers/{response,query,query-handler-drizzle,model,array}-handler.ts        04
    validation/validation.ts   mappers/dto-mapper.ts      04
    context/auth-context.ts                               04
    processors/encryption.ts                              04
    helpers/{env,error-message,paths,process}.ts          04
    loggers/logger.ts                                     04
    services/{db-pool,drizzle-db,redis-pool,queue-service}.ts                     04
    services/git-client.ts                                04
    services/artifact-store.ts                            04
    services/github-client.ts                             06
    services/ai/{ai-provider.ts,ai-provider-factory.ts,anthropic-api-provider.ts,claude-code-provider.ts,json-schema-validator.ts}   05
  controllers/{health,settings,repositories,visualizations}-controller.ts        04/05/06/07
  services/settings/settings-service.ts                   05
  services/repositories/{repositories-service,project-detection-service}.ts      06
  services/visualizations/visualizations-service.ts       07
  services/visualizations/visualization-console-service.ts                       07
  services/visualizations/pipeline/visualization-worker-service.ts               07
  services/visualizations/pipeline/workspace-prepare-service.ts                  07
  services/visualizations/pipeline/change-analysis-service.ts                    08
  services/visualizations/pipeline/harness-generation-service.ts                 09
  services/visualizations/pipeline/harness-prompts.ts                           09
  services/visualizations/pipeline/render-service.ts                             10
  services/visualizations/pipeline/vite-mock-plugin.ts                           10
  services/visualizations/pipeline/image-diff-service.ts                         11
  services/visualizations/pipeline/structural-diff-service.ts                    11
  services/visualizations/pipeline/summary-service.ts                            11
  types/visualization-pipeline.ts                         00 (this file, section 8)
  dtos/{settings,repositories,visualizations}/…           05/06/07
  backend/harness-templates/{index.html,entry.tsx,error-boundary.tsx}            10
```

## 8. Cross-sheet TypeScript contracts

File: `backend/src/types/visualization-pipeline.ts`. Pipeline services exchange only these shapes. Services that persist results do so through `QueryHandler`; these types are in-memory contracts.

```ts
import type { AiEffort, ComponentChangeKind, VisualizationSourceType } from "../enums";

/** Produced by WorkspacePrepareService (07). */
export interface PreparedWorkspace {
  visualizationId: number;
  repositoryPath: string;            // user's clone (read-only to PRVision)
  baseDir: string;                   // <dataDir>/worktrees/<id>/base
  headDir: string;                   // <dataDir>/worktrees/<id>/head
  baseSha: string;
  headSha: string | null;            // null for working_tree
  sourceType: VisualizationSourceType;
  dependencyDrift: boolean;          // package.json deps differ between sides
}

/** Produced by ChangeAnalysisService (08), one per component row. */
export interface ComponentCandidate {
  componentId: number;               // visualization_components.id after insert
  filePath: string;                  // repo-relative, POSIX separators
  exportName: string;                // "default" or the named export
  displayName: string;
  changeKind: (typeof ComponentChangeKind)[keyof typeof ComponentChangeKind];
  rank: number;                      // 0 = highest priority
  codeDiff: string | null;           // unified diff of filePath (null for affected_parent)
  reason: string;                    // e.g. "imports changed hook src/hooks/useCart.ts"
}

export interface ChangeAnalysisResult {
  candidates: ComponentCandidate[];  // rendered set, capped
  skipped: Array<Omit<ComponentCandidate, "componentId"> & { skipReason: string }>;
  changedFiles: Array<{ path: string; status: "A" | "M" | "D" | "R"; previousPath?: string }>;
}

/** Produced by HarnessGenerationService (09). */
export interface MockedModule { specifier: string; source: string; }
export interface HarnessGenerationResult {
  componentId: number;
  harnessSource: string;             // TSX module, default export PRVisionHarness
  mockedModules: MockedModule[];
  notes: string;
}

/** Produced by RenderService (10). */
export interface RenderSideResult {
  side: "base" | "head";
  ok: boolean;
  imagePath: string | null;          // relative to dataDir
  width: number | null;
  height: number | null;
  error: string | null;
  consoleErrors: string[];
  durationMs: number;
}
export interface ComponentRenderResult {
  componentId: number;
  base: RenderSideResult | null;     // null when the component does not exist on that side
  head: RenderSideResult | null;
}

/** Produced by ImageDiffService (11). */
export interface ImageDiffResult {
  componentId: number;
  diffImagePath: string;
  diffPixelRatio: number;            // 0..1
  width: number;
  height: number;
}

/** Produced by StructuralDiffService (11). Stored in visualization_components.structural_diff. */
export type StructuralChange =
  | { kind: "element_added"; path: string; tag: string }
  | { kind: "element_removed"; path: string; tag: string }
  | { kind: "attribute_changed"; path: string; tag: string; attribute: string; before: string | null; after: string | null }
  | { kind: "text_changed"; path: string; before: string; after: string };

/** AI provider contract (05). Consumed by 09 and 11. */
export interface AiStructuredRequest {
  purpose: "harness" | "harness_repair" | "summary" | "connection_test";
  system: string;
  prompt: string;
  images?: Array<{ mediaType: "image/png"; base64: string; label: string }>;
  jsonSchema: Record<string, unknown>;     // JSON Schema draft 2020-12, additionalProperties:false
  effort: (typeof AiEffort)[keyof typeof AiEffort];
  workingDirectory?: string;               // head worktree (Claude Code provider only)
  signal?: AbortSignal;
}
export interface AiUsage { inputTokens: number; outputTokens: number; calls: number; }
export interface AiStructuredResult<T> { data: T; usage: AiUsage; model: string; }
export interface AiProvider {
  readonly kind: "anthropic_api" | "claude_code";
  generateStructured<T>(request: AiStructuredRequest): Promise<AiStructuredResult<T>>;
}

/** Raised by providers; pipeline maps it to component/visualization failures. */
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly reason: "auth" | "config" | "rate_limit" | "refusal" | "max_tokens" | "invalid_output" | "network" | "aborted" | "unknown",
    readonly retryable: boolean,
  ) { super(message); }
}

/** Pipeline context passed through the orchestrator (07). */
export interface PipelineContext {
  visualizationId: number;
  workspace: PreparedWorkspace;
  repository: { id: number; localPath: string; viteConfigPath: string | null; tsconfigPath: string | null; entryFilePath: string | null; globalStylePaths: string[] };
  ai: AiProvider;
  aiSettings: { model: string; harnessEffort: AiStructuredRequest["effort"]; summaryEffort: AiStructuredRequest["effort"] };
  console: { info(stage: string, message: string): Promise<void>; warn(stage: string, message: string): Promise<void>; error(stage: string, message: string): Promise<void> };
  isCancelled(): Promise<boolean>;
  signal: AbortSignal;
}
```

## 9. HTTP API (paths, controllers, DTO files)

All under `/api`, behind `LocalAuthMiddleware`, envelopes via `ResponseHandler` (`{ status, data }` / `{ status, error, error_reason? }`). Pagination query `page` (1-based), `pageSize` (default 20, max 100); paged responses return `{ items, page, pageSize, total }`.

| Method | Path | Controller.method | Request DTO | Sheet |
|---|---|---|---|---|
| GET | `/api/health` | `HealthController.get` | — | 04 |
| GET | `/api/settings` | `SettingsController.get` | — | 05 |
| PUT | `/api/settings` | `SettingsController.update` | `dtos/settings/settings-update.dto.ts` | 05 |
| POST | `/api/settings/test-github` | `SettingsController.testGithub` | — | 05 |
| POST | `/api/settings/test-ai` | `SettingsController.testAi` | — | 05 |
| GET | `/api/repositories` | `RepositoriesController.list` | — | 06 |
| POST | `/api/repositories` | `RepositoriesController.create` | `dtos/repositories/repository-create.dto.ts` | 06 |
| GET | `/api/repositories/:id` | `RepositoriesController.get` | `dtos/shared/id-param.dto.ts` | 06 |
| POST | `/api/repositories/:id/redetect` | `RepositoriesController.redetect` | id param | 06 |
| DELETE | `/api/repositories/:id` | `RepositoriesController.remove` | id param | 06 |
| GET | `/api/repositories/:id/pull-requests` | `RepositoriesController.listPullRequests` | id param | 06 |
| GET | `/api/repositories/:id/branches` | `RepositoriesController.listBranches` | id param | 06 |
| POST | `/api/visualizations` | `VisualizationsController.create` | `dtos/visualizations/visualization-create.dto.ts` | 07 |
| GET | `/api/visualizations` | `VisualizationsController.list` | `dtos/visualizations/visualization-list-query.dto.ts` | 07 |
| GET | `/api/visualizations/:id` | `VisualizationsController.get` | id param | 07 |
| GET | `/api/visualizations/:id/console` | `VisualizationsController.console` | `dtos/visualizations/visualization-console-query.dto.ts` | 07 |
| POST | `/api/visualizations/:id/cancel` | `VisualizationsController.cancel` | id param | 07 |
| DELETE | `/api/visualizations/:id` | `VisualizationsController.remove` | id param | 07 |
| GET | `/artifacts/*` | static (`express.static`) with traversal guard | — | 04 |

Response view shapes (backend `dtos/**/*-view.dto.ts` and frontend `core/models/*.model.ts` must match exactly):

```ts
interface SettingsView {
  hasGithubToken: boolean; githubLogin: string | null;
  aiProvider: "anthropic_api" | "claude_code"; hasAnthropicApiKey: boolean;
  aiModel: string; aiHarnessEffort: Effort; aiSummaryEffort: Effort;
}
interface RepositoryView {
  id: number; name: string; localPath: string; githubOwner: string | null; githubRepo: string | null;
  defaultBranch: string; framework: "react_vite"; packageManager: "npm" | "pnpm" | "yarn";
  viteConfigPath: string | null; tsconfigPath: string | null; entryFilePath: string | null; globalStylePaths: string[];
  lastDetectedAt: string; createdAt: string;
}
interface PullRequestView { number: number; title: string; author: string; headRef: string; baseRef: string; updatedAt: string; draft: boolean; url: string; }
interface BranchListView { current: string | null; branches: string[]; defaultBranch: string; workingTreeDirty: boolean; }
interface VisualizationSummaryView {
  id: number; repositoryId: number; repositoryName: string; sourceType: SourceType; prNumber: number | null;
  title: string; baseRef: string; headRef: string; status: VisualizationStatus;
  componentCount: number; changedCount: number; createdAt: string; completedAt: string | null;
}
interface VisualizationDetailView extends VisualizationSummaryView {
  baseSha: string | null; headSha: string | null; errorMessage: string | null; summaryMarkdown: string | null;
  aiProvider: string; aiModel: string; aiUsage: { inputTokens: number; outputTokens: number; calls: number } | null;
  startedAt: string | null; components: VisualizationComponentView[];
}
interface VisualizationComponentView {
  id: number; filePath: string; exportName: string; displayName: string; changeKind: ChangeKind;
  renderStatus: RenderStatus; visualChange: VisualChange | null; risk: Risk | null; rank: number;
  baseImageUrl: string | null; headImageUrl: string | null; diffImageUrl: string | null;   // "/artifacts/…"
  imageWidth: number | null; imageHeight: number | null; diffPixelRatio: number | null;
  codeDiff: string | null; structuralDiff: StructuralChange[] | null; aiNote: string | null;
  harnessSource: string | null; harnessNotes: string | null; baseError: string | null; headError: string | null;
}
interface ConsoleEventView { id: number; level: "info" | "warn" | "error"; stage: string; message: string; createdAt: string; }
interface CreateVisualizationResponse { visualizationId: number; jobId: string; }
```

Timestamps are ISO-8601 strings in responses. `error_reason` machine codes used across sheets: `validation_failed`, `not_found`, `not_git_repo`, `unsupported_framework`, `missing_node_modules`, `no_github_remote`, `github_token_missing`, `github_unauthorized`, `ai_not_configured`, `ai_unauthorized`, `already_terminal`, `working_tree_clean`.

## 10. Queue contract

- Prefix `prvision`; queue `visualizations`; job name `visualize`; job data `{ visualizationId: number }`; `jobId` = `viz-<visualizationId>` (idempotent enqueue); `attempts: 1`; worker `concurrency: 1`.
- Cancellation flag: Redis key `prvision:cancel:<visualizationId>` (value `1`, TTL 1 day).

## 11. Pipeline stage order (orchestrator, sheet 07)

`queued → preparing (07) → analyzing (08) → generating_harnesses (09) → rendering (10) → diffing (11) → summarizing (11) → completed`. Any stage may end in `failed` or `cancelled`. Per-component failures never fail the visualization. Worktrees are removed in `finally`; artifacts are kept.

## 12. Frontend contracts

- Routes: `/` → redirect `/repositories`; `/repositories`; `/repositories/:id`; `/visualizations`; `/visualizations/:id`; `/settings`; `**` → not-found.
- Feature folders: `features/{repositories,visualizations,settings}`; shared: `core/{services,models,interceptors,utils}`, `shared/{components,pipes}`, `layouts/main-layout`.
- `ApiService` base URL from `environment.apiBaseUrl` (`http://localhost:3100/api`); artifact URLs are prefixed with `environment.artifactBaseUrl` (`http://localhost:3100`).
- Polling: visualization detail every 2 s and console every 1.5 s while status is non-terminal; stop on terminal or on destroy.
- Visual language: copy Uply-v2 tenant frontend (layout, theme service, Material + Tailwind tokens, status pill, data grid, empty state, dialogs). Sheet 12 defines the exact inventory.

## 13. Conventions every sheet must state for its own scope

Each sheet must contain: Purpose; Scope / out of scope; Dependencies (sheets + contracts used); File inventory (every file it creates, with responsibility); Detailed design; Error handling and edge cases; Logging/console events; Security notes; Tests (file names and cases); Acceptance criteria (checklist an agent can verify); Contract changes (normally "none").

## 14. Revision 2 — resolved contract decisions (overrides earlier sections)

### 14.1 Runtime and tooling

- Node `>=22.12` in every `package.json` `engines`; `.nvmrc` = `24`. Reason: Node 20 is EOL, and `@octokit/rest@22`, `pixelmatch@7` and `@anthropic-ai/claude-agent-sdk` are ESM-only; the backend stays CommonJS compiled with `module: nodenext` and loads them via `require(esm)`.
- git `>=2.36` is a documented prerequisite (`git worktree list -z`, build note 04).
- Docker host ports default to `5433` (Postgres) and `6380` (Redis) but are overridable with `PRVISION_PG_PORT` / `PRVISION_REDIS_PORT`, read only by `docker-compose.yml`; `DATABASE_URL` / `REDIS_URL` in `.env` must match. `setup-env.mjs` detects a busy port and picks the next free one, writing both values.
- Runtime dependencies added: `typescript` (compiler API in the worker), `diff@^8`, `pixelmatch@^7`, `pngjs`, `ajv`, `@octokit/rest@^22`, `pino`.
- Setup runs `npx playwright install chromium`. `backend/harness-templates/**` is excluded from backend `tsc`, ESLint and Prettier.

### 14.2 HTTP wire format

The JSON on the wire is the envelope from ARCHITECTURE_GUIDELINES section 6 (this is a deliberate improvement over Uply-v2, whose `ResponseHandler` sends raw data):

```json
{ "status": 200, "data": { } }
{ "status": 409, "error": "Visualization is still running", "error_reason": "conflict" }
{ "status": 400, "error": ["repositoryId must be a number"], "error_reason": "validation_failed" }
```

The HTTP status code equals `status`. `error` is a string, or a string array for validation failures. The frontend `ApiService` unwraps `data` and maps errors to `ApiError { status, message, reason }`; it does not need to support Uply's raw format.

Complete `error_reason` list: `validation_failed`, `not_found`, `conflict`, `forbidden_origin`, `payload_too_large`, `internal_error`, `not_git_repo`, `unsupported_framework`, `missing_node_modules`, `no_github_remote`, `github_token_missing`, `github_unauthorized`, `github_rate_limited` (429), `github_unavailable` (502), `ai_not_configured`, `ai_unauthorized`, `already_terminal`, `working_tree_clean`.

### 14.3 Enums and tables

- `Table` stays an `as const` object with the **snake_case** values from section 5. `QueryHandlerDrizzle` resolves tables through `backend/src/database/table-registry.ts` (sheet 03/04), an exhaustive `Record<TableName, PgTable>` — never by schema export name. `DeletionMode` also becomes `as const`. Sheet 03 owns `backend/src/enums/**`; sheet 02 creates the files from section 5 during scaffold.
- New columns: `visualization_components.change_reason text null`, `visualization_components.skip_reason text null`, `visualizations.failed_stage text null` (stage active when the run failed or was cancelled; CHECK against `VisualizationStatus` non-terminal values).
- Constraints from sheet 03 are adopted: `repositories → visualizations` FK `onDelete: restrict`; unique `(visualization_id, file_path, export_name)`; `pr_number` not null iff `source_type = 'github_pr'`; `completed_at` only for terminal statuses; `diff_pixel_ratio` between 0 and 1. CHECK constraints use the `sql.raw` helper allowed only in `schema.ts`.
- `app_settings` row seeded by migration `0001_seed_app_settings.sql`. `schema-readiness.ts` fails boot when migrations are missing.
- Stored image paths are relative to the data dir: `artifacts/<visualizationId>/<componentId>/<base|head|diff>.png`. `ArtifactStore.toPublicUrl` turns them into `/artifacts/<visualizationId>/<componentId>/<kind>.png`.
- `visual_change = null` means "not compared". `component_count` counts every inserted component row (including skipped). `changed_count` counts `changed + new + deleted`.
- `repositories.global_style_paths` entries are import specifiers: `/src/index.css` for repo files, bare names for package stylesheets.

### 14.4 API shapes (replace the corresponding rows/types in section 9)

```ts
// GET /api/health  (always HTTP 200)
interface HealthView { status: "ok" | "degraded"; database: boolean; redis: boolean; version: string; }

// PUT /api/settings — partial update. Secret fields (githubToken, anthropicApiKey):
//   omitted → keep stored value; "" → clear; non-empty string → replace; null → 400 validation_failed.
interface SettingsUpdateRequest {
  githubToken?: string; anthropicApiKey?: string;
  aiProvider?: "anthropic_api" | "claude_code"; aiModel?: string;
  aiHarnessEffort?: Effort; aiSummaryEffort?: Effort;
}
// POST /api/settings/test-github → 200
interface GithubTestResultView { login: string; }
// POST /api/settings/test-ai → 200
interface AiTestResultView { provider: "anthropic_api" | "claude_code"; model: string; latencyMs: number; }

// GET /api/repositories → RepositoryView[]   (array, not paged)
// POST /api/repositories
interface RepositoryCreateRequest { localPath: string; name?: string; }   // leading "~/" expanded server-side

// POST /api/visualizations → 202 CreateVisualizationResponse
interface VisualizationCreateRequest {
  repositoryId: number;
  sourceType: "github_pr" | "local_branch" | "working_tree";
  prNumber?: number;        // required for github_pr
  headRef?: string;         // required for local_branch
  baseRef?: string;         // optional; defaults to repository.defaultBranch (ignored for github_pr: PR base is used)
}
// GET /api/visualizations?repositoryId=&status=queued,rendering&page=&pageSize= → paged VisualizationSummaryView
// GET /api/visualizations/:id/console?afterId=&limit=  → ConsoleEventView[] oldest first, afterId exclusive, limit default and max 500
// POST /api/visualizations/:id/cancel
//   200 { id, status: "cancelled" }          when the job was still queued and was removed
//   202 { id, status: "cancel_requested" }   when the worker was signalled
//   409 already_terminal
interface CancelVisualizationResponse { id: number; status: "cancelled" | "cancel_requested"; }
// DELETE /api/visualizations/:id → 200 { id }; 409 conflict while non-terminal
// DELETE /api/repositories/:id → 200 { id }; 409 conflict while any visualization of it is non-terminal
```

`VisualizationDetailView` gains `failedStage: VisualizationStatus | null`. `VisualizationComponentView` gains `changeReason: string | null` and `skipReason: string | null`. `StructuralChange` `attribute_changed` gains optional `tokensAdded?: string[]; tokensRemoved?: string[]` (for `className`). Console event `stage` values are the pipeline status names.

`AiUsage` gains optional `cacheReadInputTokens?: number`; `AiProviderError` gains optional `usage?: AiUsage` so tokens spent on failed calls are counted.

### 14.5 Local security middleware

`LocalAuthMiddleware` also rejects requests whose `Host` header is not `localhost:<PORT>` / `127.0.0.1:<PORT>` (DNS-rebinding guard) and state-changing requests whose `Origin` is present and not `FRONTEND_URL` (`403 forbidden_origin`). Child processes (git, Vite, Claude Code) receive an allow-listed environment that never contains `PRVISION_SECRET_KEY`, `DATABASE_URL` or `REDIS_URL`.

### 14.6 Queue

The job processor is injected by `worker.ts` and receives `{ visualizationId, jobId, signal }`. `signal` aborts on user cancel (Redis flag polled every 1 s by `QueueService`) or shutdown, with `signal.reason` = `"cancelled" | "shutdown"`. Worker options: `concurrency: 1`, `lockDuration: 300000`, `maxStalledCount: 0` (stalled jobs fail, never re-run). The orchestrator applies an overall timeout of 45 minutes.

### 14.7 Pipeline service contracts (authoritative signatures)

- `PipelineStepError` lives in `backend/src/types/pipeline-errors.ts`: `new PipelineStepError(stage: VisualizationStatusValue, userMessage: string, options?: { cause?: unknown })`. It is also re-exported from `types/visualization-pipeline.ts`.
- **Sheet 07 sets `baseSha` to the merge-base** for `github_pr` and `local_branch`. PR fetch may create `refs/prvision/pr-<n>` and `refs/prvision/pr-<n>-base`; both are deleted after the run.
- **08 → 09 hand-off:** `ChangeAnalysisResult` gains `sourceQueries: ComponentSourceQueries`, an object (built by sheet 08, backed by its import graph for this visualization) exposing every query sheet 09 needs — the union of 08's `ComponentSourceQueries` and 09's requested `ImportGraph` methods, each taking an explicit `side: "base" | "head"` where relevant. Sheet 09 depends only on this interface; no service instance is passed between stages.
- **Render:** sheet 10's `RenderService` API is authoritative; sheet 07 calls it exactly as sheet 10 defines. Render groups, Vite child process per side, `loadConfigFromFile` + `configFile: false`, and a fresh browser context per component and side are adopted.
- **Repair:** `HarnessGenerationService.repairHarness` returns a new `HarnessGenerationResult` (or a `component_defect` verdict) and does **not** persist; sheet 10 persists the harness of the attempt it keeps. Repair runs only when the head side fails (base side for removed components); a one-side failure on a modified component is reported as `partial`, not repaired.
- **Diff/summary:** method names `ImageDiffService.diff`, `StructuralDiffService.compare`, `SummaryService.summarize(ctx, analysis)`. Sheet 07 keeps the analysis result and the worktrees alive until summarizing ends; cleanup runs in `finally` after that.
- **AI usage:** sheet 09's `AiUsageRecorder` is the only writer of `visualizations.ai_usage`; sheets 09 and 11 both use it. The orchestrator never writes `ai_usage`.
- **Harness conventions (09 ↔ 10):** default export `PRVisionHarness`; the target is imported by relative path from `.prvision-harness/components/` or by project alias; wrapper elements use inline styles, never Tailwind classes; mock semantics and the repair error format are as defined in sheet 10 (sections 5.8.1 and 5.12.3), which sheet 09 adopts.
- `.prvision-harness/` sits in the Vite root of each worktree (the worktree root in the prototype). If the Vite root is a subfolder, sheet 07 symlinks `node_modules` there too. Vite `cacheDir` is inside `.prvision-harness/`.
- 09 writes `render_status = skipped | failed` and the side error columns for components that never reach rendering.

### 14.8 Infrastructure APIs other sheets rely on (sheet 04 must provide)

- `ArtifactStore`: `componentDir`, `ensureComponentDir`, `componentImagePath(vizId, componentId, kind)`, `read`, `write`, `removeVisualization`, `toPublicUrl`, `resolveSafe`.
- `GitClient`: everything listed in sheet 07's brief plus `diffNameStatusNoIndex`, `deleteRef`, `--no-write-fetch-head` on fetch, `-c diff.noprefix=false --ignore-submodules=all` on binary diff, hooks/fsmonitor/textconv/LFS/credential helpers disabled, refs after `--end-of-options`, token passed via environment config only. Auth header values come from sheet 06's `GitHubClient.gitAuthHeaders(token)`.
- `SettingsStore` (sheet 05) is the only non-HTTP reader of settings and secrets (`readGithubToken()`, `readAiSettings()`).
- Config constants: sheet 02 holds the single consolidated list of names and values for `render.config.ts` and `ai.config.ts`, covering every constant referenced by sheets 04, 08, 09, 10 and 11 (viewport constant is `RENDER_VIEWPORT`). Constants also include `HARNESS_TEMPLATES_DIR`.
- `dtos/shared/id-param.dto.ts` and `dtos/shared/pagination-query.dto.ts` are owned by sheet 04.

### 14.9 Frontend

- Dark theme is defined new in `styles/prvision.scss` (Uply's light palette unchanged; Uply's dark rules are incomplete). Uply's `tailwind.config.js` is copied for reference but not wired into Tailwind 4. Fonts and icons are bundled locally.
- Repository detail and visualization screens use the API shapes in 14.4.

### 14.10 Testing contracts

- Test-only env vars, ignored by `config-validation.ts`: `PRVISION_IT_RENDER`, `PRVISION_IT_AI`, `PRVISION_INTEGRATION` (umbrella; enables render ITs), `PRVISION_TEST_DATABASE_URL`. Sheet 10 uses `PRVISION_IT_RENDER` (not `PRVISION_RENDER_IT`).
- Backend test command (sheet 01) includes the preload `tests/backend/helpers/setup.ts` and `--test-force-exit`. Integration tests live in `tests/backend/integration/`.
- `npm test --prefix frontend` is a single headless run (`ng test --watch=false --browsers=ChromeHeadless`); a separate `test:watch` script keeps watch mode.
- Sheet 04's logger module exports `logTestStream` for asserting log output (pino child loggers cannot be patched after import). `tests/backend/helpers/test-context.ts` is owned by sheet 04; sheet 14 adds exports to it.
- Fixture repo branches: `main`, `feature/button-restyle`, `qa/render-failure`, `qa/no-visual-change`, `qa/css-module-only`, `qa/dependency-drift`. Fixture pins Vite 7, React 19, Tailwind 4. Render integration assertions must use Tailwind v4 colour values (e.g. `bg-red-500` is oklch-based, ≈ `rgb(251,44,54)`, not v3's `rgb(239,68,68)`); prefer asserting diff ratios over exact colours.

### 14.11 Clarification

For `sourceType = "working_tree"` the request carries no `baseRef`; the base is the clone's current `HEAD` commit and the head is `HEAD` plus uncommitted changes.

### 14.12 Final review decisions

- **HTTP status per `error_reason`:** 400 for every "fix your input or settings" reason (`validation_failed`, `not_git_repo`, `unsupported_framework`, `missing_node_modules`, `no_github_remote`, `github_token_missing`, `github_unauthorized`, `ai_not_configured`, `ai_unauthorized`, `working_tree_clean`); 403 `forbidden_origin`; 404 `not_found`; 409 `conflict` / `already_terminal`; 413 `payload_too_large`; 429 `github_rate_limited`; 500 `internal_error`; 502 `github_unavailable`; 504 for a timed-out settings test (`internal_error` reason with a timeout message). 401 is never returned. Sheet 01 §5.7.1 holds the table.
- **`PipelineStepError`:** `new PipelineStepError(stage, userMessage, options?: { cause?: unknown; detail?: string; code?: string })`, where `stage` is typed as the non-terminal `VisualizationStatus` values (matches `failed_stage`). Always constructed positionally.
- **Origin check:** allows `FRONTEND_URL` and its `127.0.0.1` twin (`http://127.0.0.1:4210`).
- **Child env:** `CHILD_PROCESS_BASE_ENV` (sheet 02 §6.7) is a strict allow-list used for git and the Vite host. The Claude Code child uses `AI_CLAUDE_CODE_PARENT_ENV`, which additionally allows `ANTHROPIC_*`, `CLAUDE_*` and CA-certificate variables. No code outside `config-consts` reads `process.env`.
- **Shared types from sheet 08:** `ComponentSourceQueries`, `DirectImport`, `ChangedDependency`, `WorktreeSide`, `TypeSourceResult`, `CallSite` and `ChangeAnalysisResult.sourceQueries` are defined authoritatively in sheet 08 §5.1.1 and live in `types/visualization-pipeline.ts`; sheet 02 creates a placeholder that sheet 08 replaces verbatim.
- **Module map:** section 7 lists the core files. Each sheet's "File inventory" is authoritative for the additional files in its area, including: 03 `database/table-registry.ts`, `database/schema-readiness.ts`; 04 health service, `local-user`, `error-reason`, `dtos/shared/*`; 05 `services/settings/settings-store.ts`, `ai/claude-code-result.ts`, `ai/ai-connection-test.ts`, split test-result view DTOs; 07 `visualization-state-machine.ts`; 08 `import-graph.ts`, `component-detector.ts`, `module-resolver.ts`, `change-source.ts`, `component-source-queries.ts`, `types/change-analysis.ts`; 09 `harness-context-builder.ts`, `harness-validator.ts`, `ai-usage-recorder.ts`; 10 `mock-rules.ts` and the Vite host child entry; 11 `png-utils.ts`, `summary-prompts.ts`.
- **ArtifactStore:** uses the 14.8 names; `removeVisualizationArtifacts` exists only as a deprecated alias — new code calls `removeVisualization`.
- **Additional test-only env vars** (ignored by config validation): `PRVISION_TEST_LOG_STDOUT`, `PRVISION_KEEP_TEST_ARTIFACTS`, `PRVISION_REAL_DATA_DIR`, `PRVISION_IT_AI_*`. Config constants are evaluated once at import (after `tests/backend/helpers/setup.ts`); tests change config through `collectConfigValidationErrors(overrides)`, constructor options or `Encryption.setKeyForTesting`, never by mutating `process.env` after import.
- **AI settings test failures:** when the AI provider itself fails during `POST /api/settings/test-ai` (network, rate limit, refusal, invalid output), the response is **502 `internal_error`** with a user-facing message. This is the only use of 502 besides `github_unavailable`.
- **Integration test location:** integration tests live in `tests/backend/integration/` **or** are named `*.integration.test.ts` beside their area's tests (matching sheet 02's `test:it` glob).
- **`image_width` / `image_height`:** a deliberate two-step write. Sheet 10 writes the rendered size; sheet 11 then sets the final value (the compared canvas, or the single image for new/deleted components). No other sheet writes them.
- **Shared types from sheet 09:** `HarnessRenderError`, `HarnessGenerationFailure`, `HarnessGenerationBatchResult` and `HarnessRepairOutcome` are defined authoritatively in sheet 09 §5.1 and live in `types/visualization-pipeline.ts`; sheets 07 and 10 import them from there.
- **`WorktreeSide`** (`"base" | "head"`) has one home: `types/visualization-pipeline.ts`, created by sheet 02 in wave 1. Sheets 04 and 08 import it; neither redefines it.
- **`mock-rules.ts`:** its content is specified in sheet 10 §5.8.1, but sheets 08 and 09 (wave 4) import it, so the sheet 08 agent creates it verbatim in wave 4. Sheet 10 consumes it and may not change its rules without updating 09's validator.


## 15. Revision 3 — Angular support and monorepo app roots (overrides earlier sections)

Source: sheet 15 §11. Where this section and earlier sections disagree, this section wins. Sheet 15 is authoritative for the detailed Angular design.

1. **00 §1**: Angular (17–21, application builder) is supported; Next.js remains post-prototype.
2. **00 §4**: harness folder for Angular is `<worktree>/<appRoot>/.prvision-harness/`; new data-dir path `<dataDir>/cache/angular/<repositoryId>/` (deleted with the repository). Fixture `<dataDir>/fixtures/sample-angular-monorepo`.
3. **00 §5**: `RepositoryFramework = { REACT_VITE: "react_vite", ANGULAR: "angular" }`.
4. **00 §6 / §14.3**: `repositories` gains `app_root` (`not null default '.'`), `angular_project`, `angular_build_configuration`; unique key becomes `(local_path, app_root, coalesce(angular_project, ''))` among non-deleted rows; CHECKs per §5.4.1.
5. **00 §8**: `PipelineContext.repository` gains `framework`, `appRoot`, `angularProject`, `angularBuildConfiguration` (§5.2.1). `HarnessGenerationResult.harnessSource` is "the harness module source: TSX default-exporting `PRVisionHarness` (React) or TypeScript default-exporting `definePrvisionHarness({...})` (Angular)". `MockedModule` for Angular means a repository TypeScript file replacement.
6. **00 §9 / §14.4**: new route `POST /api/repositories/detect-apps` (`RepositoriesController.detectApps`, DTO `dtos/repositories/repository-detect-apps.dto.ts`, view `AppDiscoveryView`); `RepositoryCreateRequest` gains `appRoot?`, `angularProject?`; `RepositoryView` gains `framework` union, `appRoot`, `angularProject`, `angularBuildConfiguration`; `VisualizationDetailView` gains `framework`.
7. **00 §14.1**: backend runtime dependency `@angular/compiler@~21.2` (template parsing only).
8. **00 §14.7**: the orchestrator selects stage factories with `stepFactoriesFor(repository.framework)`; Angular stages implement the same port types. `types/angular-analysis.ts` (§5.2.2) is a shared contract owned by 15b. 09's `HarnessGenerationDeps` gains `prompts`; `HarnessIssueCode` gains the Angular codes. `PageRenderOutcome` (ok) gains `unstable`, `skippedInputs` and `httpUnmatched`.
9. **00 §14.8**: `render.config.ts` gains the `ANGULAR_*` constants (§5.7.12); `app.config.ts` gains `APP_DISCOVERY_MAX_CONFIGS`.
10. **06 §5.4 step 2.2**: a sub-folder registers its toplevel with an app-root hint instead of failing. **06 step 4** monorepo note applies to React only.
11. **07 step 8**: node_modules links for `.` and `appRoot` (§5.4.6); React template copy only for `react_vite`.
12. **10 §5.12.1**: `vite_unavailable` also means "Angular build or static host unavailable for this side" (name kept for stability; UI text says "build unavailable").

## 16. Revision 4 — "New visualization" dialog and commit ranges (overrides earlier sections)

User-requested UX change (2026-10-05).

- **Repository detail page:** the bottom "Pull requests / Local" tab section is removed. A **New visualization** button sits top-right next to Re-detect and Remove and opens a modal stepper dialog. The "Recent visualizations" list stays on the page.
- **Stepper (Uply dialog styling):** step 1 *Source*, step 2 *Select*, step 3 *Review & start*. Source options:
  1. **Pull request:** open PRs, as on the old tab. Disabled with a reason when there is no GitHub remote or token.
  2. **Branch vs branch:** head and base branch selects, as on the old Local tab.
  3. **Commits on a branch** (new): pick a branch, then a **from** (base) commit and a **to** (head) commit from that branch's history. The from commit must be an ancestor of the to commit.
  4. **Uncommitted changes:** the old working-tree card, disabled when the tree is clean.
- **New source type** `commit_range`, added to `VisualizationSourceType`. The DB CHECK is updated through a new migration; applied migrations are never edited. Create request: `{ repositoryId, sourceType: "commit_range", headRef: <branch name>, baseSha, headSha }`, with full 40-hex SHAs. Validation:
  - Both commits exist and are reachable from `headRef`.
  - `baseSha` is an ancestor of `headSha` (`git merge-base --is-ancestor`), and the two differ. Otherwise 400 `validation_failed` with a clear message.
  - Workspace: base worktree at `baseSha`, head worktree at `headSha`. No merge-base step.
  - Default title: `<branch>: <short base>…<short head>`.
- **New endpoint** `GET /api/repositories/:id/commits?branch=<name>&limit=<1..200, default 50>&before=<sha?>` returns `CommitView[]`, newest first: `{ sha, shortSha, subject, authorName, committedAt }`, where `committedAt` is ISO. 400 `validation_failed` for an unknown branch. Pagination works through `before`.
- Views and labels: `VisualizationSummaryView.sourceType` includes `commit_range`. Source labels read "Commits a1b2c3d…e4f5a6b on <branch>".

### 16.1 Single-commit default (2026-10-05)

- "Commits on a branch" defaults to picking **one commit**. PRVision then shows the visual changes that commit introduced: base = its first parent, head = the commit. It is sent as `commit_range` with `baseSha = parentSha` and `headSha = sha`. Merge commits compare against their first parent, so the whole merged PR shows. The root commit can't be picked ("First commit, nothing to compare against").
- `CommitView` gains `parentSha: string | null` (the first parent).
- A secondary "Compare a range instead" link keeps the From/To range picker.
- `CommitView` also gains `isMerge: boolean`, which the dialog uses for the merge note (build note rev4).

## 17. Revision 5 — replaced components (successor matching) (overrides earlier sections)

Motivation: Acme commit 139fcfa replaced `EventFormComponent` (event-form/) with `EventFormModalComponent` (event-form-modal/) and `EventTypeFormComponent` with `EventTypeFormModalComponent`. PRVision showed them as one "removed" card and one "added" card, with no side-by-side.

- **New change kind `replaced`.** It is added to `ComponentChangeKind`, and the DB CHECK is updated through a new migration. A `replaced` row stands for one removed base component paired with one added head component.
- **New columns on `visualization_components`:**
  - `base_file_path`, `base_export_name` and `base_display_name`, all null unless `replaced`.
  - `base_harness_source`, `base_harness_notes` and `base_mocked_modules`, the base-side harness for `replaced` rows. Null otherwise, and the existing harness columns stay the head side.
  - `successor_evidence` jsonb: a list of `{ kind: "call_site_swap" | "git_rename" | "name_similarity" | "content_similarity", detail: string }`.
  - `VisualizationComponentView` gains `baseFilePath`, `baseExportName`, `baseDisplayName` and `successorEvidence`.
- **Successor matching** is a new sub-step at the end of analysis, for both React (08) and Angular (15b), before ranking.
  - It considers every pair of a removed component R and an added component A and scores it:
    - `call_site_swap`, strong (+3): some file that referenced R on base (selector or tag in a template, JSX element, import of R's class) references A on head at a corresponding place, and no longer references R.
    - `git_rename`, strong (+3): git reports R's file renamed to A's file at 40% similarity or more.
    - `name_similarity`, medium (+2): one class name stem contains the other (`EventForm` ⊂ `EventFormModal`), or the edit distance between stems is 4 or less, and the two share a parent feature folder.
    - `content_similarity`, weak (+1): the normalized template or JSX token Jaccard similarity is 0.35 or more.
  - Pairs scoring 3 or more are taken greedily by score, one-to-one. The pair becomes one `replaced` candidate: head = A's file and export, base = R's.
  - The matched R and A no longer appear as separate removed and added rows.
  - The change reason reads "Replaced by EventFormModalComponent (call site swap in events-list, rename)".
  - Ranking puts `replaced` with `modified`.
- **Harness generation:** `replaced` rows get two harnesses, base for R (from base sources) and head for A (from head sources). That is two AI calls, each validated by the side's own rules. Repair applies per side.
- **Render:** base renders R's harness and head renders A's harness. Image diff, structural diff (R's template or JSX against A's) and the summary run as for `modified`. The summary prompt is told this is a replacement.
- **Frontend:**
  - A `replaced` card shows a "Replaced" pill and a header "OldName → NewName", with both file paths.
  - The What changed block lists the evidence in plain words.
  - The side-by-side, slider and diff views work as normal.

## 18. Revision 6 — parallel harness generation (overrides earlier sections)

User decision (2026-10-05): harnesses are generated in parallel. The model stays generic: the single `ai_model` setting (any model ID the provider accepts) is used for harnesses and the summary alike. Use the existing Harness effort and Summary effort settings to tune per-purpose effort.

- `HARNESS_CONCURRENCY_CLAUDE_CODE` and `HARNESS_CONCURRENCY_ANTHROPIC_API` are both 4. The first component still runs alone so later calls reuse the warmed prompt cache; the rest run up to 4 at a time. Only wall-clock time changes. Prompts, validation, retries, usage recording and cancellation are unchanged.
- A per-purpose harness model setting was considered and dropped. It is not part of the contract.
- `GET /api/repositories/:id/commits` accepts `q` (≤100 chars, one line): a SHA prefix match on the branch first, then case-insensitive literal message and author matches, newest first, no paging; `before` is ignored while searching. The New visualization dialog has a "Search commits" field next to the branch select.

## 19. Revision 7 — confirm before rendering more than the default limit (overrides earlier sections)

- New status `awaiting_confirmation` (not terminal, not active), added by migration `0005`. Transitions: `analyzing → awaiting_confirmation`, then `awaiting_confirmation → queued | cancelled | failed`.
- When analysis finds more components than `MAX_COMPONENTS` (12) and the run has no confirmed limit, the worker pauses before any AI call. Worktrees are cleaned up, and the console explains the pause.
- `visualizations.component_limit int null`, between 1 and `COMPONENT_LIMIT_MAX` (100). Null means the default.
- `POST /api/visualizations/:id/continue { componentLimit }`:
  - Allowed only while `awaiting_confirmation`; otherwise 409 `conflict`.
  - Hard-deletes the run's component rows and sets `component_limit`.
  - Moves the run to `queued` and re-enqueues the job (`QueueService.requeueVisualization` removes the finished `viz-<id>` job first).
  - Returns 202 `{ id, componentLimit, jobId }`. The re-run repeats prepare and analysis with the chosen limit and does not pause again.
- Cancelling a paused run moves it to `cancelled` immediately (200).
- `VisualizationDetailView.componentLimit: number | null`.
- **UI:** the status pill reads "Needs your choice". The stepper shows the run on the Analyzing step.
  - A popup asks once per run: "N components changed", with **Render all N** (or top 100), or "Decide below".
  - An inline alert keeps the same choices: Render all, Render top 12, Cancel run.

## 20. Revision 8 — API-key only (overrides earlier sections)

Decision (2026-10-06): D5 changes. Anthropic does not allow third-party products to use Claude.ai subscription logins through the Agent SDK, so the public build ships with the Anthropic API key provider only.

- The Claude Code provider is removed: `claude-code-provider.ts`, `claude-code-result.ts`, the `@anthropic-ai/claude-agent-sdk` dependency (and its peers `zod` and `@modelcontextprotocol/sdk`), and the `AI_CLAUDE_CODE_*` and `HARNESS_CONCURRENCY_CLAUDE_CODE` constants. Harness concurrency is `HARNESS_CONCURRENCY_ANTHROPIC_API` (4).
- `AiProviderKind.CLAUDE_CODE` (`claude_code`) stays only as a legacy value, so existing `app_settings` and `visualizations` rows stay valid without a migration. The CHECK constraints and generated models are unchanged.
- It is not selectable. `PUT /api/settings` accepts only `aiProvider: "anthropic_api"`; `claude_code` fails with `400 validation_failed`.
- A stored `claude_code` setting means AI is not configured. `AiProviderFactory.create` throws `AiProviderError("config")` with "The Claude Code provider is no longer available. Add an Anthropic API key in Settings and save." `POST /api/visualizations` (readiness) and `POST /api/settings/test-ai` return `ai_not_configured` with that message; a run already queued fails with it. Nothing constructs a Claude Code provider.
- The key-absent message is now "Add an Anthropic API key in Settings."
- `AiProvider.kind` is `"anthropic_api"`. `AiStructuredRequest.workingDirectory` is still set by 09 but no provider reads it.
- Settings screen: the provider choice, the Claude Code copy and the subscription policy note are gone. The AI card is the Anthropic API key, model and efforts. When the saved provider is `claude_code`, the card shows a "Claude Code removed" note, requires a key, and the next save sends `aiProvider: "anthropic_api"`.
- Visualizations created with `claude_code` keep showing "Claude Code" as their provider label.

## 21. Revision 9 — harness library, states and live mode (overrides earlier sections)

Source: sheet 16 (decisions in `docs/plans/harness-library-decisions.md`). Where this section and earlier sections disagree, this section wins. Sheet 16 is authoritative for the detailed design.

1. **00 §1:** harnesses are saved per repository in PRVision's database (the harness library) and reused on both sides of later runs; each harness has 1–5 named states; a global style change re-checks every saved harness; finished runs can be explored live. Nothing is written to the user's working copy.
2. **00 §4:** new data-dir paths `<dataDir>/worktrees/scan-<jobId>/`, `<dataDir>/worktrees/repair-<jobId>/`, `<dataDir>/library-jobs/<jobId>/` (scratch renders) and `<dataDir>/live/<sessionId>/`. New state artifacts `artifacts/<v>/<c>/s<ordinal>/{base,head,diff}.png` (ordinal 1–9; ordinal 0 keeps the existing path). New data-dir path `<dataDir>/snapshots/<visualizationId>/` (the working-tree run's uncommitted changes, deleted with the run). No new git ref: nothing is written to the user's clone beyond today's worktree metadata and temporary PR refs. New harness files `.prvision-harness/harness-api.ts` (React) and `.prvision-harness/prvision-steps.ts` (both frameworks).
3. **00 §5:** new enums `HarnessLibraryStatus`, `HarnessLibraryOrigin`, `LibraryBuildMode`, `LibraryJobKind`, `LibraryJobStatus` (+ `ACTIVE_`/`TERMINAL_LIBRARY_JOB_STATUSES`), `ComponentHarnessOrigin`, `LiveSessionStatus` (+ `ACTIVE_LIVE_SESSION_STATUSES`), `LiveStopReason` (sheet 16 §6.1). `ComponentChangeKind` gains `rechecked`. `Table` gains `harness_library_entries`, `harness_library_jobs`, `harness_library_job_events`, `visualization_component_states`, `live_sessions`. `ErrorReason` is unchanged.
4. **00 §6 / §14.3:** migration `0009_harness_library`. New tables `harness_library_entries`, `harness_library_jobs`, `harness_library_job_events`, `visualization_component_states`, `live_sessions`; new columns `repositories.{library_build_mode, state_allowance}`, `visualizations.{checked_count, reused_harness_count, new_harness_count, needs_update_count, global_style_trigger, working_tree_snapshot}`, `visualization_components.{library_entry_id, base_library_entry_id, harness_origin, base_harness_origin, harness_needs_update, source_changed_since_write, state_count, changed_state_count}` (sheet 16 §6.2–§6.9). `visualizations.component_limit` now limits **new harnesses** per run.
5. **00 §8 / §14.7:** new contract file `types/harness-library.ts` (sheet 16 §6.11). `HarnessGenerationResult` and `SideHarness` gain `states`, `origin`, `libraryEntryId` (result also `usage?`); `HarnessGenerationBatchResult` gains `stopReason?`; `HarnessRenderError` gains `stateName?` and its `kind` gains `step_failed`; `ComponentRenderResult` gains `states: StateRenderResult[]`; `RenderSideResult` gains `failureKind`; `ImageDiffResult` gains `states`; `ChangeAnalysisResult` gains `globalStyleChanges`; `PipelineContext` gains `library` and `libraryJob?`; `AiUsage` gains `cacheWriteInputTokens?` (sheet 16 §6.12, §6.13). `PipelineStepFactories` gains `libraryResolution()`, and `render(deps)` accepts optional `persistence` and `artifactStore`. `HarnessGenerationDeps` gains `persistence`, `shouldStartCall`, and `usageRecorder` becomes `Pick<AiUsageRecorder, "add">`. `RenderFailureKind` gains `step_failed` (repairable). Library writes use optimistic revisions (sheet 16 E25).
6. **00 §9 / §14.4:** new routes and shapes of sheet 16 §14: library summary, estimates (registered and unregistered), scans, library jobs (get, events, cancel), repair and repair-broken, live (start, get, open, heartbeat, stop), export and import. Changed: `RepositoryCreateRequest` (`libraryBuildMode`, `stateAllowance`, `scanSpendCapUsd`; response adds `scanJobId`, `scanStartError`), `PATCH /api/repositories/:id` (`stateAllowance`; both fields optional, at least one), `RepositoryView` (`libraryBuildMode`, `stateAllowance`), `VisualizationSummaryView.checkedCount`, `VisualizationDetailView` (`checkedCount`, `reusedHarnessCount`, `newHarnessCount`, `needsUpdateCount`, `globalStyleTrigger`, `activeRepairJob`, `liveAvailable`), `VisualizationComponentView` (`states`, `stateCount`, `changedStateCount`, `harness`). `DELETE` of a repository or visualization returns 409 while a library job of it is active. A timed-out library estimate returns 504 `internal_error` (a second use of 504 next to 00 §14.12's settings test).
7. **00 §10 / §14.6:** three more BullMQ queues with prefix `prvision`: `harness-scans` (job `scan`, id `scan-<id>`, concurrency 1), `harness-repairs` (job `repair`, id `repair-<id>`, concurrency 1), `live-sessions` (job `live`, id `live-<id>`, concurrency `LIVE_MAX_SESSIONS` = 2). Library cancel flag `prvision:library-cancel:<id>`. `VISUALIZATION_MAX_RUNTIME_MS` becomes 90 minutes.
8. **00 §11:** stage order unchanged. `analyzing` ends with library resolution (reuse, D9 pause on new harnesses, whole-library re-check rows); the library save-back runs at the end of `rendering`. Change analysis persists up to 500 candidates (`ANALYSIS_MAX_CANDIDATES`) instead of capping at 12; the representative-component fallback for global stylesheets (08 §5.11.3, 15 §5.5.5) and the non-src console warning are removed.
9. **09 / 15c:** the harness format is multi-state (sheet 16 §7). React harnesses default-export `definePrvisionHarness({ wrapper?, states })` from `../harness-api`; Angular harnesses gain `states`. The React and Angular system prompts are replaced by sheet 16 §7.8.1/§7.8.2 (the verbatim tests read sheet 16; sheet 15 §5.6.5 is superseded).
10. **10 / 15d:** one page per (component, state, side); URL parameter `s=<state>`; page globals `__PRVISION_STATE__`, `__PRVISION_SETTLE__`, `__PRVISION_MARK_STEP_TARGET__`; scripted steps run with Playwright input after the first settle; render concurrency `RENDER_ITEM_CONCURRENCY` = 2 / `RENDER_PAGE_CONCURRENCY` = 4; render stage budget is dynamic (15–60 min); groups are split at 40 items. The single bounded fix-up applies only to harnesses written in the same run.
11. **00 §12:** new frontend route `/library-jobs/:id`.
12. **00 §14.5:** live hosts bind `127.0.0.1`, accept only `GET`/`HEAD` with a `Host` of `127.0.0.1:<port>` or `localhost:<port>`, and send a CSP whose `frame-ancestors` lists only `FRONTEND_URL` and its twin; live origins are never allowed by the API's CORS or Origin guard.
13. **00 §14.8:** `ArtifactStore` gains `componentStateImagePath` and `ensureComponentStateDir`; `QueueService` gains the library and live methods (sheet 16 §6.15). Config constants of sheet 16 §16, including the AI price table `AI_MODEL_PRICES_USD_PER_MTOK`.
