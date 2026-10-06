/**
 * Throw-away project folders for sheet 06 detection tests (06 §9) and a fake GitClient for detection and branch
 * listing. Folders live under os.tmpdir() with the "prvision-detect-" prefix (swept by the test preload).
 */
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ProjectDetectionDependencies } from "../../../../backend/src/services/repositories/project-detection-service";
import {
  GitCommandError,
  type GitClient,
  type GitCommitEntry
} from "../../../../backend/src/utilities/services/git-client";

export interface FixtureSpec {
  /** Object → JSON; string → written raw (for invalid JSON). Default: a minimal Vite + React package. */
  packageJson?: Record<string, unknown> | string;
  /** Repo-relative path → content. */
  files?: Record<string, string>;
  /** package → version (writes node_modules/<pkg>/package.json). Default: vite 7, react 19, react-dom 19. */
  installed?: Record<string, string>;
  /** Do not create node_modules at all. */
  noNodeModules?: boolean;
  /** Create the project folder inside this directory instead of a fresh temp dir. */
  parentDir?: string;
}

export const DEFAULT_PACKAGE_JSON = {
  name: "fixture-app",
  private: true,
  dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
  devDependencies: { vite: "^7.0.0" }
};

export const DEFAULT_INSTALLED: Record<string, string> = { vite: "7.0.0", react: "19.0.0", "react-dom": "19.0.0" };

/** Writes the fixture; `root` is a realpath. */
export async function createDetectionFixture(
  spec: FixtureSpec = {}
): Promise<{ root: string; cleanup(): Promise<void> }> {
  const container = await fs.realpath(await fs.mkdtemp(path.join(spec.parentDir ?? os.tmpdir(), "prvision-detect-")));
  const root = path.join(container, "project");
  await fs.mkdir(root);

  const packageJson = spec.packageJson ?? DEFAULT_PACKAGE_JSON;
  await fs.writeFile(
    path.join(root, "package.json"),
    typeof packageJson === "string" ? packageJson : `${JSON.stringify(packageJson, null, 2)}\n`
  );
  for (const [relativePath, content] of Object.entries(spec.files ?? {})) {
    await writeFile(root, relativePath, content);
  }
  if (!spec.noNodeModules) {
    await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
    for (const [name, version] of Object.entries(spec.installed ?? DEFAULT_INSTALLED)) {
      await writeFile(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version }));
    }
  }
  return {
    root,
    cleanup: () => fs.rm(container, { recursive: true, force: true })
  };
}

/** Writes one file below root, creating parent folders. */
export async function writeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = path.join(root, relativePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content);
}

export interface FakeGitState {
  /** What topLevel returns; default: the path it was called with. */
  toplevel: string | null;
  /** topLevel throws GitCommandError("not_a_repository") when false. */
  isRepository: boolean;
  /** revParse(HEAD) throws GitCommandError("unknown_revision") when false. */
  hasCommits: boolean;
  remotes: Record<string, string>;
  /** symbolicRefDefault result per remote name. */
  symbolicDefault: Record<string, string>;
  branches: string[];
  current: string | null;
  dirty: boolean;
  /** Thrown by listBranches / currentBranch / isDirty when set. */
  branchError: GitCommandError | null;
  /**
   * What lsFiles returns (15 §5.4.3 app discovery). Default null: the folder is walked like `git ls-files` with the
   * discovery pathspecs (every angular.json and vite.config.* outside node_modules and .git).
   */
  trackedFiles: string[] | null;
  /**
   * First-parent history per branch, newest first (00 §16 commit listing). revParse("refs/heads/<b>") resolves to the
   * first entry; a branch without an entry resolves to "a"×40 when it is in `branches`, else unknown_revision.
   */
  history: Record<string, GitCommitEntry[]>;
}

export type FakeGit = ProjectDetectionDependencies["git"] &
  Pick<GitClient, "isDirty" | "hasCommit" | "isAncestor" | "logCommits">;

