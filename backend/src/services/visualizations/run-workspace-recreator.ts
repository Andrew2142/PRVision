/**
 * Recreates the base and head worktrees of a finished run (16 §11.1, D10, E18), shared by repair (16g) and live mode
 * (16i). Base is the run's `base_sha`; head is its `head_sha`, or for a working-tree run a worktree at `base_sha`
 * with the run's saved snapshot replayed (§11.2). A commit that is gone from the clone is re-fetched for pull request
 * runs into the temporary `refs/prvision/pr-<n>` refs, which are deleted again once the worktrees exist (§19).
 * Nothing is written to the user's working copy; cleanup never throws.
 */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DETECTION_MAX_FILE_BYTES, GIT_FETCH_TIMEOUT_MS, HARNESS_DIR_NAME } from "../../config-consts";
import { isValidGitBranchName } from "../../dtos";
import { RepositoryFramework, VisualizationSourceType } from "../../enums";
import type { RepositoryModel, VisualizationModel } from "../../models";
import {
  PipelineStepError,
  type PipelineContext,
  type PreparedWorkspace,
  type WorktreeSide
} from "../../types/visualization-pipeline";
import {
  GitClient,
  GitCommandError,
  GitHubClient,
  createLogger,
  parseGithubRemoteUrl,
  resolveInside,
  type GitAuthHeader
} from "../../utilities";
import { SettingsStore, type SecretRead } from "../settings/settings-store";
import {
  applyWorkingTreeSnapshot,
  compareDependencies,
  defaultSnapshotsRoot,
  gitErrorSummary,
  linkWorkspaceNodeModules,
  nodeModulesLinkDirs,
  prBaseRef,
  prRef,
  workingTreeSnapshotDir,
  type LinkWorkspaceNodeModulesInput
} from "./pipeline/workspace-prepare-service";

const STAGE = "preparing";
const SHORT_SHA_LENGTH = 7;
const SIDES: readonly WorktreeSide[] = ["base", "head"];

/** §11.1 messages (also asserted by tests and shown on jobs and live sessions). */
export const NO_BASE_COMMIT_MESSAGE = "This run has no base commit to recreate.";
export const NO_HEAD_COMMIT_MESSAGE = "This run has no head commit to recreate.";
export const SNAPSHOT_UNAVAILABLE_MESSAGE =
  "The uncommitted changes of this run are no longer available. Start a new visualization.";
export const missingCommitMessage = (sha: string): string =>
  `Commit ${sha.slice(0, SHORT_SHA_LENGTH)} is no longer in the clone.`;

/** The recreated worktrees and their removal (never throws). */
export interface RecreatedWorkspace {
  workspace: PreparedWorkspace;
  cleanup(): Promise<void>;
}

/** Inputs of recreate(). */
export interface RecreateWorkspaceInput {
  visualization: VisualizationModel;
  repository: RepositoryModel;
  /** `<dataDir>/worktrees/repair-<jobId>` (repair) or the live session's folder; must lie inside `<dataDir>/worktrees`. */
  rootDir: string;
  console: PipelineContext["console"];
  signal: AbortSignal;
}

/** Git calls the recreator makes (04 §9.5 names). */
export type RecreatorGit = Pick<
  GitClient,
  | "topLevel"
  | "hasCommit"
  | "fetch"
  | "worktreeAdd"
  | "worktreeRemove"
  | "worktreePrune"
  | "deleteRef"
  | "remoteUrl"
  | "applyPatch"
>;

/** Collaborators; tests replace any subset. */
export interface RunWorkspaceRecreatorDependencies {
  git: RecreatorGit;
  githubClientFactory: (token: string) => Pick<GitHubClient, "getPullRequest">;
  readGithubToken: () => Promise<SecretRead>;
  linkNodeModules: (input: LinkWorkspaceNodeModulesInput) => Promise<{ viteRoots: Map<WorktreeSide, string> }>;
  /** `<dataDir>/snapshots` (16 §11.2). */
  snapshotsRoot: string;
}

/** What cleanup() needs to undo. */
interface CleanupPlan {
  rootDir: string;
  localPath: string;
  appRoot: string;
  viteConfigPath: string | null;
  /** Set once the PR refs may exist (they are deleted again, best effort). */
  prNumber: number | null;
}

