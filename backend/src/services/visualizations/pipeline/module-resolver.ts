/**
 * Module resolution for one worktree side (08 §5.9): tsconfig `paths`/`baseUrl` (incl. project references),
 * statically read Vite `resolve.alias`, script and style specifiers.
 *
 * Nothing in the target repo is executed: the Vite config is parsed with `ts.createSourceFile` and evaluated by a
 * tiny static evaluator; tsconfig is parsed through a host restricted to the worktree (plus read-only `*.json`
 * under `node_modules/` for package-based `extends`). Module resolution never looks inside `node_modules/`, so
 * bare packages are always `external`. TypeScript's host API is synchronous, so file probes go through `ts.sys`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import type { Side } from "../../../types/change-analysis";
import { isPathInside } from "../../../utilities";
import { readConfinedText } from "./change-source";
import { isStyleSpecifier } from "./component-detector";

export type Resolution =
  | { kind: "internal"; path: string } // repo-relative POSIX, inside the worktree, not node_modules
  | { kind: "external" } // node_modules, outside the worktree, bare package, virtual module
  | { kind: "unresolved"; reason: string };

export interface AliasEntry {
  find: string;
  replacement: string; // absolute path inside rootDir; "" = alias to a package (external)
}

export interface ModuleResolverInput {
  side: Side;
  rootDir: string;
  tsconfigPath: string | null;
  viteConfigPath: string | null;
  sourceRoot: string;
  warn: (message: string) => void;
  debug?: (message: string) => void;
}

/** DirectImport asset regex of 08 §5.1.1 (also: any ?raw/?url/?react/?worker query). */
export const ASSET_SPECIFIER =
  /\.(svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp4|webm|mp3|wav|json)(\?.*)?$|\?(raw|url|react|worker)\b/;
/** DirectImport style regex of 08 §5.1.1. */
export const STYLE_SPECIFIER = /\.(css|scss|sass|less|styl)(\?.*)?$/;

const VITE_CONFIG_NAMES = ["vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs"];
const NO_INPUTS_DIAGNOSTIC = 18003;

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith(".") && !specifier.startsWith("/");
}

function inNodeModules(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative.split(path.sep).includes("node_modules");
}

/** Restricted, memoized TS hosts for one worktree (08 §5.9.1). */
class RestrictedHost {
  private readonly realRoot: string;
  private readonly realInsideCache = new Map<string, boolean>();

  constructor(private readonly rootDir: string) {
    this.realRoot = ts.sys.realpath?.(rootDir) ?? rootDir;
  }

  /** Module-resolution host: worktree only, never node_modules. */
  readonly moduleHost: ts.ModuleResolutionHost = {
    fileExists: (file) => this.allowedSource(file) && ts.sys.fileExists(file) && this.realInside(file),
    readFile: (file) => (this.allowedSource(file) && this.realInside(file) ? ts.sys.readFile(file) : undefined),
    directoryExists: (dir) => this.allowedSource(dir) && ts.sys.directoryExists(dir),
    getCurrentDirectory: () => this.rootDir,
    getDirectories: (dir) => (this.allowedSource(dir) ? ts.sys.getDirectories(dir) : [])
  };

  /** Config-parse host: worktree files plus read-only *.json under node_modules; readDirectory returns []. */
  readonly configHost: ts.ParseConfigHost = {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [],
    fileExists: (file) => this.allowedConfig(file) && ts.sys.fileExists(file),
    readFile: (file) => (this.allowedConfig(file) ? ts.sys.readFile(file) : undefined)
  };

  existsFile(file: string): boolean {
    return this.allowedSource(file) && ts.sys.fileExists(file) && this.realInside(file);
  }

  private allowedSource(candidate: string): boolean {
    return isPathInside(this.rootDir, candidate) && !inNodeModules(this.rootDir, candidate);
  }

