/**
 * Static post-validation of AI harnesses and mocks (09 §5.7–5.8). Everything is AST-based with the TypeScript
 * compiler API (never regex over raw source), so strings and comments never trigger false positives. The code is
 * only parsed here, never executed; containment is sheet 10's job (static checks are not a sandbox).
 *
 * Mock specifier rules are 10's `validateMockedModules` (shared `mock-rules.ts`) plus the 09-only checks, so 09
 * rejects every mock 10 would reject.
 */
import { isBuiltin } from "node:module";
import path from "node:path";
import ts from "typescript";
import type {
  ComponentCandidate,
  ComponentSourceQueries,
  DirectImport,
  MockedModule,
  WorktreeSide
} from "../../../types/visualization-pipeline";
import type { HarnessStateSpec } from "../../../types/harness-library";
import { getErrorMessage } from "../../../utilities";
import { harnessDirRel } from "./harness-prompts";
import { extractHarnessStates, HARNESS_API_SPECIFIER } from "./harness-states";
import { classifySpecifier, packageNameOf, validateMockedModules } from "./mock-rules";

// ---------------------------------------------------------------------------------------------------------------
// Types (09 §5.8)
// ---------------------------------------------------------------------------------------------------------------

export type HarnessIssueCode =
  | "syntax_error"
  | "missing_default_export"
  | "default_export_wrong_name"
  | "target_not_imported"
  | "target_imported_twice"
  | "target_binding_mismatch"
  | "network_api"
  | "nondeterministic_api"
  | "forbidden_api"
  | "forbidden_import"
  | "style_import"
  | "entry_import"
  | "relative_import_unresolved"
  | "relative_import_outside_worktree"
  | "mock_syntax_error"
  | "mock_duplicate_specifier"
  | "mock_forbidden_specifier"
  | "mock_unresolvable_specifier"
  | "mock_missing_export"
  | "mock_import_unresolved"
  | "too_many_mocks"
  | "size_limit"
  // Raised by HarnessGenerationService, not by validate(): status component_defect on a first generation.
  | "invalid_status"
  // 16 §7.7.2: multi-state harness rules (both frameworks)
  | "state_list_not_literal"
  | "state_default_missing"
  | "state_name_invalid"
  | "state_duplicate"
  | "state_too_many"
  | "state_default_has_steps"
  | "state_step_invalid"
  | "state_render_missing"
  // Both frameworks since 16b (React: module shape). unknown_input and harness_shape can also be warnings (Angular).
  | "harness_shape"
  // Angular only (15 §5.6.7); React's validate() never emits them.
  | "component_not_target"
  | "host_template_error"
  | "unknown_input"
  | "missing_required_input"
  | "forbidden_provider"
  | "mock_package_specifier"
  // warnings
  | "mock_export_incomplete"
  | "alias_import_unverified"
  | "timer_usage"
  | "namespace_import_parity_skipped"
  | "harness_class_name"
  | "setup_not_allowed";

export interface HarnessValidationIssue {
  code: HarnessIssueCode;
  severity: "error" | "warning";
  message: string; // sentence the model can act on
  location?: string; // "harness:12:5" or "mock @/hooks/useAuth:3:1"
}

export interface HarnessValidationInput {
  harnessSource: string;
  mockedModules: Array<{ specifier: string; source: string }>;
  candidate: Pick<ComponentCandidate, "filePath" | "exportName">;
  paths: { base: string | null; head: string | null }; // HarnessContextPackage.paths
  viteRootRel: string;
  targetImportPath: string;
  directImports: { base: DirectImport[]; head: DirectImport[] };
  sidesPresent: { base: boolean; head: boolean };
  entryFilePath: string | null; // repository.entryFilePath
  /** The statement given to the model (HarnessContextPackage.targetImportStatement), quoted in messages. */
  targetImportStatement?: string;
  /** 16 §7.7.3: the repository's state allowance (1–5, Default included). */
  stateAllowance: number;
}

export interface HarnessValidationReport {
  ok: boolean; // no error-severity issues
  errors: HarnessValidationIssue[];
  warnings: HarnessValidationIssue[];
  /** 16 §6.12: states extracted from a valid harness, Default first; null when not ok. */
  states: HarnessStateSpec[] | null;
}

