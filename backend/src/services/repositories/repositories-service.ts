import fs from "node:fs/promises";
import { ANGULAR_CACHE_DIR_NAME, BRANCH_LIST_MAX, COMMIT_LIST_DEFAULT_LIMIT } from "../../config-consts";
import {
  toAppDiscoveryView,
  toCommitView,
  toPullRequestView,
  toRepositoryView,
  type AppDiscoveryView,
  type BranchListView,
  type CommitView,
  type PullRequestView,
  type RepositoryCommitsQueryDTO,
  type RepositoryView
} from "../../dtos";
import {
  DeletionMode,
  ErrorReason,
  Table,
  TERMINAL_VISUALIZATION_STATUSES,
  VisualizationSourceType
} from "../../enums";
import { RepositoryModel, VisualizationModel } from "../../models";
import {
  ArtifactStore,
  GitClient,
  GitCommandError,
  GitHubClient,
  GitHubClientError,
  QueryHandler,
  Where,
  createLogger,
  githubErrorToApiResponse,
  type ApiResponse,
  type GitCommitEntry
} from "../../utilities";
import { SettingsStore, type SecretRead } from "../settings/settings-store";
import { removeWorkingTreeSnapshot } from "../visualizations/pipeline/workspace-prepare-service";
import {
  ProjectDetectionService,
  suggestRenderViewport,
  type AppSelection,
  type DetectedProject,
  type DetectionFailure
} from "./project-detection-service";

/** Collaborators of RepositoriesService; tests replace any of them. */
export interface RepositoriesServiceDependencies {
  queryHandler: QueryHandler;
  detector: Pick<ProjectDetectionService, "detect">;
  /** App discovery for POST /api/repositories/detect-apps (15 §5.4.3). */
  discoverer: Pick<ProjectDetectionService, "discoverApps">;
  /** Resolves `cache/angular/<id>` inside the data dir (removed with the repository, 15 §5.4.5). */
  artifacts: Pick<ArtifactStore, "resolveSafe">;
  git: Pick<
    GitClient,
    "listBranches" | "currentBranch" | "isDirty" | "revParse" | "hasCommit" | "isAncestor" | "logCommits"
  >;
  /** new SettingsStore().readGithubToken() */
  readGithubToken: () => Promise<SecretRead>;
  /** GitHubClient.fromToken */
  githubClientFactory: (token: string) => Pick<GitHubClient, "listOpenPullRequests">;
  now: () => Date;
  /** 16d block (16 §11.2): rm -rf `<dataDir>/snapshots/<id>/` of one of the repository's runs. */
  removeWorkingTreeSnapshot: (visualizationId: number) => Promise<void>;
}

const STDERR_MESSAGE_MAX_CHARS = 200;
const STDERR_LOG_MAX_CHARS = 500;

/**
 * HTTP-facing service for registered repositories (06 §5.5): registration through ProjectDetectionService,
 * redetect, soft delete with an active-run guard, open PRs from GitHub and local branches.
 */
export class RepositoriesService {
  private readonly deps: RepositoriesServiceDependencies;
  private readonly log = createLogger("repositories-service");

  /**
   * @param repositoryPayload - Mapped request model (localPath/name for create, id otherwise).
   * @param deps - Overrides for tests; everything else uses the production default.
   */
  constructor(
    private readonly repositoryPayload: RepositoryModel = new RepositoryModel(),
    deps: Partial<RepositoriesServiceDependencies> = {}
  ) {
    this.deps = {
      queryHandler: deps.queryHandler ?? new QueryHandler(),
      detector: deps.detector ?? new ProjectDetectionService(),
      discoverer: deps.discoverer ?? new ProjectDetectionService(),
      artifacts: deps.artifacts ?? new ArtifactStore(),
      git: deps.git ?? new GitClient(),
      readGithubToken: deps.readGithubToken ?? (() => new SettingsStore().readGithubToken()),
      githubClientFactory: deps.githubClientFactory ?? ((token: string) => GitHubClient.fromToken(token)),
      now: deps.now ?? (() => new Date()),
      removeWorkingTreeSnapshot: deps.removeWorkingTreeSnapshot ?? ((id) => removeWorkingTreeSnapshot(id))
    };
  }

