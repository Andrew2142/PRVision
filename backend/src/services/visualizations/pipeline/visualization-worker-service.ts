import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  MAX_COMPONENTS,
  QUEUED_RECOVERY_GRACE_MS,
  RECOVERY_BATCH_LIMIT,
  RECOVERY_SWEEP_INTERVAL_MS,
  RUNNING_RECOVERY_GRACE_MS,
  STEP_ABORT_GRACE_MS,
  VISUALIZATION_MAX_RUNTIME_MS
} from "../../../config-consts";
import {
  ACTIVE_VISUALIZATION_STATUSES,
  ComponentChangeKind,
  ComponentHarnessOrigin,
  ComponentRenderStatus,
  ConsoleLevel,
  HarnessLibraryOrigin,
  HarnessLibraryStatus,
  Table,
  VisualizationSourceType,
  VisualizationStatus,
  type RepositoryFramework,
  type TerminalVisualizationStatus
} from "../../../enums";
import { RepositoryModel, VisualizationModel } from "../../../models";
import {
  identityKey,
  type HarnessLibraryEntryRecord,
  type HarnessLibraryStorePort,
  type HarnessStateSpec,
  type SideHarnessPlan
} from "../../../types/harness-library";
import {
  AiProviderError,
  isPipelineStepError,
  PipelineStepError,
  type AiProvider,
  type AiUsage,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type ComponentRenderResult,
  type HarnessGenerationBatchResult,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type MockedModule,
  type PipelineContext,
  type PreparedWorkspace,
  type RenderFailureKindValue,
  type SideHarness,
  type WorktreeSide
} from "../../../types/visualization-pipeline";
import {
  AiProviderFactory,
  ArtifactStore,
  DrizzleDb,
  GitClient,
  GitCommandError,
  QueryHandler,
  QueueService,
  Where,
  createLogger,
  redactSecrets,
  addUsage,
  type ResolvedAiSettings,
  type Transaction,
  type VisualizationJob
} from "../../../utilities";
import { HarnessLibraryStore } from "../../harness-library/harness-library-store";
import { LibraryFingerprinter } from "../../harness-library/library-fingerprint";
import { SettingsStore } from "../../settings/settings-store";
import { VisualizationConsoleService } from "../visualization-console-service";
import { transitionVisualization, type VisualizationTransitionFields } from "../visualization-state-machine";
import { readConfinedText } from "./change-source";
import { stepFactoriesFor } from "./frameworks";
import { capText, HARNESS_NOTES_MAX_CHARS } from "./harness-generation-service";
import { extractHarnessStates } from "./harness-states";
import { newHarnessPauseMessage } from "./library-resolution-service";
import { isReplacedCandidate } from "./replaced-components";
import { isRepairableFailure } from "./render/render-errors";
import {
  buildRenderInputs,
  QueryHandlerRenderPersistence,
  type ComponentRenderPayload,
  type ComponentRenderPersistence
} from "./render-service";
import {
  type HarnessGenerationStage,
  type LibraryResolutionResult,
  type PipelineStepFactories,
  type RepairHarnessFn
} from "./stage-registry";
import { defaultSnapshotsRoot, removeSnapshotTemps, WorkspacePrepareService } from "./workspace-prepare-service";

// ---------------------------------------------------------------------------------------------------------------
// Errors and pure helpers (07 §5.9.1)
// ---------------------------------------------------------------------------------------------------------------

/** Abort reason of the overall limit (00 §14.6; 90 minutes since 16 §16.3). */
export class VisualizationTimeoutError extends Error {
  constructor(readonly limitMs: number) {
    super("Visualization timed out");
    this.name = "VisualizationTimeoutError";
  }
}

/** A guarded transition matched 0 rows: another writer (API cancel, recovery) owns the row now. */
export class VisualizationRowConflictError extends Error {
  constructor(
    readonly visualizationId: number,
    readonly from: VisualizationStatus,
    readonly to: VisualizationStatus
  ) {
    super(`Visualization ${visualizationId} was not in status ${from} (wanted ${to})`);
    this.name = "VisualizationRowConflictError";
  }
}

/** Thrown by checkpoints and when a step reports cancellation. Exported for tests only. */
export class RunCancelledSignal extends Error {
  constructor() {
    super("cancelled");
    this.name = "RunCancelledSignal";
  }
}

/** A step did not settle within STEP_ABORT_GRACE_MS after the run signal aborted. Exported for tests only. */
export class StepAbandonedError extends Error {
  constructor() {
    super("step abandoned after abort");
    this.name = "StepAbandonedError";
  }
}

/** What the worker writes for a run that did not complete (07 §5.9.6). */
export interface RunFailureClassification {
  status: "failed" | "cancelled";
  errorMessage: string | null;
  /** True for the generic "Unexpected error" row: the error is logged at error level with `err`. */
  unexpected: boolean;
}

const WORKER_STOPPED_MESSAGE = "Worker stopped before the visualization finished. Start it again.";
const AI_AUTH_MESSAGE = "The AI provider rejected the credentials. Check Settings → AI and run Test connection.";
const SHORT_MESSAGE_MAX_LENGTH = 200;
const MS_PER_MINUTE = 60_000;

/**
 * Maps a run failure to the terminal status and error message (07 §5.9.6). The abort reason is checked first,
 * because an abort can surface as many error types; shutdown and timeout come before cancellation so a
 * RunCancelledSignal thrown by a checkpoint after a shutdown/timeout abort is not reported as a user cancel.
 *
 * @param error - What the run threw.
 * @param abortReason - `signal.reason` of the run signal (undefined when not aborted).
 * @param cancelFlagSet - Whether the Redis cancel flag is set.
 * @param activeStatus - The status that was active when the run failed.
 */
export function classifyRunFailure(
  error: unknown,
  abortReason: unknown,
  cancelFlagSet: boolean,
  activeStatus: VisualizationStatus
): RunFailureClassification {
  if (abortReason === "shutdown") {
    return { status: "failed", errorMessage: WORKER_STOPPED_MESSAGE, unexpected: false };
  }
  if (abortReason instanceof VisualizationTimeoutError) {
    const minutes = Math.round(abortReason.limitMs / MS_PER_MINUTE);
    return { status: "failed", errorMessage: `Stopped after ${minutes} minutes (time limit).`, unexpected: false };
  }
  if (abortReason === "cancelled" || error instanceof RunCancelledSignal || cancelFlagSet) {
    return { status: "cancelled", errorMessage: null, unexpected: false };
  }
  if (isPipelineStepError(error)) {
    return { status: "failed", errorMessage: error.userMessage, unexpected: false };
  }
  if (error instanceof AiProviderError) {
    if (error.reason === "auth") {
      return { status: "failed", errorMessage: AI_AUTH_MESSAGE, unexpected: false };
    }
    if (error.reason === "config") {
      return { status: "failed", errorMessage: `AI is not configured: ${shortErrorMessage(error)}`, unexpected: false };
    }
    return { status: "failed", errorMessage: `AI request failed (${error.reason}). Try again.`, unexpected: false };
  }
  if (error instanceof GitCommandError) {
    const firstLine = error.stderr.split("\n").find((line) => line.trim() !== "") ?? "";
    return {
      status: "failed",
      errorMessage: `A git command failed (${error.code}): ${firstLine.trim().slice(0, SHORT_MESSAGE_MAX_LENGTH)}`,
      unexpected: false
    };
  }
  return {
    status: "failed",
    errorMessage: `Unexpected error during ${activeStatus}. See the worker log for details.`,
    unexpected: true
  };
}

/** Redacted first line of an error message, at most 200 characters. */
export function shortErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = redactSecrets(message).split("\n")[0] ?? "";
  return firstLine.slice(0, SHORT_MESSAGE_MAX_LENGTH);
}

/** "PR #12", "feature/x vs main", "working tree" or "commits a1b2c3d…e4f5a6b on feature/x". */
export function describeSource(
  v: Pick<VisualizationModel, "sourceType" | "prNumber" | "baseRef" | "headRef" | "baseSha" | "headSha">
): string {
  switch (v.sourceType) {
    case VisualizationSourceType.GITHUB_PR:
      return `PR #${String(v.prNumber)}`;
    case VisualizationSourceType.LOCAL_BRANCH:
      return `${v.headRef} vs ${v.baseRef}`;
    case VisualizationSourceType.WORKING_TREE:
      return "working tree";
    case VisualizationSourceType.COMMIT_RANGE:
      return `commits ${(v.baseSha ?? "?").slice(0, 7)}…${(v.headSha ?? "?").slice(0, 7)} on ${v.headRef}`;
  }
}

