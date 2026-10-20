import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentRequestsService,
  type AgentRequestsServiceDependencies
} from "../../../backend/src/services/agent-requests/agent-requests-service";
import type { AgentAiRequestRecord } from "../../../backend/src/utilities/services/ai/agent-request-store";

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } }
};

function row(overrides: Partial<AgentAiRequestRecord> = {}): AgentAiRequestRecord {
  return {
    id: 1,
    visualizationId: 9,
    purpose: "harness",
    status: "claimed",
    systemPrompt: "System",
    prompt: "Prompt",
    jsonSchema: SCHEMA,
    images: [],
    response: null,
    errorMessage: null,
    claimedAt: new Date("2026-10-20T10:00:01.000Z"),
    answeredAt: null,
    createdAt: new Date("2026-10-20T10:00:00.000Z"),
    updatedAt: new Date("2026-10-20T10:00:01.000Z"),
    ...overrides
  };
}

function service(rows: AgentAiRequestRecord[], options: { visualizationExists?: boolean } = {}) {
  const calls: Array<{ op: string; id: number; value?: unknown }> = [];
  const store: AgentRequestsServiceDependencies["store"] = {
    get: (id) => Promise.resolve(rows.find((r) => r.id === id) ?? null),
    listForVisualization: (id) => Promise.resolve(rows.filter((r) => r.visualizationId === id)),
    claimPending: (id) =>
      Promise.resolve(
        rows
          .filter((r) => r.visualizationId === id && r.status === "pending")
          .map((r) => ({ ...r, status: "claimed" as const, claimedAt: new Date("2026-10-20T10:00:05.000Z") }))
      ),
    answer: (id, response) => {
      calls.push({ op: "answer", id, value: response });
      const target = rows.find((r) => r.id === id);
      return Promise.resolve(target !== undefined && (target.status === "pending" || target.status === "claimed"));
    },
    fail: (id, message) => {
      calls.push({ op: "fail", id, value: message });
      return Promise.resolve(true);
    }
  };
  const svc = new AgentRequestsService({
    store,
    visualizationExists: () => Promise.resolve(options.visualizationExists ?? true)
  });
  return { svc, calls };
}

test("claim returns the run's pending requests with everything an agent needs", async () => {
  const { svc } = service([
    row({ id: 1, status: "pending", claimedAt: null, images: [{ label: "head", path: "/d/1-1.png" }] }),
    row({ id: 2, status: "answered" })
  ]);
  const response = await svc.claim(9);
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, [
    {
      id: 1,
      visualizationId: 9,
      purpose: "harness",
      status: "claimed",
      createdAt: "2026-10-20T10:00:00.000Z",
      claimedAt: "2026-10-20T10:00:05.000Z",
      answeredAt: null,
      system: "System",
      prompt: "Prompt",
      jsonSchema: SCHEMA,
      images: [{ label: "head", path: "/d/1-1.png" }]
    }
  ]);
});

test("claim with nothing pending is an empty array", async () => {
  const { svc } = service([row({ status: "answered" })]);
  assert.deepEqual(await svc.claim(9), { status: 200, data: [] });
});

test("list and claim are 404 for a missing visualization", async () => {
  const { svc } = service([], { visualizationExists: false });
  assert.equal((await svc.list(9)).status, 404);
  assert.equal((await svc.claim(9)).status, 404);
});

test("list returns summaries without prompts, oldest first", async () => {
  const { svc } = service([row({ id: 1 }), row({ id: 2, status: "pending", claimedAt: null })]);
  const response = await svc.list(9);
  assert.deepEqual(
    response.data?.map((r) => [r.id, r.status]),
    [
      [1, "claimed"],
      [2, "pending"]
    ]
  );
  assert.ok(response.data.every((r) => !("prompt" in r)));
});

test("a valid answer is stored", async () => {
  const { svc, calls } = service([row()]);
  assert.deepEqual(await svc.answer(1, { answer: "done" }), { status: 200, data: { id: 1, status: "answered" } });
  assert.deepEqual(calls, [{ op: "answer", id: 1, value: { answer: "done" } }]);
});

test("an answer that does not match the schema is 400 with the validation messages and is not stored", async () => {
  const { svc, calls } = service([row()]);
  const response = await svc.answer(1, { answer: 3, extra: true });
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "validation_failed");
  assert.ok(Array.isArray(response.error) && response.error.length > 0);
  assert.equal(calls.length, 0);
});

test("answering or failing a closed request is 409 naming its status", async () => {
  const { svc } = service([row({ status: "cancelled" })]);
  const answered = await svc.answer(1, { answer: "late" });
  assert.equal(answered.status, 409);
  assert.equal(answered.error, "Request 1 is cancelled");
  assert.equal((await svc.fail(1, "nope")).status, 409);
});

test("unknown request ids are 404", async () => {
  const { svc } = service([]);
  assert.equal((await svc.answer(5, { answer: "x" })).status, 404);
  assert.equal((await svc.fail(5, "x")).status, 404);
});

test("fail stores the message", async () => {
  const { svc, calls } = service([row()]);
  assert.deepEqual(await svc.fail(1, "needs a backend"), { status: 200, data: { id: 1, status: "failed" } });
  assert.deepEqual(calls, [{ op: "fail", id: 1, value: "needs a backend" }]);
});
