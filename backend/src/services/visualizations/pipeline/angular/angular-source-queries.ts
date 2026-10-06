/**
 * `AngularSourceQueries` (sheet 15 §5.5.6): the `ComponentSourceQueries & AngularComponentQueries` object returned
 * in `ChangeAnalysisResult.sourceQueries` for Angular repositories. Path, import, export and specifier queries are
 * delegated to 08's `AnalysisSourceQueries` over the Angular source root; type sources, call sites and changed
 * dependencies have Angular meanings (§5.2.2 table); the Angular-only queries read the per-side component index.
 *
 * Read-only and lazy. Every method catches everything and returns its documented empty result (one `warn` log per
 * method, side and reason), so it never rejects — also after the worktrees were removed (08's rule).
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import ts from "typescript";
import {
  ANALYSIS_GRAPH_BUDGET_MS,
  ANALYSIS_MAX_FILE_BYTES,
  ANGULAR_ANALYSIS_OUTLINE_MAX_LINES,
  ANGULAR_ANALYSIS_SPEC_SNIPPET_MAX_LINES,
  ANALYSIS_MAX_PARSED_FILES,
  CALL_SITE_CONTEXT_LINES,
  CALL_SITE_MAX_LIMIT,
  TYPE_SOURCES_MAX_CHARS,
  TYPE_SOURCES_MAX_RELATED
} from "../../../../config-consts";
import type {
  AngularAppProvider,
  AngularComponentMeta,
  AngularInjectableOutline,
  AngularInjectedDependency,
  AngularSourceQueriesLike,
  AngularStyleRef
} from "../../../../types/angular-analysis";
import type { FileChange, Side } from "../../../../types/change-analysis";
import type {
  CallSite,
  ChangeAnalysisResult,
  ChangedDependency,
  ComponentCandidate,
  DirectImport,
  PipelineContext,
  PreparedWorkspace,
  TypeSourceResult,
  WorktreeSide
} from "../../../../types/visualization-pipeline";
import { getErrorMessage } from "../../../../utilities";
import { readConfinedText } from "../change-source";
import type { ComponentDetector } from "../component-detector";
import { AnalysisSourceQueries, createAnalysisState, type AnalysisState } from "../component-source-queries";
import { ImportGraph } from "../import-graph";
import { ModuleResolver } from "../module-resolver";
import {
  AngularComponentIndex,
  angularClassKey,
  type AngularIndexEntry,
  type AngularTemplateUsage,
  type AngularWorkspaceLayout
} from "./angular-component-index";
import {
  AngularDecoratorReader,
  readAngularConstructorHints,
  readAngularImportBindings,
  type AngularDecoratedClass,
  type AngularReadDependency
} from "./angular-decorator-reader";

const MAX_CHANGED_DEPENDENCIES = 10;
const MAX_EXPORT_HOPS = 3;
const CONFIG_FOLLOW_MAX_DEPTH = 2;
const SPEC_FILE = /\.spec\.ts$/;

/** Everything the Angular queries need, built by `AngularChangeAnalysisService.analyze`. */
export interface AngularAnalysisState {
  workspace: PreparedWorkspace;
  repository: PipelineContext["repository"];
  layout: AngularWorkspaceLayout;
  changes: ReadonlyMap<string, FileChange>;
  changedFiles: ChangeAnalysisResult["changedFiles"];
  rows: ReadonlyArray<{ filePath: string; changeKind: ComponentCandidate["changeKind"] }>;
  detector: ComponentDetector;
  angularMajor: number | null;
  /** 08's query state over the Angular source root; its per-side resolver and graph slots are shared. */
  shared: AnalysisState;
  indexes: Record<Side, Promise<AngularComponentIndex> | null>;
  log: Logger;
  now: () => number;
}

/** Builds the state of one Angular visualization (reuses the head index, resolver and graph of the run). */
export function createAngularAnalysisState(input: {
  workspace: PreparedWorkspace;
  repository: PipelineContext["repository"];
  layout: AngularWorkspaceLayout;
  changes: ReadonlyMap<string, FileChange>;
  changedFiles: ChangeAnalysisResult["changedFiles"];
  rows: AngularAnalysisState["rows"];
  detector: ComponentDetector;
  angularMajor: number | null;
  headResolver: ModuleResolver | null;
  headGraph: ImportGraph | null;
  headIndex: AngularComponentIndex | null;
  baseIndex: Promise<AngularComponentIndex> | null;
  log: Logger;
  now?: () => number;
}): AngularAnalysisState {
  const shared = createAnalysisState({
    workspace: input.workspace,
    repository: { ...input.repository, viteConfigPath: null },
    changes: input.changes,
    changedFiles: input.changedFiles,
    rows: input.rows,
    detector: input.detector,
    headResolver: input.headResolver,
    headGraph: input.headGraph,
    log: input.log,
    sourceRoot: input.layout.sourceRoot,
    now: input.now
  });
  return {
    workspace: input.workspace,
    repository: input.repository,
    layout: input.layout,
    changes: input.changes,
    changedFiles: input.changedFiles,
    rows: input.rows,
    detector: input.detector,
    angularMajor: input.angularMajor,
    shared,
    indexes: { head: input.headIndex === null ? null : Promise.resolve(input.headIndex), base: input.baseIndex },
    log: input.log,
    now: input.now ?? Date.now
  };
}

