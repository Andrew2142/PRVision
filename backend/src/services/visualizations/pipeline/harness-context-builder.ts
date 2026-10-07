/**
 * Context package of one harness request (09 §5.3–5.4): sources, diff, imports, types, call sites, stories and
 * tests, changed dependencies, app entry, dependencies and global styles, each capped and then shrunk to the
 * prompt budget with explicit truncation markers.
 *
 * Reads go through SafeFileReader (worktree-confined, never node_modules/.git/.prvision-harness/secrets) and
 * every analysis query through 08's ComponentSourceQueries (09 §3.1); this file never touches an import graph.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import ts from "typescript";
import { HARNESS_PROMPT_TOKEN_BUDGET } from "../../../config-consts";
import type {
  ComponentCandidate,
  ComponentSourceQueries,
  DirectImport,
  PipelineContext,
  PreparedWorkspace,
  WorktreeSide
} from "../../../types/visualization-pipeline";
import { createLogger, getErrorMessage, isPathInside } from "../../../utilities";
import {
  HARNESS_SECTION_LIMITS,
  SECTION_TAGS,
  escapeAttribute,
  escapeBody,
  estimateTokens,
  renderHarnessUserPrompt,
  targetImportPath,
  targetImportStatement,
  viteRootRelOf,
  type SectionLimit
} from "./harness-prompts";
import { syntaxProblems } from "./harness-validator";

// ---------------------------------------------------------------------------------------------------------------
// Types (09 §5.3)
// ---------------------------------------------------------------------------------------------------------------

export type SectionId =
  | "head_source"
  | "base_source"
  | "code_diff"
  | "direct_imports"
  | "referenced_types"
  | "call_sites"
  | "stories_tests"
  | "changed_dependencies"
  | "app_entry"
  | "dependencies"
  | "global_styles"
  // Angular sections (15 §5.6.2); only AngularHarnessContextBuilder emits them.
  | "template_source"
  | "style_sources"
  | "component_meta"
  | "injected_outlines"
  | "app_providers";

export interface PromptSection {
  id: SectionId;
  tag: string; // XML-ish tag used in the prompt
  attributes: Record<string, string>;
  body: string; // already truncated
  originalLines: number;
  truncatedLines: number;
  tokens: number; // estimateTokens(body)
  /** Dropped while shrinking: rendered as `<tag>[truncated N lines]</tag>` (09 §5.4.2). */
  dropped?: boolean;
}

export interface HarnessContextPackage {
  candidate: ComponentCandidate;
  sourceSide: WorktreeSide; // head unless changeKind === "removed"
  sidesPresent: { base: boolean; head: boolean };
  paths: { base: string | null; head: string | null }; // from sourceQueries.componentPaths (rename-aware)
  viteRootRel: string; // harness root: Vite root for React, app root for Angular (09 §5.2, 15 §5.6.2)
  targetImportPath: string; // targetImportPath(head path, or base path for removed)
  targetImportStatement: string;
  directImports: { base: DirectImport[]; head: DirectImport[] }; // of the component file on each present side
  sections: PromptSection[]; // in prompt order
  estimatedTokens: number;
  /** 16 §8.6.2: "change" for run candidates; "library" for scans and other library writes. */
  purpose: "change" | "library";
  /** 16 §8.6.2: maximum number of states, from the generation options (default ctx.library.stateAllowance). */
  stateAllowance: number;
}

// ---------------------------------------------------------------------------------------------------------------
// SafeFileReader
// ---------------------------------------------------------------------------------------------------------------

/** Default size cap of SafeFileReader.read. */
export const SAFE_READ_MAX_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const FORBIDDEN_SEGMENTS = new Set(["node_modules", ".git", ".prvision-harness"]);

function isSecretFileName(name: string): boolean {
  return /^\.env/i.test(name) || /\.(pem|key)$/i.test(name);
}

function hasForbiddenSegment(segments: readonly string[]): boolean {
  return segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment));
}

/**
 * Worktree-confined file access (09 §5.3). Refuses paths outside the side's root (after realpath), inside
 * node_modules/, .git/ or .prvision-harness/, and `.env*`, `*.pem`, `*.key` files. Never throws.
 */
export class SafeFileReader {
  constructor(private readonly workspace: Pick<PreparedWorkspace, "baseDir" | "headDir">) {}

