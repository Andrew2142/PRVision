/**
 * Pure reader of Angular decorators (sheet 15 §5.5.2 step 2). Finds `@Component`, `@Directive`, `@Pipe`,
 * `@NgModule` and `@Injectable` classes in a `ts.SourceFile` whose decorator resolves to an `@angular/core`
 * import (named, aliased or through a namespace), and reads their static metadata, inputs, outputs and injected
 * dependencies. Dynamic metadata is recorded as `null`. Nothing is executed; no Program or TypeChecker is used.
 */
import ts from "typescript";
import type { AngularInputMeta, AngularOutputMeta } from "../../../../types/angular-analysis";

export type AngularDecoratorKind = "Component" | "Directive" | "Pipe" | "NgModule" | "Injectable";

/** One injected dependency as written in the class (token resolution happens in the index/queries). */
export interface AngularReadDependency {
  token: string;
  /** Leftmost identifier of the token expression (`Tokens.API` → `Tokens`), used to find its import. */
  tokenRoot: string | null;
  via: "constructor" | "inject";
  optional: boolean;
  importSpecifier: string | null;
}

/** Inline template or style text taken from a string literal (already unescaped by the TS scanner). */
export interface AngularInlineText {
  text: string;
  startLine: number; // 1-based line of the literal's first character in the TS file
  start: number; // literal node start (including the quote)
  end: number;
}

export interface AngularNgModuleMeta {
  declarations: string[];
  imports: string[];
  exports: string[];
  providers: string[]; // provider expression source texts
}

/** Static metadata of one decorated class. Positions refer to the SourceFile that was read. */
export interface AngularDecoratedClass {
  kind: AngularDecoratorKind;
  className: string;
  /** `className` (or its `export { X as Y }` alias), "default" for a default export, null when not exported. */
  exportName: string | null;
  start: number; // class start including decorators
  end: number;
  startLine: number;
  selector: string | null;
  /** Explicit `standalone` flag, else the version default (§5.5.2). Always false for NgModule/Injectable. */
  standalone: boolean;
  templateUrl: string | null;
  inlineTemplate: AngularInlineText | null;
  /** `template`/`templateUrl` present but not a static string. */
  templateDynamic: boolean;
  styleUrls: string[];
  inlineStyles: AngularInlineText[];
  imports: string[];
  inputs: AngularInputMeta[];
  outputs: AngularOutputMeta[];
  injected: AngularReadDependency[];
  changeDetection: "OnPush" | "Default" | null;
  pipeName: string | null;
  providedIn: "root" | "platform" | "any" | null;
  constructorHints: string[];
  ngModule: AngularNgModuleMeta | null;
  /** Every identifier referenced inside the class (decorators included); used to match imported names. */
  identifiers: string[];
}

export interface AngularDecoratorReaderOptions {
  /** Major of the installed `@angular/core`; `standalone` defaults to true from 19 on (null = assume ≥ 19). */
  angularMajor?: number | null;
}

const DECORATOR_KINDS = new Set<string>(["Component", "Directive", "Pipe", "NgModule", "Injectable"]);
const ANGULAR_CORE = "@angular/core";
const RXJS_INTEROP = "@angular/core/rxjs-interop";
const SIGNAL_INPUT_FUNCTIONS = new Set(["input", "model"]);
const TIMER_CALL = /\b(?:setInterval|setTimeout|interval|timer)\s*\(/;
const SUBSCRIBE_CALL = /\.subscribe\s*\(/;
const HTTP_MEMBER = /\bthis\.(?:http|httpClient|apiService|api)\s*\./;

interface ImportInfo {
  specifier: string;
  imported: string; // "default" | "*" | name
}

/** Local import bindings of a file: local name → specifier and imported name. */
export function readAngularImportBindings(sf: ts.SourceFile): Map<string, ImportInfo> {
  const out = new Map<string, ImportInfo>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause === undefined) {
      continue;
    }
    if (clause.name !== undefined) {
      out.set(clause.name.text, { specifier, imported: "default" });
    }
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamespaceImport(named)) {
      out.set(named.name.text, { specifier, imported: "*" });
    } else if (named !== undefined) {
      for (const element of named.elements) {
        out.set(element.name.text, { specifier, imported: (element.propertyName ?? element.name).text });
      }
    }
  }
  return out;
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = node;
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

