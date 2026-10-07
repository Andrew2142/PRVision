/**
 * Component inventory (16 §8.3, D11): every component of the app root, "building blocks before screens". Read-only:
 * it never executes repository code and never writes anything, so it is safe on the user's clone (estimates).
 */
import {
  ANALYSIS_MAX_FILE_BYTES,
  ANALYSIS_SOURCE_ROOT,
  LIBRARY_INVENTORY_BUDGET_MS,
  LIBRARY_INVENTORY_MAX_COMPONENTS,
  LIBRARY_INVENTORY_MAX_FILES
} from "../../config-consts";
import type { ComponentInventory, InventoryComponent } from "../../types/harness-library";
import { createLogger } from "../../utilities";
import {
  AngularComponentIndex,
  detectAngularMajor,
  fallbackAngularWorkspaceLayout,
  joinAppPath,
  readAngularWorkspaceLayout
} from "../visualizations/pipeline/angular/angular-component-index";
import { classifySourcePath, readConfinedText } from "../visualizations/pipeline/change-source";
import { ComponentDetector } from "../visualizations/pipeline/component-detector";
import { ImportGraph } from "../visualizations/pipeline/import-graph";
import { ModuleResolver } from "../visualizations/pipeline/module-resolver";
import { LibraryFingerprinter } from "./library-fingerprint";

const log = createLogger("library");
const MAX_LAYER = 50;

export interface InventoryRequest {
  framework: "react_vite" | "angular";
  rootDir: string; // a worktree, or the user's clone for estimates (read-only)
  appRoot: string;
  tsconfigPath: string | null;
  viteConfigPath: string | null;
  angularProject: string | null;
  signal: AbortSignal;
  maxComponents?: number; // default LIBRARY_INVENTORY_MAX_COMPONENTS
  budgetMs?: number; // default LIBRARY_INVENTORY_BUDGET_MS; estimates pass LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS
  withFingerprints?: boolean; // default true; estimates pass false (sourceFingerprint null)
}

/** One node of the ordering (16 §8.3.3). `children` are keys of other nodes (unknown keys are ignored). */
export interface InventoryNode {
  key: string;
  children: readonly string[];
  sourceLines: number;
  filePath: string;
  exportName: string;
}

