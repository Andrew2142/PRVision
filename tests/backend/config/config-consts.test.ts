import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import * as config from "../../../backend/src/config-consts";

/** Every constant of the 02 §6.7 summary table. Adding a constant means adding it here too. */
const EXPECTED_NAMES = [
  // app
  "APP_NAME",
  "APP_VERSION",
  "NODE_ENV",
  "IS_DEVELOPMENT",
  "IS_TEST",
  "IS_PRODUCTION",
  "APP_PORT",
  "APP_HOST",
  "FRONTEND_URL",
  "LOG_LEVEL",
  "LOG_TEST_STDOUT",
  "DATA_DIR",
  "WORKTREES_DIR_NAME",
  "ARTIFACTS_DIR_NAME",
  "FIXTURES_DIR_NAME",
  "FIXTURE_REPO_NAME",
  "DATABASE_URL",
  "REDIS_URL",
  "PRVISION_SECRET_KEY",
  "DB_POOL_MAX",
  "API_PREFIX",
  "ARTIFACTS_ROUTE",
  "JSON_BODY_LIMIT",
  "SHUTDOWN_TIMEOUT_MS",
  "HEALTH_CHECK_TIMEOUT_MS",
  "CHILD_PROCESS_ENV_ALLOWLIST",
  "CHILD_PROCESS_ENV_ALLOWED_PREFIXES",
  "CHILD_PROCESS_BASE_ENV",
  "CHILD_PROCESS_MAX_BUFFER_BYTES",
  "PROCESS_KILL_GRACE_MS",
  "LOG_TEXT_MAX_LENGTH",
  "GIT_BINARY",
  "GIT_MIN_VERSION",
  "GIT_DEFAULT_TIMEOUT_MS",
  "GIT_FETCH_TIMEOUT_MS",
  "GIT_WORKTREE_TIMEOUT_MS",
  "GIT_MAX_BUFFER_BYTES",
  "GIT_REF_NAMESPACE",
  "GITHUB_API_BASE_URL",
  "GITHUB_USER_AGENT",
  "GITHUB_REQUEST_TIMEOUT_MS",
  "GITHUB_TEST_TIMEOUT_MS",
  "GITHUB_PR_LIST_PAGE_SIZE",
  "GITHUB_PR_LIST_MAX_PAGES",
  "DETECTION_MAX_FILE_BYTES",
  "MIN_VITE_MAJOR",
  "MAX_GLOBAL_STYLES",
  "BRANCH_LIST_MAX",
  "COMMIT_LIST_DEFAULT_LIMIT",
  "COMMIT_LIST_MAX_LIMIT",
  // queue
  "QUEUE_PREFIX",
  "VISUALIZATION_QUEUE",
  "VISUALIZATION_JOB",
  "VISUALIZATION_JOB_ID_PREFIX",
  "VISUALIZATION_WORKER_CONCURRENCY",
  "VISUALIZATION_JOB_ATTEMPTS",
  "JOB_RETENTION",
  "WORKER_LOCK_DURATION_MS",
  "WORKER_MAX_STALLED_COUNT",
  "WORKER_CLOSE_TIMEOUT_MS",
  "CANCEL_KEY_PREFIX",
  "CANCEL_KEY_TTL_SECONDS",
  "CANCEL_POLL_INTERVAL_MS",
  "VISUALIZATION_MAX_RUNTIME_MS",
  "STEP_ABORT_GRACE_MS",
  "QUEUED_RECOVERY_GRACE_MS",
  "RUNNING_RECOVERY_GRACE_MS",
  "RECOVERY_SWEEP_INTERVAL_MS",
  "RECOVERY_BATCH_LIMIT",
  "WORKING_TREE_MAX_UNTRACKED_FILES",
  "WORKING_TREE_MAX_UNTRACKED_BYTES",
  "WORKING_TREE_HEAD_REF",
  "CONSOLE_MESSAGE_MAX_LENGTH",
  // pagination
  "DEFAULT_PAGE",
  "DEFAULT_PAGE_SIZE",
  "MAX_PAGE_SIZE",
  "CONSOLE_PAGE_LIMIT_MAX",
  // render
  "MAX_COMPONENTS",
  "MAX_PARENTS_PER_MODULE",
  "ANALYSIS_SOURCE_ROOT",
  "ANALYSIS_MAX_CHANGED_FILES",
  "ANALYSIS_MAX_PARSED_FILES",
  "ANALYSIS_MAX_FILE_BYTES",
  "ANALYSIS_GRAPH_BUDGET_MS",
  "ANALYSIS_TIMEOUT_MS",
  "AFFECTED_PARENT_MAX_DEPTH",
  "CODE_DIFF_MAX_LINES",
  "CALL_SITE_CONTEXT_LINES",
  "CALL_SITE_MAX_LIMIT",
  "TYPE_SOURCES_MAX_CHARS",
  "TYPE_SOURCES_MAX_RELATED",
  "CHANGED_FILES_MAX_ENTRIES",
  "HARNESS_DIR_NAME",
  "HARNESS_TEMPLATES_DIR",
  "RENDER_VIEWPORT",
  "RENDER_TIMEOUT_MS",
  "VITE_START_TIMEOUT_MS",
  "RENDER_STAGE_TIMEOUT_MS",
  "RENDER_COLD_START_ALLOWANCE_MS",
  "VITE_STOP_TIMEOUT_MS",
  "BROWSER_CLOSE_TIMEOUT_MS",
  "RENDER_SETTLE_QUIET_MS",
  "RENDER_SETTLE_MAX_MS",
  "RENDER_ASSET_WAIT_MS",
  "RENDER_MODULE_ERROR_GRACE_MS",
  "RENDER_STABILITY_INTERVAL_MS",
  "RENDER_STABILITY_MAX_ATTEMPTS",
  "RENDER_CAPTURE_PADDING_PX",
  "RENDER_MAX_CAPTURE_HEIGHT_PX",
  "RENDER_FIXED_TIME_ISO",
  "RENDER_RANDOM_SEED",
  "RENDER_INFRA_RETRIES",
  "RENDER_ERROR_MAX_CHARS",
  "RENDER_CONSOLE_ERRORS_MAX",
  "RENDER_CONSOLE_ERROR_MAX_CHARS",
  "VITE_HOST_MAX_OLD_SPACE_MB",
  "VITE_HOST_LOG_BUFFER_SIZE",
  "SUPPORTED_VITE_MAJOR_MIN",
  "SUPPORTED_VITE_MAJOR_MAX",
  "PIXELMATCH_THRESHOLD",
  "UNCHANGED_RATIO_CUTOFF",
  "DIFF_MAX_WIDTH",
  "DIFF_MAX_HEIGHT",
  "DIFF_MAX_PNG_BYTES",
  "STRUCTURAL_DIFF_MAX_CHANGES",
  "STRUCTURAL_DIFF_MAX_DEPTH",
  "STRUCTURAL_DIFF_MAX_NODES",
  "STRUCTURAL_VALUE_MAX_CHARS",
  // ai
  "AI_DEFAULT_PROVIDER",
  "AI_DEFAULT_MODEL",
  "AI_DEFAULT_HARNESS_EFFORT",
  "AI_DEFAULT_SUMMARY_EFFORT",
  "AI_MAX_TOKENS_BY_PURPOSE",
  "AI_SDK_MAX_RETRIES",
  "AI_REQUEST_TIMEOUT_MS",
  "AI_CALL_DEADLINE_MS",
  "AI_SERVER_SIDE_FALLBACK_ENABLED",
  "AI_SERVER_SIDE_FALLBACK_BETA",
  "AI_MAX_IMAGE_BASE64_CHARS",
  "AI_CONNECTION_TEST_TIMEOUT_MS",
  "AI_CLAUDE_CODE_CONNECTION_TEST_TIMEOUT_MS",
  "AI_CLAUDE_CODE_TIMEOUT_MS",
  "AI_CLAUDE_CODE_MAX_TURNS",
  "AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES",
  "AI_CLAUDE_CODE_ENV_ALLOWLIST",
  "AI_CLAUDE_CODE_ENV_PREFIXES",
  "AI_CLAUDE_CODE_ENV_DENYLIST",
  "AI_CLAUDE_CODE_PARENT_ENV",
  "HARNESS_PROMPT_TOKEN_BUDGET",
  "HARNESS_CONCURRENCY_ANTHROPIC_API",
  "HARNESS_CONCURRENCY_CLAUDE_CODE",
  "HARNESS_RETRY_DELAY_MS",
  "HARNESS_MAX_CALLS_PER_COMPONENT",
  "HARNESS_MAX_REPAIRS_PER_COMPONENT",
  "SUMMARY_CODE_DIFF_MAX_LINES",
  "SUMMARY_MAX_IMAGE_COMPONENTS",
  "SUMMARY_IMAGE_MAX_EDGE",
  "SUMMARY_MAX_IMAGE_BYTES",
  "SUMMARY_MAX_TOTAL_IMAGE_BYTES",
  "SUMMARY_PROMPT_MAX_CHARS",
  "SUMMARY_MARKDOWN_MAX_CHARS",
  "SUMMARY_NOTE_MAX_CHARS",
  "SUMMARY_RELATED_DIFFS_MAX_FILES",
  "SUMMARY_RELATED_DIFF_MAX_LINES"
] as const;

