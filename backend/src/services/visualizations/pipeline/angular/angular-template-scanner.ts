/**
 * Error-tolerant Angular template scan (sheet 15 §5.5.2 step 4) over PRVision's pinned `@angular/compiler`
 * (00 §15 item 7). Collects, per element, the selector-matching shape the Angular compiler itself uses
 * (`createCssSelectorFromNode`: tag, classes, attribute/input/output names), every pipe name in bound expressions,
 * and a formatting-independent fingerprint used to decide whether a template change is formatting-only (§5.5.3).
 * The template is parsed, never executed. `scan` never throws.
 */
import {
  CombinedRecursiveAstVisitor,
  createCssSelectorFromNode,
  parseTemplate,
  tmplAstVisitAll,
  type BindingPipe,
  type TmplAstBoundAttribute,
  type TmplAstBoundEvent,
  type TmplAstBoundText,
  type TmplAstContent,
  type TmplAstDeferredBlock,
  type TmplAstDeferredBlockError,
  type TmplAstDeferredBlockLoading,
  type TmplAstDeferredBlockPlaceholder,
  type TmplAstElement,
  type TmplAstForLoopBlock,
  type TmplAstForLoopBlockEmpty,
  type TmplAstIcu,
  type TmplAstIfBlockBranch,
  type TmplAstLetDeclaration,
  type TmplAstReference,
  type TmplAstSwitchBlock,
  type TmplAstSwitchBlockCase,
  type TmplAstTemplate,
  type TmplAstText,
  type TmplAstTextAttribute
} from "@angular/compiler";

/** Selector-matching shape of one element or template (`createCssSelectorFromNode`). */
export interface AngularTemplateElementScan {
  element: string | null;
  classNames: string[];
  attrs: string[]; // flat name/value pairs, as `CssSelector.attrs`
  line: number; // 1-based line inside the template text
}

export interface AngularTemplateScan {
  elements: AngularTemplateElementScan[];
  pipes: string[]; // unique, sorted
  /** Whitespace- and comment-independent serialization of the template AST; equal = formatting-only change. */
  fingerprint: string;
  parseErrors: string[]; // first messages of the parse errors (empty when clean)
}

const MAX_REPORTED_ERRORS = 5;

/** Collapses whitespace runs to one space (text and static attribute values). */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Removes whitespace from expression source except between two word characters, outside string literals. */
export function compactAngularExpression(source: string): string {
  let out = "";
  let quote: string | null = null;
  let pendingSpace = false;
  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index);
    if (quote !== null) {
      out += char;
      if (char === "\\" && index + 1 < source.length) {
        out += source.charAt(index + 1);
        index++;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && /\w$/.test(out) && /\w/.test(char)) {
      out += " ";
    }
    pendingSpace = false;
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
    }
    out += char;
  }
  return out;
}

function spanText(span: { toString(): string } | null | undefined): string {
  return span === null || span === undefined ? "" : span.toString();
}

/** Visitor collecting elements, pipes and the fingerprint tokens in one walk. */
class ScanVisitor extends CombinedRecursiveAstVisitor {
  readonly elements: AngularTemplateElementScan[] = [];
  readonly pipes = new Set<string>();
  readonly tokens: string[] = [];

  override visitPipe(ast: BindingPipe, context: unknown): unknown {
    if (ast.name !== "") {
      this.pipes.add(ast.name);
    }
    return super.visitPipe(ast, context);
  }

  override visitElement(element: TmplAstElement): void {
    this.recordSelector(element, element.sourceSpan.start.line);
    this.tokens.push(`<${element.name}${this.attributeTokens(element)}>`);
    super.visitElement(element);
    this.tokens.push(`</${element.name}>`);
  }

  override visitTemplate(template: TmplAstTemplate): void {
    this.recordSelector(template, template.sourceSpan.start.line);
    const templateAttrs = template.templateAttrs
      .map(
        (attr) =>
          `*${attr.name}=${"type" in attr ? compactAngularExpression(spanText(attr.valueSpan)) : collapse(attr.value)}`
      )
      .sort();
    this.tokens.push(
      `<ng-template:${template.tagName ?? ""}${templateAttrs.join(" ")}${this.attributeTokens(template)}>`
    );
    super.visitTemplate(template);
    this.tokens.push("</ng-template>");
  }

  override visitContent(content: TmplAstContent): void {
    this.tokens.push(`<ng-content select=${content.selector}>`);
    super.visitContent(content);
  }

  override visitText(text: TmplAstText): void {
    const value = collapse(text.value);
    if (value !== "") {
      this.tokens.push(`#text ${value}`);
    }
  }

