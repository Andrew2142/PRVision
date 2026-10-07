// Direct Drizzle: list() and loadVisible() join visualizations with repositories (for repositoryName and to hide the
// visualizations of soft-deleted repositories, 03 §9.7); QueryHandler cannot express joins.
import fs from "node:fs/promises";
import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm";
import {
  CONSOLE_PAGE_LIMIT_MAX,
  LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE,
  LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE,
  WORKING_TREE_HEAD_REF
} from "../../config-consts";
import * as schema from "../../database/schema";
import {
  isValidGitBranchName,
  synthesizedDefaultStateView,
  toComponentStateView,
  toConsoleEventView,
  toLibraryJobView,
  toVisualizationComponentView,
  toVisualizationDetailView,
  toVisualizationSummaryView,
  type CancelVisualizationResponse,
  type CreateVisualizationResponse,
  type DeleteVisualizationResponse,
  type VisualizationConsoleQueryDTO,
  type VisualizationCreateDTO,
  type LibraryJobView,
  type VisualizationListQueryDTO,
  type VisualizationSummaryView
} from "../../dtos";
import {
  ACTIVE_LIBRARY_JOB_STATUSES,
  DeletionMode,
  ErrorReason,
  LibraryJobKind,
  isTerminalVisualizationStatus,
  type RepositoryFramework,
  Table,
  TERMINAL_VISUALIZATION_STATUSES,
  VisualizationSourceType,
  VisualizationStatus
} from "../../enums";
import {
  HarnessLibraryJobModel,
  RepositoryModel,
  VisualizationComponentModel,
  VisualizationComponentStateModel,
  VisualizationConsoleEventModel,
  VisualizationModel
} from "../../models";
import {
  AiProviderFactory,
  ArtifactStore,
  DrizzleDb,
  GitClient,
  GitCommandError,
  GitHubClient,
  GitHubClientError,
  ModelHandler,
  QueryHandler,
  QueueService,
  Where,
  createLogger,
  githubErrorToApiResponse,
  redactSecrets,
  resolvePageRequest,
  usageCostUsd,
  type AiReadiness,
  type ApiResponse,
  type Database,
  type PagedResult,
  type Transaction
} from "../../utilities";
import { SettingsStore, type SecretRead } from "../settings/settings-store";
import { VisualizationConsoleService } from "./visualization-console-service";
import { describeStep } from "./pipeline/harness-step-text";
import { removeWorkingTreeSnapshot } from "./pipeline/workspace-prepare-service";
import { transitionVisualization } from "./visualization-state-machine";

/** Longest stored title (07 §5.4.1 step 4); longer titles are cut to TITLE_MAX_LENGTH - 1 and get "…". */
const TITLE_MAX_LENGTH = 300;
/** Longest stored head_ref for a fork PR label (`owner:branch`). */
const HEAD_REF_MAX_LENGTH = 255;
/** Longest piece of a GitHub base branch name or git stderr echoed into an error message. */
const ECHO_MAX_LENGTH = 100;
const STDERR_ECHO_MAX_LENGTH = 200;
/** Abbreviated sha in titles and messages (00 §16). */
const SHORT_SHA_LENGTH = 7;

const INTERNAL_ERROR: ApiResponse<never> = {
  status: 500,
  error: "Internal server error",
  error_reason: ErrorReason.INTERNAL_ERROR
};

/** Everything VisualizationsService talks to; tests replace any subset. */
export interface VisualizationsServiceDependencies {
  queryHandler: QueryHandler;
  /** DrizzleDb.getInstance(); list/loadVisible join only. */
  db: Database;
  /** DrizzleDb.transaction. */
  transaction: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  git: Pick<GitClient, "revParse" | "isDirty" | "currentBranch" | "hasCommit" | "isAncestor">;
  /** Default: AiProviderFactory.readiness(await new SettingsStore().readAiSettings()). */
  aiReadiness: () => Promise<AiReadiness>;
  /** new SettingsStore().readGithubToken(). */
  readGithubToken: () => Promise<SecretRead>;
  githubClientFactory: (token: string) => Pick<GitHubClient, "getPullRequest">;
  queue: Pick<
    typeof QueueService,
    | "enqueueVisualization"
    | "requeueVisualization"
    | "visualizationJobId"
    | "removeQueuedVisualization"
    | "getVisualizationJobState"
    | "requestCancel"
    | "clearCancel"
  >;
  artifacts: Pick<ArtifactStore, "toPublicUrl" | "removeVisualization">;
  consoleFactory: (visualizationId: number) => Pick<VisualizationConsoleService, "info" | "warn" | "error">;
  now: () => Date;
  /** 16d block (16 §11.2): rm -rf `<dataDir>/snapshots/<id>/` of a removed run. */
  removeWorkingTreeSnapshot: (visualizationId: number) => Promise<void>;
}

