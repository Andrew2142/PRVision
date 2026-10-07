/**
 * Scan and rescan job processor (16 §10.4, D11, D12, E13, E15, E16, E25, E26). Runs in the worker on the
 * `harness-scans` queue: one worktree of the default branch, the component inventory smallest first, then batches of
 * LIBRARY_SCAN_BATCH_SIZE harnesses written by 09 and verified by 10 on the scan commit (head only), each saved to
 * the library. Nothing here touches `artifacts/` or a visualization row: the context carries visualization id 0 and
 * every consumer of that id is replaced (job console, job usage recorder, in-memory render persistence, scratch
 * renders, library cancel flag). No entry is ever deleted.
 */
import { LIBRARY_SCAN_BATCH_SIZE, LIBRARY_SCAN_MAX_RUNTIME_MS } from "../../config-consts";
import {
  HarnessLibraryOrigin,
  HarnessLibraryStatus,
  LibraryJobStatus,
  Table,
  type RepositoryFramework
} from "../../enums";
import { HarnessLibraryJobModel, RepositoryModel } from "../../models";
import {
  identityKey,
  type ComponentInventory,
  type HarnessLibraryEntryRecord,
  type HarnessLibraryStorePort,
  type InventoryComponent,
  type SaveWrittenHarnessInput
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
  type PipelineContext
} from "../../types/visualization-pipeline";
import {
  addUsage,
  AiProviderFactory,
  createLogger,
  QueryHandler,
  QueueService,
  redactSecrets,
  type LibraryJob,
  type ResolvedAiSettings
} from "../../utilities";
import { SettingsStore } from "../settings/settings-store";
import { stepFactoriesFor } from "../visualizations/pipeline/frameworks";
import { NoopHarnessPersistence } from "../visualizations/pipeline/harness-generation-service";
import { buildRenderInputs, type RepairHarnessFn } from "../visualizations/pipeline/render-service";
import type { PipelineStepFactories } from "../visualizations/pipeline/stage-registry";
import {
  classifyRunFailure,
  sideRenderOutcome,
  toRepairHarnessFn
} from "../visualizations/pipeline/visualization-worker-service";
import { ComponentInventoryService } from "./component-inventory";
import { HarnessLibraryStore } from "./harness-library-store";
import { LibraryJobConsole } from "./library-job-console";
import { transitionLibraryJob, type LibraryJobTransitionFields } from "./library-job-state";
import { LibraryJobUsageRecorder, SpendCapGuard } from "./library-job-usage-recorder";
import { createWorkspaceSourceQueries } from "./library-source-queries";
import { LibraryWorkspace, type ScanWorkspace } from "./library-workspace";
import { InMemoryRenderPersistence, ScanArtifactStore } from "./scan-render-adapters";

/** Outcome of one run() call. "skipped": the job was not a queued scan (no writes). */
export type LibraryScanOutcome = "completed" | "cap_reached" | "failed" | "cancelled" | "skipped";

/** The scratch render store a scan needs (ScanArtifactStore in production). */
export type ScanScratchStore = Pick<
  ScanArtifactStore,
  "imagePaths" | "ensureComponentDir" | "stateImagePaths" | "ensureComponentStateDir" | "clear" | "removeJobDir"
>;

/** Everything the processor talks to; tests replace any subset. */
export interface LibraryScanWorkerDependencies {
  queryHandler: QueryHandler;
  store: HarnessLibraryStorePort;
  /** new SettingsStore().readAiSettings(). */
  readAiSettings: () => Promise<ResolvedAiSettings>;
  /** AiProviderFactory.create. */
  createProvider: (settings: ResolvedAiSettings) => AiProvider;
  /** Stage factories of the repository's framework (`stepFactoriesFor`). */
  stepsFor: (framework: RepositoryFramework) => PipelineStepFactories;
  workspace: Pick<LibraryWorkspace, "resolveScanCommit" | "prepare" | "cleanup">;
  inventory: Pick<ComponentInventoryService, "inventory">;
  /** createWorkspaceSourceQueries. */
  createSourceQueries: (ctx: PipelineContext) => Promise<ComponentSourceQueries>;
  queue: Pick<typeof QueueService, "isLibraryCancelRequested" | "clearLibraryCancel">;
  consoleFactory: (jobId: number) => Pick<LibraryJobConsole, "info" | "warn" | "error" | "asPipelineConsole">;
  createScratchStore: (jobId: number) => ScanScratchStore;
  now: () => Date;
  /** LIBRARY_SCAN_MAX_RUNTIME_MS, LIBRARY_SCAN_BATCH_SIZE. */
  limits: { maxRuntimeMs: number; batchSize: number };
}