function propertyName(name: ts.PropertyName, sf: ts.SourceFile): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isComputedPropertyName(name)) {
    return null;
  }
  return name.getText(sf);
}

function staticString(node: ts.Expression | undefined): string | null {
  if (node === undefined) {
    return null;
  }
  const e = unwrapExpression(node);
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) ? e.text : null;
}

function inlineText(node: ts.Expression | undefined, sf: ts.SourceFile): AngularInlineText | null {
  if (node === undefined) {
    return null;
  }
  const e = unwrapExpression(node);
  if (!ts.isStringLiteral(e) && !ts.isNoSubstitutionTemplateLiteral(e)) {
    return null;
  }
  const start = e.getStart(sf);
  return { text: e.text, startLine: sf.getLineAndCharacterOfPosition(start).line + 1, start, end: e.getEnd() };
}

/** Leftmost identifier of an expression (`a.b.c` → `a`, `forwardRef(() => X)` → `X`). */
function rootIdentifier(node: ts.Expression): string | null {
  const e = unwrapExpression(node);
  if (ts.isIdentifier(e)) {
    return e.text;
  }
  if (ts.isPropertyAccessExpression(e)) {
    return rootIdentifier(e.expression);
  }
  if (ts.isCallExpression(e)) {
    const callee = unwrapExpression(e.expression);
    const argument = e.arguments[0];
    if (ts.isIdentifier(callee) && callee.text === "forwardRef" && argument !== undefined) {
      const fn = unwrapExpression(argument);
      if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) {
        return rootIdentifier(fn.body);
      }
    }
    return rootIdentifier(e.expression);
  }
  return null;
}

/** Identifier names listed in an array literal (spreads and calls reduced to their root identifier). */
function identifierList(node: ts.Expression | undefined): string[] {
  if (node === undefined) {
    return [];
  }
  const e = unwrapExpression(node);
  if (ts.isIdentifier(e)) {
    return [e.text];
  }
  if (!ts.isArrayLiteralExpression(e)) {
    return [];
  }
  const out: string[] = [];
  for (const element of e.elements) {
    const value = ts.isSpreadElement(element) ? element.expression : element;
    const name = rootIdentifier(value);
    if (name !== null) {
      out.push(name);
    }
  }
  return out;
}

function stringList(node: ts.Expression | undefined): string[] | null {
  if (node === undefined) {
    return [];
  }
  const e = unwrapExpression(node);
  const single = staticString(e);
  if (single !== null) {
    return [single];
  }
  if (!ts.isArrayLiteralExpression(e)) {
    return null;
  }
  const out: string[] = [];
  for (const element of e.elements) {
    const value = staticString(element);
    if (value !== null) {
      out.push(value);
    }
  }
  return out;
}

function objectProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
  sf: ts.SourceFile
): ts.Expression | undefined {
  for (const property of object.properties) {
    if (ts.isPropertyAssignment(property) && propertyName(property.name, sf) === name) {
      return property.initializer;
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === name) {
      return property.name;
    }
  }
  return undefined;
}

function hasObjectProperty(object: ts.ObjectLiteralExpression, name: string, sf: ts.SourceFile): boolean {
  return objectProperty(object, name, sf) !== undefined;
}