type SourceEntry = TypeSourceResult["sources"][number];
type TypeDeclNode = ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration | ts.ClassDeclaration;

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function emptyTypeSources(filePath: string, exportName: string, side: WorktreeSide): TypeSourceResult {
  return {
    filePath,
    exportName,
    side,
    found: false,
    propsTypeName: null,
    parameterText: null,
    sources: [],
    unresolved: [],
    truncated: false
  };
}

function lineAt(sf: ts.SourceFile, position: number): number {
  return sf.getLineAndCharacterOfPosition(position).line + 1;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
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

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === kind) ?? false);
}

function isTypeDecl(node: ts.Node): node is TypeDeclNode {
  return (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isClassDeclaration(node)
  );
}

function typeDeclKind(node: TypeDeclNode): SourceEntry["kind"] {
  if (ts.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return "type";
  }
  return ts.isEnumDeclaration(node) ? "enum" : "class";
}

/** Type reference names inside a node (`A`, `ns.B`), minus `skip`. */
function referencedTypeNames(node: ts.Node, sf: ts.SourceFile, skip: ReadonlySet<string>): string[] {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      const name = child.typeName.getText(sf);
      if (!skip.has(name)) {
        names.add(name);
      }
    } else if (ts.isExpressionWithTypeArguments(child)) {
      const name = child.expression.getText(sf);
      if (!skip.has(name)) {
        names.add(name);
      }
    }
    ts.forEachChild(child, visit);
  };
  ts.forEachChild(node, visit);
  return [...names];
}

function styleLanguage(repoPath: string): AngularStyleRef["language"] {
  const ext = path.posix.extname(repoPath).slice(1);
  return ext === "scss" || ext === "sass" || ext === "less" ? ext : "css";
}

function topLevelConst(sf: ts.SourceFile, name: string): ts.VariableDeclaration | null {
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return null;
}

/** The read-only Angular query object handed from 15b to 15c/15e. */
export class AngularSourceQueries implements AngularSourceQueriesLike {
  readonly framework = "angular" as const;
  private readonly delegate: AnalysisSourceQueries;
  private readonly warned = new Set<string>();
  private readonly reader: AngularDecoratorReader;

  constructor(private readonly state: AngularAnalysisState) {
    this.delegate = new AnalysisSourceQueries(state.shared);
    this.reader = new AngularDecoratorReader({ angularMajor: state.angularMajor });
  }

  // -------------------------------------------------------------------------------------------------------------
  // ComponentSourceQueries (§5.2.2 table)
  // -------------------------------------------------------------------------------------------------------------

  /** As 08 (rename-aware, TS file). */
  componentPaths(filePath: string): Promise<{ base: string | null; head: string | null }> {
    return this.delegate.componentPaths(filePath);
  }

  /** As 08, over TS files of the Angular source root with the tsconfig of `repository.tsconfigPath`. */
  getDirectImports(filePath: string, side: WorktreeSide): Promise<DirectImport[]> {
    return this.delegate.getDirectImports(filePath, side);
  }

  /** As 08. */
  getModuleExports(filePath: string, side: WorktreeSide): Promise<string[] | null> {
    return this.delegate.getModuleExports(filePath, side);
  }

  /** As 08. */
  resolveSpecifier(fromFilePath: string, specifier: string, side: WorktreeSide): Promise<string | null> {
    return this.delegate.resolveSpecifier(fromFilePath, specifier, side);
  }

  /**
   * Angular meaning: `propsTypeName` null; `parameterText` one line per input `name[?]: type = default`; `sources`
   * are the declarations of the types named in the inputs (depth 0) and the types they reference (depth 1).
   */
  async resolveTypeSources(filePath: string, exportName: string, side: WorktreeSide): Promise<TypeSourceResult> {
    try {
      await this.ensureSide(side);
      return await this.resolveTypeSourcesUnsafe(filePath, exportName, side);
    } catch (error: unknown) {
      this.warn("resolveTypeSources", side, filePath, error);
      return emptyTypeSources(filePath, exportName, side);
    }
  }

  /** Usages of the component's selector in other components' templates (±CALL_SITE_CONTEXT_LINES), role `source`. */
  async findCallSites(filePath: string, exportName: string, side: WorktreeSide, limit: number): Promise<CallSite[]> {
    try {
      await this.ensureSide(side);
      return await this.findCallSitesUnsafe(filePath, exportName, side, limit);
    } catch (error: unknown) {
      this.warn("findCallSites", side, filePath, error);
      return [];
    }
  }

