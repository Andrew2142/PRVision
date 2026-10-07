import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Table } from "../../../backend/src/enums";
import {
  candidateFromRow,
  HarnessRepairWorkerService,
  renamedFrom,
  repairTargets,
  type HarnessRepairWorkerDependencies
} from "../../../backend/src/services/harness-library/harness-repair-worker-service";
import { LibraryJobConsole } from "../../../backend/src/services/harness-library/library-job-console";
import type { RenderComponentInput } from "../../../backend/src/services/visualizations/pipeline/render-service";
import type {
  HarnessGenerationStageDeps,
  PipelineStepFactories,
  RenderStageDeps
} from "../../../backend/src/services/visualizations/pipeline/stage-registry";
import type { HarnessLibraryEntryRecord, SaveWrittenHarnessInput } from "../../../backend/src/types/harness-library";
import {
  PipelineStepError,
  type AiProvider,
  type ComponentRenderResult,
  type HarnessGenerationResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type PipelineContext,
  type RenderSideResult
} from "../../../backend/src/types/visualization-pipeline";
import { ModelHandler } from "../../../backend/src/utilities/handlers/model-handler";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import type { ResolvedAiSettings } from "../../../backend/src/utilities/services/ai/ai-provider";
import type { LibraryJob } from "../../../backend/src/utilities/services/queue-service";
import { VisualizationComponentModel, VisualizationComponentStateModel } from "../../../backend/src/models";
import { makeComponentRow, makeLibraryJobRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { FakeLibraryQueue } from "../helpers/fake-library-queue";
import { FakeLibraryStore, libraryEntry } from "../helpers/fake-library-store";
import { InMemoryQueryHandler, type Row } from "../helpers/query-handler-stub";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const JOBS = Table.HARNESS_LIBRARY_JOBS;
const ROWS = Table.VISUALIZATION_COMPONENTS;
const STATES = Table.VISUALIZATION_COMPONENT_STATES;
const SETTINGS: ResolvedAiSettings = {
  provider: "anthropic_api",
  model: "claude-opus-5-5",
  harnessEffort: "high",
  summaryEffort: "medium",
  anthropicApiKey: { state: "present", value: "sk-ant-test" }
};
const CALL_USAGE = { inputTokens: 50_000, outputTokens: 1_000, calls: 1 };

function harness(name: string, label = "old"): string {
  return [
    'import { definePrvisionHarness } from "../harness-api";',
    `import ${name} from "../../src/components/${name}";`,
    "export default definePrvisionHarness({",
    "  states: [",
    `    { name: "Default", render: () => <${name} label="${label}" /> },`,
    `    { name: "Empty", render: () => <${name} items={[]} /> },`,
    "  ],",
    "});",
    ""
  ].join("\n");
}

type RepairBehaviour = HarnessRepairOutcome extends infer O
  ? O extends { ok: false; reason: infer R }
    ? R
    : "ok"
  : never;
type RenderBehaviour = "ok" | "fail_head" | "infra_head" | "throw";

function side(
  sideName: "base" | "head",
  ok: boolean,
  failureKind: RenderSideResult["failureKind"] = "render_error"
): RenderSideResult {
  return {
    side: sideName,
    ok,
    imagePath: ok ? `artifacts/10/x/${sideName}.png` : null,
    width: ok ? 100 : null,
    height: ok ? 50 : null,
    error: ok ? null : `render_error: boom on ${sideName}`,
    consoleErrors: [],
    durationMs: 3,
    failureKind: ok ? null : failureKind
  };
}

/** Scriptable 09/10/11 fakes as the repair job sees them. */
class FakeEngine {
  repairs = new Map<string, RepairBehaviour>();
  renderBehaviour = new Map<number, RenderBehaviour>();
  repairCalls: Array<{ componentId: number; previous: HarnessGenerationResult; error: HarnessRenderError }> = [];
  generationDeps: Array<HarnessGenerationStageDeps | undefined> = [];
  contexts: PipelineContext[] = [];
  renderDeps: RenderStageDeps[] = [];
  renderInputs: RenderComponentInput[] = [];
  diffs: ComponentRenderResult[][] = [];
  afterRepair: (componentId: number) => void = () => undefined;

  steps(): PipelineStepFactories {
    const unused = (): never => {
      throw new Error("not used by repairs");
    };
    return {
      changeAnalysis: unused,
      libraryResolution: unused,
      structuralDiff: unused,
      summary: unused,
      harnessGeneration: (ctx, _queries, deps) => {
        this.contexts.push(ctx);
        this.generationDeps.push(deps);
        return {
          generateAll: unused,
          repairHarness: async (componentId, previous, error) => {
            this.repairCalls.push({ componentId, previous, error });
            const key = `${String(componentId)}:${error.targetSide ?? "row"}`;
            const behaviour = this.repairs.get(key) ?? this.repairs.get(String(componentId)) ?? "ok";
            await deps?.usageRecorder?.add({ ...CALL_USAGE });
            this.afterRepair(componentId);
            if (behaviour === "ok") {
              return {
                ok: true,
                result: {
                  componentId,
                  harnessSource: harness("Button", `repaired-${error.targetSide ?? "row"}`),
                  mockedModules: [{ specifier: "../api", source: "export const load = () => 1;" }],
                  notes: `${previous.notes}\n\nRepaired after ${error.sides.join(" and ")} render failure (${error.kind}): fixed.`,
                  states: [
                    { name: "Default", steps: [] },
                    { name: "Empty", steps: [] }
                  ],
                  origin: "written",
                  libraryEntryId: null,
                  usage: { ...CALL_USAGE }
                }
              };
            }
            if (behaviour === "component_defect" || behaviour === "cannot_render") {
              return {
                ok: false,
                reason: behaviour,
                message: "The component reads an undefined prop.",
                notesAppendix: `Repair check: ${behaviour}: The component reads an undefined prop.`
              };
            }
            return { ok: false, reason: behaviour, message: `Repair failed (${behaviour}).` };
          }
        };
      },
      render: (deps) => {
        this.renderDeps.push(deps);
        return {
          renderAll: (_ctx, inputs) => {
            this.renderInputs.push(...inputs);
            return Promise.resolve(inputs.map((input) => this.renderOne(input)));
          }
        };
      },
      imageDiff: () => ({
        diff: (_ctx, renders) => {
          this.diffs.push([...renders]);
          return Promise.resolve([]);
        }
      })
    };
  }

  private renderOne(input: RenderComponentInput): ComponentRenderResult {
    const id = input.candidate.componentId;
    const behaviour = this.renderBehaviour.get(id) ?? "ok";
    if (behaviour === "throw") {
      throw new PipelineStepError("rendering", "Vite could not start.");
    }
    const hasBase = input.basePath !== null;
    const hasHead = input.candidate.changeKind !== "removed";
    const headOk = behaviour === "ok";
    const kind = behaviour === "infra_head" ? "browser" : "render_error";
    const states = ["Default", "Empty"].map((stateName, ordinal) => ({
      ordinal,
      stateName,
      base: hasBase ? side("base", true) : null,
      head: hasHead ? side("head", headOk || ordinal === 0, kind) : null
    }));
    const first = states[0];
    return { componentId: id, base: first?.base ?? null, head: first?.head ?? null, states };
  }
}

function stateRow(overrides: Partial<Row> & { id: number; visualizationComponentId: number }): Partial<Row> {
  return {
    visualizationId: 10,
    ordinal: 0,
    stateName: "Default",
    onBase: true,
    onHead: true,
    steps: [],
    renderStatus: "rendered",
    baseImagePath: null,
    headImagePath: null,
    diffImagePath: null,
    imageWidth: null,
    imageHeight: null,
    diffPixelRatio: null,
    visualChange: null,
    baseError: null,
    headError: null,
    baseFailureKind: null,
    headFailureKind: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides
  };
}

interface Setup {
  db: InMemoryQueryHandler;
  store: FakeLibraryStore;
  engine: FakeEngine;
  queue: FakeLibraryQueue;
  cleanups: number[];
  runEvents: Array<{ stage: string; message: string }>;
  service: HarnessRepairWorkerService;
  job(): { job: LibraryJob; shutdown(): void };
  events(): string[];
  jobRow(): Row | undefined;
  row(id: number): Row | undefined;
  saves(): SaveWrittenHarnessInput[];
}

/**
 * Repository 1, completed run 10 and repair job 3 of its cards. Card 101 (Button, modified) renders Default on both
 * sides and fails "Empty" on head with a render_error; its library entry 5 is at revision 3.
 */
function setup(
  options: {
    componentIds?: number[];
    entries?: HarnessLibraryEntryRecord[];
    rows?: Array<Parameters<typeof makeComponentRow>[0]>;
    states?: Array<Partial<Row>>;
    deps?: Partial<HarnessRepairWorkerDependencies>;
  } = {}
): Setup {
  const db = new InMemoryQueryHandler();
  db.now = () => NOW;
  db.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, name: "shop", localPath: "/srv/repos/shop" })]);
  db.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 10,
      status: "completed",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      componentCount: 2,
      changedCount: 0,
      checkedCount: 0,
      needsUpdateCount: 1,
      completedAt: NOW
    })
  ]);
  db.seed(
    ROWS,
    (
      options.rows ?? [
        {
          id: 101,
          displayName: "Button",
          harnessSource: harness("Button"),
          harnessNotes: "Original notes.",
          harnessOrigin: "library",
          libraryEntryId: 5,
          harnessNeedsUpdate: true,
          renderStatus: "partial",
          stateCount: 2
        }
      ]
    ).map((row) => makeComponentRow({ visualizationId: 10, ...row }))
  );
  db.seed(
    STATES,
    options.states ?? [
      stateRow({ id: 1, visualizationComponentId: 101 }),
      stateRow({
        id: 2,
        visualizationComponentId: 101,
        ordinal: 1,
        stateName: "Empty",
        renderStatus: "partial",
        headError: "render_error: TypeError: items is undefined",
        headFailureKind: "render_error"
      })
    ]
  );
  const componentIds = options.componentIds ?? [101];
  db.seed(JOBS, [
    makeLibraryJobRow({
      id: 3,
      kind: "repair",
      visualizationId: 10,
      componentIds,
      totalCount: componentIds.length,
      stateAllowance: 2,
      jobId: "repair-3"
    })
  ]);
  const qh = db as unknown as QueryHandler;
  const store = new FakeLibraryStore(
    options.entries ?? [
      libraryEntry({
        id: 5,
        filePath: "src/components/Button.tsx",
        exportName: "default",
        displayName: "Button",
        revision: 3,
        status: "needs_update",
        origin: "scan"
      })
    ]
  );
  const engine = new FakeEngine();
  const queue = new FakeLibraryQueue();
  const cleanups: number[] = [];
  const runEvents: Setup["runEvents"] = [];
  const service = new HarnessRepairWorkerService({
    queryHandler: qh,
    store,
    readAiSettings: () => Promise.resolve(SETTINGS),
    createProvider: () => ({ kind: "anthropic_api" }) as AiProvider,
    stepsFor: () => engine.steps(),
    recreator: {
      recreate: (input) =>
        Promise.resolve({
          workspace: {
            visualizationId: input.visualization.id,
            repositoryPath: input.repository.localPath,
            baseDir: `${input.rootDir}/base`,
            headDir: `${input.rootDir}/head`,
            baseSha: "a".repeat(40),
            headSha: "b".repeat(40),
            sourceType: "local_branch",
            dependencyDrift: false
          },
          cleanup: () => {
            cleanups.push(input.visualization.id);
            return Promise.resolve();
          }
        })
    },
    createSourceQueries: () => Promise.resolve({} as never),
    queue,
    consoleFactory: (jobId) => new LibraryJobConsole(jobId, qh),
    runConsoleFactory: () => ({
      info: (stage: string, message: string) => {
        runEvents.push({ stage, message });
        return Promise.resolve();
      }
    }),
    fingerprinter: { fingerprint: () => Promise.resolve("f".repeat(64)) },
    worktreesRoot: "/data/worktrees",
    now: () => NOW,
    limits: { maxRuntimeMs: 60_000 },
    ...options.deps
  });
  return {
    db,
    store,
    engine,
    queue,
    cleanups,
    runEvents,
    service,
    job: () => {
      const controller = new AbortController();
      return {
        job: { libraryJobId: 3, jobId: "repair-3", signal: controller.signal },
        shutdown: () => {
          controller.abort("shutdown");
        }
      };
    },
    events: () => db.rows(Table.HARNESS_LIBRARY_JOB_EVENTS).map((event) => String(event.message)),
    jobRow: () => db.row(JOBS, 3),
    row: (id) => db.row(ROWS, id),
    saves: () => store.callsOf("saveWritten").map((args) => args[0] as SaveWrittenHarnessInput)
  };
}

