import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  MOCK_VIRTUAL_PREFIX,
  classifySpecifier,
  createMockPlugin,
  mockHash,
  mockVirtualId,
  packageNameOf,
  validateMockedModules,
  type MockPluginOptions
} from "../../../backend/src/services/visualizations/pipeline/vite-mock-plugin";
import type {
  MockEntryInput,
  VitePluginContextLike,
  VitePluginLike,
  ViteResolvedIdLike,
  ViteResolveIdOptions
} from "../../../backend/src/services/visualizations/pipeline/render/render-types";

const ROOT = "/repo";
const COMPONENT = "/repo/src/components/Cart.tsx";

/** Fake plugin context: resolve(source, importer) looks up "<dirname(importer)>\0<source>". */
function fakeContext(map: Record<string, string>): VitePluginContextLike & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    resolve(source: string, importer?: string): Promise<ViteResolvedIdLike | null> {
      const key = `${path.posix.dirname(importer ?? "/")}\u0000${source}`;
      calls.push(key);
      const id = map[key];
      return Promise.resolve(id === undefined ? null : { id });
    }
  };
}

const RESOLUTIONS: Record<string, string> = {
  "/repo/src/components\u0000@/api/client": "/repo/src/api/client.ts",
  "/repo/src/components\u0000../api/client": "/repo/src/api/client.ts",
  "/repo/src/hooks\u0000../api/client": "/repo/src/api/client.ts",
  "/repo/src/hooks\u0000/repo/src/api/client": "/repo/src/api/client.ts",
  "/repo/src/components\u0000./Other": "/repo/src/components/Other.tsx",
  "/repo/src/components\u0000./util": "/repo/src/components/util.ts",
  "/repo/src/components\u0000./Cart": "/repo/src/components/Cart.tsx",
  "/repo/src/components\u0000@tanstack/react-query": "/repo/.prvision-harness/.vite-cache/deps/@tanstack_react-query.js"
};

function entry(specifier: string, source = `export const value = ${JSON.stringify(specifier)};`): MockEntryInput {
  return { componentId: 7, componentFile: COMPONENT, specifier, source };
}

function makePlugin(
  entries: MockEntryInput[],
  overrides: Partial<MockPluginOptions> = {}
): { plugin: VitePluginLike; warnings: string[]; transpiled: string[] } {
  const warnings: string[] = [];
  const transpiled: string[] = [];
  const plugin = createMockPlugin({
    viteRoot: ROOT,
    cacheDir: "/repo/.prvision-harness/.vite-cache",
    harnessDir: "/repo/.prvision-harness",
    entries,
    transpile: (code, filename) => {
      transpiled.push(filename);
      return Promise.resolve(`/* compiled */ ${code}`);
    },
    isInstalledPackage: (name) => name === "@tanstack/react-query" || name === "date-fns",
    warn: (message) => {
      warnings.push(message);
    },
    ...overrides
  });
  return { plugin, warnings, transpiled };
}

async function resolve(
  plugin: VitePluginLike,
  context: VitePluginContextLike,
  source: string,
  importer: string | undefined,
  options: ViteResolveIdOptions = {}
): Promise<string | ViteResolvedIdLike | null> {
  assert.ok(plugin.resolveId);
  return plugin.resolveId.call(context, source, importer, options);
}

function virtualOf(specifier: string, source = `export const value = ${JSON.stringify(specifier)};`): string {
  return mockVirtualId(mockHash(COMPONENT, specifier, source));
}

test("classifySpecifier distinguishes relative, absolute and bare specifiers", () => {
  assert.equal(classifySpecifier("./x"), "relative");
  assert.equal(classifySpecifier("../x"), "relative");
  assert.equal(classifySpecifier("."), "relative");
  assert.equal(classifySpecifier(".."), "relative");
  assert.equal(classifySpecifier("/src/x"), "absolute");
  assert.equal(classifySpecifier("@/lib/api"), "bare");
  assert.equal(classifySpecifier("react-query"), "bare");
});