/** Size limits (09 §5.8), stricter than 10's defensive MOCK_SOURCE_MAX_CHARS. */
export const HARNESS_SOURCE_MAX_CHARS = 40_000;
export const HARNESS_MOCK_SOURCE_MAX_CHARS = 20_000;
export const HARNESS_MAX_MOCKS = 15;
export const HARNESS_MOCK_SPECIFIER_MAX_CHARS = 200;

// ---------------------------------------------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------------------------------------------

const STYLE_IMPORT = /\.(css|scss|sass|less|styl)(\?.*)?$/;
const SCRIPT_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;
const FORBIDDEN_MOCK_PREFIX = /^(\/|file:|http:|https:|data:)/;
const HARNESS_API_EXPORT = "definePrvisionHarness";

/** A syntax diagnostic with a 1-based position. */
export interface SyntaxProblem {
  message: string;
  line: number;
  column: number;
}

/**
 * Syntactic diagnostics only: `transpileModule` with `isolatedModules` and no program reports no type errors
 * (09 §5.8 step 2).
 */
export function syntaxProblems(source: string, fileName: string): SyntaxProblem[] {
  const output = ts.transpileModule(source, {
    fileName,
    reportDiagnostics: true,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      isolatedModules: true
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

function parse(source: string, fileName: string): ts.SourceFile {
  return ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

export function locationOf(label: string, sf: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `${label}:${line + 1}:${character + 1}`;
}

/** A module specifier used by an import, a re-export or a dynamic import() with a string literal. */
export interface ModuleReference {
  specifier: string;
  kind: "import" | "export" | "dynamic";
  typeOnly: boolean;
  node: ts.Node;
  importClause: ts.ImportClause | undefined;
}

export function moduleReferences(sf: ts.SourceFile): ModuleReference[] {
  const references: ModuleReference[] = [];
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      references.push({
        specifier: statement.moduleSpecifier.text,
        kind: "import",
        typeOnly: isTypeOnlyImport(statement.importClause),
        node: statement,
        importClause: statement.importClause
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier !== undefined &&
      ts.isStringLiteral(statement.moduleSpecifier)
    ) {
      references.push({
        specifier: statement.moduleSpecifier.text,
        kind: "export",
        typeOnly: statement.isTypeOnly,
        node: statement,
        importClause: undefined
      });
    }
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      references.push({
        specifier: node.arguments[0].text,
        kind: "dynamic",
        typeOnly: false,
        node,
        importClause: undefined
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return references;
}

function isTypeOnlyImport(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) {
    return false; // side-effect import
  }
  if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) {
    return true;
  }
  const named = clause.namedBindings;
  return (
    clause.name === undefined &&
    named !== undefined &&
    ts.isNamedImports(named) &&
    named.elements.length > 0 &&
    named.elements.every((element) => element.isTypeOnly)
  );
}

/** Runtime export names of a module; `wildcard` when it has `export * from` (satisfies every name). */
export function runtimeExports(sf: ts.SourceFile): { names: Set<string>; wildcard: boolean } {
  const names = new Set<string>();
  let wildcard = false;
  const bindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (!ts.isOmittedExpression(element)) {
        bindingNames(element.name);
      }
    }
  };
  for (const statement of sf.statements) {
    const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : [];
    const exported = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
    const isDefault = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword);
    const declare = modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
    if (exported && !declare) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        if (isDefault) {
          names.add("default");
        } else if (statement.name) {
          names.add(statement.name.text);
        }
      } else if (ts.isVariableStatement(statement)) {
        statement.declarationList.declarations.forEach((declaration) => {
          bindingNames(declaration.name);
        });
      } else if (ts.isEnumDeclaration(statement)) {
        names.add(statement.name.text);
      }
    }
    if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
      names.add("default");
    }
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      const clause = statement.exportClause;
      if (clause === undefined) {
        wildcard = true;
      } else if (ts.isNamespaceExport(clause)) {
        names.add(clause.name.text);
      } else {
        clause.elements.filter((element) => !element.isTypeOnly).forEach((element) => names.add(element.name.text));
      }
    }
  }
  return { names, wildcard };
}

