/**
 * Angular template → 11's structural tree (15 §5.8.2). Pure: no I/O, no logging.
 *
 * `angularTemplateToTree` maps the `@angular/compiler` template AST to the `JsxTreeNode` model of sheet 11, so
 * `diffJsxTrees` and its path notation are reused unchanged. The template is parsed twice: `parseTemplate` gives the
 * structure (elements, control flow blocks, text), and the raw HTML parser gives every attribute exactly as written
 * (`[class.active]`, `(click)`, `*ngIf`, `#ref`, `i18n-title`), matched to the template nodes by source offset.
 * Template parsing never executes repository code (15 §3.3).
 */
import {
  ASTWithSource,
  Binary,
  Block as HtmlBlock,
  Conditional,
  Element as HtmlElement,
  HtmlParser,
  LiteralArray,
  LiteralMap,
  LiteralPrimitive,
  ParenthesizedExpression,
  TemplateLiteral,
  TmplAstBoundText,
  TmplAstContent,
  TmplAstDeferredBlock,
  TmplAstElement,
  TmplAstForLoopBlock,
  TmplAstIcu,
  TmplAstIfBlock,
  TmplAstLetDeclaration,
  TmplAstSwitchBlock,
  TmplAstTemplate,
  TmplAstText,
  TmplAstUnknownBlock,
  parseTemplate,
  type AST,
  type Attribute as HtmlAttribute,
  type TmplAstBoundAttribute,
  type TmplAstNode
} from "@angular/compiler";
import {
  STRUCTURAL_DIFF_MAX_CHANGES,
  STRUCTURAL_DIFF_MAX_DEPTH,
  STRUCTURAL_DIFF_MAX_NODES,
  STRUCTURAL_VALUE_MAX_CHARS
} from "../../../../config-consts";
import type { StructuralChange } from "../../../../types/visualization-pipeline";
import {
  diffJsxTrees,
  newJsxBudget,
  type AttributeValue,
  type JsxBudget,
  type JsxElementNode,
  type JsxTextNode,
  type JsxTreeDiff,
  type JsxTreeNode
} from "../structural-diff-service";

/** Result of angularTemplateToTree. `parseFailed` is true when the compiler reported errors and produced no nodes. */
export interface AngularTemplateTree {
  nodes: JsxTreeNode[];
  parseFailed: boolean;
  /** Compiler error messages (at most the first 5), also for partial parses. */
  errors: string[];
}

/** Tag of the synthetic root that holds a template's top-level nodes while diffing. Never appears in paths. */
const TEMPLATE_ROOT_TAG = "#template";
const TEMPLATE_ROOT_PREFIX = `${TEMPLATE_ROOT_TAG} > `;
const MAX_REPORTED_ERRORS = 5;
const BOUND_PREFIXES = ["[", "(", "bind-", "on-", "bindon-"];

interface RawAttribute {
  name: string;
  value: string;
  offset: number;
}

/** Per-template lookup tables, keyed by source offset. */
interface BuildContext {
  budget: JsxBudget;
  /** Raw attributes of each element start tag, keyed by the tag's start offset. */
  rawAttributes: Map<number, RawAttribute[]>;
  /** Raw block parameters (`on viewport; prefetch on idle`), keyed by the block's start offset. */
  blockParameters: Map<number, string>;
}

