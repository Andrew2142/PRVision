import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  HARNESS_MAX_REPAIRS_PER_COMPONENT,
  RENDER_COLD_START_ALLOWANCE_MS,
  RENDER_STAGE_TIMEOUT_MS,
  RENDER_TIMEOUT_MS
} from "../../../backend/src/config-consts";
import { Table } from "../../../backend/src/enums";
import {
  QueryHandlerRenderPersistence,
  RenderService,
  buildRenderInputs,
  chooseAttempt,
  deriveRenderStatus,
  type ItemAttempt,
  type RenderBrowserSession,
  type RenderComponentInput,
  type RepairHarnessFn
} from "../../../backend/src/services/visualizations/pipeline/render-service";
import { BrowserLaunchError } from "../../../backend/src/services/visualizations/pipeline/render/browser-session";
import { HarnessWorkspaceWriter } from "../../../backend/src/services/visualizations/pipeline/render/harness-workspace";
import { ViteHostStartError } from "../../../backend/src/services/visualizations/pipeline/render/vite-host-client";
import type { RenderSide } from "../../../backend/src/services/visualizations/pipeline/render/render-types";
import {
  PipelineStepError,
  type ComponentRenderResult,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type RenderSideResult
} from "../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../backend/src/utilities";
import {
  FakeArtifactStore,
  FakeBrowserSession,
  FakeViteHostFactory,
  InMemoryPersistence,
  candidate,
  fakePipelineContext,
  harnessFor,
  renderInput,
  type FakeRenderEnv,
  type HostScript,
  type ScriptedOutcome
} from "./helpers/render-stubs";

type RepairScript = (
  componentId: number,
  previous: HarnessGenerationResult,
  error: HarnessRenderError
) => HarnessRepairOutcome | Promise<HarnessRepairOutcome>;

interface Harness {
  env: FakeRenderEnv;
  service: RenderService;
  hosts: FakeViteHostFactory;
  sessions: FakeBrowserSession[];
  persistence: InMemoryPersistence;
  artifacts: FakeArtifactStore;
  repairCalls: Array<{ componentId: number; previous: HarnessGenerationResult; renderError: HarnessRenderError }>;
  launches: () => number;
}

interface SetupOptions {
  files?: Record<string, { base?: string; head?: string }>;
  outcomes?: Record<string, ScriptedOutcome | ScriptedOutcome[]>;
  sessions?: FakeBrowserSession[];
  hostScript?: HostScript;
  hostWarnings?: string[];
  repair?: RepairScript;
  launchBrowser?: () => Promise<RenderBrowserSession>;
  templatesDir?: string;
  now?: () => number;
  dependencyDrift?: boolean;
}

const COMPONENT = "export default function C() { return null; }\n";

function both(...files: string[]): Record<string, { base?: string; head?: string }> {
  return Object.fromEntries(files.map((file) => [file, { base: COMPONENT, head: COMPONENT }]));
}

function setup(t: TestContext, options: SetupOptions = {}): Harness {
  const env = fakePipelineContext(t, { files: options.files ?? {}, dependencyDrift: options.dependencyDrift ?? false });
  const hosts = new FakeViteHostFactory(options.hostScript, options.hostWarnings);
  const sessions = options.sessions ?? [new FakeBrowserSession(options.outcomes ?? {})];
  const persistence = new InMemoryPersistence();
  const artifacts = new FakeArtifactStore(env.dataDir);
  const repairCalls: Harness["repairCalls"] = [];
  let launches = 0;
  const repairHarness: RepairHarnessFn = async (componentId, previous, renderError) => {
    repairCalls.push({ componentId, previous, renderError });
    const script =
      options.repair ?? ((): HarnessRepairOutcome => ({ ok: false, reason: "budget_exhausted", message: "no" }));
    return script(componentId, previous, renderError);
  };
  const service = new RenderService({
    repairHarness,
    createPersistence: () => persistence,
    artifactStore: artifacts,
    workspaceWriter: new HarnessWorkspaceWriter(options.templatesDir ?? env.templatesDir),
    launchBrowser:
      options.launchBrowser ??
      (() => {
        const session = sessions[Math.min(launches, sessions.length - 1)];
        launches += 1;
        assert.ok(session);
        return Promise.resolve(session);
      }),
    startViteHost: hosts.start,
    scanEnvKeys: () => Promise.resolve([]),
    now: options.now ?? (() => Date.now())
  });
  return { env, service, hosts, sessions, persistence, artifacts, repairCalls, launches: () => launches };
}

function sideOf(results: ComponentRenderResult[], componentId: number, side: RenderSide): RenderSideResult | null {
  const result = results.find((entry) => entry.componentId === componentId);
  assert.ok(result, `result for ${String(componentId)}`);
  return result[side];
}

function rendersOf(session: FakeBrowserSession, componentId: number, side?: RenderSide): number[] {
  return session.renders
    .filter((render) => render.componentId === componentId && (side === undefined || render.side === side))
    .map((render) => render.attempt);
}

function repaired(componentId: number, filePath: string, notes = "Repaired notes."): HarnessGenerationResult {
  return {
    ...harnessFor(componentId, filePath, [], notes),
    harnessSource: `${harnessFor(componentId, filePath).harnessSource}// repaired\n`
  };
}

