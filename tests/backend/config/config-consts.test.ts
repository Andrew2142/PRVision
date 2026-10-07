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
  "IN_CONTAINER",
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
  // 16 §16.4
  "LIBRARY_JOBS_DIR_NAME",
  "LIVE_DIR_NAME",
  "WORKING_TREE_SNAPSHOT_DIR_NAME",
  "LIBRARY_IMPORT_BODY_LIMIT",
  "LIBRARY_EXPORT_MAX_BYTES",
  "LIBRARY_IMPORT_MAX_ENTRIES",
  "LIBRARY_EXPORT_FORMAT",
  "LIBRARY_EXPORT_VERSION",
  "LIBRARY_ESTIMATE_TIMEOUT_MS",
  "LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS",
  "LIBRARY_ESTIMATE_CACHE_MS",
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
  // 16 §16.3
  "LIBRARY_SCAN_QUEUE",
  "LIBRARY_SCAN_JOB",
  "LIBRARY_SCAN_JOB_ID_PREFIX",
  "LIBRARY_REPAIR_QUEUE",
  "LIBRARY_REPAIR_JOB",
  "LIBRARY_REPAIR_JOB_ID_PREFIX",
  "LIVE_SESSION_QUEUE",
  "LIVE_SESSION_JOB",
  "LIVE_SESSION_JOB_ID_PREFIX",
  "LIBRARY_SCAN_WORKER_CONCURRENCY",
  "LIBRARY_REPAIR_WORKER_CONCURRENCY",
  "LIBRARY_CANCEL_KEY_PREFIX",
  "LIBRARY_SCAN_MAX_RUNTIME_MS",
  "LIBRARY_REPAIR_MAX_RUNTIME_MS",
  "LIVE_MAX_SESSIONS",
  "LIVE_IDLE_TIMEOUT_MS",
  "LIVE_HEARTBEAT_INTERVAL_MS",
  "LIVE_HEARTBEAT_LOSS_MS",
  "LIVE_POLL_INTERVAL_MS",
  "LIVE_MAX_SESSION_MS",
  "LIVE_START_TIMEOUT_MS",
  "LIVE_MAX_HOSTS_PER_SIDE",
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
  // 16 §16.1
  "ANALYSIS_MAX_CANDIDATES",
  "STATE_ALLOWANCE_MIN",
  "STATE_ALLOWANCE_MAX",
  "STATE_ALLOWANCE_DEFAULT",
  "MAX_STATE_ORDINALS",
  "STATE_NAME_MAX_CHARS",
  "STATE_NAME_PATTERN",
  "STATE_MAX_STEPS",
  "STATE_STEP_TEXT_MAX_CHARS",
  "STATE_STEP_NTH_MAX",
  "STATE_STEP_TIMEOUT_MS",
  "RENDER_ITEM_CONCURRENCY",
  "RENDER_PAGE_CONCURRENCY",
  "RENDER_STAGE_MS_PER_PAGE",
  "RENDER_GROUP_STARTUP_ALLOWANCE_MS",
  "ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS",
  "RENDER_STAGE_TIMEOUT_MAX_MS",
  "RENDER_GROUP_MAX_ITEMS",
  "GLOBAL_STYLE_TRIGGER_PATTERNS",
  "LIBRARY_INVENTORY_MAX_COMPONENTS",
  "LIBRARY_INVENTORY_MAX_FILES",
  "LIBRARY_INVENTORY_BUDGET_MS",
  "LIBRARY_RECHECK_MAX_COMPONENTS",
  "LIBRARY_SCAN_BATCH_SIZE",
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
  "HARNESS_PROMPT_TOKEN_BUDGET",
  "HARNESS_CONCURRENCY_ANTHROPIC_API",
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
  "SUMMARY_RELATED_DIFF_MAX_LINES",
  // 16 §16.2
  "AI_PRICES_AS_OF",
  "AI_MODEL_PRICES_USD_PER_MTOK",
  "AI_PRICE_FALLBACK_MODEL",
  "LIBRARY_ESTIMATE_MIN_SAMPLES",
  "LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE",
  "LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE",
  "LIBRARY_ESTIMATE_DEFAULT_CALL_USAGE",
  "LIBRARY_ESTIMATE_SECONDS_PER_HARNESS",
  "LIBRARY_SPEND_CAP_MIN_USD",
  "LIBRARY_SPEND_CAP_MAX_USD"
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

