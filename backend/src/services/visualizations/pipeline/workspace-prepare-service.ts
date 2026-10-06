import { constants as fsConstants, type Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  DETECTION_MAX_FILE_BYTES,
  GIT_FETCH_TIMEOUT_MS,
  HARNESS_DIR_NAME,
  HARNESS_TEMPLATES_DIR,
  WORKING_TREE_MAX_UNTRACKED_BYTES,
  WORKING_TREE_MAX_UNTRACKED_FILES
} from "../../../config-consts";
import { isValidGitBranchName } from "../../../dtos";
import { RepositoryFramework, VisualizationSourceType } from "../../../enums";
import {
  PipelineStepError,
  type PipelineContext,
  type PreparedWorkspace,
  type WorktreeSide
} from "../../../types/visualization-pipeline";
import {
  ArtifactStore,
  GitClient,
  GitCommandError,
  GitHubClient,
  GitHubClientError,
  createLogger,
  githubErrorToApiResponse,
  isPathInside,
  normalizeRepoRelativePath,
  parseGithubRemoteUrl,
  resolveInside,
  type GitAuthHeader
} from "../../../utilities";
import { SettingsStore, type SecretRead } from "../../settings/settings-store";

/** Inputs of prepare(): the source columns of the visualization row plus the repository snapshot (07 §5.11). */
export interface WorkspacePrepareInput {
  visualizationId: number;
  sourceType: VisualizationSourceType;
  prNumber: number | null;
  baseRef: string;
  headRef: string;
  /** commit_range only (00 §16): the commits stored at create. Ignored for the other source types. */
  baseSha?: string | null;
  headSha?: string | null;
  repository: {
    id: number;
    localPath: string;
    githubOwner: string | null;
    githubRepo: string | null;
    viteConfigPath: string | null;
    /** Defaults to react_vite (15 §5.4.6: the React template copy runs only for react_vite). */
    framework?: RepositoryFramework;
    /** Repo-relative app root; defaults to "." (15 §5.4.6: node_modules is linked there too). */
    appRoot?: string;
  };
  console: PipelineContext["console"];
  signal: AbortSignal;
}

/** Inputs of cleanup(); `repositoryPath` is null when the repository row is gone (boot recovery). */
export interface WorkspaceCleanupInput {
  visualizationId: number;
  repositoryPath: string | null;
  prNumber: number | null;
  /** Vite config path of the repository, when known (only used to find a subfolder node_modules link). */
  viteConfigPath?: string | null;
  /** App root of the repository, when known (only used to find its node_modules link). */
  appRoot?: string | null;
}

/** Git calls this service makes (04 §9.5 names and parameters). */
export type WorkspaceGit = Pick<
  GitClient,
  | "topLevel"
  | "revParse"
  | "hasCommit"
  | "mergeBase"
  | "fetch"
  | "worktreeAdd"
  | "worktreeRemove"
  | "worktreePrune"
  | "diffBinaryHead"
  | "applyPatch"
  | "lsUntracked"
  | "remoteUrl"
  | "deleteRef"
>;

/** Everything WorkspacePrepareService talks to; tests replace any subset. */
export interface WorkspacePrepareDependencies {
  git: WorkspaceGit;
  artifacts: Pick<
    ArtifactStore,
    "worktreesRoot" | "visualizationWorktreeRoot" | "worktreeDir" | "removeVisualizationWorktreeRoot" | "ensureDir"
  >;
  readGithubToken: () => Promise<SecretRead>;
  githubClientFactory: (token: string) => Pick<GitHubClient, "getPullRequest">;
  /** HARNESS_TEMPLATES_DIR. */
  harnessTemplatesDir: string;
}

/** Dependency differences between the two sides' package.json files (07 §5.13.6). */
export interface DependencyDrift {
  any: boolean;
  added: string[];
  removed: string[];
  changed: string[];
}

interface ResolvedCommits {
  baseSha: string;
  headCommit: string;
  headSha: string | null;
}

interface FetchAttempt {
  label: string;
  remote: string;
  auth?: GitAuthHeader;
}

/** Ref PRVision fetches a PR head into (00 §4). */
export const prRef = (n: number): string => `refs/prvision/pr-${n}`;
/** Ref PRVision fetches a PR's base branch into (00 §14.7). */
export const prBaseRef = (n: number): string => `refs/prvision/pr-${n}-base`;

const STAGE = "preparing";
const SIDES: readonly WorktreeSide[] = ["base", "head"];
const EXCLUDED_FIRST_SEGMENTS = new Set(["node_modules", ".git", HARNESS_DIR_NAME]);
const DRIFT_LIST_MAX = 10;
const SHORT_SHA_LENGTH = 7;
const GIT_SUMMARY_MAX_LENGTH = 300;

