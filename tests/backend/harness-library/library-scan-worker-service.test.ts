import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { Table } from "../../../backend/src/enums";
import { LibraryJobConsole } from "../../../backend/src/services/harness-library/library-job-console";
import {
  CompositeUsageRecorder,
  LibraryJobUsageRecorder,
  SpendCapGuard
} from "../../../backend/src/services/harness-library/library-job-usage-recorder";
import {
  LibraryScanWorkerService,
  type LibraryScanWorkerDependencies
} from "../../../backend/src/services/harness-library/library-scan-worker-service";
import type { ScanWorkspace } from "../../../backend/src/services/harness-library/library-workspace";
import {
  InMemoryRenderPersistence,
  ScanArtifactStore
} from "../../../backend/src/services/harness-library/scan-render-adapters";
import type {
  HarnessGenerationStageDeps,
  PipelineStepFactories,
  RenderStageDeps
} from "../../../backend/src/services/visualizations/pipeline/stage-registry";
import type { HarnessGenerationOptions } from "../../../backend/src/services/visualizations/pipeline/harness-generation-service";
import type { RenderComponentInput } from "../../../backend/src/services/visualizations/pipeline/render-service";
import type {
  ComponentInventory,
  HarnessLibraryEntryRecord,
  InventoryComponent,
  SaveWrittenHarnessInput
} from "../../../backend/src/types/harness-library";
import {
  PipelineStepError,
  type AiProvider,
  type ComponentCandidate,
  type ComponentRenderResult,
  type HarnessGenerationBatchResult,
  type HarnessGenerationResult,
  type PipelineContext
} from "../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import type { ResolvedAiSettings } from "../../../backend/src/utilities/services/ai/ai-provider";
import type { LibraryJob } from "../../../backend/src/utilities/services/queue-service";
import { makeLibraryJobRow, makeRepositoryRow } from "../helpers/factories";
import { FakeLibraryQueue } from "../helpers/fake-library-queue";
import { FakeLibraryStore, libraryEntry } from "../helpers/fake-library-store";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const JOBS = Table.HARNESS_LIBRARY_JOBS;
const SCAN_SHA = "c".repeat(40);
const SETTINGS: ResolvedAiSettings = {
  provider: "anthropic_api",
  model: "claude-opus-5-5",
  harnessEffort: "high",
  summaryEffort: "medium",
  anthropicApiKey: { state: "present", value: "sk-ant-test" }
};
/** 50 000 uncached input tokens with claude-opus-5-5 = $0.20 per call. */
const CALL_USAGE = { inputTokens: 50_000, outputTokens: 0, calls: 1 };

type GenerateBehaviour = "ok" | "cannot_render" | "ai_error" | "auth";
type RenderBehaviour = "ok" | "fail" | "repair";

function component(name: string, overrides: Partial<InventoryComponent> = {}): InventoryComponent {
  return {
    identity: { filePath: `src/components/${name}.tsx`, exportName: name },
    displayName: name,
    selector: null,
    sourceFingerprint: "f".repeat(64),
    childCount: 0,
    layer: 0,
    sourceLines: 12,
    ...overrides
  };
}

function harnessResult(
  candidate: ComponentCandidate,
  source = `harness of ${candidate.displayName}`
): HarnessGenerationResult {
  return {
    componentId: candidate.componentId,
    harnessSource: source,
    mockedModules: [],
    notes: `notes ${candidate.displayName}`,
    states: [
      { name: "Default", steps: [] },
      { name: "Empty", steps: [] }
    ],
    origin: "written",
    libraryEntryId: null,
    usage: { ...CALL_USAGE }
  };
}

/** Scriptable 09/10 fakes that behave like the real stages towards the scan (cap guard, usage, cancel, persistence). */
class FakeEngine {
  generate = new Map<string, GenerateBehaviour>();
  render = new Map<string, RenderBehaviour>();
  batches: ComponentCandidate[][] = [];
  options: Array<Partial<HarnessGenerationOptions> | undefined> = [];
  contexts: PipelineContext[] = [];
  generationDeps: Array<HarnessGenerationStageDeps | undefined> = [];
  renderDeps: RenderStageDeps[] = [];
  imagePaths: string[] = [];
  aiCalls = 0;
  /** Called before each candidate is generated (cancel or shutdown in the middle of a batch). */
  beforeCandidate: (candidate: ComponentCandidate) => Promise<void> = () => Promise.resolve();
  renderError: Error | null = null;

