/**
 * StructuralDiffService (11 §5.3): the JSX half of the `diffing` stage.
 *
 * When pixels cannot explain a change (a side failed to render, or the pixel comparison itself failed) it compares
 * the component's JSX between base and head with the TypeScript AST (via 08's ComponentDetector) and persists a
 * `StructuralChange[]` in `visualization_components.structural_diff`. Pure helpers `buildJsxTree`, `diffJsxTrees`
 * and `classNameTokens` are exported for tests.
 */
import ts from "typescript";
import {
  STRUCTURAL_DIFF_MAX_CHANGES,
  STRUCTURAL_DIFF_MAX_DEPTH,
  STRUCTURAL_DIFF_MAX_NODES,
  STRUCTURAL_VALUE_MAX_CHARS
} from "../../../config-consts";
import { Table } from "../../../enums";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type ComponentRenderResult,
  type ImageDiffResult,
  type PipelineContext,
  type StructuralChange,
  type WorktreeSide
} from "../../../types/visualization-pipeline";
import { QueryHandler, createLogger, type ApiResponse } from "../../../utilities";
import { readConfinedText } from "./change-source";
import { candidateBaseExport, candidateBasePath, candidateHeadPath } from "./replaced-components";
import { ComponentDetector, cleanJsxText, syntaxErrorCount } from "./component-detector";
import { MISSING_ON_BOTH_SIDES, classifyRender } from "./image-diff-service";

const STAGE = "diffing" as const;

/** What 07 passes to compare() (11 §5.1). */
export interface StructuralDiffInput {
  renders: ComponentRenderResult[];
  diffs: ImageDiffResult[];
  analysis: ChangeAnalysisResult;
}

/** One component's outcome. `changes` is null when the structural diff did not run. */
export interface StructuralDiffOutcome {
  componentId: number;
  ran: boolean;
  changes: StructuralChange[] | null;
  truncated: boolean;
  note: string | null;
}

/** Collaborators; every field defaults to the real implementation. */
export interface StructuralDiffDeps {
  detector: ComponentDetector;
  createQueryHandler(): QueryHandler;
  /** Default: 08's readConfinedText (realpath confinement, 512 KB, binary guard). */
  readSource(sideRoot: string, repoPath: string): Promise<string | null>;
}

// ---------------------------------------------------------------------------------------------------------------
// Tree model (11 §5.3.3)
// ---------------------------------------------------------------------------------------------------------------

export type JsxTreeNode = JsxElementNode | JsxTextNode;

export interface JsxElementNode {
  kind: "element";
  tag: string;
  key: string | null;
  attributes: Map<string, AttributeValue>;
  children: JsxTreeNode[];
}

export interface JsxTextNode {
  kind: "text";
  text: string;
}

export interface AttributeValue {
  text: string;
  tokens: string[] | null;
}

/** Shared node budget for one side (11 §5.3.3). `truncated` is set when depth or node limits stop expansion. */
export interface JsxBudget {
  nodes: number;
  truncated: boolean;
}

/** A fresh budget for one side. */
export function newJsxBudget(): JsxBudget {
  return { nodes: 0, truncated: false };
}

const CLASS_HELPERS = new Set(["cn", "clsx", "classnames", "classNames", "cx", "twMerge", "twJoin"]);
const FRAGMENT_TAGS = new Set(["Fragment", "React.Fragment"]);

function capValue(value: string): string {
  return value.length <= STRUCTURAL_VALUE_MAX_CHARS ? value : `${value.slice(0, STRUCTURAL_VALUE_MAX_CHARS - 1)}…`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function sourceOf(node: ts.Node, sf: ts.SourceFile): string {
  return collapse(node.getText(sf));
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
  let current = expr;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isStaticString(expr: ts.Expression): expr is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr);
}

function rendersNothing(expr: ts.Expression): boolean {
  return (
    expr.kind === ts.SyntaxKind.NullKeyword ||
    expr.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isIdentifier(expr) && expr.text === "undefined")
  );
}

function isJsxNode(expr: ts.Expression): expr is ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment {
  return ts.isJsxElement(expr) || ts.isJsxSelfClosingElement(expr) || ts.isJsxFragment(expr);
}

