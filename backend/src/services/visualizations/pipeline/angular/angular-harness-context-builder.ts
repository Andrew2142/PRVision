/**
 * Context package of one Angular harness request (15 §5.6.3–5.6.4): component and template sources, the combined
 * diff, the component metadata, injected service outlines, app-level providers, imports, input types, template
 * usages, specs and stories, styles, changed dependencies, packages and global styles. Every section is capped and
 * then shrunk to the prompt budget with 09's `applyBudget`.
 *
 * Reads go through 09's SafeFileReader (worktree-confined) and every analysis query through 15b's
 * AngularSourceQueries; this file never parses templates or builds an import graph.
 */
import path from "node:path";
import type { Logger } from "pino";
import ts from "typescript";
import { HARNESS_PROMPT_TOKEN_BUDGET } from "../../../../config-consts";
import type {
  AngularAppProvider,
  AngularComponentMeta,
  AngularInjectedDependency,
  AngularInputMeta,
  AngularSourceQueriesLike
} from "../../../../types/angular-analysis";
import type {
  ComponentCandidate,
  DirectImport,
  PipelineContext,
  WorktreeSide
} from "../../../../types/visualization-pipeline";
import { createLogger, getErrorMessage } from "../../../../utilities";
import {
  SafeFileReader,
  applyBudget,
  codeMarker,
  composeItems,
  listMarker,
  mergeDirectImports,
  splitLines,
  storyAndTestCandidates,
  truncateDiffDetailed,
  truncateLinesDetailed,
  truncateSourceDetailed,
  truncateToTokens,
  type HarnessContextOptions,
  type MergedImport,
  type SectionDraft,
  type SectionId,
  type SectionItem,
  type TruncatedText
} from "../harness-context-builder";
import { HARNESS_SECTION_LIMITS, estimateTokens, targetImportStatement, type SectionLimit } from "../harness-prompts";
import {
  angularAppRootRel,
  angularTargetImportPath,
  escapeAngularBody,
  renderAngularHarnessUserPrompt,
  type AngularHarnessContextPackage
} from "./angular-harness-prompts";

// ---------------------------------------------------------------------------------------------------------------
// Section limits (15 §5.6.3). Line caps are the spec's; token caps allow ~90 characters per line. shrinkOrder is
// the inverse of the spec's priority (priority 7 = shrunk first = shrinkOrder 1; priority 1 = shrinkOrder 7).
// ---------------------------------------------------------------------------------------------------------------

/** Limits of every Angular section role (lines from 15 §5.6.3). */
export const ANGULAR_SECTION_LIMITS = {
  componentSource: { capTokens: 12_000, minTokens: 3_000, shrinkOrder: 7, maxLines: 400 },
  templateSource: HARNESS_SECTION_LIMITS.template_source,
  codeDiff: { capTokens: 12_000, minTokens: 2_000, shrinkOrder: 6, maxLines: 400 },
  componentMeta: HARNESS_SECTION_LIMITS.component_meta,
  injectedOutlines: HARNESS_SECTION_LIMITS.injected_outlines,
  appProviders: HARNESS_SECTION_LIMITS.app_providers,
  directImports: HARNESS_SECTION_LIMITS.direct_imports,
  referencedTypes: { capTokens: 6_000, minTokens: 0, shrinkOrder: 5, maxItems: 8, maxLinesPerItem: 120 },
  callSites: { capTokens: 3_000, minTokens: 0, shrinkOrder: 4, maxItems: 3 },
  storiesAndTests: { capTokens: 4_000, minTokens: 0, shrinkOrder: 4, maxItems: 2, maxLinesPerItem: 120 },
  baseTemplate: { capTokens: 6_000, minTokens: 0, shrinkOrder: 3, maxLines: 200 },
  baseSource: { capTokens: 6_000, minTokens: 0, shrinkOrder: 2, maxLines: 200 },
  styleSources: HARNESS_SECTION_LIMITS.style_sources,
  changedDependencies: { capTokens: 5_000, minTokens: 0, shrinkOrder: 5, maxItems: 3 },
  dependencies: { capTokens: 1_500, minTokens: 300, shrinkOrder: 3, maxLines: 200 },
  globalStyles: { capTokens: 300, minTokens: 0, shrinkOrder: 1, maxLines: 20 }
} as const satisfies Record<string, SectionLimit>;

/** Libraries whose presence changes how a harness must be written (15 §5.6.3). */
export const ANGULAR_LIBRARIES_OF_INTEREST: readonly string[] = [
  "@angular/material",
  "@angular/cdk",
  "@angular/forms",
  "@angular/router",
  "@angular/animations",
  "@angular/localize",
  "@ngx-translate/core",
  "@ngrx/store",
  "@ngrx/signals",
  "@ngrx/component-store",
  "ngx-quill",
  "ag-grid-angular",
  "primeng",
  "ng-zorro-antd",
  "@ng-bootstrap/ng-bootstrap",
  "ngx-bootstrap",
  "@fullcalendar/angular",
  "ngx-charts",
  "ng2-charts",
  "apollo-angular",
  "@tanstack/angular-query-experimental",
  "angular-oauth2-oidc",
  "keycloak-angular",
  "@auth0/auth0-angular",
  "firebase",
  "@angular/fire",
  "rxjs",
  "zone.js"
];