  private allowedConfig(candidate: string): boolean {
    if (!isPathInside(this.rootDir, candidate)) {
      return false;
    }
    if (inNodeModules(this.rootDir, candidate)) {
      return candidate.endsWith(".json");
    }
    return this.realInside(candidate);
  }

  private realInside(candidate: string): boolean {
    const cached = this.realInsideCache.get(candidate);
    if (cached !== undefined) {
      return cached;
    }
    let inside: boolean;
    try {
      const real = ts.sys.realpath?.(candidate) ?? candidate;
      inside = isPathInside(this.realRoot, real) || !ts.sys.fileExists(candidate);
    } catch {
      inside = false;
    }
    this.realInsideCache.set(candidate, inside);
    return inside;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Static Vite config evaluation (08 §5.9.2)
// ---------------------------------------------------------------------------------------------------------------

interface ViteImports {
  pathNamespaces: Set<string>; // default/namespace imports of path / node:path
  resolveNames: Set<string>;
  joinNames: Set<string>;
  fileURLToPathNames: Set<string>;
}

class StaticEvaluator {
  private readonly consts = new Map<string, ts.Expression>();
  private readonly imports: ViteImports = {
    pathNamespaces: new Set(),
    resolveNames: new Set(),
    joinNames: new Set(),
    fileURLToPathNames: new Set()
  };

  constructor(
    private readonly sf: ts.SourceFile,
    private readonly configDir: string,
    private readonly rootDir: string
  ) {
    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.importClause
      ) {
        this.collectImport(statement.moduleSpecifier.text, statement.importClause);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer) {
            this.consts.set(declaration.name.text, declaration.initializer);
          }
        }
      }
    }
  }

  /** The config object literal, or null (08 §5.9.2 step 2). */
  findConfigObject(): ts.ObjectLiteralExpression | null {
    for (const statement of this.sf.statements) {
      if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
        return this.configFromArg(statement.expression, 0);
      }
      if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        statement.expression.left.getText(this.sf) === "module.exports"
      ) {
        return this.configFromArg(statement.expression.right, 0);
      }
    }
    return null;
  }

  /** Evaluates a path expression, or null when unsupported. */
  evalPath(node: ts.Expression, allowIdentifiers = true): string | null {
    const e = skipParens(node);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
      return e.text;
    }
    if (ts.isTemplateExpression(e)) {
      let out = e.head.text;
      for (const span of e.templateSpans) {
        const value = this.evalPath(span.expression, allowIdentifiers);
        if (value === null) {
          return null;
        }
        out += value + span.literal.text;
      }
      return out;
    }
    if (ts.isIdentifier(e)) {
      if (e.text === "__dirname") {
        return this.configDir;
      }
      const init = allowIdentifiers ? this.consts.get(e.text) : undefined;
      return init === undefined ? null : this.evalPath(init, false);
    }
    if (ts.isPropertyAccessExpression(e) && e.name.text === "pathname" && ts.isNewExpression(e.expression)) {
      return this.evalImportMetaUrl(e.expression, allowIdentifiers);
    }
    if (ts.isCallExpression(e)) {
      return this.evalCall(e, allowIdentifiers);
    }
    return null;
  }

  private collectImport(specifier: string, clause: ts.ImportClause): void {
    if (specifier === "path" || specifier === "node:path") {
      if (clause.name) {
        this.imports.pathNamespaces.add(clause.name.text);
      }
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) {
        this.imports.pathNamespaces.add(named.name.text);
      } else if (named) {
        for (const element of named.elements) {
          const imported = (element.propertyName ?? element.name).text;
          if (imported === "resolve") {
            this.imports.resolveNames.add(element.name.text);
          } else if (imported === "join") {
            this.imports.joinNames.add(element.name.text);
          }
        }
      }
    } else if ((specifier === "url" || specifier === "node:url") && clause.namedBindings) {
      const named = clause.namedBindings;
      if (ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if ((element.propertyName ?? element.name).text === "fileURLToPath") {
            this.imports.fileURLToPathNames.add(element.name.text);
          }
        }
      }
    }
  }

  private configFromArg(node: ts.Expression, depth: number): ts.ObjectLiteralExpression | null {
    if (depth > 3) {
      return null;
    }
    const e = skipParens(node);
    if (ts.isObjectLiteralExpression(e)) {
      return e;
    }
    if (ts.isCallExpression(e) && e.arguments[0]) {
      return this.configFromArg(e.arguments[0], depth + 1);
    }
    if (ts.isIdentifier(e)) {
      const init = this.consts.get(e.text);
      return init === undefined ? null : this.configFromArg(init, depth + 1);
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      if (!ts.isBlock(e.body)) {
        const body = skipParens(e.body);
        return ts.isObjectLiteralExpression(body) ? body : null;
      }
      const ret = e.body.statements.find(ts.isReturnStatement);
      const value = ret?.expression === undefined ? null : skipParens(ret.expression);
      return value !== null && ts.isObjectLiteralExpression(value) ? value : null;
    }
    return null;
  }

  private evalArgs(call: ts.CallExpression, allowIdentifiers: boolean): string[] | null {
    const out: string[] = [];
    for (const argument of call.arguments) {
      const value = this.evalPath(argument, allowIdentifiers);
      if (value === null) {
        return null;
      }
      out.push(value);
    }
    return out;
  }

  private evalCall(call: ts.CallExpression, allowIdentifiers: boolean): string | null {
    const callee = call.expression;
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)) {
      const object = callee.expression.text;
      const method = callee.name.text;
      if (object === "process" && method === "cwd" && call.arguments.length === 0) {
        return this.rootDir;
      }
      if (this.imports.pathNamespaces.has(object) && (method === "resolve" || method === "join")) {
        const args = this.evalArgs(call, allowIdentifiers);
        if (args === null) {
          return null;
        }
        return method === "resolve" ? path.resolve(this.configDir, ...args) : path.join(...args);
      }
      return null;
    }
    if (ts.isIdentifier(callee)) {
      if (this.imports.resolveNames.has(callee.text) || this.imports.joinNames.has(callee.text)) {
        const args = this.evalArgs(call, allowIdentifiers);
        if (args === null) {
          return null;
        }
        return this.imports.resolveNames.has(callee.text) ? path.resolve(this.configDir, ...args) : path.join(...args);
      }
      if (this.imports.fileURLToPathNames.has(callee.text) && call.arguments[0]) {
        const inner = skipParens(call.arguments[0]);
        return ts.isNewExpression(inner) ? this.evalImportMetaUrl(inner, allowIdentifiers) : null;
      }
    }
    return null;
  }

  /** `new URL(x, import.meta.url)` → path.resolve(configDir, x). */
  private evalImportMetaUrl(expr: ts.NewExpression, allowIdentifiers: boolean): string | null {
    if (!ts.isIdentifier(expr.expression) || expr.expression.text !== "URL") {
      return null;
    }
    const [first, second] = expr.arguments ?? [];
    if (first === undefined || second?.getText(this.sf) !== "import.meta.url") {
      return null;
    }
    const value = this.evalPath(first, allowIdentifiers);
    return value === null ? null : path.resolve(this.configDir, value);
  }
}