/** Return expressions of a function's own body (nested functions and classes excluded). */
function ownReturns(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Expression[] {
  if (!ts.isBlock(fn.body)) {
    return [fn.body];
  }
  const out: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) || ts.isClassLike(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) {
      out.push(node.expression);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return out;
}

function containsJsx(expr: ts.Expression): boolean {
  const e = unwrapExpression(expr);
  if (isJsxNode(e)) {
    return true;
  }
  if (ts.isConditionalExpression(e)) {
    return containsJsx(e.whenTrue) || containsJsx(e.whenFalse);
  }
  if (ts.isBinaryExpression(e)) {
    return containsJsx(e.left) || containsJsx(e.right);
  }
  if (ts.isCallExpression(e)) {
    return e.arguments.some(
      (arg) => (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) && ownReturns(arg).some(containsJsx)
    );
  }
  return false;
}

function textNode(text: string, budget: JsxBudget): JsxTextNode[] {
  if (budget.nodes >= STRUCTURAL_DIFF_MAX_NODES) {
    budget.truncated = true;
    return [];
  }
  budget.nodes += 1;
  return [{ kind: "text", text: capValue(text) }];
}

/**
 * Expands one JSX-like expression into tree nodes (11 §5.3.3 table). A conditional or logical expression may
 * expand into several nodes; a `.map(() => <Row/>)` call expands to the JSX returned by its callback.
 */
export function buildJsxTree(expr: ts.Expression, sf: ts.SourceFile, budget: JsxBudget, depth = 0): JsxTreeNode[] {
  if (depth > STRUCTURAL_DIFF_MAX_DEPTH) {
    budget.truncated = true;
    return [];
  }
  const e = unwrapExpression(expr);
  if (isJsxNode(e)) {
    const element = buildElement(e, sf, budget, depth);
    return element ? [element] : [];
  }
  if (isStaticString(e)) {
    return textNode(e.text, budget);
  }
  if (rendersNothing(e)) {
    return [];
  }
  if (ts.isConditionalExpression(e)) {
    return [...buildJsxTree(e.whenTrue, sf, budget, depth), ...buildJsxTree(e.whenFalse, sf, budget, depth)];
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return buildJsxTree(e.right, sf, budget, depth);
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [...buildJsxTree(e.left, sf, budget, depth), ...buildJsxTree(e.right, sf, budget, depth)];
    }
  }
  if (ts.isCallExpression(e)) {
    const callbacks = e.arguments.filter(
      (arg): arg is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)
    );
    const returns = callbacks.flatMap((fn) => ownReturns(fn)).filter(containsJsx);
    if (returns.length > 0) {
      return returns.flatMap((ret) => buildJsxTree(ret, sf, budget, depth));
    }
  }
  return textNode(`{${sourceOf(e, sf)}}`, budget);
}

function tagOf(node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment, sf: ts.SourceFile): string {
  if (ts.isJsxFragment(node)) {
    return "Fragment";
  }
  const tagName = ts.isJsxElement(node) ? node.openingElement.tagName : node.tagName;
  const tag = tagName.getText(sf);
  return FRAGMENT_TAGS.has(tag) ? "Fragment" : tag;
}

function buildElement(
  node: ts.JsxElement | ts.JsxSelfClosingElement | ts.JsxFragment,
  sf: ts.SourceFile,
  budget: JsxBudget,
  depth: number
): JsxElementNode | null {
  if (budget.nodes >= STRUCTURAL_DIFF_MAX_NODES) {
    budget.truncated = true;
    return null;
  }
  budget.nodes += 1;
  const element: JsxElementNode = {
    kind: "element",
    tag: tagOf(node, sf),
    key: null,
    attributes: new Map(),
    children: []
  };
  const attributes = ts.isJsxElement(node)
    ? node.openingElement.attributes
    : ts.isJsxSelfClosingElement(node)
      ? node.attributes
      : null;
  for (const property of attributes?.properties ?? []) {
    if (ts.isJsxSpreadAttribute(property)) {
      element.attributes.set(capValue(`{...${sourceOf(property.expression, sf)}}`), { text: "spread", tokens: null });
      continue;
    }
    const name = property.name.getText(sf);
    const text = attributeText(property.initializer, sf);
    if (name === "key") {
      element.key = text;
      continue;
    }
    const tokens = name === "className" || name === "class" ? classNameTokens(property.initializer, sf) : null;
    element.attributes.set(name, { text, tokens });
  }
  if (ts.isJsxSelfClosingElement(node)) {
    return element;
  }
  if (depth + 1 > STRUCTURAL_DIFF_MAX_DEPTH) {
    if (node.children.length > 0) {
      budget.truncated = true;
    }
    return element;
  }
  for (const child of node.children) {
    element.children.push(...buildChild(child, sf, budget, depth + 1));
  }
  return element;
}

