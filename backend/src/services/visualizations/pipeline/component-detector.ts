/**
 * Syntactic React component detection, export closures and normalization (08 §5.7–5.8).
 *
 * Stateless and synchronous. Uses only `ts.createSourceFile`, `ts.transpileModule`, `ts.transform` and
 * `ts.createPrinter` — never a Program, LanguageService or TypeChecker (08 §10). Code that may run on parent-less
 * trees always passes the SourceFile to `getText(sf)` / `getStart(sf)` and never reads `node.parent`.
 * Exported pure helpers `normalizeSource` and `cleanJsxText` are also used by sheet 11.
 */
import path from "node:path";
import ts from "typescript";
import type {
  ExportInfo,
  FileRole,
  ImportBinding,
  ModuleSummary,
  RawImport,
  Side
} from "../../../types/change-analysis";

const PASCAL_CASE = /^[A-Z][A-Za-z0-9_$]*$/;
const STYLE_IMPORT = /\.(css|scss)(\?.*)?$/;

/** Local names bound to React APIs in one file (08 §5.7.1). */
export interface ReactBindings {
  namespaces: Set<string>; // default and namespace imports of "react"; always includes "React"
  memo: Set<string>;
  forwardRef: Set<string>;
  component: Set<string>; // `Component`, `PureComponent` local names
  createElement: Set<string>; // `createElement`, and `jsx`/`jsxs` from react/jsx-runtime
}

/** One located export with its AST nodes (08 §5.7). */
export interface ResolvedExport {
  sf: ts.SourceFile;
  info: ExportInfo;
  statement: ts.Statement; // declaring statement
  componentNode: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration | null;
  wrapperCalls: ts.CallExpression[]; // memo/forwardRef calls, outermost first
  variableDeclaration: ts.VariableDeclaration | null; // for `const X: FC<P> = …`
}

/** Where the props type of a component was found (08 §5.14.1 step 2). */
export interface PropsTypeLocation {
  typeNode: ts.TypeNode | null;
  via: "forwardRef" | "memo" | "annotation" | "class" | "parameter" | "none";
  parameterText: string | null; // first parameter as written (inner function for wrappers), or null
}

interface ImportBindingInfo {
  imported: string; // "default" | name | "*"
  specifier: string;
  typeOnly: boolean;
}

interface ExportEntry {
  exportName: string;
  localName: string | null;
  statement: ts.Statement;
  valueNode: ts.Node | null; // FunctionDeclaration | ClassDeclaration | Expression | null
  variableDeclaration: ts.VariableDeclaration | null;
  typeOnly: boolean;
}

interface ComponentValue {
  node: ts.FunctionLikeDeclaration | ts.ClassLikeDeclaration;
  shape: "function" | "arrow" | "class";
  wrappers: Array<"memo" | "forwardRef">;
  calls: ts.CallExpression[];
}

type TopLevelDeclaration = ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableDeclaration;

interface FileIndex {
  react: ReactBindings;
  topLevel: Map<string, ts.Statement[]>;
  declarations: Map<string, TopLevelDeclaration>;
  importBindings: Map<string, ImportBindingInfo>;
  exprStatements: ts.ExpressionStatement[];
  sideEffectImports: string[];
  entries: ExportEntry[];
  imports: RawImport[];
  refs: Map<ts.Node, Set<string>>;
  closures: Map<ExportEntry, { stmts: Set<ts.Statement>; names: Set<string> }>;
}