// ----- the ok path -----

test("HarnessRepairWorkerService.run repairs a card: new snapshot, render, diff, library revision + 1, origin repaired", async () => {
  const h = setup();
  const outcome = await h.service.run(h.job().job);
  assert.equal(outcome, "completed");

  // 09 got the run's snapshot and the first harness-attributable state failure (head, "Empty")
  assert.equal(h.engine.repairCalls.length, 1);
  const call = h.engine.repairCalls[0];
  assert.ok(call);
  assert.equal(call.componentId, 101);
  assert.equal(call.previous.harnessSource, harness("Button"));
  assert.equal(call.previous.origin, "library");
  assert.deepEqual(
    call.previous.states.map((state) => state.name),
    ["Default", "Empty"]
  );
  assert.deepEqual(call.error, {
    sides: ["head"],
    kind: "render_error",
    message: "render_error: TypeError: items is undefined",
    otherSideMessage: null,
    stateName: "Empty"
  });

  // context on the run, job usage on both recorders
  const ctx = h.engine.contexts[0];
  assert.equal(ctx?.visualizationId, 10);
  assert.deepEqual(ctx.libraryJob, { kind: "repair", libraryJobId: 3 });
  assert.equal(ctx.library.stateAllowance, 2);
  assert.equal((h.db.row(Table.VISUALIZATIONS, 10)?.aiUsage as { calls: number } | null)?.calls, 1, "run usage");
  assert.equal((h.jobRow()?.aiUsage as { calls: number } | null)?.calls, 1, "job usage");
  assert.ok(Number(h.jobRow()?.spentUsd) > 0);

  // the row's new snapshot
  const row = h.row(101);
  assert.equal(row?.harnessSource, harness("Button", "repaired-row"));
  assert.match(String(row.harnessNotes), /^Original notes\.\n\nRepaired after head render failure/);
  assert.match(String(row.harnessNotes), /\nRepaired by job 3 on 2026-10-07\.$/);
  assert.deepEqual(row.mockedModules, [{ specifier: "../api", source: "export const load = () => 1;" }]);
  assert.equal(row.harnessOrigin, "repaired");
  assert.equal(row.libraryEntryId, 5);
  assert.equal(row.harnessNeedsUpdate, false);
  assert.equal(row.sourceChangedSinceWrite, false);

  // render with the new harness and no second fix-up, then the diff of that render
  assert.equal(h.engine.renderInputs.length, 1);
  assert.equal(h.engine.renderInputs[0]?.harness.harnessSource, harness("Button", "repaired-row"));
  assert.equal(h.engine.renderInputs[0].basePath, "src/components/Button.tsx");
  const fixUp = await h.engine.renderDeps[0]?.repairHarness(101, call.previous, call.error);
  assert.deepEqual(fixUp && !fixUp.ok ? fixUp.reason : null, "budget_exhausted");
  assert.equal(h.engine.renderDeps[0]?.persistence, undefined, "the run's own render persistence");
  assert.equal(h.engine.diffs.length, 1);
  assert.equal(h.engine.diffs[0]?.[0]?.componentId, 101);

  // the library: revision + 1, written unconditionally (E25)
  const save = h.saves()[0];
  assert.equal(save?.expectedRevision, null);
  assert.equal(save.origin, "repair");
  assert.equal(save.status, "ready");
  assert.equal(save.stateAllowance, 2);
  assert.equal(save.sourceFingerprint, "f".repeat(64));
  assert.deepEqual(save.aiUsage, CALL_USAGE);
  const entry = h.store.entries.get(5);
  assert.equal(entry?.revision, 4);
  assert.equal(entry.status, "ready");
  assert.equal(entry.origin, "repair");
  assert.equal(entry.harnessSource, harness("Button", "repaired-row"));

  // job, counts, events
  const job = h.jobRow();
  assert.equal(job?.status, "completed");
  assert.equal(job.writtenCount, 1);
  assert.equal(job.failedCount, 0);
  assert.equal(job.currentLabel, null);
  const events = h.events();
  assert.ok(events.includes("Button: harness repaired and re-rendered (2 state(s))."));
  assert.equal(events.at(-1), "Done: 1 repaired, 0 failed, 0 skipped.");
  const run = h.db.row(Table.VISUALIZATIONS, 10);
  assert.equal(run?.needsUpdateCount, 0, "needs_update_count recomputed");
  assert.equal(run.checkedCount, 1, "checked_count recomputed (partial row with a harness)");
  assert.equal(run.status, "completed", "the run itself stays terminal");
  assert.deepEqual(h.runEvents, [
    {
      stage: "completed",
      message: "Repair: 1 harness(es) repaired and re-rendered, 0 failed. The summary was written before the repair."
    }
  ]);
  assert.deepEqual(h.cleanups, [10]);
  assert.deepEqual(h.queue.calls, ["clearCancel:3"], "the cancel flag is cleared in finally");
});

