/**
 * Scan worktree (16 §10.3): one detached worktree of the default branch at `<dataDir>/worktrees/scan-<jobId>/head`,
 * the user's node_modules linked in through 07's link step, removed again in `finally`. Nothing is written to the
 * user's working copy; the only write to the clone's git data is the worktree metadata, as for runs.
 */
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { HARNESS_DIR_NAME } from "../../config-consts";
import { RepositoryFramework } from "../../enums";
import { PipelineStepError, type PipelineContext, type PreparedWorkspace } from "../../types/visualization-pipeline";
import { ArtifactStore, GitClient, GitCommandError, createLogger, resolveInside } from "../../utilities";
import {
  gitErrorSummary,
  linkWorkspaceNodeModules,
  nodeModulesLinkDirs,
  type LinkWorkspaceNodeModulesInput
} from "../visualizations/pipeline/workspace-prepare-service";

const STAGE = "preparing";

/** Prefix of scan worktree folders in `<dataDir>/worktrees` (00 §21 item 2). */
export const SCAN_WORKTREE_PREFIX = "scan-";
/** Prefix of repair worktree folders (16g). */
export const REPAIR_WORKTREE_PREFIX = "repair-";

/** The repository fields a scan workspace needs. */
export interface LibraryWorkspaceRepository {
  localPath: string;
  defaultBranch: string;
  framework: RepositoryFramework;
  appRoot: string;
  viteConfigPath: string | null;
}

export interface LibraryWorkspaceDependencies {
  git: Pick<GitClient, "revParse" | "topLevel" | "worktreeAdd" | "worktreeRemove" | "worktreePrune">;
  /** `<dataDir>/worktrees`. */
  worktreesRoot: string;
  linkNodeModules: (input: LinkWorkspaceNodeModulesInput) => Promise<{ viteRoots: Map<"base" | "head", string> }>;
}

/** The prepared scan workspace: 00 §8's PreparedWorkspace with the scan commit on both sides (base = head). */
export interface ScanWorkspace {
  root: string;
  headDir: string;
  workspace: PreparedWorkspace;
}

async function lstatOrNull(target: string): Promise<Stats | null> {
  try {
    return await fs.lstat(target);
  } catch {
    return null;
  }
}

/** Scan worktree (create, link, remove). */
export class LibraryWorkspace {
  private readonly deps: LibraryWorkspaceDependencies;
  private readonly log = createLogger("library-workspace");

  constructor(deps: Partial<LibraryWorkspaceDependencies> = {}) {
    this.deps = {
      git: deps.git ?? new GitClient(),
      worktreesRoot: deps.worktreesRoot ?? new ArtifactStore().worktreesRoot(),
      linkNodeModules: deps.linkNodeModules ?? linkWorkspaceNodeModules
    };
  }