const indexCache = new WeakMap<ts.SourceFile, FileIndex>();

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/** Script kind by extension (08 §5.7): .tsx → TSX, .ts → TS, .jsx/.js/.mjs → JSX (lenient). */
export function scriptKindFor(repoPath: string): ts.ScriptKind {
  const ext = path.posix.extname(repoPath).toLowerCase();
  if (ext === ".tsx") {
    return ts.ScriptKind.TSX;
  }
  if (ext === ".ts" || ext === ".mts" || ext === ".cts") {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JSX;
}

/** True for `.css`/`.scss` specifiers (optionally with a query). */
export function isStyleSpecifier(specifier: string): boolean {
  return STYLE_IMPORT.test(specifier);
}

/** Number of parse diagnostics (internal but stable field; access guarded, 08 §5.8.3). */
export function syntaxErrorCount(sf: ts.SourceFile): number {
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  return Array.isArray(diags) ? diags.length : 0;
}

/** 1-based line of a position. */
export function lineOf(sf: ts.SourceFile, position: number): number {
  return sf.getLineAndCharacterOfPosition(position).line + 1;
}

/**
 * Display name for an anonymous default export (08 §5.7.4 rule 4): basename without extension and `.module`;
 * `index` uses the parent directory; parts split on `[-_.\s]+` are capitalized and joined.
 */
export function pascalFromFile(filePath: string): string {
  const posix = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(posix);
  let stem = base.slice(0, base.length - path.posix.extname(base).length).replace(/\.module$/, "");
  if (stem === "index") {
    stem = path.posix.basename(path.posix.dirname(posix));
  }
  const name = stem
    .split(/[-_.\s]+/)
    .filter((part) => part !== "")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
  return /^[A-Za-z]/.test(name) ? name : "Component";
}

/** React's JSX whitespace rule (08 §5.8.2): whitespace that renders is kept (collapsed), the rest dropped. */
export function cleanJsxText(text: string): string {
  if (!text.includes("\n")) {
    return text.replace(/[ \t]+/g, " ");
  }
  const lines = text.split(/\r?\n/);
  const kept: string[] = [];
  lines.forEach((line, i) => {
    let part = line.replace(/\t/g, " ");
    if (i !== 0) {
      part = part.replace(/^ +/, "");
    }
    if (i !== lines.length - 1) {
      part = part.replace(/ +$/, "");
    }
    if (part) {
      kept.push(part.replace(/ +/g, " "));
    }
  });
  return kept.join(" ");
}

const canonicalLiteralsTransformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
  const { factory } = context;
  const visit = (node: ts.Node): ts.Node | undefined => {
    if (ts.isStringLiteral(node)) {
      return factory.createStringLiteral(node.text);
    }
    if (ts.isNoSubstitutionTemplateLiteral(node)) {
      return factory.createNoSubstitutionTemplateLiteral(node.text);
    }
    if (ts.isJsxText(node)) {
      const cleaned = cleanJsxText(node.text);
      return cleaned === "" ? undefined : factory.createJsxText(cleaned, false);
    }
    if (ts.isNumericLiteral(node)) {
      return factory.createNumericLiteral(Number(node.text.replace(/_/g, "")));
    }
    // Layout canonicalization: the printer keeps a parsed block/object/array on one line when it was written on
    // one line, so Prettier reflows would otherwise differ. Synthesized nodes get one fixed layout.
    if (ts.isBlock(node)) {
      const visited = ts.visitEachChild(node, visit, context);
      return factory.createBlock(visited.statements, true);
    }
    if (ts.isObjectLiteralExpression(node)) {
      const visited = ts.visitEachChild(node, visit, context);
      return factory.createObjectLiteralExpression(visited.properties, true);
    }
    if (ts.isArrayLiteralExpression(node)) {
      const visited = ts.visitEachChild(node, visit, context);
      return factory.createArrayLiteralExpression(visited.elements, false);
    }
    if (ts.isParenthesizedExpression(node)) {
      const inner = node.expression;
      if (ts.isJsxElement(inner) || ts.isJsxSelfClosingElement(inner) || ts.isJsxFragment(inner)) {
        return ts.visitNode(inner, visit);
      }
    }
    return ts.visitEachChild(node, visit, context);
  };
  return (root) => {
    const result = ts.visitNode(root, visit);
    return result !== undefined && ts.isSourceFile(result) ? result : root;
  };
};

/**
 * Canonical text of a code fragment (08 §5.8.2): types and comments erased by `transpileModule`, re-printed with
 * canonical string/number literals, React's JSX whitespace rule and JSX parentheses removed. Falls back to the
 * whitespace-collapsed raw text when transpilation throws. `transpile` is a test seam (defaults to
 * `ts.transpileModule`).
 */
export function normalizeSource(
  raw: string,
  fileName: string,
  transpile: (input: string, options: ts.TranspileOptions) => ts.TranspileOutput = ts.transpileModule
): string {
  const ext = /\.(tsx|jsx|js|mjs)$/.test(fileName) ? "tsx" : "ts";
  let js: string;
  try {
    js = transpile(raw, {
      fileName: `closure.${ext}`,
      reportDiagnostics: false,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.Preserve,
        removeComments: true,
        verbatimModuleSyntax: false,
        isolatedModules: true,
        sourceMap: false
      }
    }).outputText;
  } catch {
    return raw.replace(/\s+/g, " ").trim();
  }
  const parsed = ts.createSourceFile("closure.jsx", js, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const result = ts.transform(parsed, [canonicalLiteralsTransformer]);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: true });
  const transformed = result.transformed[0] ?? parsed;
  const printed = printer.printFile(transformed);
  result.dispose();
  return printed.trim();
}

// ---------------------------------------------------------------------------------------------------------------
// AST predicates (08 §5.7.2)
// ---------------------------------------------------------------------------------------------------------------