function skipParens(node: ts.Expression): ts.Expression {
  let e = node;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) {
    e = e.expression;
  }
  return e;
}

function propertyNamed(object: ts.ObjectLiteralExpression, name: string): ts.Expression | null {
  for (const property of object.properties) {
    if (!ts.isPropertyAssignment(property)) {
      continue;
    }
    const key = property.name;
    if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && key.text === name) {
      return property.initializer;
    }
  }
  return null;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// ModuleResolver
// ---------------------------------------------------------------------------------------------------------------

/** Resolves specifiers for one side. Create with `ModuleResolver.create`. */
export class ModuleResolver {
  private readonly cache = new Map<string, Resolution>();
  private readonly moduleCache: ts.ModuleResolutionCache;

  private constructor(
    readonly side: Side,
    private readonly rootDir: string,
    private readonly sourceRoot: string,
    private readonly host: RestrictedHost,
    private readonly compilerOptions: ts.CompilerOptions,
    readonly aliases: readonly AliasEntry[],
    private readonly pathsBase: string,
    private readonly debug: (message: string) => void
  ) {
    this.moduleCache = ts.createModuleResolutionCache(rootDir, (s) => s, compilerOptions);
  }

  /** Loads tsconfig (with references) and the statically readable Vite aliases of one worktree side. */
  static async create(input: ModuleResolverInput): Promise<ModuleResolver> {
    const rootDir = path.resolve(input.rootDir);
    const host = new RestrictedHost(rootDir);
    const debug = input.debug ?? ((): void => undefined);
    const { options, pathsBase } = loadCompilerOptions(rootDir, input.tsconfigPath, host, input.warn);
    const aliases = await loadViteAliases(rootDir, input.viteConfigPath, input.warn, debug);
    return new ModuleResolver(input.side, rootDir, input.sourceRoot, host, options, aliases, pathsBase, debug);
  }