  override visitBoundText(text: TmplAstBoundText): void {
    this.tokens.push(`#bound ${compactAngularExpression(spanText(text.sourceSpan))}`);
    super.visitBoundText(text);
  }

  override visitIcu(icu: TmplAstIcu): void {
    this.tokens.push(`#icu ${compactAngularExpression(spanText(icu.sourceSpan))}`);
    super.visitIcu(icu);
  }

  override visitIfBlockBranch(block: TmplAstIfBlockBranch): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitIfBlockBranch(block);
    });
  }

  override visitForLoopBlock(block: TmplAstForLoopBlock): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitForLoopBlock(block);
    });
  }

  override visitForLoopBlockEmpty(block: TmplAstForLoopBlockEmpty): void {
    this.block("@empty", () => {
      super.visitForLoopBlockEmpty(block);
    });
  }

  override visitSwitchBlock(block: TmplAstSwitchBlock): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitSwitchBlock(block);
    });
  }

  override visitSwitchBlockCase(block: TmplAstSwitchBlockCase): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitSwitchBlockCase(block);
    });
  }

  override visitDeferredBlock(block: TmplAstDeferredBlock): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitDeferredBlock(block);
    });
  }

  override visitDeferredBlockPlaceholder(block: TmplAstDeferredBlockPlaceholder): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitDeferredBlockPlaceholder(block);
    });
  }

  override visitDeferredBlockLoading(block: TmplAstDeferredBlockLoading): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitDeferredBlockLoading(block);
    });
  }

  override visitDeferredBlockError(block: TmplAstDeferredBlockError): void {
    this.block(spanText(block.startSourceSpan), () => {
      super.visitDeferredBlockError(block);
    });
  }

  override visitLetDeclaration(decl: TmplAstLetDeclaration): void {
    this.tokens.push(`@let ${decl.name}=${compactAngularExpression(spanText(decl.valueSpan))}`);
    super.visitLetDeclaration(decl);
  }

  private block(header: string, visitChildren: () => void): void {
    this.tokens.push(`{${compactAngularExpression(header)}`);
    visitChildren();
    this.tokens.push("}");
  }

  private recordSelector(node: TmplAstElement | TmplAstTemplate, line: number): void {
    const selector = createCssSelectorFromNode(node);
    this.elements.push({
      element: selector.element,
      classNames: [...selector.classNames],
      attrs: [...selector.attrs],
      line: line + 1
    });
  }

  private attributeTokens(node: {
    attributes: TmplAstTextAttribute[];
    inputs: TmplAstBoundAttribute[];
    outputs: TmplAstBoundEvent[];
    references: TmplAstReference[];
  }): string {
    const parts = [
      ...node.attributes.map((attr) => `${attr.name}=${collapse(attr.value)}`),
      ...node.inputs.map(
        (input) => `[${String(input.type)}:${input.name}]=${compactAngularExpression(spanText(input.valueSpan))}`
      ),
      ...node.outputs.map((output) => `(${output.name})=${compactAngularExpression(spanText(output.handlerSpan))}`),
      ...node.references.map((ref) => `#${ref.name}=${ref.value}`)
    ].sort();
    return parts.length === 0 ? "" : ` ${parts.join(" ")}`;
  }
}

/** Parses and scans Angular templates. Stateless. */
export class AngularTemplateScanner {
  /**
   * Scans one template. Parse errors yield a partial result (whatever the compiler could convert) and are listed in
   * `parseErrors`; the scan never throws.
   *
   * @param text - Template source (inline templates already unescaped).
   * @param url - Template path used in parse error locations.
   */
  scan(text: string, url: string): AngularTemplateScan {
    try {
      const parsed = parseTemplate(text, url, {
        preserveWhitespaces: false,
        enableBlockSyntax: true,
        enableLetSyntax: true,
        alwaysAttemptHtmlToR3AstConversion: true
      });
      const visitor = new ScanVisitor();
      tmplAstVisitAll(visitor, parsed.nodes);
      const errors = (parsed.errors ?? []).slice(0, MAX_REPORTED_ERRORS).map((error) => collapse(error.msg));
      return {
        elements: visitor.elements,
        pipes: [...visitor.pipes].sort(),
        fingerprint: visitor.tokens.join("\n"),
        parseErrors: errors
      };
    } catch (error: unknown) {
      return {
        elements: [],
        pipes: [],
        fingerprint: `#unparsable ${collapse(text)}`,
        parseErrors: [error instanceof Error ? collapse(error.message) : "template could not be parsed"]
      };
    }
  }
}