type ResolvedSource = {
  baseRef: string;
  headRef: string;
  prNumber: number | null;
  title: string;
  /** commit_range only (00 §16): fixed at create; other sources resolve their commits while preparing. */
  baseSha?: string;
  headSha?: string;
};
type SourceResolution = { ok: true; source: ResolvedSource } | { ok: false; response: ApiResponse };
type VisibleVisualization = {
  visualization: VisualizationModel;
  repositoryName: string;
  repositoryFramework: RepositoryFramework;
  repositoryStateAllowance: number;
};

/**
 * HTTP-facing visualization lifecycle (07 §5.4): create (validate the source, insert the queued row, enqueue), list,
 * detail, console, cancel and delete. Returns ApiResponse; never throws (unexpected errors become a generic 500).
 * The API never writes a running status: its only writes are the insert, queued → cancelled and queued → failed.
 */
export class VisualizationsService {
  private readonly deps: VisualizationsServiceDependencies;
  private readonly log = createLogger("visualizations-service");

  /**
   * @param visualizationPayload - Model carrying the id for get/console/cancel/remove (controllers set it).
   * @param deps - Dependency overrides (tests).
   */
  constructor(
    private readonly visualizationPayload: VisualizationModel = new VisualizationModel(),
    deps: Partial<VisualizationsServiceDependencies> = {}
  ) {
    this.deps = resolveVisualizationsDependencies(deps);
  }

  /** POST /api/visualizations — validates the source, inserts the queued row with its job id, enqueues; 202. */
  async create(dto: VisualizationCreateDTO): Promise<ApiResponse> {
    try {
      const repo = await this.deps.queryHandler.validateAndSelect(
        RepositoryModel,
        { id: dto.repositoryId },
        Table.REPOSITORIES
      );
      if (!repo) {
        return { status: 404, error: "Repository not found", error_reason: ErrorReason.NOT_FOUND };
      }

      const readiness = await this.deps.aiReadiness();
      if (!readiness.ready) {
        return { status: 400, error: readiness.message, error_reason: ErrorReason.AI_NOT_CONFIGURED };
      }

      const resolution = await this.resolveSource(dto, repo);
      if (!resolution.ok) {
        return resolution.response;
      }
      const source = { ...resolution.source, title: limitTitle(resolution.source.title) };

      const visualizationId = await this.deps.transaction(async (tx) => {
        const qh = new QueryHandler(tx);
        const inserted = await qh.insert(
          {
            repositoryId: repo.id,
            sourceType: dto.sourceType,
            prNumber: source.prNumber,
            title: source.title,
            baseRef: source.baseRef,
            headRef: source.headRef,
            baseSha: source.baseSha ?? null,
            headSha: source.headSha ?? null,
            renderViewport: dto.renderViewport ?? null,
            status: VisualizationStatus.QUEUED,
            aiProvider: readiness.provider,
            aiModel: readiness.model,
            componentCount: 0,
            changedCount: 0
          },
          Table.VISUALIZATIONS
        );
        const id = QueryHandler.firstInsertedId(inserted);
        if (inserted.status !== 200 || id === null) {
          throw new Error("Visualization insert failed"); // rollback
        }
        const updated = await qh.update(
          { jobId: this.deps.queue.visualizationJobId(id) },
          { id },
          Table.VISUALIZATIONS
        );
        if (updated.status !== 200) {
          throw new Error("job_id update failed"); // rollback
        }
        return id;
      });

      const consoleSvc = this.deps.consoleFactory(visualizationId);
      await consoleSvc.info(VisualizationStatus.QUEUED, `Queued: ${source.title}`);
      if (dto.sourceType === VisualizationSourceType.WORKING_TREE) {
        await consoleSvc.info(
          VisualizationStatus.QUEUED,
          "Your uncommitted changes are captured when the worker starts this visualization."
        );
      }

      // Enqueue after commit, so the worker never reads an uncommitted row.
      try {
        const { jobId } = await this.deps.queue.enqueueVisualization(visualizationId); // idempotent on viz-<id>
        this.log.info(
          { event: "visualization.job.queued", visualizationId, repositoryId: repo.id, sourceType: dto.sourceType },
          "Visualization queued"
        );
        const data: CreateVisualizationResponse = { visualizationId, jobId };
        return { status: 202, data };
      } catch (error: unknown) {
        this.log.error({ event: "visualization.enqueue.failed", err: error, visualizationId }, "Enqueue failed");
        await transitionVisualization(this.deps.queryHandler, {
          visualizationId,
          from: VisualizationStatus.QUEUED,
          to: VisualizationStatus.FAILED,
          now: this.deps.now(),
          fields: {
            errorMessage: "Could not queue the job. Is Redis running? Start it and create the visualization again."
          }
        });
        await consoleSvc.error(VisualizationStatus.QUEUED, "Could not queue the job (Redis unavailable).");
        return {
          status: 500,
          error: "Could not queue the visualization: the job queue (Redis) is unavailable.",
          error_reason: ErrorReason.INTERNAL_ERROR
        };
      }
    } catch (error: unknown) {
      return this.unexpected(error, "create");
    }
  }

