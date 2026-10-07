/**
 * Repair job processor (16 §11.4, D8, E2, E5, E25). Runs in the worker on the `harness-repairs` queue: recreates the
 * finished run's worktrees, asks 09 for a new harness for every requested card (one repair call plus at most one
 * correction), re-renders the card with it (no second fix-up), compares, and saves the new harness to the library
 * unconditionally (`expectedRevision: null`, revision + 1). Only the user starts a repair; nothing here runs on
 * its own. The run's summary is not regenerated.
 */
import { LIBRARY_REPAIR_MAX_RUNTIME_MS, STATE_ALLOWANCE_MAX } from "../../config-consts";
import {
  ComponentHarnessOrigin,
  HarnessLibraryOrigin,
  HarnessLibraryStatus,
  LibraryJobKind,
  LibraryJobStatus,
  Table,
  type RepositoryFramework
} from "../../enums";
import {
  HarnessLibraryJobModel,
  RepositoryModel,
  VisualizationComponentModel,
  VisualizationComponentStateModel,
  VisualizationModel
} from "../../models";
import {
  DEFAULT_STATE_NAME,
  identityKey,
  type HarnessLibraryEntryRecord,
  type HarnessLibraryStorePort,
  type HarnessStateSpec,
  type LibraryComponentIdentity
} from "../../types/harness-library";
import {
  isPipelineStepError,
  PipelineStepError,
  type AiProvider,
  type AiUsage,
  type ComponentCandidate,
  type ComponentRenderResult,
  type ComponentSourceQueries,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type MockedModule,
  type PipelineContext,
  type PreparedWorkspace,
  type RenderFailureKindValue,
  type WorktreeSide
} from "../../types/visualization-pipeline";
import {
  AiProviderFactory,
  ArtifactStore,
  createLogger,
  QueryHandler,
  QueueService,
  redactSecrets,
  resolveInside,
  type LibraryJob,
  type ResolvedAiSettings
} from "../../utilities";
import { SettingsStore } from "../settings/settings-store";
import { VisualizationConsoleService } from "../visualizations/visualization-console-service";
import { AiUsageRecorder } from "../visualizations/pipeline/ai-usage-recorder";
import { readConfinedText } from "../visualizations/pipeline/change-source";
import { stepFactoriesFor } from "../visualizations/pipeline/frameworks";
import {
  capText,
  HARNESS_NOTES_MAX_CHARS,
  NoopHarnessPersistence
} from "../visualizations/pipeline/harness-generation-service";
import { extractHarnessStates } from "../visualizations/pipeline/harness-states";
import { isRepairableFailure } from "../visualizations/pipeline/render/render-errors";
import { sideHarnessResult, withRepairedSide } from "../visualizations/pipeline/render/replaced-harness";
import type { RenderComponentInput, RepairHarnessFn } from "../visualizations/pipeline/render-service";
import type { PipelineStepFactories } from "../visualizations/pipeline/stage-registry";
import {
  classifyRunFailure,
  countCheckedComponents,
  countNeedsUpdateComponents,
  countRunComponents,
  sideRenderOutcome
} from "../visualizations/pipeline/visualization-worker-service";
import { RunWorkspaceRecreator, type RecreatedWorkspace } from "../visualizations/run-workspace-recreator";
import { LibraryFingerprinter } from "./library-fingerprint";
import { HarnessLibraryStore } from "./harness-library-store";
import { LibraryJobConsole } from "./library-job-console";
import { transitionLibraryJob, type LibraryJobTransitionFields } from "./library-job-state";
import { CompositeUsageRecorder, LibraryJobUsageRecorder } from "./library-job-usage-recorder";
import { createWorkspaceSourceQueries } from "./library-source-queries";
import { REPAIR_WORKTREE_PREFIX } from "./library-workspace";

/** Outcome of one run() call. "skipped": the job was not a queued repair (no writes). */
export type LibraryRepairOutcome = "completed" | "failed" | "cancelled" | "skipped";

/** How one requested card ended (job counters, §11.4 steps 3.4–3.6). */
export type RepairComponentResult = "written" | "failed" | "skipped";

/** Everything the processor talks to; tests replace any subset. */
export interface HarnessRepairWorkerDependencies {
  queryHandler: QueryHandler;
  store: Pick<HarnessLibraryStorePort, "get" | "saveWritten" | "moveIdentity">;
  /** new SettingsStore().readAiSettings(). */
  readAiSettings: () => Promise<ResolvedAiSettings>;
  /** AiProviderFactory.create. */
  createProvider: (settings: ResolvedAiSettings) => AiProvider;
  /** Stage factories of the repository's framework (`stepFactoriesFor`). */
  stepsFor: (framework: RepositoryFramework) => PipelineStepFactories;
  recreator: Pick<RunWorkspaceRecreator, "recreate">;
  /** createWorkspaceSourceQueries. */
  createSourceQueries: (ctx: PipelineContext) => Promise<ComponentSourceQueries>;
  queue: Pick<typeof QueueService, "isLibraryCancelRequested" | "clearLibraryCancel">;
  consoleFactory: (jobId: number) => Pick<LibraryJobConsole, "info" | "warn" | "error" | "asPipelineConsole">;
  /** The run's console (one event after the loop, §11.4 step 4). */
  runConsoleFactory: (visualizationId: number) => Pick<VisualizationConsoleService, "info">;
  /** The run's AI usage (`visualizations.ai_usage`); the job's recorder is added next to it. */
  runUsageRecorder: (visualizationId: number) => Pick<AiUsageRecorder, "add">;
  fingerprinter: Pick<LibraryFingerprinter, "fingerprint">;
  /** `<dataDir>/worktrees`. */
  worktreesRoot: string;
  now: () => Date;
  /** LIBRARY_REPAIR_MAX_RUNTIME_MS. */
  limits: { maxRuntimeMs: number };
}

