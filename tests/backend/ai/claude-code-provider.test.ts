import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { AI_CLAUDE_CODE_PARENT_ENV } from "../../../backend/src/config-consts";
import { AiProviderError, type AiStructuredRequest } from "../../../backend/src/types/visualization-pipeline";
import {
  ClaudeCodeProvider,
  buildClaudeCodeEnv,
  type AgentQueryFn,
  type ClaudeCodeQueryOptions
} from "../../../backend/src/utilities/services/ai/claude-code-provider";
import { agentResult, fakeAgentQuery } from "../helpers/ai-sdk-fakes";
import { patchStaticMethod, withTempDir } from "../helpers/test-context";

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["answer"],
  properties: { answer: { type: "string" } }
};
const INIT = { type: "system", subtype: "init", model: "claude-opus-5-5", cwd: "/x", tools: ["Read", "Glob", "Grep"] };

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

async function exists(target: string): Promise<boolean> {
  return fs.stat(target).then(
    () => true,
    () => false
  );
}

/** Behavioural options for buildSdkOptions tests. */
function sdkInputs(root: string): ClaudeCodeQueryOptions {
  return {
    cwd: root,
    model: "claude-opus-5-5",
    systemPrompt: "System text",
    allowedTools: ["Read", "Glob", "Grep"],
    readableRoots: [root],
    maxTurns: 40,
    env: { PATH: "/usr/bin" },
    abortController: new AbortController(),
    effort: "medium"
  };
}

test("ClaudeCodeProvider passes cwd from workingDirectory", async () => {
  await withTempDir(async (worktree) => {
    const fake = fakeAgentQuery([INIT, agentResult('{"answer":"ok"}')]);
    const provider = new ClaudeCodeProvider({ model: "claude-opus-5-5", queryFn: fake.queryFn });
    const result = await provider.generateStructured<{ answer: string }>(request({ workingDirectory: worktree }));
    assert.deepEqual(result.data, { answer: "ok" });
    assert.equal(result.model, "claude-opus-5-5");
    const options = fake.calls[0]!.options;
    assert.equal(options.cwd, worktree);
    assert.deepEqual(options.readableRoots, [worktree]);
    assert.equal(options.systemPrompt, "System text");
    assert.equal(options.effort, "high");
    assert.equal(options.maxTurns, 3);
    assert.ok(await exists(worktree)); // the caller's worktree is never removed
  });
});

test("ClaudeCodeProvider uses a temp cwd when workingDirectory is absent and removes it", async () => {
  let cwd = "";
  let mode = 0;
  const queryFn: AgentQueryFn = ({ options }) => {
    cwd = options.cwd;
    return (async function* () {
      mode = (await fs.stat(cwd)).mode & 0o777;
      yield agentResult('{"answer":"ok"}');
    })();
  };
  await new ClaudeCodeProvider({ model: "claude-opus-5-5", queryFn }).generateStructured(request());
  assert.match(path.basename(cwd), /^prvision-cc-/);
  assert.equal(mode, 0o700);
  assert.equal(await exists(cwd), false);
});

test("ClaudeCodeProvider gives text-only calls no tools and a 3-turn cap", async () => {
  const fake = fakeAgentQuery([agentResult('{"answer":"ok"}')]);
  await new ClaudeCodeProvider({ model: "m", queryFn: fake.queryFn }).generateStructured(request());
  assert.deepEqual(fake.calls[0]!.options.allowedTools, []);
  assert.equal(fake.calls[0]!.options.maxTurns, 3);

  const sdk = ClaudeCodeProvider.buildSdkOptions({ ...sdkInputs("/tmp"), allowedTools: [], maxTurns: 3 });
  assert.deepEqual(sdk.tools, []);
  assert.deepEqual(sdk.allowedTools, []);
  for (const tool of ["Read", "Glob", "Grep", "Bash", "Write", "Edit"]) {
    assert.ok(sdk.disallowedTools?.includes(tool), tool);
  }
  assert.equal(sdk.maxTurns, 3);
});

