import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openEmbeddedDatabase } from "../../../backend/src/database/embedded";
import type { AgentRequestView } from "../../../backend/src/dtos/agent-requests/agent-request-view.dto";
import { LocalQueue } from "../../../backend/src/headless/local-queue";
import { RunFolder } from "../../../backend/src/headless/run-folder";

async function tempFolder(): Promise<RunFolder> {
  const folder = new RunFolder(await mkdtemp(path.join(os.tmpdir(), "prvision-run-")));
  await folder.init();
  return folder;
}

function request(id: number): AgentRequestView {
  return {
    id,
    visualizationId: 1,
    purpose: "harness",
    status: "claimed",
    createdAt: "2026-10-20T00:00:00.000Z",
    claimedAt: "2026-10-20T00:00:01.000Z",
    system: "SYSTEM TEXT",
    prompt: "PROMPT TEXT",
    jsonSchema: { type: "object" },
    images: []
  } as AgentRequestView;
}

test("LocalQueue answers the queue calls of one in-process run", async () => {
  const queue = new LocalQueue();
  assert.equal(queue.visualizationJobId(7), "viz-7");
  assert.deepEqual(await queue.enqueueVisualization(7), { jobId: "viz-7", alreadyQueued: false });
  assert.equal(await queue.getVisualizationJobState(), "active");
  assert.equal(await queue.isCancelRequested(7), false);
  await queue.requestCancel(7);
  assert.equal(await queue.isCancelRequested(7), true);
  await queue.clearCancel(7);
  assert.equal(await queue.isCancelRequested(7), false);
});

test("RunFolder writes a request the agent can answer with the given command", async () => {
  const folder = await tempFolder();
  try {
    await folder.writeRequest(request(3), { title: "feature → main", repository: "/repo", cli: "node prvision.mjs" });
    const task = await readFile(path.join(folder.requestDir(3), "task.md"), "utf8");
    assert.match(task, /# PRVision AI request #3 \(harness\)/);
    assert.ok(task.includes(`node prvision.mjs answer ${folder.root} 3 `));
    assert.ok(task.includes("SYSTEM TEXT") && task.includes("PROMPT TEXT"));
    const schema = JSON.parse(await readFile(path.join(folder.requestDir(3), "schema.json"), "utf8")) as unknown;
    assert.deepEqual(schema, { type: "object" });
  } finally {
    await rm(folder.root, { recursive: true, force: true });
  }
});

test("RunFolder hands submissions to the engine once and records the verdict", async () => {
  const folder = await tempFolder();
  try {
    await folder.writeRequest(request(4), { title: "t", repository: "/repo", cli: "prvision" });
    await writeFile(path.join(folder.requestDir(4), "submit.json"), JSON.stringify({ harness: "x" }));
    assert.deepEqual(await folder.pendingSubmissions(), [{ id: 4, kind: "submit", body: { harness: "x" } }]);
    await folder.writeResult(4, "submit", { accepted: false, errors: ["missing field"] });
    assert.deepEqual(await folder.pendingSubmissions(), []);
    const result = JSON.parse(await readFile(path.join(folder.requestDir(4), "result.json"), "utf8")) as unknown;
    assert.deepEqual(result, { accepted: false, errors: ["missing field"] });
  } finally {
    await rm(folder.root, { recursive: true, force: true });
  }
});

test("RunFolder.takeContinue reads a positive limit once and ignores anything else", async () => {
  const folder = await tempFolder();
  try {
    assert.equal(await folder.takeContinue(), null);
    await writeFile(path.join(folder.root, "continue.json"), JSON.stringify({ limit: 20 }));
    assert.equal(await folder.takeContinue(), 20);
    assert.equal(await folder.takeContinue(), null);
    await writeFile(path.join(folder.root, "continue.json"), JSON.stringify({ limit: -1 }));
    assert.equal(await folder.takeContinue(), null);
  } finally {
    await rm(folder.root, { recursive: true, force: true });
  }
});

test("the embedded database applies every migration without a Postgres server", async () => {
  const database = await openEmbeddedDatabase();
  try {
    const result = await database.db.execute(
      "select count(*)::int as count from information_schema.tables where table_schema = 'public'"
    );
    const rows = (result as unknown as { rows: Array<{ count: number }> }).rows;
    assert.ok((rows[0]?.count ?? 0) >= 11);
  } finally {
    await database.close();
  }
});