test("HarnessRepairWorkerService.run saves a repaired harness that still fails as needs_update and counts it failed", async () => {
  const h = setup();
  h.engine.renderBehaviour.set(101, "fail_head");
  assert.equal(await h.service.run(h.job().job), "completed");
  const save = h.saves()[0];
  assert.equal(save?.status, "needs_update");
  assert.equal(save.lastError, 'State "Empty": render_error: boom on head');
  assert.equal(save.lastFailedVisualizationId, 10);
  assert.equal(h.store.entries.get(5)?.revision, 4);
  assert.equal(h.row(101)?.harnessOrigin, "repaired");
  assert.equal(h.row(101)?.harnessNeedsUpdate, true, "E5: still a harness-attributable failure");
  assert.equal(h.jobRow()?.failedCount, 1);
  assert.ok(h.events().some((event) => event.startsWith("Button: the repaired harness still does not render")));
  assert.equal(h.db.row(Table.VISUALIZATIONS, 10)?.needsUpdateCount, 1);
  assert.equal(
    h.runEvents[0]?.message,
    "Repair: 0 harness(es) repaired and re-rendered, 1 failed. The summary was written before the repair."
  );
});

test("HarnessRepairWorkerService.run clears the card flag when the new harness only fails for infrastructure reasons", async () => {
  const h = setup();
  h.engine.renderBehaviour.set(101, "infra_head");
  await h.service.run(h.job().job);
  assert.equal(h.row(101)?.harnessNeedsUpdate, false, "E5: browser failures never flag the card");
  assert.equal(h.saves()[0]?.status, "needs_update", "the status side did not render every state");
});

