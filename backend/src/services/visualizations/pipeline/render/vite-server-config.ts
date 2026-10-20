/**
 * Inline Vite config construction (10 §5.7): the user's config, loaded with the repo's own `loadConfigFromFile`,
 * is sanitized and merged with PRVision's overrides, and served with `configFile: false` so PRVision controls
 * plugin order (mock plugin first, harness plugin last).
 *
 * PURE: runs inside the Vite host child; no IO except `detectConfigFile` and `detectViteMode`.
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

/** Vite's own default mode for `vite` / `vite serve`. */
export const DEFAULT_VITE_MODE = "development";

/** package.json scripts that start the dev server, in the order they are trusted. */
const DEV_SCRIPT_NAMES = ["dev", "start", "serve"] as const;

/**
 * The `--mode` a repository's dev server runs with, read from its package.json scripts (`dev`, then `start`, then
 * `serve`): the first command segment that runs `vite` (not `vitest`, `vite build` or `vite preview`) and passes
 * `--mode <name>` or `--mode=<name>`. Configs that only accept their own modes (one env file per mode) fail to load
 * in Vite's default `development` mode.
 *
 * @param scripts - The `scripts` field of package.json (anything).
 * @returns The mode name, or null when no dev script names one.
 */
export function viteModeFromScripts(scripts: unknown): string | null {
  if (!isRecord(scripts)) {
    return null;
  }
  for (const name of DEV_SCRIPT_NAMES) {
    const script = scripts[name];
    if (typeof script !== "string") {
      continue;
    }
    for (const segment of script.split(/&&|\|\||;|\|/)) {
      const tokens = segment.trim().split(/\s+/);
      const viteIndex = tokens.findIndex((token) => token === "vite" || token.endsWith("/vite"));
      if (viteIndex === -1) {
        continue;
      }
      const subcommand = tokens[viteIndex + 1];
      if (subcommand === "build" || subcommand === "preview" || subcommand === "optimize") {
        continue;
      }
      for (const [index, token] of tokens.entries()) {
        const inline = /^--mode=([A-Za-z0-9._-]+)$/.exec(token);
        if (inline?.[1] !== undefined) {
          return inline[1];
        }
        const next = tokens[index + 1];
        if (token === "--mode" && next !== undefined && /^[A-Za-z0-9._-]+$/.test(next)) {
          return next;
        }
      }
    }
  }
  return null;
}

/**
 * The mode to load the repository's Vite config and .env files with: its dev script's `--mode`, else
 * DEFAULT_VITE_MODE.
 *
 * @param viteRoot - Absolute Vite root (holds the app's package.json).
 */
export async function detectViteMode(viteRoot: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(viteRoot, "package.json"), "utf8"));
    return (isRecord(parsed) ? viteModeFromScripts(parsed.scripts) : null) ?? DEFAULT_VITE_MODE;
  } catch {
    return DEFAULT_VITE_MODE;
  }
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
  /** 16i (16 §12.4): the live plugin of a live host (`createLivePlugin`), appended after the harness plugin. */
  livePlugin?: VitePluginLike | null;
  logger: ViteLoggerLike;
  fsAllow: string[];
  envDefines: Record<string, string>;
  reactDomMajor: number;
  port: number; // probed free port (10 §5.6.3 step 7b)
  /** The repository's dev mode (`detectViteMode`); default DEFAULT_VITE_MODE. */
  mode?: string;
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
    mode: input.mode ?? DEFAULT_VITE_MODE,
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
  const livePlugin = options.live === undefined ? null : (input.livePlugin ?? null);
  merged.plugins = [input.mockPlugin, ...input.userPlugins, input.harnessPlugin, ...(livePlugin ? [livePlugin] : [])];
  const mergedServer = asRecord(merged.server);
  mergedServer.watch = resolveWatchOption(input.viteMajor, input.viteMinor);
  if (options.live !== undefined) {
    // 16 §12.4: no Access-Control-Allow-Origin header (a user config cannot re-enable it for a live host).
    mergedServer.cors = false;
  }
  merged.server = mergedServer;
  const mergedOptimizeDeps = asRecord(merged.optimizeDeps);
  mergedOptimizeDeps.entries = [...options.optimizeEntries];
  merged.optimizeDeps = mergedOptimizeDeps;

  return { config: merged, warnings };
}
