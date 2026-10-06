/**
 * Inline Vite config construction (10 §5.7): the user's config, loaded with the repo's own `loadConfigFromFile`,
 * is sanitized and merged with PRVision's overrides, and served with `configFile: false` so PRVision controls
 * plugin order (mock plugin first, harness plugin last).
 *
 * PURE: runs inside the Vite host child; no IO except `detectConfigFile`.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  isRecord,
  jsonOrNull,
  type UnknownRecord,
  type ViteHostStartOptions,
  type ViteLoggerLike,
  type ViteModuleLike,
  type VitePluginLike
} from "./render-types";

/** Prefixes of plugin names that are dev-tooling only and harmful or slow in headless rendering. */
export const PLUGIN_DENYLIST_PREFIXES: readonly string[] = [
  "vite-plugin-checker", // spawns tsc/eslint workers, overlays
  "vite:eslint",
  "vite-plugin-eslint",
  "vite-plugin-inspect",
  "vite-plugin-pwa", // service worker registration (service workers are blocked anyway)
  "vite:basic-ssl",
  "vite:mkcert",
  "vite-plugin-mkcert" // https
];

/** Config file names probed in the Vite root when the repository has no stored `viteConfigPath`. */
export const VITE_CONFIG_FILE_NAMES: readonly string[] = [
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs"
];

/** `server.watch`: `null` (no watcher) for Vite ≥ 5.4, an ignore-all watcher for older versions. */
export function resolveWatchOption(major: number, minor: number): null | { ignored: string[] } {
  return major > 5 || (major === 5 && minor >= 4) ? null : { ignored: ["**/*"] };
}

/** React entry points pre-bundled up front (the mount module is virtual, so the scanner does not see them). */
export function reactIncludes(reactDomMajor: number): string[] {
  return reactDomMajor >= 18
    ? ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime"]
    : ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"];
}

/**
 * First existing `vite.config.{ts,mts,cts,js,mjs,cjs}` in `viteRoot`, or null.
 *
 * @param viteRoot - Absolute Vite root.
 * @returns The absolute config file path or null.
 */
export async function detectConfigFile(viteRoot: string): Promise<string | null> {
  for (const name of VITE_CONFIG_FILE_NAMES) {
    const candidate = path.join(viteRoot, name);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next name.
    }
  }
  return null;
}

function isPluginLike(value: unknown): value is VitePluginLike {
  return isRecord(value) && typeof value.name === "string";
}

/**
 * Recursively awaits promises, flattens arrays, drops falsy values and non-plugin objects.
 *
 * @param value - The user's `plugins` value (any nesting of arrays/promises).
 * @returns Flat list of plugin objects.
 */
export async function flattenUserPlugins(value: unknown): Promise<VitePluginLike[]> {
  const resolved: unknown = value instanceof Promise ? await (value as Promise<unknown>) : value;
  if (Array.isArray(resolved)) {
    const nested = await Promise.all(resolved.map((entry: unknown) => flattenUserPlugins(entry)));
    return nested.flat();
  }
  return isPluginLike(resolved) ? [resolved] : [];
}

/**
 * Drops dev-tooling plugins (PLUGIN_DENYLIST_PREFIXES) and build-only plugins (`apply: "build"`).
 *
 * @param plugins - Flattened user plugins.
 * @returns Kept plugins and the names of the dropped ones.
 */
export function filterUserPlugins(plugins: readonly VitePluginLike[]): { kept: VitePluginLike[]; dropped: string[] } {
  const kept: VitePluginLike[] = [];
  const dropped: string[] = [];
  for (const plugin of plugins) {
    const denied = PLUGIN_DENYLIST_PREFIXES.some((prefix) => plugin.name.startsWith(prefix));
    if (denied || plugin.apply === "build") {
      dropped.push(plugin.name);
    } else {
      kept.push(plugin);
    }
  }
  return { kept, dropped };
}

export interface BuildInlineConfigInput {
  vite: Pick<ViteModuleLike, "mergeConfig">;
  viteMajor: number;
  viteMinor: number;
  options: ViteHostStartOptions;
  userConfig: UnknownRecord; // as loaded; {} when no config file
  userConfigFound: boolean;
  userPlugins: VitePluginLike[]; // flattened + filtered
  mockPlugin: VitePluginLike;
  harnessPlugin: VitePluginLike;
  logger: ViteLoggerLike;
  fsAllow: string[];
  envDefines: Record<string, string>;
  reactDomMajor: number;
  port: number; // probed free port (10 §5.6.3 step 7b)
}

const REMOVED_TOP_LEVEL_KEYS = [
  "root",
  "base",
  "cacheDir",
  "configFile",
  "mode",
  "appType",
  "logLevel",
  "customLogger",
  "clearScreen",
  "plugins"
] as const;

