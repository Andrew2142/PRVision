/**
 * `AngularChangeAnalysisService` (sheet 15 §5.5): the Angular implementation of the change-analysis stage port
 * (`ChangeAnalysisStage`, same contract as 08's `ChangeAnalysisService.analyze`). It finds the Angular components a
 * change touches — changed component classes, changed templates and styles mapped to their owning components, and
 * parents affected through TS imports, DI, template selectors and pipes — persists one row per component through
 * the shared `persistAnalysisRows` helper and returns `AngularSourceQueries` as the hand-off to harness generation.
 *
 * Same budgets, cancellation checkpoints, error codes and persistence semantics as 08. Static analysis only.
 */
import fs from "node:fs/promises";
import type { Logger } from "pino";
import ts from "typescript";
import {
  AFFECTED_PARENT_MAX_DEPTH,
  ANALYSIS_GRAPH_BUDGET_MS,
  ANALYSIS_MAX_CHANGED_FILES,
  ANALYSIS_MAX_FILE_BYTES,
  ANALYSIS_MAX_PARSED_FILES,
  ANALYSIS_TIMEOUT_MS,
  CHANGED_FILES_MAX_ENTRIES,
  CODE_DIFF_MAX_LINES,
  MAX_COMPONENTS,
  MAX_PARENTS_PER_MODULE
} from "../../../../config-consts";
import type { DraftCandidate, FileChange, Side } from "../../../../types/change-analysis";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type PipelineContext,
  type SuccessorEvidence
} from "../../../../types/visualization-pipeline";
import { DrizzleDb, GitClient, QueryHandler, createLogger, getErrorMessage } from "../../../../utilities";
import { rankAndCap } from "../change-analysis-service";
import { analysisRowKey, persistAnalysisRows, type AnalysisPersistenceDeps } from "../change-analysis-persistence";
import {
  ChangeSource,
  buildUnifiedDiff,
  hasGeneratedMarker,
  truncateDiff,
  unavailableDiff,
  type RawChange
} from "../change-source";
import { ComponentDetector } from "../component-detector";
import { ImportGraph, edgeUsesNames, localBindingsFor, namesExposedBy } from "../import-graph";
import { ModuleResolver } from "../module-resolver";
import {
  callSiteSwapEvidence,
  callSiteSwapPlace,
  contentSimilarityEvidence,
  gitRenameEvidence,
  matchSuccessors,
  nameSimilarityEvidence,
  placeLabel,
  replacementConsoleLine,
  sourceQueryRows
} from "../successor-matching";
import {
  AngularComponentIndex,
  angularClassKey,
  classifyAngularPath,
  detectAngularMajor,
  fallbackAngularWorkspaceLayout,
  readAngularWorkspaceLayout,
  type AngularIndexEntry,
  type AngularPathKind,
  type AngularWorkspaceLayout
} from "./angular-component-index";
import { AngularDecoratorReader, type AngularDecoratedClass } from "./angular-decorator-reader";
import { AngularSelectorMatcher } from "./angular-selector-matcher";
import { AngularSourceQueries, createAngularAnalysisState } from "./angular-source-queries";
import { AngularTemplateScanner } from "./angular-template-scanner";

export interface AngularChangeAnalysisDeps extends AnalysisPersistenceDeps {
  gitClient: GitClient;
  /** 08's detector: export closures, normalization and the import graph's module summaries. */
  detector: ComponentDetector;
  now(): number;
}

const STAGE = "analyzing";
const CONSOLE_MAX_CHARS = 500;
const REASON_MAX_CHARS = 300;
const INLINE_TEMPLATE_PLACEHOLDER = "`__PRVISION_INLINE_TEMPLATE__`";
const KIND_ORDER: Record<DraftCandidate["changeKind"], number> = {
  modified: 0,
  added: 1,
  removed: 2,
  affected_parent: 3,
  replaced: 0 // 00 §17: ranked with modified
};
const DIRECT_KIND_ORDER: Record<AngularPathKind, number> = {
  script: 0,
  template: 1,
  style: 2,
  asset: 3,
  global_style: 4,
  global_config: 5,
  ignored: 6
};
/** Representatives rank after every real parent (rankAndCap orders affected parents by depth, then diff size). */
const REPRESENTATIVE_DEPTH = AFFECTED_PARENT_MAX_DEPTH + 1;
const RENDERABLE_KINDS = new Set(["Component"]);
const SEEDING_KINDS = new Set(["Component", "Directive", "Pipe"]);

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

/** `<app-x>` for an element selector, the selector itself otherwise (`[appX]`, `app-x.y`). */
function selectorLabel(selector: string | null, className: string): string {
  if (selector === null) {
    return className;
  }
  return /^[a-zA-Z][\w-]*$/.test(selector) ? `<${selector}>` : selector;
}