interface FetchAttempt {
  label: string;
  remote: string;
  auth?: GitAuthHeader;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/** package.json of one side (regular file, size-capped), parsed; null when absent or unreadable. */
async function readPackageJson(dir: string): Promise<unknown> {
  const target = path.join(dir, "package.json");
  const st = await lstatOrNull(target);
  if (!st?.isFile() || st.size > DETECTION_MAX_FILE_BYTES) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(target, "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Recreates a run's base and head worktrees (16 §11.1). */
export class RunWorkspaceRecreator {
  private readonly deps: RunWorkspaceRecreatorDependencies;
  private readonly log = createLogger("run-workspace-recreator");

  constructor(deps: Partial<RunWorkspaceRecreatorDependencies> = {}) {
    this.deps = {
      git: deps.git ?? new GitClient(),
      githubClientFactory: deps.githubClientFactory ?? ((token) => GitHubClient.fromToken(token)),
      readGithubToken: deps.readGithubToken ?? (() => new SettingsStore().readGithubToken()),
      linkNodeModules: deps.linkNodeModules ?? linkWorkspaceNodeModules,
      snapshotsRoot: deps.snapshotsRoot ?? defaultSnapshotsRoot()
    };
  }

  /**
   * Creates `<rootDir>/base` and `<rootDir>/head` at the run's commits and links node_modules. On failure every
   * partial result is removed before the error is rethrown.
   *
   * @throws PipelineStepError("preparing", …) for problems the user can act on (§11.1 messages).
   */
  async recreate(input: RecreateWorkspaceInput): Promise<RecreatedWorkspace> {
    const { visualization: v, repository, signal } = input;
    const plan: CleanupPlan = {
      rootDir: input.rootDir,
      localPath: repository.localPath,
      appRoot: repository.appRoot,
      viteConfigPath: repository.viteConfigPath,
      prNumber: null
    };
    const cleanup = (): Promise<void> => this.cleanup(plan, v.id);

    // 1 + 2. Commits (checked before anything is written)
    const baseSha = v.baseSha ?? "";
    if (baseSha === "") {
      throw new PipelineStepError(STAGE, NO_BASE_COMMIT_MESSAGE);
    }
    const workingTree = v.sourceType === VisualizationSourceType.WORKING_TREE;
    let snapshotDir: string | null = null;
    let headCommit: string;
    if (workingTree) {
      if (!v.workingTreeSnapshot) {
        throw new PipelineStepError(STAGE, SNAPSHOT_UNAVAILABLE_MESSAGE, { code: "SNAPSHOT_MISSING" });
      }
      snapshotDir = workingTreeSnapshotDir(this.deps.snapshotsRoot, v.id);
      if (!(await lstatOrNull(snapshotDir))?.isDirectory()) {
        throw new PipelineStepError(STAGE, SNAPSHOT_UNAVAILABLE_MESSAGE, { code: "SNAPSHOT_MISSING" });
      }
      headCommit = baseSha;
    } else {
      const headSha = v.headSha ?? "";
      if (headSha === "") {
        throw new PipelineStepError(STAGE, NO_HEAD_COMMIT_MESSAGE);
      }
      headCommit = headSha;
    }

    const baseDir = resolveInside(input.rootDir, "base");
    const headDir = resolveInside(input.rootDir, "head");
    try {
      // Leftovers of a crashed attempt, then the repository sanity checks of 07
      if (await lstatOrNull(input.rootDir)) {
        await cleanup();
      }
      await fs.mkdir(input.rootDir, { recursive: true });
      signal.throwIfAborted();
      await this.assertRepository(repository.localPath);
      await this.bestEffort("worktree_prune", v.id, () => this.deps.git.worktreePrune(repository.localPath));

      // 3. Commits missing from the clone (PR runs: re-fetch)
      signal.throwIfAborted();
      await this.ensureCommits(v, repository, [baseSha, headCommit], plan, input.console, signal);

      // 4. Worktrees; the temporary PR refs go as soon as both exist
      for (const [dir, sha] of [
        [baseDir, baseSha],
        [headDir, headCommit]
      ] as const) {
        signal.throwIfAborted();
        try {
          await this.deps.git.worktreeAdd(repository.localPath, dir, sha);
        } catch (error: unknown) {
          if (error instanceof GitCommandError) {
            throw new PipelineStepError(STAGE, `Could not create a git worktree: ${gitErrorSummary(error)}`, {
              cause: error,
              code: error.code
            });
          }
          throw error;
        }
      }
      await this.deletePrRefs(plan, v.id);

      // 2 (working tree). The saved uncommitted changes on top of base_sha
      if (snapshotDir !== null) {
        await applyWorkingTreeSnapshot(headDir, snapshotDir, signal, { git: this.deps.git, console: input.console });
      }

      // 4. node_modules links (a symlinked app or Vite root is refused, as in 07)
      signal.throwIfAborted();
      const { viteRoots } = await this.deps.linkNodeModules({
        localPath: repository.localPath,
        sides: SIDES.map((side) => ({ side, dir: side === "base" ? baseDir : headDir })),
        framework: repository.framework,
        appRoot: repository.appRoot,
        viteConfigPath: repository.viteConfigPath,
        console: input.console,
        signal
      });
      if (repository.framework === RepositoryFramework.REACT_VITE) {
        await this.removeCommittedHarnessDirs(viteRoots, { base: baseDir, head: headDir }, input.console);
      }
      const drift = compareDependencies(await readPackageJson(baseDir), await readPackageJson(headDir));

      this.log.info(
        { event: "run_workspace.recreated", visualizationId: v.id, sourceType: v.sourceType },
        "Run workspace recreated"
      );
      return {
        workspace: {
          visualizationId: v.id,
          repositoryPath: repository.localPath,
          baseDir,
          headDir,
          baseSha,
          headSha: workingTree ? null : headCommit,
          sourceType: v.sourceType,
          dependencyDrift: drift.any
        },
        cleanup
      };
    } catch (error: unknown) {
      await cleanup();
      throw error;
    }
  }

  // ----- steps -----

  private async assertRepository(localPath: string): Promise<void> {
    try {
      await fs.stat(localPath);
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, `The repository folder ${localPath} no longer exists.`, { cause: error });
    }
    try {
      await this.deps.git.topLevel(localPath);
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, `${localPath} is no longer a git repository.`, { cause: error });
    }
  }

  /**
   * §11.1 step 3: every commit must be in the clone. Pull request runs fetch `pull/<n>/head` (and the PR base branch
   * when GitHub names it) into the temporary refs first; anything still missing is an error.
   */
  private async ensureCommits(
    v: VisualizationModel,
    repository: RepositoryModel,
    shas: readonly string[],
    plan: CleanupPlan,
    console: PipelineContext["console"],
    signal: AbortSignal
  ): Promise<void> {
    const missing = await this.missingCommits(repository.localPath, shas);
    const first = missing[0];
    if (first === undefined) {
      return;
    }
    const prNumber = v.prNumber;
    if (
      v.sourceType !== VisualizationSourceType.GITHUB_PR ||
      prNumber === null ||
      repository.githubOwner === null ||
      repository.githubRepo === null
    ) {
      throw new PipelineStepError(STAGE, missingCommitMessage(first));
    }
    await console.info(
      STAGE,
      `Commit ${first.slice(0, SHORT_SHA_LENGTH)} is not in the clone; fetching pull request #${String(prNumber)} again.`
    );
    plan.prNumber = prNumber;
    await this.fetchPullRequest({
      localPath: repository.localPath,
      owner: repository.githubOwner,
      repo: repository.githubRepo,
      prNumber,
      console,
      signal
    });
    const stillMissing = (await this.missingCommits(repository.localPath, shas))[0];
    if (stillMissing !== undefined) {
      throw new PipelineStepError(STAGE, missingCommitMessage(stillMissing));
    }
  }

  private async missingCommits(localPath: string, shas: readonly string[]): Promise<string[]> {
    const missing: string[] = [];
    for (const sha of new Set(shas)) {
      if (!(await this.deps.git.hasCommit(localPath, sha))) {
        missing.push(sha);
      }
    }
    return missing;
  }

  /**
   * 07's fetch of a pull request (00 §14.7): the user's own access first (a github remote, else public https), then
   * the GitHub token's auth headers. A token is optional here; without one only the user's own access is tried.
   */
  private async fetchPullRequest(input: {
    localPath: string;
    owner: string;
    repo: string;
    prNumber: number;
    console: PipelineContext["console"];
    signal: AbortSignal;
  }): Promise<void> {
    const n = input.prNumber;
    const secret = await this.readTokenOrNull();
    const refspecs = [`+refs/pull/${String(n)}/head:${prRef(n)}`];
    const baseRef = secret === null ? null : await this.pullRequestBaseRef(secret, input.owner, input.repo, n);
    if (baseRef !== null) {
      refspecs.push(`+refs/heads/${baseRef}:${prBaseRef(n)}`);
    }
    const httpsUrl = `https://github.com/${input.owner}/${input.repo}.git`;
    const remoteName = await this.findGithubRemoteName(input.localPath, input.owner, input.repo);
    const attempts: FetchAttempt[] = [
      {
        label: remoteName ? `remote "${remoteName}" (your SSH key or public access)` : "github.com (public access)",
        remote: remoteName ?? httpsUrl
      },
      ...(secret === null
        ? []
        : GitHubClient.gitAuthHeaders(secret).map((auth, index) => ({
            label: index === 0 ? "the GitHub token" : `the GitHub token (alternative auth ${String(index + 1)})`,
            remote: httpsUrl,
            auth
          })))
    ];
    let last: GitCommandError | null = null;
    for (const attempt of attempts) {
      input.signal.throwIfAborted();
      try {
        await this.deps.git.fetch(
          input.localPath,
          { remote: attempt.remote, refspecs, ...(attempt.auth !== undefined ? { auth: attempt.auth } : {}) },
          { signal: input.signal, timeoutMs: GIT_FETCH_TIMEOUT_MS }
        );
        await input.console.info(STAGE, `Fetched pull request #${String(n)} using ${attempt.label}.`);
        return;
      } catch (error: unknown) {
        if (!(error instanceof GitCommandError) || error.code === "aborted") {
          throw error;
        }
        last = error;
        this.log.warn(
          { event: "run_workspace.fetch.attempt_failed", attempt: attempt.label, code: error.code },
          "PR fetch attempt failed"
        );
      }
    }
    throw new PipelineStepError(
      STAGE,
      `Could not fetch pull request #${String(n)} from GitHub (${last ? gitErrorSummary(last) : "unknown error"}). ` +
        "Check your SSH access, or give the GitHub token Contents: Read access to this repository.",
      { code: last?.code, cause: last ?? undefined }
    );
  }

  private async readTokenOrNull(): Promise<string | null> {
    try {
      const secret = await this.deps.readGithubToken();
      return secret.state === "present" ? secret.value : null;
    } catch (error: unknown) {
      this.log.warn({ event: "run_workspace.token_read_failed", err: error }, "GitHub token read failed");
      return null;
    }
  }

  /** The PR's base branch from GitHub (null when GitHub cannot answer or the name is unusable). */
  private async pullRequestBaseRef(token: string, owner: string, repo: string, n: number): Promise<string | null> {
    try {
      const pr = await this.deps.githubClientFactory(token).getPullRequest(owner, repo, n);
      return isValidGitBranchName(pr.baseRef) ? pr.baseRef : null;
    } catch (error: unknown) {
      this.log.warn({ event: "run_workspace.pr_lookup_failed", prNumber: n, err: error }, "PR lookup failed");
      return null;
    }
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
        this.log.warn(
          { event: "run_workspace.remote_lookup_failed", remote: name, err: error },
          "Remote lookup failed"
        );
      }
    }
    return null;
  }

  /** A committed .prvision-harness (dir, file or symlink) would redirect the render engine's writes (07 §5.13). */
  private async removeCommittedHarnessDirs(
    viteRoots: ReadonlyMap<WorktreeSide, string>,
    sideDirs: Record<WorktreeSide, string>,
    console: PipelineContext["console"]
  ): Promise<void> {
    for (const side of SIDES) {
      const dest = path.join(viteRoots.get(side) ?? sideDirs[side], HARNESS_DIR_NAME);
      const existing = await lstatOrNull(dest);
      if (!existing) {
        continue;
      }
      if (existing.isDirectory() && !existing.isSymbolicLink()) {
        await fs.rm(dest, { recursive: true, force: true });
      } else {
        await fs.unlink(dest);
      }
      await console.warn(STAGE, `The repository contains a ${HARNESS_DIR_NAME} entry; it was replaced on ${side}.`);
    }
  }

  private async deletePrRefs(plan: CleanupPlan, visualizationId: number): Promise<void> {
    const n = plan.prNumber;
    if (n === null) {
      return;
    }
    await this.bestEffort("delete_ref", visualizationId, () => this.deps.git.deleteRef(plan.localPath, prRef(n)));
    await this.bestEffort("delete_ref", visualizationId, () => this.deps.git.deleteRef(plan.localPath, prBaseRef(n)));
    plan.prNumber = null;
  }

  /**
   * §11.1 step 5: unlinks the node_modules links, removes both worktrees from the clone's metadata, prunes, deletes
   * leftover PR refs and the root folder. Never throws.
   */
  private async cleanup(plan: CleanupPlan, visualizationId: number): Promise<void> {
    const localPath = plan.localPath;
    const linkRels = nodeModulesLinkDirs(plan.appRoot, plan.viteConfigPath);
    for (const side of SIDES) {
      for (const linkRel of linkRels) {
        await this.bestEffort("unlink_node_modules", visualizationId, async () => {
          const link = path.join(resolveInside(path.join(plan.rootDir, side), linkRel), "node_modules");
          if ((await lstatOrNull(link))?.isSymbolicLink()) {
            await fs.unlink(link);
          }
        });
      }
    }
    if ((await lstatOrNull(localPath))?.isDirectory()) {
      for (const side of SIDES) {
        await this.bestEffort("worktree_remove", visualizationId, () =>
          this.deps.git.worktreeRemove(localPath, path.join(plan.rootDir, side))
        );
      }
      await this.bestEffort("worktree_prune", visualizationId, () => this.deps.git.worktreePrune(localPath));
      await this.deletePrRefs(plan, visualizationId);
    }
    // fs.rm never follows symbolic links, so a node_modules link left behind is removed, not its target.
    await this.bestEffort("remove_root", visualizationId, () => fs.rm(plan.rootDir, { recursive: true, force: true }));
  }

  private async bestEffort(step: string, visualizationId: number, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error: unknown) {
      this.log.warn(
        { event: "run_workspace.cleanup_failed", visualizationId, step, err: error },
        "Run workspace step failed"
      );
    }
  }
}