test("packageNameOf handles scoped packages, subpaths and aliases", () => {
  assert.equal(packageNameOf("@tanstack/react-query"), "@tanstack/react-query");
  assert.equal(packageNameOf("@scope/name/sub/path"), "@scope/name");
  assert.equal(packageNameOf("date-fns/format"), "date-fns");
  assert.equal(packageNameOf("lodash"), "lodash");
  assert.equal(packageNameOf("@/lib/api"), null);
  assert.equal(packageNameOf("~/hooks/useCart"), null);
  assert.equal(packageNameOf("#internal"), null);
  assert.equal(packageNameOf("./x"), null);
  assert.equal(packageNameOf("/src/x"), null);
  assert.equal(packageNameOf("node:fs"), null);
  assert.equal(packageNameOf(""), null);
});

test("validateMockedModules rejects queries, styles, assets, React core and its subpaths, scheduler, duplicates, empty and oversized sources with the exact reason texts", () => {
  const ok = "export const x = 1;";
  const result = validateMockedModules([
    { specifier: "", source: ok },
    { specifier: "a b", source: ok },
    { specifier: "./x?raw", source: ok },
    { specifier: "./styles.CSS", source: ok },
    { specifier: "./logo.svg", source: ok },
    { specifier: "react", source: ok },
    { specifier: "react-dom/client", source: ok },
    { specifier: "react/jsx-runtime", source: ok },
    { specifier: "scheduler", source: ok },
    { specifier: "@/api", source: ok },
    { specifier: "@/api", source: "export const y = 2;" },
    { specifier: "./empty", source: "   " },
    { specifier: "./big", source: "x".repeat(200_001) }
  ]);
  assert.deepEqual(result.accepted, [{ specifier: "@/api", source: ok }]);
  assert.deepEqual(
    result.rejected.map((rejection) => [rejection.specifier, rejection.reason, rejection.duplicate]),
    [
      ["", "empty specifier", false],
      ["a b", "specifier contains whitespace", false],
      ["./x?raw", "specifiers with a query cannot be mocked", false],
      ["./styles.CSS", "stylesheets and assets cannot be mocked", false],
      ["./logo.svg", "stylesheets and assets cannot be mocked", false],
      ["react", "React core cannot be mocked", false],
      ["react-dom/client", "React core cannot be mocked", false],
      ["react/jsx-runtime", "React core cannot be mocked", false],
      ["scheduler", "React core cannot be mocked", false],
      ["@/api", "duplicate specifier (first one kept)", true],
      ["./empty", "empty source", false],
      ["./big", "source is longer than 200000 characters", false]
    ]
  );
});

test("mock-rules imports nothing but node:path and types", () => {
  const file = path.join(__dirname, "../../../backend/src/services/visualizations/pipeline/mock-rules.ts");
  const source = fs.readFileSync(file, "utf8");
  const imports = [...source.matchAll(/^import\s+(type\s+)?[^"']*["']([^"']+)["']/gm)].map((match) => ({
    typeOnly: match[1] !== undefined,
    from: match[2]
  }));
  for (const entry of imports) {
    assert.ok(entry.from === "node:path" || entry.typeOnly, `unexpected runtime import ${String(entry.from)}`);
  }
  assert.doesNotMatch(source, /\brequire\(/);
});

test("mockVirtualId is stable for identical input and differs when source changes", () => {
  const a = mockVirtualId(mockHash(COMPONENT, "@/api", "export const a = 1;"));
  const b = mockVirtualId(mockHash(COMPONENT, "@/api", "export const a = 1;"));
  const c = mockVirtualId(mockHash(COMPONENT, "@/api", "export const a = 2;"));
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.ok(a.startsWith(MOCK_VIRTUAL_PREFIX));
  assert.match(a.slice(MOCK_VIRTUAL_PREFIX.length), /^[0-9a-f]{16}$/);
});

