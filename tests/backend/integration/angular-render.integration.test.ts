/**
 * Angular render engine integration test (15 §5.9.3 "angular-render"): hand-written harnesses through
 * AngularRenderService against detached worktrees of the sample-angular-monorepo fixture, with the repository's own
 * @angular/build (Architect child processes), the in-process static hosts and real Chromium. Repair is a stub;
 * persistence is 10's InMemoryPersistence. Gated on PRVISION_IT_RENDER=1 or PRVISION_INTEGRATION=1.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { PIXELMATCH_THRESHOLD } from "../../../backend/src/config-consts";
import { ProjectDetectionService } from "../../../backend/src/services/repositories/project-detection-service";
import { targetImportStatement } from "../../../backend/src/services/visualizations/pipeline/harness-prompts";
import {
  ArtifactStoreRenderAdapter,
  type RenderComponentInput,
  type RepairHarnessFn
} from "../../../backend/src/services/visualizations/pipeline/render-service";
import { AngularHostClient } from "../../../backend/src/services/visualizations/pipeline/render/angular/angular-host-client";
import { AngularRenderService } from "../../../backend/src/services/visualizations/pipeline/render/angular/angular-render-service";
import { AngularStaticHost } from "../../../backend/src/services/visualizations/pipeline/render/angular/angular-static-host";
import type {
  ComponentCandidate,
  ComponentRenderResult,
  HarnessRenderError,
  PipelineContext
} from "../../../backend/src/types/visualization-pipeline";
import { ArtifactStore } from "../../../backend/src/utilities/services/artifact-store";
import type { ConsoleRecorder } from "../helpers/console-recorder";
import { createPipelineContext } from "../helpers/pipeline-context";
import { makeTempDir } from "../helpers/temp-dir";
import { isolatedGitEnv } from "../helpers/temp-git-repo";
import { InMemoryPersistence } from "../render/helpers/render-stubs";
import {
  ANGULAR_APP_ROOT,
  ANGULAR_PROJECT,
  angularFixtureHarness,
  requireAngularFixtureRepo,
  type AngularFixtureBranch
} from "./helpers/angular-fixture";
import { itSkip } from "./helpers/it-flags";

const SKIP = itSkip("render");
const web = (relative: string): string => `${ANGULAR_APP_ROOT}/${relative}`;

const cleanups: Array<() => void> = [];
after(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const COMPONENTS = {
  badge: { id: 201, className: "BadgeComponent", file: web("src/app/shared/badge/badge.component.ts") },
  orderList: {
    id: 202,
    className: "OrderListComponent",
    file: web("src/app/orders/order-list/order-list.component.ts")
  },
  signalCard: {
    id: 203,
    className: "SignalCardComponent",
    file: web("src/app/shared/signal-card/signal-card.component.ts")
  },
  legacyChip: {
    id: 204,
    className: "LegacyChipComponent",
    file: web("src/app/shared/legacy-chip/legacy-chip.module.ts")
  },
  bell: {
    id: 205,
    className: "NotificationBellComponent",
    file: web("src/app/notifications/notification-bell.component.ts")
  },
  app: { id: 206, className: "AppComponent", file: web("src/app/app.component.ts") }
} as const;
type ComponentKey = keyof typeof COMPONENTS;

/** A harness whose host template binds an input SignalCardComponent does not have (NG8002 in the harness file). */
const BROKEN_ID = 207;
const BROKEN_HARNESS = `import { Component } from '@angular/core';
import { definePrvisionHarness } from '../harness-api';
import { SignalCardComponent } from '../../src/app/shared/signal-card/signal-card.component';

@Component({
  selector: 'prvision-host',
  imports: [SignalCardComponent],
  template: '<app-signal-card [titel]="label" />',
})
class PrvisionHost {
  label = 'Orders this week';
}

export default definePrvisionHarness({ component: PrvisionHost });
`;

function candidateFor(key: ComponentKey, rank: number): ComponentCandidate {
  const c = COMPONENTS[key];
  return {
    componentId: c.id,
    filePath: c.file,
    exportName: c.className,
    displayName: c.className,
    changeKind: "modified",
    rank,
    codeDiff: null,
    reason: "Component code changed"
  };
}

function input(key: ComponentKey, rank: number): RenderComponentInput {
  const candidate = candidateFor(key, rank);
  const statement = targetImportStatement(candidate, ANGULAR_APP_ROOT);
  // "" as the prompt: optional inputs (SignalCard's trend) are left out, like a model that saw no such input.
  const { harnessSource, notes } = angularFixtureHarness(candidate.displayName, statement, "");
  return {
    candidate,
    harness: { componentId: candidate.componentId, harnessSource, mockedModules: [], notes },
    basePath: candidate.filePath
  };
}