  /**
   * Text of a repo-relative file on one side, or null when it is missing, refused, binary (NUL in the first
   * 8 KiB) or larger than `maxBytes`.
   */
  async read(side: WorktreeSide, repoRelativePath: string, maxBytes = SAFE_READ_MAX_BYTES): Promise<string | null> {
    const file = await this.confine(side, repoRelativePath);
    if (file === null) {
      return null;
    }
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > maxBytes) {
        return null;
      }
      const buffer = await fs.readFile(file);
      if (buffer.length > maxBytes || buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
        return null;
      }
      return buffer.toString("utf8");
    } catch {
      return null; // vanished between stat and read, or unreadable: treated as missing
    }
  }

  /** True when the repo-relative path is a regular file on that side and passes the same confinement rules. */
  async exists(side: WorktreeSide, repoRelativePath: string): Promise<boolean> {
    const file = await this.confine(side, repoRelativePath);
    if (file === null) {
      return false;
    }
    try {
      return (await fs.stat(file)).isFile();
    } catch {
      return false;
    }
  }

  private async confine(side: WorktreeSide, repoRelativePath: string): Promise<string | null> {
    if (repoRelativePath === "" || repoRelativePath.includes("\0") || path.posix.isAbsolute(repoRelativePath)) {
      return null;
    }
    const normalized = path.posix.normalize(repoRelativePath);
    const segments = normalized.split("/");
    if (segments.includes("..") || hasForbiddenSegment(segments) || isSecretFileName(segments.at(-1) ?? "")) {
      return null;
    }
    const root = side === "base" ? this.workspace.baseDir : this.workspace.headDir;
    try {
      const realRoot = await fs.realpath(root);
      const realFile = await fs.realpath(path.join(root, normalized));
      if (!isPathInside(realRoot, realFile)) {
        return null;
      }
      const realSegments = path.relative(realRoot, realFile).split(path.sep);
      if (hasForbiddenSegment(realSegments) || isSecretFileName(path.basename(realFile))) {
        return null; // a symlink inside the worktree pointing at a refused location
      }
      return realFile;
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Truncation helpers (09 §5.4.2)
// ---------------------------------------------------------------------------------------------------------------

/** Builds the marker line for N omitted lines. */
export type TruncationMarker = (omittedLines: number) => string;
/** Code (sources, stories, tests, app entry, type snippets). */
export const codeMarker: TruncationMarker = (n) => `// [truncated ${n} lines]`;
/** Diffs and lists. */
export const listMarker: TruncationMarker = (n) => `[truncated ${n} lines]`;

/** Truncation result with line accounting. */
export interface TruncatedText {
  text: string;
  totalLines: number;
  omittedLines: number;
}

export function splitLines(text: string): string[] {
  return text.replace(/\n+$/, "").split("\n");
}

function charsOf(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 1, 0);
}

/** Keeps the first `maxLines` lines and appends `marker(N)` with N = omitted line count (09 §5.4.2). */
export function truncateLines(text: string, maxLines: number, marker: TruncationMarker): string {
  return truncateLinesDetailed(text, maxLines, marker).text;
}

export function truncateLinesDetailed(text: string, maxLines: number, marker: TruncationMarker): TruncatedText {
  const lines = splitLines(text);
  if (lines.length <= maxLines) {
    return { text: lines.join("\n"), totalLines: lines.length, omittedLines: 0 };
  }
  const omitted = lines.length - maxLines;
  return {
    text: [...lines.slice(0, maxLines), marker(omitted)].join("\n"),
    totalLines: lines.length,
    omittedLines: omitted
  };
}

/** Head of the text within `capTokens` (and at most `maxLines` lines), then the marker. */
export function truncateToTokens(
  text: string,
  capTokens: number,
  marker: TruncationMarker,
  maxLines = Number.POSITIVE_INFINITY
): TruncatedText {
  const lines = splitLines(text);
  if (lines.length <= maxLines && estimateTokens(lines.join("\n")) <= capTokens) {
    return { text: lines.join("\n"), totalLines: lines.length, omittedLines: 0 };
  }
  const budget = capTokens * 3 - marker(lines.length).length - 1;
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (kept.length >= maxLines || used + line.length + 1 > budget) {
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  return { text: [...kept, marker(omitted)].join("\n"), totalLines: lines.length, omittedLines: omitted };
}

/**
 * Export-aware truncation of a component source (09 §5.4.2): keeps imports, the declaration that provides
 * `exportName` and its props types, then other statements in source order while within the cap; each omitted run
 * becomes one `// [truncated N lines]` line. Parse errors fall back to the head of the file.
 */
export function truncateSourceAroundExport(source: string, exportName: string, capTokens: number): string {
  return truncateSourceDetailed(source, exportName, capTokens).text;
}

export function truncateSourceDetailed(source: string, exportName: string, capTokens: number): TruncatedText {
  const lines = splitLines(source);
  const text = lines.join("\n");
  if (estimateTokens(text) <= capTokens) {
    return { text, totalLines: lines.length, omittedLines: 0 };
  }
  if (syntaxProblems(text, "component.tsx").length > 0) {
    return truncateToTokens(text, capTokens, codeMarker);
  }
  const sf = ts.createSourceFile("component.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const targets = findTargetStatements(sf, exportName);
  if (targets.size === 0) {
    return truncateToTokens(text, capTokens, codeMarker);
  }
  const ranges = new Map(sf.statements.map((statement) => [statement, statementLines(sf, statement)]));
  const imports: ts.Statement[] = sf.statements.filter((statement) => ts.isImportDeclaration(statement));
  const props = findPropsTypeStatements(sf, targets);
  const kept = new Set<ts.Statement>([...imports, ...targets, ...props]);
  const budget = capTokens * 3;
  const sizeOf = (statement: ts.Statement): number => {
    const range = ranges.get(statement) ?? { start: 0, end: -1 };
    return charsOf(lines.slice(range.start, range.end + 1));
  };
  let used = [...kept].reduce((sum, statement) => sum + sizeOf(statement), 0);
  const mask: Array<"keep" | "omit" | "free"> = lines.map(() => "free");
  const mark = (statement: ts.Statement, state: "keep" | "omit"): void => {
    const range = ranges.get(statement);
    if (range) {
      for (let line = range.start; line <= range.end; line += 1) {
        mask[line] = state;
      }
    }
  };

  if (used > budget) {
    // Step 6: imports, then the first lines of the target until the cap.
    used = imports.reduce((sum, statement) => sum + sizeOf(statement), 0);
    for (const statement of sf.statements) {
      mark(statement, imports.includes(statement) ? "keep" : "omit");
    }
    const targetLines = [...targets]
      .flatMap((statement) => {
        const range = ranges.get(statement) ?? { start: 0, end: -1 };
        return Array.from({ length: range.end - range.start + 1 }, (_, index) => range.start + index);
      })
      .sort((a, b) => a - b);
    for (const line of targetLines) {
      const size = (lines[line] ?? "").length + 1;
      if (used + size > budget) {
        break;
      }
      mask[line] = "keep";
      used += size;
    }
  } else {
    let full = false;
    for (const statement of sf.statements) {
      if (kept.has(statement)) {
        mark(statement, "keep");
        continue;
      }
      const size = sizeOf(statement);
      if (!full && used + size <= budget) {
        used += size;
        mark(statement, "keep");
      } else {
        full = true;
        mark(statement, "omit");
      }
    }
  }
  return emitMasked(lines, mask);
}

/** Blank lines between two omitted regions join the omitted run; every run becomes one marker line. */
function emitMasked(lines: readonly string[], mask: Array<"keep" | "omit" | "free">): TruncatedText {
  const resolved = mask.map((state, index) => {
    if (state !== "free") {
      return state;
    }
    const before = mask
      .slice(0, index)
      .reverse()
      .find((s) => s !== "free");
    const after = mask.slice(index + 1).find((s) => s !== "free");
    return before === "omit" && (after === undefined || after === "omit") ? "omit" : "keep";
  });
  const out: string[] = [];
  let run = 0;
  let omitted = 0;
  resolved.forEach((state, index) => {
    if (state === "omit") {
      run += 1;
      omitted += 1;
      return;
    }
    if (run > 0) {
      out.push(codeMarker(run));
      run = 0;
    }
    out.push(lines[index] ?? "");
  });
  if (run > 0) {
    out.push(codeMarker(run));
  }
  return { text: out.join("\n"), totalLines: lines.length, omittedLines: omitted };
}

/** 0-based first line (including leading comments) and last line of a top-level statement. */
function statementLines(sf: ts.SourceFile, statement: ts.Statement): { start: number; end: number } {
  let position = statement.getFullStart();
  const tokenStart = statement.getStart(sf);
  while (position < tokenStart && /\s/.test(sf.text.charAt(position))) {
    position += 1;
  }
  return {
    start: sf.getLineAndCharacterOfPosition(position).line,
    end: sf.getLineAndCharacterOfPosition(statement.getEnd()).line
  };
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

function declaresName(statement: ts.Statement, name: string): boolean {
  if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name?.text === name) {
    return true;
  }
  return (
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some((d) => ts.isIdentifier(d.name) && d.name.text === name)
  );
}

/** The statements that provide `exportName`, plus the local declarations they export. */
function findTargetStatements(sf: ts.SourceFile, exportName: string): Set<ts.Statement> {
  const targets = new Set<ts.Statement>();
  const localNames = new Set<string>();
  for (const statement of sf.statements) {
    const isExported = hasModifier(statement, ts.SyntaxKind.ExportKeyword);
    const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
    if (exportName === "default") {
      if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && isExported && isDefault) {
        targets.add(statement);
      } else if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
        targets.add(statement);
        collectIdentifiers(statement.expression, localNames);
      }
    } else if (isExported && declaresName(statement, exportName)) {
      targets.add(statement);
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier === undefined &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === exportName) {
          targets.add(statement);
          localNames.add((element.propertyName ?? element.name).text);
        }
      }
    }
  }
  for (const statement of sf.statements) {
    if ([...localNames].some((name) => declaresName(statement, name))) {
      targets.add(statement);
    }
  }
  return targets;
}