  steps(): PipelineStepFactories {
    const unused = (): never => {
      throw new Error("not used by scans");
    };
    return {
      changeAnalysis: unused,
      libraryResolution: unused,
      imageDiff: unused,
      structuralDiff: unused,
      summary: unused,
      harnessGeneration: (ctx, _queries, deps) => {
        this.contexts.push(ctx);
        this.generationDeps.push(deps);
        return {
          generateAll: (candidates, options) => this.generateAll(ctx, deps, candidates, options),
          repairHarness: async (componentId, previous) => {
            if ((await deps?.shouldStartCall?.()) === false) {
              return { ok: false, reason: "budget_exhausted", message: "stopped" };
            }
            this.aiCalls += 1;
            await deps?.usageRecorder?.add({ ...CALL_USAGE });
            return {
              ok: true,
              result: {
                ...previous,
                componentId,
                harnessSource: `repaired ${previous.harnessSource}`,
                states: [{ name: "Default", steps: [] }],
                usage: { ...CALL_USAGE }
              }
            };
          }
        };
      },
      render: (deps) => {
        this.renderDeps.push(deps);
        return { renderAll: (ctx, inputs) => this.renderAll(ctx, deps, inputs) };
      }
    };
  }

  private async generateAll(
    ctx: PipelineContext,
    deps: HarnessGenerationStageDeps | undefined,
    candidates: readonly ComponentCandidate[],
    options: Partial<HarnessGenerationOptions> | undefined
  ): Promise<HarnessGenerationBatchResult> {
    this.batches.push([...candidates]);
    this.options.push(options);
    const results: HarnessGenerationResult[] = [];
    const failures: HarnessGenerationBatchResult["failures"] = [];
    const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
    for (const candidate of candidates) {
      await this.beforeCandidate(candidate);
      if (ctx.signal.aborted || (await ctx.isCancelled())) {
        return { results, failures, usage, cancelled: true, stopReason: "cancelled" };
      }
      if ((await deps?.shouldStartCall?.()) === false) {
        return { results, failures, usage, cancelled: false, stopReason: "spend_cap" };
      }
      this.aiCalls += 1;
      await deps?.usageRecorder?.add({ ...CALL_USAGE });
      const behaviour = this.generate.get(candidate.displayName) ?? "ok";
      if (behaviour === "auth") {
        throw new PipelineStepError("generating_harnesses", "AI provider error: invalid x-api-key", {
          code: "ai_auth"
        });
      }
      if (behaviour === "cannot_render") {
        failures.push({
          componentId: candidate.componentId,
          kind: "cannot_render",
          aiReason: null,
          message: "Needs a running backend."
        });
      } else if (behaviour === "ai_error") {
        failures.push({
          componentId: candidate.componentId,
          kind: "ai_error",
          aiReason: "network",
          message: "AI request failed (network)."
        });
      } else {
        results.push(harnessResult(candidate));
      }
    }
    return { results, failures, usage, cancelled: false };
  }

  private async renderAll(
    ctx: PipelineContext,
    deps: RenderStageDeps,
    inputs: RenderComponentInput[]
  ): Promise<ComponentRenderResult[]> {
    if (this.renderError) {
      throw this.renderError;
    }
    const out: ComponentRenderResult[] = [];
    for (const input of inputs) {
      const id = input.candidate.componentId;
      const store = deps.artifactStore;
      assert.ok(store, "scans pass their scratch artifact store");
      await store.ensureComponentStateDir(ctx.visualizationId, id, 0);
      const paths = store.stateImagePaths(ctx.visualizationId, id, 0, "head");
      await fs.writeFile(paths.absolutePath, "png");
      this.imagePaths.push(paths.relativePath);
      let behaviour = this.render.get(input.candidate.displayName) ?? "ok";
      let harness: { harnessSource: string; harnessNotes: string; mockedModules: [] } | undefined;
      if (behaviour === "repair") {
        const outcome = await deps.repairHarness(id, input.harness, {
          sides: ["head"],
          kind: "render_error",
          message: "boom",
          otherSideMessage: null
        });
        if (outcome.ok) {
          behaviour = "ok";
          harness = {
            harnessSource: outcome.result.harnessSource,
            harnessNotes: outcome.result.notes,
            mockedModules: []
          };
        } else {
          behaviour = "fail";
        }
      }
      const ok = behaviour === "ok";
      const head = {
        side: "head" as const,
        ok,
        imagePath: ok ? paths.relativePath : null,
        width: ok ? 100 : null,
        height: ok ? 50 : null,
        error: ok ? null : 'State "Empty": render_error: TypeError: items is undefined',
        consoleErrors: [],
        durationMs: 5,
        failureKind: ok ? null : ("render_error" as const)
      };
      await deps.persistence?.saveRenderResult(id, {
        renderStatus: ok ? "rendered" : "failed",
        baseImagePath: null,
        headImagePath: head.imagePath,
        imageWidth: head.width,
        imageHeight: head.height,
        baseError: null,
        headError: head.error,
        states: [],
        ...(harness ? { harness } : {})
      });
      out.push({ componentId: id, base: null, head, states: [{ ordinal: 0, stateName: "Default", base: null, head }] });
    }
    return out;
  }
}