/** One harness to repair on a card: the error 09 receives and, for `replaced` rows, the side (00 §17). */
export interface RepairTarget {
  /** `replaced` rows only: the side whose own harness is repaired. */
  side: WorktreeSide | null;
  renderError: HarnessRenderError;
}

interface JobCounters {
  written: number;
  failed: number;
  skipped: number;
}

interface JobRun {
  job: HarnessLibraryJobModel;
  status: LibraryJobStatus;
  framework: RepositoryFramework;
  console: Pick<LibraryJobConsole, "info" | "warn" | "error" | "asPipelineConsole">;
  /** Set once the job is running: the run's counts and console event are written after the loop. */
  visualization: VisualizationModel | null;
  counters: JobCounters;
}

interface RepairContext {
  run: JobRun;
  ctx: PipelineContext;
  steps: PipelineStepFactories;
  generation: { repairHarness: RepairHarnessFn };
  signal: AbortSignal;
}

/** Abort reason of the 30-minute limit. */
export class LibraryRepairTimeoutError extends Error {
  override readonly name = "LibraryRepairTimeoutError";

  constructor(readonly limitMs: number) {
    super(`Library repair exceeded ${String(limitMs)} ms`);
  }
}

/** Thrown at a checkpoint before the loop when the user cancelled. */
class RepairCancelledSignal extends Error {
  override readonly name = "RepairCancelledSignal";
}

/** Thrown when the run signal aborted (shutdown or the time limit); classified by its reason. */
class RepairAbortedSignal extends Error {
  override readonly name = "RepairAbortedSignal";
}

/** A guarded transition lost: another writer moved the job (library.job.skipped). */
class RepairJobConflictError extends Error {
  override readonly name = "RepairJobConflictError";
}

const SIDES: readonly WorktreeSide[] = ["base", "head"];
const MS_PER_MINUTE = 60_000;
const SHORT_ERROR_MAX_CHARS = 200;
const OTHER_SIDE_MESSAGE_MAX_CHARS = 1_000;
const SHUTDOWN_MESSAGE = "PRVision stopped while this repair was running. Run Repair again.";
const UNEXPECTED_MESSAGE = "Unexpected error during the repair. See the worker log for details.";
const RUN_REMOVED_MESSAGE = "The run was removed.";
const REPOSITORY_REMOVED_MESSAGE = "The repository was removed.";
const NOT_RENDERED_MESSAGE = "The harness was not rendered.";
const NO_FIX_UP_MESSAGE = "A repaired harness gets no second fix-up.";
const NO_FAILURE_MESSAGE = "No render failure was recorded for this card; there is nothing to repair.";

/** The single bounded fix-up does not apply to a repair's render (§11.4 step 3.4). */
const noFixUp: RepairHarnessFn = () =>
  Promise.resolve({ ok: false, reason: "budget_exhausted", message: NO_FIX_UP_MESSAGE });

/** First line of an error message, redacted and capped (job events). */
function shortError(message: string): string {
  const firstLine = redactSecrets(message).split("\n")[0] ?? "";
  return firstLine.slice(0, SHORT_ERROR_MAX_CHARS);
}

function otherSide(side: WorktreeSide): WorktreeSide {
  return side === "base" ? "head" : "base";
}

function isRepairableKind(kind: RenderFailureKindValue | null): kind is HarnessRenderError["kind"] {
  return kind !== null && isRepairableFailure(kind);
}

function mockedModulesOf(value: unknown): MockedModule[] {
  return Array.isArray(value)
    ? value.filter(
        (mock): mock is MockedModule =>
          typeof mock === "object" &&
          mock !== null &&
          typeof (mock as { specifier?: unknown }).specifier === "string" &&
          typeof (mock as { source?: unknown }).source === "string"
      )
    : [];
}

/** A `replaced` row with both harness snapshots (each side is repaired on its own, 00 §17). */
export function isTwoSidedRow(row: VisualizationComponentModel): boolean {
  return row.changeKind === "replaced" && (row.baseHarnessSource ?? "") !== "";
}

/** The sides a same-harness row exists on (by change kind). */
function rowSides(row: VisualizationComponentModel): Record<WorktreeSide, boolean> {
  return { base: row.changeKind !== "added", head: row.changeKind !== "removed" };
}

/** E5: the side whose render drives the library status of a same-harness row (head; base when only on base). */
export function statusSideOf(row: VisualizationComponentModel): WorktreeSide {
  return row.changeKind === "removed" ? "base" : "head";
}

/** `rename from <path>` of a git-style diff header (08's code diffs of renamed files), else null. */
export function renamedFrom(codeDiff: string | null): string | null {
  if (codeDiff === null) {
    return null;
  }
  for (const line of codeDiff.split("\n")) {
    if (line.startsWith("@@") || line.startsWith("--- ")) {
      return null;
    }
    if (line.startsWith("rename from ")) {
      const previous = line.slice("rename from ".length).trim();
      return previous === "" ? null : previous;
    }
  }
  return null;
}

/** The run's candidate for a component row (the base path of a renamed file is read from its code diff). */
export function candidateFromRow(row: VisualizationComponentModel): {
  candidate: ComponentCandidate;
  basePath: string | null;
} {
  const replaced = row.changeKind === "replaced" && row.baseFilePath !== null;
  const candidate: ComponentCandidate = {
    componentId: row.id,
    filePath: row.filePath,
    exportName: row.exportName,
    displayName: row.displayName,
    changeKind: row.changeKind,
    rank: row.rank,
    codeDiff: row.codeDiff,
    reason: row.changeReason ?? "",
    ...(replaced
      ? {
          predecessor: {
            filePath: row.baseFilePath,
            exportName: row.baseExportName ?? row.exportName,
            displayName: row.baseDisplayName ?? row.displayName,
            evidence: row.successorEvidence ?? []
          }
        }
      : {})
  };
  const basePath =
    row.changeKind === "added" ? null : replaced ? row.baseFilePath : (renamedFrom(row.codeDiff) ?? row.filePath);
  return { candidate, basePath };
}