const MODULE_LOAD: ScriptedOutcome = { ok: false, kind: "module_load", error: "[module_load] Module load failed: x" };

test("renders both sides of a modified component and persists rendered status with relative image paths", async (t) => {
  const h = setup(t, { files: both("src/Button.tsx"), outcomes: { "1:head": { ok: true, width: 120, height: 44 } } });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(1, "src/Button.tsx")]);
  assert.equal(results.length, 1);
  assert.deepEqual(sideOf(results, 1, "base")?.imagePath, "artifacts/1/1/base.png");
  assert.deepEqual(sideOf(results, 1, "head")?.imagePath, "artifacts/1/1/head.png");
  const payload = h.persistence.latest(1);
  assert.deepEqual(payload, {
    renderStatus: "rendered",
    baseImagePath: "artifacts/1/1/base.png",
    headImagePath: "artifacts/1/1/head.png",
    imageWidth: 120,
    imageHeight: 44,
    baseError: null,
    headError: null
  });
  for (const side of ["base", "head"] as const) {
    assert.ok(fs.existsSync(path.join(h.env.dataDir, `artifacts/1/1/${side}.png`)));
  }
  assert.deepEqual(
    fs.readdirSync(path.join(h.env.dataDir, "artifacts/1/1")).sort(),
    ["base.png", "head.png"],
    "no temp images left"
  );
  assert.ok(h.env.handle.console.has("info", "Rendered Button: base ok (100×40), head ok (120×44)."));
  assert.ok(h.env.handle.console.has("info", /^Render stage finished in \d+ s: 1 rendered, 0 partial, 0 failed\.$/));
  h.env.handle.console.assertStagesAreStatusNames();
  assert.equal(h.hosts.liveCount(), 0);
  assert.equal(h.sessions[0]?.closeCalls, 1);
});

test("added component renders head only and returns base null", async (t) => {
  const h = setup(t, { files: { "src/Badge.tsx": { head: COMPONENT } } });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(2, "src/Badge.tsx", { changeKind: "added" })
  ]);
  assert.equal(sideOf(results, 2, "base"), null);
  assert.equal(sideOf(results, 2, "head")?.ok, true);
  assert.equal(h.persistence.latest(2)?.renderStatus, "rendered");
  assert.deepEqual(
    h.hosts.started.map((options) => options.side),
    ["head"]
  );
  assert.deepEqual(rendersOf(h.sessions[0] ?? new FakeBrowserSession(), 2, "base"), []);
});

test("removed component renders base only and returns head null", async (t) => {
  const h = setup(t, { files: { "src/Old.tsx": { base: COMPONENT } } });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(3, "src/Old.tsx", { changeKind: "removed" })
  ]);
  assert.equal(sideOf(results, 3, "head"), null);
  assert.equal(sideOf(results, 3, "base")?.ok, true);
  const payload = h.persistence.latest(3);
  assert.equal(payload?.renderStatus, "rendered");
  assert.equal(payload.headImagePath, null);
  assert.equal(payload.baseImagePath, "artifacts/1/3/base.png");
});

test("buildRenderInputs omits candidates without a harness and sets basePath from renames", () => {
  const candidates = [
    candidate(1, "src/B.tsx", "modified", 1),
    candidate(2, "src/New.tsx", "modified", 0),
    candidate(3, "src/Added.tsx", "added", 2),
    candidate(4, "src/NoHarness.tsx", "modified", 3)
  ];
  const harnesses = [harnessFor(3, "src/Added.tsx"), harnessFor(1, "src/B.tsx"), harnessFor(2, "src/New.tsx")];
  const inputs = buildRenderInputs(candidates, harnesses, [
    { path: "src/New.tsx", status: "R", previousPath: "src/Old.tsx" },
    { path: "src/B.tsx", status: "M" }
  ]);
  assert.deepEqual(
    inputs.map((input) => [input.candidate.componentId, input.basePath]),
    [
      [2, "src/Old.tsx"],
      [1, "src/B.tsx"],
      [3, null]
    ]
  );
  assert.equal(inputs[0]?.harness.componentId, 2);
});

test("renamed component: base harness file imports the previous path, head file the new path", async (t) => {
  const h = setup(t, { files: { "src/OldButton.tsx": { base: COMPONENT }, "src/NewButton.tsx": { head: COMPONENT } } });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(5, "src/NewButton.tsx", { basePath: "src/OldButton.tsx" })
  ]);
  assert.equal(deriveRenderStatus(results[0] ?? { componentId: 5, base: null, head: null }), "rendered");
  const baseFile = fs.readFileSync(path.join(h.env.baseDir, ".prvision-harness/components/5.tsx"), "utf8");
  const headFile = fs.readFileSync(path.join(h.env.headDir, ".prvision-harness/components/5.tsx"), "utf8");
  assert.match(baseFile, /from "\.\.\/\.\.\/src\/OldButton"/);
  assert.doesNotMatch(baseFile, /NewButton/);
  assert.match(headFile, /from "\.\.\/\.\.\/src\/NewButton"/);
});

