import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Table } from "../../../backend/src/enums";
import { HarnessLibraryService } from "../../../backend/src/services/harness-library/harness-library-service";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import type { AiReadiness } from "../../../backend/src/utilities/services/ai/ai-provider-factory";
import type { ResolvedAiSettings } from "../../../backend/src/utilities/services/ai/ai-provider";
import { makeComponentRow, makeLibraryJobRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { FakeLibraryQueue } from "../helpers/fake-library-queue";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";

const NOW = new Date("2026-10-07T12:00:00.000Z");
const JOBS = Table.HARNESS_LIBRARY_JOBS;
const SETTINGS: ResolvedAiSettings = {
  provider: "anthropic_api",
  model: "claude-opus-5-5",
  harnessEffort: "high",
  summaryEffort: "medium",
  anthropicApiKey: { state: "present", value: "sk-ant-test" }
};
const HARNESS = 'export default definePrvisionHarness({ states: [{ name: "Default" }] });';

interface Setup {
  db: InMemoryQueryHandler;
  queue: FakeLibraryQueue;
  events: Array<{ jobId: number; level: string; message: string }>;
  service: HarnessLibraryService;
}

/** Repository 1 (allowance 4), completed run 10 with three cards: 101 and 103 broken, 102 fine. */
function setup(options: { readiness?: AiReadiness } = {}): Setup {
  const db = new InMemoryQueryHandler();
  db.now = () => NOW;
  db.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, name: "shop", stateAllowance: 4 })]);
  db.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 10,
      status: "completed",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      componentCount: 3,
      needsUpdateCount: 2,
      completedAt: NOW
    })
  ]);
  db.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 101, visualizationId: 10, rank: 2, harnessSource: HARNESS, harnessNeedsUpdate: true }),
    makeComponentRow({ id: 102, visualizationId: 10, rank: 0, harnessSource: HARNESS, harnessNeedsUpdate: false }),
    makeComponentRow({ id: 103, visualizationId: 10, rank: 1, harnessSource: HARNESS, harnessNeedsUpdate: true })
  ]);
  const qh = db as unknown as QueryHandler;
  const queue = new FakeLibraryQueue();
  const events: Setup["events"] = [];
  const record =
    (jobId: number, level: string) =>
    (message: string): Promise<void> => {
      events.push({ jobId, level, message });
      return Promise.resolve();
    };
  const service = new HarnessLibraryService({
    queryHandler: qh,
    readAiSettings: () => Promise.resolve(SETTINGS),
    aiReadiness: () =>
      Promise.resolve(options.readiness ?? { ready: true, provider: "anthropic_api", model: SETTINGS.model }),
    queue,
    consoleFactory: (jobId) => ({
      info: record(jobId, "info"),
      warn: record(jobId, "warn"),
      error: record(jobId, "error")
    }),
    now: () => NOW
  });
  return { db, queue, events, service };
}

test("HarnessLibraryService.startRepair queues a repair of one card → 202 LibraryJobView", async () => {
  const { db, queue, service } = setup();
  const response = await service.startRepair(10, [103]);
  assert.equal(response.status, 202);
  const job = db.rows(JOBS)[0];
  assert.ok(job);
  assert.equal(job.kind, "repair");
  assert.equal(job.status, "queued");
  assert.equal(job.visualizationId, 10);
  assert.deepEqual(job.componentIds, [103]);
  assert.equal(job.stateAllowance, 4, "the repository's allowance");
  assert.equal(job.totalCount, 1);
  assert.equal(job.spendCapUsd, null, "repairs have no spending cap");
  assert.equal(job.aiModel, "claude-opus-5-5");
  assert.equal(job.jobId, `repair-${String(job.id)}`);
  assert.deepEqual(queue.calls, [`enqueue:repair:${String(job.id)}`]);
  assert.equal(response.data?.kind, "repair");
  assert.equal(response.data.visualizationId, 10);
  assert.deepEqual(response.data.componentIds, [103]);
  assert.equal(response.data.repositoryName, "shop");
  assert.equal(response.data.totalCount, 1);
});

test('HarnessLibraryService.startRepair with "broken" selects every card that needs updating, in rank order', async () => {
  const { db, service } = setup();
  const response = await service.startRepair(10, "broken");
  assert.equal(response.status, 202);
  assert.deepEqual(db.rows(JOBS)[0]?.componentIds, [103, 101]);
  assert.equal(db.rows(JOBS)[0]?.totalCount, 2);
});

test("HarnessLibraryService.startRepair returns 404 for an unknown or removed run, or a removed repository", async () => {
  const { db, service } = setup();
  db.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2, name: "gone", localPath: "/srv/gone", isDeleted: true })]);
  db.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 11, status: "completed", isDeleted: true, completedAt: NOW }),
    makeVisualizationRow({ id: 12, repositoryId: 2, status: "completed", completedAt: NOW })
  ]);
  for (const id of [99, 11, 12]) {
    const response = await service.startRepair(id, "broken");
    assert.equal(response.status, 404, `run ${String(id)}`);
    assert.equal(response.error_reason, "not_found");
  }
  assert.equal(db.rows(JOBS).length, 0);
});

