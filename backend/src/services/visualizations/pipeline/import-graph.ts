/**
 * Import graph of one worktree side (08 §5.10–5.11): module summaries, resolved edges, forward/reverse adjacency,
 * affected-parent reverse BFS, forward BFS from the entry file and the export-alias walk used for call sites.
 * Only `ModuleSummary` objects are retained; SourceFiles are dropped after summarizing.
 */
import type { Logger } from "pino";
import { ANALYSIS_MAX_FILE_BYTES } from "../../../config-consts";
import type { ExportInfo, ImportEdge, ModuleSummary, RawImport, Seed, Side } from "../../../types/change-analysis";
import { classifySourcePath, hasGeneratedMarker, readConfined, walkSourceFiles } from "./change-source";
import type { ComponentDetector } from "./component-detector";
import type { ModuleResolver } from "./module-resolver";

export interface ImportGraphBuildOptions {
  side: Side;
  rootDir: string;
  sourceRoot: string;
  resolver: ModuleResolver;
  detector: ComponentDetector;
  priorityPaths: string[]; // changed files (head paths) — used to prioritise when truncating
  maxFiles: number; // ANALYSIS_MAX_PARSED_FILES
  budgetMs: number; // ANALYSIS_GRAPH_BUDGET_MS
  signal: AbortSignal;
  now(): number;
  log?: Logger;
}

export interface AffectedParent {
  path: string;
  exportInfo: ExportInfo;
  depth: number; // 1 = direct importer
  via: string[]; // intermediate module paths, nearest first
  directStyleOwner: boolean; // depth 1, seed is a stylesheet, co-located or CSS module (5.11.2)
}

const STYLE_FILE = /\.(css|scss)$/;
const CSS_MODULE = /\.module\.(css|scss)$/;
const YIELD_EVERY_FILES = 100;
const STYLE_AT_RULE = /@(?:use|forward|import)\s+(?:url\(\s*)?["']([^"']+)["']/g;
const STYLE_COMPOSES = /composes\s*:[^;]*?\bfrom\s+["']([^"']+)["']/g;

function byPath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function lineAt(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
    }
  }
  return line;
}

/** `@use`/`@forward`/`@import` and CSS-module `composes … from` references of a stylesheet (08 §5.10.2 step 3). */
export function scanStyleImports(text: string): RawImport[] {
  const out: Array<{ index: number; raw: RawImport }> = [];
  const lines = text.split("\n");
  const commented = (index: number): boolean => {
    const line = lines[lineAt(text, index) - 1] ?? "";
    return line.trimStart().startsWith("//");
  };
  for (const regex of [STYLE_AT_RULE, STYLE_COMPOSES]) {
    regex.lastIndex = 0;
    for (let match = regex.exec(text); match !== null; match = regex.exec(text)) {
      const specifier = match[1];
      if (specifier === undefined || commented(match.index)) {
        continue;
      }
      out.push({
        index: match.index,
        raw: { specifier, kind: "style", bindings: [], star: true, line: lineAt(text, match.index) }
      });
    }
  }
  return out.sort((a, b) => a.index - b.index).map((entry) => entry.raw);
}

/** True for a CSS module, or a stylesheet whose stem equals the importer's stem in the same directory (5.11.2). */
export function isCoLocatedStyle(stylePath: string, importerPath: string): boolean {
  if (CSS_MODULE.test(stylePath)) {
    return true;
  }
  const dir = (p: string): string => p.slice(0, Math.max(0, p.lastIndexOf("/")));
  const stem = (p: string): string => {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const dot = base.indexOf(".");
    return dot === -1 ? base : base.slice(0, dot);
  };
  return dir(stylePath) === dir(importerPath) && stem(stylePath) === stem(importerPath);
}

// ---------------------------------------------------------------------------------------------------------------
// Name matching through edges (08 §5.10.3)
// ---------------------------------------------------------------------------------------------------------------

/** Does this edge consume any of `names` from its target? */
export function edgeUsesNames(edge: ImportEdge, names: Set<string> | "*"): boolean {
  if (names === "*") {
    return true;
  }
  if (edge.kind === "reexport" && edge.star) {
    return [...names].some((n) => n !== "default");
  }
  if (edge.star) {
    return true;
  }
  return edge.bindings.some((b) => names.has(b.imported));
}

/** Local names in the importer that hold the consumed values. */
export function localBindingsFor(edge: ImportEdge, names: Set<string> | "*"): string[] | "*" {
  if (edge.kind === "side_effect" || edge.kind === "dynamic") {
    return "*";
  }
  if (edge.kind === "style" && edge.bindings.length === 0) {
    return "*";
  }
  return edge.bindings.filter((b) => names === "*" || b.imported === "*" || names.has(b.imported)).map((b) => b.local);
}