  /** All registered repositories as RepositoryView[] (unpaged), ordered by name then id. */
  async list(): Promise<ApiResponse<RepositoryView[]>> {
    try {
      const models = await this.deps.queryHandler.selectMany(RepositoryModel, {}, Table.REPOSITORIES, {
        orderBy: [
          { column: "name", direction: "asc" },
          { column: "id", direction: "asc" }
        ]
      });
      return { status: 200, data: models.map(toRepositoryView) };
    } catch (error: unknown) {
      return this.unexpected(error, "list");
    }
  }

  /** One repository; 404 not_found when unknown or deleted. */
  async get(): Promise<ApiResponse<RepositoryView>> {
    try {
      const repository = await this.loadRepository();
      if (!repository) {
        return this.notFound();
      }
      return { status: 200, data: toRepositoryView(repository) };
    } catch (error: unknown) {
      return this.unexpected(error, "get");
    }
  }

  /**
   * Lists the apps of the repository at the payload's localPath (15 §5.4.5), each marked with the id of its active
   * registration, or returns the detection failure.
   */
  async detectApps(): Promise<ApiResponse<AppDiscoveryView>> {
    try {
      const localPath = this.repositoryPayload.localPath;
      const result = await this.deps.discoverer.discoverApps(localPath);
      if (!result.ok) {
        return this.detectionFailure(result.failure, localPath);
      }
      const discovery = result.discovery;
      const registered = await this.deps.queryHandler.select(
        { localPath: discovery.rootPath },
        Table.REPOSITORIES,
        true
      );
      if (discovery.warnings.length > 0) {
        this.log.info(
          { event: "repositories.discovery.warnings", localPath: discovery.rootPath, warnings: discovery.warnings },
          "App discovery warnings"
        );
      }
      return {
        status: 200,
        data: toAppDiscoveryView(discovery, (app) => {
          const row = registered.find(
            (candidate) =>
              (candidate.appRoot ?? ".") === app.appRoot && (candidate.angularProject ?? null) === app.angularProject
          );
          return typeof row?.id === "number" ? row.id : null;
        })
      };
    } catch (error: unknown) {
      return this.unexpected(error, "detectApps");
    }
  }

  /** Detects the app at the payload's localPath (and appRoot/angularProject) and inserts it (201). */
  async create(): Promise<ApiResponse<RepositoryView>> {
    try {
      // Detect the app (business validation of the folder and the selection).
      const detection = await this.deps.detector.detect(this.repositoryPayload.localPath, this.payloadSelection());
      if (!detection.ok) {
        return this.detectionFailure(detection.failure, this.repositoryPayload.localPath);
      }
      const project = detection.project;

      // Duplicate check on (canonical path, app root, project) among non-deleted rows; soft-deleted rows are history.
      const duplicate = (await this.findActiveRows(project))[0];
      if (duplicate) {
        const isRootReact = project.appRoot === "." && project.angularProject === null;
        return {
          status: 409,
          error: `This ${isRootReact ? "folder" : "app"} is already registered as "${String(duplicate.name)}" (id ${String(duplicate.id)})`,
          error_reason: ErrorReason.CONFLICT
        };
      }

      // Insert with the user's name override, else the detected name.
      const nameOverride = this.payloadName();
      const insertResponse = await this.deps.queryHandler.insert(
        {
          name: nameOverride ?? project.suggestedName,
          ...this.detectedFields(project),
          renderViewport: this.payloadViewport() ?? (await suggestRenderViewport(project.rootPath, project.appRoot))
        },
        Table.REPOSITORIES
      );
      if (insertResponse.status === 409) {
        // Unique-violation race (two concurrent registers); the constraint text is not passed through.
        return { status: 409, error: "This folder is already registered", error_reason: ErrorReason.CONFLICT };
      }
      const row = insertResponse.data?.[0];
      if (insertResponse.status !== 200 || !row) {
        this.log.error(
          { event: "repositories.repository.insert_failed", status: insertResponse.status },
          "Repository insert failed"
        );
        return { status: 500, error: "Repository could not be saved", error_reason: ErrorReason.INTERNAL_ERROR };
      }

      const view = toRepositoryView(new RepositoryModel(row));
      this.log.info(
        {
          event: "repositories.repository.registered",
          repositoryId: view.id,
          localPath: view.localPath,
          githubOwner: view.githubOwner,
          githubRepo: view.githubRepo,
          framework: view.framework,
          appRoot: view.appRoot,
          angularProject: view.angularProject,
          packageManager: view.packageManager,
          warnings: project.warnings
        },
        "Repository registered"
      );
      return { status: 201, data: view };
    } catch (error: unknown) {
      return this.unexpected(error, "create");
    }
  }

