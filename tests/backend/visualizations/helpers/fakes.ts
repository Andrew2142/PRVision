/**
 * Sheet 07 test fakes (07 §4): a Drizzle database over the shared InMemoryQueryHandler (for the list/loadVisible
 * join), a rolling-back fake transaction, in-memory QueueService statics, a scriptable fake GitClient for
 * WorkspacePrepareService and fake pipeline step factories. Console recording uses the real
 * VisualizationConsoleService writing into the in-memory store (assert on its rows), or sheet 14's ConsoleRecorder.
 */
import fs from "node:fs";
import path from "node:path";
import { getTableColumns, type Column } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "../../../../backend/src/database/schema";
import { Table } from "../../../../backend/src/enums";
import type {
  ChangeAnalysisStage,
  HarnessGenerationStage,
  ImageDiffStage,
  LibraryResolutionResult,
  LibraryResolutionStage,
  PipelineStepFactories,
  RenderComponentInput,
  RenderStage,
  RepairHarnessFn,
  StructuralDiffInput,
  StructuralDiffOutcome,
  StructuralDiffStage,
  SummaryOutcome,
  SummaryStage
} from "../../../../backend/src/services/visualizations/pipeline/stage-registry";
import type { WorkspaceGit } from "../../../../backend/src/services/visualizations/pipeline/workspace-prepare-service";
import type {
  ChangeAnalysisResult,
  ComponentCandidate,
  ComponentRenderResult,
  ComponentSourceQueries,
  HarnessGenerationBatchResult,
  HarnessGenerationResult,
  ImageDiffResult,
  PipelineContext
} from "../../../../backend/src/types/visualization-pipeline";
import type { Database, Transaction } from "../../../../backend/src/utilities/services/drizzle-db";
import { GitCommandError, type GitErrorCode } from "../../../../backend/src/utilities/services/git-client";
import type { InMemoryQueryHandler, Row } from "../../helpers/query-handler-stub";

// ---------------------------------------------------------------------------------------------------------------
// Drizzle database over the in-memory store (SELECT … [INNER JOIN] … WHERE a AND b … ORDER BY … LIMIT … OFFSET)
// ---------------------------------------------------------------------------------------------------------------

type SqlTableName = "visualizations" | "repositories";
const SQL_TABLES: Record<SqlTableName, { table: Table; columns: Record<string, Column> }> = {
  visualizations: { table: Table.VISUALIZATIONS, columns: getTableColumns(schema.visualizations) },
  repositories: { table: Table.REPOSITORIES, columns: getTableColumns(schema.repositories) }
};

/** Every SQL statement the fake database received. */
export interface RecordedQuery {
  text: string;
  params: unknown[];
}

type JoinedRow = Partial<Record<SqlTableName, Row>>;

function columnKey(tableName: SqlTableName, columnName: string): string {
  const entry = Object.entries(SQL_TABLES[tableName].columns).find(([, column]) => column.name === columnName);
  if (!entry) {
    throw new Error(`fake db: unknown column ${tableName}.${columnName}`);
  }
  return entry[0];
}

function readColumn(row: JoinedRow, ref: string): unknown {
  const match = /^"(\w+)"\."(\w+)"$/.exec(ref.trim());
  if (!match) {
    throw new Error(`fake db: unsupported column reference ${ref}`);
  }
  const tableName = match[1] as SqlTableName;
  const tableRow = row[tableName];
  if (!tableRow) {
    throw new Error(`fake db: table ${tableName} not in FROM`);
  }
  return tableRow[columnKey(tableName, match[2] ?? "")];
}

function param(params: unknown[], placeholder: string): unknown {
  return params[Number(placeholder.replace("$", "")) - 1];
}

function evaluateCondition(row: JoinedRow, condition: string, params: unknown[]): boolean {
  const trimmed = condition.trim();
  const equality = /^("\w+"\."\w+") = (\$\d+)$/.exec(trimmed);
  if (equality) {
    return readColumn(row, equality[1] ?? "") === param(params, equality[2] ?? "");
  }
  const inList = /^("\w+"\."\w+") in \(([^)]*)\)$/.exec(trimmed);
  if (inList) {
    const values = (inList[2] ?? "").split(",").map((p) => param(params, p.trim()));
    return values.includes(readColumn(row, inList[1] ?? ""));
  }
  throw new Error(`fake db: unsupported condition ${condition}`);
}

