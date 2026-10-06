import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { AiProviderError, type AiStructuredRequest } from "../../../backend/src/types/visualization-pipeline";
import { JSON_SCHEMA_VALIDATOR_MODULE, ScriptedAiProvider } from "../helpers/ai-provider-stub";

// ScriptedAiProvider validates through sheet 05's JsonSchemaValidator (wave 3); until it exists these cases skip.
const validatorPath = path.resolve(__dirname, "../helpers", `${JSON_SCHEMA_VALIDATOR_MODULE}.ts`);
const skip = fs.existsSync(validatorPath)
  ? false
  : "needs sheet 05's backend/src/utilities/services/ai/json-schema-validator.ts (wave 3)";

const SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false
};

function request(overrides: Partial<AiStructuredRequest> = {}): AiStructuredRequest {
  return { purpose: "summary", system: "sys", prompt: "prompt", jsonSchema: SCHEMA, effort: "low", ...overrides };
}

test("returns scripted data per purpose in order", { skip }, async () => {
  const ai = new ScriptedAiProvider({
    summary: [
      { kind: "data", data: { answer: "one" } },
      { kind: "data", data: { answer: "two" }, usage: { outputTokens: 7 }, model: "other-model" }
    ],
    connection_test: [{ kind: "data", data: { answer: "ping" } }]
  });
  const first = await ai.generateStructured<{ answer: string }>(request());
  const ping = await ai.generateStructured<{ answer: string }>(request({ purpose: "connection_test" }));
  const second = await ai.generateStructured<{ answer: string }>(request());
  assert.deepEqual(first, {
    data: { answer: "one" },
    usage: { inputTokens: 100, outputTokens: 50, calls: 1 },
    model: "claude-opus-5-5"
  });
  assert.equal(ping.data.answer, "ping");
  assert.deepEqual(second, {
    data: { answer: "two" },
    usage: { inputTokens: 100, outputTokens: 7, calls: 1 },
    model: "other-model"
  });
  assert.equal(ai.callsFor("summary").length, 2);
  ai.assertExhausted();
});

test("error steps throw AiProviderError with reason, retryable and usage", { skip }, async () => {
  const usage = { inputTokens: 10, outputTokens: 2, calls: 1 };
  const ai = new ScriptedAiProvider({
    summary: [
      { kind: "error", reason: "rate_limit" },
      { kind: "error", reason: "auth", message: "bad key", retryable: true, usage },
      { kind: "refusal" },
      { kind: "invalid_output", raw: "{nope" }
    ]
  });
  await assert.rejects(ai.generateStructured(request()), (error: unknown) => {
    assert.ok(error instanceof AiProviderError);
    assert.equal(error.reason, "rate_limit");
    assert.equal(error.retryable, true);
    assert.equal(error.usage, undefined);
    return true;
  });
  await assert.rejects(ai.generateStructured(request()), {
    reason: "auth",
    message: "bad key",
    retryable: true,
    usage
  });
  await assert.rejects(ai.generateStructured(request()), {
    reason: "refusal",
    retryable: false,
    usage: { inputTokens: 100, outputTokens: 50, calls: 1 }
  });
  await assert.rejects(ai.generateStructured(request()), {
    reason: "invalid_output",
    retryable: true,
    message: /\{nope/,
    usage: { inputTokens: 100, outputTokens: 50, calls: 1 }
  });
});

test("hang settles only on abort", { skip }, async () => {
  const ai = new ScriptedAiProvider({ summary: [{ kind: "hang" }] });
  const controller = new AbortController();
  let settled = false;
  const pending = ai.generateStructured(request({ signal: controller.signal })).finally(() => {
    settled = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  controller.abort("cancelled");
  await assert.rejects(pending, { name: "AiProviderError", reason: "aborted" });
});

test("exhausted script throws a descriptive error", { skip }, async () => {
  const ai = new ScriptedAiProvider({ summary: [{ kind: "data", data: { answer: "x" } }] });
  await ai.generateStructured(request());
  await assert.rejects(ai.generateStructured(request()), { message: /no scripted step for purpose "summary" call #2/ });
  await assert.rejects(ai.generateStructured(request({ purpose: "harness" })), { message: /"harness" call #1/ });
});

test("assertExhausted detects unused steps", { skip }, async () => {
  const ai = new ScriptedAiProvider({ summary: [{ kind: "data", data: { answer: "x" } }, { kind: "refusal" }] });
  await ai.generateStructured(request());
  assert.throws(() => {
    ai.assertExhausted();
  }, /1 unused step\(s\) for "summary"/);
});

test("rejects request schemas that fail assertStructuredOutputCompatible", { skip }, async () => {
  const ai = new ScriptedAiProvider({ summary: [{ kind: "data", data: { answer: "x" } }] });
  const open = { type: "object", properties: { answer: { type: "string", minLength: 1 } }, required: ["answer"] };
  await assert.rejects(ai.generateStructured(request({ jsonSchema: open })), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!(error instanceof AiProviderError), "a bad schema is a programming error, not an AiProviderError");
    return true;
  });
});

test("data that violates request.jsonSchema throws invalid_output with usage attached", { skip }, async () => {
  const ai = new ScriptedAiProvider({ summary: [{ kind: "data", data: { answer: 42 }, usage: { inputTokens: 5 } }] });
  await assert.rejects(ai.generateStructured(request()), {
    name: "AiProviderError",
    reason: "invalid_output",
    retryable: true,
    usage: { inputTokens: 5, outputTokens: 50, calls: 1 }
  });
});

test("skipSchemaValidation returns the data unchanged", { skip }, async () => {
  const malformed = { answer: 42, extra: true };
  const ai = new ScriptedAiProvider({ summary: [{ kind: "data", data: malformed, skipSchemaValidation: true }] });
  const result = await ai.generateStructured(request());
  assert.equal(result.data, malformed);
});