/** States of a harness snapshot (legacy shapes accepted; any allowance, the snapshot was valid when written). */
function statesOf(source: string, framework: RepositoryFramework): HarnessStateSpec[] {
  const extraction = extractHarnessStates(source, framework, {
    stateAllowance: STATE_ALLOWANCE_MAX,
    allowLegacy: true
  });
  return extraction.ok ? extraction.states : [];
}

/**
 * §11.4 step 3.1: the row's harness snapshot as 09's `previous` (E2: the run's snapshot, not the library's current
 * revision). Null when the row has no harness.
 */
export function previousHarnessOf(
  row: VisualizationComponentModel,
  framework: RepositoryFramework
): HarnessGenerationResult | null {
  const source = row.harnessSource ?? "";
  if (source.trim() === "") {
    return null;
  }
  const origin = row.harnessOrigin === "library" ? "library" : "written";
  const baseSource = row.baseHarnessSource ?? "";
  return {
    componentId: row.id,
    harnessSource: source,
    mockedModules: mockedModulesOf(row.mockedModules),
    notes: row.harnessNotes ?? "",
    states: statesOf(source, framework),
    origin,
    libraryEntryId: row.libraryEntryId,
    ...(isTwoSidedRow(row)
      ? {
          baseHarness: {
            harnessSource: baseSource,
            mockedModules: mockedModulesOf(row.baseMockedModules),
            notes: row.baseHarnessNotes ?? "",
            states: statesOf(baseSource, framework),
            origin: row.baseHarnessOrigin === "library" ? "library" : "written",
            libraryEntryId: row.baseLibraryEntryId
          }
        }
      : {})
  };
}

interface SideFailure {
  kind: RenderFailureKindValue | null;
  error: string;
}

/** One state's failure on one side, from a state row (or the row's own columns for rows without state rows). */
function failureOn(
  state: Pick<VisualizationComponentStateModel, "baseError" | "headError" | "baseFailureKind" | "headFailureKind">,
  side: WorktreeSide
): SideFailure | null {
  const error = side === "base" ? state.baseError : state.headError;
  const kind = side === "base" ? state.baseFailureKind : state.headFailureKind;
  if ((error === null || error === "") && kind === null) {
    return null;
  }
  return { kind, error: error ?? "" };
}

/** Rows without state rows (legacy): one synthesized Default from the row's errors; the kind is unknown. */
function stateRowsOrDefault(
  row: VisualizationComponentModel,
  states: readonly VisualizationComponentStateModel[]
): Array<{
  ordinal: number;
  stateName: string;
  baseError: string | null;
  headError: string | null;
  baseFailureKind: RenderFailureKindValue | null;
  headFailureKind: RenderFailureKindValue | null;
}> {
  if (states.length > 0) {
    return [...states]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((state) => ({
        ordinal: state.ordinal,
        stateName: state.stateName,
        baseError: state.baseError,
        headError: state.headError,
        baseFailureKind: state.baseFailureKind,
        headFailureKind: state.headFailureKind
      }));
  }
  return [
    {
      ordinal: 0,
      stateName: DEFAULT_STATE_NAME,
      baseError: row.baseError,
      headError: row.headError,
      baseFailureKind: null,
      headFailureKind: null
    }
  ];
}

/**
 * §11.4 steps 3.1–3.2: what to repair on a card. Same-harness rows: one target, the first state (ordinal order) with
 * a harness-attributable failure on the status side, else on any side (`sides` lists the sides that state failed
 * on). `replaced` rows: one target per side whose states show a harness-attributable failure (`targetSide`). A
 * failure whose kind was not recorded (legacy rows) counts as `render_error`. [] when nothing failed.
 */
export function repairTargets(
  row: VisualizationComponentModel,
  states: readonly VisualizationComponentStateModel[]
): RepairTarget[] {
  const rows = stateRowsOrDefault(row, states);
  const legacy = states.length === 0;
  const attributable = (failure: SideFailure | null): boolean =>
    failure !== null &&
    (legacy ? failure.kind === null || isRepairableKind(failure.kind) : isRepairableKind(failure.kind));
  const kindOf = (failure: SideFailure): HarnessRenderError["kind"] =>
    isRepairableKind(failure.kind) ? failure.kind : "render_error";
  const stateNameOf = (name: string): { stateName?: string } =>
    name === DEFAULT_STATE_NAME ? {} : { stateName: name };

  if (isTwoSidedRow(row)) {
    const targets: RepairTarget[] = [];
    for (const side of ["head", "base"] as const) {
      for (const state of rows) {
        const failure = failureOn(state, side);
        if (failure !== null && attributable(failure)) {
          targets.push({
            side,
            renderError: {
              sides: [side],
              kind: kindOf(failure),
              message: failure.error,
              otherSideMessage: null,
              targetSide: side,
              ...stateNameOf(state.stateName)
            }
          });
          break;
        }
      }
    }
    return targets;
  }

  const present = rowSides(row);
  const statusSide = statusSideOf(row);
  const order: WorktreeSide[] = [statusSide, otherSide(statusSide)].filter((side) => present[side]);
  for (const pass of ["attributable", "any"] as const) {
    for (const side of order) {
      for (const state of rows) {
        const failure = failureOn(state, side);
        if (failure === null || (pass === "attributable" && !attributable(failure))) {
          continue;
        }
        const other = present[otherSide(side)] ? failureOn(state, otherSide(side)) : null;
        const otherMessage =
          other !== null && other.error !== "" ? other.error.slice(0, OTHER_SIDE_MESSAGE_MAX_CHARS) : null;
        return [
          {
            side: null,
            renderError: {
              sides: SIDES.filter((candidate) => candidate === side || other !== null),
              kind: kindOf(failure),
              message: failure.error,
              otherSideMessage: otherMessage,
              ...stateNameOf(state.stateName)
            }
          }
        ];
      }
    }
  }
  return [];
}