function buildChild(child: ts.JsxChild, sf: ts.SourceFile, budget: JsxBudget, depth: number): JsxTreeNode[] {
  if (ts.isJsxText(child)) {
    const text = cleanJsxText(child.text);
    return text === "" ? [] : textNode(text, budget);
  }
  if (ts.isJsxExpression(child)) {
    if (child.expression === undefined) {
      return []; // {/* comment */}
    }
    if (child.dotDotDotToken) {
      return textNode(`{...${sourceOf(child.expression, sf)}}`, budget);
    }
    return buildJsxTree(child.expression, sf, budget, depth);
  }
  return buildJsxTree(child, sf, budget, depth);
}

function attributeText(initializer: ts.JsxAttributeValue | undefined, sf: ts.SourceFile): string {
  if (initializer === undefined) {
    return "true";
  }
  if (ts.isStringLiteral(initializer)) {
    return capValue(initializer.text);
  }
  if (ts.isJsxExpression(initializer)) {
    if (initializer.expression === undefined) {
      return "{}";
    }
    const expression = unwrapExpression(initializer.expression);
    if (isStaticString(expression)) {
      return capValue(expression.text);
    }
    return capValue(`{${sourceOf(initializer.expression, sf)}}`);
  }
  return capValue(`{${sourceOf(initializer, sf)}}`);
}

function splitClasses(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== "");
}

function templateTokens(template: ts.TemplateExpression, sf: ts.SourceFile): string[] {
  const tokens = splitClasses(template.head.text);
  for (const span of template.templateSpans) {
    tokens.push(capValue(`\${${sourceOf(span.expression, sf)}}`), ...splitClasses(span.literal.text));
  }
  return tokens;
}

function helperArgumentTokens(arg: ts.Expression, sf: ts.SourceFile): string[] {
  const e = unwrapExpression(arg);
  if (isStaticString(e)) {
    return splitClasses(e.text);
  }
  if (ts.isTemplateExpression(e)) {
    return templateTokens(e, sf);
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return helperArgumentTokens(e.right, sf);
  }
  if (ts.isConditionalExpression(e)) {
    return [...helperArgumentTokens(e.whenTrue, sf), ...helperArgumentTokens(e.whenFalse, sf)];
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.flatMap((property) => {
      const name = property.name;
      if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
        return splitClasses(name.text);
      }
      return [capValue(`{${sourceOf(property, sf)}}`)];
    });
  }
  if (ts.isArrayLiteralExpression(e)) {
    return e.elements.flatMap((element) => helperArgumentTokens(element, sf));
  }
  return [capValue(`{${sourceOf(e, sf)}}`)];
}

/**
 * Tokens of a `className` / `class` initializer (11 §5.3.3 table), deduplicated (order not significant).
 */
export function classNameTokens(initializer: ts.JsxAttributeValue | undefined, sf: ts.SourceFile): string[] {
  let tokens: string[];
  if (initializer === undefined) {
    tokens = [];
  } else if (ts.isStringLiteral(initializer)) {
    tokens = splitClasses(initializer.text);
  } else if (ts.isJsxExpression(initializer) && initializer.expression !== undefined) {
    const e = unwrapExpression(initializer.expression);
    if (isStaticString(e)) {
      tokens = splitClasses(e.text);
    } else if (ts.isTemplateExpression(e)) {
      tokens = templateTokens(e, sf);
    } else if (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && CLASS_HELPERS.has(e.expression.text)) {
      tokens = e.arguments.flatMap((arg) => helperArgumentTokens(arg, sf));
    } else {
      tokens = [capValue(`{${sourceOf(e, sf)}}`)];
    }
  } else {
    tokens = [capValue(`{${sourceOf(initializer, sf)}}`)];
  }
  return [...new Set(tokens)];
}