test("16 §16: harness library constants have their binding values", () => {
  // §16.1
  assert.equal(config.ANALYSIS_MAX_CANDIDATES, 500);
  assert.deepEqual([config.STATE_ALLOWANCE_MIN, config.STATE_ALLOWANCE_MAX, config.STATE_ALLOWANCE_DEFAULT], [1, 5, 3]);
  assert.equal(config.MAX_STATE_ORDINALS, 10);
  assert.equal(config.STATE_NAME_MAX_CHARS, 40);
  assert.equal(config.STATE_NAME_PATTERN, "^[A-Za-z0-9][A-Za-z0-9 ,.'()&/+-]{0,39}$");
  assert.equal(config.STATE_MAX_STEPS, 5);
  assert.equal(config.STATE_STEP_TEXT_MAX_CHARS, 200);
  assert.equal(config.STATE_STEP_NTH_MAX, 20);
  assert.equal(config.STATE_STEP_TIMEOUT_MS, 3_000);
  assert.equal(config.RENDER_ITEM_CONCURRENCY, 2);
  assert.equal(config.RENDER_PAGE_CONCURRENCY, 4);
  assert.equal(config.RENDER_STAGE_MS_PER_PAGE, 2_500);
  assert.equal(config.RENDER_GROUP_STARTUP_ALLOWANCE_MS, 20_000);
  assert.equal(config.ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS, config.ANGULAR_BUILD_TIMEOUT_MS);
  assert.equal(config.ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS, 240_000);
  assert.equal(config.RENDER_STAGE_TIMEOUT_MAX_MS, 60 * 60_000);
  assert.equal(config.RENDER_GROUP_MAX_ITEMS, 40);
  assert.deepEqual(config.GLOBAL_STYLE_TRIGGER_PATTERNS, {
    tailwindConfig: "^tailwind\\.config\\.[cm]?[jt]s$",
    postcssConfig: ["^postcss\\.config\\.([cm]?[jt]s|json)$", "^\\.postcssrc(\\.(json|ya?ml|[cm]?js))?$"],
    tokenBasenames: [
      "^(design-)?tokens?\\.(css|scss|sass|less|json)$",
      "^design-tokens\\.[cm]?[jt]s$",
      "^_?(variables|tokens|theme)\\.(css|scss|sass|less)$"
    ],
    tokenFolders: ["tokens", "design-tokens"]
  });
  assert.match("tailwind.config.mjs", new RegExp(config.GLOBAL_STYLE_TRIGGER_PATTERNS.tailwindConfig));
  assert.equal(config.LIBRARY_INVENTORY_MAX_COMPONENTS, 2_000);
  assert.equal(config.LIBRARY_INVENTORY_MAX_FILES, 6_000);
  assert.equal(config.LIBRARY_INVENTORY_BUDGET_MS, 120_000);
  assert.equal(config.LIBRARY_RECHECK_MAX_COMPONENTS, 2_000);
  assert.equal(config.LIBRARY_SCAN_BATCH_SIZE, 12);
  // §16.2
  assert.equal(config.AI_PRICES_AS_OF, "2026-09-25");
  assert.equal(Object.keys(config.AI_MODEL_PRICES_USD_PER_MTOK).length, 11);
  assert.deepEqual(config.AI_MODEL_PRICES_USD_PER_MTOK["claude-opus-5-5"], {
    input: 4,
    output: 20,
    cacheRead: 0.2,
    cacheWrite: 5
  });
  assert.equal(config.AI_PRICE_FALLBACK_MODEL, "claude-fable-5-1");
  assert.equal(config.LIBRARY_ESTIMATE_MIN_SAMPLES, 5);
  assert.deepEqual(config.LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE, {
    inputTokens: 26_000,
    cacheReadInputTokens: 4_500,
    cacheWriteInputTokens: 0,
    outputTokens: 9_000,
    calls: 1
  });
  assert.equal(config.LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE, 1_500);
  assert.deepEqual(config.LIBRARY_ESTIMATE_DEFAULT_CALL_USAGE, {
    inputTokens: 20_000,
    cacheReadInputTokens: 3_500,
    cacheWriteInputTokens: 0,
    outputTokens: 7_000,
    calls: 1
  });
  assert.equal(config.LIBRARY_ESTIMATE_SECONDS_PER_HARNESS, 25);
  assert.equal(config.LIBRARY_SPEND_CAP_MIN_USD, 0.5);
  assert.equal(config.LIBRARY_SPEND_CAP_MAX_USD, 10_000);
  // §16.4
  assert.equal(config.LIBRARY_JOBS_DIR_NAME, "library-jobs");
  assert.equal(config.LIVE_DIR_NAME, "live");
  assert.equal(config.WORKING_TREE_SNAPSHOT_DIR_NAME, "snapshots");
  assert.equal(config.LIBRARY_IMPORT_BODY_LIMIT, "64mb");
  assert.equal(config.LIBRARY_EXPORT_MAX_BYTES, 64 * 1024 * 1024);
  assert.equal(config.LIBRARY_IMPORT_MAX_ENTRIES, 5_000);
  assert.equal(config.LIBRARY_EXPORT_FORMAT, "prvision-harness-library");
  assert.equal(config.LIBRARY_EXPORT_VERSION, 1);
  assert.equal(config.LIBRARY_ESTIMATE_TIMEOUT_MS, 60_000);
  assert.equal(config.LIBRARY_ESTIMATE_INVENTORY_BUDGET_MS, 45_000);
  assert.equal(config.LIBRARY_ESTIMATE_CACHE_MS, 60_000);
});
