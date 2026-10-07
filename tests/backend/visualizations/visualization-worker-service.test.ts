import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Table, VISUALIZATION_STATUS_VALUES } from "../../../backend/src/enums";
import { buildRenderInputs } from "../../../backend/src/services/visualizations/pipeline/render-service";
import {
  classifyRunFailure,
  RunCancelledSignal,
  toRepairHarnessFn,
  VisualizationTimeoutError,
  VisualizationWorkerService,
  type VisualizationWorkerDependencies
} from "../../../backend/src/services/visualizations/pipeline/visualization-worker-service";
import type {
  WorkspaceCleanupInput,
  WorkspacePrepareInput
} from "../../../backend/src/services/visualizations/pipeline/workspace-prepare-service";
import { VisualizationConsoleService } from "../../../backend/src/services/visualizations/visualization-console-service";
import type {
  LibraryResolutionResult,
  RenderStageDeps
} from "../../../backend/src/services/visualizations/pipeline/stage-registry";
import type {
  HarnessLibraryEntryRecord,
  SaveWrittenHarnessInput,
  SideHarnessPlan
} from "../../../backend/src/types/harness-library";
import {
  AiProviderError,
  PipelineStepError,
  type AiProvider,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type ComponentRenderResult,
  type HarnessRenderError,
  type HarnessRepairOutcome,
  type PreparedWorkspace,
  type RenderFailureKindValue
} from "../../../backend/src/types/visualization-pipeline";
import { GitCommandError, type QueryHandler, type ResolvedAiSettings } from "../../../backend/src/utilities";
import { recordLogger } from "../helpers/console-recorder";
import { FakeLibraryStore, libraryEntry } from "../helpers/fake-library-store";
import { makeComponentRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { makeJob } from "../helpers/fake-queue";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import {
  analysisWith,
  candidate,
  FakeQueueStatics,
  fakeSteps,
  harness,
  ignoresAbort,
  passThroughResolution,
  render,
  untilAborted,
  type FakeStepOptions
} from "./helpers/fakes";

const NOW = new Date("2026-03-01T12:00:00.000Z");
const SETTINGS: ResolvedAiSettings = {
  provider: "anthropic_api",
  model: "claude-opus-5-5",
  harnessEffort: "high",
  summaryEffort: "medium",
  anthropicApiKey: { state: "present", value: `sk-ant-api03-${"w".repeat(40)}` }
};
const PROVIDER: AiProvider = {
  kind: "anthropic_api",
  generateStructured: () => Promise.reject(new Error("not used"))
};

interface WorkerHarness {
  store: InMemoryQueryHandler;
  library: FakeLibraryStore;
  queue: FakeQueueStatics;
  events: string[];
  prepareInputs: WorkspacePrepareInput[];
  cleanupInputs: WorkspaceCleanupInput[];
  settingsReads: number;
  providerArgs: ResolvedAiSettings[];
  deps: Partial<VisualizationWorkerDependencies>;
  calls: ReturnType<typeof fakeSteps>["calls"];
  worker(): VisualizationWorkerService;
  row(): Record<string, unknown> | undefined;
  consoleRows(): Array<Record<string, unknown>>;
  statusUpdates(): string[];
}

function workspaceFor(id: number): PreparedWorkspace {
  return {
    visualizationId: id,
    repositoryPath: "/tmp/repo",
    baseDir: `/data/worktrees/${id}/base`,
    headDir: `/data/worktrees/${id}/head`,
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    sourceType: "local_branch",
    dependencyDrift: false
  };
}

function setup(
  t: TestContext,
  options: {
    steps?: FakeStepOptions;
    visualization?: Parameters<typeof makeVisualizationRow>[0] | null;
    prepare?: (input: WorkspacePrepareInput) => Promise<PreparedWorkspace>;
    limits?: VisualizationWorkerDependencies["limits"];
    library?: FakeLibraryStore;
  } = {}
): WorkerHarness {
  const store = new InMemoryQueryHandler();
  store.now = () => NOW;
  store.seed(Table.REPOSITORIES, [
    makeRepositoryRow({
      id: 1,
      localPath: "/tmp/repo",
      globalStylePaths: ["/src/index.css"],
      stateAllowance: 4,
      libraryBuildMode: "scan"
    })
  ]);
  if (options.visualization !== null) {
    store.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 1, status: "queued", ...options.visualization })]);
  }
  const queue = new FakeQueueStatics();
  const events: string[] = [];
  const { steps, calls } = fakeSteps(options.steps);
  const library = options.library ?? new FakeLibraryStore();
  const h: WorkerHarness = {
    store,
    library,
    queue,
    events,
    prepareInputs: [],
    cleanupInputs: [],
    settingsReads: 0,
    providerArgs: [],
    calls,
    deps: {},
    worker: () => new VisualizationWorkerService(h.deps),
    row: () => store.row(Table.VISUALIZATIONS, 1),
    consoleRows: () => store.rows(Table.VISUALIZATION_CONSOLE_EVENTS),
    statusUpdates: () =>
      store
        .callsFor("update", Table.VISUALIZATIONS)
        .map((call) => (call.args[0] as Record<string, unknown>).status)
        .filter((status): status is string => typeof status === "string")
  };
  h.deps = {
    queryHandler: store as unknown as QueryHandler,
    workspace: {
      prepare: (input) => {
        events.push("prepare");
        h.prepareInputs.push(input);
        return options.prepare ? options.prepare(input) : Promise.resolve(workspaceFor(input.visualizationId));
      },
      cleanup: (input) => {
        events.push("cleanup");
        h.cleanupInputs.push(input);
        return Promise.resolve();
      }
    },
    readAiSettings: () => {
      h.settingsReads += 1;
      return Promise.resolve(SETTINGS);
    },
    createProvider: (settings) => {
      h.providerArgs.push(settings);
      return PROVIDER;
    },
    steps,
    queue,
    consoleFactory: (id) => new VisualizationConsoleService(id, store),
    now: () => NOW,
    limits: options.limits ?? { maxRuntimeMs: 60_000, stepAbortGraceMs: 200 },
    libraryStore: library,
    fingerprinter: { fingerprint: () => Promise.resolve("f".repeat(64)) },
    createRenderPersistence: () => ({ saveRenderResult: () => Promise.resolve() })
  };
  t.after(() => {
    events.length = 0;
  });
  return h;
}

/** Seeds component rows the way sheet 08 would, then returns the analysis. */
function analysisSeeding(
  h: () => WorkerHarness,
  rows: Array<Parameters<typeof makeComponentRow>[0]>,
  candidates = [candidate(1), candidate(2)]
): FakeStepOptions["analysis"] {
  return () => {
    h().store.seed(
      Table.VISUALIZATION_COMPONENTS,
      rows.map((row, index) => makeComponentRow({ id: index + 1, visualizationId: 1, ...row }))
    );
    return Promise.resolve(analysisWith(candidates));
  };
}