/**
 * Adapter to 10's RepairHarnessFn. 10 owns when to repair and persists the attempt it keeps; 09's repairHarness
 * never persists (00 §14.7). The HarnessRenderError object is forwarded and the HarnessRepairOutcome returned
 * unchanged (10 needs the verdicts' notesAppendix, 10 §5.13.1).
 */
export function toRepairHarnessFn(harnessService: Pick<HarnessGenerationStage, "repairHarness">): RepairHarnessFn {
  return (
    componentId: number,
    previous: HarnessGenerationResult,
    renderError: HarnessRenderError
  ): Promise<HarnessRepairOutcome> => harnessService.repairHarness(componentId, previous, renderError);
}

// ---------------------------------------------------------------------------------------------------------------
// Library save-back helpers (16 §8.7 steps 4 and 6)
// ---------------------------------------------------------------------------------------------------------------

/** One side of one row's render over every state (16 E5). */
export interface SideRenderOutcome {
  /** At least one state rendered or failed on that side. */
  present: boolean;
  /** Present and every state rendered on that side. */
  allOk: boolean;
  /** The first failing state's error on that side (any kind). */
  firstError: string | null;
  /** The first failure with a harness-attributable kind (module_load, render_error, timeout, step_failed). */
  harnessError: string | null;
}

/** Evaluates one side of a render result over its states (Default only when `states` is empty). */
export function sideRenderOutcome(render: ComponentRenderResult, side: WorktreeSide): SideRenderOutcome {
  const states =
    render.states.length > 0
      ? render.states
      : [{ ordinal: 0, stateName: "Default", base: render.base, head: render.head }];
  let present = false;
  let failed = false;
  let firstError: string | null = null;
  let harnessError: string | null = null;
  for (const state of states) {
    const result = state[side];
    if (result === null) {
      continue;
    }
    present = true;
    if (result.ok) {
      continue;
    }
    failed = true;
    const prefix = state.stateName === "Default" ? "" : `State "${state.stateName}": `;
    const message = `${prefix}${result.error ?? "render failed"}`;
    firstError ??= message;
    if (result.failureKind !== null && isHarnessAttributable(result.failureKind)) {
      harnessError ??= message;
    }
  }
  return { present, allOk: present && !failed, firstError, harnessError };
}

/** 16 E5: module_load, render_error, timeout and step_failed blame the harness; the rest is infrastructure. */
export function isHarnessAttributable(kind: RenderFailureKindValue): boolean {
  return isRepairableFailure(kind);
}

/** Notes of a reused harness (16 §8.7 step 4): the entry's notes prefixed with its library revision. */
export function reusedHarnessNotes(entry: Pick<HarnessLibraryEntryRecord, "notes" | "revision">): string {
  const prefix = `From the harness library (revision ${String(entry.revision)}).`;
  return capText(entry.notes.trim() === "" ? prefix : `${prefix}\n${entry.notes}`, HARNESS_NOTES_MAX_CHARS);
}

/** A saved harness as the side harness of a run row (origin library, the entry id and states). */
export function sideHarnessFromEntry(entry: HarnessLibraryEntryRecord): SideHarness {
  return {
    harnessSource: entry.harnessSource ?? "",
    mockedModules: entry.mockedModules,
    notes: reusedHarnessNotes(entry),
    states: entry.states,
    origin: "library",
    libraryEntryId: entry.id
  };
}

/**
 * Joins written and reused harnesses into one HarnessGenerationResult per row that reaches rendering (16 §8.7
 * step 4): reused sides come from their entries; a `replaced` row with one reused side gets the other side from
 * generation (whose placeholder side is replaced). Rows whose written side failed generation get no result.
 */
export function mergeRunHarnesses(
  resolution: Pick<LibraryResolutionResult, "plans" | "renderCandidates" | "toWrite">,
  written: readonly HarnessGenerationResult[]
): HarnessGenerationResult[] {
  const byId = new Map(written.map((result) => [result.componentId, result]));
  const writes = new Map(resolution.toWrite.map((row) => [row.candidate.componentId, row.sides]));
  const out: HarnessGenerationResult[] = [];
  for (const candidate of resolution.renderCandidates) {
    const plans = resolution.plans.get(candidate.componentId) ?? [];
    const generated = byId.get(candidate.componentId);
    const writeSides = writes.get(candidate.componentId) ?? [];
    if (writeSides.length > 0 && generated === undefined) {
      continue; // generation failed or was skipped for a side this row needs
    }
    const reused = (side: WorktreeSide): HarnessLibraryEntryRecord | null =>
      plans.find((plan) => plan.side === side && plan.entry !== null)?.entry ?? null;
    if (isReplacedCandidate(candidate)) {
      const headEntry = reused("head");
      const baseEntry = reused("base");
      const head: SideHarness | null =
        headEntry !== null
          ? sideHarnessFromEntry(headEntry)
          : generated !== undefined
            ? topLevelHarness(generated)
            : null;
      const base: SideHarness | null =
        baseEntry !== null ? sideHarnessFromEntry(baseEntry) : (generated?.baseHarness ?? null);
      if (head === null || base === null) {
        continue;
      }
      out.push({
        componentId: candidate.componentId,
        ...head,
        baseHarness: base,
        ...(generated?.usage !== undefined ? { usage: generated.usage } : {})
      });
      continue;
    }
    const entry = plans.find((plan) => plan.entry !== null)?.entry ?? null;
    if (entry !== null) {
      out.push({ componentId: candidate.componentId, ...sideHarnessFromEntry(entry) });
    } else if (generated !== undefined) {
      out.push(generated);
    }
  }
  return out;
}

function topLevelHarness(result: HarnessGenerationResult): SideHarness {
  return {
    harnessSource: result.harnessSource,
    mockedModules: result.mockedModules,
    notes: result.notes,
    states: result.states,
    origin: result.origin,
    libraryEntryId: result.libraryEntryId
  };
}

/** Wraps the run's render persistence and remembers the last payload per component (kept repaired harnesses). */
class RecordingRenderPersistence implements ComponentRenderPersistence {
  readonly payloads = new Map<number, ComponentRenderPayload>();

  constructor(private readonly inner: ComponentRenderPersistence) {}

  async saveRenderResult(componentId: number, payload: ComponentRenderPayload): Promise<void> {
    await this.inner.saveRenderResult(componentId, payload);
    this.payloads.set(componentId, payload);
  }
}

/** Everything the library save-back needs from one run (16 §8.7 step 6). */
interface SaveBackInput {
  ctx: PipelineContext;
  resolution: LibraryResolutionResult;
  batch: HarnessGenerationBatchResult;
  renders: readonly ComponentRenderResult[];
  /** Successful fix-up results by `<componentId>:<side>` (the side whose harness was repaired). */
  repairs: ReadonlyMap<string, HarnessGenerationResult>;
  /** Render payloads as persisted (the repaired harness when the repaired attempt was kept). */
  payloads: ReadonlyMap<number, ComponentRenderPayload>;
  consoleSvc: VisualizationConsoleService;
}

// ---------------------------------------------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------------------------------------------

/** Everything the orchestrator talks to; tests replace any subset (07 §5.9.3). */
export interface VisualizationWorkerDependencies {
  queryHandler: QueryHandler;
  workspace: Pick<WorkspacePrepareService, "prepare" | "cleanup">;
  /** new SettingsStore().readAiSettings(). */
  readAiSettings: () => Promise<ResolvedAiSettings>;
  /** AiProviderFactory.create. */
  createProvider: (settings: ResolvedAiSettings) => AiProvider;
  /** Test override: when set, used for every framework (15 §5.3). */
  steps?: PipelineStepFactories;
  /** Stage factories of a repository's framework; default `stepFactoriesFor` (the only framework branch). */
  stepsFor: (framework: RepositoryFramework) => PipelineStepFactories;
  queue: Pick<typeof QueueService, "isCancelRequested" | "clearCancel" | "getVisualizationJobState">;
  consoleFactory: (visualizationId: number) => VisualizationConsoleService;
  now: () => Date;
  /** VISUALIZATION_MAX_RUNTIME_MS, STEP_ABORT_GRACE_MS. */
  limits: { maxRuntimeMs: number; stepAbortGraceMs: number };
  /** 16 §8.7 step 6: the repository's harness library (save-back). */
  libraryStore: HarnessLibraryStorePort;
  /** 16 §8.1: fingerprints of written harnesses' components (status side). */
  fingerprinter: Pick<LibraryFingerprinter, "fingerprint">;
  /** The render stage's persistence; the worker wraps it to see which harness each row kept. */
  createRenderPersistence: (visualizationId: number) => ComponentRenderPersistence;
}