  /** Resolves a script import specifier as seen from `fromRepoPath` (08 §5.9.3). */
  resolveScript(specifier: string, fromRepoPath: string): Resolution {
    const key = `s\0${path.posix.dirname(fromRepoPath)}\0${specifier}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = this.resolveScriptUncached(specifier, fromRepoPath);
    this.cache.set(key, result);
    return result;
  }

  /** Resolves a stylesheet specifier (script `.css` imports, SCSS `@use`/`@import`, CSS-module `composes`). */
  resolveStyle(specifier: string, fromRepoPath: string): Resolution {
    const key = `c\0${path.posix.dirname(fromRepoPath)}\0${specifier}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const result = this.resolveStyleUncached(specifier, fromRepoPath);
    this.cache.set(key, result);
    return result;
  }

  /** True when `<rootDir>/node_modules/<packageName>/package.json` exists (stat through the symlink, never read). */
  async isInstalledPackage(packageName: string): Promise<boolean> {
    if (packageName.includes("..") || packageName.startsWith("/")) {
      return false;
    }
    try {
      const stats = await fs.stat(path.join(this.rootDir, "node_modules", packageName, "package.json"));
      return stats.isFile();
    } catch {
      return false;
    }
  }

  /** tsconfig `paths` mapping for non-relative specifiers (TS does not map .css/.scss through `paths`). */
  applyTsconfigPaths(specifier: string): string | null {
    const paths = this.compilerOptions.paths;
    if (paths === undefined) {
      return null;
    }
    const base = this.compilerOptions.baseUrl ?? this.pathsBase;
    for (const [key, targets] of Object.entries(paths)) {
      const first = targets[0];
      if (first === undefined) {
        continue;
      }
      let mapped: string | null = null;
      if (!key.includes("*")) {
        mapped = key === specifier ? first : null;
      } else {
        const [prefix = "", suffix = ""] = key.split("*");
        if (
          specifier.startsWith(prefix) &&
          specifier.endsWith(suffix) &&
          specifier.length >= prefix.length + suffix.length
        ) {
          mapped = first.replace("*", specifier.slice(prefix.length, specifier.length - suffix.length));
        }
      }
      if (mapped !== null) {
        const absolute = path.resolve(base, mapped);
        return isPathInside(this.rootDir, absolute) ? absolute : null;
      }
    }
    return null;
  }

  private abs(repoPath: string): string {
    return path.join(this.rootDir, repoPath);
  }

  private toInternal(absolute: string): Resolution {
    if (!isPathInside(this.rootDir, absolute) || inNodeModules(this.rootDir, absolute)) {
      return { kind: "external" };
    }
    return { kind: "internal", path: toPosix(path.relative(this.rootDir, absolute)) };
  }

