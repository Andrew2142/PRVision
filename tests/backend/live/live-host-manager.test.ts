import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { VisualizationComponentModel } from "../../../backend/src/models";
import {
  AngularLiveBackend,
  LiveHostManager,
  type AngularLiveBackendDependencies,
  ReactLiveBackend,
  buildLivePlan,
  type LiveBackendContext,
  type LiveGroupPlan,
  type LiveHostBackend,
  type LiveRunningHost,
  type LiveSessionPlan
} from "../../../backend/src/services/live/live-host-manager";
import type {
  AngularBuildHost,
  AngularBuildRequest
} from "../../../backend/src/services/visualizations/pipeline/render/angular/angular-host-client";
import type { AngularStaticHostOptions } from "../../../backend/src/services/visualizations/pipeline/render/angular/angular-static-host";
import type {
  ViteHostHandle,
  ViteHostStartOptions
} from "../../../backend/src/services/visualizations/pipeline/render/render-types";
import type { LiveHostState } from "../../../backend/src/types/harness-library";
import { ModelHandler } from "../../../backend/src/utilities/handlers/model-handler";
import { makeComponentRow, makeRepositoryModel } from "../helpers/factories";

const ORIGINS = ["http://localhost:4210", "http://127.0.0.1:4210"];
const WORKSPACE = {
  visualizationId: 1,
  repositoryPath: "/repo",
  baseDir: "/data/worktrees/live-1/base",
  headDir: "/data/worktrees/live-1/head",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  sourceType: "local_branch" as const,
  dependencyDrift: false
};

function harnessSource(target: string, states = '[{ name: "Default", render: () => <Target /> }]'): string {
  return `import { definePrvisionHarness } from "../harness-api";\nimport Target from "${target}";\nexport default definePrvisionHarness({ states: ${states} });\n`;
}

function row(data: Record<string, unknown>): VisualizationComponentModel {
  return ModelHandler.hydrate(VisualizationComponentModel, {
    ...makeComponentRow({ renderStatus: "rendered" }),
    ...data
  });
}

/** n components, each in its own render group (distinct mocks), all on both sides. */
function rowsInGroups(n: number): VisualizationComponentModel[] {
  return Array.from({ length: n }, (_, index) =>
    row({
      id: index + 1,
      rank: index,
      filePath: `src/C${String(index + 1)}.tsx`,
      displayName: `C${String(index + 1)}`,
      harnessSource: harnessSource(`../../src/C${String(index + 1)}`),
      mockedModules: [{ specifier: `./api${String(index + 1)}`, source: "export const x = 1;" }]
    })
  );
}

function planOf(rows: VisualizationComponentModel[]): LiveSessionPlan {
  return buildLivePlan(rows, makeRepositoryModel());
}

interface FakeHost extends LiveRunningHost {
  stopped: boolean;
  alive: boolean;
}

class FakeBackend implements LiveHostBackend {
  readonly starts: Array<[string, number]> = [];
  readonly hosts: FakeHost[] = [];
  failNext: string | null = null;
  closed = 0;
  private port = 50_000;

  prepare(): Promise<void> {
    return Promise.resolve();
  }

  start(side: "base" | "head", group: LiveGroupPlan): Promise<LiveRunningHost> {
    this.starts.push([side, group.index]);
    if (this.failNext !== null) {
      const message = this.failNext;
      this.failNext = null;
      return Promise.reject(new Error(`${message} in /data/worktrees/live-1/head/src/x.ts\nstack line`));
    }
    this.port += 1;
    const host: FakeHost = {
      origin: `http://127.0.0.1:${String(this.port)}`,
      harnessUrlPath: "/.prvision-harness/index.html",
      note: null,
      stopped: false,
      alive: true,
      isAlive: () => host.alive && !host.stopped,
      exitReason: () => (host.alive ? null : "exited with code 1"),
      stop: () => {
        host.stopped = true;
        return Promise.resolve();
      }
    };
    this.hosts.push(host);
    return Promise.resolve(host);
  }