  /** GET /api/visualizations — paged list, newest first. */
  async list(query: VisualizationListQueryDTO): Promise<ApiResponse> {
    try {
      const { page, pageSize, limit, offset } = resolvePageRequest(query);
      const v = schema.visualizations;
      const r = schema.repositories;
      const conditions: SQL[] = [eq(v.isDeleted, false), eq(r.isDeleted, false)]; // 03 §9.7
      if (query.repositoryId !== undefined) {
        conditions.push(eq(v.repositoryId, query.repositoryId));
      }
      if (query.status !== undefined) {
        conditions.push(inArray(v.status, query.status)); // comma list, 00 §14.4
      }
      const where = and(...conditions);

      const [rows, totals] = await Promise.all([
        this.deps.db
          .select({ visualization: v, repositoryName: r.name })
          .from(v)
          .innerJoin(r, eq(r.id, v.repositoryId))
          .where(where)
          .orderBy(desc(v.createdAt), desc(v.id))
          .limit(limit)
          .offset(offset),
        this.deps.db.select({ total: count() }).from(v).innerJoin(r, eq(r.id, v.repositoryId)).where(where)
      ]);
      const data: PagedResult<VisualizationSummaryView> = {
        items: rows.map((row) =>
          toVisualizationSummaryView(ModelHandler.hydrate(VisualizationModel, row.visualization), row.repositoryName)
        ),
        page,
        pageSize,
        total: totals[0]?.total ?? 0
      };
      return { status: 200, data };
    } catch (error: unknown) {
      return this.unexpected(error, "list");
    }
  }

  /** GET /api/visualizations/:id — detail with components ordered by rank, then id. */
  async get(): Promise<ApiResponse> {
    try {
      const id = this.visualizationPayload.id;
      const visible = await this.loadVisible(id);
      if (!visible) {
        return notFound();
      }
      const components = await this.deps.queryHandler.selectMany(
        VisualizationComponentModel,
        { visualizationId: id },
        Table.VISUALIZATION_COMPONENTS,
        {
          orderBy: [
            { column: "rank", direction: "asc" },
            { column: "id", direction: "asc" }
          ]
        }
      );
      // --- 16e block (16 §14.5): states, harness status, active repair job, live and repair estimate ---
      const toPublicUrl = (relativePath: string | null): string | null => this.deps.artifacts.toPublicUrl(relativePath);
      const [stateRows, repairJob] = await Promise.all([
        this.deps.queryHandler.selectMany(
          VisualizationComponentStateModel,
          { visualizationId: id },
          Table.VISUALIZATION_COMPONENT_STATES,
          { orderBy: [{ column: "ordinal", direction: "asc" }] }
        ),
        this.deps.queryHandler.validateAndSelect(
          HarnessLibraryJobModel,
          { visualizationId: id, kind: LibraryJobKind.REPAIR, status: Where.in([...ACTIVE_LIBRARY_JOB_STATUSES]) },
          Table.HARNESS_LIBRARY_JOBS
        )
      ]);
      const statesByComponent = new Map<number, VisualizationComponentStateModel[]>();
      for (const state of stateRows) {
        const list = statesByComponent.get(state.visualizationComponentId) ?? [];
        list.push(state);
        statesByComponent.set(state.visualizationComponentId, list);
      }
      const activeRepairJob: LibraryJobView | null =
        repairJob === null ? null : toLibraryJobView(repairJob, visible.repositoryName);
      const repairing = new Set(activeRepairJob?.componentIds ?? []);
      const views = components.map((component) => {
        const rows = statesByComponent.get(component.id) ?? [];
        const states =
          rows.length > 0
            ? rows.map((state) => toComponentStateView(state, toPublicUrl, describeStep))
            : [synthesizedDefaultStateView(component, toPublicUrl)];
        return toVisualizationComponentView(component, toPublicUrl, { states, repairing: repairing.has(component.id) });
      });
      const repository = { name: visible.repositoryName, framework: visible.repositoryFramework };
      const library = {
        activeRepairJob,
        liveAvailable: isLiveAvailable(visible.visualization, components),
        repairEstimateUsd: await this.repairEstimateUsd(
          visible.visualization.needsUpdateCount,
          visible.repositoryStateAllowance
        )
      };
      return { status: 200, data: toVisualizationDetailView(visible.visualization, repository, views, library) };
      // --- end 16e block ---
    } catch (error: unknown) {
      return this.unexpected(error, "get");
    }
  }