test("missing component file on an expected side yields file_missing for that side", async (t) => {
  const h = setup(t, { files: { "src/Card.tsx": { base: COMPONENT } } });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(6, "src/Card.tsx")]);
  const head = sideOf(results, 6, "head");
  assert.equal(head?.ok, false);
  assert.match(head.error ?? "", /^\[file_missing\] src\/Card\.tsx does not exist on the head side\./);
  assert.equal(sideOf(results, 6, "base")?.ok, true);
  assert.equal(h.persistence.latest(6)?.renderStatus, "partial");
  assert.equal(h.repairCalls.length, 0);
  assert.deepEqual(
    h.hosts.started.map((options) => options.side),
    ["base"]
  );
  assert.ok(h.env.handle.console.has("warn", "Card: src/Card.tsx does not exist on the head side."));
});

test("base-only failure yields partial without repair", async (t) => {
  const h = setup(t, { files: both("src/Card.tsx"), outcomes: { "7:base": MODULE_LOAD } });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(7, "src/Card.tsx")]);
  assert.equal(sideOf(results, 7, "base")?.ok, false);
  const payload = h.persistence.latest(7);
  assert.equal(payload?.renderStatus, "partial");
  assert.equal(payload.baseImagePath, null);
  assert.equal(payload.headImagePath, "artifacts/1/7/head.png");
  assert.equal(payload.baseError, "[module_load] Module load failed: x");
  assert.equal(h.repairCalls.length, 0);
  assert.ok(h.env.handle.console.has("warn", "Card: base failed (module_load): Module load failed: x"));
});

test("head-only failure of a modified component yields partial without repair (stack inside the component)", async (t) => {
  const h = setup(t, {
    files: both("src/Card.tsx"),
    outcomes: {
      "8:head": {
        ok: false,
        kind: "render_error",
        error: "[render_error] Render error: intentional render failure\nStack:\n  at Card (src/Card.tsx:3:9)"
      }
    }
  });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(8, "src/Card.tsx")]);
  assert.equal(sideOf(results, 8, "head")?.ok, false);
  const payload = h.persistence.latest(8);
  assert.equal(payload?.renderStatus, "partial");
  assert.match(payload.headError ?? "", /intentional render failure/);
  assert.equal(payload.headImagePath, null);
  assert.equal(payload.baseImagePath, "artifacts/1/8/base.png");
  assert.equal(h.repairCalls.length, 0);
});

test("both sides failing with module_load trigger one repair with a HarnessRenderError and re-render both sides", async (t) => {
  const h = setup(t, {
    files: both("src/Cart.tsx"),
    outcomes: {
      "9:head:0": { ok: false, kind: "module_load", error: "[module_load] head failed" },
      "9:base:0": { ok: false, kind: "module_load", error: "[module_load] base failed" }
    },
    repair: (componentId) => ({ ok: true, result: repaired(componentId, "src/Cart.tsx") })
  });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(9, "src/Cart.tsx")]);
  assert.equal(h.repairCalls.length, 1);
  assert.deepEqual(h.repairCalls[0]?.renderError, {
    sides: ["base", "head"],
    kind: "module_load",
    message: "[module_load] head failed",
    otherSideMessage: "[module_load] base failed"
  });
  assert.equal(h.repairCalls[0].previous.notes, "Initial notes.");
  const session = h.sessions[0] ?? new FakeBrowserSession();
  assert.deepEqual(rendersOf(session, 9, "base"), [0, 1]);
  assert.deepEqual(rendersOf(session, 9, "head"), [0, 1]);
  assert.equal(deriveRenderStatus(results[0] ?? { componentId: 9, base: null, head: null }), "rendered");
  assert.ok(
    h.env.handle.console.has("info", "Repairing the harness for Cart after a render failure (head: module_load).")
  );
  assert.ok(h.env.handle.console.has("info", "Repaired harness rendered Cart: base ok (100×40), head ok (100×40)."));
  // The repaired harness file was written on both sides before the re-render.
  for (const dir of [h.env.baseDir, h.env.headDir]) {
    assert.match(fs.readFileSync(path.join(dir, ".prvision-harness/components/9.tsx"), "utf8"), /\/\/ repaired/);
  }
});

test("head failure of an added component triggers repair; base failure of a removed component triggers repair", async (t) => {
  const h = setup(t, {
    files: { "src/New.tsx": { head: COMPONENT }, "src/Gone.tsx": { base: COMPONENT } },
    outcomes: {
      "10:head:0": { ok: false, kind: "render_error", error: "[render_error] boom" },
      "11:base:0": { ok: false, kind: "timeout", error: "[timeout] Timed out" }
    }
  });
  await h.service.renderAll(h.env.handle.context, [
    renderInput(10, "src/New.tsx", { changeKind: "added" }),
    renderInput(11, "src/Gone.tsx", { changeKind: "removed" })
  ]);
  assert.deepEqual(
    h.repairCalls.map((call) => [
      call.componentId,
      call.renderError.sides,
      call.renderError.kind,
      call.renderError.otherSideMessage
    ]),
    [
      [10, ["head"], "render_error", null],
      [11, ["base"], "timeout", null]
    ]
  );
});