/** Names that the importer re-exposes after consuming `names` (for non-component intermediates). */
export function namesExposedBy(
  importer: ModuleSummary,
  edge: ImportEdge,
  names: Set<string> | "*"
): Set<string> | "*" | null {
  if (importer.language === "style") {
    return "*";
  }
  if (edge.kind === "reexport") {
    if (edge.star && edge.bindings.length === 0) {
      return names === "*" ? "*" : new Set([...names].filter((n) => n !== "default"));
    }
    const out = edge.bindings
      .filter((b) => names === "*" || b.imported === "*" || names.has(b.imported))
      .map((b) => b.local);
    return out.length > 0 ? new Set(out) : null;
  }
  const locals = localBindingsFor(edge, names);
  if (locals === "*") {
    return "*";
  }
  const exposed = importer.exports
    .filter((e) => !e.typeOnly && e.closureNames.some((n) => locals.includes(n)))
    .map((e) => e.exportName);
  return exposed.length > 0 ? new Set(exposed) : null;
}

function compareExports(a: ExportInfo, b: ExportInfo): number {
  if (a.exportName === b.exportName) {
    return 0;
  }
  if (a.exportName === "default") {
    return -1;
  }
  if (b.exportName === "default") {
    return 1;
  }
  return byPath(a.exportName, b.exportName);
}

/** Exported components of `importer` that use the consumed bindings ("default" first, then exportName). */
export function affectedComponents(importer: ModuleSummary, edge: ImportEdge, names: Set<string> | "*"): ExportInfo[] {
  const comps = importer.exports.filter((e) => e.isComponent).sort(compareExports);
  const locals = localBindingsFor(edge, names);
  if (locals === "*") {
    return comps;
  }
  return comps.filter((c) => c.closureNames.some((n) => locals.includes(n)));
}

// ---------------------------------------------------------------------------------------------------------------
// ImportGraph
// ---------------------------------------------------------------------------------------------------------------

function sharedPrefixSegments(a: string, b: string): number {
  const left = a.split("/").slice(0, -1);
  const right = b.split("/").slice(0, -1);
  let count = 0;
  while (count < left.length && count < right.length && left[count] === right[count]) {
    count++;
  }
  return count;
}

/** Keeps priority paths and the files nearest to them (08 §5.10.1). */
export function truncateFiles(files: readonly string[], priorityPaths: readonly string[], maxFiles: number): string[] {
  if (files.length <= maxFiles) {
    return [...files];
  }
  const present = new Set(files);
  const priority = [...new Set(priorityPaths)].filter((p) => present.has(p)).sort(byPath);
  const prioritySet = new Set(priority);
  const scored = files
    .filter((file) => !prioritySet.has(file))
    .map((file) => ({
      file,
      score: priority.reduce((best, p) => Math.max(best, sharedPrefixSegments(file, p)), 0)
    }))
    .sort((a, b) => b.score - a.score || byPath(a.file, b.file));
  const keep = scored.slice(0, Math.max(0, maxFiles - priority.length)).map((entry) => entry.file);
  return [...priority, ...keep].sort(byPath);
}

async function yieldToLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Module graph of one side (08 §5.10). Build with `ImportGraph.build`. */
export class ImportGraph {
  private readonly modules = new Map<string, ModuleSummary>();
  private readonly forward = new Map<string, ImportEdge[]>();
  private readonly reverse = new Map<string, ImportEdge[]>();

  private constructor(
    readonly side: Side,
    readonly truncated: boolean,
    readonly totalFiles: number,
    private budgetHit: boolean,
    private readonly statsValue: {
      files: number;
      parsed: number;
      edges: number;
      unresolved: number;
      durationMs: number;
    }
  ) {}

  get budgetExceeded(): boolean {
    return this.budgetHit;
  }

  get stats(): { files: number; parsed: number; edges: number; unresolved: number; durationMs: number } {
    return { ...this.statsValue };
  }

