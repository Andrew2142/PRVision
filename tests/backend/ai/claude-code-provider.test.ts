import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { CHILD_PROCESS_BASE_ENV } from "../../../backend/src/config-consts";
import { AiProviderError, type AiStructuredRequest } from "../../../backend/src/types/visualization-pipeline";
import { ProcessError } from "../../../backend/src/utilities/helpers/process";
import {
  ClaudeCodeProvider,
  NOT_INSTALLED_MESSAGE,
  NOT_SIGNED_IN_MESSAGE,
  buildClaudeCodeEnv
} from "../../../backend/src/utilities/services/ai/claude-code-provider";
import { agentResult, fakeClaudeCli, type FakeCliRun } from "../helpers/ai-sdk-fakes";
import { withTempDir } from "../helpers/test-context";

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } }
};
const INIT = { type: "system", subtype: "init", model: "claude-opus-5-5", apiKeySource: "none" };

function request(overrides: Partial<AiStructuredRequest> = {}): AiStructuredRequest {
  return {
    purpose: "harness",
    system: "System text",
    prompt: "Do the task.",
    jsonSchema: SCHEMA,
    effort: "high",
    ...overrides
  };
}

function ok(structured: unknown, overrides: Record<string, unknown> = {}): FakeCliRun {
  return { events: [INIT, agentResult("", { structured_output: structured, ...overrides })] };
}

function provider(runs: FakeCliRun[]): {
  provider: ClaudeCodeProvider;
  calls: ReturnType<typeof fakeClaudeCli>["calls"];
} {
  const fake = fakeClaudeCli(runs);
  return { provider: new ClaudeCodeProvider({ model: "claude-opus-5-5", run: fake.run }), calls: fake.calls };
}

function processError(kind: ProcessError["kind"], stderr = ""): ProcessError {
  return new ProcessError(
    `claude failed (${kind})`,
    kind,
    "claude",
    kind === "non_zero_exit" ? 2 : null,
    null,
    "",
    stderr,
    1
  );
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

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function stdinMessage(input: string | Buffer | undefined): {
  type: string;
  message: { role: string; content: Array<Record<string, unknown>> };
} {
  assert.equal(typeof input, "string");
  const text = input as string;
  assert.ok(text.endsWith("\n"));
  return JSON.parse(text) as { type: string; message: { role: string; content: Array<Record<string, unknown>> } };
}

test("ClaudeCodeProvider runs claude --print locked down, in the worktree, and returns the structured output", async () => {
  await withTempDir(async (worktree) => {
    const { provider: cli, calls } = provider([ok({ answer: "ok" })]);
    const result = await cli.generateStructured<{ answer: string }>(
      request({ workingDirectory: worktree, effort: "medium" })
    );
    assert.deepEqual(result.data, { answer: "ok" });
    assert.equal(result.model, "claude-opus-5-5");
    assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 250, calls: 1, cacheReadInputTokens: 0 });

    const call = calls[0];
    assert.ok(call);
    assert.equal(call.command, "claude");
    assert.equal(call.options.cwd, worktree);
    assert.deepEqual(call.options.allowedExitCodes, [0, 1]);
    const args = call.args;
    for (const flag of [
      "--print",
      "--verbose",
      "--safe-mode",
      "--strict-mcp-config",
      "--disable-slash-commands",
      "--no-session-persistence"
    ]) {
      assert.ok(args.includes(flag), `missing ${flag}`);
    }
    assert.equal(flagValue(args, "--input-format"), "stream-json");
    assert.equal(flagValue(args, "--output-format"), "stream-json");
    assert.equal(flagValue(args, "--tools"), "");
    assert.equal(flagValue(args, "--permission-mode"), "dontAsk");
    assert.equal(flagValue(args, "--model"), "claude-opus-5-5");
    assert.equal(flagValue(args, "--effort"), "medium");
    assert.deepEqual(JSON.parse(flagValue(args, "--json-schema") ?? "null"), SCHEMA);
    assert.ok(!args.includes("--dangerously-skip-permissions"));
    assert.equal(call.systemPrompt, "System text");
    assert.ok(!args.includes("Do the task."), "the prompt goes on stdin, never on argv");

    const message = stdinMessage(call.options.input);
    assert.equal(message.type, "user");
    assert.deepEqual(message.message.content, [{ type: "text", text: "Do the task." }]);
  });
});