test("ClaudeCodeProvider tool budget allows only Read, one turn per image plus a margin", () => {
  assert.deepEqual(ClaudeCodeProvider.toolBudget(0), { allowedTools: [], maxTurns: 3 });
  assert.deepEqual(ClaudeCodeProvider.toolBudget(7), { allowedTools: ["Read"], maxTurns: 11 });
  assert.deepEqual(ClaudeCodeProvider.toolBudget(100), { allowedTools: ["Read"], maxTurns: 40 });
});

test("ClaudeCodeProvider restricts tools to Read, Glob, Grep when the caller allows them", () => {
  const sdk = ClaudeCodeProvider.buildSdkOptions(sdkInputs("/tmp"));
  assert.deepEqual(sdk.tools, ["Read", "Glob", "Grep"]);
  assert.deepEqual(sdk.allowedTools, ["Read", "Glob", "Grep"]);
  for (const tool of ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent"]) {
    assert.ok(sdk.disallowedTools?.includes(tool), tool);
  }
  assert.equal(sdk.permissionMode, "dontAsk");
  assert.equal(typeof sdk.canUseTool, "function");
  assert.equal(sdk.hooks?.PreToolUse?.length, 1);
  assert.equal(sdk.systemPrompt, "System text");
  assert.equal(sdk.model, "claude-opus-5-5");
  assert.equal(sdk.maxTurns, 40);
  assert.equal(sdk.effort, "medium");
});

test("buildClaudeCodeEnv defaults its base to AI_CLAUDE_CODE_PARENT_ENV", async () => {
  assert.deepEqual(buildClaudeCodeEnv(), buildClaudeCodeEnv(AI_CLAUDE_CODE_PARENT_ENV));
  const env = buildClaudeCodeEnv();
  for (const name of ["PRVISION_SECRET_KEY", "DATABASE_URL", "REDIS_URL", "NODE_OPTIONS", "PRVISION_DATA_DIR"]) {
    assert.equal(name in env, false, name);
  }
  const fake = fakeAgentQuery([agentResult('{"answer":"ok"}')]);
  await new ClaudeCodeProvider({ model: "m", queryFn: fake.queryFn }).generateStructured(request());
  assert.deepEqual(fake.calls[0]!.options.env, env);
});

test("buildClaudeCodeEnv keeps PATH/HOME and ANTHROPIC_* and drops PRVISION_SECRET_KEY, DATABASE_URL, REDIS_URL, NODE_OPTIONS and unrelated vars", () => {
  const env = buildClaudeCodeEnv({
    PATH: "/usr/bin",
    HOME: "/home/dev",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    CLAUDE_CONFIG_DIR: "/home/dev/.claude",
    NODE_EXTRA_CA_CERTS: "/certs.pem",
    PRVISION_SECRET_KEY: "secret",
    PRVISION_DATA_DIR: "/data",
    DATABASE_URL: "postgres://u:p@h/db",
    REDIS_URL: "redis://h",
    NODE_OPTIONS: "--require evil.js",
    AWS_SECRET_ACCESS_KEY: "nope",
    GITHUB_TOKEN: "nope"
  });
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    CLAUDE_CONFIG_DIR: "/home/dev/.claude",
    NODE_EXTRA_CA_CERTS: "/certs.pem"
  });
});

test("ClaudeCodeProvider does not load setting sources from the repository", () => {
  const sdk = ClaudeCodeProvider.buildSdkOptions(sdkInputs("/tmp"));
  assert.deepEqual(sdk.settingSources, []);
  assert.equal(sdk.strictMcpConfig, true);
  assert.deepEqual(sdk.mcpServers, {});
  assert.deepEqual(sdk.skills, []);
  assert.equal(sdk.persistSession, false);
  assert.equal(sdk.verbatimPrompts, true);
  assert.deepEqual(sdk.env, { PATH: "/usr/bin" }); // replaces the child env (not merged with process.env)
});

