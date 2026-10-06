/**
 * Adapter isolating the Claude Agent SDK message shapes: the only file that reads SDK message fields (05 §5.12).
 * Field names verified against @anthropic-ai/claude-agent-sdk 0.3.288 (sdk.d.ts):
 *  - SDKSystemMessage `{ type: "system", subtype: "init", model }`
 *  - SDKAssistantMessage `{ type: "assistant", message: BetaMessage, error?: SDKAssistantMessageError }`
 *  - SDKResultSuccess `{ type: "result", subtype: "success", is_error, api_error_status?, result, usage,
 *    modelUsage, structured_output? }`
 *  - SDKResultError `{ type: "result", subtype: "error_during_execution" | "error_max_turns" |
 *    "error_max_budget_usd" | "error_max_structured_output_retries", is_error, usage, modelUsage, errors: string[] }`
 *  - SDKAuthStatusMessage `{ type: "auth_status", error?: string }`
 * Messages are read through type guards only (they arrive as `unknown`).
 */
import type { AiUsage } from "./ai-provider";

/** How a Claude Code run failed, derived from typed fields only (never from free text). */
export type AgentErrorKind = "auth" | "max_turns" | "spawn" | "rate_limit" | "config" | "invalid_output" | "other";

/** The terminal outcome of one query() run. */
export interface AgentFinalResult {
  /** Final assistant text ("" when missing). */
  text: string;
  /** Native structured output (SDK `outputFormat`), when the result carried one. */
  structuredOutput: { present: true; value: unknown } | { present: false };
  isError: boolean;
  errorKind: AgentErrorKind | null;
  errorMessage: string | null;
  usage: AiUsage | null;
  model: string | null;
}