test("ClaudeCodeProvider uses a private temp cwd when workingDirectory is absent and removes it", async () => {
  const { provider: cli, calls } = provider([ok({ answer: "ok" })]);
  await cli.generateStructured(request());
  const cwd = calls[0]?.options.cwd ?? "";
  assert.match(cwd, /prvision-cc-/);
  await assert.rejects(fs.stat(cwd), { code: "ENOENT" });
  await assert.rejects(fs.stat(flagValue(calls[0]?.args ?? [], "--system-prompt-file") ?? ""), { code: "ENOENT" });
});

test("ClaudeCodeProvider sends images as base64 blocks before the legend and prompt", async () => {
  const { provider: cli, calls } = provider([ok({ answer: "ok" })]);
  await cli.generateStructured(
    request({
      prompt: "Summarize.",
      images: [
        { mediaType: "image/png", base64: "AAAA", label: "Button base" },
        { mediaType: "image/png", base64: "BBBB", label: "Button head" }
      ]
    })
  );
  const content = stdinMessage(calls[0]?.options.input).message.content;
  assert.deepEqual(content, [
    { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    { type: "image", source: { type: "base64", media_type: "image/png", data: "BBBB" } },
    { type: "text", text: "Image 1: Button base\nImage 2: Button head\n\nSummarize." }
  ]);
});

test("ClaudeCodeProvider env is the child allow-list plus the CLI login variables, never an API key", () => {
  const env = buildClaudeCodeEnv({ CLAUDE_CONFIG_DIR: "/home/u/.claude" });
  assert.equal(env.CLAUDE_CONFIG_DIR, "/home/u/.claude");
  assert.deepEqual(
    { ...env, CLAUDE_CONFIG_DIR: undefined },
    { ...CHILD_PROCESS_BASE_ENV, CLAUDE_CONFIG_DIR: undefined }
  );
  for (const name of Object.keys(buildClaudeCodeEnv())) {
    assert.ok(!name.startsWith("ANTHROPIC_"), name);
    assert.ok(!name.startsWith("PRVISION_"), name);
    assert.notEqual(name, "CLAUDECODE");
  }
});

test("ClaudeCodeProvider falls back to the JSON object in the result text", async () => {
  const { provider: cli } = provider([{ events: [INIT, agentResult('Here:\n```json\n{"answer":"fenced"}\n```')] }]);
  const result = await cli.generateStructured<{ answer: string }>(request());
  assert.deepEqual(result.data, { answer: "fenced" });
});

test("ClaudeCodeProvider retries once with the validation errors and sums usage", async () => {
  const { provider: cli, calls } = provider([ok({ answer: 7 }), ok({ answer: "fixed" })]);
  const result = await cli.generateStructured<{ answer: string }>(request());
  assert.deepEqual(result.data, { answer: "fixed" });
  assert.equal(result.usage.calls, 2);
  assert.equal(result.usage.inputTokens, 1800);
  const retryText = String(stdinMessage(calls[1]?.options.input).message.content[0]?.text);
  assert.ok(retryText.startsWith("Do the task."));
  assert.ok(retryText.includes('{"answer":7}'));
  assert.ok(retryText.includes("did not satisfy the required JSON Schema"));
});

test("ClaudeCodeProvider fails with invalid_output after the retry, carrying usage", async () => {
  const { provider: cli } = provider([ok({ answer: 1 }), ok({ answer: 2 })]);
  const error = await rejectsWith(cli.generateStructured(request()), "invalid_output", true);
  assert.equal(error.usage?.calls, 2);
});

test("ClaudeCodeProvider maps an expired login to auth", async () => {
  const { provider: cli } = provider([
    {
      exitCode: 1,
      events: [
        INIT,
        { type: "assistant", error: "authentication_failed", message: { model: "<synthetic>", content: [] } },
        agentResult("Failed to authenticate: OAuth session expired and could not be refreshed", {
          is_error: true,
          usage: { input_tokens: 0, output_tokens: 0 }
        })
      ]
    }
  ]);
  const error = await rejectsWith(cli.generateStructured(request()), "auth", false);
  assert.equal(error.message, NOT_SIGNED_IN_MESSAGE);
});

test("ClaudeCodeProvider maps a subscription usage limit to rate_limit", async () => {
  const { provider: cli } = provider([
    {
      exitCode: 1,
      events: [INIT, agentResult("You've hit your limit · resets 3pm (Europe/London)", { is_error: true })]
    }
  ]);
  const error = await rejectsWith(cli.generateStructured(request()), "rate_limit", true);
  assert.match(error.message, /resets 3pm/);
});

test("ClaudeCodeProvider maps max turns to invalid_output", async () => {
  const { provider: cli } = provider([
    { exitCode: 1, events: [INIT, agentResult("", { subtype: "error_max_turns", is_error: true, errors: [] })] }
  ]);
  await rejectsWith(cli.generateStructured(request()), "invalid_output", true);
});

test("ClaudeCodeProvider reports stderr when the CLI fails before producing a result", async () => {
  const { provider: cli } = provider([
    { exitCode: 1, events: [], stderr: "error: unknown option '--safe-mode'\nmore" }
  ]);
  const error = await rejectsWith(cli.generateStructured(request()), "unknown", false);
  assert.equal(error.message, "error: unknown option '--safe-mode'");
});

test("ClaudeCodeProvider maps process failures: missing binary, timeout, abort, other exit codes", async () => {
  const missing = await rejectsWith(
    provider([processError("spawn_failed")]).provider.generateStructured(request()),
    "config",
    false
  );
  assert.equal(missing.message, NOT_INSTALLED_MESSAGE);
  await rejectsWith(provider([processError("timeout")]).provider.generateStructured(request()), "network", true);
  await rejectsWith(provider([processError("aborted")]).provider.generateStructured(request()), "aborted", false);
  const exit = await rejectsWith(
    provider([processError("non_zero_exit", "segfault\n")]).provider.generateStructured(request()),
    "unknown",
    false
  );
  assert.equal(exit.message, "Claude Code exited with code 2: segfault");
});

test("ClaudeCodeProvider passes the caller's signal and does not run when it is already aborted", async () => {
  const controller = new AbortController();
  const { provider: cli, calls } = provider([ok({ answer: "ok" })]);
  await cli.generateStructured(request({ signal: controller.signal }));
  assert.equal(calls[0]?.options.signal, controller.signal);
  controller.abort();
  await rejectsWith(cli.generateStructured(request({ signal: controller.signal })), "aborted", false);
  assert.equal(calls.length, 1);
});

test("ClaudeCodeProvider rejects a schema too large for argv without running", async () => {
  const { provider: cli, calls } = provider([]);
  const huge = { type: "object", description: "x".repeat(200_000) };
  await rejectsWith(cli.generateStructured(request({ jsonSchema: huge })), "config", false);
  assert.equal(calls.length, 0);
});

test("ClaudeCodeProvider.checkCli reports the version, caches success and reports a missing binary", async () => {
  ClaudeCodeProvider.resetCliCheckForTesting();
  let runs = 0;
  const found = () => {
    runs += 1;
    return Promise.resolve({ stdout: "2.1.280 (Claude Code)\n", stderr: "", exitCode: 0, durationMs: 1 });
  };
  assert.deepEqual(await ClaudeCodeProvider.checkCli(found), { available: true, version: "2.1.280" });
  assert.deepEqual(await ClaudeCodeProvider.checkCli(found), { available: true, version: "2.1.280" });
  assert.equal(runs, 1);
  ClaudeCodeProvider.resetCliCheckForTesting();
  const missing = () => Promise.reject(processError("spawn_failed"));
  assert.deepEqual(await ClaudeCodeProvider.checkCli(missing), { available: false, message: NOT_INSTALLED_MESSAGE });
  ClaudeCodeProvider.resetCliCheckForTesting();
});