  close(): Promise<void> {
    this.closed += 1;
    return Promise.resolve();
  }
}

function manager(plan: LiveSessionPlan, backend: LiveHostBackend, clock: { t: number }) {
  const changes: LiveHostState[][] = [];
  const instance = new LiveHostManager({
    sessionId: 1,
    plan,
    backend,
    onChange: (hosts) => changes.push(hosts),
    now: () => new Date(clock.t),
    stripPaths: [WORKSPACE.baseDir, WORKSPACE.headDir]
  });
  return { instance, changes };
}

test("buildLivePlan skips rows without a harness, groups like the render engine and indexes groups", () => {
  const rows = [
    ...rowsInGroups(2),
    row({ id: 9, rank: 9, filePath: "src/N.tsx", harnessSource: null }),
    row({ id: 10, rank: 10, filePath: "src/P.tsx", harnessSource: harnessSource("../../src/P") }),
    row({ id: 11, rank: 11, filePath: "src/Q.tsx", harnessSource: harnessSource("../../src/Q") })
  ];
  const plan = planOf(rows);
  assert.deepEqual(
    plan.items.map((item) => item.candidate.componentId),
    [1, 2, 10, 11]
  );
  assert.deepEqual(
    plan.groups.map((group) => [group.index, group.items.map((item) => item.candidate.componentId)]),
    [
      [0, [10, 11]],
      [1, [1]],
      [2, [2]]
    ]
  );
  assert.equal(plan.groups[0]?.key, "none");
  assert.equal(plan.groupOf.get(11), 0);
  assert.equal(plan.groupOf.get(2), 2);
  assert.equal(plan.groupOf.get(9), undefined);
});

test("buildLivePlan renders a renamed row's old path on the base side and reads states from the snapshot", () => {
  const renamed = row({
    id: 4,
    filePath: "src/New.tsx",
    harnessSource: harnessSource(
      "../../src/New",
      '[{ name: "Default", render: () => <Target /> }, { name: "Open", render: () => <Target />, steps: [{ action: "click", target: { by: "text", text: "Go" } }] }]'
    ),
    codeDiff:
      "diff --git a/src/Old.tsx b/src/New.tsx\nsimilarity index 90%\nrename from src/Old.tsx\nrename to src/New.tsx\n@@ -1 +1 @@\n"
  });
  const added = row({
    id: 5,
    filePath: "src/Added.tsx",
    changeKind: "added",
    harnessSource: harnessSource("../../src/Added")
  });
  const plan = planOf([renamed, added]);
  const [first, second] = plan.items;
  assert.deepEqual(first?.paths, { base: "src/Old.tsx", head: "src/New.tsx" });
  assert.deepEqual(
    first.states.map((state) => state.name),
    ["Default", "Open"]
  );
  assert.deepEqual(second?.paths, { base: null, head: "src/Added.tsx" });
  assert.deepEqual(second.sides, { base: false, head: true });
});

test("hosts start lazily per (side, render group); a second open of the group reuses them", async () => {
  const backend = new FakeBackend();
  const plan = planOf([
    ...rowsInGroups(2),
    row({ id: 7, rank: 7, filePath: "src/N.tsx", changeKind: "added", harnessSource: harnessSource("../../src/N") })
  ]);
  const clock = { t: 1_000 };
  const { instance, changes } = manager(plan, backend, clock);
  assert.deepEqual(instance.snapshot(), []);

  const first = instance.open(1);
  assert.equal(first.known, true);
  assert.deepEqual(
    instance.snapshot().map((host) => [host.side, host.status]),
    [
      ["base", "starting"],
      ["head", "starting"]
    ],
    "entries are written as starting before the start"
  );
  await first.done;
  const ready = instance.snapshot();
  assert.deepEqual(
    ready.map((host) => [host.side, host.groupKey, host.componentIds, host.status, host.harnessUrlPath]),
    [
      ["base", plan.groups[1]?.key, [1], "ready", "/.prvision-harness/index.html"],
      ["head", plan.groups[1]?.key, [1], "ready", "/.prvision-harness/index.html"]
    ]
  );
  assert.ok(ready.every((host) => /^http:\/\/127\.0\.0\.1:\d+$/.test(host.origin ?? "")));
  assert.ok(changes.length >= 2);

  await instance.open(1).done;
  assert.equal(backend.starts.length, 2, "no restart for an open host");

  await instance.open(7).done; // added: head only, group "none"
  assert.deepEqual(backend.starts, [
    ["base", 1],
    ["head", 1],
    ["head", 0]
  ]);
  assert.equal(instance.open(999).known, false);
});