  /** Re-runs detection on the stored path; on failure the row is left unchanged. `name` is never changed. */
  async redetect(): Promise<ApiResponse<RepositoryView>> {
    try {
      const existing = await this.loadRepository();
      if (!existing) {
        return this.notFound();
      }

      // The stored app is re-read (15 §5.4.4: a vanished Angular project fails and leaves the row unchanged).
      const angularProject: unknown = existing.angularProject;
      const appRoot: unknown = existing.appRoot;
      const detection = await this.deps.detector.detect(existing.localPath, {
        appRoot: typeof appRoot === "string" ? appRoot : ".",
        ...(typeof angularProject === "string" ? { angularProject } : {})
      });
      if (!detection.ok) {
        return this.detectionFailure(detection.failure, existing.localPath);
      }
      const project = detection.project;

      // The folder now resolves elsewhere (symlink retargeted): refuse when that app is registered already.
      if (project.rootPath !== existing.localPath) {
        const duplicates = await this.findActiveRows(project, existing.id);
        if (duplicates.length > 0) {
          return this.alreadyRegistered();
        }
      }

      const updateResponse = await this.deps.queryHandler.update(
        this.detectedFields(project),
        { id: existing.id },
        Table.REPOSITORIES
      );
      if (updateResponse.status === 409) {
        return this.alreadyRegistered();
      }
      if (updateResponse.status === 404) {
        return this.notFound();
      }
      if (updateResponse.status !== 200) {
        this.log.error(
          { event: "repositories.repository.update_failed", status: updateResponse.status },
          "Repository update failed"
        );
        return { status: 500, error: "Repository could not be saved", error_reason: ErrorReason.INTERNAL_ERROR };
      }
      if (project.warnings.length > 0) {
        this.log.info(
          { event: "repositories.detection.warnings", repositoryId: existing.id, warnings: project.warnings },
          "Detection warnings on redetect"
        );
      }

      const reloaded = await this.loadRepository();
      if (!reloaded) {
        return this.notFound();
      }
      return { status: 200, data: toRepositoryView(reloaded) };
    } catch (error: unknown) {
      return this.unexpected(error, "redetect");
    }
  }