interface Harness {
  db: InMemoryQueryHandler;
  store: FakeLibraryStore;
  engine: FakeEngine;
  queue: FakeLibraryQueue;
  dataDir: string;
  cleanups: Array<{ jobId: number }>;
  service: LibraryScanWorkerService;
  job(): { job: LibraryJob; cancel(): void; shutdown(): void };
  events(): string[];
  jobRow(): Record<string, unknown> | undefined;
  saves(): SaveWrittenHarnessInput[];
}

async function setup(
  t: TestContext,
  options: {
    components?: InventoryComponent[];
    truncated?: boolean;
    entries?: HarnessLibraryEntryRecord[];
    jobOverrides?: Parameters<typeof makeLibraryJobRow>[0];
    batchSize?: number;
    maxRuntimeMs?: number;
    deps?: Partial<LibraryScanWorkerDependencies>;
  } = {}
): Promise<Harness> {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-scan-test-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const db = new InMemoryQueryHandler();
  db.now = () => NOW;
  db.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, name: "shop", localPath: "/srv/repos/shop" })]);
  db.seed(JOBS, [makeLibraryJobRow({ id: 3, ...options.jobOverrides })]);
  const qh = db as unknown as QueryHandler;
  const store = new FakeLibraryStore(options.entries ?? []);
  const engine = new FakeEngine();
  const queue = new FakeLibraryQueue();
  const cleanups: Array<{ jobId: number }> = [];
  const inventory: ComponentInventory = {
    framework: "react_vite",
    components: options.components ?? [component("Badge"), component("Button"), component("Card")],
    truncated: options.truncated ?? false,
    warnings: options.truncated === true ? ["More than 3 components found; the library covers the first 3."] : []
  };
  const headDir = path.join(dataDir, "worktrees", "scan-3", "head");
  const prepared: ScanWorkspace = {
    root: path.dirname(headDir),
    headDir,
    workspace: {
      visualizationId: 0,
      repositoryPath: "/srv/repos/shop",
      baseDir: headDir,
      headDir,
      baseSha: SCAN_SHA,
      headSha: SCAN_SHA,
      sourceType: "local_branch",
      dependencyDrift: false
    }
  };
  const service = new LibraryScanWorkerService({
    queryHandler: qh,
    store,
    readAiSettings: () => Promise.resolve(SETTINGS),
    createProvider: () => ({ kind: "anthropic_api" }) as AiProvider,
    stepsFor: () => engine.steps(),
    workspace: {
      resolveScanCommit: () => Promise.resolve(SCAN_SHA),
      prepare: () => Promise.resolve(prepared),
      cleanup: (input) => {
        cleanups.push({ jobId: input.jobId });
        return Promise.resolve();
      }
    },
    inventory: { inventory: () => Promise.resolve(inventory) },
    createSourceQueries: () => Promise.resolve({} as never),
    queue,
    consoleFactory: (jobId) => new LibraryJobConsole(jobId, qh),
    createScratchStore: (jobId) => new ScanArtifactStore(jobId, dataDir),
    now: () => NOW,
    limits: { maxRuntimeMs: options.maxRuntimeMs ?? 60_000, batchSize: options.batchSize ?? 12 },
    ...options.deps
  });
  return {
    db,
    store,
    engine,
    queue,
    dataDir,
    cleanups,
    service,
    job: () => {
      const controller = new AbortController();
      return {
        job: { libraryJobId: 3, jobId: "scan-3", signal: controller.signal },
        cancel: () => {
          queue.flags.add(3);
          controller.abort("cancelled");
        },
        shutdown: () => {
          controller.abort("shutdown");
        }
      };
    },
    events: () => db.rows(Table.HARNESS_LIBRARY_JOB_EVENTS).map((row) => String(row.message)),
    jobRow: () => db.row(JOBS, 3),
    saves: () => store.callsOf("saveWritten").map((args) => args[0] as SaveWrittenHarnessInput)
  };
}

// ----- batches and the visualization-id-0 contract -----

