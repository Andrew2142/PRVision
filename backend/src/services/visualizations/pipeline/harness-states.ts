/**
 * Static extraction of a harness module's states (16 §7.7.1). Pure: the module is parsed with the TypeScript
 * compiler API and never executed (E6). State names and steps must be literals, so the page reads exactly the
 * values extracted here.
 */
import ts from "typescript";
import {
  STATE_MAX_STEPS,
  STATE_NAME_MAX_CHARS,
  STATE_NAME_PATTERN,
  STATE_STEP_NTH_MAX,
  STATE_STEP_TEXT_MAX_CHARS
} from "../../../config-consts";
import { DEFAULT_STATE_NAME, type HarnessStateSpec, type HarnessStep } from "../../../types/harness-library";
import type { HarnessIssueCode, HarnessValidationIssue } from "./harness-validator";

export type StateExtraction =
  { ok: true; states: HarnessStateSpec[]; legacy: boolean } | { ok: false; issues: HarnessValidationIssue[] };

/** Implicit ARIA roles PRVision resolves (16 §7.5); equal to the template's `STEP_TARGET_ROLES` (a test checks). */
export const STEP_TARGET_ROLES = [
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "listbox",
  "slider",
  "spinbutton",
  "row",
  "cell",
  "gridcell",
  "heading",
  "img",
  "dialog",
  "menu",
  "tablist",
  "treeitem"
] as const;

export const STEP_KEYS = [
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "ArrowDown",
  "ArrowUp",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End"
] as const;

/** The module every harness imports `definePrvisionHarness` from (React and Angular). */
export const HARNESS_API_SPECIFIER = "../harness-api";
const DEFINE_HARNESS = "definePrvisionHarness";
const LEGACY_HARNESS_NAME = "PRVisionHarness";
const STEP_STRING_MAX_CHARS = 200;

/** harness_shape message of the React format (16 §7.7.2). */
export const REACT_HARNESS_SHAPE_MESSAGE =
  "Default-export definePrvisionHarness({ wrapper?, states }) imported from '../harness-api'.";
const ANGULAR_HARNESS_SHAPE_MESSAGE =
  "Default-export definePrvisionHarness({ component, … }) imported from '../harness-api'.";

const LIST_NOT_LITERAL = {
  react_vite:
    'states must be an array literal of { name: "...", render, steps: [...] } objects with literal names and steps.',
  angular:
    "states must be an array literal of { name: '...', inputs, providers, http, steps: [...] } objects with literal names and steps."
} as const;

const REACT_HARNESS_KEYS: ReadonlySet<string> = new Set(["wrapper", "states"]);
const REACT_STATE_KEYS: ReadonlySet<string> = new Set(["name", "render", "steps"]);
const ANGULAR_STATE_KEYS: ReadonlySet<string> = new Set(["name", "inputs", "providers", "http", "steps"]);
const ROLES: ReadonlySet<string> = new Set(STEP_TARGET_ROLES);
const KEYS: ReadonlySet<string> = new Set(STEP_KEYS);
const NAME_PATTERN = new RegExp(STATE_NAME_PATTERN);

// ---------------------------------------------------------------------------------------------------------------
// Name and step rules (16 §7.1, §7.5)
// ---------------------------------------------------------------------------------------------------------------