/**
 * Turns a source (PR, branch pair or working tree) into two detached git worktrees under
 * `<dataDir>/worktrees/<id>/{base,head}`, links the user's node_modules into them and copies the harness templates
 * (07 §5.13). Never writes through a path component that is a symlink in the checkout. cleanup() removes
 * everything again, including the refs/prvision/* refs, and never throws.
 */
export class WorkspacePrepareService {
  private readonly log = createLogger("workspace-prepare");
  private readonly deps: WorkspacePrepareDependencies;

  constructor(deps: Partial<WorkspacePrepareDependencies> = {}) {
    this.deps = {
      git: deps.git ?? new GitClient(),
      artifacts: deps.artifacts ?? new ArtifactStore(),
      readGithubToken: deps.readGithubToken ?? (() => new SettingsStore().readGithubToken()),
      githubClientFactory: deps.githubClientFactory ?? ((token) => GitHubClient.fromToken(token)),
      harnessTemplatesDir: deps.harnessTemplatesDir ?? HARNESS_TEMPLATES_DIR
    };
  }

  /**
   * Creates both worktrees for the visualization. Throws PipelineStepError("preparing", …) for problems the user
   * can act on; an abort rethrows the signal's reason at the next call boundary.
   */
  async prepare(input: WorkspacePrepareInput): Promise<PreparedWorkspace> {
    const { visualizationId: id, signal, repository } = input;
    const localPath = repository.localPath;
    const { git, artifacts } = this.deps;

    // 1. Paths
    signal.throwIfAborted();
    const root = artifacts.visualizationWorktreeRoot(id);
    const baseDir = artifacts.worktreeDir(id, "base");
    const headDir = artifacts.worktreeDir(id, "head");

    // 2. Leftovers from an earlier crashed attempt
    if (await lstatOrNull(root)) {
      await this.cleanup({
        visualizationId: id,
        repositoryPath: localPath,
        prNumber: input.prNumber,
        viteConfigPath: repository.viteConfigPath,
        appRoot: repository.appRoot ?? null
      });
    }
    await artifacts.ensureDir(root);

    // 3. Repository sanity
    signal.throwIfAborted();
    try {
      await fs.stat(localPath);
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, `The repository folder ${localPath} no longer exists.`, { cause: error });
    }
    try {
      await git.topLevel(localPath);
    } catch (error: unknown) {
      rethrowAbort(error, signal);
      throw new PipelineStepError(STAGE, `${localPath} is no longer a git repository.`, {
        cause: error,
        code: gitCode(error)
      });
    }

    // 4. Drop stale registrations that would make `worktree add` fail with worktree_exists
    signal.throwIfAborted();
    await this.bestEffort("worktree_prune", id, () => git.worktreePrune(localPath));

    // 5. Resolve commits (working_tree also snapshots the user's changes here)
    signal.throwIfAborted();
    let overlay: WorkingTreeSnapshot | null = null;
    let commits: ResolvedCommits;
    switch (input.sourceType) {
      case VisualizationSourceType.GITHUB_PR:
        commits = await this.resolvePullRequest(input);
        break;
      case VisualizationSourceType.LOCAL_BRANCH:
        commits = await this.resolveLocalBranch(input);
        break;
      case VisualizationSourceType.WORKING_TREE: {
        const snapshot = await this.snapshotWorkingTree(input);
        overlay = snapshot;
        commits = { baseSha: snapshot.baseSha, headCommit: snapshot.baseSha, headSha: null };
        break;
      }
      case VisualizationSourceType.COMMIT_RANGE:
        commits = await this.resolveCommitRange(input);
        break;
    }

    // 6. Worktrees (detached, hooks disabled by 04)
    for (const [dir, sha] of [
      [baseDir, commits.baseSha],
      [headDir, commits.headCommit]
    ] as const) {
      signal.throwIfAborted();
      try {
        await git.worktreeAdd(localPath, dir, sha);
      } catch (error: unknown) {
        rethrowAbort(error, signal);
        if (error instanceof GitCommandError) {
          throw new PipelineStepError(STAGE, `Could not create a git worktree: ${gitErrorSummary(error)}`, {
            cause: error,
            code: error.code
          });
        }
        throw error;
      }
    }
    if (/filter=lfs/.test((await readSmallTextFile(path.join(headDir, ".gitattributes"))) ?? "")) {
      await input.console.warn(
        STAGE,
        "This repository uses Git LFS; LFS files (e.g. images) are not downloaded and may render as broken."
      );
    }

    // 7. Working-tree overlay
    if (overlay) {
      await this.applyOverlay(input, headDir, overlay);
    }