function brokenInput(rank: number): RenderComponentInput {
  return {
    candidate: { ...candidateFor("signalCard", rank), componentId: BROKEN_ID },
    harness: { componentId: BROKEN_ID, harnessSource: BROKEN_HARNESS, mockedModules: [], notes: "Broken on purpose." },
    basePath: COMPONENTS.signalCard.file
  };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: isolatedGitEnv(), encoding: "utf8" }).trim();
}

function readPng(file: string): PNG {
  return PNG.sync.read(fs.readFileSync(file));
}

function diffRatio(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) {
    return 1;
  }
  const changed = pixelmatch(a.data, b.data, undefined, a.width, a.height, { threshold: PIXELMATCH_THRESHOLD });
  return changed / (a.width * a.height);
}

function portRefusesConnections(origin: string): Promise<boolean> {
  const { hostname, port } = new URL(origin);
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port: Number(port) });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      resolve(true);
    });
  });
}

/** Command lines of every live descendant of this test process. */
function descendantCommands(): string[] {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  const children = new Map<number, Array<{ pid: number; args: string }>>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) {
      const list = children.get(Number(m[2])) ?? [];
      list.push({ pid: Number(m[1]), args: m[3] ?? "" });
      children.set(Number(m[2]), list);
    }
  }
  const found: string[] = [];
  const queue = [process.pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift() ?? 0) ?? []) {
      found.push(child.args);
      queue.push(child.pid);
    }
  }
  return found;
}

interface RunOutput {
  results: ComponentRenderResult[];
  persistence: InMemoryPersistence;
  repairCalls: Array<{ componentId: number; renderError: HarnessRenderError }>;
  console: ConsoleRecorder;
  origins: string[];
  dataDir: string;
}