function unwrap(expr: ts.Expression): ts.Expression {
  let e = expr;
  while (
    ts.isParenthesizedExpression(e) ||
    ts.isAsExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

function isCreateElementCall(call: ts.CallExpression, react: ReactBindings): boolean {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    return react.createElement.has(callee.text);
  }
  return (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    react.namespaces.has(callee.expression.text) &&
    callee.name.text === "createElement"
  );
}

function isJsxLike(expr: ts.Expression | undefined, react: ReactBindings): boolean {
  if (!expr) {
    return false;
  }
  const e = unwrap(expr);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) {
    return true;
  }
  if (ts.isConditionalExpression(e)) {
    return isJsxLike(e.whenTrue, react) || isJsxLike(e.whenFalse, react);
  }
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return isJsxLike(e.right, react);
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return isJsxLike(e.left, react) || isJsxLike(e.right, react);
    }
    return false;
  }
  if (ts.isCallExpression(e)) {
    return isCreateElementCall(e, react);
  }
  return false;
}

function ownReturnExpressions(fn: ts.FunctionLikeDeclaration): ts.Expression[] {
  const body = fn.body;
  if (!body) {
    return [];
  }
  if (!ts.isBlock(body)) {
    return [body];
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
  ts.forEachChild(body, visit);
  return out;
}

function returnsJsx(fn: ts.FunctionLikeDeclaration, react: ReactBindings): boolean {
  return ownReturnExpressions(fn).some((expr) => isJsxLike(expr, react));
}

function wrapperKind(call: ts.CallExpression, react: ReactBindings): "memo" | "forwardRef" | null {
  const callee = unwrap(call.expression);
  if (ts.isIdentifier(callee)) {
    if (react.memo.has(callee.text)) {
      return "memo";
    }
    if (react.forwardRef.has(callee.text)) {
      return "forwardRef";
    }
    return null;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression) &&
    react.namespaces.has(callee.expression.text)
  ) {
    if (callee.name.text === "memo") {
      return "memo";
    }
    if (callee.name.text === "forwardRef") {
      return "forwardRef";
    }
  }
  return null;
}

function memberName(member: ts.ClassElement): string | null {
  const name = member.name;
  if (!name) {
    return null;
  }
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) {
    return name.text;
  }
  return null;
}

function renderMember(cls: ts.ClassLikeDeclaration): ts.FunctionLikeDeclaration | null {
  for (const member of cls.members) {
    if (ts.isMethodDeclaration(member) && memberName(member) === "render") {
      return member;
    }
    if (ts.isPropertyDeclaration(member) && memberName(member) === "render" && member.initializer) {
      const init = unwrap(member.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        return init;
      }
    }
  }
  return null;
}

function classHeritage(cls: ts.ClassLikeDeclaration): ts.ExpressionWithTypeArguments | undefined {
  return cls.heritageClauses?.find((h) => h.token === ts.SyntaxKind.ExtendsKeyword)?.types[0];
}

function isReactClassComponent(cls: ts.ClassLikeDeclaration, react: ReactBindings): boolean {
  const heritage = classHeritage(cls)?.expression;
  if (!heritage) {
    return false;
  }
  const base = unwrap(heritage);
  const extendsReact =
    (ts.isIdentifier(base) && react.component.has(base.text)) ||
    (ts.isPropertyAccessExpression(base) &&
      ts.isIdentifier(base.expression) &&
      react.namespaces.has(base.expression.text) &&
      (base.name.text === "Component" || base.name.text === "PureComponent"));
  if (!extendsReact) {
    return false;
  }
  const render = renderMember(cls);
  return render !== null && returnsJsx(render, react);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function bindingNames(name: ts.BindingName, out: string[] = []): string[] {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return out;
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) {
      bindingNames(element.name, out);
    }
  }
  return out;
}

/** `import type …` (TS 5.9 models it as a phase modifier). */
export function isTypeOnlyClause(clause: ts.ImportClause): boolean {
  return clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
}

function moduleSpecifierText(node: ts.Expression | undefined): string | null {
  return node !== undefined && ts.isStringLiteralLike(node) ? node.text : null;
}

function emptyReactBindings(): ReactBindings {
  return {
    namespaces: new Set(["React"]),
    memo: new Set(),
    forwardRef: new Set(),
    component: new Set(),
    createElement: new Set()
  };
}

// ---------------------------------------------------------------------------------------------------------------
// File index
// ---------------------------------------------------------------------------------------------------------------