/** `export default X` → X; `export default memo(X)` → X (identifiers in call arguments). */
function collectIdentifiers(expression: ts.Expression, names: Set<string>): void {
  if (ts.isIdentifier(expression)) {
    names.add(expression.text);
  } else if (ts.isCallExpression(expression)) {
    for (const argument of expression.arguments) {
      collectIdentifiers(argument, names);
    }
  } else if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression)) {
    collectIdentifiers(expression.expression, names);
  }
}

function typeReferenceNames(node: ts.Node, names: Set<string>): void {
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      names.add(ts.isIdentifier(child.typeName) ? child.typeName.text : child.typeName.right.text);
    } else if (ts.isExpressionWithTypeArguments(child) && ts.isIdentifier(child.expression)) {
      names.add(child.expression.text); // interface X extends Y
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
}

/**
 * Local interfaces / type aliases referenced in the target's parameter lists (and the type annotations or type
 * arguments of its wrapper), one level plus their own local references (depth ≤ 2).
 */
function findPropsTypeStatements(sf: ts.SourceFile, targets: ReadonlySet<ts.Statement>): Set<ts.Statement> {
  const localTypes = new Map<string, ts.Statement>();
  for (const statement of sf.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      localTypes.set(statement.name.text, statement);
    }
  }
  const level1 = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      for (const parameter of node.parameters) {
        typeReferenceNames(parameter, level1);
      }
    }
    if (ts.isVariableDeclaration(node) && node.type) {
      typeReferenceNames(node.type, level1);
    }
    if (ts.isCallExpression(node)) {
      for (const typeArgument of node.typeArguments ?? []) {
        typeReferenceNames(typeArgument, level1);
      }
    }
    if (ts.isClassDeclaration(node)) {
      for (const clause of node.heritageClauses ?? []) {
        typeReferenceNames(clause, level1);
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const target of targets) {
    visit(target);
  }
  const found = new Set<ts.Statement>();
  const level2 = new Set<string>();
  for (const name of level1) {
    const declaration = localTypes.get(name);
    if (declaration) {
      found.add(declaration);
      typeReferenceNames(declaration, level2);
    }
  }
  for (const name of level2) {
    const declaration = localTypes.get(name);
    if (declaration) {
      found.add(declaration);
    }
  }
  return found;
}