  /** Soft-deletes the repository row only; 409 conflict while any of its visualizations is non-terminal. */
  async remove(): Promise<ApiResponse<{ id: number }>> {
    try {
      const repository = await this.loadRepository();
      if (!repository) {
        return this.notFound();
      }

      // Active-run guard (isDeleted = false is added by QueryHandler).
      const active = await this.deps.queryHandler.count(
        { repositoryId: repository.id, status: Where.notIn([...TERMINAL_VISUALIZATION_STATUSES]) },
        Table.VISUALIZATIONS
      );
      if (active.status !== 200) {
        this.log.error(
          { event: "repositories.repository.count_failed", status: active.status },
          "Active run count failed"
        );
        return { status: 500, error: "Repository could not be removed", error_reason: ErrorReason.INTERNAL_ERROR };
      }
      if ((active.data?.count ?? 0) > 0) {
        return {
          status: 409,
          error: "This repository has visualizations queued or in progress. Cancel them first.",
          error_reason: ErrorReason.CONFLICT
        };
      }

      const deleteResponse = await this.deps.queryHandler.delete(
        { id: repository.id },
        Table.REPOSITORIES,
        DeletionMode.SOFT
      );
      if (deleteResponse.status === 404) {
        return this.notFound();
      }
      if (deleteResponse.status !== 200) {
        this.log.error(
          { event: "repositories.repository.delete_failed", status: deleteResponse.status },
          "Repository delete failed"
        );
        return { status: 500, error: "Repository could not be removed", error_reason: ErrorReason.INTERNAL_ERROR };
      }

      await this.removeAngularCache(repository.id);
      await this.removeWorkingTreeSnapshots(repository.id); // 16d block
      this.log.info({ event: "repositories.repository.removed", repositoryId: repository.id }, "Repository removed");
      return { status: 200, data: { id: repository.id } };
    } catch (error: unknown) {
      return this.unexpected(error, "remove");
    }
  }

  /** Open pull requests of the repository's github.com remote, most recently updated first (at most 300). */
  async listPullRequests(): Promise<ApiResponse<PullRequestView[]>> {
    try {
      const repository = await this.loadRepository();
      if (!repository) {
        return this.notFound();
      }
      const owner = repository.githubOwner;
      const repo = repository.githubRepo;
      if (!owner || !repo) {
        return {
          status: 400,
          error: "This repository has no github.com remote (checked upstream and origin)",
          error_reason: ErrorReason.NO_GITHUB_REMOTE
        };
      }

      const secret = await this.deps.readGithubToken();
      if (secret.state === "absent") {
        return {
          status: 400,
          error: "Add a GitHub token in Settings to list pull requests.",
          error_reason: ErrorReason.GITHUB_TOKEN_MISSING
        };
      }
      if (secret.state === "unreadable") {
        return {
          status: 400,
          error:
            "The stored GitHub token can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the token again in Settings.",
          error_reason: ErrorReason.GITHUB_TOKEN_MISSING
        };
      }

      try {
        const pullRequests = await this.deps.githubClientFactory(secret.value).listOpenPullRequests(owner, repo);
        return { status: 200, data: pullRequests.map(toPullRequestView) };
      } catch (error: unknown) {
        if (error instanceof GitHubClientError) {
          // GitHubClient already logged { kind, httpStatus, owner, repo }; the error object is never logged.
          return githubErrorToApiResponse(error, { owner, repo });
        }
        throw error;
      }
    } catch (error: unknown) {
      return this.unexpected(error, "listPullRequests");
    }
  }

  /** Local branches (most recent first, capped), the current branch, the default branch and the dirty flag. */
  async listBranches(): Promise<ApiResponse<BranchListView>> {
    try {
      const repository = await this.loadRepository();
      if (!repository) {
        return this.notFound();
      }
      const localPath = repository.localPath;
      try {
        await fs.stat(localPath);
      } catch {
        return this.missingFolder(localPath);
      }

      let listed: [string[], string | null, boolean];
      try {
        listed = await Promise.all([
          this.deps.git.listBranches(localPath),
          this.deps.git.currentBranch(localPath),
          this.deps.git.isDirty(localPath)
        ]);
      } catch (error: unknown) {
        if (error instanceof GitCommandError) {
          return this.gitFailure(error, repository.id, "branches");
        }
        throw error;
      }
      const [allBranches, current, workingTreeDirty] = listed;

      const branches = allBranches.slice(0, BRANCH_LIST_MAX);
      const defaultBranch = repository.defaultBranch;
      if (defaultBranch && !branches.includes(defaultBranch)) {
        branches.unshift(defaultBranch);
      }
      if (current !== null && !branches.includes(current)) {
        branches.unshift(current);
      }
      return { status: 200, data: { current, branches, defaultBranch, workingTreeDirty } };
    } catch (error: unknown) {
      return this.unexpected(error, "listBranches");
    }
  }

