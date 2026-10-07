/**
 * React render engine for `replaced` rows (00 §17): each side renders its own harness and target file, mocks are
 * per side, a failed side repairs its own harness, and the base harness of a kept repair is persisted to the
 * base_harness columns.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Table } from "../../../backend/src/enums";
import {
  QueryHandlerRenderPersistence,
  RenderService,
  buildRenderInputs,
  deriveRenderStatus,
  type RenderComponentInput,
  type RepairHarnessFn
} from "../../../backend/src/services/visualizations/pipeline/render-service";
import { HarnessWorkspaceWriter } from "../../../backend/src/services/visualizations/pipeline/render/harness-workspace";
import type {
  ComponentCandidate,
  HarnessGenerationResult,
  HarnessRenderError,
  HarnessRepairOutcome
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
  type FakeRenderEnv,
  type ScriptedOutcome
} from "./helpers/render-stubs";

const COMPONENT = "export default function C() { return null; }\n";
const OLD = "src/components/NoteForm.tsx";
const NEW = "src/components/NoteFormModal.tsx";
const BASE_MOCK = { specifier: "@/api/notes", source: "export const load = () => [];" };
const HEAD_MOCK = { specifier: "@/api/drafts", source: "export const draft = null;" };

type RepairScript = (side: "base" | "head") => HarnessRepairOutcome;

interface Setup {
  env: FakeRenderEnv;
  service: RenderService;
  hosts: FakeViteHostFactory;
  session: FakeBrowserSession;
  persistence: InMemoryPersistence;
  repairCalls: Array<{ componentId: number; previous: HarnessGenerationResult; renderError: HarnessRenderError }>;
}

function setup(t: TestContext, outcomes: Record<string, ScriptedOutcome> = {}, repair?: RepairScript): Setup {
  const env = fakePipelineContext(t, { files: { [OLD]: { base: COMPONENT }, [NEW]: { head: COMPONENT } } });
  const hosts = new FakeViteHostFactory();
  const session = new FakeBrowserSession(outcomes);
  const persistence = new InMemoryPersistence();
  const repairCalls: Setup["repairCalls"] = [];
  const repairHarness: RepairHarnessFn = (componentId, previous, renderError) => {
    repairCalls.push({ componentId, previous, renderError });
    return Promise.resolve(
      repair?.(renderError.targetSide ?? "head") ?? { ok: false, reason: "budget_exhausted", message: "no" }
    );
  };
  const service = new RenderService({
    repairHarness,
    createPersistence: () => persistence,
    artifactStore: new FakeArtifactStore(env.dataDir),
    workspaceWriter: new HarnessWorkspaceWriter(env.templatesDir),
    launchBrowser: () => Promise.resolve(session),
    startViteHost: hosts.start,
    scanEnvKeys: () => Promise.resolve([]),
    now: () => Date.now()
  });
  return { env, service, hosts, session, persistence, repairCalls };
}

function replacedCandidate(componentId: number): ComponentCandidate {
  return {
    ...candidate(componentId, NEW, "replaced"),
    predecessor: { filePath: OLD, exportName: "default", displayName: "NoteForm", evidence: [] }
  };
}

function replacedHarness(componentId: number): HarnessGenerationResult {
  const base = harnessFor(componentId, OLD, [BASE_MOCK], "Base notes.");
  return {
    ...harnessFor(componentId, NEW, [HEAD_MOCK], "Head notes."),
    baseHarness: {
      harnessSource: base.harnessSource,
      mockedModules: base.mockedModules,
      notes: base.notes,
      states: base.states,
      origin: base.origin,
      libraryEntryId: base.libraryEntryId
    }
  };
}

function replacedInput(componentId: number): RenderComponentInput {
  return buildRenderInputs(
    [replacedCandidate(componentId)],
    [replacedHarness(componentId)],
    []
  )[0] as RenderComponentInput;
}

const harnessFile = (dir: string, id: number): string =>
  fs.readFileSync(path.join(dir, `.prvision-harness/components/${String(id)}.tsx`), "utf8");

test("buildRenderInputs gives a replaced row R's file as its base path", () => {
  const input = replacedInput(3);
  assert.equal(input.basePath, OLD);
  assert.equal(input.candidate.filePath, NEW);
});

test("RenderService renders R's harness on base and A's on head, each with its own mocks", async (t) => {
  const s = setup(t);
  const results = await s.service.renderAll(s.env.handle.context, [replacedInput(3)]);
  assert.equal(deriveRenderStatus(results[0] ?? { componentId: 3, base: null, head: null, states: [] }), "rendered");
  assert.match(harnessFile(s.env.baseDir, 3), /from "\.\.\/\.\.\/src\/components\/NoteForm"/);
  assert.doesNotMatch(harnessFile(s.env.baseDir, 3), /NoteFormModal/);
  assert.match(harnessFile(s.env.headDir, 3), /from "\.\.\/\.\.\/src\/components\/NoteFormModal"/);
  const bySide = (side: "base" | "head"): string[] =>
    s.hosts.started
      .filter((options) => options.side === side)
      .flatMap((options) => options.mocks.map((m) => m.specifier));
  assert.deepEqual(bySide("base"), [BASE_MOCK.specifier]);
  assert.deepEqual(bySide("head"), [HEAD_MOCK.specifier]);
  const payload = s.persistence.latest(3);
  assert.equal(payload?.baseImagePath, "artifacts/1/3/base.png");
  assert.equal(payload.headImagePath, "artifacts/1/3/head.png");
  assert.equal(payload.baseHarness, undefined, "the original attempt never rewrites a harness");
  assert.deepEqual(s.repairCalls, []);
});

test("RenderService repairs only the failed side's own harness of a replaced row and persists it to the base columns", async (t) => {
  const fixedBase = `${replacedHarness(3).baseHarness?.harnessSource ?? ""}// repaired base\n`;
  const s = setup(
    t,
    { "3:base:0": { ok: false, kind: "render_error", error: "[render_error] NoteForm needs a provider" } },
    (side) => ({
      ok: true,
      result: {
        componentId: 3,
        harnessSource: fixedBase,
        mockedModules: [],
        notes: `Repaired ${side}.`,
        states: [{ name: "Default", steps: [] }],
        origin: "written",
        libraryEntryId: null
      }
    })
  );
  const results = await s.service.renderAll(s.env.handle.context, [replacedInput(3)]);
  assert.equal(s.repairCalls.length, 1, "one side failed: one repair, although the head side rendered");
  assert.deepEqual(s.repairCalls[0]?.renderError, {
    sides: ["base"],
    kind: "render_error",
    message: "[render_error] NoteForm needs a provider",
    otherSideMessage: null,
    targetSide: "base"
  });
  assert.equal(s.repairCalls[0].previous.notes, "Base notes.");
  assert.match(s.repairCalls[0].previous.harnessSource, /src\/components\/NoteForm"/);
  assert.match(harnessFile(s.env.baseDir, 3), /\/\/ repaired base/);
  assert.doesNotMatch(harnessFile(s.env.headDir, 3), /repaired/);
  assert.equal(deriveRenderStatus(results[0] ?? { componentId: 3, base: null, head: null, states: [] }), "rendered");
  const payload = s.persistence.latest(3);
  assert.deepEqual(payload?.baseHarness, {
    harnessSource: fixedBase,
    harnessNotes: "Repaired base.",
    mockedModules: []
  });
  assert.equal(payload.harness?.harnessNotes, "Head notes.", "the head harness is unchanged");
  assert.ok(
    s.env.handle.console.has("info", "Repairing the base harness for NoteForm after a render failure (render_error).")
  );
});

test("RenderService appends a base-side repair verdict to the base harness notes", async (t) => {
  const s = setup(t, { "3:base:0": { ok: false, kind: "module_load", error: "[module_load] x" } }, () => ({
    ok: false,
    reason: "component_defect",
    message: "defect",
    notesAppendix: "Repair check: defect."
  }));
  await s.service.renderAll(s.env.handle.context, [replacedInput(3)]);
  const payload = s.persistence.latest(3);
  assert.equal(payload?.baseHarnessNotes, "Base notes.\n\nRepair check: defect.");
  assert.equal(payload.harnessNotes, undefined);
  assert.equal(payload.renderStatus, "partial");
});

test("QueryHandlerRenderPersistence writes the base harness of a kept repair and base verdict notes", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const queryHandler = {
    update: (values: Record<string, unknown>) => {
      calls.push(values);
      return Promise.resolve({ status: 200, data: { rowsAffected: 1 } });
    }
  } as unknown as QueryHandler;
  const persistence = new QueryHandlerRenderPersistence(1, queryHandler);
  const base = {
    renderStatus: "rendered" as const,
    baseImagePath: "artifacts/1/3/base.png",
    headImagePath: "artifacts/1/3/head.png",
    imageWidth: 10,
    imageHeight: 10,
    baseError: null,
    headError: null
  };
  await persistence.saveRenderResult(3, {
    ...base,
    harness: { harnessSource: "head", harnessNotes: "h", mockedModules: [] },
    baseHarness: { harnessSource: "base", harnessNotes: "b", mockedModules: [BASE_MOCK] }
  });
  await persistence.saveRenderResult(3, { ...base, baseHarnessNotes: "verdict" });
  assert.deepEqual(
    [calls[0]?.baseHarnessSource, calls[0]?.baseHarnessNotes, calls[0]?.baseMockedModules, calls[0]?.harnessSource],
    ["base", "b", [BASE_MOCK], "head"]
  );
  assert.equal(calls[1]?.baseHarnessNotes, "verdict");
  assert.equal(calls[1].baseHarnessSource, undefined);
  assert.equal(calls[1].harnessNotes, undefined);
  assert.equal(Table.VISUALIZATION_COMPONENTS, "visualization_components");
});