test("every constant of the 02 §6.7 table is exported", () => {
  const exported = new Set(Object.keys(config));
  for (const name of EXPECTED_NAMES) {
    assert.ok(exported.has(name), `missing ${name}`);
  }
});

test("pagination.config matches 00 §9 and §14.4", () => {
  assert.equal(config.DEFAULT_PAGE, 1);
  assert.equal(config.DEFAULT_PAGE_SIZE, 20);
  assert.equal(config.MAX_PAGE_SIZE, 100);
  assert.equal(config.CONSOLE_PAGE_LIMIT_MAX, 500);
});

test("ai.config defaults match 00 D5", () => {
  assert.equal(config.AI_DEFAULT_PROVIDER, "anthropic_api");
  assert.equal(config.AI_DEFAULT_MODEL, "claude-opus-5-5");
  assert.equal(config.AI_DEFAULT_HARNESS_EFFORT, "high");
  assert.equal(config.AI_DEFAULT_SUMMARY_EFFORT, "medium");
});

test("render.config: harness folder, RENDER_VIEWPORT and HARNESS_TEMPLATES_DIR", () => {
  assert.equal(config.HARNESS_DIR_NAME, ".prvision-harness");
  assert.deepEqual(config.RENDER_VIEWPORT, { width: 1280, height: 800 });
  assert.ok(path.isAbsolute(config.HARNESS_TEMPLATES_DIR));
  assert.equal(path.basename(config.HARNESS_TEMPLATES_DIR), "harness-templates");
  assert.equal(path.basename(path.dirname(config.HARNESS_TEMPLATES_DIR)), "backend");
});