  /**
   * Commits of a local branch's first-parent history, newest first (00 §16). `before` (exclusive) pages further back
   * and must be a commit of that branch. 400 validation_failed for an unknown branch or a foreign `before`.
   */
  async listCommits(query: RepositoryCommitsQueryDTO): Promise<ApiResponse<CommitView[]>> {
    try {
      const repository = await this.loadRepository();
      if (!repository) {
        return this.notFound();
      }
      const localPath = repository.localPath;
      try {
        await fs.stat(localPath);
      } catch {
        return this.missingFolder(localPath);
      }
      const branchLabel = query.branch.slice(0, STDERR_MESSAGE_MAX_CHARS);
      try {
        let branchTip: string;
        try {
          branchTip = await this.deps.git.revParse(localPath, `refs/heads/${query.branch}`);
        } catch (error: unknown) {
          if (
            error instanceof GitCommandError &&
            (error.code === "unknown_revision" || error.code === "invalid_argument")
          ) {
            return {
              status: 400,
              error: `Branch "${branchLabel}" does not exist in ${repository.name}.`,
              error_reason: ErrorReason.VALIDATION_FAILED
            };
          }
          throw error;
        }

        if (query.q !== undefined) {
          const found = await this.searchCommits(
            localPath,
            branchTip,
            query.q,
            query.limit ?? COMMIT_LIST_DEFAULT_LIMIT
          );
          return { status: 200, data: found.map(toCommitView) };
        }

        let start = branchTip;
        if (query.before !== undefined) {
          const onBranch =
            (await this.deps.git.hasCommit(localPath, query.before)) &&
            (await this.deps.git.isAncestor(localPath, query.before, branchTip));
          if (!onBranch) {
            return {
              status: 400,
              error: `Commit ${query.before.slice(0, 7)} is not on branch "${branchLabel}".`,
              error_reason: ErrorReason.VALIDATION_FAILED
            };
          }
          start = query.before;
        }
        const commits = await this.deps.git.logCommits(localPath, start, {
          limit: query.limit ?? COMMIT_LIST_DEFAULT_LIMIT,
          skip: query.before === undefined ? 0 : 1
        });
        return { status: 200, data: commits.map(toCommitView) };
      } catch (error: unknown) {
        if (error instanceof GitCommandError) {
          return this.gitFailure(error, repository.id, "commits");
        }
        throw error;
      }
    } catch (error: unknown) {
      return this.unexpected(error, "listCommits");
    }
  }

  /**
   * Commit search on the branch's first-parent history: an exact commit for a SHA prefix (when it is on the branch),
   * then message and author matches, newest first, without duplicates.
   */
  private async searchCommits(
    localPath: string,
    branchTip: string,
    q: string,
    limit: number
  ): Promise<GitCommitEntry[]> {
    const [bySha, byMessage, byAuthor] = await Promise.all([
      this.commitBySha(localPath, branchTip, q),
      this.deps.git.logCommits(localPath, branchTip, { limit, grep: q }),
      this.deps.git.logCommits(localPath, branchTip, { limit, author: q })
    ]);
    const byDate = [...byMessage, ...byAuthor].sort((a, b) => Date.parse(b.committedAt) - Date.parse(a.committedAt));
    const seen = new Set<string>();
    const merged: GitCommitEntry[] = [];
    for (const commit of [...bySha, ...byDate]) {
      if (!seen.has(commit.sha)) {
        seen.add(commit.sha);
        merged.push(commit);
      }
    }
    return merged.slice(0, limit);
  }