// ---------------------------------------------------------------------------------------------------------------

test("VisualizationWorkerService.run skips a missing visualization and a non-queued visualization without writes", async (t) => {
  const missing = setup(t, { visualization: null });
  assert.equal(await missing.worker().run(makeJob(1).job), "skipped");
  const running = setup(t, { visualization: { status: "rendering" } });
  const logs = recordLogger();
  t.after(logs.restore);
  assert.equal(await running.worker().run(makeJob(1).job), "skipped");
  for (const h of [missing, running]) {
    assert.equal(h.store.callsFor("update").length, 0);
    assert.equal(h.store.callsFor("insert").length, 0);
    assert.deepEqual(h.events, []);
  }
  assert.ok(logs.lines.some((l) => l.event === "visualization.job.skipped" && l.status === "rendering"));
});

test("VisualizationWorkerService.run happy path writes statuses in order and completes with counts from the aggregate", async (t) => {
  let h: WorkerHarness | null = null;
  const get = (): WorkerHarness => {
    assert.ok(h);
    return h;
  };
  h = setup(t, {
    steps: {
      analysis: analysisSeeding(get, [
        { renderStatus: "rendered", visualChange: "changed", harnessOrigin: "written" },
        { renderStatus: "rendered", visualChange: "new", harnessOrigin: "written" },
        { renderStatus: "rendered", visualChange: "deleted", harnessOrigin: "library" },
        { renderStatus: "rendered", visualChange: "unchanged", harnessOrigin: "library" },
        { renderStatus: "failed", visualChange: null, harnessOrigin: "written" },
        { renderStatus: "skipped", skipReason: "cap" }
      ])
    }
  });
  const outcome = await h.worker().run(makeJob(1).job);
  assert.equal(outcome, "completed");
  assert.deepEqual(h.statusUpdates(), [
    "preparing",
    "analyzing",
    "generating_harnesses",
    "rendering",
    "diffing",
    "summarizing",
    "completed"
  ]);
  const row = h.row();
  assert.equal(row?.status, "completed");
  assert.equal(row.changedCount, 3, "changed + new + deleted");
  assert.equal(row.componentCount, 0, "component_count is 08's column; the worker never writes it");
  assert.deepEqual(row.completedAt, NOW);
  assert.equal(row.errorMessage, null);
  assert.equal(row.failedStage, null);
  // 16 §8.7: library resolution ends analyzing
  assert.deepEqual(h.calls.order, ["analyze", "resolve", "generateAll", "renderAll", "diff", "compare", "summarize"]);
  assert.equal(row.checkedCount, 5, "16 §8.7 step 8: rendered, partial or failed rows with a harness");
  assert.equal(
    h.consoleRows().at(-2)?.message,
    "Completed: 5 checked, 3 changed visually.",
    "terminal line before the cleanup line (16 §8.7 step 8)"
  );
  assert.equal(h.consoleRows().at(-1)?.message, "Removing temporary worktrees.");
  assert.equal(h.consoleRows().at(-1)?.stage, "completed");
});

test("VisualizationWorkerService.run reads settings once and builds both the provider and ctx.aiSettings from that read", async (t) => {
  const h = setup(t);
  await h.worker().run(makeJob(1).job);
  assert.equal(h.settingsReads, 1);
  assert.deepEqual(h.providerArgs, [SETTINGS]);
  const ctx = h.calls.analyzeCtx;
  assert.ok(ctx);
  assert.equal(ctx.ai, PROVIDER);
  assert.deepEqual(ctx.aiSettings, { model: "claude-opus-5-5", harnessEffort: "high", summaryEffort: "medium" });
  assert.equal("anthropicApiKey" in ctx.aiSettings, false, "the key never enters the context");
  assert.deepEqual(ctx.repository, {
    id: 1,
    localPath: "/tmp/repo",
    framework: "react_vite",
    appRoot: ".",
    angularProject: null,
    angularBuildConfiguration: null,
    viteConfigPath: "vite.config.ts",
    tsconfigPath: "tsconfig.json",
    entryFilePath: "src/main.tsx",
    globalStylePaths: ["/src/index.css"],
    renderViewport: "desktop"
  });
  // 16 §6.12: the repository's library settings are snapshotted into the context at job start.
  assert.deepEqual(ctx.library, { stateAllowance: 4, buildMode: "scan" });
  assert.equal(ctx.libraryJob, undefined);
  assert.deepEqual(ctx.workspace, workspaceFor(1));
  assert.equal(ctx.visualizationId, 1);
  assert.equal(await ctx.isCancelled(), false);
});

test("VisualizationWorkerService.run snapshots ai_provider/ai_model and started_at on preparing; base_sha/head_sha on analyzing", async (t) => {
  const h = setup(t);
  await h.worker().run(makeJob(1).job);
  const updates = h.store.callsFor("update", Table.VISUALIZATIONS).map((c) => c.args[0] as Record<string, unknown>);
  assert.deepEqual(updates[0], {
    aiProvider: "anthropic_api",
    aiModel: "claude-opus-5-5",
    errorMessage: null,
    status: "preparing",
    startedAt: NOW
  });
  assert.deepEqual(updates[1], { baseSha: "b".repeat(40), headSha: "h".repeat(40), status: "analyzing" });
  const row = h.row();
  assert.equal(row?.aiProvider, "anthropic_api");
  assert.equal(row.baseSha, "b".repeat(40));
  assert.equal(row.headSha, "h".repeat(40));
  assert.deepEqual(row.startedAt, NOW);
});

test("VisualizationWorkerService.run passes a commit_range's stored commits and branch to prepare and names the range in the console", async (t) => {
  const baseSha = "1".repeat(40);
  const headSha = "2".repeat(40);
  const h = setup(t, {
    visualization: {
      sourceType: "commit_range",
      prNumber: null,
      baseRef: "feature/x",
      headRef: "feature/x",
      baseSha,
      headSha
    }
  });
  await h.worker().run(makeJob(1).job);
  const input = h.prepareInputs[0];
  assert.equal(input?.sourceType, "commit_range");
  assert.equal(input.baseSha, baseSha);
  assert.equal(input.headSha, headSha);
  assert.equal(input.headRef, "feature/x");
  const messages = h.store.rows(Table.VISUALIZATION_CONSOLE_EVENTS).map((event) => event.message);
  assert.ok(messages.includes("Preparing workspace (commits 1111111…2222222 on feature/x)."), messages.join("\n"));
});

test("VisualizationWorkerService.run never writes ai_usage or summary_markdown", async (t) => {
  const h = setup(t, {
    steps: { summary: { status: "failed", summaryMarkdown: null, usage: null, failureReason: "x" } }
  });
  await h.worker().run(makeJob(1).job);
  const failing = setup(t, { steps: { renders: () => Promise.reject(new PipelineStepError("rendering", "boom")) } });
  await failing.worker().run(makeJob(1).job);
  for (const harnessUnderTest of [h, failing]) {
    for (const call of harnessUnderTest.store.callsFor("update", Table.VISUALIZATIONS)) {
      const values = call.args[0] as Record<string, unknown>;
      assert.equal("aiUsage" in values, false);
      assert.equal("summaryMarkdown" in values, false);
      assert.equal("componentCount" in values, false);
    }
  }
});

