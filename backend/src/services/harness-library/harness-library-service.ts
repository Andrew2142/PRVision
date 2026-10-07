/**
 * HTTP-facing service of the harness library (16 §10, §14.3): library summary, scan estimates (registered and
 * unregistered folders), starting scans and rescans, and the job routes (get, events, cancel). Expected failures
 * return ApiResponse; unexpected ones are logged and answered 500 internal_error.
 *
 * Owned blocks (16 §0): 16f (this file's first part), 16g appends the repair methods, 16k the export/import methods.
 * This file never imports repositories-service.ts; RepositoriesService injects `startScan` instead.
 */
import fs from "node:fs/promises";
import {
  toHarnessLibrarySummaryView,
  toLibraryJobEventView,
  toLibraryJobView,
  type CancelLibraryJobResponse,
  type HarnessLibrarySummaryView,
  type LibraryEstimateRequestDTO,
  type LibraryEstimateView,
  type LibraryJobEventView,
  type LibraryJobView
} from "../../dtos";
import { LIBRARY_JOB_EVENTS_MAX_LIMIT } from "../../dtos/harness-library/library-job-events-query.dto";
import {
  ACTIVE_LIBRARY_JOB_STATUSES,
  ErrorReason,
  LibraryBuildMode,
  LibraryJobKind,
  LibraryJobStatus,
  Table,
  TERMINAL_LIBRARY_JOB_STATUSES
} from "../../enums";
import { HarnessLibraryJobEventModel, HarnessLibraryJobModel, RepositoryModel } from "../../models";
import type { HarnessLibraryStorePort } from "../../types/harness-library";
import {
  AiProviderFactory,
  QueryHandler,
  QueueService,
  Where,
  createLogger,
  type AiReadiness,
  type ApiResponse,
  type ResolvedAiSettings
} from "../../utilities";
import { ProjectDetectionService } from "../repositories/project-detection-service";
import { SettingsStore } from "../settings/settings-store";
import { HarnessLibraryStore } from "./harness-library-store";
import { LibraryEstimateService, LibraryEstimateTimeoutError } from "./library-estimate-service";
import { LibraryJobConsole } from "./library-job-console";
import { isTerminalLibraryJobStatus, transitionLibraryJob } from "./library-job-state";

/** What a scan start needs besides the repository (16 §10.1). */
export interface StartScanInput {
  kind: "scan" | "rescan";
  spendCapUsd: number | null;
  /** When given, the repository's allowance is updated first (same rules as PATCH). */
  stateAllowance?: number;
}

/** GET /api/repositories/:id/library/estimate query (defaults: the repository's allowance, "scan"). */
export interface EstimateQuery {
  stateAllowance?: number;
  kind?: "scan" | "rescan";
}

/** GET /api/library-jobs/:id/events query. */
export interface JobEventsQuery {
  afterId?: number;
  limit?: number;
}

/** Collaborators; tests replace any subset. */
export interface HarnessLibraryServiceDependencies {
  queryHandler: QueryHandler;
  store: Pick<HarnessLibraryStorePort, "counts">;
  estimator: Pick<LibraryEstimateService, "estimate">;
  /** 06/15 detection of an unregistered folder (writes nothing). */
  detector: Pick<ProjectDetectionService, "detect">;
  /** new SettingsStore().readAiSettings(). */
  readAiSettings: () => Promise<ResolvedAiSettings>;
  /** AiProviderFactory.readiness. */
  aiReadiness: (settings: ResolvedAiSettings) => Promise<AiReadiness>;
  queue: Pick<
    typeof QueueService,
    | "enqueueLibraryJob"
    | "removeQueuedLibraryJob"
    | "getLibraryJobState"
    | "requestLibraryCancel"
    | "clearLibraryCancel"
  >;
  consoleFactory: (jobId: number) => Pick<LibraryJobConsole, "info" | "warn" | "error">;
  /** fs.stat of the repository folder (estimates count a folder that must exist). */
  folderExists: (localPath: string) => Promise<boolean>;
  now: () => Date;
}