  /**
   * 16e block (16 §14.5): needsUpdateCount × the default per-harness cost with the repository's allowance, at the
   * current AI model, rounded to cents; null when nothing needs updating or AI is not configured.
   */
  private async repairEstimateUsd(needsUpdateCount: number, stateAllowance: number): Promise<number | null> {
    if (needsUpdateCount <= 0) {
      return null;
    }
    const readiness = await this.deps.aiReadiness();
    if (!readiness.ready) {
      return null;
    }
    const usage = {
      ...LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE,
      outputTokens:
        LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE.outputTokens +
        LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE * Math.max(0, stateAllowance - 1)
    };
    return Math.round(needsUpdateCount * usageCostUsd(readiness.model, usage).usd * 100) / 100;
  }

  /** GET /api/visualizations/:id/console — events after `afterId` (exclusive), oldest first, at most `limit`. */
  async console(query: VisualizationConsoleQueryDTO): Promise<ApiResponse> {
    try {
      const id = this.visualizationPayload.id;
      if (!(await this.loadVisible(id))) {
        return notFound();
      }
      const events = await this.deps.queryHandler.selectMany(
        VisualizationConsoleEventModel,
        { visualizationId: id, id: Where.gt(query.afterId ?? 0) },
        Table.VISUALIZATION_CONSOLE_EVENTS,
        { orderBy: [{ column: "id", direction: "asc" }], limit: query.limit ?? CONSOLE_PAGE_LIMIT_MAX }
      );
      return { status: 200, data: events.map(toConsoleEventView) };
    } catch (error: unknown) {
      return this.unexpected(error, "console");
    }
  }

  /**
   * POST /api/visualizations/:id/cancel — 200 { id, status: "cancelled" } when the queued job was removed,
   * 202 { id, status: "cancel_requested" } when the worker was signalled, 409 already_terminal (00 §14.4).
   */
  async cancel(): Promise<ApiResponse> {
    try {
      const id = this.visualizationPayload.id;
      const visible = await this.loadVisible(id);
      if (!visible) {
        return notFound();
      }
      const status = visible.visualization.status;
      if (isTerminalVisualizationStatus(status)) {
        return alreadyTerminal(status);
      }

      // Paused for a choice: no worker holds it, so cancel directly.
      if (status === VisualizationStatus.AWAITING_CONFIRMATION) {
        const ok = await transitionVisualization(this.deps.queryHandler, {
          visualizationId: id,
          from: VisualizationStatus.AWAITING_CONFIRMATION,
          to: VisualizationStatus.CANCELLED,
          now: this.deps.now()
        });
        if (ok) {
          await this.deps.consoleFactory(id).info(VisualizationStatus.CANCELLED, "Cancelled before rendering.");
          const data: CancelVisualizationResponse = { id, status: "cancelled" };
          return { status: 200, data };
        }
      }

      // Flag first: a worker picking the job up a moment later still sees it (pre-start check or 04's poll).
      await this.deps.queue.requestCancel(id);
      this.log.info({ event: "visualization.cancel.requested", visualizationId: id, status }, "Cancel requested");

      if (status === VisualizationStatus.QUEUED) {
        const removed = await this.deps.queue.removeQueuedVisualization(id);
        const removable =
          removed || ["missing", "completed", "failed"].includes(await this.deps.queue.getVisualizationJobState(id));
        if (removable) {
          const ok = await transitionVisualization(this.deps.queryHandler, {
            visualizationId: id,
            from: VisualizationStatus.QUEUED,
            to: VisualizationStatus.CANCELLED,
            now: this.deps.now()
          });
          if (ok) {
            await this.deps
              .consoleFactory(id)
              .info(VisualizationStatus.CANCELLED, "Cancelled before the worker started.");
            await this.clearCancelBestEffort(id);
            const data: CancelVisualizationResponse = { id, status: "cancelled" };
            return { status: 200, data };
          }
        }
      }

      // Re-read: the worker may have finished (or started) between the first read and now.
      const current = await this.loadVisible(id);
      if (!current) {
        return notFound();
      }
      if (isTerminalVisualizationStatus(current.visualization.status)) {
        await this.clearCancelBestEffort(id);
        return alreadyTerminal(current.visualization.status);
      }
      await this.deps
        .consoleFactory(id)
        .info(current.visualization.status, "Cancellation requested. The run stops at the next checkpoint.");
      const data: CancelVisualizationResponse = { id, status: "cancel_requested" };
      return { status: 202, data };
    } catch (error: unknown) {
      return this.unexpected(error, "cancel");
    }
  }

