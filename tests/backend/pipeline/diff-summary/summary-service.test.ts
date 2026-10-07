import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { SUMMARY_MAX_TOTAL_IMAGE_BYTES, SUMMARY_PROMPT_MAX_CHARS } from "../../../../backend/src/config-consts";
import { Table } from "../../../../backend/src/enums";
import { AiUsageRecorder } from "../../../../backend/src/services/visualizations/pipeline/ai-usage-recorder";
import {
  ANGULAR_SUMMARY_SYSTEM_PROMPT,
  SUMMARY_JSON_SCHEMA,
  SUMMARY_SYSTEM_PROMPT,
  type SummaryAiOutput
} from "../../../../backend/src/services/visualizations/pipeline/summary-prompts";
import {
  SummaryService,
  type SummaryDeps
} from "../../../../backend/src/services/visualizations/pipeline/summary-service";
import {
  AiProviderError,
  PipelineStepError,
  type AiStructuredRequest,
  type ChangeAnalysisResult,
  type ComponentSourceQueries
} from "../../../../backend/src/types/visualization-pipeline";
import type { Transaction } from "../../../../backend/src/utilities";
import type { Script } from "../../helpers/ai-provider-stub";
import type { ComponentRow, VisualizationRow } from "../../helpers/factories";
import { createPipelineContext, type PipelineContextHandle } from "../../helpers/pipeline-context";
import {
  VISUALIZATION_ID,
  artifactPath,
  decodePng,
  encodePng,
  memoryArtifactStore,
  pixelAt,
  recordingQueryHandler,
  solidPng,
  withRect,
  type MemoryArtifactStore,
  type RecordingQueryHandler
} from "./helpers/png-fixtures";

const BASE_DIR = "/worktrees/1/base";
const HEAD_DIR = "/worktrees/1/head";
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const SMALL_PNG = encodePng(solidPng(10, 10, WHITE));

interface Setup {
  service: SummaryService;
  handle: PipelineContextHandle;
  db: RecordingQueryHandler;
  store: MemoryArtifactStore;
  transactions: Array<{ start: number; end: number }>;
  analysis: ChangeAnalysisResult;
}

interface SetupOptions {
  components: Array<Partial<ComponentRow>>;
  visualization?: Partial<VisualizationRow>;
  script?: Script;
  files?: Record<string, Buffer>;
  analysis?: Partial<ChangeAnalysisResult>;
  sources?: { base?: Record<string, string>; head?: Record<string, string> };
  runInTransaction?: SummaryDeps["runInTransaction"];
  repository?: Partial<PipelineContextHandle["context"]["repository"]>;
}

function setup(options: SetupOptions): Setup {
  const db = recordingQueryHandler(options.components, {
    status: "summarizing",
    ...options.visualization
  });
  const store = memoryArtifactStore(options.files ?? {});
  const handle = createPipelineContext({
    visualizationId: VISUALIZATION_ID,
    dataDir: "/tmp/unused",
    repositoryPath: "/tmp/repo",
    baseDir: BASE_DIR,
    headDir: HEAD_DIR,
    ...(options.script ? { script: options.script } : {}),
    ...(options.repository ? { repository: options.repository } : {})
  });
  const transactions: Array<{ start: number; end: number }> = [];
  const service = new SummaryService({
    artifactStore: store,
    createQueryHandler: () => db.asQueryHandler(),
    createUsageRecorder: (id) => new AiUsageRecorder(id, db.asQueryHandler()),
    readSource: (root, repoPath) => {
      const side = root === BASE_DIR ? options.sources?.base : options.sources?.head;
      return Promise.resolve(side?.[repoPath] ?? null);
    },
    runInTransaction:
      options.runInTransaction ??
      (async <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> => {
        const start = db.calls.length;
        const result = await fn({} as Transaction);
        transactions.push({ start, end: db.calls.length });
        return result;
      })
  });
  const analysis: ChangeAnalysisResult = {
    candidates: [],
    skipped: [],
    changedFiles: [{ path: "src/components/C1.tsx", status: "M" }],
    sourceQueries: {} as ComponentSourceQueries,
    globalStyleChanges: [],
    ...options.analysis
  };
  return { service, handle, db, store, transactions, analysis };
}