test("targets run in inventory order in batches of LIBRARY_SCAN_BATCH_SIZE with scan-local synthetic candidates", async (t) => {
  const names = Array.from({ length: 14 }, (_, i) => `C${String(i).padStart(2, "0")}`);
  const h = await setup(t, { components: names.map((name) => component(name)), jobOverrides: { stateAllowance: 2 } });
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.deepEqual(
    h.engine.batches.map((batch) => batch.length),
    [12, 2]
  );
  const all = h.engine.batches.flat();
  assert.deepEqual(
    all.map((candidate) => candidate.displayName),
    names
  );
  assert.deepEqual(
    all.map((candidate) => candidate.componentId),
    names.map((_, i) => i + 1)
  );
  assert.deepEqual(all[13], {
    componentId: 14,
    filePath: "src/components/C13.tsx",
    exportName: "C13",
    displayName: "C13",
    changeKind: "added",
    rank: 13,
    codeDiff: null,
    reason: "whole-app scan"
  });
  assert.deepEqual(h.engine.options[0], { stateAllowance: 2, purpose: "library" });
  const ctx = h.engine.contexts[0];
  assert.equal(ctx?.visualizationId, 0);
  assert.deepEqual(ctx.libraryJob, { kind: "scan", libraryJobId: 3 });
  assert.deepEqual(ctx.library, { stateAllowance: 2, buildMode: "scan" });
  assert.equal(ctx.workspace.headSha, SCAN_SHA);
  assert.equal(ctx.repository.renderViewport, "desktop");
  const deps = h.engine.generationDeps[0];
  assert.equal(deps?.persistence?.constructor.name, "NoopHarnessPersistence");
  assert.ok(deps.usageRecorder instanceof LibraryJobUsageRecorder);
  assert.equal(typeof deps.shouldStartCall, "function");
  const renderDeps = h.engine.renderDeps[0];
  assert.ok(renderDeps?.persistence instanceof InMemoryRenderPersistence);
  assert.ok(renderDeps.artifactStore instanceof ScanArtifactStore);
  const job = h.jobRow();
  assert.equal(job?.status, "completed");
  assert.equal(job.totalCount, 14);
  assert.equal(job.writtenCount, 14);
  assert.equal(job.scanSha, SCAN_SHA);
});

test("a scan touches no artifacts/ path and no visualization row; scratch renders are deleted", async (t) => {
  const h = await setup(t);
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.equal(h.engine.imagePaths.length, 3);
  for (const relativePath of h.engine.imagePaths) {
    assert.match(relativePath, /^library-jobs\/3\/renders\/\d+\/head\.png$/);
  }
  const touched = new Set(h.db.calls.map((call) => call.table));
  assert.equal(touched.has(Table.VISUALIZATIONS), false);
  assert.equal(touched.has(Table.VISUALIZATION_COMPONENTS), false);
  assert.equal(touched.has(Table.VISUALIZATION_COMPONENT_STATES), false);
  await assert.rejects(fs.stat(path.join(h.dataDir, "library-jobs", "3")), /ENOENT/);
  await assert.rejects(fs.stat(path.join(h.dataDir, "artifacts")), /ENOENT/);
});

// ----- saving (16 §10.4 step 7.5) -----

test("save rules: ready, needs_update with the first failing state, cannot_render without a harness, generation failure", async (t) => {
  const h = await setup(t, {
    components: [component("Good"), component("Broken"), component("Backend"), component("Flaky")]
  });
  h.engine.render.set("Broken", "fail");
  h.engine.generate.set("Backend", "cannot_render");
  h.engine.generate.set("Flaky", "ai_error");
  assert.equal(await h.service.run(h.job().job), "completed");
  const [good, broken, backend, flaky] = h.saves();
  assert.equal(good?.status, "ready");
  assert.equal(good.origin, "scan");
  assert.equal(good.lastError, null);
  assert.equal(good.harness?.harnessSource, "harness of Good");
  assert.deepEqual(
    good.harness.states.map((state) => state.name),
    ["Default", "Empty"]
  );
  assert.equal(good.sourceFingerprint, "f".repeat(64));
  assert.equal(good.stateAllowance, 3);
  assert.equal(good.aiModel, "claude-opus-5-5");
  assert.deepEqual(good.aiUsage, CALL_USAGE);
  assert.equal(good.lastFailedVisualizationId, null);
  assert.equal(broken?.status, "needs_update");
  assert.equal(broken.harness?.harnessSource, "harness of Broken");
  assert.equal(broken.lastError, 'State "Empty": render_error: TypeError: items is undefined');
  assert.equal(backend?.harness, null);
  assert.equal(backend.status, "needs_update");
  assert.equal(backend.lastError, "cannot_render: Needs a running backend.");
  assert.equal(flaky?.harness, null);
  assert.equal(flaky.lastError, "AI request failed (network).");
  const job = h.jobRow();
  assert.deepEqual([job?.writtenCount, job?.failedCount, job?.skippedCount], [1, 2, 1]);
  const events = h.events();
  assert.ok(events.includes("Good: 2 state(s) saved."));
  assert.ok(
    events.includes('Broken: harness needs updating (State "Empty": render_error: TypeError: items is undefined).')
  );
  assert.ok(events.includes("Backend: harness needs updating (cannot_render: Needs a running backend.)."));
  assert.equal(events.at(-1), "Done: 1 saved, 2 need updating, 1 skipped.");
});

test("a fix-up kept by the render is saved as the harness, with the fix-up usage added", async (t) => {
  const h = await setup(t, { components: [component("Fixed")] });
  h.engine.render.set("Fixed", "repair");
  assert.equal(await h.service.run(h.job().job), "completed");
  const [saved] = h.saves();
  assert.equal(saved?.status, "ready");
  assert.equal(saved.harness?.harnessSource, "repaired harness of Fixed");
  assert.deepEqual(saved.aiUsage, { inputTokens: 100_000, outputTokens: 0, calls: 2 });
});

