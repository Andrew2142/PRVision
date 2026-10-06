import assert from "node:assert/strict";
import test from "node:test";
import { SettingsUpdateDTO } from "../../../backend/src/dtos/settings/settings-update.dto";
import { AppSettingModel } from "../../../backend/src/models/app-setting-model";
import {
  SettingsService,
  type SettingsServiceDependencies
} from "../../../backend/src/services/settings/settings-service";
import {
  SettingsStore,
  type AppSettingsPatch,
  type GithubTokenSnapshot,
  type ResolvedAiSettings
} from "../../../backend/src/services/settings/settings-store";
import type { AiProviderError, AiStructuredRequest } from "../../../backend/src/types/visualization-pipeline";
import { logTestStream } from "../../../backend/src/utilities/loggers/logger";
import { AnthropicStatusError } from "../../../backend/src/utilities/services/ai/anthropic-api-provider";
import { ScriptedAiProvider } from "../helpers/ai-provider-stub";
import { runWithAuthContext } from "../helpers/test-context";

const GITHUB_TOKEN = `github_pat_${"Q7".repeat(20)}`;
const API_KEY = `sk-ant-api03-${"s".repeat(40)}`;
const NONCE = "prv-0a1b2c";

/** In-memory SettingsStore: one row, patches merged into it, CAS result configurable. */
class FakeStore {
  values: Record<string, unknown> = {
    id: 1,
    aiProvider: "anthropic_api",
    aiModel: "claude-opus-5-5",
    aiHarnessEffort: "high",
    aiSummaryEffort: "medium",
    githubTokenEncrypted: null,
    githubLogin: null,
    anthropicApiKeyEncrypted: null
  };
  patches: AppSettingsPatch[] = [];
  loginWrites: Array<[string, string]> = [];
  casResult = true;
  aiSettings: ResolvedAiSettings = {
    provider: "anthropic_api",
    model: "claude-opus-5-5",
    harnessEffort: "high",
    summaryEffort: "medium",
    anthropicApiKey: { state: "present", value: API_KEY }
  };
  snapshot: GithubTokenSnapshot = { secret: { state: "absent" }, storedCiphertext: null };

  getOrCreate(): Promise<AppSettingModel> {
    return Promise.resolve(new AppSettingModel(this.values));
  }
  patch(patch: AppSettingsPatch): Promise<AppSettingModel> {
    this.patches.push(patch);
    this.values = { ...this.values, ...patch };
    return this.getOrCreate();
  }
  readGithubTokenSnapshot(): Promise<GithubTokenSnapshot> {
    return Promise.resolve(this.snapshot);
  }
  setGithubLoginIfTokenUnchanged(ciphertext: string, login: string): Promise<boolean> {
    if (this.casResult) {
      this.loginWrites.push([ciphertext, login]);
    }
    return Promise.resolve(this.casResult);
  }
  readAiSettings(): Promise<ResolvedAiSettings> {
    return Promise.resolve(this.aiSettings);
  }
}

function serviceWith(store: FakeStore, deps: Partial<SettingsServiceDependencies> = {}): SettingsService {
  return new SettingsService(store as unknown as SettingsStore, { nonce: () => NONCE, ...deps });
}

function dto(values: Partial<SettingsUpdateDTO>): SettingsUpdateDTO {
  return Object.assign(new SettingsUpdateDTO(), values);
}

function storedToken(): FakeStore {
  const store = new FakeStore();
  const ciphertext = SettingsStore.encryptSecret(GITHUB_TOKEN);
  store.values.githubTokenEncrypted = ciphertext;
  store.snapshot = { secret: { state: "present", value: GITHUB_TOKEN }, storedCiphertext: ciphertext };
  return store;
}

const aborted = (): AbortSignal => AbortSignal.abort(new DOMException("timeout", "TimeoutError"));
const neverAborted = (): AbortSignal => new AbortController().signal;

async function captureLogs<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const stop = logTestStream.subscribe((line) => lines.push(line));
  try {
    return { result: await fn(), lines };
  } finally {
    stop();
  }
}

// ---- get / update ----