/** Truncates a unified diff: header and whole hunks while within the cap, then `[truncated N lines]` (09 §5.4.2). */
export function truncateDiff(diff: string, capTokens: number): string {
  return truncateDiffDetailed(diff, capTokens).text;
}

export function truncateDiffDetailed(diff: string, capTokens: number): TruncatedText {
  const lines = splitLines(diff);
  const text = lines.join("\n");
  if (estimateTokens(text) <= capTokens) {
    return { text, totalLines: lines.length, omittedLines: 0 };
  }
  const budget = capTokens * 3 - listMarker(lines.length).length - 1;
  const groups: string[][] = [[]];
  for (const line of lines) {
    if (line.startsWith("@@")) {
      groups.push([]);
    }
    groups.at(-1)?.push(line);
  }
  const kept: string[] = [];
  let used = 0;
  for (const group of groups) {
    const size = charsOf(group);
    if (used + size <= budget) {
      kept.push(...group);
      used += size;
      continue;
    }
    for (const line of group) {
      if (used + line.length + 1 > budget) {
        break;
      }
      kept.push(line);
      used += line.length + 1;
    }
    break;
  }
  const omitted = lines.length - kept.length;
  return { text: [...kept, listMarker(omitted)].join("\n"), totalLines: lines.length, omittedLines: omitted };
}

// ---------------------------------------------------------------------------------------------------------------
// Composite sections (child elements built by this file; their contents are escaped here)
// ---------------------------------------------------------------------------------------------------------------

/** One child element of a composite section. */
export interface SectionItem {
  tag: string;
  attributes: Record<string, string>;
  content: string;
  marker: TruncationMarker;
  maxLines?: number;
}

function openTag(tag: string, attributes: Record<string, string>): string {
  const rendered = Object.entries(attributes)
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join("");
  return `<${tag}${rendered}>`;
}

/**
 * Child elements within the cap: whole items while they fit, the next one cut to the remaining budget, then a
 * `[truncated N lines]` line for everything left. `trailer` lines follow the items when they fit.
 */
export function composeItems(
  items: readonly SectionItem[],
  capTokens: number,
  trailer: readonly string[] = []
): TruncatedText {
  const prepared = items.map((item) => {
    const escaped = escapeBody(item.content).text;
    const capped = truncateLinesDetailed(escaped, item.maxLines ?? Number.POSITIVE_INFINITY, item.marker);
    return { item, capped, open: openTag(item.tag, item.attributes), close: `</${item.tag}>` };
  });
  const totalLines = prepared.reduce((sum, p) => sum + p.capped.totalLines, 0) + trailer.length;
  let omitted = prepared.reduce((sum, p) => sum + p.capped.omittedLines, 0);
  const budget = capTokens * 3;
  const out: string[] = [];
  let used = 0;
  let index = 0;
  for (; index < prepared.length; index += 1) {
    const p = prepared[index];
    if (p === undefined) {
      break;
    }
    const block = [p.open, p.capped.text, p.close];
    const size = charsOf(block);
    if (used + size <= budget) {
      out.push(...block);
      used += size;
      continue;
    }
    const remaining = budget - used - charsOf([p.open, p.close]);
    if (remaining > 200) {
      const cut = truncateToTokens(p.capped.text, Math.floor(remaining / 3), p.item.marker);
      out.push(p.open, cut.text, p.close);
      used += charsOf([p.open, cut.text, p.close]);
      omitted += cut.omittedLines;
      index += 1;
    }
    break;
  }
  const rest = prepared.slice(index).reduce((sum, p) => sum + p.capped.totalLines - p.capped.omittedLines, 0);
  if (rest > 0) {
    omitted += rest;
    out.push(listMarker(rest));
  } else if (trailer.length > 0 && used + charsOf(trailer) <= budget) {
    out.push(...trailer);
  } else if (trailer.length > 0) {
    omitted += trailer.length;
    out.push(listMarker(trailer.length));
  }
  return { text: out.join("\n"), totalLines, omittedLines: omitted };
}

// ---------------------------------------------------------------------------------------------------------------
// Section drafts and the budget
// ---------------------------------------------------------------------------------------------------------------