test("repaired attempt is persisted with the new harness fields and replaces both images", async (t) => {
  const fixed = repaired(12, "src/Cart.tsx");
  fixed.mockedModules = [{ specifier: "@/api", source: "export const x = 1;" }];
  const h = setup(t, {
    files: both("src/Cart.tsx"),
    outcomes: { "12:head:0": MODULE_LOAD, "12:base:0": MODULE_LOAD, "12:head:1": { ok: true, width: 50, height: 20 } },
    repair: () => ({ ok: true, result: fixed })
  });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(12, "src/Cart.tsx")]);
  const payload = h.persistence.latest(12);
  assert.equal(payload?.renderStatus, "rendered");
  assert.deepEqual(payload.harness, {
    harnessSource: fixed.harnessSource,
    harnessNotes: "Repaired notes.",
    mockedModules: fixed.mockedModules
  });
  assert.equal(payload.imageWidth, 50);
  assert.equal(h.persistence.saves.filter((save) => save.componentId === 12).length, 2);
  assert.equal(h.persistence.saves[0]?.payload.harness, undefined, "the original finalize never carries a harness");
  assert.deepEqual(fs.readdirSync(path.join(h.env.dataDir, "artifacts/1/12")).sort(), ["base.png", "head.png"]);
  assert.equal(sideOf(results, 12, "head")?.width, 50);
  // The repaired attempt is rendered by new hosts that receive its mocks.
  const repairedHosts = h.hosts.started.filter((options) => options.mocks.length > 0);
  assert.equal(repairedHosts.length, 2);
});

test("repaired attempt that is worse keeps the original result, deletes temp images and never writes the repaired harness", async (t) => {
  // With the repair trigger (every present side failed) the original always scores 0, so a repaired attempt can
  // never be strictly worse in a real run; chooseAttempt covers the comparison and this run covers the tie rule.
  const original: ItemAttempt = {
    attemptNo: 0,
    harness: harnessFor(1, "src/A.tsx"),
    base: { result: okSide("base"), kind: null, tempImagePath: null },
    head: { result: failedSide("head"), kind: "module_load", tempImagePath: null }
  };
  const worse: ItemAttempt = {
    attemptNo: 1,
    harness: harnessFor(1, "src/A.tsx"),
    base: { result: failedSide("base"), kind: "module_load", tempImagePath: null },
    head: { result: failedSide("head"), kind: "module_load", tempImagePath: null }
  };
  assert.equal(chooseAttempt("head", original, worse), "original");

  const h = setup(t, {
    files: both("src/Cart.tsx"),
    outcomes: { "13:head": MODULE_LOAD, "13:base": MODULE_LOAD },
    repair: () => ({ ok: true, result: repaired(13, "src/Cart.tsx") })
  });
  await h.service.renderAll(h.env.handle.context, [renderInput(13, "src/Cart.tsx")]);
  const payload = h.persistence.latest(13);
  assert.equal(payload?.renderStatus, "failed");
  assert.ok(payload.harness, "ties go to the repaired attempt, whose harness is persisted");
  assert.deepEqual(
    fs.existsSync(path.join(h.env.dataDir, "artifacts/1/13"))
      ? fs.readdirSync(path.join(h.env.dataDir, "artifacts/1/13"))
      : [],
    []
  );
});

test("component_defect verdict appends notesAppendix to harness_notes and keeps the original result", async (t) => {
  const h = setup(t, {
    files: both("src/Cart.tsx"),
    outcomes: { "14:head": MODULE_LOAD, "14:base": MODULE_LOAD },
    repair: () => ({
      ok: false,
      reason: "component_defect",
      message: "The component itself throws.",
      notesAppendix: "Repair check: the component throws on render."
    })
  });
  await h.service.renderAll(h.env.handle.context, [renderInput(14, "src/Cart.tsx")]);
  const saves = h.persistence.saves.filter((save) => save.componentId === 14);
  assert.equal(saves.length, 2);
  const [first, second] = saves;
  assert.ok(first && second);
  assert.equal(second.payload.harnessNotes, "Initial notes.\n\nRepair check: the component throws on render.");
  assert.equal(second.payload.harness, undefined);
  assert.equal(second.payload.renderStatus, first.payload.renderStatus);
  assert.equal(second.payload.headError, first.payload.headError);
  assert.equal(rendersOf(h.sessions[0] ?? new FakeBrowserSession(), 14).length, 2, "no re-render");
  assert.ok(
    h.env.handle.console.has(
      "warn",
      "Harness repair for Cart: the failure looks like a defect in the component itself."
    )
  );
});

test("repair outcome ok:false or a thrown error keeps the original result", async (t) => {
  const h = setup(t, {
    files: both("src/A.tsx", "src/B.tsx"),
    outcomes: { "15:head": MODULE_LOAD, "15:base": MODULE_LOAD, "16:head": MODULE_LOAD, "16:base": MODULE_LOAD },
    repair: (componentId) => {
      if (componentId === 15) {
        return { ok: false, reason: "ai_error", message: "rate limited" };
      }
      throw new Error("bug in repair");
    }
  });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(15, "src/A.tsx"),
    renderInput(16, "src/B.tsx")
  ]);
  assert.equal(results.length, 2);
  for (const id of [15, 16]) {
    assert.equal(h.persistence.saves.filter((save) => save.componentId === id).length, 1);
    assert.equal(h.persistence.latest(id)?.renderStatus, "failed");
  }
  assert.ok(h.env.handle.console.has("info", "No repaired harness for A (ai_error); keeping the first result."));
  assert.ok(h.env.handle.console.has("warn", "Harness repair for B failed: bug in repair"));
});

