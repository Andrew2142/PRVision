/**
 * Static checks of an Angular harness and its file replacements (15 §5.6.7). Same input and report types as 09's
 * HarnessValidator. Everything is AST-based: the harness is parsed with the TypeScript compiler API as `.ts`
 * (experimental decorators), a host component's template with PRVision's pinned `@angular/compiler`. Nothing is
 * executed; containment is the render engine's job.
 */
import path from "node:path";
import {
  BindingType,
  CssSelector,
  ParsedEventType,
  SelectorMatcher,
  TmplAstRecursiveVisitor,
  createCssSelectorFromNode,
  parseTemplate,
  tmplAstVisitAll,
  type TmplAstElement,
  type TmplAstTemplate
} from "@angular/compiler";
import ts from "typescript";
import type { AngularComponentMeta, AngularSourceQueriesLike } from "../../../../types/angular-analysis";
import type { MockedModule, WorktreeSide } from "../../../../types/visualization-pipeline";
import { createLogger, getErrorMessage } from "../../../../utilities";
import { harnessDirRel } from "../harness-prompts";
import {
  HARNESS_MAX_MOCKS,
  HARNESS_MOCK_SOURCE_MAX_CHARS,
  HARNESS_MOCK_SPECIFIER_MAX_CHARS,
  HARNESS_SOURCE_MAX_CHARS,
  isForbiddenModule,
  locationOf,
  moduleReferences,
  runtimeExports,
  singleDefaultState,
  type HarnessIssueCode,
  type HarnessValidationInput,
  type HarnessValidationIssue,
  type HarnessValidationReport
} from "../harness-validator";
import { classifySpecifier, packageNameOf, validateMockedModules } from "../mock-rules";

const log = createLogger("pipeline.harness");

type Report = (code: HarnessIssueCode, severity: "error" | "warning", message: string, location?: string) => void;
type Metas = Partial<Record<WorktreeSide, AngularComponentMeta | null>>;

/** The only module a harness imports the API from (15 §5.6.1). */
export const ANGULAR_HARNESS_API_SPECIFIER = "../harness-api";
const DEFINE_HARNESS = "definePrvisionHarness";
const HOST_SELECTOR = "prvision-host";
const DESCRIPTOR_KEYS = new Set(["component", "inputs", "providers", "http", "hostStyle", "setup"]);
const SHAPE_HINT = "Default-export definePrvisionHarness({ component, … }) imported from '../harness-api'.";

/** Provider functions and bootstrap APIs the render page owns (15 §5.6.7 step 7). */
export const ANGULAR_FORBIDDEN_PROVIDER_CALLS: ReadonlySet<string> = new Set([
  "provideHttpClient",
  "provideHttpClientTesting",
  "provideRouter",
  "provideAnimations",
  "provideAnimationsAsync",
  "provideNoopAnimations",
  "provideZoneChangeDetection",
  "provideZonelessChangeDetection",
  "provideAppInitializer",
  "provideEnvironmentInitializer",
  "bootstrapApplication",
  "createApplication",
  "platformBrowser",
  "platformBrowserDynamic"
]);

/** Tokens that may not be used as a `provide:` value (15 §5.6.7 step 7). */
export const ANGULAR_FORBIDDEN_PROVIDER_TOKENS: ReadonlySet<string> = new Set([
  "HttpBackend",
  "HttpXhrBackend",
  "FetchBackend",
  "APP_INITIALIZER",
  "ENVIRONMENT_INITIALIZER",
  "PLATFORM_INITIALIZER"
]);

const ANGULAR_TESTING_MODULES = [
  "@angular/core/testing",
  "@angular/common/http/testing",
  "@angular/router/testing",
  "@angular/platform-browser/testing"
];

/**
 * Inputs and outputs of common Angular directives that may sit on the target's element in a host template
 * (forms, NgClass/NgStyle, router). They are not the target's own bindings, so they are not reported as unknown.
 */
const DIRECTIVE_BINDINGS: ReadonlySet<string> = new Set([
  "ngClass",
  "ngStyle",
  "ngModel",
  "ngModelChange",
  "ngModelOptions",
  "formControl",
  "formControlName",
  "formGroup",
  "formGroupName",
  "formArrayName",
  "routerLink",
  "routerLinkActive",
  "queryParams",
  "ngTemplateOutlet",
  "ngTemplateOutletContext"
]);

const STYLE_IMPORT = /\.(css|scss|sass|less|styl)(\?.*)?$/;
const RELATIVE_EXTENSIONS = [".ts", ".tsx", ".mjs", ".js"] as const;
const FORBIDDEN_MOCK_PREFIX = /^(\/|file:|http:|https:|data:)/;
const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);
const NETWORK_CONSTRUCTORS = new Set(["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker"]);
const NONDETERMINISTIC_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  Date: ["now"],
  performance: ["now"],
  Math: ["random"],
  crypto: ["randomUUID", "getRandomValues"]
};
const TIMERS = new Set(["setTimeout", "requestAnimationFrame"]);
const RXJS_TIMERS = new Set(["interval", "timer"]);
const NETWORK_HINT =
  "the harness and its file replacements must never touch the network; use http fixtures or a DI fake";
const DETERMINISM_HINT = "renders must be deterministic; use fixed literal values such as '2024-03-14T09:30:00Z'";

// ---------------------------------------------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------------------------------------------

/** A syntax diagnostic with a 1-based position. */
interface SyntaxProblem {
  message: string;
  line: number;
  column: number;
}

/** Syntactic diagnostics of a `.ts` module (transpileModule, no program, experimental decorators). */
export function angularSyntaxProblems(source: string, fileName: string): SyntaxProblem[] {
  const output = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true,
      experimentalDecorators: true
    }
  });
  return (output.diagnostics ?? [])
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) => {
      const position =
        diagnostic.file && diagnostic.start !== undefined
          ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
          : { line: 0, character: 0 };
      return {
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        line: position.line + 1,
        column: position.character + 1
      };
    });
}