  /**
   * As 08 over TS import edges plus template/style ownership edges (and style partials), excluding the component's
   * own template and styles. Depth 1..maxDepth (≤ 3), nearest first, then path; at most 10.
   */
  async changedDependenciesOf(filePath: string, side: WorktreeSide, maxDepth: number): Promise<ChangedDependency[]> {
    try {
      await this.ensureSide(side);
      const depthLimit = Math.min(3, Math.max(1, Math.trunc(maxDepth)));
      const [graph, index] = await Promise.all([this.graphFor(side), this.indexFor(side)]);
      const changesByPath = new Map<string, FileChange>();
      for (const change of this.state.changes.values()) {
        const p = side === "head" ? change.headPath : change.basePath;
        if (p !== null) {
          changesByPath.set(p, change);
        }
      }
      const own = new Set<string>();
      for (const entry of index.entriesInFile(filePath)) {
        if (entry.templatePath !== null) {
          own.add(entry.templatePath);
        }
        for (const stylePath of entry.stylePaths) {
          own.add(stylePath);
        }
      }
      const forward = (current: string): string[] => {
        const out = graph.importsOf(current).map((edge) => edge.to);
        out.push(...index.styleImportsOf(current));
        if (current !== filePath) {
          for (const entry of index.entriesInFile(current)) {
            if (entry.templatePath !== null) {
              out.push(entry.templatePath);
            }
            out.push(...entry.stylePaths);
          }
        }
        return out;
      };
      const out: ChangedDependency[] = [];
      const visited = new Set([filePath, ...own]);
      let level = [filePath];
      for (let depth = 1; depth <= depthLimit && level.length > 0; depth++) {
        const next = new Set<string>();
        for (const current of level) {
          for (const target of forward(current)) {
            if (!visited.has(target)) {
              visited.add(target);
              next.add(target);
            }
          }
        }
        level = [...next].sort(byString);
        for (const module of level) {
          const change = changesByPath.get(module);
          if (change !== undefined) {
            out.push({ path: module, status: change.status, depth, codeDiff: change.codeDiff });
          }
        }
      }
      return out.slice(0, MAX_CHANGED_DEPENDENCIES);
    } catch (error: unknown) {
      this.warn("changedDependenciesOf", side, filePath, error);
      return [];
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // AngularComponentQueries (§5.5.6)
  // -------------------------------------------------------------------------------------------------------------

  /** Static metadata of the component; template text read with `readConfinedText`, inline templates unescaped. */
  async getComponentMeta(
    filePath: string,
    exportName: string,
    side: WorktreeSide
  ): Promise<AngularComponentMeta | null> {
    try {
      await this.ensureSide(side);
      const index = await this.indexFor(side);
      const entry = await this.componentEntry(index, filePath, exportName, side);
      if (entry === null) {
        return null;
      }
      const cls = entry.cls;
      let template: AngularComponentMeta["template"] = null;
      if (entry.templatePath !== null) {
        const text = entry.templateText ?? (await this.text(side, entry.templatePath));
        template = text === null ? null : { kind: "external", path: entry.templatePath, text, startLine: 1 };
      } else if (cls.inlineTemplate !== null) {
        template = {
          kind: "inline",
          path: null,
          text: cls.inlineTemplate.text,
          startLine: cls.inlineTemplate.startLine
        };
      }
      const styles: AngularStyleRef[] = [
        ...entry.stylePaths.map((stylePath) => ({
          kind: "external" as const,
          path: stylePath,
          language: styleLanguage(stylePath)
        })),
        ...cls.inlineStyles.map(() => ({ kind: "inline" as const, path: null, language: "css" as const }))
      ];
      const injected: AngularInjectedDependency[] = [];
      for (const dependency of cls.injected) {
        injected.push(await this.resolveDependency(dependency, entry.filePath, side, index));
      }
      const moduleKey = index.declaringModuleOf(entry.key);
      const moduleEntry = moduleKey === null ? undefined : index.entry(moduleKey);
      return {
        filePath: entry.filePath,
        className: cls.className,
        exportName: cls.exportName ?? cls.className,
        selector: cls.selector,
        standalone: cls.standalone,
        declaringModule:
          moduleEntry === undefined ? null : { filePath: moduleEntry.filePath, className: moduleEntry.cls.className },
        template,
        styles,
        inputs: cls.inputs.map((input) => ({ ...input })),
        outputs: cls.outputs.map((output) => ({ ...output })),
        injected,
        imports: [...cls.imports],
        changeDetection: cls.changeDetection
      };
    } catch (error: unknown) {
      this.warn("getComponentMeta", side, filePath, error);
      return null;
    }
  }

  /** Class outline with method bodies elided and private members dropped (≤ 120 lines). */
  async getInjectableOutline(
    filePath: string,
    className: string,
    side: WorktreeSide
  ): Promise<AngularInjectableOutline | null> {
    try {
      await this.ensureSide(side);
      const sf = await this.sourceFile(side, filePath);
      if (sf === null) {
        return null;
      }
      const cls = sf.statements.find(
        (statement): statement is ts.ClassDeclaration =>
          ts.isClassDeclaration(statement) && statement.name?.text === className
      );
      if (cls === undefined) {
        return null;
      }
      const decorated = this.reader.read(sf).find((read) => read.className === className);
      return {
        filePath,
        className,
        providedIn: decorated?.providedIn ?? null,
        outline: classOutline(cls, sf),
        constructorHints: decorated?.constructorHints ?? readAngularConstructorHints(cls, sf)
      };
    } catch (error: unknown) {
      this.warn("getInjectableOutline", side, filePath, error);
      return null;
    }
  }

  /** Providers of `bootstrapApplication(X, config)` (config followed one level) or of the bootstrapped NgModule. */
  async getAppProviders(side: WorktreeSide): Promise<AngularAppProvider[]> {
    const entryFile = this.state.repository.entryFilePath;
    try {
      await this.ensureSide(side);
      if (entryFile === null) {
        return [];
      }
      const sf = await this.sourceFile(side, entryFile);
      if (sf === null) {
        return [];
      }
      const calleeName = (node: ts.CallExpression): string | null => {
        const callee = unwrap(node.expression);
        return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      };
      const bootstrap = findCall(sf, (node) => calleeName(node) === "bootstrapApplication");
      if (bootstrap !== null) {
        const config = bootstrap.arguments[1];
        return config === undefined ? [] : await this.configProviders(config, sf, entryFile, side, 0);
      }
      const moduleArgument = findCall(sf, (node) => calleeName(node) === "bootstrapModule")?.arguments[0];
      if (moduleArgument === undefined) {
        return [];
      }
      return await this.moduleProviders(unwrap(moduleArgument), sf, entryFile, side);
    } catch (error: unknown) {
      this.warn("getAppProviders", side, entryFile ?? "", error);
      return [];
    }
  }

  /** `*.spec.ts` files importing the component file and calling `TestBed.configureTestingModule`; co-located first. */
  async findSpecSetups(filePath: string, exportName: string, side: WorktreeSide, limit: number): Promise<CallSite[]> {
    try {
      await this.ensureSide(side);
      const max = Math.min(CALL_SITE_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
      const index = await this.indexFor(side);
      const entry = index.findComponent(filePath, exportName);
      const className = entry?.cls.className ?? exportName;
      const stem = filePath.replace(/\.ts$/, "");
      const specs = index
        .files()
        .filter((file) => SPEC_FILE.test(file))
        .sort((a, b) => Number(a !== `${stem}.spec.ts`) - Number(b !== `${stem}.spec.ts`) || byString(a, b));
      const resolver = await this.resolverFor(side);
      const out: CallSite[] = [];
      for (const spec of specs) {
        if (out.length >= max) {
          break;
        }
        const text = await this.text(side, spec);
        if (text === null || !text.includes("configureTestingModule") || !text.includes(className)) {
          continue;
        }
        const sf = ts.createSourceFile(spec, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
        const importsComponent = sf.statements.some((statement) => {
          if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
            return false;
          }
          const resolved = resolver.resolveScript(statement.moduleSpecifier.text, spec);
          return resolved.kind === "internal" && resolved.path === filePath;
        });
        if (!importsComponent) {
          continue;
        }
        const node = findCall(
          sf,
          (call) =>
            ts.isPropertyAccessExpression(call.expression) && call.expression.name.text === "configureTestingModule"
        );
        if (node === null) {
          continue;
        }
        const startLine = lineAt(sf, node.getStart(sf));
        const lines = node.getText(sf).split("\n");
        const shown = lines.slice(0, ANGULAR_ANALYSIS_SPEC_SNIPPET_MAX_LINES);
        const endLine = startLine + shown.length - 1;
        const continuation = lines.length > shown.length ? "\n// …" : "";
        out.push({
          filePath: spec,
          role: "test",
          line: startLine,
          startLine,
          endLine,
          usedAs: className,
          snippet: `// ${spec} lines ${String(startLine)}–${String(endLine)} (TestBed setup)\n${shown.join("\n")}${continuation}`
        });
      }
      return out;
    } catch (error: unknown) {
      this.warn("findSpecSetups", side, filePath, error);
      return [];
    }
  }

  // -------------------------------------------------------------------------------------------------------------
  // Unsafe bodies
  // -------------------------------------------------------------------------------------------------------------

  private async resolveTypeSourcesUnsafe(
    filePath: string,
    exportName: string,
    side: WorktreeSide
  ): Promise<TypeSourceResult> {
    const index = await this.indexFor(side);
    const entry = await this.componentEntry(index, filePath, exportName, side);
    const sf = await this.sourceFile(side, filePath);
    if (entry === null || sf === null) {
      return emptyTypeSources(filePath, exportName, side);
    }
    const inputs = entry.cls.inputs;
    const result: TypeSourceResult = {
      ...emptyTypeSources(filePath, exportName, side),
      found: true,
      parameterText:
        inputs.length === 0
          ? null
          : inputs
              .map(
                (input) =>
                  `${input.alias ?? input.name}${input.required ? "" : "?"}: ${input.typeText ?? "unknown"}${
                    input.initializerText === null ? "" : ` = ${input.initializerText}`
                  }`
              )
              .join("\n")
    };
    const names = new Set<string>();
    for (const input of inputs) {
      if (input.typeText === null) {
        continue;
      }
      const typeSf = ts.createSourceFile(
        "input-type.ts",
        `type __T = ${input.typeText};`,
        ts.ScriptTarget.Latest,
        true
      );
      for (const name of referencedTypeNames(typeSf, typeSf, new Set(["__T"]))) {
        names.add(name);
      }
    }
    const candidates: SourceEntry[] = [];
    const unresolved = new Set<string>();
    const seen = new Set<ts.Node>();
    const depthZero: Array<{ node: TypeDeclNode; sf: ts.SourceFile; filePath: string }> = [];
    for (const name of [...names].sort(byString)) {
      const decl = await this.lookupType(name, sf, filePath, side);
      if (decl === null) {
        unresolved.add(name);
      } else if (!seen.has(decl.node)) {
        seen.add(decl.node);
        candidates.push(this.sourceEntry(name, decl, 0));
        depthZero.push(decl);
      }
    }
    const related = new Map<string, { sf: ts.SourceFile; filePath: string }>();
    for (const decl of depthZero) {
      for (const name of referencedTypeNames(decl.node, decl.sf, names)) {
        if (!related.has(name)) {
          related.set(name, { sf: decl.sf, filePath: decl.filePath });
        }
      }
    }
    const relatedNames = [...related.keys()].sort(byString);
    if (relatedNames.length > TYPE_SOURCES_MAX_RELATED) {
      result.truncated = true;
    }
    for (const name of relatedNames.slice(0, TYPE_SOURCES_MAX_RELATED)) {
      const context = related.get(name);
      if (context === undefined) {
        continue;
      }
      const decl = await this.lookupType(name, context.sf, context.filePath, side);
      if (decl === null) {
        unresolved.add(name);
      } else if (!seen.has(decl.node)) {
        seen.add(decl.node);
        candidates.push(this.sourceEntry(name, decl, 1));
      }
    }
    let total = 0;
    for (const candidate of candidates) {
      if (total + candidate.text.length > TYPE_SOURCES_MAX_CHARS) {
        result.truncated = true;
        break;
      }
      total += candidate.text.length;
      result.sources.push(candidate);
    }
    result.unresolved = [...unresolved].sort(byString);
    return result;
  }

  private sourceEntry(
    name: string,
    decl: { node: TypeDeclNode; sf: ts.SourceFile; filePath: string },
    depth: 0 | 1
  ): SourceEntry {
    return {
      name,
      filePath: decl.filePath,
      startLine: lineAt(decl.sf, decl.node.getStart(decl.sf)),
      endLine: lineAt(decl.sf, decl.node.getEnd()),
      kind: typeDeclKind(decl.node),
      depth,
      text: decl.node.getText(decl.sf)
    };
  }

  /** Same-file declaration, else the imported (exported) declaration, re-exports followed ≤ 3 hops. */
  private async lookupType(
    name: string,
    sf: ts.SourceFile,
    filePath: string,
    side: Side
  ): Promise<{ node: TypeDeclNode; sf: ts.SourceFile; filePath: string } | null> {
    const dot = name.indexOf(".");
    const head = dot === -1 ? name : name.slice(0, dot);
    const tail = dot === -1 ? null : name.slice(dot + 1);
    if (tail === null) {
      const local = sf.statements.find((statement) => isTypeDecl(statement) && statement.name?.text === name);
      if (local !== undefined && isTypeDecl(local)) {
        return { node: local, sf, filePath };
      }
    }
    const binding = readAngularImportBindings(sf).get(head);
    if (binding === undefined || (tail !== null && binding.imported !== "*")) {
      return null;
    }
    const resolver = await this.resolverFor(side);
    const target = resolver.resolveScript(binding.specifier, filePath);
    if (target.kind !== "internal") {
      return null;
    }
    return this.exportedTypeDecl(target.path, tail ?? binding.imported, side, 0);
  }

  private async exportedTypeDecl(
    filePath: string,
    name: string,
    side: Side,
    hops: number
  ): Promise<{ node: TypeDeclNode; sf: ts.SourceFile; filePath: string } | null> {
    if (hops > MAX_EXPORT_HOPS) {
      return null;
    }
    const sf = await this.sourceFile(side, filePath);
    if (sf === null) {
      return null;
    }
    for (const statement of sf.statements) {
      if (
        isTypeDecl(statement) &&
        statement.name?.text === name &&
        hasModifier(statement, ts.SyntaxKind.ExportKeyword)
      ) {
        return { node: statement, sf, filePath };
      }
    }
    const resolver = await this.resolverFor(side);
    const stars: string[] = [];
    for (const statement of sf.statements) {
      if (!ts.isExportDeclaration(statement)) {
        continue;
      }
      const specifier =
        statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)
          ? statement.moduleSpecifier.text
          : null;
      const clause = statement.exportClause;
      if (clause === undefined) {
        if (specifier !== null) {
          stars.push(specifier);
        }
        continue;
      }
      if (!ts.isNamedExports(clause)) {
        continue;
      }
      for (const element of clause.elements) {
        if (element.name.text !== name) {
          continue;
        }
        const local = (element.propertyName ?? element.name).text;
        if (specifier === null) {
          const decl = sf.statements.find((s) => isTypeDecl(s) && s.name?.text === local);
          return decl !== undefined && isTypeDecl(decl) ? { node: decl, sf, filePath } : null;
        }
        const target = resolver.resolveScript(specifier, filePath);
        return target.kind === "internal" ? this.exportedTypeDecl(target.path, local, side, hops + 1) : null;
      }
    }
    for (const specifier of stars) {
      const target = resolver.resolveScript(specifier, filePath);
      if (target.kind === "internal") {
        const decl = await this.exportedTypeDecl(target.path, name, side, hops + 1);
        if (decl !== null) {
          return decl;
        }
      }
    }
    return null;
  }

  private async findCallSitesUnsafe(
    filePath: string,
    exportName: string,
    side: WorktreeSide,
    limit: number
  ): Promise<CallSite[]> {
    const max = Math.min(CALL_SITE_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
    const index = await this.indexFor(side);
    const entry = index.findComponent(filePath, exportName);
    if (entry === null) {
      return [];
    }
    const usages = index.usagesOf(entry.key);
    // diversify by owner file: first usage of every file, then the rest
    const firstPerFile: AngularTemplateUsage[] = [];
    const rest: AngularTemplateUsage[] = [];
    const files = new Set<string>();
    for (const usage of usages) {
      const owner = index.entry(usage.ownerKey);
      const file = owner?.templatePath ?? owner?.filePath ?? usage.ownerKey;
      if (files.has(file)) {
        rest.push(usage);
      } else {
        files.add(file);
        firstPerFile.push(usage);
      }
    }
    const out: CallSite[] = [];
    for (const usage of [...firstPerFile, ...rest]) {
      if (out.length >= max) {
        break;
      }
      const owner = index.entry(usage.ownerKey);
      const text = owner?.templateText ?? null;
      if (owner === undefined || text === null) {
        continue;
      }
      const offset = owner.templatePath === null ? (owner.cls.inlineTemplate?.startLine ?? 1) - 1 : 0;
      const ownerFile = owner.templatePath ?? owner.filePath;
      const lines = text.replace(/\n$/, "").split("\n");
      const start = Math.max(1, usage.line - CALL_SITE_CONTEXT_LINES);
      const end = Math.min(lines.length, usage.line + CALL_SITE_CONTEXT_LINES);
      const header = `// ${ownerFile} lines ${String(start + offset)}–${String(end + offset)} (usage at line ${String(usage.line + offset)})`;
      out.push({
        filePath: ownerFile,
        role: "source",
        line: usage.line + offset,
        startLine: start + offset,
        endLine: end + offset,
        usedAs: entry.cls.selector ?? entry.cls.className,
        snippet: `${header}\n${lines.slice(start - 1, end).join("\n")}`
      });
    }
    return out;
  }

  /** Index entry of a component, or one read directly from the file when the index does not hold it. */
  private async componentEntry(
    index: AngularComponentIndex,
    filePath: string,
    exportName: string,
    side: Side
  ): Promise<AngularIndexEntry | null> {
    const indexed = index.findComponent(filePath, exportName);
    if (indexed !== null) {
      return indexed;
    }
    const sf = await this.sourceFile(side, filePath);
    if (sf === null) {
      return null;
    }
    const cls = this.reader
      .read(sf)
      .find((read) => read.kind === "Component" && (read.exportName === exportName || read.className === exportName));
    if (cls === undefined) {
      return null;
    }
    const resolve = (url: string): string | null => {
      const joined = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), url));
      return joined.startsWith("../") || joined.startsWith("/") ? null : joined;
    };
    const templatePath = cls.templateUrl === null ? null : resolve(cls.templateUrl);
    return {
      key: angularClassKey(filePath, cls.className),
      filePath,
      cls,
      templatePath,
      stylePaths: cls.styleUrls.flatMap((url) => {
        const resolved = resolve(url);
        return resolved === null ? [] : [resolved];
      }),
      templateText: templatePath === null ? (cls.inlineTemplate?.text ?? null) : await this.text(side, templatePath),
      templateScan: null
    };
  }