  /**
   * POST /api/visualizations/:id/continue — a run paused in awaiting_confirmation continues with the chosen
   * component limit: its analysis rows are dropped and the run is queued again (prepare and analysis repeat, no AI
   * was spent before the pause). 202 { id, componentLimit, jobId }; 409 conflict when it is not waiting.
   */
  async continueRun(componentLimit: number): Promise<ApiResponse> {
    try {
      const id = this.visualizationPayload.id;
      const visible = await this.loadVisible(id);
      if (!visible) {
        return notFound();
      }
      if (visible.visualization.status !== VisualizationStatus.AWAITING_CONFIRMATION) {
        return {
          status: 409,
          error: "This visualization is not waiting for a choice.",
          error_reason: ErrorReason.CONFLICT
        };
      }
      const deleted = await this.deps.queryHandler.delete(
        { visualizationId: id },
        Table.VISUALIZATION_COMPONENTS,
        DeletionMode.HARD
      );
      if (deleted.status !== 200 && deleted.status !== 404) {
        throw new Error(`Component rows could not be cleared (${String(deleted.status)})`);
      }
      const ok = await transitionVisualization(this.deps.queryHandler, {
        visualizationId: id,
        from: VisualizationStatus.AWAITING_CONFIRMATION,
        to: VisualizationStatus.QUEUED,
        fields: { componentLimit, changedCount: 0 },
        now: this.deps.now()
      });
      if (!ok) {
        return {
          status: 409,
          error: "This visualization is not waiting for a choice.",
          error_reason: ErrorReason.CONFLICT
        };
      }
      await this.deps
        .consoleFactory(id)
        .info(VisualizationStatus.QUEUED, `Continuing: writing up to ${String(componentLimit)} new harnesses.`); // 16d block (E12)
      const { jobId } = await this.deps.queue.requeueVisualization(id);
      this.log.info(
        { event: "visualization.continued", visualizationId: id, componentLimit },
        "Visualization continued"
      );
      return { status: 202, data: { id, componentLimit, jobId } };
    } catch (error: unknown) {
      return this.unexpected(error, "continue");
    }
  }

  /** DELETE /api/visualizations/:id — 200 { id }; 409 conflict while non-terminal (00 §14.4). */
  async remove(): Promise<ApiResponse> {
    try {
      const id = this.visualizationPayload.id;
      const visible = await this.loadVisible(id);
      if (!visible) {
        return notFound();
      }
      if (!isTerminalVisualizationStatus(visible.visualization.status)) {
        return stillRunning();
      }

      // Conditioned on a terminal status, so a row that is (impossibly) running again is never deleted.
      const deleted = await this.deps.queryHandler.delete(
        { id, isDeleted: false, status: Where.in([...TERMINAL_VISUALIZATION_STATUSES]) },
        Table.VISUALIZATIONS,
        DeletionMode.SOFT
      );
      if (deleted.status === 404) {
        return (await this.loadVisible(id)) ? stillRunning() : notFound();
      }
      if (deleted.status !== 200) {
        return INTERNAL_ERROR;
      }

      try {
        await this.deps.artifacts.removeVisualization(id);
      } catch (error: unknown) {
        this.log.warn(
          { event: "visualization.artifacts.remove_failed", visualizationId: id, err: error },
          "Artifact removal failed; the visualization is deleted anyway"
        );
      }
      // 16d block (16 §11.2): the working-tree snapshot is deleted with the run (best effort, like artifacts)
      try {
        await this.deps.removeWorkingTreeSnapshot(id);
      } catch (error: unknown) {
        this.log.warn(
          { event: "visualization.snapshot.remove_failed", visualizationId: id, err: error },
          "Working-tree snapshot removal failed; the visualization is deleted anyway"
        );
      }
      const data: DeleteVisualizationResponse = { id };
      return { status: 200, data };
    } catch (error: unknown) {
      return this.unexpected(error, "remove");
    }
  }