test("repairs never exceed HARNESS_MAX_REPAIRS_PER_COMPONENT", async (t) => {
  assert.equal(HARNESS_MAX_REPAIRS_PER_COMPONENT, 1);
  const h = setup(t, {
    files: both("src/Cart.tsx"),
    outcomes: { "17:head": MODULE_LOAD, "17:base": MODULE_LOAD },
    repair: (componentId) => ({ ok: true, result: repaired(componentId, "src/Cart.tsx") })
  });
  await h.service.renderAll(h.env.handle.context, [renderInput(17, "src/Cart.tsx")]);
  assert.equal(h.repairCalls.length, 1);
  assert.deepEqual(rendersOf(h.sessions[0] ?? new FakeBrowserSession(), 17, "head"), [0, 1]);
});

test("vite_unavailable failures are not repaired", async (t) => {
  const h = setup(t, {
    files: both("src/Cart.tsx"),
    hostScript: () =>
      new ViteHostStartError("Vite is not installed for this repository (looked from /x).", "vite_not_found", null)
  });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(18, "src/Cart.tsx")]);
  assert.equal(h.repairCalls.length, 0);
  for (const side of ["base", "head"] as const) {
    assert.match(sideOf(results, 18, side)?.error ?? "", /^\[vite_unavailable\] Vite is not installed/);
  }
  assert.equal(h.persistence.latest(18)?.renderStatus, "failed");
});

test("sticky host start failure fails every group on that side without starting new hosts", async (t) => {
  const h = setup(t, {
    files: both("src/A.tsx", "src/B.tsx"),
    hostScript: (options) =>
      options.side === "base"
        ? new ViteHostStartError("Loading vite.config.ts failed on the base side: boom", "config_error", null)
        : "ready"
  });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(19, "src/A.tsx"),
    renderInput(20, "src/B.tsx", { mocks: [{ specifier: "@/api", source: "export const x = 1;" }] })
  ]);
  assert.equal(h.hosts.started.filter((options) => options.side === "base").length, 1);
  assert.equal(h.hosts.started.filter((options) => options.side === "head").length, 2);
  for (const id of [19, 20]) {
    assert.match(sideOf(results, id, "base")?.error ?? "", /Loading vite\.config\.ts failed on the base side: boom/);
    assert.equal(sideOf(results, id, "head")?.ok, true);
    assert.equal(h.persistence.latest(id)?.renderStatus, "partial");
  }
  assert.equal(
    h.env.handle.console.events.filter(
      (event) => event.level === "error" && event.message.startsWith("Vite could not start on the base side")
    ).length,
    1
  );
});

test("non-sticky host start failure is retried for the next group", async (t) => {
  let baseStarts = 0;
  const h = setup(t, {
    files: both("src/A.tsx", "src/B.tsx"),
    hostScript: (options) => {
      if (options.side !== "base") {
        return "ready";
      }
      baseStarts += 1;
      return baseStarts === 1
        ? new ViteHostStartError(
            "The Vite dev server for the base side did not become ready within 60 s.",
            "timeout",
            null
          )
        : "ready";
    }
  });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(21, "src/A.tsx"),
    renderInput(22, "src/B.tsx", { mocks: [{ specifier: "@/api", source: "export const x = 1;" }] })
  ]);
  assert.equal(baseStarts, 2);
  assert.match(sideOf(results, 21, "base")?.error ?? "", /did not become ready within 60 s/);
  assert.equal(sideOf(results, 22, "base")?.ok, true);
  assert.ok(h.env.handle.console.has("warn", /^Vite on the base side failed to start for render group 1: /));
});

test("groups start base and head hosts in parallel and stop them before the next group starts", async (t) => {
  const h = setup(t, { files: both("src/A.tsx", "src/B.tsx") });
  await h.service.renderAll(h.env.handle.context, [
    renderInput(23, "src/A.tsx"),
    renderInput(24, "src/B.tsx", { mocks: [{ specifier: "@/api", source: "export const x = 1;" }] })
  ]);
  const events = h.hosts.events;
  assert.equal(events.length, 8);
  assert.deepEqual(events.slice(0, 2).sort(), ["start:base:none", "start:head:none"]);
  assert.deepEqual(events.slice(2, 4).sort(), ["stop:base:none", "stop:head:none"]);
  assert.ok(events.slice(4, 6).every((event) => event.startsWith("start:")));
  assert.ok(events.slice(6, 8).every((event) => event.startsWith("stop:")));
  assert.equal(h.hosts.liveCount(), 0);
});