    // 8. node_modules symlinks for ".", the app root and the Vite root (15 §5.4.6)
    const framework = repository.framework ?? RepositoryFramework.REACT_VITE;
    const isReact = framework === RepositoryFramework.REACT_VITE;
    const viteRootRel = viteRootOf(repository.viteConfigPath);
    const linkDirs = nodeModulesLinkDirs(repository.appRoot ?? null, repository.viteConfigPath);
    const viteRoots = new Map<WorktreeSide, string>();
    for (const side of SIDES) {
      signal.throwIfAborted();
      const sideDir = side === "base" ? baseDir : headDir;
      for (const linkRel of linkDirs) {
        const linkDir = linkRel === "." ? sideDir : await ensureRealDir(sideDir, linkRel);
        if (linkDir === null) {
          throw new PipelineStepError(
            STAGE,
            linkRel === viteRootRel
              ? `The Vite root ${linkRel} is a symbolic link in this checkout; PRVision only renders projects whose Vite root is a real folder.`
              : `The app root ${linkRel} is a symbolic link in this checkout; PRVision only renders apps whose folder is a real directory.`
          );
        }
        if (linkRel === viteRootRel) {
          viteRoots.set(side, linkDir);
        }
        const source = await nodeModulesSource(localPath, linkRel, isReact);
        if (source === null) {
          continue; // nothing installed at this folder of the clone
        }
        const link = path.join(linkDir, "node_modules");
        if (await lstatOrNull(link)) {
          await input.console.warn(
            STAGE,
            linkRel === "."
              ? `The repository contains a node_modules entry; using it as-is on ${side}.`
              : `The repository contains a node_modules entry at ${linkRel}; using it as-is on ${side}.`
          );
          continue;
        }
        await fs.symlink(source, link, "dir");
      }
    }

    // 9. Dependency drift
    const drift = compareDependencies(
      parseJsonOrNull(await readSmallTextFile(path.join(baseDir, "package.json"))),
      parseJsonOrNull(await readSmallTextFile(path.join(headDir, "package.json")))
    );
    if (drift.any) {
      await input.console.warn(STAGE, describeDrift(drift));
    }

    // 10. Harness templates (React only; the Angular harness folder is written by the Angular render engine)
    signal.throwIfAborted();
    if (isReact) {
      await this.copyReactTemplates(input, viteRoots, baseDir, headDir);
    }

    // 11. .env files are deliberately not copied (the head worktree is the AI provider's working directory)
    await input.console.info(STAGE, "Note: .env files are not copied into the render workspace.");