test("VisualizationWorkerService.run passes analysis.sourceQueries to the harness factory and the same harness instance to the render repair adapter", async (t) => {
  const analysis = analysisWith([candidate(1)]);
  const h = setup(t, { steps: { analysis } });
  await h.worker().run(makeJob(1).job);
  assert.equal(h.calls.harnessFactoryArgs?.sourceQueries, analysis.sourceQueries);
  assert.equal(h.calls.harnessFactoryArgs.ctx, h.calls.analyzeCtx);
  assert.ok(h.calls.renderDeps);
  const outcome = await h.calls.renderDeps.repairHarness(1, harness(1), {
    sides: ["head"],
    kind: "render_error",
    message: "x",
    otherSideMessage: null
  });
  assert.deepEqual(outcome, { ok: true, result: harness(1) });
  assert.ok(h.calls.order.includes("repair:1"), "repair went to the instance that generated the harnesses");
});

test("VisualizationWorkerService.run calls RenderService.renderAll(ctx, buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles)) using 10's helper", async (t) => {
  const candidates = [
    candidate(1, { rank: 1 }),
    candidate(2, { rank: 0, filePath: "src/New.tsx", changeKind: "modified" }),
    candidate(3, { rank: 2, changeKind: "added" })
  ];
  const analysis = {
    ...analysisWith(candidates),
    changedFiles: [{ path: "src/New.tsx", status: "R" as const, previousPath: "src/Old.tsx" }]
  };
  const batch = {
    results: [harness(1), harness(2), harness(3)],
    failures: [],
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    cancelled: false
  };
  const h = setup(t, { steps: { analysis, batch } });
  await h.worker().run(makeJob(1).job);
  const expected = buildRenderInputs(analysis.candidates, batch.results, analysis.changedFiles);
  assert.deepEqual(h.calls.renderAllInputs, expected);
  assert.deepEqual(
    expected.map((input) => [input.candidate.componentId, input.basePath]),
    [
      [2, "src/Old.tsx"],
      [1, "src/components/C1.tsx"],
      [3, null]
    ]
  );
  const withoutHarness = buildRenderInputs(candidates, [harness(1)], []);
  assert.deepEqual(
    withoutHarness.map((input) => input.candidate.componentId),
    [1],
    "candidates without a harness are omitted"
  );
});

test("toRepairHarnessFn forwards the HarnessRenderError object and returns 09's HarnessRepairOutcome unchanged (results and verdicts)", async () => {
  const renderError: HarnessRenderError = {
    sides: ["base", "head"],
    kind: "module_load",
    message: "[module_load] Failed to resolve import",
    otherSideMessage: "other"
  };
  const verdict: HarnessRepairOutcome = {
    ok: false,
    reason: "component_defect",
    message: "The component throws",
    notesAppendix: "Repair verdict: component defect"
  };
  const received: unknown[] = [];
  const fn = toRepairHarnessFn({
    repairHarness: (componentId, previous, error) => {
      received.push(componentId, previous, error);
      return Promise.resolve(verdict);
    }
  });
  const previous = harness(4);
  assert.equal(await fn(4, previous, renderError), verdict);
  assert.equal(received[1], previous);
  assert.equal(received[2], renderError, "the same object, not a string");
  const ok: HarnessRepairOutcome = { ok: true, result: harness(4) };
  const fnOk = toRepairHarnessFn({ repairHarness: () => Promise.resolve(ok) });
  assert.equal(await fnOk(4, previous, renderError), ok);
});

test("VisualizationWorkerService.run calls ImageDiffService.diff(ctx, renders), StructuralDiffService.compare(ctx, { renders, diffs, analysis }) and SummaryService.summarize(ctx, analysis)", async (t) => {
  const analysis = analysisWith([candidate(1)]);
  const diffs = [
    { componentId: 1, diffImagePath: "artifacts/1/1/diff.png", diffPixelRatio: 0.1, width: 10, height: 10, states: [] }
  ];
  const h = setup(t, { steps: { analysis, diffs } });
  await h.worker().run(makeJob(1).job);
  assert.ok(h.calls.diffRenders);
  assert.equal(h.calls.diffRenders.length, 1);
  assert.equal(h.calls.compareInput?.renders, h.calls.diffRenders);
  assert.equal(h.calls.compareInput.diffs, diffs);
  assert.equal(h.calls.compareInput.analysis, analysis);
  assert.equal(h.calls.summarizeAnalysis, analysis);
});

test("VisualizationWorkerService.run zero candidates still passes every stage, skips render and diff calls, and calls summarize", async (t) => {
  const h = setup(t, { steps: { analysis: analysisWith([]) } });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  assert.deepEqual(h.calls.order, ["analyze", "resolve", "generateAll", "summarize"]);
  assert.deepEqual(h.statusUpdates(), [
    "preparing",
    "analyzing",
    "generating_harnesses",
    "rendering",
    "diffing",
    "summarizing",
    "completed"
  ]);
  const messages = h.consoleRows().map((row) => row.message);
  for (const message of ["No components to generate harnesses for.", "Nothing to render.", "Nothing to compare."]) {
    assert.ok(messages.includes(message), message);
  }
});

test("VisualizationWorkerService.run cleanup runs after summarize resolves, never before", async (t) => {
  let harnessRef: WorkerHarness | null = null;
  const h = setup(t, {
    steps: {
      summary: async () => {
        harnessRef?.events.push("summarize:start");
        await delay(20);
        harnessRef?.events.push("summarize:end");
        return { status: "generated", summaryMarkdown: "# x", usage: null, failureReason: null };
      }
    }
  });
  harnessRef = h;
  await h.worker().run(makeJob(1).job);
  assert.deepEqual(h.events, ["prepare", "summarize:start", "summarize:end", "cleanup"]);
});

test("VisualizationWorkerService.run cancel flag set before start → queued → cancelled with failed_stage queued, with no prepare", async (t) => {
  const h = setup(t);
  h.queue.flags.add(1);
  assert.equal(await h.worker().run(makeJob(1).job), "cancelled");
  const row = h.row();
  assert.equal(row?.status, "cancelled");
  assert.equal(row.failedStage, "queued");
  assert.equal(row.errorMessage, null);
  assert.deepEqual(h.events, [], "no prepare, no cleanup");
  assert.equal(h.settingsReads, 0);
  assert.equal(h.store.callsFor("update", Table.VISUALIZATION_COMPONENTS).length, 0, "no sweep before analysis");
  assert.deepEqual(h.statusUpdates(), ["cancelled"]);
  assert.ok(h.queue.calls.includes("clearCancel:1"));
});