/** A GitClient stand-in over in-memory state (no git binary needed). */
export function fakeGit(overrides: Partial<FakeGitState> = {}): FakeGit {
  const state: FakeGitState = {
    toplevel: null,
    isRepository: true,
    hasCommits: true,
    remotes: {},
    symbolicDefault: {},
    branches: ["main"],
    current: "main",
    dirty: false,
    branchError: null,
    trackedFiles: null,
    history: {},
    ...overrides
  };
  const unknownRevision = (): Promise<never> =>
    Promise.reject(
      new GitCommandError("git rev-parse failed (unknown_revision)", "unknown_revision", "rev-parse", 1, "")
    );
  /** Every [branch, index] a sha appears at in `history`. */
  const positions = (sha: string): Array<[string, number]> =>
    Object.entries(state.history).flatMap(([branch, commits]) => {
      const index = commits.findIndex((commit) => commit.sha === sha);
      return index >= 0 ? [[branch, index] as [string, number]] : [];
    });
  const branchCall = <T>(value: T): Promise<T> =>
    state.branchError ? Promise.reject(state.branchError) : Promise.resolve(value);
  return {
    topLevel: (repoPath: string) =>
      state.isRepository
        ? Promise.resolve(state.toplevel ?? repoPath)
        : Promise.reject(
            new GitCommandError(
              "git rev-parse failed (not_a_repository)",
              "not_a_repository",
              "rev-parse",
              128,
              "fatal: not a git repository"
            )
          ),
    revParse: (_cwd: string, rev: string) => {
      if (!state.hasCommits) {
        return unknownRevision();
      }
      if (rev.startsWith("refs/heads/")) {
        const branch = rev.slice("refs/heads/".length);
        const tip = state.history[branch]?.[0]?.sha;
        if (tip !== undefined) {
          return Promise.resolve(tip);
        }
        return state.branches.includes(branch) ? Promise.resolve("a".repeat(40)) : unknownRevision();
      }
      // A short or full hex SHA resolves to the history commit it prefixes (00 §16 commit search).
      if (/^[0-9a-f]{4,40}$/.test(rev)) {
        const match = Object.values(state.history)
          .flat()
          .find((commit) => commit.sha.startsWith(rev));
        return match ? Promise.resolve(match.sha) : unknownRevision();
      }
      return Promise.resolve("a".repeat(40));
    },
    hasCommit: (_cwd: string, sha: string) => Promise.resolve(positions(sha).length > 0),
    /** Ancestor when both are in one branch's history and `ancestor` is listed at or below `descendant`. */
    isAncestor: (_cwd: string, ancestor: string, descendant: string) =>
      Promise.resolve(
        positions(ancestor).some(([branch, index]) =>
          positions(descendant).some(([other, otherIndex]) => other === branch && otherIndex <= index)
        )
      ),
    logCommits: (
      _cwd: string,
      rev: string,
      options: { limit: number; skip?: number; grep?: string; author?: string }
    ) => {
      const found = positions(rev)[0];
      if (!found) {
        return unknownRevision();
      }
      const [branch, index] = found;
      const contains = (text: string, needle: string | undefined): boolean =>
        needle === undefined || text.toLowerCase().includes(needle.toLowerCase());
      const matching = (state.history[branch] ?? [])
        .slice(index + (options.skip ?? 0))
        .filter((commit) => contains(commit.subject, options.grep) && contains(commit.authorName, options.author));
      return Promise.resolve(matching.slice(0, options.limit));
    },
    remoteUrl: (_cwd: string, remote: string) => Promise.resolve(state.remotes[remote] ?? null),
    symbolicRefDefault: (_cwd: string, remote: string) => Promise.resolve(state.symbolicDefault[remote] ?? null),
    listBranches: () => branchCall([...state.branches]),
    currentBranch: () => branchCall(state.current),
    isDirty: () => branchCall(state.dirty),
    lsFiles: (cwd: string) => (state.trackedFiles ? Promise.resolve([...state.trackedFiles]) : walkAppConfigs(cwd))
  };
}

/** Repo-relative paths of every angular.json / vite.config.* below root (node_modules and .git skipped). */
async function walkAppConfigs(root: string): Promise<string[]> {
  const found: string[] = [];
  const visit = async (relDir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") {
          await visit(rel);
        }
      } else if (entry.name === "angular.json" || entry.name.startsWith("vite.config.")) {
        found.push(rel);
      }
    }
  };
  await visit("");
  return found.sort();
}
