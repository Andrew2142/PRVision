/**
 * `AnalysisSourceQueries` — the `ComponentSourceQueries` implementation returned in
 * `ChangeAnalysisResult.sourceQueries` (08 §5.14, 00 §14.7). It is the only 08 → 09 hand-off.
 *
 * Read-only and lazy: files are read from the worktrees on demand, the base resolver and base graph are built on
 * the first base query. Every method catches everything and returns its documented empty result (one `warn` log
 * per method, side and reason), so it never rejects — also after sheet 07 removed the worktrees.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Logger } from "pino";
import ts from "typescript";
import {
  ANALYSIS_GRAPH_BUDGET_MS,
  ANALYSIS_MAX_PARSED_FILES,
  ANALYSIS_SOURCE_ROOT,
  CALL_SITE_CONTEXT_LINES,
  CALL_SITE_MAX_LIMIT,
  TYPE_SOURCES_MAX_CHARS,
  TYPE_SOURCES_MAX_RELATED
} from "../../../config-consts";
import type { FileChange, Side } from "../../../types/change-analysis";
import type {
  CallSite,
  ChangeAnalysisResult,
  ChangedDependency,
  ComponentCandidate,
  ComponentSourceQueries,
  DirectImport,
  PipelineContext,
  PreparedWorkspace,
  TypeSourceResult,
  WorktreeSide
} from "../../../types/visualization-pipeline";
import { getErrorMessage } from "../../../utilities";
import { basePathFor, classifySourcePath, confinedFileExists, headPathFor, readConfinedText } from "./change-source";
import { isTypeOnlyClause, lineOf, type ComponentDetector } from "./component-detector";
import { ImportGraph } from "./import-graph";
import { packageNameOf } from "./mock-rules";
import { ASSET_SPECIFIER, ModuleResolver, STYLE_SPECIFIER, type Resolution } from "./module-resolver";

const SCRIPT_FILE = /\.(tsx?|jsx?|mjs|cjs|mts|cts)$/;
const MAX_CHANGED_DEPENDENCIES = 10;
const MAX_EXPORT_HOPS = 3;
const LONG_ELEMENT_LINES = 40;

/** Small Map-based LRU (no dependency). */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}

interface SideState {
  rootDir: string;
  resolver: Promise<ModuleResolver> | null;
  graph: Promise<ImportGraph> | null;
}

/** Everything the queries need, built by `ChangeAnalysisService.analyze` (08 §5.14). */
export interface AnalysisState {
  workspace: PreparedWorkspace;
  repository: PipelineContext["repository"];
  changes: ReadonlyMap<string, FileChange>; // analysable FileChanges by head path (base path for D)
  changedFiles: ChangeAnalysisResult["changedFiles"];
  rows: ReadonlyArray<{ filePath: string; changeKind: ComponentCandidate["changeKind"] }>; // every persisted row
  detector: ComponentDetector;
  sides: Record<Side, SideState>;
  texts: LruCache<string, string | null>; // `${side}:${path}`, max 500 (changed files pinned in `changes`)
  sourceFiles: LruCache<string, ts.SourceFile>; // `${side}:${path}`, max 200, parsed with parents
  log: Logger;
  sourceRoot?: string;
  now?: () => number;
}

interface TypeDecl {
  name: string;
  node: ts.InterfaceDeclaration | ts.TypeAliasDeclaration | ts.EnumDeclaration | ts.ClassDeclaration;
  sf: ts.SourceFile;
  filePath: string;
}

type SourceEntry = TypeSourceResult["sources"][number];

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

