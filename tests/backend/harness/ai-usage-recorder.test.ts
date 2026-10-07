import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { Table } from "../../../backend/src/enums";
import { AiUsageRecorder } from "../../../backend/src/services/visualizations/pipeline/ai-usage-recorder";
import type { QueryHandler } from "../../../backend/src/utilities";
import { makeVisualizationRow } from "../helpers/factories";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";

function store(aiUsage: unknown): InMemoryQueryHandler {
  const stub = new InMemoryQueryHandler();
  stub.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 5, aiUsage: aiUsage as never })]);
  return stub;
}
const recorder = (stub: InMemoryQueryHandler): AiUsageRecorder =>
  new AiUsageRecorder(5, stub as unknown as QueryHandler);
const stored = (stub: InMemoryQueryHandler): unknown => stub.row(Table.VISUALIZATIONS, 5)?.aiUsage;

test("adds to existing ai_usage", async () => {
  const stub = store({ inputTokens: 10, outputTokens: 5, calls: 1 });
  const total = await recorder(stub).add({ inputTokens: 100, outputTokens: 50, calls: 1 });
  assert.deepEqual(total, { inputTokens: 110, outputTokens: 55, calls: 2 });
  assert.deepEqual(stored(stub), { inputTokens: 110, outputTokens: 55, calls: 2 });
  const update = stub.callsFor("update", Table.VISUALIZATIONS)[0];
  assert.deepEqual(update?.args.slice(0, 2), [
    { aiUsage: { inputTokens: 110, outputTokens: 55, calls: 2 } },
    { id: 5 }
  ]);
});

test("serializes concurrent adds without lost updates", async () => {
  const stub = store(null);
  const usageRecorder = recorder(stub);
  await Promise.all(
    Array.from({ length: 10 }, (_, index) => usageRecorder.add({ inputTokens: index + 1, outputTokens: 1, calls: 1 }))
  );
  assert.deepEqual(stored(stub), { inputTokens: 55, outputTokens: 10, calls: 10 });
  // every add re-read the row: one select per add, in order with the updates
  const methods = stub.calls.map((call) => call.method);
  assert.deepEqual(methods, Array.from({ length: 10 }, () => ["validateAndSelect", "update"]).flat());
});

test("two recorder instances used one after another do not lose updates", async () => {
  const stub = store(null);
  await recorder(stub).add({ inputTokens: 1_000, outputTokens: 200, calls: 3 }); // 09 generation
  await recorder(stub).add({ inputTokens: 300, outputTokens: 30, calls: 1 }); // 09 repair through a fresh instance
  await recorder(stub).add({ inputTokens: 50, outputTokens: 5, calls: 1 }); // 11 summary
  assert.deepEqual(stored(stub), { inputTokens: 1_350, outputTokens: 235, calls: 5 });
});

test("treats null or malformed ai_usage as zero", async () => {
  for (const malformed of [
    null,
    "oops",
    [],
    { inputTokens: "1", outputTokens: 2, calls: 1 },
    { inputTokens: -1, outputTokens: 0, calls: 0 },
    { inputTokens: 1 }
  ]) {
    const stub = store(malformed);
    await recorder(stub).add({ inputTokens: 7, outputTokens: 3, calls: 1 });
    assert.deepEqual(stored(stub), { inputTokens: 7, outputTokens: 3, calls: 1 }, JSON.stringify(malformed));
  }
});