const SCAN_RUNNING_MESSAGE = "A scan is already running for this repository.";
const QUEUE_FAILED_MESSAGE = "Could not queue the scan.";
const ESTIMATE_TIMEOUT_MESSAGE = "Counting components took too long; the estimate is unavailable.";
const SCAN_KINDS: readonly string[] = [LibraryJobKind.SCAN, LibraryJobKind.RESCAN];
const JOB_GONE_STATES: readonly string[] = ["missing", "completed", "failed"];

const INTERNAL_ERROR: ApiResponse<never> = {
  status: 500,
  error: "Internal server error",
  error_reason: ErrorReason.INTERNAL_ERROR
};

async function directoryExists(localPath: string): Promise<boolean> {
  try {
    return (await fs.stat(localPath)).isDirectory();
  } catch {
    return false;
  }
}

/** The harness library API (16 §14.3). */
export class HarnessLibraryService {
  private readonly deps: HarnessLibraryServiceDependencies;
  private readonly log = createLogger("harness-library-service");

  constructor(deps: Partial<HarnessLibraryServiceDependencies> = {}) {
    this.deps = {
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      store: deps.store ?? new HarnessLibraryStore(),
      estimator: deps.estimator ?? new LibraryEstimateService(),
      detector: deps.detector ?? new ProjectDetectionService(),
      readAiSettings: deps.readAiSettings ?? (() => new SettingsStore().readAiSettings()),
      aiReadiness: deps.aiReadiness ?? ((settings) => AiProviderFactory.readiness(settings)),
      queue: deps.queue ?? QueueService,
      consoleFactory: deps.consoleFactory ?? ((jobId) => new LibraryJobConsole(jobId)),
      folderExists: deps.folderExists ?? directoryExists,
      now: deps.now ?? ((): Date => new Date())
    };
  }

  // ----- 16f block: summary, estimates, scans and jobs -----

  /** GET /api/repositories/:id/library — counts (E26), the active and the last scan job, and the action flags. */
  async summary(repositoryId: number): Promise<ApiResponse<HarnessLibrarySummaryView>> {
    try {
      const repository = await this.loadRepository(repositoryId);
      if (!repository) {
        return repositoryNotFound();
      }
      const [counts, activeJob, lastScanJob] = await Promise.all([
        this.deps.store.counts(repository.id, repository.stateAllowance),
        this.latestScanJob(repository.id, ACTIVE_LIBRARY_JOB_STATUSES),
        this.latestScanJob(repository.id, TERMINAL_LIBRARY_JOB_STATUSES)
      ]);
      return {
        status: 200,
        data: toHarnessLibrarySummaryView({
          repositoryId: repository.id,
          buildMode: repository.libraryBuildMode,
          stateAllowance: repository.stateAllowance,
          counts,
          activeJob: activeJob === null ? null : toLibraryJobView(activeJob, repository.name),
          lastScanJob: lastScanJob === null ? null : toLibraryJobView(lastScanJob, repository.name)
        })
      };
    } catch (error: unknown) {
      return this.unexpected(error, "summary");
    }
  }

  /** GET /api/repositories/:id/library/estimate — counted over the user's clone (read-only, approximate). */
  async estimate(repositoryId: number, query: EstimateQuery): Promise<ApiResponse<LibraryEstimateView>> {
    try {
      const repository = await this.loadRepository(repositoryId);
      if (!repository) {
        return repositoryNotFound();
      }
      if (!(await this.deps.folderExists(repository.localPath))) {
        return {
          status: 400,
          error: `Repository folder is missing: ${repository.localPath}. Restore it or remove the repository.`,
          error_reason: ErrorReason.NOT_GIT_REPO
        };
      }
      const settings = await this.deps.readAiSettings();
      return await this.runEstimate({
        rootDir: repository.localPath,
        framework: repository.framework,
        appRoot: repository.appRoot,
        tsconfigPath: repository.tsconfigPath,
        viteConfigPath: repository.viteConfigPath,
        angularProject: repository.angularProject ?? null,
        stateAllowance: query.stateAllowance ?? repository.stateAllowance,
        kind: query.kind ?? LibraryJobKind.SCAN,
        repositoryId: repository.id,
        model: settings.model
      });
    } catch (error: unknown) {
      return this.unexpected(error, "estimate");
    }
  }