function capValue(value: string): string {
  return value.length <= STRUCTURAL_VALUE_MAX_CHARS ? value : `${value.slice(0, STRUCTURAL_VALUE_MAX_CHARS - 1)}…`;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function splitClasses(text: string): string[] {
  return text.split(/\s+/).filter((token) => token !== "");
}

/** `:svg:path` → `path` (Angular keeps the namespace in element names). */
function stripNamespace(name: string): string {
  const match = /^:[^:]+:(.+)$/.exec(name);
  return match?.[1] ?? name;
}

// ---------------------------------------------------------------------------------------------------------------
// Raw HTML pass (attributes as written, block parameters)
// ---------------------------------------------------------------------------------------------------------------

function collectRaw(source: string, url: string): Pick<BuildContext, "rawAttributes" | "blockParameters"> {
  const rawAttributes = new Map<number, RawAttribute[]>();
  const blockParameters = new Map<number, string>();
  const result = new HtmlParser().parse(source, url, {
    tokenizeExpansionForms: true,
    tokenizeBlocks: true,
    tokenizeLet: true
  });
  const visit = (nodes: readonly unknown[]): void => {
    for (const node of nodes) {
      if (node instanceof HtmlElement) {
        rawAttributes.set(
          node.sourceSpan.start.offset,
          node.attrs.map((attr: HtmlAttribute) => ({
            name: attr.name,
            value: attr.value,
            offset: attr.sourceSpan.start.offset
          }))
        );
        visit(node.children);
      } else if (node instanceof HtmlBlock) {
        const parameters = node.parameters.map((parameter) => parameter.expression).join("; ");
        blockParameters.set(node.sourceSpan.start.offset, parameters);
        visit(node.children);
      }
    }
  };
  visit(result.rootNodes);
  return { rawAttributes, blockParameters };
}

// ---------------------------------------------------------------------------------------------------------------
// Class tokens from an expression AST (11's classNameTokens rules, 15 §5.8.2)
// ---------------------------------------------------------------------------------------------------------------

function astSource(node: AST, source: string): string {
  return collapse(source.slice(node.span.start, node.span.end));
}

function expressionTokens(node: AST, source: string): string[] {
  if (node instanceof ParenthesizedExpression) {
    return expressionTokens(node.expression, source);
  }
  if (node instanceof LiteralPrimitive && typeof node.value === "string") {
    return splitClasses(node.value);
  }
  if (node instanceof TemplateLiteral) {
    const tokens: string[] = [];
    node.elements.forEach((element, index) => {
      tokens.push(...splitClasses(element.text));
      const expression = node.expressions[index];
      if (expression !== undefined) {
        tokens.push(capValue(`\${${astSource(expression, source)}}`));
      }
    });
    return tokens;
  }
  if (node instanceof Binary && node.operation === "&&") {
    return expressionTokens(node.right, source);
  }
  if (node instanceof Conditional) {
    return [...expressionTokens(node.trueExp, source), ...expressionTokens(node.falseExp, source)];
  }
  if (node instanceof LiteralMap) {
    return node.keys.flatMap((key) =>
      key.kind === "property"
        ? splitClasses(key.key)
        : [capValue(`{${collapse(source.slice(key.span.start, key.span.end))}}`)]
    );
  }
  if (node instanceof LiteralArray) {
    return node.expressions.flatMap((expression) => expressionTokens(expression, source));
  }
  return [capValue(`{${astSource(node, source)}}`)];
}

/** `instanceof` alone narrows to `ASTWithSource<any>`. */
function isAstWithSource(value: unknown): value is ASTWithSource {
  return value instanceof ASTWithSource;
}

/** Tokens of a `[class]` / `[ngClass]` binding, deduplicated. Unparsed bindings give one `{expr}` token. */
function boundClassTokens(binding: TmplAstBoundAttribute | undefined, rawValue: string): string[] {
  const value = binding?.value;
  if (isAstWithSource(value)) {
    return [...new Set(expressionTokens(value.ast, value.source ?? ""))];
  }
  return [capValue(`{${collapse(rawValue)}}`)];
}

// ---------------------------------------------------------------------------------------------------------------
// Attributes (15 §5.8.2 attribute table)
// ---------------------------------------------------------------------------------------------------------------

function isBoundName(name: string): boolean {
  return BOUND_PREFIXES.some((prefix) => name.startsWith(prefix));
}

function attributeValue(raw: RawAttribute, bindings: Map<number, TmplAstBoundAttribute>): AttributeValue {
  const value = collapse(raw.value);
  if (raw.name === "class") {
    return { text: capValue(value === "" ? "true" : value), tokens: [...new Set(splitClasses(raw.value))] };
  }
  if (isBoundName(raw.name)) {
    const text = capValue(`{${value}}`);
    const tokens =
      raw.name === "[class]" || raw.name === "[ngClass]" ? boundClassTokens(bindings.get(raw.offset), raw.value) : null;
    return { text, tokens };
  }
  // static attributes, references (#ref), i18n markers and structural directives (*ngIf) keep their value
  return { text: capValue(value === "" ? "true" : value), tokens: null };
}

function attributesOf(
  raws: readonly RawAttribute[],
  inputs: readonly TmplAstBoundAttribute[],
  include: (raw: RawAttribute) => boolean
): Map<string, AttributeValue> {
  const bindings = new Map(inputs.map((input) => [input.sourceSpan.start.offset, input]));
  const out = new Map<string, AttributeValue>();
  for (const raw of raws) {
    if (include(raw)) {
      out.set(raw.name, attributeValue(raw, bindings));
    }
  }
  return out;
}

function isStructuralDirective(raw: RawAttribute): boolean {
  return raw.name.startsWith("*");
}

// ---------------------------------------------------------------------------------------------------------------
// Nodes (15 §5.8.2 node table)
// ---------------------------------------------------------------------------------------------------------------

function textNode(text: string, ctx: BuildContext): JsxTextNode[] {
  const collapsed = collapse(text);
  if (collapsed === "") {
    return [];
  }
  if (ctx.budget.nodes >= STRUCTURAL_DIFF_MAX_NODES) {
    ctx.budget.truncated = true;
    return [];
  }
  ctx.budget.nodes += 1;
  return [{ kind: "text", text: capValue(collapsed) }];
}

/**
 * Creates an element and fills its children. Returns null when the node budget is spent. `children` is called only
 * when the depth limit allows it; a skipped non-empty child list marks the budget truncated.
 */
function element(
  tag: string,
  attributes: Map<string, AttributeValue>,
  depth: number,
  ctx: BuildContext,
  children: (childDepth: number) => JsxTreeNode[],
  hasChildren: boolean
): JsxElementNode | null {
  if (ctx.budget.nodes >= STRUCTURAL_DIFF_MAX_NODES) {
    ctx.budget.truncated = true;
    return null;
  }
  ctx.budget.nodes += 1;
  const node: JsxElementNode = { kind: "element", tag, key: null, attributes, children: [] };
  if (depth + 1 > STRUCTURAL_DIFF_MAX_DEPTH) {
    if (hasChildren) {
      ctx.budget.truncated = true;
    }
    return node;
  }
  node.children = children(depth + 1);
  return node;
}

function attrs(entries: Array<[string, string | null]>): Map<string, AttributeValue> {
  const out = new Map<string, AttributeValue>();
  for (const [name, value] of entries) {
    if (value !== null && value !== "") {
      out.set(name, { text: capValue(collapse(value)), tokens: null });
    }
  }
  return out;
}

function sourceOfAst(value: AST | null | undefined): string | null {
  if (value instanceof ASTWithSource) {
    return value.source === null ? null : collapse(value.source);
  }
  return null;
}

/** Elements directly in a list get `key` (an `@for` track expression or a `*ngFor` trackBy). */
function keyElements(nodes: JsxTreeNode[], key: string): JsxTreeNode[] {
  for (const node of nodes) {
    if (node.kind === "element") {
      node.key = capValue(key);
    }
  }
  return nodes;
}

function buildNodes(nodes: readonly TmplAstNode[], depth: number, ctx: BuildContext): JsxTreeNode[] {
  return nodes.flatMap((node) => buildNode(node, depth, ctx));
}

function single(node: JsxElementNode | null): JsxTreeNode[] {
  return node === null ? [] : [node];
}

function buildNode(node: TmplAstNode, depth: number, ctx: BuildContext): JsxTreeNode[] {
  if (depth > STRUCTURAL_DIFF_MAX_DEPTH) {
    ctx.budget.truncated = true;
    return [];
  }
  if (node instanceof TmplAstText) {
    return textNode(node.value, ctx);
  }
  if (node instanceof TmplAstBoundText || node instanceof TmplAstIcu) {
    return textNode(node.sourceSpan.toString(), ctx);
  }
  if (node instanceof TmplAstElement) {
    const raws = ctx.rawAttributes.get(node.sourceSpan.start.offset) ?? [];
    const attributes = attributesOf(raws, node.inputs, (raw) => !isStructuralDirective(raw));
    return single(
      element(
        stripNamespace(node.name),
        attributes,
        depth,
        ctx,
        (d) => buildNodes(node.children, d, ctx),
        node.children.length > 0
      )
    );
  }
  if (node instanceof TmplAstTemplate) {
    return buildTemplate(node, depth, ctx);
  }
  if (node instanceof TmplAstContent) {
    const raws = ctx.rawAttributes.get(node.sourceSpan.start.offset) ?? [];
    const attributes = attributesOf(raws, [], () => true);
    return single(
      element("ng-content", attributes, depth, ctx, (d) => buildNodes(node.children, d, ctx), node.children.length > 0)
    );
  }
  if (node instanceof TmplAstIfBlock) {
    const first = node.branches[0];
    const condition = first === undefined ? null : ifCondition(first.expression, first.expressionAlias?.name ?? null);
    const branches = (d: number): JsxTreeNode[] =>
      node.branches.flatMap((branch, index) => {
        const branchCondition = ifCondition(branch.expression, branch.expressionAlias?.name ?? null);
        const tag = index === 0 ? "@if-branch" : branch.expression === null ? "@else" : "@else-if";
        const branchAttrs = attrs(index === 0 ? [] : [["condition", branchCondition]]);
        return single(
          element(tag, branchAttrs, d, ctx, (dd) => buildNodes(branch.children, dd, ctx), branch.children.length > 0)
        );
      });
    return single(element("@if", attrs([["condition", condition]]), depth, ctx, branches, node.branches.length > 0));
  }
  if (node instanceof TmplAstForLoopBlock) {
    const of = `${node.item.name} of ${sourceOfAst(node.expression) ?? ""}`;
    const track = sourceOfAst(node.trackBy);
    const body = (d: number): JsxTreeNode[] => {
      const items = buildNodes(node.children, d, ctx);
      if (track !== null) {
        keyElements(items, `{${track}}`);
      }
      const empty = node.empty;
      if (empty === null) {
        return items;
      }
      const emptyNode = element(
        "@empty",
        new Map(),
        d,
        ctx,
        (dd) => buildNodes(empty.children, dd, ctx),
        empty.children.length > 0
      );
      return [...items, ...single(emptyNode)];
    };
    return single(
      element(
        "@for",
        attrs([
          ["of", of],
          ["track", track]
        ]),
        depth,
        ctx,
        body,
        node.children.length > 0 || node.empty !== null
      )
    );
  }
  if (node instanceof TmplAstSwitchBlock) {
    const groups = (d: number): JsxTreeNode[] =>
      node.groups.flatMap((group) => {
        const values = group.cases.flatMap((c) => {
          const value = sourceOfAst(c.expression);
          return value === null ? [] : [value];
        });
        const isDefault = group.cases.some((c) => c.expression === null);
        const tag = isDefault ? "@default" : "@case";
        const groupAttrs = attrs([["value", values.length > 0 ? values.join(", ") : null]]);
        return single(
          element(tag, groupAttrs, d, ctx, (dd) => buildNodes(group.children, dd, ctx), group.children.length > 0)
        );
      });
    return single(
      element(
        "@switch",
        attrs([["expression", sourceOfAst(node.expression)]]),
        depth,
        ctx,
        groups,
        node.groups.length > 0
      )
    );
  }
  if (node instanceof TmplAstDeferredBlock) {
    return buildDefer(node, depth, ctx);
  }
  if (node instanceof TmplAstLetDeclaration) {
    return single(
      element(
        "@let",
        attrs([
          ["name", node.name],
          ["value", sourceOfAst(node.value)]
        ]),
        depth,
        ctx,
        () => [],
        false
      )
    );
  }
  if (node instanceof TmplAstUnknownBlock) {
    return textNode(`{@${node.name}}`, ctx);
  }
  // Comments are not part of the AST; selectorless components/directives and other nodes are not diffed.
  return [];
}

function ifCondition(expression: AST | null, alias: string | null): string | null {
  const source = sourceOfAst(expression);
  if (source === null) {
    return null;
  }
  return alias === null ? source : `${source}; as ${alias}`;
}

/**
 * `<ng-template>` → element `ng-template` with its own attributes. A structural directive (`*ngIf="…"` on a host
 * element) → element `ng-template` holding only the `*` attribute; the host element is its child.
 */
function buildTemplate(node: TmplAstTemplate, depth: number, ctx: BuildContext): JsxTreeNode[] {
  const raws = ctx.rawAttributes.get(node.sourceSpan.start.offset) ?? [];
  const isStructural = node.templateAttrs.length > 0;
  const attributes = isStructural
    ? attributesOf(raws, [], isStructuralDirective)
    : attributesOf(raws, node.inputs, (raw) => !isStructuralDirective(raw));
  const trackBy = node.templateAttrs.find(
    (attr): attr is TmplAstBoundAttribute =>
      attr.name === "ngForTrackBy" && "value" in attr && attr.value instanceof ASTWithSource
  );
  const trackSource = trackBy === undefined ? null : sourceOfAst(trackBy.value);
  const children = (d: number): JsxTreeNode[] => {
    const built = buildNodes(node.children, d, ctx);
    return trackSource === null ? built : keyElements(built, `{${trackSource}}`);
  };
  return single(element("ng-template", attributes, depth, ctx, children, node.children.length > 0));
}

/** `@defer (triggers)` with the main content first, then `@placeholder`, `@loading`, `@error` in source order. */
function buildDefer(node: TmplAstDeferredBlock, depth: number, ctx: BuildContext): JsxTreeNode[] {
  const triggers = ctx.blockParameters.get(node.sourceSpan.start.offset) ?? null;
  const subBlocks = [
    { tag: "@placeholder", block: node.placeholder },
    { tag: "@loading", block: node.loading },
    { tag: "@error", block: node.error }
  ]
    .flatMap((entry) => (entry.block === null ? [] : [{ tag: entry.tag, block: entry.block }]))
    .sort((a, b) => a.block.sourceSpan.start.offset - b.block.sourceSpan.start.offset);
  const children = (d: number): JsxTreeNode[] => [
    ...buildNodes(node.children, d, ctx),
    ...subBlocks.flatMap(({ tag, block }) => {
      const parameters = ctx.blockParameters.get(block.sourceSpan.start.offset) ?? null;
      return single(
        element(
          tag,
          attrs([["parameters", parameters]]),
          d,
          ctx,
          (dd) => buildNodes(block.children, dd, ctx),
          block.children.length > 0
        )
      );
    })
  ];
  return single(
    element(
      "@defer",
      attrs([["triggers", triggers]]),
      depth,
      ctx,
      children,
      node.children.length > 0 || subBlocks.length > 0
    )
  );
}

/**
 * Parses an Angular template and maps it to 11's tree model (15 §5.8.2). Never throws for template content.
 *
 * @param template template source (an external file's text or an inline template's unescaped text)
 * @param url used in compiler messages only
 * @param budget per-side node budget (11 §5.3.3); a fresh one by default
 */
export function angularTemplateToTree(
  template: string,
  url: string,
  budget: JsxBudget = newJsxBudget()
): AngularTemplateTree {
  const parsed = parseTemplate(template, url, { preserveWhitespaces: false });
  const errors = (parsed.errors ?? []).slice(0, MAX_REPORTED_ERRORS).map((error) => error.msg);
  if ((parsed.errors?.length ?? 0) > 0 && parsed.nodes.length === 0) {
    return { nodes: [], parseFailed: true, errors };
  }
  const ctx: BuildContext = { budget, ...collectRaw(template, url) };
  return { nodes: buildNodes(parsed.nodes, 0, ctx), parseFailed: false, errors };
}

function templateRoot(nodes: JsxTreeNode[]): JsxElementNode {
  return { kind: "element", tag: TEMPLATE_ROOT_TAG, key: null, attributes: new Map(), children: nodes };
}

function stripRoot(path: string): string {
  return path.startsWith(TEMPLATE_ROOT_PREFIX) ? path.slice(TEMPLATE_ROOT_PREFIX.length) : path;
}

/**
 * Diffs two templates' top-level nodes with 11's `diffJsxTrees`. The nodes are wrapped in one synthetic root so that
 * top-level siblings are matched by tag + key + index like any other children (a template has no `return[i]`); the
 * root segment is removed from every path, so paths start at the template's own elements (`div > span`, `@if`).
 */
export function diffAngularTemplateTrees(
  base: JsxTreeNode[],
  head: JsxTreeNode[],
  maxChanges: number = STRUCTURAL_DIFF_MAX_CHANGES
): JsxTreeDiff {
  const diff = diffJsxTrees([templateRoot(base)], [templateRoot(head)], maxChanges);
  const changes = diff.changes.map((change): StructuralChange => ({ ...change, path: stripRoot(change.path) }));
  return { changes, truncated: diff.truncated };
}