/** Why a state name is not allowed (16 §7.1), or null when it is valid. */
export function stateNameIssue(name: string): string | null {
  if (name.length === 0) {
    return "it is empty";
  }
  if (name.length > STATE_NAME_MAX_CHARS) {
    return `it is longer than ${STATE_NAME_MAX_CHARS} characters`;
  }
  if (/^\s/.test(name)) {
    return "it starts with a space";
  }
  if (/\s$/.test(name)) {
    return "it ends with a space";
  }
  if (!NAME_PATTERN.test(name)) {
    return "use only letters, digits, spaces and the characters , . ' ( ) & / + -, starting with a letter or digit";
  }
  return null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringIssue(value: unknown, field: string, max: number = STEP_STRING_MAX_CHARS): string | null {
  if (typeof value !== "string") {
    return `${field} must be a string`;
  }
  if (value.trim() === "") {
    return `${field} must not be empty`;
  }
  if (value.length > max) {
    return `${field} is longer than ${max} characters`;
  }
  return null;
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

function targetIssue(target: unknown): string | null {
  if (!isPlainRecord(target)) {
    return 'target must be an object such as { by: "role", role: "button", name: "Save" }';
  }
  const fields: Record<string, readonly string[]> = {
    role: ["role", "name"],
    text: ["text"],
    label: ["label"],
    placeholder: ["placeholder"],
    testId: ["testId"]
  };
  const by = target.by;
  const required = typeof by === "string" ? fields[by] : undefined;
  if (typeof by !== "string" || required === undefined) {
    return 'target.by must be one of "role", "text", "label", "placeholder", "testId"';
  }
  const extra = unknownKeys(target, ["by", "nth", ...required]);
  if (extra.length > 0) {
    return `target has unknown field ${extra.join(", ")}`;
  }
  for (const field of required) {
    const issue = stringIssue(target[field], `target.${field}`);
    if (issue !== null) {
      return issue;
    }
  }
  if (by === "role" && typeof target.role === "string" && !ROLES.has(target.role)) {
    return `target.role "${target.role}" is not supported; use one of ${STEP_TARGET_ROLES.join(", ")}`;
  }
  if (target.nth !== undefined) {
    const nth = target.nth;
    if (typeof nth !== "number" || !Number.isInteger(nth) || nth < 0 || nth > STATE_STEP_NTH_MAX) {
      return `target.nth must be an integer from 0 to ${STATE_STEP_NTH_MAX}`;
    }
  }
  return null;
}

/** Why a step is not valid (16 §7.1, §7.5), or null when it is. */
export function stepIssue(step: unknown): string | null {
  if (!isPlainRecord(step)) {
    return 'a step must be an object such as { action: "click", target: { by: "role", role: "button", name: "Save" } }';
  }
  const action = step.action;
  switch (action) {
    case "click":
    case "hover":
    case "focus":
    case "waitFor": {
      const extra = unknownKeys(step, ["action", "target"]);
      if (extra.length > 0) {
        return `${action} has unknown field ${extra.join(", ")}`;
      }
      return targetIssue(step.target);
    }
    case "type": {
      const extra = unknownKeys(step, ["action", "target", "text"]);
      if (extra.length > 0) {
        return `type has unknown field ${extra.join(", ")}`;
      }
      return targetIssue(step.target) ?? stringIssue(step.text, "text", STATE_STEP_TEXT_MAX_CHARS);
    }
    case "press": {
      const extra = unknownKeys(step, ["action", "key", "target"]);
      if (extra.length > 0) {
        return `press has unknown field ${extra.join(", ")}`;
      }
      if (typeof step.key !== "string" || !KEYS.has(step.key)) {
        return `key must be one of ${STEP_KEYS.join(", ")}`;
      }
      return step.target === undefined ? null : targetIssue(step.target);
    }
    default:
      return 'action must be one of "click", "hover", "focus", "type", "press", "waitFor"';
  }
}

/** Type guard over `stepIssue` (page-reported steps are validated with it before they run). */
export function isHarnessStep(value: unknown): value is HarnessStep {
  return stepIssue(value) === null;
}

// ---------------------------------------------------------------------------------------------------------------
// AST helpers
// ---------------------------------------------------------------------------------------------------------------

function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function propertyNameText(name: ts.PropertyName): string | null {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return null;
}

const NOT_LITERAL = Symbol("not-literal");

/** The JavaScript value of a literal expression (strings, numbers, booleans, nested object and array literals). */
function literalValue(expression: ts.Expression): unknown {
  const node = unwrap(expression);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isNumericLiteral(node)) {
    return Number(node.text);
  }
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.FalseKeyword) {
    return false;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) {
        return NOT_LITERAL;
      }
      const key = propertyNameText(property.name);
      if (key === null) {
        return NOT_LITERAL;
      }
      const value = literalValue(property.initializer);
      if (value === NOT_LITERAL) {
        return NOT_LITERAL;
      }
      out[key] = value;
    }
    return out;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const out: unknown[] = [];
    for (const element of node.elements) {
      const value = literalValue(element);
      if (value === NOT_LITERAL) {
        return NOT_LITERAL;
      }
      out.push(value);
    }
    return out;
  }
  return NOT_LITERAL;
}