test("components are grouped by mock fingerprint and only that group's mocks are passed to the host", async (t) => {
  const mock = { specifier: "@/api", source: "export const fetchUser = () => null;" };
  const h = setup(t, { files: both("src/A.tsx", "src/B.tsx", "src/C.tsx") });
  await h.service.renderAll(h.env.handle.context, [
    renderInput(25, "src/A.tsx"),
    renderInput(26, "src/B.tsx", { mocks: [mock] }),
    renderInput(27, "src/C.tsx")
  ]);
  const head = h.hosts.started.filter((options) => options.side === "head");
  assert.equal(head.length, 2);
  assert.equal(head[0]?.groupKey, "none");
  assert.deepEqual(head[0].mocks, []);
  assert.deepEqual(head[0].warmupFiles, [
    ".prvision-harness/entry.tsx",
    ".prvision-harness/components/25.tsx",
    ".prvision-harness/components/27.tsx"
  ]);
  assert.deepEqual(head[1]?.mocks, [
    { componentId: 26, componentFile: path.join(h.env.headDir, "src/B.tsx"), specifier: "@/api", source: mock.source }
  ]);
  assert.deepEqual(head[1].optimizeEntries, [
    ".prvision-harness/entry.tsx",
    ".prvision-harness/globals.ts",
    ".prvision-harness/components/25.tsx",
    ".prvision-harness/components/26.tsx",
    ".prvision-harness/components/27.tsx"
  ]);
  const base = h.hosts.started.find((options) => options.side === "base" && options.mocks.length > 0);
  assert.equal(base?.mocks[0]?.componentFile, path.join(h.env.baseDir, "src/B.tsx"));
});

test("first render on each host gets the cold start allowance", async (t) => {
  const h = setup(t, { files: both("src/A.tsx", "src/B.tsx") });
  await h.service.renderAll(h.env.handle.context, [renderInput(28, "src/A.tsx"), renderInput(29, "src/B.tsx")]);
  const session = h.sessions[0] ?? new FakeBrowserSession();
  for (const side of ["base", "head"] as const) {
    const timeouts = session.renders.filter((render) => render.side === side).map((render) => render.timeoutMs);
    assert.deepEqual(timeouts, [RENDER_TIMEOUT_MS + RENDER_COLD_START_ALLOWANCE_MS, RENDER_TIMEOUT_MS]);
    const checks = session.renders.filter((render) => render.side === side).map((render) => render.checkStylesheets);
    assert.deepEqual(checks[0], { globalStylesExpected: true, tailwindMajor: 4 });
    assert.equal(checks[1], null, "stylesheet health is checked on the first successful render per host only");
  }
});

test("infra-retryable outcome is retried once", async (t) => {
  const churn: ScriptedOutcome = {
    ok: false,
    kind: "module_load",
    error: "[module_load] Outdated Optimize Dep",
    infraRetryable: true
  };
  const h = setup(t, {
    files: both("src/A.tsx", "src/B.tsx"),
    outcomes: { "30:head": [churn, { ok: true }], "31:head": [churn, churn, { ok: true }] }
  });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(30, "src/A.tsx"),
    renderInput(31, "src/B.tsx")
  ]);
  const session = h.sessions[0] ?? new FakeBrowserSession();
  assert.equal(rendersOf(session, 30, "head").length, 2);
  assert.equal(sideOf(results, 30, "head")?.ok, true);
  assert.equal(sideOf(results, 31, "head")?.ok, false, "only one infrastructure retry");
  assert.equal(rendersOf(session, 31, "head").filter((attempt) => attempt === 0).length, 2);
});

test("cancellation before a group stops scheduling, cleans up and returns only finished components", async (t) => {
  const h = setup(t, { files: both("src/A.tsx", "src/B.tsx") });
  h.env.handle.context.isCancelled = () => Promise.resolve(h.persistence.saves.length >= 1);
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(32, "src/A.tsx"),
    renderInput(33, "src/B.tsx", { mocks: [{ specifier: "@/api", source: "export const x = 1;" }] })
  ]);
  assert.deepEqual(
    results.map((result) => result.componentId),
    [32]
  );
  assert.equal(h.hosts.started.length, 2, "no hosts for the second group");
  assert.equal(h.persistence.latest(33), undefined);
  assert.equal(h.hosts.liveCount(), 0);
  assert.equal(h.sessions[0]?.closeCalls, 1);
});

test("abort during an in-flight render closes contexts and hosts and does not persist that component", async (t) => {
  const h = setup(t, { files: both("src/A.tsx") });
  const session = h.sessions[0] ?? new FakeBrowserSession();
  session.beforeOutcome = async (input) => {
    if (input.host.side === "head") {
      h.env.handle.cancel();
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(34, "src/A.tsx")]);
  assert.deepEqual(results, []);
  assert.equal(h.persistence.saves.length, 0);
  assert.ok(session.closeAllContextsCalls >= 1);
  assert.equal(h.hosts.liveCount(), 0);
  assert.ok(h.hosts.hosts.every((host) => host.stopCalls >= 1));
  const dir = path.join(h.env.dataDir, "artifacts/1/34");
  assert.deepEqual(fs.existsSync(dir) ? fs.readdirSync(dir) : [], [], "temp images removed");
});