/** `Repaired by job <id> on <ISO date>.` (§11.4 step 3.4). */
export function repairedByLine(jobId: number, at: Date): string {
  return `Repaired by job ${String(jobId)} on ${at.toISOString().slice(0, 10)}.`;
}

/** Processes one repair job (16 §11.4). */
export class HarnessRepairWorkerService {
  private readonly deps: HarnessRepairWorkerDependencies;
  private readonly log = createLogger("library-repair");

  constructor(deps: Partial<HarnessRepairWorkerDependencies> = {}) {
    const queryHandler = deps.queryHandler ?? new QueryHandler();
    this.deps = {
      queryHandler,
      store: deps.store ?? new HarnessLibraryStore(),
      readAiSettings: deps.readAiSettings ?? (() => new SettingsStore().readAiSettings()),
      createProvider: deps.createProvider ?? ((settings) => AiProviderFactory.create(settings)),
      stepsFor: deps.stepsFor ?? stepFactoriesFor,
      recreator: deps.recreator ?? new RunWorkspaceRecreator(),
      createSourceQueries: deps.createSourceQueries ?? createWorkspaceSourceQueries,
      queue: deps.queue ?? QueueService,
      consoleFactory: deps.consoleFactory ?? ((jobId) => new LibraryJobConsole(jobId, queryHandler)),
      runConsoleFactory:
        deps.runConsoleFactory ?? ((visualizationId) => new VisualizationConsoleService(visualizationId, queryHandler)),
      runUsageRecorder:
        deps.runUsageRecorder ?? ((visualizationId) => new AiUsageRecorder(visualizationId, queryHandler)),
      fingerprinter: deps.fingerprinter ?? new LibraryFingerprinter(),
      worktreesRoot: deps.worktreesRoot ?? new ArtifactStore().worktreesRoot(),
      now: deps.now ?? ((): Date => new Date()),
      limits: deps.limits ?? { maxRuntimeMs: LIBRARY_REPAIR_MAX_RUNTIME_MS }
    };
  }