/** Outcome of one run() call. "skipped": the job did not belong to a queued row (no writes). */
export type RunOutcome = "completed" | "failed" | "cancelled" | "skipped" | "paused";

/** What boot recovery did (logged by worker.ts). */
export interface BootRecoveryReport {
  failedRunning: number[];
  failedLostQueued: number[];
  cleanedWorktrees: number[];
  skippedEntries: string[];
  /** 16 §11.2: `<dataDir>/snapshots/<id>.tmp` folders of interrupted snapshot saves. */
  removedSnapshotTemps: string[];
}

/** Dependencies of boot recovery and the periodic sweep (07 §5.10). */
export interface RecoveryDependencies {
  queryHandler: QueryHandler;
  /** DrizzleDb.transaction. */
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  queue: Pick<typeof QueueService, "getVisualizationJobState">;
  workspace: Pick<WorkspacePrepareService, "cleanup">;
  git: Pick<GitClient, "worktreePrune">;
  artifacts: Pick<ArtifactStore, "worktreesRoot">;
  now: () => Date;
  /** RECOVERY_SWEEP_INTERVAL_MS. */
  intervalMs: number;
  /** `<dataDir>/snapshots` (16 §11.2). */
  snapshotsRoot: string;
}

interface RunState {
  visualizationId: number;
  status: VisualizationStatus;
}

const PENDING_SKIP_REASON: Record<TerminalVisualizationStatus, string> = {
  completed: "Not processed.",
  failed: "Not processed: the run failed before this component was finished.",
  cancelled: "Not processed: the run was cancelled before this component was finished."
};

const WORKER_RESTARTED_MESSAGE = "The worker restarted while this visualization was running. Start it again.";
const LOST_QUEUED_MESSAGE =
  "The queued job was lost (Redis was cleared or the job failed before starting). Start the visualization again.";
const LOST_RUNNING_MESSAGE =
  "The worker lost track of this visualization (its job ended without a final status). Start it again.";
const JOB_GONE_STATES: readonly string[] = ["missing", "completed", "failed"];
const WORKTREE_DIR_NAME = /^[1-9]\d*$/;

// ---------------------------------------------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------------------------------------------

/**
 * Drives one queued visualization through preparing → analyzing → generating_harnesses → rendering → diffing →
 * summarizing → completed (07 §5.9). Enforces cancellation and the time limit, writes every status transition and
 * the terminal row, keeps the worktrees and the analysis alive until summarizing ends and always removes the
 * worktrees in finally. Also owns boot recovery and the periodic recovery sweep (07 §5.10).
 */
export class VisualizationWorkerService {
  private readonly deps: VisualizationWorkerDependencies;
  private readonly log = createLogger("visualization-worker");

  constructor(deps: Partial<VisualizationWorkerDependencies> = {}) {
    this.deps = resolveWorkerDependencies(deps);
  }