export function isForbiddenModule(specifier: string): boolean {
  if (specifier.startsWith("node:") || isBuiltin(specifier)) {
    return true;
  }
  const name = packageNameOf(specifier);
  if (name === null) {
    return false;
  }
  return (
    name === "jest" ||
    name === "vitest" ||
    name === "msw" ||
    name.startsWith("@jest/") ||
    name.startsWith("@testing-library/")
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Forbidden API scan (09 §5.8 step 6)
// ---------------------------------------------------------------------------------------------------------------

const GLOBAL_OBJECTS = new Set(["window", "globalThis", "self"]);
const NETWORK_CONSTRUCTORS = new Set(["XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker"]);
const NONDETERMINISTIC_MEMBERS: Readonly<Record<string, readonly string[]>> = {
  Date: ["now"],
  performance: ["now"],
  Math: ["random"],
  crypto: ["randomUUID", "getRandomValues"]
};
const ROOT_FUNCTIONS = new Set(["createRoot", "hydrateRoot"]);
const REACT_DOM_RENDERERS = new Set(["render", "hydrate", "createRoot", "hydrateRoot"]);
const REACT_DOM_MODULES = new Set(["react-dom", "react-dom/client"]);
const DOCUMENT_PROPERTIES = new Set(["body", "title", "documentElement"]);
const TIMERS = new Set(["setTimeout", "requestAnimationFrame"]);

type Report = (code: HarnessIssueCode, severity: "error" | "warning", message: string, location?: string) => void;

function memberObjectName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  return ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
}

function calleeName(expression: ts.Expression): { object: string | null; name: string } | null {
  if (ts.isIdentifier(expression)) {
    return { object: null, name: expression.text };
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return { object: memberObjectName(expression.expression), name: expression.name.text };
  }
  return null;
}

function assignsDocumentProperty(target: ts.Expression): boolean {
  let current: ts.Expression = target;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    if (
      ts.isPropertyAccessExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "document" &&
      DOCUMENT_PROPERTIES.has(current.name.text)
    ) {
      return true;
    }
    current = current.expression;
  }
  return false;
}

function isAssignment(node: ts.BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  return kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
}

const NETWORK_HINT =
  "the harness and its mocks must never touch the network; mock the module that would make the request";
const DETERMINISM_HINT = 'renders must be deterministic; use fixed literal values such as "2024-03-14T09:30:00Z"';

