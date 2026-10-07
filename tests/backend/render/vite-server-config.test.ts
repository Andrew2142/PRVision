import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  UnknownRecord,
  ViteHostStartOptions,
  ViteLoggerLike,
  VitePluginLike
} from "../../../backend/src/services/visualizations/pipeline/render/render-types";
import {
  PLUGIN_DENYLIST_PREFIXES,
  buildViteInlineConfig,
  filterUserPlugins,
  flattenUserPlugins,
  type BuildInlineConfigInput
} from "../../../backend/src/services/visualizations/pipeline/render/vite-server-config";

function isPlainObject(value: unknown): value is UnknownRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Vite's documented mergeConfig semantics: null/undefined skipped, arrays concatenated, objects deep-merged. */
function mergeConfig(defaults: UnknownRecord, overrides: UnknownRecord): UnknownRecord {
  const merged: UnknownRecord = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null || value === undefined) {
      continue;
    }
    const existing = merged[key];
    if (existing === null || existing === undefined) {
      merged[key] = value;
    } else if (Array.isArray(existing) || Array.isArray(value)) {
      merged[key] = [...(Array.isArray(existing) ? existing : [existing]), ...(Array.isArray(value) ? value : [value])];
    } else if (isPlainObject(existing) && isPlainObject(value)) {
      merged[key] = mergeConfig(existing, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

const logger: ViteLoggerLike = {
  info: () => undefined,
  warn: () => undefined,
  warnOnce: () => undefined,
  error: () => undefined,
  clearScreen: () => undefined,
  hasErrorLogged: () => false,
  hasWarned: false
};

const OPTIONS: ViteHostStartOptions = {
  side: "head",
  groupKey: "none",
  worktreeDir: "/wt/head",
  viteRoot: "/wt/head",
  harnessDir: "/wt/head/.prvision-harness",
  cacheDir: "/wt/head/.prvision-harness/.vite-cache",
  configFile: "/wt/head/vite.config.ts",
  optimizeEntries: [
    ".prvision-harness/entry.tsx",
    ".prvision-harness/globals.ts",
    ".prvision-harness/components/1.tsx"
  ],
  warmupFiles: [".prvision-harness/entry.tsx", ".prvision-harness/components/1.tsx"],
  referencedEnvKeys: [],
  mocks: []
};

const mockPlugin: VitePluginLike = { name: "prvision:mock", enforce: "pre" };
const harnessPlugin: VitePluginLike = { name: "prvision:harness", enforce: "pre" };

function build(overrides: Partial<BuildInlineConfigInput> = {}): { config: UnknownRecord; warnings: string[] } {
  return buildViteInlineConfig({
    vite: { mergeConfig },
    viteMajor: 7,
    viteMinor: 3,
    options: OPTIONS,
    userConfig: {},
    userConfigFound: true,
    userPlugins: [],
    mockPlugin,
    harnessPlugin,
    logger,
    fsAllow: ["/wt/head", "/real/node_modules"],
    envDefines: {},
    reactDomMajor: 19,
    port: 51234,
    ...overrides
  });
}

function record(value: unknown): UnknownRecord {
  assert.ok(isPlainObject(value), "expected an object");
  return value;
}

test("removes proxy, https, open, port, host, hmr, watch and warmup from the user server config", () => {
  const userConfig = {
    server: {
      proxy: { "/api": "http://localhost:8080" },
      https: true,
      open: true,
      port: 5173,
      host: "0.0.0.0",
      hmr: { overlay: true },
      watch: { usePolling: true },
      warmup: { clientFiles: ["src/main.tsx"] },
      headers: { "x-test": "1" }
    }
  };
  const { config, warnings } = build({ userConfig });
  const server = record(config.server);
  assert.equal(server.proxy, undefined);
  assert.equal(server.https, undefined);
  assert.equal(server.open, false);
  assert.equal(server.port, 51234);
  assert.equal(server.host, "127.0.0.1");
  assert.equal(server.hmr, false);
  assert.equal(server.watch, null);
  assert.deepEqual(record(server.warmup).clientFiles, OPTIONS.warmupFiles);
  assert.deepEqual(server.headers, { "x-test": "1" });
  assert.ok(warnings.some((warning) => warning.includes("server.proxy")));
  assert.ok(warnings.some((warning) => warning.includes("server.https")));
  assert.deepEqual(record(userConfig.server).port, 5173, "input not mutated");
});

test("forces root, base, appType, cacheDir, host 127.0.0.1 and the probed port", () => {
  const { config } = build({
    userConfig: { root: "/wt/head", base: "/", appType: "spa", cacheDir: "node_modules/.vite", mode: "production" }
  });
  assert.equal(config.root, "/wt/head");
  assert.equal(config.base, "/");
  assert.equal(config.appType, "mpa");
  assert.equal(config.cacheDir, OPTIONS.cacheDir);
  assert.equal(config.mode, "development");
  assert.equal(config.configFile, false);
  assert.equal(config.customLogger, logger);
  assert.equal(config.clearScreen, false);
  const server = record(config.server);
  assert.equal(server.host, "127.0.0.1");
  assert.equal(server.port, 51234);
  assert.notEqual(server.port, 0);
  assert.equal(server.strictPort, false);
});

test("places the mock plugin first and the harness plugin last around user plugins", () => {
  const react: VitePluginLike = { name: "vite:react-babel" };
  const tailwind: VitePluginLike = { name: "@tailwindcss/vite:scan" };
  const { config } = build({ userConfig: { plugins: [{ name: "ignored-raw" }] }, userPlugins: [react, tailwind] });
  assert.deepEqual(config.plugins, [mockPlugin, react, tailwind, harnessPlugin]);
});

test("drops denylisted and build-only plugins and reports them", () => {
  const plugins: VitePluginLike[] = [
    { name: "vite:react-babel" },
    { name: "vite-plugin-checker" },
    { name: "vite-plugin-pwa:main" },
    { name: "vite:basic-ssl" },
    { name: "rollup-visualizer", apply: "build" },
    { name: "@tailwindcss/vite:scan" }
  ];
  const { kept, dropped } = filterUserPlugins(plugins);
  assert.deepEqual(
    kept.map((plugin) => plugin.name),
    ["vite:react-babel", "@tailwindcss/vite:scan"]
  );
  assert.deepEqual(dropped, ["vite-plugin-checker", "vite-plugin-pwa:main", "vite:basic-ssl", "rollup-visualizer"]);
  assert.ok(PLUGIN_DENYLIST_PREFIXES.includes("vite-plugin-checker"));
});

test("adds harness, cache, node_modules realpath and workspace root to fs.allow while keeping user entries", () => {
  const { config } = build({
    userConfig: { server: { fs: { allow: ["/shared/libs"], strict: false } } },
    fsAllow: ["/wt/head", "/wt/head/.prvision-harness", OPTIONS.cacheDir, "/real/clone/node_modules", "/monorepo"]
  });
  const fsConfig = record(record(config.server).fs);
  assert.equal(fsConfig.strict, true);
  assert.deepEqual(fsConfig.allow, [
    "/shared/libs",
    "/wt/head",
    "/wt/head/.prvision-harness",
    OPTIONS.cacheDir,
    "/real/clone/node_modules",
    "/monorepo"
  ]);
});

test("sets optimizeDeps.entries to exactly the provided list", () => {
  const { config } = build({
    userConfig: { optimizeDeps: { entries: ["src/**/*.tsx"], force: true, exclude: ["big-lib"] } }
  });
  const optimizeDeps = record(config.optimizeDeps);
  assert.deepEqual(optimizeDeps.entries, OPTIONS.optimizeEntries);
  assert.equal(optimizeDeps.force, undefined);
  assert.deepEqual(optimizeDeps.exclude, ["big-lib"]);
  assert.equal(optimizeDeps.holdUntilCrawlEnd, true);
});

test("adds React includes for React 18 and omits react-dom/client for React 17", () => {
  const react19 = record(build({ userConfig: { optimizeDeps: { include: ["lodash"] } } }).config.optimizeDeps);
  assert.deepEqual(react19.include, [
    "lodash",
    "react",
    "react-dom",
    "react-dom/client",
    "react/jsx-runtime",
    "react/jsx-dev-runtime"
  ]);
  const react17 = record(build({ reactDomMajor: 17 }).config.optimizeDeps);
  assert.deepEqual(react17.include, ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"]);
  assert.deepEqual(record(build().config.resolve).dedupe, ["react", "react-dom"]);
});

test("sets server.watch after merge (null survives)", () => {
  assert.equal(record(build({ viteMajor: 6, viteMinor: 0 }).config.server).watch, null);
  assert.deepEqual(record(build({ viteMajor: 5, viteMinor: 2 }).config.server).watch, { ignored: ["**/*"] });
});

test("adds warmup only for Vite 5+", () => {
  assert.deepEqual(
    record(record(build({ viteMajor: 5, viteMinor: 0 }).config.server).warmup).clientFiles,
    OPTIONS.warmupFiles
  );
  assert.equal(record(build({ viteMajor: 4, viteMinor: 5 }).config.server).warmup, undefined);
});

test("adds env defines without overriding user defines", () => {
  const { config } = build({
    userConfig: { define: { "import.meta.env.VITE_API_URL": JSON.stringify("https://user") } },
    envDefines: { "import.meta.env.VITE_FLAG": JSON.stringify(""), "import.meta.env.VITE_API_URL": JSON.stringify("") }
  });
  assert.deepEqual(config.define, {
    "import.meta.env.VITE_FLAG": '""',
    "import.meta.env.VITE_API_URL": '"https://user"'
  });
});

test("sets esbuild jsx automatic only when no config file was found", () => {
  assert.deepEqual(build({ userConfigFound: false }).config.esbuild, { jsx: "automatic" });
  assert.equal(build({ userConfigFound: true }).config.esbuild, undefined);
});

test("warns when the user config sets root or base", () => {
  const { warnings } = build({ userConfig: { root: "app", base: "/admin/" } });
  assert.ok(warnings.includes("Ignoring root: app from the Vite config; PRVision serves from /wt/head"));
  assert.ok(warnings.includes("Ignoring base: /admin/; the harness is served at /"));
  assert.deepEqual(build({ userConfig: { root: "/wt/head", base: "/" } }).warnings, []);
});

test("flattenUserPlugins awaits promises, flattens nested arrays and drops falsy values", async () => {
  const a: VitePluginLike = { name: "a" };
  const b: VitePluginLike = { name: "b" };
  const c: VitePluginLike = { name: "c" };
  const flattened = await flattenUserPlugins([
    a,
    null,
    false,
    undefined,
    [Promise.resolve(b), [Promise.resolve([c, 0])]],
    { notAPlugin: true }
  ]);
  assert.deepEqual(
    flattened.map((plugin) => plugin.name),
    ["a", "b", "c"]
  );
  assert.deepEqual(await flattenUserPlugins(undefined), []);
});

// ----- 16i: live hosts (16 §12.4) -----

test("live hosts append the live plugin after the harness plugin and keep server.cors false over a user cors", () => {
  const livePlugin: VitePluginLike = { name: "prvision:live", apply: "serve" };
  const react: VitePluginLike = { name: "vite:react-babel" };
  const { config } = build({
    options: { ...OPTIONS, live: { frontendOrigins: ["http://localhost:4210", "http://127.0.0.1:4210"] } },
    userConfig: { server: { cors: { origin: "*" } } },
    userPlugins: [react],
    livePlugin
  });
  assert.deepEqual(config.plugins, [mockPlugin, react, harnessPlugin, livePlugin]);
  const server = record(config.server);
  assert.equal(server.cors, false);
  assert.equal(server.hmr, false);
  assert.equal(server.watch, null);
});

test("a live plugin is ignored for a screenshot host (no live option)", () => {
  const { config } = build({ livePlugin: { name: "prvision:live" } });
  assert.deepEqual(config.plugins, [mockPlugin, harnessPlugin]);
  assert.equal(record(config.server).cors, false);
});
