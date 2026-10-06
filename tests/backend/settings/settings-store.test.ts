import assert from "node:assert/strict";
import test from "node:test";
import { AppSettingModel } from "../../../backend/src/models/app-setting-model";
import { SECRET_PREFIX, SettingsStore } from "../../../backend/src/services/settings/settings-store";
import { logTestStream } from "../../../backend/src/utilities/loggers/logger";
import { Encryption } from "../../../backend/src/utilities/processors/encryption";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import type { Database } from "../../../backend/src/utilities/services/drizzle-db";

const TOKEN = `github_pat_${"Z9".repeat(20)}`;

function settingsRow(overrides: Record<string, unknown> = {}): AppSettingModel {
  return new AppSettingModel({
    id: 1,
    aiProvider: "anthropic_api",
    aiModel: "claude-opus-5-5",
    aiHarnessEffort: "high",
    aiSummaryEffort: "medium",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
  });
}

interface Recorded {
  selects: unknown[];
  updates: Array<{ values: unknown; conditions: unknown }>;
  inserts: Array<{ values: Record<string, unknown>; conflict: "nothing" | "update"; set?: Record<string, unknown> }>;
}

/** SettingsStore with a scripted QueryHandler (validateAndSelect results in order) and a recording Drizzle fake. */
function storeWith(
  selectResults: Array<AppSettingModel | null>,
  updateStatus = 200
): { store: SettingsStore; rec: Recorded } {
  const rec: Recorded = { selects: [], updates: [], inserts: [] };
  const queryHandler = {
    validateAndSelect: (_model: unknown, conditions: unknown) => {
      rec.selects.push(conditions);
      return Promise.resolve(selectResults.shift() ?? null);
    },
    update: (values: unknown, conditions: unknown) => {
      rec.updates.push({ values, conditions });
      return Promise.resolve(
        updateStatus === 200
          ? { status: 200, data: { rowsAffected: 1 } }
          : { status: updateStatus, error: "Record not found", error_reason: "not_found" }
      );
    }
  } as unknown as QueryHandler;
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => ({
        onConflictDoNothing: () => {
          rec.inserts.push({ values, conflict: "nothing" });
          return Promise.resolve();
        },
        onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
          rec.inserts.push({ values, conflict: "update", set });
          return Promise.resolve();
        }
      })
    })
  } as unknown as Database;
  return { store: new SettingsStore(queryHandler, db), rec };
}

function captureLogs(): { lines: string[]; stop: () => void } {
  const lines: string[] = [];
  const stop = logTestStream.subscribe((line) => lines.push(line));
  return { lines, stop };
}

test("SettingsStore.encryptSecret produces enc:v1: prefix and round-trips through readSecret", () => {
  const stored = SettingsStore.encryptSecret(TOKEN);
  assert.ok(stored.startsWith(SECRET_PREFIX));
  assert.ok(!stored.includes(TOKEN));
  assert.deepEqual(SettingsStore.readSecret(stored, "github_token"), { state: "present", value: TOKEN });
});

test("SettingsStore.readSecret returns absent for null and empty", () => {
  assert.deepEqual(SettingsStore.readSecret(null, "github_token"), { state: "absent" });
  assert.deepEqual(SettingsStore.readSecret(undefined, "github_token"), { state: "absent" });
  assert.deepEqual(SettingsStore.readSecret("", "github_token"), { state: "absent" });
});

test("SettingsStore.readSecret returns unreadable for value without prefix", () => {
  const logs = captureLogs();
  try {
    // A plaintext value (manual DB edit) is never used as a secret.
    assert.deepEqual(SettingsStore.readSecret(TOKEN, "github_token"), { state: "unreadable" });
    assert.deepEqual(SettingsStore.readSecret(Encryption.encrypt(TOKEN), "github_token"), { state: "unreadable" });
  } finally {
    logs.stop();
  }
  assert.ok(logs.lines.some((line) => line.includes("settings.secret.unknown_format")));
  assert.ok(logs.lines.every((line) => !line.includes(TOKEN)));
});

