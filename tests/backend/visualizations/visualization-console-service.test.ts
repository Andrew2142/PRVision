import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_MESSAGE_MAX_LENGTH } from "../../../backend/src/config-consts";
import { Table } from "../../../backend/src/enums";
import {
  sanitizeConsoleMessage,
  VisualizationConsoleService
} from "../../../backend/src/services/visualizations/visualization-console-service";
import { recordLogger } from "../helpers/console-recorder";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";

test("VisualizationConsoleService append writes level, stage and message, and never throws when the insert fails", async (t) => {
  const qh = new InMemoryQueryHandler();
  const consoleSvc = new VisualizationConsoleService(7, qh);
  await consoleSvc.info("preparing", "one");
  await consoleSvc.warn("analyzing", "two");
  await consoleSvc.error("failed", "three");
  assert.deepEqual(
    qh.rows(Table.VISUALIZATION_CONSOLE_EVENTS).map((r) => [r.visualizationId, r.level, r.stage, r.message]),
    [
      [7, "info", "preparing", "one"],
      [7, "warn", "analyzing", "two"],
      [7, "error", "failed", "three"]
    ]
  );

  const logs = recordLogger();
  t.after(logs.restore);
  qh.failNext("insert");
  await consoleSvc.info("rendering", "db returns 500");
  const throwing = new VisualizationConsoleService(7, { insert: () => Promise.reject(new Error("db down")) });
  await throwing.error("rendering", "db throws");
  const events = logs.lines.map((line) => line.event);
  assert.equal(events.filter((e) => e === "visualization.console.insert_failed").length, 2);
  assert.ok(events.includes("visualization.console.event"), "every event is mirrored to the log");

  const pipelineConsole = consoleSvc.asPipelineConsole();
  await pipelineConsole.info("diffing", "via adapter");
  assert.equal(qh.rows(Table.VISUALIZATION_CONSOLE_EVENTS).at(-1)?.message, "via adapter");
});

test("VisualizationConsoleService messages are redacted (ghp_, github_pat_, sk-ant-, Authorization headers, URL credentials)", async () => {
  const qh = new InMemoryQueryHandler();
  const consoleSvc = new VisualizationConsoleService(1, qh);
  const secrets = [
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
    "sk-ant-api03-abcdefghijklmnop",
    "c2VjcmV0LXRva2VuLXZhbHVl",
    "hunter2pass"
  ];
  await consoleSvc.warn(
    "preparing",
    `fetch failed: token ${secrets[0]} and ${secrets[1]}, key ${secrets[2]}, ` +
      `AUTHORIZATION: basic ${secrets[3]} from https://user:${secrets[4]}@github.com/o/r.git`
  );
  const message = String(qh.rows(Table.VISUALIZATION_CONSOLE_EVENTS)[0]?.message);
  for (const secret of secrets) {
    assert.equal(message.includes(secret), false, `leaked ${secret.slice(0, 8)}…`);
  }
  assert.match(message, /\[REDACTED/);
});

test("VisualizationConsoleService ANSI and control characters are stripped; messages are capped at 4000 characters and stages at 64", async () => {
  assert.equal(sanitizeConsoleMessage("\u001b[31mred\u001b[0m\u0007 ok\tline\nnext\u0000"), "red ok\tline\nnext");
  const long = sanitizeConsoleMessage("x".repeat(CONSOLE_MESSAGE_MAX_LENGTH + 50));
  assert.equal(long.length, CONSOLE_MESSAGE_MAX_LENGTH);
  assert.ok(long.endsWith("…"));
  assert.equal(sanitizeConsoleMessage("y".repeat(CONSOLE_MESSAGE_MAX_LENGTH)).length, CONSOLE_MESSAGE_MAX_LENGTH);

  const qh = new InMemoryQueryHandler();
  await new VisualizationConsoleService(1, qh).info("s".repeat(100), "m");
  assert.equal(String(qh.rows(Table.VISUALIZATION_CONSOLE_EVENTS)[0]?.stage).length, 64);
});