  /** Resolves a token to its file, `providedIn` and the injectable's constructor hints. */
  private async resolveDependency(
    dependency: AngularReadDependency,
    filePath: string,
    side: Side,
    index: AngularComponentIndex
  ): Promise<AngularInjectedDependency> {
    let resolvedPath: string | null = null;
    let className: string | null = dependency.tokenRoot;
    if (dependency.importSpecifier !== null) {
      resolvedPath = await this.delegate.resolveSpecifier(filePath, dependency.importSpecifier, side);
      const sf = await this.sourceFile(side, filePath);
      const imported =
        sf === null || dependency.tokenRoot === null
          ? undefined
          : readAngularImportBindings(sf).get(dependency.tokenRoot);
      if (imported !== undefined && imported.imported !== "*" && imported.imported !== "default") {
        className = imported.imported;
      }
    } else if (dependency.tokenRoot !== null) {
      const sf = await this.sourceFile(side, filePath);
      const declared =
        sf?.statements.some(
          (statement) =>
            (ts.isClassDeclaration(statement) && statement.name?.text === dependency.tokenRoot) ||
            (dependency.tokenRoot !== null &&
              ts.isVariableStatement(statement) &&
              topLevelConst(sf, dependency.tokenRoot) !== null)
        ) ?? false;
      resolvedPath = declared ? filePath : null;
    }
    let providedIn: AngularInjectedDependency["providedIn"] = null;
    let hints: string[] = [];
    if (resolvedPath !== null && !resolvedPath.startsWith("package:") && className !== null) {
      const info = await this.injectableInfo(resolvedPath, className, side, index);
      providedIn = info?.providedIn ?? null;
      hints = info?.constructorHints ?? [];
    }
    return {
      token: dependency.token,
      via: dependency.via,
      optional: dependency.optional,
      importSpecifier: dependency.importSpecifier,
      resolvedPath,
      providedIn,
      hints
    };
  }

