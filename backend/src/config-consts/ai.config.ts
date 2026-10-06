/**
 * AI provider, harness-generation and summary configuration (consumed by 03, 05, 09, 11). Defaults match 00 D5.
 * Settings rows override provider/model/effort at runtime; these are the initial values and the limits.
 */
import { pickEnv } from "../utilities/helpers/env";

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
export const AI_CLAUDE_CODE_TIMEOUT_MS = 900_000;
export const AI_CLAUDE_CODE_MAX_TURNS = 40;
/**
 * Turn cap for calls without images. PRVision already packs every source file the model needs into the prompt,
 * so these calls run with no tools; letting the agent browse the repository re-sent the whole conversation on every
 * step and cost ~500k input tokens per harness on a large repo.
 */
export const AI_CLAUDE_CODE_MAX_TURNS_NO_TOOLS = 3;
/** Extra turns on top of one Read per attached image (summary calls). */
export const AI_CLAUDE_CODE_IMAGE_TURN_MARGIN = 4;
export const AI_CLAUDE_CODE_INVALID_OUTPUT_RETRIES = 1;

/** Parent variables the Claude Code child may inherit (05 §5.12), in addition to the prefixes below. */
export const AI_CLAUDE_CODE_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE"
] as const;
export const AI_CLAUDE_CODE_ENV_PREFIXES = ["ANTHROPIC_", "CLAUDE_"] as const;
/** Dropped even if an allow rule matches (defence in depth, 00 §14.5). */
export const AI_CLAUDE_CODE_ENV_DENYLIST = [
  "PRVISION_SECRET_KEY",
  "DATABASE_URL",
  "REDIS_URL",
  "NODE_OPTIONS"
] as const;

/**
 * Frozen snapshot of the parent variables the Claude Code child may inherit: allow-list + prefixes, minus the
 * deny-list and every PRVISION_* name. 05's buildClaudeCodeEnv() starts from this (not from
 * CHILD_PROCESS_BASE_ENV, which deliberately excludes ANTHROPIC_* and CLAUDE_*).
 */
export const AI_CLAUDE_CODE_PARENT_ENV: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    Object.entries(pickEnv(AI_CLAUDE_CODE_ENV_ALLOWLIST, AI_CLAUDE_CODE_ENV_PREFIXES)).filter(
      ([name]) => !(AI_CLAUDE_CODE_ENV_DENYLIST as readonly string[]).includes(name) && !name.startsWith("PRVISION_")
    )
  )
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