function isTrue(node: ts.Expression | undefined): boolean {
  return node !== undefined && unwrapExpression(node).kind === ts.SyntaxKind.TrueKeyword;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function decoratorsOf(node: ts.Node): readonly ts.Decorator[] {
  return ts.canHaveDecorators(node) ? (ts.getDecorators(node) ?? []) : [];
}

/** Resolves local names to Angular API names for one file. */
class AngularBindings {
  private readonly named = new Map<string, string>(); // local → `<module>#<name>`
  private readonly namespaces = new Map<string, string>(); // local → module

  constructor(imports: ReadonlyMap<string, ImportInfo>) {
    for (const [local, info] of imports) {
      if (info.specifier !== ANGULAR_CORE && info.specifier !== RXJS_INTEROP) {
        continue;
      }
      if (info.imported === "*") {
        this.namespaces.set(local, info.specifier);
      } else {
        this.named.set(local, `${info.specifier}#${info.imported}`);
      }
    }
  }

  /** `<module>#<name>` of a callee/decorator expression, or null when it is not an Angular import. */
  resolve(node: ts.Expression): string | null {
    const e = unwrapExpression(node);
    if (ts.isIdentifier(e)) {
      return this.named.get(e.text) ?? null;
    }
    if (ts.isPropertyAccessExpression(e)) {
      const target = unwrapExpression(e.expression);
      if (ts.isIdentifier(target)) {
        const module = this.namespaces.get(target.text);
        if (module !== undefined) {
          return `${module}#${e.name.text}`;
        }
        // `input.required(...)` / `model.required(...)`
        const base = this.named.get(target.text);
        if (base !== undefined && e.name.text === "required") {
          return `${base}.required`;
        }
      }
      if (ts.isPropertyAccessExpression(target) && e.name.text === "required") {
        const base = this.resolve(target);
        return base === null ? null : `${base}.required`;
      }
    }
    return null;
  }

  isCore(node: ts.Expression, name: string): boolean {
    return this.resolve(node) === `${ANGULAR_CORE}#${name}`;
  }
}

function exportNamesOf(sf: ts.SourceFile): { named: Map<string, string>; defaultLocal: string | null } {
  const named = new Map<string, string>();
  let defaultLocal: string | null = null;
  for (const statement of sf.statements) {
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier === undefined && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (clause !== undefined && ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const local = (element.propertyName ?? element.name).text;
          if (element.name.text === "default") {
            defaultLocal = local;
          } else if (!named.has(local)) {
            named.set(local, element.name.text);
          }
        }
      }
    } else if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const e = unwrapExpression(statement.expression);
      if (ts.isIdentifier(e)) {
        defaultLocal = e.text;
      }
    }
  }
  return { named, defaultLocal };
}

function collectIdentifiers(node: ts.Node): string[] {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) {
      names.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return [...names].sort();
}

function typeArgumentText(call: ts.CallExpression, sf: ts.SourceFile): string | null {
  const first = call.typeArguments?.[0];
  return first === undefined ? null : first.getText(sf);
}

/** Options object of a signal API call: `input(init, opts)`, `input.required(opts)`, `output(opts)`. */
function optionsArgument(call: ts.CallExpression, index: number): ts.ObjectLiteralExpression | null {
  const argument = call.arguments[index];
  if (argument === undefined) {
    return null;
  }
  const e = unwrapExpression(argument);
  return ts.isObjectLiteralExpression(e) ? e : null;
}

/**
 * Constructor hints of a class (§5.5.2): its constructor body or field initialisers start a timer, subscribe, or
 * call an HTTP-like member. Works on undecorated classes too.
 */
export function readAngularConstructorHints(cls: ts.ClassLikeDeclaration, sf: ts.SourceFile): string[] {
  const parts: string[] = [];
  for (const member of cls.members) {
    if (ts.isConstructorDeclaration(member) && member.body !== undefined) {
      parts.push(member.body.getText(sf));
    } else if (ts.isPropertyDeclaration(member) && member.initializer !== undefined) {
      parts.push(member.initializer.getText(sf));
    }
  }
  const text = parts.join("\n");
  const hints: string[] = [];
  if (TIMER_CALL.test(text)) {
    hints.push("constructor starts a timer");
  }
  if (SUBSCRIBE_CALL.test(text)) {
    hints.push("constructor subscribes on creation");
  }
  if (HTTP_MEMBER.test(text)) {
    hints.push("constructor calls HTTP");
  }
  return hints;
}