test("HarnessLibraryService.startRepair returns 409 while the run is still in progress", async () => {
  const { db, service } = setup();
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 13, status: "rendering" })]);
  const response = await service.startRepair(13, "broken");
  assert.equal(response.status, 409);
  assert.equal(response.error_reason, "conflict");
  assert.equal(response.error, "The run is still in progress.");
});

test("HarnessLibraryService.startRepair returns 400 ai_not_configured with the readiness message", async () => {
  const { db, queue, service } = setup({
    readiness: { ready: false, reason: "ai_not_configured", message: "Add an Anthropic API key in Settings." }
  });
  const response = await service.startRepair(10, [103]);
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "ai_not_configured");
  assert.equal(response.error, "Add an Anthropic API key in Settings.");
  assert.equal(db.rows(JOBS).length, 0);
  assert.deepEqual(queue.calls, []);
});

test("HarnessLibraryService.startRepair returns 409 for a card that needs no repair or is not in the run", async () => {
  const { db, service } = setup();
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 14, status: "completed", completedAt: NOW })]);
  db.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 140, visualizationId: 14, harnessSource: HARNESS, harnessNeedsUpdate: true })
  ]);
  for (const ids of [[102], [140], [999], [103, 102]]) {
    const response = await service.startRepair(10, ids);
    assert.equal(response.status, 409, `cards ${ids.join(",")}`);
    assert.equal(response.error_reason, "conflict");
    assert.equal(response.error, "This component's harness does not need repair.");
  }
  assert.equal(db.rows(JOBS).length, 0);
});

test('HarnessLibraryService.startRepair with "broken" returns 409 when no card of the run needs updating', async () => {
  const { db, service } = setup();
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: 15, status: "failed", completedAt: NOW })]);
  db.seed(Table.VISUALIZATION_COMPONENTS, [makeComponentRow({ id: 150, visualizationId: 15, harnessSource: HARNESS })]);
  const response = await service.startRepair(15, "broken");
  assert.equal(response.status, 409);
  assert.equal(response.error, "No broken harnesses in this run.");
});

test("HarnessLibraryService.startRepair returns 409 while a repair of the run is active, also on a unique violation", async () => {
  const { db, service } = setup();
  db.seed(JOBS, [
    makeLibraryJobRow({
      id: 7,
      kind: "repair",
      status: "running",
      visualizationId: 10,
      componentIds: [101],
      totalCount: 1
    })
  ]);
  const active = await service.startRepair(10, [103]);
  assert.equal(active.status, 409);
  assert.equal(active.error, "A repair is already running for this run.");

  const fresh = setup();
  fresh.db.failNext("insert", { status: 409, error: "duplicate key", error_reason: "conflict" });
  const raced = await fresh.service.startRepair(10, [103]);
  assert.equal(raced.status, 409);
  assert.equal(raced.error, "A repair is already running for this run.");
  assert.deepEqual(fresh.queue.calls, []);
});

test("HarnessLibraryService.startRepair allows a new repair once the previous one is terminal", async () => {
  const { db, service } = setup();
  db.seed(JOBS, [
    makeLibraryJobRow({
      id: 7,
      kind: "repair",
      status: "completed",
      visualizationId: 10,
      componentIds: [101],
      totalCount: 1,
      completedAt: NOW
    })
  ]);
  assert.equal((await service.startRepair(10, [101])).status, 202);
});

test("HarnessLibraryService.startRepair returns 409 for a working-tree run without its snapshot", async () => {
  const { db, service } = setup();
  db.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 16,
      sourceType: "working_tree",
      status: "completed",
      baseSha: "a".repeat(40),
      workingTreeSnapshot: false,
      completedAt: NOW
    }),
    makeVisualizationRow({
      id: 17,
      sourceType: "working_tree",
      status: "completed",
      baseSha: "a".repeat(40),
      workingTreeSnapshot: true,
      completedAt: NOW
    })
  ]);
  db.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 160, visualizationId: 16, harnessSource: HARNESS, harnessNeedsUpdate: true }),
    makeComponentRow({ id: 170, visualizationId: 17, harnessSource: HARNESS, harnessNeedsUpdate: true })
  ]);
  const missing = await service.startRepair(16, [160]);
  assert.equal(missing.status, 409);
  assert.equal(
    missing.error,
    "The uncommitted changes of this run are no longer available. Start a new visualization."
  );
  assert.equal((await service.startRepair(17, [170])).status, 202);
});

test("HarnessLibraryService.startRepair fails the job and answers 500 when the queue rejects it", async () => {
  const { db, queue, events, service } = setup();
  queue.enqueueError = new Error("redis down");
  const response = await service.startRepair(10, [103]);
  assert.equal(response.status, 500);
  assert.equal(response.error_reason, "internal_error");
  assert.equal(response.error, "Could not queue the repair.");
  const job = db.rows(JOBS)[0];
  assert.equal(job?.status, "failed");
  assert.equal(job.errorMessage, "Could not queue the repair.");
  assert.deepEqual(events, [{ jobId: job.id, level: "error", message: "Could not queue the repair." }]);
});

test("HarnessLibraryService.startRepair answers 500 internal_error on an unexpected failure", async () => {
  const { db, service } = setup();
  db.failNext("validateAndSelect", new Error("db down"));
  const response = await service.startRepair(10, [103]);
  assert.equal(response.status, 500);
  assert.equal(response.error_reason, "internal_error");
});
