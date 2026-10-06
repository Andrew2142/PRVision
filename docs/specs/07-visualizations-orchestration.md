# 07 — Visualizations API, worker orchestration and workspace preparation

Owner: build agent (wave 3)
Depends on: 00 (contracts, **including Revision 2 §14, which overrides earlier sections**), 01 (standards), 03 (schema/models), 04 (core infrastructure), 05 (settings + AI providers), 06 (repositories + GitHub)
Consumed by: 08, 09, 10, 11 (called by the orchestrator), 13 (visualization screens), 14 (E2E)
Calls (authoritative APIs of the sibling sheets): 08 `ChangeAnalysisService.analyze(ctx)`; 09 `new HarnessGenerationService(ctx, analysis.sourceQueries).generateAll(candidates)` and `repairHarness`; 10 `new RenderService({ repairHarness }).renderAll(ctx, buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles))`; 11 `ImageDiffService.diff`, `StructuralDiffService.compare`, `SummaryService.summarize(ctx, analysis)`.

---

## 1. Purpose

This sheet owns the visualization lifecycle end to end:

1. **HTTP side.** Create a visualization from a GitHub PR, a local branch or the working tree. List, view, read console events incrementally, cancel and delete visualizations.
2. **Worker side.** A single orchestrator, `VisualizationWorkerService`, drives a queued visualization through `preparing → analyzing → generating_harnesses → rendering → diffing → summarizing → completed`. It:
   - calls the step services of sheets 08–11 using the typed contracts those sheets publish;
   - enforces cancellation and a time limit;
   - writes progress console events and every status transition, and `failed_stage` on failure or cancellation;
   - writes the terminal row;
   - keeps the worktrees and the `ChangeAnalysisResult` alive until summarizing ends, then always removes the worktrees in `finally`.
3. **Workspace preparation.** `WorkspacePrepareService` turns a source (PR, branch pair or working tree) into two detached git worktrees (`base`, `head`) under the data dir. It symlinks the user's `node_modules` and copies in the harness templates. It also cleans up afterwards, including the `refs/prvision/*` refs it created.
4. **Recovery.** When the worker starts, it marks visualizations left running by a crash or kill as failed, fails lost queued jobs, and removes orphaned worktrees. While it runs, a periodic sweep fails rows whose BullMQ job no longer exists or has finished, so no row can stay non-terminal forever.

## 2. Scope / Out of scope

In scope:

- `VisualizationsController` (6 routes, 00 §9), route lines and composition.
- DTOs: `visualization-create.dto.ts`, `visualization-list-query.dto.ts`, `visualization-console-query.dto.ts`, and view DTOs with mappers.
- `VisualizationsService` (HTTP-facing; returns `ApiResponse`).
- `VisualizationConsoleService`: append and list console events, with central secret redaction.
- The visualization state machine module: allowed transitions and guarded compare-and-set updates.
- `VisualizationWorkerService`: job processor, orchestrator and boot recovery.
- `WorkspacePrepareService`: prepare and cleanup.
- The `worker.ts` processor line and the boot-recovery call.
- Constants.
- Tests in `tests/backend/visualizations/`.

Out of scope:

- Sheet 04 infrastructure:
  - BullMQ wiring;
  - the cancel flag mechanics and polling (`QueueService`);
  - `GitClient`, `ArtifactStore`, `PipelineStepError`, `QueryHandler`;
  - the logger and graceful shutdown.

  §3.1 lists exactly what this sheet uses and the small additions it requests.
- The internals of the step services:
  - change analysis (08);
  - harness generation and AI usage recording (09);
  - rendering (10);
  - image diff, structural diff and the summary (11).

  §5.9.2 fixes how the orchestrator calls them.
- Settings and AI provider construction (05).
- Harness template contents (10). This sheet only copies the folder.
- Frontend (13).

## 3. Dependencies

| Dependency | Sheet | Used for |
|---|---|---|
| Tables `visualizations`, `visualization_components`, `visualization_console_events`, `repositories`; models `VisualizationModel`, `VisualizationComponentModel`, `VisualizationConsoleEventModel`, `RepositoryModel`; `schema.*` | 03 | Persistence. Relevant CHECKs: `completed_at` is set only for terminal statuses; `changed_count ≤ component_count`. |
| Enums `VisualizationStatus`, `TERMINAL_VISUALIZATION_STATUSES`, `ACTIVE_VISUALIZATION_STATUSES`, `isTerminalVisualizationStatus`, `VisualizationSourceType`, `ComponentRenderStatus`, `ConsoleLevel`, `Table`, `DeletionMode`, `ErrorReason` | 03/04 | |
| `QueryHandler` (with `Where` and ordered `selectMany`), `ModelHandler.hydrate`, `DrizzleDb` (incl. static `transaction`), `ResponseHandler`, `Validation` (discriminated tuple), `IdParamDTO`, `PaginationQueryDTO`, `resolvePageRequest`, `PagedResult`, `toIsoString`/`toIsoStringOrNull`, `createLogger`, `redactSecrets`, `resolveInside`/`isPathInside`/`normalizeRepoRelativePath` | 04 | |
| `QueueService`, `VisualizationJob`, `VisualizationJobProcessor` (signature per 00 §14.6), `GitClient`, `GitCommandError`, `GitAuthHeader`, `ArtifactStore`, `PipelineStepError`, `isPipelineStepError`, `AuthContext.runAsLocalUser` | 04 | See §3.1. |
| `SettingsStore.readAiSettings()`, `SettingsStore.readGithubToken()` (the only non-HTTP settings reader, 00 §14.8); `AiProviderFactory.readiness(settings)`, `AiProviderFactory.create(settings)` (pure, 05 §5.9); `AiProviderError`; `ResolvedAiSettings`, `SecretRead` | 05 | AI readiness at create; provider and settings in the worker from **one** settings read; GitHub token. |
| `GitHubClient.fromToken(token).getPullRequest`, `GitHubClient.gitAuthHeaders(token)`, `GitHubClientError`, `githubErrorToApiResponse`, `parseGithubRemoteUrl` | 06 | PR resolution at create and in prepare; fetch auth; remote matching. |
| `ChangeAnalysisService` (08), `HarnessGenerationService` (09), `RenderService` + `RenderComponentInput` + `RepairHarnessFn` + `buildRenderInputs` (10 §5.13.1), `ImageDiffService`, `StructuralDiffService`, `SummaryService` (11 §5.1) | 08–11 | §5.9.2. |
| Types `PreparedWorkspace`, `PipelineContext`, `ComponentCandidate`, `ChangeAnalysisResult` (+ `sourceQueries: ComponentSourceQueries`, 00 §14.7), `HarnessGenerationResult`, `ComponentRenderResult`, `AiProvider` (00 §8); `PipelineStepError` (`types/pipeline-errors.ts`, 00 §14.7); `HarnessGenerationBatchResult`, `HarnessRenderError`, `HarnessRepairOutcome` (09 §5.1); `SummaryOutcome` (11 §5.4) | 00/04/09/10/11 | |

### 3.1 Sheet-04 surface used

| API (04) | How 07 uses it |
|---|---|
| `QueueService.enqueueVisualization(id): Promise<{ jobId; alreadyQueued }>` | Called after the create transaction commits. Idempotent: jobId `viz-<id>` (00 §10); a second call for the same id returns `alreadyQueued: true` and adds nothing. |
| `QueueService.visualizationJobId(id)` | `viz-<id>`, written to `job_id` inside the create transaction. |
| `QueueService.removeQueuedVisualization(id): Promise<boolean>` | Cancel of a queued visualization. `true` means the job was waiting/delayed/prioritized and is gone; it will never run. |
| `QueueService.getVisualizationJobState(id): Promise<string \| "missing">` | Cancel fallback, boot recovery and the periodic sweep (§5.10). |
| `QueueService.requestCancel(id)`, `isCancelRequested(id)`, `clearCancel(id)` | The cancel flag `prvision:cancel:<id>` (00 §10). 04 polls it every `CANCEL_POLL_INTERVAL_MS` (1 s) and aborts the job signal. |
| Job processor (00 §14.6) | `worker.ts` injects a processor that receives `{ visualizationId, jobId, signal }`. `signal` aborts on user cancel (Redis flag) or worker shutdown with **`signal.reason === "cancelled" \| "shutdown"`** (a string). Worker options: `concurrency: 1`, `lockDuration: 300000`, `maxStalledCount: 0` (a stalled job fails and is never re-run). |
| `GitClient` (stateless; the repo path is the first argument) | See the call list below. |
| `GitCommandError { code: GitErrorCode; subcommand; exitCode; stderr }` | Mapped to `PipelineStepError` messages (§5.13). `stderr` is already redacted by 04. |
| `ArtifactStore` (instance; method names as defined in 04 §9.8) | `worktreesRoot()`, `visualizationWorktreeRoot(id)`, `worktreeDir(id, side)`, `removeVisualizationWorktreeRoot(id)` (guarded rm), `removeVisualization(id)` (00 §14.8; never the deprecated alias `removeVisualizationArtifacts`, 00 §14.12), `toPublicUrl(rel)`, `ensureDir(abs)`, `dataDir`. |
| `PipelineStepError(stage, userMessage, options?: { cause?: unknown; detail?: string; code?: string })` (00 §14.12; `stage` is a non-terminal `VisualizationStatus`, always positional) | The only fatal error that pipeline services throw. This sheet passes `{ cause }`, plus `code` (the `GitErrorCode`) when a git failure is the cause (§5.13.5); the `GitCommandError` itself travels on `cause`. |
| `CHILD_PROCESS_BASE_ENV` | Not used directly: 07 spawns nothing itself. Every git child gets 04's environment built from `CHILD_PROCESS_BASE_ENV` (02 §6.7, 00 §14.5); Claude Code gets 05's env built from `AI_CLAUDE_CODE_PARENT_ENV` (00 §14.12). |

`GitClient` calls used by this sheet. Names and parameters are exactly those of 04 §9.5; 07 passes call options only to `fetch`, every other call is bounded by 04's per-method timeout (30 s default, 180 s for `worktree add/remove`):

- `topLevel(path)`.
- `revParse(cwd, rev)`: 04 runs `rev-parse --verify --quiet --end-of-options <rev>^{commit}`.
- `hasCommit(cwd, sha)`.
- `mergeBase(cwd, a, b)`: fails with code `no_merge_base` when there is none.
- `fetch(cwd, { remote, refspecs, auth? }, { signal, timeoutMs })`:
  - `credential.helper=` is disabled;
  - the `auth` header travels in `GIT_CONFIG_*` env, never argv;
  - refspec destinations must start with `refs/prvision/`.
- `worktreeAdd(repoPath, dir, sha)`.
- `worktreeRemove(repoPath, dir)`: idempotent, double force.
- `worktreePrune(repoPath)`.
- `worktreeList(repoPath)`: cleanup verification in tests.
- `diffBinaryHead(cwd)`.
- `applyPatch(cwd, patch)`.
- `lsUntracked(cwd)`.
- `isDirty(cwd)`.
- `currentBranch(cwd)`.
- `remoteUrl(cwd, remote)`.
- `deleteRef(cwd, ref)` (00 §14.8, 04 §9.5): `update-ref -d --end-of-options <ref>`, `ref` must start with `refs/prvision/`, a missing ref is success.

Every call runs with `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `GIT_TERMINAL_PROMPT=0`, `GIT_LFS_SKIP_SMUDGE=1`, refs validated by `assertSafeRef` and placed after `--end-of-options`, and stderr redacted.

Also provided by 04 §9.5 as 00 §14.8 requires: `--no-write-fetch-head` on `fetch`; `-c diff.noprefix=false -c diff.mnemonicPrefix=false --ignore-submodules=all` on `diffBinaryHead`; `textconv`/LFS/credential helpers disabled.

## 4. File inventory

| File | Action | Responsibility |
|---|---|---|
| `backend/src/controllers/visualizations-controller.ts` | create | `VisualizationsController`: `create`, `list`, `get`, `console`, `cancel`, `remove`. |
| `backend/src/controllers/index.ts` | modify | Export. |
| `backend/src/dtos/visualizations/visualization-create.dto.ts` | create | `VisualizationCreateDTO`, `GitBranchNameConstraint`, `VisualizationSourceFieldsConstraint`, `isValidGitBranchName`, `sourceFieldErrors`. |
| `backend/src/dtos/visualizations/visualization-list-query.dto.ts` | create | `VisualizationListQueryDTO extends PaginationQueryDTO`. |
| `backend/src/dtos/visualizations/visualization-console-query.dto.ts` | create | `VisualizationConsoleQueryDTO`. |
| `backend/src/dtos/visualizations/visualization-view.dto.ts` | create | `VisualizationSummaryView`, `VisualizationDetailView`, `CreateVisualizationResponse`, `CancelVisualizationResponse`, plus mappers. |
| `backend/src/dtos/visualizations/visualization-component-view.dto.ts` | create | `VisualizationComponentView` + `toVisualizationComponentView`. |
| `backend/src/dtos/visualizations/console-event-view.dto.ts` | create | `ConsoleEventView` + `toConsoleEventView`. |
| `backend/src/dtos/visualizations/index.ts`, `backend/src/dtos/index.ts` | create / modify | Barrels. |
| `backend/src/services/visualizations/visualizations-service.ts` | create | `VisualizationsService`. |
| `backend/src/services/visualizations/visualization-console-service.ts` | create | `VisualizationConsoleService`, `sanitizeConsoleMessage`. |
| `backend/src/services/visualizations/visualization-state-machine.ts` | create (new in module map) | `VISUALIZATION_TRANSITIONS`, `canTransition`, `transitionVisualization`, `VisualizationTransitionError`. |
| `backend/src/services/visualizations/pipeline/visualization-worker-service.ts` | create | `VisualizationWorkerService` (`run`, `recoverOnBoot`, `startRecoverySweep`), step factories, `VisualizationTimeoutError`, `VisualizationRowConflictError`, `classifyRunFailure`, `toRepairHarnessFn`. (`buildRenderInputs` is imported from 10's `render-service.ts`, not redeclared.) |
| `backend/src/services/visualizations/pipeline/workspace-prepare-service.ts` | create | `WorkspacePrepareService`, `compareDependencies`, `prRef`, `prBaseRef`, `gitErrorSummary`, `isSafeRelativePath`, `ensureRealDir`. |
| `backend/src/services/visualizations/index.ts`, `.../pipeline/index.ts` | create | Barrels. 11 adds its own exports to the pipeline barrel. |
| `backend/src/services/index.ts` | modify | Re-export visualizations. |
| `backend/src/config-consts/queue.config.ts` | — (owned by 02) | No change: the §5.12 constants are already in 02 §6.7; this sheet imports them. |
| `backend/src/config-consts/pagination.config.ts` | — (owned by 02) | No change: `CONSOLE_PAGE_LIMIT_MAX = 500` is already in 02 §6.7. |
| `backend/src/routes/index.ts`, `backend/src/app.ts` | modify | Six route lines; construct the controller in `buildRouteDependencies`. |
| `backend/src/worker.ts` | modify (04 owns) | Real processor, the `recoverOnBoot()` call and the recovery sweep start/stop (§5.6). |
| `tests/backend/visualizations/*.test.ts` | create | §9. |
| `tests/backend/visualizations/helpers/fakes.ts` | create | Recording QueryHandler, fake GitClient, `QueueService` statics patched with `patchStaticMethod`, fake step factories, console recorder. |
| `tests/backend/visualizations/helpers/temp-git-repo.ts` | create | Real throw-away git repo for integration tests. Uses `execFileSync("git")` in test code only; application code never spawns git directly. |

## 5. Detailed design

### 5.1 State machine

File: `services/visualizations/visualization-state-machine.ts`.

#### 5.1.1 Allowed transitions

| From → To | Writer |
|---|---|
| (insert) → `queued` | API create |
| `queued` → `preparing` | worker |
| `queued` → `cancelled` | API cancel (job removed before start); worker (flag seen before start) |
| `queued` → `failed` | API create (enqueue failed); worker (repository gone, AI not configured); boot recovery / sweep (job lost) |
| `preparing` → `analyzing` | worker |
| `analyzing` → `generating_harnesses` | worker (also with zero candidates: every later stage runs and finds nothing to do, and 11 writes its fixed summary) |
| `generating_harnesses` → `rendering` | worker |
| `rendering` → `diffing` | worker |
| `diffing` → `summarizing` | worker |
| `summarizing` → `completed` | worker |
| any of `preparing` … `summarizing` → `failed` | worker; boot recovery / sweep |
| any of `preparing` … `summarizing` → `cancelled` | worker |
| `completed`, `failed`, `cancelled` → anything | **never**; cancel gets `409 already_terminal`, delete is allowed |

There is no shortcut to `completed`: the run always passes `summarizing`, so 11 owns `summary_markdown` in every completed run (including its fixed "no changed files" / "no components" texts). The API never writes a running status. Its only writes are the insert, `queued → cancelled` and `queued → failed`. Every write is a guarded compare-and-set on the expected current status, so when two writers race, the loser fails cleanly instead of overwriting.

`failed_stage` (00 §14.3) is stamped by `transitionVisualization` itself: on every transition to `failed` or `cancelled` it writes `failed_stage = from` (the status that was active, including `queued`). No other writer sets it; it is never cleared because terminal rows never transition again.

```ts
import { isTerminalVisualizationStatus, Table, VisualizationStatus } from "../../enums";
import type { QueryHandler } from "../../utilities";

export const VISUALIZATION_TRANSITIONS: Readonly<Record<VisualizationStatus, readonly VisualizationStatus[]>> = {
  queued: ["preparing", "cancelled", "failed"],
  preparing: ["analyzing", "failed", "cancelled"],
  analyzing: ["generating_harnesses", "failed", "cancelled"],
  generating_harnesses: ["rendering", "failed", "cancelled"],
  rendering: ["diffing", "failed", "cancelled"],
  diffing: ["summarizing", "failed", "cancelled"],
  summarizing: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: VisualizationStatus, to: VisualizationStatus): boolean {
  return VISUALIZATION_TRANSITIONS[from].includes(to);
}

/**
 * Columns a transition may write besides status / started_at / completed_at / failed_stage.
 * ai_usage is NOT here (only 09's AiUsageRecorder writes it, 00 §14.7); summary_markdown is NOT here (11 writes it).
 */
