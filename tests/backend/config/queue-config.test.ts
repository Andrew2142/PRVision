import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANCEL_KEY_PREFIX,
  CANCEL_KEY_TTL_SECONDS,
  CANCEL_POLL_INTERVAL_MS,
  QUEUE_PREFIX,
  VISUALIZATION_JOB,
  VISUALIZATION_JOB_ATTEMPTS,
  VISUALIZATION_JOB_ID_PREFIX,
  VISUALIZATION_MAX_RUNTIME_MS,
  VISUALIZATION_QUEUE,
  VISUALIZATION_WORKER_CONCURRENCY,
  WORKER_LOCK_DURATION_MS,
  WORKER_MAX_STALLED_COUNT
} from "../../../backend/src/config-consts";

test("queue.config matches 00 §10 and §14.6", () => {
  assert.equal(QUEUE_PREFIX, "prvision");
  assert.equal(VISUALIZATION_QUEUE, "visualizations");
  assert.equal(VISUALIZATION_JOB, "visualize");
  assert.equal(`${VISUALIZATION_JOB_ID_PREFIX}42`, "viz-42");
  assert.equal(VISUALIZATION_JOB_ATTEMPTS, 1);
  assert.equal(VISUALIZATION_WORKER_CONCURRENCY, 1);
  assert.equal(`${CANCEL_KEY_PREFIX}42`, "prvision:cancel:42");
  assert.equal(CANCEL_KEY_TTL_SECONDS, 86_400);
  assert.equal(CANCEL_POLL_INTERVAL_MS, 1_000);
  assert.equal(WORKER_LOCK_DURATION_MS, 300_000);
  assert.equal(WORKER_MAX_STALLED_COUNT, 0);
  assert.equal(VISUALIZATION_MAX_RUNTIME_MS, 45 * 60_000);
});