test("expectedRevision is 0 for new targets and the start revision for rescan targets", async (t) => {
  const entries = [
    libraryEntry({ id: 10, filePath: "src/components/Badge.tsx", exportName: "Badge", revision: 4 }),
    libraryEntry({ id: 11, filePath: "src/components/Button.tsx", exportName: "Button", revision: 2 })
  ];
  const scan = await setup(t, { entries });
  assert.equal(await scan.service.run(scan.job().job), "completed");
  assert.deepEqual(
    scan.saves().map((save) => [save.identity.exportName, save.expectedRevision]),
    [["Card", 0]]
  );
  assert.equal(scan.jobRow()?.totalCount, 1, "scan writes only what is missing");

  const rescan = await setup(t, { entries, jobOverrides: { kind: "rescan" } });
  assert.equal(await rescan.service.run(rescan.job().job), "completed");
  assert.deepEqual(
    rescan.saves().map((save) => [save.identity.exportName, save.expectedRevision]),
    [
      ["Badge", 4],
      ["Button", 2],
      ["Card", 0]
    ]
  );
  assert.equal(rescan.store.byIdentity({ filePath: "src/components/Badge.tsx", exportName: "Badge" })?.revision, 5);
});

test("a rescan keeps the previous ready harness when the rewritten one fails, and keeps a harness on writing failures", async (t) => {
  const entries = [
    libraryEntry({ id: 10, filePath: "src/components/Badge.tsx", exportName: "Badge", harnessSource: "old badge" }),
    libraryEntry({ id: 11, filePath: "src/components/Button.tsx", exportName: "Button", harnessSource: "old button" }),
    libraryEntry({
      id: 12,
      filePath: "src/components/Card.tsx",
      exportName: "Card",
      status: "needs_update",
      lastError: "old error"
    })
  ];
  const h = await setup(t, { entries, jobOverrides: { kind: "rescan" } });
  h.engine.render.set("Badge", "fail");
  h.engine.generate.set("Button", "ai_error");
  h.engine.render.set("Card", "fail");
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.deepEqual(
    h.saves().map((save) => save.identity.exportName),
    ["Card"],
    "only the needs_update entry is rewritten"
  );
  assert.equal(h.store.entries.get(10)?.harnessSource, "old badge");
  assert.equal(h.store.entries.get(11)?.harnessSource, "old button");
  assert.equal(h.store.entries.get(12)?.harnessSource, "harness of Card");
  const events = h.events();
  assert.ok(
    events.includes(
      'Kept the previous harness for Badge: the rewritten one did not render (State "Empty": render_error: TypeError: items is undefined).'
    )
  );
  assert.ok(
    events.includes("Kept the previous harness for Button: writing a new one failed (AI request failed (network).).")
  );
  assert.deepEqual([h.jobRow()?.writtenCount, h.jobRow()?.failedCount], [0, 3]);
});

test("a newer revision saved meanwhile is kept: skipped with 'Kept a newer revision of <name>.'", async (t) => {
  const h = await setup(t, { components: [component("Badge")] });
  h.engine.beforeCandidate = () => {
    // A run saves the entry while the scan is writing it.
    h.store.entries.set(
      50,
      libraryEntry({ id: 50, filePath: "src/components/Badge.tsx", exportName: "Badge", origin: "run" })
    );
    return Promise.resolve();
  };
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.equal(h.store.entries.get(50)?.origin, "run");
  assert.equal(h.jobRow()?.skippedCount, 1);
  assert.ok(h.events().includes("Kept a newer revision of Badge."));
});

// ----- E26: default-branch status, never deleting -----

test("a complete inventory marks missing entries off_default_branch (never deletes) and restores marked entries found again", async (t) => {
  const entries = [
    libraryEntry({ id: 1, filePath: "src/components/Badge.tsx", exportName: "Badge", status: "off_default_branch" }),
    libraryEntry({ id: 2, filePath: "src/components/Gone.tsx", exportName: "Gone" }),
    libraryEntry({ id: 3, filePath: "src/components/Card.tsx", exportName: "Unexported" }),
    libraryEntry({ id: 4, filePath: "src/components/Old.tsx", exportName: "Old", status: "off_default_branch" })
  ];
  const h = await setup(t, { entries });
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.equal(h.store.entries.size, 4 + 2, "two new entries, none deleted");
  assert.equal(h.store.entries.get(1)?.status, "ready");
  assert.equal(h.store.entries.get(2)?.status, "off_default_branch");
  assert.equal(h.store.entries.get(3)?.status, "off_default_branch");
  assert.equal(h.store.entries.get(4)?.status, "off_default_branch");
  assert.deepEqual(h.store.callsOf("restoreOnDefaultBranch"), [[1, [1]]]);
  const marked = h.store.callsOf("markOffDefaultBranch");
  assert.equal(marked.length, 1);
  assert.deepEqual([...(marked[0]?.[1] as number[])].sort(), [2, 3]);
  const events = h.events();
  assert.ok(events.includes("1 saved harness(es) are on the default branch again."));
  assert.ok(
    events.includes(
      "2 saved harness(es) are not on the default branch; they are kept, left out of the library counts and global re-checks, and reused by runs that need them."
    )
  );
  assert.deepEqual(
    h.saves().map((save) => save.identity.exportName),
    ["Button", "Card"],
    "marked and restored entries are not targets of a scan"
  );
});