// ----- verdicts and failures -----

test("HarnessRepairWorkerService.run keeps the harness on a component_defect verdict and clears the flag", async () => {
  const h = setup();
  h.engine.repairs.set("101", "component_defect");
  assert.equal(await h.service.run(h.job().job), "completed");
  const row = h.row(101);
  assert.equal(row?.harnessSource, harness("Button"), "harness unchanged");
  assert.equal(
    row.harnessNotes,
    "Original notes.\n\nRepair check: component_defect: The component reads an undefined prop."
  );
  assert.equal(row.harnessNeedsUpdate, false);
  assert.equal(row.harnessOrigin, "library");
  assert.deepEqual(h.saves(), [], "library entry unchanged");
  assert.equal(h.engine.renderInputs.length, 0, "nothing re-rendered");
  assert.equal(h.jobRow()?.skippedCount, 1);
  assert.ok(h.events().includes("Button: the component itself is broken (The component reads an undefined prop.)."));
  assert.equal(h.db.row(Table.VISUALIZATIONS, 10)?.needsUpdateCount, 0);
});

test("HarnessRepairWorkerService.run leaves the row unchanged for cannot_render, invalid_harness, ai_error and budget_exhausted", async () => {
  for (const behaviour of ["cannot_render", "invalid_harness", "ai_error", "budget_exhausted"] as const) {
    const h = setup();
    h.engine.repairs.set("101", behaviour);
    const before = h.row(101);
    assert.equal(await h.service.run(h.job().job), "completed", behaviour);
    assert.deepEqual(h.row(101), before, `${behaviour}: row unchanged`);
    assert.deepEqual(h.saves(), []);
    assert.equal(h.engine.renderInputs.length, 0);
    assert.equal(h.jobRow()?.failedCount, 1);
    const expected =
      behaviour === "cannot_render"
        ? "Button: The component reads an undefined prop."
        : `Button: Repair failed (${behaviour}).`;
    assert.ok(h.events().includes(expected), `${behaviour}: ${JSON.stringify(h.events())}`);
    const errorEvents = h.db.rows(Table.HARNESS_LIBRARY_JOB_EVENTS).filter((event) => event.level === "error");
    assert.equal(errorEvents.length, 1, behaviour);
  }
});