test("SettingsStore.readSecret returns unreadable when decryption throws", () => {
  const otherKeyCiphertext = (() => {
    Encryption.setKeyForTesting("a-different-test-key-that-is-long-enough");
    try {
      return SettingsStore.encryptSecret(TOKEN);
    } finally {
      Encryption.setKeyForTesting(null);
    }
  })();
  const logs = captureLogs();
  try {
    assert.deepEqual(SettingsStore.readSecret(otherKeyCiphertext, "github_token"), { state: "unreadable" });
    assert.deepEqual(SettingsStore.readSecret(`${SECRET_PREFIX}not-a-payload`, "anthropic_api_key"), {
      state: "unreadable"
    });
  } finally {
    logs.stop();
  }
  const events = logs.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const failures = events.filter((event) => event.event === "settings.secret.decrypt_failed");
  assert.deepEqual(
    failures.map((event) => [event.secretName, event.reason]),
    [
      ["github_token", "decrypt_failed"],
      ["anthropic_api_key", "malformed_payload"]
    ]
  );
  assert.ok(logs.lines.every((line) => !line.includes(otherKeyCiphertext.slice(SECRET_PREFIX.length))));
});

test("SettingsStore.patch only writes defined keys", async () => {
  const { store, rec } = storeWith([settingsRow({ aiModel: "claude-sonnet-5-5" })]);
  const row = await store.patch({
    aiModel: "claude-sonnet-5-5",
    githubLogin: undefined,
    anthropicApiKeyEncrypted: null
  });
  assert.equal(row.aiModel, "claude-sonnet-5-5");
  assert.equal(rec.inserts.length, 1);
  const insert = rec.inserts[0]!;
  assert.equal(insert.conflict, "update");
  assert.deepEqual(Object.keys(insert.set ?? {}).sort(), ["aiModel", "anthropicApiKeyEncrypted", "updatedAt"]);
  assert.equal(insert.set?.anthropicApiKeyEncrypted, null);
  assert.ok(insert.set.updatedAt instanceof Date);
  // The insert half carries the defaults so a missing row is created whole.
  assert.equal(insert.values.id, 1);
  assert.equal(insert.values.aiProvider, "anthropic_api");
  assert.equal(insert.values.aiModel, "claude-sonnet-5-5");
});

test("SettingsStore.getOrCreate selects without inserting when the seeded row exists", async () => {
  const { store, rec } = storeWith([settingsRow()]);
  const row = await store.getOrCreate();
  assert.equal(row.id, 1);
  assert.equal(rec.selects.length, 1);
  assert.deepEqual(rec.selects[0], { id: 1 });
  assert.equal(rec.inserts.length, 0);
});

test("SettingsStore.getOrCreate inserts defaults when the row is missing", async () => {
  const { store, rec } = storeWith([null, settingsRow()]);
  const row = await store.getOrCreate();
  assert.equal(row.aiModel, "claude-opus-5-5");
  assert.equal(rec.selects.length, 2);
  assert.deepEqual(rec.inserts, [
    {
      values: {
        id: 1,
        aiProvider: "anthropic_api",
        aiModel: "claude-opus-5-5",
        aiHarnessEffort: "high",
        aiSummaryEffort: "medium"
      },
      conflict: "nothing"
    }
  ]);
});

test("SettingsStore.setGithubLoginIfTokenUnchanged returns false and writes nothing when the ciphertext changed", async () => {
  const { store, rec } = storeWith([], 404);
  const written = await store.setGithubLoginIfTokenUnchanged("enc:v1:old", "octo");
  assert.equal(written, false);
  assert.deepEqual(rec.updates, [
    { values: { githubLogin: "octo" }, conditions: { id: 1, githubTokenEncrypted: "enc:v1:old" } }
  ]);

  const ok = storeWith([], 200);
  assert.equal(await ok.store.setGithubLoginIfTokenUnchanged("enc:v1:old", "octo"), true);
  await assert.rejects(storeWith([], 500).store.setGithubLoginIfTokenUnchanged("enc:v1:old", "octo"), /500/);
});

test("SettingsStore.readAiSettings returns provider, model, efforts and the decrypted key from one row read", async () => {
  const key = `sk-ant-api03-${"k".repeat(40)}`;
  const { store, rec } = storeWith([
    settingsRow({
      aiProvider: "claude_code",
      aiModel: "claude-sonnet-5-5",
      aiHarnessEffort: "xhigh",
      aiSummaryEffort: "low",
      anthropicApiKeyEncrypted: SettingsStore.encryptSecret(key)
    })
  ]);
  assert.deepEqual(await store.readAiSettings(), {
    provider: "claude_code",
    model: "claude-sonnet-5-5",
    harnessEffort: "xhigh",
    summaryEffort: "low",
    anthropicApiKey: { state: "present", value: key }
  });
  assert.equal(rec.selects.length, 1);
});