    // 12. Done
    return {
      visualizationId: id,
      repositoryPath: localPath,
      baseDir,
      headDir,
      baseSha: commits.baseSha,
      headSha: commits.headSha,
      sourceType: input.sourceType,
      dependencyDrift: drift.any
    };
  }

  /** Step 10: copies the React harness templates into `<viteRoot>/.prvision-harness` on both sides. */
  private async copyReactTemplates(
    input: WorkspacePrepareInput,
    viteRoots: ReadonlyMap<WorktreeSide, string>,
    baseDir: string,
    headDir: string
  ): Promise<void> {
    const templates = this.deps.harnessTemplatesDir;
    const templatesStat = await lstatOrNull(templates);
    if (!templatesStat?.isDirectory()) {
      throw new PipelineStepError(
        STAGE,
        `Harness templates are missing at ${templates}; the PRVision installation is incomplete.`
      );
    }
    for (const side of SIDES) {
      const viteRoot = viteRoots.get(side) ?? (side === "base" ? baseDir : headDir);
      const dest = path.join(viteRoot, HARNESS_DIR_NAME);
      const existing = await lstatOrNull(dest);
      if (existing) {
        // A committed .prvision-harness (dir, file or symlink) would redirect the copy and 10's writes.
        if (existing.isDirectory() && !existing.isSymbolicLink()) {
          await fs.rm(dest, { recursive: true, force: true }); // never follows symlinks inside it
        } else {
          await fs.unlink(dest);
        }
        await input.console.warn(
          STAGE,
          `The repository contains a ${HARNESS_DIR_NAME} entry; it was replaced on ${side}.`
        );
      }
      await fs.mkdir(dest); // non-recursive: fails if something re-appeared
      // Entry by entry: fs.cp(dir, existingDir, { errorOnExist: true }) rejects the existing destination itself.
      for (const entry of await fs.readdir(templates)) {
        await fs.cp(path.join(templates, entry), path.join(dest, entry), {
          recursive: true,
          force: false,
          errorOnExist: true,
          dereference: false
        });
      }
    }
  }

  /**
   * Removes the worktrees, the refs/prvision/* refs of the PR and the worktree root. Never throws: every step is
   * isolated and logs a warning on failure. The node_modules symlinks are unlinked first, so nothing below can
   * reach the user's node_modules.
   */
  async cleanup(input: WorkspaceCleanupInput): Promise<void> {
    const startedAt = Date.now();
    const { visualizationId: id } = input;
    const { git, artifacts } = this.deps;
    const linkRels = nodeModulesLinkDirs(input.appRoot ?? null, input.viteConfigPath ?? null);

    // 1. node_modules symlinks first (head, then base)
    for (const side of ["head", "base"] as const) {
      await this.bestEffort("unlink_node_modules", id, async () => {
        const sideDir = artifacts.worktreeDir(id, side);
        const linkDirs: string[] = [];
        for (const linkRel of linkRels) {
          const linkDir = linkRel === "." ? sideDir : await existingRealDir(sideDir, linkRel);
          if (linkDir !== null) {
            linkDirs.push(linkDir);
          }
        }
        for (const linkDir of linkDirs) {
          const link = path.join(linkDir, "node_modules");
          if ((await lstatOrNull(link))?.isSymbolicLink()) {
            await fs.unlink(link);
          }
        }
      });
    }

    // 2. Git metadata and refs in the user's clone
    const repositoryPath = input.repositoryPath;
    if (repositoryPath !== null && (await lstatOrNull(repositoryPath))?.isDirectory()) {
      for (const side of ["head", "base"] as const) {
        await this.bestEffort("worktree_remove", id, () =>
          git.worktreeRemove(repositoryPath, artifacts.worktreeDir(id, side))
        );
      }
      await this.bestEffort("worktree_prune", id, () => git.worktreePrune(repositoryPath));
      if (input.prNumber !== null) {
        const n = input.prNumber;
        await this.bestEffort("delete_ref", id, () => git.deleteRef(repositoryPath, prRef(n)));
        await this.bestEffort("delete_ref", id, () => git.deleteRef(repositoryPath, prBaseRef(n)));
      }
    }

    // 3. The worktree root (04's guarded rm, only ever <dataDir>/worktrees/<int>)
    await this.bestEffort("remove_root", id, () => artifacts.removeVisualizationWorktreeRoot(id));

    this.log.info(
      { event: "workspace.cleanup.completed", visualizationId: id, durationMs: Date.now() - startedAt },
      "Workspace cleaned"
    );
  }

  // ----- github_pr (07 §5.13.2) -----

  private async resolvePullRequest(input: WorkspacePrepareInput): Promise<ResolvedCommits> {
    const { repository, signal } = input;
    const localPath = repository.localPath;
    const owner = repository.githubOwner;
    const repo = repository.githubRepo;
    const n = input.prNumber;
    if (owner === null || repo === null) {
      throw new PipelineStepError(STAGE, "This repository has no github.com remote.");
    }
    if (n === null) {
      throw new PipelineStepError(STAGE, "This pull request visualization has no pull request number.");
    }
    const secret = await this.deps.readGithubToken();
    if (secret.state !== "present") {
      throw new PipelineStepError(STAGE, "GitHub token is missing or unreadable. Add it in Settings.");
    }

    signal.throwIfAborted();
    let pr: Awaited<ReturnType<GitHubClient["getPullRequest"]>>;
    try {
      pr = await this.deps.githubClientFactory(secret.value).getPullRequest(owner, repo, n);
    } catch (error: unknown) {
      if (error instanceof GitHubClientError) {
        const response = githubErrorToApiResponse(error, { owner, repo, pullNumber: n });
        const message = typeof response.error === "string" ? response.error : "GitHub request failed.";
        throw new PipelineStepError(STAGE, message, { cause: error });
      }
      throw error;
    }

    await input.console.info(
      STAGE,
      `PR #${n}: ${pr.title} (${pr.baseRef} ← ${pr.headRef}), head ${shortSha(pr.headSha)}.`
    );
    if (pr.state === "closed") {
      await input.console.info(
        STAGE,
        `This pull request is closed${pr.merged ? " and merged" : ""}; visualizing its last head commit.`
      );
    }
    if (pr.isFork) {
      await input.console.warn(
        STAGE,
        `This pull request comes from a fork (${pr.headRepoFullName ?? "deleted fork"}). Rendering runs its code, including vite.config, on this machine.`
      );
    }
    if (!isUsableBranchName(pr.baseRef)) {
      throw new PipelineStepError(STAGE, `GitHub returned a base branch name PRVision cannot use: ${pr.baseRef}.`);
    }

    await this.fetchWithAuthChain({
      localPath,
      owner,
      repo,
      token: secret.value,
      refspecs: [`+refs/pull/${n}/head:${prRef(n)}`, `+refs/heads/${pr.baseRef}:${prBaseRef(n)}`],
      prNumber: n,
      console: input.console,
      signal
    });

    signal.throwIfAborted();
    const headSha = await this.deps.git.revParse(localPath, prRef(n));
    if (headSha !== pr.headSha) {
      await input.console.warn(
        STAGE,
        `The PR was updated after it was loaded; using the fetched head ${shortSha(headSha)}.`
      );
    }

    signal.throwIfAborted();
    let baseTip: string;
    if (await this.deps.git.hasCommit(localPath, pr.baseSha)) {
      baseTip = pr.baseSha;
    } else {
      baseTip = await this.deps.git.revParse(localPath, prBaseRef(n));
      await input.console.warn(STAGE, `The PR base commit is not available; using the current tip of ${pr.baseRef}.`);
    }

    signal.throwIfAborted();
    const baseSha = await this.mergeBaseOrFail(
      localPath,
      baseTip,
      headSha,
      "The pull request head and base share no history (is the clone shallow? run git fetch --unshallow)."
    );
    return { baseSha, headCommit: headSha, headSha };
  }

  /** Tries the user's own access, then the PAT headers from 06 in their order; stops at the first success. */
  private async fetchWithAuthChain(input: {
    localPath: string;
    owner: string;
    repo: string;
    token: string;
    refspecs: string[];
    prNumber: number;
    console: PipelineContext["console"];
    signal: AbortSignal;
  }): Promise<void> {
    const httpsUrl = `https://github.com/${input.owner}/${input.repo}.git`;
    const remoteName = await this.findGithubRemoteName(input.localPath, input.owner, input.repo);
    const attempts: FetchAttempt[] = [
      {
        label: remoteName ? `remote "${remoteName}" (your SSH key or public access)` : "github.com (public access)",
        remote: remoteName ?? httpsUrl
      },
      // 06 returns the headers in the order to try them (Basic x-access-token, then Bearer); never index the array.
      ...GitHubClient.gitAuthHeaders(input.token).map((auth, index) => ({
        label: index === 0 ? "the GitHub token" : `the GitHub token (alternative auth ${index + 1})`,
        remote: httpsUrl,
        auth
      }))
    ];
    let last: GitCommandError | null = null;
    for (const attempt of attempts) {
      input.signal.throwIfAborted();
      try {
        await this.deps.git.fetch(
          input.localPath,
          { remote: attempt.remote, refspecs: input.refspecs, auth: attempt.auth },
          { signal: input.signal, timeoutMs: GIT_FETCH_TIMEOUT_MS }
        );
        await input.console.info(STAGE, `Fetched pull request #${input.prNumber} using ${attempt.label}.`);
        return;
      } catch (error: unknown) {
        if (!(error instanceof GitCommandError) || error.code === "aborted") {
          throw error;
        }
        last = error;
        this.log.warn(
          {
            event: "workspace.fetch.attempt_failed",
            attempt: attempt.label,
            code: error.code,
            exitCode: error.exitCode
          },
          "PR fetch attempt failed"
        );
        await input.console.warn(STAGE, `Fetching with ${attempt.label} failed: ${gitErrorSummary(error)}`);
      }
    }
    throw new PipelineStepError(
      STAGE,
      `Could not fetch pull request #${input.prNumber} from GitHub (${last ? gitErrorSummary(last) : "unknown error"}). ` +
        "Check your SSH access, or give the GitHub token Contents: Read access to this repository.",
      { code: last?.code, cause: last ?? undefined }
    );
  }

  /** First of upstream/origin whose URL points at owner/repo on github.com (case-insensitive), or null. */
  private async findGithubRemoteName(localPath: string, owner: string, repo: string): Promise<string | null> {
    for (const name of ["upstream", "origin"]) {
      try {
        const url = await this.deps.git.remoteUrl(localPath, name);
        const parsed = url === null ? null : parseGithubRemoteUrl(url);
        if (
          parsed &&
          parsed.owner.toLowerCase() === owner.toLowerCase() &&
          parsed.repo.toLowerCase() === repo.toLowerCase()
        ) {
          return name;
        }
      } catch (error: unknown) {
        this.log.warn({ event: "workspace.remote.lookup_failed", remote: name, err: error }, "Remote lookup failed");
      }
    }
    return null;
  }

  // ----- local_branch (07 §5.13.3) -----

  private async resolveLocalBranch(input: WorkspacePrepareInput): Promise<ResolvedCommits> {
    const { repository, signal, baseRef, headRef } = input;
    const localPath = repository.localPath;
    const resolveBranch = async (name: string): Promise<string> => {
      signal.throwIfAborted();
      try {
        return await this.deps.git.revParse(localPath, `refs/heads/${name}`);
      } catch (error: unknown) {
        if (
          error instanceof GitCommandError &&
          (error.code === "unknown_revision" || error.code === "invalid_argument")
        ) {
          throw new PipelineStepError(STAGE, `Branch "${name}" no longer exists.`, { cause: error, code: error.code });
        }
        throw error;
      }
    };
    const baseTip = await resolveBranch(baseRef);
    const headSha = await resolveBranch(headRef);

    signal.throwIfAborted();
    const baseSha = await this.mergeBaseOrFail(
      localPath,
      baseTip,
      headSha,
      `Branches ${headRef} and ${baseRef} share no history (is the clone shallow? run git fetch --unshallow).`
    );
    if (baseSha === headSha) {
      await input.console.warn(
        STAGE,
        `${headRef} has no commits that are not already in ${baseRef}; nothing will differ.`
      );
    }
    await input.console.info(
      STAGE,
      `Comparing ${headRef} (${shortSha(headSha)}) against its merge-base with ${baseRef} (${shortSha(baseSha)}).`
    );
    return { baseSha, headCommit: headSha, headSha };
  }

  // ----- commit_range (00 §16) -----

  /** The two stored commits as they are: base worktree at baseSha, head at headSha, no merge-base step. */
  private async resolveCommitRange(input: WorkspacePrepareInput): Promise<ResolvedCommits> {
    const { repository, signal, headRef } = input;
    const baseSha = input.baseSha ?? null;
    const headSha = input.headSha ?? null;
    if (baseSha === null || headSha === null) {
      throw new PipelineStepError(STAGE, "This commit range has no stored commits; create the visualization again.");
    }
    for (const sha of [baseSha, headSha]) {
      signal.throwIfAborted();
      if (!(await this.deps.git.hasCommit(repository.localPath, sha))) {
        throw new PipelineStepError(
          STAGE,
          `Commit ${shortSha(sha)} no longer exists in the repository (was ${headRef} rewritten?).`,
          { code: "unknown_revision" }
        );
      }
    }
    await input.console.info(STAGE, `Comparing commits ${shortSha(baseSha)} → ${shortSha(headSha)} on ${headRef}.`);
    return { baseSha, headCommit: headSha, headSha };
  }

  private async mergeBaseOrFail(localPath: string, a: string, b: string, noHistoryMessage: string): Promise<string> {
    try {
      return await this.deps.git.mergeBase(localPath, a, b);
    } catch (error: unknown) {
      if (error instanceof GitCommandError && error.code === "no_merge_base") {
        throw new PipelineStepError(STAGE, noHistoryMessage, { cause: error, code: error.code });
      }
      throw error;
    }
  }

  // ----- working_tree (07 §5.13.4) -----

  private async snapshotWorkingTree(input: WorkspacePrepareInput): Promise<WorkingTreeSnapshot> {
    const { repository, signal } = input;
    const localPath = repository.localPath;
    const baseSha = await this.deps.git.revParse(localPath, "HEAD");

    signal.throwIfAborted();
    let patch: string;
    try {
      patch = await this.deps.git.diffBinaryHead(localPath);
    } catch (error: unknown) {
      if (error instanceof GitCommandError && error.code === "output_too_large") {
        throw new PipelineStepError(STAGE, "The uncommitted diff is larger than 64 MB.", {
          cause: error,
          code: error.code
        });
      }
      throw error;
    }

    signal.throwIfAborted();
    const untracked = (await this.deps.git.lsUntracked(localPath)).filter(
      (p) => isSafeRelativePath(p) && !EXCLUDED_FIRST_SEGMENTS.has(p.split("/")[0] ?? "")
    );
    if (untracked.length > WORKING_TREE_MAX_UNTRACKED_FILES) {
      throw new PipelineStepError(STAGE, "There are more than 2,000 untracked files. Add build output to .gitignore.");
    }
    if (patch.trim() === "" && untracked.length === 0) {
      throw new PipelineStepError(STAGE, "The working tree has no uncommitted changes anymore.");
    }
    return { baseSha, patch, untracked };
  }

  private async applyOverlay(
    input: WorkspacePrepareInput,
    headDir: string,
    snapshot: WorkingTreeSnapshot
  ): Promise<void> {
    const { signal, repository } = input;
    const localPath = repository.localPath;

    if (snapshot.patch.trim() !== "") {
      signal.throwIfAborted();
      try {
        await this.deps.git.applyPatch(headDir, snapshot.patch);
      } catch (error: unknown) {
        rethrowAbort(error, signal);
        if (error instanceof GitCommandError && error.code === "patch_failed") {
          throw new PipelineStepError(
            STAGE,
            `Could not apply your uncommitted changes to a clean checkout: ${gitErrorSummary(error)}`,
            { cause: error, code: error.code }
          );
        }
        throw error;
      }
    }

    let copied = 0;
    let totalBytes = 0;
    for (const rel of snapshot.untracked) {
      signal.throwIfAborted();
      const src = path.join(localPath, rel);
      const dest = resolveInside(headDir, rel);
      const st = await lstatOrNull(src);
      if (!st) {
        continue; // vanished since the listing
      }
      totalBytes += st.size;
      if (totalBytes > WORKING_TREE_MAX_UNTRACKED_BYTES) {
        throw new PipelineStepError(STAGE, "Untracked files exceed 200 MB.");
      }
      const destDir = await ensureRealDir(headDir, path.posix.dirname(rel));
      if (destDir === null) {
        await input.console.warn(STAGE, `Skipped ${rel} (its folder is not a real folder in the checkout).`);
        continue;
      }
      const target = path.join(destDir, path.posix.basename(rel));
      if (target !== dest) {
        continue; // defence in depth: ensureRealDir never returns another folder for a normalized path
      }
      if (await lstatOrNull(dest)) {
        await input.console.warn(STAGE, `Skipped ${rel} (already exists in the checkout).`);
        continue;
      }
      if (st.isFile()) {
        await fs.copyFile(src, dest, fsConstants.COPYFILE_EXCL);
        await fs.chmod(dest, st.mode & 0o777);
        copied += 1;
      } else if (st.isSymbolicLink()) {
        const linkTarget = await fs.readlink(src);
        if (!path.isAbsolute(linkTarget) && isPathInside(localPath, path.resolve(path.dirname(src), linkTarget))) {
          await fs.symlink(linkTarget, dest);
          copied += 1;
        } else {
          await input.console.warn(STAGE, `Skipped symlink ${rel} (points outside the repository).`);
        }
      }
      // Anything else (directory entries, FIFO, socket) is skipped.
    }

    const trackedChanges = snapshot.patch.split("\n").filter((line) => line.startsWith("diff --git ")).length;
    await input.console.info(
      STAGE,
      `Applied uncommitted changes: ${trackedChanges} tracked file change(s), ${copied} untracked file(s).`
    );
  }

  private async bestEffort(step: string, visualizationId: number, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error: unknown) {
      this.log.warn(
        { event: "workspace.cleanup.step_failed", visualizationId, step, err: error },
        "Workspace step failed; continuing"
      );
    }
  }
}

