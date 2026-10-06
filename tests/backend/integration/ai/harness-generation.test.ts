/**
 * Real-AI check of sheet 09 (09 §10): two harness calls against the Anthropic API pass HarnessValidator, and the
 * second call reads the cached system prompt. Gated on PRVISION_IT_AI=1 plus ANTHROPIC_API_KEY (costs tokens).
 * The fixture-repo variant (Button and UserMenu from feature/button-restyle) is sheet 14's anthropic-api.test.ts.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { AiProviderFactory } from "../../../../backend/src/utilities";
import { recordLogger } from "../../helpers/console-recorder";
import { componentCandidate, setupService } from "../../harness/helpers/service-setup";
import { itSkip } from "../helpers/it-flags";

const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
const model = process.env.PRVISION_IT_AI_MODEL ?? "claude-opus-5-5";
const skip = itSkip("ai") || (apiKey === "" ? "set ANTHROPIC_API_KEY" : false);

test("harness generation passes post-validation and reuses the prompt cache", { skip, timeout: 900_000 }, async (t) => {
  const logs = recordLogger();
  t.after(logs.restore);
  const candidates = [
    componentCandidate("Button", { componentId: 1, rank: 0 }),
    componentCandidate("Badge", { componentId: 2, rank: 1 })
  ];
  const { service, handle } = setupService(t, { candidates });
  handle.context.ai = AiProviderFactory.create({
    provider: "anthropic_api",
    model,
    harnessEffort: "low",
    summaryEffort: "low",
    anthropicApiKey: { state: "present", value: apiKey }
  });
  handle.context.aiSettings = { model, harnessEffort: "low", summaryEffort: "low" };

  const batch = await service.generateAll(candidates);
  assert.deepEqual(batch.failures, [], JSON.stringify(batch.failures));
  assert.equal(batch.results.length, 2, "every result passed HarnessValidator");
  const calls = logs.lines.filter((line) => line.event === "harness.ai.call");
  assert.ok(calls.length >= 2);
  assert.ok(
    calls.slice(1).some((line) => typeof line.cacheReadInputTokens === "number" && line.cacheReadInputTokens > 0),
    "a call after the first read the cached system prompt"
  );
});