function collectReactBindings(sf: ts.SourceFile): ReactBindings {
  const react = emptyReactBindings();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause || isTypeOnlyClause(statement.importClause)) {
      continue;
    }
    const specifier = moduleSpecifierText(statement.moduleSpecifier);
    const clause = statement.importClause;
    if (specifier === "react") {
      if (clause.name) {
        react.namespaces.add(clause.name.text);
      }
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) {
        react.namespaces.add(bindings.name.text);
      } else if (bindings) {
        for (const element of bindings.elements) {
          if (element.isTypeOnly) {
            continue;
          }
          const imported = (element.propertyName ?? element.name).text;
          const local = element.name.text;
          if (imported === "memo") {
            react.memo.add(local);
          } else if (imported === "forwardRef") {
            react.forwardRef.add(local);
          } else if (imported === "Component" || imported === "PureComponent") {
            react.component.add(local);
          } else if (imported === "createElement") {
            react.createElement.add(local);
          }
        }
      }
    } else if (specifier === "react/jsx-runtime" && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const imported = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && (imported === "jsx" || imported === "jsxs")) {
          react.createElement.add(element.name.text);
        }
      }
    }
  }
  return react;
}

function addTopLevel(index: FileIndex, name: string, statement: ts.Statement): void {
  const list = index.topLevel.get(name);
  if (list === undefined) {
    index.topLevel.set(name, [statement]);
  } else if (!list.includes(statement)) {
    list.push(statement);
  }
}

function buildIndex(sf: ts.SourceFile): FileIndex {
  const index: FileIndex = {
    react: collectReactBindings(sf),
    topLevel: new Map(),
    declarations: new Map(),
    importBindings: new Map(),
    exprStatements: [],
    sideEffectImports: [],
    entries: [],
    imports: [],
    refs: new Map(),
    closures: new Map()
  };
  const positioned: Array<{ pos: number; raw: RawImport }> = [];
  const line = (node: ts.Node): number => lineOf(sf, node.getStart(sf));

  // Pass 1: declarations and import bindings.
  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      collectImport(index, statement, positioned, line(statement));
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) {
        addTopLevel(index, statement.name.text, statement);
        const existing = index.declarations.get(statement.name.text);
        const isOverload = ts.isFunctionDeclaration(statement) && !statement.body;
        const replacesOverload = existing !== undefined && ts.isFunctionDeclaration(existing) && !existing.body;
        if (existing === undefined || (replacesOverload && !isOverload)) {
          index.declarations.set(statement.name.text, statement);
        }
      }
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) {
          addTopLevel(index, name, statement);
          if (ts.isIdentifier(declaration.name) && !index.declarations.has(name)) {
            index.declarations.set(name, declaration);
          }
        }
      }
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      addTopLevel(index, statement.name.text, statement);
    } else if (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name)) {
      addTopLevel(index, statement.name.text, statement);
    } else if (ts.isExpressionStatement(statement)) {
      index.exprStatements.push(statement);
    }
  }

  // Pass 2: exports.
  const seen = new Set<string>();
  const pushEntry = (entry: ExportEntry): void => {
    if (seen.has(entry.exportName)) {
      return;
    }
    seen.add(entry.exportName);
    index.entries.push(entry);
  };
  for (const statement of sf.statements) {
    collectExportsOf(index, statement, pushEntry, positioned, line);
  }

  // Dynamic imports anywhere in the file.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const specifier = moduleSpecifierText(node.arguments[0]);
      if (specifier !== null) {
        positioned.push({
          pos: node.getStart(sf),
          raw: { specifier, kind: "dynamic", bindings: [], star: true, line: line(node) }
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  positioned.sort((a, b) => a.pos - b.pos);
  index.imports = positioned.map((entry) => entry.raw);
  return index;
}

function collectImport(
  index: FileIndex,
  statement: ts.ImportDeclaration,
  positioned: Array<{ pos: number; raw: RawImport }>,
  line: number
): void {
  const specifier = moduleSpecifierText(statement.moduleSpecifier);
  if (specifier === null) {
    return;
  }
  const pos = statement.pos;
  const clause = statement.importClause;
  if (!clause) {
    index.sideEffectImports.push(specifier);
    positioned.push({
      pos,
      raw: { specifier, kind: isStyleSpecifier(specifier) ? "style" : "side_effect", bindings: [], star: true, line }
    });
    return;
  }
  const typeOnlyClause = isTypeOnlyClause(clause);
  const bindings: ImportBinding[] = [];
  let star = false;
  if (clause.name) {
    addTopLevel(index, clause.name.text, statement);
    index.importBindings.set(clause.name.text, { imported: "default", specifier, typeOnly: typeOnlyClause });
    if (!typeOnlyClause) {
      bindings.push({ imported: "default", local: clause.name.text });
    }
  }
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    addTopLevel(index, named.name.text, statement);
    index.importBindings.set(named.name.text, { imported: "*", specifier, typeOnly: typeOnlyClause });
    if (!typeOnlyClause) {
      bindings.push({ imported: "*", local: named.name.text });
      star = true;
    }
  } else if (named) {
    for (const element of named.elements) {
      const imported = (element.propertyName ?? element.name).text;
      const typeOnly = typeOnlyClause || element.isTypeOnly;
      addTopLevel(index, element.name.text, statement);
      index.importBindings.set(element.name.text, { imported, specifier, typeOnly });
      if (!typeOnly) {
        bindings.push({ imported, local: element.name.text });
      }
    }
  }
  if (typeOnlyClause || bindings.length === 0) {
    return; // type-only import: no runtime edge (08 §5.10.2)
  }
  positioned.push({
    pos,
    raw: { specifier, kind: isStyleSpecifier(specifier) ? "style" : "import", bindings, star, line }
  });
}

function firstLocalDeclaration(index: FileIndex, name: string): ts.Statement | null {
  return index.topLevel.get(name)?.find((statement) => !ts.isImportDeclaration(statement)) ?? null;
}

function isTypeDeclaration(statement: ts.Statement): boolean {
  return ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement);
}

