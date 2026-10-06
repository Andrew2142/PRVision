/**
 * PRVision's Vite mock plugin (10 §5.8): replaces the modules named by a render group's accepted mocks with
 * virtual modules compiled from the AI-written mock source.
 *
 * Semantics (10 §5.8.1, adopted by 09): while rendering a component, the module a mock `specifier` refers to is
 * replaced everywhere in the page's module graph except inside other mocks and inside pre-bundled dependencies.
 * Matching is by exact specifier and, for repository files, by Vite's own resolved path (10 §5.8.4).
 *
 * PURE: no DB, env, logger or config imports. Runs inside the Vite host child; unit tested in the parent.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type {
  MockEntryInput,
  VitePluginContextLike,
  VitePluginLike,
  ViteResolvedIdLike,
  ViteResolveIdOptions
} from "./render/render-types";
import {
  classifySpecifier,
  packageNameOf,
  STYLE_OR_ASSET_EXTENSIONS,
  validateMockedModules,
  type SpecifierKind
} from "./mock-rules";

export * from "./mock-rules";

export const MOCK_VIRTUAL_PREFIX = "\0prvision-mock:";

/** sha256(`${componentFile}\n${specifier}\n${source}`) hex, first 16 chars. */
export function mockHash(componentFile: string, specifier: string, source: string): string {
  return createHash("sha256").update(`${componentFile}\n${specifier}\n${source}`).digest("hex").slice(0, 16);
}

/** MOCK_VIRTUAL_PREFIX + hash. */
export function mockVirtualId(hash: string): string {
  return `${MOCK_VIRTUAL_PREFIX}${hash}`;
}

export interface MockPluginOptions {
  viteRoot: string;
  cacheDir: string;
  harnessDir: string;
  entries: readonly MockEntryInput[];
  transpile: (code: string, filename: string) => Promise<string>; // wraps vite.transformWithEsbuild / transformWithOxc
  isInstalledPackage: (packageName: string) => boolean; // node_modules/<name>/package.json exists from viteRoot
  warn: (message: string) => void; // forwarded as a "[prvision-mock]" warn log
}

type MockTarget =
  | { kind: "package" } // exact-specifier match only
  | { kind: "source"; file: string } // match by resolved file path
  | { kind: "unresolved" }; // module does not exist; exact-specifier match only

interface MockRegistryEntry {
  hash: string;
  virtualId: string; // "\0prvision-mock:<hash>"
  componentId: number;
  componentFile: string;
  specifier: string;
  specifierKind: SpecifierKind;
  packageName: string | null; // set when bare and isInstalledPackage(packageNameOf(specifier))
  source: string;
  target: Promise<MockTarget> | null; // lazily resolved on first resolveId call
  compiled: Promise<string> | null; // lazily transpiled on first load
  disabled: boolean; // targets the component under test itself
}

const INELIGIBLE_PREFIXES = ["\0", "virtual:", "/@", "data:", "http:", "https:"];