// ---------------------------------------------------------------------------------------------------------------
// Diff (11 §5.3.4, §5.3.5)
// ---------------------------------------------------------------------------------------------------------------

/** Result of diffJsxTrees. `truncated` is true when STRUCTURAL_DIFF_MAX_CHANGES was reached. */
export interface JsxTreeDiff {
  changes: StructuralChange[];
  truncated: boolean;
}

class ChangeCollector {
  readonly changes: StructuralChange[] = [];
  truncated = false;

  constructor(private readonly max: number) {}

  /** A method (not a getter) so control-flow narrowing never treats it as constant. */
  isFull(): boolean {
    return this.changes.length >= this.max;
  }

  push(change: StructuralChange): void {
    if (this.isFull()) {
      this.truncated = true;
      return;
    }
    this.changes.push(change);
    if (this.isFull()) {
      this.truncated = true;
    }
  }
}

function join(parent: string, segment: string): string {
  return parent === "" ? segment : `${parent} > ${segment}`;
}

function elementsOf(node: JsxElementNode): JsxElementNode[] {
  return node.children.filter((child): child is JsxElementNode => child.kind === "element");
}

function textsOf(node: JsxElementNode): JsxTextNode[] {
  return node.children.filter((child): child is JsxTextNode => child.kind === "text");
}

/** Segment of each element among its siblings on one side: tag, `{key=…}`, `[i]` for repeated unkeyed tags. */
function segmentsFor(siblings: readonly JsxElementNode[]): Map<JsxElementNode, string> {
  const unkeyedCount = new Map<string, number>();
  for (const sibling of siblings) {
    if (sibling.key === null) {
      unkeyedCount.set(sibling.tag, (unkeyedCount.get(sibling.tag) ?? 0) + 1);
    }
  }
  const seen = new Map<string, number>();
  const out = new Map<JsxElementNode, string>();
  for (const sibling of siblings) {
    if (sibling.key !== null) {
      out.set(sibling, `${sibling.tag}{key=${sibling.key}}`);
      continue;
    }
    const index = seen.get(sibling.tag) ?? 0;
    seen.set(sibling.tag, index + 1);
    out.set(sibling, (unkeyedCount.get(sibling.tag) ?? 0) > 1 ? `${sibling.tag}[${String(index)}]` : sibling.tag);
  }
  return out;
}

function rootSegment(node: JsxElementNode): string {
  return node.key === null ? node.tag : `${node.tag}{key=${node.key}}`;
}

/** "tag + key + index" child matching (11 §5.3.5 matchChildren). Returns head → base pairs. */
function matchChildren(
  base: readonly JsxElementNode[],
  head: readonly JsxElementNode[]
): { pairs: Map<JsxElementNode, JsxElementNode>; removed: JsxElementNode[] } {
  const pairs = new Map<JsxElementNode, JsxElementNode>();
  const usedBase = new Set<JsxElementNode>();
  for (const h of head) {
    if (h.key === null) {
      continue;
    }
    const b = base.find((candidate) => !usedBase.has(candidate) && candidate.tag === h.tag && candidate.key === h.key);
    if (b) {
      pairs.set(h, b);
      usedBase.add(b);
    }
  }
  const tags = [...new Set(head.map((h) => h.tag))];
  for (const tag of tags) {
    const freeBase = base.filter((b) => b.tag === tag && !usedBase.has(b));
    const freeHead = head.filter((h) => h.tag === tag && !pairs.has(h));
    const count = Math.min(freeBase.length, freeHead.length);
    for (let i = 0; i < count; i += 1) {
      const h = freeHead[i];
      const b = freeBase[i];
      if (h && b) {
        pairs.set(h, b);
        usedBase.add(b);
      }
    }
  }
  return { pairs, removed: base.filter((b) => !usedBase.has(b)) };
}