  private async injectableInfo(
    filePath: string,
    className: string,
    side: Side,
    index: AngularComponentIndex
  ): Promise<Pick<AngularDecoratedClass, "providedIn" | "constructorHints"> | null> {
    const indexed = index.entry(angularClassKey(filePath, className));
    if (indexed !== undefined) {
      return indexed.cls;
    }
    const sf = await this.sourceFile(side, filePath);
    if (sf === null) {
      return null;
    }
    const decorated = this.reader.read(sf).find((read) => read.className === className);
    if (decorated !== undefined) {
      return decorated;
    }
    const cls = sf.statements.find(
      (statement): statement is ts.ClassDeclaration =>
        ts.isClassDeclaration(statement) && statement.name?.text === className
    );
    return cls === undefined ? null : { providedIn: null, constructorHints: readAngularConstructorHints(cls, sf) };
  }

  /** Providers of an application config expression (object literal, identifier, `mergeApplicationConfig(...)`). */
  private async configProviders(
    expression: ts.Expression,
    sf: ts.SourceFile,
    filePath: string,
    side: Side,
    depth: number
  ): Promise<AngularAppProvider[]> {
    const e = unwrap(expression);
    if (ts.isObjectLiteralExpression(e)) {
      for (const property of e.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
          property.name.text === "providers"
        ) {
          const list = unwrap(property.initializer);
          if (!ts.isArrayLiteralExpression(list)) {
            return [{ text: list.getText(sf), token: null, source: filePath }];
          }
          return list.elements.map((element) => ({
            text: element.getText(sf),
            token: providerToken(element, sf),
            source: filePath
          }));
        }
      }
      return [];
    }
    if (depth >= CONFIG_FOLLOW_MAX_DEPTH) {
      return [];
    }
    if (ts.isCallExpression(e)) {
      const callee = unwrap(e.expression);
      if (ts.isIdentifier(callee) && callee.text === "mergeApplicationConfig") {
        const out: AngularAppProvider[] = [];
        for (const argument of e.arguments) {
          out.push(...(await this.configProviders(argument, sf, filePath, side, depth + 1)));
        }
        return out;
      }
      return [];
    }
    if (!ts.isIdentifier(e)) {
      return [];
    }
    const local = topLevelConst(sf, e.text);
    if (local?.initializer !== undefined) {
      return this.configProviders(local.initializer, sf, filePath, side, depth + 1);
    }
    const binding = readAngularImportBindings(sf).get(e.text);
    if (binding === undefined || binding.imported === "*") {
      return [];
    }
    const resolver = await this.resolverFor(side);
    const target = resolver.resolveScript(binding.specifier, filePath);
    if (target.kind !== "internal") {
      return [];
    }
    const targetSf = await this.sourceFile(side, target.path);
    const declaration = targetSf === null ? null : topLevelConst(targetSf, binding.imported);
    if (targetSf === null || declaration?.initializer === undefined) {
      return [];
    }
    return this.configProviders(declaration.initializer, targetSf, target.path, side, depth + 1);
  }

  /** NgModule bootstrap: the module's providers plus `importProvidersFrom(<import>)` hints. */
  private async moduleProviders(
    moduleExpression: ts.Expression,
    sf: ts.SourceFile,
    filePath: string,
    side: Side
  ): Promise<AngularAppProvider[]> {
    if (!ts.isIdentifier(moduleExpression)) {
      return [];
    }
    let moduleFile = filePath;
    let moduleSf: ts.SourceFile | null = sf;
    let className = moduleExpression.text;
    const binding = readAngularImportBindings(sf).get(className);
    if (binding !== undefined && binding.imported !== "*") {
      const resolver = await this.resolverFor(side);
      const target = resolver.resolveScript(binding.specifier, filePath);
      if (target.kind !== "internal") {
        return [];
      }
      moduleFile = target.path;
      moduleSf = await this.sourceFile(side, moduleFile);
      className = binding.imported === "default" ? className : binding.imported;
    }
    const module =
      moduleSf === null
        ? undefined
        : this.reader
            .read(moduleSf)
            .find(
              (read) => read.kind === "NgModule" && (read.className === className || read.exportName === "default")
            );
    if (module?.ngModule === undefined || module.ngModule === null) {
      return [];
    }
    const providers = module.ngModule.providers.map((text) => ({
      text,
      token: /^\s*\{[\s\S]*?\bprovide\s*:\s*([^,}]+)/.exec(text)?.[1]?.trim() ?? null,
      source: moduleFile
    }));
    const hints = module.ngModule.imports.map((name) => ({
      text: `importProvidersFrom(${name})`,
      token: null,
      source: moduleFile
    }));
    return [...providers, ...hints];
  }

  // -------------------------------------------------------------------------------------------------------------
  // Lazy infrastructure
  // -------------------------------------------------------------------------------------------------------------

  private warn(method: string, side: WorktreeSide, filePath: string, error: unknown): void {
    const message = getErrorMessage(error);
    const key = `${method}\0${side}\0${message}`;
    if (this.warned.has(key)) {
      return;
    }
    this.warned.add(key);
    this.state.log.warn(
      { event: "source_queries.failed", framework: "angular", method, side, path: filePath, error: message },
      "Source query failed; returning an empty result"
    );
  }

  /** Rejects when the worktree of `side` is gone (07 removed it); callers turn that into their empty result. */
  private async ensureSide(side: Side): Promise<void> {
    const stats = await fs.stat(this.state.shared.sides[side].rootDir);
    if (!stats.isDirectory()) {
      throw new Error(`The ${side} worktree no longer exists`);
    }
  }

  private resolverFor(side: Side): Promise<ModuleResolver> {
    const sideState = this.state.shared.sides[side];
    sideState.resolver ??= ModuleResolver.create({
      side,
      rootDir: sideState.rootDir,
      tsconfigPath: this.state.repository.tsconfigPath,
      viteConfigPath: null,
      sourceRoot: this.state.layout.sourceRoot,
      warn: (message) => {
        this.state.log.warn({ event: "source_queries.resolver_warning", side, detail: message }, "Resolver warning");
      }
    });
    return sideState.resolver;
  }

  private graphFor(side: Side): Promise<ImportGraph> {
    const sideState = this.state.shared.sides[side];
    sideState.graph ??= this.buildGraph(side);
    return sideState.graph;
  }

  private async buildGraph(side: Side): Promise<ImportGraph> {
    const resolver = await this.resolverFor(side);
    const priorityPaths: string[] = [];
    for (const change of this.state.changes.values()) {
      const p = side === "head" ? change.headPath : change.basePath;
      if (p !== null) {
        priorityPaths.push(p);
      }
    }
    return ImportGraph.build({
      side,
      rootDir: this.state.shared.sides[side].rootDir,
      sourceRoot: this.state.layout.sourceRoot,
      resolver,
      detector: this.state.detector,
      priorityPaths,
      maxFiles: ANALYSIS_MAX_PARSED_FILES,
      budgetMs: ANALYSIS_GRAPH_BUDGET_MS,
      signal: AbortSignal.timeout(ANALYSIS_GRAPH_BUDGET_MS),
      now: this.state.now,
      log: this.state.log
    });
  }

  private indexFor(side: Side): Promise<AngularComponentIndex> {
    const existing = this.state.indexes[side];
    if (existing !== null) {
      return existing;
    }
    const built = this.buildIndex(side);
    this.state.indexes[side] = built;
    return built;
  }

  private async buildIndex(side: Side): Promise<AngularComponentIndex> {
    const resolver = await this.resolverFor(side);
    const priorityPaths: string[] = [];
    for (const change of this.state.changes.values()) {
      const p = side === "head" ? change.headPath : change.basePath;
      if (p !== null) {
        priorityPaths.push(p);
      }
    }
    return AngularComponentIndex.build({
      side,
      rootDir: this.state.shared.sides[side].rootDir,
      sourceRoot: this.state.layout.sourceRoot,
      appRoot: this.state.layout.appRoot,
      maxFiles: ANALYSIS_MAX_PARSED_FILES,
      maxFileBytes: ANALYSIS_MAX_FILE_BYTES,
      priorityPaths,
      angularMajor: this.state.angularMajor,
      signal: AbortSignal.timeout(ANALYSIS_GRAPH_BUDGET_MS),
      now: this.state.now,
      resolveScript: (specifier, from) => {
        const resolution = resolver.resolveScript(specifier, from);
        return resolution.kind === "internal" ? resolution.path : null;
      },
      log: this.state.log
    });
  }

  private async text(side: Side, filePath: string): Promise<string | null> {
    for (const change of this.state.changes.values()) {
      if (side === "head" && change.headPath === filePath) {
        return change.headText;
      }
      if (side === "base" && change.basePath === filePath) {
        return change.baseText;
      }
    }
    const key = `${side}:${filePath}`;
    if (this.state.shared.texts.has(key)) {
      return this.state.shared.texts.get(key) ?? null;
    }
    const text = await readConfinedText(this.state.shared.sides[side].rootDir, filePath);
    this.state.shared.texts.set(key, text);
    return text;
  }

  private async sourceFile(side: Side, filePath: string): Promise<ts.SourceFile | null> {
    if (!filePath.endsWith(".ts")) {
      return null;
    }
    const key = `angular:${side}:${filePath}`;
    const cached = this.state.shared.sourceFiles.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const text = await this.text(side, filePath);
    if (text === null) {
      return null;
    }
    const sf = ts.createSourceFile(filePath, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    this.state.shared.sourceFiles.set(key, sf);
    return sf;
  }
}