/** One component to write in this job, with the entry seen at job start (E25). */
interface ScanTarget {
  component: InventoryComponent;
  entry: HarnessLibraryEntryRecord | null;
}

interface JobCounters {
  written: number;
  failed: number;
  skipped: number;
}

interface JobRun {
  job: HarnessLibraryJobModel;
  status: LibraryJobStatus;
  /** The repository's framework (set once the repository is loaded). */
  framework: RepositoryFramework;
  console: Pick<LibraryJobConsole, "info" | "warn" | "error" | "asPipelineConsole">;
}

/** Abort reason of the 8-hour limit. */
export class LibraryScanTimeoutError extends Error {
  override readonly name = "LibraryScanTimeoutError";

  constructor(readonly limitMs: number) {
    super(`Library scan exceeded ${String(limitMs)} ms`);
  }
}

/** Thrown at a checkpoint before the batches when the user cancelled. */
class ScanCancelledSignal extends Error {
  override readonly name = "ScanCancelledSignal";
}

/** Thrown when the run signal aborted (shutdown or the time limit); classified by its reason. */
class ScanAbortedSignal extends Error {
  override readonly name = "ScanAbortedSignal";
}

/** A guarded transition lost: another writer moved the job (library.job.skipped). */
class ScanJobConflictError extends Error {
  override readonly name = "ScanJobConflictError";
}

const MS_PER_HOUR = 3_600_000;
const SHORT_SHA_LENGTH = 7;
const SHORT_ERROR_MAX_CHARS = 200;
const SCAN_REASON = "whole-app scan";
const SHUTDOWN_MESSAGE = "PRVision stopped while this scan was running. Continue scan to write the rest.";
const UNEXPECTED_MESSAGE = "Unexpected error during the scan. See the worker log for details.";
const REPOSITORY_REMOVED_MESSAGE = "The repository was removed.";
const NOT_RENDERED_MESSAGE = "The harness was not rendered.";

/** First line of an error message, redacted and capped (job events). */
function shortError(message: string): string {
  const firstLine = redactSecrets(message).split("\n")[0] ?? "";
  return firstLine.slice(0, SHORT_ERROR_MAX_CHARS);
}

function usd(value: number): string {
  return value.toFixed(2);
}

function sumUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (a === null) {
    return b;
  }
  return b === null ? a : addUsage(a, b);
}

/** Distinct inventory layers (`Found <n> components in <appRoot> (<layers> layers, smallest first).`). */
function layerCount(inventory: ComponentInventory): number {
  return new Set(inventory.components.map((component) => component.layer)).size;
}

/** Processes one scan or rescan job (16 §10.4). */
export class LibraryScanWorkerService {
  private readonly deps: LibraryScanWorkerDependencies;
  private readonly log = createLogger("library-scan");

