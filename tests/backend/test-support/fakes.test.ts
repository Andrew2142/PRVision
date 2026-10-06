import assert from "node:assert/strict";
import test from "node:test";
import { jobAbortReason } from "../../../backend/src/utilities/services/queue-service";
import { anthropicErrors, anthropicFinalMessage, fakeAnthropicStream } from "../helpers/ai-sdk-fakes";
import { ConsoleRecorder, recordLogger } from "../helpers/console-recorder";
import { createFakeGithubPort, githubHttpError, rawPull } from "../helpers/fake-github-port";
import { FakeQueue, makeJob } from "../helpers/fake-queue";
import { FakeRedis } from "../helpers/fake-redis";
import { createPipelineContext } from "../helpers/pipeline-context";
import { patchMethods, withPatches } from "../helpers/test-context";
import { logger } from "../../../backend/src/utilities/loggers/logger";

test("FakeQueue treats a repeated jobId as a no-op and reports getState", async () => {
  const queue = new FakeQueue();
  const first = await queue.add("visualize", { visualizationId: 3 }, { jobId: "viz-3", attempts: 1 });
  const again = await queue.add("visualize", { visualizationId: 3 }, { jobId: "viz-3" });
  assert.equal(again, first);
  assert.equal(queue.added.length, 1);
  assert.equal(await (await queue.getJob("viz-3"))?.getState(), "waiting");
  first.state = "active";
  assert.equal(await first.getState(), "active");
  await first.remove();
  assert.equal(await queue.getJob("viz-3"), undefined);
  queue.failNextAdd = new Error("redis down");
  await assert.rejects(queue.add("visualize", { visualizationId: 4 }, { jobId: "viz-4" }), { message: "redis down" });
  await queue.add("visualize", { visualizationId: 4 }, { jobId: "viz-4" });
  assert.equal(queue.jobs.size, 1);
});

test('makeJob builds { visualizationId, jobId: "viz-<id>", signal } and cancel/shutdown abort with the string reasons', () => {
  const cancelled = makeJob(12);
  assert.equal(cancelled.job.visualizationId, 12);
  assert.equal(cancelled.job.jobId, "viz-12");
  assert.equal(cancelled.job.signal.aborted, false);
  assert.equal(jobAbortReason(cancelled.job.signal), null);
  cancelled.cancel();
  assert.equal(cancelled.job.signal.reason, "cancelled");
  assert.equal(jobAbortReason(cancelled.job.signal), "cancelled");

  const stopped = makeJob(13);
  stopped.shutdown();
  assert.equal(jobAbortReason(stopped.job.signal), "shutdown");
});

test("FakeRedis expires keys by TTL with the injected clock", async () => {
  const redis = new FakeRedis();
  let now = Date.parse("2026-01-01T00:00:00Z");
  redis.now = () => now;
  await redis.set("prvision:cancel:1", "1", "EX", 86_400);
  await redis.set("plain", "v");
  assert.equal(await redis.exists("prvision:cancel:1"), 1);
  assert.equal(await redis.ttl("prvision:cancel:1"), 86_400);
  assert.equal(await redis.ttl("plain"), -1);
  assert.equal(await redis.ttl("missing"), -2);
  now += 86_399_000;
  assert.equal(await redis.get("prvision:cancel:1"), "1");
  now += 1_000;
  assert.equal(await redis.get("prvision:cancel:1"), null);
  assert.equal(await redis.exists("prvision:cancel:1"), 0);
  assert.equal(await redis.del("plain", "missing"), 1);
  assert.deepEqual(
    redis.commands.map((c) => c.name),
    ["set", "set", "exists", "get", "get", "exists", "del"]
  );
});

test("createFakeGithubPort pages listPulls and throws scripted errors once", async () => {
  const pulls = Array.from({ length: 5 }, (_, i) => rawPull({ number: i + 1 }));
  const rateLimited = githubHttpError(429, "rate limited", { "retry-after": "30" });
  const { port, calls } = createFakeGithubPort({ login: "ada", pulls, errors: { listPulls: [rateLimited] } });
  const signal = new AbortController().signal;
  const params = { owner: "acme", repo: "web", page: 1, perPage: 2, signal };
  await assert.rejects(port.listPulls(params), (error: unknown) => error === rateLimited);
  assert.deepEqual(
    (await port.listPulls(params)).map((p) => p.number),
    [1, 2]
  );
  assert.deepEqual(
    (await port.listPulls({ ...params, page: 3 })).map((p) => p.number),
    [5]
  );
  assert.deepEqual(await port.getAuthenticatedUser(signal), { login: "ada" });
  await assert.rejects(port.getPull({ owner: "acme", repo: "web", pullNumber: 9, signal }), { status: 404 });
  assert.deepEqual(
    calls.map((c) => c.method),
    ["listPulls", "listPulls", "listPulls", "getAuthenticatedUser", "getPull"]
  );
});