  /** Walks `<rootDir>/<sourceRoot>`, summarizes every graph file and resolves its imports (budgeted). */
  static async build(options: ImportGraphBuildOptions): Promise<ImportGraph> {
    const start = options.now();
    const all = (await walkSourceFiles(options.rootDir, options.sourceRoot, options.signal)).filter(
      (file) => classifySourcePath(file, { sourceRoot: options.sourceRoot }).inGraph
    );
    const files = truncateFiles(all, options.priorityPaths, options.maxFiles);
    const graph = new ImportGraph(options.side, files.length < all.length, all.length, false, {
      files: 0,
      parsed: 0,
      edges: 0,
      unresolved: 0,
      durationMs: 0
    });
    /** Every 100 files: yield, honour the signal, check the soft budget. False = stop (budget exceeded). */
    const checkpoint = async (index: number): Promise<boolean> => {
      if (index === 0 || index % YIELD_EVERY_FILES !== 0) {
        return true;
      }
      await yieldToLoop();
      options.signal.throwIfAborted();
      if (!graph.budgetHit && options.now() - start > options.budgetMs) {
        graph.budgetHit = true;
        return false;
      }
      return true;
    };

    for (const [index, file] of files.entries()) {
      if (!(await checkpoint(index))) {
        break;
      }
      graph.modules.set(file, await summarizeFile(options, file));
    }

    let index = 0;
    for (const summary of graph.modules.values()) {
      if (!(await checkpoint(index))) {
        break; // budget hit while resolving: keep what was built
      }
      index++;
      graph.addEdgesOf(summary, options);
    }
    for (const list of graph.reverse.values()) {
      list.sort((a, b) => byPath(a.from, b.from) || a.line - b.line);
    }
    graph.statsValue.files = graph.modules.size;
    graph.statsValue.parsed = [...graph.modules.values()].filter((m) => m.parsed).length;
    graph.statsValue.durationMs = options.now() - start;
    return graph;
  }

  has(path: string): boolean {
    return this.modules.has(path);
  }

  module(path: string): ModuleSummary | undefined {
    return this.modules.get(path);
  }

  /** All module paths, sorted. */
  paths(): string[] {
    return [...this.modules.keys()].sort(byPath);
  }

  importsOf(path: string): readonly ImportEdge[] {
    return this.forward.get(path) ?? [];
  }

  importersOf(path: string): readonly ImportEdge[] {
    return this.reverse.get(path) ?? [];
  }

  exportedComponents(path: string): readonly ExportInfo[] {
    return (this.modules.get(path)?.exports ?? []).filter((e) => e.isComponent).sort(compareExports);
  }

  /** Nearest exported components that consume the seed's changed names (08 §5.11.1). */
  findAffectedParents(
    seed: Seed,
    opts: { maxDepth: number; maxParents: number; isAlreadyCovered(path: string, exportName: string): boolean }
  ): AffectedParent[] {
    const found: AffectedParent[] = [];
    let counted = 0;
    const seedIsStyle = STYLE_FILE.test(seed.path);
    const visited = new Set<string>([seed.path]);
    const queue: Array<{ path: string; depth: number; names: Set<string> | "*"; via: string[] }> = [
      { path: seed.path, depth: 0, names: seed.names, via: [] }
    ];
    while (queue.length > 0 && counted < opts.maxParents) {
      const cur = queue.shift();
      if (cur === undefined || cur.depth >= opts.maxDepth) {
        continue;
      }
      for (const edge of this.importersOf(cur.path)) {
        const imp = this.modules.get(edge.from);
        if (imp === undefined || visited.has(edge.from)) {
          continue;
        }
        if (!edgeUsesNames(edge, cur.names)) {
          continue;
        }
        visited.add(edge.from);
        if (imp.role === "test" || imp.role === "story") {
          continue;
        }
        const comps = affectedComponents(imp, edge, cur.names);
        if (comps.length > 0) {
          for (const c of comps) {
            const styleOwner = seedIsStyle && cur.depth === 0 && isCoLocatedStyle(seed.path, edge.from);
            if (!styleOwner && counted >= opts.maxParents) {
              break;
            }
            found.push({
              path: edge.from,
              exportInfo: c,
              depth: cur.depth + 1,
              via: cur.via,
              directStyleOwner: styleOwner
            });
            if (!styleOwner && !opts.isAlreadyCovered(edge.from, c.exportName)) {
              counted += 1;
            }
          }
          continue;
        }
        const next = namesExposedBy(imp, edge, cur.names);
        if (next !== null) {
          queue.push({ path: edge.from, depth: cur.depth + 1, names: next, via: [...cur.via, edge.from] });
        }
      }
    }
    return found;
  }