test("stage budget exhaustion persists remaining components as failed", async (t) => {
  let saves = 0;
  const h = setup(t, { files: both("src/A.tsx", "src/B.tsx", "src/C.tsx") });
  const clock = (): number => (saves >= 1 ? RENDER_STAGE_TIMEOUT_MS + 1 : 0);
  const original = h.persistence.saveRenderResult.bind(h.persistence);
  h.persistence.saveRenderResult = async (componentId, payload) => {
    await original(componentId, payload);
    saves += 1;
  };
  (h.service as unknown as { deps: { now: () => number } }).deps.now = clock;
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(35, "src/A.tsx"),
    renderInput(36, "src/B.tsx"),
    renderInput(37, "src/C.tsx")
  ]);
  assert.deepEqual(
    results.map((result) => result.componentId),
    [35, 36, 37]
  );
  assert.equal(h.persistence.latest(35)?.renderStatus, "rendered");
  for (const id of [36, 37]) {
    const payload = h.persistence.latest(id);
    assert.equal(payload?.renderStatus, "failed");
    assert.match(
      payload.headError ?? "",
      /^\[budget_exceeded\] The render stage exceeded its time budget before this component finished\./
    );
  }
  assert.ok(
    h.env.handle.console.has(
      "warn",
      "The render stage exceeded its 15-minute budget; 2 component(s) were not rendered."
    )
  );
});

test("browser launch failure throws PipelineStepError and starts no hosts", async (t) => {
  const h = setup(t, {
    files: both("src/A.tsx"),
    launchBrowser: () =>
      Promise.reject(
        new BrowserLaunchError(
          "Chromium for Playwright is not installed. Run `npx playwright install chromium` in the PRVision folder.",
          "Executable doesn't exist"
        )
      )
  });
  await assert.rejects(h.service.renderAll(h.env.handle.context, [renderInput(38, "src/A.tsx")]), (error: unknown) => {
    assert.ok(error instanceof PipelineStepError);
    assert.equal(error.stage, "rendering");
    assert.match(error.userMessage, /npx playwright install chromium/);
    return true;
  });
  assert.equal(h.hosts.started.length, 0);
});

test("persistence failure throws PipelineStepError after closing hosts and the browser", async (t) => {
  const h = setup(t, { files: both("src/A.tsx") });
  h.persistence.failWith = new Error("db down");
  await assert.rejects(h.service.renderAll(h.env.handle.context, [renderInput(39, "src/A.tsx")]), (error: unknown) => {
    assert.ok(error instanceof PipelineStepError);
    assert.equal(error.userMessage, "Could not save render results.");
    assert.equal(error.code, "RENDER_PERSIST_FAILED");
    return true;
  });
  assert.equal(h.hosts.liveCount(), 0);
  assert.equal(h.sessions[0]?.closeCalls, 1);
});

test("persistence updates use (values, { id, visualizationId }, Table.VISUALIZATION_COMPONENTS)", async () => {
  const calls: Array<{ values: Record<string, unknown>; conditions: unknown; table: unknown }> = [];
  let status = 200;
  const queryHandler = {
    update: (values: Record<string, unknown>, conditions: unknown, table: unknown) => {
      calls.push({ values, conditions, table });
      return Promise.resolve({ status, data: { rowsAffected: 1 } });
    }
  } as unknown as QueryHandler;
  const persistence = new QueryHandlerRenderPersistence(42, queryHandler);
  const base = {
    renderStatus: "partial" as const,
    baseImagePath: "artifacts/42/7/base.png",
    headImagePath: null,
    imageWidth: 10,
    imageHeight: 20,
    baseError: null,
    headError: "[module_load] x"
  };
  await persistence.saveRenderResult(7, base);
  await persistence.saveRenderResult(7, {
    ...base,
    harness: { harnessSource: "src", harnessNotes: "notes", mockedModules: [{ specifier: "a", source: "b" }] }
  });
  await persistence.saveRenderResult(7, { ...base, harnessNotes: "verdict" });
  assert.deepEqual(calls[0], {
    values: {
      renderStatus: "partial",
      baseImagePath: "artifacts/42/7/base.png",
      headImagePath: null,
      imageWidth: 10,
      imageHeight: 20,
      baseError: null,
      headError: "[module_load] x"
    },
    conditions: { id: 7, visualizationId: 42 },
    table: Table.VISUALIZATION_COMPONENTS
  });
  assert.deepEqual(
    [calls[1]?.values.harnessSource, calls[1]?.values.harnessNotes, calls[1]?.values.mockedModules],
    ["src", "notes", [{ specifier: "a", source: "b" }]]
  );
  assert.equal(calls[2]?.values.harnessNotes, "verdict");
  assert.equal(calls[2].values.harnessSource, undefined);
  status = 404;
  await assert.rejects(persistence.saveRenderResult(7, base), /visualization_components update failed for id 7/);
});

test("missing harness templates throw PipelineStepError before any host starts", async (t) => {
  const h = setup(t, { files: both("src/A.tsx"), templatesDir: "/nonexistent/templates" });
  await assert.rejects(h.service.renderAll(h.env.handle.context, [renderInput(40, "src/A.tsx")]), (error: unknown) => {
    assert.ok(error instanceof PipelineStepError);
    assert.equal(
      error.userMessage,
      "PRVision's harness templates are missing (backend/harness-templates). Reinstall PRVision."
    );
    return true;
  });
  assert.equal(h.hosts.started.length, 0);
  assert.equal(h.launches(), 0);
});