  /** `<dataDir>/worktrees/scan-<jobId>`. */
  scanRoot(jobId: number): string {
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      throw new Error(`Invalid job id ${String(jobId)}`);
    }
    return resolveInside(this.deps.worktreesRoot, `${SCAN_WORKTREE_PREFIX}${String(jobId)}`);
  }

  /**
   * The scan commit: `refs/heads/<defaultBranch>`, else `refs/remotes/origin/<defaultBranch>`.
   *
   * @throws PipelineStepError("preparing", "The default branch <b> was not found in the clone.")
   */
  async resolveScanCommit(localPath: string, defaultBranch: string): Promise<string> {
    for (const ref of [`refs/heads/${defaultBranch}`, `refs/remotes/origin/${defaultBranch}`]) {
      try {
        return await this.deps.git.revParse(localPath, `${ref}^{commit}`);
      } catch (error: unknown) {
        if (!(error instanceof GitCommandError)) {
          throw error;
        }
      }
    }
    throw new PipelineStepError(STAGE, `The default branch ${defaultBranch} was not found in the clone.`);
  }

  /**
   * Creates the worktree at `scanSha` and links node_modules. Leftovers of a crashed attempt are removed first.
   *
   * @throws PipelineStepError("preparing", …) for problems the user can act on.
   */
  async prepare(input: {
    jobId: number;
    repository: LibraryWorkspaceRepository;
    scanSha: string;
    console: PipelineContext["console"];
    signal: AbortSignal;
  }): Promise<ScanWorkspace> {
    const { jobId, repository, signal } = input;
    const root = this.scanRoot(jobId);
    const headDir = resolveInside(root, "head");
    if (await lstatOrNull(root)) {
      await this.cleanup({ jobId, repository });
    }
    await fs.mkdir(root, { recursive: true });

    signal.throwIfAborted();
    try {
      await fs.stat(repository.localPath);
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, `The repository folder ${repository.localPath} no longer exists.`, {
        cause: error
      });
    }
    try {
      await this.deps.git.topLevel(repository.localPath);
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, `${repository.localPath} is no longer a git repository.`, { cause: error });
    }
    await this.bestEffort("worktree_prune", jobId, () => this.deps.git.worktreePrune(repository.localPath));

    signal.throwIfAborted();
    try {
      await this.deps.git.worktreeAdd(repository.localPath, headDir, input.scanSha);
    } catch (error: unknown) {
      if (error instanceof GitCommandError) {
        throw new PipelineStepError(STAGE, `Could not create a git worktree: ${gitErrorSummary(error)}`, {
          cause: error,
          code: error.code
        });
      }
      throw error;
    }

    signal.throwIfAborted();
    const { viteRoots } = await this.deps.linkNodeModules({
      localPath: repository.localPath,
      sides: [{ side: "head", dir: headDir }],
      framework: repository.framework,
      appRoot: repository.appRoot,
      viteConfigPath: repository.viteConfigPath,
      console: input.console,
      signal
    });
    if (repository.framework === RepositoryFramework.REACT_VITE) {
      // A committed .prvision-harness (dir, file or symlink) would redirect the render engine's writes (07 §5.13).
      const dest = path.join(viteRoots.get("head") ?? headDir, HARNESS_DIR_NAME);
      const existing = await lstatOrNull(dest);
      if (existing) {
        if (existing.isDirectory() && !existing.isSymbolicLink()) {
          await fs.rm(dest, { recursive: true, force: true });
        } else {
          await fs.unlink(dest);
        }
        await input.console.warn(STAGE, `The repository contains a ${HARNESS_DIR_NAME} entry; it was replaced.`);
      }
    }

    return {
      root,
      headDir,
      workspace: {
        visualizationId: 0,
        repositoryPath: repository.localPath,
        baseDir: headDir,
        headDir,
        baseSha: input.scanSha,
        headSha: input.scanSha,
        sourceType: "local_branch",
        dependencyDrift: false
      }
    };
  }

  /**
   * Unlinks the node_modules links, removes the worktree from the clone's metadata, prunes and deletes the folder.
   * Never throws: every step is isolated and logged.
   */
  async cleanup(input: {
    jobId: number;
    repository: Pick<LibraryWorkspaceRepository, "localPath" | "appRoot" | "viteConfigPath"> | null;
  }): Promise<void> {
    const { jobId, repository } = input;
    let root: string;
    try {
      root = this.scanRoot(jobId);
    } catch (error: unknown) {
      this.log.warn({ event: "library.workspace.cleanup_failed", jobId, err: error }, "Invalid scan root");
      return;
    }
    const headDir = path.join(root, "head");
    if (repository !== null) {
      for (const linkRel of nodeModulesLinkDirs(repository.appRoot, repository.viteConfigPath)) {
        await this.bestEffort("unlink_node_modules", jobId, async () => {
          const link = path.join(resolveInside(headDir, linkRel), "node_modules");
          if ((await lstatOrNull(link))?.isSymbolicLink()) {
            await fs.unlink(link);
          }
        });
      }
      const localPath = repository.localPath;
      if ((await lstatOrNull(localPath))?.isDirectory()) {
        await this.bestEffort("worktree_remove", jobId, () => this.deps.git.worktreeRemove(localPath, headDir));
        await this.bestEffort("worktree_prune", jobId, () => this.deps.git.worktreePrune(localPath));
      }
    }
    // fs.rm never follows symbolic links, so a node_modules link left behind is removed, not its target.
    await this.bestEffort("remove_root", jobId, () => fs.rm(root, { recursive: true, force: true }));
  }

  private async bestEffort(step: string, jobId: number, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error: unknown) {
      this.log.warn(
        { event: "library.workspace.cleanup_failed", jobId, step, err: error },
        "Scan workspace step failed"
      );
    }
  }
}