test("SettingsService.get returns SettingsView without secrets", async () => {
  const store = storedToken();
  store.values.githubLogin = "octo";
  store.values.anthropicApiKeyEncrypted = SettingsStore.encryptSecret(API_KEY);
  const response = await runWithAuthContext(() => serviceWith(store).get());
  assert.deepEqual(response, {
    status: 200,
    data: {
      hasGithubToken: true,
      githubLogin: "octo",
      aiProvider: "anthropic_api",
      hasAnthropicApiKey: true,
      aiModel: "claude-opus-5-5",
      aiHarnessEffort: "high",
      aiSummaryEffort: "medium"
    }
  });
  const body = JSON.stringify(response);
  assert.ok(!body.includes(GITHUB_TOKEN) && !body.includes(API_KEY) && !body.includes("enc:v1:"));
});

test("SettingsService.update with empty dto does not write", async () => {
  const store = new FakeStore();
  const response = await runWithAuthContext(() => serviceWith(store).update(dto({})));
  assert.equal(response.status, 200);
  assert.equal(store.patches.length, 0);
  assert.equal(response.data?.hasGithubToken, false);
});

test("SettingsService.update encrypts a new github token and resets githubLogin", async () => {
  const store = new FakeStore();
  store.values.githubLogin = "old-login";
  const response = await runWithAuthContext(() => serviceWith(store).update(dto({ githubToken: GITHUB_TOKEN })));
  assert.equal(store.patches.length, 1);
  const patch = store.patches[0]!;
  assert.equal(patch.githubLogin, null);
  assert.ok(patch.githubTokenEncrypted?.startsWith("enc:v1:"));
  assert.deepEqual(SettingsStore.readSecret(patch.githubTokenEncrypted, "github_token"), {
    state: "present",
    value: GITHUB_TOKEN
  });
  assert.equal(response.data?.hasGithubToken, true);
  assert.equal(response.data.githubLogin, null);
});

test('SettingsService.update with githubToken "" clears token and login', async () => {
  const store = storedToken();
  store.values.githubLogin = "octo";
  const response = await runWithAuthContext(() => serviceWith(store).update(dto({ githubToken: "" })));
  assert.deepEqual(store.patches, [{ githubTokenEncrypted: null, githubLogin: null }]);
  assert.equal(response.data?.hasGithubToken, false);
  assert.equal(response.data.githubLogin, null);
});

test('SettingsService.update with anthropicApiKey "" clears the key', async () => {
  const store = new FakeStore();
  store.values.anthropicApiKeyEncrypted = SettingsStore.encryptSecret(API_KEY);
  const response = await runWithAuthContext(() =>
    serviceWith(store).update(dto({ anthropicApiKey: "", aiModel: "claude-sonnet-5-5" }))
  );
  assert.deepEqual(store.patches, [{ anthropicApiKeyEncrypted: null, aiModel: "claude-sonnet-5-5" }]);
  assert.equal(response.data?.hasAnthropicApiKey, false);
  assert.equal(response.data.aiModel, "claude-sonnet-5-5");
});

test("SettingsService.update logs field names but never values", async () => {
  const store = new FakeStore();
  const { lines } = await captureLogs(() =>
    runWithAuthContext(() =>
      serviceWith(store).update(
        dto({ githubToken: GITHUB_TOKEN, anthropicApiKey: API_KEY, aiProvider: "anthropic_api" })
      )
    )
  );
  const updated = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((e) => e.event === "settings.updated");
  assert.deepEqual(updated?.fields, ["githubToken(set)", "anthropicApiKey(set)", "aiProvider"]);
  const all = lines.join("\n");
  assert.ok(!all.includes(GITHUB_TOKEN));
  assert.ok(!all.includes(API_KEY));
  assert.ok(!all.includes("enc:v1:"));
});

// ---- testGithub ----

test("SettingsService.testGithub returns 400 github_token_missing when absent", async () => {
  let called = false;
  const service = serviceWith(new FakeStore(), {
    verifyGithubToken: () => {
      called = true;
      return Promise.resolve({ ok: true, login: "x" });
    }
  });
  assert.deepEqual(await runWithAuthContext(() => service.testGithub()), {
    status: 400,
    error: "Add a GitHub token first.",
    error_reason: "github_token_missing"
  });
  assert.equal(called, false);
});