/** First call expression (depth-first, source order) matching `predicate`, or null. */
function findCall(root: ts.Node, predicate: (call: ts.CallExpression) => boolean): ts.CallExpression | null {
  if (ts.isCallExpression(root) && predicate(root)) {
    return root;
  }
  let found: ts.CallExpression | null = null;
  ts.forEachChild(root, (child) => {
    found ??= findCall(child, predicate);
    return found ?? undefined;
  });
  return found;
}

/** `{ provide: X, … }` → "X"; anything else → null. */
function providerToken(element: ts.Expression, sf: ts.SourceFile): string | null {
  const e = unwrap(element);
  if (!ts.isObjectLiteralExpression(e)) {
    return null;
  }
  for (const property of e.properties) {
    if (
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "provide"
    ) {
      return property.initializer.getText(sf);
    }
  }
  return null;
}

function isPrivateMember(member: ts.ClassElement): boolean {
  return (
    hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
    (member.name !== undefined && ts.isPrivateIdentifier(member.name))
  );
}

function reindent(text: string): string[] {
  const lines = text.split("\n");
  const indents = lines
    .slice(1)
    .filter((line) => line.trim() !== "")
    .map((line) => /^\s*/.exec(line)?.[0].length ?? 0);
  const strip = indents.length === 0 ? 0 : Math.max(0, Math.min(...indents) - 2);
  return lines.map(
    (line, index) => `  ${index === 0 ? line.trim() : line.slice(Math.min(strip, /^\s*/.exec(line)?.[0].length ?? 0))}`
  );
}