function byString(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hasExportModifier(node: ts.Node): boolean {
  return (
    ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
  );
}

function typeDeclKind(node: TypeDecl["node"]): SourceEntry["kind"] {
  if (ts.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return "type";
  }
  if (ts.isEnumDeclaration(node)) {
    return "enum";
  }
  return "class";
}

function topLevelTypeDecl(sf: ts.SourceFile, name: string): TypeDecl["node"] | null {
  for (const statement of sf.statements) {
    if (
      (ts.isInterfaceDeclaration(statement) ||
        ts.isTypeAliasDeclaration(statement) ||
        ts.isEnumDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name?.text === name
    ) {
      return statement;
    }
  }
  return null;
}

function importBindingOf(sf: ts.SourceFile, local: string): { imported: string; specifier: string } | null {
  for (const statement of sf.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !statement.importClause
    ) {
      continue;
    }
    const specifier = statement.moduleSpecifier.text;
    const clause = statement.importClause;
    if (clause.name?.text === local) {
      return { imported: "default", specifier };
    }
    const named = clause.namedBindings;
    if (named && ts.isNamespaceImport(named) && named.name.text === local) {
      return { imported: "*", specifier };
    }
    if (named && ts.isNamedImports(named)) {
      for (const element of named.elements) {
        if (element.name.text === local) {
          return { imported: (element.propertyName ?? element.name).text, specifier };
        }
      }
    }
  }
  return null;
}

function unwrapPropsWrapper(node: ts.TypeNode, sf: ts.SourceFile): ts.TypeNode {
  if (ts.isTypeReferenceNode(node) && node.typeArguments?.length === 1) {
    const name = node.typeName.getText(sf);
    if (name === "Readonly" || name === "PropsWithChildren" || name === "React.PropsWithChildren") {
      return node.typeArguments[0] ?? node;
    }
  }
  return node;
}

function typeParameterNames(node: ts.Node): Set<string> {
  const names = new Set<string>();
  const params = (node as { typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }).typeParameters;
  for (const param of params ?? []) {
    names.add(param.name.text);
  }
  return names;
}

function referencedTypeNames(node: ts.Node, sf: ts.SourceFile, skip: Set<string>): string[] {
  const names = new Set<string>();
  const visit = (child: ts.Node): void => {
    if (ts.isTypeReferenceNode(child)) {
      const name = child.typeName.getText(sf);
      if (!skip.has(name)) {
        names.add(name);
      }
    } else if (ts.isExpressionWithTypeArguments(child) && ts.isInterfaceDeclaration(node)) {
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

function sourceEntry(
  name: string,
  kind: SourceEntry["kind"],
  depth: 0 | 1,
  node: ts.Node,
  sf: ts.SourceFile,
  filePath: string
): SourceEntry {
  return {
    name,
    filePath,
    startLine: lineOf(sf, node.getStart(sf)),
    endLine: lineOf(sf, node.getEnd()),
    kind,
    depth,
    text: node.getText(sf)
  };
}

function staticAssignment(sf: ts.SourceFile, localName: string, property: string): ts.ExpressionStatement | null {
  for (const statement of sf.statements) {
    if (!ts.isExpressionStatement(statement)) {
      continue;
    }
    const expr = statement.expression;
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(expr.left) &&
      ts.isIdentifier(expr.left.expression) &&
      expr.left.expression.text === localName &&
      expr.left.name.text === property
    ) {
      return statement;
    }
  }
  return null;
}

function roleOf(filePath: string, sourceRoot: string): CallSite["role"] {
  const role = classifySourcePath(filePath, { sourceRoot }).role;
  return role === "test" || role === "story" ? role : "source";
}

const ROLE_ORDER: Record<CallSite["role"], number> = { source: 0, story: 1, test: 2 };

/** The read-only query object handed from 08 to 09 (08 §5.14). */
export class AnalysisSourceQueries implements ComponentSourceQueries {
  private readonly warned = new Set<string>();
  private readonly sourceRoot: string;

  constructor(private readonly state: AnalysisState) {
    this.sourceRoot = state.sourceRoot ?? ANALYSIS_SOURCE_ROOT;
  }

  async componentPaths(filePath: string): Promise<{ base: string | null; head: string | null }> {
    try {
      await Promise.all([this.ensureSide("base"), this.ensureSide("head")]);
      const row = this.state.rows.find((candidate) => candidate.filePath === filePath);
      const kind = row?.changeKind ?? "modified";
      const base = basePathFor(filePath, kind, this.state.changedFiles);
      const head = headPathFor(filePath, kind);
      const [baseExists, headExists] = await Promise.all([
        base === null ? Promise.resolve(false) : confinedFileExists(this.state.sides.base.rootDir, base),
        head === null ? Promise.resolve(false) : confinedFileExists(this.state.sides.head.rootDir, head)
      ]);
      return { base: baseExists ? base : null, head: headExists ? head : null };
    } catch (error: unknown) {
      this.warn("componentPaths", "head", filePath, error);
      return { base: null, head: null };
    }
  }

  async resolveTypeSources(filePath: string, exportName: string, side: WorktreeSide): Promise<TypeSourceResult> {
    try {
      await this.ensureSide(side);
      return await this.resolveTypeSourcesUnsafe(filePath, exportName, side);
    } catch (error: unknown) {
      this.warn("resolveTypeSources", side, filePath, error);
      return emptyTypeSources(filePath, exportName, side);
    }
  }

  async findCallSites(filePath: string, exportName: string, side: WorktreeSide, limit: number): Promise<CallSite[]> {
    try {
      await this.ensureSide(side);
      return await this.findCallSitesUnsafe(filePath, exportName, side, limit);
    } catch (error: unknown) {
      this.warn("findCallSites", side, filePath, error);
      return [];
    }
  }

  async getDirectImports(filePath: string, side: WorktreeSide): Promise<DirectImport[]> {
    try {
      await this.ensureSide(side);
      return await this.getDirectImportsUnsafe(filePath, side);
    } catch (error: unknown) {
      this.warn("getDirectImports", side, filePath, error);
      return [];
    }
  }

  async getModuleExports(filePath: string, side: WorktreeSide): Promise<string[] | null> {
    try {
      await this.ensureSide(side);
      const names = await this.moduleExports(filePath, side, new Set(), 0);
      return names === null ? null : [...names].sort(byString);
    } catch (error: unknown) {
      this.warn("getModuleExports", side, filePath, error);
      return null;
    }
  }

  async resolveSpecifier(fromFilePath: string, specifier: string, side: WorktreeSide): Promise<string | null> {
    try {
      await this.ensureSide(side);
      const resolver = await this.resolverFor(side);
      let r = resolver.resolveScript(specifier, fromFilePath);
      if (r.kind === "unresolved" && STYLE_SPECIFIER.test(specifier)) {
        r = resolver.resolveStyle(specifier, fromFilePath);
      }
      if (r.kind === "internal") {
        return r.path;
      }
      if (r.kind === "external") {
        const packageName = packageNameOf(specifier);
        if (packageName !== null && (await resolver.isInstalledPackage(packageName))) {
          return `package:${packageName}`;
        }
      }
      return null;
    } catch (error: unknown) {
      this.warn("resolveSpecifier", side, fromFilePath, error);
      return null;
    }
  }

  async changedDependenciesOf(filePath: string, side: WorktreeSide, maxDepth: number): Promise<ChangedDependency[]> {
    try {
      await this.ensureSide(side);
      const depthLimit = Math.min(3, Math.max(1, Math.trunc(maxDepth)));
      const graph = await this.graphFor(side);
      const changesByPath = new Map<string, FileChange>();
      for (const change of this.state.changes.values()) {
        const p = side === "head" ? change.headPath : change.basePath;
        if (p !== null) {
          changesByPath.set(p, change);
        }
      }
      const out: ChangedDependency[] = [];
      const visited = new Set([filePath]);
      let level = [filePath];
      for (let depth = 1; depth <= depthLimit && level.length > 0; depth++) {
        const next = new Set<string>();
        for (const current of level) {
          for (const edge of graph.importsOf(current)) {
            if (!visited.has(edge.to)) {
              visited.add(edge.to);
              next.add(edge.to);
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
      { event: "source_queries.failed", method, side, path: filePath, error: message },
      "Source query failed; returning an empty result"
    );
  }

  /** Rejects when the worktree of `side` is gone (07 removed it); callers turn that into their empty result. */
  private async ensureSide(side: Side): Promise<void> {
    const stats = await fs.stat(this.state.sides[side].rootDir);
    if (!stats.isDirectory()) {
      throw new Error(`The ${side} worktree no longer exists`);
    }
  }

  private resolverFor(side: Side): Promise<ModuleResolver> {
    const sideState = this.state.sides[side];
    sideState.resolver ??= ModuleResolver.create({
      side,
      rootDir: sideState.rootDir,
      tsconfigPath: this.state.repository.tsconfigPath,
      viteConfigPath: this.state.repository.viteConfigPath,
      sourceRoot: this.sourceRoot,
      warn: (message) => {
        this.state.log.warn({ event: "source_queries.resolver_warning", side, detail: message }, "Resolver warning");
      }
    });
    return sideState.resolver;
  }

  private graphFor(side: Side): Promise<ImportGraph> {
    const sideState = this.state.sides[side];
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
      rootDir: this.state.sides[side].rootDir,
      sourceRoot: this.sourceRoot,
      resolver,
      detector: this.state.detector,
      priorityPaths,
      maxFiles: ANALYSIS_MAX_PARSED_FILES,
      budgetMs: ANALYSIS_GRAPH_BUDGET_MS,
      signal: AbortSignal.timeout(ANALYSIS_GRAPH_BUDGET_MS),
      now: this.state.now ?? Date.now,
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
    if (this.state.texts.has(key)) {
      return this.state.texts.get(key) ?? null;
    }
    const text = await readConfinedText(this.state.sides[side].rootDir, filePath);
    this.state.texts.set(key, text);
    return text;
  }

  private async sourceFile(side: Side, filePath: string): Promise<ts.SourceFile | null> {
    if (!SCRIPT_FILE.test(filePath)) {
      return null;
    }
    const key = `${side}:${filePath}`;
    const cached = this.state.sourceFiles.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const text = await this.text(side, filePath);
    if (text === null) {
      return null;
    }
    const sf = this.state.detector.parse(filePath, text, { parents: true });
    this.state.sourceFiles.set(key, sf);
    return sf;
  }

  // -------------------------------------------------------------------------------------------------------------
  // resolveTypeSources (08 §5.14.1)
  // -------------------------------------------------------------------------------------------------------------

  private async resolveTypeSourcesUnsafe(
    filePath: string,
    exportName: string,
    side: WorktreeSide
  ): Promise<TypeSourceResult> {
    const sf = await this.sourceFile(side, filePath);
    const resolved = sf === null ? null : this.state.detector.findExport(sf, exportName);
    if (sf === null || resolved === null || resolved.componentNode === null) {
      return emptyTypeSources(filePath, exportName, side);
    }
    const location = this.state.detector.findPropsTypeNode(resolved);
    const result: TypeSourceResult = {
      ...emptyTypeSources(filePath, exportName, side),
      found: true,
      parameterText: location.parameterText
    };
    const candidates: SourceEntry[] = [];
    const unresolved = new Set<string>();
    const depthZero: Array<{ node: ts.Node; sf: ts.SourceFile; filePath: string }> = [];
    const seenDecls = new Set<ts.Node>();
    const componentTypeParams = typeParameterNames(resolved.componentNode);

    if (location.typeNode !== null) {
      const typeNode = unwrapPropsWrapper(location.typeNode, sf);
      if (ts.isTypeReferenceNode(typeNode)) {
        const name = typeNode.typeName.getText(sf);
        result.propsTypeName = name;
        const decl = await this.lookupType(name, sf, filePath, side);
        if (decl === null) {
          unresolved.add(name);
        } else {
          seenDecls.add(decl.node);
          candidates.push(sourceEntry(decl.name, typeDeclKind(decl.node), 0, decl.node, decl.sf, decl.filePath));
          depthZero.push({ node: decl.node, sf: decl.sf, filePath: decl.filePath });
        }
      } else {
        candidates.push(sourceEntry("(inline)", "inline", 0, typeNode, sf, filePath));
        depthZero.push({ node: typeNode, sf, filePath });
      }
    }
    const localName = resolved.info.localName;
    if (localName !== null) {
      if (location.typeNode === null) {
        const propTypes = staticAssignment(sf, localName, "propTypes");
        if (propTypes !== null) {
          candidates.push(sourceEntry("(propTypes)", "propTypes", 0, propTypes, sf, filePath));
        }
      }
      const defaultProps = staticAssignment(sf, localName, "defaultProps");
      if (defaultProps !== null) {
        candidates.push(sourceEntry("(defaultProps)", "defaultProps", 0, defaultProps, sf, filePath));
      }
    }

    // depth 1: names referenced by every depth-0 node
    const related = new Map<string, { sf: ts.SourceFile; filePath: string }>();
    for (const entry of depthZero) {
      const skip = new Set([...typeParameterNames(entry.node), ...componentTypeParams]);
      if (result.propsTypeName !== null) {
        skip.add(result.propsTypeName);
      }
      for (const name of referencedTypeNames(entry.node, entry.sf, skip)) {
        if (!related.has(name)) {
          related.set(name, { sf: entry.sf, filePath: entry.filePath });
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
      } else if (!seenDecls.has(decl.node)) {
        seenDecls.add(decl.node);
        candidates.push(sourceEntry(decl.name, typeDeclKind(decl.node), 1, decl.node, decl.sf, decl.filePath));
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

  /** Same-file declaration, else an imported one (exported declaration, re-exports followed ≤ 3 hops). */
  private async lookupType(name: string, sf: ts.SourceFile, filePath: string, side: Side): Promise<TypeDecl | null> {
    const [head, tail] = name.includes(".")
      ? [name.slice(0, name.indexOf(".")), name.slice(name.indexOf(".") + 1)]
      : [name, null];
    if (tail === null) {
      const local = topLevelTypeDecl(sf, name);
      if (local !== null) {
        return { name, node: local, sf, filePath };
      }
    }
    const binding = importBindingOf(sf, head);
    if (binding === null) {
      return null;
    }
    if (tail !== null && binding.imported !== "*") {
      return null;
    }
    const resolver = await this.resolverFor(side);
    const target = resolver.resolveScript(binding.specifier, filePath);
    if (target.kind !== "internal") {
      return null;
    }
    const importedName = tail ?? binding.imported;
    return this.exportedTypeDecl(target.path, importedName, side, 0);
  }

  private async exportedTypeDecl(filePath: string, name: string, side: Side, hops: number): Promise<TypeDecl | null> {
    if (hops > MAX_EXPORT_HOPS) {
      return null;
    }
    const sf = await this.sourceFile(side, filePath);
    if (sf === null) {
      return null;
    }
    const resolver = await this.resolverFor(side);
    const follow = async (specifier: string, imported: string): Promise<TypeDecl | null> => {
      const target = resolver.resolveScript(specifier, filePath);
      return target.kind === "internal" ? this.exportedTypeDecl(target.path, imported, side, hops + 1) : null;
    };
    for (const statement of sf.statements) {
      if (
        (ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement) ||
          ts.isClassDeclaration(statement)) &&
        statement.name?.text === name &&
        hasExportModifier(statement)
      ) {
        return { name, node: statement, sf, filePath };
      }
    }
    const stars: string[] = [];
    for (const statement of sf.statements) {
      if (!ts.isExportDeclaration(statement)) {
        continue;
      }
      const specifier =
        statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
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
        if (specifier !== null) {
          return follow(specifier, local);
        }
        const decl = topLevelTypeDecl(sf, local);
        if (decl !== null) {
          return { name: local, node: decl, sf, filePath };
        }
        const binding = importBindingOf(sf, local);
        if (binding !== null) {
          return follow(binding.specifier, binding.imported);
        }
      }
    }
    for (const specifier of stars) {
      const found = await follow(specifier, name);
      if (found !== null) {
        return found;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------------------------
  // findCallSites (08 §5.14.2)
  // -------------------------------------------------------------------------------------------------------------

  private async findCallSitesUnsafe(
    filePath: string,
    exportName: string,
    side: WorktreeSide,
    limit: number
  ): Promise<CallSite[]> {
    const max = Math.min(CALL_SITE_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
    const graph = await this.graphFor(side);
    const tags = new Map<string, Set<string>>();
    const addTag = (importer: string, tag: string): void => {
      const set = tags.get(importer) ?? new Set<string>();
      set.add(tag);
      tags.set(importer, set);
    };
    for (const alias of graph.exportAliases(filePath, exportName, MAX_EXPORT_HOPS)) {
      for (const edge of graph.importersOf(alias.path)) {
        if (edge.kind !== "import") {
          continue;
        }
        for (const binding of edge.bindings) {
          if (binding.imported === alias.exportName) {
            addTag(edge.from, binding.local);
          } else if (binding.imported === "*") {
            addTag(edge.from, `${binding.local}.${alias.exportName}`);
          }
        }
      }
    }
    const own = graph.module(filePath)?.exports.find((e) => e.exportName === exportName)?.localName ?? null;
    if (own !== null) {
      addTag(filePath, own);
    }

    interface Usage {
      filePath: string;
      role: CallSite["role"];
      line: number;
      elementEnd: number;
      usedAs: string;
      sf: ts.SourceFile;
    }
    const usages: Usage[] = [];
    for (const [importer, tagSet] of [...tags.entries()].sort((a, b) => byString(a[0], b[0]))) {
      const sf = await this.sourceFile(side, importer);
      if (sf === null) {
        continue;
      }
      const role = roleOf(importer, this.sourceRoot);
      const visit = (node: ts.Node): void => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const usedAs = node.tagName.getText(sf);
          if (tagSet.has(usedAs)) {
            const elementNode = ts.isJsxOpeningElement(node) ? node.parent : node;
            usages.push({
              filePath: importer,
              role,
              line: lineOf(sf, node.getStart(sf)),
              elementEnd: lineOf(sf, elementNode.getEnd()),
              usedAs,
              sf
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    usages.sort(
      (a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || byString(a.filePath, b.filePath) || a.line - b.line
    );
    const picked = new Set<Usage>();
    const perFile = new Map<string, number>();
    for (const usage of usages) {
      if (picked.size >= max) {
        break;
      }
      const count = perFile.get(usage.filePath) ?? 0;
      if (count < 2) {
        picked.add(usage);
        perFile.set(usage.filePath, count + 1);
      }
    }
    for (const usage of usages) {
      if (picked.size >= max) {
        break;
      }
      picked.add(usage);
    }
    return usages.filter((usage) => picked.has(usage)).map((usage) => this.toCallSite(usage));
  }

  private toCallSite(usage: {
    filePath: string;
    role: CallSite["role"];
    line: number;
    elementEnd: number;
    usedAs: string;
    sf: ts.SourceFile;
  }): CallSite {
    const lines = usage.sf.text.split("\n");
    const totalLines = lines.length;
    const startLine = Math.max(1, usage.line - CALL_SITE_CONTEXT_LINES);
    let endLine = Math.min(totalLines, usage.elementEnd + CALL_SITE_CONTEXT_LINES);
    let continuation = "";
    if (usage.elementEnd - usage.line > LONG_ELEMENT_LINES) {
      endLine = Math.min(totalLines, usage.line + LONG_ELEMENT_LINES);
      continuation = `\n// … element continues to line ${String(usage.elementEnd)}`;
    }
    const header = `// ${usage.filePath} lines ${String(startLine)}–${String(endLine)} (usage at line ${String(usage.line)})`;
    return {
      filePath: usage.filePath,
      role: usage.role,
      line: usage.line,
      startLine,
      endLine,
      usedAs: usage.usedAs,
      snippet: `${header}\n${lines.slice(startLine - 1, endLine).join("\n")}${continuation}`
    };
  }

  // -------------------------------------------------------------------------------------------------------------
  // getDirectImports (08 §5.14.3)
  // -------------------------------------------------------------------------------------------------------------

  private async getDirectImportsUnsafe(filePath: string, side: WorktreeSide): Promise<DirectImport[]> {
    const sf = await this.sourceFile(side, filePath);
    if (sf === null) {
      return [];
    }
    const resolver = await this.resolverFor(side);
    const found: Array<{ pos: number; entry: DirectImport }> = [];
    const base = (specifier: string, node: ts.Node): DirectImport => ({
      specifier,
      line: lineOf(sf, node.getStart(sf)),
      ...this.classify(specifier, filePath, resolver),
      defaultImport: false,
      namespaceImport: false,
      namedImports: [],
      typeOnly: false,
      sideEffectOnly: false,
      reexport: false,
      dynamic: false
    });
    for (const statement of sf.statements) {
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        const entry = base(statement.moduleSpecifier.text, statement);
        const clause = statement.importClause;
        if (!clause) {
          entry.sideEffectOnly = true;
        } else {
          entry.defaultImport = clause.name !== undefined;
          const named = clause.namedBindings;
          entry.namespaceImport = named !== undefined && ts.isNamespaceImport(named);
          const elements = named !== undefined && ts.isNamedImports(named) ? named.elements : [];
          entry.namedImports = isTypeOnlyClause(clause)
            ? []
            : elements
                .filter((element) => !element.isTypeOnly)
                .map((element) => (element.propertyName ?? element.name).text)
                .filter((name) => name !== "default")
                .sort(byString);
          if (elements.some((e) => !e.isTypeOnly && (e.propertyName ?? e.name).text === "default")) {
            entry.defaultImport = true;
          }
          entry.typeOnly =
            isTypeOnlyClause(clause) ||
            (!entry.defaultImport &&
              !entry.namespaceImport &&
              elements.length > 0 &&
              elements.every((e) => e.isTypeOnly));
        }
        found.push({ pos: statement.getStart(sf), entry });
      } else if (
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier !== undefined &&
        ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        const entry = base(statement.moduleSpecifier.text, statement);
        entry.reexport = true;
        const clause = statement.exportClause;
        if (clause === undefined || ts.isNamespaceExport(clause)) {
          entry.namespaceImport = true;
          entry.typeOnly = statement.isTypeOnly;
        } else {
          const elements = clause.elements;
          const runtime = statement.isTypeOnly ? [] : elements.filter((element) => !element.isTypeOnly);
          entry.defaultImport = runtime.some((element) => (element.propertyName ?? element.name).text === "default");
          entry.namedImports = runtime
            .map((element) => (element.propertyName ?? element.name).text)
            .filter((name) => name !== "default")
            .sort(byString);
          entry.typeOnly = statement.isTypeOnly || (elements.length > 0 && runtime.length === 0);
        }
        found.push({ pos: statement.getStart(sf), entry });
      }
    }
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        if (argument !== undefined && ts.isStringLiteralLike(argument)) {
          const entry = base(argument.text, node);
          entry.dynamic = true;
          found.push({ pos: node.getStart(sf), entry });
        }
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(sf, visit);
    return found.sort((a, b) => a.pos - b.pos).map((item) => item.entry);
  }

  /** `kind` / `resolvedPath` classification of 08 §5.1.1 (first match). */
  private classify(
    specifier: string,
    fromFilePath: string,
    resolver: ModuleResolver
  ): Pick<DirectImport, "kind" | "resolvedPath"> {
    const internalPath = (r: Resolution): string | null => (r.kind === "internal" ? r.path : null);
    if (STYLE_SPECIFIER.test(specifier)) {
      return { kind: "style", resolvedPath: internalPath(resolver.resolveStyle(specifier, fromFilePath)) };
    }
    if (ASSET_SPECIFIER.test(specifier)) {
      return { kind: "asset", resolvedPath: null };
    }
    const resolution = resolver.resolveScript(specifier, fromFilePath);
    if (specifier.startsWith(".") || specifier.startsWith("/")) {
      return { kind: "relative", resolvedPath: internalPath(resolution) };
    }
    if (resolution.kind === "internal") {
      return { kind: "alias", resolvedPath: resolution.path };
    }
    return { kind: "package", resolvedPath: null };
  }

  // -------------------------------------------------------------------------------------------------------------
  // getModuleExports (08 §5.14.4)
  // -------------------------------------------------------------------------------------------------------------

  private async moduleExports(
    filePath: string,
    side: Side,
    visited: Set<string>,
    hops: number
  ): Promise<Set<string> | null> {
    if (!SCRIPT_FILE.test(filePath) || visited.has(filePath)) {
      return null;
    }
    visited.add(filePath);
    const sf = await this.sourceFile(side, filePath);
    if (sf === null) {
      return null;
    }
    const summary = this.state.detector.summarize(sf, {
      path: filePath,
      side,
      role: classifySourcePath(filePath, { sourceRoot: this.sourceRoot }).role,
      sizeBytes: sf.text.length
    });
    const names = new Set<string>();
    for (const info of summary.exports) {
      if (!info.typeOnly) {
        names.add(info.exportName);
      }
    }
    const stars: string[] = [];
    for (const raw of summary.imports) {
      if (raw.kind !== "reexport") {
        continue;
      }
      if (raw.star && raw.bindings.length === 0) {
        stars.push(raw.specifier);
        continue;
      }
      for (const binding of raw.bindings) {
        names.add(binding.local);
      }
    }
    if (hops < MAX_EXPORT_HOPS) {
      const resolver = await this.resolverFor(side);
      for (const specifier of stars) {
        const target = resolver.resolveScript(specifier, filePath);
        if (target.kind !== "internal") {
          continue;
        }
        const nested = await this.moduleExports(target.path, side, visited, hops + 1);
        for (const name of nested ?? []) {
          if (name !== "default") {
            names.add(name);
          }
        }
      }
    }
    return names;
  }
}

/** Builds the `AnalysisState` of one visualization (caches sized per 08 §5.14). */
export function createAnalysisState(input: {
  workspace: PreparedWorkspace;
  repository: PipelineContext["repository"];
  changes: ReadonlyMap<string, FileChange>;
  changedFiles: ChangeAnalysisResult["changedFiles"];
  rows: AnalysisState["rows"];
  detector: ComponentDetector;
  headResolver: ModuleResolver | null;
  headGraph: ImportGraph | null;
  log: Logger;
  sourceRoot?: string;
  now?: () => number;
}): AnalysisState {
  return {
    workspace: input.workspace,
    repository: input.repository,
    changes: input.changes,
    changedFiles: input.changedFiles,
    rows: input.rows,
    detector: input.detector,
    sides: {
      base: { rootDir: path.resolve(input.workspace.baseDir), resolver: null, graph: null },
      head: {
        rootDir: path.resolve(input.workspace.headDir),
        resolver: input.headResolver === null ? null : Promise.resolve(input.headResolver),
        graph: input.headGraph === null ? null : Promise.resolve(input.headGraph)
      }
    },
    texts: new LruCache(500),
    sourceFiles: new LruCache(200),
    log: input.log,
    sourceRoot: input.sourceRoot,
    now: input.now
  };
}