/** A section before budgeting: renders its body for any token cap. */
export interface SectionDraft {
  id: SectionId;
  attributes: Record<string, string>;
  limit: SectionLimit;
  originalLines: number;
  render(capTokens: number): TruncatedText;
}

function toSection(draft: SectionDraft, capTokens: number): PromptSection {
  const rendered = draft.render(capTokens);
  return {
    id: draft.id,
    tag: SECTION_TAGS[draft.id],
    attributes: draft.attributes,
    body: rendered.text,
    originalLines: draft.originalLines,
    truncatedLines: rendered.omittedLines,
    tokens: estimateTokens(rendered.text)
  };
}

function droppedSection(draft: SectionDraft): PromptSection {
  const body = listMarker(draft.originalLines);
  return {
    id: draft.id,
    tag: SECTION_TAGS[draft.id],
    attributes: {},
    body,
    originalLines: draft.originalLines,
    truncatedLines: draft.originalLines,
    tokens: estimateTokens(body),
    dropped: true
  };
}

/**
 * Limits of a component source section (09 §5.4.1, §5.4.3): the primary source (head, or base for removed
 * components) uses the head_source row; a modified component's base source uses the base_source row (min 0,
 * shrunk third) when code_diff is present, else min 3 000 and shrunk last with the head source.
 */
export function sourceSectionLimit(role: "primary" | "secondary", codeDiffPresent: boolean): SectionLimit {
  if (role === "primary") {
    return HARNESS_SECTION_LIMITS.head_source;
  }
  return codeDiffPresent
    ? HARNESS_SECTION_LIMITS.base_source
    : { ...HARNESS_SECTION_LIMITS.base_source, minTokens: 3_000, shrinkOrder: 9 };
}

const PROMPT_ORDER: readonly SectionId[] = [
  "head_source",
  "base_source",
  "code_diff",
  "direct_imports",
  "referenced_types",
  "call_sites",
  "stories_tests",
  "changed_dependencies",
  "app_entry",
  "dependencies",
  "global_styles"
];

/** Outcome of the budget algorithm. */
export interface BudgetedSections {
  sections: PromptSection[];
  totalTokens: number;
  overBudget: boolean;
}

/**
 * The 09 §5.4.3 budget algorithm: every section at its own cap, then shrink in `shrinkOrder` (1 → 9) to the
 * section's minimum or drop it (min 0) until the rendered prompt fits `budget`.
 *
 * @param measure - Estimated tokens of the whole user prompt for a section list (fixed template text included).
 */
export function applyBudget(
  drafts: readonly SectionDraft[],
  measure: (sections: PromptSection[]) => number,
  budget: number
): BudgetedSections {
  const sections = drafts.map((draft) => toSection(draft, draft.limit.capTokens));
  let total = measure(sections);
  const shrinkable = drafts
    .map((draft, index) => ({ draft, index }))
    .filter(({ draft }) => draft.limit.shrinkOrder !== null)
    .sort((a, b) => (a.draft.limit.shrinkOrder ?? 0) - (b.draft.limit.shrinkOrder ?? 0));
  for (const { draft, index } of shrinkable) {
    if (total <= budget) {
      break;
    }
    const current = sections[index];
    if (current === undefined) {
      continue;
    }
    const target = Math.max(draft.limit.minTokens, current.tokens - (total - budget));
    if (target >= current.tokens) {
      continue;
    }
    sections[index] = target === 0 ? droppedSection(draft) : toSection(draft, target);
    total = measure(sections);
  }
  return { sections, totalTokens: total, overBudget: total > budget };
}

const LIBRARIES_OF_INTEREST: readonly string[] = [
  "react",
  "react-dom",
  "react-router",
  "react-router-dom",
  "@tanstack/react-query",
  "react-query",
  "swr",
  "@apollo/client",
  "urql",
  "redux",
  "@reduxjs/toolkit",
  "react-redux",
  "zustand",
  "jotai",
  "recoil",
  "mobx-react-lite",
  "react-i18next",
  "i18next",
  "react-intl",
  "styled-components",
  "@emotion/react",
  "@mui/material",
  "@chakra-ui/react",
  "@mantine/core",
  "antd",
  "@radix-ui/*",
  "@headlessui/react",
  "framer-motion",
  "react-hook-form",
  "formik",
  "next-themes",
  "@sentry/react",
  "posthog-js",
  "firebase",
  "@supabase/supabase-js"
];

function isLibraryOfInterest(name: string): boolean {
  return LIBRARIES_OF_INTEREST.some((pattern) =>
    pattern.endsWith("/*") ? name.startsWith(pattern.slice(0, -1)) : name === pattern
  );
}