function wrappedLocalName(expr: ts.Expression, react: ReactBindings): string | null {
  let e = unwrap(expr);
  for (let depth = 0; depth < 5; depth++) {
    if (ts.isIdentifier(e)) {
      return e.text;
    }
    if (ts.isCallExpression(e) && wrapperKind(e, react) !== null && e.arguments[0]) {
      e = unwrap(e.arguments[0]);
      continue;
    }
    return null;
  }
  return null;
}

function collectExportsOf(
  index: FileIndex,
  statement: ts.Statement,
  pushEntry: (entry: ExportEntry) => void,
  positioned: Array<{ pos: number; raw: RawImport }>,
  line: (node: ts.Node) => number
): void {
  if (ts.isExportDeclaration(statement)) {
    const specifier = moduleSpecifierText(statement.moduleSpecifier);
    if (specifier !== null) {
      if (statement.isTypeOnly) {
        return;
      }
      const clause = statement.exportClause;
      if (!clause) {
        positioned.push({
          pos: statement.pos,
          raw: { specifier, kind: "reexport", bindings: [], star: true, line: line(statement) }
        });
      } else if (ts.isNamespaceExport(clause)) {
        positioned.push({
          pos: statement.pos,
          raw: {
            specifier,
            kind: "reexport",
            bindings: [{ imported: "*", local: clause.name.text }],
            star: true,
            line: line(statement)
          }
        });
      } else {
        const bindings = clause.elements
          .filter((element) => !element.isTypeOnly)
          .map((element) => ({ imported: (element.propertyName ?? element.name).text, local: element.name.text }));
        if (bindings.length > 0) {
          positioned.push({
            pos: statement.pos,
            raw: { specifier, kind: "reexport", bindings, star: false, line: line(statement) }
          });
        }
      }
      return;
    }
    const clause = statement.exportClause;
    if (!clause || !ts.isNamedExports(clause)) {
      return;
    }
    for (const element of clause.elements) {
      const local = (element.propertyName ?? element.name).text;
      const exported = element.name.text;
      const typeOnly = statement.isTypeOnly || element.isTypeOnly;
      const binding = index.importBindings.get(local);
      if (binding !== undefined) {
        if (!typeOnly && !binding.typeOnly) {
          positioned.push({
            pos: statement.pos,
            raw: {
              specifier: binding.specifier,
              kind: "reexport",
              bindings: [{ imported: binding.imported, local: exported }],
              star: binding.imported === "*",
              line: line(statement)
            }
          });
        }
        continue;
      }
      const declaration = firstLocalDeclaration(index, local);
      if (declaration === null) {
        continue;
      }
      const decl = index.declarations.get(local) ?? null;
      pushEntry({
        exportName: exported,
        localName: local,
        statement: declaration,
        valueNode: decl === null ? null : ts.isVariableDeclaration(decl) ? (decl.initializer ?? null) : decl,
        variableDeclaration: decl !== null && ts.isVariableDeclaration(decl) ? decl : null,
        typeOnly: typeOnly || isTypeDeclaration(declaration)
      });
    }
    return;
  }
  if (ts.isExportAssignment(statement)) {
    if (statement.isExportEquals) {
      return; // CommonJS-style export = is not supported (08 §5.7.3)
    }
    pushEntry({
      exportName: "default",
      localName: wrappedLocalName(statement.expression, index.react),
      statement,
      valueNode: statement.expression,
      variableDeclaration: null,
      typeOnly: false
    });
    return;
  }
  if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword) || hasModifier(statement, ts.SyntaxKind.DeclareKeyword)) {
    return;
  }
  const isDefault = hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
  if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
    if (ts.isFunctionDeclaration(statement) && !statement.body) {
      return; // overload signature; the implementation carries the export
    }
    const name = statement.name?.text ?? null;
    pushEntry({
      exportName: isDefault ? "default" : (name ?? "default"),
      localName: name,
      statement,
      valueNode: statement,
      variableDeclaration: null,
      typeOnly: false
    });
    return;
  }
  if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) {
        pushEntry({
          exportName: declaration.name.text,
          localName: declaration.name.text,
          statement,
          valueNode: declaration.initializer ?? null,
          variableDeclaration: declaration,
          typeOnly: false
        });
      } else {
        for (const name of bindingNames(declaration.name)) {
          pushEntry({
            exportName: name,
            localName: name,
            statement,
            valueNode: null,
            variableDeclaration: null,
            typeOnly: false
          });
        }
      }
    }
    return;
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
    pushEntry({
      exportName: isDefault ? "default" : statement.name.text,
      localName: statement.name.text,
      statement,
      valueNode: null,
      variableDeclaration: null,
      typeOnly: true
    });
    return;
  }
  if (ts.isEnumDeclaration(statement) || (ts.isModuleDeclaration(statement) && ts.isIdentifier(statement.name))) {
    const name = statement.name.text;
    pushEntry({
      exportName: name,
      localName: name,
      statement,
      valueNode: null,
      variableDeclaration: null,
      typeOnly: false
    });
  }
}