test("resolveId returns the virtual id for an exact package specifier from user source", async () => {
  const { plugin } = makePlugin([entry("@tanstack/react-query")]);
  const result = await resolve(plugin, fakeContext(RESOLUTIONS), "@tanstack/react-query", "/repo/src/hooks/useCart.ts");
  assert.equal(result, virtualOf("@tanstack/react-query"));
});

test("resolveId does not apply alias or relative mocks to node_modules importers", async () => {
  const { plugin } = makePlugin([entry("@/api/client"), entry("../api/client", "export const rel = 1;")]);
  const context = fakeContext(RESOLUTIONS);
  assert.equal(await resolve(plugin, context, "@/api/client", "/repo/node_modules/some-lib/index.js"), null);
  assert.equal(await resolve(plugin, context, "../api/client", "/repo/node_modules/some-lib/index.js"), null);
});

test("resolveId applies package mocks to node_modules importers", async () => {
  const { plugin } = makePlugin([entry("@tanstack/react-query")]);
  const result = await resolve(
    plugin,
    fakeContext(RESOLUTIONS),
    "@tanstack/react-query",
    "/repo/node_modules/some-lib/index.js"
  );
  assert.equal(result, virtualOf("@tanstack/react-query"));
});

test("resolveId matches a relative mock when the same file is imported from another directory", async () => {
  const { plugin } = makePlugin([entry("../api/client")]);
  const context = fakeContext(RESOLUTIONS);
  assert.equal(await resolve(plugin, context, "../api/client", COMPONENT), virtualOf("../api/client"));
  assert.equal(
    await resolve(plugin, context, "../api/client", "/repo/src/hooks/useCart.ts"),
    virtualOf("../api/client")
  );
});

test("resolveId matches an alias mock when the importer uses a relative path to the same file", async () => {
  const { plugin } = makePlugin([entry("@/api/client")]);
  const result = await resolve(plugin, fakeContext(RESOLUTIONS), "../api/client", "/repo/src/hooks/useCart.ts");
  assert.equal(result, virtualOf("@/api/client"));
});

test("resolveId matches an alias-expanded absolute source by resolved path", async () => {
  const { plugin } = makePlugin([entry("@/api/client")]);
  const result = await resolve(plugin, fakeContext(RESOLUTIONS), "/repo/src/api/client", "/repo/src/hooks/useCart.ts");
  assert.equal(result, virtualOf("@/api/client"));
});

test("resolveId returns the chain's resolution for non-mocked eligible sources (no double resolution)", async () => {
  const { plugin } = makePlugin([entry("@/api/client")]);
  const context = fakeContext(RESOLUTIONS);
  const first = await resolve(plugin, context, "./Other", COMPONENT);
  assert.deepEqual(first, { id: "/repo/src/components/Other.tsx" });
  const before = context.calls.filter((call) => call.endsWith("./Other")).length;
  const second = await resolve(plugin, context, "./Other", "/repo/src/components/Sibling.tsx");
  assert.deepEqual(second, { id: "/repo/src/components/Other.tsx" });
  assert.equal(context.calls.filter((call) => call.endsWith("./Other")).length, before, "memoized per directory");
  assert.equal(before, 1);
});

test("resolveId returns null during dependency scan for resolvable targets", async () => {
  const { plugin } = makePlugin([entry("@/api/client"), entry("@tanstack/react-query")]);
  const context = fakeContext(RESOLUTIONS);
  assert.equal(await resolve(plugin, context, "@/api/client", COMPONENT, { scan: true }), null);
  assert.equal(await resolve(plugin, context, "@tanstack/react-query", COMPONENT, { scan: true }), null);
});

test("resolveId returns the virtual id during dependency scan for unresolvable targets", async () => {
  const { plugin } = makePlugin([entry("./does-not-exist")]);
  const result = await resolve(plugin, fakeContext(RESOLUTIONS), "./does-not-exist", COMPONENT, { scan: true });
  assert.equal(result, virtualOf("./does-not-exist"));
});

