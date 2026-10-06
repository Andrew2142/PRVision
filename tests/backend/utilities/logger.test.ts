import assert from "node:assert/strict";
import test from "node:test";
import { PRVISION_SECRET_KEY } from "../../../backend/src/config-consts";
import { createLogger, logTestStream, logger, redactSecrets } from "../../../backend/src/utilities/loggers/logger";

/** Records every JSON log line while fn runs, with the root level at debug. */
async function recordLines(fn: () => void | Promise<void>): Promise<Array<Record<string, unknown>>> {
  const lines: Array<Record<string, unknown>> = [];
  const previousLevel = logger.level;
  logger.level = "debug";
  const unsubscribe = logTestStream.subscribe((line) => lines.push(JSON.parse(line) as Record<string, unknown>));
  try {
    await fn();
  } finally {
    unsubscribe();
    logger.level = previousLevel;
  }
  return lines;
}

const GITHUB_TOKEN = `ghp_${"a".repeat(36)}`;
const FINE_GRAINED = `github_pat_${"B".repeat(30)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${"c".repeat(20)}`;

test("redactSecrets masks ghp_, github_pat_, sk-ant- tokens, Authorization headers and URL credentials", () => {
  const text = [
    `token ${GITHUB_TOKEN}`,
    `pat ${FINE_GRAINED}`,
    `key ${ANTHROPIC_KEY}`,
    "AUTHORIZATION: basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0",
    "Authorization: Bearer abc.def",
    "postgres://prvision:hunter2@127.0.0.1:5434/prvision",
    "https://x-access-token:s3cr3t@github.com/o/r.git",
    '{"x-api-key": "k-123"}'
  ].join("\n");
  const redacted = redactSecrets(text);
  for (const secret of [
    GITHUB_TOKEN,
    FINE_GRAINED,
    ANTHROPIC_KEY,
    "eC1hY2Nlc3MtdG9rZW46c2VjcmV0",
    "abc.def",
    "hunter2",
    "s3cr3t",
    "k-123"
  ]) {
    assert.ok(!redacted.includes(secret), `${secret} must be redacted`);
  }
  assert.match(redacted, /\[REDACTED_GITHUB_TOKEN\]/);
  assert.match(redacted, /\[REDACTED_ANTHROPIC_KEY\]/);
  assert.match(redacted, /postgres:\/\/\[REDACTED\]@127\.0\.0\.1/);
});

test("redactSecrets leaves ordinary text untouched", () => {
  const text = "git fetch failed: could not resolve host github.com (src/App.tsx line 4) https://github.com/o/r";
  assert.equal(redactSecrets(text), text);
});

test("redactSecrets removes the literal PRVISION_SECRET_KEY value", () => {
  assert.ok(PRVISION_SECRET_KEY.length >= 16);
  assert.equal(redactSecrets(`key=${PRVISION_SECRET_KEY};`), "key=[REDACTED];");
});

test("logger redacts configured paths", async () => {
  const lines = await recordLines(() => {
    createLogger("logger-test").info(
      { event: "test.redact", token: GITHUB_TOKEN, nested: { apiKey: "x" }, env: { PATH: "/bin" } },
      "redaction"
    );
  });
  const line = lines.find((entry) => entry.event === "test.redact");
  assert.ok(line);
  assert.equal(line.token, "[REDACTED]");
  assert.deepEqual(line.nested, { apiKey: "[REDACTED]" });
  assert.equal(line.env, "[REDACTED]");
  assert.equal(line.module, "logger-test");
});

test("err serializer drops request/response objects and redacts message/stack/stderr", async () => {
  const error = Object.assign(new Error(`request failed with ${GITHUB_TOKEN}`), {
    request: { headers: { authorization: "token abc" } },
    response: { status: 401 },
    stderr: `fatal: Authentication failed for https://x-access-token:${GITHUB_TOKEN}@github.com/`
  });
  const lines = await recordLines(() => {
    createLogger("logger-test").error({ event: "test.err", err: error }, "failure");
  });
  const err = lines.find((entry) => entry.event === "test.err")?.err as Record<string, unknown>;
  assert.ok(err);
  assert.equal(err.request, undefined);
  assert.equal(err.response, undefined);
  for (const key of ["message", "stack", "stderr"]) {
    assert.ok(!String(err[key]).includes(GITHUB_TOKEN), `${key} must be redacted`);
  }
});

test("err serializer logs a string abort reason unchanged and does not throw", async () => {
  const lines = await recordLines(() => {
    createLogger("logger-test").warn({ event: "test.abort", err: "cancelled" }, "aborted");
  });
  assert.equal(lines.find((entry) => entry.event === "test.abort")?.err, "cancelled");
});

test("logTestStream receives JSON lines from child loggers and unsubscribe stops delivery", async () => {
  const lines = await recordLines(() => {
    createLogger("child-a", { visualizationId: 7 })
      .child({ stage: "rendering" })
      .debug({ event: "test.child" }, "child");
  });
  const line = lines.find((entry) => entry.event === "test.child");
  assert.equal(line?.visualizationId, 7);
  assert.equal(line.stage, "rendering");

  const after: string[] = [];
  const unsubscribe = logTestStream.subscribe((entry) => after.push(entry));
  unsubscribe();
  createLogger("child-a").error({ event: "test.after" }, "after unsubscribe");
  assert.deepEqual(after, []);
});
