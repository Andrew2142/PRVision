import assert from "node:assert/strict";
import test from "node:test";
import { extractFinalResult, extractJsonObject } from "../../../backend/src/utilities/services/ai/claude-code-result";
import { agentResult } from "../helpers/ai-sdk-fakes";

test("extractJsonObject handles braces inside strings", () => {
  const result = extractJsonObject(
    'Here you go: {"source": "function f() { return \\"}\\"; }", "n": {"a": 1}} trailing }'
  );
  assert.deepEqual(result, { ok: true, value: { source: 'function f() { return "}"; }', n: { a: 1 } } });
});

test("extractJsonObject handles escaped quotes", () => {
  const fenced = '```json\n{"say": "she said \\"hi\\" \\\\", "ok": true}\n```';
  assert.deepEqual(extractJsonObject(fenced), { ok: true, value: { say: 'she said "hi" \\', ok: true } });
});

test("extractJsonObject returns error when no object", () => {
  assert.equal(extractJsonObject("I could not find the component.").ok, false);
  assert.equal(extractJsonObject('{"unterminated": "x"').ok, false);
  assert.equal(extractJsonObject("{not json}").ok, false);
});

test("extractFinalResult reports missing result message as error", () => {
  const final = extractFinalResult([{ type: "system", subtype: "init", model: "claude-opus-5-5" }]);
  assert.deepEqual(final, {
    text: "",
    structuredOutput: { present: false },
    isError: true,
    errorKind: "other",
    errorMessage: "Claude Code ended without a result.",
    usage: null,
    model: "claude-opus-5-5"
  });
});

test("extractFinalResult reads text, usage, model and typed error kinds", () => {
  const ok = extractFinalResult([
    { type: "system", subtype: "init", model: "claude-opus-5-5" },
    agentResult('{"a":1}', { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 } })
  ]);
  assert.equal(ok.isError, false);
  assert.equal(ok.text, '{"a":1}');
  assert.deepEqual(ok.usage, { inputTokens: 110, outputTokens: 5, calls: 1, cacheReadInputTokens: 100 });

  const maxTurns = extractFinalResult([agentResult("", { subtype: "error_max_turns", is_error: true, errors: [] })]);
  assert.equal(maxTurns.errorKind, "max_turns");

  const auth = extractFinalResult([
    { type: "assistant", message: { model: "claude-opus-5-5", content: [] }, error: "authentication_failed" },
    agentResult("Invalid API key · Please run /login", { is_error: true })
  ]);
  assert.equal(auth.errorKind, "auth");
  assert.equal(auth.model, "claude-opus-5-5");

  const status = extractFinalResult([agentResult("overloaded", { is_error: true, api_error_status: 529 })]);
  assert.equal(status.errorKind, "rate_limit");
});