test("ClaudeCodeProvider writes images to temp files, references them in the prompt, deletes them", async () => {
  const png = Buffer.from("fake-png-bytes").toString("base64");
  const seen: Array<{ file: string; mode: number; bytes: string }> = [];
  let roots: string[] = [];
  let prompt = "";
  const queryFn: AgentQueryFn = (args) => {
    prompt = args.prompt;
    roots = args.options.readableRoots;
    return (async function* () {
      for (const match of args.prompt.matchAll(/^\d+\. (\S+\.png) — /gm)) {
        const file = match[1]!;
        const stat = await fs.stat(file);
        seen.push({ file, mode: stat.mode & 0o777, bytes: (await fs.readFile(file)).toString() });
      }
      yield agentResult('{"answer":"ok"}');
    })();
  };
  await new ClaudeCodeProvider({ model: "m", queryFn }).generateStructured(
    request({
      images: [
        { mediaType: "image/png", base64: png, label: "Button (before)" },
        { mediaType: "image/png", base64: png, label: "Button (after)" }
      ]
    })
  );
  assert.ok(prompt.startsWith("Before answering, use the Read tool to view these images:\n1. "));
  assert.equal(seen.length, 2);
  assert.match(path.basename(seen[0]!.file), /^1-button-before\.png$/);
  assert.deepEqual(
    seen.map((entry) => [entry.mode, entry.bytes]),
    [
      [0o600, "fake-png-bytes"],
      [0o600, "fake-png-bytes"]
    ]
  );
  assert.equal(roots.length, 2);
  assert.equal(roots[1], path.dirname(seen[0]!.file));
  for (const entry of seen) {
    assert.equal(await exists(entry.file), false);
  }
  assert.equal(await exists(roots[1]), false);
});

test("ClaudeCodeProvider extracts JSON from fenced output", async () => {
  const fake = fakeAgentQuery([INIT, agentResult('Here it is:\n```json\n{"answer": "fenced"}\n```')]);
  const result = await new ClaudeCodeProvider({ model: "m", queryFn: fake.queryFn }).generateStructured<{
    answer: string;
  }>(request());
  assert.deepEqual(result.data, { answer: "fenced" });
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 250, calls: 1, cacheReadInputTokens: 0 });
  assert.ok(fake.calls[0]!.prompt.includes("<json_schema>"));
  assert.ok(fake.calls[0]!.prompt.startsWith("Do the task."));
});

test("ClaudeCodeProvider retries once with validation errors when output is invalid", async () => {
  const outputs = ['{"answer": 7}', '{"answer": "fixed"}'];
  const prompts: string[] = [];
  const queryFn: AgentQueryFn = ({ prompt }) => {
    prompts.push(prompt);
    const text = outputs.shift() ?? "";
    return (async function* () {
      await Promise.resolve();
      yield agentResult(text);
    })();
  };
  const result = await new ClaudeCodeProvider({ model: "m", queryFn }).generateStructured<{ answer: string }>(
    request()
  );
  assert.deepEqual(result.data, { answer: "fixed" });
  assert.equal(result.usage.calls, 2);
  assert.equal(prompts.length, 2);
  assert.ok(prompts[1]!.startsWith(prompts[0]!));
  assert.ok(prompts[1]!.includes('<previous_reply>\n{"answer": 7}\n</previous_reply>'));
  assert.ok(prompts[1]!.includes("/answer: must be string"));
  assert.ok(prompts[1]!.endsWith("Return ONLY the corrected JSON object."));
});

test("ClaudeCodeProvider fails with invalid_output after second invalid output and sums usage over two calls", async () => {
  const fake = fakeAgentQuery([agentResult("no json here")]);
  const error = await rejectsWith(
    new ClaudeCodeProvider({ model: "m", queryFn: fake.queryFn }).generateStructured(request()),
    "invalid_output",
    true
  );
  assert.equal(fake.calls.length, 2);
  assert.match(error.message, /^Claude Code did not return valid JSON after a retry/);
  assert.deepEqual(error.usage, { inputTokens: 1800, outputTokens: 500, calls: 2, cacheReadInputTokens: 0 });
});

