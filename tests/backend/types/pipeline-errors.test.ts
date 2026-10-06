import assert from "node:assert/strict";
import { test } from "node:test";
import { AiProviderError, PipelineStepError, isAbortError, isPipelineStepError } from "../../../backend/src/types";
import { PipelineStepError as ReexportedPipelineStepError } from "../../../backend/src/types/visualization-pipeline";

test("PipelineStepError keeps stage, userMessage, detail, code and cause", () => {
  const cause = new Error("spawn vite ENOENT");
  const error = new PipelineStepError("rendering", "Vite failed to start.", {
    detail: "vite exited 1",
    code: "vite_start",
    cause
  });
  assert.equal(error.name, "PipelineStepError");
  assert.equal(error.stage, "rendering");
  assert.equal(error.userMessage, "Vite failed to start.");
  assert.equal(error.message, "vite exited 1");
  assert.equal(error.code, "vite_start");
  assert.equal(error.cause, cause);
  assert.ok(error instanceof Error);
});

test("PipelineStepError message defaults to userMessage and code to null", () => {
  const error = new PipelineStepError("queued", "Worktree failed.");
  assert.equal(error.message, "Worktree failed.");
  assert.equal(error.code, null);
});

test("PipelineStepError is re-exported from visualization-pipeline", () => {
  assert.equal(ReexportedPipelineStepError, PipelineStepError);
});

test("isPipelineStepError narrows only PipelineStepError", () => {
  assert.equal(isPipelineStepError(new PipelineStepError("diffing", "x")), true);
  assert.equal(isPipelineStepError(new Error("x")), false);
  assert.equal(isPipelineStepError("x"), false);
});

test("isAbortError is true for AbortError and false for TimeoutError and plain errors", async () => {
  const aborted = AbortSignal.abort();
  assert.throws(
    () => aborted.throwIfAborted(),
    (error: unknown) => isAbortError(error)
  );

  const timed = AbortSignal.timeout(1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.throws(
    () => timed.throwIfAborted(),
    (error: unknown) => !isAbortError(error)
  );

  assert.equal(isAbortError(new Error("boom")), false);
});

test("AiProviderError carries reason, retryable, optional usage and its name", () => {
  const usage = { inputTokens: 10, outputTokens: 2, calls: 1, cacheReadInputTokens: 4 };
  const error = new AiProviderError("cut off", "max_tokens", false, usage);
  assert.equal(error.name, "AiProviderError");
  assert.equal(error.reason, "max_tokens");
  assert.equal(error.retryable, false);
  assert.deepEqual(error.usage, usage);
  assert.equal(new AiProviderError("x", "network", true).usage, undefined);
});
