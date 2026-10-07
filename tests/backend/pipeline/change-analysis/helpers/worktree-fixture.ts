/**
 * Sheet 08 test helpers (08 §9): base/head worktrees from file maps, a stub GitClient, stub persistence and a
 * PipelineContext with recorded console events. No Postgres, Redis or git needed.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ChangeAnalysisDeps } from "../../../../../backend/src/services/visualizations/pipeline/change-analysis-service";
import type { PipelineContext, PreparedWorkspace } from "../../../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../../../backend/src/utilities/handlers/query-handler";
import type { Transaction } from "../../../../../backend/src/utilities/services/drizzle-db";
import type {
  GitClient,
  GitCommandError,
  GitNameStatusEntry
} from "../../../../../backend/src/utilities/services/git-client";

export type FileMap = Record<string, string>;

/** Writes `base` and `head` file maps to `<tmp>/worktrees/1/{base,head}`. */
export async function makeWorktrees(files: {
  base: FileMap;
  head: FileMap;
}): Promise<{ root: string; baseDir: string; headDir: string; cleanup(): Promise<void> }> {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-ca-")));
  const baseDir = path.join(root, "worktrees", "1", "base");
  const headDir = path.join(root, "worktrees", "1", "head");
  await writeTree(baseDir, files.base);
  await writeTree(headDir, files.head);
  return {
    root,
    baseDir,
    headDir,
    cleanup: () => fs.rm(root, { recursive: true, force: true })
  };
}

export async function writeTree(dir: string, files: FileMap): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(dir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/** Name-status entries (A/M/D, sorted) from two file maps, as git would report them without renames. */
export function diffEntries(base: FileMap, head: FileMap): GitNameStatusEntry[] {
  const out: GitNameStatusEntry[] = [];
  for (const file of new Set([...Object.keys(base), ...Object.keys(head)])) {
    const b = base[file];
    const h = head[file];
    if (b === undefined && h !== undefined) {
      out.push({ status: "A", path: file });
    } else if (b !== undefined && h === undefined) {
      out.push({ status: "D", path: file });
    } else if (b !== h) {
      out.push({ status: "M", path: file });
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

export interface StubGitCall {
  method: "diffNameStatus" | "diffNameStatusNoIndex";
  args: unknown[];
}

/** GitClient whose two diff methods return `entries` (or reject with the error); records every call. */
export function stubGitClient(
  entries: GitNameStatusEntry[] | GitCommandError | Error
): GitClient & { calls: StubGitCall[] } {
  const calls: StubGitCall[] = [];
  const respond = (): Promise<GitNameStatusEntry[]> =>
    entries instanceof Error ? Promise.reject(entries) : Promise.resolve(entries.map((entry) => ({ ...entry })));
  const stub = {
    calls,
    diffNameStatus: (...args: unknown[]) => {
      calls.push({ method: "diffNameStatus", args });
      return respond();
    },
    diffNameStatusNoIndex: (...args: unknown[]) => {
      calls.push({ method: "diffNameStatusNoIndex", args });
      return respond();
    }
  };
  return stub as unknown as GitClient & { calls: StubGitCall[] };
}

export interface StubPersistence {
  runInTransaction: ChangeAnalysisDeps["runInTransaction"];
  createQueryHandler: ChangeAnalysisDeps["createQueryHandler"];
  inserted: Record<string, unknown>[][];
  deleted: unknown[];
  updates: unknown[];
  transactions: number;
  rolledBack: number;
}

/** Records writes; insert echoes rows with ids 100, 101, … in reverse order (ids are mapped by key). */
export function stubPersistence(
  options: { insertStatus?: number; deleteStatus?: number; insertThrows?: boolean } = {}
): StubPersistence {
  const state: StubPersistence = {
    inserted: [],
    deleted: [],
    updates: [],
    transactions: 0,
    rolledBack: 0,
    runInTransaction: async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
      state.transactions++;
      try {
        return await fn({} as Transaction);
      } catch (error: unknown) {
        state.rolledBack++;
        throw error;
      }
    },
    createQueryHandler: () => {
      const handler = {
        delete: (conditions: unknown) => {
          state.deleted.push(conditions);
          return Promise.resolve({ status: options.deleteStatus ?? 404, data: { rowsAffected: 0 } });
        },
        insert: (rows: Record<string, unknown>[]) => {
          if (options.insertThrows === true) {
            return Promise.reject(new Error("insert exploded"));
          }
          state.inserted.push(rows);
          if ((options.insertStatus ?? 200) !== 200) {
            return Promise.resolve({ status: options.insertStatus, error: "Insert failed" });
          }
          const echoed = rows.map((row, index) => ({ ...row, id: 100 + index })).reverse();
          return Promise.resolve({ status: 200, data: echoed });
        },
        update: (values: unknown, conditions: unknown, table: unknown) => {
          state.updates.push({ values, conditions, table });
          return Promise.resolve({ status: 200, data: { rowsAffected: 1 } });
        }
      };
      return handler as unknown as QueryHandler;
    }
  };
  return state;
}

export type TestContext = PipelineContext & {
  consoleEvents: Array<{ level: string; message: string }>;
  cancel(): void;
};

/** PipelineContext for one visualization with recorded console events and a cancel switch. */
export function makeContext(
  workspace: Partial<PreparedWorkspace>,
  repo: Partial<PipelineContext["repository"]> = {}
): TestContext {
  const consoleEvents: Array<{ level: string; message: string }> = [];
  const abort = new AbortController();
  let cancelled = false;
  const record =
    (level: string) =>
    (_stage: string, message: string): Promise<void> => {
      consoleEvents.push({ level, message });
      return Promise.resolve();
    };
  const fullWorkspace: PreparedWorkspace = {
    visualizationId: 1,
    repositoryPath: "/nonexistent/clone",
    baseDir: "/nonexistent/base",
    headDir: "/nonexistent/head",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    sourceType: "local_branch",
    dependencyDrift: false,
    ...workspace
  };
  return {
    visualizationId: fullWorkspace.visualizationId,
    workspace: fullWorkspace,
    repository: {
      id: 1,
      localPath: fullWorkspace.repositoryPath,
      framework: "react_vite",
      appRoot: ".",
      angularProject: null,
      angularBuildConfiguration: null,
      viteConfigPath: null,
      tsconfigPath: null,
      entryFilePath: null,
      globalStylePaths: [],
      ...repo
    },
    ai: {
      kind: "anthropic_api",
      generateStructured: () => Promise.reject(new Error("AI is not used by change analysis"))
    },
    aiSettings: { model: "claude-opus-5-5", harnessEffort: "high", summaryEffort: "medium" },
    console: { info: record("info"), warn: record("warn"), error: record("error") },
    isCancelled: () => Promise.resolve(cancelled),
    signal: abort.signal,
    library: { stateAllowance: 1, buildMode: "grow" }, // 16 §6.12 test default
    consoleEvents,
    cancel: () => {
      cancelled = true;
      abort.abort("cancelled");
    }
  };
}

/** tsconfig with `@/*` → `src/*` used by the 08 §5.16 examples. */
export const ALIAS_TSCONFIG = JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } });
