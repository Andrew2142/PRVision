import assert from "node:assert/strict";
import test from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AiProviderError, type AiStructuredRequest } from "../../../backend/src/types/visualization-pipeline";
import {
  AnthropicApiProvider,
  type AnthropicApiProviderOptions
} from "../../../backend/src/utilities/services/ai/anthropic-api-provider";
import { anthropicErrors, anthropicFinalMessage, fakeAnthropicStream, hangingMessage } from "../helpers/ai-sdk-fakes";
import { patchStaticMethod } from "../helpers/test-context";

const API_KEY = `sk-ant-api03-${"t".repeat(40)}`;
const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } }
};

function request(overrides: Partial<AiStructuredRequest> = {}): AiStructuredRequest {
  return {
    purpose: "harness",
    system: "You write render harnesses.",
    prompt: "Write the harness.",
    jsonSchema: SCHEMA,
    effort: "high",
    ...overrides
  };
}

function providerWith(
  responses: Parameters<typeof fakeAnthropicStream>[0],
  options: Partial<AnthropicApiProviderOptions> = {}
) {
  const fake = fakeAnthropicStream(responses);
  const provider = new AnthropicApiProvider({
    apiKey: API_KEY,
    model: "claude-opus-5-5",
    streamFn: fake.streamFn,
    ...options
  });
  return { provider, calls: fake.calls };
}

/** Params as a plain record, to assert on keys that must be absent. */
function paramsOf(calls: ReturnType<typeof providerWith>["calls"]): Record<string, unknown> {
  return calls[0]!.params as unknown as Record<string, unknown>;
}

async function rejectsWith(promise: Promise<unknown>, reason: AiProviderError["reason"], retryable?: boolean) {
  const error = await promise.then(
    () => assert.fail("expected a rejection"),
    (caught: unknown) => caught
  );
  assert.ok(error instanceof AiProviderError, `expected AiProviderError, got ${String(error)}`);
  assert.equal(error.reason, reason);
  if (retryable !== undefined) {
    assert.equal(error.retryable, retryable);
  }
  return error;
}

// ---- request params ----

test("AnthropicApiProvider builds params with model claude-opus-5-5, adaptive thinking, explicit effort and json_schema format", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "ok" })]);
  await provider.generateStructured(request({ effort: "xhigh" }));
  const params = paramsOf(calls);
  assert.equal(params.model, "claude-opus-5-5");
  assert.equal(params.max_tokens, 64_000);
  assert.deepEqual(params.thinking, { type: "adaptive" });
  assert.deepEqual(params.output_config, { effort: "xhigh", format: { type: "json_schema", schema: SCHEMA } });
});

test("AnthropicApiProvider never sends budget_tokens, tool_choice, tools, output_format, temperature or assistant prefill", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "ok" })]);
  await provider.generateStructured(request({ purpose: "summary", effort: "medium" }));
  const params = paramsOf(calls);
  for (const key of ["tool_choice", "tools", "output_format", "temperature", "top_p", "top_k"]) {
    assert.equal(key in params, false, key);
  }
  assert.ok(!JSON.stringify(params).includes("budget_tokens"));
  const messages = params.messages as Array<{ role: string }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[messages.length - 1]?.role, "user");
});

test("AnthropicApiProvider puts system prompt in a single cached block", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "ok" })]);
  await provider.generateStructured(request());
  assert.deepEqual(paramsOf(calls).system, [
    { type: "text", text: "You write render harnesses.", cache_control: { type: "ephemeral" } }
  ]);
});

test("AnthropicApiProvider places image blocks before the text block with a legend", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "ok" })]);
  await provider.generateStructured(
    request({
      images: [
        { mediaType: "image/png", base64: "AAAA", label: "Button before" },
        { mediaType: "image/png", base64: "BBBB", label: "Button after" }
      ]
    })
  );
  const content = (paramsOf(calls).messages as Array<{ content: Array<Record<string, unknown>> }>)[0]!.content;
  assert.deepEqual(
    content.map((block) => block.type),
    ["image", "image", "text"]
  );
  assert.deepEqual(content[0]?.source, { type: "base64", media_type: "image/png", data: "AAAA" });
  assert.equal(content[2]?.text, "Image 1: Button before\nImage 2: Button after\n\nWrite the harness.");
});

test('AnthropicApiProvider adds betas ["server-side-fallback-2026-07-01"] and fallbacks "default" when fallback enabled', async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "ok" })]);
  await provider.generateStructured(request());
  const params = paramsOf(calls);
  assert.deepEqual(params.betas, ["server-side-fallback-2026-07-01"]);
  assert.equal(params.fallbacks, "default");
});

test("AnthropicApiProvider omits betas and fallbacks when fallback disabled", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "ok" })], { serverSideFallback: false });
  await provider.generateStructured(request());
  const params = paramsOf(calls);
  assert.equal("betas" in params, false);
  assert.equal("fallbacks" in params, false);
});