  /**
   * Runs the job. Never throws for pipeline failures (they are recorded on the row); rethrows only when the row
   * cannot be loaded at all (DB down), so BullMQ marks the job failed and recovery fixes the row later.
   */
  async run(job: VisualizationJob): Promise<RunOutcome> {
    const { visualizationId } = job;
    const log = this.log.child({ visualizationId, jobId: job.jobId });

    // 1. Load + guard. Only 'queued' rows are executable; anything else is a stale or duplicate job.
    const visualization = await this.deps.queryHandler.validateAndSelect(
      VisualizationModel,
      { id: visualizationId },
      Table.VISUALIZATIONS
    );
    if (!visualization) {
      log.warn(
        { event: "visualization.job.skipped", visualizationId },
        "Visualization missing or deleted; job skipped"
      );
      return "skipped";
    }
    if (visualization.status !== VisualizationStatus.QUEUED) {
      log.warn(
        { event: "visualization.job.skipped", visualizationId, status: visualization.status },
        "Visualization is not queued; job skipped"
      );
      return "skipped";
    }

    const consoleSvc = this.deps.consoleFactory(visualizationId);
    const state: RunState = { visualizationId, status: VisualizationStatus.QUEUED };
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new VisualizationTimeoutError(this.deps.limits.maxRuntimeMs));
    }, this.deps.limits.maxRuntimeMs);
    timer.unref();
    const signal = AbortSignal.any([job.signal, timeout.signal]); // keeps the first aborter's reason
    let repository: RepositoryModel | null = null;
    let workspaceStarted = false;
    const startedAtMs = Date.now();

    try {
      // 2. Cancelled before start?
      if (signal.aborted || (await this.safeIsCancelled(visualizationId))) {
        throw new RunCancelledSignal();
      }

      // 3. Repository (soft-delete aware).
      repository = await this.deps.queryHandler.validateAndSelect(
        RepositoryModel,
        { id: visualization.repositoryId },
        Table.REPOSITORIES
      );
      if (!repository) {
        throw new PipelineStepError("preparing", "The repository for this visualization was removed.");
      }
      const repo = repository;

      // 4. One settings read → provider and ctx.aiSettings (05 §5.2). Config problems surface before any git work.
      const settings = await this.deps.readAiSettings();
      const ai = this.deps.createProvider(settings);

      // 5. queued → preparing
      await this.advance(
        state,
        VisualizationStatus.PREPARING,
        consoleSvc,
        { aiProvider: settings.provider, aiModel: settings.model, errorMessage: null },
        `Preparing workspace (${describeSource(visualization)}).`
      );

      // 6. Workspace (cleanup runs in finally even if prepare fails halfway).
      workspaceStarted = true;
      const prepared = await this.awaitStep(
        this.deps.workspace.prepare({
          visualizationId,
          sourceType: visualization.sourceType,
          prNumber: visualization.prNumber,
          baseRef: visualization.baseRef,
          headRef: visualization.headRef,
          baseSha: visualization.baseSha,
          headSha: visualization.headSha,
          repository: {
            id: repo.id,
            localPath: repo.localPath,
            githubOwner: repo.githubOwner,
            githubRepo: repo.githubRepo,
            viteConfigPath: repo.viteConfigPath,
            framework: repo.framework,
            appRoot: repo.appRoot
          },
          console: consoleSvc.asPipelineConsole(),
          signal
        }),
        signal,
        state
      );
      const { workingTreeSnapshot, ...workspace } = prepared;
      if (workingTreeSnapshot === true) {
        await this.recordWorkingTreeSnapshot(visualizationId);
      }
      const baseCtx = this.buildContext(visualizationId, workspace, repo, ai, settings, consoleSvc, signal);
      const ctx = {
        ...baseCtx,
        // A screen size chosen for this run wins over the repository's.
        repository: { ...baseCtx.repository, renderViewport: visualization.renderViewport ?? repo.renderViewport },
        ...(visualization.componentLimit !== null ? { componentLimit: visualization.componentLimit } : {})
      };
      const steps = this.deps.steps ?? this.deps.stepsFor(repo.framework); // 15 §5.3: once per job

      // 7. analyzing — `analysis` stays in scope until summarizing ends (00 §14.7).
      await this.checkpoint(ctx);
      await this.advance(
        state,
        VisualizationStatus.ANALYZING,
        consoleSvc,
        { baseSha: workspace.baseSha, headSha: workspace.headSha },
        "Analyzing changed files."
      );
      const analysis = await this.awaitStep(steps.changeAnalysis().analyze(ctx), signal, state);
      await consoleSvc.info(
        VisualizationStatus.ANALYZING,
        `${analysis.changedFiles.length} changed file(s); ${analysis.candidates.length} component(s) to render, ${analysis.skipped.length} skipped.`
      );

      // 7b. Library resolution (16 §8.4): reuse, new harnesses, the D9 pause and the whole-library re-check.
      const resolution = await this.awaitStep(steps.libraryResolution().resolve(ctx, analysis), signal, state);
      if (visualization.componentLimit === null && resolution.pause) {
        await this.advance(
          state,
          VisualizationStatus.AWAITING_CONFIRMATION,
          consoleSvc,
          {},
          newHarnessPauseMessage(resolution.newHarnessCount, resolution.reusedCount)
        );
        log.info(
          {
            event: "visualization.run.paused",
            visualizationId,
            newHarnesses: resolution.newHarnessCount,
            reused: resolution.reusedCount,
            limit: MAX_COMPONENTS
          },
          "Visualization paused for confirmation"
        );
        return "paused";
      }

      // 8. generating_harnesses (09 owns concurrency and per-component cancellation checks)
      await this.checkpoint(ctx);
      const toWrite = resolution.toWrite;
      await this.advance(
        state,
        VisualizationStatus.GENERATING_HARNESSES,
        consoleSvc,
        {},
        toWrite.length > 0
          ? `Generating render harnesses for ${toWrite.length} component(s).`
          : "No components to generate harnesses for."
      );
      const harnessService = steps.harnessGeneration(ctx, analysis.sourceQueries);
      const batch = await this.awaitStep(
        harnessService.generateAll(
          toWrite.map((row) => row.candidate),
          { sides: new Map(toWrite.map((row) => [row.candidate.componentId, row.sides])) }
        ),
        signal,
        state
      );
      if (batch.cancelled) {
        throw new RunCancelledSignal();
      }
      if (toWrite.length > 0) {
        await consoleSvc.info(
          VisualizationStatus.GENERATING_HARNESSES,
          `${batch.results.length} harness(es) ready, ${batch.failures.length} failed.`
        );
      }
      const harnesses = mergeRunHarnesses(resolution, batch.results);
      await this.persistReusedHarnesses(ctx, resolution);

      // 9. rendering
      await this.checkpoint(ctx);
      const renderInputs = buildRenderInputs(resolution.renderCandidates, harnesses, analysis.changedFiles); // 10 §5.13.1
      await this.advance(
        state,
        VisualizationStatus.RENDERING,
        consoleSvc,
        {},
        renderInputs.length > 0
          ? `Rendering ${renderInputs.length} component(s) on base and head.`
          : "Nothing to render."
      );
      const repairs = new Map<string, HarnessGenerationResult>();
      const persistence = new RecordingRenderPersistence(this.deps.createRenderPersistence(visualizationId));
      const renders =
        renderInputs.length > 0
          ? await this.awaitStep(
              steps
                .render({ repairHarness: recordRepairs(toRepairHarnessFn(harnessService), repairs), persistence })
                .renderAll(ctx, renderInputs),
              signal,
              state
            )
          : [];
      if (renders.length > 0) {
        const ok = renders.filter((r) => (r.base?.ok ?? true) && (r.head?.ok ?? true)).length;
        await consoleSvc.info(
          VisualizationStatus.RENDERING,
          `${ok} of ${renders.length} component(s) rendered on every side they exist.`
        );
      }
      // 9b. Library save-back (16 §8.7 step 6): never fails the run.
      await this.saveRunResultsToLibrary({
        ctx,
        resolution,
        batch,
        renders,
        repairs,
        payloads: persistence.payloads,
        consoleSvc
      });
      const downstream = withRecheckedCandidates(analysis, resolution);

      // 10. diffing
      await this.checkpoint(ctx);
      await this.advance(
        state,
        VisualizationStatus.DIFFING,
        consoleSvc,
        {},
        renders.length > 0 ? `Comparing ${renders.length} render(s).` : "Nothing to compare."
      );
      if (renders.length > 0) {
        const diffs = await this.awaitStep(steps.imageDiff().diff(ctx, renders), signal, state);
        await this.checkpoint(ctx);
        await this.awaitStep(
          steps.structuralDiff().compare(ctx, { renders, diffs, analysis: downstream }),
          signal,
          state
        );
      }

      // 11. summarizing — always; worktrees and `analysis` are still alive (structural/related diffs read them).
      await this.checkpoint(ctx);
      await this.advance(state, VisualizationStatus.SUMMARIZING, consoleSvc, {}, "Writing the summary.");
      const outcome = await this.awaitStep(steps.summary().summarize(ctx, downstream), signal, state);
      if (outcome.status === "cancelled") {
        throw new RunCancelledSignal();
      }
      if (outcome.status === "failed") {
        await consoleSvc.error(
          VisualizationStatus.SUMMARIZING,
          `The summary could not be generated (${outcome.failureReason ?? "unknown error"}). Renders and diffs are still available.`
        );
      }

      // 12. completed. No checkpoint here: once the summary exists, a cancel that arrives now loses the race.
      const counts = await this.finish(state, consoleSvc, VisualizationStatus.COMPLETED, { errorMessage: null });
      log.info(
        {
          event: "visualization.run.finished",
          visualizationId,
          outcome: "completed",
          durationMs: Date.now() - startedAtMs,
          componentCount: counts?.componentCount ?? 0,
          changedCount: counts?.changedCount ?? 0,
          checkedCount: counts?.checkedCount ?? 0
        },
        "Visualization completed"
      );
      return "completed";
    } catch (error: unknown) {
      const outcome = await this.finishWithError(state, consoleSvc, error, signal, log);
      log.info(
        { event: "visualization.run.finished", visualizationId, outcome, durationMs: Date.now() - startedAtMs },
        "Visualization finished without completing"
      );
      return outcome;
    } finally {
      clearTimeout(timer);
      if (workspaceStarted && repository) {
        await consoleSvc.info(state.status, "Removing temporary worktrees.");
        await this.deps.workspace.cleanup({
          visualizationId,
          repositoryPath: repository.localPath,
          prNumber: visualization.prNumber,
          viteConfigPath: repository.viteConfigPath,
          appRoot: repository.appRoot
        }); // never throws
      }
      try {
        await this.deps.queue.clearCancel(visualizationId);
      } catch (error: unknown) {
        log.warn(
          { event: "visualization.cancel.clear_failed", visualizationId, err: error },
          "Cancel flag clear failed"
        );
      }
    }
  }

  /** Boot recovery (07 §5.10). Runs before the worker takes jobs; never throws. */
  static async recoverOnBoot(deps: Partial<RecoveryDependencies> = {}): Promise<BootRecoveryReport> {
    return new VisualizationRecovery(resolveRecoveryDependencies(deps)).recoverOnBoot();
  }

  /** Starts the periodic recovery sweep (unref'd interval; overlapping ticks are skipped). */
  static startRecoverySweep(deps: Partial<RecoveryDependencies> = {}): { stop(): void } {
    return new VisualizationRecovery(resolveRecoveryDependencies(deps)).startSweep();
  }

  // ----- run() helpers -----

  /** Guarded transition + console line. A lost guard stops the run without further writes. */
  private async advance(
    state: RunState,
    to: VisualizationStatus,
    consoleSvc: VisualizationConsoleService,
    fields: VisualizationTransitionFields,
    message: string
  ): Promise<void> {
    const ok = await transitionVisualization(this.deps.queryHandler, {
      visualizationId: state.visualizationId,
      from: state.status,
      to,
      fields,
      now: this.deps.now()
    });
    if (!ok) {
      throw new VisualizationRowConflictError(state.visualizationId, state.status, to);
    }
    this.log.info(
      { event: "visualization.stage.transition", visualizationId: state.visualizationId, from: state.status, to },
      "Stage transition"
    );
    state.status = to;
    await consoleSvc.info(to, message);
  }

  /** Between stages: abort reasons (cancel/shutdown/timeout) first, then the Redis flag (covers the ≤ 1 s poll gap). */
  private async checkpoint(ctx: PipelineContext): Promise<void> {
    if (ctx.signal.aborted) {
      throw new RunCancelledSignal(); // classified by signal.reason in classifyRunFailure
    }
    if (await ctx.isCancelled()) {
      throw new RunCancelledSignal();
    }
  }

  /** QueueService.isCancelRequested that never throws: a Redis hiccup does not count as a cancellation. */
  private async safeIsCancelled(visualizationId: number): Promise<boolean> {
    try {
      return await this.deps.queue.isCancelRequested(visualizationId);
    } catch (error: unknown) {
      this.log.warn(
        { event: "visualization.cancel.check_failed", visualizationId, err: error },
        "Cancel flag check failed"
      );
      return false;
    }
  }

  /**
   * Resolves/rejects with `work`. Once `signal` aborts, waits at most stepAbortGraceMs more; if the step has not
   * settled by then it is abandoned (StepAbandonedError) so cleanup and the terminal write still happen.
   */
  private async awaitStep<T>(work: Promise<T>, signal: AbortSignal, state: RunState): Promise<T> {
    const graceMs = this.deps.limits.stepAbortGraceMs;
    const settled = new AbortController();
    const abandoned = (async (): Promise<never> => {
      if (!signal.aborted) {
        await once(signal, "abort", { signal: settled.signal });
      }
      await delay(graceMs, undefined, { signal: settled.signal });
      throw new StepAbandonedError();
    })();
    // Rejects with an AbortError once the step settled first; that outcome is expected and ignored.
    abandoned.catch(() => undefined);
    try {
      return await Promise.race([work, abandoned]);
    } catch (error: unknown) {
      if (error instanceof StepAbandonedError) {
        work.catch(() => undefined); // the abandoned promise can never become an unhandled rejection
        this.log.error(
          {
            event: "visualization.step.abandoned",
            visualizationId: state.visualizationId,
            stage: state.status,
            graceMs
          },
          "Step did not stop after abort"
        );
      }
      throw error;
    } finally {
      settled.abort();
    }
  }

  private buildContext(
    visualizationId: number,
    workspace: PreparedWorkspace,
    repository: RepositoryModel,
    ai: AiProvider,
    settings: ResolvedAiSettings,
    consoleSvc: VisualizationConsoleService,
    signal: AbortSignal
  ): PipelineContext {
    return {
      visualizationId,
      workspace,
      repository: {
        id: repository.id,
        localPath: repository.localPath,
        framework: repository.framework,
        appRoot: repository.appRoot,
        angularProject: repository.angularProject ?? null,
        angularBuildConfiguration: repository.angularBuildConfiguration ?? null,
        viteConfigPath: repository.viteConfigPath,
        tsconfigPath: repository.tsconfigPath,
        entryFilePath: repository.entryFilePath,
        globalStylePaths: [...repository.globalStylePaths], // snapshot: a later redetect cannot change this run
        renderViewport: repository.renderViewport
      },
      ai,
      // Same settings read as the provider; the key never enters the context.
      aiSettings: {
        model: settings.model,
        harnessEffort: settings.harnessEffort,
        summaryEffort: settings.summaryEffort
      },
      console: consoleSvc.asPipelineConsole(),
      isCancelled: () => this.safeIsCancelled(visualizationId),
      signal,
      // 16 §6.12: snapshot of the repository's library settings at job start.
      library: { stateAllowance: repository.stateAllowance, buildMode: repository.libraryBuildMode }
    };
  }

  /**
   * Counts via QueryHandler (00 §14.3 semantics). A `replaced` row always counts as changed (00 §17), also when its
   * screenshots matched or were not compared. changed_count never exceeds component_count.
   */
  private async componentCounts(visualizationId: number): Promise<{ componentCount: number; changedCount: number }> {
    const replaced = ComponentChangeKind.REPLACED;
    const [all, changed, replacedUnchanged, replacedNotCompared] = await Promise.all([
      this.deps.queryHandler.count({ visualizationId }, Table.VISUALIZATION_COMPONENTS),
      this.deps.queryHandler.count(
        { visualizationId, visualChange: Where.in(["changed", "new", "deleted"]) },
        Table.VISUALIZATION_COMPONENTS
      ),
      this.deps.queryHandler.count(
        { visualizationId, changeKind: replaced, visualChange: Where.in(["unchanged"]) },
        Table.VISUALIZATION_COMPONENTS
      ),
      this.deps.queryHandler.count(
        { visualizationId, changeKind: replaced, visualChange: Where.isNull() },
        Table.VISUALIZATION_COMPONENTS
      )
    ]);
    if (
      all.status !== 200 ||
      changed.status !== 200 ||
      replacedUnchanged.status !== 200 ||
      replacedNotCompared.status !== 200
    ) {
      throw new Error("Component count failed");
    }
    const componentCount = all.data?.count ?? 0;
    const changedCount =
      (changed.data?.count ?? 0) + (replacedUnchanged.data?.count ?? 0) + (replacedNotCompared.data?.count ?? 0);
    return { componentCount, changedCount: Math.min(changedCount, componentCount) };
  }

  /**
   * Pending sweep, counts, guarded terminal transition, console line. Throws on DB failure (finishWithError logs
   * it at fatal). Returns the counts it wrote (null before analysis: no component rows exist yet).
   */
  private async finish(
    state: RunState,
    consoleSvc: VisualizationConsoleService,
    to: TerminalVisualizationStatus,
    fields: VisualizationTransitionFields
  ): Promise<{ componentCount: number; changedCount: number; checkedCount: number } | null> {
    let counts: { componentCount: number; changedCount: number; checkedCount: number } | null = null;
    if (state.status !== VisualizationStatus.QUEUED) {
      const swept = await this.deps.queryHandler.update(
        { renderStatus: ComponentRenderStatus.SKIPPED, skipReason: PENDING_SKIP_REASON[to] },
        { visualizationId: state.visualizationId, renderStatus: ComponentRenderStatus.PENDING },
        Table.VISUALIZATION_COMPONENTS
      );
      if (swept.status !== 200 && swept.status !== 404) {
        throw new Error("Pending sweep failed"); // 404 = nothing pending
      }
      counts = {
        ...(await this.componentCounts(state.visualizationId)),
        checkedCount: await this.checkedCount(state.visualizationId)
      };
      const checked = await this.deps.queryHandler.update(
        { checkedCount: counts.checkedCount },
        { id: state.visualizationId },
        Table.VISUALIZATIONS
      );
      if (checked.status !== 200) {
        throw new Error("checked_count update failed");
      }
    }
    const ok = await transitionVisualization(this.deps.queryHandler, {
      visualizationId: state.visualizationId,
      from: state.status,
      to,
      now: this.deps.now(),
      fields: { ...fields, ...(counts ? { changedCount: counts.changedCount } : {}) } // component_count stays 08's
    });
    if (!ok) {
      throw new VisualizationRowConflictError(state.visualizationId, state.status, to);
    }
    state.status = to;
    if (to === VisualizationStatus.COMPLETED) {
      await consoleSvc.info(
        to,
        `Completed: ${String(counts?.checkedCount ?? 0)} checked, ${String(counts?.changedCount ?? 0)} changed visually.`
      );
    } else if (to === VisualizationStatus.CANCELLED) {
      await consoleSvc.warn(to, "Cancelled by user.");
    } else {
      await consoleSvc.error(to, fields.errorMessage ?? "Failed.");
    }
    return counts;
  }

  /**
   * 16 §8.7 step 8: rows that reached rendering (`render_status` rendered, partial or failed) with a harness
   * (`harness_origin` set).
   */
  private async checkedCount(visualizationId: number): Promise<number> {
    const response = await this.deps.queryHandler.count(
      {
        visualizationId,
        renderStatus: Where.in([
          ComponentRenderStatus.RENDERED,
          ComponentRenderStatus.PARTIAL,
          ComponentRenderStatus.FAILED
        ]),
        harnessOrigin: Where.isNotNull()
      },
      Table.VISUALIZATION_COMPONENTS
    );
    if (response.status !== 200) {
      throw new Error("Checked count failed");
    }
    return response.data?.count ?? 0;
  }

  /** 16 §11.2: the run kept its working-tree snapshot (live mode and repair can recreate the head side). */
  private async recordWorkingTreeSnapshot(visualizationId: number): Promise<void> {
    const response = await this.deps.queryHandler.update(
      { workingTreeSnapshot: true },
      { id: visualizationId },
      Table.VISUALIZATIONS
    );
    if (response.status !== 200) {
      throw new Error("working_tree_snapshot update failed");
    }
  }

  /**
   * 16 §8.7 step 4 (`persistReusedHarness`): the run's snapshot of every reused harness (E2), `rechecked` rows
   * included — `harness_source`, `harness_notes`, `mocked_modules` and the `base_*` columns of a reused base side —
   * in one update per row.
   */
  private async persistReusedHarnesses(ctx: PipelineContext, resolution: LibraryResolutionResult): Promise<void> {
    for (const candidate of resolution.renderCandidates) {
      const values: Record<string, unknown> = {};
      for (const plan of resolution.plans.get(candidate.componentId) ?? []) {
        if (plan.entry === null) {
          continue;
        }
        const harness = sideHarnessFromEntry(plan.entry);
        if (isReplacedCandidate(candidate) && plan.side === "base") {
          values.baseHarnessSource = harness.harnessSource;
          values.baseHarnessNotes = harness.notes;
          values.baseMockedModules = harness.mockedModules;
        } else {
          values.harnessSource = harness.harnessSource;
          values.harnessNotes = harness.notes;
          values.mockedModules = harness.mockedModules;
        }
      }
      if (Object.keys(values).length === 0) {
        continue;
      }
      const response = await this.deps.queryHandler.update(
        values,
        { id: candidate.componentId, visualizationId: ctx.visualizationId },
        Table.VISUALIZATION_COMPONENTS
      );
      if (response.status !== 200) {
        throw new PipelineStepError("generating_harnesses", "Could not save the reused harnesses.", {
          code: "LIBRARY_REUSE_PERSIST_FAILED"
        });
      }
    }
  }

  /**
   * 16 §8.7 step 6: saves the harnesses this run wrote (E25 optimistic revisions), refreshes the status of reused
   * entries from their status side (E4, E5, E26), moves renamed components' entries, and flags rows whose harness
   * needs updating. Failures are logged and reported as one console warning; they never fail the run.
   */
  private async saveRunResultsToLibrary(input: SaveBackInput): Promise<void> {
    const { ctx, resolution, batch, renders, repairs, payloads, consoleSvc } = input;
    const log = this.log.child({ visualizationId: ctx.visualizationId });
    const problems: string[] = [];
    const guard = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (error: unknown) {
        problems.push(shortErrorMessage(error));
        log.warn({ event: "library.save_back.failed", step: what, err: error }, "Library save-back step failed");
      }
    };
    const renderById = new Map(renders.map((render) => [render.componentId, render]));
    const failureById = new Map(batch.failures.map((failure) => [failure.componentId, failure]));
    const generatedById = new Map(batch.results.map((result) => [result.componentId, result]));
    const writes = new Map(resolution.toWrite.map((row) => [row.candidate.componentId, row.sides]));
    const at = this.deps.now();
    let saved = 0;
    let savedNeedingUpdate = 0;

    for (const candidate of resolution.renderCandidates) {
      const plans = resolution.plans.get(candidate.componentId) ?? [];
      const render = renderById.get(candidate.componentId);
      const writeSides = writes.get(candidate.componentId) ?? [];
      const rowValues: Record<string, unknown> = {};
      const replaced = isReplacedCandidate(candidate);

      // reused entries: status refresh from the status side (E4, E5), rename move
      for (const plan of plans) {
        const entry = plan.entry;
        if (entry === null || render === undefined) {
          continue;
        }
        const outcome = sideRenderOutcome(render, plan.side);
        await guard("render_outcome", async () => {
          if (outcome.allOk) {
            await this.deps.libraryStore.markRenderOutcome(entry.id, { ok: true, at });
          } else if (outcome.harnessError !== null) {
            await this.deps.libraryStore.markRenderOutcome(entry.id, {
              ok: false,
              at,
              error: outcome.harnessError,
              visualizationId: ctx.visualizationId
            });
          } else {
            return; // infrastructure failure or nothing rendered: the entry is unchanged (16 §17)
          }
          log.info(
            { event: "library.entry.render_outcome", entryId: entry.id, ok: outcome.allOk },
            "Library entry render outcome"
          );
        });
        if (!replaced && outcome.allOk && plan.side === "head" && identityKey(entry) !== identityKey(plan.identity)) {
          await guard("move_identity", () =>
            this.deps.libraryStore.moveIdentity(entry.id, { ...plan.identity, displayName: candidate.displayName })
          );
        }
      }

      // written sides: save to the library (E25)
      for (const side of writeSides) {
        const plan = plans.find((candidatePlan) => candidatePlan.side === side);
        if (plan === undefined) {
          continue;
        }
        const failure = failureById.get(candidate.componentId);
        const generated = generatedById.get(candidate.componentId);
        if (failure !== undefined || generated === undefined) {
          if (failure === undefined) {
            continue; // not generated (cancelled): nothing to save
          }
          await guard("save_without_harness", async () => {
            await this.saveWritten(ctx, candidate, plan, null, resolution, failure.message, null);
          });
          continue;
        }
        if (render === undefined) {
          continue; // never reached a page: nothing verified to save
        }
        const written = replaced && side === "base" ? generated.baseHarness : topLevelHarness(generated);
        if (written === null || written === undefined || written.harnessSource === "") {
          continue;
        }
        const repairedKey = `${String(candidate.componentId)}:${replaced ? side : "head"}`;
        const repaired = repairs.get(repairedKey);
        const payload = payloads.get(candidate.componentId);
        const kept = replaced && side === "base" ? payload?.baseHarness : payload?.harness;
        const useRepaired = kept !== undefined && kept.harnessSource !== written.harnessSource;
        const harness = useRepaired
          ? {
              harnessSource: kept.harnessSource,
              mockedModules: kept.mockedModules,
              notes: kept.harnessNotes,
              states:
                repaired?.harnessSource === kept.harnessSource
                  ? repaired.states
                  : this.statesOf(ctx, kept.harnessSource)
            }
          : {
              harnessSource: written.harnessSource,
              mockedModules: written.mockedModules,
              notes: written.notes,
              states: written.states
            };
        const generationUsage =
          side === "base" && replaced && writeSides.includes("head") ? null : (generated.usage ?? null);
        const usage = sumUsage(generationUsage, repaired?.usage ?? null);
        const outcome = sideRenderOutcome(render, side);
        const origin = useRepaired ? ComponentHarnessOrigin.REPAIRED : ComponentHarnessOrigin.WRITTEN;
        if (replaced && side === "base") {
          rowValues.baseHarnessOrigin = origin;
        } else {
          rowValues.harnessOrigin = origin;
        }
        await guard("save_written", async () => {
          const entryId = await this.saveWritten(
            ctx,
            candidate,
            plan,
            harness,
            resolution,
            outcome.allOk ? null : (outcome.firstError ?? "The harness did not render."),
            usage
          );
          if (entryId !== null) {
            saved += 1;
            if (!outcome.allOk) {
              savedNeedingUpdate += 1;
            }
            if (replaced && side === "base") {
              rowValues.baseLibraryEntryId = entryId;
            } else {
              rowValues.libraryEntryId = entryId;
            }
          }
        });
      }

      // the row's card (E5): any present side of any state failed for a harness-attributable reason
      if (render !== undefined) {
        rowValues.harnessNeedsUpdate =
          sideRenderOutcome(render, "base").harnessError !== null ||
          sideRenderOutcome(render, "head").harnessError !== null;
      }
      if (Object.keys(rowValues).length > 0) {
        await guard("row_update", async () => {
          const response = await this.deps.queryHandler.update(
            rowValues,
            { id: candidate.componentId, visualizationId: ctx.visualizationId },
            Table.VISUALIZATION_COMPONENTS
          );
          if (response.status !== 200) {
            throw new Error(`component row update failed (${String(response.status)})`);
          }
        });
      }
    }

    await guard("needs_update_count", async () => {
      const counted = await this.deps.queryHandler.count(
        { visualizationId: ctx.visualizationId, harnessNeedsUpdate: true },
        Table.VISUALIZATION_COMPONENTS
      );
      if (counted.status !== 200) {
        throw new Error("needs_update_count failed");
      }
      const response = await this.deps.queryHandler.update(
        { needsUpdateCount: counted.data?.count ?? 0 },
        { id: ctx.visualizationId },
        Table.VISUALIZATIONS
      );
      if (response.status !== 200) {
        throw new Error("needs_update_count update failed");
      }
    });
    if (saved > 0) {
      await consoleSvc.info(
        VisualizationStatus.RENDERING,
        `Saved ${String(saved)} new harness(es) to the library; ${String(savedNeedingUpdate)} need updating.`
      );
    }
    if (problems.length > 0) {
      await consoleSvc.warn(
        VisualizationStatus.RENDERING,
        `Could not update the harness library: ${problems[0] ?? ""}`
      );
    }
  }

  /**
   * One `saveWritten` of a harness this run wrote (or failed to write, `harness` null). Returns the saved entry's
   * id, or null when a newer revision was kept (E25: the row keeps its run snapshot).
   */
  private async saveWritten(
    ctx: PipelineContext,
    candidate: ComponentCandidate,
    plan: SideHarnessPlan,
    harness: { harnessSource: string; mockedModules: MockedModule[]; notes: string; states: HarnessStateSpec[] } | null,
    resolution: LibraryResolutionResult,
    lastError: string | null,
    usage: AiUsage | null
  ): Promise<number | null> {
    const status =
      harness !== null && lastError === null ? HarnessLibraryStatus.READY : HarnessLibraryStatus.NEEDS_UPDATE;
    const sourceFingerprint = await this.fingerprintOf(ctx, plan);
    const displayName =
      isReplacedCandidate(candidate) && plan.side === "base"
        ? candidate.predecessor.displayName
        : candidate.displayName;
    const outcome = await this.deps.libraryStore.saveWritten({
      repositoryId: ctx.repository.id,
      framework: ctx.repository.framework,
      identity: plan.identity,
      displayName,
      selector: null,
      sourceFingerprint,
      harness,
      stateAllowance: ctx.library.stateAllowance,
      status,
      origin: HarnessLibraryOrigin.RUN,
      lastError,
      lastFailedVisualizationId: status === HarnessLibraryStatus.READY ? null : ctx.visualizationId,
      aiModel: ctx.aiSettings.model,
      aiUsage: usage,
      expectedRevision: resolution.writeRevisions.get(identityKey(plan.identity)) ?? 0
    });
    if (!outcome.saved) {
      this.log.info(
        {
          event: "library.entry.kept_newer",
          visualizationId: ctx.visualizationId,
          entryId: outcome.current.id,
          revision: outcome.current.revision
        },
        "A newer library revision was kept"
      );
      return null;
    }
    this.log.info(
      {
        event: "library.entry.saved",
        repositoryId: ctx.repository.id,
        entryId: outcome.entry.id,
        revision: outcome.entry.revision,
        status: outcome.entry.status,
        origin: outcome.entry.origin
      },
      "Library entry saved"
    );
    return outcome.entry.id;
  }

  /** 16 §8.1: the fingerprint of the plan's identity on its status side; null when it cannot be computed. */
  private async fingerprintOf(ctx: PipelineContext, plan: SideHarnessPlan): Promise<string | null> {
    try {
      const root = plan.side === "base" ? ctx.workspace.baseDir : ctx.workspace.headDir;
      return await this.deps.fingerprinter.fingerprint({
        framework: ctx.repository.framework,
        identity: plan.identity,
        readFile: (path) => readConfinedText(root, path)
      });
    } catch {
      return null;
    }
  }

  /** States of a kept repaired harness that was not recorded by the repair wrapper (best effort, 16 §7.7.1). */
  private statesOf(ctx: PipelineContext, source: string): HarnessStateSpec[] {
    const extraction = extractHarnessStates(source, ctx.repository.framework, {
      stateAllowance: ctx.library.stateAllowance,
      allowLegacy: true
    });
    return extraction.ok ? extraction.states : [];
  }

  /** Error mapping and terminal write (07 §5.9.6). Never throws. */
  private async finishWithError(
    state: RunState,
    consoleSvc: VisualizationConsoleService,
    error: unknown,
    signal: AbortSignal,
    log: ReturnType<typeof createLogger>
  ): Promise<RunOutcome> {
    if (error instanceof VisualizationRowConflictError) {
      log.warn(
        {
          event: "visualization.transition.conflict",
          visualizationId: state.visualizationId,
          from: error.from,
          to: error.to
        },
        "Visualization row moved by another writer; run stopped"
      );
      return "skipped";
    }

    const abortReason: unknown = signal.aborted ? signal.reason : undefined;
    const classification = classifyRunFailure(
      error,
      abortReason,
      await this.safeIsCancelled(state.visualizationId),
      state.status
    );
    if (classification.unexpected) {
      log.error(
        { event: "visualization.run.failed", visualizationId: state.visualizationId, stage: state.status, err: error },
        "Visualization run failed with an unexpected error"
      );
    }

    try {
      await this.finish(state, consoleSvc, classification.status, { errorMessage: classification.errorMessage });
      return classification.status;
    } catch (writeError: unknown) {
      if (writeError instanceof VisualizationRowConflictError) {
        log.warn(
          {
            event: "visualization.transition.conflict",
            visualizationId: state.visualizationId,
            from: writeError.from,
            to: writeError.to
          },
          "Visualization row moved by another writer; terminal write skipped"
        );
        return "skipped";
      }
      log.fatal(
        {
          event: "visualization.terminal_write.failed",
          visualizationId: state.visualizationId,
          err: writeError,
          originalErr: error
        },
        "Terminal write failed; recovery will fail the row later"
      );
      return "failed";
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Recovery (07 §5.10)
// ---------------------------------------------------------------------------------------------------------------

/** Boot recovery and the periodic sweep. Every step is isolated: recovery never blocks worker start. */
class VisualizationRecovery {
  private readonly log = createLogger("visualization-recovery");

  constructor(private readonly deps: RecoveryDependencies) {}

  async recoverOnBoot(): Promise<BootRecoveryReport> {
    const report: BootRecoveryReport = {
      failedRunning: [],
      failedLostQueued: [],
      cleanedWorktrees: [],
      skippedEntries: [],
      removedSnapshotTemps: []
    };
    const now = this.deps.now();

    // 1. Running → failed (no job is active in this process yet).
    await this.step("fail_running", async () => {
      const stuck = await this.deps.queryHandler.selectMany(
        VisualizationModel,
        { status: Where.in([...ACTIVE_VISUALIZATION_STATUSES]) },
        Table.VISUALIZATIONS,
        { limit: RECOVERY_BATCH_LIMIT }
      );
      for (const row of stuck) {
        if (await this.failRow(row.id, row.status, WORKER_RESTARTED_MESSAGE, now, "boot")) {
          report.failedRunning.push(row.id);
        }
      }
    });

    // 2. Lost queued jobs.
    await this.step("fail_lost_queued", async () => {
      report.failedLostQueued.push(...(await this.failLostQueued(now)));
    });

    // 3. Orphan worktrees.
    await this.step("clean_worktrees", async () => {
      await this.cleanOrphanWorktrees(report);
    });

    // 4. Dangling worktree metadata in every registered clone.
    await this.step("prune_worktrees", async () => {
      const repositories = await this.deps.queryHandler.selectMany(RepositoryModel, {}, Table.REPOSITORIES, {
        limit: RECOVERY_BATCH_LIMIT
      });
      for (const repository of repositories) {
        if (await isDirectory(repository.localPath)) {
          await this.step("prune_worktrees", () => this.deps.git.worktreePrune(repository.localPath));
        }
      }
    });

    // 5. Interrupted working-tree snapshot saves (16 §11.2).
    await this.step("clean_snapshot_temps", async () => {
      report.removedSnapshotTemps.push(...(await removeSnapshotTemps(this.deps.snapshotsRoot)));
    });

    return report;
  }

  startSweep(): { stop(): void } {
    let running = false;
    const tick = async (): Promise<void> => {
      running = true;
      try {
        await this.sweepOnce();
      } finally {
        running = false;
      }
    };
    const timer = setInterval(() => {
      if (running) {
        return; // the previous tick is still running
      }
      // Interval callback: the process boundary for this promise.
      tick().catch((error: unknown) => {
        this.log.warn({ event: "visualization.recovery.sweep_failed", err: error }, "Recovery sweep failed");
      });
    }, this.deps.intervalMs);
    timer.unref();
    return {
      stop: () => {
        clearInterval(timer);
      }
    };
  }

  private async sweepOnce(): Promise<void> {
    const now = this.deps.now();
    await this.step("fail_lost_queued", async () => {
      await this.failLostQueued(now);
    });
    await this.step("fail_running_without_job", async () => {
      const rows = await this.deps.queryHandler.selectMany(
        VisualizationModel,
        {
          status: Where.in([...ACTIVE_VISUALIZATION_STATUSES]),
          updatedAt: Where.lt(new Date(now.getTime() - RUNNING_RECOVERY_GRACE_MS))
        },
        Table.VISUALIZATIONS,
        { limit: RECOVERY_BATCH_LIMIT }
      );
      for (const row of rows) {
        const jobState = await this.deps.queue.getVisualizationJobState(row.id);
        if (jobState === "active") {
          continue; // the job is running (always the case for the current job of this worker)
        }
        this.log.warn(
          { event: "visualization.recovery.row_failed", visualizationId: row.id, status: row.status, jobState },
          "Recovery failed a running visualization without a live job"
        );
        await this.failRow(row.id, row.status, LOST_RUNNING_MESSAGE, now, "sweep");
      }
    });
  }

  /** Fails queued rows older than the grace period whose job is missing, completed or failed. Returns their ids. */
  private async failLostQueued(now: Date): Promise<number[]> {
    const failed: number[] = [];
    const rows = await this.deps.queryHandler.selectMany(
      VisualizationModel,
      {
        status: VisualizationStatus.QUEUED,
        createdAt: Where.lt(new Date(now.getTime() - QUEUED_RECOVERY_GRACE_MS))
      },
      Table.VISUALIZATIONS,
      { limit: RECOVERY_BATCH_LIMIT }
    );
    for (const row of rows) {
      const jobState = await this.deps.queue.getVisualizationJobState(row.id);
      if (!JOB_GONE_STATES.includes(jobState)) {
        continue; // waiting, delayed, prioritized or active
      }
      this.log.warn(
        { event: "visualization.recovery.row_failed", visualizationId: row.id, status: row.status, jobState },
        "Recovery failed a queued visualization whose job is gone"
      );
      if (await this.failRow(row.id, VisualizationStatus.QUEUED, LOST_QUEUED_MESSAGE, now, "lost_queued")) {
        failed.push(row.id);
      }
    }
    return failed;
  }

  /**
   * One transaction per row: guarded transition to failed (stamps failed_stage), the pending sweep and one console
   * error event at stage "failed". Returns false when the guard lost (another writer moved the row).
   */
  private async failRow(
    visualizationId: number,
    from: VisualizationStatus,
    message: string,
    now: Date,
    reason: string
  ): Promise<boolean> {
    return this.deps.transaction(async (tx) => {
      const qh = new QueryHandler(tx);
      const ok = await transitionVisualization(qh, {
        visualizationId,
        from,
        to: VisualizationStatus.FAILED,
        fields: { errorMessage: message },
        now
      });
      if (!ok) {
        return false;
      }
      const swept = await qh.update(
        { renderStatus: ComponentRenderStatus.SKIPPED, skipReason: PENDING_SKIP_REASON.failed },
        { visualizationId, renderStatus: ComponentRenderStatus.PENDING },
        Table.VISUALIZATION_COMPONENTS
      );
      if (swept.status !== 200 && swept.status !== 404) {
        throw new Error(`Pending sweep failed (${swept.status})`); // rolls back
      }
      const inserted = await qh.insert(
        { visualizationId, level: ConsoleLevel.ERROR, stage: VisualizationStatus.FAILED, message },
        Table.VISUALIZATION_CONSOLE_EVENTS
      );
      if (inserted.status !== 200) {
        throw new Error(`Recovery console event insert failed (${inserted.status})`); // rolls back
      }
      this.log.info(
        { event: "visualization.recovery.row_failed", visualizationId, status: from, reason },
        "Row failed by recovery"
      );
      return true;
    });
  }

  /** Cleans numeric worktree dirs (also of soft-deleted visualizations); leaves foreign entries and symlinks. */
  private async cleanOrphanWorktrees(report: BootRecoveryReport): Promise<void> {
    const root = this.deps.artifacts.worktreesRoot();
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return; // no worktrees root yet
      }
      throw error;
    }
    for (const name of entries.sort()) {
      const st = await fs.lstat(path.join(root, name));
      const id = Number(name);
      if (!WORKTREE_DIR_NAME.test(name) || !Number.isSafeInteger(id) || st.isSymbolicLink() || !st.isDirectory()) {
        report.skippedEntries.push(name);
        this.log.warn(
          { event: "visualization.recovery.foreign_entry", entry: name },
          "Unknown entry in the worktrees root left alone"
        );
        continue;
      }
      // isDeleted given explicitly, so QueryHandler includes soft-deleted rows (04 applyDefaultConditions).
      const visualization = await this.deps.queryHandler.validateAndSelect(
        VisualizationModel,
        { id, isDeleted: Where.isNotNull() },
        Table.VISUALIZATIONS
      );
      const repository = visualization
        ? await this.deps.queryHandler.validateAndSelect(
            RepositoryModel,
            { id: visualization.repositoryId, isDeleted: Where.isNotNull() },
            Table.REPOSITORIES
          )
        : null;
      await this.deps.workspace.cleanup({
        visualizationId: id,
        repositoryPath: repository?.localPath ?? null,
        prNumber: visualization?.prNumber ?? null,
        viteConfigPath: repository?.viteConfigPath ?? null,
        appRoot: repository?.appRoot ?? null
      });
      report.cleanedWorktrees.push(id);
    }
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error: unknown) {
      this.log.warn({ event: "visualization.recovery.step_failed", step: name, err: error }, "Recovery step failed");
    }
  }
}