  /** First alias where spec == find or spec starts with find + "/" (declaration order). */
  private applyAlias(specifier: string): { target: string } | "external" | null {
    for (const alias of this.aliases) {
      if (specifier === alias.find || specifier.startsWith(`${alias.find}/`)) {
        if (alias.replacement === "") {
          return "external";
        }
        return { target: alias.replacement + specifier.slice(alias.find.length) };
      }
    }
    return null;
  }

  private resolveScriptUncached(specifier: string, fromRepoPath: string): Resolution {
    if (specifier.startsWith("virtual:") || specifier.startsWith("\0") || specifier.includes("?")) {
      return { kind: "external" };
    }
    if (ASSET_SPECIFIER.test(specifier)) {
      return { kind: "external" };
    }
    const alias = this.applyAlias(specifier);
    if (alias === "external") {
      return { kind: "external" };
    }
    let target = alias?.target ?? specifier;
    if (target.startsWith("/") && !isPathInside(this.rootDir, target)) {
      target = path.join(this.rootDir, target); // Vite root-relative import
    }
    if (!isBareSpecifier(target)) {
      const lexical = path.resolve(path.dirname(this.abs(fromRepoPath)), target);
      if (!isPathInside(this.rootDir, lexical) || inNodeModules(this.rootDir, lexical)) {
        return { kind: "external" }; // outside the worktree or inside node_modules: never opened
      }
    }
    let resolved: ts.ResolvedModuleFull | undefined;
    try {
      resolved = ts.resolveModuleName(
        target,
        this.abs(fromRepoPath),
        this.compilerOptions,
        this.host.moduleHost,
        this.moduleCache
      ).resolvedModule;
    } catch (error: unknown) {
      this.debug(`resolveModuleName failed for ${specifier}: ${String(error)}`);
      resolved = undefined;
    }
    if (resolved !== undefined) {
      const file = resolved.resolvedFileName;
      if (resolved.isExternalLibraryImport === true || file.includes("/node_modules/")) {
        return { kind: "external" };
      }
      if (/\.d\.[cm]?ts$/.test(file)) {
        return { kind: "external" };
      }
      return this.toInternal(file);
    }
    if (isStyleSpecifier(target)) {
      return this.resolveStyle(specifier, fromRepoPath);
    }
    if (alias === null && isBareSpecifier(specifier) && this.applyTsconfigPaths(specifier) === null) {
      return { kind: "external" };
    }
    return { kind: "unresolved", reason: "cannot resolve" };
  }

