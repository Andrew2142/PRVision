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
  ComponentRenderStatus,
  ConsoleLevel,
  Table,
  VisualizationSourceType,
  VisualizationStatus,
  type RepositoryFramework,
  type TerminalVisualizationStatus
} from "../../../enums";
import { RepositoryModel, VisualizationModel } from "../../../models";
import {
  AiProviderError,
  isPipelineStepError,
  PipelineStepError,
  type AiProvider,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type PipelineContext,
  type PreparedWorkspace
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
  type ResolvedAiSettings,
  type Transaction,
  type VisualizationJob
} from "../../../utilities";
import { SettingsStore } from "../../settings/settings-store";
import { VisualizationConsoleService } from "../visualization-console-service";
import { transitionVisualization, type VisualizationTransitionFields } from "../visualization-state-machine";
import { stepFactoriesFor } from "./frameworks";
import { buildRenderInputs } from "./render-service";
import { type HarnessGenerationStage, type PipelineStepFactories, type RepairHarnessFn } from "./stage-registry";
import { WorkspacePrepareService } from "./workspace-prepare-service";

// ---------------------------------------------------------------------------------------------------------------
// Errors and pure helpers (07 §5.9.1)
// ---------------------------------------------------------------------------------------------------------------

/** Abort reason of the 45-minute overall limit (00 §14.6). */
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
}

/** Outcome of one run() call. "skipped": the job did not belong to a queued row (no writes). */
export type RunOutcome = "completed" | "failed" | "cancelled" | "skipped" | "paused";

/** What boot recovery did (logged by worker.ts). */
export interface BootRecoveryReport {
  failedRunning: number[];
  failedLostQueued: number[];
  cleanedWorktrees: number[];
  skippedEntries: string[];
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
      const workspace = await this.awaitStep(
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

      // 7b. More components than the default limit and the user has not chosen yet: pause and ask (no AI spent).
      const overLimit = analysis.skipped.filter((entry) => entry.skipReason.startsWith("over_limit")).length;
      if (visualization.componentLimit === null && overLimit > 0) {
        const total = analysis.candidates.length + overLimit;
        await this.advance(
          state,
          VisualizationStatus.AWAITING_CONFIRMATION,
          consoleSvc,
          {},
          `${String(total)} components changed; PRVision renders ${String(MAX_COMPONENTS)} by default. Waiting for you to choose how many to render.`
        );
        log.info(
          { event: "visualization.run.paused", visualizationId, components: total, limit: MAX_COMPONENTS },
          "Visualization paused for confirmation"
        );
        return "paused";
      }

      // 8. generating_harnesses (09 owns concurrency and per-component cancellation checks)
      await this.checkpoint(ctx);
      await this.advance(
        state,
        VisualizationStatus.GENERATING_HARNESSES,
        consoleSvc,
        {},
        analysis.candidates.length > 0
          ? `Generating render harnesses for ${analysis.candidates.length} component(s).`
          : "No components to generate harnesses for."
      );
      const harnessService = steps.harnessGeneration(ctx, analysis.sourceQueries);
      const batch = await this.awaitStep(harnessService.generateAll(analysis.candidates), signal, state);
      if (batch.cancelled) {
        throw new RunCancelledSignal();
      }
      if (analysis.candidates.length > 0) {
        await consoleSvc.info(
          VisualizationStatus.GENERATING_HARNESSES,
          `${batch.results.length} harness(es) ready, ${batch.failures.length} failed.`
        );
      }

      // 9. rendering
      await this.checkpoint(ctx);
      const renderInputs = buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles); // 10 §5.13.1
      await this.advance(
        state,
        VisualizationStatus.RENDERING,
        consoleSvc,
        {},
        renderInputs.length > 0
          ? `Rendering ${renderInputs.length} component(s) on base and head.`
          : "Nothing to render."
      );
      const renders =
        renderInputs.length > 0
          ? await this.awaitStep(
              steps.render({ repairHarness: toRepairHarnessFn(harnessService) }).renderAll(ctx, renderInputs),
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
        await this.awaitStep(steps.structuralDiff().compare(ctx, { renders, diffs, analysis }), signal, state);
      }

      // 11. summarizing — always; worktrees and `analysis` are still alive (structural/related diffs read them).
      await this.checkpoint(ctx);
      await this.advance(state, VisualizationStatus.SUMMARIZING, consoleSvc, {}, "Writing the summary.");
      const outcome = await this.awaitStep(steps.summary().summarize(ctx, analysis), signal, state);
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
          changedCount: counts?.changedCount ?? 0
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
  ): Promise<{ componentCount: number; changedCount: number } | null> {
    let counts: { componentCount: number; changedCount: number } | null = null;
    if (state.status !== VisualizationStatus.QUEUED) {
      const swept = await this.deps.queryHandler.update(
        { renderStatus: ComponentRenderStatus.SKIPPED, skipReason: PENDING_SKIP_REASON[to] },
        { visualizationId: state.visualizationId, renderStatus: ComponentRenderStatus.PENDING },
        Table.VISUALIZATION_COMPONENTS
      );
      if (swept.status !== 200 && swept.status !== 404) {
        throw new Error("Pending sweep failed"); // 404 = nothing pending
      }
      counts = await this.componentCounts(state.visualizationId);
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
        `Completed: ${counts?.changedCount ?? 0} of ${counts?.componentCount ?? 0} component(s) changed visually.`
      );
    } else if (to === VisualizationStatus.CANCELLED) {
      await consoleSvc.warn(to, "Cancelled by user.");
    } else {
      await consoleSvc.error(to, fields.errorMessage ?? "Failed.");
    }
    return counts;
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
      skippedEntries: []
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
    limits: overrides.limits ?? { maxRuntimeMs: VISUALIZATION_MAX_RUNTIME_MS, stepAbortGraceMs: STEP_ABORT_GRACE_MS }
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
    intervalMs: overrides.intervalMs ?? RECOVERY_SWEEP_INTERVAL_MS
  };
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
