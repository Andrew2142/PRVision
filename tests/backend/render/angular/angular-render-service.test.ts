import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { RENDER_STAGE_TIMEOUT_MS } from "../../../../backend/src/config-consts";
import { AngularHarnessWorkspaceWriter } from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-harness-workspace";
import type {
  AngularBuildHost,
  AngularBuildOutcome,
  AngularBuildRequest
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-host-client";
import {
  AngularRenderService,
  type AngularMockResolver
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-render-service";
import type {
  AngularStaticHostHandle,
  AngularStaticHostOptions
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-static-host";
import type { RenderComponentInput } from "../../../../backend/src/services/visualizations/pipeline/render-service";
import type {
  PageRenderInput,
  PageRenderOutcome,
  RenderSide,
  ViteLogEntry
} from "../../../../backend/src/services/visualizations/pipeline/render/render-types";
import {
  PipelineStepError,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type MockedModule
} from "../../../../backend/src/types/visualization-pipeline";
import {
  FakeArtifactStore,
  FakeBrowserSession,
  InMemoryPersistence,
  candidate,
  fakePipelineContext,
  type FakeRenderEnv,
  type ScriptedOutcome
} from "../helpers/render-stubs";

const ANGULAR_JSON = JSON.stringify({
  projects: {
    app: {
      projectType: "application",
      root: "",
      architect: {
        build: {
          builder: "@angular/build:application",
          options: {
            browser: "src/main.ts",
            index: "src/index.html",
            tsConfig: "tsconfig.app.json",
            polyfills: ["zone.js"],
            styles: ["src/styles.css"]
          },
          configurations: { development: { optimization: false } }
        }
      }
    }
  }
});

const PAGE_WARNINGS = { unstable: false, skippedInputs: [] as string[], httpUnmatched: [] as string[] };

/** Script of one build: decides by side, build key and the items in the registry. */
type BuildScript = (side: RenderSide, request: AngularBuildRequest, ids: number[]) => AngularBuildOutcome | null;

interface BuildRecord {
  side: RenderSide;
  buildKey: string;
  ids: number[];
  fileReplacements: unknown;
}

class FakeBuildHost implements AngularBuildHost {
  stopCalls = 0;
  failStop = false;
  constructor(
    readonly side: RenderSide,
    private readonly workspaceRoot: string,
    private readonly records: BuildRecord[],
    private readonly script: BuildScript,
    private readonly beforeBuild: (() => void) | null
  ) {}

  versions() {
    return { core: "21.2.0", build: "21.2.0", architect: "0.2102.0" };
  }

  build(request: AngularBuildRequest, signal: AbortSignal): Promise<AngularBuildOutcome> {
    const registry = fs.readFileSync(
      path.join(this.workspaceRoot, ".prvision-harness", "registry.generated.ts"),
      "utf8"
    );
    const ids = [...registry.matchAll(/'(\d+)':/g)].map((match) => Number(match[1]));
    this.records.push({
      side: this.side,
      buildKey: request.buildKey,
      ids,
      fileReplacements: request.options.fileReplacements
    });
    this.beforeBuild?.();
    if (signal.aborted) {
      return Promise.resolve({ status: "cancelled", durationMs: 1, logs: [] });
    }
    const scripted = this.script(this.side, request, ids);
    if (scripted !== null) {
      return Promise.resolve(scripted);
    }
    const outputDir = path.join(this.workspaceRoot, ".prvision-harness", "dist", request.buildKey);
    fs.mkdirSync(outputDir, { recursive: true });
    return Promise.resolve({ status: "success", outputDir, durationMs: 7_000, logs: [] });
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    return this.failStop ? Promise.reject(new Error("stop failed")) : Promise.resolve();
  }
}

class FakeStaticHost implements AngularStaticHostHandle {
  readonly harnessUrlPath = "/index.html" as const;
  readonly tailwindMajor = null;
  readonly warnings: readonly string[] = [];
  alive = true;
  failStop = false;
  constructor(
    readonly side: RenderSide,
    readonly groupKey: string,
    readonly origin: string,
    readonly distDir: string
  ) {}
  isAlive(): boolean {
    return this.alive;
  }
  exitReason(): string | null {
    return this.alive ? null : "stopped";
  }
  currentSeq(): number {
    return 0;
  }
  logsSince(): ViteLogEntry[] {
    return [];
  }
  sawDepsReoptimizeSince(): false {
    return false;
  }
  stop(): Promise<void> {
    this.alive = false;
    return this.failStop ? Promise.reject(new Error("static stop failed")) : Promise.resolve();
  }
}

/** FakeBrowserSession that also returns the Angular page fields for scripted components. */
class AngularFakeSession extends FakeBrowserSession {
  readonly pageExtras = new Map<string, Partial<typeof PAGE_WARNINGS>>();
  override async renderComponent(input: PageRenderInput): Promise<PageRenderOutcome> {
    const outcome = await super.renderComponent(input);
    const extras = this.pageExtras.get(`${String(input.componentId)}:${input.host.side}`);
    return outcome.ok && extras !== undefined ? { ...outcome, ...PAGE_WARNINGS, ...extras } : outcome;
  }
}

interface Fixture {
  env: FakeRenderEnv;
  service: AngularRenderService;
  builds: BuildRecord[];
  buildHosts: FakeBuildHost[];
  staticHosts: FakeStaticHost[];
  session: AngularFakeSession;
  persistence: InMemoryPersistence;
  repairs: Array<{ componentId: number; error: HarnessRenderError }>;
  clock: { now: number };
}

function component(id: number): string {
  return `src/app/c${String(id)}/c${String(id)}.component.ts`;
}

function angularHarness(id: number, mocks: MockedModule[] = [], marker = ""): HarnessGenerationResult {
  return {
    componentId: id,
    harnessSource: `import { definePrvisionHarness } from '../harness-api';\nimport { C${String(id)} } from '../../${component(id).replace(/\.ts$/, "")}';\n${marker}export default definePrvisionHarness({ component: C${String(id)} });\n`,
    mockedModules: mocks,
    notes: "Initial notes.",
    states: [{ name: "Default", steps: [] }],
    origin: "written",
    libraryEntryId: null
  };
}

function input(
  id: number,
  options: { mocks?: MockedModule[]; changeKind?: "modified" | "added" | "removed" } = {}
): RenderComponentInput {
  const changeKind = options.changeKind ?? "modified";
  return {
    candidate: candidate(id, component(id), changeKind, id),
    harness: angularHarness(id, options.mocks ?? []),
    basePath: changeKind === "added" ? null : component(id)
  };
}

function setup(
  t: TestContext,
  options: {
    ids?: number[];
    script?: BuildScript;
    outcomes?: Record<string, ScriptedOutcome | ScriptedOutcome[]>;
    repair?: (
      componentId: number,
      previous: HarnessGenerationResult,
      error: HarnessRenderError
    ) => HarnessRepairOutcome;
    headAngularJson?: string | null;
    baseAngularJson?: string | null;
    beforeBuild?: (fixture: Fixture) => void;
  } = {}
): Fixture {
  const ids = options.ids ?? [1, 2];
  const files: Record<string, { base?: string; head?: string }> = {};
  for (const id of ids) {
    files[component(id)] = { base: `export class C${String(id)} {}\n`, head: `export class C${String(id)} {}\n` };
  }
  files["src/app/clock.ts"] = { base: "export const now = 1;\n", head: "export const now = 1;\n" };
  files["src/index.html"] = {
    base: "<html><head><title>x</title></head><body></body></html>",
    head: "<html><head></head></html>"
  };
  files["tsconfig.app.json"] = { base: "{}", head: "{}" };
  if (options.baseAngularJson !== null) {
    files["angular.json"] = { ...files["angular.json"], base: options.baseAngularJson ?? ANGULAR_JSON };
  }
  if (options.headAngularJson !== null) {
    files["angular.json"] = { ...files["angular.json"], head: options.headAngularJson ?? ANGULAR_JSON };
  }
  const env = fakePipelineContext(t, { files, globalStylePaths: ["/src/styles.css"] });
  Object.assign(env.handle.context.repository, {
    framework: "angular",
    appRoot: ".",
    angularProject: "app",
    angularBuildConfiguration: "development",
    viteConfigPath: null,
    tsconfigPath: "tsconfig.app.json"
  });
  const templatesDir = path.join(env.templatesDir, "angular");
  fs.mkdirSync(templatesDir, { recursive: true });
  for (const file of ["main.ts", "harness-api.ts", "http-backend.ts"]) {
    fs.writeFileSync(path.join(templatesDir, file), `// ${file}\n`);
  }
  const session = new AngularFakeSession(options.outcomes ?? {});
  const persistence = new InMemoryPersistence();
  const fixture: Fixture = {
    env,
    service: null as unknown as AngularRenderService,
    builds: [],
    buildHosts: [],
    staticHosts: [],
    session,
    persistence,
    repairs: [],
    clock: { now: 1_000_000 }
  };
  let port = 42000;
  const resolver: AngularMockResolver = (specifier, from) =>
    specifier.startsWith(".") ? path.posix.join(path.posix.dirname(from), `${specifier}.ts`) : null;
  fixture.service = new AngularRenderService({
    repairHarness: (componentId, previous, error) => {
      fixture.repairs.push({ componentId, error });
      return Promise.resolve(
        options.repair?.(componentId, previous, error) ?? { ok: false, reason: "ai_error", message: "no repair" }
      );
    },
    createPersistence: () => persistence,
    artifactStore: new FakeArtifactStore(env.dataDir),
    workspaceWriter: new AngularHarnessWorkspaceWriter(templatesDir),
    launchBrowser: () => Promise.resolve(session),
    createBuildHost: (side, workspaceRoot) => {
      const host = new FakeBuildHost(
        side,
        workspaceRoot,
        fixture.builds,
        options.script ?? (() => null),
        options.beforeBuild ? () => options.beforeBuild?.(fixture) : null
      );
      fixture.buildHosts.push(host);
      return host;
    },
    startStaticHost: (hostOptions: AngularStaticHostOptions) => {
      port += 1;
      const host = new FakeStaticHost(
        hostOptions.side,
        hostOptions.groupKey,
        `http://127.0.0.1:${String(port)}`,
        hostOptions.distDir
      );
      fixture.staticHosts.push(host);
      return Promise.resolve(host);
    },
    createMockResolver: () => Promise.resolve(resolver),
    cacheDirFor: (id) => path.join(env.dataDir, "cache", "angular", String(id)),
    now: () => fixture.clock.now
  });
  return fixture;
}

function failedBuild(file: string, message = "NG8002: Can't bind to 'x'"): AngularBuildOutcome {
  return {
    status: "failed",
    durationMs: 3_000,
    logs: [
      { level: "error", message: `✘ [ERROR] ${message} [plugin angular-compiler]\n\n    ${file}:3:5:\n      3 │ x\n` }
    ]
  };
}

const warns = (f: Fixture): string[] => f.env.handle.console.messages("warn");
const infos = (f: Fixture): string[] => f.env.handle.console.messages("info");

test("AngularRenderService.renderAll builds each group once per side (base ∥ head) and renders every item", async (t) => {
  const mock: MockedModule = { specifier: "../clock", source: "export const now = 2;" };
  const f = setup(t, { ids: [1, 2, 3] });
  const results = await f.service.renderAll(f.env.handle.context, [input(1), input(2), input(3, { mocks: [mock] })]);
  assert.deepEqual(
    results.map((result) => result.componentId),
    [1, 2, 3]
  );
  for (const result of results) {
    assert.equal(result.base?.ok, true);
    assert.equal(result.head?.ok, true);
  }
  // Two groups ("none" and the mock fingerprint), each built on both sides with only its items in the registry.
  assert.deepEqual(f.builds.map((build) => `${build.side}:${build.ids.join(",")}`).sort(), [
    "base:1,2",
    "base:3",
    "head:1,2",
    "head:3"
  ]);
  assert.ok(f.builds.some((build) => build.buildKey === "none"));
  const mockBuild = f.builds.find((build) => build.side === "head" && build.ids.includes(3));
  const replacements = mockBuild?.fileReplacements as Array<{ replace: string; with: string }>;
  const [replacement] = replacements;
  assert.ok(replacement && replacements.length === 1);
  assert.equal(replacement.replace, "src/app/clock.ts");
  assert.match(replacement.with, /^\.prvision-harness\/mocks\/[0-9a-f]{16}\.ts$/);
  const mockFile = replacement.with;
  assert.ok(fs.readFileSync(path.join(f.env.headDir, mockFile), "utf8").includes("export const now = 2;"));
  assert.ok(
    fs.readFileSync(path.join(f.env.headDir, ".prvision-harness/components/1.ts"), "utf8").startsWith("// @ts-nocheck")
  );
  // Each item rendered against the static host of its build; hosts stopped after each group.
  assert.equal(f.staticHosts.length, 4);
  assert.ok(f.staticHosts.every((host) => !host.alive));
  assert.ok(
    f.buildHosts.every((host) => host.stopCalls >= 1),
    "build children stopped in cleanup"
  );
  assert.equal(f.session.closeCalls, 1);
  assert.ok(
    infos(f).some((line) =>
      /^Angular 21\.2\.0 build \(@angular\/build:application\) for the head side: 2 component\(s\) in 7\.0 s\.$/.test(
        line
      )
    )
  );
  assert.equal(f.persistence.latest(1)?.renderStatus, "rendered");
  // Static first render: no cold-start allowance.
  assert.ok(f.session.renders.every((render) => render.timeoutMs === 30_000));
});

test("AngularRenderService excludes a harness with an attributed compile error and rebuilds the rest (one extra build)", async (t) => {
  const f = setup(t, {
    ids: [1, 2],
    script: (side, _request, ids) =>
      side === "head" && ids.includes(2) ? failedBuild(".prvision-harness/components/2.ts") : null
  });
  const results = await f.service.renderAll(f.env.handle.context, [input(1), input(2)]);
  assert.deepEqual(
    f.builds.filter((build) => build.side === "head").map((build) => [build.buildKey, build.ids.join(",")]),
    [
      ["none", "1,2"],
      ["none-x2", "1"]
    ]
  );
  assert.equal(results[0]?.head?.ok, true);
  const two = results[1];
  assert.equal(two?.base?.ok, true);
  assert.equal(two.head?.ok, false);
  assert.match(
    two.head.error ?? "",
    /^\[module_load\] Module load failed: Angular build error in the harness:\nAngular build:\n- NG8002/
  );
  assert.ok(warns(f).includes("Angular build on the head side failed for 1 harness(es); rebuilding without them."));
  assert.equal(f.persistence.latest(2)?.renderStatus, "partial");
  assert.equal(f.repairs.length, 0, "a one-side failure on a modified component is not repaired");
});

test("AngularRenderService fails every item of a side on a side-wide build error and reports it once", async (t) => {
  const f = setup(t, {
    ids: [1, 2],
    script: (side) => (side === "base" ? failedBuild("src/styles.css", "Unexpected '}'") : null)
  });
  const results = await f.service.renderAll(f.env.handle.context, [input(1), input(2)]);
  for (const result of results) {
    assert.equal(result.base?.ok, false);
    assert.match(result.base.error ?? "", /^\[vite_unavailable\] The Angular build failed on the base side:/);
    assert.equal(result.head?.ok, true);
  }
  assert.equal(f.builds.filter((build) => build.side === "base").length, 1);
  assert.deepEqual(
    f.env.handle.console
      .messages("error")
      .filter((line) => line.startsWith("The Angular build failed on the base side")),
    ["The Angular build failed on the base side: Unexpected '}' (src/styles.css:3)"]
  );
});

test("AngularRenderService repairs a component that failed on every side and rebuilds it as <group>-r1", async (t) => {
  const f = setup(t, {
    ids: [1],
    outcomes: {
      "1:base:0": {
        ok: false,
        kind: "render_error",
        error: "[render_error] Render error: NG0201: No provider for API_AUTH_BRIDGE"
      },
      "1:head:0": {
        ok: false,
        kind: "render_error",
        error: "[render_error] Render error: NG0201: No provider for API_AUTH_BRIDGE"
      }
    },
    repair: (componentId) => ({
      ok: true,
      result: { ...angularHarness(componentId, [], "// repaired\n"), notes: "Repaired after a render error." }
    })
  });
  const results = await f.service.renderAll(f.env.handle.context, [input(1)]);
  assert.equal(f.repairs.length, 1);
  assert.equal(f.repairs[0]?.error.kind, "render_error");
  assert.deepEqual(f.builds.map((build) => `${build.side}:${build.buildKey}`).sort(), [
    "base:none",
    "base:none-r1",
    "head:none",
    "head:none-r1"
  ]);
  assert.equal(results[0]?.head?.ok, true);
  assert.equal(results[0].base?.ok, true);
  const saved = f.persistence.latest(1);
  assert.equal(saved?.renderStatus, "rendered");
  assert.ok(saved.harness?.harnessSource.includes("// repaired"));
  assert.ok(
    fs.readFileSync(path.join(f.env.headDir, ".prvision-harness/components/1.ts"), "utf8").includes("// repaired")
  );
  assert.ok(infos(f).some((line) => line.startsWith("Repaired harness rendered c1.component")));
});

test("AngularRenderService reports unstable apps, HTTP requests without fixtures and skipped inputs as console events, not failures", async (t) => {
  const f = setup(t, { ids: [1] });
  f.session.pageExtras.set("1:head", {
    unstable: true,
    httpUnmatched: ["GET /api/a", "GET /api/b", "POST /api/c", "GET /api/d"]
  });
  f.session.pageExtras.set("1:base", { skippedInputs: ["section"] });
  const results = await f.service.renderAll(f.env.handle.context, [input(1)]);
  assert.equal(results[0]?.head?.ok, true);
  const name = "c1.component";
  assert.ok(
    warns(f).includes(
      `${name} (head): the app never became stable within 5 s (pending timers or requests); captured anyway.`
    )
  );
  assert.ok(
    warns(f).includes(`${name} (head): 4 HTTP request(s) had no fixture: GET /api/a, GET /api/b, POST /api/c.`)
  );
  assert.ok(infos(f).includes(`${name} (base): inputs not declared on this side were skipped: section.`));
  assert.equal(f.persistence.latest(1)?.renderStatus, "rendered");
});

test("AngularRenderService fails the side whose angular.json lacks the project; both sides missing is fatal", async (t) => {
  const f = setup(t, { ids: [1], headAngularJson: JSON.stringify({ projects: {} }) });
  const results = await f.service.renderAll(f.env.handle.context, [input(1)]);
  assert.equal(results[0]?.base?.ok, true);
  assert.match(
    results[0].head?.error ?? "",
    /^\[vite_unavailable\] Project app not found in angular\.json on the head side/
  );
  assert.ok(f.builds.every((build) => build.side === "base"));

  const none = setup(t, { ids: [1], headAngularJson: null, baseAngularJson: null });
  await assert.rejects(
    none.service.renderAll(none.env.handle.context, [input(1)]),
    (error: unknown) => error instanceof PipelineStepError && error.stage === "rendering"
  );
});

test("AngularRenderService marks the remaining components budget_exceeded when the stage budget runs out", async (t) => {
  const f = setup(t, {
    ids: [1, 2],
    beforeBuild: (fixture) => {
      fixture.clock.now += RENDER_STAGE_TIMEOUT_MS + 1;
    }
  });
  await f.service.renderAll(f.env.handle.context, [input(1), input(2)]);
  for (const id of [1, 2]) {
    const saved = f.persistence.latest(id);
    assert.equal(saved?.renderStatus, "failed");
    assert.match(saved.headError ?? "", /budget_exceeded|time budget/);
  }
  assert.ok(warns(f).some((line) => /exceeded its 15-minute budget; 2 component\(s\) were not rendered\./.test(line)));
});

test("AngularRenderService stops the build children on cancellation and persists nothing for unfinished items", async (t) => {
  const f = setup(t, {
    ids: [1, 2],
    beforeBuild: (fixture) => {
      fixture.env.handle.cancel();
    }
  });
  const results = await f.service.renderAll(f.env.handle.context, [input(1), input(2)]);
  assert.deepEqual(results, []);
  assert.equal(f.persistence.saves.length, 0);
  assert.ok(f.buildHosts.length > 0);
  assert.ok(f.buildHosts.every((host) => host.stopCalls >= 1));
  assert.equal(f.session.renders.length, 0);
});

test("AngularRenderService cleanup never throws when hosts fail to stop", async (t) => {
  const f = setup(t, { ids: [1] });
  const original = f.service;
  const results = await original.renderAll(f.env.handle.context, [input(1)]);
  assert.equal(results.length, 1);
  const g = setup(t, {
    ids: [1],
    beforeBuild: (fixture) => {
      for (const host of fixture.buildHosts) {
        host.failStop = true;
      }
    }
  });
  const again = await g.service.renderAll(g.env.handle.context, [input(1)]);
  assert.equal(again[0]?.head?.ok, true);
});

test("AngularRenderService renders only the base side of a removed component and only the head of an added one", async (t) => {
  const f = setup(t, { ids: [1, 2] });
  const results = await f.service.renderAll(f.env.handle.context, [
    input(1, { changeKind: "removed" }),
    input(2, { changeKind: "added" })
  ]);
  assert.equal(results[0]?.head, null);
  assert.equal(results[0].base?.ok, true);
  assert.equal(results[1]?.base, null);
  assert.equal(results[1].head?.ok, true);
  assert.deepEqual(f.builds.map((build) => `${build.side}:${build.ids.join(",")}`).sort(), ["base:1", "head:2"]);
});

// ---- 00 §17: replaced rows render each side with its own harness, target file and file replacements ----

function replacedInput(id: number, baseId: number, headId: number): RenderComponentInput {
  const head = angularHarness(headId, [
    { specifier: `./c${String(headId)}.service`, source: "export const head = 1;" }
  ]);
  const base = angularHarness(baseId, [
    { specifier: `./c${String(baseId)}.service`, source: "export const base = 1;" }
  ]);
  return {
    candidate: {
      ...candidate(id, component(headId), "replaced", id),
      predecessor: {
        filePath: component(baseId),
        exportName: `C${String(baseId)}`,
        displayName: `C${String(baseId)}`,
        evidence: []
      }
    },
    harness: {
      ...head,
      componentId: id,
      notes: "Head notes.",
      baseHarness: {
        harnessSource: base.harnessSource,
        mockedModules: base.mockedModules,
        notes: "Base notes.",
        states: base.states,
        origin: base.origin,
        libraryEntryId: base.libraryEntryId
      }
    },
    basePath: component(baseId)
  };
}

test("AngularRenderService renders a replaced row with R's harness and file replacements on base and A's on head", async (t) => {
  const f = setup(t, { ids: [1, 2] });
  const results = await f.service.renderAll(f.env.handle.context, [replacedInput(5, 1, 2)]);
  assert.equal(results[0]?.base?.ok, true);
  assert.equal(results[0].head?.ok, true);
  const baseFile = fs.readFileSync(path.join(f.env.baseDir, ".prvision-harness/components/5.ts"), "utf8");
  const headFile = fs.readFileSync(path.join(f.env.headDir, ".prvision-harness/components/5.ts"), "utf8");
  assert.match(baseFile, /import \{ C1 \} from '\.\.\/\.\.\/src\/app\/c1\/c1\.component'/);
  assert.doesNotMatch(baseFile, /c2/);
  assert.match(headFile, /import \{ C2 \} from '\.\.\/\.\.\/src\/app\/c2\/c2\.component'/);
  const replacements = (side: RenderSide): string =>
    JSON.stringify(f.builds.filter((build) => build.side === side).map((build) => build.fileReplacements));
  assert.match(replacements("base"), /src\/app\/c1\/c1\.service\.ts/);
  assert.doesNotMatch(replacements("base"), /c2\.service/);
  assert.match(replacements("head"), /src\/app\/c2\/c2\.service\.ts/);
  assert.doesNotMatch(replacements("head"), /c1\.service/);
  assert.equal(f.persistence.latest(5)?.renderStatus, "rendered");
  assert.deepEqual(f.repairs, []);
});

test("AngularRenderService repairs only the failed side's own harness of a replaced row", async (t) => {
  const f = setup(t, {
    ids: [1, 2],
    outcomes: { "5:head:0": { ok: false, kind: "render_error", error: "[render_error] NG0201: No provider for X" } },
    repair: (componentId, previous) => ({
      ok: true,
      result: {
        ...previous,
        componentId,
        harnessSource: `${previous.harnessSource}// repaired\n`,
        notes: "Fixed head."
      }
    })
  });
  const results = await f.service.renderAll(f.env.handle.context, [replacedInput(5, 1, 2)]);
  assert.equal(f.repairs.length, 1, "the base side rendered; only the head harness is repaired");
  assert.deepEqual(f.repairs[0]?.error, {
    sides: ["head"],
    kind: "render_error",
    message: "[render_error] NG0201: No provider for X",
    otherSideMessage: null,
    targetSide: "head"
  });
  assert.ok(f.builds.some((build) => build.side === "head" && build.buildKey.endsWith("-r1")));
  assert.equal(results[0]?.head?.ok, true);
  const saved = f.persistence.latest(5);
  assert.equal(saved?.renderStatus, "rendered");
  assert.ok(saved.harness?.harnessSource.includes("// repaired"));
  assert.equal(saved.harness?.harnessNotes, "Fixed head.");
  assert.equal(saved.baseHarness?.harnessNotes, "Base notes.", "the base harness is kept as it was");
  assert.doesNotMatch(saved.baseHarness.harnessSource, /repaired/);
  assert.doesNotMatch(
    fs.readFileSync(path.join(f.env.baseDir, ".prvision-harness/components/5.ts"), "utf8"),
    /repaired/
  );
});