test("resolveId never mocks imports made by a mock module", async () => {
  const { plugin } = makePlugin([entry("@/api/client"), entry("@tanstack/react-query")]);
  const context = fakeContext(RESOLUTIONS);
  const importer = virtualOf("@/api/client");
  assert.equal(await resolve(plugin, context, "@/api/client", importer), null);
  assert.equal(await resolve(plugin, context, "@tanstack/react-query", importer), null);
});

test("relative imports inside a mock resolve against the component file", async () => {
  const { plugin } = makePlugin([entry("@/api/client")]);
  const result = await resolve(plugin, fakeContext(RESOLUTIONS), "./util", virtualOf("@/api/client"));
  assert.deepEqual(result, { id: "/repo/src/components/util.ts" });
});

test("resolveId ignores specifiers with queries and asset extensions", async () => {
  const { plugin } = makePlugin([entry("@/api/client")]);
  const context = fakeContext(RESOLUTIONS);
  const callsBefore = context.calls.length;
  assert.equal(await resolve(plugin, context, "../api/client?raw", "/repo/src/hooks/useCart.ts"), null);
  assert.equal(await resolve(plugin, context, "./logo.svg", COMPONENT), null);
  assert.equal(await resolve(plugin, context, "./styles.module.css", COMPONENT), null);
  const pathCalls = context.calls.slice(callsBefore).filter((call) => !call.endsWith("@/api/client"));
  assert.deepEqual(pathCalls, [], "ineligible sources are never resolved");
});

test("a mock targeting the component file itself is ignored with a warning", async () => {
  const { plugin, warnings } = makePlugin([entry("./Cart")]);
  const result = await resolve(plugin, fakeContext(RESOLUTIONS), "./Cart", "/repo/src/components/Index.tsx");
  assert.notEqual(result, virtualOf("./Cart"));
  assert.ok(warnings.some((warning) => warning.includes("targets the component under test itself")));
});

test("load transpiles mock source once and caches it", async () => {
  const { plugin, transpiled } = makePlugin([entry("@/api/client", "export const a: number = 1;")]);
  assert.ok(plugin.load);
  const id = virtualOf("@/api/client", "export const a: number = 1;");
  const context = fakeContext({});
  const first = await plugin.load.call(context, id);
  const second = await plugin.load.call(context, id);
  assert.deepEqual(first, { code: "/* compiled */ export const a: number = 1;", map: null });
  assert.deepEqual(second, first);
  assert.equal(transpiled.length, 1);
  assert.match(transpiled[0] ?? "", /^\/repo\/\.prvision-harness\/mocks\/[0-9a-f]{16}\.tsx$/);
});

test("load wraps transpile errors with the specifier and component id", async () => {
  const { plugin } = makePlugin([entry("@/api/client")], {
    transpile: () => Promise.reject<string>(new Error("Unexpected token"))
  });
  assert.ok(plugin.load);
  await assert.rejects(
    async () => plugin.load?.call(fakeContext({}), virtualOf("@/api/client")),
    /Mock for "@\/api\/client" \(component 7\) failed to compile: Unexpected token/
  );
});

test("load throws for unknown virtual ids and returns null for other ids", async () => {
  const { plugin } = makePlugin([entry("@/api/client")]);
  assert.ok(plugin.load);
  await assert.rejects(
    async () => plugin.load?.call(fakeContext({}), `${MOCK_VIRTUAL_PREFIX}0000000000000000`),
    /Unknown PRVision mock module/
  );
  assert.equal(await plugin.load.call(fakeContext({}), "/repo/src/api/client.ts"), null);
});

test("an empty registry yields hooks that return null", async () => {
  const { plugin } = makePlugin([]);
  const context = fakeContext(RESOLUTIONS);
  assert.equal(plugin.name, "prvision:mock");
  assert.equal(plugin.enforce, "pre");
  assert.equal(await resolve(plugin, context, "@/api/client", COMPONENT), null);
  assert.equal(await resolve(plugin, context, "./Other", COMPONENT), null);
  assert.equal(context.calls.length, 0);
  assert.equal(await plugin.load?.call(context, "/repo/src/x.ts"), null);
});