  /** Source-specific validation and the derived title/refs (07 §5.4.1 step 3). */
  private async resolveSource(dto: VisualizationCreateDTO, repo: RepositoryModel): Promise<SourceResolution> {
    switch (dto.sourceType) {
      case VisualizationSourceType.GITHUB_PR:
        return this.resolvePullRequest(dto, repo);
      case VisualizationSourceType.LOCAL_BRANCH:
        return this.resolveLocalBranch(dto, repo);
      case VisualizationSourceType.WORKING_TREE:
        return this.resolveWorkingTree(repo);
      case VisualizationSourceType.COMMIT_RANGE:
        return this.resolveCommitRange(dto, repo);
    }
  }

  private async resolvePullRequest(dto: VisualizationCreateDTO, repo: RepositoryModel): Promise<SourceResolution> {
    const owner = repo.githubOwner;
    const name = repo.githubRepo;
    const pullNumber = dto.prNumber;
    if (owner === null || name === null) {
      return fail(
        400,
        "This repository has no github.com remote, so pull requests cannot be visualized.",
        ErrorReason.NO_GITHUB_REMOTE
      );
    }
    if (pullNumber === undefined) {
      return fail(400, "prNumber is required when sourceType is github_pr", ErrorReason.VALIDATION_FAILED); // DTO guards it
    }
    const secret = await this.deps.readGithubToken();
    if (secret.state === "absent") {
      return fail(400, "Add a GitHub token in Settings to visualize pull requests.", ErrorReason.GITHUB_TOKEN_MISSING);
    }
    if (secret.state === "unreadable") {
      return fail(
        400,
        "The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again in Settings.",
        ErrorReason.GITHUB_TOKEN_MISSING
      );
    }

    let pr: Awaited<ReturnType<GitHubClient["getPullRequest"]>>;
    try {
      pr = await this.deps.githubClientFactory(secret.value).getPullRequest(owner, name, pullNumber);
    } catch (error: unknown) {
      if (error instanceof GitHubClientError) {
        return { ok: false, response: githubErrorToApiResponse(error, { owner, repo: name, pullNumber }) };
      }
      throw error;
    }

    if (!isUsableBranchName(pr.baseRef)) {
      return fail(
        400,
        `GitHub returned a base branch name PRVision cannot use: ${pr.baseRef.slice(0, ECHO_MAX_LENGTH)}.`,
        ErrorReason.VALIDATION_FAILED
      );
    }
    const forkOwner = pr.headRepoFullName?.split("/")[0] ?? "";
    // Display only: prepare fetches refs/pull/<n>/head and never passes head_ref to git for PRs.
    const headRef = (pr.isFork && pr.headRepoFullName ? `${forkOwner}:${pr.headRef}` : pr.headRef).slice(
      0,
      HEAD_REF_MAX_LENGTH
    );
    return {
      ok: true,
      source: { baseRef: pr.baseRef, headRef, prNumber: pullNumber, title: `#${pullNumber} ${pr.title}` }
    };
  }

  private async resolveLocalBranch(dto: VisualizationCreateDTO, repo: RepositoryModel): Promise<SourceResolution> {
    const head = dto.headRef ?? "";
    const base = dto.baseRef ?? repo.defaultBranch;
    if (head === base) {
      return fail(400, "Choose two different branches.", ErrorReason.VALIDATION_FAILED);
    }
    const missing = await this.missingFolder(repo);
    if (missing) {
      return missing;
    }
    for (const branch of [base, head]) {
      try {
        await this.deps.git.revParse(repo.localPath, `refs/heads/${branch}`);
      } catch (error: unknown) {
        if (
          error instanceof GitCommandError &&
          (error.code === "unknown_revision" || error.code === "invalid_argument")
        ) {
          return fail(
            400,
            `Branch "${branch.slice(0, ECHO_MAX_LENGTH)}" does not exist in ${repo.name}.`,
            ErrorReason.VALIDATION_FAILED
          );
        }
        return gitFailure(error);
      }
    }
    return { ok: true, source: { baseRef: base, headRef: head, prNumber: null, title: `${head} → ${base}` } };
  }