function locationOf(sf: ts.SourceFile, node: ts.Node): string {
  const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  return `harness:${line + 1}:${character + 1}`;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === kind);
}

/** Local names bound to `definePrvisionHarness` imported (as a value) from '../harness-api'. */
function defineHarnessBindings(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== HARNESS_API_SPECIFIER ||
      statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) {
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

/** Names of top-level functions (declarations and `const x = () => …` / `function` expressions). */
function topLevelFunctions(sf: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.add(statement.name.text);
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const initializer = declaration.initializer === undefined ? undefined : unwrap(declaration.initializer);
        if (
          ts.isIdentifier(declaration.name) &&
          initializer !== undefined &&
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer))
        ) {
          names.add(declaration.name.text);
        }
      }
    }
  }
  return names;
}

type DefaultExport =
  | { kind: "none" }
  | { kind: "many"; node: ts.Node }
  | { kind: "expression"; node: ts.Node; expression: ts.Expression }
  | { kind: "function"; node: ts.Node; name: string | null };

function findDefaultExport(sf: ts.SourceFile): DefaultExport {
  const found: Array<Exclude<DefaultExport, { kind: "none" }>> = [];
  const functions = topLevelFunctions(sf);
  for (const statement of sf.statements) {
    if (ts.isExportAssignment(statement) && statement.isExportEquals !== true) {
      const expression = unwrap(statement.expression);
      if (ts.isIdentifier(expression) && functions.has(expression.text)) {
        found.push({ kind: "function", node: statement, name: expression.text });
      } else {
        found.push({ kind: "expression", node: statement, expression });
      }
    } else if (
      (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) &&
      hasModifier(statement, ts.SyntaxKind.ExportKeyword) &&
      hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
    ) {
      found.push({
        kind: "function",
        node: statement,
        name: ts.isFunctionDeclaration(statement) ? (statement.name?.text ?? null) : null
      });
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        if (element.name.text === "default") {
          const local = (element.propertyName ?? element.name).text;
          found.push(
            statement.moduleSpecifier === undefined && functions.has(local)
              ? { kind: "function", node: statement, name: local }
              : { kind: "function", node: statement, name: null }
          );
        }
      }
    }
  }
  const first = found[0];
  if (first === undefined) {
    return { kind: "none" };
  }
  return found.length > 1 ? { kind: "many", node: first.node } : first;
}

function exportLocation(sf: ts.SourceFile, exported: DefaultExport): string | undefined {
  return exported.kind === "none" ? undefined : locationOf(sf, exported.node);
}

/** The object literal passed to `definePrvisionHarness(...)` in the default export, or null. */
function harnessObject(sf: ts.SourceFile, exported: DefaultExport): ts.ObjectLiteralExpression | null {
  if (exported.kind !== "expression") {
    return null;
  }
  const call = exported.expression;
  const bindings = defineHarnessBindings(sf);
  if (
    !ts.isCallExpression(call) ||
    !ts.isIdentifier(call.expression) ||
    !bindings.has(call.expression.text) ||
    call.arguments.length !== 1 ||
    call.arguments[0] === undefined
  ) {
    return null;
  }
  const argument = unwrap(call.arguments[0]);
  return ts.isObjectLiteralExpression(argument) ? argument : null;
}