function parseMetadataEntry(entry: string): { name: string; alias: string | null } {
  const [left, right] = entry.split(":").map((part) => part.trim());
  const name = left ?? entry.trim();
  return { name, alias: right !== undefined && right !== "" && right !== name ? right : null };
}

/**
 * Reads the decorated classes of one file (§5.5.2 step 2). Stateless; safe on files with syntax errors.
 */
export class AngularDecoratorReader {
  private readonly angularMajor: number | null;

  constructor(options: AngularDecoratorReaderOptions = {}) {
    this.angularMajor = options.angularMajor ?? null;
  }

  /** Default of `standalone` when the flag is absent: true from Angular 19 (or when the version is unknown). */
  get standaloneDefault(): boolean {
    return this.angularMajor === null || this.angularMajor >= 19;
  }

  /**
   * Returns every class decorated with an Angular decorator, in source order.
   *
   * @param sf - SourceFile created with `setParentNodes` (positions are read with `getStart(sf)`).
   */
  read(sf: ts.SourceFile): AngularDecoratedClass[] {
    const imports = readAngularImportBindings(sf);
    const bindings = new AngularBindings(imports);
    const exports = exportNamesOf(sf);
    const out: AngularDecoratedClass[] = [];
    for (const statement of sf.statements) {
      if (!ts.isClassDeclaration(statement)) {
        continue;
      }
      const read = this.readClass(statement, sf, bindings, imports, exports);
      if (read !== null) {
        out.push(read);
      }
    }
    return out;
  }