function indexOf(sf: ts.SourceFile): FileIndex {
  let index = indexCache.get(sf);
  if (index === undefined) {
    index = buildIndex(sf);
    indexCache.set(sf, index);
  }
  return index;
}

function refsOf(index: FileIndex, node: ts.Node): Set<string> {
  let refs = index.refs.get(node);
  if (refs !== undefined) {
    return refs;
  }
  refs = new Set<string>();
  const found = refs;
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) {
      found.add(child.text);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  index.refs.set(node, refs);
  return refs;
}

function closureOf(index: FileIndex, entry: ExportEntry): { stmts: Set<ts.Statement>; names: Set<string> } {
  const cached = index.closures.get(entry);
  if (cached !== undefined) {
    return cached;
  }
  const names = new Set<string>();
  const stmts = new Set<ts.Statement>([entry.statement]);
  const work: ts.Statement[] = [entry.statement];
  const drain = (): void => {
    for (let s = work.pop(); s !== undefined; s = work.pop()) {
      for (const name of refsOf(index, s)) {
        const declaring = index.topLevel.get(name);
        if (declaring === undefined || names.has(name)) {
          continue;
        }
        names.add(name);
        for (const declaration of declaring) {
          if (!stmts.has(declaration) && !ts.isImportDeclaration(declaration)) {
            stmts.add(declaration);
            work.push(declaration);
          }
        }
      }
    }
  };
  drain();
  for (;;) {
    let added = false;
    for (const statement of index.exprStatements) {
      if (stmts.has(statement)) {
        continue;
      }
      const refs = refsOf(index, statement);
      const touches =
        (entry.localName !== null && refs.has(entry.localName)) || [...refs].some((name) => names.has(name));
      if (touches) {
        stmts.add(statement);
        work.push(statement);
        added = true;
      }
    }
    if (!added) {
      break;
    }
    drain();
  }
  const closure = { stmts, names };
  index.closures.set(entry, closure);
  return closure;
}

function resolveComponentValue(
  index: FileIndex,
  value: ts.Node,
  wrappers: Array<"memo" | "forwardRef">,
  calls: ts.CallExpression[],
  depth: number
): ComponentValue | null {
  if (depth > 4) {
    return null;
  }
  if (ts.isFunctionDeclaration(value)) {
    return returnsJsx(value, index.react) ? { node: value, shape: "function", wrappers, calls } : null;
  }
  if (ts.isClassDeclaration(value)) {
    return isReactClassComponent(value, index.react) ? { node: value, shape: "class", wrappers, calls } : null;
  }
  if (ts.isVariableDeclaration(value)) {
    return value.initializer ? resolveComponentValue(index, value.initializer, wrappers, calls, depth + 1) : null;
  }
  if (!ts.isExpression(value)) {
    return null;
  }
  const e = unwrap(value);
  if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
    return returnsJsx(e, index.react)
      ? { node: e, shape: ts.isArrowFunction(e) ? "arrow" : "function", wrappers, calls }
      : null;
  }
  if (ts.isClassExpression(e)) {
    return isReactClassComponent(e, index.react) ? { node: e, shape: "class", wrappers, calls } : null;
  }
  if (ts.isCallExpression(e)) {
    const kind = wrapperKind(e, index.react);
    const argument = e.arguments[0];
    if (kind !== null && argument !== undefined) {
      return resolveComponentValue(index, argument, [...wrappers, kind], [...calls, e], depth + 1);
    }
    return null;
  }
  if (ts.isIdentifier(e)) {
    const declaration = index.declarations.get(e.text);
    return declaration === undefined ? null : resolveComponentValue(index, declaration, wrappers, calls, depth + 1);
  }
  return null;
}