const DEPENDENCY_GROUPS = ["dependencies", "peerDependencies", "devDependencies"] as const;
const DEPENDENCY_MAX_ENTRIES = 200;
const UNRESOLVED_TYPES_MAX = 30;
const CALL_SITES_LIMIT = 3;
const CHANGED_DEPENDENCIES_MAX_DEPTH = 3;
const STATUS_NAMES = { A: "added", M: "modified", D: "deleted", R: "renamed" } as const;
const SCRIPT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;
const APP_FILE = /^App\.(t|j)sx?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Stories / tests discovery candidates of one component file (09 §5.3.1). */
export function storyAndTestCandidates(filePath: string): { stories: string[]; tests: string[] } {
  const dir = path.posix.dirname(filePath);
  const base = path.posix.basename(filePath).replace(/\.[^.]+$/, "");
  const stem = base === "index" ? path.posix.basename(dir) : base;
  const join = (...parts: string[]): string => path.posix.normalize(path.posix.join(dir, ...parts));
  const stories: string[] = [];
  const tests: string[] = [];
  for (const pattern of [
    (ext: string) => join(`${stem}.stories${ext}`),
    (ext: string) => join(`${stem}.story${ext}`),
    (ext: string) => join("__stories__", `${stem}.stories${ext}`),
    (ext: string) => join("stories", `${stem}.stories${ext}`)
  ]) {
    stories.push(...SCRIPT_EXTENSIONS.map(pattern));
  }
  for (const pattern of [
    (ext: string) => join(`${stem}.test${ext}`),
    (ext: string) => join(`${stem}.spec${ext}`),
    (ext: string) => join("__tests__", `${stem}.test${ext}`),
    (ext: string) => join("__tests__", `${stem}.spec${ext}`),
    (ext: string) => join("__tests__", `${stem}${ext}`)
  ]) {
    tests.push(...SCRIPT_EXTENSIONS.map(pattern));
  }
  return { stories, tests };
}

/** Merged view of one specifier across both sides (09 §5.3 item 3). */
export interface MergedImport {
  specifier: string;
  kind: DirectImport["kind"];
  resolvedPath: string | null;
  resolvedSide: WorktreeSide;
  names: Set<string>;
  typeOnly: boolean;
  sideEffectOnly: boolean;
  sides: Set<WorktreeSide>;
}

export function mergeDirectImports(imports: { base: DirectImport[]; head: DirectImport[] }): MergedImport[] {
  const merged = new Map<string, MergedImport>();
  for (const side of ["head", "base"] as const) {
    for (const entry of imports[side]) {
      const names = [
        ...(entry.defaultImport ? ["default"] : []),
        ...entry.namedImports,
        ...(entry.namespaceImport ? ["* (namespace)"] : [])
      ];
      const existing = merged.get(entry.specifier);
      if (existing) {
        names.forEach((name) => existing.names.add(name));
        existing.typeOnly = existing.typeOnly && entry.typeOnly;
        existing.sideEffectOnly = existing.sideEffectOnly && entry.sideEffectOnly;
        existing.sides.add(side);
        continue;
      }
      merged.set(entry.specifier, {
        specifier: entry.specifier,
        kind: entry.kind,
        resolvedPath: entry.resolvedPath,
        resolvedSide: side,
        names: new Set(names),
        typeOnly: entry.typeOnly,
        sideEffectOnly: entry.sideEffectOnly,
        sides: new Set([side])
      });
    }
  }
  return [...merged.values()];
}

/** Purpose and state allowance of a package (16 §8.6.2), from HarnessGenerationService's options. */
export interface HarnessContextOptions {
  purpose: "change" | "library";
  stateAllowance: number;
}

/** Builds the context package of one candidate (09 §5.3). Shared sections are memoised per side. */
export class HarnessContextBuilder {
  private readonly shared = new Map<WorktreeSide, Promise<SectionDraft[]>>();
  private readonly log: Logger;

  constructor(
    private readonly ctx: Pick<PipelineContext, "workspace" | "repository" | "library">,
    private readonly queries: ComponentSourceQueries,
    private readonly fsReader: SafeFileReader = new SafeFileReader(ctx.workspace)
  ) {
    this.log = createLogger("pipeline.harness", { visualizationId: ctx.workspace.visualizationId });
  }