  private readClass(
    cls: ts.ClassDeclaration,
    sf: ts.SourceFile,
    bindings: AngularBindings,
    imports: ReadonlyMap<string, ImportInfo>,
    exports: { named: Map<string, string>; defaultLocal: string | null }
  ): AngularDecoratedClass | null {
    let kind: AngularDecoratorKind | null = null;
    let metadata: ts.ObjectLiteralExpression | null = null;
    for (const decorator of decoratorsOf(cls)) {
      const expression = unwrapExpression(decorator.expression);
      const callee = ts.isCallExpression(expression) ? expression.expression : expression;
      const resolved = bindings.resolve(callee);
      if (resolved === null || !resolved.startsWith(`${ANGULAR_CORE}#`)) {
        continue;
      }
      const name = resolved.slice(ANGULAR_CORE.length + 1);
      if (!DECORATOR_KINDS.has(name)) {
        continue;
      }
      kind = name as AngularDecoratorKind;
      const argument = ts.isCallExpression(expression) ? expression.arguments[0] : undefined;
      const arg = argument === undefined ? null : unwrapExpression(argument);
      metadata = arg !== null && ts.isObjectLiteralExpression(arg) ? arg : null;
      break;
    }
    if (kind === null) {
      return null;
    }
    const className = cls.name?.text ?? "default";
    const isDefault = hasModifier(cls, ts.SyntaxKind.DefaultKeyword);
    const isExported = hasModifier(cls, ts.SyntaxKind.ExportKeyword);
    let exportName: string | null = null;
    if (isExported) {
      exportName = isDefault ? "default" : className;
    } else if (exports.named.has(className)) {
      exportName = exports.named.get(className) ?? className;
    } else if (exports.defaultLocal === className) {
      exportName = "default";
    }
    const start = cls.getStart(sf);
    const meta = metadata;
    const prop = (name: string): ts.Expression | undefined =>
      meta === null ? undefined : objectProperty(meta, name, sf);

    const standaloneExpr = prop("standalone");
    const standaloneValue = standaloneExpr === undefined ? null : unwrapExpression(standaloneExpr).kind;
    let standalone =
      standaloneValue === ts.SyntaxKind.TrueKeyword
        ? true
        : standaloneValue === ts.SyntaxKind.FalseKeyword
          ? false
          : this.standaloneDefault;
    if (kind === "NgModule" || kind === "Injectable") {
      standalone = false;
    }

    const templateExpr = prop("template");
    const templateUrlExpr = prop("templateUrl");
    const inlineTemplate = inlineText(templateExpr, sf);
    const templateUrl = staticString(templateUrlExpr);
    const templateDynamic =
      (templateExpr !== undefined && inlineTemplate === null) ||
      (templateUrlExpr !== undefined && templateUrl === null);

    const styleUrls = [...(stringList(prop("styleUrls")) ?? []), ...(stringList(prop("styleUrl")) ?? [])];
    const stylesExpr = prop("styles");
    const inlineStyles: AngularInlineText[] = [];
    if (stylesExpr !== undefined) {
      const e = unwrapExpression(stylesExpr);
      const items = ts.isArrayLiteralExpression(e) ? [...e.elements] : [e];
      for (const item of items) {
        const text = inlineText(item, sf);
        if (text !== null) {
          inlineStyles.push(text);
        }
      }
    }

    const changeDetectionExpr = prop("changeDetection");
    let changeDetection: AngularDecoratedClass["changeDetection"] = null;
    if (changeDetectionExpr !== undefined) {
      const e = unwrapExpression(changeDetectionExpr);
      if (ts.isPropertyAccessExpression(e)) {
        if (e.name.text === "OnPush") {
          changeDetection = "OnPush";
        } else if (e.name.text === "Default" || e.name.text === "Eager") {
          changeDetection = "Default";
        }
      }
    } else if (kind === "Component") {
      changeDetection = "Default";
    }

    const providedInExpr = prop("providedIn");
    const providedInText = staticString(providedInExpr);
    const providedIn =
      providedInText === "root" || providedInText === "platform" || providedInText === "any" ? providedInText : null;

    const ngModule: AngularNgModuleMeta | null =
      kind === "NgModule"
        ? {
            declarations: identifierList(prop("declarations")),
            imports: identifierList(prop("imports")),
            exports: identifierList(prop("exports")),
            providers: this.providerTexts(prop("providers"), sf)
          }
        : null;

    const inputs: AngularInputMeta[] = [];
    const outputs: AngularOutputMeta[] = [];
    if (kind === "Component" || kind === "Directive") {
      this.readMetadataBindings(prop("inputs"), "input", inputs, outputs, sf);
      this.readMetadataBindings(prop("outputs"), "output", inputs, outputs, sf);
      this.readMemberBindings(cls, sf, bindings, inputs, outputs);
    }

    return {
      kind,
      className,
      exportName,
      start,
      end: cls.getEnd(),
      startLine: sf.getLineAndCharacterOfPosition(start).line + 1,
      selector: kind === "Component" || kind === "Directive" ? staticString(prop("selector")) : null,
      standalone,
      templateUrl,
      inlineTemplate,
      templateDynamic,
      styleUrls,
      inlineStyles,
      imports: kind === "Component" || kind === "Directive" ? identifierList(prop("imports")) : [],
      inputs,
      outputs,
      injected: this.readInjected(cls, sf, bindings, imports),
      changeDetection: kind === "Component" ? changeDetection : null,
      pipeName: kind === "Pipe" ? staticString(prop("name")) : null,
      providedIn: kind === "Injectable" ? providedIn : null,
      constructorHints: readAngularConstructorHints(cls, sf),
      ngModule,
      identifiers: collectIdentifiers(cls)
    };
  }

  private providerTexts(node: ts.Expression | undefined, sf: ts.SourceFile): string[] {
    if (node === undefined) {
      return [];
    }
    const e = unwrapExpression(node);
    if (!ts.isArrayLiteralExpression(e)) {
      return [e.getText(sf)];
    }
    return e.elements.map((element) => element.getText(sf));
  }