test("SettingsService.testGithub returns 400 github_token_missing when unreadable", async () => {
  const store = new FakeStore();
  store.snapshot = { secret: { state: "unreadable" }, storedCiphertext: "enc:v1:broken" };
  const response = await runWithAuthContext(() => serviceWith(store).testGithub());
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "github_token_missing");
  assert.match(String(response.error), /can no longer be decrypted \(PRVISION_SECRET_KEY changed\)/);
});

test('SettingsService.testGithub persists login on success and returns { login: "octo" }', async () => {
  const store = storedToken();
  const seen: Array<{ token: string; signal: AbortSignal | undefined }> = [];
  const service = serviceWith(store, {
    verifyGithubToken: (token, options) => {
      seen.push({ token, signal: options?.signal });
      return Promise.resolve({ ok: true, login: "octo" });
    }
  });
  const response = await runWithAuthContext(() => service.testGithub());
  assert.deepEqual(response, { status: 200, data: { login: "octo" } });
  assert.equal(seen[0]?.token, GITHUB_TOKEN);
  assert.ok(seen[0].signal instanceof AbortSignal);
  assert.deepEqual(store.loginWrites, [[store.snapshot.storedCiphertext, "octo"]]);
});

test("SettingsService.testGithub does not persist login when the token changed during the check", async () => {
  const store = storedToken();
  store.casResult = false;
  const service = serviceWith(store, { verifyGithubToken: () => Promise.resolve({ ok: true, login: "octo" }) });
  const { result, lines } = await captureLogs(() => runWithAuthContext(() => service.testGithub()));
  assert.deepEqual(result, { status: 200, data: { login: "octo" } });
  assert.equal(store.loginWrites.length, 0);
  assert.ok(lines.some((line) => line.includes("settings.test_github.token_changed")));
});

test("SettingsService.testGithub maps unauthorized to 400 github_unauthorized", async () => {
  const service = serviceWith(storedToken(), {
    timeoutSignal: neverAborted,
    verifyGithubToken: () =>
      Promise.resolve({ ok: false, reason: "unauthorized", status: 401, message: "Bad credentials" })
  });
  const response = await runWithAuthContext(() => service.testGithub());
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "github_unauthorized");
  assert.match(String(response.error), /^GitHub rejected the token/);
});

test("SettingsService.testGithub maps rate_limited to 429 github_rate_limited", async () => {
  const service = serviceWith(storedToken(), {
    timeoutSignal: neverAborted,
    verifyGithubToken: () => Promise.resolve({ ok: false, reason: "rate_limited", status: 403, message: "limit" })
  });
  assert.deepEqual(await runWithAuthContext(() => service.testGithub()), {
    status: 429,
    error: "GitHub rate limit reached. Try again in a few minutes.",
    error_reason: "github_rate_limited"
  });
});

test("SettingsService.testGithub maps network to 502 github_unavailable", async () => {
  const service = serviceWith(storedToken(), {
    timeoutSignal: neverAborted,
    verifyGithubToken: () => Promise.resolve({ ok: false, reason: "network", status: null, message: "ECONNRESET" })
  });
  assert.deepEqual(await runWithAuthContext(() => service.testGithub()), {
    status: 502,
    error: "Could not reach GitHub. Check your network connection.",
    error_reason: "github_unavailable"
  });
});

test("SettingsService.testGithub maps its own timeout to 504 internal_error", async () => {
  const service = serviceWith(storedToken(), {
    timeoutSignal: aborted,
    verifyGithubToken: () => Promise.resolve({ ok: false, reason: "network", status: null, message: "aborted" })
  });
  assert.deepEqual(await runWithAuthContext(() => service.testGithub()), {
    status: 504,
    error: "GitHub did not answer within 15 s.",
    error_reason: "internal_error"
  });
});

// ---- testAi ----

function aiService(
  provider: ScriptedAiProvider | null,
  store = new FakeStore(),
  deps: Partial<SettingsServiceDependencies> = {}
): SettingsService {
  return serviceWith(store, {
    timeoutSignal: neverAborted,
    ...(provider ? { createProvider: () => provider } : {}),
    ...deps
  });
}