test("render.config imports only node:path", () => {
  const source = fs.readFileSync(path.join(__dirname, "../../../backend/src/config-consts/render.config.ts"), "utf8");
  const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:path"]);
});

test("AI_CLAUDE_CODE_PARENT_ENV never contains PRVision secrets", () => {
  for (const name of Object.keys(config.AI_CLAUDE_CODE_PARENT_ENV)) {
    assert.ok(!name.startsWith("PRVISION_"), name);
    assert.ok(!["DATABASE_URL", "REDIS_URL", "NODE_OPTIONS"].includes(name), name);
  }
});

test("every numeric constant is a finite non-negative number", () => {
  for (const [name, value] of Object.entries(config)) {
    if (typeof value === "number") {
      assert.ok(Number.isFinite(value) && value >= 0, `${name} = ${value}`);
    }
  }
});

test("numeric timeouts and limits are positive integers", () => {
  for (const [name, value] of Object.entries(config)) {
    if (typeof value !== "number") {
      continue;
    }
    if (/(_MS|_SECONDS|_BYTES|_PX|_LIMIT|_SIZE|_CONCURRENCY|_COMPONENTS|_TOKENS|_CHARS|_LINES|_MAX)$/.test(name)) {
      assert.ok(Number.isSafeInteger(value) && value > 0, `${name} = ${String(value)}`);
    }
  }
});

test("SHUTDOWN_TIMEOUT_MS exceeds WORKER_CLOSE_TIMEOUT_MS", () => {
  // Widened to number: both constants are literal types, so comparing them directly is a constant condition
  // (@typescript-eslint/no-unnecessary-condition). The test still guards future edits of either value.
  const shutdownMs: number = config.SHUTDOWN_TIMEOUT_MS;
  const workerCloseMs: number = config.WORKER_CLOSE_TIMEOUT_MS;
  assert.ok(shutdownMs > workerCloseMs);
});