function staticDisplayName(index: FileIndex, localName: string | null): string | null {
  if (localName === null) {
    return null;
  }
  for (const statement of index.exprStatements) {
    const expr = statement.expression;
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      ts.isIdentifier(expr.left.expression) &&
      expr.left.expression.text === localName &&
      expr.left.name.text === "displayName" &&
      ts.isStringLiteralLike(expr.right)
    ) {
      return expr.right.text;
    }
  }
  return null;
}

function nameRuleHolds(entry: ExportEntry): boolean {
  if (entry.exportName !== "default") {
    return PASCAL_CASE.test(entry.exportName);
  }
  return entry.localName === null || PASCAL_CASE.test(entry.localName);
}

function toExportInfo(
  sf: ts.SourceFile,
  index: FileIndex,
  entry: ExportEntry
): { info: ExportInfo; component: ComponentValue | null } {
  const component =
    entry.typeOnly || entry.valueNode === null ? null : resolveComponentValue(index, entry.valueNode, [], [], 0);
  const isComponent = component !== null && nameRuleHolds(entry);
  const displayName =
    staticDisplayName(index, entry.localName) ??
    (entry.exportName !== "default" ? entry.exportName : (entry.localName ?? pascalFromFile(sf.fileName)));
  const closure = closureOf(index, entry);
  return {
    info: {
      exportName: entry.exportName,
      localName: entry.localName,
      isComponent,
      shape: isComponent ? component.shape : null,
      wrappers: isComponent ? component.wrappers : [],
      displayName,
      declStart: entry.statement.getStart(sf),
      declEnd: entry.statement.getEnd(),
      closureNames: [...closure.names].sort(),
      typeOnly: entry.typeOnly
    },
    component: isComponent ? component : null
  };
}

function isFunctionLikeDeclaration(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node)
  );
}

// ---------------------------------------------------------------------------------------------------------------
// ComponentDetector
// ---------------------------------------------------------------------------------------------------------------

/** Parses files and answers component/closure questions about them (08 §5.7–5.8). Stateless. */
export class ComponentDetector {
  /** Parses a file syntactically; `parents` defaults to true (needed for `node.parent`). */
  parse(repoPath: string, text: string, options: { parents?: boolean } = {}): ts.SourceFile {
    return ts.createSourceFile(
      repoPath,
      text,
      ts.ScriptTarget.Latest,
      options.parents ?? true,
      scriptKindFor(repoPath)
    );
  }

  /** Imports, re-exports and exports (with component decisions and closure names) of a script file. */
  summarize(sf: ts.SourceFile, meta: { path: string; side: Side; role: FileRole; sizeBytes: number }): ModuleSummary {
    const index = indexOf(sf);
    return {
      path: meta.path,
      side: meta.side,
      language: "script",
      role: meta.role,
      sizeBytes: meta.sizeBytes,
      parsed: true,
      syntaxErrors: syntaxErrorCount(sf),
      imports: index.imports.map((raw) => ({ ...raw, bindings: raw.bindings.map((b) => ({ ...b })) })),
      exports: index.entries.map((entry) => toExportInfo(sf, index, entry).info)
    };
  }

  /** Locates one export by its exported name (first declaration wins), or null. */
  findExport(sf: ts.SourceFile, exportName: string): ResolvedExport | null {
    const index = indexOf(sf);
    const entry = index.entries.find((candidate) => candidate.exportName === exportName);
    if (entry === undefined) {
      return null;
    }
    const { info, component } = toExportInfo(sf, index, entry);
    return {
      sf,
      info,
      statement: entry.statement,
      componentNode: component?.node ?? null,
      wrapperCalls: component?.calls ?? [],
      variableDeclaration: entry.variableDeclaration
    };
  }

  /** Raw closure text of an export (08 §5.8.1), or null when the export does not exist or is type-only. */
  closureText(sf: ts.SourceFile, exportName: string): string | null {
    const index = indexOf(sf);
    const entry = index.entries.find((candidate) => candidate.exportName === exportName);
    if (entry === undefined || entry.typeOnly) {
      return null;
    }
    const { stmts, names } = closureOf(index, entry);
    const lines: string[] = [];
    for (const name of [...names].sort()) {
      const binding = index.importBindings.get(name);
      if (binding === undefined) {
        continue;
      }
      lines.push(
        binding.imported === "*"
          ? `import * as ${name} from "${binding.specifier}";`
          : `import { ${binding.imported} as ${name} } from "${binding.specifier}";`
      );
    }
    for (const specifier of [...index.sideEffectImports].sort()) {
      lines.push(`import "${specifier}";`);
    }
    for (const statement of sf.statements) {
      if (stmts.has(statement)) {
        lines.push(statement.getText(sf));
      }
    }
    return lines.join("\n");
  }