const INJECTED_OUTLINES_MAX = 6;
const STYLE_FILES_MAX = 2;
const APP_ENTRY_MAX_LINES = 60;
const PROVIDER_TEXT_MAX_CHARS = 300;
const META_TEXT_MAX_CHARS = 160;
const CALL_SITES_LIMIT = 3;
const SPEC_SETUPS_LIMIT = 1;
const CHANGED_DEPENDENCIES_MAX_DEPTH = 3;
const DEPENDENCY_MAX_ENTRIES = 200;
const UNRESOLVED_TYPES_MAX = 30;
const DEPENDENCY_GROUPS = ["dependencies", "peerDependencies", "devDependencies"] as const;
const STATUS_NAMES = { A: "added", M: "modified", D: "deleted", R: "renamed" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oneLine(text: string, max = META_TEXT_MAX_CHARS): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/** Applies a line cap after a token-based render. */
function capLines(rendered: TruncatedText, maxLines: number, marker: typeof codeMarker): TruncatedText {
  const lines = splitLines(rendered.text);
  if (lines.length <= maxLines) {
    return rendered;
  }
  const cut = truncateLinesDetailed(rendered.text, maxLines, marker);
  return { text: cut.text, totalLines: rendered.totalLines, omittedLines: rendered.omittedLines + cut.omittedLines };
}

/** A plain text section: head within the token cap and the line cap. */
function textDraft(
  id: SectionId,
  attributes: Record<string, string>,
  limit: SectionLimit,
  text: string,
  marker: typeof codeMarker
): SectionDraft {
  const originalLines = splitLines(text).length;
  return {
    id,
    attributes,
    limit,
    originalLines,
    render: (cap) => truncateToTokens(text, cap, marker, limit.maxLines ?? Number.POSITIVE_INFINITY)
  };
}

function itemsDraft(
  id: SectionId,
  items: SectionItem[],
  limit: SectionLimit,
  trailer: readonly string[] = []
): SectionDraft {
  // Child contents are escaped over the React + Angular tag union first (09's composeItems escapes React tags only).
  const escaped = items.map((item) => ({ ...item, content: escapeAngularBody(item.content).text }));
  return {
    id,
    attributes: {},
    limit,
    originalLines: items.reduce((sum, item) => sum + splitLines(item.content).length, 0) + trailer.length,
    render: (cap) => composeItems(escaped, cap, trailer)
  };
}

// ---------------------------------------------------------------------------------------------------------------
// component_meta rendering (15 §5.6.4)
// ---------------------------------------------------------------------------------------------------------------

function inputLine(input: AngularInputMeta, requiredByTemplate: ReadonlySet<string>): string {
  const parts: string[] = [input.kind];
  if (input.alias !== null) {
    parts.push(`alias ${input.alias}`);
  }
  if (input.required) {
    parts.push("required");
  }
  if (input.kind === "decorator" && !input.required && requiredByTemplate.has(input.name)) {
    parts.push("required by template use");
  }
  if (input.hasTransform) {
    parts.push("transform");
  }
  const type = input.typeText !== null ? ` : ${oneLine(input.typeText)}` : "";
  const initial = input.initializerText !== null ? ` = ${oneLine(input.initializerText)}` : "";
  return `- ${input.name} (${parts.join(", ")})${type}${initial}`;
}

function injectedWhere(dependency: AngularInjectedDependency): string {
  const resolved = dependency.resolvedPath;
  if (resolved !== null && resolved.startsWith("package:")) {
    return `package ${resolved.slice("package:".length)}`;
  }
  if (resolved !== null) {
    const kind =
      dependency.importSpecifier === null ? "local" : dependency.importSpecifier.startsWith(".") ? "relative" : "alias";
    return `${kind} → ${resolved}`;
  }
  return dependency.importSpecifier !== null ? `unresolved ${dependency.importSpecifier}` : "unresolved";
}

function injectedLine(dependency: AngularInjectedDependency): string {
  const optional = dependency.optional ? " (optional)" : "";
  const providedIn = dependency.providedIn !== null ? ` providedIn ${dependency.providedIn}` : "";
  const hints = dependency.hints.length > 0 ? `; hints: ${dependency.hints.join(", ")}` : "";
  return `- ${dependency.token} via ${dependency.via}${optional} [${injectedWhere(dependency)}]${providedIn}${hints}`;
}

function templateLine(meta: AngularComponentMeta): string {
  if (meta.template === null) {
    return "template: unknown (dynamic metadata)";
  }
  return meta.template.kind === "external"
    ? `template: external ${meta.template.path ?? "(unknown path)"}`
    : `template: inline (${meta.filePath} line ${meta.template.startLine})`;
}

function stylesLine(meta: AngularComponentMeta): string {
  const styles = meta.styles.map((style) =>
    style.kind === "external" && style.path !== null
      ? `${path.posix.basename(style.path)} (${style.language})`
      : `inline (${style.language})`
  );
  return `styles: ${styles.length > 0 ? styles.join(", ") : "(none)"}`;
}

function outputsLine(meta: AngularComponentMeta): string {
  const names = meta.outputs.map((output) =>
    output.alias !== null ? `${output.name} (alias ${output.alias})` : output.name
  );
  return `outputs: ${names.length > 0 ? names.join(", ") : "(none)"}`;
}

function classLine(meta: AngularComponentMeta): string {
  return `class: ${meta.className} (${meta.standalone ? "standalone" : "NgModule-declared"}) selector: ${meta.selector ?? "none"}`;
}

function declaredLine(meta: AngularComponentMeta): string {
  const module = meta.declaringModule;
  return `declared in NgModule: ${module !== null ? `${module.className} (${module.filePath})` : "(none)"}`;
}

/** One-line summaries per field, used to list base differences. */
function summaryFields(meta: AngularComponentMeta, requiredByTemplate: ReadonlySet<string>): Array<[string, string]> {
  return [
    ["class", classLine(meta)],
    ["changeDetection", `changeDetection: ${meta.changeDetection ?? "Default"}`],
    ["template", templateLine(meta)],
    ["styles", stylesLine(meta)],
    ["imports", `imports: ${meta.imports.length > 0 ? meta.imports.join(", ") : "(none)"}`],
    [
      "inputs",
      `inputs: ${meta.inputs.length > 0 ? meta.inputs.map((input) => inputLine(input, requiredByTemplate).slice(2)).join("; ") : "(none)"}`
    ],
    ["outputs", outputsLine(meta)],
    [
      "injected",
      `injected: ${meta.injected.length > 0 ? meta.injected.map((dependency) => injectedLine(dependency).slice(2)).join("; ") : "(none)"}`
    ],
    ["declared", declaredLine(meta)]
  ];
}

/** Options of renderAngularComponentMeta. */
export interface AngularComponentMetaRenderOptions {
  /** Decorator inputs declared with `!` that the template reads without a null guard (heuristic hint). */
  requiredByTemplate?: ReadonlySet<string>;
  /** Base-side metadata of a component present on both sides; differing fields are appended as `base: …` lines. */
  base?: AngularComponentMeta | null;
  /** True when the component exists on the base side but its metadata could not be read there. */
  baseMissing?: boolean;
}

/** The `component_meta` section body (15 §5.6.4). */
export function renderAngularComponentMeta(
  meta: AngularComponentMeta,
  options: AngularComponentMetaRenderOptions = {}
): string {
  const requiredByTemplate = options.requiredByTemplate ?? new Set<string>();
  const lines = [
    classLine(meta),
    `changeDetection: ${meta.changeDetection ?? "Default"}`,
    templateLine(meta),
    stylesLine(meta)
  ];
  lines.push(`imports: ${meta.imports.length > 0 ? meta.imports.join(", ") : "(none)"}`);
  if (meta.inputs.length === 0) {
    lines.push("inputs: (none)");
  } else {
    lines.push("inputs:", ...meta.inputs.map((input) => inputLine(input, requiredByTemplate)));
  }
  lines.push(outputsLine(meta));
  if (meta.injected.length === 0) {
    lines.push("injected: (none)");
  } else {
    lines.push("injected:", ...meta.injected.map(injectedLine));
  }
  lines.push(declaredLine(meta));
  if (options.base !== undefined && options.base !== null) {
    const head = new Map(summaryFields(meta, requiredByTemplate));
    for (const [key, value] of summaryFields(options.base, new Set())) {
      if (head.get(key) !== value) {
        lines.push(`base: ${value}`);
      }
    }
  } else if (options.baseMissing === true) {
    lines.push("base: (component metadata not found on the base side)");
  }
  return lines.join("\n");
}

/**
 * Decorator inputs declared with a definite-assignment `!` (`@Input() x!: T`) that the template reads as `x.` with
 * no null guard (`x?.`, `@if (x`, `*ngIf="x`, `x &&`). A heuristic hint for the model only (15 §5.6.4).
 */
export function angularInputsRequiredByTemplateUse(
  source: string,
  className: string,
  inputs: readonly AngularInputMeta[],
  template: string | null
): Set<string> {
  const found = new Set<string>();
  if (template === null) {
    return found;
  }
  const sf = ts.createSourceFile("component.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const definite = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && (node.name?.text === className || className === "")) {
      for (const member of node.members) {
        if (ts.isPropertyDeclaration(member) && member.exclamationToken !== undefined && ts.isIdentifier(member.name)) {
          definite.add(member.name.text);
        }
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const input of inputs) {
    if (input.kind !== "decorator" || input.required || !definite.has(input.name)) {
      continue;
    }
    const name = input.name.replace(/[$]/g, "\\$");
    const read = new RegExp(`(^|[^\\w$.?])${name}\\.(?!\\.)`).test(template);
    const guarded = new RegExp(
      `@if\\s*\\(\\s*!?\\s*${name}\\b|\\*ngIf\\s*=\\s*["']\\s*!?\\s*${name}\\b|\\[ngIf\\]\\s*=\\s*["']\\s*!?\\s*${name}\\b|\\b${name}\\s*&&|\\b${name}\\s*\\?(?!\\.)`
    ).test(template);
    if (read && !guarded) {
      found.add(input.name);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------------------------------------------
// AngularHarnessContextBuilder
// ---------------------------------------------------------------------------------------------------------------

type Metas = Record<WorktreeSide, AngularComponentMeta | null>;

/** Builds the context package of one Angular candidate (15 §5.6.3). Shared sections are memoised per side. */
export class AngularHarnessContextBuilder {
  private readonly shared = new Map<WorktreeSide, Promise<SectionDraft[]>>();
  private readonly log: Logger;

  constructor(
    private readonly ctx: Pick<PipelineContext, "workspace" | "repository" | "library">,
    private readonly queries: AngularSourceQueriesLike,
    private readonly fsReader: SafeFileReader = new SafeFileReader(ctx.workspace)
  ) {
    this.log = createLogger("pipeline.harness", { visualizationId: ctx.workspace.visualizationId });
  }

  /**
   * Assembles and budgets the context package.
   *
   * @param options - 16 §8.6.2: purpose and state allowance; default change review with the repository's allowance.
   * @throws Error when the component file exists on neither side (the caller records a context_error).
   */
  async build(candidate: ComponentCandidate, options?: HarnessContextOptions): Promise<AngularHarnessContextPackage> {
    const paths = await this.queries.componentPaths(candidate.filePath);
    const sidesPresent = { base: paths.base !== null, head: paths.head !== null };
    if (!sidesPresent.base && !sidesPresent.head) {
      throw new Error(`${candidate.filePath} does not exist on the base or the head side.`);
    }
    const preferred: WorktreeSide = candidate.changeKind === "removed" ? "base" : "head";
    const sourceSide: WorktreeSide = sidesPresent[preferred] ? preferred : preferred === "head" ? "base" : "head";
    const otherSide: WorktreeSide = sourceSide === "head" ? "base" : "head";
    const sourcePath = paths[sourceSide] ?? candidate.filePath;
    const appRoot = this.ctx.repository.appRoot;
    const appRootRel = angularAppRootRel(appRoot);
    const metas: Metas = {
      base: paths.base !== null ? await this.metaOf(paths.base, candidate.exportName, "base") : null,
      head: paths.head !== null ? await this.metaOf(paths.head, candidate.exportName, "head") : null
    };
    const meta = metas[sourceSide];
    const className =
      meta?.className ?? (candidate.exportName === "default" ? candidate.displayName : candidate.exportName);
    const directImports = {
      base: paths.base !== null ? await this.queries.getDirectImports(paths.base, "base") : [],
      head: paths.head !== null ? await this.queries.getDirectImports(paths.head, "head") : []
    };
    const source = await this.fsReader.read(sourceSide, sourcePath);

    const drafts: SectionDraft[] = [];
    const add = async (id: string, make: () => Promise<SectionDraft | SectionDraft[] | null>): Promise<void> => {
      try {
        const made = await make();
        if (made !== null) {
          drafts.push(...(Array.isArray(made) ? made : [made]));
        }
      } catch (error: unknown) {
        this.log.warn(
          {
            event: "harness.context.section_failed",
            componentId: candidate.componentId,
            section: id,
            error: getErrorMessage(error)
          },
          "Context section failed; omitted"
        );
      }
    };
    const hasDiff = candidate.codeDiff !== null && candidate.codeDiff !== "";
    const isModified = candidate.changeKind === "modified" && sourceSide === "head" && paths.base !== null;
    const primarySourceId: SectionId = sourceSide === "head" ? "head_source" : "base_source";

    await add("component_source", () =>
      Promise.resolve(
        source === null
          ? null
          : this.sourceDraft(primarySourceId, sourceSide, sourcePath, source, candidate, className, true)
      )
    );
    await add("template_source", () =>
      Promise.resolve(this.templateDraft(meta, sourceSide, ANGULAR_SECTION_LIMITS.templateSource))
    );
    if (hasDiff) {
      await add("code_diff", () => Promise.resolve(this.diffDraft(candidate)));
    }
    await add("component_meta", () =>
      Promise.resolve(this.metaDraft(meta, metas[otherSide], sidesPresent[otherSide], source))
    );
    await add("injected_outlines", () => this.outlinesDraft(meta, sourceSide));
    await add("app_providers", () => this.sharedDraft(sourceSide, "app_providers"));
    await add("direct_imports", () => this.directImportsDraft(directImports));
    await add("referenced_types", () => this.typesDraft(sourcePath, candidate.exportName, sourceSide));
    await add("call_sites", () => this.callSitesDraft(sourcePath, candidate.exportName, sourceSide));
    await add("stories_tests", () => this.storiesDraft(sourcePath, candidate.exportName, className, sourceSide));
    if (isModified) {
      await add("template_source", () => Promise.resolve(this.baseTemplateDraft(metas)));
      await add("base_source", () => this.baseSourceDraft(paths.base ?? candidate.filePath, candidate, className));
    }
    await add("style_sources", () => this.stylesDraft(meta, sourceSide));
    await add("changed_dependencies", () => this.dependencyDiffsDraft(candidate, paths, sourcePath, sourceSide));
    await add("dependencies", () => this.sharedDraft(sourceSide, "dependencies"));
    await add("global_styles", () => this.sharedDraft(sourceSide, "global_styles"));

    const statementTarget = { filePath: sourcePath, exportName: candidate.exportName, displayName: className };
    const pkg: AngularHarnessContextPackage = {
      candidate,
      sourceSide,
      sidesPresent,
      paths,
      viteRootRel: appRootRel,
      targetImportPath: angularTargetImportPath(sourcePath, appRootRel),
      targetImportStatement: targetImportStatement(statementTarget, appRootRel),
      directImports,
      sections: [],
      estimatedTokens: 0,
      purpose: options?.purpose ?? "change",
      stateAllowance: options?.stateAllowance ?? this.ctx.library.stateAllowance,
      angular: { className, selector: meta?.selector ?? null, appRoot }
    };
    const budgeted = applyBudget(
      drafts,
      (sections) => estimateTokens(renderAngularHarnessUserPrompt({ ...pkg, sections }).text),
      HARNESS_PROMPT_TOKEN_BUDGET
    );
    pkg.sections = budgeted.sections;
    pkg.estimatedTokens = budgeted.totalTokens;
    if (budgeted.overBudget) {
      this.log.warn(
        {
          event: "harness.context.over_budget",
          componentId: candidate.componentId,
          totalTokens: budgeted.totalTokens,
          budget: HARNESS_PROMPT_TOKEN_BUDGET
        },
        "Harness prompt is over budget after shrinking"
      );
    }
    this.log.debug(
      {
        event: "harness.context.built",
        framework: "angular",
        componentId: candidate.componentId,
        sections: pkg.sections.map((s) => ({ id: s.id, tokens: s.tokens, truncatedLines: s.truncatedLines })),
        totalTokens: pkg.estimatedTokens
      },
      "Harness context built"
    );
    return pkg;
  }

  private async metaOf(filePath: string, exportName: string, side: WorktreeSide): Promise<AngularComponentMeta | null> {
    try {
      return await this.queries.getComponentMeta(filePath, exportName, side);
    } catch (error: unknown) {
      this.log.warn(
        { event: "harness.context.section_failed", section: "component_meta", side, error: getErrorMessage(error) },
        "Angular component metadata could not be read"
      );
      return null;
    }
  }

  private sourceDraft(
    id: SectionId,
    side: WorktreeSide,
    filePath: string,
    source: string,
    candidate: ComponentCandidate,
    className: string,
    primary: boolean
  ): SectionDraft {
    const lines = splitLines(source).length;
    const limit = primary ? ANGULAR_SECTION_LIMITS.componentSource : ANGULAR_SECTION_LIMITS.baseSource;
    const attributes: Record<string, string> = { side, path: filePath, lines: String(lines) };
    if (primary && candidate.changeKind === "removed") {
      attributes.status = "removed in head";
    }
    const anchor = candidate.exportName === "default" ? "default" : className;
    return {
      id,
      attributes,
      limit,
      originalLines: lines,
      render: (cap) => capLines(truncateSourceDetailed(source, anchor, cap), limit.maxLines, codeMarker)
    };
  }

  private async baseSourceDraft(
    filePath: string,
    candidate: ComponentCandidate,
    className: string
  ): Promise<SectionDraft | null> {
    const source = await this.fsReader.read("base", filePath);
    return source === null
      ? null
      : this.sourceDraft("base_source", "base", filePath, source, candidate, className, false);
  }

  private templateDraft(
    meta: AngularComponentMeta | null,
    side: WorktreeSide,
    limit: SectionLimit
  ): SectionDraft | null {
    const template = meta?.template ?? null;
    if (meta === null || template === null || template.text.trim() === "") {
      return null;
    }
    const attributes: Record<string, string> = {
      side,
      path: template.kind === "external" ? (template.path ?? meta.filePath) : meta.filePath,
      kind: template.kind
    };
    if (template.kind === "inline") {
      attributes.line = String(template.startLine);
    }
    return textDraft("template_source", attributes, limit, template.text, listMarker);
  }

  /** The base template of a modified component, only when it differs from head (15 §5.6.3 row 10). */
  private baseTemplateDraft(metas: Metas): SectionDraft | null {
    const base = metas.base?.template ?? null;
    const head = metas.head?.template ?? null;
    if (base === null || (head !== null && head.text === base.text)) {
      return null;
    }
    return this.templateDraft(metas.base, "base", ANGULAR_SECTION_LIMITS.baseTemplate);
  }

  private diffDraft(candidate: ComponentCandidate): SectionDraft {
    const diff = candidate.codeDiff ?? "";
    const limit = ANGULAR_SECTION_LIMITS.codeDiff;
    return {
      id: "code_diff",
      attributes: { path: candidate.filePath },
      limit,
      originalLines: splitLines(diff).length,
      render: (cap) => capLines(truncateDiffDetailed(diff, cap), limit.maxLines, listMarker)
    };
  }

  private metaDraft(
    meta: AngularComponentMeta | null,
    other: AngularComponentMeta | null,
    otherPresent: boolean,
    source: string | null
  ): SectionDraft | null {
    if (meta === null) {
      return null;
    }
    const requiredByTemplate =
      source === null
        ? new Set<string>()
        : angularInputsRequiredByTemplateUse(source, meta.className, meta.inputs, meta.template?.text ?? null);
    const text = renderAngularComponentMeta(meta, {
      requiredByTemplate,
      base: otherPresent ? other : null,
      baseMissing: otherPresent && other === null
    });
    return textDraft("component_meta", {}, ANGULAR_SECTION_LIMITS.componentMeta, text, listMarker);
  }

  /** Outlines of the repository services and tokens the component injects (at most 6). */
  private async outlinesDraft(meta: AngularComponentMeta | null, side: WorktreeSide): Promise<SectionDraft | null> {
    if (meta === null) {
      return null;
    }
    const limit = ANGULAR_SECTION_LIMITS.injectedOutlines;
    const seen = new Set<string>();
    const items: SectionItem[] = [];
    for (const dependency of meta.injected) {
      const resolved = dependency.resolvedPath;
      if (
        resolved === null ||
        resolved.startsWith("package:") ||
        items.length >= (limit.maxItems ?? INJECTED_OUTLINES_MAX)
      ) {
        continue;
      }
      const key = `${resolved}#${dependency.token}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const outline = await this.queries.getInjectableOutline(resolved, dependency.token, side);
      if (outline === null) {
        continue;
      }
      const attributes: Record<string, string> = {
        path: outline.filePath,
        class: outline.className,
        providedIn: outline.providedIn ?? "none"
      };
      if (outline.constructorHints.length > 0) {
        attributes.hints = outline.constructorHints.join("; ");
      }
      items.push({
        tag: "injectable",
        attributes,
        content: outline.outline,
        marker: codeMarker,
        maxLines: limit.maxLinesPerItem
      });
    }
    return items.length > 0 ? itemsDraft("injected_outlines", items, limit) : null;
  }

  private async directImportsDraft(imports: {
    base: DirectImport[];
    head: DirectImport[];
  }): Promise<SectionDraft | null> {
    const merged = mergeDirectImports(imports);
    if (merged.length === 0) {
      return null;
    }
    const lines: string[] = [];
    for (const entry of merged) {
      lines.push(await this.importLine(entry));
    }
    return textDraft("direct_imports", {}, ANGULAR_SECTION_LIMITS.directImports, lines.join("\n"), listMarker);
  }

  /** Same line format as 09's direct_imports section. */
  private async importLine(entry: MergedImport): Promise<string> {
    const sideNote = entry.sides.size === 2 ? "" : entry.sides.has("head") ? " [head only]" : " [base only]";
    const head = `- "${entry.specifier}"`;
    if (entry.kind === "style" || entry.kind === "asset") {
      return `${head} [${entry.kind} — leave untouched]${sideNote}`;
    }
    if (entry.typeOnly) {
      return `${head} [type-only — no replacement needed]${sideNote}`;
    }
    const label =
      entry.kind === "package"
        ? "[package]"
        : entry.resolvedPath === null
          ? "[unresolved]"
          : `[${entry.kind} → ${entry.resolvedPath}]`;
    const names = [...entry.names];
    const imported =
      entry.sideEffectOnly && names.length === 0
        ? " side effect only"
        : names.length > 0
          ? ` imports: ${names.join(", ")}`
          : "";
    let exportsText = "";
    if (entry.kind !== "package" && entry.resolvedPath !== null) {
      const moduleExports = await this.queries.getModuleExports(entry.resolvedPath, entry.resolvedSide);
      if (moduleExports !== null) {
        exportsText = ` | module exports: ${moduleExports.join(", ")}`;
      }
    }
    return `${head} ${label}${imported}${exportsText}${sideNote}`;
  }

  private async typesDraft(filePath: string, exportName: string, side: WorktreeSide): Promise<SectionDraft | null> {
    const result = await this.queries.resolveTypeSources(filePath, exportName, side);
    const limit = ANGULAR_SECTION_LIMITS.referencedTypes;
    const sources = result.sources.slice(0, limit.maxItems);
    if (!result.found || (sources.length === 0 && result.unresolved.length === 0)) {
      return null;
    }
    const items: SectionItem[] = sources.map((typeSource) => ({
      tag: "type_source",
      attributes: {
        name: typeSource.name,
        path: typeSource.filePath,
        lines: `${typeSource.startLine}-${typeSource.endLine}`
      },
      content: typeSource.text,
      marker: codeMarker,
      maxLines: limit.maxLinesPerItem
    }));
    const trailer =
      result.unresolved.length > 0
        ? [`external or unknown types: ${result.unresolved.slice(0, UNRESOLVED_TYPES_MAX).join(", ")}`]
        : [];
    return itemsDraft("referenced_types", items, limit, trailer);
  }

  private async callSitesDraft(filePath: string, exportName: string, side: WorktreeSide): Promise<SectionDraft | null> {
    const sites = await this.queries.findCallSites(filePath, exportName, side, CALL_SITES_LIMIT);
    if (sites.length === 0) {
      return null;
    }
    const items: SectionItem[] = sites.slice(0, CALL_SITES_LIMIT).map((site) => ({
      tag: "call_site",
      attributes: { path: site.filePath, line: String(site.line), role: site.role },
      content: site.snippet,
      marker: codeMarker
    }));
    return itemsDraft("call_sites", items, ANGULAR_SECTION_LIMITS.callSites);
  }

  /** The TestBed setup of one spec (findSpecSetups) and one `*.stories.ts` that imports the component. */
  private async storiesDraft(
    filePath: string,
    exportName: string,
    className: string,
    side: WorktreeSide
  ): Promise<SectionDraft | null> {
    const limit = ANGULAR_SECTION_LIMITS.storiesAndTests;
    const items: SectionItem[] = [];
    const specs = await this.queries.findSpecSetups(filePath, exportName, side, SPEC_SETUPS_LIMIT);
    for (const spec of specs.slice(0, SPEC_SETUPS_LIMIT)) {
      items.push({
        tag: "test",
        attributes: { path: spec.filePath, line: String(spec.line) },
        content: spec.snippet,
        marker: codeMarker,
        maxLines: limit.maxLinesPerItem
      });
    }
    const stories = storyAndTestCandidates(filePath).stories.filter((candidate) => candidate.endsWith(".ts"));
    for (const candidate of stories) {
      const text = await this.fsReader.read(side, candidate);
      if (text !== null && text.includes(className)) {
        items.push({
          tag: "story",
          attributes: { path: candidate },
          content: text,
          marker: codeMarker,
          maxLines: limit.maxLinesPerItem
        });
        break;
      }
    }
    return items.length > 0 ? itemsDraft("stories_tests", items, limit) : null;
  }

  /** External component stylesheets of the source side (at most 2). */
  private async stylesDraft(meta: AngularComponentMeta | null, side: WorktreeSide): Promise<SectionDraft | null> {
    if (meta === null) {
      return null;
    }
    const limit = ANGULAR_SECTION_LIMITS.styleSources;
    const items: SectionItem[] = [];
    for (const style of meta.styles) {
      if (style.kind !== "external" || style.path === null || items.length >= (limit.maxItems ?? STYLE_FILES_MAX)) {
        continue;
      }
      const text = await this.fsReader.read(side, style.path);
      if (text === null) {
        continue;
      }
      items.push({
        tag: "style_source",
        attributes: { path: style.path, language: style.language },
        content: text,
        marker: listMarker,
        maxLines: limit.maxLinesPerItem
      });
    }
    return items.length > 0 ? itemsDraft("style_sources", items, limit) : null;
  }

  private async dependencyDiffsDraft(
    candidate: ComponentCandidate,
    paths: { base: string | null; head: string | null },
    sourcePath: string,
    sourceSide: WorktreeSide
  ): Promise<SectionDraft | null> {
    let wanted = candidate.changeKind === "affected_parent";
    if (!wanted && candidate.changeKind === "modified" && paths.head !== null) {
      wanted = (await this.queries.changedDependenciesOf(paths.head, "head", 1)).length > 0;
    }
    if (!wanted) {
      return null;
    }
    const limit = ANGULAR_SECTION_LIMITS.changedDependencies;
    const dependencies = (
      await this.queries.changedDependenciesOf(sourcePath, sourceSide, CHANGED_DEPENDENCIES_MAX_DEPTH)
    ).slice(0, limit.maxItems);
    if (dependencies.length === 0) {
      return null;
    }
    const items: SectionItem[] = dependencies.map((dependency) => ({
      tag: "dependency_diff",
      attributes: { path: dependency.path, status: STATUS_NAMES[dependency.status], depth: String(dependency.depth) },
      content: dependency.codeDiff,
      marker: listMarker
    }));
    return itemsDraft("changed_dependencies", items, limit);
  }

  // ---- shared sections (computed once per side) ----

  private async sharedDraft(
    side: WorktreeSide,
    id: "app_providers" | "dependencies" | "global_styles"
  ): Promise<SectionDraft | null> {
    let drafts = this.shared.get(side);
    if (drafts === undefined) {
      drafts = this.buildSharedDrafts(side);
      this.shared.set(side, drafts);
    }
    return (await drafts).find((draft) => draft.id === id) ?? null;
  }

  private async buildSharedDrafts(side: WorktreeSide): Promise<SectionDraft[]> {
    const drafts: SectionDraft[] = [];
    for (const [id, make] of [
      ["app_providers", () => this.appProvidersDraft(side)],
      ["dependencies", () => this.dependenciesDraft(side)],
      ["global_styles", () => Promise.resolve(this.globalStylesDraft())]
    ] as const) {
      try {
        const draft = await make();
        if (draft !== null) {
          drafts.push(draft);
        }
      } catch (error: unknown) {
        this.log.warn(
          { event: "harness.context.section_failed", section: id, error: getErrorMessage(error) },
          "Context section failed; omitted"
        );
      }
    }
    return drafts;
  }

  /** `getAppProviders` one line each, then the raw application entry (≤ 60 lines). */
  private async appProvidersDraft(side: WorktreeSide): Promise<SectionDraft | null> {
    const providers: AngularAppProvider[] = await this.queries.getAppProviders(side);
    const entryPath = this.ctx.repository.entryFilePath;
    const entry = entryPath !== null ? await this.fsReader.read(side, entryPath) : null;
    if (providers.length === 0 && entry === null) {
      return null;
    }
    const lines =
      providers.length > 0
        ? [
            "providers given to the application at bootstrap:",
            ...providers.map(
              (provider) => `- ${oneLine(provider.text, PROVIDER_TEXT_MAX_CHARS)} (from ${provider.source})`
            )
          ]
        : ["providers given to the application at bootstrap: (none found)"];
    if (entry !== null && entryPath !== null) {
      lines.push(`// file: ${entryPath}`, truncateLinesDetailed(entry, APP_ENTRY_MAX_LINES, codeMarker).text);
    }
    const attributes: Record<string, string> = entryPath !== null ? { entry: entryPath } : {};
    return textDraft("app_providers", attributes, ANGULAR_SECTION_LIMITS.appProviders, lines.join("\n"), listMarker);
  }

  /** The app's package.json (`<appRoot>/package.json`, else the repository root's) with the Angular libraries of interest. */
  private async dependenciesDraft(side: WorktreeSide): Promise<SectionDraft | null> {
    const appRootRel = angularAppRootRel(this.ctx.repository.appRoot);
    const candidates = appRootRel === "" ? ["package.json"] : [`${appRootRel}/package.json`, "package.json"];
    let raw: string | null = null;
    for (const candidate of candidates) {
      raw = await this.fsReader.read(side, candidate);
      if (raw !== null) {
        break;
      }
    }
    if (raw === null) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error: unknown) {
      this.log.warn(
        { event: "harness.context.section_failed", section: "dependencies", error: getErrorMessage(error) },
        "package.json is not valid JSON; dependencies omitted"
      );
      return null;
    }
    if (!isRecord(parsed)) {
      return null;
    }
    const interesting: string[] = [];
    const groups: string[] = [];
    let entries = 0;
    let omitted = 0;
    for (const group of DEPENDENCY_GROUPS) {
      const map = parsed[group];
      if (!isRecord(map)) {
        continue;
      }
      const lines: string[] = [];
      for (const [name, range] of Object.entries(map)) {
        const entry = `${name}@${typeof range === "string" ? range : JSON.stringify(range)}`;
        if (ANGULAR_LIBRARIES_OF_INTEREST.includes(name)) {
          interesting.push(entry);
        }
        if (entries >= DEPENDENCY_MAX_ENTRIES) {
          omitted += 1;
          continue;
        }
        entries += 1;
        lines.push(entry);
      }
      if (lines.length > 0) {
        groups.push(`${group}:`, ...lines);
      }
    }
    if (groups.length === 0) {
      return null;
    }
    const text = [
      `libraries of interest: ${interesting.length > 0 ? interesting.join(", ") : "none"}`,
      ...groups,
      ...(omitted > 0 ? [listMarker(omitted)] : [])
    ].join("\n");
    const originalLines = splitLines(text).length + omitted;
    return {
      id: "dependencies",
      attributes: {},
      limit: ANGULAR_SECTION_LIMITS.dependencies,
      originalLines,
      render: (cap) => {
        const cut = truncateToTokens(text, cap, listMarker);
        return { text: cut.text, totalLines: originalLines, omittedLines: omitted + cut.omittedLines };
      }
    };
  }

  private globalStylesDraft(): SectionDraft | null {
    const stylePaths = this.ctx.repository.globalStylePaths;
    if (stylePaths.length === 0) {
      return null;
    }
    const limit = ANGULAR_SECTION_LIMITS.globalStyles;
    const listed = truncateLinesDetailed(stylePaths.join("\n"), limit.maxLines, listMarker);
    const text = `${listed.text}\n(already applied by the build; never import)`;
    return {
      id: "global_styles",
      attributes: {},
      limit,
      originalLines: stylePaths.length + 1,
      render: (cap) => {
        const cut = truncateToTokens(text, cap, listMarker);
        return {
          text: cut.text,
          totalLines: stylePaths.length + 1,
          omittedLines: listed.omittedLines + cut.omittedLines
        };
      }
    };
  }
}