describe("Angular render engine against the fixture (real Angular build + Chromium)", { timeout: 600_000 }, () => {
  let fixture = "";
  let clone = "";
  let root = "";
  let repository: Partial<PipelineContext["repository"]> = {};
  let nodeModulesBefore: string[] = [];
  let angularCacheBefore = false;
  let visualizationId = 9100;
  const runs: Record<string, RunOutput> = {};

  function worktree(name: string, ref: AngularFixtureBranch): string {
    const dir = path.join(root, name);
    git(clone, ["worktree", "add", "--quiet", "--detach", dir, git(clone, ["rev-parse", ref])]);
    // 07 links the clone's app node_modules into every worktree (15 §5.4.6).
    fs.symlinkSync(
      path.join(clone, ANGULAR_APP_ROOT, "node_modules"),
      path.join(dir, ANGULAR_APP_ROOT, "node_modules")
    );
    return dir;
  }

  async function render(
    baseRef: AngularFixtureBranch,
    headRef: AngularFixtureBranch,
    inputs: RenderComponentInput[]
  ): Promise<RunOutput> {
    visualizationId += 1;
    const dataDirTemp = makeTempDir("it-angular-render-data");
    cleanups.push(dataDirTemp.cleanup);
    const dataDir = dataDirTemp.path;
    const persistence = new InMemoryPersistence();
    const repairCalls: RunOutput["repairCalls"] = [];
    const origins: string[] = [];
    const repairHarness: RepairHarnessFn = (componentId, _previous, renderError) => {
      repairCalls.push({ componentId, renderError });
      return Promise.resolve({ ok: false, reason: "budget_exhausted", message: "scripted: no repair" });
    };
    const handle = createPipelineContext({
      visualizationId,
      dataDir,
      repositoryPath: clone,
      baseDir: worktree(`${String(visualizationId)}-base`, baseRef),
      headDir: worktree(`${String(visualizationId)}-head`, headRef),
      repository
    });
    const service = new AngularRenderService({
      repairHarness,
      createPersistence: () => persistence,
      artifactStore: new ArtifactStoreRenderAdapter(new ArtifactStore(dataDir)),
      startStaticHost: async (options) => {
        const host = await AngularStaticHost.start(options);
        origins.push(host.origin);
        return host;
      },
      cacheDirFor: (id) => path.join(dataDir, "cache", "angular", String(id))
    });
    const results = await service.renderAll(handle.context, inputs);
    handle.console.assertStagesAreStatusNames();
    return { results, persistence, repairCalls, console: handle.console, origins, dataDir };
  }

  function side(run: RunOutput, componentId: number, which: "base" | "head"): PNG {
    const result = run.results.find((entry) => entry.componentId === componentId);
    const sideResult = result?.[which];
    assert.ok(sideResult?.ok, `component ${String(componentId)} ${which}: ${sideResult?.error ?? "missing"}`);
    assert.ok(sideResult.imagePath);
    return readPng(path.join(run.dataDir, sideResult.imagePath));
  }

  before(async () => {
    if (SKIP !== false) {
      return;
    }
    fixture = requireAngularFixtureRepo();
    nodeModulesBefore = fs.readdirSync(path.join(fixture, ANGULAR_APP_ROOT, "node_modules")).sort();
    angularCacheBefore = fs.existsSync(path.join(fixture, ANGULAR_APP_ROOT, ".angular"));
    const temp = makeTempDir("it-angular-render");
    cleanups.push(temp.cleanup);
    root = temp.path;
    clone = path.join(root, "clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", fixture, clone], { env: isolatedGitEnv() });
    for (const branch of ["feature/badge-restyle", "qa/build-error"]) {
      git(clone, ["branch", "--quiet", branch, `origin/${branch}`]);
    }
    fs.symlinkSync(
      path.join(fixture, ANGULAR_APP_ROOT, "node_modules"),
      path.join(clone, ANGULAR_APP_ROOT, "node_modules")
    );
    const detected = await new ProjectDetectionService().detect(clone, {
      appRoot: ANGULAR_APP_ROOT,
      angularProject: ANGULAR_PROJECT
    });
    assert.ok(detected.ok, JSON.stringify(detected));
    const p = detected.project;
    repository = {
      id: 77,
      localPath: clone,
      framework: "angular",
      appRoot: p.appRoot,
      angularProject: p.angularProject,
      angularBuildConfiguration: p.angularBuildConfiguration,
      viteConfigPath: null,
      tsconfigPath: p.tsconfigPath,
      entryFilePath: p.entryFilePath,
      globalStylePaths: p.globalStylePaths
    };

    const all = (Object.keys(COMPONENTS) as ComponentKey[]).map((key, rank) => input(key, rank));
    runs.mainFirst = await render("main", "main", all);
    runs.mainSecond = await render("main", "main", all);
    runs.badge = await render("main", "feature/badge-restyle", [
      input("badge", 0),
      input("orderList", 1),
      brokenInput(2)
    ]);
    runs.buildError = await render("main", "qa/build-error", [
      input("orderList", 0),
      input("badge", 1),
      input("signalCard", 2)
    ]);
  });

  test("main vs main: every component renders on both sides with zero difference", { skip: SKIP }, () => {
    const run = runs.mainFirst;
    assert.ok(run);
    for (const c of Object.values(COMPONENTS)) {
      const base = side(run, c.id, "base");
      const head = side(run, c.id, "head");
      assert.equal(Buffer.compare(base.data, head.data), 0, `${c.className}: base and head byte-identical`);
      assert.equal(run.persistence.latest(c.id)?.renderStatus, "rendered", c.className);
    }
    assert.equal(run.repairCalls.length, 0);
    assert.deepEqual(run.console.messages("error"), []);
  });

  test("main vs main: two runs over separate worktrees and builds are byte-identical", { skip: SKIP }, () => {
    const one = runs.mainFirst;
    const two = runs.mainSecond;
    assert.ok(one && two);
    for (const c of Object.values(COMPONENTS)) {
      for (const which of ["base", "head"] as const) {
        assert.equal(
          Buffer.compare(side(one, c.id, which).data, side(two, c.id, which).data),
          0,
          `${c.className} ${which}`
        );
      }
    }
  });

  test("Tailwind utilities from the repository's own setup apply", { skip: SKIP }, () => {
    const run = runs.mainFirst;
    assert.ok(run);
    // The danger badge is bg-rose-100 (#ffe4e6): those pixels exist only when Tailwind generated the utility.
    const badge = side(run, COMPONENTS.badge.id, "head");
    let rose = 0;
    for (let i = 0; i < badge.data.length; i += 4) {
      const [r, g, b] = [badge.data[i] ?? 0, badge.data[i + 1] ?? 0, badge.data[i + 2] ?? 0];
      if (r > 240 && g < 235 && g > 200 && b > 220 && b < 240) {
        rose += 1;
      }
    }
    assert.ok(rose > 50, `rose-100 badge fill pixels: ${String(rose)}`);
  });

  test("feature/badge-restyle: the badge differs by more than 1 %", { skip: SKIP }, () => {
    const run = runs.badge;
    assert.ok(run);
    const ratio = diffRatio(side(run, COMPONENTS.badge.id, "base"), side(run, COMPONENTS.badge.id, "head"));
    assert.ok(ratio > 0.01, `badge ratio ${String(ratio)}`);
    assert.equal(run.persistence.latest(COMPONENTS.orderList.id)?.renderStatus, "rendered");
  });

  test("a broken harness fails only itself: attributed, excluded, one extra build per side", { skip: SKIP }, () => {
    const run = runs.badge;
    assert.ok(run);
    const broken = run.persistence.latest(BROKEN_ID);
    assert.equal(broken?.renderStatus, "failed");
    for (const error of [broken.baseError, broken.headError]) {
      assert.match(error ?? "", /^\[module_load\] /);
      assert.match(error ?? "", /Angular build error in the harness/);
      assert.match(error ?? "", /NG8002: Can't bind to 'titel'/);
      assert.match(error ?? "", /\.prvision-harness\/components\/207\.ts/);
    }
    for (const which of ["base", "head"]) {
      assert.ok(
        run.console.has(
          "warn",
          `Angular build on the ${which} side failed for 1 harness(es); rebuilding without them.`
        ),
        run.console.messages().join("\n")
      );
    }
    // Both sides failed with a repairable kind: repair is requested once (the stub declines).
    const calls = run.repairCalls.filter((call) => call.componentId === BROKEN_ID);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.renderError.kind, "module_load");
    assert.deepEqual(
      run.repairCalls.map((call) => call.componentId),
      [BROKEN_ID]
    );
    // One static host per successful build: the second build of each side (the first failed).
    assert.equal(run.origins.length, 2, run.origins.join(", "));
  });

  test(
    "qa/build-error: head module_load with NG8002, base renders, the other components still render",
    { skip: SKIP },
    () => {
      const run = runs.buildError;
      assert.ok(run);
      const orderList = run.persistence.latest(COMPONENTS.orderList.id);
      assert.equal(orderList?.renderStatus, "partial", run.console.messages().join("\n"));
      assert.equal(orderList.baseError, null);
      assert.match(orderList.headError ?? "", /^\[module_load\] /);
      assert.match(
        orderList.headError ?? "",
        /Angular build error in src\/app\/orders\/order-list\/order-list\.component\.html/
      );
      assert.match(orderList.headError ?? "", /NG8002: Can't bind to 'size'/);
      for (const key of ["badge", "signalCard"] as const) {
        const c = COMPONENTS[key];
        const payload = run.persistence.latest(c.id);
        assert.equal(
          payload?.renderStatus,
          "rendered",
          `${c.className}: ${String(payload?.headError)}\n${run.console.messages().join("\n")}`
        );
        assert.equal(diffRatio(side(run, c.id, "base"), side(run, c.id, "head")), 0, `${c.className} unchanged`);
      }
      // A one-side failure of a two-sided component is never repaired (00 §14.7).
      assert.deepEqual(run.repairCalls, []);
      // The error is in OrderListComponent's own template: it is failed and the rest rebuilt once (no bisect; the
      // harness-attribution warning is for harness errors only). One static host per side: base build 1, head build 2.
      assert.ok(!run.console.has("warn", /rebuilding without them/), run.console.messages().join("\n"));
      assert.equal(run.origins.length, 2, run.origins.join(", "));
    }
  );

  test("NotificationBellComponent renders with the never-stable warning on both sides", { skip: SKIP }, () => {
    const run = runs.mainFirst;
    assert.ok(run);
    for (const which of ["base", "head"]) {
      assert.ok(
        run.console.has(
          "warn",
          `NotificationBellComponent (${which}): the app never became stable within 5 s (pending timers or requests); captured anyway.`
        ),
        run.console.messages().join("\n")
      );
    }
    assert.ok(
      !run.console.has("warn", /^(BadgeComponent|SignalCardComponent|LegacyChipComponent) \(\w+\): the app never/)
    );
  });

  test(
    "cleanup: no Angular host or Chromium processes, no listening static hosts, node_modules untouched",
    { skip: SKIP },
    async () => {
      assert.equal(AngularHostClient.liveCount(), 0);
      const origins = Object.values(runs).flatMap((run) => run.origins);
      assert.ok(origins.length >= 6);
      for (const origin of origins) {
        assert.ok(await portRefusesConnections(origin), `${origin} closed`);
      }
      const pattern = /angular-host-process|esbuild|chrom(e|ium)|headless_shell|ms-playwright/i;
      let leftovers: string[] = [];
      for (let attempt = 0; attempt < 25; attempt += 1) {
        leftovers = descendantCommands().filter((args) => pattern.test(args) && !args.startsWith("ps "));
        if (leftovers.length === 0) {
          break;
        }
        await delay(200);
      }
      assert.deepEqual(leftovers, []);
      assert.deepEqual(fs.readdirSync(path.join(fixture, ANGULAR_APP_ROOT, "node_modules")).sort(), nodeModulesBefore);
      assert.equal(
        fs.existsSync(path.join(fixture, ANGULAR_APP_ROOT, ".angular")),
        angularCacheBefore,
        "no .angular cache in the fixture"
      );
      assert.equal(git(clone, ["status", "--porcelain"]), "", "clone untouched");
    }
  );
});