test("VisualizationWorkerService.run generateAll returning cancelled → cancelled with failed_stage generating_harnesses", async (t) => {
  const h = setup(t, {
    steps: {
      batch: { results: [], failures: [], usage: { inputTokens: 0, outputTokens: 0, calls: 0 }, cancelled: true }
    }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "cancelled");
  assert.equal(h.row()?.status, "cancelled");
  assert.equal(h.row()?.failedStage, "generating_harnesses");
  assert.ok(h.consoleRows().some((r) => r.stage === "cancelled" && r.message === "Cancelled by user."));
});

test('VisualizationWorkerService.run job signal aborted with reason "cancelled" during rendering → cancelled with failed_stage rendering', async (t) => {
  const handle = makeJob(1);
  const h = setup(t, {
    steps: {
      renders: (ctx) => {
        setTimeout(() => {
          handle.cancel();
        }, 10);
        return untilAborted<never>()(ctx);
      }
    }
  });
  assert.equal(await h.worker().run(handle.job), "cancelled");
  assert.equal(h.row()?.status, "cancelled");
  assert.equal(h.row()?.failedStage, "rendering");
  assert.equal(h.cleanupInputs.length, 1);
});

test('VisualizationWorkerService.run job signal aborted with reason "shutdown" → failed "Worker stopped…", even when the step throws RunCancelledSignal or an AI aborted error', async (t) => {
  const cases: Array<FakeStepOptions["renders"]> = [
    () => Promise.reject(new AiProviderError("Request aborted", "aborted", false)),
    () => Promise.reject(new RunCancelledSignal()),
    () => Promise.resolve([]) // the checkpoint after the step throws RunCancelledSignal
  ];
  for (const behaviour of cases) {
    const handle = makeJob(1);
    const h = setup(t, {
      steps: {
        renders: (ctx) => {
          handle.shutdown();
          return typeof behaviour === "function" ? behaviour(ctx) : Promise.resolve([]);
        }
      }
    });
    assert.equal(await h.worker().run(handle.job), "failed");
    assert.equal(h.row()?.errorMessage, "Worker stopped before the visualization finished. Start it again.");
    assert.equal(h.row()?.failedStage, "rendering");
    assert.equal(h.cleanupInputs.length, 1);
  }
});

test("VisualizationWorkerService.run timeout → failed with the time-limit message", async (t) => {
  const h = setup(t, {
    limits: { maxRuntimeMs: 50, stepAbortGraceMs: 1_000 },
    steps: { analysis: untilAborted() }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "failed");
  assert.match(String(h.row()?.errorMessage), /^Stopped after \d+ minutes \(time limit\)\.$/);
  assert.equal(h.row()?.failedStage, "analyzing");
  const classification = classifyRunFailure(
    new Error("x"),
    new VisualizationTimeoutError(45 * 60_000),
    true,
    "rendering"
  );
  assert.deepEqual(classification, {
    status: "failed",
    errorMessage: "Stopped after 45 minutes (time limit).",
    unexpected: false
  });
});

test("VisualizationWorkerService.run a step that ignores the abort is abandoned after the grace period and the run still ends and cleans up", async (t) => {
  const handle = makeJob(1);
  const logs = recordLogger();
  t.after(logs.restore);
  const h = setup(t, {
    limits: { maxRuntimeMs: 60_000, stepAbortGraceMs: 100 },
    steps: {
      analysis: () => {
        setTimeout(() => {
          handle.cancel();
        }, 10);
        return ignoresAbort<never>(2_000)();
      }
    }
  });
  const startedAt = Date.now();
  assert.equal(await h.worker().run(handle.job), "cancelled");
  assert.ok(Date.now() - startedAt < 1_500, "did not wait for the step");
  assert.equal(h.row()?.failedStage, "analyzing");
  assert.equal(h.cleanupInputs.length, 1);
  assert.ok(logs.lines.some((l) => l.event === "visualization.step.abandoned" && l.stage === "analyzing"));
});

test("VisualizationWorkerService.run PipelineStepError → failed with userMessage and failed_stage = the active stage", async (t) => {
  const h = setup(t, {
    steps: { renders: () => Promise.reject(new PipelineStepError("rendering", "Vite failed to start for head.")) }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "failed");
  assert.equal(h.row()?.errorMessage, "Vite failed to start for head.");
  assert.equal(h.row()?.failedStage, "rendering");
  assert.ok(
    h
      .consoleRows()
      .some((r) => r.stage === "failed" && r.level === "error" && r.message === "Vite failed to start for head.")
  );

  const prepareFails = setup(t, {
    prepare: () => Promise.reject(new PipelineStepError("preparing", "Could not create a git worktree: x"))
  });
  assert.equal(await prepareFails.worker().run(makeJob(1).job), "failed");
  assert.equal(prepareFails.row()?.failedStage, "preparing");
  assert.equal(prepareFails.cleanupInputs.length, 1, "cleanup also after a failed prepare");
});

test("VisualizationWorkerService.run AiProviderError config from createProvider → queued → failed, with no prepare", async (t) => {
  const h = setup(t);
  h.deps.createProvider = () => {
    throw new AiProviderError("Add an Anthropic API key in Settings.", "config", false);
  };
  assert.equal(await h.worker().run(makeJob(1).job), "failed");
  assert.equal(h.row()?.status, "failed");
  assert.equal(h.row()?.failedStage, "queued");
  assert.equal(h.row()?.errorMessage, "AI is not configured: Add an Anthropic API key in Settings.");
  assert.deepEqual(h.events, []);
  assert.deepEqual(
    classifyRunFailure(new AiProviderError("x", "auth", false), undefined, false, "generating_harnesses").errorMessage,
    "The AI provider rejected the credentials. Check Settings → AI and run Test connection."
  );
  assert.equal(
    classifyRunFailure(new AiProviderError("x", "rate_limit", true), undefined, false, "summarizing").errorMessage,
    "AI request failed (rate_limit). Try again."
  );
  assert.equal(
    classifyRunFailure(
      new GitCommandError("git fetch failed", "network", "fetch", 128, "fatal: unable to access\nmore"),
      undefined,
      false,
      "preparing"
    ).errorMessage,
    "A git command failed (network): fatal: unable to access"
  );
});

test("VisualizationWorkerService.run unknown error → generic message, error logged", async (t) => {
  const logs = recordLogger();
  t.after(logs.restore);
  const h = setup(t, { steps: { analysis: () => Promise.reject(new TypeError("cannot read x of undefined")) } });
  assert.equal(await h.worker().run(makeJob(1).job), "failed");
  assert.equal(h.row()?.errorMessage, "Unexpected error during analyzing. See the worker log for details.");
  const logged = logs.lines.find((l) => l.event === "visualization.run.failed");
  assert.ok(logged);
  assert.equal(logged.level, 50);
  assert.equal(logged.stage, "analyzing");
});

test("VisualizationWorkerService.run summary outcome failed → completed with a console error", async (t) => {
  const h = setup(t, {
    steps: { summary: { status: "failed", summaryMarkdown: null, usage: null, failureReason: "rate_limit" } }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  assert.equal(h.row()?.status, "completed");
  assert.ok(
    h
      .consoleRows()
      .some(
        (r) =>
          r.level === "error" &&
          r.stage === "summarizing" &&
          r.message === "The summary could not be generated (rate_limit). Renders and diffs are still available."
      )
  );
});

test("VisualizationWorkerService.run summary outcome cancelled → cancelled", async (t) => {
  const h = setup(t, {
    steps: { summary: { status: "cancelled", summaryMarkdown: null, usage: null, failureReason: null } }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "cancelled");
  assert.equal(h.row()?.failedStage, "summarizing");
});

test("VisualizationWorkerService.run cleanup is called in finally for completed, failed and cancelled runs once prepare started, and not before prepare", async (t) => {
  const completed = setup(t);
  await completed.worker().run(makeJob(1).job);
  const failed = setup(t, { steps: { analysis: () => Promise.reject(new PipelineStepError("analyzing", "x")) } });
  await failed.worker().run(makeJob(1).job);
  const cancelled = setup(t, {
    steps: {
      batch: { results: [], failures: [], usage: { inputTokens: 0, outputTokens: 0, calls: 0 }, cancelled: true }
    }
  });
  await cancelled.worker().run(makeJob(1).job);
  for (const h of [completed, failed, cancelled]) {
    assert.deepEqual(h.cleanupInputs, [
      {
        visualizationId: 1,
        repositoryPath: "/tmp/repo",
        prNumber: null,
        viteConfigPath: "vite.config.ts",
        appRoot: "."
      }
    ]);
  }
  const beforePrepare = setup(t);
  beforePrepare.deps.readAiSettings = () => Promise.reject(new Error("db down"));
  await beforePrepare.worker().run(makeJob(1).job);
  assert.deepEqual(beforePrepare.cleanupInputs, []);
  const repositoryGone = setup(t, { visualization: { repositoryId: 9 } });
  assert.equal(await repositoryGone.worker().run(makeJob(1).job), "failed");
  assert.equal(repositoryGone.row()?.errorMessage, "The repository for this visualization was removed.");
  assert.equal(repositoryGone.row()?.failedStage, "queued");
  assert.deepEqual(repositoryGone.cleanupInputs, []);
});

test("VisualizationWorkerService.run pending components are swept to skipped with a skip reason before every terminal write", async (t) => {
  const reasons = {
    completed: "Not processed.",
    failed: "Not processed: the run failed before this component was finished.",
    cancelled: "Not processed: the run was cancelled before this component was finished."
  };
  const pendingRows = [
    { renderStatus: "pending" as const },
    { renderStatus: "rendered" as const, visualChange: "changed" as const }
  ];
  const scenarios: Array<[keyof typeof reasons, FakeStepOptions]> = [
    ["completed", {}],
    ["failed", { renders: () => Promise.reject(new PipelineStepError("rendering", "boom")) }],
    ["cancelled", { summary: { status: "cancelled", summaryMarkdown: null, usage: null, failureReason: null } }]
  ];
  for (const [expected, steps] of scenarios) {
    let ref: WorkerHarness | null = null;
    const h = setup(t, {
      steps: {
        ...steps,
        analysis: analysisSeeding(() => {
          assert.ok(ref);
          return ref;
        }, pendingRows)
      }
    });
    ref = h;
    assert.equal(await h.worker().run(makeJob(1).job), expected);
    const components = h.store.rows(Table.VISUALIZATION_COMPONENTS);
    assert.deepEqual(
      components.map((c) => [c.renderStatus, c.skipReason]),
      [
        ["skipped", reasons[expected]],
        ["rendered", null]
      ],
      expected
    );
    const sweepIndex = h.store.calls.findIndex(
      (c) => c.method === "update" && c.table === Table.VISUALIZATION_COMPONENTS
    );
    const terminalIndex = h.store.calls.findIndex(
      (c) =>
        c.method === "update" &&
        c.table === Table.VISUALIZATIONS &&
        (c.args[0] as Record<string, unknown>).status === expected
    );
    assert.ok(sweepIndex >= 0 && sweepIndex < terminalIndex, `${expected}: sweep before the terminal write`);
  }
});

test("VisualizationWorkerService.run counts every replaced row as changed, also when unchanged or not compared (00 §17)", async (t) => {
  let h: WorkerHarness | null = null;
  const get = (): WorkerHarness => {
    assert.ok(h);
    return h;
  };
  const replaced = {
    changeKind: "replaced" as const,
    baseFilePath: "src/components/Old.tsx",
    baseExportName: "default",
    baseDisplayName: "Old"
  };
  h = setup(t, {
    steps: {
      analysis: analysisSeeding(get, [
        { renderStatus: "rendered", visualChange: "changed" },
        { ...replaced, renderStatus: "rendered", visualChange: "changed" },
        { ...replaced, renderStatus: "rendered", visualChange: "unchanged" },
        { ...replaced, renderStatus: "failed", visualChange: null },
        { renderStatus: "rendered", visualChange: "unchanged" },
        { renderStatus: "failed", visualChange: null }
      ])
    }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  assert.equal(h.row()?.changedCount, 4, "1 changed + 3 replaced; plain unchanged and failed rows do not count");
});

test("VisualizationWorkerService.run changed_count never exceeds component_count", async (t) => {
  const h = setup(t);
  const originalCount = h.store.count.bind(h.store);
  h.store.count = async (conditions, table) => {
    const result = await originalCount(conditions, table);
    return "visualChange" in conditions ? { status: 200, data: { count: 9 } } : { ...result, data: { count: 2 } };
  };
  await h.worker().run(makeJob(1).job);
  assert.equal(h.row()?.changedCount, 2);
});

test("VisualizationWorkerService.run a lost transition guard stops the run without terminal writes", async (t) => {
  let ref: WorkerHarness | null = null;
  const h = setup(t, {
    prepare: async (input) => {
      // Another writer (recovery) failed the row while the workspace was being prepared.
      await ref?.store.update({ status: "failed", failedStage: "preparing" }, { id: 1 }, Table.VISUALIZATIONS);
      return workspaceFor(input.visualizationId);
    }
  });
  ref = h;
  const logs = recordLogger();
  t.after(logs.restore);
  assert.equal(await h.worker().run(makeJob(1).job), "skipped");
  assert.equal(h.row()?.status, "failed");
  assert.deepEqual(
    h.statusUpdates(),
    ["preparing", "failed", "analyzing"],
    "the lost analyzing guard is the last write"
  );
  assert.deepEqual(h.calls.order, []);
  assert.equal(h.cleanupInputs.length, 1, "cleanup still runs");
  assert.ok(logs.lines.some((l) => l.event === "visualization.transition.conflict"));
});

test("VisualizationWorkerService.run clearCancel is called in finally", async (t) => {
  const completed = setup(t);
  await completed.worker().run(makeJob(1).job);
  assert.ok(completed.queue.calls.includes("clearCancel:1"));
  const failing = setup(t, { steps: { analysis: () => Promise.reject(new Error("x")) } });
  failing.queue.clearCancel = () => Promise.reject(new Error("redis down"));
  assert.equal(await failing.worker().run(makeJob(1).job), "failed", "a clearCancel failure is only logged");
  const flaky = setup(t);
  flaky.queue.cancelCheckError = new Error("redis hiccup");
  assert.equal(await flaky.worker().run(makeJob(1).job), "completed", "a failing flag check is not a cancellation");
});

test("VisualizationWorkerService.run every console stage written by the worker is a VisualizationStatus name", async (t) => {
  const runs = [
    setup(t),
    setup(t, { steps: { analysis: analysisWith([]) } }),
    setup(t, { steps: { renders: () => Promise.reject(new PipelineStepError("rendering", "boom")) } }),
    setup(t, { steps: { summary: { status: "cancelled", summaryMarkdown: null, usage: null, failureReason: null } } })
  ];
  const allowed = new Set<string>(VISUALIZATION_STATUS_VALUES);
  for (const h of runs) {
    await h.worker().run(makeJob(1).job);
    for (const row of h.consoleRows()) {
      assert.ok(allowed.has(String(row.stage)), String(row.stage));
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// 16d: library resolution, D9 pause, reuse, save-back and counts (16 §8.7)
// ---------------------------------------------------------------------------------------------------------------

const ENTRY_SOURCE = 'export default definePrvisionHarness({ states: [{ name: "Default", render: () => <i /> }] });';

function resolutionOf(
  analysis: ChangeAnalysisResult,
  overrides: Partial<LibraryResolutionResult> & {
    reuse?: Record<number, HarnessLibraryEntryRecord>;
    rechecked?: Array<{ candidate: ComponentCandidate; entry: HarnessLibraryEntryRecord }>;
  } = {}
): LibraryResolutionResult {
  const base = passThroughResolution(analysis);
  const reuse = overrides.reuse ?? {};
  const plans = new Map<number, SideHarnessPlan[]>();
  for (const c of analysis.candidates) {
    const entry = reuse[c.componentId] ?? null;
    plans.set(c.componentId, [
      {
        side: c.changeKind === "removed" ? "base" : "head",
        identity: { filePath: c.filePath, exportName: c.exportName },
        entry
      }
    ]);
  }
  for (const row of overrides.rechecked ?? []) {
    plans.set(row.candidate.componentId, [
      { side: "head", identity: { filePath: row.entry.filePath, exportName: row.entry.exportName }, entry: row.entry }
    ]);
  }
  const { reuse: _reuse, rechecked, ...rest } = overrides;
  return {
    ...base,
    plans,
    toWrite: base.toWrite.filter((row) => reuse[row.candidate.componentId] === undefined),
    renderCandidates: [...analysis.candidates, ...(rechecked ?? []).map((row) => row.candidate)],
    recheckedCount: (rechecked ?? []).length,
    ...rest
  };
}

function failedRender(
  componentId: number,
  kind: RenderFailureKindValue,
  side: "base" | "head" | "both" = "head"
): ComponentRenderResult {
  const result = render(componentId);
  const fail = (s: "base" | "head"): ComponentRenderResult["base"] => ({
    side: s,
    ok: false,
    imagePath: null,
    width: null,
    height: null,
    error: `[${kind}] boom`,
    consoleErrors: [],
    durationMs: 1,
    failureKind: kind
  });
  return {
    ...result,
    ...(side === "base" || side === "both" ? { base: fail("base") } : {}),
    ...(side === "head" || side === "both" ? { head: fail("head") } : {})
  };
}

test("VisualizationWorkerService.run pauses when library resolution says so (more than 12 new harnesses) with the 16 §8.4 message and no AI", async (t) => {
  const analysis = analysisWith([candidate(1), candidate(2)]);
  const h = setup(t, {
    steps: {
      analysis,
      resolution: () =>
        Promise.resolve({ ...passThroughResolution(analysis), pause: true, newHarnessCount: 13, reusedCount: 2 })
    }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "paused");
  assert.equal(h.row()?.status, "awaiting_confirmation");
  assert.deepEqual(h.calls.order, ["analyze", "resolve"], "no harness generation (no AI spent)");
  assert.ok(
    h
      .consoleRows()
      .some(
        (row) =>
          row.stage === "awaiting_confirmation" &&
          row.message ===
            "13 new harnesses needed (2 components reuse saved harnesses); PRVision writes 12 by default. Waiting for you to choose how many to write."
      )
  );
});

test("VisualizationWorkerService.run does not pause when the run has a confirmed limit, nor on analysis over_limit skips alone", async (t) => {
  const analysis = analysisWith([candidate(1)]);
  const confirmed = setup(t, {
    visualization: { componentLimit: 30 },
    steps: { analysis, resolution: () => Promise.resolve({ ...passThroughResolution(analysis), pause: true }) }
  });
  assert.equal(await confirmed.worker().run(makeJob(1).job), "completed");
  assert.equal(confirmed.calls.analyzeCtx?.componentLimit, 30);
  const skippedByAnalysis = setup(t, {
    steps: {
      analysis: {
        ...analysis,
        skipped: [
          {
            ...candidate(9),
            skipReason: "over_limit: ranked 501 of 501; PRVision analyses at most 500 components per visualization"
          }
        ]
      }
    }
  });
  assert.equal(
    await skippedByAnalysis.worker().run(makeJob(1).job),
    "completed",
    "16 §8.4: the old overLimit check is gone"
  );
});

test("VisualizationWorkerService.run generates only the rows that need new harnesses, with their sides, and renders reused and rechecked rows with the saved harness", async (t) => {
  const reused = libraryEntry({ id: 11, filePath: "src/components/C1.tsx", harnessSource: ENTRY_SOURCE, revision: 2 });
  const recheckedEntry = libraryEntry({
    id: 13,
    filePath: "src/components/Other.tsx",
    displayName: "Other",
    harnessSource: ENTRY_SOURCE
  });
  const rechecked = candidate(3, {
    changeKind: "rechecked",
    filePath: "src/components/Other.tsx",
    displayName: "Other",
    codeDiff: null,
    rank: 2
  });
  const analysis = analysisWith([candidate(1), candidate(2)]);
  let h: WorkerHarness | null = null;
  h = setup(t, {
    library: new FakeLibraryStore([reused, recheckedEntry]),
    steps: {
      analysis: () => {
        h?.store.seed(Table.VISUALIZATION_COMPONENTS, [
          makeComponentRow({ id: 1, visualizationId: 1, filePath: "src/components/C1.tsx" }),
          makeComponentRow({ id: 2, visualizationId: 1, filePath: "src/components/C2.tsx" }),
          makeComponentRow({
            id: 3,
            visualizationId: 1,
            filePath: "src/components/Other.tsx",
            changeKind: "rechecked",
            libraryEntryId: 13,
            harnessOrigin: "library"
          })
        ]);
        return Promise.resolve(analysis);
      },
      resolution: (a) =>
        Promise.resolve(
          resolutionOf(a, { reuse: { 1: reused }, rechecked: [{ candidate: rechecked, entry: recheckedEntry }] })
        )
    }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  assert.deepEqual(
    h.calls.generateAllCandidates?.map((c) => c.componentId),
    [2]
  );
  assert.deepEqual(h.calls.generateAllOptions, { sides: new Map([[2, ["head"]]]) });
  const inputs = h.calls.renderAllInputs ?? [];
  assert.deepEqual(
    inputs.map((input) => [input.candidate.componentId, input.harness.origin, input.harness.libraryEntryId]),
    [
      [1, "library", 11],
      [2, "written", null],
      [3, "library", 13]
    ]
  );
  assert.equal(inputs[0]?.harness.notes, "From the harness library (revision 2).\nSaved notes.");
  assert.deepEqual(inputs[0].harness.states, [{ name: "Default", steps: [] }]);
  // the run's snapshot of every reused harness (E2), rechecked rows included
  for (const id of [1, 3]) {
    const row = h.store.row(Table.VISUALIZATION_COMPONENTS, id);
    assert.equal(row?.harnessSource, ENTRY_SOURCE, `row ${String(id)} snapshot`);
    assert.match(String(row.harnessNotes), /^From the harness library \(revision \d\)\./);
  }
  // structural diff and summary see the rechecked row as a candidate
  assert.deepEqual(
    h.calls.summarizeAnalysis?.candidates.map((c) => c.componentId),
    [1, 2, 3]
  );
  assert.deepEqual(
    h.calls.compareInput?.analysis.candidates.map((c) => c.componentId),
    [1, 2, 3]
  );
});

test("VisualizationWorkerService.run save-back: written harnesses saved ready or needs_update (E25 expectedRevision), generation failures saved without harness, rows flagged per E5", async (t) => {
  const analysis = analysisWith([candidate(2), candidate(4), candidate(5), candidate(7)]);
  const harnessLess = libraryEntry({ id: 55, filePath: "src/components/C5.tsx", harnessSource: null, revision: 3 });
  const concurrent = libraryEntry({
    id: 77,
    filePath: "src/components/C7.tsx",
    harnessSource: ENTRY_SOURCE,
    revision: 4,
    origin: "repair"
  });
  const library = new FakeLibraryStore([harnessLess]);
  let h: WorkerHarness | null = null;
  h = setup(t, {
    library,
    steps: {
      analysis: () => {
        h?.store.seed(
          Table.VISUALIZATION_COMPONENTS,
          [2, 4, 5, 7].map((id) =>
            makeComponentRow({ id, visualizationId: 1, filePath: `src/components/C${String(id)}.tsx` })
          )
        );
        return Promise.resolve(analysis);
      },
      resolution: (a) => {
        // a repair saved C7 after resolution read the library (expected revision 0)
        library.entries.set(concurrent.id, concurrent);
        return Promise.resolve({
          ...resolutionOf(a),
          writeRevisions: new Map([["src/components/C5.tsx\u0000default", 3]])
        });
      },
      batch: {
        results: [2, 4, 7].map((id) => ({ ...harness(id), usage: { inputTokens: 10, outputTokens: 5, calls: 1 } })),
        failures: [
          {
            componentId: 5,
            kind: "ai_error",
            aiReason: "network",
            message: "Could not reach the AI provider (or it timed out)."
          }
        ],
        usage: { inputTokens: 30, outputTokens: 15, calls: 3 },
        cancelled: false
      },
      renders: [render(2), failedRender(4, "render_error"), render(7)]
    }
  });
  const logs = recordLogger();
  t.after(logs.restore);
  assert.equal(await h.worker().run(makeJob(1).job), "completed");

  const saves = library.callsOf("saveWritten").map((args) => args[0] as SaveWrittenHarnessInput);
  assert.deepEqual(
    saves.map((s) => [s.identity.filePath, s.status, s.harness === null, s.expectedRevision, s.lastError]),
    [
      ["src/components/C2.tsx", "ready", false, 0, null],
      ["src/components/C4.tsx", "needs_update", false, 0, "[render_error] boom"],
      ["src/components/C5.tsx", "needs_update", true, 3, "Could not reach the AI provider (or it timed out)."],
      ["src/components/C7.tsx", "ready", false, 0, null]
    ]
  );
  const c2 = saves[0];
  assert.ok(c2);
  assert.equal(c2.origin, "run");
  assert.equal(c2.repositoryId, 1);
  assert.equal(c2.stateAllowance, 4, "the repository's allowance snapshotted at job start");
  assert.equal(c2.aiModel, "claude-opus-5-5");
  assert.deepEqual(c2.aiUsage, { inputTokens: 10, outputTokens: 5, calls: 1 });
  assert.equal(c2.sourceFingerprint, "f".repeat(64));
  assert.deepEqual(c2.harness?.states, [{ name: "Default", steps: [] }]);
  assert.equal(saves[1]?.lastFailedVisualizationId, 1);

  const done = h;
  const row = (id: number): Record<string, unknown> | undefined => done.store.row(Table.VISUALIZATION_COMPONENTS, id);
  const saved = library.byIdentity({ filePath: "src/components/C2.tsx", exportName: "default" });
  assert.equal(row(2)?.libraryEntryId, saved?.id);
  assert.equal(row(2)?.harnessOrigin, "written");
  assert.equal(row(2)?.harnessNeedsUpdate, false);
  assert.equal(row(4)?.harnessNeedsUpdate, true, "E5: a harness-attributable failure flags the card");
  assert.equal(row(5)?.harnessOrigin, null, "no harness was written for C5");
  assert.equal(library.entries.get(55)?.revision, 4, "the harness-less entry was replaced at its revision");
  // C7: a newer revision was kept; the row keeps its run snapshot
  assert.equal(library.entries.get(77)?.revision, 4);
  assert.equal(library.entries.get(77)?.origin, "repair");
  assert.equal(row(7)?.libraryEntryId, null);
  assert.equal(row(7)?.harnessOrigin, "written");
  assert.ok(logs.lines.some((line) => line.event === "library.entry.kept_newer" && line.entryId === 77));
  assert.equal(h.row()?.needsUpdateCount, 1);
  assert.ok(
    h
      .consoleRows()
      .some((r) => r.stage === "rendering" && r.message === "Saved 2 new harness(es) to the library; 1 need updating.")
  );
});

test("VisualizationWorkerService.run save-back: reused entries get their status from the status side (E4, E5, E26) and renamed entries move", async (t) => {
  const offBranch = libraryEntry({
    id: 21,
    filePath: "src/components/C1.tsx",
    status: "off_default_branch",
    harnessSource: ENTRY_SOURCE
  });
  const breaking = libraryEntry({ id: 22, filePath: "src/components/C2.tsx", harnessSource: ENTRY_SOURCE });
  const infra = libraryEntry({ id: 23, filePath: "src/components/C3.tsx", harnessSource: ENTRY_SOURCE });
  const renamed = libraryEntry({
    id: 26,
    filePath: "src/components/Old6.tsx",
    displayName: "Old6",
    harnessSource: ENTRY_SOURCE
  });
  const baseOnly = libraryEntry({ id: 28, filePath: "src/components/C8.tsx", harnessSource: ENTRY_SOURCE });
  const library = new FakeLibraryStore([offBranch, breaking, infra, renamed, baseOnly]);
  const analysis = analysisWith([candidate(1), candidate(2), candidate(3), candidate(6), candidate(8)]);
  let h: WorkerHarness | null = null;
  h = setup(t, {
    library,
    steps: {
      analysis: () => {
        h?.store.seed(
          Table.VISUALIZATION_COMPONENTS,
          [1, 2, 3, 6, 8].map((id) =>
            makeComponentRow({ id, visualizationId: 1, filePath: `src/components/C${String(id)}.tsx` })
          )
        );
        return Promise.resolve(analysis);
      },
      resolution: (a) =>
        Promise.resolve(resolutionOf(a, { reuse: { 1: offBranch, 2: breaking, 3: infra, 6: renamed, 8: baseOnly } })),
      renders: [
        render(1),
        failedRender(2, "step_failed"),
        failedRender(3, "vite_unavailable"),
        render(6),
        failedRender(8, "module_load", "base")
      ]
    }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  assert.equal(h.calls.generateAllCandidates?.length, 0, "no AI for reused harnesses");
  assert.equal(
    library.entries.get(21)?.status,
    "ready",
    "an off_default_branch entry is back to ready after a head render"
  );
  assert.equal(library.entries.get(22)?.status, "needs_update");
  assert.equal(library.entries.get(22)?.lastError, "[step_failed] boom");
  assert.equal(library.entries.get(22)?.lastFailedVisualizationId, 1);
  assert.equal(library.entries.get(23)?.status, "ready", "an infrastructure failure leaves the entry unchanged");
  assert.equal(
    library.callsOf("markRenderOutcome").some((args) => args[0] === 23),
    false
  );
  assert.equal(library.entries.get(28)?.status, "ready", "E5: a failure only on the other side keeps the entry");
  assert.deepEqual(library.callsOf("moveIdentity"), [
    [26, { filePath: "src/components/C6.tsx", exportName: "default", displayName: "C6" }]
  ]);
  const done = h;
  const row = (id: number): Record<string, unknown> | undefined => done.store.row(Table.VISUALIZATION_COMPONENTS, id);
  assert.equal(row(1)?.harnessNeedsUpdate, false);
  assert.equal(row(2)?.harnessNeedsUpdate, true);
  assert.equal(row(3)?.harnessNeedsUpdate, false, "infrastructure failures do not flag the card");
  assert.equal(row(8)?.harnessNeedsUpdate, true, "any present side's harness-attributable failure flags the card");
  assert.equal(h.row()?.needsUpdateCount, 2);
  assert.equal(library.callsOf("saveWritten").length, 0);
});

test("VisualizationWorkerService.run save-back: a kept fix-up saves the repaired harness with origin repaired and the fix-up usage", async (t) => {
  const repairedSource = ENTRY_SOURCE.replace("<i />", "<b />");
  let h: WorkerHarness | null = null;
  h = setup(t, {
    steps: {
      analysis: analysisSeeding(
        () => {
          assert.ok(h);
          return h;
        },
        [{}],
        [candidate(1)]
      ),
      batch: {
        results: [{ ...harness(1), usage: { inputTokens: 100, outputTokens: 50, calls: 1 } }],
        failures: [],
        usage: { inputTokens: 100, outputTokens: 50, calls: 1 },
        cancelled: false
      },
      repair: (_id, previous) =>
        Promise.resolve({
          ok: true,
          result: {
            ...previous,
            harnessSource: repairedSource,
            notes: "repaired",
            states: [{ name: "Default", steps: [] }],
            usage: { inputTokens: 40, outputTokens: 20, calls: 1 }
          }
        }),
      renders: async () => {
        assert.ok(h?.calls.renderDeps);
        const deps = h.calls.renderDeps as RenderStageDeps;
        const outcome = await deps.repairHarness(1, harness(1), {
          sides: ["base", "head"],
          kind: "render_error",
          message: "x",
          otherSideMessage: null
        });
        assert.ok(outcome.ok);
        await deps.persistence?.saveRenderResult(1, {
          renderStatus: "rendered",
          baseImagePath: null,
          headImagePath: null,
          imageWidth: null,
          imageHeight: null,
          baseError: null,
          headError: null,
          harness: { harnessSource: repairedSource, harnessNotes: "repaired", mockedModules: [] },
          states: []
        });
        return [render(1)];
      }
    }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  const save = h.library.callsOf("saveWritten")[0]?.[0] as SaveWrittenHarnessInput | undefined;
  assert.equal(save?.harness?.harnessSource, repairedSource);
  assert.equal(save.harness.notes, "repaired");
  assert.deepEqual(save.aiUsage, { inputTokens: 140, outputTokens: 70, calls: 2 }, "generation plus fix-up");
  assert.equal(h.store.row(Table.VISUALIZATION_COMPONENTS, 1)?.harnessOrigin, "repaired");
});

test("VisualizationWorkerService.run save-back failure is one console warning and the run still completes", async (t) => {
  const library = new FakeLibraryStore();
  library.failWrites = new Error("library table locked");
  let h: WorkerHarness | null = null;
  h = setup(t, {
    library,
    steps: {
      analysis: analysisSeeding(() => {
        assert.ok(h);
        return h;
      }, [{}, {}])
    }
  });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  const warnings = h.consoleRows().filter((r) => r.level === "warn" && r.stage === "rendering");
  assert.deepEqual(
    warnings.map((r) => r.message),
    ["Could not update the harness library: library table locked"]
  );
});

test("VisualizationWorkerService.run records working_tree_snapshot when prepare kept the snapshot; the context workspace stays the 00 §8 shape", async (t) => {
  const h = setup(t, {
    visualization: { sourceType: "working_tree", prNumber: null, headRef: "working-tree" },
    prepare: (input) =>
      Promise.resolve({
        ...workspaceFor(input.visualizationId),
        sourceType: "working_tree",
        headSha: null,
        workingTreeSnapshot: true
      })
  });
  assert.equal(await h.worker().run(makeJob(1).job), "completed");
  assert.equal(h.row()?.workingTreeSnapshot, true);
  assert.equal("workingTreeSnapshot" in (h.calls.analyzeCtx?.workspace ?? {}), false);
  const without = setup(t);
  await without.worker().run(makeJob(1).job);
  assert.equal(without.row()?.workingTreeSnapshot, false);
});
