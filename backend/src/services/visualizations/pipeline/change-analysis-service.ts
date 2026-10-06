/**
 * ChangeAnalysisService (08): decides which React components a change touches, persists one
 * `visualization_components` row per component and returns a ranked, capped `ChangeAnalysisResult` whose
 * `sourceQueries` object is the only hand-off to sheet 09 (00 §14.7).
 *
 * Everything is static analysis; nothing in the target repo is executed (08 §8).
 */
import fs from "node:fs/promises";
import type { Logger } from "pino";
import type ts from "typescript";
import {
  AFFECTED_PARENT_MAX_DEPTH,
  ANALYSIS_GRAPH_BUDGET_MS,
  ANALYSIS_MAX_CHANGED_FILES,
  ANALYSIS_MAX_FILE_BYTES,
  ANALYSIS_MAX_PARSED_FILES,
  ANALYSIS_SOURCE_ROOT,
  ANALYSIS_TIMEOUT_MS,
  CHANGED_FILES_MAX_ENTRIES,
  CODE_DIFF_MAX_LINES,
  MAX_COMPONENTS,
  MAX_PARENTS_PER_MODULE
} from "../../../config-consts";
import type { DraftCandidate, ExportInfo, FileChange, Seed, Side } from "../../../types/change-analysis";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type PipelineContext,
  type SuccessorEvidence
} from "../../../types/visualization-pipeline";
import {
  DrizzleDb,
  GitClient,
  QueryHandler,
  createLogger,
  getErrorMessage,
  type Transaction
} from "../../../utilities";
import { analysisRowKey, persistAnalysisRows } from "./change-analysis-persistence";
import {
  ChangeSource,
  buildUnifiedDiff,
  classifySourcePath,
  hasGeneratedMarker,
  truncateDiff,
  unavailableDiff,
  type RawChange
} from "./change-source";
import { ComponentDetector } from "./component-detector";
import { AnalysisSourceQueries, createAnalysisState } from "./component-source-queries";
import { ImportGraph } from "./import-graph";
import { ModuleResolver } from "./module-resolver";
import {
  callSiteSwapEvidence,
  contentSimilarityEvidence,
  gitRenameEvidence,
  matchSuccessors,
  nameSimilarityEvidence,
  replacementConsoleLine,
  sourceQueryRows
} from "./successor-matching";

export interface ChangeAnalysisDeps {
  gitClient: GitClient;
  /** Default DrizzleDb.transaction (04 §9.2). */
  runInTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  createQueryHandler(tx?: Transaction): QueryHandler;
  detector: ComponentDetector;
  now(): number;
}

const STAGE = "analyzing";
const CONSOLE_MAX_CHARS = 500;
const REASON_MAX_CHARS = 300;
const NON_SRC_WARNING = /^(tailwind|postcss|vite)\.config\.[cm]?[jt]s$/;
const KIND_ORDER: Record<DraftCandidate["changeKind"], number> = {
  modified: 0,
  added: 1,
  removed: 2,
  affected_parent: 3,
  replaced: 0 // 00 §17: ranked with modified
};

type Console = PipelineContext["console"];

const keyOf = analysisRowKey;

function clip(message: string, max: number): string {
  return message.length <= max ? message : `${message.slice(0, max - 1)}…`;
}

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How a file referenced a component: `<Local>` when it renders it as JSX, else `import Local`. */
function referenceLabel(text: string | null, local: string): string {
  return text !== null && new RegExp(`<${escapeRegExp(local)}[\\s/>]`).test(text) ? `<${local}>` : `import ${local}`;
}

function compareDrafts(a: DraftCandidate, b: DraftCandidate): number {
  const group = KIND_ORDER[a.changeKind] - KIND_ORDER[b.changeKind];
  if (group !== 0) {
    return group;
  }
  if (a.changeKind === "affected_parent" && a.depth !== b.depth) {
    return a.depth - b.depth;
  }
  if (a.diffSize !== b.diffSize) {
    return b.diffSize - a.diffSize;
  }
  const byFile = byString(a.filePath, b.filePath);
  if (byFile !== 0) {
    return byFile;
  }
  if (a.exportName === b.exportName) {
    return 0;
  }
  if (a.exportName === "default") {
    return -1;
  }
  if (b.exportName === "default") {
    return 1;
  }
  return byString(a.exportName, b.exportName);
}

/** Ranks drafts (08 §5.12) and splits them into rendered and skipped with skip reasons. */
export function rankAndCap(
  drafts: readonly DraftCandidate[],
  maxComponents: number = MAX_COMPONENTS
): { ordered: DraftCandidate[]; rendered: Set<string>; skipReasons: Map<string, string> } {
  const ordered = [...drafts].sort(compareDrafts);
  const rendered = new Set<string>();
  const skipReasons = new Map<string, string>();
  ordered.forEach((draft, rank) => {
    const key = keyOf(draft);
    if (draft.forcedSkipReason === null && rendered.size < maxComponents) {
      rendered.add(key);
      return;
    }
    skipReasons.set(
      key,
      draft.forcedSkipReason ??
        `over_limit: ranked ${String(rank + 1)} of ${String(ordered.length)}; PRVision renders at most ${String(maxComponents)} components per visualization`
    );
  });
  return { ordered, rendered, skipReasons };
}