test("SettingsService.testAi returns 400 ai_not_configured when key absent", async () => {
  const store = new FakeStore();
  store.aiSettings = { ...store.aiSettings, anthropicApiKey: { state: "absent" } };
  // Default createProvider: the real factory raises the config error.
  assert.deepEqual(await runWithAuthContext(() => aiService(null, store).testAi()), {
    status: 400,
    error: "Add an Anthropic API key in Settings.",
    error_reason: "ai_not_configured"
  });
});

test("SettingsService.testAi returns 400 ai_not_configured for the legacy claude_code provider", async () => {
  const store = new FakeStore();
  store.aiSettings = { ...store.aiSettings, provider: "claude_code" };
  // Default createProvider: the real factory refuses the legacy provider even though a key is stored.
  const response = await runWithAuthContext(() => aiService(null, store).testAi());
  assert.deepEqual(response, {
    status: 400,
    error: "The Claude Code provider is no longer available. Add an Anthropic API key in Settings and save.",
    error_reason: "ai_not_configured"
  });
});

test("SettingsService.testAi returns 200 { provider, model, latencyMs } when provider echoes nonce", async () => {
  const provider = new ScriptedAiProvider({
    connection_test: [{ kind: "data", data: { ok: true, echo: NONCE }, model: "claude-opus-5" }]
  });
  const clock = [1000, 1234.4];
  const response = await runWithAuthContext(() =>
    aiService(provider, new FakeStore(), { now: () => clock.shift() ?? 0 }).testAi()
  );
  assert.deepEqual(response, {
    status: 200,
    data: { provider: "anthropic_api", model: "claude-opus-5", latencyMs: 234 }
  });
  const request = provider.callsFor("connection_test")[0] as AiStructuredRequest;
  assert.equal(request.effort, "low");
  assert.ok(request.prompt.includes(NONCE));
  assert.ok(request.signal instanceof AbortSignal);
});

test("SettingsService.testAi returns 502 internal_error when echo mismatches", async () => {
  const provider = new ScriptedAiProvider({ connection_test: [{ kind: "data", data: { ok: true, echo: "prv-zzz" } }] });
  assert.deepEqual(await runWithAuthContext(() => aiService(provider).testAi()), {
    status: 502,
    error: "The AI answered but not with the expected check value. Try again.",
    error_reason: "internal_error"
  });
});

test("SettingsService.testAi maps auth to 400 ai_unauthorized", async () => {
  const thrower = (error: AiProviderError) => ({
    kind: "anthropic_api" as const,
    generateStructured: () => Promise.reject(error)
  });
  const key401 = await runWithAuthContext(() =>
    serviceWith(new FakeStore(), {
      timeoutSignal: neverAborted,
      createProvider: () =>
        thrower(new AnthropicStatusError("Anthropic rejected the API key (401).", "auth", false, 401))
    }).testAi()
  );
  assert.deepEqual(key401, {
    status: 400,
    error: "Anthropic rejected the API key. Check that it is active and copied correctly.",
    error_reason: "ai_unauthorized"
  });
  const model403 = await runWithAuthContext(() =>
    serviceWith(new FakeStore(), {
      timeoutSignal: neverAborted,
      createProvider: () => thrower(new AnthropicStatusError("no access (403).", "auth", false, 403))
    }).testAi()
  );
  assert.equal(model403.error, 'The API key is not allowed to use model "claude-opus-5-5".');
  assert.equal(model403.error_reason, "ai_unauthorized");
});

test("SettingsService.testAi maps aborted with its own timeout fired to 504 internal_error", async () => {
  const provider = new ScriptedAiProvider({ connection_test: [{ kind: "hang" }] });
  const controller = new AbortController();
  const response = await runWithAuthContext(() =>
    aiService(provider, new FakeStore(), {
      timeoutSignal: () => {
        setTimeout(() => {
          controller.abort(new DOMException("timeout", "TimeoutError"));
        }, 5);
        return controller.signal;
      }
    }).testAi()
  );
  assert.deepEqual(response, {
    status: 504,
    error: "The AI provider did not answer within 60 s.",
    error_reason: "internal_error"
  });

  // An abort that is not the test's own timeout is a cancelled request (502).
  const cancelled = new ScriptedAiProvider({ connection_test: [{ kind: "error", reason: "aborted" }] });
  const other = await runWithAuthContext(() => aiService(cancelled).testAi());
  assert.deepEqual(other, {
    status: 502,
    error: "The AI request was cancelled. Try again.",
    error_reason: "internal_error"
  });
});