test("a truncated inventory marks nothing; the step-4 events appear only when something changed", async (t) => {
  const entries = [libraryEntry({ id: 2, filePath: "src/components/Gone.tsx", exportName: "Gone" })];
  const h = await setup(t, { entries, truncated: true });
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.equal(h.store.callsOf("markOffDefaultBranch").length, 0);
  assert.equal(h.store.entries.get(2)?.status, "ready");
  const events = h.events();
  assert.ok(events.includes("More than 3 components found; the library covers the first 3."));
  assert.equal(
    events.some((message) => message.includes("default branch")),
    false
  );
});

// ----- spending cap (16 §10.5, E16) -----

test("the cap guard counts in-flight calls: 4 concurrent calls near the cap admit only what fits, usage releases them", async () => {
  // Default expectation for claude-opus-5-5: (16 500·4 + 3 500·0.2 + 7 000·20) / 1e6 = $0.2067 per call.
  const guard = new SpendCapGuard(0.5, "claude-opus-5-5");
  assert.equal(guard.expectedCallUsd(), 0.2067);
  const admitted = await Promise.all([1, 2, 3, 4].map(() => guard.shouldStartCall()));
  assert.deepEqual(admitted, [true, true, false, false]);
  assert.equal(guard.inFlight, 2);
  guard.onUsageRecorded({ spentUsd: 0.05, calls: 1 });
  assert.equal(guard.inFlight, 1);
  assert.equal(await guard.shouldStartCall(), true, "0.05 + 2 × 0.2067 fits in 0.5");
  assert.equal(await guard.shouldStartCall(), false);
  guard.onUsageRecorded({ spentUsd: 0.1, calls: 2 });
  guard.onUsageRecorded({ spentUsd: 0.15, calls: 3 });
  guard.onUsageRecorded({ spentUsd: 0.2, calls: 4 });
  assert.equal(guard.inFlight, 0, "never below 0");
  assert.equal(guard.expectedCallUsd(), 0.05, "the job's own mean after 3 calls");
  const uncapped = new SpendCapGuard(null, "claude-opus-5-5");
  assert.deepEqual(await Promise.all([1, 2, 3, 4, 5, 6].map(() => uncapped.shouldStartCall())), Array(6).fill(true));
});

test("the job usage recorder serializes read-add-write of ai_usage and prices spent_usd with the job's model", async () => {
  const db = new InMemoryQueryHandler();
  db.seed(JOBS, [makeLibraryJobRow({ id: 3, aiModel: "claude-opus-5-5" })]);
  const guard = new SpendCapGuard(10, "claude-opus-5-5");
  await guard.shouldStartCall();
  await guard.shouldStartCall();
  const recorder = new LibraryJobUsageRecorder(3, "claude-opus-5-5", db, undefined, guard);
  const totals = await Promise.all([
    recorder.add({ ...CALL_USAGE }),
    recorder.add({ ...CALL_USAGE, cacheReadInputTokens: 10_000 })
  ]);
  assert.deepEqual(totals[1], { inputTokens: 100_000, outputTokens: 0, calls: 2, cacheReadInputTokens: 10_000 });
  const row = db.row(JOBS, 3);
  assert.deepEqual(row?.aiUsage, totals[1]);
  assert.equal(row.spentUsd, 0.362); // (90 000·4 + 10 000·0.2) / 1e6
  assert.deepEqual(recorder.current(), { spentUsd: 0.362, calls: 2 });
  assert.equal(guard.inFlight, 0);

  const other: Array<{ calls: number }> = [];
  const composite = new CompositeUsageRecorder([
    recorder,
    { add: (usage) => Promise.resolve(other.push(usage) > 0 ? { ...usage } : usage) }
  ]);
  await composite.add({ ...CALL_USAGE });
  assert.equal(other.length, 1);
  assert.equal(recorder.current().calls, 3);
});

test("cap reached: calls in flight finish and are saved, nothing new starts, the job ends cap_reached", async (t) => {
  const names = ["A", "B", "C", "D", "E", "F", "G"].map((name) => component(name));
  const h = await setup(t, { components: names, jobOverrides: { spendCapUsd: 0.5 }, batchSize: 3 });
  assert.equal(await h.service.run(h.job().job), "cap_reached");
  assert.equal(h.engine.aiCalls, 2, "the third call would cross the cap");
  assert.equal(h.engine.batches.length, 1, "no further batch starts");
  assert.deepEqual(
    h.saves().map((save) => save.identity.exportName),
    ["A", "B"]
  );
  const job = h.jobRow();
  assert.equal(job?.status, "cap_reached");
  assert.equal(job.spentUsd, 0.4);
  assert.equal(job.errorMessage, "Stopped at the spending cap of $0.50 (spent $0.40).");
  assert.equal(h.events().at(-1), "Stopped at the spending cap of $0.50 (spent $0.40).");
  assert.equal(h.store.byIdentity({ filePath: "src/components/C.tsx", exportName: "C" }), undefined, "C stays missing");
});