function compareValues(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : a;
  const right = b instanceof Date ? b.getTime() : b;
  if (typeof left === "number" && typeof right === "number") {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

/**
 * A real Drizzle instance whose pg client evaluates the generated SQL against the InMemoryQueryHandler's rows.
 * Supports exactly the shapes sheet 07 issues: one table or visualizations INNER JOIN repositories, a WHERE of
 * `=` / `in (…)` conditions joined by AND, ORDER BY, LIMIT and OFFSET, and `count(*)`.
 */
export function createFakeDb(store: InMemoryQueryHandler): { db: Database; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    query(config: { text: string } | string, params: unknown[] = []): Promise<{ rows: unknown[][] }> {
      const text = typeof config === "string" ? config : config.text;
      queries.push({ text, params });
      return Promise.resolve({ rows: run(text, params) });
    }
  };

  const run = (text: string, params: unknown[]): unknown[][] => {
    const match =
      /^select (.+?) from "(\w+)"(?: inner join "(\w+)" on (.+?))?(?: where (.+?))?(?: order by (.+?))?(?: limit (\$\d+))?(?: offset (\$\d+))?$/.exec(
        text
      );
    if (!match) {
      throw new Error(`fake db: unsupported SQL ${text}`);
    }
    const [, selectList = "", fromTable = "", joinTable, joinOn, where, orderBy, limit, offset] = match;
    const from = fromTable as SqlTableName;
    let rows: JoinedRow[] = store.rows(SQL_TABLES[from].table).map((row) => ({ [from]: row }));
    if (joinTable && joinOn) {
      const joined = joinTable as SqlTableName;
      const others = store.rows(SQL_TABLES[joined].table);
      const [leftRef = "", rightRef = ""] = joinOn.split(" = ");
      rows = rows.flatMap((row) =>
        others
          .map((other) => ({ ...row, [joined]: other }))
          .filter((candidate) => readColumn(candidate, leftRef) === readColumn(candidate, rightRef))
      );
    }
    if (where) {
      const conditions = where.replace(/^\((.*)\)$/, "$1").split(" and ");
      rows = rows.filter((row) => conditions.every((condition) => evaluateCondition(row, condition, params)));
    }
    if (orderBy) {
      const keys = orderBy.split(", ").map((part) => {
        const [ref = "", direction = "asc"] = part.split(" ");
        return { ref, sign: direction === "desc" ? -1 : 1 };
      });
      rows = [...rows].sort((a, b) => {
        for (const key of keys) {
          const result = compareValues(readColumn(a, key.ref), readColumn(b, key.ref));
          if (result !== 0) {
            return result * key.sign;
          }
        }
        return 0;
      });
    }
    const start = offset ? Number(param(params, offset)) : 0;
    const end = limit ? start + Number(param(params, limit)) : undefined;
    if (selectList === "count(*)") {
      return [[String(rows.length)]];
    }
    const refs = selectList.split(", ");
    return rows.slice(start, end).map((row) => refs.map((ref) => readColumn(row, ref)));
  };

  const db = drizzle(client as never, { schema }) as unknown as Database;
  return { db, queries };
}

// ---------------------------------------------------------------------------------------------------------------
// Transaction with rollback over the in-memory store
// ---------------------------------------------------------------------------------------------------------------

/**
 * `DrizzleDb.transaction` stand-in. With installQueryHandlerStub(store) in place, `new QueryHandler(tx)` routes to
 * the store; when `fn` throws, every table is restored to its state before the transaction.
 */
export function fakeTransaction(store: InMemoryQueryHandler): <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T> {
  return async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
    const tables = (store as unknown as { tables: Map<Table, Row[]> }).tables;
    const snapshot = new Map([...tables].map(([table, rows]) => [table, rows.map((row) => ({ ...row }))]));
    try {
      return await fn({} as Transaction);
    } catch (error: unknown) {
      tables.clear();
      for (const [table, rows] of snapshot) {
        tables.set(table, rows);
      }
      throw error;
    }
  };
}

// ---------------------------------------------------------------------------------------------------------------
// QueueService statics
// ---------------------------------------------------------------------------------------------------------------