export interface VisualizationTransitionFields {
  errorMessage?: string | null;
  aiProvider?: "anthropic_api" | "claude_code";
  aiModel?: string;
  baseSha?: string | null;
  headSha?: string | null;
  changedCount?: number;                // component_count is written only by 08 (00 §14.3)
}

export class VisualizationTransitionError extends Error {
  constructor(readonly from: VisualizationStatus, readonly to: VisualizationStatus) {
    super(`Illegal visualization transition ${from} → ${to}`);
    this.name = "VisualizationTransitionError";
  }
}

/**
 * Guarded compare-and-set: UPDATE … WHERE id = $id AND status = $from AND is_deleted = false.
 * Returns false when no row matched (someone else moved it). Stamps started_at on → preparing,
 * completed_at on → terminal, and failed_stage = from on → failed | cancelled. updated_at is stamped by QueryHandler.
 */
export async function transitionVisualization(
  queryHandler: Pick<QueryHandler, "update">,
  input: { visualizationId: number; from: VisualizationStatus; to: VisualizationStatus; fields?: VisualizationTransitionFields; now: Date },
): Promise<boolean> {
  if (!canTransition(input.from, input.to)) throw new VisualizationTransitionError(input.from, input.to);

  const values: Record<string, unknown> = { ...(input.fields ?? {}), status: input.to };
  if (input.to === VisualizationStatus.PREPARING) values.startedAt = input.now;
  if (isTerminalVisualizationStatus(input.to)) values.completedAt = input.now;
  if (input.to === VisualizationStatus.FAILED || input.to === VisualizationStatus.CANCELLED) values.failedStage = input.from;

  const result = await queryHandler.update(values,
    { id: input.visualizationId, status: input.from, isDeleted: false }, Table.VISUALIZATIONS);
  if (result.status === 200) return true;
  if (result.status === 404) return false;
  throw new Error(`Visualization ${input.visualizationId} ${input.from}→${input.to} update failed (${result.status})`);
}
```

#### 5.1.2 Exact DB writes per transition

| Transition | Columns written |
|---|---|
| insert `queued` (API; one transaction together with the `job_id` update) | `repository_id, source_type, pr_number, title, base_ref, head_ref, status='queued', ai_provider, ai_model` (provisional, from readiness), `component_count=0, changed_count=0`; then `job_id='viz-<id>'` |
| `queued → preparing` | `status, started_at=now, ai_provider, ai_model` (snapshot of the settings read for this run), `error_message=null` |
| `queued → cancelled` | `status, completed_at=now, failed_stage='queued'` |
| `queued → failed` | `status, completed_at=now, failed_stage='queued', error_message` |
| `preparing → analyzing` | `status, base_sha` (the merge-base for `github_pr` and `local_branch`, 00 §14.7; `HEAD` for `working_tree`), `head_sha` (null for working_tree) |
| `analyzing → generating_harnesses` | `status` (08 has already written `component_count` = all inserted rows, 00 §14.3) |
| `generating_harnesses → rendering`, `rendering → diffing`, `diffing → summarizing` | `status` |
| `summarizing → completed` | `status, completed_at, changed_count` (aggregate, §5.9.5), `error_message=null`. `summary_markdown` was already written by 11. |
| `<running> → failed` (worker) | `status, completed_at, failed_stage=<running>, error_message, changed_count` (aggregate) |
| `<running> → cancelled` (worker) | `status, completed_at, failed_stage=<running>, changed_count` (aggregate), `error_message=null` |
| `<running> → failed` (boot recovery / sweep) | `status, completed_at, failed_stage=<running>, error_message` |

Column ownership: `ai_usage` — 09's `AiUsageRecorder` only (09 and 11 both use it; the orchestrator never writes it, so partial usage survives failures and cancellations). `summary_markdown` — 11 only. `component_count` — 08 writes it after analysis (all inserted rows, 00 §14.3); `changed_count` — only the orchestrator, at every terminal write (11 never writes it, 11 §2). The terminal write recomputes `changed_count` from the component rows and is its final value; it reads `component_count` only to cap `changed_count` and never writes it. Per-component columns — the step that owns them (08 insert incl. `change_reason`/`skip_reason`, 09 harness and pre-render failures, 10 render, 11 diff/summary).

Before every terminal write, by the worker or by recovery, any component still at `render_status = 'pending'` is set to `skipped` (§5.9.5).

### 5.2 DTOs

#### 5.2.1 `visualization-create.dto.ts`

This is the request body, exactly 00 §14.4 `VisualizationCreateRequest` (no `title` field; the title is always derived server-side):

| Field | github_pr | local_branch | working_tree |
|---|---|---|---|
| `repositoryId` (int 1…2³¹−1) | required | required | required |
| `sourceType` | `"github_pr"` | `"local_branch"` | `"working_tree"` |
| `prNumber` (int 1…2³¹−1) | required | forbidden | forbidden |
| `headRef` | forbidden | required | forbidden |
| `baseRef` | optional, format-checked, **ignored** (the PR's base is used, 00 §14.4) | optional (default: the repository's `defaultBranch`) | forbidden |

"Forbidden" means present (`!== undefined`, including `null`) → 400 `validation_failed`. Unknown keys (e.g. a stale `title`, `headBranch`) → 400 through `forbidNonWhitelisted`.

Ref names are validated twice:

1. **Format, in the DTO** (`isValidGitBranchName`): the rules of `git check-ref-format --branch` intersected with 04's `SAFE_REF` charset `[A-Za-z0-9._/+-]`. This blocks option injection (leading `-`), revision syntax (`..`, `@{`, `^`, `~`, `:`), and anything 04's `assertSafeRef` would reject later in the worker. Names with other characters (`#`, non-ASCII) are unsupported in the prototype and get a clear 400.
2. **Existence, in the service** (`git rev-parse --verify --end-of-options refs/heads/<name>^{commit}` through 04's `revParse`), so the worker never starts on a branch that does not exist.

The stored ref is always passed to git as `refs/heads/<name>` after `--end-of-options` (04), never as a bare argument.

```ts
import { Transform } from "class-transformer";
import {
  IsIn, IsInt, IsString, Max, Min, Validate, ValidateIf,
  ValidatorConstraint, type ValidationArguments, type ValidatorConstraintInterface,
} from "class-validator";
import { VisualizationSourceType } from "../../enums";

/**
 * `git check-ref-format --branch` rules ∩ 04's SAFE_REF charset. Pure; also used by 07's prepare step to
 * check the base branch name GitHub returns for a PR.
 */
export function isValidGitBranchName(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) return false;
  if (!/^[A-Za-z0-9._/+-]+$/.test(value)) return false;                         // no space, ~ ^ : ? * [ \ @ or control chars
  if (value.startsWith("-") || value.startsWith("/") || value.endsWith("/") || value.endsWith(".")) return false;
  if (value.includes("..") || value.includes("//") || value === "HEAD") return false;
  return value.split("/").every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"));
}

@ValidatorConstraint({ name: "gitBranchName", async: false })
export class GitBranchNameConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean { return isValidGitBranchName(value); }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} is not a supported git branch name (letters, digits, . _ / + - only; no "..", no leading "-")`;
  }
}

/** Cross-field rules per source type (ValidateIf alone cannot forbid fields). Exported for tests. */
export function sourceFieldErrors(dto: Partial<VisualizationCreateDTO>): string[] {
  const errors: string[] = [];
  const present = (v: unknown): boolean => v !== undefined;
  switch (dto.sourceType) {
    case VisualizationSourceType.GITHUB_PR:
      if (present(dto.headRef)) errors.push("headRef is only allowed when sourceType is local_branch");
      break;
    case VisualizationSourceType.LOCAL_BRANCH:
      if (present(dto.prNumber)) errors.push("prNumber is only allowed when sourceType is github_pr");
      if (present(dto.baseRef) && dto.baseRef === dto.headRef) errors.push("baseRef and headRef must be different");
      break;
    case VisualizationSourceType.WORKING_TREE:
      if (present(dto.prNumber) || present(dto.headRef) || present(dto.baseRef)) {
        errors.push("prNumber, headRef and baseRef cannot be set when sourceType is working_tree");
      }
      break;
    default:
      break; // @IsIn reports an invalid sourceType
  }
  return errors;
}

@ValidatorConstraint({ name: "visualizationSourceFields", async: false })
export class VisualizationSourceFieldsConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    return sourceFieldErrors(args.object as Partial<VisualizationCreateDTO>).length === 0;
  }
  defaultMessage(args: ValidationArguments): string {
    return sourceFieldErrors(args.object as Partial<VisualizationCreateDTO>)[0] ?? "Invalid source fields";
  }
}

const trim = ({ value }: { value: unknown }): unknown => (typeof value === "string" ? value.trim() : value);

export class VisualizationCreateDTO {
  @IsInt() @Min(1) @Max(2_147_483_647)
  repositoryId!: number;

  @IsIn(Object.values(VisualizationSourceType))
  @Validate(VisualizationSourceFieldsConstraint)
  sourceType!: VisualizationSourceType;

  @ValidateIf((o: VisualizationCreateDTO) => o.sourceType === VisualizationSourceType.GITHUB_PR || o.prNumber !== undefined)
  @IsInt() @Min(1) @Max(2_147_483_647)
  prNumber?: number;

  @ValidateIf((o: VisualizationCreateDTO) => o.sourceType === VisualizationSourceType.LOCAL_BRANCH || o.headRef !== undefined)
  @Transform(trim) @IsString() @Validate(GitBranchNameConstraint)
  headRef?: string;

  /** Not @IsOptional: that would let `null` through. Validated whenever present. */
  @ValidateIf((o: VisualizationCreateDTO) => o.baseRef !== undefined)
  @Transform(trim) @IsString() @Validate(GitBranchNameConstraint)
  baseRef?: string;
}
```

Body numbers are not coerced, because 04's `Validation` has no implicit conversion. `"12"` for `repositoryId` is therefore a 400. An explicit `null` for any optional field fails (`ValidateIf` sees `null !== undefined` and runs `IsInt`/`IsString`).

#### 5.2.2 `visualization-list-query.dto.ts`

`GET /api/visualizations?repositoryId=&status=queued,rendering&page=&pageSize=` (00 §14.4). `status` is a comma-separated list; every item must be a `VisualizationStatus`; duplicates are removed; at most 10 items (there are 10 statuses).

```ts
import { Transform, Type } from "class-transformer";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

/**
 * "queued, rendering,,queued" → ["queued", "rendering"]. A repeated key (?status=a&status=b), which Express
 * parses as a string array, is joined first so both forms behave the same. Anything else passes through to fail.
 */
export function parseStatusList(value: unknown): unknown {
  const joined = Array.isArray(value) && value.every((v): v is string => typeof v === "string") ? value.join(",") : value;
  if (typeof joined !== "string") return joined;
  return [...new Set(joined.split(",").map((part) => part.trim()).filter((part) => part !== ""))];
}

export class VisualizationListQueryDTO extends PaginationQueryDTO {     // page, pageSize from 04
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(2_147_483_647)
  repositoryId?: number;

  @IsOptional() @Transform(({ value }: { value: unknown }) => parseStatusList(value))
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10) @IsIn(Object.values(VisualizationStatus), { each: true })
  status?: VisualizationStatus[];
}
```

An empty value (`?status=`) parses to `[]` and fails `@ArrayMinSize(1)`; the frontend omits the key instead (13).

#### 5.2.3 `visualization-console-query.dto.ts`

`GET /api/visualizations/:id/console?afterId=&limit=` → `ConsoleEventView[]`, oldest first, `afterId` exclusive, `limit` default and max 500 (00 §14.4).

```ts
export class VisualizationConsoleQueryDTO {
  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(2_147_483_647)
  afterId?: number;                                   // default 0 → from the beginning; exclusive

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(CONSOLE_PAGE_LIMIT_MAX)
  limit?: number;                                     // default and max 500
}
```

#### 5.2.4 View DTOs and mappers

The shapes are exactly those in 00 §9 plus 00 §14.4 (`failedStage` on the detail view; `changeReason`, `skipReason` on the component view; `CancelVisualizationResponse`). Mapping follows 03 §9.5.

```ts
// visualization-view.dto.ts
export interface CreateVisualizationResponse { visualizationId: number; jobId: string; }
export interface CancelVisualizationResponse { id: number; status: "cancelled" | "cancel_requested"; }   // 00 §14.4
export interface DeleteVisualizationResponse { id: number; }

export function toVisualizationSummaryView(v: VisualizationModel, repositoryName: string): VisualizationSummaryView {
  return {
    id: v.id, repositoryId: v.repositoryId, repositoryName, sourceType: v.sourceType, prNumber: v.prNumber,
    title: v.title, baseRef: v.baseRef, headRef: v.headRef, status: v.status,
    componentCount: v.componentCount, changedCount: v.changedCount,
    createdAt: toIsoString(v.createdAt), completedAt: toIsoStringOrNull(v.completedAt),
  };
}

export function toVisualizationDetailView(
  v: VisualizationModel, repositoryName: string, components: VisualizationComponentView[],
): VisualizationDetailView {
  return {
    ...toVisualizationSummaryView(v, repositoryName),
    baseSha: v.baseSha, headSha: v.headSha, errorMessage: v.errorMessage, summaryMarkdown: v.summaryMarkdown,
    failedStage: v.failedStage,                                    // null unless failed/cancelled (00 §14.4)
    aiProvider: v.aiProvider, aiModel: v.aiModel,
    aiUsage: v.aiUsage ? { inputTokens: v.aiUsage.inputTokens, outputTokens: v.aiUsage.outputTokens, calls: v.aiUsage.calls } : null,
    startedAt: toIsoStringOrNull(v.startedAt),
    components,
  };
}

// visualization-component-view.dto.ts
export function toVisualizationComponentView(
  c: VisualizationComponentModel, toPublicUrl: (relativePath: string | null) => string | null,
): VisualizationComponentView {
  return {
    id: c.id, filePath: c.filePath, exportName: c.exportName, displayName: c.displayName,
    changeKind: c.changeKind, renderStatus: c.renderStatus, visualChange: c.visualChange, risk: c.risk, rank: c.rank,
    baseImageUrl: toPublicUrl(c.baseImagePath), headImageUrl: toPublicUrl(c.headImagePath), diffImageUrl: toPublicUrl(c.diffImagePath),
    imageWidth: c.imageWidth, imageHeight: c.imageHeight,
    diffPixelRatio: c.diffPixelRatio !== null && Number.isFinite(c.diffPixelRatio) ? c.diffPixelRatio : null,
    codeDiff: c.codeDiff, structuralDiff: c.structuralDiff, aiNote: c.aiNote,
    harnessSource: c.harnessSource, harnessNotes: c.harnessNotes, baseError: c.baseError, headError: c.headError,
    changeReason: c.changeReason, skipReason: c.skipReason,        // 00 §14.4
  };
}

// console-event-view.dto.ts
export function toConsoleEventView(e: VisualizationConsoleEventModel): ConsoleEventView {
  return { id: e.id, level: e.level, stage: e.stage, message: e.message, createdAt: toIsoString(e.createdAt) };
}
```

`mockedModules` and `jobId` are not in the views (00 §9). `aiUsage` maps only `{ inputTokens, outputTokens, calls }` (a stored `cacheReadInputTokens` key is dropped). Model getters `failedStage`, `changeReason`, `skipReason` come from the regenerated models once 03 adds the columns (00 §14.3).

### 5.3 Controller — `controllers/visualizations-controller.ts`

```ts
import type { Request, Response } from "express";
import { IdParamDTO, VisualizationConsoleQueryDTO, VisualizationCreateDTO, VisualizationListQueryDTO } from "../dtos";
import { VisualizationModel } from "../models";
import { VisualizationsService } from "../services";
import { type ApiResponse, createLogger, ResponseHandler, Validation } from "../utilities";

type IdReadResult = { ok: true; id: number } | { ok: false; response: ApiResponse };