/** A query() that yields init, then waits for the abort controller and throws like the SDK. */
function hangingQuery(): { queryFn: AgentQueryFn; closed: () => boolean } {
  let closed = false;
  const queryFn: AgentQueryFn = ({ options }) =>
    (async function* () {
      try {
        yield INIT;
        await new Promise<void>((resolve) => {
          options.abortController.signal.addEventListener("abort", () => {
            resolve();
          });
        });
        throw Object.assign(new Error("Claude Code process aborted by user"), { name: "AbortError" });
      } finally {
        closed = true;
      }
    })();
  return { queryFn, closed: () => closed };
}

test("ClaudeCodeProvider maps caller abort to aborted and closes the iterator", async () => {
  const hanging = hangingQuery();
  const caller = new AbortController();
  const pending = new ClaudeCodeProvider({ model: "m", queryFn: hanging.queryFn }).generateStructured(
    request({ signal: caller.signal })
  );
  setTimeout(() => {
    caller.abort("cancelled");
  }, 10);
  await rejectsWith(pending, "aborted", false);
  assert.equal(hanging.closed(), true);

  const fake = fakeAgentQuery([agentResult('{"answer":"x"}')]);
  await rejectsWith(
    new ClaudeCodeProvider({ model: "m", queryFn: fake.queryFn }).generateStructured(
      request({ signal: AbortSignal.abort("cancelled") })
    ),
    "aborted",
    false
  );
  assert.equal(fake.calls.length, 0);
});

test("ClaudeCodeProvider maps deadline to network retryable", async () => {
  const hanging = hangingQuery();
  const error = await rejectsWith(
    new ClaudeCodeProvider({ model: "m", queryFn: hanging.queryFn, timeoutMs: 20 }).generateStructured(request()),
    "network",
    true
  );
  assert.match(error.message, /^Claude Code did not finish within/);
  assert.equal(hanging.closed(), true);
});

test("ClaudeCodeProvider classifies an expired login as auth even when the SDK throws after the error result", async () => {
  const expired = fakeAgentQuery([
    { type: "assistant", message: { model: "<synthetic>", content: [] }, error: "authentication_failed" },
    agentResult("Failed to authenticate: OAuth session expired and could not be refreshed", { is_error: true }),
    new Error("Claude Code returned an error result: Failed to authenticate: OAuth session expired")
  ]);
  await rejectsWith(
    new ClaudeCodeProvider({ model: "m", queryFn: expired.queryFn }).generateStructured(request()),
    "auth",
    false
  );
});

test("ClaudeCodeProvider maps typed failures: auth, max turns, missing binary", async () => {
  const auth = fakeAgentQuery([
    { type: "assistant", message: { model: "m", content: [] }, error: "authentication_failed" },
    agentResult("Not logged in", { is_error: true })
  ]);
  const authError = await rejectsWith(
    new ClaudeCodeProvider({ model: "m", queryFn: auth.queryFn }).generateStructured(request()),
    "auth",
    false
  );
  assert.ok(authError.usage);

  const turns = fakeAgentQuery([agentResult("", { subtype: "error_max_turns", is_error: true, errors: [] })]);
  await rejectsWith(
    new ClaudeCodeProvider({ model: "m", queryFn: turns.queryFn }).generateStructured(request()),
    "invalid_output",
    true
  );

  const spawn = fakeAgentQuery([Object.assign(new Error("spawn claude ENOENT"), { code: "ENOENT" })]);
  const spawnError = await rejectsWith(
    new ClaudeCodeProvider({ model: "m", queryFn: spawn.queryFn }).generateStructured(request()),
    "config",
    false
  );
  assert.equal(spawnError.message, "Claude Code is not installed or not on PATH.");
});

