import type { AiStructuredRequest } from "./ai-provider";

/** Expected answer of the connection test. */
export interface ConnectionTestResponse {
  ok: boolean;
  echo: string;
}

/** Response schema of the connection test (passes JsonSchemaValidator.assertStructuredOutputCompatible). */
export const CONNECTION_TEST_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["ok", "echo"],
  properties: {
    ok: { type: "boolean", description: "Always true." },
    echo: { type: "string", description: "The check value from the prompt, copied exactly." }
  }
};

export const CONNECTION_TEST_SYSTEM =
  "You are the connectivity check for PRVision, a local developer tool. " +
  "Reply only with the JSON object described by the response schema. Do not add commentary.";

/**
 * Builds the tiny structured request of POST /api/settings/test-ai. The caller owns the timeout signal so it
 * can tell its own timeout apart from other aborts (05 §5.5.4 step 8).
 *
 * @param input - Nonce to echo and the caller's timeout signal.
 */
export function buildConnectionTestRequest(input: { nonce: string; signal: AbortSignal }): AiStructuredRequest {
  return {
    purpose: "connection_test",
    system: CONNECTION_TEST_SYSTEM,
    prompt: `Set "ok" to true and set "echo" to exactly this check value: ${input.nonce}`,
    jsonSchema: CONNECTION_TEST_SCHEMA,
    effort: "low",
    signal: input.signal
  };
}
