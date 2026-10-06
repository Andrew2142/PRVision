/**
 * The shared real-git sandbox (sheet 14 §5.4.6): isolated from the developer's git config, deterministic authors
 * and dates (stable SHAs within a test), LF line endings, hooks disabled. Synchronous (execFileSync), which test
 * code may use; application code never does.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { makeTempDir } from "./temp-dir";

export type FileMap = Record<string, string>;

export interface TempGitRepo {
  readonly path: string;
  git(...args: string[]): string;
  write(files: FileMap): void;
  remove(paths: string[]): void;
  /** Writes/removes files, stages everything, commits, returns the new HEAD sha. */
  commit(message: string, files?: FileMap, options?: { remove?: string[] }): string;
  /** Creates and checks out a branch (from `from` or HEAD). */
  branch(name: string, from?: string): void;
  checkout(ref: string): void;
  /** Leaves uncommitted changes: modified/added tracked files, untracked files, deletions. */
  dirty(changes: { modify?: FileMap; untracked?: FileMap; remove?: string[]; stage?: boolean }): void;
  sha(ref?: string): string;
  /** Creates a bare repo, adds it as `origin`, pushes all branches. */
  createBareOrigin(): TempGitRepo;
  /** In a bare repo: points refs/pull/<n>/head at sha (simulates GitHub). */
  setPullRef(prNumber: number, sha: string): void;
  /** Snapshot used to prove PRVision never mutates the user's clone. */
  snapshot(): RepoSnapshot;
  cleanup(): void;
}

export interface RepoSnapshot {
  head: string;
  symbolicHead: string | null;
  status: string;
  branches: string;
  stashes: string;
  tags: string;
  nonPrvisionRefs: string;
  worktrees: string;
  indexHash: string;
}

export interface CreateTempGitRepoOptions {
  files?: FileMap;
  defaultBranch?: string; // default "main"
  initialMessage?: string; // default "initial"
  nodeModules?: boolean; // write fake installed packages so sheet 06 detection passes (ignored via .gitignore)
  bare?: boolean;
}

const BASE_TIME = Date.parse("2026-01-01T00:00:00Z");

/** Environment for git in tests: no global/system config, fixed identity and dates, no prompts. */
export function isolatedGitEnv(commitIndex = 0): NodeJS.ProcessEnv {
  const date = new Date(BASE_TIME + commitIndex * 60_000).toISOString();
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "PRVision Test",
    GIT_AUTHOR_EMAIL: "test@prvision.local",
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: "PRVision Test",
    GIT_COMMITTER_EMAIL: "test@prvision.local",
    GIT_COMMITTER_DATE: date,
    GIT_TERMINAL_PROMPT: "0"
  };
}