  /** Normalized closure text (08 §5.8.2), or null. */
  normalizedClosure(sf: ts.SourceFile, exportName: string): string | null {
    const raw = this.closureText(sf, exportName);
    if (raw === null) {
      return null;
    }
    return this.normalizeText(raw, sf.fileName);
  }

  /** Normalization hook (counts in tests); delegates to `normalizeSource`. */
  normalizeText(raw: string, fileName: string): string {
    return normalizeSource(raw, fileName);
  }

  /** Raw text of top-level statements that are in no export closure (imports, re-exports and types excluded). */
  residualRaw(sf: ts.SourceFile): string {
    const index = indexOf(sf);
    const covered = new Set<ts.Statement>();
    for (const entry of index.entries) {
      if (entry.typeOnly) {
        continue;
      }
      for (const statement of closureOf(index, entry).stmts) {
        covered.add(statement);
      }
    }
    return sf.statements
      .filter(
        (statement) =>
          !covered.has(statement) &&
          !ts.isImportDeclaration(statement) &&
          !ts.isExportDeclaration(statement) &&
          !isTypeDeclaration(statement) &&
          !ts.isEmptyStatement(statement) &&
          !hasModifier(statement, ts.SyntaxKind.DeclareKeyword)
      )
      .map((statement) => statement.getText(sf))
      .join("\n");
  }

  /** Normalized residual text (08 §5.8.3). */
  residualText(sf: ts.SourceFile): string {
    const raw = this.residualRaw(sf);
    return raw === "" ? "" : this.normalizeText(raw, sf.fileName);
  }

  /** Re-export map `exportedName → "<specifier>#<importedName>"` (star entries keyed `*:<specifier>`). */
  reExportMap(sf: ts.SourceFile): Map<string, string> {
    const map = new Map<string, string>();
    for (const raw of indexOf(sf).imports) {
      if (raw.kind !== "reexport") {
        continue;
      }
      if (raw.bindings.length === 0) {
        map.set(`*:${raw.specifier}`, `${raw.specifier}#*`);
        continue;
      }
      for (const binding of raw.bindings) {
        map.set(binding.local, `${raw.specifier}#${binding.imported}`);
      }
    }
    return map;
  }

  /** Where the props type of a resolved component is declared (08 §5.14.1 step 2). */
  findPropsTypeNode(resolved: ResolvedExport): PropsTypeLocation {
    const node = resolved.componentNode;
    const firstParameter = node !== null && isFunctionLikeDeclaration(node) ? (node.parameters[0] ?? null) : null;
    const parameterText = firstParameter === null ? null : firstParameter.getText(resolved.sf);
    const react = indexOf(resolved.sf).react;
    for (const call of resolved.wrapperCalls) {
      const kind = wrapperKind(call, react);
      if (kind === "forwardRef" && call.typeArguments?.[1]) {
        return { typeNode: call.typeArguments[1], via: "forwardRef", parameterText };
      }
      if (kind === "memo" && call.typeArguments?.[0]) {
        return { typeNode: call.typeArguments[0], via: "memo", parameterText };
      }
    }
    const annotation = resolved.variableDeclaration?.type;
    if (annotation && ts.isTypeReferenceNode(annotation) && annotation.typeArguments?.[0]) {
      const name = annotation.typeName.getText(resolved.sf);
      const fcNames = ["FC", "FunctionComponent", "VFC"];
      const bare = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
      if (fcNames.includes(bare)) {
        return { typeNode: annotation.typeArguments[0], via: "annotation", parameterText };
      }
    }
    if (node !== null && ts.isClassLike(node)) {
      const heritage = classHeritage(node);
      if (heritage?.typeArguments?.[0]) {
        return { typeNode: heritage.typeArguments[0], via: "class", parameterText: null };
      }
    }
    if (firstParameter?.type) {
      return { typeNode: firstParameter.type, via: "parameter", parameterText };
    }
    return { typeNode: null, via: "none", parameterText };
  }

  /** JSX-like return expressions of the component's own body (class: its render member). Used by sheet 11. */
  findRenderRoots(resolved: ResolvedExport): ts.Expression[] {
    const node = resolved.componentNode;
    if (node === null) {
      return [];
    }
    const react = indexOf(resolved.sf).react;
    const fn = ts.isClassLike(node) ? renderMember(node) : node;
    if (fn === null) {
      return [];
    }
    return ownReturnExpressions(fn)
      .filter((expr) => isJsxLike(expr, react))
      .map((expr) => unwrap(expr));
  }
}
