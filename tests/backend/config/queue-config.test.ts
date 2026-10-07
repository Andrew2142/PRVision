import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANCEL_KEY_PREFIX,
  CANCEL_KEY_TTL_SECONDS,
  CANCEL_POLL_INTERVAL_MS,
  LIBRARY_CANCEL_KEY_PREFIX,
  LIBRARY_REPAIR_JOB,
  LIBRARY_REPAIR_JOB_ID_PREFIX,
  LIBRARY_REPAIR_MAX_RUNTIME_MS,
  LIBRARY_REPAIR_QUEUE,
  LIBRARY_REPAIR_WORKER_CONCURRENCY,
  LIBRARY_SCAN_JOB,
  LIBRARY_SCAN_JOB_ID_PREFIX,
  LIBRARY_SCAN_MAX_RUNTIME_MS,
  LIBRARY_SCAN_QUEUE,
  LIBRARY_SCAN_WORKER_CONCURRENCY,
  LIVE_HEARTBEAT_INTERVAL_MS,
  LIVE_HEARTBEAT_LOSS_MS,
  LIVE_IDLE_TIMEOUT_MS,
  LIVE_MAX_HOSTS_PER_SIDE,
  LIVE_MAX_SESSIONS,
  LIVE_MAX_SESSION_MS,
  LIVE_POLL_INTERVAL_MS,
  LIVE_SESSION_JOB,
  LIVE_SESSION_JOB_ID_PREFIX,
  LIVE_SESSION_QUEUE,
  LIVE_START_TIMEOUT_MS,
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
  assert.equal(VISUALIZATION_MAX_RUNTIME_MS, 90 * 60_000); // 00 §21 item 7 (was 45 minutes)
});

test("queue.config library and live queues match 16 §16.3 (00 §21 item 7)", () => {
  assert.equal(LIBRARY_SCAN_QUEUE, "harness-scans");
  assert.equal(LIBRARY_SCAN_JOB, "scan");
  assert.equal(`${LIBRARY_SCAN_JOB_ID_PREFIX}7`, "scan-7");
  assert.equal(LIBRARY_REPAIR_QUEUE, "harness-repairs");
  assert.equal(LIBRARY_REPAIR_JOB, "repair");
  assert.equal(`${LIBRARY_REPAIR_JOB_ID_PREFIX}7`, "repair-7");
  assert.equal(LIVE_SESSION_QUEUE, "live-sessions");
  assert.equal(LIVE_SESSION_JOB, "live");
  assert.equal(`${LIVE_SESSION_JOB_ID_PREFIX}7`, "live-7");
  assert.equal(LIBRARY_SCAN_WORKER_CONCURRENCY, 1);
  assert.equal(LIBRARY_REPAIR_WORKER_CONCURRENCY, 1);
  assert.equal(`${LIBRARY_CANCEL_KEY_PREFIX}7`, "prvision:library-cancel:7");
  assert.equal(LIBRARY_SCAN_MAX_RUNTIME_MS, 8 * 60 * 60_000);
  assert.equal(LIBRARY_REPAIR_MAX_RUNTIME_MS, 30 * 60_000);
  assert.equal(LIVE_MAX_SESSIONS, 2);
  assert.equal(LIVE_IDLE_TIMEOUT_MS, 10 * 60_000);
  assert.equal(LIVE_HEARTBEAT_INTERVAL_MS, 30_000);
  assert.equal(LIVE_HEARTBEAT_LOSS_MS, 90_000);
  assert.equal(LIVE_POLL_INTERVAL_MS, 500);
  assert.equal(LIVE_MAX_SESSION_MS, 4 * 60 * 60_000);
  assert.equal(LIVE_START_TIMEOUT_MS, 5 * 60_000);
  assert.equal(LIVE_MAX_HOSTS_PER_SIDE, 4);
});