// ----- replaced rows -----

test("HarnessRepairWorkerService.run repairs only the failing side of a replaced row, against that side's harness", async () => {
  const h = setup({
    rows: [
      {
        id: 101,
        changeKind: "replaced",
        displayName: "EventFormModal",
        filePath: "src/components/EventFormModal.tsx",
        harnessSource: harness("EventFormModal"),
        harnessOrigin: "library",
        libraryEntryId: 6,
        baseFilePath: "src/components/EventForm.tsx",
        baseExportName: "default",
        baseDisplayName: "EventForm",
        baseHarnessSource: harness("EventForm"),
        baseHarnessNotes: "Base notes.",
        baseMockedModules: [],
        baseHarnessOrigin: "library",
        baseLibraryEntryId: 5,
        successorEvidence: [],
        harnessNeedsUpdate: true
      }
    ],
    entries: [
      libraryEntry({ id: 5, filePath: "src/components/EventForm.tsx", displayName: "EventForm", revision: 2 }),
      libraryEntry({ id: 6, filePath: "src/components/EventFormModal.tsx", displayName: "EventFormModal", revision: 7 })
    ],
    states: [
      stateRow({
        id: 1,
        visualizationComponentId: 101,
        baseError: "module_load: Cannot find module ../api",
        baseFailureKind: "module_load"
      })
    ]
  });
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.equal(h.engine.repairCalls.length, 1);
  const call = h.engine.repairCalls[0];
  assert.equal(call?.error.targetSide, "base");
  assert.deepEqual(call.error.sides, ["base"]);
  assert.equal(call.error.kind, "module_load");
  assert.equal(call.previous.harnessSource, harness("EventForm"), "the base side's own harness");
  const row = h.row(101);
  assert.equal(row?.baseHarnessSource, harness("Button", "repaired-base"));
  assert.match(String(row.baseHarnessNotes), /Repaired by job 3 on 2026-10-07\.$/);
  assert.equal(row.harnessSource, harness("EventFormModal"), "head harness untouched");
  assert.equal(row.baseHarnessOrigin, "repaired");
  assert.equal(row.harnessOrigin, "library");
  assert.equal(row.baseLibraryEntryId, 5);
  const input = h.engine.renderInputs[0];
  assert.equal(input?.basePath, "src/components/EventForm.tsx");
  assert.equal(input.harness.baseHarness?.harnessSource, harness("Button", "repaired-base"));
  assert.equal(input.harness.harnessSource, harness("EventFormModal"));
  const save = h.saves()[0];
  assert.deepEqual(save?.identity, { filePath: "src/components/EventForm.tsx", exportName: "default" });
  assert.equal(save.displayName, "EventForm");
  assert.equal(h.store.entries.get(5)?.revision, 3);
  assert.equal(h.store.entries.get(6)?.revision, 7, "head entry untouched");
});