  constructor(deps: Partial<LibraryScanWorkerDependencies> = {}) {
    const queryHandler = deps.queryHandler ?? new QueryHandler();
    this.deps = {
      queryHandler,
      store: deps.store ?? new HarnessLibraryStore(),
      readAiSettings: deps.readAiSettings ?? (() => new SettingsStore().readAiSettings()),
      createProvider: deps.createProvider ?? ((settings) => AiProviderFactory.create(settings)),
      stepsFor: deps.stepsFor ?? stepFactoriesFor,
      workspace: deps.workspace ?? new LibraryWorkspace(),
      inventory: deps.inventory ?? new ComponentInventoryService(),
      createSourceQueries: deps.createSourceQueries ?? createWorkspaceSourceQueries,
      queue: deps.queue ?? QueueService,
      consoleFactory: deps.consoleFactory ?? ((jobId) => new LibraryJobConsole(jobId, queryHandler)),
      createScratchStore: deps.createScratchStore ?? ((jobId) => new ScanArtifactStore(jobId)),
      now: deps.now ?? ((): Date => new Date()),
      limits: deps.limits ?? { maxRuntimeMs: LIBRARY_SCAN_MAX_RUNTIME_MS, batchSize: LIBRARY_SCAN_BATCH_SIZE }
    };
  }

