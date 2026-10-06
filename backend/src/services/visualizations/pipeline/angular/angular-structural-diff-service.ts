/**
 * AngularStructuralDiffService (15 §5.8): the template half of the `diffing` stage for Angular repositories.
 *
 * Same contract and run conditions as 11's StructuralDiffService (11 §5.3.1): when pixels cannot explain a change it
 * compares the component's template between base and head and persists a `StructuralChange[]` in
 * `visualization_components.structural_diff`. Templates come from the component's `@Component` metadata on each side
 * (inline `template` or external `templateUrl`) and are mapped to 11's tree by `angularTemplateToTree`, so 11's diff
 * algorithm and path notation apply unchanged.
 */
import { posix } from "node:path";
import ts from "typescript";
import { Table } from "../../../../enums";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type PipelineContext,
  type StructuralChange,
  type WorktreeSide
} from "../../../../types/visualization-pipeline";
import { QueryHandler, createLogger, type ApiResponse } from "../../../../utilities";
import { readConfinedText } from "../change-source";
import { candidateBaseExport, candidateBasePath, candidateHeadPath } from "../replaced-components";
import { MISSING_ON_BOTH_SIDES, classifyRender } from "../image-diff-service";
import {
  newJsxBudget,
  type JsxBudget,
  type JsxTreeNode,
  type StructuralDiffInput,
  type StructuralDiffOutcome
} from "../structural-diff-service";
import { AngularDecoratorReader } from "./angular-decorator-reader";
import { angularTemplateToTree, diffAngularTemplateTrees } from "./angular-template-tree";

const STAGE = "diffing" as const;

/** Where a component's template lives, as read from its `@Component` decorator. */
export type AngularTemplateLocation =
  | { kind: "class_not_found" }
  /** The class exists but its template is not static (`template: someVar`, missing decorator or property). */
  | { kind: "unknown" }
  | { kind: "inline"; text: string }
  /** `templateUrl` exactly as written, relative to the component file. */
  | { kind: "external"; templateUrl: string };

/** Collaborators; every field defaults to the real implementation. */
export interface AngularStructuralDiffDeps {
  createQueryHandler(): QueryHandler;
  /** Default: 08's readConfinedText (realpath confinement, 512 KB, binary guard). */
  readSource(sideRoot: string, repoPath: string): Promise<string | null>;
  /** Default: `locateAngularTemplate`. */
  locateTemplate(sf: ts.SourceFile, exportName: string): AngularTemplateLocation;
}

type SideTree = { kind: "tree"; nodes: JsxTreeNode[]; note: string | null } | { kind: "failed"; note: string };

/**
 * Finds the `@Component` class exported as `exportName` with 15b's `AngularDecoratorReader` (alias- and
 * namespace-aware `@angular/core` imports) and returns where its template lives. A class name is accepted as well,
 * for components that are not exported under their own name.
 */
export function locateAngularTemplate(sf: ts.SourceFile, exportName: string): AngularTemplateLocation {
  const components = new AngularDecoratorReader().read(sf).filter((cls) => cls.kind === "Component");
  const target =
    components.find((cls) => cls.exportName === exportName) ?? components.find((cls) => cls.className === exportName);
  if (target === undefined) {
    return { kind: "class_not_found" };
  }
  if (target.inlineTemplate !== null) {
    return { kind: "inline", text: target.inlineTemplate.text };
  }
  if (target.templateUrl !== null) {
    return { kind: "external", templateUrl: target.templateUrl };
  }
  return { kind: "unknown" };
}

/** Repo-relative path of a `templateUrl` written relative to the component file. */
function resolveTemplatePath(componentPath: string, templateUrl: string): string {
  return posix.normalize(posix.join(posix.dirname(componentPath), templateUrl));
}

/** Runs the template comparison for Angular components without pixel output (15 §5.8.1) and persists it. */
export class AngularStructuralDiffService {
  private readonly deps: AngularStructuralDiffDeps;

  constructor(deps: Partial<AngularStructuralDiffDeps> = {}) {
    this.deps = {
      createQueryHandler: deps.createQueryHandler ?? ((): QueryHandler => new QueryHandler()),
      readSource: deps.readSource ?? ((sideRoot, repoPath) => readConfinedText(sideRoot, repoPath)),
      locateTemplate: deps.locateTemplate ?? locateAngularTemplate
    };
  }