  /**
   * Assembles and budgets the context package.
   *
   * @param options - 16 §8.6.2: purpose and state allowance; default change review with the repository's allowance.
   *   With `purpose: "library"` the caller passes a head-only (`added`) candidate, so no diff sections exist.
   * @throws Error when the component file exists on neither side (the caller records a context_error).
   */
  async build(candidate: ComponentCandidate, options?: HarnessContextOptions): Promise<HarnessContextPackage> {
    const paths = await this.queries.componentPaths(candidate.filePath);
    const sidesPresent = { base: paths.base !== null, head: paths.head !== null };
    if (!sidesPresent.base && !sidesPresent.head) {
      throw new Error(`${candidate.filePath} does not exist on the base or the head side.`);
    }
    this.checkSides(candidate, sidesPresent);
    const preferred: WorktreeSide = candidate.changeKind === "removed" ? "base" : "head";
    const sourceSide: WorktreeSide = sidesPresent[preferred] ? preferred : preferred === "head" ? "base" : "head";
    const sourcePath = paths[sourceSide] ?? candidate.filePath;
    const viteRootRel = viteRootRelOf(this.ctx.repository.viteConfigPath);
    const importTarget = { ...candidate, filePath: sourcePath };
    const directImports = {
      base: paths.base !== null ? await this.queries.getDirectImports(paths.base, "base") : [],
      head: paths.head !== null ? await this.queries.getDirectImports(paths.head, "head") : []
    };

    const drafts: SectionDraft[] = [];
    const add = async (id: SectionId, make: () => Promise<SectionDraft | SectionDraft[] | null>): Promise<void> => {
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
    const primaryId: SectionId = sourceSide === "head" ? "head_source" : "base_source";
    await add(primaryId, () => this.sourceDraft(primaryId, sourceSide, sourcePath, candidate, true, false));
    if (sourceSide === "head" && candidate.changeKind === "modified" && paths.base !== null) {
      await add("base_source", () =>
        this.sourceDraft("base_source", "base", paths.base ?? candidate.filePath, candidate, false, hasDiff)
      );
    }
    if (hasDiff) {
      await add("code_diff", () => Promise.resolve(this.diffDraft(candidate)));
    }
    await add("direct_imports", () => this.directImportsDraft(directImports));
    await add("referenced_types", () => this.typesDraft(sourcePath, candidate.exportName, sourceSide));
    await add("call_sites", () => this.callSitesDraft(sourcePath, candidate.exportName, sourceSide));
    await add("stories_tests", () => this.storiesDraft(sourcePath, sourceSide));
    await add("changed_dependencies", () => this.dependencyDiffsDraft(candidate, paths, sourcePath, sourceSide));
    await add("app_entry", () => this.sharedDrafts(sourceSide));
    drafts.sort((a, b) => PROMPT_ORDER.indexOf(a.id) - PROMPT_ORDER.indexOf(b.id));

    const pkg: HarnessContextPackage = {
      candidate,
      sourceSide,
      sidesPresent,
      paths,
      viteRootRel,
      targetImportPath: targetImportPath(sourcePath, viteRootRel),
      targetImportStatement: targetImportStatement(importTarget, viteRootRel),
      directImports,
      sections: [],
      estimatedTokens: 0,
      purpose: options?.purpose ?? "change",
      stateAllowance: options?.stateAllowance ?? this.ctx.library.stateAllowance
    };
    const budgeted = applyBudget(
      drafts,
      (sections) => estimateTokens(renderHarnessUserPrompt({ ...pkg, sections }).text),
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
        componentId: candidate.componentId,
        sections: pkg.sections.map((s) => ({ id: s.id, tokens: s.tokens, truncatedLines: s.truncatedLines })),
        totalTokens: pkg.estimatedTokens
      },
      "Harness context built"
    );
    return pkg;
  }

  private checkSides(candidate: ComponentCandidate, present: { base: boolean; head: boolean }): void {
    const expected = {
      modified: { base: true, head: true },
      affected_parent: { base: true, head: true },
      added: { base: false, head: true },
      removed: { base: true, head: false },
      replaced: { base: true, head: true }, // 00 §17: harnesses are built per side, as removed + added
      rechecked: { base: true, head: true } // 16 E11: unchanged component re-rendered on both sides
    }[candidate.changeKind];
    if (expected.base !== present.base || expected.head !== present.head) {
      this.log.warn(
        {
          event: "harness.context.side_mismatch",
          componentId: candidate.componentId,
          changeKind: candidate.changeKind,
          basePresent: present.base,
          headPresent: present.head
        },
        "Component presence differs from its change kind; the existence check wins"
      );
    }
  }

  private async sourceDraft(
    id: SectionId,
    side: WorktreeSide,
    filePath: string,
    candidate: ComponentCandidate,
    primary: boolean,
    diffPresent: boolean
  ): Promise<SectionDraft | null> {
    const source = await this.fsReader.read(side, filePath);
    if (source === null) {
      return null;
    }
    const lines = splitLines(source).length;
    const limit = sourceSectionLimit(primary ? "primary" : "secondary", diffPresent);
    const attributes: Record<string, string> = { side, path: filePath, lines: String(lines) };
    if (primary && candidate.changeKind === "removed") {
      attributes.status = "removed in head";
    }
    return {
      id,
      attributes,
      limit,
      originalLines: lines,
      render: (cap) => truncateSourceDetailed(source, candidate.exportName, cap)
    };
  }

  private diffDraft(candidate: ComponentCandidate): SectionDraft {
    const diff = candidate.codeDiff ?? "";
    return {
      id: "code_diff",
      attributes: { path: candidate.filePath },
      limit: HARNESS_SECTION_LIMITS.code_diff,
      originalLines: splitLines(diff).length,
      render: (cap) => truncateDiffDetailed(diff, cap)
    };
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
    const text = lines.join("\n");
    const limit = HARNESS_SECTION_LIMITS.direct_imports;
    return {
      id: "direct_imports",
      attributes: {},
      limit,
      originalLines: lines.length,
      render: (cap) => truncateToTokens(text, cap, listMarker, limit.maxLines)
    };
  }

  private async importLine(entry: MergedImport): Promise<string> {
    const sideNote = entry.sides.size === 2 ? "" : entry.sides.has("head") ? " [head only]" : " [base only]";
    const head = `- "${entry.specifier}"`;
    if (entry.kind === "style" || entry.kind === "asset") {
      return `${head} [${entry.kind} — leave untouched]${sideNote}`;
    }
    if (entry.typeOnly) {
      return `${head} [type-only — no mock needed]${sideNote}`;
    }
    let label: string;
    if (entry.kind === "package") {
      label = "[package]";
    } else if (entry.resolvedPath === null) {
      label = "[unresolved]";
    } else {
      label = `[${entry.kind} → ${entry.resolvedPath}]`;
    }
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
    const limit = HARNESS_SECTION_LIMITS.referenced_types;
    const sources = result.sources.slice(0, limit.maxItems);
    if (!result.found || (sources.length === 0 && result.unresolved.length === 0)) {
      return null;
    }
    const items: SectionItem[] = sources.map((source) => ({
      tag: "type_source",
      attributes: { name: source.name, path: source.filePath, lines: `${source.startLine}-${source.endLine}` },
      content: source.text,
      marker: codeMarker,
      ...(limit.maxLinesPerItem !== undefined ? { maxLines: limit.maxLinesPerItem } : {})
    }));
    const trailer =
      result.unresolved.length > 0
        ? [`external or unknown types: ${result.unresolved.slice(0, UNRESOLVED_TYPES_MAX).join(", ")}`]
        : [];
    return this.itemsDraft("referenced_types", items, limit, trailer);
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
    return this.itemsDraft("call_sites", items, HARNESS_SECTION_LIMITS.call_sites);
  }