test("HarnessRepairWorkerService.run repairs both sides of a replaced row separately when both failed", async () => {
  const h = setup({
    rows: [
      {
        id: 101,
        changeKind: "replaced",
        displayName: "EventFormModal",
        filePath: "src/components/EventFormModal.tsx",
        harnessSource: harness("EventFormModal"),
        baseFilePath: "src/components/EventForm.tsx",
        baseExportName: "default",
        baseDisplayName: "EventForm",
        baseHarnessSource: harness("EventForm"),
        baseHarnessNotes: "",
        baseMockedModules: [],
        successorEvidence: [],
        harnessNeedsUpdate: true
      }
    ],
    entries: [],
    states: [
      stateRow({
        id: 1,
        visualizationComponentId: 101,
        baseError: "timeout: no settle",
        baseFailureKind: "timeout",
        headError: "render_error: x",
        headFailureKind: "render_error"
      })
    ]
  });
  await h.service.run(h.job().job);
  assert.deepEqual(
    h.engine.repairCalls.map((entry) => entry.error.targetSide),
    ["head", "base"]
  );
  assert.equal(h.saves().length, 2, "one library entry per side");
  assert.equal(h.row(101)?.harnessOrigin, "repaired");
  assert.equal(h.row(101)?.baseHarnessOrigin, "repaired");
  assert.equal(h.jobRow()?.writtenCount, 1, "one card");
});

// ----- renamed component -----

test("HarnessRepairWorkerService.run renders a renamed card from its old base path and moves the entry after a head render", async () => {
  const h = setup({
    rows: [
      {
        id: 101,
        displayName: "Button",
        filePath: "src/ui/Button.tsx",
        codeDiff:
          "diff --git a/src/components/Button.tsx b/src/ui/Button.tsx\nrename from src/components/Button.tsx\nrename to src/ui/Button.tsx\n--- a/src/components/Button.tsx\n+++ b/src/ui/Button.tsx\n@@ -1,1 +1,1 @@\n-a\n+b",
        harnessSource: harness("Button"),
        harnessOrigin: "library",
        libraryEntryId: 5,
        harnessNeedsUpdate: true
      }
    ]
  });
  await h.service.run(h.job().job);
  assert.equal(h.engine.renderInputs[0]?.basePath, "src/components/Button.tsx");
  assert.deepEqual(h.saves()[0]?.identity, { filePath: "src/components/Button.tsx", exportName: "default" });
  assert.equal(h.store.entries.get(5)?.revision, 4);
  assert.equal(h.store.entries.get(5)?.filePath, "src/ui/Button.tsx", "moved to the new path");
});