  /**
   * Compares templates for every render that has no ImageDiffResult and is not new/deleted/missing on both sides.
   *
   * @returns One outcome per render (`ran: false`, `changes: null` where it did not run).
   * @throws PipelineStepError STRUCTURAL_DIFF_PERSIST_FAILED on a DB failure; the job signal's reason on abort.
   */
  async compare(ctx: PipelineContext, input: StructuralDiffInput): Promise<StructuralDiffOutcome[]> {
    const log = createLogger("angular-structural-diff", { visualizationId: ctx.visualizationId });
    const startedAt = Date.now();
    const diffed = new Set(input.diffs.map((diff) => diff.componentId));
    const candidates = new Map(input.analysis.candidates.map((candidate) => [candidate.componentId, candidate]));
    const ordered = [...input.renders].sort((a, b) => a.componentId - b.componentId);
    const toRun = ordered.filter((render) => {
      if (diffed.has(render.componentId)) {
        return false;
      }
      const classification = classifyRender(render);
      if (classification.kind === "new" || classification.kind === "deleted") {
        return false;
      }
      return !(classification.kind === "not_comparable" && classification.reason === MISSING_ON_BOTH_SIDES);
    });
    const runIds = new Set(toRun.map((render) => render.componentId));

    if (toRun.length > 0) {
      await ctx.console.info(
        STAGE,
        `Comparing template structure for ${String(toRun.length)} components that could not be compared visually.`
      );
    }
    const queryHandler = this.deps.createQueryHandler();
    const outcomes: StructuralDiffOutcome[] = [];
    for (const render of ordered) {
      if (!runIds.has(render.componentId)) {
        outcomes.push({ componentId: render.componentId, ran: false, changes: null, truncated: false, note: null });
        continue;
      }
      ctx.signal.throwIfAborted();
      const componentStartedAt = Date.now();
      const candidate = candidates.get(render.componentId);
      const outcome = await this.compareOne(ctx, render.componentId, candidate, input.analysis);
      await this.persist(ctx, queryHandler, render.componentId, outcome.changes ?? []);
      if (outcome.note !== null) {
        log.warn(
          { event: "structural_diff.component.note", componentId: render.componentId, note: outcome.note },
          "Template comparison incomplete"
        );
        await ctx.console.warn(
          STAGE,
          `Could not compare the template of ${candidate?.displayName ?? `component #${String(render.componentId)}`}: ${outcome.note}.`
        );
      }
      log.debug(
        {
          event: "structural_diff.component.completed",
          componentId: render.componentId,
          changes: outcome.changes?.length ?? 0,
          truncated: outcome.truncated,
          durationMs: Date.now() - componentStartedAt
        },
        "Component template compared"
      );
      outcomes.push(outcome);
    }
    log.info(
      { event: "structural_diff.stage.completed", compared: toRun.length, durationMs: Date.now() - startedAt },
      "Template structural diff completed"
    );
    return outcomes;
  }

  private async compareOne(
    ctx: PipelineContext,
    componentId: number,
    candidate: ComponentCandidate | undefined,
    analysis: ChangeAnalysisResult
  ): Promise<StructuralDiffOutcome> {
    if (candidate === undefined) {
      return { componentId, ran: true, changes: [], truncated: false, note: "component not found in the analysis" };
    }
    // 00 §17: a replaced row compares R (base path and export) with A (head path and export)
    const basePath = candidateBasePath(candidate, analysis.changedFiles);
    const headPath = candidateHeadPath(candidate);
    const baseBudget = newJsxBudget();
    const headBudget = newJsxBudget();
    const base = await this.treeFor(ctx, "base", basePath, candidateBaseExport(candidate), baseBudget);
    const head = await this.treeFor(ctx, "head", headPath, candidate.exportName, headBudget);
    if (base.kind === "failed" || head.kind === "failed") {
      const note = [base, head].flatMap((side) => (side.kind === "failed" ? [side.note] : [])).join("; ");
      return { componentId, ran: true, changes: [], truncated: false, note };
    }
    const diff = diffAngularTemplateTrees(base.nodes, head.nodes);
    const notes = [base.note, head.note].filter((note): note is string => note !== null);
    return {
      componentId,
      ran: true,
      changes: diff.changes,
      truncated: diff.truncated || baseBudget.truncated || headBudget.truncated,
      note: notes.length > 0 ? notes.join("; ") : null
    };
  }

  /** Template tree of one side. A side that does not exist for this change kind (`repoPath` null) is empty. */
  private async treeFor(
    ctx: PipelineContext,
    side: WorktreeSide,
    repoPath: string | null,
    exportName: string,
    budget: JsxBudget
  ): Promise<SideTree> {
    if (repoPath === null) {
      return { kind: "tree", nodes: [], note: null };
    }
    const sideRoot = side === "base" ? ctx.workspace.baseDir : ctx.workspace.headDir;
    const text = await this.deps.readSource(sideRoot, repoPath);
    if (text === null) {
      return { kind: "tree", nodes: [], note: `component source not found on ${side}` };
    }
    const sf = ts.createSourceFile(repoPath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const location = this.deps.locateTemplate(sf, exportName);
    let template: { text: string; url: string };
    switch (location.kind) {
      case "class_not_found":
        return { kind: "tree", nodes: [], note: `export ${exportName} not found on ${side}` };
      case "unknown":
        return { kind: "tree", nodes: [], note: `the template of ${exportName} is not static on ${side}` };
      case "inline":
        template = { text: location.text, url: repoPath };
        break;
      case "external": {
        const templatePath = resolveTemplatePath(repoPath, location.templateUrl);
        const external = await this.deps.readSource(sideRoot, templatePath);
        if (external === null) {
          return { kind: "tree", nodes: [], note: `template ${templatePath} not found on ${side}` };
        }
        template = { text: external, url: templatePath };
        break;
      }
    }
    const tree = angularTemplateToTree(template.text, template.url, budget);
    if (tree.parseFailed) {
      return { kind: "failed", note: `could not parse the ${side} template` };
    }
    return { kind: "tree", nodes: tree.nodes, note: null };
  }

  private async persist(
    ctx: PipelineContext,
    queryHandler: QueryHandler,
    componentId: number,
    changes: StructuralChange[]
  ): Promise<void> {
    let response: ApiResponse<{ rowsAffected: number }>;
    try {
      response = await queryHandler.update(
        { structuralDiff: changes },
        { id: componentId, visualizationId: ctx.visualizationId },
        Table.VISUALIZATION_COMPONENTS
      );
    } catch (error: unknown) {
      throw new PipelineStepError(STAGE, "Could not save the structural comparison results.", {
        code: "STRUCTURAL_DIFF_PERSIST_FAILED",
        cause: error
      });
    }
    if (response.status !== 200) {
      throw new PipelineStepError(STAGE, "Could not save the structural comparison results.", {
        code: "STRUCTURAL_DIFF_PERSIST_FAILED",
        detail: `Component ${String(componentId)} update failed (${String(response.status)})`
      });
    }
  }
}