function findProperty(object: ts.ObjectLiteralExpression, name: string): ts.ObjectLiteralElementLike | undefined {
  return object.properties.find(
    (property) => !ts.isSpreadAssignment(property) && propertyNameText(property.name) === name
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------------------------------------------

interface RawState {
  name: string;
  steps: HarnessStep[];
  hasSteps: boolean;
  node: ts.Node;
}

class IssueList {
  readonly issues: HarnessValidationIssue[] = [];

  add(code: HarnessIssueCode, message: string, location?: string): void {
    if (this.issues.some((issue) => issue.code === code && issue.message === message)) {
      return;
    }
    this.issues.push({ code, severity: "error", message, ...(location !== undefined ? { location } : {}) });
  }
}

/**
 * Reads the default export of a harness module and returns its states, Default first (16 §7.7.1). Never throws.
 *
 * @param source - The harness module source.
 * @param framework - Which harness format to read.
 * @param options - The repository's state allowance; `allowLegacy` accepts React's pre-16 `PRVisionHarness`.
 * @returns The states, or the issues that make the module unusable.
 */
export function extractHarnessStates(
  source: string,
  framework: "react_vite" | "angular",
  options: { stateAllowance: number; allowLegacy: boolean }
): StateExtraction {
  try {
    const sf = ts.createSourceFile(
      framework === "angular" ? "harness.ts" : "harness.tsx",
      source,
      ts.ScriptTarget.Latest,
      true,
      framework === "angular" ? ts.ScriptKind.TS : ts.ScriptKind.TSX
    );
    return framework === "angular" ? extractAngular(sf, options) : extractReact(sf, options);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      issues: [
        { code: "harness_shape", severity: "error", message: `The harness states could not be read: ${message}` }
      ]
    };
  }
}

function extractReact(sf: ts.SourceFile, options: { stateAllowance: number; allowLegacy: boolean }): StateExtraction {
  const issues = new IssueList();
  const exported = findDefaultExport(sf);
  if (
    options.allowLegacy &&
    exported.kind === "function" &&
    exported.name === LEGACY_HARNESS_NAME &&
    (ts.isFunctionDeclaration(exported.node) ||
      ts.isExportAssignment(exported.node) ||
      ts.isExportDeclaration(exported.node))
  ) {
    return { ok: true, states: [{ name: DEFAULT_STATE_NAME, steps: [] }], legacy: true };
  }
  const object = harnessObject(sf, exported);
  if (object === null) {
    issues.add("harness_shape", REACT_HARNESS_SHAPE_MESSAGE, exportLocation(sf, exported));
    return { ok: false, issues: issues.issues };
  }
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      issues.add(
        "harness_shape",
        `Write the harness as a plain object literal without spreads. ${REACT_HARNESS_SHAPE_MESSAGE}`,
        locationOf(sf, property)
      );
      continue;
    }
    const name = propertyNameText(property.name);
    if (name === null || !REACT_HARNESS_KEYS.has(name)) {
      issues.add(
        "harness_shape",
        `Unknown key ${name ?? property.name.getText(sf)} in definePrvisionHarness({...}); allowed keys: wrapper, states.`,
        locationOf(sf, property)
      );
    }
  }
  const functions = topLevelFunctions(sf);
  const raw = readStateList(sf, object, "react_vite", issues, (state, name) => {
    const render = findProperty(state, "render");
    if (!isUsableRender(render, functions)) {
      issues.add("state_render_missing", `State "${name}" needs a render function.`, locationOf(sf, state));
    }
  });
  if (raw === null) {
    return { ok: false, issues: issues.issues };
  }
  const first = raw[0];
  if (first?.name !== DEFAULT_STATE_NAME) {
    issues.add(
      "state_default_missing",
      'The first state must be named "Default".',
      first === undefined ? locationOf(sf, object) : locationOf(sf, first.node)
    );
  } else if (first.hasSteps) {
    issues.add("state_default_has_steps", "The Default state has no steps.", locationOf(sf, first.node));
  }
  checkNames(sf, raw, "react_vite", issues);
  checkCount(raw.length, options.stateAllowance, issues);
  if (issues.issues.length > 0) {
    return { ok: false, issues: issues.issues };
  }
  return { ok: true, states: raw.map((state) => ({ name: state.name, steps: state.steps })), legacy: false };
}