// ----- cancel, failures, shutdown -----

test("HarnessRepairWorkerService.run stops between cards on cancel and keeps what was repaired", async () => {
  const h = setup({
    componentIds: [101, 102],
    rows: [
      { id: 101, displayName: "Button", harnessSource: harness("Button"), libraryEntryId: 5, harnessNeedsUpdate: true },
      {
        id: 102,
        displayName: "Card",
        filePath: "src/components/Card.tsx",
        rank: 1,
        harnessSource: harness("Card"),
        harnessNeedsUpdate: true
      }
    ],
    states: [
      stateRow({ id: 1, visualizationComponentId: 101, headError: "render_error: a", headFailureKind: "render_error" }),
      stateRow({ id: 2, visualizationComponentId: 102, headError: "render_error: b", headFailureKind: "render_error" })
    ]
  });
  h.engine.afterRepair = () => {
    h.queue.flags.add(3);
  };
  assert.equal(await h.service.run(h.job().job), "cancelled");
  assert.deepEqual(
    h.engine.repairCalls.map((call) => call.componentId),
    [101]
  );
  assert.equal(h.row(101)?.harnessOrigin, "repaired", "the started card is finished and saved");
  assert.equal(h.row(102)?.harnessNeedsUpdate, true);
  const job = h.jobRow();
  assert.equal(job?.status, "cancelled");
  assert.equal(job.writtenCount, 1);
  assert.equal(h.events().at(-1), "Cancelled. 1 harness(es) repaired so far are kept.");
  assert.equal(h.runEvents.length, 1, "the run still gets its repair event");
  assert.deepEqual(
    h.queue.calls.filter((c) => c.startsWith("clear")),
    ["clearCancel:3"]
  );
});

test("HarnessRepairWorkerService.run is cancelled before it starts when the flag is already set", async () => {
  const h = setup();
  h.queue.flags.add(3);
  assert.equal(await h.service.run(h.job().job), "cancelled");
  assert.equal(h.jobRow()?.status, "cancelled");
  assert.equal(h.events().at(-1), "Cancelled before the repair started.");
  assert.equal(h.engine.repairCalls.length, 0);
  assert.deepEqual(h.runEvents, []);
});

test("HarnessRepairWorkerService.run fails the job with the workspace message and makes no AI call", async () => {
  const h = setup({
    deps: {
      recreator: {
        recreate: () =>
          Promise.reject(
            new PipelineStepError(
              "preparing",
              "The uncommitted changes of this run are no longer available. Start a new visualization."
            )
          )
      }
    }
  });
  assert.equal(await h.service.run(h.job().job), "failed");
  const job = h.jobRow();
  assert.equal(job?.status, "failed");
  assert.equal(
    job.errorMessage,
    "The uncommitted changes of this run are no longer available. Start a new visualization."
  );
  assert.equal(h.engine.repairCalls.length, 0);
  assert.deepEqual(h.runEvents, []);
});

test("HarnessRepairWorkerService.run fails the job when the render engine itself fails, after saving the harness", async () => {
  const h = setup();
  h.engine.renderBehaviour.set(101, "throw");
  assert.equal(await h.service.run(h.job().job), "failed");
  assert.equal(h.jobRow()?.errorMessage, "Vite could not start.");
  assert.equal(h.jobRow()?.failedCount, 1);
  assert.equal(h.saves()[0]?.status, "needs_update");
  assert.equal(h.row(101)?.harnessOrigin, "repaired");
  assert.equal(h.runEvents.length, 1, "the run's counts and event still reflect the repaired card");
});

test("HarnessRepairWorkerService.run fails with the shutdown message when the worker stops mid-repair", async () => {
  const h = setup({ componentIds: [101] });
  const handle = h.job();
  h.engine.afterRepair = () => {
    handle.shutdown();
  };
  assert.equal(await h.service.run(handle.job), "failed");
  assert.equal(h.jobRow()?.errorMessage, "PRVision stopped while this repair was running. Run Repair again.");
  assert.deepEqual(h.cleanups, [10], "worktrees removed");
});