function sameTokens(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((token) => right.has(token));
}

function diffAttributes(b: JsxElementNode, h: JsxElementNode, path: string, out: ChangeCollector): void {
  const names = [...new Set([...b.attributes.keys(), ...h.attributes.keys()])].sort();
  for (const name of names) {
    if (out.isFull()) {
      return;
    }
    const bv = b.attributes.get(name);
    const hv = h.attributes.get(name);
    if (bv?.text === hv?.text) {
      continue;
    }
    if (bv?.tokens && hv?.tokens && sameTokens(bv.tokens, hv.tokens)) {
      continue; // class order only
    }
    const change: StructuralChange = {
      kind: "attribute_changed",
      path,
      tag: h.tag,
      attribute: name,
      before: bv?.text ?? null,
      after: hv?.text ?? null
    };
    if (bv?.tokens && hv?.tokens) {
      const before = new Set(bv.tokens);
      const after = new Set(hv.tokens);
      change.tokensAdded = [...after].filter((token) => !before.has(token)).sort();
      change.tokensRemoved = [...before].filter((token) => !after.has(token)).sort();
    }
    out.push(change);
  }
}

function diffElementPair(
  b: JsxElementNode,
  h: JsxElementNode,
  parentPath: string,
  segment: { base: string; head: string },
  out: ChangeCollector
): void {
  if (out.isFull()) {
    return;
  }
  if (b.tag !== h.tag) {
    out.push({ kind: "element_removed", path: join(parentPath, segment.base), tag: b.tag });
    out.push({ kind: "element_added", path: join(parentPath, segment.head), tag: h.tag });
    return;
  }
  const path = join(parentPath, segment.head);
  diffAttributes(b, h, path, out);

  const baseTexts = textsOf(b);
  const headTexts = textsOf(h);
  for (let i = 0; i < Math.max(baseTexts.length, headTexts.length) && !out.isFull(); i += 1) {
    const before = baseTexts[i]?.text ?? "";
    const after = headTexts[i]?.text ?? "";
    if (before !== after) {
      out.push({ kind: "text_changed", path: join(path, `#text[${String(i)}]`), before, after });
    }
  }

  const baseChildren = elementsOf(b);
  const headChildren = elementsOf(h);
  const { pairs, removed } = matchChildren(baseChildren, headChildren);
  const headSegments = segmentsFor(headChildren);
  const baseSegments = segmentsFor(baseChildren);
  for (const hc of headChildren) {
    if (out.isFull()) {
      return;
    }
    const headSegment = headSegments.get(hc) ?? hc.tag;
    const bc = pairs.get(hc);
    if (bc) {
      diffElementPair(bc, hc, path, { base: headSegment, head: headSegment }, out);
    } else {
      out.push({ kind: "element_added", path: join(path, headSegment), tag: hc.tag });
    }
  }
  for (const bc of removed) {
    if (out.isFull()) {
      return;
    }
    out.push({ kind: "element_removed", path: join(path, baseSegments.get(bc) ?? bc.tag), tag: bc.tag });
  }
}

/**
 * Diffs the render roots of base and head (11 §5.3.5). Deterministic: document order and sorted attribute names.
 * Only the root of an added/removed subtree is reported. Stops at `maxChanges`.
 */
export function diffJsxTrees(
  baseRoots: readonly JsxElementNode[],
  headRoots: readonly JsxElementNode[],
  maxChanges: number = STRUCTURAL_DIFF_MAX_CHANGES
): JsxTreeDiff {
  const out = new ChangeCollector(maxChanges);
  const n = Math.max(baseRoots.length, headRoots.length);
  for (let i = 0; i < n && !out.isFull(); i += 1) {
    const prefix = n > 1 ? `return[${String(i)}]` : "";
    const b = baseRoots[i];
    const h = headRoots[i];
    if (b && h) {
      diffElementPair(b, h, prefix, { base: rootSegment(b), head: rootSegment(h) }, out);
    } else if (h) {
      out.push({ kind: "element_added", path: join(prefix, rootSegment(h)), tag: h.tag });
    } else if (b) {
      out.push({ kind: "element_removed", path: join(prefix, rootSegment(b)), tag: b.tag });
    }
  }
  return { changes: out.changes, truncated: out.truncated };
}