/** HTTP transport for visualizations. Business rules live in VisualizationsService. */
export class VisualizationsController {
  private readonly validation = new Validation();
  private readonly responseHandler = new ResponseHandler();
  private readonly log = createLogger("visualizations-controller");

  /** POST /api/visualizations — validate, create the queued row, enqueue; 202. */
  async create(req: Request, res: Response): Promise<Response> {
    try {
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData(req.body), VisualizationCreateDTO);
      if (!isValid) return this.responseHandler.controllerResponse(errorResponse, res);

      // Deliberate deviation from DTOMapper: the DTO is a command (headRef/baseRef are resolved into
      // base_ref/head_ref/title by the service, and baseRef is ignored for github_pr), not a row, so the
      // validated DTO is passed directly, as 05's SettingsService.update(dto) does.
      const serviceResponse = await new VisualizationsService().create(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "create", res);
    }
  }

  /** GET /api/visualizations — paged list. */
  async list(req: Request, res: Response): Promise<Response> {
    try {
      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData({ ...req.query }), VisualizationListQueryDTO);
      if (!isValid) return this.responseHandler.controllerResponse(errorResponse, res);

      const serviceResponse = await new VisualizationsService().list(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "list", res);
    }
  }

  /** GET /api/visualizations/:id — detail with components. */
  async get(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).get();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "get", res);
    }
  }

  /** GET /api/visualizations/:id/console?afterId&limit — incremental console events. */
  async console(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const [isValid, errorResponse, dto] = await this.validation.validate(
        this.validation.compileJsonData({ ...req.query }), VisualizationConsoleQueryDTO);
      if (!isValid) return this.responseHandler.controllerResponse(errorResponse, res);

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).console(dto);
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "console", res);
    }
  }

  /** POST /api/visualizations/:id/cancel — 200 cancelled, 202 cancel_requested, 409 already_terminal. */
  async cancel(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).cancel();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "cancel", res);
    }
  }

  /** DELETE /api/visualizations/:id — 200 { id }; 409 conflict while non-terminal. */
  async remove(req: Request, res: Response): Promise<Response> {
    try {
      const idResult = await this.readId(req);
      if (!idResult.ok) return this.responseHandler.controllerResponse(idResult.response, res);

      const serviceResponse = await new VisualizationsService(this.modelWithId(idResult.id)).remove();
      return this.responseHandler.controllerResponse(serviceResponse, res);
    } catch (error) {
      return this.internalError(error, "remove", res);
    }
  }

  private async readId(req: Request): Promise<IdReadResult> {
    const [isValid, errorResponse, dto] = await this.validation.validate(this.validation.compileJsonData(req.params), IdParamDTO);
    if (!isValid) return { ok: false, response: errorResponse };
    return { ok: true, id: dto.id };
  }

  private modelWithId(id: number): VisualizationModel {
    const model = new VisualizationModel();
    model.setId(id);
    return model;
  }

  private internalError(error: unknown, action: string, res: Response): Response {
    this.log.error({ event: "visualizations.controller.unhandled", err: error, action }, "Unhandled visualizations controller error");
    return this.responseHandler.controllerResponse(this.responseHandler.internalError(), res);
  }
}
```

Routes go in `routes/index.ts`, in 04's marked section, with `requireLocal` as defined by 04:

```ts
app.post("/api/visualizations", requireLocal, visualizationsController.create.bind(visualizationsController));
app.get("/api/visualizations", requireLocal, visualizationsController.list.bind(visualizationsController));
app.get("/api/visualizations/:id", requireLocal, visualizationsController.get.bind(visualizationsController));
app.get("/api/visualizations/:id/console", requireLocal, visualizationsController.console.bind(visualizationsController));
app.post("/api/visualizations/:id/cancel", requireLocal, visualizationsController.cancel.bind(visualizationsController));
app.delete("/api/visualizations/:id", requireLocal, visualizationsController.remove.bind(visualizationsController));
```

### 5.4 `VisualizationsService`

```ts
export interface VisualizationsServiceDependencies {
  queryHandler: QueryHandler;
  db: Database;                                                              // DrizzleDb.getInstance(); list/loadVisible join only
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;       // DrizzleDb.transaction
  git: Pick<GitClient, "revParse" | "isDirty" | "currentBranch">;
  aiReadiness: () => Promise<AiReadiness>;                                   // default: AiProviderFactory.readiness(await new SettingsStore().readAiSettings())
  readGithubToken: () => Promise<SecretRead>;                                // new SettingsStore().readGithubToken()
  githubClientFactory: (token: string) => Pick<GitHubClient, "getPullRequest">;
  queue: Pick<typeof QueueService,
    "enqueueVisualization" | "visualizationJobId" | "removeQueuedVisualization" | "getVisualizationJobState" | "requestCancel" | "clearCancel">;
  artifacts: Pick<ArtifactStore, "toPublicUrl" | "removeVisualization">;
  consoleFactory: (visualizationId: number) => Pick<VisualizationConsoleService, "info" | "warn" | "error">;
  now: () => Date;
}

export class VisualizationsService {
  private readonly deps: VisualizationsServiceDependencies;
  private readonly log = createLogger("visualizations-service");

  constructor(
    private readonly visualizationPayload: VisualizationModel = new VisualizationModel(),
    deps: Partial<VisualizationsServiceDependencies> = {},
  ) {
    this.deps = { ...defaultVisualizationsDependencies(), ...deps };
  }

  create(dto: VisualizationCreateDTO): Promise<ApiResponse>;
  list(query: VisualizationListQueryDTO): Promise<ApiResponse>;
  get(): Promise<ApiResponse>;
  console(query: VisualizationConsoleQueryDTO): Promise<ApiResponse>;
  cancel(): Promise<ApiResponse>;
  remove(): Promise<ApiResponse>;
}
```

Every public method wraps its body in `try/catch`. The catch logs `{ err }` and returns `{ status: 500, error: "Internal server error", error_reason: "internal_error" }`; exception messages never reach the client.

The shared private helper `loadVisible(id)` runs the list join (§5.4.2) filtered by `v.id = id` with limit 1. It returns `{ visualization: VisualizationModel; repositoryName: string } | null`. Deleted visualizations, and visualizations of deleted repositories, are hidden (03 §9.7).

#### 5.4.1 `create(dto)`

```ts
type ResolvedSource = { baseRef: string; headRef: string; prNumber: number | null; title: string };
type SourceResolution = { ok: true; source: ResolvedSource } | { ok: false; response: ApiResponse };
```

1. **Repository.** Run `repo = await queryHandler.validateAndSelect(RepositoryModel, { id: dto.repositoryId }, Table.REPOSITORIES)`. If it is `null`, return `404 { error: "Repository not found", error_reason: "not_found" }`.
2. **AI readiness.** Run `readiness = await deps.aiReadiness()`. This makes no network or model call (05 §5.9). If `!readiness.ready`, return `400 { error: readiness.message, error_reason: "ai_not_configured" }`.
3. **Source resolution** via `resolveSource(dto, repo): Promise<SourceResolution>`:
   - **github_pr** (`dto.baseRef`, if sent, is ignored: the PR's base is authoritative, 00 §14.4)
     1. If `repo.githubOwner` or `repo.githubRepo` is null, return `400 no_github_remote` with "This repository has no github.com remote, so pull requests cannot be visualized."
     2. Read `secret = await deps.readGithubToken()`.
        - `absent`: return `400 github_token_missing` with "Add a GitHub token in Settings to visualize pull requests."
        - `unreadable`: return `400 github_token_missing` with "The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again in Settings."
     3. Run `pr = await deps.githubClientFactory(secret.value).getPullRequest(owner, repo, dto.prNumber)`. On `GitHubClientError`, return `githubErrorToApiResponse(error, { owner, repo, pullNumber })` unchanged (06 §5.6.4: PR missing → 404 `not_found`; token problems → 400 `github_unauthorized`; rate limit → 429 `github_rate_limited`; unavailable → 502 `github_unavailable`).
     4. If `!isValidGitBranchName(pr.baseRef)`, return `400 validation_failed` with "GitHub returned a base branch name PRVision cannot use: {baseRef (≤ 100 chars)}." (The same check runs again in prepare.)
     5. Set `baseRef = pr.baseRef`.
     6. Set `headRef = pr.isFork && pr.headRepoFullName ? \`${forkOwner}:${pr.headRef}\` : pr.headRef`, cut to 255 characters. This value is **display-only**: prepare never passes `head_ref` to git for PRs (it fetches `refs/pull/<n>/head`).
     7. Set `title = \`#${n} ${pr.title}\``. Closed and merged PRs are allowed, because `refs/pull/<n>/head` stays fetchable.
   - **local_branch**
     1. Set `head = dto.headRef` and `base = dto.baseRef ?? repo.defaultBranch`. If `head === base`, return `400 validation_failed` with "Choose two different branches." This also catches a defaulted base that equals the head.
     2. If `fs.stat(repo.localPath)` fails, return `400 not_git_repo` with "Repository folder is missing: <path>".
     3. For each of `[base, head]`, run `git.revParse(repo.localPath, \`refs/heads/${name}\`)`. If it fails with `unknown_revision` or `invalid_argument`, return `400 validation_failed` with `Branch "<name>" does not exist in <repo.name>.` The same message covers a stored `defaultBranch` containing characters outside `SAFE_REF`. Any other `GitCommandError` → `400 not_git_repo` with "git failed: {first stderr line, ≤ 200 chars}".
     4. Set `title = \`${head} → ${base}\``, `baseRef = base` and `headRef = head`.
   - **working_tree**
     1. Same folder check as for local_branch.
     2. If `!(await git.isDirty(repo.localPath))`, return `400 { error: "There are no uncommitted changes in <repo.name>.", error_reason: "working_tree_clean" }`.
     3. Read `current = await git.currentBranch(repo.localPath)`.
     4. Set `baseRef = current ?? "HEAD"` and `headRef = WORKING_TREE_HEAD_REF` (`"working-tree"`).
     5. Set `title = current ? \`Uncommitted changes on ${current}\` : "Uncommitted changes (detached HEAD)"`.
     6. The snapshot itself is taken when the worker starts (§5.13.4).
4. **Title length.** If the derived title is longer than 300 characters, cut it to 299 and append `…`.
5. **Insert and job id in one transaction:**
   ```ts
   const visualizationId = await this.deps.transaction(async (tx) => {
     const qh = new QueryHandler(tx);
     const inserted = await qh.insert({
       repositoryId: repo.id, sourceType: dto.sourceType, prNumber: source.prNumber, title: source.title,
       baseRef: source.baseRef, headRef: source.headRef, status: VisualizationStatus.QUEUED,
       aiProvider: readiness.provider, aiModel: readiness.model, componentCount: 0, changedCount: 0,
     }, Table.VISUALIZATIONS);
     const id = QueryHandler.firstInsertedId(inserted);
     if (inserted.status !== 200 || id === null) throw new Error("Visualization insert failed");     // rollback
     const updated = await qh.update({ jobId: this.deps.queue.visualizationJobId(id) }, { id }, Table.VISUALIZATIONS);
     if (updated.status !== 200) throw new Error("job_id update failed");
     return id;
   });
   ```
   An insert that fails with `23503` (the repository was hard-deleted, impossible in practice because of `onDelete: restrict`) surfaces as the generic 500.
6. **Console**, after commit:
   - `info("queued", \`Queued: ${title}\`)`;
   - for working_tree, also `info("queued", "Your uncommitted changes are captured when the worker starts this visualization.")`.
7. **Enqueue after commit**, so the worker never reads an uncommitted row:
   ```ts
   try {
     const { jobId } = await this.deps.queue.enqueueVisualization(visualizationId);   // idempotent on viz-<id>
     this.log.info({ event: "visualization.job.queued", visualizationId, repositoryId: repo.id, sourceType: dto.sourceType }, "Visualization queued");
     return { status: 202, data: { visualizationId, jobId } satisfies CreateVisualizationResponse };
   } catch (error) {
     this.log.error({ event: "visualization.enqueue.failed", err: error, visualizationId }, "Enqueue failed");
     await transitionVisualization(this.deps.queryHandler, {
       visualizationId, from: VisualizationStatus.QUEUED, to: VisualizationStatus.FAILED, now: this.deps.now(),
       fields: { errorMessage: "Could not queue the job. Is Redis running? Start it and create the visualization again." },
     });
     await consoleSvc.error("queued", "Could not queue the job (Redis unavailable).");
     return { status: 500, error: "Could not queue the visualization: the job queue (Redis) is unavailable.", error_reason: "internal_error" };   // 00 §14.12
   }
   ```
   If `add` actually reached Redis before the client saw an error, a job exists for a row that is now `failed`; the worker skips it because it only runs `queued` rows (§5.9.4 step 1). If the API process dies between commit and enqueue, the row stays `queued` without a job; the recovery sweep fails it after `QUEUED_RECOVERY_GRACE_MS` (§5.10).

#### 5.4.2 `list(query)`

This uses direct Drizzle because it needs a join with `repositories` for `repositoryName`, which `QueryHandler` cannot express.

```ts
const { page, pageSize, limit, offset } = resolvePageRequest(query);
const v = schema.visualizations;
const r = schema.repositories;
const conditions: SQL[] = [eq(v.isDeleted, false), eq(r.isDeleted, false)];   // 03 §9.7: hide deleted repos' visualizations
if (query.repositoryId !== undefined) conditions.push(eq(v.repositoryId, query.repositoryId));
if (query.status !== undefined) conditions.push(inArray(v.status, query.status));   // comma list, 00 §14.4
const where = and(...conditions);

const [rows, totals] = await Promise.all([
  db.select({ visualization: v, repositoryName: r.name }).from(v)
    .innerJoin(r, eq(r.id, v.repositoryId)).where(where)
    .orderBy(desc(v.createdAt), desc(v.id)).limit(limit).offset(offset),
  db.select({ total: count() }).from(v).innerJoin(r, eq(r.id, v.repositoryId)).where(where),
]);
const data: PagedResult<VisualizationSummaryView> = {
  items: rows.map((row) => toVisualizationSummaryView(ModelHandler.hydrate(VisualizationModel, row.visualization), row.repositoryName)),
  page, pageSize, total: Number(totals[0]?.total ?? 0),
};
return { status: 200, data };
```

`limit` is always set (`pageSize` ≤ 100), so the query is bounded. A page past the end returns `items: []` with the correct `total`. An unknown `repositoryId` returns an empty page, not 404.

#### 5.4.3 `get()`

1. Call `loadVisible(id)`. If it returns `null`, respond 404 `not_found` with "Visualization not found".
2. Load the components ordered by rank, then id:
   ```ts
   queryHandler.selectMany(VisualizationComponentModel, { visualizationId: id }, Table.VISUALIZATION_COMPONENTS,
     { orderBy: [{ column: "rank", direction: "asc" }, { column: "id", direction: "asc" }] })
   ```
   No limit is applied: the row count per visualization is bounded by 08's analysis caps (rendered ≤ `MAX_COMPONENTS`, skipped rows bounded by `ANALYSIS_MAX_CHANGED_FILES`).
3. Map each component with `toVisualizationComponentView(c, (p) => deps.artifacts.toPublicUrl(p))`.
4. Return `200` with `toVisualizationDetailView(...)`.

#### 5.4.4 `console(query)`

1. Call `loadVisible(id)`. If it returns `null`, respond 404.
2. Read the events. This needs no direct Drizzle (04 §8.3):
   ```ts
   const events = await queryHandler.selectMany(VisualizationConsoleEventModel,
     { visualizationId: id, id: Where.gt(query.afterId ?? 0) }, Table.VISUALIZATION_CONSOLE_EVENTS,
     { orderBy: [{ column: "id", direction: "asc" }], limit: query.limit ?? CONSOLE_PAGE_LIMIT_MAX });
   ```
3. Return `200` with `events.map(toConsoleEventView)` — a bare array, oldest first (00 §14.4).

The frontend sends the last `id` it received as `afterId` (exclusive). An empty array means there is nothing new; a full page (`length === limit`) means the client should fetch again immediately.

#### 5.4.5 `cancel()`

Responses (00 §14.4): `200 { id, status: "cancelled" }` when the job was still queued and was removed; `202 { id, status: "cancel_requested" }` when the worker was signalled; `409 { error, error_reason: "already_terminal" }` when the run has already ended.