test("HarnessRepairWorkerService.run skips jobs that are not queued repairs", async () => {
  const h = setup();
  h.db.seed(JOBS, [makeLibraryJobRow({ id: 4, kind: "scan" })]);
  assert.equal(
    await h.service.run({ libraryJobId: 4, jobId: "scan-4", signal: new AbortController().signal }),
    "skipped"
  );
  assert.equal(
    await h.service.run({ libraryJobId: 99, jobId: "repair-99", signal: new AbortController().signal }),
    "skipped"
  );
  assert.equal(h.engine.repairCalls.length, 0);
});

test("HarnessRepairWorkerService.run fails with 'The run was removed.' when the run is gone", async () => {
  const h = setup();
  await h.db.update({ isDeleted: true }, { id: 10 }, Table.VISUALIZATIONS);
  assert.equal(await h.service.run(h.job().job), "failed");
  assert.equal(h.jobRow()?.errorMessage, "The run was removed.");
});

// ----- pure helpers -----

function componentModel(overrides: Parameters<typeof makeComponentRow>[0]): VisualizationComponentModel {
  return ModelHandler.hydrate(VisualizationComponentModel, makeComponentRow(overrides));
}

function stateModel(
  overrides: Partial<Row> & { id: number; visualizationComponentId: number }
): VisualizationComponentStateModel {
  return ModelHandler.hydrate(VisualizationComponentStateModel, stateRow(overrides));
}

test("repairTargets prefers a harness-attributable failure on the status side, then the other side", () => {
  const row = componentModel({ id: 1, harnessSource: harness("Button"), harnessNeedsUpdate: true });
  const states = [
    stateModel({ id: 1, visualizationComponentId: 1, baseError: "module_load: x", baseFailureKind: "module_load" }),
    stateModel({
      id: 2,
      visualizationComponentId: 1,
      ordinal: 1,
      stateName: "Empty",
      headError: "browser: crashed",
      headFailureKind: "browser"
    }),
    stateModel({
      id: 3,
      visualizationComponentId: 1,
      ordinal: 2,
      stateName: "Open",
      headError: "step_failed: no button",
      headFailureKind: "step_failed",
      baseError: "step_failed: none",
      baseFailureKind: "step_failed"
    })
  ];
  assert.deepEqual(repairTargets(row, states), [
    {
      side: null,
      renderError: {
        sides: ["base", "head"],
        kind: "step_failed",
        message: "step_failed: no button",
        otherSideMessage: "step_failed: none",
        stateName: "Open"
      }
    }
  ]);
  // only base failed for a harness reason: the base failure, Default (no stateName)
  assert.deepEqual(repairTargets(row, states.slice(0, 2))[0]?.renderError, {
    sides: ["base"],
    kind: "module_load",
    message: "module_load: x",
    otherSideMessage: null
  });
});

test("repairTargets uses base as the status side of a removed row and the row's errors for rows without states", () => {
  const removed = componentModel({
    id: 2,
    changeKind: "removed",
    harnessSource: harness("Old"),
    baseError: "render_error: gone",
    harnessNeedsUpdate: true
  });
  assert.deepEqual(repairTargets(removed, []), [
    {
      side: null,
      renderError: { sides: ["base"], kind: "render_error", message: "render_error: gone", otherSideMessage: null }
    }
  ]);
  assert.deepEqual(repairTargets(componentModel({ id: 3, harnessSource: harness("Ok") }), []), []);
});

test("candidateFromRow and renamedFrom derive the base path of renamed, added and replaced rows", () => {
  assert.equal(renamedFrom("diff --git a/a.tsx b/b.tsx\nrename from a.tsx\nrename to b.tsx\n--- a/a.tsx"), "a.tsx");
  assert.equal(renamedFrom("diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-rename from y"), null);
  assert.equal(renamedFrom(null), null);
  assert.equal(candidateFromRow(componentModel({ id: 4, changeKind: "added" })).basePath, null);
  assert.equal(candidateFromRow(componentModel({ id: 5 })).basePath, "src/components/Button.tsx");
  const replaced = candidateFromRow(
    componentModel({
      id: 6,
      changeKind: "replaced",
      baseFilePath: "src/Old.tsx",
      baseExportName: "Old",
      baseDisplayName: "Old",
      baseHarnessSource: "x",
      baseHarnessNotes: "",
      baseMockedModules: [],
      successorEvidence: []
    })
  );
  assert.equal(replaced.basePath, "src/Old.tsx");
  assert.equal(replaced.candidate.predecessor?.exportName, "Old");
});
