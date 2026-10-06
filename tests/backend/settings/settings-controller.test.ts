import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { SettingsService } from "../../../backend/src/services/settings/settings-service";
import { logTestStream } from "../../../backend/src/utilities/loggers/logger";
import { startTestApp, type TestApp } from "../http/app-fixture";
import { patchStaticMethod } from "../helpers/test-context";

// Routes are exercised through the real middleware stack (routes/index.ts registration included); the service is
// replaced on its prototype because the controller constructs it per request.
const proto = SettingsService.prototype;
let testApp: TestApp;

before(async () => {
  testApp = await startTestApp();
});

after(async () => {
  await testApp.close();
});

test("SettingsController.update returns 400 validation_failed for invalid body without calling service", async (t) => {
  let called = false;
  const restore = patchStaticMethod(proto, "update", () => {
    called = true;
    return Promise.resolve({ status: 200, data: {} } as never);
  });
  t.after(restore);
  const response = await fetch(`${testApp.baseUrl}/api/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ githubToken: null, hasGithubToken: true })
  });
  assert.equal(response.status, 400);
  const body = (await response.json()) as { status: number; error: string[]; error_reason: string };
  assert.equal(body.error_reason, "validation_failed");
  assert.ok(Array.isArray(body.error) && body.error.length >= 2);
  assert.equal(called, false);
});

test('SettingsController.get returns 500 { error: "Internal server error", error_reason: "internal_error" } when service throws, and logs the error', async (t) => {
  const restore = patchStaticMethod(proto, "get", () => Promise.reject(new Error("db exploded at /home/someone")));
  t.after(restore);
  const lines: string[] = [];
  const stop = logTestStream.subscribe((line) => lines.push(line));
  let response: Response;
  try {
    response = await fetch(`${testApp.baseUrl}/api/settings`);
  } finally {
    stop();
  }
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    status: 500,
    error: "Internal server error",
    error_reason: "internal_error"
  });
  const logged = lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((event) => event.event === "settings.controller.unhandled");
  assert.equal(logged?.action, "get");
  assert.equal(logged.level, 50);
});

test("SettingsController.testGithub and testAi delegate to the service and return its status unchanged", async (t) => {
  const restoreGithub = patchStaticMethod(proto, "testGithub", () =>
    Promise.resolve({ status: 429, error: "GitHub rate limit reached.", error_reason: "github_rate_limited" } as const)
  );
  const restoreAi = patchStaticMethod(proto, "testAi", () =>
    Promise.resolve({
      status: 200,
      data: { provider: "anthropic_api", model: "claude-opus-5-5", latencyMs: 12 }
    } as const)
  );
  t.after(() => {
    restoreGithub();
    restoreAi();
  });
  // Any body is ignored (not validated) on the test routes.
  const github = await fetch(`${testApp.baseUrl}/api/settings/test-github`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ anything: true })
  });
  assert.equal(github.status, 429);
  assert.deepEqual(await github.json(), {
    status: 429,
    error: "GitHub rate limit reached.",
    error_reason: "github_rate_limited"
  });
  const ai = await fetch(`${testApp.baseUrl}/api/settings/test-ai`, { method: "POST" });
  assert.equal(ai.status, 200);
  assert.deepEqual(await ai.json(), {
    status: 200,
    data: { provider: "anthropic_api", model: "claude-opus-5-5", latencyMs: 12 }
  });
});
