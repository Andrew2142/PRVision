import assert from "node:assert/strict";
import test from "node:test";
import { AiProviderError } from "../../../backend/src/types/visualization-pipeline";
import type { ResolvedAiSettings } from "../../../backend/src/utilities/services/ai/ai-provider";
import { AiProviderFactory } from "../../../backend/src/utilities/services/ai/ai-provider-factory";
import { AnthropicApiProvider } from "../../../backend/src/utilities/services/ai/anthropic-api-provider";
import {
  ClaudeCodeProvider,
  NOT_INSTALLED_MESSAGE
} from "../../../backend/src/utilities/services/ai/claude-code-provider";
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
    "Add an Anthropic API key, or switch the provider to Claude Code."
  );
});

test("AiProviderFactory.create throws config when key unreadable", () => {
  configError(
    () => AiProviderFactory.create(settings({ anthropicApiKey: { state: "unreadable" } })),
    "The stored Anthropic API key can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the key again."
  );
});

test("AiProviderFactory.create returns ClaudeCodeProvider without a key", () => {
  const provider = AiProviderFactory.create(
    settings({ provider: "claude_code", anthropicApiKey: { state: "absent" } })
  );
  assert.ok(provider instanceof ClaudeCodeProvider);
  assert.equal(provider.kind, "claude_code");
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
    message: "Add an Anthropic API key, or switch the provider to Claude Code."
  });
  assert.deepEqual(await AiProviderFactory.readiness(settings()), {
    ready: true,
    provider: "anthropic_api",
    model: "claude-opus-5-5"
  });
});

test("AiProviderFactory.readiness for claude_code checks that the claude CLI runs", async (t) => {
  let status: Awaited<ReturnType<typeof ClaudeCodeProvider.checkCli>> = {
    available: false,
    message: NOT_INSTALLED_MESSAGE
  };
  const restore = patchStaticMethod(ClaudeCodeProvider, "checkCli", () => Promise.resolve(status));
  t.after(restore);
  const claude = settings({ provider: "claude_code", anthropicApiKey: { state: "absent" } });
  assert.deepEqual(await AiProviderFactory.readiness(claude), {
    ready: false,
    reason: "ai_not_configured",
    message: NOT_INSTALLED_MESSAGE
  });
  status = { available: true, version: "2.1.280" };
  assert.deepEqual(await AiProviderFactory.readiness(claude), {
    ready: true,
    provider: "claude_code",
    model: "claude-opus-5-5"
  });
});