/** Creates a temp repo (or bare repo) under os.tmpdir(); non-bare repos get an initial commit with .gitignore. */
export function createTempGitRepo(options: CreateTempGitRepoOptions = {}): TempGitRepo {
  const temp = makeTempDir(options.bare ? "bare" : "repo");
  const repoPath = temp.path;
  let commitIndex = 0;

  const git = (...args: string[]): string =>
    execFileSync("git", args, {
      cwd: repoPath,
      env: isolatedGitEnv(commitIndex),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trimEnd();

  const write = (files: FileMap): void => {
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(repoPath, relative);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content.replace(/\r\n/g, "\n"));
    }
  };
  const remove = (paths: string[]): void => {
    for (const relative of paths) {
      fs.rmSync(path.join(repoPath, relative), { recursive: true, force: true });
    }
  };

  const branchName = options.defaultBranch ?? "main";
  git("init", ...(options.bare ? ["--bare"] : []), "-b", branchName);
  git("config", "commit.gpgsign", "false");
  git("config", "core.autocrlf", "false");
  git("config", "core.hooksPath", os.devNull);

  const repo: TempGitRepo = {
    path: repoPath,
    git,
    write,
    remove,
    commit(message, files = {}, commitOptions = {}) {
      write(files);
      remove(commitOptions.remove ?? []);
      git("add", "-A");
      commitIndex += 1;
      git("commit", "--no-verify", "--allow-empty", "-m", message);
      return git("rev-parse", "HEAD");
    },
    branch(name, from) {
      git("checkout", "-b", name, ...(from ? [from] : []));
    },
    checkout(ref) {
      git("checkout", ref);
    },
    dirty({ modify = {}, untracked = {}, remove: removed = [], stage = false }) {
      write(modify);
      write(untracked);
      remove(removed);
      const modified = Object.keys(modify);
      if (stage && modified.length > 0) {
        git("add", "-A", "--", ...modified);
      }
    },
    sha(ref = "HEAD") {
      return git("rev-parse", ref);
    },
    createBareOrigin() {
      const bare = createTempGitRepo({ bare: true, defaultBranch: branchName });
      git("remote", "add", "origin", bare.path);
      git("push", "--all", "origin");
      return bare;
    },
    setPullRef(prNumber, sha) {
      git("update-ref", `refs/pull/${prNumber}/head`, sha);
    },
    snapshot() {
      const safe = (...args: string[]): string => {
        try {
          return git(...args);
        } catch {
          return "";
        }
      };
      const indexPath = path.join(repoPath, ".git", "index");
      return {
        head: safe("rev-parse", "HEAD"),
        symbolicHead: safe("symbolic-ref", "-q", "HEAD") || null,
        status: safe("status", "--porcelain=v1", "--untracked-files=all"),
        branches: safe("for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"),
        stashes: safe("stash", "list"),
        tags: safe("tag", "--list"),
        nonPrvisionRefs: safe("for-each-ref", "--format=%(refname) %(objectname)")
          .split("\n")
          .filter((line) => !line.startsWith("refs/prvision/"))
          .join("\n"),
        worktrees: safe("worktree", "list", "--porcelain"),
        indexHash: fs.existsSync(indexPath) ? safe("hash-object", "--no-filters", indexPath) : ""
      };
    },
    cleanup: temp.cleanup
  };

  if (!options.bare) {
    write({ ".gitignore": "node_modules\ndist\n", ...(options.files ?? {}) });
    if (options.nodeModules) {
      write({
        "node_modules/react/package.json": '{ "name": "react", "version": "19.3.0" }\n',
        "node_modules/react-dom/package.json": '{ "name": "react-dom", "version": "19.3.0" }\n',
        "node_modules/vite/package.json": '{ "name": "vite", "version": "7.3.6" }\n'
      });
    }
    repo.commit(options.initialMessage ?? "initial");
  }
  return repo;
}

/** Creates a temp repo and registers its cleanup on the test context. */
export function withTempGitRepo(t: TestContext, options?: CreateTempGitRepoOptions): TempGitRepo {
  const repo = createTempGitRepo(options);
  t.after(() => {
    repo.cleanup();
  });
  return repo;
}

/** Minimal Vite + React + TS file set that passes project detection (no install). */
export function reactViteFiles(overrides: FileMap = {}): FileMap {
  return {
    "package.json":
      JSON.stringify(
        {
          name: "temp-app",
          private: true,
          type: "module",
          dependencies: { react: "19.3.0", "react-dom": "19.3.0" },
          devDependencies: { vite: "7.3.6", "@vitejs/plugin-react": "5.2.0", typescript: "5.9.3" }
        },
        null,
        2
      ) + "\n",
    "package-lock.json": '{\n  "lockfileVersion": 3\n}\n',
    "vite.config.ts":
      'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\nexport default defineConfig({ plugins: [react()] });\n',
    "tsconfig.json": '{\n  "compilerOptions": { "jsx": "react-jsx", "strict": true }\n}\n',
    "index.html":
      '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>\n',
    "src/main.tsx":
      'import { createRoot } from "react-dom/client";\nimport App from "./App";\nimport "./index.css";\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
    "src/index.css": "body { margin: 0; }\n",
    "src/App.tsx": "export default function App() {\n  return <div>App</div>;\n}\n",
    ...overrides
  };
}

/** Builds a small function component source. */
export function componentSource(name: string, jsx: string, imports = ""): string {
  return `${imports}${imports ? "\n" : ""}export default function ${name}() {\n  return (\n    ${jsx}\n  );\n}\n`;
}