function isUsableRender(property: ts.ObjectLiteralElementLike | undefined, functions: ReadonlySet<string>): boolean {
  if (property === undefined) {
    return false;
  }
  if (ts.isMethodDeclaration(property)) {
    return property.body !== undefined;
  }
  const value = ts.isPropertyAssignment(property)
    ? unwrap(property.initializer)
    : ts.isShorthandPropertyAssignment(property)
      ? property.name
      : undefined;
  if (value === undefined) {
    return false;
  }
  return (
    ts.isArrowFunction(value) || ts.isFunctionExpression(value) || (ts.isIdentifier(value) && functions.has(value.text))
  );
}

function extractAngular(sf: ts.SourceFile, options: { stateAllowance: number; allowLegacy: boolean }): StateExtraction {
  const issues = new IssueList();
  const exported = findDefaultExport(sf);
  const object = harnessObject(sf, exported);
  if (object === null) {
    issues.add("harness_shape", ANGULAR_HARNESS_SHAPE_MESSAGE, exportLocation(sf, exported));
    return { ok: false, issues: issues.issues };
  }
  const defaultState: RawState = { name: DEFAULT_STATE_NAME, steps: [], hasSteps: false, node: object };
  if (findProperty(object, "states") === undefined) {
    checkCount(1, options.stateAllowance, issues);
    return issues.issues.length > 0
      ? { ok: false, issues: issues.issues }
      : { ok: true, states: [{ name: DEFAULT_STATE_NAME, steps: [] }], legacy: false };
  }
  const extra = readStateList(sf, object, "angular", issues, () => undefined);
  if (extra === null) {
    return { ok: false, issues: issues.issues };
  }
  for (const state of extra) {
    if (state.name.toLowerCase() === DEFAULT_STATE_NAME.toLowerCase()) {
      issues.add(
        "state_name_invalid",
        `State name "${state.name}" is not allowed: the top-level descriptor is the Default state, so states lists only the additional states.`,
        locationOf(sf, state.node)
      );
    }
  }
  const all = [defaultState, ...extra.filter((state) => state.name.toLowerCase() !== DEFAULT_STATE_NAME.toLowerCase())];
  checkNames(sf, all, "angular", issues);
  checkCount(1 + extra.length, options.stateAllowance, issues);
  if (issues.issues.length > 0) {
    return { ok: false, issues: issues.issues };
  }
  return { ok: true, states: all.map((state) => ({ name: state.name, steps: state.steps })), legacy: false };
}

/** Reads `states: [ { name, …, steps } ]` (shared by both formats); null when the list itself is unusable. */
function readStateList(
  sf: ts.SourceFile,
  object: ts.ObjectLiteralExpression,
  framework: "react_vite" | "angular",
  issues: IssueList,
  checkState: (state: ts.ObjectLiteralExpression, name: string) => void
): RawState[] | null {
  const notLiteral = (node: ts.Node): void => {
    issues.add("state_list_not_literal", LIST_NOT_LITERAL[framework], locationOf(sf, node));
  };
  const property = findProperty(object, "states");
  if (property === undefined || !ts.isPropertyAssignment(property)) {
    notLiteral(property ?? object);
    return null;
  }
  const list = unwrap(property.initializer);
  if (!ts.isArrayLiteralExpression(list)) {
    notLiteral(property.initializer);
    return null;
  }
  const allowedKeys = framework === "angular" ? ANGULAR_STATE_KEYS : REACT_STATE_KEYS;
  const states: RawState[] = [];
  let usable = true;
  for (const element of list.elements) {
    const state = unwrap(element);
    if (!ts.isObjectLiteralExpression(state)) {
      notLiteral(element);
      usable = false;
      continue;
    }
    let stateOk = true;
    for (const member of state.properties) {
      if (ts.isSpreadAssignment(member)) {
        notLiteral(member);
        stateOk = false;
        continue;
      }
      const key = propertyNameText(member.name);
      if (key === null || !allowedKeys.has(key)) {
        notLiteral(member);
        stateOk = false;
      }
    }
    const nameProperty = findProperty(state, "name");
    const nameValue =
      nameProperty !== undefined && ts.isPropertyAssignment(nameProperty)
        ? unwrap(nameProperty.initializer)
        : undefined;
    if (nameValue === undefined || !(ts.isStringLiteral(nameValue) || ts.isNoSubstitutionTemplateLiteral(nameValue))) {
      notLiteral(nameProperty ?? state);
      usable = false;
      continue;
    }
    const name = nameValue.text;
    const steps = readSteps(sf, state, name, framework, issues);
    if (steps === null) {
      stateOk = false;
    }
    checkState(state, name);
    if (!stateOk) {
      usable = false;
    }
    states.push({ name, steps: steps?.steps ?? [], hasSteps: (steps?.count ?? 0) > 0, node: state });
  }
  return usable ? states : null;
}