  /**
   * commit_range (00 §16): both commits exist and are reachable from `headRef`, and `baseSha` is a strict ancestor of
   * `headSha`. Base and head refs are both the branch; the commits are stored on the row.
   */
  private async resolveCommitRange(dto: VisualizationCreateDTO, repo: RepositoryModel): Promise<SourceResolution> {
    const branch = dto.headRef ?? "";
    const baseSha = dto.baseSha ?? "";
    const headSha = dto.headSha ?? "";
    if (baseSha === headSha) {
      return fail(400, "Choose two different commits.", ErrorReason.VALIDATION_FAILED); // DTO guards it
    }
    const missing = await this.missingFolder(repo);
    if (missing) {
      return missing;
    }
    const branchLabel = branch.slice(0, ECHO_MAX_LENGTH);
    try {
      let branchTip: string;
      try {
        branchTip = await this.deps.git.revParse(repo.localPath, `refs/heads/${branch}`);
      } catch (error: unknown) {
        if (
          error instanceof GitCommandError &&
          (error.code === "unknown_revision" || error.code === "invalid_argument")
        ) {
          return fail(400, `Branch "${branchLabel}" does not exist in ${repo.name}.`, ErrorReason.VALIDATION_FAILED);
        }
        throw error;
      }
      for (const [label, sha] of [
        ["From", baseSha],
        ["To", headSha]
      ] as const) {
        if (!(await this.deps.git.hasCommit(repo.localPath, sha))) {
          return fail(
            400,
            `The ${label} commit ${shortSha(sha)} does not exist in ${repo.name}.`,
            ErrorReason.VALIDATION_FAILED
          );
        }
        if (!(await this.deps.git.isAncestor(repo.localPath, sha, branchTip))) {
          return fail(
            400,
            `The ${label} commit ${shortSha(sha)} is not on branch "${branchLabel}".`,
            ErrorReason.VALIDATION_FAILED
          );
        }
      }
      if (!(await this.deps.git.isAncestor(repo.localPath, baseSha, headSha))) {
        return fail(
          400,
          `The From commit ${shortSha(baseSha)} is not an ancestor of the To commit ${shortSha(headSha)}. Pick an older From commit.`,
          ErrorReason.VALIDATION_FAILED
        );
      }
    } catch (error: unknown) {
      return gitFailure(error);
    }
    return {
      ok: true,
      source: {
        baseRef: branch,
        headRef: branch,
        prNumber: null,
        title: `${branch}: ${shortSha(baseSha)}…${shortSha(headSha)}`,
        baseSha,
        headSha
      }
    };
  }

  private async resolveWorkingTree(repo: RepositoryModel): Promise<SourceResolution> {
    const missing = await this.missingFolder(repo);
    if (missing) {
      return missing;
    }
    let current: string | null;
    try {
      if (!(await this.deps.git.isDirty(repo.localPath))) {
        return fail(400, `There are no uncommitted changes in ${repo.name}.`, ErrorReason.WORKING_TREE_CLEAN);
      }
      current = await this.deps.git.currentBranch(repo.localPath);
    } catch (error: unknown) {
      return gitFailure(error);
    }
    return {
      ok: true,
      source: {
        baseRef: current ?? "HEAD",
        headRef: WORKING_TREE_HEAD_REF,
        prNumber: null,
        title: current ? `Uncommitted changes on ${current}` : "Uncommitted changes (detached HEAD)"
      }
    };
  }

  private async missingFolder(repo: RepositoryModel): Promise<SourceResolution | null> {
    try {
      await fs.stat(repo.localPath);
      return null;
    } catch {
      return fail(400, `Repository folder is missing: ${repo.localPath}`, ErrorReason.NOT_GIT_REPO);
    }
  }

  /**
   * The visualization and its repository name, or null when either is soft-deleted (03 §9.7). Same join as list().
   */
  private async loadVisible(id: number): Promise<VisibleVisualization | null> {
    const v = schema.visualizations;
    const r = schema.repositories;
    const rows = await this.deps.db
      .select({
        visualization: v,
        repositoryName: r.name,
        repositoryFramework: r.framework,
        repositoryStateAllowance: r.stateAllowance
      })
      .from(v)
      .innerJoin(r, eq(r.id, v.repositoryId))
      .where(and(eq(v.isDeleted, false), eq(r.isDeleted, false), eq(v.id, id)))
      .limit(1);
    const row = rows[0];
    return row
      ? {
          visualization: ModelHandler.hydrate(VisualizationModel, row.visualization),
          repositoryName: row.repositoryName,
          repositoryFramework: row.repositoryFramework,
          repositoryStateAllowance: row.repositoryStateAllowance
        }
      : null;
  }