/** True when an import specifier names `targetPath` (same file name without `.ts`): `../x/x.component` → x.component.ts. */
function specifierNamesFile(specifier: string, targetPath: string): boolean {
  const last = specifier.slice(specifier.lastIndexOf("/") + 1).replace(/\.ts$/, "");
  const file = targetPath.slice(targetPath.lastIndexOf("/") + 1).replace(/\.ts$/, "");
  return last === file;
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

/** A changed file of the Angular run: 08's `FileChange` plus its Angular kind. */
interface AngularFileChange extends FileChange {
  kind: AngularPathKind;
}

/** Propagation seed (§5.5.4): a changed file, its changed export names and its changed component/directive/pipe classes. */
interface AngularSeed {
  path: string;
  names: Set<string> | "*";
  classKeys: string[];
  label: string;
  changedLines: number;
}

/** Where a direct draft's code diff comes from (assembled after all direct changes are known, §5.5.3). */
interface DirectSource {
  entry: AngularIndexEntry;
  partials: string[]; // changed partial stylesheets that reached the component
}

interface RunState {
  ctx: PipelineContext;
  signal: AbortSignal;
  timeout: AbortSignal;
  log: Logger;
  layout: AngularWorkspaceLayout;
  reader: AngularDecoratorReader;
  scanner: AngularTemplateScanner;
  angularMajor: number | null;
  changes: Map<string, AngularFileChange>;
  indexes: Partial<Record<Side, Promise<AngularComponentIndex>>>;
  headResolver: ModuleResolver | null;
}

/** Change analysis step for Angular repositories (15b). Throws only PipelineStepError (stage "analyzing"). */
export class AngularChangeAnalysisService {
  private readonly deps: AngularChangeAnalysisDeps;

  constructor(deps: Partial<AngularChangeAnalysisDeps> = {}) {
    this.deps = {
      gitClient: deps.gitClient ?? new GitClient(),
      runInTransaction: deps.runInTransaction ?? ((fn) => DrizzleDb.transaction(fn)),
      createQueryHandler: deps.createQueryHandler ?? ((tx) => new QueryHandler(tx)),
      detector: deps.detector ?? new ComponentDetector(),
      now: deps.now ?? Date.now
    };
  }

  /**
   * Same contract as 08's `ChangeAnalysisService.analyze` (00 §14.7). Stateless between calls.
   *
   * @throws PipelineStepError (stage "analyzing") with an ANALYSIS_* code for every fatal outcome.
   */
  async analyze(ctx: PipelineContext): Promise<ChangeAnalysisResult> {
    const log = createLogger("angular-change-analysis", { visualizationId: ctx.visualizationId });
    const timeout = AbortSignal.timeout(ANALYSIS_TIMEOUT_MS);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    try {
      return await this.run(ctx, log, signal, timeout);
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
      log.error({ event: "change_analysis.unexpected", err: error }, "Angular change analysis failed unexpectedly");
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

  private async info(run: { ctx: PipelineContext }, message: string): Promise<void> {
    await run.ctx.console.info(STAGE, clip(message, CONSOLE_MAX_CHARS));
  }

  private async warn(run: { ctx: PipelineContext }, message: string): Promise<void> {
    await run.ctx.console.warn(STAGE, clip(message, CONSOLE_MAX_CHARS));
  }

  private async run(
    ctx: PipelineContext,
    log: Logger,
    signal: AbortSignal,
    timeout: AbortSignal
  ): Promise<ChangeAnalysisResult> {
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
      { ctx },
      `Looking for changed files between ${short(workspace.baseSha)} and ${workspace.headSha === null ? "working tree" : short(workspace.headSha)}`
    );

    // 0b. Angular workspace layout (head, else base: the project may be gone on head, 15 §6)
    const layoutInput = {
      appRoot: repository.appRoot,
      angularProject: repository.angularProject,
      tsconfigPath: repository.tsconfigPath
    };
    const headLayout = await readAngularWorkspaceLayout(workspace.headDir, layoutInput);
    const baseLayout = headLayout === null ? await readAngularWorkspaceLayout(workspace.baseDir, layoutInput) : null;
    const layout = headLayout ?? baseLayout ?? fallbackAngularWorkspaceLayout(repository.appRoot);
    if (headLayout === null && baseLayout === null) {
      await this.warn(
        { ctx },
        `${layout.appRoot}/angular.json could not be read on either side; analysing ${layout.sourceRoot} only.`
      );
    }
    const angularMajor = await detectAngularMajor(workspace.headDir, layout.appRoot, repository.localPath);
    const run: RunState = {
      ctx,
      signal,
      timeout,
      log,
      layout,
      reader: new AngularDecoratorReader({ angularMajor }),
      scanner: new AngularTemplateScanner(),
      angularMajor,
      changes: new Map(),
      indexes: {},
      headResolver: null
    };

    // 1. changed files (working tree: compare the app root, or the source root for a root app)
    const changeRoot = layout.appRoot === "." ? layout.sourceRoot : layout.appRoot;
    const source = new ChangeSource(this.deps.gitClient, workspace, signal, changeRoot);
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
    await this.checkpoint(run);

    // 2. classification (§5.5.1)
    let relevant = rawChanges.filter((change) => {
      const kind = classifyAngularPath(change.path, layout);
      if (kind === "ignored") {
        log.debug({ event: "change_analysis.angular.ignored", path: change.path }, "Changed path ignored");
      }
      return kind !== "ignored";
    });
    await this.info(
      { ctx },
      `${String(rawChanges.length)} changed files, ${String(relevant.length)} of them relevant to the Angular app ${layout.appRoot === "." ? "at the repository root" : layout.appRoot}`
    );
    if (relevant.length > ANALYSIS_MAX_CHANGED_FILES) {
      relevant = relevant.slice(0, ANALYSIS_MAX_CHANGED_FILES);
      await this.warn(
        { ctx },
        `Only the first ${String(ANALYSIS_MAX_CHANGED_FILES)} changed source files were analysed.`
      );
    }

    // 3. contents and diffs
    await this.loadChanges(run, source, relevant);

    // 4. head index (and resolver for NgModule declarations and token resolution)
    const drafts = new Map<string, DraftCandidate>();
    const directSources = new Map<string, DirectSource>();
    const seeds: AngularSeed[] = [];
    const globalChanges: AngularFileChange[] = [];
    let headIndex: AngularComponentIndex | null = null;
    if (run.changes.size > 0) {
      const resolverWarnings: string[] = [];
      run.headResolver = await ModuleResolver.create({
        side: "head",
        rootDir: workspace.headDir,
        tsconfigPath: repository.tsconfigPath,
        viteConfigPath: null,
        sourceRoot: layout.sourceRoot,
        warn: (message) => resolverWarnings.push(message),
        debug: (message) => {
          log.debug({ event: "change_analysis.resolver.debug", detail: message }, "Resolver detail");
        }
      });
      for (const message of resolverWarnings) {
        await this.warn({ ctx }, message);
      }
      headIndex = await this.indexFor(run, "head");
      const stats = headIndex.stats;
      await this.info(
        { ctx },
        `Angular workspace ${layout.appRoot}, project ${layout.projectName ?? "(unknown)"}: ${String(stats.components)} components indexed on head (${String(stats.templates)} templates).`
      );
      if (headIndex.truncated) {
        await this.warn({ ctx }, `Angular index truncated at ${String(ANALYSIS_MAX_PARSED_FILES)} files on head.`);
      }
      // global style closure needs the partial index (§5.5.1 rule 2)
      const closure = headIndex.styleClosure(layout.globalStyles);
      for (const change of run.changes.values()) {
        if (change.kind === "style" && closure.has(change.path)) {
          change.kind = "global_style";
        }
      }
    }
    await this.checkpoint(run);

    // 5. direct changes (§5.5.3)
    // scripts first, then templates, styles and assets: the first reason of a component wins (08 dedupe)
    const byKind = [...run.changes.values()].sort(
      (a, b) => DIRECT_KIND_ORDER[a.kind] - DIRECT_KIND_ORDER[b.kind] || byString(a.path, b.path)
    );
    for (const change of byKind) {
      switch (change.kind) {
        case "script":
          if (!change.tooLarge) {
            await this.classifyScriptChange(run, change, drafts, directSources, seeds);
          }
          break;
        case "template":
          await this.classifyTemplateChange(run, change, drafts, directSources);
          break;
        case "style":
          await this.classifyStyleChange(run, change, drafts, directSources);
          break;
        case "asset":
          if (headIndex !== null) {
            await this.classifyAssetChange(run, headIndex, change, drafts);
          }
          break;
        case "global_style":
        case "global_config":
          globalChanges.push(change);
          break;
        case "ignored":
          break;
      }
    }
    await this.reclassifyNewComponents(run, drafts);
    this.finalizeDirectDiffs(run, drafts, directSources);
    for (const [key, source] of directSources) {
      const draft = drafts.get(key);
      if (draft !== undefined && (draft.changeKind === "modified" || draft.changeKind === "added")) {
        seeds.push({
          path: source.entry.filePath,
          names: new Set([source.entry.cls.exportName ?? source.entry.cls.className]),
          classKeys: [source.entry.key],
          label: `component ${source.entry.cls.className}`,
          changedLines: draft.diffSize
        });
      }
    }
    const direct = [...drafts.values()];
    await this.info(
      { ctx },
      `Found ${String(direct.length)} directly changed components (${String(direct.filter((d) => d.changeKind === "modified").length)} modified, ${String(direct.filter((d) => d.changeKind === "added").length)} added, ${String(direct.filter((d) => d.changeKind === "removed").length)} removed).`
    );
    log.info(
      { event: "change_analysis.step.completed", step: "direct", drafts: direct.length, seeds: seeds.length },
      "Direct changes classified"
    );
    await this.checkpoint(run);

    // 6–7. TS import graph (only when something can propagate through imports)
    let headGraph: ImportGraph | null = null;
    if (headIndex !== null && run.headResolver !== null && seeds.length > 0) {
      headGraph = await ImportGraph.build({
        side: "head",
        rootDir: workspace.headDir,
        sourceRoot: layout.sourceRoot,
        resolver: run.headResolver,
        detector: this.deps.detector,
        priorityPaths: [...run.changes.values()].flatMap((change) =>
          change.headPath === null ? [] : [change.headPath]
        ),
        maxFiles: ANALYSIS_MAX_PARSED_FILES,
        budgetMs: ANALYSIS_GRAPH_BUDGET_MS,
        signal,
        now: () => this.deps.now(),
        log
      });
      const stats = headGraph.stats;
      const seconds = (stats.durationMs / 1000).toFixed(1);
      await this.info(
        { ctx },
        `Import graph: ${String(stats.files)} modules, ${String(stats.edges)} imports (${seconds} s).`
      );
      if (headGraph.truncated) {
        await this.warn(
          { ctx },
          `${layout.sourceRoot} has ${String(headGraph.totalFiles)} files; the import graph covers the ${String(ANALYSIS_MAX_PARSED_FILES)} closest to the change, so some parent components may be missing.`
        );
      }
      if (headGraph.budgetExceeded) {
        await this.warn({ ctx }, `Import graph stopped after ${seconds} s; some parent components may be missing.`);
      }
      log.info({ event: "change_analysis.step.completed", step: "graph", ...stats }, "Import graph built");
    }
    await this.checkpoint(run);

    // 8. propagation (§5.5.4) and global changes (§5.5.5)
    if (headIndex !== null) {
      await this.propagate(run, headIndex, headGraph, seeds, drafts);
      if (globalChanges.length > 0) {
        await this.addRepresentatives(run, headIndex, globalChanges, drafts);
      }
    }

    // 8b. successor matching (00 §17): removed + added pairs become one `replaced` draft
    if (headIndex !== null) {
      await this.matchReplacements(run, source, rawChanges, headIndex, drafts);
    }
    await this.checkpoint(run);

    // 9. rank and cap
    const limit = ctx.componentLimit ?? MAX_COMPONENTS;
    const { ordered, rendered, skipReasons } = rankAndCap([...drafts.values()], limit);
    const skippedCount = ordered.length - rendered.size;
    if (skippedCount > 0) {
      await this.warn({ ctx }, `${String(skippedCount)} components were skipped (limit ${String(limit)}).`);
    }
    if (ordered.length === 0) {
      await this.info({ ctx }, "No Angular components are affected by this change.");
    }
    await this.checkpoint(run);

    // 10. persist (shared helper, §5.5.7)
    const ids = await persistAnalysisRows(this.deps, ctx.visualizationId, ordered, rendered, skipReasons);
    await this.info({ ctx }, `Selected ${String(rendered.size)} components to render.`);

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
        framework: "angular",
        candidates: candidates.length,
        skipped: skipped.length,
        changedFiles: changedFiles.length,
        durationMs: this.deps.now() - started
      },
      "Angular change analysis completed"
    );
    const state = createAngularAnalysisState({
      workspace,
      repository,
      layout,
      changes: run.changes,
      changedFiles,
      rows: sourceQueryRows(ordered),
      detector: this.deps.detector,
      angularMajor,
      headResolver: run.headResolver,
      headGraph,
      headIndex,
      baseIndex: run.indexes.base ?? null,
      log,
      now: () => this.deps.now()
    });
    // 16a compile shim (16 §6.12): 16d fills globalStyleChanges (§8.5.2).
    return {
      candidates,
      skipped,
      changedFiles,
      sourceQueries: new AngularSourceQueries(state),
      globalStyleChanges: []
    };
  }

  /**
   * Step 8b (00 §17): scores every removed × added component pair with Angular evidence — templates that used R's
   * selector on base and use A's instead on head, TS files that imported R's class and now import A's, git renames,
   * similar class names in one feature folder, similar templates — and lets the shared core pair them. The
   * `replaced` draft's code diff compares R's class, template and styles on base with A's on head.
   */
  private async matchReplacements(
    run: RunState,
    source: ChangeSource,
    rawChanges: readonly RawChange[],
    headIndex: AngularComponentIndex,
    drafts: Map<string, DraftCandidate>
  ): Promise<void> {
    const kinds = new Set([...drafts.values()].map((draft) => draft.changeKind));
    if (!kinds.has("removed") || !kinds.has("added")) {
      return;
    }
    const baseIndex = await this.indexFor(run, "base");
    const entryOf = (side: Side, draft: DraftCandidate): AngularIndexEntry | null =>
      (side === "base" ? baseIndex : headIndex).entry(angularClassKey(draft.filePath, draft.displayName)) ?? null;
    const headPathOf = (basePath: string): string | null => {
      const change = this.changeAt(run, "base", basePath);
      return change === null ? basePath : change.headPath;
    };

    const templateSwaps = (removed: AngularIndexEntry, added: AngularIndexEntry): SuccessorEvidence[] => {
      const out: SuccessorEvidence[] = [];
      const oldSelector = removed.cls.selector;
      const oldMatcher =
        oldSelector === null ? null : new AngularSelectorMatcher([{ key: removed.key, selector: oldSelector }]);
      const headOwners = new Set(headIndex.usagesOf(added.key).map((usage) => usage.ownerKey));
      for (const usage of baseIndex.usagesOf(removed.key)) {
        const owner = baseIndex.entry(usage.ownerKey);
        const headPath = owner === undefined ? null : headPathOf(owner.filePath);
        if (owner === undefined || headPath === null) {
          continue;
        }
        const headOwner = headIndex.entry(angularClassKey(headPath, owner.cls.className));
        if (headOwner === undefined || !headOwners.has(headOwner.key)) {
          continue;
        }
        const scan = headOwner.templateScan;
        if (oldMatcher !== null && scan !== null && oldMatcher.matchUsages(scan).has(removed.key)) {
          continue; // still uses R on head: not a swap
        }
        out.push(
          callSiteSwapEvidence(
            headOwner.templatePath ?? headOwner.filePath,
            selectorLabel(oldSelector, removed.cls.className),
            selectorLabel(added.cls.selector, added.cls.className)
          )
        );
      }
      return out;
    };
    const importSwaps = (removed: AngularIndexEntry, added: AngularIndexEntry): SuccessorEvidence[] => {
      const out: SuccessorEvidence[] = [];
      const imports = (
        bindings: ReadonlyMap<string, { specifier: string; imported: string }>,
        entry: AngularIndexEntry
      ): boolean =>
        [...bindings.values()].some(
          (binding) => binding.imported === entry.cls.className && specifierNamesFile(binding.specifier, entry.filePath)
        );
      for (const change of run.changes.values()) {
        if (change.kind !== "script" || change.basePath === null || change.headPath === null) {
          continue;
        }
        if (change.basePath === removed.filePath || change.headPath === added.filePath) {
          continue;
        }
        const base = baseIndex.importsOf(change.basePath);
        const head = headIndex.importsOf(change.headPath);
        if (imports(base, removed) && imports(head, added) && !imports(head, removed)) {
          out.push(
            callSiteSwapEvidence(change.headPath, `import ${removed.cls.className}`, `import ${added.cls.className}`)
          );
        }
      }
      return out;
    };
    const changedFiles = rawChanges.map((change) =>
      change.previousPath === undefined
        ? { path: change.path, status: change.status }
        : { path: change.path, status: change.status, previousPath: change.previousPath }
    );
    const textAt = (side: Side, repoPath: string): string | null => {
      const change = this.changeAt(run, side, repoPath);
      return (side === "base" ? change?.baseText : change?.headText) ?? null;
    };

    const matches = await matchSuccessors(
      drafts,
      (removedDraft, addedDraft) => {
        const removed = entryOf("base", removedDraft);
        const added = entryOf("head", addedDraft);
        const evidence: SuccessorEvidence[] = [];
        if (removed !== null && added !== null) {
          const inTemplates = templateSwaps(removed, added);
          const templatePlaces = new Set(inTemplates.map((item) => placeLabel(callSiteSwapPlace(item.detail))));
          evidence.push(
            ...inTemplates,
            // a component whose template swapped also swaps its TS import: one place, one piece of evidence
            ...importSwaps(removed, added).filter(
              (item) => !templatePlaces.has(placeLabel(callSiteSwapPlace(item.detail)))
            )
          );
        }
        const rename = gitRenameEvidence(removedDraft.filePath, addedDraft.filePath, changedFiles, (from, to) =>
          source.renameSimilarity(from, to)
        );
        const name = nameSimilarityEvidence(removedDraft, addedDraft);
        const content = contentSimilarityEvidence(
          removed?.templateText ?? null,
          added?.templateText ?? null,
          "template"
        );
        evidence.push(...[rename, name, content].filter((item): item is SuccessorEvidence => item !== null));
        return Promise.resolve(evidence);
      },
      (removedDraft, addedDraft) => {
        const removed = entryOf("base", removedDraft);
        const added = entryOf("head", addedDraft);
        const pairs: Array<[string, string]> = [[removedDraft.filePath, addedDraft.filePath]];
        if (removed?.templatePath && added?.templatePath) {
          pairs.push([removed.templatePath, added.templatePath]);
        }
        const styles = Math.min(removed?.stylePaths.length ?? 0, added?.stylePaths.length ?? 0);
        for (let index = 0; index < styles; index++) {
          const from = removed?.stylePaths[index];
          const to = added?.stylePaths[index];
          if (from !== undefined && to !== undefined) {
            pairs.push([from, to]);
          }
        }
        const diffs = pairs.flatMap(([oldPath, newPath]) => {
          const oldText = textAt("base", oldPath);
          const newText = textAt("head", newPath);
          return oldText === null || newText === null ? [] : [buildUnifiedDiff({ oldPath, newPath, oldText, newText })];
        });
        if (diffs.length === 0) {
          return {
            codeDiff: addedDraft.codeDiff ?? removedDraft.codeDiff,
            diffSize: addedDraft.diffSize + removedDraft.diffSize
          };
        }
        return {
          codeDiff: truncateDiff(diffs.map((built) => built.diff).join("\n"), CODE_DIFF_MAX_LINES),
          diffSize: diffs.reduce((total, built) => total + built.changedLines, 0)
        };
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

  /** The side's component index, built once per run (§5.5.2). */
  private indexFor(run: RunState, side: Side): Promise<AngularComponentIndex> {
    const existing = run.indexes[side];
    if (existing !== undefined) {
      return existing;
    }
    const rootDir = side === "head" ? run.ctx.workspace.headDir : run.ctx.workspace.baseDir;
    const resolver = side === "head" ? run.headResolver : null;
    const priorityPaths = [...run.changes.values()].flatMap((change) => {
      const p = side === "head" ? change.headPath : change.basePath;
      return p === null ? [] : [p];
    });
    const built = AngularComponentIndex.build({
      side,
      rootDir,
      sourceRoot: run.layout.sourceRoot,
      appRoot: run.layout.appRoot,
      maxFiles: ANALYSIS_MAX_PARSED_FILES,
      maxFileBytes: ANALYSIS_MAX_FILE_BYTES,
      priorityPaths,
      angularMajor: run.angularMajor,
      signal: run.signal,
      now: () => this.deps.now(),
      resolveScript:
        resolver === null
          ? undefined
          : (specifier, from) => {
              const resolution = resolver.resolveScript(specifier, from);
              return resolution.kind === "internal" ? resolution.path : null;
            },
      log: run.log
    });
    run.indexes[side] = built;
    return built;
  }

  /** Step 3 (08 §5.6): reads both sides, applies the generated check and builds truncated diffs. */
  private async loadChanges(run: RunState, source: ChangeSource, relevant: readonly RawChange[]): Promise<void> {
    for (const change of relevant) {
      const kind = classifyAngularPath(change.path, run.layout);
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
      } else if (binary && kind !== "asset") {
        await this.warn(run, `Skipped ${change.path}: binary file.`);
      } else if (unsafe) {
        run.log.warn({ event: "change_analysis.file.refused", path: change.path }, "Symlink or path escape refused");
      }
      const baseText = base?.text ?? null;
      const headText = head?.text ?? null;
      if (
        kind === "script" &&
        ((headText !== null && hasGeneratedMarker(headText)) ||
          (headText === null && baseText !== null && hasGeneratedMarker(baseText)))
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
      run.changes.set(change.path, {
        kind,
        status: change.status,
        path: change.path,
        previousPath: change.previousPath ?? null,
        basePath,
        headPath,
        language: kind === "style" || kind === "global_style" ? "style" : "script",
        baseText: unavailable ? null : baseText,
        headText: unavailable ? null : headText,
        codeDiff,
        changedLines,
        tooLarge: unavailable
      });
    }
  }

  /** Changed file by its path on one side. */
  private changeAt(run: RunState, side: Side, repoPath: string): AngularFileChange | null {
    for (const change of run.changes.values()) {
      if ((side === "head" ? change.headPath : change.basePath) === repoPath) {
        return change;
      }
    }
    return null;
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

  private directDraft(
    entry: AngularIndexEntry,
    changeKind: "modified" | "added" | "removed",
    reason: string
  ): DraftCandidate | null {
    if (entry.cls.exportName === null) {
      return null; // not importable by a harness
    }
    return {
      filePath: entry.filePath,
      exportName: entry.cls.exportName,
      displayName: entry.cls.className,
      changeKind,
      codeDiff: null, // assembled in finalizeDirectDiffs
      reason,
      diffSize: 0,
      depth: 0,
      forcedSkipReason: null
    };
  }

  /**
   * A "modified" component that has no class of the same name at its base path is new on head: a renamed
   * component (file and class renamed together) or a component whose template/styles moved with it. Rendering it
   * as modified made the base build import a class that does not exist there.
   */
  private async reclassifyNewComponents(run: RunState, drafts: Map<string, DraftCandidate>): Promise<void> {
    const modified = [...drafts.values()].filter((draft) => draft.changeKind === "modified");
    if (modified.length === 0) {
      return;
    }
    const base = await this.indexFor(run, "base");
    for (const draft of modified) {
      const change = [...run.changes.values()].find((candidate) => candidate.headPath === draft.filePath);
      const basePath = change === undefined ? draft.filePath : change.basePath;
      if (basePath !== null && base.entry(angularClassKey(basePath, draft.displayName)) !== undefined) {
        continue;
      }
      drafts.set(keyOf(draft), { ...draft, changeKind: "added", reason: "New component" });
    }
  }

  private recordDirect(
    drafts: Map<string, DraftCandidate>,
    directSources: Map<string, DirectSource>,
    entry: AngularIndexEntry,
    changeKind: "modified" | "added" | "removed",
    reason: string,
    partial: string | null = null
  ): void {
    const draft = this.directDraft(entry, changeKind, reason);
    if (draft === null) {
      return;
    }
    this.addDraft(drafts, draft);
    const key = keyOf(draft);
    const source = directSources.get(key) ?? { entry, partials: [] };
    if (partial !== null && !source.partials.includes(partial)) {
      source.partials.push(partial);
    }
    directSources.set(key, source);
  }

  /** codeDiff = TS diff, then external template diff, then direct style diffs, then partials (§5.5.3). */
  private finalizeDirectDiffs(
    run: RunState,
    drafts: Map<string, DraftCandidate>,
    directSources: ReadonlyMap<string, DirectSource>
  ): void {
    for (const [key, source] of directSources) {
      const draft = drafts.get(key);
      if (draft === undefined || draft.changeKind === "affected_parent") {
        continue;
      }
      const side: Side = draft.changeKind === "removed" ? "base" : "head";
      const parts: AngularFileChange[] = [];
      const add = (repoPath: string | null): void => {
        if (repoPath === null) {
          return;
        }
        const change = this.changeAt(run, side, repoPath);
        if (change !== null && !parts.includes(change)) {
          parts.push(change);
        }
      };
      add(source.entry.filePath);
      add(source.entry.templatePath);
      for (const stylePath of source.entry.stylePaths) {
        add(stylePath);
      }
      for (const partial of source.partials) {
        add(partial);
      }
      draft.codeDiff =
        parts.length === 0
          ? null
          : truncateDiff(parts.map((change) => change.codeDiff).join("\n"), CODE_DIFF_MAX_LINES);
      draft.diffSize = parts.reduce((total, change) => total + change.changedLines, 0);
    }
  }

  /** Source file with inline templates masked, so template formatting is compared by fingerprint (15 §6). */
  private maskedSource(sf: ts.SourceFile, classes: readonly AngularDecoratedClass[]): ts.SourceFile {
    const spans = classes
      .flatMap((cls) => (cls.inlineTemplate === null ? [] : [cls.inlineTemplate]))
      .sort((a, b) => b.start - a.start);
    if (spans.length === 0) {
      return sf;
    }
    let text = sf.text;
    for (const span of spans) {
      text = `${text.slice(0, span.start)}${INLINE_TEMPLATE_PLACEHOLDER}${text.slice(span.end)}`;
    }
    return this.deps.detector.parse(sf.fileName, text);
  }

  /** Normalized code of one class: 08's export closure when exported, else the class text (§5.5.3). */
  private classCode(sf: ts.SourceFile, cls: AngularDecoratedClass): { raw: string; normalized: () => string } {
    const detector = this.deps.detector;
    const closure = cls.exportName === null ? null : detector.closureText(sf, cls.exportName);
    const raw = closure ?? findClassText(sf, cls.className);
    return { raw, normalized: () => detector.normalizeText(raw, sf.fileName) };
  }

  private classChanged(
    run: RunState,
    baseSF: ts.SourceFile,
    headSF: ts.SourceFile,
    base: AngularDecoratedClass,
    head: AngularDecoratedClass
  ): boolean {
    const baseTemplate = base.inlineTemplate?.text ?? null;
    const headTemplate = head.inlineTemplate?.text ?? null;
    if (baseTemplate !== headTemplate) {
      if (baseTemplate === null || headTemplate === null) {
        return true;
      }
      const url = `${headSF.fileName}#${head.className}`;
      if (run.scanner.scan(baseTemplate, url).fingerprint !== run.scanner.scan(headTemplate, url).fingerprint) {
        return true;
      }
    }
    const b = this.classCode(baseSF, base);
    const h = this.classCode(headSF, head);
    return b.raw !== h.raw && b.normalized() !== h.normalized();
  }

  /** §5.5.3 row 1 and row 4: component classes per class; directives, pipes and other exports become seeds. */
  private async classifyScriptChange(
    run: RunState,
    change: AngularFileChange,
    drafts: Map<string, DraftCandidate>,
    directSources: Map<string, DirectSource>,
    seeds: AngularSeed[]
  ): Promise<void> {
    const detector = this.deps.detector;
    const parse = (repoPath: string | null, text: string | null): ts.SourceFile | null =>
      repoPath === null || text === null ? null : detector.parse(repoPath, text);
    const baseRaw = parse(change.basePath, change.baseText);
    const headRaw = parse(change.headPath, change.headText);
    const baseClasses = baseRaw === null ? [] : run.reader.read(baseRaw);
    const headClasses = headRaw === null ? [] : run.reader.read(headRaw);
    const baseSF = baseRaw === null ? null : this.maskedSource(baseRaw, baseClasses);
    const headSF = headRaw === null ? null : this.maskedSource(headRaw, headClasses);
    const headIndex = await this.indexFor(run, "head");

    const entryFor = (side: Side, filePath: string, cls: AngularDecoratedClass): AngularIndexEntry => {
      const index = side === "head" ? headIndex : null;
      return (
        index?.entry(angularClassKey(filePath, cls.className)) ?? {
          key: angularClassKey(filePath, cls.className),
          filePath,
          cls,
          templatePath: null,
          stylePaths: [],
          templateText: cls.inlineTemplate?.text ?? null,
          templateScan: null
        }
      );
    };

    const decoratedNames = new Set<string>();
    const changedClassKeys: string[] = [];
    const changedNames = new Set<string>();
    const classNames = [...new Set([...baseClasses, ...headClasses].map((cls) => cls.className))].sort(byString);
    for (const className of classNames) {
      const b = baseClasses.find((cls) => cls.className === className);
      const h = headClasses.find((cls) => cls.className === className);
      for (const cls of [b, h]) {
        if (cls?.exportName !== null && cls?.exportName !== undefined) {
          decoratedNames.add(cls.exportName);
        }
      }
      const isComponent = (cls: AngularDecoratedClass | undefined): boolean =>
        cls !== undefined && RENDERABLE_KINDS.has(cls.kind);
      if (isComponent(h) && h !== undefined && change.headPath !== null) {
        if (isComponent(b) && b !== undefined) {
          if (baseSF !== null && headSF !== null && this.classChanged(run, baseSF, headSF, b, h)) {
            this.recordDirect(
              drafts,
              directSources,
              entryFor("head", change.headPath, h),
              "modified",
              "Component code changed"
            );
          }
        } else {
          this.recordDirect(drafts, directSources, entryFor("head", change.headPath, h), "added", "New component");
        }
        continue;
      }
      if (isComponent(b) && b !== undefined && change.basePath !== null) {
        this.recordDirect(drafts, directSources, entryFor("base", change.basePath, b), "removed", "Component removed");
        continue;
      }
      // directives, pipes, NgModules, injectables: seeds when their class changed (§5.5.4)
      const changed =
        b === undefined ||
        h === undefined ||
        baseSF === null ||
        headSF === null ||
        this.classChanged(run, baseSF, headSF, b, h);
      if (!changed) {
        continue;
      }
      const exportName = h?.exportName ?? b?.exportName ?? null;
      if (exportName !== null) {
        changedNames.add(exportName);
      }
      if (h !== undefined && change.headPath !== null && SEEDING_KINDS.has(h.kind)) {
        changedClassKeys.push(angularClassKey(change.headPath, h.className));
      }
    }

    // undecorated exports and module-level code: 08's closure comparison (08 §5.8.3)
    if (baseSF !== null && headSF !== null) {
      const meta = (side: Side, sf: ts.SourceFile) => ({
        path: sf.fileName,
        side,
        role: "source" as const,
        sizeBytes: sf.text.length
      });
      const baseExports = detector.summarize(baseSF, meta("base", baseSF)).exports;
      const headExports = detector.summarize(headSF, meta("head", headSF)).exports;
      const names = new Set([...baseExports, ...headExports].map((e) => e.exportName));
      for (const name of [...names].sort(byString)) {
        if (decoratedNames.has(name)) {
          continue;
        }
        const b = baseExports.find((e) => e.exportName === name);
        const h = headExports.find((e) => e.exportName === name);
        if (b?.typeOnly === true || h?.typeOnly === true) {
          continue;
        }
        if (b === undefined || h === undefined) {
          changedNames.add(name);
          continue;
        }
        const baseText = detector.closureText(baseSF, name);
        const headText = detector.closureText(headSF, name);
        if (
          baseText !== headText &&
          (baseText === null ||
            headText === null ||
            detector.normalizeText(baseText, baseSF.fileName) !== detector.normalizeText(headText, headSF.fileName))
        ) {
          changedNames.add(name);
        }
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
      if (residualChanged || changedNames.size > 0 || changedClassKeys.length > 0) {
        seeds.push({
          path: change.headPath ?? change.path,
          names: residualChanged ? "*" : changedNames,
          classKeys: changedClassKeys,
          label: `module ${change.headPath ?? change.path}`,
          changedLines: change.changedLines
        });
      }
    } else if (
      change.status === "A" &&
      change.headPath !== null &&
      (changedNames.size > 0 || changedClassKeys.length > 0)
    ) {
      seeds.push({
        path: change.headPath,
        names: changedNames,
        classKeys: changedClassKeys,
        label: `module ${change.headPath}`,
        changedLines: change.changedLines
      });
    }
  }

  /** §5.5.3 row 2: a changed template maps to its owners when its fingerprint changed. */
  private async classifyTemplateChange(
    run: RunState,
    change: AngularFileChange,
    drafts: Map<string, DraftCandidate>,
    directSources: Map<string, DirectSource>
  ): Promise<void> {
    if (change.baseText !== null && change.headText !== null) {
      const base = run.scanner.scan(change.baseText, change.basePath ?? change.path);
      const head = run.scanner.scan(change.headText, change.headPath ?? change.path);
      if (base.fingerprint === head.fingerprint) {
        run.log.debug(
          { event: "change_analysis.angular.template_formatting", path: change.path },
          "Formatting-only template change"
        );
        return;
      }
    }
    const owners = await this.ownersOf(run, change, (index, repoPath) => index.templateOwnersOf(repoPath));
    if (owners.length === 0) {
      run.log.debug(
        { event: "change_analysis.angular.template_unowned", path: change.path },
        "Changed template has no owner"
      );
    }
    for (const entry of owners) {
      this.recordDirect(drafts, directSources, entry, "modified", `Template changed: ${change.path}`);
    }
  }

  /** §5.5.3 row 3: direct owners ("Styles changed") and owners through partials ("Uses changed stylesheet"). */
  private async classifyStyleChange(
    run: RunState,
    change: AngularFileChange,
    drafts: Map<string, DraftCandidate>,
    directSources: Map<string, DirectSource>
  ): Promise<void> {
    const direct = await this.ownersOf(run, change, (index, repoPath) => index.styleOwnersOf(repoPath));
    for (const entry of direct) {
      this.recordDirect(drafts, directSources, entry, "modified", `Styles changed: ${change.path}`);
    }
    const viaPartial = await this.ownersOf(run, change, (index, repoPath) =>
      index.partialOwners(repoPath).map((owner) => owner.key)
    );
    for (const entry of viaPartial) {
      this.recordDirect(
        drafts,
        directSources,
        entry,
        "modified",
        `Uses changed stylesheet ${change.path}`,
        change.headPath ?? change.basePath
      );
    }
  }

  /**
   * Owner components of a changed template/style: head index for A/M/R, base index for D (mapped back to the head
   * entry when the owner still exists there).
   */
  private async ownersOf(
    run: RunState,
    change: AngularFileChange,
    keysOf: (index: AngularComponentIndex, repoPath: string) => readonly string[]
  ): Promise<AngularIndexEntry[]> {
    const head = await this.indexFor(run, "head");
    if (change.headPath !== null) {
      return keysOf(head, change.headPath).flatMap((key) => {
        const entry = head.entry(key);
        return entry === undefined ? [] : [entry];
      });
    }
    if (change.basePath === null) {
      return [];
    }
    const base = await this.indexFor(run, "base");
    return keysOf(base, change.basePath).flatMap((key) => {
      const entry = head.entry(key);
      return entry === undefined ? [] : [entry];
    });
  }

  /** §5.5.3 last row: components whose template names the asset file → affected_parent. */
  private async classifyAssetChange(
    run: RunState,
    index: AngularComponentIndex,
    change: AngularFileChange,
    drafts: Map<string, DraftCandidate>
  ): Promise<void> {
    const name = change.path.slice(change.path.lastIndexOf("/") + 1);
    const users = index
      .components()
      .filter((entry) => entry.cls.exportName !== null && entry.templateText?.includes(name) === true)
      .slice(0, MAX_PARENTS_PER_MODULE);
    for (const entry of users) {
      this.addParent(drafts, entry, `References changed asset ${change.path}`, 1, change.changedLines, change.codeDiff);
    }
    if (users.length > 0) {
      await this.info(
        run,
        `${change.path} changed: also rendering ${users.map((entry) => entry.cls.className).join(", ")}.`
      );
    }
  }

  private addParent(
    drafts: Map<string, DraftCandidate>,
    entry: AngularIndexEntry,
    reason: string,
    depth: number,
    diffSize: number,
    /** The diff of the changed file that makes this a parent, so every card has a code diff. */
    codeDiff: string | null
  ): boolean {
    if (entry.cls.exportName === null) {
      return false;
    }
    const draft: DraftCandidate = {
      filePath: entry.filePath,
      exportName: entry.cls.exportName,
      displayName: entry.cls.className,
      changeKind: "affected_parent",
      codeDiff,
      reason: clip(reason, REASON_MAX_CHARS),
      diffSize,
      depth,
      forcedSkipReason: null
    };
    if (drafts.has(keyOf(draft))) {
      return false; // direct changes and earlier reasons win
    }
    drafts.set(keyOf(draft), draft);
    return true;
  }

  /** §5.5.4: reverse BFS over TS imports, template selector usage and pipe usage, capped per seed. */
  private async propagate(
    run: RunState,
    index: AngularComponentIndex,
    graph: ImportGraph | null,
    seeds: readonly AngularSeed[],
    drafts: Map<string, DraftCandidate>
  ): Promise<void> {
    const directKeys = new Set(drafts.keys());
    for (const seed of [...seeds].sort((a, b) => byString(a.path, b.path) || byString(a.label, b.label))) {
      const reported: string[] = [];
      const alreadyListed: string[] = [];
      let counted = 0;
      const visitedFiles = new Set<string>([seed.path]);
      const seedKeys = new Set(seed.classKeys);
      let level: Array<{ path: string; names: Set<string> | "*"; classKeys: string[]; via: string[] }> = [
        { path: seed.path, names: seed.names, classKeys: seed.classKeys, via: [] }
      ];
      for (
        let depth = 1;
        depth <= AFFECTED_PARENT_MAX_DEPTH && level.length > 0 && counted < MAX_PARENTS_PER_MODULE;
        depth++
      ) {
        const found = new Map<string, { entry: AngularIndexEntry; reason: string }>();
        const offer = (entry: AngularIndexEntry | undefined, reason: string): void => {
          if (
            entry === undefined ||
            entry.cls.kind !== "Component" ||
            seedKeys.has(entry.key) ||
            found.has(entry.key)
          ) {
            return;
          }
          found.set(entry.key, { entry, reason });
        };
        const next: typeof level = [];
        for (const node of level) {
          const via = node.via.length > 0 ? ` via ${node.via.join(" → ")}` : "";
          // 2. template selector usage, 3. pipes
          for (const classKey of node.classKeys) {
            const used = index.entry(classKey);
            if (used === undefined) {
              continue;
            }
            if (used.cls.kind === "Pipe" && used.cls.pipeName !== null) {
              for (const owner of index.pipeUsersOf(used.cls.pipeName)) {
                offer(index.entry(owner), `Uses changed pipe ${used.cls.pipeName}${via}`);
              }
              continue;
            }
            const selector = used.cls.selector ?? "";
            const reason =
              used.cls.kind === "Component"
                ? `Uses changed component ${used.cls.className} (${selector}) in its template`
                : `Uses changed directive ${selector}`;
            for (const usage of index.usagesOf(classKey)) {
              offer(index.entry(usage.ownerKey), `${reason}${via}`);
            }
          }
          // 1. TS imports
          if (graph === null) {
            continue;
          }
          for (const edge of graph.importersOf(node.path)) {
            if (visitedFiles.has(edge.from) || !edgeUsesNames(edge, node.names)) {
              continue;
            }
            const importer = graph.module(edge.from);
            if (importer === undefined || importer.role === "test" || importer.role === "story") {
              continue;
            }
            visitedFiles.add(edge.from);
            const locals = localBindingsFor(edge, node.names);
            const uses = (cls: AngularDecoratedClass): boolean =>
              locals === "*" || locals.some((local) => cls.identifiers.includes(local));
            const entries = index.entriesInFile(edge.from);
            const components = entries.filter((entry) => entry.cls.kind === "Component" && uses(entry.cls));
            if (components.length > 0) {
              for (const entry of components) {
                const injects =
                  locals !== "*" &&
                  entry.cls.injected.some((dep) => dep.tokenRoot !== null && locals.includes(dep.tokenRoot));
                offer(entry, `${injects ? "Injects changed service" : "Imports changed module"} ${seed.path}${via}`);
              }
              continue;
            }
            const exposed = namesExposedBy(importer, edge, node.names);
            const classKeys = entries
              .filter((entry) => (entry.cls.kind === "Directive" || entry.cls.kind === "Pipe") && uses(entry.cls))
              .map((entry) => entry.key);
            if (exposed !== null || classKeys.length > 0) {
              next.push({ path: edge.from, names: exposed ?? new Set(), classKeys, via: [...node.via, edge.from] });
            }
          }
        }
        for (const { entry, reason } of [...found.values()].sort((a, b) => byString(a.entry.key, b.entry.key))) {
          if (counted >= MAX_PARENTS_PER_MODULE) {
            break;
          }
          const covered =
            entry.cls.exportName !== null &&
            directKeys.has(keyOf({ filePath: entry.filePath, exportName: entry.cls.exportName }));
          if (covered) {
            alreadyListed.push(entry.cls.className);
            continue;
          }
          const seedDiff =
            this.changeAt(run, "head", seed.path)?.codeDiff ?? this.changeAt(run, "base", seed.path)?.codeDiff ?? null;
          if (
            this.addParent(drafts, entry, reason, depth, seed.changedLines, seedDiff) ||
            entry.cls.exportName !== null
          ) {
            // a parent added by an earlier seed still counts as one of this seed's nearest parents
            reported.push(entry.cls.className);
            counted++;
          }
        }
        level = next.sort((a, b) => byString(a.path, b.path));
      }
      await this.info(
        run,
        reported.length > 0
          ? `${seed.label} changed: also rendering ${reported.join(", ")}.`
          : alreadyListed.length > 0
            ? `${seed.label} changed; the components using it are already listed (${[...new Set(alreadyListed)].join(", ")}).`
            : `${seed.label} changed; no other component uses it.`
      );
    }
  }

  /** §5.5.5: fill the remaining slots with widely used components. */
  private async addRepresentatives(
    run: RunState,
    index: AngularComponentIndex,
    globalChanges: readonly AngularFileChange[],
    drafts: Map<string, DraftCandidate>
  ): Promise<void> {
    const slots = (run.ctx.componentLimit ?? MAX_COMPONENTS) - drafts.size;
    if (slots <= 0) {
      return;
    }
    const first = [...globalChanges].sort((a, b) => byString(a.path, b.path))[0];
    if (first === undefined) {
      return;
    }
    const reason =
      first.kind === "global_style"
        ? `Global stylesheet changed: ${first.path}`
        : `Build configuration changed: ${first.path}`;
    const representatives = index
      .components()
      .filter((entry) => entry.cls.exportName !== null)
      .sort(
        (a, b) =>
          index.usageCount(b.key) - index.usageCount(a.key) ||
          Number(b.cls.selector !== null) - Number(a.cls.selector !== null) ||
          byString(a.filePath, b.filePath) ||
          byString(a.cls.className, b.cls.className)
      );
    let added = 0;
    for (const entry of representatives) {
      if (added >= slots) {
        break;
      }
      // diffSize encodes the usage order so rankAndCap keeps it (most used first)
      if (this.addParent(drafts, entry, reason, REPRESENTATIVE_DEPTH, slots - added, first.codeDiff)) {
        added++;
      }
    }
    if (added > 0) {
      await this.info(run, `Global change: showing ${String(added)} widely used components.`);
    }
  }
}

/** Text of a top-level class declaration (decorators included), or "" when absent. */
function findClassText(sf: ts.SourceFile, className: string): string {
  for (const statement of sf.statements) {
    if (ts.isClassDeclaration(statement) && statement.name?.text === className) {
      return statement.getText(sf);
    }
  }
  return "";
}