  /** The commit a 4–40 character hex prefix names, when it exists and is reachable from the branch; else none. */
  private async commitBySha(localPath: string, branchTip: string, q: string): Promise<GitCommitEntry[]> {
    if (!/^[0-9a-f]{4,40}$/i.test(q)) {
      return [];
    }
    let sha: string;
    try {
      sha = await this.deps.git.revParse(localPath, q.toLowerCase());
    } catch (error: unknown) {
      if (error instanceof GitCommandError) {
        return []; // unknown or ambiguous prefix: no SHA match
      }
      throw error;
    }
    if (!(await this.deps.git.isAncestor(localPath, sha, branchTip))) {
      return [];
    }
    return this.deps.git.logCommits(localPath, sha, { limit: 1 });
  }

  /** Loads one non-deleted repository by the id in the payload (QueryHandler adds isDeleted = false). */
  private async loadRepository(): Promise<RepositoryModel | null> {
    return this.deps.queryHandler.validateAndSelect(
      RepositoryModel,
      { id: this.repositoryPayload.id },
      Table.REPOSITORIES
    );
  }

  /** Active rows registered for the detected app (same path, app root and Angular project), optionally excluding one id. */
  private async findActiveRows(project: DetectedProject, excludeId?: number): Promise<Record<string, unknown>[]> {
    const rows = await this.deps.queryHandler.select(
      {
        localPath: project.rootPath,
        appRoot: project.appRoot,
        ...(excludeId === undefined ? {} : { id: Where.ne(excludeId) })
      },
      Table.REPOSITORIES,
      true
    );
    return rows.filter((row) => (row.angularProject ?? null) === project.angularProject);
  }

  /** The DTO's optional appRoot/angularProject (15 §5.4.5); undefined when neither was sent. */
  private payloadSelection(): AppSelection | undefined {
    const appRoot: unknown = this.repositoryPayload.appRoot;
    const angularProject: unknown = this.repositoryPayload.angularProject;
    const selection: AppSelection = {
      ...(typeof appRoot === "string" ? { appRoot } : {}),
      ...(typeof angularProject === "string" ? { angularProject } : {})
    };
    return Object.keys(selection).length === 0 ? undefined : selection;
  }

  /** Best effort: removes `<dataDir>/cache/angular/<id>` (15 §5.4.5); a failure is logged, never returned. */
  // --- 16d block (16 §11.2): working-tree snapshots of the repository's runs are deleted with it (best effort) ---
  private async removeWorkingTreeSnapshots(repositoryId: number): Promise<void> {
    try {
      // isDeleted given explicitly so soft-deleted runs' leftover snapshots are removed too
      const runs = await this.deps.queryHandler.selectMany(
        VisualizationModel,
        { repositoryId, sourceType: VisualizationSourceType.WORKING_TREE, isDeleted: Where.isNotNull() },
        Table.VISUALIZATIONS
      );
      for (const run of runs) {
        try {
          await this.deps.removeWorkingTreeSnapshot(run.id);
        } catch (error: unknown) {
          this.log.warn(
            { event: "repositories.snapshot.remove_failed", repositoryId, visualizationId: run.id, err: error },
            "Working-tree snapshot could not be removed"
          );
        }
      }
    } catch (error: unknown) {
      this.log.warn(
        { event: "repositories.snapshot.remove_failed", repositoryId, err: error },
        "Working-tree snapshots could not be listed"
      );
    }
  }
  // --- end 16d block ---

  private async removeAngularCache(repositoryId: number): Promise<void> {
    try {
      const cacheDir = this.deps.artifacts.resolveSafe(`${ANGULAR_CACHE_DIR_NAME}/${String(repositoryId)}`);
      await fs.rm(cacheDir, { recursive: true, force: true });
    } catch (error: unknown) {
      this.log.warn(
        { event: "repositories.angular_cache.remove_failed", repositoryId, err: error },
        "Angular build cache could not be removed"
      );
    }
  }

  /** The DTO's optional name (the generated getter is typed string but is unset when omitted). */
  private payloadViewport(): "desktop" | "tablet" | "mobile" | null {
    const value: unknown = this.repositoryPayload.renderViewport;
    return value === "desktop" || value === "tablet" || value === "mobile" ? value : null;
  }