// ---------------------------------------------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------------------------------------------

type SideRoots = { kind: "roots"; roots: JsxElementNode[]; note: string | null } | { kind: "failed"; note: string };

/** Runs the structural comparison for components without pixel output (11 §5.3.1) and persists it. */
export class StructuralDiffService {
  private readonly deps: StructuralDiffDeps;

  constructor(deps: Partial<StructuralDiffDeps> = {}) {
    this.deps = {
      detector: deps.detector ?? new ComponentDetector(),
      createQueryHandler: deps.createQueryHandler ?? ((): QueryHandler => new QueryHandler()),
      readSource: deps.readSource ?? ((sideRoot, repoPath) => readConfinedText(sideRoot, repoPath))
    };
  }

  /**
   * Compares JSX for every render that has no ImageDiffResult and is not new/deleted/missing on both sides.
   *
   * @returns One outcome per render (`ran: false`, `changes: null` where it did not run).
   * @throws PipelineStepError STRUCTURAL_DIFF_PERSIST_FAILED on a DB failure; the job signal's reason on abort.
   */
  async compare(ctx: PipelineContext, input: StructuralDiffInput): Promise<StructuralDiffOutcome[]> {
    const log = createLogger("structural-diff", { visualizationId: ctx.visualizationId });
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
        `Comparing JSX structure for ${String(toRun.length)} components that could not be compared visually.`
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
          "Structural comparison incomplete"
        );
        await ctx.console.warn(
          STAGE,
          `Could not compare the JSX of ${candidate?.displayName ?? `component #${String(render.componentId)}`}: ${outcome.note}.`
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
        "Component structure compared"
      );
      outcomes.push(outcome);
    }
    log.info(
      { event: "structural_diff.stage.completed", compared: toRun.length, durationMs: Date.now() - startedAt },
      "Structural diff completed"
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
    const base = await this.rootsFor(ctx, "base", basePath, candidateBaseExport(candidate), baseBudget);
    const head = await this.rootsFor(ctx, "head", headPath, candidate.exportName, headBudget);
    if (base.kind === "failed" || head.kind === "failed") {
      const note = [base, head].flatMap((side) => (side.kind === "failed" ? [side.note] : [])).join("; ");
      return { componentId, ran: true, changes: [], truncated: false, note };
    }
    const diff = diffJsxTrees(base.roots, head.roots);
    const notes = [base.note, head.note].filter((note): note is string => note !== null);
    return {
      componentId,
      ran: true,
      changes: diff.changes,
      truncated: diff.truncated || baseBudget.truncated || headBudget.truncated,
      note: notes.length > 0 ? notes.join("; ") : null
    };
  }

  /** Element roots of one side. A side that does not exist for this change kind (`repoPath` null) is empty. */
  private async rootsFor(
    ctx: PipelineContext,
    side: WorktreeSide,
    repoPath: string | null,
    exportName: string,
    budget: JsxBudget
  ): Promise<SideRoots> {
    if (repoPath === null) {
      return { kind: "roots", roots: [], note: null };
    }
    const sideRoot = side === "base" ? ctx.workspace.baseDir : ctx.workspace.headDir;
    const text = await this.deps.readSource(sideRoot, repoPath);
    if (text === null) {
      return { kind: "roots", roots: [], note: `component source not found on ${side}` };
    }
    const sf = this.deps.detector.parse(repoPath, text);
    if (syntaxErrorCount(sf) > 0) {
      return { kind: "failed", note: `could not parse the ${side} source` };
    }
    const resolved = this.deps.detector.findExport(sf, exportName);
    if (resolved === null) {
      return { kind: "roots", roots: [], note: `export ${exportName} not found on ${side}` };
    }
    const roots = this.deps.detector
      .findRenderRoots(resolved)
      .flatMap((expr) => buildJsxTree(expr, sf, budget))
      .filter((node): node is JsxElementNode => node.kind === "element");
    return { kind: "roots", roots, note: null };
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