// 16 §6.13 replaces 09's "stores only inputTokens, outputTokens, calls": the two optional cache counts are summed and
// stored when present (so library costs can be priced), and rows written before 16a still parse.
test("stores the three counts plus the cache read and write counts when present (16 §6.13)", async () => {
  const stub = store({ inputTokens: 1, outputTokens: 1, calls: 1, cacheReadInputTokens: 99 });
  await recorder(stub).add({
    inputTokens: 1,
    outputTokens: 1,
    calls: 1,
    cacheReadInputTokens: 500,
    cacheWriteInputTokens: 20
  });
  assert.deepEqual(stored(stub), {
    inputTokens: 2,
    outputTokens: 2,
    calls: 2,
    cacheReadInputTokens: 599,
    cacheWriteInputTokens: 20
  });
  // Unknown keys of the stored row are dropped.
  const extra = store({ inputTokens: 1, outputTokens: 1, calls: 1, foo: 3 });
  await recorder(extra).add({ inputTokens: 1, outputTokens: 1, calls: 1 });
  assert.deepEqual(Object.keys(stored(extra) as object).sort(), ["calls", "inputTokens", "outputTokens"]);
});

test("rows without cache counts parse, and no cache key is written when neither side has one (16 §6.13)", async () => {
  const stub = store({ inputTokens: 10, outputTokens: 5, calls: 1 });
  const total = await recorder(stub).add({ inputTokens: 1, outputTokens: 1, calls: 1 });
  assert.deepEqual(total, { inputTokens: 11, outputTokens: 6, calls: 2 });
  assert.deepEqual(Object.keys(stored(stub) as object).sort(), ["calls", "inputTokens", "outputTokens"]);

  const old = store({ inputTokens: 10, outputTokens: 5, calls: 1 });
  await recorder(old).add({ inputTokens: 1, outputTokens: 1, calls: 1, cacheWriteInputTokens: 4 });
  assert.deepEqual(stored(old), { inputTokens: 11, outputTokens: 6, calls: 2, cacheWriteInputTokens: 4 });

  const malformedCache = store({ inputTokens: 10, outputTokens: 5, calls: 1, cacheReadInputTokens: "9" });
  await recorder(malformedCache).add({ inputTokens: 1, outputTokens: 1, calls: 1 });
  assert.deepEqual(stored(malformedCache), { inputTokens: 11, outputTokens: 6, calls: 2 });
});

test("throws when the update response is not 200", async () => {
  const stub = store(null);
  const usageRecorder = recorder(stub);
  stub.failNext("update");
  await assert.rejects(
    usageRecorder.add({ inputTokens: 1, outputTokens: 1, calls: 1 }),
    /ai_usage update failed \(500\)/
  );
  // the chain survives a failed add
  await usageRecorder.add({ inputTokens: 2, outputTokens: 2, calls: 1 });
  assert.deepEqual(stored(stub), { inputTokens: 2, outputTokens: 2, calls: 1 });
  // a DB error from the read propagates too
  stub.failNext("validateAndSelect");
  await assert.rejects(usageRecorder.add({ inputTokens: 1, outputTokens: 1, calls: 1 }));
});

/** 14 §5.6.7: an `aiUsage` key inside a `.update(` values literal appears only in ai-usage-recorder.ts (00 §14.7). */
test("no other backend source writes aiUsage", () => {
  const root = path.join(__dirname, "../../../backend/src");
  const writers: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts")) {
        continue;
      }
      const sf = ts.createSourceFile(full, fs.readFileSync(full, "utf8"), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "update"
        ) {
          const values = node.arguments[0];
          if (
            values !== undefined &&
            ts.isObjectLiteralExpression(values) &&
            values.properties.some((p) => p.name !== undefined && p.name.getText(sf) === "aiUsage")
          ) {
            writers.push(path.relative(root, full));
            // 16 §10.5: the library job recorder owns harness_library_jobs.ai_usage, never visualizations.ai_usage.
            const table = node.arguments[2]?.getText(sf);
            if (path.relative(root, full) === "services/harness-library/library-job-usage-recorder.ts") {
              assert.equal(table, "Table.HARNESS_LIBRARY_JOBS");
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
  };
  walk(root);
  // visualizations.ai_usage: AiUsageRecorder only (00 §14.7); harness_library_jobs.ai_usage: the job recorder (16 §10.5).
  assert.deepEqual(writers.sort(), [
    "services/harness-library/library-job-usage-recorder.ts",
    "services/visualizations/pipeline/ai-usage-recorder.ts"
  ]);
});