  private async storiesDraft(filePath: string, side: WorktreeSide): Promise<SectionDraft | null> {
    const { stories, tests } = storyAndTestCandidates(filePath);
    const limit = HARNESS_SECTION_LIMITS.stories_tests;
    const items: SectionItem[] = [];
    for (const [tag, candidates] of [
      ["story", stories],
      ["test", tests]
    ] as const) {
      for (const candidate of candidates) {
        const text = await this.fsReader.read(side, candidate);
        if (text !== null) {
          items.push({
            tag,
            attributes: { path: candidate },
            content: text,
            marker: codeMarker,
            ...(limit.maxLinesPerItem !== undefined ? { maxLines: limit.maxLinesPerItem } : {})
          });
          break;
        }
      }
    }
    return items.length > 0 ? this.itemsDraft("stories_tests", items, limit) : null;
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
    const limit = HARNESS_SECTION_LIMITS.changed_dependencies;
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
    return this.itemsDraft("changed_dependencies", items, limit);
  }

  private itemsDraft(
    id: SectionId,
    items: SectionItem[],
    limit: SectionLimit,
    trailer: readonly string[] = []
  ): SectionDraft {
    return {
      id,
      attributes: {},
      limit,
      originalLines: items.reduce((sum, item) => sum + splitLines(item.content).length, 0) + trailer.length,
      render: (cap) => composeItems(items, cap, trailer)
    };
  }

  /** app_entry, dependencies, global_styles: computed once per side and memoised (09 §5.3). */
  private sharedDrafts(side: WorktreeSide): Promise<SectionDraft[]> {
    let drafts = this.shared.get(side);
    if (drafts === undefined) {
      drafts = this.buildSharedDrafts(side);
      this.shared.set(side, drafts);
    }
    return drafts;
  }

  private async buildSharedDrafts(side: WorktreeSide): Promise<SectionDraft[]> {
    const drafts: SectionDraft[] = [];
    for (const [id, make] of [
      ["app_entry", () => this.appEntryDraft(side)],
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

  private async appEntryDraft(side: WorktreeSide): Promise<SectionDraft | null> {
    const entryPath = this.ctx.repository.entryFilePath;
    if (entryPath === null) {
      return null;
    }
    const entry = await this.fsReader.read(side, entryPath);
    if (entry === null) {
      return null;
    }
    const limit = HARNESS_SECTION_LIMITS.app_entry;
    const perFile = limit.maxLinesPerItem ?? Number.POSITIVE_INFINITY;
    const parts = [truncateLinesDetailed(entry, perFile, codeMarker)];
    const appImport = (await this.queries.getDirectImports(entryPath, side)).find(
      (entryImport) =>
        (entryImport.kind === "relative" || entryImport.kind === "alias") &&
        entryImport.resolvedPath !== null &&
        APP_FILE.test(path.posix.basename(entryImport.resolvedPath))
    );
    let appPath: string | null = null;
    if (appImport?.resolvedPath) {
      const app = await this.fsReader.read(side, appImport.resolvedPath);
      if (app !== null) {
        appPath = appImport.resolvedPath;
        parts.push(truncateLinesDetailed(app, perFile, codeMarker));
      }
    }
    const [entryPart, appPart] = parts;
    const text = [entryPart?.text ?? "", ...(appPart && appPath ? [`// file: ${appPath}`, appPart.text] : [])].join(
      "\n"
    );
    const originalLines = parts.reduce((sum, part) => sum + part.totalLines, 0);
    const preOmitted = parts.reduce((sum, part) => sum + part.omittedLines, 0);
    return {
      id: "app_entry",
      attributes: { path: entryPath },
      limit,
      originalLines,
      render: (cap) => {
        const cut = truncateToTokens(text, cap, codeMarker);
        return { text: cut.text, totalLines: originalLines, omittedLines: preOmitted + cut.omittedLines };
      }
    };
  }

  private async dependenciesDraft(side: WorktreeSide): Promise<SectionDraft | null> {
    const raw = await this.fsReader.read(side, "package.json");
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
        if (isLibraryOfInterest(name)) {
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
      limit: HARNESS_SECTION_LIMITS.dependencies,
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
    const limit = HARNESS_SECTION_LIMITS.global_styles;
    const listed = truncateLinesDetailed(stylePaths.join("\n"), limit.maxLines ?? stylePaths.length, listMarker);
    const text = `${listed.text}\n(already loaded by the render page; never import these)`;
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