/** A changed component row with base/head/diff images at the standard paths. */
function changedRow(id: number, ratio: number, overrides: Partial<ComponentRow> = {}): Partial<ComponentRow> {
  return {
    id,
    rank: id,
    visualChange: "changed",
    diffPixelRatio: ratio,
    imageWidth: 10,
    imageHeight: 10,
    baseImagePath: artifactPath(id, "base"),
    headImagePath: artifactPath(id, "head"),
    diffImagePath: artifactPath(id, "diff"),
    codeDiff: "@@ -1 +1 @@\n-a\n+b",
    ...overrides
  };
}

function imagesFor(ids: number[], kinds: Array<"base" | "head" | "diff"> = ["base", "head"]): Record<string, Buffer> {
  const out: Record<string, Buffer> = {};
  for (const id of ids) {
    for (const kind of kinds) {
      out[artifactPath(id, kind)] = SMALL_PNG;
    }
  }
  return out;
}

function aiData(ids: number[], overrides: Partial<SummaryAiOutput> = {}): SummaryAiOutput {
  return {
    summaryMarkdown: "- **C1** is taller.",
    components: ids.map((componentId) => ({
      componentId,
      note: `Note ${String(componentId)}.`,
      risk: "check" as const
    })),
    ...overrides
  };
}

function summaryRequest(handle: PipelineContextHandle): AiStructuredRequest {
  const [request] = handle.ai.callsFor("summary");
  assert.ok(request, "summary request sent");
  return request;
}

function vizRow(db: RecordingQueryHandler): Record<string, unknown> {
  const row = db.row(Table.VISUALIZATIONS, VISUALIZATION_ID);
  assert.ok(row);
  return row;
}

function componentRow(db: RecordingQueryHandler, id: number): Record<string, unknown> {
  const row = db.row(Table.VISUALIZATION_COMPONENTS, id);
  assert.ok(row);
  return row;
}

/** Index in db.calls of the first update whose values contain `key`. */
function updateIndex(db: RecordingQueryHandler, key: string): number {
  return db.calls.findIndex((call) => call.method === "update" && key in (call.args[0] as Record<string, unknown>));
}