test("AnthropicApiProvider passes the caller signal combined with the deadline to stream()", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "ok" })]);
  const caller = new AbortController();
  await provider.generateStructured(request({ signal: caller.signal }));
  const passed = calls[0]!.signal;
  assert.notEqual(passed, caller.signal); // combined with the deadline, not the raw caller signal
  assert.equal(passed.aborted, false);
  caller.abort("cancelled");
  assert.equal(passed.aborted, true);
});

test("AnthropicApiProvider default streamFn calls client.beta.messages.stream and finalMessage", async (t) => {
  const seen: Array<{ params: unknown; options: unknown }> = [];
  const restore = patchStaticMethod(
    Anthropic.Beta.Messages.prototype,
    "stream",
    function (this: unknown, params: unknown, options: unknown) {
      seen.push({ params, options });
      return { finalMessage: () => Promise.resolve(anthropicFinalMessage({ answer: "real seam" })) } as never;
    }
  );
  t.after(restore);
  const provider = new AnthropicApiProvider({ apiKey: API_KEY, model: "claude-opus-5-5" });
  const result = await provider.generateStructured<{ answer: string }>(request());
  assert.equal(result.data.answer, "real seam");
  assert.equal(seen.length, 1);
  assert.ok((seen[0]?.options as { signal?: unknown }).signal instanceof AbortSignal);
});

// ---- responses ----

test("AnthropicApiProvider returns parsed data, model and usage including cache reads", async () => {
  const { provider } = providerWith([
    anthropicFinalMessage(
      { answer: "hello" },
      {
        model: "claude-opus-5-5",
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }
      }
    )
  ]);
  const result = await provider.generateStructured<{ answer: string }>(request());
  assert.deepEqual(result, {
    data: { answer: "hello" },
    usage: { inputTokens: 1050, outputTokens: 40, calls: 1, cacheReadInputTokens: 900 },
    model: "claude-opus-5-5"
  });
});

test("AnthropicApiProvider sums usage across iterations when a fallback ran", async () => {
  // Top-level usage covers only the serving attempt; usage.iterations has one entry per attempt.
  const { provider } = providerWith([
    anthropicFinalMessage(
      { answer: "served by fallback" },
      {
        model: "claude-opus-5",
        content: [
          { type: "text", text: '{"answer": "partial' },
          {
            type: "fallback",
            from: { model: "claude-opus-5-5" },
            to: { model: "claude-opus-5" },
            trigger: { type: "refusal", category: "cyber" }
          },
          { type: "text", text: '{"answer":"served by fallback"}' }
        ],
        usage: {
          input_tokens: 300,
          output_tokens: 70,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          iterations: [
            {
              type: "message",
              input_tokens: 300,
              output_tokens: 20,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5
            },
            {
              type: "fallback_message",
              model: "claude-opus-5",
              input_tokens: 300,
              output_tokens: 70,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0
            }
          ]
        }
      }
    )
  ]);
  const result = await provider.generateStructured<{ answer: string }>(request());
  assert.equal(result.model, "claude-opus-5");
  assert.deepEqual(result.usage, { inputTokens: 615, outputTokens: 90, calls: 1, cacheReadInputTokens: 10 });
});

test("AnthropicApiProvider throws max_tokens on stop_reason max_tokens", async () => {
  const { provider } = providerWith([anthropicFinalMessage('{"answer": "cut', { stop_reason: "max_tokens" })]);
  const error = await rejectsWith(provider.generateStructured(request()), "max_tokens", false);
  assert.deepEqual(error.usage, { inputTokens: 1200, outputTokens: 300, calls: 1, cacheReadInputTokens: 0 });
});

test("AnthropicApiProvider throws refusal with stop_details category", async () => {
  const { provider } = providerWith([
    anthropicFinalMessage("", { stop_reason: "refusal", stop_details: { type: "refusal", category: "bio" } })
  ]);
  const error = await rejectsWith(provider.generateStructured(request()), "refusal", false);
  assert.equal(error.message, "The model declined the request (category: bio).");
  assert.ok(error.usage);

  const unknownStop = providerWith([anthropicFinalMessage({ answer: "x" }, { stop_reason: "pause_turn" })]);
  const unexpected = await rejectsWith(unknownStop.provider.generateStructured(request()), "unknown", false);
  assert.ok(unexpected.usage);
});

test("AnthropicApiProvider ignores text before the last fallback block", async () => {
  const { provider } = providerWith([
    anthropicFinalMessage("", {
      content: [
        { type: "text", text: "declined preamble {" },
        { type: "fallback", from: { model: "a" }, to: { model: "b" }, trigger: { type: "refusal", category: null } },
        { type: "text", text: "more junk" },
        { type: "fallback", from: { model: "b" }, to: { model: "c" }, trigger: { type: "refusal", category: null } },
        { type: "text", text: '{"answer":' },
        { type: "text", text: '"final"}' }
      ]
    })
  ]);
  const result = await provider.generateStructured<{ answer: string }>(request());
  assert.deepEqual(result.data, { answer: "final" });
});

