/**
 * In-memory ComponentSourceQueries (08 §5.1.1) for sheet 09 tests. Resolution follows the real contract closely
 * enough for the validator and context builder: relative specifiers resolve from the importer's folder against the
 * declared files of that side, `@/` maps to `src/`, root-relative `/x` to `x`, and bare specifiers resolve to
 * `package:<name>` when the package is declared installed. Every call is recorded.
 */
import path from "node:path";
import { packageNameOf } from "../../../../backend/src/services/visualizations/pipeline/mock-rules";
import type {
  CallSite,
  ChangedDependency,
  ComponentSourceQueries,
  DirectImport,
  TypeSourceResult,
  WorktreeSide
} from "../../../../backend/src/types/visualization-pipeline";

type PerSide<T> = Record<WorktreeSide, T>;
type Keyed<T> = Record<string, T>; // key `${side}:${filePath}`

export interface FakeSourceQueriesOptions {
  /** Repo files existing on each side (componentPaths and relative/alias resolution). */
  files?: Partial<PerSide<string[]>>;
  /** Installed packages on each side (default for both: react, react-dom, react-router-dom, @tanstack/react-query, clsx). */
  packages?: Partial<PerSide<string[]>>;
  /** Alias prefix → repo folder (default `{ "@/": "src/" }`). */
  aliases?: Record<string, string>;
  /** Explicit componentPaths results (default: existence of the path on each side). */
  componentPaths?: Record<string, { base: string | null; head: string | null }>;
  directImports?: Partial<PerSide<Record<string, DirectImport[]>>>;
  moduleExports?: Partial<PerSide<Record<string, string[]>>>;
  typeSources?: Keyed<Omit<TypeSourceResult, "filePath" | "exportName" | "side">>;
  callSites?: Keyed<CallSite[]>;
  changedDependencies?: Keyed<ChangedDependency[]>;
}

const DEFAULT_PACKAGES = ["react", "react-dom", "react-router-dom", "@tanstack/react-query", "clsx"];
const EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"];

/** A DirectImport with defaults (relative, no bindings). */
export function directImport(overrides: Partial<DirectImport> & Pick<DirectImport, "specifier">): DirectImport {
  return {
    line: 1,
    kind: "relative",
    resolvedPath: null,
    defaultImport: false,
    namespaceImport: false,
    namedImports: [],
    typeOnly: false,
    sideEffectOnly: false,
    reexport: false,
    dynamic: false,
    ...overrides
  };
}

export class FakeSourceQueries implements ComponentSourceQueries {
  readonly calls: Array<{ method: keyof ComponentSourceQueries; args: unknown[] }> = [];
  private readonly files: PerSide<Set<string>>;
  private readonly packages: PerSide<Set<string>>;
  private readonly aliases: Record<string, string>;

  constructor(private readonly options: FakeSourceQueriesOptions = {}) {
    this.files = { base: new Set(options.files?.base ?? []), head: new Set(options.files?.head ?? []) };
    this.packages = {
      base: new Set(options.packages?.base ?? DEFAULT_PACKAGES),
      head: new Set(options.packages?.head ?? DEFAULT_PACKAGES)
    };
    this.aliases = options.aliases ?? { "@/": "src/" };
  }

  /** Adds files after construction (e.g. from temp worktrees). */
  addFiles(side: WorktreeSide, files: readonly string[]): void {
    files.forEach((file) => this.files[side].add(file));
  }

  callsTo(method: keyof ComponentSourceQueries): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  componentPaths(filePath: string): Promise<{ base: string | null; head: string | null }> {
    this.calls.push({ method: "componentPaths", args: [filePath] });
    return Promise.resolve(
      this.options.componentPaths?.[filePath] ?? {
        base: this.files.base.has(filePath) ? filePath : null,
        head: this.files.head.has(filePath) ? filePath : null
      }
    );
  }

  resolveTypeSources(filePath: string, exportName: string, side: WorktreeSide): Promise<TypeSourceResult> {
    this.calls.push({ method: "resolveTypeSources", args: [filePath, exportName, side] });
    const found = this.options.typeSources?.[`${side}:${filePath}`];
    return Promise.resolve(
      found
        ? { filePath, exportName, side, ...found }
        : {
            filePath,
            exportName,
            side,
            found: false,
            propsTypeName: null,
            parameterText: null,
            sources: [],
            unresolved: [],
            truncated: false
          }
    );
  }

  findCallSites(filePath: string, exportName: string, side: WorktreeSide, limit: number): Promise<CallSite[]> {
    this.calls.push({ method: "findCallSites", args: [filePath, exportName, side, limit] });
    return Promise.resolve((this.options.callSites?.[`${side}:${filePath}`] ?? []).slice(0, limit));
  }

  getDirectImports(filePath: string, side: WorktreeSide): Promise<DirectImport[]> {
    this.calls.push({ method: "getDirectImports", args: [filePath, side] });
    return Promise.resolve(this.options.directImports?.[side]?.[filePath] ?? []);
  }

  getModuleExports(filePath: string, side: WorktreeSide): Promise<string[] | null> {
    this.calls.push({ method: "getModuleExports", args: [filePath, side] });
    return Promise.resolve(this.options.moduleExports?.[side]?.[filePath] ?? null);
  }

  resolveSpecifier(fromFilePath: string, specifier: string, side: WorktreeSide): Promise<string | null> {
    this.calls.push({ method: "resolveSpecifier", args: [fromFilePath, specifier, side] });
    return Promise.resolve(this.resolveSync(fromFilePath, specifier, side));
  }

  changedDependenciesOf(filePath: string, side: WorktreeSide, maxDepth: number): Promise<ChangedDependency[]> {
    this.calls.push({ method: "changedDependenciesOf", args: [filePath, side, maxDepth] });
    return Promise.resolve(
      (this.options.changedDependencies?.[`${side}:${filePath}`] ?? []).filter((d) => d.depth <= maxDepth)
    );
  }

  private resolveSync(fromFilePath: string, specifier: string, side: WorktreeSide): string | null {
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      return this.findFile(side, path.posix.normalize(path.posix.join(path.posix.dirname(fromFilePath), specifier)));
    }
    if (specifier.startsWith("/")) {
      return this.findFile(side, specifier.slice(1));
    }
    for (const [prefix, folder] of Object.entries(this.aliases)) {
      if (specifier.startsWith(prefix)) {
        return this.findFile(side, `${folder}${specifier.slice(prefix.length)}`);
      }
    }
    const name = packageNameOf(specifier);
    return name !== null && this.packages[side].has(name) ? `package:${name}` : null;
  }

  private findFile(side: WorktreeSide, base: string): string | null {
    const candidates = [
      ...EXTENSIONS.map((ext) => `${base}${ext}`),
      ...EXTENSIONS.map((ext) => `${base}/index${ext}`),
      base
    ];
    return candidates.find((candidate) => this.files[side].has(candidate)) ?? null;
  }
}