test("SettingsService.testAi maps network to 502 internal_error", async () => {
  const provider = new ScriptedAiProvider({ connection_test: [{ kind: "error", reason: "network" }] });
  assert.deepEqual(await runWithAuthContext(() => aiService(provider).testAi()), {
    status: 502,
    error: "Could not reach the AI provider. Check your network connection.",
    error_reason: "internal_error"
  });
});

test("SettingsService.testAi maps rate_limit to 502 internal_error", async () => {
  const provider = new ScriptedAiProvider({ connection_test: [{ kind: "error", reason: "rate_limit" }] });
  assert.deepEqual(await runWithAuthContext(() => aiService(provider).testAi()), {
    status: 502,
    error: "The AI provider is rate limited or overloaded. Try again shortly.",
    error_reason: "internal_error"
  });
});

test("SettingsService.testAi maps refusal to 502 internal_error with the provider message", async () => {
  const provider = new ScriptedAiProvider({
    connection_test: [
      { kind: "error", reason: "refusal", message: "The model declined the request (category: cyber)." }
    ]
  });
  assert.deepEqual(await runWithAuthContext(() => aiService(provider).testAi()), {
    status: 502,
    error: "The model declined the request (category: cyber). Try again.",
    error_reason: "internal_error"
  });
});

test("SettingsService.testAi error messages are redacted and capped at 300 chars", async () => {
  const leaky = `Request rejected (400): key ${API_KEY} ${"x".repeat(600)}`;
  const provider = new ScriptedAiProvider({ connection_test: [{ kind: "error", reason: "config", message: leaky }] });
  const response = await runWithAuthContext(() => aiService(provider).testAi());
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "ai_not_configured");
  const message = String(response.error);
  assert.ok(message.startsWith('The AI provider rejected the request for model "claude-opus-5-5": Request rejected'));
  assert.ok(!message.includes(API_KEY));
  assert.ok(message.includes("[REDACTED_ANTHROPIC_KEY]"));
  assert.ok(message.length <= 300);
});

test("SettingsService.testAi rethrows non-provider errors", async () => {
  const service = serviceWith(new FakeStore(), {
    timeoutSignal: neverAborted,
    createProvider: () => ({ kind: "anthropic_api", generateStructured: () => Promise.reject(new Error("bug")) })
  });
  await assert.rejects(
    runWithAuthContext(() => service.testAi()),
    /bug/
  );
});

test("SettingsService never logs the token or key across PUT, test-github and test-ai", async () => {
  const store = new FakeStore();
  const service = serviceWith(store, {
    timeoutSignal: neverAborted,
    verifyGithubToken: () =>
      Promise.resolve({ ok: false, reason: "unauthorized", status: 401, message: `bad token ${GITHUB_TOKEN}` }),
    createProvider: () =>
      new ScriptedAiProvider({
        connection_test: [{ kind: "error", reason: "config", message: `Request rejected (400): ${API_KEY}` }]
      })
  });
  const { lines } = await captureLogs(() =>
    runWithAuthContext(async () => {
      await service.update(dto({ githubToken: GITHUB_TOKEN, anthropicApiKey: API_KEY }));
      store.snapshot = {
        secret: { state: "present", value: GITHUB_TOKEN },
        storedCiphertext: String(store.values.githubTokenEncrypted)
      };
      await service.testGithub();
      await service.testAi();
    })
  );
  const all = lines.join("\n");
  assert.ok(lines.some((line) => line.includes("settings.test_github.result")));
  assert.ok(lines.some((line) => line.includes("settings.test_ai.result")));
  assert.ok(!all.includes(GITHUB_TOKEN));
  assert.ok(!all.includes(API_KEY));
});