/** SDKAssistantMessageError values that mean "not signed in / not authorized". */
const AUTH_ERRORS = new Set([
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "verification_required",
  "billing_error",
  "cloud_credential_error"
]);
const RATE_LIMIT_ERRORS = new Set(["rate_limit", "overloaded"]);
const CONFIG_ERRORS = new Set(["model_not_found", "invalid_request"]);
/** SDKStartupFailureReason values that mean the sign-in / credential is the problem. */
const AUTH_STARTUP_FAILURES = new Set([
  "gateway_signin_required",
  "gateway_access_denied",
  "org_verify_failed",
  "org_pin_api_key_conflict",
  "org_pin_mismatch",
  "provider_not_allowed"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

/** Usage of the run: modelUsage (all models, the SDK's accounting field) when present, else the main-loop usage. */
function mapUsage(result: Record<string, unknown>): AiUsage | null {
  const modelUsage = result.modelUsage;
  if (isRecord(modelUsage)) {
    const entries = Object.values(modelUsage).filter(isRecord);
    if (entries.length > 0) {
      const sum = (key: string): number => entries.reduce((total, entry) => total + numberField(entry, key), 0);
      const cacheRead = sum("cacheReadInputTokens");
      return {
        inputTokens: sum("inputTokens") + cacheRead + sum("cacheCreationInputTokens"),
        outputTokens: sum("outputTokens"),
        calls: 1,
        cacheReadInputTokens: cacheRead
      };
    }
  }
  const usage = result.usage;
  if (!isRecord(usage)) {
    return null;
  }
  const cacheRead = numberField(usage, "cache_read_input_tokens");
  return {
    inputTokens: numberField(usage, "input_tokens") + cacheRead + numberField(usage, "cache_creation_input_tokens"),
    outputTokens: numberField(usage, "output_tokens"),
    calls: 1,
    cacheReadInputTokens: cacheRead
  };
}

function kindFromAssistantError(error: string | null): AgentErrorKind | null {
  if (error === null) {
    return null;
  }
  if (AUTH_ERRORS.has(error)) {
    return "auth";
  }
  if (RATE_LIMIT_ERRORS.has(error)) {
    return "rate_limit";
  }
  if (CONFIG_ERRORS.has(error)) {
    return "config";
  }
  return "other";
}

function kindFromStatus(status: number): AgentErrorKind {
  if (status === 401 || status === 403) {
    return "auth";
  }
  if (status === 429 || status === 529) {
    return "rate_limit";
  }
  if (status === 400 || status === 404 || status === 422) {
    return "config";
  }
  return "other";
}

/**
 * Reduces the messages of one run to its final result. A missing result message is an error ("other").
 *
 * @param messages - Every message the query() iterator yielded, in order.
 */
export function extractFinalResult(messages: readonly unknown[]): AgentFinalResult {
  let model: string | null = null;
  let assistantError: string | null = null;
  let authStatusError: string | null = null;
  let result: Record<string, unknown> | null = null;

  for (const message of messages) {
    if (!isRecord(message)) {
      continue;
    }
    switch (message.type) {
      case "system":
        if (message.subtype === "init" && model === null) {
          model = stringField(message, "model");
        }
        break;
      case "assistant": {
        assistantError = stringField(message, "error") ?? assistantError;
        const inner = message.message;
        if (model === null && isRecord(inner)) {
          model = stringField(inner, "model");
        }
        break;
      }
      case "auth_status":
        authStatusError = stringField(message, "error") ?? authStatusError;
        break;
      case "result":
        result = message;
        break;
      default:
        break;
    }
  }

  if (result === null) {
    return {
      text: "",
      structuredOutput: { present: false },
      isError: true,
      errorKind: authStatusError === null ? "other" : "auth",
      errorMessage: authStatusError ?? "Claude Code ended without a result.",
      usage: null,
      model
    };
  }

  const subtype = stringField(result, "subtype");
  const text = subtype === "success" ? (stringField(result, "result") ?? "") : "";
  const structuredOutput: AgentFinalResult["structuredOutput"] =
    "structured_output" in result && result.structured_output !== undefined && result.structured_output !== null
      ? { present: true, value: result.structured_output }
      : { present: false };
  const isError = result.is_error === true || (subtype !== null && subtype !== "success");

  let errorKind: AgentErrorKind | null = null;
  let errorMessage: string | null = null;
  if (isError) {
    const errors = Array.isArray(result.errors) ? result.errors.filter((e): e is string => typeof e === "string") : [];
    errorMessage =
      errors.length > 0 ? errors.join("; ") : text !== "" ? text : `Claude Code failed (${String(subtype)}).`;
    const startupFailure = stringField(result, "startup_failure_reason");
    const apiStatus = numberField(result, "api_error_status");
    if (subtype === "error_max_turns") {
      errorKind = "max_turns";
    } else if (subtype === "error_max_structured_output_retries") {
      errorKind = "invalid_output";
    } else if (startupFailure !== null) {
      errorKind = AUTH_STARTUP_FAILURES.has(startupFailure) ? "auth" : "other";
    } else if (authStatusError !== null) {
      errorKind = "auth";
    } else {
      errorKind = kindFromAssistantError(assistantError) ?? (apiStatus > 0 ? kindFromStatus(apiStatus) : "other");
    }
  }

  return { text, structuredOutput, isError, errorKind, errorMessage, usage: mapUsage(result), model };
}

/**
 * Extracts the first JSON object from model text: strips one surrounding ```json / ``` fence, finds the first
 * `{`, walks to the matching `}` with a brace counter that understands JSON strings and escapes, and parses it.
 *
 * @param text - Raw final text of the model.
 */
export function extractJsonObject(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  const body = fenced?.[1] ?? trimmed;

  const start = body.indexOf("{");
  if (start === -1) {
    return { ok: false, error: "The reply contains no JSON object." };
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < body.length; index += 1) {
    const char = body[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { ok: true, value: JSON.parse(body.slice(start, index + 1)) as unknown };
        } catch {
          return { ok: false, error: "The reply contains a JSON object that does not parse." };
        }
      }
    }
  }
  return { ok: false, error: "The reply contains an unterminated JSON object." };
}