function readSteps(
  sf: ts.SourceFile,
  state: ts.ObjectLiteralExpression,
  name: string,
  framework: "react_vite" | "angular",
  issues: IssueList
): { steps: HarnessStep[]; count: number } | null {
  const property = findProperty(state, "steps");
  if (property === undefined) {
    return { steps: [], count: 0 };
  }
  const notLiteral = (node: ts.Node): null => {
    issues.add("state_list_not_literal", LIST_NOT_LITERAL[framework], locationOf(sf, node));
    return null;
  };
  if (!ts.isPropertyAssignment(property)) {
    return notLiteral(property);
  }
  const list = unwrap(property.initializer);
  if (!ts.isArrayLiteralExpression(list)) {
    return notLiteral(property.initializer);
  }
  const steps: HarnessStep[] = [];
  let ok = true;
  list.elements.forEach((element, index) => {
    const value = literalValue(element);
    if (value === NOT_LITERAL || !ts.isObjectLiteralExpression(unwrap(element))) {
      notLiteral(element);
      ok = false;
      return;
    }
    const issue = stepIssue(value);
    if (issue !== null) {
      issues.add("state_step_invalid", `State "${name}", step ${index + 1}: ${issue}.`, locationOf(sf, element));
      ok = false;
      return;
    }
    if (isHarnessStep(value)) {
      steps.push(value);
    }
  });
  if (list.elements.length > STATE_MAX_STEPS) {
    issues.add(
      "state_step_invalid",
      `State "${name}", step ${STATE_MAX_STEPS + 1}: a state has at most ${STATE_MAX_STEPS} steps.`,
      locationOf(sf, list.elements[STATE_MAX_STEPS] ?? list)
    );
    ok = false;
  }
  return ok ? { steps, count: list.elements.length } : null;
}

function checkNames(
  sf: ts.SourceFile,
  states: readonly RawState[],
  framework: "react_vite" | "angular",
  issues: IssueList
): void {
  const seen = new Set<string>();
  for (const state of states) {
    const reason = stateNameIssue(state.name);
    if (reason !== null) {
      issues.add(
        "state_name_invalid",
        `State name "${state.name}" is not allowed: ${reason}.`,
        locationOf(sf, state.node)
      );
    }
    const key = state.name.toLowerCase();
    if (seen.has(key)) {
      issues.add("state_duplicate", `State "${state.name}" appears twice.`, locationOf(sf, state.node));
    }
    seen.add(key);
  }
  if (framework === "react_vite" && states.length === 0) {
    issues.add("state_default_missing", 'The first state must be named "Default".');
  }
}

function checkCount(count: number, allowance: number, issues: IssueList): void {
  if (count > allowance) {
    issues.add("state_too_many", `${count} states written; the state allowance is ${allowance} (Default included).`);
  }
}