  /**
   * POST /api/repositories/library-estimate — the estimate of a folder that is not registered (Add repository
   * dialog). Detection runs with the same selection as POST /api/repositories and writes nothing.
   */
  async estimateFolder(request: LibraryEstimateRequestDTO): Promise<ApiResponse<LibraryEstimateView>> {
    try {
      const selection = {
        ...(request.appRoot !== undefined ? { appRoot: request.appRoot } : {}),
        ...(request.angularProject !== undefined ? { angularProject: request.angularProject } : {})
      };
      const detection = await this.deps.detector.detect(
        request.localPath,
        Object.keys(selection).length === 0 ? undefined : selection
      );
      if (!detection.ok) {
        return {
          status: detection.failure.status,
          error: detection.failure.message,
          error_reason: detection.failure.errorReason
        };
      }
      const project = detection.project;
      const settings = await this.deps.readAiSettings();
      return await this.runEstimate({
        rootDir: project.rootPath,
        framework: project.framework,
        appRoot: project.appRoot,
        tsconfigPath: project.tsconfigPath,
        viteConfigPath: project.viteConfigPath,
        angularProject: project.angularProject,
        stateAllowance: request.stateAllowance,
        kind: LibraryJobKind.SCAN,
        repositoryId: null,
        model: settings.model
      });
    } catch (error: unknown) {
      return this.unexpected(error, "estimateFolder");
    }
  }

  /**
   * POST /api/repositories/:id/library/scans (16 §10.1): 404, 400 ai_not_configured, 409 while a scan is active;
   * applies the allowance, switches the repository to "scan", inserts and enqueues the job → 202 LibraryJobView.
   */
  async startScan(repositoryId: number, input: StartScanInput): Promise<ApiResponse<LibraryJobView>> {
    try {
      // 1. Repository
      const repository = await this.loadRepository(repositoryId);
      if (!repository) {
        return repositoryNotFound();
      }

      // 2. AI readiness (one settings read: the job records the model it was started with)
      const settings = await this.deps.readAiSettings();
      const readiness = await this.deps.aiReadiness(settings);
      if (!readiness.ready) {
        return { status: 400, error: readiness.message, error_reason: ErrorReason.AI_NOT_CONFIGURED };
      }

      // 3. One active scan per repository (the partial unique index enforces it too)
      const active = await this.latestScanJob(repository.id, ACTIVE_LIBRARY_JOB_STATUSES);
      if (active !== null) {
        return scanRunning();
      }

      // 4 + 5. Allowance (when given) and build mode "scan" (D3)
      const stateAllowance = input.stateAllowance ?? repository.stateAllowance;
      const updated = await this.deps.queryHandler.update(
        { stateAllowance, libraryBuildMode: LibraryBuildMode.SCAN },
        { id: repository.id },
        Table.REPOSITORIES
      );
      if (updated.status === 404) {
        return repositoryNotFound();
      }
      if (updated.status !== 200) {
        this.log.error(
          { event: "library.scan.repository_update_failed", repositoryId, status: updated.status },
          "Repository update before a scan failed"
        );
        return INTERNAL_ERROR;
      }

      // 6. Job row, then the queue
      const inserted = await this.deps.queryHandler.insert(
        {
          repositoryId: repository.id,
          kind: input.kind,
          status: LibraryJobStatus.QUEUED,
          stateAllowance,
          spendCapUsd: input.spendCapUsd,
          aiModel: settings.model
        },
        Table.HARNESS_LIBRARY_JOBS
      );
      if (inserted.status === 409) {
        return scanRunning();
      }
      const jobId = QueryHandler.firstInsertedId(inserted);
      if (inserted.status !== 200 || jobId === null) {
        this.log.error(
          { event: "library.scan.insert_failed", repositoryId, status: inserted.status },
          "Library job insert failed"
        );
        return INTERNAL_ERROR;
      }
      let queueJobId: string;
      try {
        queueJobId = (await this.deps.queue.enqueueLibraryJob(input.kind, jobId)).jobId;
      } catch (error: unknown) {
        this.log.error({ event: "library.scan.enqueue_failed", repositoryId, jobId, err: error }, "Enqueue failed");
        await transitionLibraryJob(this.deps.queryHandler, {
          jobId,
          from: LibraryJobStatus.QUEUED,
          to: LibraryJobStatus.FAILED,
          fields: { errorMessage: QUEUE_FAILED_MESSAGE },
          now: this.deps.now()
        });
        await this.deps.consoleFactory(jobId).error(QUEUE_FAILED_MESSAGE);
        return { status: 500, error: QUEUE_FAILED_MESSAGE, error_reason: ErrorReason.INTERNAL_ERROR };
      }
      await this.deps.queryHandler.update({ jobId: queueJobId }, { id: jobId }, Table.HARNESS_LIBRARY_JOBS);

      const job = await this.loadJob(jobId);
      if (job === null) {
        return INTERNAL_ERROR;
      }
      this.log.info(
        {
          event: "library.scan.started",
          repositoryId,
          jobId,
          kind: input.kind,
          stateAllowance,
          capped: input.spendCapUsd !== null
        },
        "Library scan queued"
      );
      return { status: 202, data: toLibraryJobView(job, repository.name) };
    } catch (error: unknown) {
      return this.unexpected(error, "startScan");
    }
  }