function parseTs(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function isForbiddenAngularModule(specifier: string): boolean {
  if (isForbiddenModule(specifier)) {
    return true;
  }
  if (ANGULAR_TESTING_MODULES.some((name) => specifier === name || specifier.startsWith(`${name}/`))) {
    return true;
  }
  const name = packageNameOf(specifier);
  return name !== null && (name.startsWith("jasmine") || name.startsWith("karma") || name.startsWith("@types/jasmine"));
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  if (ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return null;
}

/** Property `name` of an object literal (property assignment, shorthand or method), or undefined. */
function findProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find(
    (property) => !ts.isSpreadAssignment(property) && propertyNameText(property.name) === name
  );
}

function initializerOf(property: ts.ObjectLiteralElementLike | undefined): ts.Expression | undefined {
  if (property === undefined) {
    return undefined;
  }
  if (ts.isPropertyAssignment(property)) {
    return property.initializer;
  }
  if (ts.isShorthandPropertyAssignment(property)) {
    return property.name;
  }
  return undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isNonNullExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function isStringLike(expression: ts.Expression): expression is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral {
  return ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression);
}

/** A literal setup argument: string/number/boolean literal, or JSON.stringify of a literal object or array. */
function isLiteralArgument(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (
    isStringLike(node) ||
    ts.isNumericLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "JSON" &&
    node.expression.name.text === "stringify" &&
    node.arguments.length >= 1
  ) {
    const [value] = node.arguments;
    return value !== undefined && isLiteralValue(value);
  }
  return false;
}

function isLiteralValue(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (ts.isObjectLiteralExpression(node)) {
    return node.properties.every(
      (property) => ts.isPropertyAssignment(property) && isLiteralValue(property.initializer)
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return node.elements.every((element) => isLiteralValue(element));
  }
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    return ts.isNumericLiteral(node.operand);
  }
  return isLiteralArgument(node);
}

/** `document.documentElement` (optionally through window/globalThis). */
function isDocumentElement(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (!ts.isPropertyAccessExpression(node) || node.name.text !== "documentElement") {
    return false;
  }
  const owner = unwrap(node.expression);
  if (ts.isIdentifier(owner)) {
    return owner.text === "document";
  }
  return (
    ts.isPropertyAccessExpression(owner) &&
    owner.name.text === "document" &&
    ts.isIdentifier(owner.expression) &&
    GLOBAL_OBJECTS.has(owner.expression.text)
  );
}

function isStorage(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  const storage = (name: string): boolean => name === "localStorage" || name === "sessionStorage";
  if (ts.isIdentifier(node)) {
    return storage(node.text);
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    storage(node.name.text) &&
    ts.isIdentifier(node.expression) &&
    GLOBAL_OBJECTS.has(node.expression.text)
  );
}

/** One allowed setup statement (15 §5.6.7 step 7). */
function isAllowedSetupExpression(expression: ts.Expression): boolean {
  const node = unwrap(expression);
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text;
    const literalArgs = node.arguments.length > 0 && node.arguments.every((argument) => isLiteralArgument(argument));
    if (method === "setAttribute" && isDocumentElement(node.expression.expression)) {
      return literalArgs;
    }
    if (method === "setItem" && isStorage(node.expression.expression)) {
      return literalArgs;
    }
    return false;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = unwrap(node.left);
    const owner =
      ts.isPropertyAccessExpression(target) || ts.isElementAccessExpression(target) ? unwrap(target.expression) : null;
    const isDatasetWrite =
      owner !== null &&
      ts.isPropertyAccessExpression(owner) &&
      owner.name.text === "dataset" &&
      isDocumentElement(owner.expression) &&
      (ts.isPropertyAccessExpression(target) ||
        (ts.isElementAccessExpression(target) && isStringLike(unwrap(target.argumentExpression))));
    return isDatasetWrite && isLiteralArgument(node.right);
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// API scan (15 §5.6.7 step 7)
// ---------------------------------------------------------------------------------------------------------------

function calleeName(expression: ts.Expression): { object: string | null; name: string } | null {
  if (ts.isIdentifier(expression)) {
    return { object: null, name: expression.text };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const object = expression.expression;
    const objectName = ts.isIdentifier(object)
      ? object.text
      : ts.isPropertyAccessExpression(object)
        ? object.name.text
        : null;
    return { object: objectName, name: expression.name.text };
  }
  return null;
}

/** Local names bound to rxjs `interval`/`timer`, and rxjs namespace import names. */
function rxjsTimerBindings(sf: ts.SourceFile): { functions: Set<string>; namespaces: Set<string> } {
  const functions = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      (statement.moduleSpecifier.text !== "rxjs" && !statement.moduleSpecifier.text.startsWith("rxjs/"))
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined) {
      continue;
    }
    if (ts.isNamespaceImport(bindings)) {
      namespaces.add(bindings.name.text);
      continue;
    }
    for (const element of bindings.elements) {
      if (RXJS_TIMERS.has((element.propertyName ?? element.name).text)) {
        functions.add(element.name.text);
      }
    }
  }
  return { functions, namespaces };
}