function resolveWorkerDependencies(
  overrides: Partial<VisualizationWorkerDependencies>
): VisualizationWorkerDependencies {
  const queryHandler = overrides.queryHandler ?? new QueryHandler();
  return {
    queryHandler,
    workspace: overrides.workspace ?? new WorkspacePrepareService(),
    readAiSettings: overrides.readAiSettings ?? (() => new SettingsStore().readAiSettings()),
    createProvider: overrides.createProvider ?? ((settings) => AiProviderFactory.create(settings)),
    ...(overrides.steps === undefined ? {} : { steps: overrides.steps }),
    stepsFor: overrides.stepsFor ?? stepFactoriesFor,
    queue: overrides.queue ?? QueueService,
    consoleFactory: overrides.consoleFactory ?? ((id) => new VisualizationConsoleService(id, queryHandler)),
    now: overrides.now ?? (() => new Date()),
    limits: overrides.limits ?? { maxRuntimeMs: VISUALIZATION_MAX_RUNTIME_MS, stepAbortGraceMs: STEP_ABORT_GRACE_MS },
    libraryStore: overrides.libraryStore ?? new HarnessLibraryStore(),
    fingerprinter: overrides.fingerprinter ?? new LibraryFingerprinter(),
    createRenderPersistence:
      overrides.createRenderPersistence ?? ((visualizationId) => new QueryHandlerRenderPersistence(visualizationId))
  };
}