  private async clearCancelBestEffort(id: number): Promise<void> {
    try {
      await this.deps.queue.clearCancel(id);
    } catch (error: unknown) {
      this.log.warn(
        { event: "visualization.cancel.clear_failed", visualizationId: id, err: error },
        "Cancel flag clear failed"
      );
    }
  }

  private unexpected(error: unknown, action: string): ApiResponse<never> {
    this.log.error(
      { event: "visualizations.service.failed", err: error, action, visualizationId: this.visualizationPayload.id },
      "Visualizations service failed"
    );
    return INTERNAL_ERROR;
  }
}

/**
 * 16e block (16 §14.5): live mode is available for a terminal run with at least one harness snapshot, a base
 * commit, and a recreatable head (a head commit, or the kept working-tree snapshot).
 */
export function isLiveAvailable(
  v: Pick<VisualizationModel, "status" | "baseSha" | "headSha" | "sourceType" | "workingTreeSnapshot">,
  components: ReadonlyArray<Pick<VisualizationComponentModel, "harnessSource">>
): boolean {
  if (!isTerminalVisualizationStatus(v.status) || v.baseSha === null || v.baseSha === "") {
    return false;
  }
  const headRecreatable =
    v.sourceType === VisualizationSourceType.WORKING_TREE
      ? v.workingTreeSnapshot
      : v.headSha !== null && v.headSha !== "";
  return headRecreatable && components.some((component) => (component.harnessSource ?? "").trim() !== "");
}

function resolveVisualizationsDependencies(
  overrides: Partial<VisualizationsServiceDependencies>
): VisualizationsServiceDependencies {
  const queryHandler = overrides.queryHandler ?? new QueryHandler();
  return {
    queryHandler,
    db: overrides.db ?? DrizzleDb.getInstance(),
    transaction: overrides.transaction ?? ((fn) => DrizzleDb.transaction(fn)),
    git: overrides.git ?? new GitClient(),
    aiReadiness:
      overrides.aiReadiness ?? (async () => AiProviderFactory.readiness(await new SettingsStore().readAiSettings())),
    readGithubToken: overrides.readGithubToken ?? (() => new SettingsStore().readGithubToken()),
    githubClientFactory: overrides.githubClientFactory ?? ((token) => GitHubClient.fromToken(token)),
    queue: overrides.queue ?? QueueService,
    artifacts: overrides.artifacts ?? new ArtifactStore(),
    consoleFactory: overrides.consoleFactory ?? ((id) => new VisualizationConsoleService(id, queryHandler)),
    now: overrides.now ?? (() => new Date()),
    removeWorkingTreeSnapshot: overrides.removeWorkingTreeSnapshot ?? ((id) => removeWorkingTreeSnapshot(id))
  };
}

function fail(status: number, error: string, reason: ErrorReason): { ok: false; response: ApiResponse } {
  return { ok: false, response: { status, error, error_reason: reason } };
}

function gitFailure(error: unknown): SourceResolution {
  if (!(error instanceof GitCommandError)) {
    throw error;
  }
  const firstLine =
    redactSecrets(error.stderr)
      .split("\n")
      .find((line) => line.trim() !== "") ?? `exit code ${String(error.exitCode)}`;
  return fail(400, `git failed: ${firstLine.slice(0, STDERR_ECHO_MAX_LENGTH)}`, ErrorReason.NOT_GIT_REPO);
}

/** isValidGitBranchName without the type-guard narrowing (the name is echoed in the error message). */
function isUsableBranchName(name: string): boolean {
  return isValidGitBranchName(name);
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function limitTitle(title: string): string {
  return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title;
}

function notFound(): ApiResponse<never> {
  return { status: 404, error: "Visualization not found", error_reason: ErrorReason.NOT_FOUND };
}

function alreadyTerminal(status: VisualizationStatus): ApiResponse<never> {
  return { status: 409, error: `This visualization is already ${status}.`, error_reason: ErrorReason.ALREADY_TERMINAL };
}

function stillRunning(): ApiResponse<never> {
  return {
    status: 409,
    error: "This visualization is still running. Cancel it and wait until it stops before deleting.",
    error_reason: ErrorReason.CONFLICT
  };
}