test("AnthropicApiProvider throws invalid_output on non-JSON text", async () => {
  const { provider } = providerWith([anthropicFinalMessage("Sure! Here is the harness.")]);
  const error = await rejectsWith(provider.generateStructured(request()), "invalid_output", true);
  assert.ok(error.usage);
});

test("AnthropicApiProvider throws invalid_output on schema mismatch with usage attached", async () => {
  const { provider } = providerWith([anthropicFinalMessage({ answer: 42 })]);
  const error = await rejectsWith(provider.generateStructured(request()), "invalid_output", true);
  assert.match(error.message, /^AI output did not match the expected schema: \/answer: must be string/);
  assert.deepEqual(error.usage, { inputTokens: 1200, outputTokens: 300, calls: 1, cacheReadInputTokens: 0 });
});

// ---- error mapping ----

test("AnthropicApiProvider maps AuthenticationError to auth non-retryable", async () => {
  const { provider } = providerWith([anthropicErrors.auth()]);
  const error = await rejectsWith(provider.generateStructured(request()), "auth", false);
  assert.equal(error.message, "Anthropic rejected the API key (401).");
  assert.equal(error.usage, undefined);
});

test("AnthropicApiProvider maps PermissionDeniedError to auth", async () => {
  const { provider } = providerWith([anthropicErrors.permission()]);
  const error = await rejectsWith(provider.generateStructured(request()), "auth", false);
  assert.equal(error.message, 'The API key is not allowed to use model "claude-opus-5-5" (403).');
});

test("AnthropicApiProvider maps RateLimitError to rate_limit retryable", async () => {
  const { provider } = providerWith([anthropicErrors.rateLimit()]);
  await rejectsWith(provider.generateStructured(request()), "rate_limit", true);
});

test("AnthropicApiProvider maps 529 InternalServerError to rate_limit", async () => {
  const { provider } = providerWith([anthropicErrors.overloaded(), anthropicErrors.server()]);
  await rejectsWith(provider.generateStructured(request()), "rate_limit", true);
  const server = await rejectsWith(provider.generateStructured(request()), "unknown", true);
  assert.equal(server.message, "Anthropic server error (500).");
});

test("AnthropicApiProvider maps BadRequestError to config with API message", async () => {
  const { provider } = providerWith([
    Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message: "thinking.type: unsupported" } },
      "thinking.type: unsupported",
      new Headers()
    )
  ]);
  const error = await rejectsWith(provider.generateStructured(request()), "config", false);
  assert.match(error.message, /^Request rejected \(400\): .*thinking\.type: unsupported/);
  assert.ok(error.message.length <= "Request rejected (400): ".length + 300);
});

test("AnthropicApiProvider maps NotFoundError to config", async () => {
  const { provider } = providerWith([anthropicErrors.notFound()]);
  const error = await rejectsWith(provider.generateStructured(request()), "config", false);
  assert.equal(error.message, 'Model "claude-opus-5-5" was not found (404).');
});

test("AnthropicApiProvider maps APIConnectionTimeoutError to network retryable", async () => {
  const { provider } = providerWith([anthropicErrors.timeout(), anthropicErrors.connection()]);
  const timeout = await rejectsWith(provider.generateStructured(request()), "network", true);
  assert.equal(timeout.message, "Connection to Anthropic timed out.");
  const connection = await rejectsWith(provider.generateStructured(request()), "network", true);
  assert.equal(connection.message, "Could not connect to Anthropic.");
});

test("AnthropicApiProvider maps caller abort to aborted", async () => {
  const caller = new AbortController();
  const { provider } = providerWith([hangingMessage]);
  const pending = provider.generateStructured(request({ signal: caller.signal }));
  setTimeout(() => {
    caller.abort("cancelled");
  }, 5);
  await rejectsWith(pending, "aborted", false);

  // Already aborted: no call is made.
  const { provider: second, calls } = providerWith([anthropicFinalMessage({ answer: "x" })]);
  await rejectsWith(second.generateStructured(request({ signal: AbortSignal.abort("cancelled") })), "aborted", false);
  assert.equal(calls.length, 0);
});

test("AnthropicApiProvider maps deadline expiry to network retryable", async () => {
  const { provider } = providerWith([hangingMessage], { callDeadlineMs: 20 });
  const error = await rejectsWith(provider.generateStructured(request()), "network", true);
  assert.match(error.message, /^AI request timed out after/);
});

test("AnthropicApiProvider rejects oversize image before calling the API", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "x" })]);
  const error = await rejectsWith(
    provider.generateStructured(
      request({ images: [{ mediaType: "image/png", base64: "A".repeat(6_900_001), label: "huge" }] })
    ),
    "unknown",
    false
  );
  assert.match(error.message, /larger than the 5 MB API limit/);
  assert.equal(calls.length, 0);
});

test("AnthropicApiProvider rejects request schemas that are not structured-output compatible", async () => {
  const { provider, calls } = providerWith([anthropicFinalMessage({ answer: "x" })]);
  await assert.rejects(
    provider.generateStructured(
      request({ jsonSchema: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } })
    ),
    /additionalProperties: false/
  );
  assert.equal(calls.length, 0);
});