  /** Forward BFS from the entry over import/reexport/dynamic edges collecting exported components (08 §5.11.3). */
  componentsFromEntry(
    entryPath: string,
    opts: { maxDepth: number; limit: number }
  ): Array<{ path: string; exportInfo: ExportInfo; depth: number }> {
    const out: Array<{ path: string; exportInfo: ExportInfo; depth: number }> = [];
    if (!this.modules.has(entryPath)) {
      return out;
    }
    const visited = new Set<string>([entryPath]);
    let level = [entryPath];
    for (let depth = 0; depth <= opts.maxDepth && level.length > 0; depth++) {
      for (const path of level) {
        for (const exportInfo of this.exportedComponents(path)) {
          if (out.length >= opts.limit) {
            return out;
          }
          out.push({ path, exportInfo, depth });
        }
      }
      const next = new Set<string>();
      for (const path of level) {
        for (const edge of this.importsOf(path)) {
          if (
            (edge.kind === "import" || edge.kind === "reexport" || edge.kind === "dynamic") &&
            !visited.has(edge.to)
          ) {
            visited.add(edge.to);
            next.add(edge.to);
          }
        }
      }
      level = [...next].sort(byPath);
    }
    return out;
  }

  /** (module, exportName) pairs under which an export is reachable through barrels (08 §5.14.2 step 2). */
  exportAliases(path: string, exportName: string, maxHops: number): Array<{ path: string; exportName: string }> {
    const out = [{ path, exportName }];
    const seen = new Set([`${path}\0${exportName}`]);
    let level = out.slice();
    for (let hop = 0; hop < maxHops && level.length > 0; hop++) {
      const next: Array<{ path: string; exportName: string }> = [];
      for (const current of level) {
        for (const edge of this.importersOf(current.path)) {
          if (edge.kind !== "reexport") {
            continue;
          }
          const names: string[] = [];
          if (edge.star && edge.bindings.length === 0) {
            if (current.exportName !== "default") {
              names.push(current.exportName);
            }
          } else {
            for (const binding of edge.bindings) {
              if (binding.imported === current.exportName) {
                names.push(binding.local);
              }
            }
          }
          for (const name of names) {
            const key = `${edge.from}\0${name}`;
            if (!seen.has(key)) {
              seen.add(key);
              const alias = { path: edge.from, exportName: name };
              out.push(alias);
              next.push(alias);
            }
          }
        }
      }
      level = next;
    }
    return out;
  }

  private addEdgesOf(summary: ModuleSummary, options: ImportGraphBuildOptions): void {
    for (const raw of summary.imports) {
      const resolution =
        raw.kind === "style"
          ? options.resolver.resolveStyle(raw.specifier, summary.path)
          : options.resolver.resolveScript(raw.specifier, summary.path);
      if (resolution.kind === "unresolved") {
        this.statsValue.unresolved++;
        options.log?.debug(
          {
            event: "change_analysis.import.unresolved",
            side: options.side,
            from: summary.path,
            reason: resolution.reason
          },
          "Import specifier could not be resolved"
        );
        continue;
      }
      if (resolution.kind !== "internal" || resolution.path === summary.path || !this.modules.has(resolution.path)) {
        continue;
      }
      const edge: ImportEdge = {
        from: summary.path,
        to: resolution.path,
        kind: raw.kind,
        bindings: raw.bindings,
        star: raw.star,
        specifier: raw.specifier,
        line: raw.line
      };
      const forward = this.forward.get(summary.path);
      if (forward === undefined) {
        this.forward.set(summary.path, [edge]);
      } else {
        forward.push(edge);
      }
      const reverse = this.reverse.get(resolution.path);
      if (reverse === undefined) {
        this.reverse.set(resolution.path, [edge]);
      } else {
        reverse.push(edge);
      }
      this.statsValue.edges++;
    }
  }
}

async function summarizeFile(options: ImportGraphBuildOptions, file: string): Promise<ModuleSummary> {
  const classification = classifySourcePath(file, { sourceRoot: options.sourceRoot });
  const language = classification.language ?? "script";
  const empty = (sizeBytes: number): ModuleSummary => ({
    path: file,
    side: options.side,
    language,
    role: classification.role,
    sizeBytes,
    parsed: false,
    syntaxErrors: 0,
    imports: [],
    exports: []
  });
  const read = await readConfined(options.rootDir, file, ANALYSIS_MAX_FILE_BYTES);
  if (read.kind !== "ok") {
    return empty(read.kind === "too_large" || read.kind === "binary" ? read.sizeBytes : 0);
  }
  const role = hasGeneratedMarker(read.text) ? "generated" : classification.role;
  if (language === "style") {
    return { ...empty(read.sizeBytes), role, parsed: true, imports: scanStyleImports(read.text) };
  }
  const sf = options.detector.parse(file, read.text, { parents: false });
  return options.detector.summarize(sf, { path: file, side: options.side, role, sizeBytes: read.sizeBytes });
}