/** Strips `?query` and `#hash` from a module id. */
export function cleanUrl(id: string): string {
  const cut = id.search(/[?#]/);
  return cut === -1 ? id : id.slice(0, cut);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasStyleOrAssetExtension(source: string): boolean {
  const ext = path.posix.extname(cleanUrl(source)).toLowerCase();
  return ext !== "" && STYLE_OR_ASSET_EXTENSIONS.includes(ext);
}

/** Relative-specifier normalization used to de-duplicate entries shared by the components of one group. */
function matchKey(componentFile: string, specifier: string): string {
  if (classifySpecifier(specifier) !== "relative") {
    return `spec:${specifier}`;
  }
  return `rel:${path.posix.normalize(path.posix.join(path.posix.dirname(componentFile), specifier))}`;
}

function buildRegistry(options: MockPluginOptions): MockRegistryEntry[] {
  const registry: MockRegistryEntry[] = [];
  const seen = new Set<string>();
  const byComponent = new Map<number, MockEntryInput[]>();
  for (const entry of options.entries) {
    const list = byComponent.get(entry.componentId) ?? [];
    list.push(entry);
    byComponent.set(entry.componentId, list);
  }
  for (const [componentId, entries] of byComponent) {
    const componentFile = entries[0]?.componentFile ?? "";
    const { accepted, rejected } = validateMockedModules(
      entries.map((entry) => ({ specifier: entry.specifier, source: entry.source }))
    );
    for (const rejection of rejected) {
      options.warn(
        `Mock "${rejection.specifier}" for component ${String(componentId)} was ignored: ${rejection.reason}.`
      );
    }
    for (const mock of accepted) {
      const key = `${matchKey(componentFile, mock.specifier)}\u0000${mock.source}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const specifierKind = classifySpecifier(mock.specifier);
      const pkg = specifierKind === "bare" ? packageNameOf(mock.specifier) : null;
      const hash = mockHash(componentFile, mock.specifier, mock.source);
      registry.push({
        hash,
        virtualId: mockVirtualId(hash),
        componentId,
        componentFile,
        specifier: mock.specifier,
        specifierKind,
        packageName: pkg !== null && options.isInstalledPackage(pkg) ? pkg : null,
        source: mock.source,
        target: null,
        compiled: null,
        disabled: false
      });
    }
  }
  return registry;
}

/**
 * Creates the `prvision:mock` plugin. An empty `entries` list yields hooks that return null immediately (the
 * plugin stays installed so plugin names, and therefore the optimizer hash, are identical across groups).
 *
 * @param options - Group mocks, transpiler and package probe.
 * @returns A Vite plugin object (`enforce: "pre"`).
 */
export function createMockPlugin(options: MockPluginOptions): VitePluginLike {
  const registry = buildRegistry(options);
  const byVirtualId = new Map(registry.map((entry) => [entry.virtualId, entry] as const));
  const bySpecifier = new Map<string, MockRegistryEntry[]>();
  for (const entry of registry) {
    const list = bySpecifier.get(entry.specifier) ?? [];
    list.push(entry);
    bySpecifier.set(entry.specifier, list);
  }
  const memo = new Map<string, Promise<ViteResolvedIdLike | null>>();
  const installedCache = new Map<string, boolean>();
  const cacheDir = path.resolve(options.cacheDir);

  const isInstalled = (pkg: string): boolean => {
    let cached = installedCache.get(pkg);
    if (cached === undefined) {
      cached = options.isInstalledPackage(pkg);
      installedCache.set(pkg, cached);
    }
    return cached;
  };

  const resolveTarget = async (context: VitePluginContextLike, entry: MockRegistryEntry): Promise<MockTarget> => {
    if (entry.packageName !== null) {
      return { kind: "package" };
    }
    const resolved = await context.resolve(entry.specifier, entry.componentFile, { skipSelf: true });
    if (resolved === null || (resolved.external !== undefined && resolved.external !== false)) {
      return { kind: "unresolved" };
    }
    const file = cleanUrl(resolved.id);
    if (file.includes("/node_modules/") || file.startsWith(cacheDir)) {
      return { kind: "package" };
    }
    if (file === entry.componentFile) {
      entry.disabled = true;
      options.warn(`Mock for "${entry.specifier}" targets the component under test itself and was ignored`);
    }
    return { kind: "source", file };
  };

  const targetOf = (context: VitePluginContextLike, entry: MockRegistryEntry): Promise<MockTarget> => {
    entry.target ??= resolveTarget(context, entry);
    return entry.target;
  };

  const isEligibleForPathMatch = (source: string): boolean => {
    if (INELIGIBLE_PREFIXES.some((prefix) => source.startsWith(prefix))) {
      return false;
    }
    if (source.includes("?") || hasStyleOrAssetExtension(source)) {
      return false;
    }
    if (classifySpecifier(source) === "bare") {
      const pkg = packageNameOf(source);
      if (pkg !== null && isInstalled(pkg)) {
        return false;
      }
    }
    return true;
  };

  async function resolveId(
    this: VitePluginContextLike,
    source: string,
    importer: string | undefined,
    resolveOptions: ViteResolveIdOptions
  ): Promise<string | ViteResolvedIdLike | null> {
    if (registry.length === 0) {
      return null;
    }
    // 1. Already a mock id.
    if (source.startsWith(MOCK_VIRTUAL_PREFIX)) {
      return source;
    }
    // 2. Entry points are never mocked.
    if (importer === undefined) {
      return null;
    }
    // 3. Imports made by a mock are never mocked; relative ones resolve against the component file.
    if (importer.startsWith(MOCK_VIRTUAL_PREFIX)) {
      const owner = byVirtualId.get(cleanUrl(importer));
      if (owner !== undefined && classifySpecifier(source) === "relative") {
        return this.resolve(source, owner.componentFile, { skipSelf: true });
      }
      return null;
    }
    const candidates = bySpecifier.get(source) ?? [];
    // 4. Dependency scan: only modules that exist solely as a mock.
    if (resolveOptions.scan === true) {
      for (const entry of candidates) {
        const target = await targetOf(this, entry);
        if (!entry.disabled && target.kind === "unresolved") {
          return entry.virtualId;
        }
      }
      return null;
    }
    const importerFile = cleanUrl(importer);
    // 5. Importer inside node_modules or the cache dir: package mocks only.
    if (importerFile.includes("/node_modules/") || importerFile.startsWith(cacheDir)) {
      for (const entry of candidates) {
        const target = await targetOf(this, entry);
        if (!entry.disabled && target.kind === "package") {
          return entry.virtualId;
        }
      }
      return null;
    }
    // 6. User or harness importer. Resolve every target first (memoized) so path matching knows the files.
    const targets = await Promise.all(registry.map((entry) => targetOf(this, entry)));
    // 6.1 Exact specifier match (any target for bare/absolute entries; relative entries only from the component file).
    for (const entry of candidates) {
      if (entry.disabled) {
        continue;
      }
      if (entry.specifierKind !== "relative" || importerFile === entry.componentFile) {
        return entry.virtualId;
      }
    }
    // 6.2 Resolved-path match.
    const fileTargets = new Map<string, MockRegistryEntry>();
    registry.forEach((entry, index) => {
      const target = targets[index];
      if (!entry.disabled && target?.kind === "source" && !fileTargets.has(target.file)) {
        fileTargets.set(target.file, entry);
      }
    });
    if (fileTargets.size === 0 || !isEligibleForPathMatch(source)) {
      return null;
    }
    const key = `${path.posix.dirname(importerFile)}\u0000${source}`;
    let pending = memo.get(key);
    if (pending === undefined) {
      pending = this.resolve(source, importer, {
        skipSelf: true,
        isEntry: resolveOptions.isEntry,
        custom: resolveOptions.custom,
        ssr: resolveOptions.ssr
      });
      memo.set(key, pending);
    }
    const resolved = await pending;
    if (resolved === null) {
      return null;
    }
    const matched = fileTargets.get(cleanUrl(resolved.id));
    return matched === undefined ? resolved : matched.virtualId;
  }

  async function load(id: string): Promise<{ code: string; map: null } | null> {
    if (!id.startsWith(MOCK_VIRTUAL_PREFIX)) {
      return null;
    }
    const entry = byVirtualId.get(id);
    if (entry === undefined) {
      throw new Error(`Unknown PRVision mock module ${id.slice(1)}`);
    }
    entry.compiled ??= options
      .transpile(entry.source, path.join(options.harnessDir, "mocks", `${entry.hash}.tsx`))
      .catch((error: unknown) => {
        entry.compiled = null; // allow a later retry to surface the same error again
        throw new Error(
          `Mock for "${entry.specifier}" (component ${String(entry.componentId)}) failed to compile: ${describe(error)}`
        );
      });
    return { code: await entry.compiled, map: null };
  }

  return {
    name: "prvision:mock",
    enforce: "pre",
    resolveId,
    load
  };
}