/** Class outline: decorators, header, members with bodies elided, private members dropped, ≤ 120 lines. */
function classOutline(cls: ts.ClassDeclaration, sf: ts.SourceFile): string {
  const decorators = ts.getDecorators(cls) ?? [];
  const lines: string[] = decorators.map((decorator) => decorator.getText(sf));
  const headerStart =
    decorators.length > 0 ? (decorators[decorators.length - 1]?.getEnd() ?? cls.getStart(sf)) : cls.getStart(sf);
  lines.push(sf.text.slice(headerStart, cls.members.pos).trim());
  for (const member of cls.members) {
    if (isPrivateMember(member)) {
      continue;
    }
    const body =
      ts.isConstructorDeclaration(member) ||
      ts.isMethodDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
        ? member.body
        : undefined;
    const text =
      body === undefined
        ? member.getText(sf)
        : `${sf.text.slice(member.getStart(sf), body.getStart(sf)).trimEnd()} { … }`;
    lines.push(...reindent(text));
  }
  lines.push("}");
  if (lines.length > ANGULAR_ANALYSIS_OUTLINE_MAX_LINES) {
    return [...lines.slice(0, ANGULAR_ANALYSIS_OUTLINE_MAX_LINES - 2), "  // … (outline truncated)", "}"].join("\n");
  }
  return lines.join("\n");
}