/** Forbidden providers, network, nondeterminism and code-evaluation APIs anywhere in one module. */
export function scanAngularApis(sf: ts.SourceFile, label: string, report: Report): void {
  const rxjs = rxjsTimerBindings(sf);
  const at = (node: ts.Node): string => locationOf(label, sf, node);
  const network = (node: ts.Node, api: string): void => {
    report("network_api", "error", `Do not use ${api}: ${NETWORK_HINT}.`, at(node));
  };
  const nondeterministic = (node: ts.Node, api: string): void => {
    report("nondeterministic_api", "error", `Do not use ${api}: ${DETERMINISM_HINT}.`, at(node));
  };
  const forbidden = (node: ts.Node, api: string, why: string): void => {
    report("forbidden_api", "error", `Do not use ${api}: ${why}.`, at(node));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        forbidden(node, "dynamic import()", "import every module statically at the top of the file");
      }
      const callee = calleeName(node.expression);
      if (callee !== null) {
        const global = callee.object === null || GLOBAL_OBJECTS.has(callee.object);
        if (ANGULAR_FORBIDDEN_PROVIDER_CALLS.has(callee.name)) {
          report(
            "forbidden_provider",
            "error",
            `Do not call ${callee.name}: the render page already bootstraps the application with the HTTP client, router, animations and change detection it needs.`,
            at(node)
          );
        } else if (callee.object === null && callee.name === "fetch") {
          network(node, "fetch");
        } else if (callee.object === null && callee.name === "importScripts") {
          network(node, "importScripts");
        } else if (callee.object === null && callee.name === "Date") {
          nondeterministic(node, "Date()");
        } else if (global && callee.name === "setInterval") {
          nondeterministic(node, "setInterval");
        } else if (
          (callee.object === null && rxjs.functions.has(callee.name)) ||
          (callee.object !== null && rxjs.namespaces.has(callee.object) && RXJS_TIMERS.has(callee.name))
        ) {
          nondeterministic(node, `rxjs ${callee.name}()`);
        } else if (callee.object === null && callee.name === "eval") {
          forbidden(node, "eval", "it executes arbitrary code");
        } else if (callee.object === null && callee.name === "Function") {
          forbidden(node, "Function()", "it executes arbitrary code");
        } else if (global && TIMERS.has(callee.name)) {
          report(
            "timer_usage",
            "warning",
            `${callee.name} delays what is rendered; fakes should return synchronously or with of(…).`,
            at(node)
          );
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const object = calleeName(node)?.object ?? null;
      const name = node.name.text;
      if (object !== null && GLOBAL_OBJECTS.has(object) && name === "fetch") {
        network(node, `${object}.fetch`);
      } else if (object === "navigator" && name === "sendBeacon") {
        network(node, "navigator.sendBeacon");
      } else if (object !== null && NONDETERMINISTIC_MEMBERS[object]?.includes(name) === true) {
        nondeterministic(node, `${object}.${name}`);
      }
    } else if (ts.isNewExpression(node)) {
      const callee = calleeName(node.expression);
      if (callee !== null && (callee.object === null || GLOBAL_OBJECTS.has(callee.object))) {
        if (NETWORK_CONSTRUCTORS.has(callee.name)) {
          network(node, `new ${callee.name}`);
        } else if (callee.name === "Date" && (node.arguments === undefined || node.arguments.length === 0)) {
          nondeterministic(node, "new Date() without arguments");
        } else if (callee.name === "Function") {
          forbidden(node, "new Function", "it executes arbitrary code");
        }
      }
    } else if (ts.isPropertyAssignment(node) && propertyNameText(node.name) === "provide") {
      const value = unwrap(node.initializer);
      const token = ts.isIdentifier(value) ? value.text : ts.isPropertyAccessExpression(value) ? value.name.text : null;
      if (token !== null && ANGULAR_FORBIDDEN_PROVIDER_TOKENS.has(token)) {
        report(
          "forbidden_provider",
          "error",
          `Do not provide ${token}: the render page owns the HTTP backend and the application initializers.`,
          at(node)
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------------
// Host template checks (15 §5.6.7 step 5)
// ---------------------------------------------------------------------------------------------------------------

interface HostElement {
  node: TmplAstElement | TmplAstTemplate;
  name: string;
  line: number;
  boundInputs: string[]; // property and two-way bindings
  outputs: string[]; // event bindings (two-way implicit events excluded)
  staticAttributes: string[];
  classBinding: boolean;
}

class HostTemplateCollector extends TmplAstRecursiveVisitor {
  readonly elements: HostElement[] = [];

  override visitElement(element: TmplAstElement): void {
    this.collect(element, element.name);
    super.visitElement(element);
  }

  override visitTemplate(template: TmplAstTemplate): void {
    if (template.tagName !== null && template.tagName !== "ng-template") {
      this.collect(template, template.tagName);
    }
    super.visitTemplate(template);
  }

  private collect(node: TmplAstElement | TmplAstTemplate, name: string): void {
    const boundInputs: string[] = [];
    let classBinding = false;
    for (const input of node.inputs) {
      const property = input.type === BindingType.Property || input.type === BindingType.Attribute;
      if (input.type === BindingType.Class || (property && (input.name === "class" || input.name === "className"))) {
        classBinding = true;
        continue;
      }
      if (input.name === "ngClass") {
        classBinding = true;
      }
      if (input.type === BindingType.Property || input.type === BindingType.TwoWay) {
        boundInputs.push(input.name);
      }
    }
    const outputs = node.outputs
      .filter((output) => output.type !== ParsedEventType.TwoWay)
      .map((output) => output.name);
    const staticAttributes = node.attributes.map((attribute) => attribute.name);
    if (staticAttributes.includes("class")) {
      classBinding = true;
    }
    this.elements.push({
      node,
      name,
      line: node.sourceSpan.start.line + 1,
      boundInputs,
      outputs,
      staticAttributes,
      classBinding
    });
  }
}

function matchesSelector(selector: string, element: HostElement): boolean {
  let matched = false;
  try {
    const matcher = new SelectorMatcher<true>();
    matcher.addSelectables(CssSelector.parse(selector), true);
    matcher.match(createCssSelectorFromNode(element.node), () => {
      matched = true;
    });
  } catch {
    return element.name === selector;
  }
  return matched;
}

// ---------------------------------------------------------------------------------------------------------------
// AngularHarnessValidator
// ---------------------------------------------------------------------------------------------------------------

interface DescriptorInfo {
  object: ts.ObjectLiteralExpression;
}

/** Static checks of one Angular harness and its file replacements (15 §5.6.7). */
export class AngularHarnessValidator {
  constructor(
    private readonly queries: AngularSourceQueriesLike,
    private readonly fileExists: (side: WorktreeSide, repoRelativePath: string) => Promise<boolean>
  ) {}

  /** Never throws for bad input; internal errors become a syntax_error issue. */
  async validate(input: HarnessValidationInput): Promise<HarnessValidationReport> {
    const issues: HarnessValidationIssue[] = [];
    const report: Report = (code, severity, message, location) => {
      issues.push({ code, severity, message, ...(location !== undefined ? { location } : {}) });
    };
    try {
      await this.run(input, report);
    } catch (error: unknown) {
      report("syntax_error", "error", `The harness could not be checked: ${getErrorMessage(error)}`);
    }
    const errors = issues.filter((issue) => issue.severity === "error");
    const warnings = issues.filter((issue) => issue.severity === "warning");
    log.debug(
      {
        event: "harness.angular.validation",
        codes: errors.map((issue) => issue.code),
        warningCodes: warnings.map((issue) => issue.code)
      },
      "Angular harness validated"
    );
    const ok = errors.length === 0;
    return { ok, errors, warnings, states: ok ? singleDefaultState() : null }; // 16a shim until 16b
  }

  private async run(input: HarnessValidationInput, report: Report): Promise<void> {
    const sides = (["base", "head"] as const).filter((side) => input.sidesPresent[side] && input.paths[side] !== null);
    const metas: Metas = {};
    for (const side of sides) {
      metas[side] = await this.metaOf(input.paths[side] ?? input.candidate.filePath, input.candidate.exportName, side);
    }
    // Step 1: size
    this.checkSizes(input, report);
    // Step 2: parse; harness checks stop on a syntax error (file replacements are still checked)
    const problems = angularSyntaxProblems(input.harnessSource, "harness.ts");
    for (const problem of problems) {
      report("syntax_error", "error", problem.message, `harness:${problem.line}:${problem.column}`);
    }
    if (problems.length === 0) {
      const sf = parseTs(input.harnessSource, "harness.ts");
      const descriptor = checkShape(sf, report);
      const targetLocal = this.checkTargetImport(sf, input, report);
      if (descriptor !== null && targetLocal !== null) {
        const mode = this.checkComponent(sf, descriptor, targetLocal, input, sides, metas, report);
        if (mode === "target") {
          checkInputs(descriptor, sides, metas, report, sf);
        }
      }
      scanAngularApis(sf, "harness", report);
      if (descriptor !== null) {
        checkSetup(sf, descriptor, report);
        checkHttp(sf, descriptor, report);
      }
      await this.checkImports(sf, input, sides, report);
    }
    // Step 10: file replacements
    await this.checkMocks(input, sides, report);
  }

  private async metaOf(filePath: string, exportName: string, side: WorktreeSide): Promise<AngularComponentMeta | null> {
    try {
      return await this.queries.getComponentMeta(filePath, exportName, side);
    } catch {
      return null;
    }
  }

  private checkSizes(input: HarnessValidationInput, report: Report): void {
    if (input.harnessSource.length > HARNESS_SOURCE_MAX_CHARS) {
      report(
        "size_limit",
        "error",
        `The harness is ${input.harnessSource.length} characters long; keep it under ${HARNESS_SOURCE_MAX_CHARS} characters.`,
        "harness"
      );
    }
    if (input.mockedModules.length > HARNESS_MAX_MOCKS) {
      report(
        "too_many_mocks",
        "error",
        `Use at most ${HARNESS_MAX_MOCKS} file replacements (got ${input.mockedModules.length}); prefer DI fakes and http fixtures.`
      );
    }
    for (const mock of input.mockedModules) {
      if (mock.source.length > HARNESS_MOCK_SOURCE_MAX_CHARS) {
        report(
          "size_limit",
          "error",
          `File replacement "${mock.specifier}" is ${mock.source.length} characters long; keep every replacement under ${HARNESS_MOCK_SOURCE_MAX_CHARS} characters.`,
          `mock ${mock.specifier}`
        );
      }
    }
  }

  private statementFor(input: HarnessValidationInput): string {
    if (input.targetImportStatement !== undefined) {
      return input.targetImportStatement;
    }
    return input.candidate.exportName === "default"
      ? `import TargetComponent from "${input.targetImportPath}";`
      : `import { ${input.candidate.exportName} } from "${input.targetImportPath}";`;
  }

  /** Step 4 (09 §5.8 step 4): the target import; returns the local name bound to the target, or null. */
  private checkTargetImport(sf: ts.SourceFile, input: HarnessValidationInput, report: Report): string | null {
    const statement = this.statementFor(input);
    const references = moduleReferences(sf);
    const targetImports = references.filter(
      (reference) => reference.kind === "import" && reference.specifier === input.targetImportPath
    );
    const otherTargetUses = references.filter(
      (reference) => reference.kind !== "import" && reference.specifier === input.targetImportPath
    );
    const first = targetImports[0];
    if (first === undefined) {
      report("target_not_imported", "error", `Import the target with exactly: ${statement}`);
      return null;
    }
    if (targetImports.length > 1 || otherTargetUses.length > 0) {
      report(
        "target_imported_twice",
        "error",
        `Import the target exactly once, with: ${statement}`,
        locationOf("harness", sf, first.node)
      );
    }
    const clause = first.importClause;
    let local: string | null = null;
    if (clause !== undefined && clause.phaseModifier !== ts.SyntaxKind.TypeKeyword) {
      if (input.candidate.exportName === "default") {
        local = clause.name?.text ?? null;
      } else if (clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)) {
        const element = clause.namedBindings.elements.find(
          (candidate) =>
            !candidate.isTypeOnly && (candidate.propertyName ?? candidate.name).text === input.candidate.exportName
        );
        local = element?.name.text ?? null;
      }
    }
    if (local === null) {
      const kind =
        input.candidate.exportName === "default"
          ? "the target is the module's default export"
          : `the target is the named export ${input.candidate.exportName}`;
      report(
        "target_binding_mismatch",
        "error",
        `The target import binds the wrong name (${kind}); import it with exactly: ${statement}`,
        locationOf("harness", sf, first.node)
      );
    }
    return local;
  }

  /** Step 5: `component` is the target or a host component that imports it. */
  private checkComponent(
    sf: ts.SourceFile,
    descriptor: DescriptorInfo,
    targetLocal: string,
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    metas: Metas,
    report: Report
  ): "target" | "host" | null {
    const property = findProperty(descriptor.object, "component");
    const value = initializerOf(property);
    if (value === undefined) {
      return null; // reported by the shape check
    }
    const expression = unwrap(value);
    const notTarget = (): null => {
      report(
        "component_not_target",
        "error",
        `component must be ${targetLocal} (imported with ${this.statementFor(input)}) or a standalone host component declared in this file whose imports list ${targetLocal}.`,
        locationOf("harness", sf, value)
      );
      return null;
    };
    if (!ts.isIdentifier(expression)) {
      return notTarget();
    }
    if (expression.text === targetLocal) {
      return "target";
    }
    const hostClass = sf.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === expression.text
    );
    const decorator = hostClass === undefined ? undefined : componentDecorator(hostClass);
    const metadata = decorator?.arguments[0] !== undefined ? unwrap(decorator.arguments[0]) : undefined;
    if (hostClass === undefined || decorator === undefined) {
      return notTarget();
    }
    if (metadata === undefined || !ts.isObjectLiteralExpression(metadata)) {
      report(
        "harness_shape",
        "error",
        "Declare the host component with @Component({ selector: 'prvision-host', imports: [...], template: '...' }).",
        locationOf("harness", sf, decorator.expression)
      );
      return null;
    }
    const imports = initializerOf(findProperty(metadata, "imports"));
    const importsTarget =
      imports !== undefined &&
      ts.isArrayLiteralExpression(unwrap(imports)) &&
      (unwrap(imports) as ts.ArrayLiteralExpression).elements.some(
        (element) => ts.isIdentifier(unwrap(element)) && (unwrap(element) as ts.Identifier).text === targetLocal
      );
    if (!importsTarget) {
      return notTarget();
    }
    checkHostMetadata(sf, metadata, targetLocal, sides, metas, report);
    return "host";
  }

  /** Step 8: imports (09 §5.8 step 5, resolved from <appRoot>/.prvision-harness/components/). */
  private async checkImports(
    sf: ts.SourceFile,
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    report: Report
  ): Promise<void> {
    const statement = this.statementFor(input);
    const entries = await this.entryFiles(input, sides);
    const reportedTwice = new Set<string>();
    for (const reference of moduleReferences(sf)) {
      const specifier = reference.specifier;
      if (
        specifier === input.targetImportPath ||
        specifier === ANGULAR_HARNESS_API_SPECIFIER ||
        reference.typeOnly ||
        reference.kind === "dynamic"
      ) {
        continue;
      }
      const location = locationOf("harness", sf, reference.node);
      if (STYLE_IMPORT.test(specifier)) {
        report(
          "style_import",
          "error",
          `Do not import stylesheets in the harness ("${specifier}"): global styles are applied by the build and components bring their own styles.`,
          location
        );
        continue;
      }
      if (isForbiddenAngularModule(specifier)) {
        report(
          "forbidden_import",
          "error",
          `Do not import "${specifier}": test utilities, test runners and Node built-in modules are not available in the render page.`,
          location
        );
        continue;
      }
      const resolved = new Map<WorktreeSide, string | null>();
      if (classifySpecifier(specifier) === "relative") {
        const repoPath = path.posix.normalize(path.posix.join(harnessDirRel(input.viteRootRel), specifier));
        const segments = repoPath.split("/");
        if (
          repoPath === ".." ||
          repoPath.startsWith("../") ||
          segments.includes("node_modules") ||
          segments.includes(".prvision-harness")
        ) {
          report(
            "relative_import_outside_worktree",
            "error",
            `The harness import "${specifier}" points outside the repository sources (${repoPath}); import repository modules by a path inside the worktree.`,
            location
          );
          continue;
        }
        for (const side of sides) {
          const found = await this.resolveRelativeFile(side, repoPath);
          resolved.set(side, found);
          if (found === null) {
            report(
              "relative_import_unresolved",
              "error",
              `The harness import "${specifier}" does not resolve to a file on the ${side} side (looked for ${repoPath}); import only modules that exist on every side the component exists on.`,
              location
            );
          }
        }
      } else {
        const unresolved: WorktreeSide[] = [];
        for (const side of sides) {
          const found = await this.queries.resolveSpecifier(
            input.paths[side] ?? input.candidate.filePath,
            specifier,
            side
          );
          resolved.set(side, found);
          if (found === null) {
            unresolved.push(side);
          }
        }
        if (unresolved.length > 0 && packageNameOf(specifier) === null) {
          report(
            "alias_import_unverified",
            "warning",
            `The harness import "${specifier}" could not be resolved on the ${unresolved.join(" and ")} side; check that the path alias exists in the repository's tsconfig.`,
            location
          );
        }
      }
      for (const [side, found] of resolved) {
        if (found !== null && found === input.paths[side] && !reportedTwice.has(specifier)) {
          reportedTwice.add(specifier);
          report(
            "target_imported_twice",
            "error",
            `"${specifier}" is the target component file again; import the target only with: ${statement}`,
            location
          );
        }
        if (found !== null && entries.has(found)) {
          report(
            "entry_import",
            "error",
            `Do not import ${found}: it is the application entry or its bootstrap configuration and starts the whole application.`,
            location
          );
          break;
        }
      }
    }
  }

  /** The application entry and the files that hold the bootstrap providers (`getAppProviders` sources). */
  private async entryFiles(input: HarnessValidationInput, sides: readonly WorktreeSide[]): Promise<Set<string>> {
    const entries = new Set<string>();
    if (input.entryFilePath !== null) {
      entries.add(input.entryFilePath);
    }
    for (const side of sides) {
      try {
        for (const provider of await this.queries.getAppProviders(side)) {
          entries.add(provider.source);
        }
      } catch {
        // getAppProviders never rejects (15b); an unexpected error only weakens this check
      }
    }
    return entries;
  }

  private async resolveRelativeFile(side: WorktreeSide, repoPath: string): Promise<string | null> {
    const candidates = [
      ...RELATIVE_EXTENSIONS.map((extension) => `${repoPath}${extension}`),
      ...RELATIVE_EXTENSIONS.map((extension) => `${repoPath}/index${extension}`),
      repoPath
    ];
    for (const candidate of candidates) {
      if (await this.fileExists(side, candidate)) {
        return candidate;
      }
    }
    return null;
  }

  // ---- Step 10: file replacements ----

  private async checkMocks(
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    report: Report
  ): Promise<void> {
    const mocks: MockedModule[] = input.mockedModules.map(({ specifier, source }) => ({ specifier, source }));
    const validation = validateMockedModules(mocks);
    for (const rejected of validation.rejected) {
      report(
        rejected.duplicate ? "mock_duplicate_specifier" : "mock_forbidden_specifier",
        "error",
        rejected.duplicate
          ? `File replacement "${rejected.specifier}" appears more than once (${rejected.reason}); return a single replacement per specifier.`
          : `File replacement "${rejected.specifier}" cannot be used: ${rejected.reason}.`,
        `mock ${rejected.specifier}`
      );
    }
    for (const mock of validation.accepted) {
      await this.checkMock(mock, input, sides, report);
    }
  }

  private async checkMock(
    mock: MockedModule,
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    report: Report
  ): Promise<void> {
    const { specifier } = mock;
    const label = `mock ${specifier}`;
    if (specifier.length > HARNESS_MOCK_SPECIFIER_MAX_CHARS || FORBIDDEN_MOCK_PREFIX.test(specifier)) {
      report(
        "mock_forbidden_specifier",
        "error",
        `File replacement "${specifier.slice(0, HARNESS_MOCK_SPECIFIER_MAX_CHARS)}" cannot be used: write the specifier exactly as it appears in an import statement (no absolute paths or URLs, at most ${HARNESS_MOCK_SPECIFIER_MAX_CHARS} characters).`,
        label
      );
      return;
    }
    const targetMessage = `Never replace the target component's own file ("${specifier}").`;
    if (specifier === input.targetImportPath) {
      report("mock_forbidden_specifier", "error", targetMessage, label);
      return;
    }
    const resolved = new Map<WorktreeSide, string | null>();
    for (const side of sides) {
      resolved.set(
        side,
        await this.queries.resolveSpecifier(input.paths[side] ?? input.candidate.filePath, specifier, side)
      );
    }
    const repoFile = (value: string | null | undefined): value is string =>
      value !== null && value !== undefined && !value.startsWith("package:");
    if (packageNameOf(specifier) !== null && !sides.some((side) => repoFile(resolved.get(side)))) {
      report(
        "mock_package_specifier",
        "error",
        `File replacement "${specifier}" names a package. Angular harnesses cannot mock packages; provide a DI fake instead.`,
        label
      );
      return;
    }
    if (sides.some((side) => resolved.get(side) === input.paths[side])) {
      report("mock_forbidden_specifier", "error", targetMessage, label);
      return;
    }
    const appRootRel = input.viteRootRel;
    const insideAppRoot = (file: string): boolean => appRootRel === "" || file.startsWith(`${appRootRel}/`);
    const replaceable = sides.some((side) => {
      const file = resolved.get(side);
      return repoFile(file) && file.endsWith(".ts") && !file.endsWith(".d.ts") && insideAppRoot(file);
    });
    if (!replaceable) {
      report(
        "mock_unresolvable_specifier",
        "error",
        `File replacement "${specifier}" must resolve from ${input.candidate.filePath} to a repository .ts file inside ${appRootRel === "" ? "the repository" : appRootRel}; use the specifier as written in the import statement.`,
        label
      );
    }
    const problems = angularSyntaxProblems(mock.source, "replacement.ts");
    for (const problem of problems) {
      report(
        "mock_syntax_error",
        "error",
        `File replacement "${specifier}" is not valid TypeScript: ${problem.message}`,
        `${label}:${problem.line}:${problem.column}`
      );
    }
    if (problems.length > 0) {
      return;
    }
    const sf = parseTs(mock.source, "replacement.ts");
    scanAngularApis(sf, label, report);
    await this.checkMockImports(sf, mock, input, sides, resolved, report);
    await this.checkMockExports(sf, mock, input, sides, resolved, report);
  }

  private async checkMockImports(
    sf: ts.SourceFile,
    mock: MockedModule,
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    replaced: ReadonlyMap<WorktreeSide, string | null>,
    report: Report
  ): Promise<void> {
    const label = `mock ${mock.specifier}`;
    for (const reference of moduleReferences(sf)) {
      if (reference.typeOnly) {
        continue;
      }
      const specifier = reference.specifier;
      const location = locationOf(label, sf, reference.node);
      let selfImport = specifier === mock.specifier;
      for (const side of sides) {
        const target = replaced.get(side) ?? null;
        if (selfImport || target === null || target.startsWith("package:")) {
          continue;
        }
        const found = await this.queries.resolveSpecifier(
          input.paths[side] ?? input.candidate.filePath,
          specifier,
          side
        );
        selfImport = found === target;
      }
      if (selfImport) {
        report("mock_forbidden_specifier", "error", "A file replacement cannot import the file it replaces.", location);
        continue;
      }
      if (STYLE_IMPORT.test(specifier)) {
        report(
          "style_import",
          "error",
          `File replacement "${mock.specifier}" must not import stylesheets ("${specifier}").`,
          location
        );
        continue;
      }
      if (isForbiddenAngularModule(specifier)) {
        report(
          "forbidden_import",
          "error",
          `File replacement "${mock.specifier}" must not import "${specifier}": test utilities, test runners and Node built-in modules are not available in the render page.`,
          location
        );
      }
    }
  }

  private async checkMockExports(
    sf: ts.SourceFile,
    mock: MockedModule,
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    resolved: ReadonlyMap<WorktreeSide, string | null>,
    report: Report
  ): Promise<void> {
    const label = `mock ${mock.specifier}`;
    const exported = runtimeExports(sf);
    const required = new Set<string>();
    let namespace = false;
    for (const side of sides) {
      for (const entry of input.directImports[side]) {
        if (entry.specifier !== mock.specifier || entry.typeOnly) {
          continue;
        }
        entry.namedImports.forEach((name) => required.add(name));
        if (entry.defaultImport) {
          required.add("default");
        }
        namespace ||= entry.namespaceImport;
      }
    }
    if (namespace) {
      report(
        "namespace_import_parity_skipped",
        "warning",
        `${input.candidate.filePath} imports "${mock.specifier}" as a namespace, so PRVision cannot check which names the replacement needs; export every runtime name of the real module.`,
        label
      );
    }
    if (exported.wildcard) {
      return;
    }
    const missing = [...required].filter((name) => !exported.names.has(name)).sort();
    if (missing.length > 0) {
      report(
        "mock_missing_export",
        "error",
        `File replacement "${mock.specifier}" must export: ${missing.join(", ")} (imported by ${input.candidate.filePath}).`,
        label
      );
    }
    const incomplete = new Set<string>();
    for (const side of sides) {
      const target = resolved.get(side) ?? null;
      if (target === null || target.startsWith("package:")) {
        continue;
      }
      const realExports = (await this.queries.getModuleExports(target, side)) ?? [];
      realExports
        .filter((name) => !exported.names.has(name) && !missing.includes(name))
        .forEach((name) => incomplete.add(name));
    }
    if (incomplete.size > 0) {
      const names = [...incomplete].sort();
      const listed = names.slice(0, 10).join(", ") + (names.length > 10 ? `, … (${names.length - 10} more)` : "");
      report(
        "mock_export_incomplete",
        "warning",
        `File replacement "${mock.specifier}" does not export ${listed}, which the real module exports; other importers of the file may break.`,
        label
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Step 3: module shape
// ---------------------------------------------------------------------------------------------------------------

/** Local names bound to definePrvisionHarness imported from '../harness-api'. */
function defineHarnessBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== ANGULAR_HARNESS_API_SPECIFIER
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (
      bindings === undefined ||
      !ts.isNamedImports(bindings) ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    for (const element of bindings.elements) {
      if (!element.isTypeOnly && (element.propertyName ?? element.name).text === DEFINE_HARNESS) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Exactly one `export default definePrvisionHarness({ … })`; returns its descriptor object. */
function checkShape(sf: ts.SourceFile, report: Report): DescriptorInfo | null {
  const defaults: ts.Node[] = [];
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
      defaults.push(statement);
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      defaults.push(statement);
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      if (statement.exportClause.elements.some((element) => element.name.text === "default")) {
        defaults.push(statement);
      }
    }
  }
  const first = defaults[0];
  if (first === undefined) {
    report("harness_shape", "error", SHAPE_HINT);
    return null;
  }
  if (defaults.length > 1) {
    report(
      "harness_shape",
      "error",
      `Export exactly one default export. ${SHAPE_HINT}`,
      locationOf("harness", sf, first)
    );
    return null;
  }
  const bindings = defineHarnessBindings(sf);
  const expression = ts.isExportAssignment(first) ? unwrap(first.expression) : null;
  if (
    expression === null ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !bindings.has(expression.expression.text) ||
    expression.arguments.length !== 1 ||
    expression.arguments[0] === undefined ||
    !ts.isObjectLiteralExpression(unwrap(expression.arguments[0]))
  ) {
    report("harness_shape", "error", SHAPE_HINT, locationOf("harness", sf, first));
    return null;
  }
  const object = unwrap(expression.arguments[0]) as ts.ObjectLiteralExpression;
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      report(
        "harness_shape",
        "error",
        "Write the harness descriptor as a plain object literal without spreads.",
        locationOf("harness", sf, property)
      );
      continue;
    }
    const name = propertyNameText(property.name);
    if (name === null || !DESCRIPTOR_KEYS.has(name)) {
      report(
        "harness_shape",
        "error",
        `Unknown key ${name ?? property.getText(sf)} in definePrvisionHarness({...}); allowed keys: component, inputs, providers, http, hostStyle, setup.`,
        locationOf("harness", sf, property)
      );
    }
  }
  if (findProperty(object, "component") === undefined) {
    report(
      "harness_shape",
      "error",
      `The harness must set component. ${SHAPE_HINT}`,
      locationOf("harness", sf, object)
    );
  }
  return { object };
}

// ---------------------------------------------------------------------------------------------------------------
// Step 5: host component
// ---------------------------------------------------------------------------------------------------------------

function componentDecorator(node: ts.ClassDeclaration): ts.CallExpression | undefined {
  for (const decorator of ts.getDecorators(node) ?? []) {
    const expression = decorator.expression;
    if (!ts.isCallExpression(expression)) {
      continue;
    }
    const callee = expression.expression;
    const name = ts.isIdentifier(callee)
      ? callee.text
      : ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : null;
    if (name === "Component") {
      return expression;
    }
  }
  return undefined;
}

function checkHostMetadata(
  sf: ts.SourceFile,
  metadata: ts.ObjectLiteralExpression,
  targetLocal: string,
  sides: readonly WorktreeSide[],
  metas: Metas,
  report: Report
): void {
  const at = (node: ts.Node): string => locationOf("harness", sf, node);
  const selector = initializerOf(findProperty(metadata, "selector"));
  if (
    selector === undefined ||
    !isStringLike(unwrap(selector)) ||
    (unwrap(selector) as ts.StringLiteral).text !== HOST_SELECTOR
  ) {
    report(
      "harness_shape",
      "error",
      `The host component's selector must be '${HOST_SELECTOR}'.`,
      at(selector ?? metadata)
    );
  }
  const standalone = initializerOf(findProperty(metadata, "standalone"));
  if (standalone !== undefined && unwrap(standalone).kind === ts.SyntaxKind.FalseKeyword) {
    report("harness_shape", "error", "The host component must be standalone.", at(standalone));
  }
  for (const key of ["styles", "styleUrl", "styleUrls"]) {
    const property = findProperty(metadata, key);
    if (property !== undefined) {
      report(
        "harness_class_name",
        "warning",
        `Remove ${key} from the host component: style the elements it creates only with inline style attributes.`,
        at(property)
      );
    }
  }
  const templateUrl = findProperty(metadata, "templateUrl");
  if (templateUrl !== undefined) {
    report(
      "harness_shape",
      "error",
      "The host component must use an inline template, not templateUrl.",
      at(templateUrl)
    );
  }
  const template = initializerOf(findProperty(metadata, "template"));
  if (template === undefined) {
    if (templateUrl === undefined) {
      report(
        "harness_shape",
        "error",
        "The host component needs an inline template that renders the target.",
        at(metadata)
      );
    }
    return;
  }
  const literal = unwrap(template);
  if (!isStringLike(literal)) {
    report("harness_shape", "error", "Write the host component's template as one string literal.", at(template));
    return;
  }
  checkHostTemplate(literal.text, at(template), targetLocal, sides, metas, report);
}

function checkHostTemplate(
  text: string,
  location: string,
  targetLocal: string,
  sides: readonly WorktreeSide[],
  metas: Metas,
  report: Report
): void {
  let parsed: ReturnType<typeof parseTemplate>;
  try {
    parsed = parseTemplate(text, "prvision-host.html", { preserveWhitespaces: false });
  } catch (error: unknown) {
    report(
      "host_template_error",
      "error",
      `The host template could not be parsed: ${getErrorMessage(error)}`,
      location
    );
    return;
  }
  if (parsed.errors !== null && parsed.errors.length > 0) {
    const messages = parsed.errors.slice(0, 3).map((error) => error.msg);
    report("host_template_error", "error", `The host template does not parse: ${messages.join("; ")}`, location);
    return;
  }
  const collector = new HostTemplateCollector();
  tmplAstVisitAll(collector, parsed.nodes);
  if (collector.elements.some((element) => element.classBinding)) {
    report(
      "harness_class_name",
      "warning",
      "Style the elements the host template creates with inline style attributes, not class, [class] or [ngClass]: utility classes used only in the harness are not generated.",
      location
    );
  }
  for (const side of sides) {
    const meta = metas[side];
    if (meta === null || meta === undefined || meta.selector === null) {
      continue;
    }
    const inputs = new Set(meta.inputs.map((input) => input.alias ?? input.name));
    const outputs = new Set([
      ...meta.outputs.map((output) => output.alias ?? output.name),
      ...meta.inputs.filter((input) => input.kind === "model").map((input) => `${input.alias ?? input.name}Change`)
    ]);
    const required = meta.inputs.filter((input) => input.required).map((input) => input.alias ?? input.name);
    for (const element of collector.elements.filter((candidate) => matchesSelector(meta.selector ?? "", candidate))) {
      const where = `<${element.name}> (host template line ${element.line})`;
      for (const name of element.boundInputs) {
        if (!inputs.has(name) && !DIRECTIVE_BINDINGS.has(name)) {
          report(
            "host_template_error",
            "error",
            `The host template binds [${name}] on ${where}, but ${targetLocal} has no input named ${name} on the ${side} side.`,
            location
          );
        }
      }
      for (const name of element.outputs) {
        if (!outputs.has(name) && !DIRECTIVE_BINDINGS.has(name)) {
          report(
            "host_template_error",
            "error",
            `The host template listens to (${name}) on ${where}, but ${targetLocal} has no output named ${name} on the ${side} side.`,
            location
          );
        }
      }
      for (const name of required) {
        if (!element.boundInputs.includes(name) && !element.staticAttributes.includes(name)) {
          report(
            "host_template_error",
            "error",
            `The host template does not set the required input ${name} on ${where} (required on the ${side} side).`,
            location
          );
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Steps 6, 7 (setup) and 9
// ---------------------------------------------------------------------------------------------------------------

/** Step 6: `inputs` keys against the target's public input names on every present side. */
function checkInputs(
  descriptor: DescriptorInfo,
  sides: readonly WorktreeSide[],
  metas: Metas,
  report: Report,
  sf: ts.SourceFile
): void {
  const property = findProperty(descriptor.object, "inputs");
  const value = initializerOf(property);
  let keys: Array<{ name: string; node: ts.Node }> | null = [];
  if (value !== undefined) {
    const object = unwrap(value);
    if (!ts.isObjectLiteralExpression(object) || object.properties.some((element) => ts.isSpreadAssignment(element))) {
      keys = null; // not statically known
    } else {
      keys = [];
      for (const element of object.properties) {
        const name = element.name === undefined ? null : propertyNameText(element.name);
        if (name !== null) {
          keys.push({ name, node: element });
        }
      }
    }
  }
  if (keys === null) {
    return;
  }
  const primary: WorktreeSide | undefined = sides.includes("head") ? "head" : sides[0];
  for (const { name, node } of keys) {
    for (const side of sides) {
      const meta = metas[side];
      if (meta === null || meta === undefined) {
        continue;
      }
      if (!meta.inputs.some((input) => (input.alias ?? input.name) === name)) {
        const isPrimary = side === primary;
        report(
          "unknown_input",
          isPrimary ? "error" : "warning",
          isPrimary
            ? `${meta.className} has no input named ${name} on the ${side} side; use the public input names listed in <component_meta>.`
            : `${meta.className} has no input named ${name} on the ${side} side; that render skips it.`,
          locationOf("harness", sf, node)
        );
      }
    }
  }
  const given = new Set(keys.map((key) => key.name));
  for (const side of sides) {
    const meta = metas[side];
    if (meta === null || meta === undefined) {
      continue;
    }
    for (const input of meta.inputs) {
      const name = input.alias ?? input.name;
      if (input.required && !given.has(name)) {
        report(
          "missing_required_input",
          "error",
          `Set the required input ${name} of ${meta.className} in inputs (required on the ${side} side).`,
          property !== undefined ? locationOf("harness", sf, property) : undefined
        );
      }
    }
  }
}

/** Step 7 (setup): only document attributes, dataset values and storage seeds with literal arguments. */
function checkSetup(sf: ts.SourceFile, descriptor: DescriptorInfo, report: Report): void {
  const property = findProperty(descriptor.object, "setup");
  if (property === undefined) {
    return;
  }
  const warn = (node: ts.Node): void => {
    report(
      "setup_not_allowed",
      "warning",
      "setup may only set document.documentElement attributes or dataset values and seed localStorage/sessionStorage with literal values.",
      locationOf("harness", sf, node)
    );
  };
  let body: ts.ConciseBody | undefined;
  if (ts.isMethodDeclaration(property)) {
    body = property.body;
  } else {
    const value = initializerOf(property);
    const fn = value === undefined ? undefined : unwrap(value);
    if (fn !== undefined && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
      body = fn.body;
    } else {
      warn(property);
      return;
    }
  }
  if (body === undefined) {
    return;
  }
  if (!ts.isBlock(body)) {
    if (!isAllowedSetupExpression(body)) {
      warn(body);
    }
    return;
  }
  for (const statement of body.statements) {
    if (!ts.isExpressionStatement(statement) || !isAllowedSetupExpression(statement.expression)) {
      warn(statement);
    }
  }
}

/** Step 9: `http` is an array literal of object literals whose url is a string or regex literal. */
function checkHttp(sf: ts.SourceFile, descriptor: DescriptorInfo, report: Report): void {
  const property = findProperty(descriptor.object, "http");
  const value = initializerOf(property);
  if (property === undefined || value === undefined) {
    return;
  }
  const at = (node: ts.Node): string => locationOf("harness", sf, node);
  const hint =
    "http must be an array of { method?, url, status?, body?, headers? } with a string or RegExp literal url";
  const list = unwrap(value);
  if (!ts.isArrayLiteralExpression(list)) {
    report("harness_shape", "warning", `${hint}; PRVision could not check a non-literal value.`, at(value));
    return;
  }
  for (const element of list.elements) {
    const fixture = unwrap(element);
    if (!ts.isObjectLiteralExpression(fixture)) {
      report("harness_shape", "warning", `${hint}; PRVision could not check a non-literal entry.`, at(element));
      continue;
    }
    const url = initializerOf(findProperty(fixture, "url"));
    if (url === undefined) {
      report("harness_shape", "error", `${hint}; this entry has no url.`, at(fixture));
      continue;
    }
    const urlValue = unwrap(url);
    if (isStringLike(urlValue) || ts.isRegularExpressionLiteral(urlValue)) {
      continue;
    }
    const literalButWrong =
      ts.isNumericLiteral(urlValue) ||
      ts.isObjectLiteralExpression(urlValue) ||
      ts.isArrayLiteralExpression(urlValue) ||
      urlValue.kind === ts.SyntaxKind.TrueKeyword ||
      urlValue.kind === ts.SyntaxKind.FalseKeyword ||
      urlValue.kind === ts.SyntaxKind.NullKeyword;
    report(
      "harness_shape",
      literalButWrong ? "error" : "warning",
      literalButWrong ? `${hint}.` : `${hint}; PRVision could not check a non-literal url.`,
      at(url)
    );
  }
}