test("ClaudeCodeProvider permission callback denies read outside cwd", async () => {
  await withTempDir(async (root) => {
    const repo = path.join(root, "repo");
    await fs.mkdir(path.join(repo, "src"), { recursive: true });
    await fs.writeFile(path.join(repo, "src", "App.tsx"), "export {}");
    await fs.writeFile(path.join(root, "outside.txt"), "secret");
    await fs.symlink(path.join(root, "outside.txt"), path.join(repo, "src", "link.txt"));
    const roots = [repo];

    assert.deepEqual(await ClaudeCodeProvider.evaluateToolUse("Read", { file_path: "src/App.tsx" }, roots), {
      allow: true
    });
    assert.equal(
      (await ClaudeCodeProvider.evaluateToolUse("Read", { file_path: "../outside.txt" }, roots)).allow,
      false
    );
    assert.equal((await ClaudeCodeProvider.evaluateToolUse("Read", { file_path: "/etc/passwd" }, roots)).allow, false);
    // A symlink inside the worktree pointing outside it is resolved with realpath and denied.
    assert.equal((await ClaudeCodeProvider.evaluateToolUse("Read", { file_path: "src/link.txt" }, roots)).allow, false);
    assert.equal((await ClaudeCodeProvider.evaluateToolUse("Glob", { pattern: "../**/*" }, roots)).allow, false);
    assert.equal((await ClaudeCodeProvider.evaluateToolUse("Grep", { pattern: "x", path: "/" }, roots)).allow, false);
    assert.equal(
      (await ClaudeCodeProvider.evaluateToolUse("Grep", { pattern: "useCart", path: "src" }, roots)).allow,
      true
    );
    assert.equal((await ClaudeCodeProvider.evaluateToolUse("Bash", { command: "ls" }, roots)).allow, false);

    // The SDK hooks run the same policy.
    const sdk = ClaudeCodeProvider.buildSdkOptions({ ...sdkInputs(repo), readableRoots: roots });
    const signal = new AbortController().signal;
    const denied = await sdk.canUseTool!("Read", { file_path: "/etc/passwd" }, { signal, toolUseID: "t1" } as never);
    assert.equal(denied?.behavior, "deny");
    const hook = sdk.hooks!.PreToolUse![0]!.hooks[0]!;
    const output = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "../outside.txt" },
        tool_use_id: "t2",
        session_id: "s",
        transcript_path: "/t",
        cwd: repo
      },
      "t2",
      { signal }
    );
    assert.deepEqual(
      (output as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision,
      "deny"
    );
    const allowed = await hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Read",
        tool_input: { file_path: "src/App.tsx" },
        tool_use_id: "t3",
        session_id: "s",
        transcript_path: "/t",
        cwd: repo
      },
      "t3",
      { signal }
    );
    assert.deepEqual(allowed, {});
  });
});

test("ClaudeCodeProvider permission callback denies .env files", async () => {
  await withTempDir(async (repo) => {
    await fs.writeFile(path.join(repo, ".env.local"), "TOKEN=x");
    const roots = [repo];
    for (const file of [
      ".env",
      ".env.local",
      "certs/server.pem",
      "keys/app.key",
      "id_rsa",
      ".git/config",
      "node_modules/a/index.js"
    ]) {
      const decision = await ClaudeCodeProvider.evaluateToolUse("Read", { file_path: file }, roots);
      assert.equal(decision.allow, false, file);
    }
    assert.equal((await ClaudeCodeProvider.evaluateToolUse("Glob", { pattern: "**/.env*" }, roots)).allow, false);
    assert.equal((await ClaudeCodeProvider.evaluateToolUse("Read", { file_path: "src/env.ts" }, roots)).allow, true);
  });
});

test("ClaudeCodeProvider returns config error when the SDK cannot be loaded", async (t) => {
  ClaudeCodeProvider.resetSdkForTesting();
  const restore = patchStaticMethod(ClaudeCodeProvider, "importSdk", () =>
    Promise.reject(new Error("Cannot find package '@anthropic-ai/claude-agent-sdk'"))
  );
  t.after(() => {
    restore();
    ClaudeCodeProvider.resetSdkForTesting();
  });
  const error = await rejectsWith(
    new ClaudeCodeProvider({ model: "claude-opus-5-5" }).generateStructured(request()),
    "config",
    false
  );
  assert.equal(
    error.message,
    "The Claude Code provider is unavailable: @anthropic-ai/claude-agent-sdk could not be loaded. Run npm install in backend/."
  );
  assert.equal(await ClaudeCodeProvider.isSdkAvailable(), false);
});