function resolveRecoveryDependencies(overrides: Partial<RecoveryDependencies>): RecoveryDependencies {
  return {
    queryHandler: overrides.queryHandler ?? new QueryHandler(),
    transaction: overrides.transaction ?? ((fn) => DrizzleDb.transaction(fn)),
    queue: overrides.queue ?? QueueService,
    workspace: overrides.workspace ?? new WorkspacePrepareService(),
    git: overrides.git ?? new GitClient(),
    artifacts: overrides.artifacts ?? new ArtifactStore(),
    now: overrides.now ?? (() => new Date()),
    intervalMs: overrides.intervalMs ?? RECOVERY_SWEEP_INTERVAL_MS,
    snapshotsRoot: overrides.snapshotsRoot ?? defaultSnapshotsRoot()
  };
}

/** Wraps the repair adapter: remembers every successful fix-up by `<componentId>:<side>` (16 §8.7 step 6). */
function recordRepairs(fn: RepairHarnessFn, repairs: Map<string, HarnessGenerationResult>): RepairHarnessFn {
  return async (componentId, previous, renderError) => {
    const outcome = await fn(componentId, previous, renderError);
    if (outcome.ok) {
      repairs.set(`${String(componentId)}:${renderError.targetSide ?? "head"}`, outcome.result);
    }
    return outcome;
  };
}

/** Sum of two optional usages (null when both are absent). */
function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (a === null) {
    return b;
  }
  return b === null ? a : addUsage(a, b);
}

/**
 * The analysis handed to structural diff and summary: unchanged, plus the `rechecked` rows as candidates when
 * library resolution added any (so their reasons and paths are known downstream).
 */
function withRecheckedCandidates(
  analysis: ChangeAnalysisResult,
  resolution: Pick<LibraryResolutionResult, "recheckedCount" | "renderCandidates">
): ChangeAnalysisResult {
  if (resolution.recheckedCount === 0) {
    return analysis;
  }
  const rechecked = resolution.renderCandidates.filter(
    (candidate) => candidate.changeKind === ComponentChangeKind.RECHECKED
  );
  return { ...analysis, candidates: [...analysis.candidates, ...rechecked] };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
