/**
 * AI provider, harness-generation and summary configuration (consumed by 03, 05, 09, 11). Defaults match 00 D5.
 * Settings rows override provider/model/effort at runtime; these are the initial values and the limits.
 */
import { optionalEnv, pickEnv } from "../utilities/helpers/env";

// ---- Defaults (must equal 03's column defaults) ----

export const AI_DEFAULT_PROVIDER = "anthropic_api" as const;
export const AI_DEFAULT_MODEL = "claude-opus-5-5";
export const AI_DEFAULT_HARNESS_EFFORT = "high" as const;
export const AI_DEFAULT_SUMMARY_EFFORT = "medium" as const;

// ---- Provider limits (05) ----

/** `max_tokens` per request purpose; values above ~21k require streaming (05 always streams). */
export const AI_MAX_TOKENS_BY_PURPOSE = {
  harness: 64_000,
  harness_repair: 64_000,
  summary: 32_000,
  connection_test: 16_000 // thinking cannot be disabled on claude-opus-5-5 and counts against max_tokens
} as const;

/** Anthropic SDK `maxRetries` (408/409/429/5xx and connection errors). */
export const AI_SDK_MAX_RETRIES = 2;

/** Per SDK attempt. */
export const AI_REQUEST_TIMEOUT_MS = 600_000;

/** Whole generateStructured call including retries. */
export const AI_CALL_DEADLINE_MS = 900_000;

export const AI_SERVER_SIDE_FALLBACK_ENABLED = true;
export const AI_SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-07-01";

/** ~5 MB decoded: the API's per-image limit. */
export const AI_MAX_IMAGE_BASE64_CHARS = 6_900_000;

export const AI_CONNECTION_TEST_TIMEOUT_MS = 60_000;
export const AI_CLAUDE_CODE_CONNECTION_TEST_TIMEOUT_MS = 180_000;

// ---- Claude Code CLI provider (05 §5.12, Revision 10) ----

/** Executable of the local Claude Code CLI, resolved through the child's PATH. */
export const AI_CLAUDE_CODE_COMMAND: string = optionalEnv("PRVISION_CLAUDE_COMMAND") ?? "claude";
/** Whole-run deadline of one `claude --print` call (harness calls write up to 64k tokens). */
export const AI_CLAUDE_CODE_TIMEOUT_MS = 900_000;
/** `claude --version` probe used by readiness checks. */
export const AI_CLAUDE_CODE_VERSION_TIMEOUT_MS = 15_000;
/** How long a successful version probe is reused. */
export const AI_CLAUDE_CODE_VERSION_CACHE_MS = 300_000;
/**
 * Turn cap. The CLI runs with no tools except its StructuredOutput tool: PRVision already packs every source file
 * the model needs into the prompt, and letting the agent browse the repository cost ~10x the tokens.
 */
export const AI_CLAUDE_CODE_MAX_TURNS = 4;
export const AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES = 1;
/** stream-json output of one call (assistant messages + result) is capped per stream at this size. */
export const AI_CLAUDE_CODE_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
/** The JSON schema goes on argv; Linux caps a single argument at 128 KiB. */
export const AI_CLAUDE_CODE_MAX_SCHEMA_CHARS = 100_000;

/**
 * Parent variables the Claude Code child inherits on top of CHILD_PROCESS_BASE_ENV: only where the CLI keeps its
 * login. ANTHROPIC_* is deliberately left out, so the CLI uses its own sign-in (the Claude subscription) and never
 * an API key from PRVision's environment; CLAUDECODE and CLAUDE_CODE_* session variables of a parent Claude Code
 * session are left out too (the CLI refuses to start inside another session).
 */
export const AI_CLAUDE_CODE_ENV_ALLOWLIST = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN"] as const;

/** Frozen snapshot of the allow-listed Claude Code login variables (05's buildClaudeCodeEnv adds them). */
export const AI_CLAUDE_CODE_PARENT_ENV: Readonly<Record<string, string>> = Object.freeze(
  pickEnv(AI_CLAUDE_CODE_ENV_ALLOWLIST)
);

// ---- Harness generation (09) ----

export const HARNESS_PROMPT_TOKEN_BUDGET = 48_000;
export const HARNESS_CONCURRENCY_ANTHROPIC_API = 4;
export const HARNESS_CONCURRENCY_CLAUDE_CODE = 4;
export const HARNESS_RETRY_DELAY_MS = 10_000;
export const HARNESS_MAX_CALLS_PER_COMPONENT = 3;
/** Repair rounds after a failed head render (09 generates, 10 drives the loop). */
export const HARNESS_MAX_REPAIRS_PER_COMPONENT = 1;

// ---- Summary (11) ----

export const SUMMARY_CODE_DIFF_MAX_LINES = 300;
export const SUMMARY_MAX_IMAGE_COMPONENTS = 6;
/** Crop window edge; the model downsizes beyond this anyway. */
export const SUMMARY_IMAGE_MAX_EDGE = 1_568;
/** Raw PNG bytes per image (≈ 5 MB base64). */
export const SUMMARY_MAX_IMAGE_BYTES = 3_750_000;
/** All attached images together (≈ 16 MB base64; the Messages API rejects requests over 32 MB). */
export const SUMMARY_MAX_TOTAL_IMAGE_BYTES = 12_000_000;
export const SUMMARY_PROMPT_MAX_CHARS = 150_000;
export const SUMMARY_MARKDOWN_MAX_CHARS = 8_000;
export const SUMMARY_NOTE_MAX_CHARS = 600;
export const SUMMARY_RELATED_DIFFS_MAX_FILES = 5;
export const SUMMARY_RELATED_DIFF_MAX_LINES = 120;

// ---- AI prices and harness library estimates (16 §16.2, §6.13, D13, E17) ----

/** Published Anthropic first-party prices, USD per million tokens, as of AI_PRICES_AS_OF. Cache writes are 5-minute writes (1.25 × input). */
export const AI_PRICES_AS_OF = "2026-09-25";
export const AI_MODEL_PRICES_USD_PER_MTOK = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1.0, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-7": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }
} as const satisfies Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>;
/** Unknown models are priced like this (the most expensive listed), marked approximate (E17). */
export const AI_PRICE_FALLBACK_MODEL = "claude-fable-5-1";

/** Library entries with recorded usage needed before an estimate uses history instead of the defaults. */
export const LIBRARY_ESTIMATE_MIN_SAMPLES = 5;
/** Default usage of writing one harness with one state, correction and fix-up calls averaged in. */
export const LIBRARY_ESTIMATE_DEFAULT_HARNESS_USAGE = {
  inputTokens: 26_000,
  cacheReadInputTokens: 4_500,
  cacheWriteInputTokens: 0,
  outputTokens: 9_000,
  calls: 1
} as const;
/** Extra output tokens per state beyond Default. */
export const LIBRARY_ESTIMATE_OUTPUT_TOKENS_PER_EXTRA_STATE = 1_500;
/** Expected usage of one AI call before a job has its own mean (cap guard, §10.5). */
export const LIBRARY_ESTIMATE_DEFAULT_CALL_USAGE = {
  inputTokens: 20_000,
  cacheReadInputTokens: 3_500,
  cacheWriteInputTokens: 0,
  outputTokens: 7_000,
  calls: 1
} as const;
/** Wall-clock estimate per written harness. */
export const LIBRARY_ESTIMATE_SECONDS_PER_HARNESS = 25;
/** Scan spending cap range in USD (16 §14.2). */
export const LIBRARY_SPEND_CAP_MIN_USD = 0.5;
export const LIBRARY_SPEND_CAP_MAX_USD = 10_000;
