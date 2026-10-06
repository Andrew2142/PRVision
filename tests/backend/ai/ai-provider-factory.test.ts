import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderError } from "../../../backend/src/types/visualization-pipeline";
import type { ResolvedAiSettings } from "../../../backend/src/utilities/services/ai/ai-provider";
import { AiProviderFactory } from "../../../backend/src/utilities/services/ai/ai-provider-factory";
import { AnthropicApiProvider } from "../../../backend/src/utilities/services/ai/anthropic-api-provider";
import { DrizzleDb } from "../../../backend/src/utilities/services/drizzle-db";
import { patchStaticMethod } from "../helpers/test-context";

const KEY = `sk-ant-api03-${"f".repeat(40)}`;

function settings(overrides: Partial<ResolvedAiSettings> = {}): ResolvedAiSettings {
  return {
    provider: "anthropic_api",
    model: "claude-opus-5-5",
    harnessEffort: "high",
    summaryEffort: "medium",
    anthropicApiKey: { state: "present", value: KEY },
    ...overrides
  };
}

function configError(fn: () => unknown, message: string): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof AiProviderError);
    assert.equal(error.reason, "config");
    assert.equal(error.retryable, false);
    assert.equal(error.message, message);
    return true;
  });
}

test("AiProviderFactory.create returns AnthropicApiProvider when key present", () => {
  const provider = AiProviderFactory.create(settings());
  assert.ok(provider instanceof AnthropicApiProvider);
  assert.equal(provider.kind, "anthropic_api");
});

test("AiProviderFactory.create throws config when key absent", () => {
  configError(
    () => AiProviderFactory.create(settings({ anthropicApiKey: { state: "absent" } })),
    "Add an Anthropic API key in Settings."
  );
});

test("AiProviderFactory.create throws config when key unreadable", () => {
  configError(
    () => AiProviderFactory.create(settings({ anthropicApiKey: { state: "unreadable" } })),
    "The stored Anthropic API key can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the key again."
  );
});

test("AiProviderFactory.create treats the legacy claude_code provider as not configured, even with a key", () => {
  for (const anthropicApiKey of [{ state: "absent" as const }, { state: "present" as const, value: KEY }]) {
    configError(
      () => AiProviderFactory.create(settings({ provider: "claude_code", anthropicApiKey })),
      "The Claude Code provider is no longer available. Add an Anthropic API key in Settings and save."
    );
  }
});

test("AiProviderFactory.create throws config for empty model", () => {
  configError(
    () => AiProviderFactory.create(settings({ model: "   " })),
    "No AI model is configured. Set a model in Settings."
  );
});

test("AiProviderFactory.readiness(settings) returns ai_not_configured message without touching the DB", async (t) => {
  const restore = patchStaticMethod(DrizzleDb, "getInstance", () => {
    throw new Error("readiness must not touch the database");
  });
  t.after(restore);
  assert.deepEqual(await AiProviderFactory.readiness(settings({ anthropicApiKey: { state: "absent" } })), {
    ready: false,
    reason: "ai_not_configured",
    message: "Add an Anthropic API key in Settings."
  });
  assert.deepEqual(await AiProviderFactory.readiness(settings()), {
    ready: true,
    provider: "anthropic_api",
    model: "claude-opus-5-5"
  });
});

test("AiProviderFactory.readiness for the legacy claude_code provider is ai_not_configured", async () => {
  assert.deepEqual(await AiProviderFactory.readiness(settings({ provider: "claude_code" })), {
    ready: false,
    reason: "ai_not_configured",
    message: "The Claude Code provider is no longer available. Add an Anthropic API key in Settings and save."
  });
});