const REMOVED_SERVER_KEYS = [
  "proxy",
  "https",
  "open",
  "port",
  "strictPort",
  "host",
  "hmr",
  "watch",
  "warmup",
  "origin",
  "middlewareMode",
  "ws"
] as const;

function asRecord(value: unknown): UnknownRecord {
  return isRecord(value) ? value : {};
}

function describeValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return jsonOrNull(value) ?? Object.prototype.toString.call(value);
}

/**
 * Builds the inline config passed to the repo's `createServer` (10 §5.7.2). Never mutates `input.userConfig`.
 *
 * @param input - Loaded user config, plugins and host options.
 * @returns The merged config and human-readable sanitization warnings.
 */
export function buildViteInlineConfig(input: BuildInlineConfigInput): { config: UnknownRecord; warnings: string[] } {
  const { options } = input;
  const warnings: string[] = [];

  // 1. Shallow-copy and sanitize the user config.
  const sanitized: UnknownRecord = { ...input.userConfig };
  const userRoot = sanitized.root;
  if (userRoot !== undefined && userRoot !== null) {
    const resolvedRoot = typeof userRoot === "string" ? path.resolve(options.viteRoot, userRoot) : null;
    if (resolvedRoot !== path.resolve(options.viteRoot)) {
      warnings.push(
        `Ignoring root: ${describeValue(userRoot)} from the Vite config; PRVision serves from ${options.viteRoot}`
      );
    }
  }
  const userBase = sanitized.base;
  if (userBase !== undefined && userBase !== null && userBase !== "/") {
    warnings.push(`Ignoring base: ${describeValue(userBase)}; the harness is served at /`);
  }
  for (const key of REMOVED_TOP_LEVEL_KEYS) {
    Reflect.deleteProperty(sanitized, key);
  }
  if (isRecord(sanitized.server)) {
    const server: UnknownRecord = { ...sanitized.server };
    if (server.proxy !== undefined && server.proxy !== null) {
      warnings.push("Ignoring server.proxy from the Vite config (network is disabled while rendering).");
    }
    if (server.https !== undefined && server.https !== null && server.https !== false) {
      warnings.push("Ignoring server.https from the Vite config; the harness is served over http://127.0.0.1.");
    }
    for (const key of REMOVED_SERVER_KEYS) {
      Reflect.deleteProperty(server, key);
    }
    sanitized.server = server;
  }
  if (isRecord(sanitized.optimizeDeps)) {
    const optimizeDeps: UnknownRecord = { ...sanitized.optimizeDeps };
    Reflect.deleteProperty(optimizeDeps, "entries");
    Reflect.deleteProperty(optimizeDeps, "force");
    sanitized.optimizeDeps = optimizeDeps;
  }

  // 2. Overrides (merged last, so they win).
  const overrides: UnknownRecord = {
    root: options.viteRoot,
    base: "/",
    mode: "development",
    appType: "mpa", // HTML middleware serves .prvision-harness/index.html (runs transformIndexHtml); no SPA fallback
    cacheDir: options.cacheDir, // isolated per worktree; never the user's node_modules/.vite
    clearScreen: false,
    logLevel: "info",
    customLogger: input.logger,
    server: {
      host: "127.0.0.1",
      port: input.port,
      strictPort: false,
      hmr: false, // also disables @vitejs/plugin-react fast refresh
      open: false,
      cors: false,
      fs: { strict: true, allow: input.fsAllow }, // arrays concatenate with the user's fs.allow
      ...(input.viteMajor >= 5 ? { warmup: { clientFiles: options.warmupFiles } } : {})
    },
    optimizeDeps: {
      include: reactIncludes(input.reactDomMajor), // concatenated with the user's include
      holdUntilCrawlEnd: true
    },
    resolve: { dedupe: ["react", "react-dom"] }, // concatenated with the user's dedupe
    define: input.envDefines, // user's define wins on conflict (keys pre-filtered by the host)
    ...(input.userConfigFound ? {} : { esbuild: { jsx: "automatic" } })
  };

  // The user's define wins on conflict: merge the defines in that order explicitly.
  const userDefine = asRecord(sanitized.define);
  overrides.define = { ...input.envDefines, ...userDefine };

  // 3. The repo's own mergeConfig, so merge semantics match its version.
  const merged = input.vite.mergeConfig(sanitized, overrides);

  // 4. Post-merge assignments (mergeConfig skips null and concatenates arrays).
  merged.configFile = false;
  merged.plugins = [input.mockPlugin, ...input.userPlugins, input.harnessPlugin];
  const mergedServer = asRecord(merged.server);
  mergedServer.watch = resolveWatchOption(input.viteMajor, input.viteMinor);
  merged.server = mergedServer;
  const mergedOptimizeDeps = asRecord(merged.optimizeDeps);
  mergedOptimizeDeps.entries = [...options.optimizeEntries];
  merged.optimizeDeps = mergedOptimizeDeps;

  return { config: merged, warnings };
}