test("zero detailed components skips AI and writes fixed summary", async () => {
  const s = setup({
    components: [
      { id: 1, visualChange: "unchanged", diffPixelRatio: 0 },
      { id: 2, visualChange: "unchanged", diffPixelRatio: 0.0001 },
      {
        id: 3,
        renderStatus: "skipped",
        visualChange: null,
        skipReason: "Over the 12-component limit"
      }
    ]
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  const text =
    "PRVision rendered 2 component(s) and found no visual differences (every component changed less than 0.05% of its pixels). 1 more component(s) were not rendered because of the 12-component limit.";
  assert.deepEqual(outcome, {
    status: "fixed",
    summaryMarkdown: text,
    usage: null,
    failureReason: null
  });
  assert.equal(s.handle.ai.requests.length, 0);
  assert.equal(vizRow(s.db).summaryMarkdown, text);
  assert.equal(vizRow(s.db).aiUsage, null);
  assert.deepEqual(s.db.updatesFor(3), []);
  assert.equal(s.transactions.length, 1);
  assert.ok(s.handle.console.has("info", "No visual changes found; summary written without AI.", "summarizing"));
});

test("unchanged rows get risk none", async () => {
  const s = setup({
    components: [changedRow(1, 0.2), { id: 2, visualChange: "unchanged", diffPixelRatio: 0, aiNote: "stale" }],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(componentRow(s.db, 2).risk, "none");
  assert.equal(componentRow(s.db, 2).aiNote, null);
  assert.ok(
    summaryRequest(s.handle).prompt.includes("# Components with no visual change\n- [#2] C2 — `src/components/C2.tsx`")
  );
});

test("sends one generateStructured call with purpose summary, schema and summaryEffort", async () => {
  const s = setup({
    components: [changedRow(1, 0.2), changedRow(2, 0.1)],
    files: imagesFor([1, 2]),
    script: { summary: [{ kind: "data", data: aiData([1, 2]) }] }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "generated");
  assert.equal(s.handle.ai.requests.length, 1);
  const request = summaryRequest(s.handle);
  assert.equal(request.purpose, "summary");
  assert.equal(request.system, SUMMARY_SYSTEM_PROMPT);
  assert.equal(request.jsonSchema, SUMMARY_JSON_SCHEMA);
  assert.equal(request.effort, "medium");
  assert.equal(request.signal, s.handle.context.signal);
  assert.ok(
    request.prompt.startsWith("# Change under review\nTitle: feature/button-restyle → main\nSource: local branch")
  );
  assert.ok(
    s.handle.console.has("info", "Writing the AI summary for 2 components (4 screenshots attached).", "summarizing")
  );
  assert.ok(s.handle.console.has("info", "AI summary written (100 input / 50 output tokens).", "summarizing"));
});

test("does not pass workingDirectory", async () => {
  const s = setup({
    components: [changedRow(1, 0.2)],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  assert.equal("workingDirectory" in summaryRequest(s.handle), false);
});

test("attaches top 6 changed by ratio, head then base, with exact labels", async () => {
  const ratios = [0.1, 0.5, 0.3, 0.05, 0.9, 0.2, 0.3, 0.01];
  const ids = ratios.map((_, i) => i + 1);
  const files = imagesFor(ids);
  for (const id of ids) {
    files[artifactPath(id, "head")] = encodePng(solidPng(10 + id, 10, WHITE)); // distinguishable per id
  }
  const s = setup({
    components: ratios.map((ratio, i) => changedRow(i + 1, ratio)),
    files,
    script: { summary: [{ kind: "data", data: aiData(ids) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  const request = summaryRequest(s.handle);
  const expectedOrder = [5, 2, 3, 7, 6, 1];
  assert.deepEqual(
    request.images?.map((image) => image.label),
    expectedOrder.flatMap((id) => [
      `#${String(id)} C${String(id)} — after (head)`,
      `#${String(id)} C${String(id)} — before (base)`
    ])
  );
  assert.equal(request.images[0]?.base64, files[artifactPath(5, "head")]?.toString("base64"));
  assert.ok(request.prompt.includes('- Screenshots: attached: "#5 C5 — after (head)" and "#5 C5 — before (base)"\n'));
  assert.ok(
    request.prompt.includes(
      "## [#4] C4\n- File: `src/components/C4.tsx` (export `default`)\n- Change: modified — Component code changed\n"
    )
  );
  assert.ok(
    request.prompt.includes("- Screenshots: not attached (only the 6 most-changed components get screenshots)")
  );
});

test("fills remaining image slots with new then deleted", async () => {
  const s = setup({
    components: [
      changedRow(1, 0.2),
      changedRow(2, 0.4),
      ...[3, 4, 5].map((id) => ({
        id,
        rank: id,
        changeKind: "added" as const,
        visualChange: "new" as const,
        headImagePath: artifactPath(id, "head")
      })),
      ...[6, 7, 8].map((id) => ({
        id,
        rank: id,
        changeKind: "removed" as const,
        visualChange: "deleted" as const,
        baseImagePath: artifactPath(id, "base")
      }))
    ],
    files: imagesFor([1, 2, 3, 4, 5, 6, 7, 8]),
    script: {
      summary: [{ kind: "data", data: aiData([1, 2, 3, 4, 5, 6, 7, 8]) }]
    }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  assert.deepEqual(
    summaryRequest(s.handle).images?.map((image) => image.label),
    [
      "#2 C2 — after (head)",
      "#2 C2 — before (base)",
      "#1 C1 — after (head)",
      "#1 C1 — before (base)",
      "#3 C3 — after (head)",
      "#4 C4 — after (head)",
      "#5 C5 — after (head)",
      "#6 C6 — before (base)"
    ]
  );
  assert.ok(summaryRequest(s.handle).prompt.includes("## [#7] C7"));
});

test("crops large screenshots around diff bbox with the same window for both sides", async () => {
  const base = withRect(solidPng(600, 3000, WHITE), { x: 5, y: 1266, w: 1, h: 1 }, [255, 0, 0, 255]);
  const head = withRect(solidPng(600, 3000, WHITE), { x: 6, y: 1266 + 1567, w: 1, h: 1 }, [0, 0, 255, 255]);
  const diff = withRect(solidPng(600, 3000, [0, 0, 0, 0]), { x: 100, y: 2000, w: 50, h: 100 }, [255, 0, 80, 255]);
  const s = setup({
    components: [changedRow(1, 0.01, { imageWidth: 600, imageHeight: 3000 })],
    files: {
      [artifactPath(1, "base")]: encodePng(base),
      [artifactPath(1, "head")]: encodePng(head),
      [artifactPath(1, "diff")]: encodePng(diff)
    },
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  const request = summaryRequest(s.handle);
  const [headImage, baseImage] = (request.images ?? []).map((image) => decodePng(Buffer.from(image.base64, "base64")));
  assert.ok(headImage && baseImage);
  assert.deepEqual([headImage.width, headImage.height], [600, 1568]);
  assert.deepEqual([baseImage.width, baseImage.height], [600, 1568]);
  assert.deepEqual(pixelAt(baseImage, 5, 0), [255, 0, 0, 255]);
  assert.deepEqual(pixelAt(headImage, 6, 1567), [0, 0, 255, 255]);
  assert.ok(
    request.prompt.includes(
      '- Screenshots: attached: "#1 C1 — after (head)" and "#1 C1 — before (base)"; both cropped to x=0 y=1266 600×1568 of 600×3000 around the changed area'
    )
  );
});

test("drops oversized images with note", async () => {
  const oversized = Buffer.concat([SMALL_PNG, Buffer.alloc(3_800_000)]);
  const s = setup({
    components: [changedRow(1, 0.5), changedRow(2, 0.1)],
    files: { ...imagesFor([1, 2]), [artifactPath(1, "head")]: oversized },
    script: { summary: [{ kind: "data", data: aiData([1, 2]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  const request = summaryRequest(s.handle);
  assert.deepEqual(
    request.images?.map((image) => image.label),
    ["#2 C2 — after (head)", "#2 C2 — before (base)"]
  );
  assert.ok(request.prompt.includes("## [#1] C1"));
  assert.ok(request.prompt.includes("- Screenshots: not attached: image too large\n"));
});

test("stops attaching image pairs at the total image budget", async () => {
  const big = Buffer.concat([SMALL_PNG, Buffer.alloc(3_100_000)]);
  const s = setup({
    components: [changedRow(1, 0.9), changedRow(2, 0.8), changedRow(3, 0.7)],
    files: {
      ...imagesFor([3]),
      [artifactPath(1, "head")]: big,
      [artifactPath(1, "base")]: big,
      [artifactPath(2, "head")]: big,
      [artifactPath(2, "base")]: big
    },
    script: { summary: [{ kind: "data", data: aiData([1, 2, 3]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  const request = summaryRequest(s.handle);
  assert.deepEqual(
    request.images?.map((image) => image.label),
    ["#1 C1 — after (head)", "#1 C1 — before (base)", "#3 C3 — after (head)", "#3 C3 — before (base)"]
  );
  const totalBytes = (request.images ?? []).reduce((sum, image) => sum + Buffer.from(image.base64, "base64").length, 0);
  assert.ok(totalBytes <= SUMMARY_MAX_TOTAL_IMAGE_BYTES);
  assert.ok(request.prompt.includes("## [#2] C2"));
  assert.ok(request.prompt.includes("- Screenshots: not attached: image budget reached\n"));
});

test("includes related module diffs for affected parents", async () => {
  const s = setup({
    components: [
      changedRow(1, 0.2, {
        filePath: "src/components/UserMenu.tsx",
        changeKind: "affected_parent",
        codeDiff: null,
        changeReason: "Imports changed hook src/hooks/useCart.ts"
      })
    ],
    files: imagesFor([1]),
    analysis: {
      changedFiles: [
        { path: "src/components/UserMenu.tsx", status: "M" },
        { path: "src/hooks/useCart.ts", status: "M" },
        { path: "src/utils/zeta.ts", status: "M" },
        { path: "src/api/client.ts", status: "A" },
        { path: "src/legacy.ts", status: "D" },
        { path: "src/unreadable.ts", status: "M" }
      ]
    },
    sources: {
      base: {
        "src/hooks/useCart.ts": "export const n = 1;\n",
        "src/utils/zeta.ts": "export const z = 1;\n"
      },
      head: {
        "src/hooks/useCart.ts": "export const n = 2;\n",
        "src/utils/zeta.ts": "export const z = 2;\n",
        "src/api/client.ts": "export const c = 1;\n"
      }
    },
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  const prompt = summaryRequest(s.handle).prompt;
  const sections = [...prompt.matchAll(/^## `([^`]+)`$/gm)].map((match) => match[1]);
  assert.deepEqual(sections, ["src/hooks/useCart.ts", "src/api/client.ts", "src/utils/zeta.ts"]);
  assert.ok(prompt.includes("-export const n = 1;\n+export const n = 2;"));
  assert.ok(prompt.includes("- Change: affected parent — Imports changed hook src/hooks/useCart.ts"));
  assert.ok(prompt.includes("(none — the component's own file did not change)"));
});

test("shrinks prompt over budget", async () => {
  const longLine = `+${"x".repeat(600)}`;
  const codeDiff = Array.from({ length: 300 }, () => longLine).join("\n");
  const s = setup({
    components: [changedRow(1, 0.2, { codeDiff })],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  const prompt = summaryRequest(s.handle).prompt;
  assert.ok(prompt.length <= SUMMARY_PROMPT_MAX_CHARS);
  assert.ok(prompt.includes("… [PRVision: diff truncated for the summary — showing 150 of 300 lines]"));
});

test("drops unknown ids and keeps first duplicate", async () => {
  const s = setup({
    components: [changedRow(1, 0.2), changedRow(2, 0.1), { id: 3, visualChange: "unchanged" }],
    files: imagesFor([1, 2]),
    script: {
      summary: [
        {
          kind: "data",
          data: {
            summaryMarkdown: "- Two components changed.",
            components: [
              { componentId: 99, note: "Unknown.", risk: "likely_regression" },
              {
                componentId: 3,
                note: "Unchanged one.",
                risk: "likely_regression"
              },
              { componentId: 1, note: "First.", risk: "check" },
              { componentId: 1, note: "Second.", risk: "none" },
              { componentId: 2, note: "Two.", risk: "none" }
            ]
          }
        }
      ]
    }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(componentRow(s.db, 1).aiNote, "First.");
  assert.equal(componentRow(s.db, 1).risk, "check");
  assert.equal(componentRow(s.db, 2).aiNote, "Two.");
  assert.equal(componentRow(s.db, 3).aiNote, null);
  assert.equal(componentRow(s.db, 3).risk, "none");
  assert.ok(
    s.handle.console.has(
      "warn",
      "AI summary skipped 2 unknown component entries and missed 0 components.",
      "summarizing"
    )
  );
});

test("missing ids leave note and risk null and warn", async () => {
  const s = setup({
    components: [changedRow(1, 0.2), changedRow(2, 0.1, { aiNote: "old", risk: "check" })],
    files: imagesFor([1, 2]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "generated");
  assert.equal(componentRow(s.db, 2).aiNote, null);
  assert.equal(componentRow(s.db, 2).risk, null);
  assert.ok(s.handle.console.has("warn", "AI summary skipped 0 unknown component entries and missed 1 components."));
});

test("applies risk floor when head failed and base rendered", async () => {
  const s = setup({
    components: [
      {
        id: 1,
        renderStatus: "partial",
        visualChange: null,
        headError: "TypeError: x is undefined",
        baseImagePath: artifactPath(1, "base")
      },
      {
        id: 2,
        renderStatus: "failed",
        changeKind: "added",
        visualChange: null,
        headError: "Boom"
      },
      {
        id: 3,
        renderStatus: "partial",
        visualChange: null,
        baseError: "Old boom"
      }
    ],
    script: {
      summary: [
        {
          kind: "data",
          data: {
            summaryMarkdown: "- Renders failed.",
            components: [1, 2, 3].map((componentId) => ({
              componentId,
              note: "n",
              risk: "none"
            }))
          }
        }
      ]
    }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(componentRow(s.db, 1).risk, "check");
  assert.equal(componentRow(s.db, 2).risk, "none");
  assert.equal(componentRow(s.db, 3).risk, "none");
  const prompt = summaryRequest(s.handle).prompt;
  assert.ok(prompt.includes("- Visual result: not compared — head render failed"));
  assert.ok(prompt.includes("- Screenshots: not attached (the screenshots were not compared)"));
});

test("persists summary, notes, risks in one transaction", async () => {
  const s = setup({
    components: [changedRow(1, 0.2), { id: 2, visualChange: "unchanged" }],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(s.transactions.length, 1);
  const [tx] = s.transactions;
  assert.ok(tx);
  const writes = s.db.calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => {
      const values = call.args[0] as Record<string, unknown>;
      return call.method === "update" && ("summaryMarkdown" in values || "aiNote" in values || "risk" in values);
    });
  assert.equal(writes.length, 3);
  assert.ok(writes.every(({ index }) => index >= tx.start && index < tx.end));
  assert.equal(vizRow(s.db).summaryMarkdown, "- **C1** is taller.");
  assert.equal(componentRow(s.db, 1).aiNote, "Note 1.");
  assert.equal(componentRow(s.db, 1).risk, "check");
});

test("records usage through AiUsageRecorder right after the call", async () => {
  const s = setup({
    components: [changedRow(1, 0.2)],
    files: imagesFor([1]),
    visualization: {
      aiUsage: { inputTokens: 1000, outputTokens: 200, calls: 3 }
    },
    script: {
      summary: [
        {
          kind: "data",
          data: aiData([1]),
          usage: { inputTokens: 120, outputTokens: 30, calls: 1 }
        }
      ]
    }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.deepEqual(outcome.usage, {
    inputTokens: 120,
    outputTokens: 30,
    calls: 1
  });
  assert.deepEqual(vizRow(s.db).aiUsage, {
    inputTokens: 1120,
    outputTokens: 230,
    calls: 4
  });
  const usageWrite = updateIndex(s.db, "aiUsage");
  assert.ok(usageWrite >= 0);
  assert.ok(usageWrite < updateIndex(s.db, "summaryMarkdown"));
});

test("records AiProviderError.usage on failure", async () => {
  const s = setup({
    components: [changedRow(1, 0.2)],
    files: imagesFor([1]),
    script: {
      summary: [
        {
          kind: "invalid_output",
          usage: { inputTokens: 7, outputTokens: 3, calls: 1 }
        }
      ]
    }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureReason, "invalid_output");
  assert.deepEqual(outcome.usage, {
    inputTokens: 7,
    outputTokens: 3,
    calls: 1
  });
  assert.deepEqual(vizRow(s.db).aiUsage, {
    inputTokens: 7,
    outputTokens: 3,
    calls: 1
  });
});

test("never imports drizzle-orm or writes ai_usage directly", () => {
  const dir = path.join(__dirname, "../../../../backend/src/services/visualizations/pipeline");
  for (const file of [
    "summary-service.ts",
    "summary-prompts.ts",
    "image-diff-service.ts",
    "structural-diff-service.ts"
  ]) {
    const source = fs.readFileSync(path.join(dir, file), "utf8");
    assert.ok(!source.includes("drizzle-orm"), `${file} imports drizzle-orm`);
    assert.ok(!/\baiUsage\b/.test(source), `${file} touches aiUsage`);
  }
});

test("provider error leaves summary null, warns and does not throw", async () => {
  const s = setup({
    components: [changedRow(1, 0.2, { aiNote: "keep" }), { id: 2, visualChange: "unchanged", risk: null }],
    files: imagesFor([1]),
    visualization: { summaryMarkdown: "stale" },
    script: {
      summary: [{ kind: "error", reason: "network", message: "socket hang up" }]
    }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.deepEqual(outcome, {
    status: "failed",
    summaryMarkdown: null,
    usage: null,
    failureReason: "network"
  });
  assert.equal(vizRow(s.db).summaryMarkdown, null);
  assert.equal(vizRow(s.db).aiUsage, null);
  assert.equal(componentRow(s.db, 1).aiNote, "keep");
  assert.equal(componentRow(s.db, 2).risk, "none");
  assert.ok(
    s.handle.console.has(
      "warn",
      "AI summary failed (network): socket hang up. The visualization will complete without a summary.",
      "summarizing"
    )
  );
});

test("empty summary after sanitizing is a failure but usage is recorded", async () => {
  const s = setup({
    components: [changedRow(1, 0.2)],
    files: imagesFor([1]),
    script: {
      summary: [
        {
          kind: "data",
          data: aiData([1], {
            summaryMarkdown: "![x](https://evil.example/p.png) <img src=x>"
          })
        }
      ]
    }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failureReason, "empty_summary");
  assert.equal(outcome.summaryMarkdown, null);
  assert.deepEqual(vizRow(s.db).aiUsage, {
    inputTokens: 100,
    outputTokens: 50,
    calls: 1
  });
  assert.equal(vizRow(s.db).summaryMarkdown, null);
  assert.ok(s.handle.console.has("warn", /^AI summary failed \(empty_summary\): /));
});

test("aborted call returns cancelled without writes", async () => {
  let handle: PipelineContextHandle | null = null;
  const s = setup({
    components: [changedRow(1, 0.2)],
    files: imagesFor([1]),
    script: {
      summary: [
        {
          kind: "fn",
          fn: () => {
            handle?.cancel();
            throw new AiProviderError("aborted", "aborted", false);
          }
        }
      ]
    }
  });
  handle = s.handle;
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "cancelled");
  assert.equal(s.db.updates.length, 0);
  assert.equal(s.handle.console.messages("warn").length, 0);
});

test("cancelled before the call returns cancelled without an AI call", async () => {
  const s = setup({ components: [changedRow(1, 0.2)], files: imagesFor([1]) });
  s.handle.cancel();
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "cancelled");
  assert.equal(s.handle.ai.requests.length, 0);
  assert.equal(s.db.updates.length, 0);
});

test("throws SUMMARY_PERSIST_FAILED on transaction error", async () => {
  const s = setup({
    components: [changedRow(1, 0.2)],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] },
    runInTransaction: () => Promise.reject(new Error("deadlock detected"))
  });
  await assert.rejects(
    s.service.summarize(s.handle.context, s.analysis),
    (error: unknown) =>
      error instanceof PipelineStepError &&
      error.code === "SUMMARY_PERSIST_FAILED" &&
      error.stage === "summarizing" &&
      error.userMessage === "Could not save the AI summary."
  );
});

test("throws SUMMARY_PERSIST_FAILED when the usage write fails", async () => {
  const s = setup({
    components: [changedRow(1, 0.2)],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  s.db.failNext("update"); // the usage write
  await assert.rejects(
    s.service.summarize(s.handle.context, s.analysis),
    (error: unknown) => error instanceof PipelineStepError && error.code === "SUMMARY_PERSIST_FAILED"
  );
});

test("uses the Angular system prompt and template label for an Angular repository", async () => {
  const s = setup({
    components: [
      changedRow(1, 0.2),
      {
        id: 2,
        rank: 2,
        visualChange: null,
        renderStatus: "partial",
        headError: "NG0201: No provider found",
        structuralDiff: [{ kind: "element_added", path: "@if", tag: "@if" }]
      }
    ],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1, 2]) }] },
    repository: { framework: "angular", appRoot: "apps/web", angularProject: "web" }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "generated");
  const request = summaryRequest(s.handle);
  assert.equal(request.system, ANGULAR_SUMMARY_SYSTEM_PROMPT);
  assert.ok(request.prompt.includes("- Structural diff (template, 1 changes):"));
  assert.ok(!request.prompt.includes("Structural diff (JSX"));
});

test("writes the Angular fixed summary when no Angular component was affected", async () => {
  const s = setup({ components: [], repository: { framework: "angular", appRoot: ".", angularProject: "app" } });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "fixed");
  assert.ok(outcome.summaryMarkdown?.startsWith("No Angular components were affected by this change."));
  assert.equal(s.handle.ai.requests.length, 0);
});

test("tells the model a replaced row compares two different components, keeping the static system prompt (00 §17)", async () => {
  const s = setup({
    components: [
      changedRow(1, 0.3, {
        displayName: "NoteFormModal",
        filePath: "src/components/NoteFormModal.tsx",
        changeKind: "replaced",
        changeReason: "Replaced by NoteFormModal (call site swap in Notes)",
        baseFilePath: "src/components/NoteForm.tsx",
        baseExportName: "NoteForm",
        baseDisplayName: "NoteForm",
        successorEvidence: [{ kind: "call_site_swap", detail: "src/pages/Notes.tsx: <NoteForm> → <NoteFormModal>" }]
      })
    ],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  const outcome = await s.service.summarize(s.handle.context, s.analysis);
  assert.equal(outcome.status, "generated");
  const request = summaryRequest(s.handle);
  assert.equal(request.system, SUMMARY_SYSTEM_PROMPT);
  assert.ok(
    request.prompt.includes("- Replaces: NoteForm (`src/components/NoteForm.tsx`, export `NoteForm`)"),
    request.prompt
  );
  assert.ok(
    request.prompt.includes("- Why they are paired: call site swap: src/pages/Notes.tsx: <NoteForm> → <NoteFormModal>"),
    request.prompt
  );
});

// ---- 16 §9.7: states in the user prompt, image choice and the global-style re-check overview ----

test("SummaryService adds a states line and attaches the first changed state's images with its name", async () => {
  const stateImage = (kind: "base" | "head" | "diff"): string => `artifacts/1/1/s1/${kind}.png`;
  const s = setup({
    components: [changedRow(1, 0.021, { visualChange: "changed" })],
    files: {
      ...imagesFor([1], ["base", "head", "diff"]),
      [stateImage("base")]: SMALL_PNG,
      [stateImage("head")]: encodePng(solidPng(12, 10, WHITE))
    },
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  s.db.seed(Table.VISUALIZATION_COMPONENT_STATES, [
    {
      visualizationComponentId: 1,
      visualizationId: 1,
      ordinal: 0,
      stateName: "Default",
      onBase: true,
      onHead: true,
      visualChange: "unchanged",
      diffPixelRatio: 0
    },
    {
      visualizationComponentId: 1,
      visualizationId: 1,
      ordinal: 1,
      stateName: "Overdue",
      onBase: true,
      onHead: true,
      visualChange: "changed",
      diffPixelRatio: 0.021,
      baseImagePath: stateImage("base"),
      headImagePath: stateImage("head"),
      diffImagePath: stateImage("diff")
    },
    {
      visualizationComponentId: 1,
      visualizationId: 1,
      ordinal: 2,
      stateName: "Menu open",
      onBase: true,
      onHead: true,
      visualChange: "unchanged",
      diffPixelRatio: 0
    }
  ]);
  await s.service.summarize(s.handle.context, s.analysis);
  const request = summaryRequest(s.handle);
  assert.ok(
    request.prompt.includes("- states: Default (unchanged), Overdue (changed, 2.10%), Menu open (unchanged)\n"),
    request.prompt
  );
  assert.deepEqual(
    request.images?.map((image) => image.label),
    ["#1 C1 — Overdue — after (head)", "#1 C1 — Overdue — before (base)"]
  );
  assert.equal(request.images[0]?.base64, encodePng(solidPng(12, 10, WHITE)).toString("base64"));
});

test("SummaryService keeps Default images and labels when Default changed", async () => {
  const s = setup({
    components: [changedRow(1, 0.3)],
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  s.db.seed(Table.VISUALIZATION_COMPONENT_STATES, [
    {
      visualizationComponentId: 1,
      visualizationId: 1,
      ordinal: 0,
      stateName: "Default",
      onBase: true,
      onHead: true,
      visualChange: "changed",
      diffPixelRatio: 0.3
    }
  ]);
  await s.service.summarize(s.handle.context, s.analysis);
  assert.deepEqual(
    summaryRequest(s.handle).images?.map((image) => image.label),
    ["#1 C1 — after (head)", "#1 C1 — before (base)"]
  );
});

test("SummaryService reports a global-style re-check and leaves unchanged re-check rows out of the list", async () => {
  const s = setup({
    components: [
      changedRow(1, 0.2, { changeKind: "rechecked" }),
      { id: 2, rank: 2, visualChange: "unchanged", changeKind: "rechecked", displayName: "Quiet" },
      { id: 3, rank: 3, visualChange: "unchanged", changeKind: "modified", displayName: "Touched" }
    ],
    visualization: { globalStyleTrigger: "src/index.css" },
    files: imagesFor([1]),
    script: { summary: [{ kind: "data", data: aiData([1]) }] }
  });
  await s.service.summarize(s.handle.context, s.analysis);
  const prompt = summaryRequest(s.handle).prompt;
  assert.ok(
    prompt.includes(
      "2 components were re-checked with saved harnesses after a global style change in src/index.css; 1 changed."
    ),
    prompt
  );
  assert.ok(prompt.includes("Unchanged: 2."), "re-check rows are counted");
  assert.ok(prompt.includes("Touched"));
  assert.ok(!prompt.includes("Quiet"), "unchanged re-check rows are not listed");
});