  /** GET /api/library-jobs/:id. */
  async getJob(jobId: number): Promise<ApiResponse<LibraryJobView>> {
    try {
      const visible = await this.loadVisibleJob(jobId);
      if (!visible) {
        return jobNotFound();
      }
      return { status: 200, data: toLibraryJobView(visible.job, visible.repositoryName) };
    } catch (error: unknown) {
      return this.unexpected(error, "getJob");
    }
  }

  /** GET /api/library-jobs/:id/events — oldest first, `afterId` exclusive, at most 500 per page. */
  async jobEvents(jobId: number, query: JobEventsQuery): Promise<ApiResponse<LibraryJobEventView[]>> {
    try {
      const visible = await this.loadVisibleJob(jobId);
      if (!visible) {
        return jobNotFound();
      }
      const limit = Math.min(query.limit ?? LIBRARY_JOB_EVENTS_MAX_LIMIT, LIBRARY_JOB_EVENTS_MAX_LIMIT);
      const events = await this.deps.queryHandler.selectMany(
        HarnessLibraryJobEventModel,
        { jobId, ...(query.afterId !== undefined ? { id: Where.gt(query.afterId) } : {}) },
        Table.HARNESS_LIBRARY_JOB_EVENTS,
        { orderBy: [{ column: "id", direction: "asc" }], limit }
      );
      return { status: 200, data: events.map(toLibraryJobEventView) };
    } catch (error: unknown) {
      return this.unexpected(error, "jobEvents");
    }
  }

  /**
   * POST /api/library-jobs/:id/cancel (16 §10.6): a queued job that is still in the queue is cancelled at once
   * (200); otherwise the cancel flag is set and the worker stops before its next AI call (202). 409 when terminal.
   */
  async cancelJob(jobId: number): Promise<ApiResponse<CancelLibraryJobResponse>> {
    try {
      const visible = await this.loadVisibleJob(jobId);
      if (!visible) {
        return jobNotFound();
      }
      const { job } = visible;
      if (isTerminalLibraryJobStatus(job.status)) {
        return alreadyTerminal(job.status);
      }

      // Flag first: a worker picking the job up a moment later still sees it.
      await this.deps.queue.requestLibraryCancel(jobId);
      this.log.info(
        { event: "library.job.cancel_requested", jobId, status: job.status },
        "Library job cancel requested"
      );

      if (job.status === LibraryJobStatus.QUEUED) {
        const removed = await this.deps.queue.removeQueuedLibraryJob(job.kind, jobId);
        const removable =
          removed || JOB_GONE_STATES.includes(await this.deps.queue.getLibraryJobState(job.kind, jobId));
        if (removable) {
          const ok = await transitionLibraryJob(this.deps.queryHandler, {
            jobId,
            from: LibraryJobStatus.QUEUED,
            to: LibraryJobStatus.CANCELLED,
            now: this.deps.now()
          });
          if (ok) {
            await this.deps.consoleFactory(jobId).info("Cancelled before the worker started.");
            await this.clearCancelBestEffort(jobId);
            return { status: 200, data: { id: jobId, status: "cancelled" } };
          }
        }
      }

      // Re-read: the worker may have finished (or started) between the first read and now.
      const current = await this.loadJob(jobId);
      if (current === null) {
        return jobNotFound();
      }
      if (isTerminalLibraryJobStatus(current.status)) {
        await this.clearCancelBestEffort(jobId);
        return alreadyTerminal(current.status);
      }
      await this.deps
        .consoleFactory(jobId)
        .info("Cancellation requested. The job stops before its next AI call; everything written so far is kept.");
      return { status: 202, data: { id: jobId, status: "cancel_requested" } };
    } catch (error: unknown) {
      return this.unexpected(error, "cancelJob");
    }
  }