test("a job whose spend already leaves no room for one call stops before its first batch", async (t) => {
  const h = await setup(t, { jobOverrides: { spendCapUsd: 0.5, spentUsd: 0.45 } });
  assert.equal(await h.service.run(h.job().job), "cap_reached");
  assert.equal(h.engine.batches.length, 0);
});

// ----- cancel, failure, shutdown, limits -----

test("cancel finishes the current batch (verified and saved) and ends cancelled; no new batch starts", async (t) => {
  const names = ["A", "B", "C", "D", "E"].map((name) => component(name));
  const h = await setup(t, { components: names, batchSize: 3 });
  const handle = h.job();
  h.engine.beforeCandidate = (candidate) => {
    if (candidate.displayName === "C") {
      handle.cancel();
    }
    return Promise.resolve();
  };
  assert.equal(await h.service.run(handle.job), "cancelled");
  assert.equal(h.engine.batches.length, 1);
  assert.deepEqual(
    h.saves().map((save) => save.identity.exportName),
    ["A", "B"]
  );
  assert.equal(h.engine.imagePaths.length, 2, "the batch's harnesses were verified");
  const job = h.jobRow();
  assert.equal(job?.status, "cancelled");
  assert.equal(job.writtenCount, 2);
  assert.equal(h.events().at(-1), "Cancelled. 2 harness(es) written so far are kept.");
  assert.deepEqual(h.cleanups, [{ jobId: 3 }]);
  assert.equal(h.queue.flags.has(3), false, "the cancel flag is cleared");
});

test("a job cancelled before it started ends cancelled without a workspace", async (t) => {
  const h = await setup(t);
  h.queue.flags.add(3);
  assert.equal(await h.service.run(h.job().job), "cancelled");
  assert.equal(h.jobRow()?.status, "cancelled");
  assert.deepEqual(h.cleanups, []);
  assert.equal(h.engine.batches.length, 0);
});

test("zero targets: the job completes with 'Nothing to write'", async (t) => {
  const entries = ["Badge", "Button", "Card"].map((name, i) =>
    libraryEntry({ id: i + 1, filePath: `src/components/${name}.tsx`, exportName: name })
  );
  const h = await setup(t, { entries });
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.equal(h.engine.batches.length, 0);
  assert.equal(h.jobRow()?.totalCount, 0);
  assert.equal(h.events().at(-1), "Nothing to write: every component has a saved harness.");
  assert.ok(
    h.events().includes(`Scanning 0 components at ${SCAN_SHA.slice(0, 7)} with claude-opus-5-5, up to 3 states each.`)
  );
  assert.ok(h.events().includes("Found 3 components in . (1 layers, smallest first)."));
});

test("a missing default branch fails the job; the workspace is still cleaned up", async (t) => {
  const h = await setup(t, {
    deps: {
      workspace: {
        resolveScanCommit: () =>
          Promise.reject(new PipelineStepError("preparing", "The default branch main was not found in the clone.")),
        prepare: () => Promise.reject(new Error("not reached")),
        cleanup: () => Promise.resolve()
      }
    }
  });
  assert.equal(await h.service.run(h.job().job), "failed");
  const job = h.jobRow();
  assert.equal(job?.status, "failed");
  assert.equal(job.errorMessage, "The default branch main was not found in the clone.");
  assert.equal(h.events().at(-1), "The default branch main was not found in the clone.");
});

test("a removed repository fails the job; non-queued or repair jobs are skipped without writes", async (t) => {
  const removed = await setup(t);
  await removed.db.update({ isDeleted: true }, { id: 1 }, Table.REPOSITORIES);
  assert.equal(await removed.service.run(removed.job().job), "failed");
  assert.equal(removed.jobRow()?.errorMessage, "The repository was removed.");

  const running = await setup(t, { jobOverrides: { status: "running" } });
  assert.equal(await running.service.run(running.job().job), "skipped");
  const repair = await setup(t, { jobOverrides: { kind: "repair", visualizationId: 4, componentIds: [1] } });
  assert.equal(await repair.service.run(repair.job().job), "skipped");
  assert.equal(repair.db.callsFor("update").length, 0);
});