  /** `@Component({ inputs: ["a", "b: alias", { name, alias, required, transform }] })`. */
  private readMetadataBindings(
    node: ts.Expression | undefined,
    which: "input" | "output",
    inputs: AngularInputMeta[],
    outputs: AngularOutputMeta[],
    sf: ts.SourceFile
  ): void {
    if (node === undefined) {
      return;
    }
    const e = unwrapExpression(node);
    if (!ts.isArrayLiteralExpression(e)) {
      return;
    }
    for (const element of e.elements) {
      const value = unwrapExpression(element);
      let name: string | null = null;
      let alias: string | null = null;
      let required = false;
      let hasTransform = false;
      const text = staticString(value);
      if (text !== null) {
        ({ name, alias } = parseMetadataEntry(text));
      } else if (ts.isObjectLiteralExpression(value)) {
        name = staticString(objectProperty(value, "name", sf));
        alias = staticString(objectProperty(value, "alias", sf));
        required = isTrue(objectProperty(value, "required", sf));
        hasTransform = hasObjectProperty(value, "transform", sf);
      }
      if (name === null || name === "") {
        continue;
      }
      if (which === "input") {
        inputs.push({
          name,
          alias,
          kind: "metadata",
          required,
          typeText: null,
          initializerText: null,
          hasTransform
        });
      } else {
        outputs.push({ name, alias, kind: "metadata" });
      }
    }
  }

  /** Decorator inputs/outputs and signal `input()`/`model()`/`output()`/`outputFromObservable()` members. */
  private readMemberBindings(
    cls: ts.ClassDeclaration,
    sf: ts.SourceFile,
    bindings: AngularBindings,
    inputs: AngularInputMeta[],
    outputs: AngularOutputMeta[]
  ): void {
    for (const member of cls.members) {
      if (
        !ts.isPropertyDeclaration(member) &&
        !ts.isSetAccessorDeclaration(member) &&
        !ts.isGetAccessorDeclaration(member)
      ) {
        continue;
      }
      const name = propertyName(member.name, sf);
      if (name === null) {
        continue;
      }
      for (const decorator of decoratorsOf(member)) {
        const expression = unwrapExpression(decorator.expression);
        const callee = ts.isCallExpression(expression) ? expression.expression : expression;
        const firstArgument = ts.isCallExpression(expression) ? expression.arguments[0] : undefined;
        const first = firstArgument === undefined ? undefined : unwrapExpression(firstArgument);
        let alias = staticString(first);
        let required = false;
        let hasTransform = false;
        if (first !== undefined && ts.isObjectLiteralExpression(first)) {
          alias = staticString(objectProperty(first, "alias", sf));
          required = isTrue(objectProperty(first, "required", sf));
          hasTransform = hasObjectProperty(first, "transform", sf);
        }
        if (bindings.isCore(callee, "Input")) {
          let typeText: string | null = null;
          if (ts.isPropertyDeclaration(member)) {
            typeText = member.type?.getText(sf) ?? null;
          } else if (ts.isSetAccessorDeclaration(member)) {
            typeText = member.parameters[0]?.type?.getText(sf) ?? null;
          } else {
            typeText = member.type?.getText(sf) ?? null;
          }
          inputs.push({
            name,
            alias: alias === name ? null : alias,
            kind: "decorator",
            required,
            typeText,
            initializerText: ts.isPropertyDeclaration(member) ? (member.initializer?.getText(sf) ?? null) : null,
            hasTransform
          });
        } else if (bindings.isCore(callee, "Output")) {
          outputs.push({ name, alias: alias === name ? null : alias, kind: "decorator" });
        }
      }
      if (!ts.isPropertyDeclaration(member) || member.initializer === undefined) {
        continue;
      }
      const init = unwrapExpression(member.initializer);
      if (!ts.isCallExpression(init)) {
        continue;
      }
      const api = bindings.resolve(init.expression);
      if (api === null) {
        continue;
      }
      const [module, fn] = api.split("#") as [string, string | undefined];
      const fnName = fn ?? "";
      const required = fnName.endsWith(".required");
      const base = required ? fnName.slice(0, -".required".length) : fnName;
      if (module === ANGULAR_CORE && SIGNAL_INPUT_FUNCTIONS.has(base)) {
        const options = optionsArgument(init, required ? 0 : 1);
        const alias = options === null ? null : staticString(objectProperty(options, "alias", sf));
        const initArgument = required ? undefined : init.arguments[0];
        inputs.push({
          name,
          alias: alias === name ? null : alias,
          kind: base === "model" ? "model" : "signal",
          required,
          typeText: typeArgumentText(init, sf),
          initializerText: initArgument === undefined ? null : initArgument.getText(sf),
          hasTransform: options !== null && hasObjectProperty(options, "transform", sf)
        });
        if (base === "model") {
          const publicName = alias ?? name;
          outputs.push({ name: `${name}Change`, alias: alias === null ? null : `${publicName}Change`, kind: "model" });
        }
      } else if (
        (module === ANGULAR_CORE && base === "output") ||
        (module === RXJS_INTEROP && base === "outputFromObservable")
      ) {
        const options = optionsArgument(init, base === "output" ? 0 : 1);
        const alias = options === null ? null : staticString(objectProperty(options, "alias", sf));
        outputs.push({ name, alias: alias === name ? null : alias, kind: "signal" });
      }
    }
  }