  private resolveStyleUncached(rawSpecifier: string, fromRepoPath: string): Resolution {
    if (/^(https?|data):/.test(rawSpecifier)) {
      return { kind: "external" };
    }
    const specifier = rawSpecifier.replace(/[?#].*$/, "");
    const alias = this.applyAlias(specifier);
    if (alias === "external") {
      return { kind: "external" };
    }
    let target: string | null = alias?.target ?? null;
    if (target === null && isBareSpecifier(specifier)) {
      target = this.applyTsconfigPaths(specifier);
    }
    if (target === null && (specifier.startsWith("~") || isBareSpecifier(specifier))) {
      return { kind: "external" };
    }
    let base: string;
    if (target !== null) {
      base = target;
    } else if (specifier.startsWith("/")) {
      base = path.join(this.rootDir, specifier);
    } else {
      base = path.resolve(path.dirname(this.abs(fromRepoPath)), specifier);
    }
    const dir = path.dirname(base);
    const name = path.basename(base);
    const candidates = [
      base,
      `${base}.scss`,
      `${base}.css`,
      path.join(dir, `_${name}.scss`),
      path.join(base, "_index.scss"),
      path.join(base, "index.scss"),
      path.join(base, "index.css")
    ];
    const sourceDir = path.join(this.rootDir, this.sourceRoot);
    for (const candidate of candidates) {
      if (this.host.existsFile(candidate)) {
        if (!isPathInside(sourceDir, candidate)) {
          return { kind: "unresolved", reason: "outside source root" };
        }
        return this.toInternal(candidate);
      }
    }
    return { kind: "unresolved", reason: "stylesheet not found" };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// tsconfig loading (08 §5.9.1)
// ---------------------------------------------------------------------------------------------------------------

interface ParsedConfig {
  options: ts.CompilerOptions;
  raw: unknown;
  errors: readonly ts.Diagnostic[];
}

function parseConfigFile(file: string, host: RestrictedHost): ParsedConfig | null {
  const read = ts.readConfigFile(file, (p) => host.configHost.readFile(p));
  if (read.error !== undefined || read.config === undefined) {
    return null;
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, host.configHost, path.dirname(file), undefined, file);
  return {
    options: parsed.options,
    raw: read.config,
    errors: parsed.errors.filter((diagnostic) => diagnostic.code !== NO_INPUTS_DIAGNOSTIC)
  };
}

function rawArray(raw: unknown, key: string): unknown[] {
  if (typeof raw !== "object" || raw === null) {
    return [];
  }
  const value = (raw as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function stringOption(options: ts.CompilerOptions, key: string): string | null {
  const value = options[key];
  return typeof value === "string" ? value : null;
}

function loadCompilerOptions(
  rootDir: string,
  tsconfigPath: string | null,
  host: RestrictedHost,
  warn: (message: string) => void
): { options: ts.CompilerOptions; pathsBase: string } {
  let options: ts.CompilerOptions = {};
  let pathsBase = rootDir;
  if (tsconfigPath !== null) {
    const file = path.resolve(rootDir, tsconfigPath);
    const warning = `Could not read ${tsconfigPath}; import aliases from it are ignored.`;
    const parsed = isPathInside(rootDir, file) ? parseConfigFile(file, host) : null;
    if (parsed === null) {
      warn(warning);
    } else {
      if (parsed.errors.length > 0) {
        warn(warning);
      }
      options = parsed.options;
      pathsBase = stringOption(options, "pathsBasePath") ?? path.dirname(file);
      if (options.paths === undefined && options.baseUrl === undefined) {
        for (const reference of rawArray(parsed.raw, "references")) {
          const refPath =
            typeof reference === "object" && reference !== null ? (reference as { path?: unknown }).path : undefined;
          if (typeof refPath !== "string") {
            continue;
          }
          let refFile = path.resolve(path.dirname(file), refPath);
          if (!refFile.endsWith(".json")) {
            refFile = path.join(refFile, "tsconfig.json");
          }
          const ref = isPathInside(rootDir, refFile) ? parseConfigFile(refFile, host) : null;
          if (ref === null) {
            continue;
          }
          const includesSrc = rawArray(ref.raw, "include").some(
            (entry) => typeof entry === "string" && entry.replace(/^\.\//, "").startsWith("src")
          );
          if (ref.options.paths !== undefined || ref.options.baseUrl !== undefined || includesSrc) {
            options = { ...options, ...ref.options };
            pathsBase = stringOption(ref.options, "pathsBasePath") ?? path.dirname(refFile);
            break;
          }
        }
      }
    }
  }
  options = {
    ...options,
    allowJs: true,
    jsx: ts.JsxEmit.Preserve,
    resolveJsonModule: true,
    allowImportingTsExtensions: true,
    noEmit: true
  };
  const resolution = options.moduleResolution;
  if (
    resolution !== ts.ModuleResolutionKind.Bundler &&
    resolution !== ts.ModuleResolutionKind.Node16 &&
    resolution !== ts.ModuleResolutionKind.NodeNext
  ) {
    options.moduleResolution = ts.ModuleResolutionKind.Bundler;
    options.module = ts.ModuleKind.ESNext;
  }
  return { options, pathsBase };
}

// ---------------------------------------------------------------------------------------------------------------
// Vite aliases (08 §5.9.2)
// ---------------------------------------------------------------------------------------------------------------

async function findViteConfig(rootDir: string, viteConfigPath: string | null): Promise<string | null> {
  if (viteConfigPath !== null) {
    return viteConfigPath;
  }
  for (const name of VITE_CONFIG_NAMES) {
    if (await pathExists(path.join(rootDir, name))) {
      return name;
    }
  }
  return null;
}

async function normalizeReplacement(rootDir: string, configDir: string, value: string): Promise<string | null> {
  if (path.isAbsolute(value)) {
    if (isPathInside(rootDir, value)) {
      return path.resolve(value);
    }
    if (value.startsWith("/")) {
      const rooted = path.join(rootDir, value);
      if (isPathInside(rootDir, rooted) && (await pathExists(rooted))) {
        return rooted;
      }
    }
    return null;
  }
  if (value.startsWith(".")) {
    const resolved = path.resolve(configDir, value);
    return isPathInside(rootDir, resolved) ? resolved : null;
  }
  return ""; // bare package name → external alias
}

async function loadViteAliases(
  rootDir: string,
  viteConfigPath: string | null,
  warn: (message: string) => void,
  debug: (message: string) => void
): Promise<AliasEntry[]> {
  const relative = await findViteConfig(rootDir, viteConfigPath);
  if (relative === null) {
    debug("no Vite config found");
    return [];
  }
  const text = await readConfinedText(rootDir, relative.replace(/\\/g, "/"));
  if (text === null) {
    debug("Vite config could not be read");
    return [];
  }
  const configAbs = path.join(rootDir, relative);
  const configDir = path.dirname(configAbs);
  const sf = ts.createSourceFile(configAbs, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const evaluator = new StaticEvaluator(sf, configDir, rootDir);
  const config = evaluator.findConfigObject();
  if (config === null) {
    debug("Vite config object not found");
    return [];
  }
  const resolve = propertyNamed(config, "resolve");
  if (resolve === null || !ts.isObjectLiteralExpression(skipParens(resolve))) {
    return [];
  }
  const aliasNode = propertyNamed(skipParens(resolve) as ts.ObjectLiteralExpression, "alias");
  if (aliasNode === null) {
    return [];
  }
  const aliasValue = skipParens(aliasNode);
  const raw: Array<{ find: string; value: ts.Expression | null }> = [];
  const unsupported = (find: string): void => {
    warn(`Vite alias "${find}" could not be read statically; imports using it are ignored.`);
  };
  if (ts.isObjectLiteralExpression(aliasValue)) {
    for (const property of aliasValue.properties) {
      if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
        raw.push({ find: property.name.text, value: property.initializer });
      } else {
        unsupported(property.name?.getText(sf) ?? "...");
      }
    }
  } else if (ts.isArrayLiteralExpression(aliasValue)) {
    for (const element of aliasValue.elements) {
      const item = skipParens(element);
      if (!ts.isObjectLiteralExpression(item)) {
        unsupported(element.getText(sf));
        continue;
      }
      const find = propertyNamed(item, "find");
      const replacement = propertyNamed(item, "replacement");
      if (find === null || !ts.isStringLiteralLike(find)) {
        unsupported(find?.getText(sf) ?? "?");
        continue;
      }
      raw.push({ find: find.text, value: replacement });
    }
  } else {
    unsupported(aliasValue.getText(sf));
    return [];
  }
  const aliases: AliasEntry[] = [];
  for (const entry of raw) {
    const evaluated = entry.value === null ? null : evaluator.evalPath(entry.value);
    const replacement = evaluated === null ? null : await normalizeReplacement(rootDir, configDir, evaluated);
    if (replacement === null) {
      unsupported(entry.find);
      continue;
    }
    aliases.push({ find: entry.find, replacement });
  }
  return aliases;
}