test("at most 4 hosts run per side: a fifth stops the least recently used, which restarts when opened again", async () => {
  const backend = new FakeBackend();
  const plan = planOf(rowsInGroups(5));
  const clock = { t: 0 };
  const { instance } = manager(plan, backend, clock);
  for (const id of [1, 2, 3, 4]) {
    clock.t += 1_000;
    await instance.open(id).done;
  }
  clock.t += 1_000;
  await instance.open(1).done; // touches group of 1: now 2 is the least recently used
  clock.t += 1_000;
  await instance.open(5).done;
  const byGroup = (side: string): Array<[string, string]> =>
    instance
      .snapshot()
      .filter((host) => host.side === side)
      .map((host) => [String(host.componentIds[0]), host.status]);
  assert.deepEqual(byGroup("head"), [
    ["1", "ready"],
    ["2", "stopped"],
    ["3", "ready"],
    ["4", "ready"],
    ["5", "ready"]
  ]);
  assert.equal(backend.hosts.filter((host) => host.stopped).length, 2, "one per side");
  const stoppedHost = instance.snapshot().find((host) => host.status === "stopped");
  assert.equal(stoppedHost?.origin, null);

  clock.t += 1_000;
  await instance.open(2).done;
  assert.deepEqual(byGroup("head"), [
    ["1", "ready"],
    ["2", "ready"],
    ["3", "stopped"],
    ["4", "ready"],
    ["5", "ready"]
  ]);
});

test("a failed start marks the host failed with a repo-relative first line; opening again retries", async () => {
  const backend = new FakeBackend();
  const plan = planOf(rowsInGroups(1));
  const { instance } = manager(plan, backend, { t: 0 });
  backend.failNext = "Loading vite.config.ts failed";
  await instance.open(1).done;
  const failed = instance.snapshot().find((host) => host.status === "failed");
  assert.equal(failed?.error, "Loading vite.config.ts failed in src/x.ts");
  assert.equal(failed.origin, null);
  await instance.open(1).done;
  assert.ok(instance.snapshot().every((host) => host.status === "ready"));
});