test("browser disconnect triggers one relaunch", async (t) => {
  const first = new FakeBrowserSession({
    "41:head": { ok: false, kind: "browser", error: "[browser] Target crashed", infraRetryable: true }
  });
  const second = new FakeBrowserSession();
  const h = setup(t, { files: both("src/A.tsx", "src/B.tsx"), sessions: [first, second] });
  const results = await h.service.renderAll(h.env.handle.context, [
    renderInput(41, "src/A.tsx"),
    renderInput(42, "src/B.tsx")
  ]);
  assert.equal(h.launches(), 2);
  assert.equal(first.closeCalls >= 1, true);
  assert.equal(sideOf(results, 41, "head")?.ok, true, "the infrastructure retry ran on the relaunched browser");
  assert.equal(rendersOf(second, 42).length, 2);
  assert.equal(
    h.env.handle.console.events.filter((event) => event.message === "Chromium disconnected; restarting the browser.")
      .length,
    1
  );
});

test("results are returned in input order", async (t) => {
  const h = setup(t, { files: both("src/A.tsx", "src/B.tsx", "src/C.tsx") });
  const inputs: RenderComponentInput[] = [
    renderInput(45, "src/C.tsx", { rank: 2 }),
    renderInput(43, "src/A.tsx", { rank: 0, mocks: [{ specifier: "@/api", source: "export const x = 1;" }] }),
    renderInput(44, "src/B.tsx", { rank: 1 })
  ];
  const results = await h.service.renderAll(h.env.handle.context, inputs);
  assert.deepEqual(
    results.map((result) => result.componentId),
    [45, 43, 44]
  );
});

test("persisted errors and console events contain no secrets and no absolute data-dir or worktree paths", async (t) => {
  const h = setup(t, { files: both("src/A.tsx") });
  const leak = `[module_load] Module load failed: token ghp_TESTabcdefghijklmnopqrstuvwxyz0123456789 at ${h.env.headDir}/src/A.tsx and ${h.env.baseDir}/src/A.tsx`;
  h.sessions[0] = new FakeBrowserSession({
    "46:head": { ok: false, kind: "module_load", error: leak },
    "46:base": { ok: false, kind: "module_load", error: leak }
  });
  const results = await h.service.renderAll(h.env.handle.context, [renderInput(46, "src/A.tsx")]);
  const payload = h.persistence.latest(46);
  for (const text of [
    payload?.baseError ?? "",
    payload?.headError ?? "",
    ...h.env.handle.console.messages(),
    sideOf(results, 46, "head")?.error ?? ""
  ]) {
    assert.doesNotMatch(text, /ghp_TEST/);
    assert.ok(!text.includes(h.env.dataDir), `no data dir in: ${text}`);
    assert.ok(!text.includes(path.dirname(h.env.headDir)), `no worktree path in: ${text}`);
  }
  assert.match(payload?.headError ?? "", /at src\/A\.tsx/);
});

test("deriveRenderStatus maps side outcomes to rendered, partial and failed", () => {
  const ok = okSide("head");
  const fail = failedSide("head");
  assert.equal(deriveRenderStatus({ componentId: 1, base: okSide("base"), head: ok }), "rendered");
  assert.equal(deriveRenderStatus({ componentId: 1, base: okSide("base"), head: fail }), "partial");
  assert.equal(deriveRenderStatus({ componentId: 1, base: failedSide("base"), head: ok }), "partial");
  assert.equal(deriveRenderStatus({ componentId: 1, base: failedSide("base"), head: fail }), "failed");
  assert.equal(deriveRenderStatus({ componentId: 1, base: null, head: ok }), "rendered");
  assert.equal(deriveRenderStatus({ componentId: 1, base: null, head: fail }), "failed");
  assert.equal(deriveRenderStatus({ componentId: 1, base: okSide("base"), head: null }), "rendered");
  assert.equal(deriveRenderStatus({ componentId: 1, base: null, head: null }), "failed");
});

test("chooseAttempt prefers a primary-side success and breaks ties toward the repaired attempt", () => {
  const attempt = (base: boolean | null, head: boolean | null): ItemAttempt => ({
    attemptNo: 0,
    harness: harnessFor(1, "src/A.tsx"),
    base:
      base === null
        ? null
        : {
            result: base ? okSide("base") : failedSide("base"),
            kind: base ? null : "module_load",
            tempImagePath: null
          },
    head:
      head === null
        ? null
        : { result: head ? okSide("head") : failedSide("head"), kind: head ? null : "module_load", tempImagePath: null }
  });
  assert.equal(chooseAttempt("head", attempt(false, false), attempt(false, true)), "repaired");
  assert.equal(chooseAttempt("head", attempt(false, false), attempt(false, false)), "repaired", "tie");
  assert.equal(chooseAttempt("head", attempt(false, true), attempt(true, false)), "original", "primary success wins");
  assert.equal(chooseAttempt("head", attempt(true, true), attempt(false, true)), "original");
  assert.equal(chooseAttempt("base", attempt(true, null), attempt(false, null)), "original");
  assert.equal(chooseAttempt("base", attempt(false, null), attempt(true, null)), "repaired");
});

function okSide(side: RenderSide): RenderSideResult {
  return {
    side,
    ok: true,
    imagePath: `artifacts/1/1/${side}.png`,
    width: 10,
    height: 10,
    error: null,
    consoleErrors: [],
    durationMs: 1
  };
}

function failedSide(side: RenderSide): RenderSideResult {
  return {
    side,
    ok: false,
    imagePath: null,
    width: null,
    height: null,
    error: "[module_load] x",
    consoleErrors: [],
    durationMs: 1
  };
}