/** In-memory replacement for the QueueService statics sheet 07 uses (cancel flags, job states, enqueue). */
export class FakeQueueStatics {
  readonly flags = new Set<number>();
  readonly jobStates = new Map<number, string>();
  readonly enqueued: number[] = [];
  readonly calls: string[] = [];
  enqueueError: Error | null = null;
  removeResult: boolean | null = null;
  cancelCheckError: Error | null = null;

  visualizationJobId(id: number): string {
    return `viz-${id}`;
  }

  enqueueVisualization(id: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    this.calls.push(`enqueue:${id}`);
    if (this.enqueueError) {
      return Promise.reject(this.enqueueError);
    }
    const alreadyQueued = this.jobStates.has(id);
    this.enqueued.push(id);
    this.jobStates.set(id, this.jobStates.get(id) ?? "waiting");
    return Promise.resolve({ jobId: this.visualizationJobId(id), alreadyQueued });
  }

  /** Like QueueService.requeueVisualization: a finished job is removed first, then the run is enqueued again. */
  requeueVisualization(id: number): Promise<{ jobId: string; alreadyQueued: boolean }> {
    this.calls.push(`requeue:${id}`);
    const state = this.jobStates.get(id);
    if (state === "completed" || state === "failed") {
      this.jobStates.delete(id);
    }
    return this.enqueueVisualization(id);
  }

  removeQueuedVisualization(id: number): Promise<boolean> {
    this.calls.push(`remove:${id}`);
    if (this.removeResult !== null) {
      return Promise.resolve(this.removeResult);
    }
    const state = this.jobStates.get(id);
    if (state === "waiting" || state === "delayed" || state === "prioritized") {
      this.jobStates.delete(id);
      return Promise.resolve(true);
    }
    return Promise.resolve(false);
  }

  getVisualizationJobState(id: number): Promise<string> {
    this.calls.push(`state:${id}`);
    return Promise.resolve(this.jobStates.get(id) ?? "missing");
  }

  requestCancel(id: number): Promise<void> {
    this.calls.push(`requestCancel:${id}`);
    this.flags.add(id);
    return Promise.resolve();
  }

  isCancelRequested(id: number): Promise<boolean> {
    if (this.cancelCheckError) {
      return Promise.reject(this.cancelCheckError);
    }
    return Promise.resolve(this.flags.has(id));
  }