test("checkHealth marks a dead host failed; stopAll stops every host, is idempotent and closes the backend", async () => {
  const backend = new FakeBackend();
  const plan = planOf(rowsInGroups(2));
  const { instance } = manager(plan, backend, { t: 0 });
  await instance.open(1).done;
  await instance.open(2).done;
  const dead = backend.hosts[0];
  assert.ok(dead);
  dead.alive = false;
  instance.checkHealth();
  const failed = instance.snapshot().filter((host) => host.status === "failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0]?.error ?? "", /stopped unexpectedly \(exited with code 1\)/);

  await instance.stopAll();
  await instance.stopAll();
  assert.ok(backend.hosts.slice(1).every((host) => host.stopped));
  assert.ok(instance.snapshot().every((host) => host.status === "stopped" && host.origin === null));
  assert.equal(instance.open(1).known, false, "no host starts after a stop");
  assert.equal(backend.closed, 2);
});

test("stopAll during a start stops the host the start returns", async () => {
  const releases: Array<() => void> = [];
  const started: FakeHost[] = [];
  const backend: LiveHostBackend = {
    prepare: () => Promise.resolve(),
    close: () => Promise.resolve(),
    start: () =>
      new Promise((resolve) => {
        releases.push(() => {
          const host: FakeHost = {
            origin: "http://127.0.0.1:50001",
            harnessUrlPath: "/index.html",
            note: null,
            stopped: false,
            alive: true,
            isAlive: () => !host.stopped,
            exitReason: () => null,
            stop: () => {
              host.stopped = true;
              return Promise.resolve();
            }
          };
          started.push(host);
          resolve(host);
        });
      })
  };
  const plan = planOf(rowsInGroups(1));
  const { instance } = manager(plan, backend, { t: 0 });
  const open = instance.open(1);
  while (releases.length < 2) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const stopping = instance.stopAll(); // both backend starts are in flight
  for (const release of releases) {
    release();
  }
  await open.done;
  await stopping;
  assert.equal(started.length, 2);
  assert.ok(started.every((host) => host.stopped));
  assert.ok(instance.snapshot().every((host) => host.status === "stopped"));
});

function backendContext(framework: "react_vite" | "angular" = "react_vite"): LiveBackendContext {
  return {
    repository: makeRepositoryModel(
      framework === "angular"
        ? { framework: "angular", appRoot: "apps/web", angularProject: "web", viteConfigPath: null }
        : {}
    ),
    workspace: WORKSPACE,
    frontendOrigins: ORIGINS,
    stripPaths: []
  };
}

test("React live hosts start with the render engine's options plus live, a per-group cache and the group's mocks", async () => {
  const written: Array<[string, number]> = [];
  const started: Array<{ options: ViteHostStartOptions; harnessUrlPath: string }> = [];
  const backend = new ReactLiveBackend(backendContext(), {
    writer: {
      templatesDir: path.join(__dirname, "../../../backend/harness-templates"),
      prepareSide: () => Promise.resolve({ missingStyles: [] }),
      writeComponentHarness: (layout, id) => {
        written.push([layout.side, id]);
        return Promise.resolve(path.join(layout.componentsDir, `${String(id)}.tsx`));
      }
    },
    scanEnvKeys: () => Promise.resolve(["VITE_API"]),
    startViteHost: (options, harnessUrlPath) => {
      started.push({ options, harnessUrlPath });
      return Promise.resolve({
        origin: "http://127.0.0.1:51001",
        harnessUrlPath,
        isAlive: () => true,
        exitReason: () => null,
        stop: () => Promise.resolve()
      } as unknown as ViteHostHandle);
    }
  });
  const plan = planOf(rowsInGroups(2));
  await backend.prepare(plan, new AbortController().signal);
  assert.deepEqual(written, [
    ["base", 1],
    ["head", 1],
    ["base", 2],
    ["head", 2]
  ]);
  const group = plan.groups[1];
  assert.ok(group);
  const host = await backend.start("head", group, new AbortController().signal);
  assert.equal(host.origin, "http://127.0.0.1:51001");
  const call = started[0];
  assert.ok(call);
  assert.equal(call.harnessUrlPath, "/.prvision-harness/index.html");
  assert.deepEqual(call.options.live, { frontendOrigins: ORIGINS });
  assert.equal(call.options.side, "head");
  assert.equal(call.options.groupKey, group.key);
  assert.equal(call.options.viteRoot, WORKSPACE.headDir);
  assert.equal(call.options.configFile, null, "a missing vite.config.ts is auto-detected");
  assert.equal(call.options.cacheDir, path.join(WORKSPACE.headDir, ".prvision-harness", ".vite-cache-live-1"));
  assert.deepEqual(call.options.optimizeEntries, [
    ".prvision-harness/entry.tsx",
    ".prvision-harness/globals.ts",
    ".prvision-harness/components/1.tsx",
    ".prvision-harness/components/2.tsx"
  ]);
  assert.deepEqual(call.options.warmupFiles, [".prvision-harness/entry.tsx", ".prvision-harness/components/2.tsx"]);
  assert.deepEqual(call.options.referencedEnvKeys, ["VITE_API"]);
  assert.deepEqual(call.options.mocks, [
    {
      componentId: 2,
      componentFile: path.join(WORKSPACE.headDir, "src/C2.tsx"),
      specifier: "./api2",
      source: "export const x = 1;"
    }
  ]);
});

test("Angular live hosts build each group into dist/live-<n> and serve it with the live option", async () => {
  const requests: AngularBuildRequest[] = [];
  const registries: number[][] = [];
  const staticOptions: AngularStaticHostOptions[] = [];
  const buildHost: AngularBuildHost = {
    side: "head",
    versions: () => null,
    build: (request) => {
      requests.push(request);
      return Promise.resolve({ status: "success", outputDir: `/out/${request.buildKey}`, durationMs: 1, logs: [] });
    },
    stop: () => Promise.resolve()
  };
  const ctx = backendContext("angular");
  const backend = new AngularLiveBackend(ctx, {
    writer: {
      templatesDir: path.join(__dirname, "../../../backend/harness-templates/angular"),
      prepareSide: () => Promise.resolve({ tsconfigFiles: [], warnings: [] }),
      writeComponentHarness: () => Promise.resolve("x"),
      writeMock: () => Promise.resolve("x"),
      writeRegistry: (_layout: unknown, ids: readonly number[]) => {
        registries.push([...ids]);
        return Promise.resolve();
      }
    } as unknown as AngularLiveBackendDependencies["writer"],
    createBuildHost: () => buildHost,
    createMockResolver: () => Promise.resolve(() => null),
    startStaticHost: (options) => {
      staticOptions.push(options);
      return Promise.resolve({
        origin: "http://127.0.0.1:52001",
        harnessUrlPath: "/index.html",
        isAlive: () => true,
        exitReason: () => null,
        stop: () => Promise.resolve()
      } as never);
    },
    cacheDir: "/data/cache/angular/1"
  });
  // resolveSide reads angular.json from the worktree: give the backend a readable one through a temp workspace
  const fs = await import("node:fs");
  const os = await import("node:os");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prvision-test-live-angular-"));
  try {
    for (const side of ["base", "head"]) {
      fs.mkdirSync(path.join(root, side, "apps/web"), { recursive: true });
      fs.writeFileSync(
        path.join(root, side, "apps/web/angular.json"),
        JSON.stringify({
          version: 1,
          projects: {
            web: {
              root: "",
              projectType: "application",
              architect: {
                build: {
                  builder: "@angular/build:application",
                  options: { browser: "src/main.ts", index: "src/index.html", tsConfig: "tsconfig.app.json" }
                }
              }
            }
          }
        })
      );
    }
    (ctx as { workspace: typeof WORKSPACE }).workspace = {
      ...WORKSPACE,
      baseDir: path.join(root, "base"),
      headDir: path.join(root, "head")
    };
    const plan = planOf(
      rowsInGroups(2).map((component) => {
        component.setFilePath(`apps/web/src/C${String(component.id)}.ts`);
        return component;
      })
    );
    await backend.prepare(plan, new AbortController().signal);
    const group = plan.groups[1];
    assert.ok(group);
    const host = await backend.start("head", group, new AbortController().signal);
    assert.equal(host.harnessUrlPath, "/index.html");
    assert.equal(host.note, null);
    assert.equal(requests[0]?.buildKey, "live-1");
    const outputPath: unknown = requests[0].options.outputPath;
    assert.ok(
      JSON.stringify(outputPath).includes(".prvision-harness/dist/live-1"),
      `output path ${JSON.stringify(outputPath)}`
    );
    assert.deepEqual(registries, [[2]]);
    assert.equal(staticOptions[0]?.distDir, "/out/live-1");
    assert.deepEqual(staticOptions[0].live, { frontendOrigins: ORIGINS });
    await backend.close();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