  /** `<dataDir>/worktrees/repair-<jobId>` (00 §21 item 2). */
  repairRoot(jobId: number): string {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      throw new Error(`Invalid job id ${String(jobId)}`);
    }
    return resolveInside(this.deps.worktreesRoot, `${REPAIR_WORKTREE_PREFIX}${String(jobId)}`);
  }

  /**
   * Runs the job. Never throws for job failures (they are recorded on the row); rethrows only when the job row
   * cannot be loaded at all (DB down), so BullMQ marks the job failed and recovery fixes the row later.
   */
  async run(job: LibraryJob): Promise<LibraryRepairOutcome> {
    const { libraryJobId } = job;
    const row = await this.deps.queryHandler.validateAndSelect(
      HarnessLibraryJobModel,
      { id: libraryJobId },
      Table.HARNESS_LIBRARY_JOBS
    );
    if (
      row === null ||
      row.status !== LibraryJobStatus.QUEUED ||
      row.kind !== LibraryJobKind.REPAIR ||
      row.visualizationId === null
    ) {
      this.log.warn(
        { event: "library.job.skipped", jobId: libraryJobId, status: row?.status ?? null, kind: row?.kind ?? null },
        "Library job is not a queued repair; job skipped"
      );
      return "skipped";
    }
    const visualizationId = row.visualizationId;

    const run: JobRun = {
      job: row,
      status: LibraryJobStatus.QUEUED,
      framework: "react_vite",
      console: this.deps.consoleFactory(row.id),
      visualization: null,
      counters: { written: 0, failed: 0, skipped: 0 }
    };
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new LibraryRepairTimeoutError(this.deps.limits.maxRuntimeMs));
    }, this.deps.limits.maxRuntimeMs);
    timer.unref();
    // Cancel is checked between components (§11.4 step 3); only shutdown and the time limit abort work in flight.
    const shutdown = new AbortController();
    const onJobAbort = (): void => {
      if (job.signal.reason === "shutdown") {
        shutdown.abort("shutdown");
      }
    };
    if (job.signal.aborted) {
      onJobAbort();
    } else {
      job.signal.addEventListener("abort", onJobAbort, { once: true });
    }
    const signal = AbortSignal.any([shutdown.signal, timeout.signal]);
    let recreated: RecreatedWorkspace | null = null;

    try {
      if (await this.isCancelled(job)) {
        throw new RepairCancelledSignal();
      }

      // 1. Run, repository, AI settings; queued → preparing; the run's worktrees
      const visualization = await this.deps.queryHandler.validateAndSelect(
        VisualizationModel,
        { id: visualizationId },
        Table.VISUALIZATIONS
      );
      if (visualization === null) {
        throw new PipelineStepError("preparing", RUN_REMOVED_MESSAGE);
      }
      const repository = await this.deps.queryHandler.validateAndSelect(
        RepositoryModel,
        { id: visualization.repositoryId },
        Table.REPOSITORIES
      );
      if (repository === null) {
        throw new PipelineStepError("preparing", REPOSITORY_REMOVED_MESSAGE);
      }
      run.framework = repository.framework;
      const settings = await this.deps.readAiSettings();
      const ai = this.deps.createProvider(settings);

      await this.advance(run, LibraryJobStatus.PREPARING);
      recreated = await this.deps.recreator.recreate({
        visualization,
        repository,
        rootDir: this.repairRoot(row.id),
        console: run.console.asPipelineConsole(),
        signal
      });
      this.throwIfAborted(signal);
      if (await this.isCancelled(job)) {
        throw new RepairCancelledSignal();
      }

      // 2. Context on the run (its rows and artifact folders), usage on the run and the job
      const ctx = this.buildContext(row, visualization, repository, recreated.workspace, ai, settings, run, signal);
      const queries = await this.deps.createSourceQueries(ctx);
      const usageRecorder = new CompositeUsageRecorder([
        this.deps.runUsageRecorder(visualization.id),
        new LibraryJobUsageRecorder(row.id, row.aiModel, this.deps.queryHandler, {
          spentUsd: row.spentUsd,
          calls: row.aiUsage?.calls ?? 0
        })
      ]);
      const steps = this.deps.stepsFor(repository.framework);
      const generation = steps.harnessGeneration(ctx, queries, {
        persistence: new NoopHarnessPersistence(),
        usageRecorder
      });

      // 3. preparing → running; one card at a time, cancel checked between cards
      await this.advance(run, LibraryJobStatus.RUNNING);
      run.visualization = visualization;
      const componentIds = row.componentIds ?? [];
      await run.console.info(
        `Repairing ${String(componentIds.length)} harness(es) of run #${String(visualization.id)} with ${settings.model}, up to ${String(row.stateAllowance)} states each.`
      );
      const repairCtx: RepairContext = {
        run,
        ctx,
        steps,
        generation: { repairHarness: (id, previous, error) => generation.repairHarness(id, previous, error) },
        signal
      };
      let cancelled = false;
      for (const componentId of componentIds) {
        if (await this.isCancelled(job)) {
          cancelled = true;
          break;
        }
        this.throwIfAborted(signal);
        const result = await this.repairComponent(repairCtx, componentId, recreated.workspace);
        run.counters[result] += 1;
        await this.updateJob(row.id, {
          writtenCount: run.counters.written,
          failedCount: run.counters.failed,
          skippedCount: run.counters.skipped
        });
      }

      // 4 + 5. Run counts and console event; terminal status
      await this.afterLoop(run);
      if (cancelled) {
        await this.finish(
          run,
          LibraryJobStatus.CANCELLED,
          { currentLabel: null },
          `Cancelled. ${String(run.counters.written)} harness(es) repaired so far are kept.`
        );
        return "cancelled";
      }
      await this.finish(
        run,
        LibraryJobStatus.COMPLETED,
        { currentLabel: null },
        `Done: ${String(run.counters.written)} repaired, ${String(run.counters.failed)} failed, ${String(run.counters.skipped)} skipped.`
      );
      return "completed";
    } catch (error: unknown) {
      return await this.finishWithError(run, error, signal);
    } finally {
      clearTimeout(timer);
      job.signal.removeEventListener("abort", onJobAbort);
      if (recreated !== null) {
        await recreated.cleanup(); // never throws
      }
      try {
        await this.deps.queue.clearLibraryCancel(row.id);
      } catch (error: unknown) {
        this.log.warn(
          { event: "library.job.cancel_clear_failed", jobId: row.id, err: error },
          "Cancel flag clear failed"
        );
      }
    }
  }

  // ----- one card (§11.4 step 3) -----

  private async repairComponent(
    input: RepairContext,
    componentId: number,
    workspace: PreparedWorkspace
  ): Promise<RepairComponentResult> {
    const { run } = input;
    const jobId = run.job.id;
    const visualizationId = input.ctx.visualizationId;
    const row = await this.deps.queryHandler.validateAndSelect(
      VisualizationComponentModel,
      { id: componentId, visualizationId },
      Table.VISUALIZATION_COMPONENTS
    );
    if (row === null) {
      await run.console.error(`Component #${String(componentId)} is no longer part of this run.`);
      this.logComponent(jobId, componentId, "missing");
      return "failed";
    }
    const name = row.displayName;
    await this.updateJob(jobId, { currentLabel: `Repairing ${name} (${row.filePath})` });

    // 3.1 previous harness and the state rows
    const previous = previousHarnessOf(row, run.framework);
    if (previous === null) {
      await run.console.error(`${name}: this card has no harness to repair.`);
      this.logComponent(jobId, componentId, "no_harness");
      return "failed";
    }
    const states = await this.deps.queryHandler.selectMany(
      VisualizationComponentStateModel,
      { visualizationComponentId: row.id },
      Table.VISUALIZATION_COMPONENT_STATES,
      { orderBy: [{ column: "ordinal", direction: "asc" }] }
    );

    // 3.2 the render errors, 3.3 one AI repair per target
    const targets = repairTargets(row, states);
    if (targets.length === 0) {
      await run.console.error(`${name}: ${NO_FAILURE_MESSAGE}`);
      this.logComponent(jobId, componentId, "no_failure");
      return "failed";
    }
    const outcomes: Array<{ target: RepairTarget; outcome: HarnessRepairOutcome }> = [];
    for (const target of targets) {
      const sidePrevious = target.side === null ? previous : sideHarnessResult(previous, target.side);
      const outcome = await input.generation.repairHarness(row.id, sidePrevious, target.renderError);
      this.throwIfAborted(input.signal);
      if (!outcome.ok && outcome.reason === "cancelled") {
        throw new RepairAbortedSignal("repair aborted");
      }
      outcomes.push({ target, outcome });
    }

    // 3.5 component defects: the harness is fine, the card's verdict is kept in its notes
    const rowValues: Record<string, unknown> = {};
    const defectSides = new Set<WorktreeSide | null>();
    for (const { target, outcome } of outcomes) {
      if (outcome.ok || outcome.reason !== "component_defect") {
        continue;
      }
      defectSides.add(target.side);
      if (target.side === "base") {
        rowValues.baseHarnessNotes = capText(
          `${row.baseHarnessNotes ?? ""}\n\n${outcome.notesAppendix}`,
          HARNESS_NOTES_MAX_CHARS
        );
      } else {
        rowValues.harnessNotes = capText(
          `${row.harnessNotes ?? ""}\n\n${outcome.notesAppendix}`,
          HARNESS_NOTES_MAX_CHARS
        );
      }
      await run.console.info(`${name}: the component itself is broken (${shortError(outcome.message)}).`);
    }
    // 3.6 failures: row unchanged
    let failed = false;
    for (const { outcome } of outcomes) {
      if (!outcome.ok && outcome.reason !== "component_defect") {
        failed = true;
        await run.console.error(`${name}: ${shortError(outcome.message)}`);
      }
    }

    // 3.4 new harnesses: snapshot, render, compare, library
    const repaired = outcomes.filter(
      (entry): entry is { target: RepairTarget; outcome: Extract<HarnessRepairOutcome, { ok: true }> } =>
        entry.outcome.ok
    );
    if (repaired.length === 0) {
      if (defectSides.size > 0 && !failed) {
        rowValues.harnessNeedsUpdate = false;
      }
      if (Object.keys(rowValues).length > 0) {
        await this.updateRow(row, rowValues);
      }
      const result: RepairComponentResult = failed ? "failed" : "skipped";
      this.logComponent(jobId, componentId, failed ? "failed" : "component_defect");
      return result;
    }

    const repairedLine = repairedByLine(jobId, this.deps.now());
    let harness: HarnessGenerationResult = previous;
    for (const { target, outcome } of repaired) {
      const result: HarnessGenerationResult = {
        ...outcome.result,
        componentId: row.id,
        notes: capText(`${outcome.result.notes}\n${repairedLine}`, HARNESS_NOTES_MAX_CHARS)
      };
      harness = target.side === null ? result : withRepairedSide(harness, target.side, result);
      if (target.side === "base") {
        rowValues.baseHarnessSource = result.harnessSource;
        rowValues.baseHarnessNotes = result.notes;
        rowValues.baseMockedModules = result.mockedModules;
      } else {
        rowValues.harnessSource = result.harnessSource;
        rowValues.harnessNotes = result.notes;
        rowValues.mockedModules = result.mockedModules;
      }
    }
    await this.updateRow(row, rowValues);

    const { candidate, basePath } = candidateFromRow(row);
    const renderInput: RenderComponentInput = { candidate, harness, basePath };
    let render: ComponentRenderResult | null = null;
    let renderFailure: string | null = null;
    try {
      const renders = await input.steps.render({ repairHarness: noFixUp }).renderAll(input.ctx, [renderInput]);
      render = renders.find((entry) => entry.componentId === row.id) ?? null;
    } catch (error: unknown) {
      if (input.signal.aborted) {
        throw new RepairAbortedSignal("render aborted", { cause: error });
      }
      renderFailure = isPipelineStepError(error) ? error.userMessage : NOT_RENDERED_MESSAGE;
      this.log.warn({ event: "library.repair.render_failed", jobId, componentId, err: error }, "Repair render failed");
    }
    this.throwIfAborted(input.signal);
    if (render !== null) {
      try {
        await input.steps.imageDiff().diff(input.ctx, [render]);
      } catch (error: unknown) {
        if (input.signal.aborted) {
          throw new RepairAbortedSignal("diff aborted", { cause: error });
        }
        await run.console.warn(
          `${name}: could not compare the new screenshots (${shortError(isPipelineStepError(error) ? error.userMessage : String(error))}).`
        );
      }
    }

    // library save and the card's flags, per repaired side
    const finalValues: Record<string, unknown> = {};
    let allRendered = true;
    let firstError: string | null = renderFailure;
    for (const { target, outcome } of repaired) {
      const side = target.side;
      const statusSide: WorktreeSide = side ?? statusSideOf(row);
      const sideOutcome =
        render === null
          ? { allOk: false, firstError: renderFailure ?? NOT_RENDERED_MESSAGE }
          : sideRenderOutcome(render, statusSide);
      if (!sideOutcome.allOk) {
        allRendered = false;
        firstError ??= sideOutcome.firstError ?? NOT_RENDERED_MESSAGE;
      }
      const sideHarness = side === null ? harness : sideHarnessResult(harness, side);
      const entryId = await this.saveToLibrary(input, row, {
        side,
        statusSide,
        workspace,
        harness: {
          harnessSource: sideHarness.harnessSource,
          mockedModules: sideHarness.mockedModules,
          notes: sideHarness.notes,
          states: sideHarness.states
        },
        lastError: sideOutcome.allOk ? null : (sideOutcome.firstError ?? NOT_RENDERED_MESSAGE),
        usage: outcome.result.usage ?? null
      });
      if (side === "base") {
        finalValues.baseHarnessOrigin = ComponentHarnessOrigin.REPAIRED;
        if (entryId !== null) {
          finalValues.baseLibraryEntryId = entryId;
        }
      } else {
        finalValues.harnessOrigin = ComponentHarnessOrigin.REPAIRED;
        if (entryId !== null) {
          finalValues.libraryEntryId = entryId;
          finalValues.sourceChangedSinceWrite = false;
        }
      }
    }
    // E5 on the new render; a side the AI judged a component defect does not flag the card
    if (render !== null) {
      finalValues.harnessNeedsUpdate = SIDES.some((side) => {
        const owner: WorktreeSide | null = isTwoSidedRow(row) ? side : null;
        return !defectSides.has(owner) && sideRenderOutcome(render, side).harnessError !== null;
      });
    }
    await this.updateRow(row, finalValues);

    if (renderFailure !== null) {
      // The render engine itself failed (not this harness): later cards would fail the same way, so the job stops.
      await run.console.error(`${name}: the repaired harness could not be rendered (${shortError(renderFailure)}).`);
      this.logComponent(jobId, componentId, "render_failed");
      run.counters.failed += 1;
      await this.updateJob(jobId, { failedCount: run.counters.failed });
      throw new PipelineStepError("rendering", renderFailure);
    }
    const stateCount = render?.states.length ?? 0;
    if (allRendered && !failed) {
      await run.console.info(
        `${name}: harness repaired and re-rendered (${String(Math.max(stateCount, 1))} state(s)).`
      );
      this.logComponent(jobId, componentId, "written");
      return "written";
    }
    if (!allRendered) {
      await run.console.warn(
        `${name}: the repaired harness still does not render (${shortError(firstError ?? NOT_RENDERED_MESSAGE)}).`
      );
    }
    this.logComponent(jobId, componentId, "failed");
    return "failed";
  }

  /**
   * `saveWritten` with origin `repair` and `expectedRevision: null` (E25: an explicit user action replaces the entry,
   * revision + 1). The entry of the run's row is kept when it lives at another identity (a renamed component: it
   * moves to the new path after a successful head render, as runs do). Returns the entry id, or null when the
   * library could not be updated (the card keeps its new harness; a job warning says why).
   */
  private async saveToLibrary(
    input: RepairContext,
    row: VisualizationComponentModel,
    values: {
      side: WorktreeSide | null;
      statusSide: WorktreeSide;
      workspace: PreparedWorkspace;
      harness: { harnessSource: string; mockedModules: MockedModule[]; notes: string; states: HarnessStateSpec[] };
      lastError: string | null;
      usage: AiUsage | null;
    }
  ): Promise<number | null> {
    const { run, ctx } = input;
    const base = values.side === "base";
    const rowIdentity: LibraryComponentIdentity = base
      ? { filePath: row.baseFilePath ?? row.filePath, exportName: row.baseExportName ?? row.exportName }
      : { filePath: row.filePath, exportName: row.exportName };
    const displayName = base ? (row.baseDisplayName ?? row.displayName) : row.displayName;
    const entryId = base ? row.baseLibraryEntryId : row.libraryEntryId;
    try {
      const existing: HarnessLibraryEntryRecord | null = entryId === null ? null : await this.deps.store.get(entryId);
      const identity: LibraryComponentIdentity =
        existing !== null && existing.repositoryId === ctx.repository.id
          ? { filePath: existing.filePath, exportName: existing.exportName }
          : rowIdentity;
      const root = values.statusSide === "base" ? values.workspace.baseDir : values.workspace.headDir;
      const sourceFingerprint = await this.fingerprintOf(ctx.repository.framework, rowIdentity, root);
      const ready = values.lastError === null;
      const outcome = await this.deps.store.saveWritten({
        repositoryId: ctx.repository.id,
        framework: ctx.repository.framework,
        identity,
        displayName,
        selector: existing?.selector ?? null,
        sourceFingerprint,
        harness: values.harness,
        stateAllowance: run.job.stateAllowance,
        status: ready ? HarnessLibraryStatus.READY : HarnessLibraryStatus.NEEDS_UPDATE,
        origin: HarnessLibraryOrigin.REPAIR,
        lastError: values.lastError,
        lastFailedVisualizationId: ready ? null : ctx.visualizationId,
        aiModel: run.job.aiModel,
        aiUsage: values.usage,
        expectedRevision: null
      });
      if (!outcome.saved) {
        // Unreachable with expectedRevision null; kept for the port's contract.
        await run.console.warn(`Kept a newer revision of ${displayName}.`);
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
      if (
        values.side === null &&
        values.statusSide === "head" &&
        ready &&
        identityKey(identity) !== identityKey(rowIdentity)
      ) {
        await this.deps.store.moveIdentity(outcome.entry.id, { ...rowIdentity, displayName });
      }
      return outcome.entry.id;
    } catch (error: unknown) {
      this.log.warn(
        { event: "library.repair.save_failed", jobId: run.job.id, componentId: row.id, err: error },
        "Library save after a repair failed"
      );
      await run.console.warn(
        `Could not update the harness library: ${shortError(error instanceof Error ? error.message : String(error))}`
      );
      return null;
    }
  }

  /** 16 §8.1 on the status side; null when it cannot be computed. */
  private async fingerprintOf(
    framework: RepositoryFramework,
    identity: LibraryComponentIdentity,
    root: string
  ): Promise<string | null> {
    try {
      return await this.deps.fingerprinter.fingerprint({
        framework,
        identity,
        readFile: (repoPath) => readConfinedText(root, repoPath)
      });
    } catch {
      return null;
    }
  }

  // ----- after the loop (§11.4 step 4) -----

  /** The run's counts with finish()'s formulas, then one console event on the run. */
  private async afterLoop(run: JobRun): Promise<void> {
    const visualization = run.visualization;
    if (visualization === null) {
      return;
    }
    const id = visualization.id;
    const [counts, checkedCount, needsUpdateCount] = await Promise.all([
      countRunComponents(this.deps.queryHandler, id),
      countCheckedComponents(this.deps.queryHandler, id),
      countNeedsUpdateComponents(this.deps.queryHandler, id)
    ]);
    const response = await this.deps.queryHandler.update(
      { changedCount: counts.changedCount, checkedCount, needsUpdateCount },
      { id },
      Table.VISUALIZATIONS
    );
    if (response.status !== 200) {
      throw new Error(`Run counts update failed (${String(response.status)})`);
    }
    await this.deps
      .runConsoleFactory(id)
      .info(
        visualization.status,
        `Repair: ${String(run.counters.written)} harness(es) repaired and re-rendered, ${String(run.counters.failed)} failed. The summary was written before the repair.`
      );
    run.visualization = null; // written once
  }

  // ----- helpers -----

  private buildContext(
    job: HarnessLibraryJobModel,
    visualization: VisualizationModel,
    repository: RepositoryModel,
    workspace: PreparedWorkspace,
    ai: AiProvider,
    settings: ResolvedAiSettings,
    run: JobRun,
    signal: AbortSignal
  ): PipelineContext {
    return {
      visualizationId: visualization.id,
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
        globalStylePaths: [...repository.globalStylePaths],
        renderViewport: visualization.renderViewport ?? repository.renderViewport
      },
      ai,
      aiSettings: {
        model: settings.model,
        harnessEffort: settings.harnessEffort,
        summaryEffort: settings.summaryEffort
      },
      console: run.console.asPipelineConsole(),
      // The cancel flag is checked between cards (§11.4 step 3): a card that started is finished and saved.
      isCancelled: () => Promise.resolve(false),
      signal,
      library: { stateAllowance: job.stateAllowance, buildMode: repository.libraryBuildMode },
      libraryJob: { kind: LibraryJobKind.REPAIR, libraryJobId: job.id }
    };
  }

  /** The cancel flag (or the job signal's "cancelled"); a Redis hiccup does not count as a cancellation. */
  private async isCancelled(job: LibraryJob): Promise<boolean> {
    if (job.signal.aborted && job.signal.reason === "cancelled") {
      return true;
    }
    try {
      return await this.deps.queue.isLibraryCancelRequested(job.libraryJobId);
    } catch (error: unknown) {
      this.log.warn(
        { event: "library.job.cancel_check_failed", jobId: job.libraryJobId, err: error },
        "Cancel flag check failed"
      );
      return false;
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new RepairAbortedSignal("repair aborted");
    }
  }

  private logComponent(jobId: number, componentId: number, outcome: string): void {
    this.log.info({ event: "library.repair.component", jobId, componentId, outcome }, "Repair of one card finished");
  }

  private async updateRow(row: VisualizationComponentModel, values: Record<string, unknown>): Promise<void> {
    if (Object.keys(values).length === 0) {
      return;
    }
    const response = await this.deps.queryHandler.update(
      values,
      { id: row.id, visualizationId: row.visualizationId },
      Table.VISUALIZATION_COMPONENTS
    );
    if (response.status !== 200) {
      throw new Error(`visualization_components update failed for id ${String(row.id)} (${String(response.status)})`);
    }
  }

  /** Guarded transition; a lost guard stops the job without further writes. */
  private async advance(run: JobRun, to: LibraryJobStatus, fields: LibraryJobTransitionFields = {}): Promise<void> {
    const ok = await transitionLibraryJob(this.deps.queryHandler, {
      jobId: run.job.id,
      from: run.status,
      to,
      fields,
      now: this.deps.now()
    });
    if (!ok) {
      throw new RepairJobConflictError(`Library job ${String(run.job.id)} was not in status ${run.status}`);
    }
    run.status = to;
  }

  /** Terminal transition plus the last event (the terminal message). */
  private async finish(
    run: JobRun,
    to: LibraryJobStatus,
    fields: LibraryJobTransitionFields,
    message: string,
    level: "info" | "warn" | "error" = "info"
  ): Promise<void> {
    await this.advance(run, to, fields);
    await run.console[level](message);
  }

  /** Counters and labels of a running job (only its own columns; usage and spend are the recorder's). */
  private async updateJob(jobId: number, values: Record<string, unknown>): Promise<void> {
    const response = await this.deps.queryHandler.update(values, { id: jobId }, Table.HARNESS_LIBRARY_JOBS);
    if (response.status !== 200) {
      throw new Error(`Library job ${String(jobId)} update failed (${String(response.status)})`);
    }
  }

  /** Maps a failure to the terminal status and message (§11.4 step 5) and writes it. Never throws. */
  private async finishWithError(run: JobRun, error: unknown, signal: AbortSignal): Promise<LibraryRepairOutcome> {
    const jobId = run.job.id;
    if (error instanceof RepairJobConflictError) {
      this.log.warn({ event: "library.job.skipped", jobId, status: run.status }, "Library job moved by another writer");
      return "skipped";
    }
    let to: "failed" | "cancelled" = "failed";
    let message: string | null;
    const reason: unknown = signal.reason;
    if (signal.aborted && reason instanceof LibraryRepairTimeoutError) {
      const minutes = Math.round(reason.limitMs / MS_PER_MINUTE);
      message = `Stopped after ${String(minutes)} minutes (time limit). Run Repair again for the rest.`;
    } else if (signal.aborted) {
      message = SHUTDOWN_MESSAGE;
    } else if (error instanceof RepairCancelledSignal) {
      to = "cancelled";
      message = null;
    } else {
      const classified = classifyRunFailure(error, undefined, false, "preparing");
      message = classified.unexpected ? UNEXPECTED_MESSAGE : classified.errorMessage;
      if (classified.unexpected) {
        this.log.error({ event: "library.repair.failed", jobId, err: error }, "Library repair failed unexpectedly");
      }
    }
    // Cards repaired before the failure keep their new harness; the run's counts and event still reflect them.
    if (run.visualization !== null && !signal.aborted) {
      try {
        await this.afterLoop(run);
      } catch (countError: unknown) {
        this.log.warn(
          { event: "library.repair.counts_failed", jobId, err: countError },
          "Run counts after a repair failed"
        );
      }
    }
    try {
      const fields: LibraryJobTransitionFields = { errorMessage: message, currentLabel: null };
      if (to === "cancelled") {
        await this.finish(run, LibraryJobStatus.CANCELLED, fields, "Cancelled before the repair started.");
      } else {
        await this.finish(run, LibraryJobStatus.FAILED, fields, message ?? UNEXPECTED_MESSAGE, "error");
      }
    } catch (writeError: unknown) {
      if (writeError instanceof RepairJobConflictError) {
        this.log.warn(
          { event: "library.job.skipped", jobId, status: run.status },
          "Library job moved by another writer"
        );
        return "skipped";
      }
      this.log.fatal(
        { event: "library.repair.terminal_write_failed", jobId, err: writeError },
        "Could not record the repair's final status"
      );
    }
    this.log.info({ event: "library.repair.finished", jobId, outcome: to }, "Library repair finished");
    return to;
  }
}