  /** Constructor parameters (`@Inject`, `@Optional`) and `inject(X, opts)` calls anywhere in the class. */
  private readInjected(
    cls: ts.ClassDeclaration,
    sf: ts.SourceFile,
    bindings: AngularBindings,
    imports: ReadonlyMap<string, ImportInfo>
  ): AngularReadDependency[] {
    const out: AngularReadDependency[] = [];
    const specifierOf = (root: string | null): string | null =>
      root === null ? null : (imports.get(root)?.specifier ?? null);
    for (const member of cls.members) {
      if (!ts.isConstructorDeclaration(member)) {
        continue;
      }
      for (const parameter of member.parameters) {
        let tokenNode: ts.Node | null = parameter.type ?? null;
        let optional = false;
        for (const decorator of decoratorsOf(parameter)) {
          const expression = unwrapExpression(decorator.expression);
          const callee = ts.isCallExpression(expression) ? expression.expression : expression;
          if (bindings.isCore(callee, "Inject") && ts.isCallExpression(expression) && expression.arguments[0]) {
            tokenNode = expression.arguments[0];
          } else if (bindings.isCore(callee, "Optional")) {
            optional = true;
          }
        }
        if (tokenNode === null) {
          continue;
        }
        let root: string | null = null;
        let token = tokenNode.getText(sf);
        if (ts.isTypeReferenceNode(tokenNode)) {
          token = tokenNode.typeName.getText(sf);
          const typeName = tokenNode.typeName;
          root = ts.isIdentifier(typeName) ? typeName.text : rootOfQualified(typeName);
        } else if (ts.isExpression(tokenNode)) {
          root = rootIdentifier(tokenNode);
        }
        out.push({ token, tokenRoot: root, via: "constructor", optional, importSpecifier: specifierOf(root) });
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && bindings.isCore(node.expression, "inject")) {
        const argument = node.arguments[0];
        if (argument !== undefined) {
          const options = optionsArgument(node, 1);
          const root = rootIdentifier(argument);
          out.push({
            token: argument.getText(sf),
            tokenRoot: root,
            via: "inject",
            optional: options !== null && isTrue(objectProperty(options, "optional", sf)),
            importSpecifier: specifierOf(root)
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    for (const member of cls.members) {
      visit(member);
    }
    return out;
  }
}

function rootOfQualified(name: ts.EntityName): string | null {
  let current: ts.EntityName = name;
  while (ts.isQualifiedName(current)) {
    current = current.left;
  }
  return ts.isIdentifier(current) ? current.text : null;
}