function scanApis(sf: ts.SourceFile, label: string, isHarness: boolean, report: Report): void {
  const reactDomNamespaces = new Set<string>();
  const reactDomFunctions = new Set<string>();
  for (const statement of sf.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      REACT_DOM_MODULES.has(statement.moduleSpecifier.text) &&
      statement.importClause
    ) {
      const clause = statement.importClause;
      if (clause.name) {
        reactDomNamespaces.add(clause.name.text);
      }
      if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
        reactDomNamespaces.add(clause.namedBindings.name.text);
      } else if (clause.namedBindings) {
        for (const element of clause.namedBindings.elements) {
          if (REACT_DOM_RENDERERS.has((element.propertyName ?? element.name).text)) {
            reactDomFunctions.add(element.name.text);
          }
        }
      }
    }
  }
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
        if (callee.object === null && callee.name === "fetch") {
          network(node, "fetch");
        } else if (callee.object === null && callee.name === "importScripts") {
          network(node, "importScripts");
        } else if (callee.object === null && callee.name === "Date") {
          nondeterministic(node, "Date()");
        } else if (global && callee.name === "setInterval") {
          nondeterministic(node, "setInterval");
        } else if (callee.object === null && callee.name === "eval") {
          forbidden(node, "eval", "it executes arbitrary code");
        } else if (callee.object === null && callee.name === "Function") {
          forbidden(node, "Function()", "it executes arbitrary code");
        } else if (ROOT_FUNCTIONS.has(callee.name) || reactDomFunctions.has(callee.name)) {
          forbidden(node, callee.name, "the render page mounts the default export itself; never create React roots");
        } else if (
          callee.object !== null &&
          reactDomNamespaces.has(callee.object) &&
          REACT_DOM_RENDERERS.has(callee.name)
        ) {
          forbidden(node, `${callee.object}.${callee.name}`, "the render page mounts the default export itself");
        } else if (
          callee.name === "addEventListener" &&
          callee.object !== null &&
          (callee.object === "document" || GLOBAL_OBJECTS.has(callee.object))
        ) {
          forbidden(node, `${callee.object}.addEventListener`, "do not register global event listeners");
        } else if (global && TIMERS.has(callee.name)) {
          report(
            "timer_usage",
            "warning",
            `${callee.name} delays what is rendered; prefer fixtures that are ready on the first render.`,
            at(node)
          );
        }
      }
    } else if (ts.isPropertyAccessExpression(node)) {
      const object = memberObjectName(node.expression);
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
    } else if (ts.isBinaryExpression(node) && isAssignment(node) && assignsDocumentProperty(node.left)) {
      forbidden(
        node,
        "assignments to document.body, document.title or document.documentElement",
        "leave the page alone"
      );
    } else if (isHarness && ts.isJsxAttribute(node) && node.name.getText(sf) === "className") {
      const element = node.parent.parent;
      const tagName =
        ts.isJsxOpeningElement(element) || ts.isJsxSelfClosingElement(element) ? element.tagName : undefined;
      if (tagName !== undefined && ts.isIdentifier(tagName) && /^[a-z]/.test(tagName.text)) {
        report(
          "harness_class_name",
          "warning",
          `Style the <${tagName.text}> the harness creates with the inline style prop, not className: utility classes used only in the harness are not generated.`,
          at(node)
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// ---------------------------------------------------------------------------------------------------------------
// HarnessValidator
// ---------------------------------------------------------------------------------------------------------------

/** Static checks of one harness and its mocks (09 §5.8). */
export class HarnessValidator {
  constructor(
    private readonly queries: ComponentSourceQueries,
    private readonly fileExists: (side: WorktreeSide, repoRelativePath: string) => Promise<boolean> // fs.stat inside the side root (realpath-confined)
  ) {}

  /** Async because resolution goes through ComponentSourceQueries. Never throws for bad input; internal errors become a syntax_error issue. */
  async validate(input: HarnessValidationInput): Promise<HarnessValidationReport> {
    const issues: HarnessValidationIssue[] = [];
    const report: Report = (code, severity, message, location) => {
      issues.push({ code, severity, message, ...(location !== undefined ? { location } : {}) });
    };
    let states: HarnessStateSpec[] | null = null;
    try {
      states = await this.run(input, report);
    } catch (error: unknown) {
      report("syntax_error", "error", `The harness could not be checked: ${getErrorMessage(error)}`);
    }
    const errors = issues.filter((issue) => issue.severity === "error");
    const ok = errors.length === 0;
    return {
      ok,
      errors,
      warnings: issues.filter((issue) => issue.severity === "warning"),
      states: ok ? states : null
    };
  }

  /** Runs every check; returns the extracted states (null when the module shape or a state is invalid). */
  private async run(input: HarnessValidationInput, report: Report): Promise<HarnessStateSpec[] | null> {
    let states: HarnessStateSpec[] | null = null;
    const sides = (["base", "head"] as const).filter((side) => input.sidesPresent[side] && input.paths[side] !== null);
    // Step 1: size
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
        `Use at most ${HARNESS_MAX_MOCKS} mocks (got ${input.mockedModules.length}); mock only what reaches the network, reads global app state or needs the browser environment.`
      );
    }
    for (const mock of input.mockedModules) {
      if (mock.source.length > HARNESS_MOCK_SOURCE_MAX_CHARS) {
        report(
          "size_limit",
          "error",
          `Mock "${mock.specifier}" is ${mock.source.length} characters long; keep every mock under ${HARNESS_MOCK_SOURCE_MAX_CHARS} characters.`,
          `mock ${mock.specifier}`
        );
      }
    }
    // Step 2: parse the harness; harness checks stop on a syntax error (mocks are still checked)
    const problems = syntaxProblems(input.harnessSource, "harness.tsx");
    for (const problem of problems) {
      report("syntax_error", "error", problem.message, `harness:${problem.line}:${problem.column}`);
    }
    if (problems.length === 0) {
      const sf = parse(input.harnessSource, "harness.tsx");
      states = checkHarnessShape(input, report);
      await this.checkHarnessImports(sf, input, sides, report);
      scanApis(sf, "harness", true, report);
    }
    await this.checkMocks(input, sides, report);
    return states;
  }

  private statementFor(input: HarnessValidationInput): string {
    if (input.targetImportStatement !== undefined) {
      return input.targetImportStatement;
    }
    return input.candidate.exportName === "default"
      ? `import TargetComponent from "${input.targetImportPath}";`
      : `import { ${input.candidate.exportName} } from "${input.targetImportPath}";`;
  }

  /** Steps 4 and 5: the target import and every other harness import. */
  private async checkHarnessImports(
    sf: ts.SourceFile,
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    report: Report
  ): Promise<void> {
    const statement = this.statementFor(input);
    const references = moduleReferences(sf);
    const targetImports = references.filter(
      (reference) => reference.kind === "import" && reference.specifier === input.targetImportPath
    );
    const otherTargetUses = references.filter(
      (reference) => reference.kind !== "import" && reference.specifier === input.targetImportPath
    );
    const firstTarget = targetImports[0];
    if (firstTarget === undefined) {
      report("target_not_imported", "error", `Import the target with exactly: ${statement}`);
    } else {
      if (targetImports.length > 1 || otherTargetUses.length > 0) {
        report(
          "target_imported_twice",
          "error",
          `Import the target exactly once, with: ${statement}`,
          locationOf("harness", sf, firstTarget.node)
        );
      }
      const clause = firstTarget.importClause;
      const bound =
        clause !== undefined &&
        clause.phaseModifier !== ts.SyntaxKind.TypeKeyword &&
        (input.candidate.exportName === "default"
          ? clause.name !== undefined
          : clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.some(
              (element) =>
                !element.isTypeOnly && (element.propertyName ?? element.name).text === input.candidate.exportName
            ));
      if (!bound) {
        const kind =
          input.candidate.exportName === "default"
            ? "the target is the module's default export"
            : `the target is the named export ${input.candidate.exportName}`;
        report(
          "target_binding_mismatch",
          "error",
          `The target import binds the wrong name (${kind}); import it with exactly: ${statement}`,
          locationOf("harness", sf, firstTarget.node)
        );
      }
    }

    const reportedTwice = new Set<string>();
    for (const reference of references) {
      if (reference.specifier === input.targetImportPath || reference.kind === "dynamic") {
        continue;
      }
      const specifier = reference.specifier;
      const location = locationOf("harness", sf, reference.node);
      if (isHarnessFileReference(input, specifier)) {
        // 16 §7.7.3: only `import { definePrvisionHarness } from "../harness-api"` (plus type-only imports of its types).
        if (specifier !== HARNESS_API_SPECIFIER || !isAllowedHarnessApiImport(reference)) {
          report(
            "forbidden_import",
            "error",
            `Do not import "${specifier}": the harness may only import definePrvisionHarness (and its types) from "${HARNESS_API_SPECIFIER}"; the other files of .prvision-harness belong to the render page.`,
            location
          );
        }
        continue;
      }
      if (reference.typeOnly) {
        continue;
      }
      if (STYLE_IMPORT.test(specifier)) {
        report(
          "style_import",
          "error",
          `Do not import stylesheets in the harness ("${specifier}"): global styles are already loaded and the component imports its own CSS.`,
          location
        );
        continue;
      }
      if (isForbiddenModule(specifier)) {
        report(
          "forbidden_import",
          "error",
          `Do not import "${specifier}": test runners, testing utilities, msw and Node built-in modules are not available in the render page.`,
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
      } else if (packageNameOf(specifier) === null) {
        const unresolved: WorktreeSide[] = [];
        for (const side of sides) {
          const found = await this.queries.resolveSpecifier(this.importer(input, side), specifier, side);
          resolved.set(side, found);
          if (found === null) {
            unresolved.push(side);
          }
        }
        if (unresolved.length > 0) {
          report(
            "alias_import_unverified",
            "warning",
            `The harness import "${specifier}" could not be resolved on the ${unresolved.join(" and ")} side; check that the alias exists in the repository's Vite or TypeScript configuration.`,
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
            `"${specifier}" is the target component again; import the target only with: ${statement}`,
            location
          );
        }
        if (found !== null && input.entryFilePath !== null && found === input.entryFilePath) {
          report(
            "entry_import",
            "error",
            `Do not import the application entry ${input.entryFilePath}; it mounts the whole app.`,
            location
          );
          break;
        }
      }
    }
  }

  private importer(input: HarnessValidationInput, side: WorktreeSide): string {
    return input.paths[side] ?? input.candidate.filePath;
  }

  private async resolveRelativeFile(side: WorktreeSide, repoPath: string): Promise<string | null> {
    const candidates = [
      ...SCRIPT_EXTENSIONS.map((extension) => `${repoPath}${extension}`),
      ...SCRIPT_EXTENSIONS.map((extension) => `${repoPath}/index${extension}`),
      repoPath
    ];
    for (const candidate of candidates) {
      if (await this.fileExists(side, candidate)) {
        return candidate;
      }
    }
    return null;
  }

  /** Step 7: shared 10 rules, 09-only specifier checks, resolvability, syntax, imports, APIs and export parity. */
  private async checkMocks(
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    report: Report
  ): Promise<void> {
    const mocks: MockedModule[] = input.mockedModules.map(({ specifier, source }) => ({ specifier, source }));
    const validation = validateMockedModules(mocks);
    for (const rejected of validation.rejected) {
      if (rejected.duplicate) {
        report(
          "mock_duplicate_specifier",
          "error",
          `Mock "${rejected.specifier}" appears more than once (${rejected.reason}); return a single mock per specifier.`,
          `mock ${rejected.specifier}`
        );
      } else {
        report(
          "mock_forbidden_specifier",
          "error",
          `Mock "${rejected.specifier}" cannot be used: ${rejected.reason}.`,
          `mock ${rejected.specifier}`
        );
      }
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
        `Mock "${specifier.slice(0, HARNESS_MOCK_SPECIFIER_MAX_CHARS)}" cannot be used: write the specifier exactly as it appears in an import statement (no absolute paths or URLs, at most ${HARNESS_MOCK_SPECIFIER_MAX_CHARS} characters).`,
        label
      );
      return;
    }
    const targetMessage = `Never mock the target component itself ("${specifier}").`;
    if (specifier === input.targetImportPath) {
      report("mock_forbidden_specifier", "error", targetMessage, label);
      return;
    }
    const resolved = new Map<WorktreeSide, string | null>();
    for (const side of sides) {
      resolved.set(side, await this.queries.resolveSpecifier(this.importer(input, side), specifier, side));
    }
    if (sides.some((side) => resolved.get(side) === input.paths[side])) {
      report("mock_forbidden_specifier", "error", targetMessage, label);
      return;
    }
    if (sides.length > 0 && sides.every((side) => resolved.get(side) === null)) {
      report(
        "mock_unresolvable_specifier",
        "error",
        `Mock "${specifier}" does not resolve from ${input.candidate.filePath}; use the specifier as written in the import statement.`,
        label
      );
    }
    const problems = syntaxProblems(mock.source, "mock.tsx");
    for (const problem of problems) {
      report(
        "mock_syntax_error",
        "error",
        `Mock "${specifier}" is not valid TSX: ${problem.message}`,
        `${label}:${problem.line}:${problem.column}`
      );
    }
    if (problems.length > 0) {
      return;
    }
    const sf = parse(mock.source, "mock.tsx");
    scanApis(sf, label, false, report);
    await this.checkMockImports(sf, mock, input, sides, report);
    await this.checkMockExports(sf, mock, input, sides, resolved, report);
  }

  private async checkMockImports(
    sf: ts.SourceFile,
    mock: MockedModule,
    input: HarnessValidationInput,
    sides: readonly WorktreeSide[],
    report: Report
  ): Promise<void> {
    const label = `mock ${mock.specifier}`;
    for (const reference of moduleReferences(sf)) {
      if (reference.typeOnly || reference.kind === "dynamic" || reference.specifier === mock.specifier) {
        continue; // own specifier: partial mock re-exporting the real module (never mocked, 10 §5.8.1)
      }
      const specifier = reference.specifier;
      const location = locationOf(label, sf, reference.node);
      if (STYLE_IMPORT.test(specifier)) {
        report(
          "style_import",
          "error",
          `Mock "${mock.specifier}" must not import stylesheets ("${specifier}").`,
          location
        );
        continue;
      }
      if (isForbiddenModule(specifier)) {
        report(
          "forbidden_import",
          "error",
          `Mock "${mock.specifier}" must not import "${specifier}": test runners, testing utilities, msw and Node built-in modules are not available in the render page.`,
          location
        );
        continue;
      }
      for (const side of sides) {
        const found = await this.queries.resolveSpecifier(this.importer(input, side), specifier, side);
        if (found === null) {
          const rule =
            packageNameOf(specifier) === null
              ? `relative and alias imports in a mock resolve from ${input.candidate.filePath}`
              : "packages must be installed in the repository";
          report(
            "mock_import_unresolved",
            "error",
            `Mock "${mock.specifier}" imports "${specifier}", which does not resolve on the ${side} side (${rule}).`,
            location
          );
          break;
        }
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
        `${input.candidate.filePath} imports "${mock.specifier}" as a namespace, so PRVision cannot check which names the mock needs; export every runtime name of the real module.`,
        label
      );
    }
    if (exported.wildcard) {
      return; // `export * from …` satisfies every name
    }
    const missing = [...required].filter((name) => !exported.names.has(name)).sort();
    if (missing.length > 0) {
      report(
        "mock_missing_export",
        "error",
        `Mock "${mock.specifier}" must export: ${missing.join(", ")} (imported by ${input.candidate.filePath}).`,
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
        `Mock "${mock.specifier}" does not export ${listed}, which the real module exports; other importers of the module may break.`,
        label
      );
    }
  }
}

/**
 * Step 3 (16 §7.7.3): the module default-exports `definePrvisionHarness({ wrapper?, states })` with valid states.
 * Reports every `harness_shape` and `state_*` issue; returns the states, or null when they are unusable.
 */
function checkHarnessShape(input: HarnessValidationInput, report: Report): HarnessStateSpec[] | null {
  const extraction = extractHarnessStates(input.harnessSource, "react_vite", {
    stateAllowance: input.stateAllowance,
    allowLegacy: false
  });
  if (extraction.ok) {
    return extraction.states;
  }
  for (const issue of extraction.issues) {
    report(issue.code, issue.severity, issue.message, issue.location);
  }
  return null;
}

/** True when a harness import points into `.prvision-harness` itself (the page's own files). */
function isHarnessFileReference(input: HarnessValidationInput, specifier: string): boolean {
  if (classifySpecifier(specifier) !== "relative") {
    return false;
  }
  const repoPath = path.posix.normalize(path.posix.join(harnessDirRel(input.viteRootRel), specifier));
  const pageDir = path.posix.normalize(path.posix.join(input.viteRootRel, ".prvision-harness"));
  return repoPath === pageDir || repoPath.startsWith(`${pageDir}/`);
}

/** `import { definePrvisionHarness } from "../harness-api"`, optionally with type-only imports of its types. */
function isAllowedHarnessApiImport(reference: ModuleReference): boolean {
  if (reference.kind !== "import") {
    return reference.typeOnly;
  }
  if (reference.typeOnly) {
    return true;
  }
  const clause = reference.importClause;
  const bindings = clause?.namedBindings;
  if (clause === undefined || clause.name !== undefined || bindings === undefined || !ts.isNamedImports(bindings)) {
    return false;
  }
  return bindings.elements.every(
    (element) => element.isTypeOnly || (element.propertyName ?? element.name).text === HARNESS_API_EXPORT
  );
}