1. Call `loadVisible(id)`. If it returns `null`, respond 404.
2. If the status is terminal, return `409 { error: "This visualization is already <status>.", error_reason: "already_terminal" }`.
3. Run `await deps.queue.requestCancel(id)`. Setting the flag first matters: if the worker picks the job up a moment later, its pre-start check or 04's 1 s poll still sees it.
4. If the status read in step 1 is `queued`:
   1. Run `removed = await deps.queue.removeQueuedVisualization(id)`.
   2. If `!removed`, read `state = await deps.queue.getVisualizationJobState(id)`. Treat `"missing"`, `"completed"` and `"failed"` as removable, because no job will ever run this row.
   3. If the job was removed or is removable, run `ok = await transitionVisualization(qh, { from: "queued", to: "cancelled", now })` (writes `failed_stage = "queued"`). If `ok`:
      - console `info("cancelled", "Cancelled before the worker started.")`;
      - `await deps.queue.clearCancel(id)` (best effort, errors logged);
      - return `200 { id, status: "cancelled" }`.
   4. Otherwise (the job is `active`, or the guard lost to the worker's `queued → preparing`), fall through to step 5.
5. **Re-read** the row status (`loadVisible`). This closes the cancel-vs-completion race: the worker may have finished between step 1 and now.
   - Terminal → `await deps.queue.clearCancel(id)` (best effort, so a stale flag does not linger for 24 h) and return `409 already_terminal` with the same message as step 2.
   - Non-terminal → console `info(<current status>, "Cancellation requested. The run stops at the next checkpoint.")` and return `202 { id, status: "cancel_requested" }`.

Cancel is idempotent while running: repeating it returns 202 again (the flag is simply re-set). A cancel that arrives after the worker's last checkpoint loses the race; the run ends `completed` and the next cancel returns 409.

#### 5.4.6 `remove()`

Decision: **refuse while the visualization is non-terminal** (00 §14.4: `409 conflict`). During a run, the worker owns the worktrees and writes into `artifacts/<id>/`. A delete from the API process would race the render. The user cancels, waits for `cancelled`, then deletes.

1. Call `loadVisible(id)`. If it returns `null`, respond 404.
2. If the status is non-terminal, return `409 { error: "This visualization is still running. Cancel it and wait until it stops before deleting.", error_reason: "conflict" }`.
3. Soft-delete **atomically conditioned on a terminal status**, so a row that is (impossibly) not terminal any more is never deleted: `queryHandler.delete({ id, status: Where.in([...TERMINAL_VISUALIZATION_STATUSES]) }, Table.VISUALIZATIONS, DeletionMode.SOFT)`. `404` → re-read: missing → 404 `not_found`; otherwise `409 conflict`. Any other non-200 → 500.
4. Run `await deps.artifacts.removeVisualization(id)` inside try/catch. On failure, log a warning and still succeed. Component and console rows stay but become unreachable (03 §9.7).
5. Return `200 { id } satisfies DeleteVisualizationResponse`.

### 5.5 `VisualizationConsoleService`

File: `services/visualizations/visualization-console-service.ts`.

The `stage` column is `text` with a CHECK against the `VisualizationStatus` values (03 §6.1). Its values are **only `VisualizationStatus` names** (00 §14.4): `queued`, `preparing`, `analyzing`, `generating_harnesses`, `rendering`, `diffing`, `summarizing`, `completed`, `failed`, `cancelled`. Rules for this sheet:

- a progress line uses the status that is active when it is written;
- the cancel-requested line uses the current status;
- terminal lines and the cleanup line after them use the terminal status;
- recovery lines use `failed`.

Sheets 08–11 write through `ctx.console` using the stage of their step. Per-component lines put the component name in the message. `append` does not validate the stage (sheets 08–11 may pass any status name); a non-status stage fails 03's CHECK, which `append` logs and swallows. This sheet's tests assert it only ever writes status names.

```ts
export class VisualizationConsoleService {
  private readonly log = createLogger("visualization-console");

  constructor(
    private readonly visualizationId: number,
    private readonly queryHandler: Pick<QueryHandler, "insert"> = new QueryHandler(),
  ) {}

  info(stage: string, message: string): Promise<void> { return this.append("info", stage, message); }
  warn(stage: string, message: string): Promise<void> { return this.append("warn", stage, message); }
  error(stage: string, message: string): Promise<void> { return this.append("error", stage, message); }

  /** Adapter for PipelineContext.console (00 §8). */
  asPipelineConsole(): PipelineContext["console"] {
    return { info: this.info.bind(this), warn: this.warn.bind(this), error: this.error.bind(this) };
  }

  /** Never throws: a console write failure must not fail a pipeline step. */
  private async append(level: ConsoleLevel, stage: string, message: string): Promise<void> {
    const clean = sanitizeConsoleMessage(message);
    const safeStage = stage.slice(0, 64);
    this.log[level]({ event: "visualization.console.event", visualizationId: this.visualizationId, stage: safeStage, message: clean }, "Console event");
    try {
      const result = await this.queryHandler.insert(
        { visualizationId: this.visualizationId, level, stage: safeStage, message: clean },
        Table.VISUALIZATION_CONSOLE_EVENTS,
      );
      if (result.status !== 200) this.log.warn({ event: "visualization.console.insert_failed", visualizationId: this.visualizationId, status: result.status }, "Console event insert failed");
    } catch (error) {
      this.log.warn({ event: "visualization.console.insert_failed", visualizationId: this.visualizationId, err: error }, "Console event insert threw");
    }
  }
}

/** Strip ANSI escapes and control chars (keep \n, \t), redact (04 redactSecrets), cap at CONSOLE_MESSAGE_MAX_LENGTH. */
export function sanitizeConsoleMessage(message: string): string {
  const stripped = message.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const redacted = redactSecrets(stripped);
  return redacted.length > CONSOLE_MESSAGE_MAX_LENGTH ? `${redacted.slice(0, CONSOLE_MESSAGE_MAX_LENGTH - 1)}…` : redacted;
}
```

The console is shown to the user, and git stderr and AI error text flow into it. Every message passes through `redactSecrets` no matter who writes it, including sheets 08–11 via `ctx.console`.

### 5.6 Queue integration and `worker.ts`

`worker.ts` is owned by 04. This sheet adds three lines at the places 04 §5.2 marks:

```ts
// between QueueService.initialize() and startVisualizationWorker():
const recovery = await AuthContext.runAsLocalUser(() => VisualizationWorkerService.recoverOnBoot(), { requestId: "boot-recovery" });
log.info({ event: "visualization.recovery.boot_finished", ...recovery }, "Visualization boot recovery finished");

// processor (replaces 04's placeholder; 04 already wraps it in AuthContext.runAsLocalUser). Signature: 00 §14.6.
const processVisualization: VisualizationJobProcessor = async ({ visualizationId, jobId, signal }) => {
  await new VisualizationWorkerService().run({ visualizationId, jobId, signal });
};

// after startVisualizationWorker(): periodic recovery sweep; stopped as the first shutdown step.
const sweep = VisualizationWorkerService.startRecoverySweep();          // returns { stop(): void }
// installGracefulShutdown([{ name: "recovery-sweep", close: async () => { sweep.stop(); } }, …04's steps])
```

`run()` never throws for pipeline failures, because those are recorded on the row. It rethrows only when the row cannot be loaded at all (DB down). BullMQ then marks the job failed, and the recovery sweep (§5.10) later fails the stuck `queued` row.

Shutdown is handled by 04's `installGracefulShutdown` → `QueueService.close()`. That aborts the active job's signal with reason `"shutdown"`. `run()` maps it to `failed` and removes the worktrees in `finally`. If 04's forced close timeout fires first, boot recovery handles the row on the next start.

### 5.7 Pipeline context and signals

```ts
const timeout = new AbortController();
const timer = setTimeout(() => timeout.abort(new VisualizationTimeoutError(limits.maxRuntimeMs)), limits.maxRuntimeMs);   // 45 min, 00 §14.6
timer.unref();
const signal = AbortSignal.any([job.signal, timeout.signal]);       // keeps the first aborter's reason

const ctx: PipelineContext = {
  visualizationId,
  workspace,
  repository: { id, localPath, viteConfigPath, tsconfigPath, entryFilePath, globalStylePaths: [...globalStylePaths] },  // snapshot
  ai,                                                                                            // AiProviderFactory.create(settings)
  aiSettings: { model: settings.model, harnessEffort: settings.harnessEffort, summaryEffort: settings.summaryEffort },  // same read; no key
  console: consoleSvc.asPipelineConsole(),
  isCancelled: () => this.safeIsCancelled(visualizationId),                                      // QueueService.isCancelRequested; never throws
  signal,
};
```

`signal.reason` is therefore one of: the string `"cancelled"` (user cancel), the string `"shutdown"` (worker stop), or a `VisualizationTimeoutError` (45-minute limit). §5.9.6 classifies on exactly these.

Every step service must pass `ctx.signal` into long calls (`runProcess`, AI providers, Playwright) and check `ctx.isCancelled()` before each component (the 04 §9.4 contract). The orchestrator also checks between stages, and bounds every step call with `awaitStep` (§5.9.4): once the signal has aborted, a step that has not settled within `STEP_ABORT_GRACE_MS` (30 s) is abandoned so cleanup and the terminal write still happen.

### 5.8 AI usage

09's `AiUsageRecorder` is the only writer of `visualizations.ai_usage` (00 §14.7). 11 uses the same recorder, and so does 09's `repairHarness` when 10 calls it during rendering. The recorder writes incrementally, so the orchestrator neither wraps the provider nor writes usage, and partial usage survives failures and cancellations.

### 5.9 `VisualizationWorkerService` — orchestrator

File: `services/visualizations/pipeline/visualization-worker-service.ts`.

#### 5.9.1 Error classes and helpers

```ts
export class VisualizationTimeoutError extends Error {
  constructor(readonly limitMs: number) { super("Visualization timed out"); this.name = "VisualizationTimeoutError"; }
}
/** A guarded transition matched 0 rows: another writer (API cancel, recovery) owns the row now. */
export class VisualizationRowConflictError extends Error {
  constructor(readonly visualizationId: number, readonly from: VisualizationStatus, readonly to: VisualizationStatus) {
    super(`Visualization ${visualizationId} was not in status ${from} (wanted ${to})`);
    this.name = "VisualizationRowConflictError";
  }
}
/** Internal: thrown by checkpoints and when a step reports cancellation. */
class RunCancelledSignal extends Error { constructor() { super("cancelled"); this.name = "RunCancelledSignal"; } }
/** Internal: a step did not settle within STEP_ABORT_GRACE_MS after the run signal aborted. */
class StepAbandonedError extends Error { constructor() { super("step abandoned after abort"); this.name = "StepAbandonedError"; } }

```

`VisualizationJob` (the processor argument of 00 §14.6: `{ visualizationId, jobId, signal }`) is imported from 04's `queue-service.ts` (04 §9.4) through the `utilities` barrel; this sheet does not redeclare it.

| Helper | Behaviour |
|---|---|
| `shortErrorMessage(error)` | `error instanceof Error ? error.message : String(error)`, then `redactSecrets`, then the first line, at most 200 characters. |
| `describeSource(v)` | `PR #12`, `feature/x vs main` or `working tree`. |
| `safeIsCancelled(id)` | `QueueService.isCancelRequested(id)` in try/catch. On error it logs a warning and returns `false`: a Redis hiccup does not count as a cancellation. |
| `awaitStep(work, signal)` | Resolves/rejects with `work`. If `signal` aborts first, waits at most `limits.stepAbortGraceMs` (30 s) more for `work` to settle; if it has not, logs `error` "Step did not stop after abort" and rejects with `StepAbandonedError` (the abandoned promise gets a no-op `.catch` so it can never become an unhandled rejection). Classification then uses `signal.reason`. An abandoned step can leave files behind; the worktrees are still removed in `finally`, and anything recreated later is removed by boot recovery. |
| `buildRenderInputs(candidates, harnesses, changedFiles)` | **Imported from 10** (10 §5.13.1), called as `buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles)`. Returns `RenderComponentInput[]` in candidate rank order with `basePath` set for renamed components. Candidates without a harness are omitted: 09 has already persisted them as `skipped`/`failed` with side errors (00 §14.7). |
| `toRepairHarnessFn(harnessService)` | Adapter to 10's `RepairHarnessFn` (below). |

```ts
/** 10 owns when to repair and persists the attempt it keeps; 09's repairHarness never persists (00 §14.7). */
function toRepairHarnessFn(harnessService: Pick<HarnessGenerationService, "repairHarness">): RepairHarnessFn {
  // renderError is 09's HarnessRenderError object (09 §5.1) built by 10; its message is 10's formatted error (10 §5.12.3).
  // The HarnessRepairOutcome is returned unchanged: 10 needs the verdicts' notesAppendix (10 §5.13.1).
  return (componentId: number, previous: HarnessGenerationResult, renderError: HarnessRenderError): Promise<HarnessRepairOutcome> =>
    harnessService.repairHarness(componentId, previous, renderError);
}
```

#### 5.9.2 Step contracts (how 08–11 are called)

Each step service persists its own per-component columns. The orchestrator writes only the `visualizations` row, console events, and the final `pending → skipped` sweep. The factories return `Pick`s of the classes the sibling sheets define; tests swap in fakes.

```ts
export interface PipelineStepFactories {
  /** 08 — default `new ChangeAnalysisService()`; one instance per job. */
  changeAnalysis(): Pick<ChangeAnalysisService, "analyze">;
  /** 09 — default `new HarnessGenerationService(ctx, sourceQueries)`; the same instance serves repairs for 10. */
  harnessGeneration(ctx: PipelineContext, sourceQueries: ComponentSourceQueries):
    Pick<HarnessGenerationService, "generateAll" | "repairHarness">;
  /** 10 — default `new RenderService({ repairHarness })` (10 §5.13.1; other deps use 10's defaults). */
  render(deps: { repairHarness: RepairHarnessFn }): Pick<RenderService, "renderAll">;
  /** 11 — defaults `new ImageDiffService()`, `new StructuralDiffService()`, `new SummaryService()`. */
  imageDiff(): Pick<ImageDiffService, "diff">;
  structuralDiff(): Pick<StructuralDiffService, "compare">;
  summary(): Pick<SummaryService, "summarize">;
}
```

Calls per stage, exactly as the sibling sheets publish them:

| Stage | Call | Result handling |
|---|---|---|
| analyzing | `analysis = await changeAnalysis().analyze(ctx)` (08) | `candidates` (capped, ranked), `skipped`, `changedFiles`, `sourceQueries` (00 §14.7). 08 inserts every component row (with `change_reason` / `skip_reason`) and writes `component_count`. `analysis` is held in memory until summarizing ends. |
| generating_harnesses | `batch = await harnessService.generateAll(analysis.candidates)` (09) | `batch.cancelled` → cancellation. 09 has already persisted every failure and `skipped` row; the orchestrator adds a console summary. AI `auth`/`config` errors arrive as `PipelineStepError`. With zero candidates 09 returns an empty batch immediately. |
| rendering | `renders = await render({ repairHarness: toRepairHarnessFn(harnessService) }).renderAll(ctx, buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles))` (10) | Skipped when there are no inputs. 10 persists render columns, omits components it did not finish because of cancellation (their rows stay `pending`), and closes Vite and Chromium before returning. |
| diffing | `diffs = await imageDiff().diff(ctx, renders)`, then `await structuralDiff().compare(ctx, { renders, diffs, analysis })` (11) | Skipped when `renders` is empty. `ImageDiffService` sets `visual_change`. |
| summarizing | `outcome = await summary().summarize(ctx, analysis)` (11) | **Always runs** (11 writes its fixed summary when nothing changed). Never throws for AI failures. `outcome.status === "cancelled"` → cancellation; `"failed"` → completed with the `summary_markdown = null` that 11 wrote, plus a console error; `"generated"` / `"fixed"` → completed. |

Binding failure rules for the steps:

| Failure | Step does | Orchestrator does |
|---|---|---|
| Whole-run problem (Vite cannot start, the diff cannot be read, a DB write fails) | throw `PipelineStepError(stage, userMessage)` | `failed` with `userMessage` |
| A single component fails | persist the failure on its row and continue | console summary; continue |
| AI `auth`/`config` during harness generation | `PipelineStepError` (09) | `failed` |
| AI failure in the summary | `SummaryOutcome.status = "failed"` | `completed`, summary null, console error |
| Abort (`ctx.signal`) | stop quickly; throw, or return `cancelled` | classify by `signal.reason` (§5.9.6) |
| Step ignores the abort | — | abandoned after `STEP_ABORT_GRACE_MS`; classified by `signal.reason` |

#### 5.9.3 Dependencies

```ts
export interface VisualizationWorkerDependencies {
  queryHandler: QueryHandler;
  workspace: Pick<WorkspacePrepareService, "prepare" | "cleanup">;
  readAiSettings: () => Promise<ResolvedAiSettings>;             // new SettingsStore().readAiSettings()
  createProvider: (settings: ResolvedAiSettings) => AiProvider;  // AiProviderFactory.create
  steps: PipelineStepFactories;
  queue: Pick<typeof QueueService, "isCancelRequested" | "clearCancel" | "getVisualizationJobState">;
  consoleFactory: (visualizationId: number) => VisualizationConsoleService;
  now: () => Date;
  limits: { maxRuntimeMs: number; stepAbortGraceMs: number };  // VISUALIZATION_MAX_RUNTIME_MS, STEP_ABORT_GRACE_MS
}

export type RunOutcome = "completed" | "failed" | "cancelled" | "skipped";

interface RunState { visualizationId: number; status: VisualizationStatus; }

export class VisualizationWorkerService {
  private readonly deps: VisualizationWorkerDependencies;
  private readonly log = createLogger("visualization-worker");

  constructor(deps: Partial<VisualizationWorkerDependencies> = {}) {
    this.deps = { ...defaultWorkerDependencies(), ...deps };
  }

  async run(job: VisualizationJob): Promise<RunOutcome>;
  static async recoverOnBoot(deps?: Partial<RecoveryDependencies>): Promise<BootRecoveryReport>;
  static startRecoverySweep(deps?: Partial<RecoveryDependencies>): { stop(): void };
}
```

#### 5.9.4 `run()`

```ts
async run(job: VisualizationJob): Promise<RunOutcome> {
  const { visualizationId } = job;
  const log = this.log.child({ visualizationId, jobId: job.jobId });

  // 1. Load + guard. Only 'queued' rows are executable; anything else is a stale or duplicate job.
  const visualization = await this.deps.queryHandler.validateAndSelect(VisualizationModel, { id: visualizationId }, Table.VISUALIZATIONS);
  if (!visualization) { log.warn({ event: "visualization.job.skipped" }, "Visualization missing or deleted; job skipped"); return "skipped"; }
  if (visualization.status !== VisualizationStatus.QUEUED) {
    log.warn({ event: "visualization.job.skipped", status: visualization.status }, "Visualization is not queued; job skipped");
    return "skipped";
  }

  const consoleSvc = this.deps.consoleFactory(visualizationId);
  const state: RunState = { visualizationId, status: VisualizationStatus.QUEUED };
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new VisualizationTimeoutError(this.deps.limits.maxRuntimeMs)), this.deps.limits.maxRuntimeMs);
  timer.unref();
  const signal = AbortSignal.any([job.signal, timeout.signal]);
  let repository: RepositoryModel | null = null;
  let workspaceStarted = false;
  const startedAtMs = Date.now();

  try {
    // 2. Cancelled before start?
    if (signal.aborted || (await this.safeIsCancelled(visualizationId))) throw new RunCancelledSignal();

    // 3. Repository (soft-delete aware).
    repository = await this.deps.queryHandler.validateAndSelect(RepositoryModel, { id: visualization.repositoryId }, Table.REPOSITORIES);
    if (!repository) throw new PipelineStepError("preparing", "The repository for this visualization was removed.");

    // 4. One settings read → provider and ctx.aiSettings (05 §5.2). Config problems surface here, before any git work.
    const settings = await this.deps.readAiSettings();
    const ai = this.deps.createProvider(settings);

    // 5. queued → preparing
    await this.advance(state, VisualizationStatus.PREPARING, consoleSvc,
      { aiProvider: settings.provider, aiModel: settings.model, errorMessage: null },
      `Preparing workspace (${describeSource(visualization)}).`);

    // 6. Workspace (cleanup runs in finally even if prepare fails halfway).
    workspaceStarted = true;
    const workspace = await this.awaitStep(this.deps.workspace.prepare({
      visualizationId, sourceType: visualization.sourceType, prNumber: visualization.prNumber,
      baseRef: visualization.baseRef, headRef: visualization.headRef,
      repository: {
        id: repository.id, localPath: repository.localPath, githubOwner: repository.githubOwner, githubRepo: repository.githubRepo,
        viteConfigPath: repository.viteConfigPath,
      },
      console: consoleSvc.asPipelineConsole(), signal,
    }), signal);
    const ctx = this.buildContext(visualizationId, workspace, repository, ai, settings, consoleSvc, signal);

    // 7. analyzing — `analysis` stays in scope until summarizing ends (00 §14.7).
    await this.checkpoint(ctx);
    await this.advance(state, VisualizationStatus.ANALYZING, consoleSvc,
      { baseSha: workspace.baseSha, headSha: workspace.headSha }, "Analyzing changed files.");
    const analysis = await this.awaitStep(this.deps.steps.changeAnalysis().analyze(ctx), signal);
    await consoleSvc.info("analyzing",
      `${analysis.changedFiles.length} changed file(s); ${analysis.candidates.length} component(s) to render, ${analysis.skipped.length} skipped.`);

    // 8. generating_harnesses (09 owns concurrency and per-component cancellation checks)
    await this.checkpoint(ctx);
    await this.advance(state, VisualizationStatus.GENERATING_HARNESSES, consoleSvc, {},
      analysis.candidates.length > 0
        ? `Generating render harnesses for ${analysis.candidates.length} component(s).`
        : "No components to generate harnesses for.");
    const harnessService = this.deps.steps.harnessGeneration(ctx, analysis.sourceQueries);
    const batch = await this.awaitStep(harnessService.generateAll(analysis.candidates), signal);
    if (batch.cancelled) throw new RunCancelledSignal();
    if (analysis.candidates.length > 0) {
      await consoleSvc.info("generating_harnesses", `${batch.results.length} harness(es) ready, ${batch.failures.length} failed.`);
    }

    // 9. rendering
    await this.checkpoint(ctx);
    const renderInputs = buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles);   // 10 §5.13.1
    await this.advance(state, VisualizationStatus.RENDERING, consoleSvc, {},
      renderInputs.length > 0 ? `Rendering ${renderInputs.length} component(s) on base and head.` : "Nothing to render.");
    const renders = renderInputs.length > 0
      ? await this.awaitStep(
          this.deps.steps.render({ repairHarness: toRepairHarnessFn(harnessService) }).renderAll(ctx, renderInputs), signal)
      : [];
    if (renders.length > 0) {
      const ok = renders.filter((r) => (r.base?.ok ?? true) && (r.head?.ok ?? true)).length;
      await consoleSvc.info("rendering", `${ok} of ${renders.length} component(s) rendered on every side they exist.`);
    }

    // 10. diffing
    await this.checkpoint(ctx);
    await this.advance(state, VisualizationStatus.DIFFING, consoleSvc, {},
      renders.length > 0 ? `Comparing ${renders.length} render(s).` : "Nothing to compare.");
    if (renders.length > 0) {
      const diffs = await this.awaitStep(this.deps.steps.imageDiff().diff(ctx, renders), signal);
      await this.checkpoint(ctx);
      await this.awaitStep(this.deps.steps.structuralDiff().compare(ctx, { renders, diffs, analysis }), signal);
    }

    // 11. summarizing — always; worktrees and `analysis` are still alive (structural/related diffs read them).
    await this.checkpoint(ctx);
    await this.advance(state, VisualizationStatus.SUMMARIZING, consoleSvc, {}, "Writing the summary.");
    const outcome = await this.awaitStep(this.deps.steps.summary().summarize(ctx, analysis), signal);
    if (outcome.status === "cancelled") throw new RunCancelledSignal();
    if (outcome.status === "failed") {
      await consoleSvc.error("summarizing",
        `The summary could not be generated (${outcome.failureReason ?? "unknown error"}). Renders and diffs are still available.`);
    }

    // 12. completed. No checkpoint here: once the summary exists, a cancel that arrives now loses the race.
    await this.finish(state, consoleSvc, VisualizationStatus.COMPLETED, { errorMessage: null });
    log.info({ event: "visualization.run.finished", outcome: "completed", durationMs: Date.now() - startedAtMs, components: analysis.candidates.length }, "Visualization completed");
    return "completed";
  } catch (error) {
    return await this.finishWithError(state, consoleSvc, error, signal, log);
  } finally {
    clearTimeout(timer);
    if (workspaceStarted && repository) {
      await consoleSvc.info(state.status, "Removing temporary worktrees.");
      await this.deps.workspace.cleanup({ visualizationId, repositoryPath: repository.localPath, prNumber: visualization.prNumber });   // never throws
    }
    await this.deps.queue.clearCancel(visualizationId).catch((error: unknown) => { log.warn({ event: "visualization.cancel.clear_failed", err: error }, "Cancel flag clear failed"); });
  }
}
```

Helpers:

```ts
/** Guarded transition + console line. A lost guard stops the run without further writes. */
private async advance(state: RunState, to: VisualizationStatus, consoleSvc: VisualizationConsoleService,
  fields: VisualizationTransitionFields, message: string): Promise<void> {
  const ok = await transitionVisualization(this.deps.queryHandler, { visualizationId: state.visualizationId, from: state.status, to, fields, now: this.deps.now() });
  if (!ok) throw new VisualizationRowConflictError(state.visualizationId, state.status, to);
  this.log.info({ event: "visualization.stage.transition", visualizationId: state.visualizationId, from: state.status, to }, "Stage transition");
  state.status = to;
  await consoleSvc.info(to, message);
}

/** Between stages: abort reasons (cancel/shutdown/timeout) first, then the Redis flag (covers the ≤ 1 s poll gap). */
private async checkpoint(ctx: PipelineContext): Promise<void> {
  if (ctx.signal.aborted) throw new RunCancelledSignal();      // classified by signal.reason in §5.9.6
  if (await ctx.isCancelled()) throw new RunCancelledSignal();
}
```

`checkpoint` throws `RunCancelledSignal` for every abort; §5.9.6 looks at `signal.reason` before treating it as a user cancel, so shutdown and timeout are not misreported as cancellations.

`buildContext(...)` assembles the `PipelineContext` exactly as shown in §5.7. Copying `globalStylePaths` into a new array means a later redetect cannot change a run that is already in progress.

#### 5.9.5 Counts and the pending sweep

```ts
/** Counts via QueryHandler (04 Where operators; no direct Drizzle needed). 00 §14.3 semantics. */
private async componentCounts(visualizationId: number): Promise<{ componentCount: number; changedCount: number }> {
  const [all, changed] = await Promise.all([
    this.deps.queryHandler.count({ visualizationId }, Table.VISUALIZATION_COMPONENTS),
    this.deps.queryHandler.count({ visualizationId, visualChange: Where.in(["changed", "new", "deleted"]) }, Table.VISUALIZATION_COMPONENTS),
  ]);
  if (all.status !== 200 || changed.status !== 200) throw new Error("Component count failed");
  const componentCount = all.data?.count ?? 0;
  return { componentCount, changedCount: Math.min(changed.data?.count ?? 0, componentCount) };
}

const PENDING_SKIP_REASON: Record<TerminalVisualizationStatus, string> = {
  completed: "Not processed.",
  failed: "Not processed: the run failed before this component was finished.",
  cancelled: "Not processed: the run was cancelled before this component was finished.",
};

/** Pending sweep, counts, guarded terminal transition, console line. Throws on DB failure (finishWithError logs fatal). */
private async finish(state: RunState, consoleSvc: VisualizationConsoleService, to: TerminalVisualizationStatus,
  fields: VisualizationTransitionFields): Promise<void> {
  let counts: { componentCount: number; changedCount: number } | null = null;
  if (state.status !== VisualizationStatus.QUEUED) {                       // no component rows exist before analyzing
    const swept = await this.deps.queryHandler.update(
      { renderStatus: ComponentRenderStatus.SKIPPED, skipReason: PENDING_SKIP_REASON[to] },
      { visualizationId: state.visualizationId, renderStatus: ComponentRenderStatus.PENDING },
      Table.VISUALIZATION_COMPONENTS);
    if (swept.status !== 200 && swept.status !== 404) throw new Error("Pending sweep failed");   // 404 = nothing pending
    counts = await this.componentCounts(state.visualizationId);
  }
  const ok = await transitionVisualization(this.deps.queryHandler, {
    visualizationId: state.visualizationId, from: state.status, to, now: this.deps.now(),
    fields: { ...fields, ...(counts ? { changedCount: counts.changedCount } : {}) },   // component_count stays 08's value
  });
  if (!ok) throw new VisualizationRowConflictError(state.visualizationId, state.status, to);
  state.status = to;
  if (to === VisualizationStatus.COMPLETED) {
    await consoleSvc.info(to, `Completed: ${counts?.changedCount ?? 0} of ${counts?.componentCount ?? 0} component(s) changed visually.`);
  } else if (to === VisualizationStatus.CANCELLED) {
    await consoleSvc.warn(to, "Cancelled by user.");
  } else {
    await consoleSvc.error(to, fields.errorMessage ?? "Failed.");
  }
}
```

The pending sweep, the counts and the terminal transition are three statements, not one transaction: the only concurrent writer at this point is a step that was abandoned by `awaitStep`, and a transaction would not stop it either. The terminal transition is the guarded write that matters.

#### 5.9.6 Error mapping — `finishWithError(state, consoleSvc, error, signal, log)`

1. If `error instanceof VisualizationRowConflictError`, log a warning and return `"skipped"`. No writes.
2. Call `classifyRunFailure(error, signal.reason, await this.safeIsCancelled(id))` (pure, exported for tests). The abort reason is checked first, because an abort can surface as many error types (AI `aborted`, 08's `ANALYSIS_CANCELLED`, Playwright errors, `AbortError`, `StepAbandonedError`). The first matching row wins:

| Condition | Status | `error_message` |
|---|---|---|
| `signal.reason === "shutdown"` | `failed` | "Worker stopped before the visualization finished. Start it again." |
| `signal.reason instanceof VisualizationTimeoutError` | `failed` | "Stopped after {n} minutes (time limit)." (`n = limitMs / 60000`) |
| `signal.reason === "cancelled"`, or `error instanceof RunCancelledSignal`, or the cancel flag is set | `cancelled` | null |
| `isPipelineStepError(error)` | `failed` | `error.userMessage` |
| `AiProviderError` with reason `auth` | `failed` | "The AI provider rejected the credentials. Check Settings → AI and run Test connection." |
| `AiProviderError` with reason `config` | `failed` | "AI is not configured: {redacted message, ≤ 200 chars}" |
| `AiProviderError` with any other reason | `failed` | "AI request failed ({reason}). Try again." |
| `GitCommandError` (escaped prepare) | `failed` | "A git command failed ({code}): {first stderr line, ≤ 200 chars}" |
| Anything else (incl. `QueryHandlerError`) | `failed` | "Unexpected error during {state.status}. See the worker log for details." Logged at error with `err`. |

   Shutdown and timeout come before the cancel row so that a `RunCancelledSignal` thrown by `checkpoint` after a shutdown/timeout abort is not reported as a user cancel.
3. Write the terminal state with `await this.finish(state, consoleSvc, status, { errorMessage })`. `transitionVisualization` stamps `failed_stage` with the status active at the time (`queued` when the failure came before `preparing`; both `queued → failed` and `queued → cancelled` are allowed).
4. If that terminal write itself throws (for example, the DB is down), log at `fatal` with both errors and return `"failed"`. The recovery sweep or boot recovery fixes the row later.
5. Return the status.

### 5.10 Recovery: boot and periodic sweep

`VisualizationWorkerService.recoverOnBoot()` runs in `worker.ts` before `startVisualizationWorker`, so no job is active in this process yet. The prototype runs exactly one worker process (00 D1), and recovery assumes it is the only one.

```ts
export interface BootRecoveryReport { failedRunning: number[]; failedLostQueued: number[]; cleanedWorktrees: number[]; skippedEntries: string[]; }

export interface RecoveryDependencies {
  queryHandler: QueryHandler;
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;    // DrizzleDb.transaction
  db: Database;                                                           // soft-delete-inclusive lookups (step 3) only
  queue: Pick<typeof QueueService, "getVisualizationJobState">;
  workspace: Pick<WorkspacePrepareService, "cleanup">;
  git: Pick<GitClient, "worktreePrune">;
  artifacts: Pick<ArtifactStore, "worktreesRoot">;
  now: () => Date;
  intervalMs: number;                                                     // RECOVERY_SWEEP_INTERVAL_MS
}
```

Each step below is wrapped in try/catch with a warning, so recovery never blocks worker start. Every query is bounded (`limit: RECOVERY_BATCH_LIMIT`, 500 rows, ordered by id; a larger backlog is handled on the next sweep).

1. **Running → failed.**
   - `stuck = await qh.selectMany(VisualizationModel, { status: Where.in([...ACTIVE_VISUALIZATION_STATUSES]) }, Table.VISUALIZATIONS, { limit: RECOVERY_BATCH_LIMIT })`.
   - For each row, inside one `DrizzleDb.transaction` per row with `new QueryHandler(tx)`:
     - `transitionVisualization(qh, { from: row.status, to: "failed", fields: { errorMessage: WORKER_RESTARTED_MESSAGE }, now })` (stamps `failed_stage = row.status`); a lost guard skips the row;
     - pending sweep `update({ renderStatus: "skipped", skipReason: PENDING_SKIP_REASON.failed }, { visualizationId: row.id, renderStatus: "pending" }, Table.VISUALIZATION_COMPONENTS)`;
     - insert one console `error` event with stage `failed`.
   - `WORKER_RESTARTED_MESSAGE` = "The worker restarted while this visualization was running. Start it again."
   - With `maxStalledCount: 0`, BullMQ fails the stalled job and never re-runs it. If it ever did, `run()` would skip the row as not queued.
2. **Lost queued jobs.** `failLostQueued(now)` (shared with the sweep):
   - Select `queued` rows with `createdAt: Where.lt(now − QUEUED_RECOVERY_GRACE_MS)` (60 s). The grace period avoids racing an API create that has committed but not enqueued yet.
   - For each row, `state = await QueueService.getVisualizationJobState(id)`.
   - If the state is `missing`, `completed` or `failed`, transition `queued → failed` with "The queued job was lost (Redis was cleared or the job failed before starting). Start the visualization again." and add a console error at stage `failed`.
   - Leave `waiting`, `delayed`, `prioritized` and `active` alone.
3. **Orphan worktrees.** `readdir(artifactStore.worktreesRoot())`. A missing directory is fine. For each entry, use `lstat`:
   - If the name matches `^[1-9]\d*$` and the entry is a real directory (not a symlink): look up the visualization **including soft-deleted rows**, and its repository. This uses direct Drizzle, because `QueryHandler` adds `isDeleted = false` by default and this lookup must include deleted rows. Then run `workspace.cleanup({ visualizationId: id, repositoryPath: repo?.localPath ?? null, prNumber: viz?.prNumber ?? null })`.
   - Any other entry (other names, symlinks, files): leave it alone, record it in `skippedEntries`, and log a warning. PRVision never deletes what it did not create; 04's `rm` only runs on `worktrees/<int>`.
4. **Dangling worktree metadata.** For every non-deleted repository whose `localPath` exists, run `git.worktreePrune(localPath)`. This removes `.git/worktrees/*` entries whose directories are gone, for example after the user wiped the data dir.
5. Return the report; `worker.ts` logs it at info.

**Periodic sweep.** `startRecoverySweep()` starts an unref'd `setInterval(RECOVERY_SWEEP_INTERVAL_MS)` (5 min). A tick is skipped while the previous one is still running. Each tick, wrapped in try/catch:

1. `failLostQueued(now)` (step 2 above).
2. **Running rows without a live job:** select rows in `ACTIVE_VISUALIZATION_STATUSES` with `updatedAt: Where.lt(now − RUNNING_RECOVERY_GRACE_MS)` (60 s). For each, `state = await QueueService.getVisualizationJobState(id)`; if it is not `active`, fail the row exactly like boot step 1, with "The worker lost track of this visualization (its job ended without a final status). Start it again." The currently running job is always `active`, so the sweep never touches it. This catches a terminal write that failed while the DB was briefly down.

`stop()` clears the interval; an in-flight tick finishes on its own (it only issues guarded writes).

### 5.11 Workspace preparation inputs

`prepare()` takes the source columns from the visualization row: `sourceType`, `prNumber`, `baseRef` and `headRef`. The PR is re-read from GitHub at prepare time, so a PR updated after it was queued is visualized at its latest head. A console warning notes when the head has moved.

### 5.12 Constants

These live in `config-consts/queue.config.ts` and are part of 02 §6.7 (the single consolidated list, 00 §14.8). This sheet imports them and never redefines them; they are repeated here for reference. The git constants (`GIT_FETCH_TIMEOUT_MS`, `GIT_WORKTREE_TIMEOUT_MS`, `GIT_MAX_BUFFER_BYTES`) are in `app.config.ts`:

```ts
export const VISUALIZATION_MAX_RUNTIME_MS = 45 * 60_000;       // 00 §14.6
export const STEP_ABORT_GRACE_MS = 30_000;                      // §5.9.1 awaitStep
export const QUEUED_RECOVERY_GRACE_MS = 60_000;
export const RUNNING_RECOVERY_GRACE_MS = 60_000;
export const RECOVERY_SWEEP_INTERVAL_MS = 5 * 60_000;
export const RECOVERY_BATCH_LIMIT = 500;
export const WORKING_TREE_MAX_UNTRACKED_FILES = 2_000;
export const WORKING_TREE_MAX_UNTRACKED_BYTES = 200 * 1024 * 1024;
export const WORKING_TREE_HEAD_REF = "working-tree";
export const CONSOLE_MESSAGE_MAX_LENGTH = 4_000;                 // 03 §9.9
```

Other constants:

- `config-consts/pagination.config.ts`: `CONSOLE_PAGE_LIMIT_MAX = 500` (02 §6.7).
- `config-consts/render.config.ts`: `HARNESS_TEMPLATES_DIR` (00 §14.8; sheet 02 holds the value), the absolute path of `backend/harness-templates`, resolved from the backend package root.
- The working-tree patch size limit is 04's `GIT_MAX_BUFFER_BYTES` (64 MiB). Past it, `diffBinaryHead` fails with `output_too_large`.

### 5.13 `WorkspacePrepareService`

File: `services/visualizations/pipeline/workspace-prepare-service.ts`.

```ts
export interface WorkspacePrepareInput {
  visualizationId: number;
  sourceType: VisualizationSourceType;
  prNumber: number | null;
  baseRef: string;
  headRef: string;
  repository: { id: number; localPath: string; githubOwner: string | null; githubRepo: string | null; viteConfigPath: string | null };
  console: PipelineContext["console"];
  signal: AbortSignal;
}
export interface WorkspaceCleanupInput { visualizationId: number; repositoryPath: string | null; prNumber: number | null; }

export interface WorkspacePrepareDependencies {
  git: GitClient;
  artifacts: Pick<ArtifactStore, "worktreesRoot" | "visualizationWorktreeRoot" | "worktreeDir" | "removeVisualizationWorktreeRoot" | "ensureDir">;
  readGithubToken: () => Promise<SecretRead>;
  githubClientFactory: (token: string) => Pick<GitHubClient, "getPullRequest">;
  harnessTemplatesDir: string;                                   // HARNESS_TEMPLATES_DIR
}

export const prRef = (n: number): string => `refs/prvision/pr-${n}`;
export const prBaseRef = (n: number): string => `refs/prvision/pr-${n}-base`;   // 00 §14.7

export class WorkspacePrepareService {
  private readonly log = createLogger("workspace-prepare");
  constructor(private readonly deps: WorkspacePrepareDependencies = defaultWorkspaceDependencies()) {}
  async prepare(input: WorkspacePrepareInput): Promise<PreparedWorkspace>;
  async cleanup(input: WorkspaceCleanupInput): Promise<void>;     // never throws
}
```

Failures the user can act on are thrown as `new PipelineStepError("preparing", message, { cause })` (00 §14.7 signature; the `GitCommandError` with its `code` is the `cause`). `fetch` receives `{ signal, timeoutMs }`; 07 passes no options to the other git calls, which are bounded by 04's per-method timeouts. `input.signal.throwIfAborted()` runs before each numbered step and before each git call, so an abort takes effect at the next call boundary.

Symlink rule for everything this service writes inside a worktree: the worktree content comes from the repository (for PRs, from an untrusted author), so any path component may be a committed symlink. This service never creates, copies into or removes through a path whose existing components were not checked with `lstat`. The helper `ensureRealDir(root, relDir)` walks `relDir` one component at a time from `root`: an existing component must be a real directory (`lstat().isDirectory()` and not a symlink), a missing one is created with a non-recursive `fs.mkdir`; it returns `null` instead of the absolute path when a component is a symlink or a non-directory.

`gitErrorSummary(e)` returns:

- `"timed out"` for code `timeout`;
- `"aborted"` for code `aborted`;
- otherwise the first two non-empty lines of the already-redacted `stderr`, joined with " / " and capped at 300 characters, falling back to `exit code N`.

#### 5.13.1 `prepare()` — common steps

1. **Paths.** `root = artifacts.visualizationWorktreeRoot(id)`, `baseDir = artifacts.worktreeDir(id, "base")`, `headDir = artifacts.worktreeDir(id, "head")`.
2. **Leftovers.** If `root` exists (`lstat`) from an earlier crashed attempt, run `await this.cleanup({ visualizationId: id, repositoryPath: localPath, prNumber })`. Then `artifacts.ensureDir(root)`.
3. **Repository sanity.**
   - If `fs.stat(localPath)` fails, throw PSE "The repository folder <path> no longer exists."
   - If `git.topLevel(localPath)` fails, throw PSE "<path> is no longer a git repository."
4. Run `git.worktreePrune(localPath)` as best effort. This drops stale registrations that would otherwise make `worktree add` fail with `worktree_exists`.
5. **Resolve commits** for the source type (§5.13.2–§5.13.4). The result is `{ baseSha, headCommit, headSha }`.
6. **Worktrees.** Run `git.worktreeAdd(localPath, baseDir, baseSha)`, then `git.worktreeAdd(localPath, headDir, headCommit)`. Both are detached, with hooks disabled (04).
   - On `GitCommandError`, throw PSE "Could not create a git worktree: {summary}".
   - 04 sets `GIT_LFS_SKIP_SMUDGE=1`, so LFS-tracked files appear as pointer files. If the head worktree's `.gitattributes` contains `filter=lfs`, warn "This repository uses Git LFS; LFS files (e.g. images) are not downloaded and may render as broken."
7. **Working-tree overlay**, for working_tree only (§5.13.4).
8. **Vite root and node_modules symlink.** `viteRootRel = repository.viteConfigPath === null ? "." : path.posix.dirname(repository.viteConfigPath)` (`"."` for every repository 06 can register today; 00 §14.7). For each side:
   - `viteRoot = viteRootRel === "." ? side : await ensureRealDir(side, viteRootRel)`; `null` → throw PSE "The Vite root {viteRootRel} is a symbolic link in this checkout; PRVision only renders projects whose Vite root is a real folder."
   - For `link` in `<side>/node_modules` and, when `viteRootRel !== "."`, `<viteRoot>/node_modules`: if `lstat(link)` finds something (a committed node_modules or symlink, which is rare), keep it and warn "The repository contains a node_modules entry; using it as-is on <side>." Otherwise `fs.symlink(path.join(localPath, "node_modules"), link, "dir")`.
9. **Dependency drift.** Compute `drift = compareDependencies(readJsonOrNull(base/package.json), readJsonOrNull(head/package.json))`. If `drift.any`, emit the console warning listed in §7.
10. **Harness templates.** If `deps.harnessTemplatesDir` is missing, throw PSE "Harness templates are missing at <path>; the PRVision installation is incomplete." For each side, with `dest = <viteRoot>/.prvision-harness` (00 §14.7; Vite `cacheDir` lives inside it, sheet 10):
    - If `lstat(dest)` finds anything, the repository committed its own `.prvision-harness`: a symlink or file is `unlink`ed, a real directory is removed with `fs.rm(dest, { recursive: true, force: true })` (which never follows symlinks inside it). Console warn "The repository contains a .prvision-harness entry; it was replaced on <side>." Without this, a committed `.prvision-harness -> ~/.ssh` symlink would make the copy below, and sheet 10's harness writes, land outside the worktree.
    - `fs.mkdir(dest)` (non-recursive: fails if something re-appeared), then `fs.cp(deps.harnessTemplatesDir, dest, { recursive: true, force: false, errorOnExist: true, dereference: false })`.
    Sheet 10 owns the template contents.
11. **Environment files.** `.env*` files are gitignored, so they are not in the worktrees, and they are deliberately **not** copied. The head worktree is the Claude Code provider's `workingDirectory` (00 §8), so copying them would expose secrets to the AI. Console info: "Note: .env files are not copied into the render workspace."
12. **Return** `{ visualizationId: id, repositoryPath: localPath, baseDir, headDir, baseSha, headSha, sourceType, dependencyDrift: drift.any }`. `baseSha` is the merge-base for `github_pr` and `local_branch` (00 §14.7), so `baseSha..headSha` is exactly the change under review.

#### 5.13.2 github_pr

1. If `githubOwner` or `githubRepo` is null, throw PSE "This repository has no github.com remote."
2. Read `secret = await readGithubToken()`. If it is not `present`, throw PSE "GitHub token is missing or unreadable. Add it in Settings."
3. Run `pr = await githubClientFactory(secret.value).getPullRequest(owner, repo, n)`. On `GitHubClientError`, throw PSE with the message from `githubErrorToApiResponse(error, { owner, repo, pullNumber: n }).error` (always a string for GitHub errors), so the wording comes from 06.
4. Console:
   - `info` "PR #n: {title} ({baseRef} ← {headRef}), head {short sha}."
   - If `pr.state === "closed"`, `info` "This pull request is closed{ and merged}; visualizing its last head commit."
   - If `pr.isFork`, `warn` "This pull request comes from a fork ({headRepoFullName ?? "deleted fork"}). Rendering runs its code, including vite.config, on this machine."
5. If `!isValidGitBranchName(pr.baseRef)`, throw PSE "GitHub returned a base branch name PRVision cannot use: {baseRef}."
6. **Fetch** both refs in one command through the auth chain (§5.13.5), with `refspecs = [\`+refs/pull/${n}/head:${prRef(n)}\`, \`+refs/heads/${pr.baseRef}:${prBaseRef(n)}\`]`.
7. Read `headSha = await git.revParse(localPath, prRef(n))`. If `headSha !== pr.headSha`, warn "The PR was updated after it was loaded; using the fetched head {short}."
8. Set `baseTip = (await git.hasCommit(localPath, pr.baseSha)) ? pr.baseSha : await git.revParse(localPath, prBaseRef(n))`. When the fallback is used (the base branch was force-pushed), warn "The PR base commit is not available; using the current tip of {baseRef}."
9. Set `baseSha = await git.mergeBase(localPath, baseTip, headSha)`. This matches GitHub's three-dot "Files changed" view. On `no_merge_base`, throw PSE "The pull request head and base share no history (is the clone shallow? run git fetch --unshallow)."
10. Return `{ baseSha, headCommit: headSha, headSha }`.

#### 5.13.3 local_branch

1. Read `baseTip = await git.revParse(localPath, \`refs/heads/${baseRef}\`)` and `headSha = await git.revParse(localPath, \`refs/heads/${headRef}\`)`. On `unknown_revision`, throw PSE "Branch \"{name}\" no longer exists."
2. Set `baseSha = await git.mergeBase(localPath, baseTip, headSha)`. On `no_merge_base`, throw PSE "Branches {head} and {base} share no history (is the clone shallow? run git fetch --unshallow)."
3. If `baseSha === headSha`, warn "{head} has no commits that are not already in {base}; nothing will differ." This is not fatal: 08 finds no changes, every later stage has nothing to do, and 11 writes its fixed summary.
4. Console `info` "Comparing {head} ({short head}) against its merge-base with {base} ({short base})."
5. Return `{ baseSha, headCommit: headSha, headSha }`.

#### 5.13.4 working_tree

1. Read `baseSha = await git.revParse(localPath, "HEAD")`.
2. Snapshot the user's changes from their clone. These calls are read-only, and 04 sets `GIT_OPTIONAL_LOCKS=0`, so no `index.lock` is taken.
   - `patch = await git.diffBinaryHead(localPath)`. This covers staged and unstaged changes to tracked files against HEAD, including deletions, renames and mode changes. If it fails with `output_too_large`, throw PSE "The uncommitted diff is larger than 64 MB."
   - `untracked = (await git.lsUntracked(localPath)).filter((p) => isSafeRelativePath(p) && !EXCLUDED_FIRST_SEGMENTS.has(p.split("/")[0] ?? ""))`, where `EXCLUDED_FIRST_SEGMENTS = new Set(["node_modules", ".git", ".prvision-harness"])`.
3. If `untracked.length > WORKING_TREE_MAX_UNTRACKED_FILES`, throw PSE "There are more than 2,000 untracked files. Add build output to .gitignore."
4. If the patch is blank and there are no untracked files, throw PSE "The working tree has no uncommitted changes anymore."
5. Once the worktrees exist (common step 6), **apply the overlay in `headDir`**:
   1. If the patch is non-blank, run `git.applyPatch(headDir, patch)`. On `patch_failed`, throw PSE "Could not apply your uncommitted changes to a clean checkout: {summary}". Submodule changes cannot cause it: 04's `diffBinaryHead` passes `--ignore-submodules=all` (00 §14.8).
   2. Copy each untracked path `rel` (`git apply` already refuses to write through symlinks; the copy below must not either):
      - Resolve `src = path.join(localPath, rel)` and `dest = resolveInside(headDir, rel)` (04 `paths.ts`).
      - Run `st = await fs.lstat(src)`. If the file has vanished, skip it.
      - Keep a running total of `st.size`. If it goes over `WORKING_TREE_MAX_UNTRACKED_BYTES`, throw PSE "Untracked files exceed 200 MB."
      - `destDir = await ensureRealDir(headDir, path.posix.dirname(rel))`. `null` (a parent folder is a committed symlink or a file in the clean checkout) → skip and warn "Skipped {rel} (its folder is not a real folder in the checkout)." Never `mkdir -p` through the path, because it would follow a symlinked parent out of the worktree.
      - If `lstat(dest)` finds anything, skip and warn "Skipped {rel} (already exists in the checkout)."
      - Regular file: `fs.copyFile(src, dest, fs.constants.COPYFILE_EXCL)`, then `fs.chmod(dest, st.mode & 0o777)`.
      - Symlink: read `target = await fs.readlink(src)`. If `target` is relative and `isPathInside(localPath, path.resolve(path.dirname(src), target))`, run `fs.symlink(target, dest)`. Otherwise skip it and warn "Skipped symlink {rel} (points outside the repository)."
      - Anything else (directory entries, FIFO, socket): skip it.
   3. Console `info` "Applied uncommitted changes: {k} tracked file change(s), {m} untracked file(s)." `k` is the number of `diff --git ` headers in the patch.
6. Return `{ baseSha, headCommit: baseSha, headSha: null }`.

`isSafeRelativePath(p)` passes `p` through 04's `normalizeRepoRelativePath`. That function throws on an absolute path, a NUL byte, an empty path or a `..` segment; `isSafeRelativePath` catches the throw and returns `false`.

#### 5.13.5 Fetch auth chain

```ts
interface FetchAttempt { label: string; remote: string; auth?: GitAuthHeader; }

private async fetchWithAuthChain(input: { localPath: string; owner: string; repo: string; token: string; refspecs: string[];
  prNumber: number; console: PipelineContext["console"]; signal: AbortSignal }): Promise<void> {
  const httpsUrl = `https://github.com/${input.owner}/${input.repo}.git`;
  const remoteName = await this.findGithubRemoteName(input.localPath, input.owner, input.repo);   // "upstream" | "origin" | null
  const attempts: FetchAttempt[] = [
    { label: remoteName ? `remote "${remoteName}" (your SSH key or public access)` : "github.com (public access)", remote: remoteName ?? httpsUrl },
    // 06 returns the headers in the order to try them (Basic x-access-token, then Bearer); never index the array.
    ...GitHubClient.gitAuthHeaders(input.token).map((auth, index) => ({
      label: index === 0 ? "the GitHub token" : `the GitHub token (alternative auth ${index + 1})`, remote: httpsUrl, auth,
    })),
  ];
  let last: GitCommandError | null = null;
  for (const attempt of attempts) {
    input.signal.throwIfAborted();
    try {
      await this.deps.git.fetch(input.localPath, { remote: attempt.remote, refspecs: input.refspecs, auth: attempt.auth },
        { signal: input.signal, timeoutMs: GIT_FETCH_TIMEOUT_MS });
      await input.console.info("preparing", `Fetched pull request #${input.prNumber} using ${attempt.label}.`);
      return;
    } catch (error) {
      if (!(error instanceof GitCommandError) || error.code === "aborted") throw error;
      last = error;
      this.log.warn({ event: "workspace.fetch.attempt_failed", attempt: attempt.label, code: error.code, exitCode: error.exitCode }, "PR fetch attempt failed");
      await input.console.warn("preparing", `Fetching with ${attempt.label} failed: ${gitErrorSummary(error)}`);
    }
  }
  throw new PipelineStepError("preparing",
    `Could not fetch pull request #${input.prNumber} from GitHub (${last ? gitErrorSummary(last) : "unknown error"}). ` +
    "Check your SSH access, or give the GitHub token Contents: Read access to this repository.",
    { code: last?.code, cause: last ?? undefined });
}
```

How the attempts work:

- **Attempt 1** uses the user's own access: SSH keys or an agent for SSH remotes, or anonymous access for public repos. 04 disables `credential.helper` and terminal prompts, so this attempt fails fast instead of prompting. An HTTPS remote that depends on a credential helper effectively goes straight to the token attempts.
- **Attempts 2 and 3** use the PAT:
  - 06 builds the header (`gitAuthHeaders`), scoped to `https://github.com/`.
  - 04 passes it through `GIT_CONFIG_*` env, so it never appears in argv, logs, labels or console messages.
  - The order comes from 06 (`gitAuthHeaders`): Basic `x-access-token`, which every GitHub token type accepts for git over HTTPS, then Bearer.
  - A failed attempt is logged with `{ attempt: label, code, exitCode }` only; `label` never contains the token or the header.
  - Fetch is bounded by `GIT_FETCH_TIMEOUT_MS` per attempt (three attempts at most) and aborts on `input.signal`; an `aborted` error is rethrown immediately (no further attempts).
- `findGithubRemoteName` checks `["upstream", "origin"]` and returns the first remote whose `git.remoteUrl(localPath, name)` parses (06 `parseGithubRemoteUrl`) to the same owner/repo, compared case-insensitively.

#### 5.13.6 `compareDependencies`

```ts
export interface DependencyDrift { any: boolean; added: string[]; removed: string[]; changed: string[]; }

/** Union of dependencies/devDependencies/peerDependencies/optionalDependencies, name → spec. */
export function compareDependencies(basePkg: unknown, headPkg: unknown): DependencyDrift {
  const base = collectDeps(basePkg);
  const head = collectDeps(headPkg);
  if (base === null && head === null) return { any: false, added: [], removed: [], changed: [] };
  if (base === null || head === null) return { any: true, added: [], removed: [], changed: ["package.json"] };
  const added = [...head.keys()].filter((k) => !base.has(k)).sort();
  const removed = [...base.keys()].filter((k) => !head.has(k)).sort();
  const changed = [...head.keys()].filter((k) => base.has(k) && base.get(k) !== head.get(k)).sort();
  return { any: added.length + removed.length + changed.length > 0, added, removed, changed };
}
```

`collectDeps` returns `null` for a missing or invalid package.json. Moving a package between dependency groups with the same spec is not drift, and neither is a change to the lockfile only.

#### 5.13.7 `cleanup()`

`cleanup()` never throws: every step is in its own try/catch and logs a warning on failure.

1. For each side, `head` then `base`: for `<side>/node_modules` and, when the Vite root is a subfolder, `<side>/<viteRootRel>/node_modules` (reached only through components that `lstat` as real directories): if `lstat` says symlink, `unlink` it first. `fs.rm` never follows symlinks, so this is defence in depth; it guarantees that nothing in step 2 or 3 can reach the user's `node_modules`.
2. If `repositoryPath` is non-null and is a directory:
   - run `git.worktreeRemove(repositoryPath, sideDir)` for each side (idempotent);
   - run `git.worktreePrune(repositoryPath)`;
   - if `prNumber !== null`, run `git.deleteRef(repositoryPath, prRef(n))` and `git.deleteRef(repositoryPath, prBaseRef(n))` (00 §14.7: both refs are removed after every run). A missing ref is ignored. Runs are sequential (worker concurrency 1), so another run of the same PR cannot be using these refs at this moment.
3. Run `artifacts.removeVisualizationWorktreeRoot(visualizationId)`. This is 04's guarded rm, which only ever touches `worktrees/<int>`.
4. Log at info: `{ visualizationId, durationMs }` "Workspace cleaned".

## 6. Error handling and edge cases

| Situation | Behaviour |
|---|---|
| Create with an unknown or deleted repository | 404 `not_found` |
| Create while AI is not configured (no key, unreadable key, Claude SDK missing) | 400 `ai_not_configured` (message from 05 readiness) |
| github_pr on a repository with no GitHub remote | 400 `no_github_remote` |
| github_pr with no token, or a token that cannot be decrypted | 400 `github_token_missing` |
| github_pr with a bad token, a missing PR, a rate limit, or GitHub down | 06 mapping: 400 `github_unauthorized` / 404 `not_found` / 429 `github_rate_limited` / 502 `github_unavailable` |
| github_pr with `baseRef` in the body | Accepted (format-checked) and ignored; the PR base is used |
| Body with `title`, `headBranch` or any other unknown key | 400 `validation_failed` |
| local_branch with base equal to head (including a defaulted base) | 400 `validation_failed` |
| local_branch naming a missing branch | 400 `validation_failed` |
| Branch names with `..`, a leading `-`, spaces, `#`, `@{`, `~`, `^`, `:` or non-ASCII | 400 `validation_failed` (DTO) |
| List with `status=queued,bogus` | 400 `validation_failed` |
| working_tree when the tree is clean | 400 `working_tree_clean` |
| working_tree becomes clean before the worker runs | `failed`: "The working tree has no uncommitted changes anymore." |
| Repository folder deleted | Create: 400 `not_git_repo`. Worker: `failed` with a folder-missing message. |
| Redis down at create | Row `failed` with the Redis message; 500 `internal_error` |
| Cancel of a terminal visualization | 409 `already_terminal` |
| Cancel of a queued visualization | 200 `{ id, status: "cancelled" }`; the job is removed |
| Cancel racing with worker pickup | The flag is set first; the pre-start check or 04's 1 s poll turns it into `cancelled`; the API returns 202 `cancel_requested` |
| Cancel racing with completion | The re-read in §5.4.5 step 5 returns 409 `already_terminal` and clears the flag; a cancel after the last checkpoint loses and the run completes |
| Cancel during a long AI call or render | 04 aborts `ctx.signal` within about 1 s; the provider or render aborts; `cancelled` with `failed_stage` = the active stage |
| A step ignores the abort | Abandoned after 30 s (`STEP_ABORT_GRACE_MS`); terminal write and cleanup still happen |
| Delete of a non-terminal visualization | 409 `conflict` |
| Double enqueue of the same id | `enqueueVisualization` is idempotent on `viz-<id>`; a duplicate delivery is skipped by `run()` because the row is no longer `queued` |
| Artifact removal fails during delete | 200; warning logged |
| Job for a row that is not queued, or is deleted | Skipped, with no writes |
| Worker crashes or is killed mid-run | Boot recovery marks it `failed` (`failed_stage` = the stage it was in) and cleans the worktrees |
| Graceful worker stop mid-run | `signal.reason === "shutdown"` → `failed` "Worker stopped…"; worktrees cleaned in `finally` |
| Redis flushed while rows are queued | Recovery sweep (or boot), after 60 s: `failed` "queued job was lost" |
| API dies between commit and enqueue | Same as above |
| Terminal write fails (DB down) | Logged at fatal; the recovery sweep fails the row once its job is no longer `active` |
| Run exceeds 45 minutes | `failed` "Stopped after 45 minutes (time limit)." |
| Zero candidates | Every stage runs with nothing to do; 11 writes its fixed summary; `completed` |
| All harnesses fail | Render and diff pass through with nothing to do; `completed`; the summary explains |
| Summary AI fails | `completed`, `summary_markdown` null, console error |
| AI auth revoked mid-run (harness stage) | `failed` with the credentials message (09 throws `PipelineStepError`) |
| PR updated between create and run | The fetched head is used, with a warning; `head_ref` is unchanged |
| PR base force-pushed | Falls back to the base branch tip, with a warning |
| PR from a deleted fork | `refs/pull/<n>/head` is still fetchable; fork warning |
| SSH key with a passphrase and no agent | Attempt 1 fails fast (no prompt); the token attempts follow |
| Private repo, token without Contents: Read | Every attempt fails; `failed` with an actionable message |
| Git hooks (husky etc.) | Never run (04 `core.hooksPath=/dev/null`) |
| Git LFS repository | Pointer files only; warning |
| Shallow clone where merge-base is missing | `failed` with an unshallow hint |
| Untracked symlink that escapes the repo | Skipped, with a warning |
| Patch that touches submodules | Submodule changes are left out of the patch (04's `diffBinaryHead` uses `--ignore-submodules=all`, 00 §14.8); the rest applies |
| Repository commits a `.prvision-harness` entry (dir or symlink) | Replaced before templates are copied; warning |
| Untracked file under a folder that is a committed symlink in the checkout | Skipped with a warning; nothing is written outside the worktree |
| package.json dependencies differ between sides | `dependencyDrift: true` and a warning; rendering uses the installed modules |
| Leftover worktree dir for the same id | Cleaned before prepare |
| Foreign folders in the worktrees root | Left alone and reported |
| Console insert fails | Logged; the pipeline continues |

## 7. Logging / console events

Logging uses pino via `createLogger(module)`. Never log the token, `auth` headers, patch content, `.env` contents or full harness sources.

Every call carries `event` (01 §5.8); the first column is the constant message.

| Log message | `event` | Level | Fields |
|---|---|---|---|
| Visualization queued | `visualization.job.queued` | info | `visualizationId, repositoryId, sourceType` |
| Enqueue failed | `visualization.enqueue.failed` | error | `visualizationId, err` |
| Job skipped (not queued, or missing) | `visualization.job.skipped` | warn | `visualizationId, status` |
| Stage transition | `visualization.stage.transition` | info | `visualizationId, from, to` |
| Run finished | `visualization.run.finished` | info | `visualizationId, outcome, durationMs, componentCount, changedCount` |
| Run failed (unknown error) | `visualization.run.failed` | error | `visualizationId, stage, err` |
| PR fetch attempt failed | `workspace.fetch.attempt_failed` | warn | `visualizationId, attempt (label), code, exitCode` |
| Workspace cleaned / cleanup step failed | `workspace.cleanup.completed` / `workspace.cleanup.step_failed` | info / warn | `visualizationId, step, err` |
| Boot recovery report | `visualization.recovery.boot_finished` | info | `failedRunning, failedLostQueued, cleanedWorktrees, skippedEntries` |
| Recovery sweep failed a row | `visualization.recovery.row_failed` | warn | `visualizationId, status, jobState` |
| Step did not stop after abort | `visualization.step.abandoned` | error | `visualizationId, stage, graceMs` |
| Cancel requested | `visualization.cancel.requested` | info | `visualizationId, status` |
| Cancel flag clear failed | `visualization.cancel.clear_failed` | warn | `visualizationId, err` |
| Row conflict on transition | `visualization.transition.conflict` | warn | `visualizationId, from, to` |
| Terminal write failed | `visualization.terminal_write.failed` | fatal | `visualizationId, err, originalErr` |
| Console event (mirror of every console row) / console insert failed | `visualization.console.event` / `visualization.console.insert_failed` | event level / warn | `visualizationId, stage, message` / `visualizationId, status, err` |
| Unhandled visualizations controller error | `visualizations.controller.unhandled` | error | `action, err` |

Console events written by this sheet (sheets 08–11 add their own through `ctx.console`). Every `stage` is a `VisualizationStatus` name (00 §14.4):

| Stage | Level | Message |
|---|---|---|
| queued | info | `Queued: {title}` |
| queued | info | `Your uncommitted changes are captured when the worker starts this visualization.` (working_tree only) |
| queued | error | `Could not queue the job (Redis unavailable).` |
| {current status} | info | `Cancellation requested. The run stops at the next checkpoint.` |
| cancelled | info | `Cancelled before the worker started.` |
| preparing | info | `Preparing workspace ({PR #n \| head vs base \| working tree}).` |
| preparing | info | `PR #{n}: {title} ({base} ← {head}), head {short}.` |
| preparing | info / warn | PR closed / PR from a fork (§5.13.2) |
| preparing | info / warn | `Fetched pull request #{n} using {label}.` / `Fetching with {label} failed: {summary}` |
| preparing | warn | PR head moved / PR base commit not available |
| preparing | info | `Comparing {head} ({short}) against its merge-base with {base} ({short}).` |
| preparing | warn | `{head} has no commits that are not already in {base}; nothing will differ.` |
| preparing | info | `Applied uncommitted changes: {k} tracked file change(s), {m} untracked file(s).` |
| preparing | warn | `Skipped symlink {rel} (points outside the repository).` / `Skipped {rel} (its folder is not a real folder in the checkout).` / `Skipped {rel} (already exists in the checkout).` |
| preparing | warn | `The repository contains a .prvision-harness entry; it was replaced on {side}.` / `The repository contains a node_modules entry; using it as-is on {side}.` |
| preparing | warn | `This repository uses Git LFS; LFS files (e.g. images) are not downloaded and may render as broken.` |
| preparing | warn | `Dependencies differ between base and head (added: {a}; removed: {r}; changed: {c}). Both sides use the node_modules installed in your clone, so components that use these packages may render inaccurately.` Each list is capped at 10 names, then "…and N more". |
| preparing | info | `Note: .env files are not copied into the render workspace.` |
| analyzing | info | `Analyzing changed files.` → `{f} changed file(s); {c} component(s) to render, {s} skipped.` |
| generating_harnesses | info | `Generating render harnesses for {n} component(s).` → `{ok} harness(es) ready, {failed} failed.` / `No components to generate harnesses for.` |
| rendering | info | `Rendering {n} component(s) on base and head.` / `Nothing to render.` → `{ok} of {n} component(s) rendered on every side they exist.` |
| diffing | info | `Comparing {n} render(s).` / `Nothing to compare.` |
| summarizing | info / error | `Writing the summary.` / `The summary could not be generated ({reason}). Renders and diffs are still available.` |
| completed | info | `Completed: {changed} of {total} component(s) changed visually.` |
| cancelled | warn | `Cancelled by user.` |
| failed | error | The `error_message` written to the row |
| {terminal status} | info | `Removing temporary worktrees.` |
| failed | error | `The worker restarted while this visualization was running. Start it again.` / `The worker lost track of this visualization (its job ended without a final status). Start it again.` / `The queued job was lost …` |

## 8. Security notes

- **The token never appears in argv, logs or the console.** 04 passes the auth header through `GIT_CONFIG_*` env, scoped to `https://github.com/`. 04 redacts `GitCommandError.stderr`. Every console message passes through `redactSecrets` centrally, and fetch-attempt labels never contain secrets.
- **Untrusted PR code runs locally.** Rendering a PR head executes its `vite.config.*`, plugins and component code with the user's privileges (sheet 10). PRs from forks get a console warning, and sheet 13 should show the same warning before creating a PR visualization from a fork. The prototype has no sandbox; the README documents this.
- **Git hooks never run** (04 sets `core.hooksPath=/dev/null`), so a PR cannot ship a hook that executes on checkout.
- **`.env` files are not copied.** Secrets in ignored env files never enter the workspace the AI provider can read.
- **Path safety.**
  - Deletion only goes through 04's guarded `removeVisualizationWorktreeRoot`.
  - `node_modules` symlinks are unlinked before any removal.
  - Nothing is written through a path component that is a symlink in the checkout (`ensureRealDir`, §5.13): a committed `.prvision-harness` or symlinked parent folder cannot redirect template copies, harness writes or untracked-file copies outside the worktree.
  - Untracked-file copying uses `resolveInside`, `COPYFILE_EXCL`, and refuses symlinks that point outside the repo.
  - Foreign entries (and symlinks) in the worktrees root are never deleted.
- **Option and revision injection.** Ref names are validated against `git check-ref-format --branch` rules ∩ 04's `SAFE_REF` charset (no leading `-`, no `..`, `@{`, `^`, `~`, `:`), existence-checked with `rev-parse --verify`, always passed as `refs/heads/<name>`, and 04 places them after `--end-of-options`. The display-only fork `head_ref` (`owner:branch`) is never passed to git.
- **Error text.** Messages stored in `error_message` and console events are user-facing sentences; raw exception messages appear only in the worker log (redacted by 04's serializer). API 500s never include exception text.
- **What PRVision writes in the user's clone:**
  - `refs/prvision/pr-<n>` and `refs/prvision/pr-<n>-base`, deleted after every run;
  - `.git/worktrees/*` metadata, which is pruned.

  `FETCH_HEAD` is not written (04's `fetch` passes `--no-write-fetch-head`, 00 §14.8).

  It never touches the working tree, index, HEAD, config or remote-tracking refs.

## 9. Tests

All tests use `node:test` + `node:assert/strict` in `tests/backend/visualizations/`:

- Service calls run inside `runWithAuthContext` (04 helper).
- Static `QueueService` methods are replaced with `patchStaticMethod`.
- Real-git integration tests use `helpers/temp-git-repo.ts`, which calls `execFileSync("git", …)` in test code only. They `skip` when `git --version` fails.

`visualization-create-dto.test.ts`:
- `accepts github_pr with prNumber, with and without baseRef`
- `rejects github_pr without prNumber, and with headRef`
- `accepts local_branch with headRef only, and with headRef + baseRef`
- `rejects local_branch with prNumber, or with baseRef equal to headRef`
- `accepts working_tree with no source fields; rejects any ref or prNumber`
- `rejects an unknown sourceType and an explicit null prNumber, headRef or baseRef`
- `rejects title, headBranch and baseBranch as unknown properties`
- `rejects a numeric-string repositoryId (no body coercion)`
- `isValidGitBranchName accepts feature/x, release-1.2, user+fix`
- `isValidGitBranchName rejects -x, a..b, "a b", fix#12, a~1, a^, a:b, a@{1}, x.lock, .hidden, trailing / and ., HEAD and non-ASCII`

`visualization-query-dto.test.ts`:
- `list query coerces page, pageSize and repositoryId; rejects pageSize 101`
- `list status parses "queued, rendering,,queued" to ["queued","rendering"] and ?status=a&status=b the same way`
- `list status rejects an unknown status and an empty value`
- `console query accepts afterId 0 and rejects limit 501 and a negative afterId`

`visualization-state-machine.test.ts`:
- `every non-terminal status can reach failed and cancelled`
- `terminal statuses have no outgoing transitions`
- `running stages are linear: preparing → analyzing → generating_harnesses → rendering → diffing → summarizing → completed`
- `analyzing cannot go to completed directly`
- `transitionVisualization guards on from-status and isDeleted`
- `transitionVisualization stamps startedAt on preparing and completedAt on terminal statuses`
- `transitionVisualization stamps failedStage = from on failed and cancelled, and not on completed`
- `transitionVisualization returns false on 404`
- `transitionVisualization throws VisualizationTransitionError for an illegal transition`

`visualizations-service.test.ts`:
- `create returns 404 for an unknown repository`
- `create returns 400 ai_not_configured when readiness is not ready`
- `create github_pr returns no_github_remote and github_token_missing (absent and unreadable)`
- `create github_pr maps GitHubClientError not_found to 404 not_found and rate_limited to 429 github_rate_limited`
- `create github_pr uses "#n title" as the title, the PR base as baseRef (ignoring dto.baseRef) and the fork label as headRef`
- `create local_branch defaults baseRef to the repository default and rejects equal branches`
- `create local_branch returns 400 when a branch does not exist`
- `create working_tree returns 400 working_tree_clean when isDirty is false`
- `create inserts queued with job_id viz-<id> in one transaction, then enqueues and returns 202 { visualizationId, jobId }`
- `create rolls back the insert when the job_id update fails`
- `create marks the row failed and returns 500 internal_error when enqueue throws`
- `list hides deleted visualizations and those of deleted repositories, filters by repositoryId and a status list, pages, and returns total`
- `get returns components ordered by rank, then id, with artifact URLs, changeReason, skipReason and failedStage`
- `console returns a bare array of events after afterId (exclusive), ascending, capped at limit`
- `cancel returns 409 already_terminal for completed, failed and cancelled`
- `cancel sets the flag, removes the queued job and returns 200 { id, status: "cancelled" }`
- `cancel treats a missing job as removable`
- `cancel returns 202 { id, status: "cancel_requested" } when the job is active, or when the queued→cancelled guard loses`
- `cancel returns 409 already_terminal and clears the flag when the run finished between the first read and the re-read`
- `remove returns 409 conflict while non-terminal; otherwise soft-deletes (conditioned on a terminal status), removes artifacts and returns 200 { id }`
- `remove returns 200 even when artifact removal throws`
- `every 500 response is { error: "Internal server error", error_reason: "internal_error" } without exception text`

`visualization-console-service.test.ts`:
- `append writes level, stage and message, and never throws when the insert fails`
- `messages are redacted (ghp_, github_pat_, sk-ant-, Authorization headers, URL credentials)`
- `ANSI and control characters are stripped; messages are capped at 4000 characters and stages at 64`

`visualization-worker-service.test.ts` (fake step factories, fixed `now`, short time limit and grace):
- `skips a missing visualization and a non-queued visualization without writes`
- `happy path writes statuses in order and completes with counts from the aggregate`
- `reads settings once and builds both the provider and ctx.aiSettings from that read`
- `snapshots ai_provider/ai_model and started_at on preparing; base_sha/head_sha on analyzing`
- `never writes ai_usage or summary_markdown`
- `passes analysis.sourceQueries to the harness factory and the same harness instance to the render repair adapter`
- `calls RenderService.renderAll(ctx, buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles)) using 10's helper`
- `repair adapter forwards the HarnessRenderError object and returns 09's HarnessRepairOutcome unchanged (results and verdicts)`
- `calls ImageDiffService.diff(ctx, renders), StructuralDiffService.compare(ctx, { renders, diffs, analysis }) and SummaryService.summarize(ctx, analysis)`
- `zero candidates still passes every stage, skips render and diff calls, and calls summarize`
- `cleanup runs after summarize resolves, never before` (worktrees alive during summarizing)
- `cancel flag set before start → queued → cancelled with failed_stage queued, with no prepare`
- `generateAll returning cancelled → cancelled with failed_stage generating_harnesses`
- `job signal aborted with reason "cancelled" during rendering → cancelled with failed_stage rendering`
- `job signal aborted with reason "shutdown" → failed "Worker stopped…", even when the step throws RunCancelledSignal or an AI aborted error`
- `timeout → failed with the time-limit message`
- `a step that ignores the abort is abandoned after the grace period and the run still ends and cleans up`
- `PipelineStepError → failed with userMessage and failed_stage = the active stage`
- `AiProviderError config from createProvider → queued → failed, with no prepare`
- `unknown error → generic message, error logged`
- `summary outcome failed → completed with a console error`
- `summary outcome cancelled → cancelled`
- `cleanup is called in finally for completed, failed and cancelled runs once prepare started, and not before prepare`
- `pending components are swept to skipped with a skip reason before every terminal write`
- `changed_count never exceeds component_count`
- `a lost transition guard stops the run without terminal writes`
- `clearCancel is called in finally`
- `every console stage written by the worker is a VisualizationStatus name`

`visualization-boot-recovery.test.ts`:
- `fails every active status with the restart message, failed_stage = its status, a console event at stage failed and the pending sweep`
- `fails queued rows older than the grace period whose job is missing, completed or failed`
- `leaves queued rows with waiting or active jobs, and recent rows, alone`
- `cleans numeric worktree dirs, including those of soft-deleted visualizations; leaves foreign entries and symlinks`
- `runs worktreePrune for every existing repository`
- `never throws when a step fails`
- `sweep fails an active row whose job is completed, failed or missing, and leaves the row of the active job alone`
- `sweep skips a tick while the previous one is still running; stop() clears the interval`

`workspace-prepare-service.test.ts` (fake GitClient + temp dirs):
- `github_pr fetches the pr-<n> and pr-<n>-base refspecs and uses merge-base(baseSha, head)`
- `github_pr tries the remote, then the headers from gitAuthHeaders in their order, and stops at the first success`
- `github_pr fails with an actionable message when every attempt fails; neither the message nor the labels contain the token`
- `github_pr falls back to the pr-<n>-base tip when baseSha is missing locally`
- `github_pr warns for forks and for closed PRs`
- `github_pr rejects a base branch name outside SAFE_REF`
- `local_branch uses the merge-base of the two branch tips and warns when head has no unique commits`
- `working_tree fails when there are no changes, on output_too_large, and over the untracked limits`
- `creates node_modules symlinks pointing at the user's node_modules`
- `copies harness templates into .prvision-harness on both sides; fails clearly when they are missing`
- `replaces a committed .prvision-harness symlink without writing through it` (the symlink target stays untouched)
- `skips untracked files whose parent folder is a symlink in the checkout, and never creates directories outside the worktree`
- `fails with a clear message when the Vite root folder is a symlink`
- `cleans a leftover root before preparing`
- `warns about LFS when .gitattributes contains filter=lfs`
- `compareDependencies detects added, removed and changed packages and ignores moves between groups`
- `cleanup unlinks node_modules symlinks first, removes worktrees, deletes both refs, prunes and removes the root`
- `prepare passes { signal, timeoutMs } to fetch and stops at the next call boundary after an abort`
- `cleanup never throws when git fails`

`workspace-prepare.integration.test.ts` (real git; skipped when git is missing):
- `local_branch: base and head worktrees are at the expected commits`
- `working_tree: head contains staged, unstaged and untracked changes; base equals HEAD`
- `working_tree: an untracked symlink escaping the repo is skipped`
- `after cleanup the clone has no extra worktrees, no refs/prvision/*, and an unchanged git status`
- `worktree creation does not run a post-checkout hook in the repo`

## 10. Acceptance criteria

- [ ] All six routes are registered exactly as in 00 §9, and the controller only validates and delegates (no `fs`, git, Drizzle, queue or GitHub calls in the controller).
- [ ] `POST /api/visualizations` with `{ repositoryId, sourceType, prNumber? | headRef? baseRef? }` returns 202 `{ status: 202, data: { visualizationId, jobId: "viz-<id>" } }` for each source type against the fixture repo; a body with `title` or `headBranch` returns 400 `validation_failed`. Every error case in §6 returns the listed status and `error_reason` (00 §14.2 codes only).
- [ ] `GET /api/visualizations?status=queued,rendering&repositoryId=<id>` returns only matching rows, paged; `GET /:id/console?afterId=<n>` returns a bare array, oldest first, excluding `<n>`, at most 500 items.
- [ ] The worker moves a fixture visualization through every stage in order, verified through console events whose `stage` values are all status names. `component_count`, `changed_count`, `started_at` and `completed_at` are set; `ai_usage` is set by 09/11's `AiUsageRecorder`; `summary_markdown` is set by 11.
- [ ] A run with no UI changes passes every stage and completes with 11's fixed summary.
- [ ] Cancelling during `generating_harnesses` returns 202 `cancel_requested` and ends in `cancelled` with `failed_stage = "generating_harnesses"` within about 2 s of the abort. Cancelling while queued returns 200 `cancelled` immediately, with the BullMQ job removed and `failed_stage = "queued"`. Cancelling a finished run returns 409 `already_terminal`.
- [ ] A failed run shows `failedStage` in `GET /api/visualizations/:id`; components carry `changeReason` / `skipReason`.
- [ ] Stopping the worker with Ctrl-C mid-run marks the row `failed` "Worker stopped…" and removes the worktrees. Killing it with SIGKILL and restarting marks the row `failed` with the restart message, leaving no `<dataDir>/worktrees/<id>` and no `refs/prvision/*` in the clone.
- [ ] After any run, `git worktree list` in the clone shows only the user's own worktrees, `git for-each-ref refs/prvision` is empty, and `git status --porcelain` output is unchanged.
- [ ] For `github_pr` and `local_branch`, `base_sha` equals `git merge-base <base tip> <head>` in the clone.
- [ ] working_tree mode renders staged, unstaged and untracked changes without touching the user's working copy.
- [ ] A PR from a private repo fetches with the user's SSH access, and with only the PAT when SSH is unavailable.
- [ ] Neither the token nor `AUTHORIZATION` appears in logs, console events, `error_message` or `ps -ef` output during a fetch (integration test greps all four).
- [ ] A fixture branch that commits `.prvision-harness` as a symlink to a temp dir renders without writing anything into that temp dir.
- [ ] `DELETE` returns 409 `conflict` for non-terminal visualizations and otherwise returns `200 { id }` and removes `<dataDir>/artifacts/<id>` (`ArtifactStore.removeVisualization`).
- [ ] No child process is spawned outside `GitClient`. No env is read outside `config-consts`. No `any`. Explicit return types. No floating promises.
- [ ] All tests in §9 pass.

## 11. Contract changes requested

Resolved:

1. Create request body — Resolved — 00 §14.4 (`headRef` / `baseRef`, no `title`; `baseRef` ignored for `github_pr`).
2. Response shapes — Resolved — 00 §14.4: cancel `200 { id, status: "cancelled" }` / `202 { id, status: "cancel_requested" }` / `409 already_terminal`; delete `200 { id }` / `409 conflict`; console returns `ConsoleEventView[]` oldest first, `afterId` exclusive, limit default and max 500; list `status` is comma-separated.
3. Sheet 10 render entry point — Resolved — 00 §14.7: 07 calls `new RenderService({ repairHarness }).renderAll(ctx, buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles))` exactly as 10 §5.13.1 defines, with 10's `buildRenderInputs` and a repair adapter that forwards the `HarnessRenderError` and returns `HarnessRepairOutcome` unchanged; Vite `cacheDir` inside `.prvision-harness/` (10 owns it).
4. `refs/prvision/pr-<n>-base` — Resolved — 00 §14.7 (both refs deleted after every run).
5. GitClient additions (`deleteRef`, `--no-write-fetch-head`, `diff.noprefix=false`, `--ignore-submodules=all`) — Resolved — 00 §14.8; 04 §9.5 provides them.
6. `HARNESS_TEMPLATES_DIR` constant — Resolved — 00 §14.8.
7. 08/09 hand-off — Resolved — 00 §14.7: `ChangeAnalysisResult.sourceQueries`; 07 passes `analysis.sourceQueries` to `new HarnessGenerationService(ctx, sourceQueries)`.
8. AI usage ownership — Resolved — 00 §14.7 (`AiUsageRecorder` is the only writer).
9. `error_reason` for a running visualization delete and duplicates — Resolved — 00 §14.2 (`conflict`).
10. Merge-base `baseSha` — Resolved — 00 §14.7.

Also resolved (Revision 2 final review):

11. **Module map (00 §7).** Resolved — 00 §14.12 (each sheet's file inventory is authoritative; lists `visualization-state-machine.ts`).
12. **GitClient additions in 04** — Resolved — 04 §9.5 now defines them. Originally requested: `deleteRef(cwd, ref)` (`update-ref -d --end-of-options <ref>`, ref under `refs/prvision/`, missing ref = success), `--no-write-fetch-head` on `fetch`, `-c diff.noprefix=false -c diff.mnemonicPrefix=false --ignore-submodules=all` on `diffBinaryHead`. 07 calls `deleteRef` with exactly that signature.
13. **Sheet 04 job processor signature (00 §14.6).** Resolved — 04 §9.4 now passes `{ visualizationId, jobId, signal }` (`VisualizationJob`, imported by 07) with `signal.reason = "cancelled" | "shutdown"`. (04 §9.4 previously defined `(data, ctx)` and aborted with `JobAbortedError`.) 07 codes against 00 §14.6.
14. **ArtifactStore names (00 §14.8 vs 04 §9.8).** Resolved — 00 §14.8 / §14.12: 04 §9.8 uses the 00 §14.8 names, and 07 calls `removeVisualization` (`removeVisualizationArtifacts` is a deprecated alias only). Besides it, 07 uses `toPublicUrl` and 04's worktree helpers `worktreesRoot`, `worktreeDir`, `visualizationWorktreeRoot`, `removeVisualizationWorktreeRoot`, `ensureDir` (04 §9.8).
15. **Settings access (05 §11 item 10).** Resolved — 07 uses `SettingsStore.readAiSettings()` + `AiProviderFactory.readiness(settings)` / `create(settings)`; the old `fromSettings()` / `loadAiSettings()` are gone.