test("fakeAnthropicStream records params and signal", async () => {
  const controller = new AbortController();
  const { streamFn, calls } = fakeAnthropicStream([anthropicFinalMessage({ ok: true }), anthropicErrors.rateLimit()]);
  const params = { model: "claude-opus-5-5", max_tokens: 10, messages: [] } as unknown as Parameters<
    typeof streamFn
  >[0];
  const message = (await streamFn(params, { signal: controller.signal }).finalMessage()) as unknown as {
    content: Array<{ text: string }>;
  };
  assert.equal(message.content[0]?.text, '{"ok":true}');
  await assert.rejects(streamFn(params, { signal: controller.signal }).finalMessage(), { status: 429 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.params, params);
  assert.equal(calls[0].signal, controller.signal);
});

test('ConsoleRecorder.assertStagesAreStatusNames rejects "render:Button"', async () => {
  const recorder = new ConsoleRecorder();
  await recorder.info("rendering", "Rendering Button");
  recorder.assertStagesAreStatusNames();
  await recorder.warn("render:Button", "bad stage");
  assert.throws(() => {
    recorder.assertStagesAreStatusNames();
  }, /render:Button/);
  assert.equal(recorder.has("warn", "bad"), true);
  assert.deepEqual(recorder.stages(), ["rendering", "render:Button"]);
  await recorder.error("rendering", "token ghp_TEST0000000000000000000000000000000000 leaked");
  assert.throws(() => {
    recorder.assertNoSecrets(["ghp_TEST0000000000000000000000000000000000"]);
  }, /Secret leaked/);
  assert.throws(() => {
    recorder.assertNoErrors();
  }, /Unexpected console errors/);
});

test("recordLogger captures root and child logger lines until restored", (t) => {
  const recorded = recordLogger();
  t.after(recorded.restore);
  logger.child({ module: "self-test" }).info({ event: "test.logger.recorded" }, "Recorded line");
  recorded.restore();
  logger.info({ event: "test.logger.ignored" }, "Not recorded");
  assert.equal(recorded.lines.length, 1);
  assert.equal(recorded.lines[0]?.event, "test.logger.recorded");
  assert.equal(recorded.lines[0].module, "self-test");
});

test('createPipelineContext cancel() aborts with "cancelled" and makes isCancelled() true', async () => {
  const handle = createPipelineContext({ dataDir: "/tmp/data", repositoryPath: "/tmp/repo", visualizationId: 5 });
  assert.equal(handle.context.workspace.baseDir, "/tmp/data/worktrees/5/base");
  assert.equal(handle.context.workspace.headDir, "/tmp/data/worktrees/5/head");
  assert.equal(handle.context.console, handle.console);
  assert.equal(handle.context.ai, handle.ai);
  assert.equal(await handle.context.isCancelled(), false);
  handle.cancel();
  assert.equal(await handle.context.isCancelled(), true);
  assert.equal(handle.context.signal.reason, "cancelled");
  assert.equal(jobAbortReason(handle.context.signal), "cancelled");

  const stopped = createPipelineContext({ dataDir: "/tmp/data", repositoryPath: "/tmp/repo" });
  stopped.shutdown();
  assert.equal(stopped.context.signal.reason, "shutdown");
  assert.equal(await stopped.context.isCancelled(), false);
});

test("patchMethods patches several members and withPatches restores them even when fn throws", async () => {
  const target = { a: (): string => "a", b: (): string => "b" };
  const restore = patchMethods(target, { a: () => "A", b: () => "B" });
  assert.equal(target.a() + target.b(), "AB");
  await assert.rejects(
    withPatches([restore], () => {
      throw new Error("boom");
    }),
    { message: "boom" }
  );
  assert.equal(target.a() + target.b(), "ab");
});