interface WorkingTreeSnapshot {
  baseSha: string;
  patch: string;
  untracked: string[];
}

/**
 * Short text for a git failure: "timed out", "aborted", or the first two non-empty lines of the (already redacted)
 * stderr joined with " / ", capped at 300 characters, falling back to "exit code N".
 */
export function gitErrorSummary(error: GitCommandError): string {
  if (error.code === "timeout") {
    return "timed out";
  }
  if (error.code === "aborted") {
    return "aborted";
  }
  const lines = error.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, 2);
  const summary = lines.length > 0 ? lines.join(" / ") : `exit code ${String(error.exitCode)}`;
  return summary.slice(0, GIT_SUMMARY_MAX_LENGTH);
}

/** True when 04's normalizeRepoRelativePath accepts the path (no absolute path, NUL, empty path or ".."). */
export function isSafeRelativePath(p: string): boolean {
  try {
    normalizeRepoRelativePath(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks `relDir` below `root` one component at a time: an existing component must be a real directory (not a
 * symlink), a missing one is created with a non-recursive mkdir. Returns the absolute directory, or null when a
 * component is a symlink or not a directory. "." returns `root`.
 */
export async function ensureRealDir(root: string, relDir: string): Promise<string | null> {
  let current = root;
  for (const part of relDir.split("/").filter((segment) => segment !== "" && segment !== ".")) {
    if (part === "..") {
      return null;
    }
    current = path.join(current, part);
    let st = await lstatOrNull(current);
    if (!st) {
      try {
        await fs.mkdir(current);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
      }
      st = await lstatOrNull(current);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      return null;
    }
  }
  return current;
}

/** Like ensureRealDir, but never creates anything (cleanup). */
async function existingRealDir(root: string, relDir: string): Promise<string | null> {
  let current = root;
  for (const part of relDir.split("/").filter((segment) => segment !== "" && segment !== ".")) {
    if (part === "..") {
      return null;
    }
    current = path.join(current, part);
    const st = await lstatOrNull(current);
    if (!st || st.isSymbolicLink() || !st.isDirectory()) {
      return null;
    }
  }
  return current;
}

/** Union of dependencies/devDependencies/peerDependencies/optionalDependencies, name → spec (07 §5.13.6). */
export function compareDependencies(basePkg: unknown, headPkg: unknown): DependencyDrift {
  const base = collectDeps(basePkg);
  const head = collectDeps(headPkg);
  if (base === null && head === null) {
    return { any: false, added: [], removed: [], changed: [] };
  }
  if (base === null || head === null) {
    return { any: true, added: [], removed: [], changed: ["package.json"] };
  }
  const added = [...head.keys()].filter((k) => !base.has(k)).sort();
  const removed = [...base.keys()].filter((k) => !head.has(k)).sort();
  const changed = [...head.keys()].filter((k) => base.has(k) && base.get(k) !== head.get(k)).sort();
  return { any: added.length + removed.length + changed.length > 0, added, removed, changed };
}

const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

function collectDeps(pkg: unknown): Map<string, string> | null {
  if (typeof pkg !== "object" || pkg === null || Array.isArray(pkg)) {
    return null;
  }
  const deps = new Map<string, string>();
  for (const group of DEPENDENCY_GROUPS) {
    const entries: unknown = (pkg as Record<string, unknown>)[group];
    if (typeof entries !== "object" || entries === null || Array.isArray(entries)) {
      continue;
    }
    for (const [name, spec] of Object.entries(entries as Record<string, unknown>)) {
      deps.set(name, typeof spec === "string" ? spec : JSON.stringify(spec));
    }
  }
  return deps;
}

function describeDrift(drift: DependencyDrift): string {
  const list = (names: string[]): string =>
    names.length === 0
      ? "none"
      : names.length > DRIFT_LIST_MAX
        ? `${names.slice(0, DRIFT_LIST_MAX).join(", ")} …and ${names.length - DRIFT_LIST_MAX} more`
        : names.join(", ");
  return (
    `Dependencies differ between base and head (added: ${list(drift.added)}; removed: ${list(drift.removed)}; ` +
    `changed: ${list(drift.changed)}). Both sides use the node_modules installed in your clone, so components ` +
    "that use these packages may render inaccurately."
  );
}

/**
 * Folders (repo-relative) that get a node_modules link on each side: the root, the app root and the Vite root, in
 * that order without duplicates (15 §5.4.6). An app root that is not a safe repo-relative path is ignored.
 */
export function nodeModulesLinkDirs(appRoot: string | null, viteConfigPath: string | null): string[] {
  const dirs = ["."];
  for (const candidate of [appRoot ?? ".", viteRootOf(viteConfigPath)]) {
    const normalized = candidate === "." || candidate === "" ? "." : normalizedRelOrNull(candidate);
    if (normalized !== null && !dirs.includes(normalized)) {
      dirs.push(normalized);
    }
  }
  return dirs;
}

function normalizedRelOrNull(relDir: string): string | null {
  try {
    return normalizeRepoRelativePath(relDir);
  } catch {
    return null;
  }
}

/**
 * `<localPath>/<relDir>/node_modules` when it is a directory in the user's clone (stat follows symlinks). Otherwise
 * React keeps 07's rule (the root and a sub-folder Vite root link the clone's root node_modules) and every other
 * framework skips the folder (null).
 */
async function nodeModulesSource(localPath: string, relDir: string, reactRule: boolean): Promise<string | null> {
  const own = path.join(localPath, relDir, "node_modules");
  if ((await statOrNull(own))?.isDirectory() === true) {
    return own;
  }
  return reactRule ? path.join(localPath, "node_modules") : null;
}

async function statOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.stat(target);
  } catch {
    return null;
  }
}

function viteRootOf(viteConfigPath: string | null): string {
  if (viteConfigPath === null) {
    return ".";
  }
  const dir = path.posix.dirname(viteConfigPath);
  return dir === "" ? "." : dir;
}

/** isValidGitBranchName without the type-guard narrowing (the name is echoed in the error message). */
function isUsableBranchName(name: string): boolean {
  return isValidGitBranchName(name);
}

function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH);
}

function gitCode(error: unknown): string | undefined {
  return error instanceof GitCommandError ? error.code : undefined;
}

/** An aborted git call (or a thrown abort reason) is rethrown unchanged once the run signal has aborted. */
function rethrowAbort(error: unknown, signal: AbortSignal): void {
  if (signal.aborted || (error instanceof GitCommandError && error.code === "aborted")) {
    throw error;
  }
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/** Reads a regular file (never through a symlink) of at most DETECTION_MAX_FILE_BYTES; null otherwise. */
async function readSmallTextFile(target: string): Promise<string | null> {
  const st = await lstatOrNull(target);
  if (!st?.isFile() || st.size > DETECTION_MAX_FILE_BYTES) {
    return null;
  }
  try {
    return await fs.readFile(target, "utf8");
  } catch {
    return null;
  }
}

function parseJsonOrNull(text: string | null): unknown {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}