  /**
   * Runs the job. Never throws for job failures (they are recorded on the row); rethrows only when the job row
   * cannot be loaded at all (DB down), so BullMQ marks the job failed and recovery fixes the row later.
   */
  async run(job: LibraryJob): Promise<LibraryScanOutcome> {
    const { libraryJobId } = job;
    const row = await this.deps.queryHandler.validateAndSelect(
      HarnessLibraryJobModel,
      { id: libraryJobId },
      Table.HARNESS_LIBRARY_JOBS
    );
    if (row === null || row.status !== LibraryJobStatus.QUEUED || (row.kind !== "scan" && row.kind !== "rescan")) {
      this.log.warn(
        { event: "library.job.skipped", jobId: libraryJobId, status: row?.status ?? null, kind: row?.kind ?? null },
        "Library job is not a queued scan; job skipped"
      );
      return "skipped";
    }

    const run: JobRun = {
      job: row,
      status: LibraryJobStatus.QUEUED,
      framework: "react_vite",
      console: this.deps.consoleFactory(row.id)
    };
    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new LibraryScanTimeoutError(this.deps.limits.maxRuntimeMs));
    }, this.deps.limits.maxRuntimeMs);
    timer.unref();
    // Cancel never aborts the work in flight (16 §10.6: the current batch is verified and saved); shutdown does.
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
    const scratch = this.deps.createScratchStore(row.id);
    let repository: RepositoryModel | null = null;
    let workspaceStarted = false;
    const isCancelled = (): Promise<boolean> => this.isCancelled(job);

    try {
      if (await isCancelled()) {
        throw new ScanCancelledSignal();
      }
      repository = await this.deps.queryHandler.validateAndSelect(
        RepositoryModel,
        { id: row.repositoryId },
        Table.REPOSITORIES
      );
      if (!repository) {
        throw new PipelineStepError("preparing", REPOSITORY_REMOVED_MESSAGE);
      }
      const repo = repository;
      run.framework = repo.framework;
      const settings = await this.deps.readAiSettings();
      const ai = this.deps.createProvider(settings);

      // 2. queued → preparing; workspace at the default branch
      await this.advance(run, LibraryJobStatus.PREPARING);
      const scanSha = await this.deps.workspace.resolveScanCommit(repo.localPath, repo.defaultBranch);
      await this.deps.queryHandler.update({ scanSha }, { id: row.id }, Table.HARNESS_LIBRARY_JOBS);
      workspaceStarted = true;
      const prepared = await this.deps.workspace.prepare({
        jobId: row.id,
        repository: {
          localPath: repo.localPath,
          defaultBranch: repo.defaultBranch,
          framework: repo.framework,
          appRoot: repo.appRoot,
          viteConfigPath: repo.viteConfigPath
        },
        scanSha,
        console: run.console.asPipelineConsole(),
        signal
      });
      await this.checkpoint(signal, isCancelled);

      // 3. Inventory (smallest first, with fingerprints)
      const inventory = await this.deps.inventory.inventory({
        framework: repo.framework,
        rootDir: prepared.headDir,
        appRoot: repo.appRoot,
        tsconfigPath: repo.tsconfigPath,
        viteConfigPath: repo.viteConfigPath,
        angularProject: repo.angularProject ?? null,
        signal
      });
      await run.console.info(
        `Found ${String(inventory.components.length)} components in ${repo.appRoot} (${String(layerCount(inventory))} layers, smallest first).`
      );
      for (const warning of inventory.warnings) {
        await run.console.warn(warning);
      }
      await this.checkpoint(signal, isCancelled);

      // 4. Targets, and the default-branch status of the existing entries (E26: nothing is deleted)
      const targets = await this.targetsAndBranchStatus(run, repo.id, inventory);

      // 5. preparing → running
      await this.advance(run, LibraryJobStatus.RUNNING, { totalCount: targets.length });
      await run.console.info(
        `Scanning ${String(targets.length)} components at ${scanSha.slice(0, SHORT_SHA_LENGTH)} with ${settings.model}, up to ${String(row.stateAllowance)} states each.`
      );
      if (targets.length === 0) {
        await this.finish(
          run,
          LibraryJobStatus.COMPLETED,
          {},
          "Nothing to write: every component has a saved harness."
        );
        return "completed";
      }

      // 6. Context (visualization id 0) and source queries over the scan worktree
      const ctx = this.buildContext(row, repo, prepared, ai, settings, run, signal, isCancelled);
      const queries = await this.deps.createSourceQueries(ctx);
      const guard = new SpendCapGuard(row.spendCapUsd, row.aiModel, {
        spentUsd: row.spentUsd,
        calls: row.aiUsage?.calls ?? 0
      });
      const recorder = new LibraryJobUsageRecorder(
        row.id,
        row.aiModel,
        this.deps.queryHandler,
        { spentUsd: row.spentUsd, calls: row.aiUsage?.calls ?? 0 },
        guard
      );
      const steps = this.deps.stepsFor(repo.framework);
      const counters: JobCounters = { written: 0, failed: 0, skipped: 0 };

      // 7. Batches in inventory order
      let stop: "cap" | "cancelled" | null = null;
      for (let offset = 0; offset < targets.length; offset += this.deps.limits.batchSize) {
        if (await isCancelled()) {
          stop = "cancelled";
          break;
        }
        if (!guard.canStartCall()) {
          stop = "cap";
          break;
        }
        const batchStop = await this.runBatch({
          run,
          ctx,
          queries,
          steps,
          scratch,
          recorder,
          guard,
          counters,
          targets,
          offset,
          signal
        });
        if (batchStop !== null) {
          stop = batchStop;
          break;
        }
      }

      // 8. End
      if (stop === "cap") {
        const message = `Stopped at the spending cap of $${usd(row.spendCapUsd ?? 0)} (spent $${usd(recorder.current().spentUsd)}).`;
        await this.finish(
          run,
          LibraryJobStatus.CAP_REACHED,
          { errorMessage: message, currentLabel: null },
          message,
          "warn"
        );
        return "cap_reached";
      }
      if (stop === "cancelled") {
        await this.finish(
          run,
          LibraryJobStatus.CANCELLED,
          { currentLabel: null },
          `Cancelled. ${String(counters.written)} harness(es) written so far are kept.`
        );
        return "cancelled";
      }
      await this.finish(
        run,
        LibraryJobStatus.COMPLETED,
        { currentLabel: null },
        `Done: ${String(counters.written)} saved, ${String(counters.failed)} need updating, ${String(counters.skipped)} skipped.`
      );
      return "completed";
    } catch (error: unknown) {
      return await this.finishWithError(run, error, signal);
    } finally {
      clearTimeout(timer);
      job.signal.removeEventListener("abort", onJobAbort);
      if (workspaceStarted) {
        await this.deps.workspace.cleanup({ jobId: row.id, repository }); // never throws
      }
      try {
        await scratch.removeJobDir();
      } catch (error: unknown) {
        this.log.warn(
          { event: "library.scan.scratch_remove_failed", jobId: row.id, err: error },
          "Scratch removal failed"
        );
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

  // ----- steps -----

  /** §10.4 step 4: restore marked entries found again, mark entries a complete inventory lacks, pick the targets. */
  private async targetsAndBranchStatus(
    run: JobRun,
    repositoryId: number,
    inventory: ComponentInventory
  ): Promise<ScanTarget[]> {
    const entries = await this.deps.store.listForRepository(repositoryId);
    const byKey = new Map(entries.map((entry) => [identityKey(entry), entry]));
    const inventoryKeys = new Set(inventory.components.map((component) => identityKey(component.identity)));

    const toRestore = entries
      .filter(
        (entry) => entry.status === HarnessLibraryStatus.OFF_DEFAULT_BRANCH && inventoryKeys.has(identityKey(entry))
      )
      .map((entry) => entry.id);
    if (toRestore.length > 0) {
      const restored = await this.deps.store.restoreOnDefaultBranch(repositoryId, toRestore);
      if (restored > 0) {
        await run.console.info(`${String(restored)} saved harness(es) are on the default branch again.`);
      }
    }
    if (!inventory.truncated) {
      const toMark = entries
        .filter(
          (entry) => entry.status !== HarnessLibraryStatus.OFF_DEFAULT_BRANCH && !inventoryKeys.has(identityKey(entry))
        )
        .map((entry) => entry.id);
      if (toMark.length > 0) {
        const marked = await this.deps.store.markOffDefaultBranch(repositoryId, toMark);
        if (marked > 0) {
          await run.console.info(
            `${String(marked)} saved harness(es) are not on the default branch; they are kept, left out of the library counts and global re-checks, and reused by runs that need them.`
          );
        }
      }
    }

    // The entries as they are now (a restored entry's status changed), read once more only when something changed.
    const current =
      toRestore.length > 0
        ? new Map((await this.deps.store.listForRepository(repositoryId)).map((entry) => [identityKey(entry), entry]))
        : byKey;
    const rescan = run.job.kind === "rescan";
    return inventory.components
      .map((component) => ({ component, entry: current.get(identityKey(component.identity)) ?? null }))
      .filter((target) => rescan || target.entry === null);
  }

  /** §10.4 step 7 for one batch. Returns why the job stops after it, or null to continue. */
  private async runBatch(input: {
    run: JobRun;
    ctx: PipelineContext;
    queries: ComponentSourceQueries;
    steps: PipelineStepFactories;
    scratch: ScanScratchStore;
    recorder: LibraryJobUsageRecorder;
    guard: SpendCapGuard;
    counters: JobCounters;
    targets: readonly ScanTarget[];
    offset: number;
    signal: AbortSignal;
  }): Promise<"cap" | "cancelled" | null> {
    const { run, ctx, steps, counters, signal } = input;
    const batch = input.targets.slice(input.offset, input.offset + this.deps.limits.batchSize);
    const candidates: ComponentCandidate[] = batch.map((target, index) => ({
      componentId: input.offset + index + 1, // scan-local, never a DB id
      filePath: target.component.identity.filePath,
      exportName: target.component.identity.exportName,
      displayName: target.component.displayName,
      changeKind: "added",
      rank: input.offset + index,
      codeDiff: null,
      reason: SCAN_REASON
    }));
    const first = batch[0];
    if (first !== undefined) {
      const more = batch.length > 1 ? ` and ${String(batch.length - 1)} more` : "";
      await this.updateJob(run.job.id, {
        currentLabel: `Writing ${first.component.displayName} (${first.component.identity.filePath})${more}`
      });
    }

    // 7.3 Generation: no row writes, the job's usage recorder, the cap guard before every AI call
    const generation = steps.harnessGeneration(ctx, input.queries, {
      persistence: new NoopHarnessPersistence(),
      usageRecorder: input.recorder,
      shouldStartCall: input.guard.shouldStartCall
    });
    const generated = await generation.generateAll(candidates, {
      stateAllowance: run.job.stateAllowance,
      purpose: "library"
    });
    this.throwIfAborted(signal);

    // 7.4 Render on the scan commit (head only); the single bounded fix-up applies to these new harnesses
    const persistence = new InMemoryRenderPersistence();
    const repairs = new Map<number, HarnessGenerationResult>();
    const repairUsage = new Map<number, AiUsage>();
    const repairHarness: RepairHarnessFn = async (componentId, previous, renderError) => {
      const outcome = await toRepairHarnessFn(generation)(componentId, previous, renderError);
      if (outcome.ok) {
        repairs.set(componentId, outcome.result);
        if (outcome.result.usage !== undefined) {
          repairUsage.set(componentId, outcome.result.usage);
        }
      }
      return outcome;
    };
    const inputs = buildRenderInputs(candidates, generated.results, []);
    let renders: ComponentRenderResult[] = [];
    let renderFailure: Error | null = null;
    if (inputs.length > 0) {
      await this.updateJob(run.job.id, { currentLabel: `Verifying ${String(inputs.length)} harness(es)` });
      try {
        renders = await steps
          .render({ repairHarness, persistence, artifactStore: input.scratch })
          .renderAll(ctx, inputs);
      } catch (error: unknown) {
        if (signal.aborted) {
          throw new ScanAbortedSignal("render aborted", { cause: error });
        }
        // The written harnesses are saved below (needs updating), then the job fails with this error.
        renderFailure = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.throwIfAborted(signal);

    // 7.5 / 7.6 Save each candidate and count it
    const renderFailureMessage =
      renderFailure === null
        ? null
        : isPipelineStepError(renderFailure)
          ? renderFailure.userMessage
          : NOT_RENDERED_MESSAGE;
    const resultById = new Map(generated.results.map((result) => [result.componentId, result]));
    const failureById = new Map(generated.failures.map((failure) => [failure.componentId, failure]));
    const renderById = new Map(renders.map((render) => [render.componentId, render]));
    const before = { ...counters };
    for (const [index, target] of batch.entries()) {
      const candidate = candidates[index];
      if (candidate === undefined) {
        continue;
      }
      const result = resultById.get(candidate.componentId);
      const failure = failureById.get(candidate.componentId);
      if (result !== undefined) {
        const repaired = persistence.get(candidate.componentId)?.harness !== undefined;
        const kept = repaired ? (repairs.get(candidate.componentId) ?? result) : result;
        await this.saveWrittenHarness(run, target, counters, {
          harness: kept,
          render: renderById.get(candidate.componentId) ?? null,
          renderFailureMessage,
          usage: sumUsage(result.usage ?? null, repairUsage.get(candidate.componentId) ?? null)
        });
      } else if (failure !== undefined) {
        await this.saveGenerationFailure(run, target, counters, {
          cannotRender: failure.kind === "cannot_render",
          message: failure.message
        });
      } else {
        continue; // not started (cap or cancel): stays missing, so Continue scan picks it up
      }
      await this.updateJob(run.job.id, {
        writtenCount: counters.written,
        failedCount: counters.failed,
        skippedCount: counters.skipped
      });
    }

    // 7.7 Scratch renders deleted
    try {
      await input.scratch.clear();
    } catch (error: unknown) {
      this.log.warn(
        { event: "library.scan.scratch_clear_failed", jobId: run.job.id, err: error },
        "Scratch clear failed"
      );
    }
    this.log.info(
      {
        event: "library.scan.batch",
        jobId: run.job.id,
        batch: Math.floor(input.offset / this.deps.limits.batchSize) + 1,
        written: counters.written - before.written,
        failed: counters.failed - before.failed,
        skipped: counters.skipped - before.skipped,
        spentUsd: input.recorder.current().spentUsd
      },
      "Library scan batch finished"
    );
    if (renderFailure !== null) {
      throw renderFailure;
    }
    if (generated.stopReason === "spend_cap") {
      return "cap";
    }
    if (generated.stopReason === "cancelled" || generated.cancelled) {
      return "cancelled";
    }
    return null;
  }

  /** §10.4 step 7.5 for a valid harness. */
  private async saveWrittenHarness(
    run: JobRun,
    target: ScanTarget,
    counters: JobCounters,
    input: {
      harness: HarnessGenerationResult;
      render: ComponentRenderResult | null;
      renderFailureMessage: string | null;
      usage: AiUsage | null;
    }
  ): Promise<void> {
    const name = target.component.displayName;
    const outcome =
      input.render === null
        ? { allOk: false, firstError: input.renderFailureMessage ?? NOT_RENDERED_MESSAGE }
        : sideRenderOutcome(input.render, "head");
    const harness = {
      harnessSource: input.harness.harnessSource,
      mockedModules: input.harness.mockedModules,
      notes: input.harness.notes,
      states: input.harness.states
    };
    if (outcome.allOk) {
      const saved = await this.save(run, target, {
        harness,
        status: HarnessLibraryStatus.READY,
        lastError: null,
        aiUsage: input.usage
      });
      if (saved) {
        counters.written += 1;
        await run.console.info(`${name}: ${String(harness.states.length)} state(s) saved.`);
      } else {
        counters.skipped += 1;
      }
      return;
    }
    const error = outcome.firstError ?? NOT_RENDERED_MESSAGE;
    const existing = target.entry;
    if (
      run.job.kind === "rescan" &&
      existing !== null &&
      existing.status === HarnessLibraryStatus.READY &&
      existing.harnessSource !== null
    ) {
      counters.failed += 1;
      await run.console.warn(
        `Kept the previous harness for ${name}: the rewritten one did not render (${shortError(error)}).`
      );
      return;
    }
    const saved = await this.save(run, target, {
      harness,
      status: HarnessLibraryStatus.NEEDS_UPDATE,
      lastError: error,
      aiUsage: input.usage
    });
    if (saved) {
      counters.failed += 1;
      await run.console.warn(`${name}: harness needs updating (${shortError(error)}).`);
    } else {
      counters.skipped += 1;
    }
  }

  /** §10.4 step 7.5 for `cannot_render` and generation failures (a rescan keeps an existing harness instead). */
  private async saveGenerationFailure(
    run: JobRun,
    target: ScanTarget,
    counters: JobCounters,
    failure: { cannotRender: boolean; message: string }
  ): Promise<void> {
    const name = target.component.displayName;
    const lastError = failure.cannotRender ? `cannot_render: ${failure.message}` : failure.message;
    const countFailure = (): void => {
      if (failure.cannotRender) {
        counters.skipped += 1;
      } else {
        counters.failed += 1;
      }
    };
    if (run.job.kind === "rescan" && target.entry !== null && target.entry.harnessSource !== null) {
      countFailure();
      await run.console.warn(
        `Kept the previous harness for ${name}: writing a new one failed (${shortError(lastError)}).`
      );
      return;
    }
    const saved = await this.save(run, target, {
      harness: null,
      status: HarnessLibraryStatus.NEEDS_UPDATE,
      lastError,
      aiUsage: null
    });
    if (saved) {
      countFailure();
      await run.console.warn(`${name}: harness needs updating (${shortError(lastError)}).`);
    } else {
      counters.skipped += 1;
    }
  }

  /**
   * One library save with E25's rule: `expectedRevision` = the entry's revision at job start for rescan targets
   * that had one, else 0. Returns false when a newer revision was kept (`Kept a newer revision of <name>.`).
   */
  private async save(
    run: JobRun,
    target: ScanTarget,
    values: Pick<SaveWrittenHarnessInput, "harness" | "status" | "lastError" | "aiUsage">
  ): Promise<boolean> {
    const component = target.component;
    const outcome = await this.deps.store.saveWritten({
      repositoryId: run.job.repositoryId,
      framework: run.framework,
      identity: component.identity,
      displayName: component.displayName,
      selector: component.selector,
      sourceFingerprint: component.sourceFingerprint,
      stateAllowance: run.job.stateAllowance,
      origin: HarnessLibraryOrigin.SCAN,
      lastFailedVisualizationId: null,
      aiModel: run.job.aiModel,
      expectedRevision: run.job.kind === "rescan" && target.entry !== null ? target.entry.revision : 0,
      ...values
    });
    if (!outcome.saved) {
      await run.console.info(`Kept a newer revision of ${component.displayName}.`);
      return false;
    }
    return true;
  }

  // ----- helpers -----

  private buildContext(
    job: HarnessLibraryJobModel,
    repository: RepositoryModel,
    prepared: ScanWorkspace,
    ai: AiProvider,
    settings: ResolvedAiSettings,
    run: JobRun,
    signal: AbortSignal,
    isCancelled: () => Promise<boolean>
  ): PipelineContext {
    return {
      visualizationId: 0,
      workspace: prepared.workspace,
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
        renderViewport: repository.renderViewport
      },
      ai,
      aiSettings: {
        model: settings.model,
        harnessEffort: settings.harnessEffort,
        summaryEffort: settings.summaryEffort
      },
      console: run.console.asPipelineConsole(),
      isCancelled,
      signal,
      library: { stateAllowance: job.stateAllowance, buildMode: "scan" },
      libraryJob: { kind: job.kind, libraryJobId: job.id }
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

  private async checkpoint(signal: AbortSignal, isCancelled: () => Promise<boolean>): Promise<void> {
    this.throwIfAborted(signal);
    if (await isCancelled()) {
      throw new ScanCancelledSignal();
    }
  }

  private throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ScanAbortedSignal("scan aborted");
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
      throw new ScanJobConflictError(`Library job ${String(run.job.id)} was not in status ${run.status}`);
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

  /** Maps a failure to the terminal status and message (§10.4 step 9) and writes it. Never throws. */
  private async finishWithError(run: JobRun, error: unknown, signal: AbortSignal): Promise<LibraryScanOutcome> {
    const jobId = run.job.id;
    if (error instanceof ScanJobConflictError) {
      this.log.warn({ event: "library.job.skipped", jobId, status: run.status }, "Library job moved by another writer");
      return "skipped";
    }
    let to: "failed" | "cancelled" = "failed";
    let message: string | null;
    const reason: unknown = signal.reason;
    if (signal.aborted && reason instanceof LibraryScanTimeoutError) {
      const hours = Math.round(reason.limitMs / MS_PER_HOUR);
      message = `Stopped after ${String(hours)} hours (time limit). Continue scan to write the rest.`;
    } else if (signal.aborted) {
      message = SHUTDOWN_MESSAGE;
    } else if (error instanceof ScanCancelledSignal) {
      to = "cancelled";
      message = null;
    } else {
      const classified = classifyRunFailure(error, undefined, false, "preparing");
      message = classified.unexpected ? UNEXPECTED_MESSAGE : classified.errorMessage;
      if (classified.unexpected) {
        this.log.error({ event: "library.scan.failed", jobId, err: error }, "Library scan failed unexpectedly");
      }
    }
    try {
      const fields: LibraryJobTransitionFields = { errorMessage: message, currentLabel: null };
      if (to === "cancelled") {
        await this.finish(run, LibraryJobStatus.CANCELLED, fields, "Cancelled before the scan started writing.");
      } else {
        await this.finish(run, LibraryJobStatus.FAILED, fields, message ?? UNEXPECTED_MESSAGE, "error");
      }
    } catch (writeError: unknown) {
      if (writeError instanceof ScanJobConflictError) {
        this.log.warn(
          { event: "library.job.skipped", jobId, status: run.status },
          "Library job moved by another writer"
        );
        return "skipped";
      }
      this.log.fatal(
        { event: "library.scan.terminal_write_failed", jobId, err: writeError },
        "Could not record the scan's final status"
      );
    }
    this.log.info({ event: "library.scan.finished", jobId, outcome: to }, "Library scan finished");
    return to;
  }
}