/** Direct child counts and layers: Tarjan SCCs collapsed, layer 0 = no children, else 1 + max child layer (≤ 50). */
export function computeLayers(nodes: readonly InventoryNode[]): Map<string, { layer: number; childCount: number }> {
  const byKey = new Map(nodes.map((node) => [node.key, node]));
  const childrenOf = (key: string): string[] => [
    ...new Set((byKey.get(key)?.children ?? []).filter((child) => child !== key && byKey.has(child)))
  ];
  // Tarjan (iterative) over the child edges.
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const component = new Map<string, number>();
  const sccs: string[][] = [];
  for (const root of [...byKey.keys()].sort()) {
    if (index.has(root)) {
      continue;
    }
    const work: Array<{ key: string; next: number; children: string[] }> = [];
    const visit = (key: string): void => {
      index.set(key, counter);
      low.set(key, counter);
      counter += 1;
      stack.push(key);
      onStack.add(key);
      work.push({ key, next: 0, children: childrenOf(key) });
    };
    visit(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) {
        break;
      }
      const child = frame.children[frame.next];
      if (child !== undefined) {
        frame.next += 1;
        if (!index.has(child)) {
          visit(child);
        } else if (onStack.has(child)) {
          low.set(frame.key, Math.min(low.get(frame.key) ?? 0, index.get(child) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        low.set(parent.key, Math.min(low.get(parent.key) ?? 0, low.get(frame.key) ?? 0));
      }
      if (low.get(frame.key) === index.get(frame.key)) {
        const members: string[] = [];
        for (;;) {
          const member = stack.pop();
          if (member === undefined) {
            break;
          }
          onStack.delete(member);
          component.set(member, sccs.length);
          members.push(member);
          if (member === frame.key) {
            break;
          }
        }
        sccs.push(members);
      }
    }
  }
  // Tarjan emits SCCs in reverse topological order (children before parents), so one pass suffices.
  const sccLayer: number[] = [];
  sccs.forEach((members, id) => {
    let layer = -1;
    for (const member of members) {
      for (const child of childrenOf(member)) {
        const childScc = component.get(child);
        if (childScc !== undefined && childScc !== id) {
          layer = Math.max(layer, sccLayer[childScc] ?? 0);
        }
      }
    }
    sccLayer[id] = layer < 0 ? 0 : Math.min(MAX_LAYER, layer + 1);
  });
  const out = new Map<string, { layer: number; childCount: number }>();
  for (const key of byKey.keys()) {
    out.set(key, { layer: sccLayer[component.get(key) ?? 0] ?? 0, childCount: childrenOf(key).length });
  }
  return out;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareExportNames(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (a === "default") {
    return -1;
  }
  return b === "default" ? 1 : compareText(a, b);
}

/** Keys ordered "smallest first" (16 §8.3.3): layer, child count, source lines, file path, export name (default first). */
export function orderSmallestFirst(nodes: readonly InventoryNode[]): string[] {
  const layers = computeLayers(nodes);
  return [...nodes]
    .sort((a, b) => {
      const la = layers.get(a.key) ?? { layer: 0, childCount: 0 };
      const lb = layers.get(b.key) ?? { layer: 0, childCount: 0 };
      return (
        la.layer - lb.layer ||
        la.childCount - lb.childCount ||
        a.sourceLines - b.sourceLines ||
        compareText(a.filePath, b.filePath) ||
        compareExportNames(a.exportName, b.exportName)
      );
    })
    .map((node) => node.key);
}

interface CollectedComponent extends InventoryNode {
  displayName: string;
  selector: string | null;
}

interface Collected {
  components: CollectedComponent[];
  truncated: boolean;
  warnings: string[];
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** Lists every component of an app, smallest first, with fingerprints (16 §8.3). */
export class ComponentInventoryService {
  private readonly detector: ComponentDetector;
  private readonly fingerprinter: LibraryFingerprinter;
  private readonly now: () => number;

  constructor(deps: { detector?: ComponentDetector; fingerprinter?: LibraryFingerprinter; now?: () => number } = {}) {
    this.detector = deps.detector ?? new ComponentDetector();
    this.fingerprinter = deps.fingerprinter ?? new LibraryFingerprinter({ detector: this.detector });
    this.now = deps.now ?? ((): number => Date.now());
  }

  /**
   * Inventory of one app.
   *
   * @param request - Framework, folder, app layout, abort signal and limits.
   * @returns The components smallest first, whether the list is incomplete, and warnings.
   */
  async inventory(request: InventoryRequest): Promise<ComponentInventory> {
    const started = this.now();
    const budgetMs = request.budgetMs ?? LIBRARY_INVENTORY_BUDGET_MS;
    const maxComponents = request.maxComponents ?? LIBRARY_INVENTORY_MAX_COMPONENTS;
    const collected =
      request.framework === "angular"
        ? await this.collectAngular(request, budgetMs)
        : await this.collectReact(request, budgetMs);
    const byKey = new Map(collected.components.map((component) => [component.key, component]));
    const layers = computeLayers(collected.components);
    let ordered = orderSmallestFirst(collected.components);
    let truncated = collected.truncated;
    const warnings = [...collected.warnings];
    if (ordered.length > maxComponents) {
      ordered = ordered.slice(0, maxComponents);
      truncated = true;
      warnings.push(
        `More than ${String(maxComponents)} components found; the library covers the first ${String(maxComponents)} (smallest first).`
      );
    }
    const readFile = (repoPath: string): Promise<string | null> => readConfinedText(request.rootDir, repoPath);
    const components: InventoryComponent[] = [];
    for (const key of ordered) {
      request.signal.throwIfAborted();
      const node = byKey.get(key);
      if (node === undefined) {
        continue;
      }
      const identity = { filePath: node.filePath, exportName: node.exportName };
      const sourceFingerprint =
        request.withFingerprints === false
          ? null
          : await this.fingerprinter.fingerprint({ framework: request.framework, identity, readFile });
      const layer = layers.get(key) ?? { layer: 0, childCount: 0 };
      components.push({
        identity,
        displayName: node.displayName,
        selector: node.selector,
        sourceFingerprint,
        childCount: layer.childCount,
        layer: layer.layer,
        sourceLines: node.sourceLines
      });
    }
    log.info(
      {
        event: "library.inventory",
        framework: request.framework,
        components: components.length,
        truncated,
        ms: this.now() - started
      },
      "Component inventory built"
    );
    return { framework: request.framework, components, truncated, warnings };
  }

  private async collectReact(request: InventoryRequest, budgetMs: number): Promise<Collected> {
    const appRoot = request.appRoot === "" ? "." : request.appRoot;
    const sourceRoot = appRoot === "." ? ANALYSIS_SOURCE_ROOT : `${appRoot}/${ANALYSIS_SOURCE_ROOT}`;
    const warnings: string[] = [];
    const resolver = await ModuleResolver.create({
      side: "head",
      rootDir: request.rootDir,
      tsconfigPath: request.tsconfigPath,
      viteConfigPath: request.viteConfigPath,
      sourceRoot,
      warn: (message) => warnings.push(message)
    });
    const graph = await ImportGraph.build({
      side: "head",
      rootDir: request.rootDir,
      sourceRoot,
      resolver,
      detector: this.detector,
      priorityPaths: [],
      maxFiles: LIBRARY_INVENTORY_MAX_FILES,
      budgetMs,
      signal: request.signal,
      now: this.now
    });
    let truncated = false;
    if (graph.truncated) {
      truncated = true;
      warnings.push(
        `The app has ${String(graph.totalFiles)} source files; only the first ${String(LIBRARY_INVENTORY_MAX_FILES)} were read, so the library may miss components.`
      );
    }
    if (graph.budgetExceeded) {
      truncated = true;
      warnings.push(
        `Reading the app took longer than ${String(Math.round(budgetMs / 1000))} s; the library may miss components.`
      );
    }
    const keyOf = (filePath: string, exportName: string): string => `${filePath}\u0000${exportName}`;
    const componentsByFile = new Map<string, string[]>();
    const components: CollectedComponent[] = [];
    for (const filePath of graph.paths()) {
      const classification = classifySourcePath(filePath, { sourceRoot });
      if (classification.role !== "source" || !classification.analysable) {
        continue;
      }
      const exports = graph.exportedComponents(filePath);
      if (exports.length === 0) {
        continue;
      }
      request.signal.throwIfAborted();
      const text = await readConfinedText(request.rootDir, filePath, ANALYSIS_MAX_FILE_BYTES);
      const sf = text === null ? null : this.detector.parse(filePath, text);
      for (const info of exports) {
        const closure = sf === null ? null : this.detector.closureText(sf, info.exportName);
        components.push({
          key: keyOf(filePath, info.exportName),
          filePath,
          exportName: info.exportName,
          displayName: info.displayName,
          selector: null,
          sourceLines: closure === null ? 0 : lineCount(closure),
          children: []
        });
      }
      componentsByFile.set(
        filePath,
        exports.map((info) => keyOf(filePath, info.exportName))
      );
    }
    for (const component of components) {
      const children = new Set<string>();
      for (const edge of graph.importsOf(component.filePath)) {
        if (edge.kind !== "import" && edge.kind !== "reexport" && edge.kind !== "dynamic") {
          continue;
        }
        if (edge.to === component.filePath) {
          continue;
        }
        const targets = componentsByFile.get(edge.to) ?? [];
        if (edge.star || edge.bindings.some((binding) => binding.imported === "*")) {
          targets.forEach((key) => children.add(key));
          continue;
        }
        for (const binding of edge.bindings) {
          const key = keyOf(edge.to, binding.imported);
          if (targets.includes(key)) {
            children.add(key);
          }
        }
      }
      component.children = [...children].sort();
    }
    return { components, truncated, warnings };
  }

  private async collectAngular(request: InventoryRequest, budgetMs: number): Promise<Collected> {
    const appRoot = request.appRoot === "" ? "." : request.appRoot;
    const warnings: string[] = [];
    const layout =
      (await readAngularWorkspaceLayout(request.rootDir, {
        appRoot,
        angularProject: request.angularProject,
        tsconfigPath: request.tsconfigPath
      })) ?? fallbackAngularWorkspaceLayout(appRoot);
    const resolver = await ModuleResolver.create({
      side: "head",
      rootDir: request.rootDir,
      tsconfigPath: request.tsconfigPath ?? joinAppPath(appRoot, "tsconfig.json"),
      viteConfigPath: null,
      sourceRoot: layout.sourceRoot,
      warn: (message) => warnings.push(message)
    });
    const resolveScript = (specifier: string, from: string): string | null => {
      const resolution = resolver.resolveScript(specifier, from);
      return resolution.kind === "internal" ? resolution.path : null;
    };
    const started = this.now();
    const index = await AngularComponentIndex.build({
      side: "head",
      rootDir: request.rootDir,
      sourceRoot: layout.sourceRoot,
      appRoot: layout.appRoot,
      maxFiles: LIBRARY_INVENTORY_MAX_FILES,
      maxFileBytes: ANALYSIS_MAX_FILE_BYTES,
      priorityPaths: [],
      angularMajor: await detectAngularMajor(request.rootDir, appRoot, null),
      signal: request.signal,
      now: this.now,
      resolveScript
    });
    let truncated = false;
    if (index.truncated) {
      truncated = true;
      warnings.push(
        `The app has ${String(index.totalFiles)} source files; only the first ${String(LIBRARY_INVENTORY_MAX_FILES)} were read, so the library may miss components.`
      );
    }
    if (this.now() - started > budgetMs) {
      truncated = true;
      warnings.push(
        `Reading the app took longer than ${String(Math.round(budgetMs / 1000))} s; the library may miss components.`
      );
    }
    const entries = index.components().filter((entry) => {
      const classification = classifySourcePath(entry.filePath, { sourceRoot: layout.sourceRoot });
      return entry.cls.exportName !== null && classification.role === "source" && classification.analysable;
    });
    const keys = new Set(entries.map((entry) => entry.key));
    const children = new Map<string, Set<string>>(entries.map((entry) => [entry.key, new Set<string>()]));
    for (const entry of entries) {
      // Template selector usage: when U uses K, K is a child of U.
      for (const usage of index.usagesOf(entry.key)) {
        if (keys.has(usage.ownerKey) && usage.ownerKey !== entry.key) {
          children.get(usage.ownerKey)?.add(entry.key);
        }
      }
      // Standalone `imports` that resolve to components.
      for (const identifier of entry.cls.imports) {
        const target = index.resolveClassReference(entry.filePath, identifier, resolveScript);
        if (target !== null && keys.has(target) && target !== entry.key) {
          children.get(entry.key)?.add(target);
        }
      }
    }
    const components: CollectedComponent[] = [];
    for (const entry of entries) {
      const text = await readConfinedText(request.rootDir, entry.filePath, ANALYSIS_MAX_FILE_BYTES);
      components.push({
        key: entry.key,
        filePath: entry.filePath,
        exportName: entry.cls.exportName ?? entry.cls.className,
        displayName: entry.cls.className,
        selector: entry.cls.selector,
        sourceLines: text === null ? 0 : lineCount(text.slice(entry.cls.start, entry.cls.end)),
        children: [...(children.get(entry.key) ?? [])].sort()
      });
    }
    return { components, truncated, warnings };
  }
}