  clearCancel(id: number): Promise<void> {
    this.calls.push(`clearCancel:${id}`);
    this.flags.delete(id);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fake GitClient (WorkspacePrepareService)
// ---------------------------------------------------------------------------------------------------------------

/** A checkout file: text content, or a symlink. */
export type CheckoutEntry = string | { symlink: string };
export type CheckoutFiles = Record<string, CheckoutEntry>;

/** Writes a checkout (files and symlinks) into `dir`. */
export function writeCheckout(dir: string, files: CheckoutFiles): void {
  for (const [relative, entry] of Object.entries(files)) {
    const full = path.join(dir, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (typeof entry === "string") {
      fs.writeFileSync(full, entry);
    } else {
      fs.symlinkSync(entry.symlink, full);
    }
  }
}

/** Builds a GitCommandError the way 04 does (redacted stderr). */
export function gitError(code: GitErrorCode, stderr = "", subcommand = "git"): GitCommandError {
  return new GitCommandError(`git ${subcommand} failed (${code})`, code, subcommand, 128, stderr);
}

type GitMethod = keyof WorkspaceGit;

/**
 * Scriptable fake of the GitClient methods WorkspacePrepareService uses. Every call is recorded as
 * `{ method, args }`. worktreeAdd creates the directory and writes `checkouts[sha]` into it, so the service's file
 * work (node_modules links, templates, overlay) runs against a real temp directory.
 */
export class FakeGit implements WorkspaceGit {
  readonly calls: Array<{ method: GitMethod; args: unknown[] }> = [];
  readonly checkouts = new Map<string, CheckoutFiles>();
  readonly refs = new Map<string, string>();
  readonly overrides: Partial<Record<GitMethod, (...args: unknown[]) => Promise<unknown>>> = {};
  mergeBases = new Map<string, string>();
  commits = new Set<string>();
  remotes = new Map<string, string>();
  patch = "";
  untracked: string[] = [];

  /** Replaces one method's behaviour. */
  on<K extends GitMethod>(method: K, fn: (...args: Parameters<WorkspaceGit[K]>) => ReturnType<WorkspaceGit[K]>): this {
    this.overrides[method] = fn as unknown as (...args: unknown[]) => Promise<unknown>;
    return this;
  }

  callsOf(method: GitMethod): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  private async invoke<T>(method: GitMethod, args: unknown[], fallback: () => Promise<T> | T): Promise<T> {
    this.calls.push({ method, args });
    const override = this.overrides[method];
    if (override) {
      return (await override(...args)) as T;
    }
    return fallback();
  }

  topLevel(repoPath: string): Promise<string> {
    return this.invoke("topLevel", [repoPath], () => repoPath);
  }

  revParse(cwd: string, rev: string): Promise<string> {
    return this.invoke("revParse", [cwd, rev], () => {
      const sha = this.refs.get(rev);
      if (sha === undefined) {
        throw gitError("unknown_revision", "", "rev-parse");
      }
      return sha;
    });
  }

  hasCommit(cwd: string, sha: string): Promise<boolean> {
    return this.invoke("hasCommit", [cwd, sha], () => this.commits.has(sha));
  }

  mergeBase(cwd: string, a: string, b: string): Promise<string> {
    return this.invoke("mergeBase", [cwd, a, b], () => {
      const base = this.mergeBases.get(`${a}..${b}`);
      if (base === undefined) {
        throw gitError("no_merge_base", "", "merge-base");
      }
      return base;
    });
  }

  fetch(
    cwd: string,
    request: Parameters<WorkspaceGit["fetch"]>[1],
    options?: Parameters<WorkspaceGit["fetch"]>[2]
  ): Promise<void> {
    return this.invoke("fetch", [cwd, request, options], () => undefined);
  }

  worktreeAdd(repoPath: string, dir: string, sha: string): Promise<void> {
    return this.invoke("worktreeAdd", [repoPath, dir, sha], () => {
      fs.mkdirSync(dir, { recursive: true });
      writeCheckout(dir, this.checkouts.get(sha) ?? {});
    });
  }

  worktreeRemove(repoPath: string, dir: string): Promise<void> {
    return this.invoke("worktreeRemove", [repoPath, dir], () => {
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  worktreePrune(repoPath: string): Promise<void> {
    return this.invoke("worktreePrune", [repoPath], () => undefined);
  }

  diffBinaryHead(cwd: string): Promise<string> {
    return this.invoke("diffBinaryHead", [cwd], () => this.patch);
  }

  applyPatch(cwd: string, patch: string): Promise<void> {
    return this.invoke("applyPatch", [cwd, patch], () => undefined);
  }

  lsUntracked(cwd: string): Promise<string[]> {
    return this.invoke("lsUntracked", [cwd], () => [...this.untracked]);
  }

  remoteUrl(cwd: string, remote?: string): Promise<string | null> {
    return this.invoke("remoteUrl", [cwd, remote], () => this.remotes.get(remote ?? "origin") ?? null);
  }

  deleteRef(cwd: string, ref: string): Promise<void> {
    return this.invoke("deleteRef", [cwd, ref], () => undefined);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Fake pipeline steps
// ---------------------------------------------------------------------------------------------------------------

/** A candidate for fake analyses. */
export function candidate(componentId: number, overrides: Partial<ComponentCandidate> = {}): ComponentCandidate {
  return {
    componentId,
    filePath: `src/components/C${componentId}.tsx`,
    exportName: "default",
    displayName: `C${componentId}`,
    changeKind: "modified",
    rank: componentId - 1,
    codeDiff: "@@ -1 +1 @@",
    reason: "Component code changed",
    ...overrides
  };
}

/** A harness for a candidate. */
export function harness(componentId: number): HarnessGenerationResult {
  return {
    componentId,
    harnessSource: 'export default definePrvisionHarness({ states: [{ name: "Default", render: () => null }] });',
    mockedModules: [],
    notes: "",
    states: [{ name: "Default", steps: [] }],
    origin: "written",
    libraryEntryId: null
  };
}

/** An ok render of both sides. */
export function render(componentId: number, ok = true): ComponentRenderResult {
  const side = (s: "base" | "head"): ComponentRenderResult["base"] => ({
    side: s,
    ok,
    imagePath: ok ? `artifacts/1/${componentId}/${s}.png` : null,
    width: ok ? 100 : null,
    height: ok ? 50 : null,
    error: ok ? null : "boom",
    consoleErrors: [],
    durationMs: 1,
    failureKind: ok ? null : "render_error"
  });
  return { componentId, base: side("base"), head: side("head"), states: [] };
}

/** Behaviour of one fake step: return a value, throw, or run custom code (e.g. wait for the abort). */
export type StepBehaviour<T> = T | ((ctx: PipelineContext) => Promise<T>);

/**
 * 16 §8.4 without a library: every analysed candidate needs a new harness (head, or base for removed rows), renders,
 * and nothing pauses or is re-checked. Keeps every pre-16d worker test's meaning.
 */
export function passThroughResolution(analysis: ChangeAnalysisResult): LibraryResolutionResult {
  const candidates = [...analysis.candidates].sort((a, b) => a.rank - b.rank);
  const sideOf = (candidate: ComponentCandidate): "base" | "head" =>
    candidate.changeKind === "removed" ? "base" : "head";
  return {
    plans: new Map(
      candidates.map((candidate) => [
        candidate.componentId,
        [
          {
            side: sideOf(candidate),
            identity: { filePath: candidate.filePath, exportName: candidate.exportName },
            entry: null
          }
        ]
      ])
    ),
    newHarnessCount: candidates.length,
    reusedCount: 0,
    recheckedCount: 0,
    globalStyleTrigger: null,
    pause: false,
    skippedOverLimit: [],
    toWrite: candidates.map((candidate) => ({ candidate, sides: [sideOf(candidate)] })),
    renderCandidates: candidates,
    writeRevisions: new Map()
  };
}

export interface FakeStepOptions {
  analysis?: StepBehaviour<ChangeAnalysisResult>;
  /** 16d: 09's repairHarness; default `{ ok: true, result: previous }`. */
  repair?: RepairHarnessFn;
  /** 16d: library resolution; default passThroughResolution(analysis). */
  resolution?: (analysis: ChangeAnalysisResult, ctx: PipelineContext) => Promise<LibraryResolutionResult>;
  batch?: StepBehaviour<HarnessGenerationBatchResult>;
  renders?: StepBehaviour<ComponentRenderResult[]>;
  diffs?: StepBehaviour<ImageDiffResult[]>;
  structural?: StepBehaviour<StructuralDiffOutcome[]>;
  summary?: StepBehaviour<SummaryOutcome>;
}

/** Every call the fake steps received, in order. */
export interface StepCalls {
  order: string[];
  analyzeCtx: PipelineContext | null;
  harnessFactoryArgs: { ctx: PipelineContext; sourceQueries: ComponentSourceQueries } | null;
  generateAllCandidates: readonly ComponentCandidate[] | null;
  /** 16d: the options generateAll received (sides per row). */
  generateAllOptions: unknown;
  resolveAnalysis: ChangeAnalysisResult | null;
  renderDeps: { repairHarness: RepairHarnessFn } | null;
  renderAllInputs: RenderComponentInput[] | null;
  diffRenders: ComponentRenderResult[] | null;
  compareInput: StructuralDiffInput | null;
  summarizeAnalysis: ChangeAnalysisResult | null;
  harnessInstance: HarnessGenerationStage | null;
}

/** An analysis with the given candidates (and a sourceQueries marker object). */
export function analysisWith(candidates: ComponentCandidate[]): ChangeAnalysisResult {
  const marker: unknown = { marker: "source-queries" };
  return {
    candidates,
    skipped: [],
    changedFiles: candidates.map((c) => ({ path: c.filePath, status: "M" as const })),
    sourceQueries: marker as ComponentSourceQueries,
    globalStyleChanges: []
  };
}

function resolve<T>(behaviour: StepBehaviour<T>, ctx: PipelineContext): Promise<T> {
  return typeof behaviour === "function"
    ? (behaviour as (c: PipelineContext) => Promise<T>)(ctx)
    : Promise.resolve(behaviour);
}

/** Fake PipelineStepFactories recording every call; defaults model a two-component happy path. */
export function fakeSteps(options: FakeStepOptions = {}): { steps: PipelineStepFactories; calls: StepCalls } {
  const defaultCandidates = [candidate(1), candidate(2)];
  const calls: StepCalls = {
    order: [],
    analyzeCtx: null,
    harnessFactoryArgs: null,
    generateAllCandidates: null,
    generateAllOptions: null,
    resolveAnalysis: null,
    renderDeps: null,
    renderAllInputs: null,
    diffRenders: null,
    compareInput: null,
    summarizeAnalysis: null,
    harnessInstance: null
  };
  const analysisStage: ChangeAnalysisStage = {
    analyze: (ctx) => {
      calls.order.push("analyze");
      calls.analyzeCtx = ctx;
      return resolve(options.analysis ?? analysisWith(defaultCandidates), ctx);
    }
  };
  const resolutionStage: LibraryResolutionStage = {
    resolve: (ctx, analysis) => {
      calls.order.push("resolve");
      calls.resolveAnalysis = analysis;
      return options.resolution ? options.resolution(analysis, ctx) : Promise.resolve(passThroughResolution(analysis));
    }
  };
  const steps: PipelineStepFactories = {
    changeAnalysis: () => analysisStage,
    libraryResolution: () => resolutionStage,
    harnessGeneration: (ctx, sourceQueries) => {
      calls.harnessFactoryArgs = { ctx, sourceQueries };
      const instance: HarnessGenerationStage = {
        generateAll: (candidates, generateOptions) => {
          calls.order.push("generateAll");
          calls.generateAllCandidates = candidates;
          calls.generateAllOptions = generateOptions;
          return resolve(
            options.batch ?? {
              results: candidates.map((c) => harness(c.componentId)),
              failures: [],
              usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
              cancelled: false
            },
            ctx
          );
        },
        repairHarness: (componentId, previous, renderError) => {
          calls.order.push(`repair:${componentId}`);
          return options.repair
            ? options.repair(componentId, previous, renderError)
            : Promise.resolve({ ok: true, result: previous });
        }
      };
      calls.harnessInstance = instance;
      return instance;
    },
    render: (deps) => {
      calls.renderDeps = deps;
      const stage: RenderStage = {
        renderAll: (ctx, inputs) => {
          calls.order.push("renderAll");
          calls.renderAllInputs = inputs;
          return resolve(options.renders ?? inputs.map((input) => render(input.candidate.componentId)), ctx);
        }
      };
      return stage;
    },
    imageDiff: () => {
      const stage: ImageDiffStage = {
        diff: (ctx, renders) => {
          calls.order.push("diff");
          calls.diffRenders = renders;
          return resolve(options.diffs ?? [], ctx);
        }
      };
      return stage;
    },
    structuralDiff: () => {
      const stage: StructuralDiffStage = {
        compare: (ctx, input) => {
          calls.order.push("compare");
          calls.compareInput = input;
          return resolve(options.structural ?? [], ctx);
        }
      };
      return stage;
    },
    summary: () => {
      const stage: SummaryStage = {
        summarize: (ctx, analysis) => {
          calls.order.push("summarize");
          calls.summarizeAnalysis = analysis;
          return resolve(
            options.summary ?? { status: "generated", summaryMarkdown: "# ok", usage: null, failureReason: null },
            ctx
          );
        }
      };
      return stage;
    }
  };
  return { steps, calls };
}

/** A step that waits until the run signal aborts, then rejects with the signal's reason (a well-behaved step). */
export function untilAborted<T>(): (ctx: PipelineContext) => Promise<T> {
  return (ctx) =>
    new Promise<T>((_resolve, reject) => {
      const keepAlive = setInterval(() => undefined, 1_000); // keeps the test process alive while waiting
      ctx.signal.addEventListener(
        "abort",
        () => {
          clearInterval(keepAlive);
          reject(ctx.signal.reason as Error);
        },
        { once: true }
      );
    });
}

/** A step that ignores the abort and never settles (kept alive by a ref'd timer for `ms`). */
export function ignoresAbort<T>(ms = 5_000): () => Promise<T> {
  return () =>
    new Promise<T>(() => {
      setTimeout(() => undefined, ms);
    });
}