test("an AI auth error fails the job with 07's message; entries saved by earlier batches are kept", async (t) => {
  const names = ["A", "B", "C", "D"].map((name) => component(name));
  const h = await setup(t, { components: names, batchSize: 2 });
  h.engine.generate.set("C", "auth");
  assert.equal(await h.service.run(h.job().job), "failed");
  assert.equal(h.jobRow()?.errorMessage, "AI provider error: invalid x-api-key");
  assert.deepEqual(
    h.saves().map((save) => save.identity.exportName),
    ["A", "B"]
  );
  assert.deepEqual(h.cleanups, [{ jobId: 3 }]);
  await assert.rejects(fs.stat(path.join(h.dataDir, "library-jobs", "3")), /ENOENT/);
});

test("a render stage failure saves the batch's harnesses as needing an update, then fails the job", async (t) => {
  const h = await setup(t, { components: [component("A")] });
  h.engine.renderError = new PipelineStepError("rendering", "Vite could not start: missing plugin.");
  assert.equal(await h.service.run(h.job().job), "failed");
  const [saved] = h.saves();
  assert.equal(saved?.status, "needs_update");
  assert.equal(saved.harness?.harnessSource, "harness of A");
  assert.equal(saved.lastError, "Vite could not start: missing plugin.");
  assert.equal(h.jobRow()?.errorMessage, "Vite could not start: missing plugin.");
});

test("a worker shutdown fails the job with the restart message and still cleans up", async (t) => {
  const h = await setup(t, { components: [component("A"), component("B")] });
  const handle = h.job();
  h.engine.beforeCandidate = (candidate) => {
    if (candidate.displayName === "B") {
      handle.shutdown();
    }
    return Promise.resolve();
  };
  assert.equal(await h.service.run(handle.job), "failed");
  assert.equal(
    h.jobRow()?.errorMessage,
    "PRVision stopped while this scan was running. Continue scan to write the rest."
  );
  assert.equal(h.saves().length, 0, "nothing is saved from an aborted batch");
  assert.deepEqual(h.cleanups, [{ jobId: 3 }]);
  assert.deepEqual(
    h.queue.calls.filter((call) => call.startsWith("clearCancel")),
    ["clearCancel:3"]
  );
});

test("the 8-hour limit fails the job with 'Stopped after 8 hours (time limit). Continue scan to write the rest.'", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = await setup(t, { maxRuntimeMs: 8 * 60 * 60_000, components: [component("A")] });
  h.engine.beforeCandidate = () => {
    t.mock.timers.tick(8 * 60 * 60_000);
    return Promise.resolve();
  };
  assert.equal(await h.service.run(h.job().job), "failed");
  assert.equal(h.jobRow()?.errorMessage, "Stopped after 8 hours (time limit). Continue scan to write the rest.");
});

// ----- scratch adapters -----

test("ScanArtifactStore maps (0, component, ordinal, kind) into the job folder and rejects other ids", async (t) => {
  const dataDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-scan-store-")));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const store = new ScanArtifactStore(9, dataDir);
  assert.deepEqual(store.stateImagePaths(0, 4, 0, "head"), {
    absolutePath: path.join(dataDir, "library-jobs", "9", "renders", "4", "head.png"),
    relativePath: "library-jobs/9/renders/4/head.png"
  });
  assert.equal(store.stateImagePaths(0, 4, 2, "base").relativePath, "library-jobs/9/renders/4/s2/base.png");
  assert.equal(store.imagePaths(0, 4, "head").relativePath, "library-jobs/9/renders/4/head.png");
  assert.throws(() => store.stateImagePaths(7, 4, 0, "head"), /visualization id 0/);
  assert.throws(() => store.stateImagePaths(0, 0, 0, "head"), /component id/);
  assert.throws(() => store.stateImagePaths(0, 4, 10, "head"), /ordinal/);
  assert.throws(() => store.stateImagePaths(0, 4, 0, "../x"), /image kind/);
  await store.ensureComponentStateDir(0, 4, 2);
  await fs.writeFile(store.stateImagePaths(0, 4, 2, "head").absolutePath, "png");
  await store.clear();
  await assert.rejects(fs.stat(store.rendersDir), /ENOENT/);
  await store.removeJobDir();
  await assert.rejects(fs.stat(path.join(dataDir, "library-jobs", "9")), /ENOENT/);
});

test("a rescan sees an entry restored to the default branch as ready (keeps it when the rewrite fails)", async (t) => {
  const entries = [
    libraryEntry({
      id: 1,
      filePath: "src/components/Badge.tsx",
      exportName: "Badge",
      status: "off_default_branch",
      harnessSource: "old badge",
      revision: 3
    })
  ];
  const h = await setup(t, { entries, components: [component("Badge")], jobOverrides: { kind: "rescan" } });
  h.engine.render.set("Badge", "fail");
  assert.equal(await h.service.run(h.job().job), "completed");
  assert.equal(h.saves().length, 0);
  assert.equal(h.store.entries.get(1)?.status, "ready");
  assert.equal(h.store.entries.get(1)?.harnessSource, "old badge");
});