  /** PATCH /api/repositories/:id — saves user settings (the screen size). Detection results are untouched. */
  async updateSettings(renderViewport: "desktop" | "tablet" | "mobile"): Promise<ApiResponse<RepositoryView>> {
    try {
      const existing = await this.loadRepository();
      if (!existing) {
        return this.notFound();
      }
      const update = await this.deps.queryHandler.update({ renderViewport }, { id: existing.id }, Table.REPOSITORIES);
      if (update.status !== 200) {
        return { status: 500, error: "Repository could not be saved", error_reason: ErrorReason.INTERNAL_ERROR };
      }
      const saved = await this.loadRepository();
      if (!saved) {
        return this.notFound();
      }
      this.log.info(
        { event: "repositories.repository.settings_saved", repositoryId: existing.id, renderViewport },
        "Repository settings saved"
      );
      return { status: 200, data: toRepositoryView(saved) };
    } catch (error: unknown) {
      return this.unexpected(error, "updateSettings");
    }
  }

  private payloadName(): string | null {
    const name: unknown = this.repositoryPayload.name;
    return typeof name === "string" && name.length > 0 ? name : null;
  }

  private missingFolder(localPath: string): ApiResponse<never> {
    return {
      status: 400,
      error: `Repository folder is missing: ${localPath}. Restore it or remove the repository.`,
      error_reason: ErrorReason.NOT_GIT_REPO
    };
  }

  /** A git failure as 400 not_git_repo with the first stderr line (logged with more context). */
  private gitFailure(error: GitCommandError, repositoryId: number, what: "branches" | "commits"): ApiResponse<never> {
    this.log.warn(
      {
        event: `repositories.${what}.git_failed`,
        repositoryId,
        exitCode: error.exitCode,
        stderr: error.stderr.slice(0, STDERR_LOG_MAX_CHARS)
      },
      `GitCommandError in ${what}`
    );
    const firstLine = (error.stderr.split("\n").find((line) => line.trim() !== "") ?? error.message).trim();
    return {
      status: 400,
      error: `git failed: ${firstLine.slice(0, STDERR_MESSAGE_MAX_CHARS)}`,
      error_reason: ErrorReason.NOT_GIT_REPO
    };
  }

  private notFound(): ApiResponse<never> {
    return { status: 404, error: "Repository not found", error_reason: ErrorReason.NOT_FOUND };
  }

  private alreadyRegistered(): ApiResponse<never> {
    return { status: 409, error: "This folder is already registered", error_reason: ErrorReason.CONFLICT };
  }

  private detectionFailure(failure: DetectionFailure, localPath: string): ApiResponse<never> {
    this.log.info(
      { event: "repositories.detection.rejected", localPath, errorReason: failure.errorReason },
      "Detection rejected"
    );
    return { status: failure.status, error: failure.message, error_reason: failure.errorReason };
  }

  private detectedFields(project: DetectedProject): Record<string, unknown> {
    return {
      localPath: project.rootPath,
      githubOwner: project.githubOwner,
      githubRepo: project.githubRepo,
      defaultBranch: project.defaultBranch,
      framework: project.framework,
      packageManager: project.packageManager,
      appRoot: project.appRoot,
      angularProject: project.angularProject,
      angularBuildConfiguration: project.angularBuildConfiguration,
      viteConfigPath: project.viteConfigPath,
      tsconfigPath: project.tsconfigPath,
      entryFilePath: project.entryFilePath,
      globalStylePaths: project.globalStylePaths,
      lastDetectedAt: this.deps.now()
    };
  }

  private unexpected(error: unknown, action: string): ApiResponse<never> {
    this.log.error({ event: "repositories.service.failed", err: error, action }, "Repositories service failed");
    return { status: 500, error: "Internal server error", error_reason: ErrorReason.INTERNAL_ERROR };
  }
}