function seedReasonLabel(path: string, names: Set<string> | "*"): string {
  if (names !== "*" && names.size > 0) {
    const list = [...names];
    if (list.every((name) => name.startsWith("use"))) {
      return `hook ${path}`;
    }
    if (list.some((name) => name.endsWith("Context") || name.endsWith("Provider"))) {
      return `context ${path}`;
    }
  }
  return `module ${path}`;
}

function cancelledError(cause?: unknown): PipelineStepError {
  return new PipelineStepError(STAGE, "Cancelled.", {
    code: "ANALYSIS_CANCELLED",
    detail: "ANALYSIS_CANCELLED: change analysis was cancelled",
    cause
  });
}

function timeoutError(cause?: unknown): PipelineStepError {
  return new PipelineStepError(STAGE, "Change analysis took too long and was stopped.", {
    code: "ANALYSIS_TIMEOUT",
    detail: `ANALYSIS_TIMEOUT: analysis exceeded ${String(ANALYSIS_TIMEOUT_MS)} ms`,
    cause
  });
}

function persistError(message: string, cause?: unknown): PipelineStepError {
  return new PipelineStepError(STAGE, "Could not save the list of components.", {
    code: "ANALYSIS_PERSIST_FAILED",
    detail: `ANALYSIS_PERSIST_FAILED: ${message}`,
    cause
  });
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/** Per-call working state (the service itself is stateless). */
interface RunState {
  ctx: PipelineContext;
  signal: AbortSignal;
  timeout: AbortSignal;
  log: Logger;
  console: Console;
  normalized: Map<string, string | null>;
  /** Repo-relative source folder: "src", or "<appRoot>/src" for an app in a sub-folder. */
  sourceRoot: string;
}

/** Change analysis step of the pipeline (08). Throws only PipelineStepError (stage "analyzing"). */
export class ChangeAnalysisService {
  private readonly deps: ChangeAnalysisDeps;

  constructor(deps: Partial<ChangeAnalysisDeps> = {}) {
    this.deps = {
      gitClient: deps.gitClient ?? new GitClient(),
      runInTransaction: deps.runInTransaction ?? ((fn) => DrizzleDb.transaction(fn)),
      createQueryHandler: deps.createQueryHandler ?? ((tx) => new QueryHandler(tx)),
      detector: deps.detector ?? new ComponentDetector(),
      now: deps.now ?? Date.now
    };
  }

  /**
   * Steps 1–10 of 08 §5.3. Stateless between calls.
   *
   * @throws PipelineStepError (stage "analyzing") with an ANALYSIS_* code for every fatal outcome.
   */
  async analyze(ctx: PipelineContext): Promise<ChangeAnalysisResult> {
    const log = createLogger("change-analysis", { visualizationId: ctx.visualizationId });
    const timeout = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
    const run: RunState = {
      ctx,
      signal: AbortSignal.any([ctx.signal, timeout]),
      timeout,
      log,
      console: ctx.console,
      normalized: new Map(),
      sourceRoot:
        ctx.repository.appRoot === "." ? ANALYSIS_SOURCE_ROOT : `${ctx.repository.appRoot}/${ANALYSIS_SOURCE_ROOT}`
    };
    try {
      return await this.run(run);
    } catch (error: unknown) {
      if (error instanceof PipelineStepError) {
        if (error.code === "ANALYSIS_CANCELLED" && !ctx.signal.aborted && timeout.aborted) {
          throw timeoutError(error);
        }
        throw error;
      }
      if (ctx.signal.aborted) {
        throw cancelledError(error);
      }
      if (timeout.aborted) {
        throw timeoutError(error);
      }
      log.error({ event: "change_analysis.unexpected", err: error }, "Change analysis failed unexpectedly");
      throw new PipelineStepError(STAGE, "Change analysis failed unexpectedly.", {
        code: "ANALYSIS_UNEXPECTED",
        detail: `ANALYSIS_UNEXPECTED: ${getErrorMessage(error)}`,
        cause: error
      });
    }
  }

  private async checkpoint(run: RunState): Promise<void> {
    if (run.ctx.signal.aborted || (await run.ctx.isCancelled())) {
      throw cancelledError();
    }
    if (run.timeout.aborted) {
      throw timeoutError();
    }
  }

  private async info(run: RunState, message: string): Promise<void> {
    await run.console.info(STAGE, clip(message, CONSOLE_MAX_CHARS));
  }

  private async warn(run: RunState, message: string): Promise<void> {
    await run.console.warn(STAGE, clip(message, CONSOLE_MAX_CHARS));
  }

  private async run(run: RunState): Promise<ChangeAnalysisResult> {
    const { ctx, log } = run;
    const { workspace, repository } = ctx;
    const started = this.deps.now();

    // 0. guard
    if (!(await isDirectory(workspace.baseDir)) || !(await isDirectory(workspace.headDir))) {
      throw new PipelineStepError(STAGE, "The prepared workspace is missing. Start the visualization again.", {
        code: "ANALYSIS_WORKTREE_MISSING",
        detail: "ANALYSIS_WORKTREE_MISSING: base or head worktree directory does not exist"
      });
    }
    await this.info(
      run,
      `Looking for changed files between ${short(workspace.baseSha)} and ${workspace.headSha === null ? "working tree" : short(workspace.headSha)}`
    );

    // 1. changed files
    const source = new ChangeSource(this.deps.gitClient, workspace, run.signal, run.sourceRoot);
    const rawChanges = await source.listChanges();
    let changedFiles: ChangeAnalysisResult["changedFiles"] = rawChanges.map((change) =>
      change.previousPath === undefined
        ? { path: change.path, status: change.status }
        : { path: change.path, status: change.status, previousPath: change.previousPath }
    );
    if (changedFiles.length > CHANGED_FILES_MAX_ENTRIES) {
      log.warn(
        { event: "change_analysis.changed_files.capped", total: changedFiles.length, cap: CHANGED_FILES_MAX_ENTRIES },
        "changedFiles capped"
      );
      changedFiles = changedFiles.slice(0, CHANGED_FILES_MAX_ENTRIES);
    }
    log.info(
      { event: "change_analysis.step.completed", step: "changed_files", count: rawChanges.length },
      "Changed files listed"
    );
    await this.checkpoint(run);

    // 2. classification
    let analysable = rawChanges.filter(
      (change) => classifySourcePath(change.path, { sourceRoot: run.sourceRoot }).analysable
    );
    for (const change of rawChanges) {
      if (NON_SRC_WARNING.test(change.path) || change.path === "index.html" || change.path === "package.json") {
        await this.warn(
          run,
          `${change.path} changed. PRVision does not analyse it; components may look different for reasons not shown here.`
        );
      }
    }
    await this.info(
      run,
      `${String(rawChanges.length)} changed files, ${String(analysable.length)} of them React/TS/CSS sources under src/`
    );
    if (analysable.length > ANALYSIS_MAX_CHANGED_FILES) {
      analysable = analysable.slice(0, ANALYSIS_MAX_CHANGED_FILES);
      await this.warn(run, `Only the first ${String(ANALYSIS_MAX_CHANGED_FILES)} changed source files were analysed.`);
    }

    // 3. contents and diffs
    const changes = await this.loadChanges(run, source, analysable);

    // 4–5. direct candidates and seeds
    const drafts = new Map<string, DraftCandidate>();
    const seeds: Seed[] = [];
    for (const change of changes.values()) {
      if (change.language === "style") {
        if ((change.status === "M" || change.status === "R") && change.headPath !== null) {
          seeds.push({
            path: change.headPath,
            names: "*",
            reasonLabel: `stylesheet ${change.headPath}`,
            global: repository.globalStylePaths.includes(`/${change.headPath}`),
            changedLines: change.changedLines
          });
        }
        continue;
      }
      if (change.tooLarge) {
        continue;
      }
      await this.classifyScriptChange(run, change, drafts, seeds);
    }
    const direct = [...drafts.values()];
    await this.info(
      run,
      `Found ${String(direct.length)} directly changed components (${String(direct.filter((d) => d.changeKind === "modified").length)} modified, ${String(direct.filter((d) => d.changeKind === "added").length)} added, ${String(direct.filter((d) => d.changeKind === "removed").length)} removed).`
    );
    log.info(
      { event: "change_analysis.step.completed", step: "direct", drafts: direct.length, seeds: seeds.length },
      "Direct changes classified"
    );
    await this.checkpoint(run);

    // 6–7. head resolver and graph
    let headResolver: ModuleResolver | null = null;
    let headGraph: ImportGraph | null = null;
    if (drafts.size > 0 || seeds.length > 0) {
      const resolverWarnings: string[] = [];
      headResolver = await ModuleResolver.create({
        side: "head",
        rootDir: workspace.headDir,
        tsconfigPath: repository.tsconfigPath,
        viteConfigPath: repository.viteConfigPath,
        sourceRoot: run.sourceRoot,
        warn: (message) => resolverWarnings.push(message),
        debug: (message) => {
          log.debug({ event: "change_analysis.resolver.debug", detail: message }, "Resolver detail");
        }
      });
      for (const message of resolverWarnings) {
        await this.warn(run, message);
      }
      headGraph = await ImportGraph.build({
        side: "head",
        rootDir: workspace.headDir,
        sourceRoot: run.sourceRoot,
        resolver: headResolver,
        detector: this.deps.detector,
        priorityPaths: [...changes.values()].flatMap((change) => (change.headPath === null ? [] : [change.headPath])),
        maxFiles: ANALYSIS_MAX_PARSED_FILES,
        budgetMs: ANALYSIS_GRAPH_BUDGET_MS,
        signal: run.signal,
        now: () => this.deps.now(),
        log
      });
      const stats = headGraph.stats;
      const seconds = (stats.durationMs / 1000).toFixed(1);
      await this.info(
        run,
        `Import graph: ${String(stats.files)} modules, ${String(stats.edges)} imports (${seconds} s).`
      );
      if (headGraph.truncated) {
        await this.warn(
          run,
          `src/ has ${String(headGraph.totalFiles)} files; the import graph covers the ${String(ANALYSIS_MAX_PARSED_FILES)} closest to the change, so some parent components may be missing.`
        );
      }
      if (headGraph.budgetExceeded) {
        await this.warn(run, `Import graph stopped after ${seconds} s; some parent components may be missing.`);
      }
      log.info({ event: "change_analysis.step.completed", step: "graph", ...stats }, "Import graph built");
    }
    await this.checkpoint(run);

    // 8. propagation
    if (headGraph !== null) {
      await this.propagate(run, headGraph, seeds, changes, drafts);
    }

    // 8b. successor matching (00 §17): removed + added pairs become one `replaced` draft
    await this.matchReplacements(run, source, changes, rawChanges, drafts, headResolver);
    await this.checkpoint(run);

    // 9. rank and cap
    const limit = run.ctx.componentLimit ?? MAX_COMPONENTS;
    const { ordered, rendered, skipReasons } = rankAndCap([...drafts.values()], limit);
    const skippedCount = ordered.length - rendered.size;
    if (skippedCount > 0) {
      await this.warn(run, `${String(skippedCount)} components were skipped (limit ${String(limit)}).`);
    }
    if (ordered.length === 0) {
      await this.info(run, "No React components are affected by this change.");
    }
    await this.checkpoint(run);

    // 10. persist
    const ids = await this.persist(ctx.visualizationId, ordered, rendered, skipReasons);
    await this.info(run, `Selected ${String(rendered.size)} components to render.`);

    const candidates: ComponentCandidate[] = [];
    const skipped: ChangeAnalysisResult["skipped"] = [];
    ordered.forEach((draft, rank) => {
      const key = keyOf(draft);
      const base = {
        filePath: draft.filePath,
        exportName: draft.exportName,
        displayName: draft.displayName,
        changeKind: draft.changeKind,
        rank,
        codeDiff: draft.codeDiff,
        reason: draft.reason,
        ...(draft.predecessor ? { predecessor: draft.predecessor } : {})
      };
      if (rendered.has(key)) {
        const componentId = ids.get(key);
        if (componentId === undefined) {
          throw persistError(`no id returned for ${draft.filePath}#${draft.exportName}`);
        }
        candidates.push({ componentId, ...base });
      } else {
        skipped.push({ ...base, skipReason: skipReasons.get(key) ?? "over_limit" });
      }
    });
    log.info(
      {
        event: "change_analysis.completed",
        candidates: candidates.length,
        skipped: skipped.length,
        changedFiles: changedFiles.length,
        durationMs: this.deps.now() - started
      },
      "Change analysis completed"
    );
    const state = createAnalysisState({
      workspace,
      repository,
      changes,
      changedFiles,
      rows: sourceQueryRows(ordered),
      detector: this.deps.detector,
      headResolver,
      headGraph,
      log,
      sourceRoot: run.sourceRoot,
      now: () => this.deps.now()
    });
    return { candidates, skipped, changedFiles, sourceQueries: new AnalysisSourceQueries(state) };
  }

  /** Step 3 (08 §5.6): reads both sides, applies the generated check and builds truncated diffs. */
  private async loadChanges(
    run: RunState,
    source: ChangeSource,
    analysable: readonly RawChange[]
  ): Promise<Map<string, FileChange>> {
    const changes = new Map<string, FileChange>();
    for (const change of analysable) {
      const basePath = change.status === "A" ? null : (change.previousPath ?? change.path);
      const headPath = change.status === "D" ? null : change.path;
      const [base, head] = await Promise.all([
        basePath === null ? null : source.readText("base", basePath),
        headPath === null ? null : source.readText("head", headPath)
      ]);
      const tooLarge = base?.tooLarge === true || head?.tooLarge === true;
      const binary = base?.binary === true || head?.binary === true;
      const unsafe = base?.unsafe === true || head?.unsafe === true;
      if (tooLarge) {
        await this.warn(run, `Skipped ${change.path}: larger than ${String(ANALYSIS_MAX_FILE_BYTES / 1024)} KB.`);
      } else if (binary) {
        await this.warn(run, `Skipped ${change.path}: binary file.`);
      } else if (unsafe) {
        run.log.warn({ event: "change_analysis.file.refused", path: change.path }, "Symlink or path escape refused");
      }
      const baseText = base?.text ?? null;
      const headText = head?.text ?? null;
      if (
        (headText !== null && hasGeneratedMarker(headText)) ||
        (headText === null && baseText !== null && hasGeneratedMarker(baseText))
      ) {
        run.log.debug({ event: "change_analysis.file.generated", path: change.path }, "Generated file skipped");
        continue;
      }
      const unavailable = tooLarge || binary || unsafe;
      let codeDiff: string;
      let changedLines = 0;
      if (unavailable) {
        codeDiff = unavailableDiff(basePath, headPath);
      } else {
        const built = buildUnifiedDiff({ oldPath: basePath, newPath: headPath, oldText: baseText, newText: headText });
        codeDiff = truncateDiff(built.diff, CODE_DIFF_MAX_LINES);
        changedLines = built.changedLines;
      }
      const classification = classifySourcePath(change.path, { sourceRoot: run.sourceRoot });
      changes.set(change.path, {
        status: change.status,
        path: change.path,
        previousPath: change.previousPath ?? null,
        basePath,
        headPath,
        language: classification.language ?? "script",
        baseText: unavailable ? null : baseText,
        headText: unavailable ? null : headText,
        codeDiff,
        changedLines,
        tooLarge: unavailable
      });
    }
    return changes;
  }

  /** True when the export's closure differs between sides (raw first, then normalized; memoized). */
  private closureChanged(run: RunState, baseSF: ts.SourceFile, headSF: ts.SourceFile, exportName: string): boolean {
    const detector = this.deps.detector;
    const baseRaw = detector.closureText(baseSF, exportName);
    const headRaw = detector.closureText(headSF, exportName);
    if (baseRaw === headRaw) {
      return false;
    }
    const normalize = (side: Side, sf: ts.SourceFile, raw: string | null): string | null => {
      const key = `${side}\0${sf.fileName}\0${exportName}`;
      if (run.normalized.has(key)) {
        return run.normalized.get(key) ?? null;
      }
      const value = raw === null ? null : detector.normalizeText(raw, sf.fileName);
      run.normalized.set(key, value);
      return value;
    };
    return normalize("base", baseSF, baseRaw) !== normalize("head", headSF, headRaw);
  }

  /** Steps 4–5 for one changed script file (08 §5.8.3). */
  private async classifyScriptChange(
    run: RunState,
    change: FileChange,
    drafts: Map<string, DraftCandidate>,
    seeds: Seed[]
  ): Promise<void> {
    const detector = this.deps.detector;
    const baseSF =
      change.basePath !== null && change.baseText !== null ? detector.parse(change.basePath, change.baseText) : null;
    const headSF =
      change.headPath !== null && change.headText !== null ? detector.parse(change.headPath, change.headText) : null;
    if (headSF !== null && detector.summarize(headSF, this.meta(change, "head")).syntaxErrors > 0) {
      await this.warn(run, `${change.path} has syntax errors on the head side; its components may fail to render.`);
    }
    const baseExports = new Map<string, ExportInfo>(
      baseSF === null ? [] : detector.summarize(baseSF, this.meta(change, "base")).exports.map((e) => [e.exportName, e])
    );
    const headExports = new Map<string, ExportInfo>(
      headSF === null ? [] : detector.summarize(headSF, this.meta(change, "head")).exports.map((e) => [e.exportName, e])
    );
    const changedNames = new Set<string>();
    const names = [...new Set([...baseExports.keys(), ...headExports.keys()])].sort(byString);
    for (const name of names) {
      const b = baseExports.get(name);
      const h = headExports.get(name);
      if (h?.typeOnly === true || b?.typeOnly === true) {
        continue;
      }
      if (h?.isComponent === true && change.headPath !== null) {
        if (b?.isComponent === true) {
          if (baseSF !== null && headSF !== null && this.closureChanged(run, baseSF, headSF, name)) {
            this.addDraft(drafts, this.directDraft(change, change.headPath, h, "modified", "Component code changed"));
          }
        } else {
          const reason =
            change.status === "A" ? "New file" : b !== undefined ? "Export became a component" : "New component export";
          this.addDraft(drafts, this.directDraft(change, change.headPath, h, "added", reason));
        }
      } else if (b?.isComponent === true && change.basePath !== null) {
        const reason =
          change.status === "D"
            ? "File deleted"
            : h !== undefined
              ? "Export is no longer a component"
              : "Component export removed";
        this.addDraft(drafts, this.directDraft(change, change.basePath, b, "removed", reason));
      } else if (b !== undefined && h !== undefined && baseSF !== null && headSF !== null) {
        if (this.closureChanged(run, baseSF, headSF, name)) {
          changedNames.add(name);
        }
      } else if (b !== undefined && h === undefined) {
        changedNames.add(name); // removed util: importers will be broken/modified anyway, cheap to include
      }
    }
    if (
      (change.status !== "M" && change.status !== "R") ||
      baseSF === null ||
      headSF === null ||
      change.headPath === null
    ) {
      return;
    }
    const residualChanged =
      detector.residualRaw(baseSF) !== detector.residualRaw(headSF) &&
      detector.residualText(baseSF) !== detector.residualText(headSF);
    const before = detector.reExportMap(baseSF);
    const after = detector.reExportMap(headSF);
    for (const key of new Set([...before.keys(), ...after.keys()])) {
      if (!key.startsWith("*:") && before.get(key) !== after.get(key)) {
        changedNames.add(key);
      }
    }
    const seedNames: Set<string> | "*" = residualChanged ? "*" : changedNames;
    if (seedNames === "*" || seedNames.size > 0) {
      seeds.push({
        path: change.headPath,
        names: seedNames,
        reasonLabel: seedReasonLabel(change.headPath, seedNames),
        global: false,
        changedLines: change.changedLines
      });
    }
  }

  private meta(change: FileChange, side: Side): { path: string; side: Side; role: "source"; sizeBytes: number } {
    const text = side === "base" ? change.baseText : change.headText;
    return {
      path: (side === "base" ? change.basePath : change.headPath) ?? change.path,
      side,
      role: "source",
      sizeBytes: text?.length ?? 0
    };
  }

  private directDraft(
    change: FileChange,
    filePath: string,
    info: ExportInfo,
    changeKind: "modified" | "added" | "removed",
    reason: string
  ): DraftCandidate {
    return {
      filePath,
      exportName: info.exportName,
      displayName: info.displayName,
      changeKind,
      codeDiff: change.codeDiff,
      reason,
      diffSize: change.changedLines,
      depth: 0,
      forcedSkipReason: null
    };
  }

  /** Dedupe by key; precedence modified > added > removed > affected_parent (08 §5.12 step 2). */
  private addDraft(drafts: Map<string, DraftCandidate>, draft: DraftCandidate): boolean {
    const key = keyOf(draft);
    const existing = drafts.get(key);
    if (existing !== undefined && KIND_ORDER[existing.changeKind] <= KIND_ORDER[draft.changeKind]) {
      return false;
    }
    drafts.set(key, draft);
    return true;
  }

  /** Step 8 (08 §5.11): style ownership, affected parents and global stylesheet fallback. */
  private async propagate(
    run: RunState,
    graph: ImportGraph,
    seeds: readonly Seed[],
    changes: ReadonlyMap<string, FileChange>,
    drafts: Map<string, DraftCandidate>
  ): Promise<void> {
    const extraSeeds = new Map<string, number>();
    const directKeys = new Set(drafts.keys());
    const entryFilePath = run.ctx.repository.entryFilePath;
    for (const seed of [...seeds].sort((a, b) => byString(a.path, b.path))) {
      const parents = graph.findAffectedParents(seed, {
        maxDepth: AFFECTED_PARENT_MAX_DEPTH,
        maxParents: MAX_PARENTS_PER_MODULE,
        isAlreadyCovered: (path, exportName) => directKeys.has(keyOf({ filePath: path, exportName }))
      });
      const rendered: string[] = [];
      const seedIsStyle = /\.(css|scss)$/.test(seed.path);
      const styleDiff = changes.get(seed.path)?.codeDiff ?? "";
      for (const parent of parents) {
        const key = keyOf({ filePath: parent.path, exportName: parent.exportInfo.exportName });
        if (parent.directStyleOwner) {
          const existing = drafts.get(key);
          if (existing !== undefined && (existing.changeKind === "modified" || existing.changeKind === "added")) {
            existing.codeDiff = truncateDiff(
              existing.codeDiff === null ? styleDiff : `${existing.codeDiff}\n\n${styleDiff}`,
              CODE_DIFF_MAX_LINES
            );
            existing.diffSize += seed.changedLines;
          } else {
            this.addDraft(drafts, {
              filePath: parent.path,
              exportName: parent.exportInfo.exportName,
              displayName: parent.exportInfo.displayName,
              changeKind: "modified",
              codeDiff: styleDiff,
              reason: `Uses changed stylesheet ${seed.path}`,
              diffSize: seed.changedLines,
              depth: 0,
              forcedSkipReason: null
            });
          }
          rendered.push(parent.exportInfo.displayName);
          continue;
        }
        const reason =
          parent.depth <= 1
            ? `Imports changed ${seed.reasonLabel}`
            : `Imports changed ${seed.reasonLabel} via ${parent.via.join(" → ")}`;
        rendered.push(parent.exportInfo.displayName);
        this.addParent(drafts, extraSeeds, key, {
          filePath: parent.path,
          exportName: parent.exportInfo.exportName,
          displayName: parent.exportInfo.displayName,
          changeKind: "affected_parent",
          // The changed module's diff, so the parent's card still shows what changed.
          codeDiff: changes.get(seed.path)?.codeDiff ?? null,
          reason: clip(reason, REASON_MAX_CHARS),
          diffSize: seed.changedLines,
          depth: parent.depth,
          forcedSkipReason: null
        });
      }
      const importers = graph.importersOf(seed.path);
      if (parents.length === 0 && entryFilePath !== null && (seed.global || (seedIsStyle && importers.length > 0))) {
        for (const representative of graph.componentsFromEntry(entryFilePath, {
          maxDepth: 3,
          limit: MAX_PARENTS_PER_MODULE
        })) {
          const key = keyOf({ filePath: representative.path, exportName: representative.exportInfo.exportName });
          rendered.push(representative.exportInfo.displayName);
          this.addParent(drafts, extraSeeds, key, {
            filePath: representative.path,
            exportName: representative.exportInfo.exportName,
            displayName: representative.exportInfo.displayName,
            changeKind: "affected_parent",
            codeDiff: changes.get(seed.path)?.codeDiff ?? null,
            reason: clip(`Global stylesheet ${seed.path} changed; representative component`, REASON_MAX_CHARS),
            diffSize: seed.changedLines,
            depth: Math.max(1, representative.depth),
            forcedSkipReason: null
          });
        }
      }
      const unique = [...new Set(rendered)];
      await this.info(
        run,
        unique.length > 0
          ? `${seed.reasonLabel} changed: also rendering ${unique.join(", ")}.`
          : `${seed.reasonLabel} changed but no exported component imports it.`
      );
    }
    for (const [key, extra] of extraSeeds) {
      const draft = drafts.get(key);
      if (draft?.changeKind === "affected_parent" && extra > 0) {
        draft.reason = `${draft.reason} (+${String(extra)} more changed modules)`;
      }
    }
  }

  private addParent(
    drafts: Map<string, DraftCandidate>,
    extraSeeds: Map<string, number>,
    key: string,
    draft: DraftCandidate
  ): void {
    const existing = drafts.get(key);
    if (existing === undefined) {
      drafts.set(key, draft);
      return;
    }
    if (existing.changeKind === "affected_parent") {
      extraSeeds.set(key, (extraSeeds.get(key) ?? 0) + 1); // first reason wins
    }
  }

  /**
   * Step 8b (00 §17): scores every removed × added pair with React evidence — call sites that imported R on base and
   * import A instead on head, git renames, similar names in one feature folder, similar JSX — and lets the shared
   * core pair them. The `replaced` draft's code diff is R's base file against A's head file.
   */
  private async matchReplacements(
    run: RunState,
    source: ChangeSource,
    changes: ReadonlyMap<string, FileChange>,
    rawChanges: readonly RawChange[],
    drafts: Map<string, DraftCandidate>,
    headResolver: ModuleResolver | null
  ): Promise<void> {
    const kinds = new Set([...drafts.values()].map((draft) => draft.changeKind));
    if (!kinds.has("removed") || !kinds.has("added")) {
      return;
    }
    const { workspace, repository } = run.ctx;
    const detector = this.deps.detector;
    const resolvers: Partial<Record<Side, ModuleResolver>> = headResolver === null ? {} : { head: headResolver };
    const resolverFor = async (side: Side): Promise<ModuleResolver> => {
      const existing = resolvers[side];
      if (existing !== undefined) {
        return existing;
      }
      const created = await ModuleResolver.create({
        side,
        rootDir: side === "head" ? workspace.headDir : workspace.baseDir,
        tsconfigPath: repository.tsconfigPath,
        viteConfigPath: repository.viteConfigPath,
        sourceRoot: run.sourceRoot,
        warn: (message) => {
          run.log.debug({ event: "change_analysis.successors.resolver", side, detail: message }, "Resolver warning");
        }
      });
      resolvers[side] = created;
      return created;
    };
    const changeAt = (side: Side, filePath: string): FileChange | undefined =>
      [...changes.values()].find((change) => (side === "base" ? change.basePath : change.headPath) === filePath);
    const textAt = (side: Side, filePath: string): string | null => {
      const change = changeAt(side, filePath);
      return (side === "base" ? change?.baseText : change?.headText) ?? null;
    };

    // imported components of a changed file, by `<resolved path>\0<imported name>` → local name
    const references = new Map<string, Map<string, string>>();
    const referencesIn = async (side: Side, change: FileChange): Promise<Map<string, string>> => {
      const filePath = side === "base" ? change.basePath : change.headPath;
      const text = side === "base" ? change.baseText : change.headText;
      const out = new Map<string, string>();
      if (filePath === null || text === null) {
        return out;
      }
      const cacheKey = `${side}\u0000${filePath}`;
      const cached = references.get(cacheKey);
      if (cached !== undefined) {
        return cached;
      }
      const resolver = await resolverFor(side);
      const summary = detector.summarize(detector.parse(filePath, text), this.meta(change, side));
      for (const raw of summary.imports) {
        if (raw.kind !== "import" && raw.kind !== "reexport") {
          continue;
        }
        const resolution = resolver.resolveScript(raw.specifier, filePath);
        if (resolution.kind !== "internal") {
          continue;
        }
        for (const binding of raw.bindings) {
          out.set(`${resolution.path}\u0000${binding.imported}`, binding.local);
        }
      }
      references.set(cacheKey, out);
      return out;
    };
    const sites = [...changes.values()].filter(
      (change) =>
        change.language === "script" &&
        (change.status === "M" || change.status === "R") &&
        change.baseText !== null &&
        change.headText !== null
    );
    const callSiteSwaps = async (removed: DraftCandidate, added: DraftCandidate): Promise<SuccessorEvidence[]> => {
      const out: SuccessorEvidence[] = [];
      const oldKey = `${removed.filePath}\u0000${removed.exportName}`;
      const newKey = `${added.filePath}\u0000${added.exportName}`;
      for (const change of sites) {
        if (change.basePath === removed.filePath || change.headPath === added.filePath) {
          continue;
        }
        const oldLocal = (await referencesIn("base", change)).get(oldKey);
        if (oldLocal === undefined) {
          continue;
        }
        const head = await referencesIn("head", change);
        const newLocal = head.get(newKey);
        if (newLocal === undefined || head.has(oldKey)) {
          continue;
        }
        out.push(
          callSiteSwapEvidence(
            change.headPath ?? change.path,
            referenceLabel(change.baseText, oldLocal),
            referenceLabel(change.headText, newLocal)
          )
        );
      }
      return out;
    };
    const markupCache = new Map<string, string | null>();
    const markupOf = (side: Side, draft: DraftCandidate): string | null => {
      const cacheKey = `${side}\u0000${draft.filePath}\u0000${draft.exportName}`;
      if (markupCache.has(cacheKey)) {
        return markupCache.get(cacheKey) ?? null;
      }
      let markup: string | null = null;
      const text = textAt(side, draft.filePath);
      if (text !== null) {
        const sf = detector.parse(draft.filePath, text);
        const resolved = detector.findExport(sf, draft.exportName);
        const roots = resolved === null ? [] : detector.findRenderRoots(resolved);
        markup =
          roots.length === 0 ? null : roots.map((root) => sf.text.slice(root.getStart(sf), root.getEnd())).join("\n");
      }
      markupCache.set(cacheKey, markup);
      return markup;
    };
    const changedFiles = rawChanges.map((change) =>
      change.previousPath === undefined
        ? { path: change.path, status: change.status }
        : { path: change.path, status: change.status, previousPath: change.previousPath }
    );
    const matches = await matchSuccessors(
      drafts,
      async (removed, added) => {
        const evidence = await callSiteSwaps(removed, added);
        const rename = gitRenameEvidence(removed.filePath, added.filePath, changedFiles, (from, to) =>
          source.renameSimilarity(from, to)
        );
        const name = nameSimilarityEvidence(removed, added);
        const content = contentSimilarityEvidence(markupOf("base", removed), markupOf("head", added), "JSX");
        return [...evidence, ...[rename, name, content].filter((item): item is SuccessorEvidence => item !== null)];
      },
      (removed, added) => {
        const oldText = textAt("base", removed.filePath);
        const newText = textAt("head", added.filePath);
        if (oldText === null || newText === null) {
          return { codeDiff: added.codeDiff ?? removed.codeDiff, diffSize: added.diffSize + removed.diffSize };
        }
        const built = buildUnifiedDiff({ oldPath: removed.filePath, newPath: added.filePath, oldText, newText });
        return { codeDiff: truncateDiff(built.diff, CODE_DIFF_MAX_LINES), diffSize: built.changedLines };
      }
    );
    for (const match of matches) {
      await this.info(run, replacementConsoleLine(match));
    }
    run.log.info(
      { event: "change_analysis.step.completed", step: "successors", pairs: matches.length },
      "Successor matching done"
    );
  }

  /** Step 10 (08 §5.13): one transaction; previous rows deleted; ids mapped by key (shared helper, 15 §5.5.7). */
  private async persist(
    visualizationId: number,
    ordered: readonly DraftCandidate[],
    rendered: ReadonlySet<string>,
    skipReasons: ReadonlyMap<string, string>
  ): Promise<Map<string, number>> {
    return persistAnalysisRows(this.deps, visualizationId, ordered, rendered, skipReasons);
  }
}