  // ----- end 16f block -----

  // ----- shared helpers (16f; 16g and 16k reuse them) -----

  private async runEstimate(
    input: Parameters<LibraryEstimateService["estimate"]>[0]
  ): Promise<ApiResponse<LibraryEstimateView>> {
    try {
      return { status: 200, data: await this.deps.estimator.estimate(input, new AbortController().signal) };
    } catch (error: unknown) {
      if (error instanceof LibraryEstimateTimeoutError) {
        this.log.warn(
          { event: "library.estimate.timeout", repositoryId: input.repositoryId, timeoutMs: error.timeoutMs },
          "Library estimate timed out"
        );
        return { status: 504, error: ESTIMATE_TIMEOUT_MESSAGE, error_reason: ErrorReason.INTERNAL_ERROR };
      }
      throw error;
    }
  }

  /** The newest scan or rescan job of the repository in one of the statuses (by id), or null. */
  private async latestScanJob(
    repositoryId: number,
    statuses: readonly LibraryJobStatus[]
  ): Promise<HarnessLibraryJobModel | null> {
    const jobs = await this.deps.queryHandler.selectMany(
      HarnessLibraryJobModel,
      { repositoryId, kind: Where.in([...SCAN_KINDS]), status: Where.in([...statuses]) },
      Table.HARNESS_LIBRARY_JOBS,
      { orderBy: [{ column: "id", direction: "desc" }], limit: 1 }
    );
    return jobs[0] ?? null;
  }

  /** One non-deleted repository (QueryHandler adds isDeleted = false). */
  private async loadRepository(repositoryId: number): Promise<RepositoryModel | null> {
    return this.deps.queryHandler.validateAndSelect(RepositoryModel, { id: repositoryId }, Table.REPOSITORIES);
  }

  private async loadJob(jobId: number): Promise<HarnessLibraryJobModel | null> {
    return this.deps.queryHandler.validateAndSelect(HarnessLibraryJobModel, { id: jobId }, Table.HARNESS_LIBRARY_JOBS);
  }

  /** A job whose repository is visible (a removed repository hides its jobs), with the repository name. */
  private async loadVisibleJob(jobId: number): Promise<{ job: HarnessLibraryJobModel; repositoryName: string } | null> {
    const job = await this.loadJob(jobId);
    if (job === null) {
      return null;
    }
    const repository = await this.loadRepository(job.repositoryId);
    return repository === null ? null : { job, repositoryName: repository.name };
  }

  private async clearCancelBestEffort(jobId: number): Promise<void> {
    try {
      await this.deps.queue.clearLibraryCancel(jobId);
    } catch (error: unknown) {
      this.log.warn({ event: "library.job.cancel_clear_failed", jobId, err: error }, "Cancel flag clear failed");
    }
  }

  private unexpected(error: unknown, action: string): ApiResponse<never> {
    this.log.error({ event: "library.service.failed", err: error, action }, "Harness library service failed");
    return INTERNAL_ERROR;
  }
}

function repositoryNotFound(): ApiResponse<never> {
  return { status: 404, error: "Repository not found", error_reason: ErrorReason.NOT_FOUND };
}

function jobNotFound(): ApiResponse<never> {
  return { status: 404, error: "Library job not found", error_reason: ErrorReason.NOT_FOUND };
}

function scanRunning(): ApiResponse<never> {
  return { status: 409, error: SCAN_RUNNING_MESSAGE, error_reason: ErrorReason.CONFLICT };
}

function alreadyTerminal(status: LibraryJobStatus): ApiResponse<never> {
  return { status: 409, error: `This job is already ${status}.`, error_reason: ErrorReason.ALREADY_TERMINAL };
}
