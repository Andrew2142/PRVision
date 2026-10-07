import assert from "node:assert/strict";
import { test } from "node:test";
import { AI_MODEL_PRICES_USD_PER_MTOK, AI_PRICE_FALLBACK_MODEL } from "../../../backend/src/config-consts";
import { priceFor, usageCostUsd } from "../../../backend/src/utilities/helpers/ai-cost";

test("usageCostUsd prices the default harness usage of claude-opus-5-5 at $0.2669 (16 §20.1)", () => {
  assert.deepEqual(
    usageCostUsd("claude-opus-5-5", {
      inputTokens: 26_000,
      cacheReadInputTokens: 4_500,
      cacheWriteInputTokens: 0,
      outputTokens: 9_000,
      calls: 1
    }),
    { usd: 0.2669, exact: true, priceModel: "claude-opus-5-5" }
  );
});

test("usageCostUsd prices cache writes at 1.25 × input and keeps them out of the uncached input", () => {
  // 1M input tokens of which 1M are cache writes: only the cache-write price applies (5 = 1.25 × 4).
  const writes = usageCostUsd("claude-opus-5-5", {
    inputTokens: 1_000_000,
    cacheWriteInputTokens: 1_000_000,
    outputTokens: 0,
    calls: 1
  });
  assert.equal(writes.usd, 5);
  const plain = usageCostUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0, calls: 1 });
  assert.equal(plain.usd, 4);
  for (const price of Object.values(AI_MODEL_PRICES_USD_PER_MTOK)) {
    assert.equal(price.cacheWrite, price.input * 1.25);
  }
});

test("usageCostUsd treats missing cache fields as 0", () => {
  assert.equal(
    usageCostUsd("claude-sonnet-4-6", { inputTokens: 2_000_000, outputTokens: 1_000_000, calls: 3 }).usd,
    2 * 3 + 15
  );
  assert.equal(
    usageCostUsd("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 0,
      calls: 1
    }).usd,
    0.3
  );
});

test("usageCostUsd never prices negative uncached input", () => {
  assert.equal(
    usageCostUsd("claude-haiku-4-5", {
      inputTokens: 10,
      cacheReadInputTokens: 1_000_000,
      outputTokens: 0,
      calls: 1
    }).usd,
    0.1
  );
});

test("usageCostUsd rounds to 4 decimals", () => {
  // 1 output token of opus-5-5 = 0.00002 USD → 0
  assert.equal(usageCostUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 1, calls: 1 }).usd, 0);
  // 7 output tokens = 0.00014 → 0.0001; 8 = 0.00016 → 0.0002
  assert.equal(usageCostUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 7, calls: 1 }).usd, 0.0001);
  assert.equal(usageCostUsd("claude-opus-5-5", { inputTokens: 0, outputTokens: 8, calls: 1 }).usd, 0.0002);
  // 123 457 input tokens at $4 = 0.493828 → 0.4938
  assert.equal(usageCostUsd("claude-opus-5-5", { inputTokens: 123_457, outputTokens: 0, calls: 1 }).usd, 0.4938);
});

test("priceFor matches the lower-cased model id exactly; unknown models use the fallback with exact = false (E17)", () => {
  const known = priceFor("Claude-Opus-5-5");
  assert.equal(known.exact, true);
  assert.equal(known.priceModel, "claude-opus-5-5");
  assert.deepEqual(known.price, {
    inputUsdPerMTok: 4,
    outputUsdPerMTok: 20,
    cacheReadUsdPerMTok: 0.2,
    cacheWriteUsdPerMTok: 5
  });

  const unknown = priceFor("claude-opus-5-5-preview");
  assert.equal(unknown.exact, false);
  assert.equal(unknown.priceModel, AI_PRICE_FALLBACK_MODEL);
  assert.deepEqual(unknown.price, {
    inputUsdPerMTok: 10,
    outputUsdPerMTok: 50,
    cacheReadUsdPerMTok: 0.25,
    cacheWriteUsdPerMTok: 12.5
  });

  const cost = usageCostUsd("some-future-model", { inputTokens: 1_000_000, outputTokens: 0, calls: 1 });
  assert.deepEqual(cost, { usd: 10, exact: false, priceModel: "claude-fable-5-1" });
  // An inherited object key is not a model.
  assert.equal(priceFor("constructor").exact, false);
});
