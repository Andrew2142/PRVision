import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { SettingsUpdateDTO } from "../../../backend/src/dtos/settings/settings-update.dto";
import { Validation } from "../../../backend/src/utilities/validation/validation";

const validation = new Validation();
const GITHUB_TOKEN = `github_pat_${"A1b2".repeat(10)}`;
const ANTHROPIC_KEY = `sk-ant-api03-${"x".repeat(40)}`;

async function validate(body: unknown) {
  return validation.validate(validation.compileJsonData(body), SettingsUpdateDTO);
}

async function rejects(body: unknown): Promise<string[]> {
  const [isValid, errorResponse] = await validate(body);
  assert.equal(isValid, false);
  assert.equal(errorResponse.status, 400);
  assert.equal(errorResponse.error_reason, "validation_failed");
  assert.ok(Array.isArray(errorResponse.error));
  return errorResponse.error;
}

test("SettingsUpdateDTO accepts empty body", async () => {
  const [isValid, , dto] = await validate({});
  assert.equal(isValid, true);
  assert.equal(dto.githubToken, undefined);
  assert.equal(dto.anthropicApiKey, undefined);
});

test('SettingsUpdateDTO accepts githubToken "" as clear', async () => {
  const [isValid, , dto] = await validate({ githubToken: "" });
  assert.equal(isValid, true);
  assert.equal(dto.githubToken, "");
});

test("SettingsUpdateDTO rejects githubToken null", async () => {
  const errors = await rejects({ githubToken: null });
  assert.ok(errors.some((message) => message.startsWith("githubToken must be a string")));
});

test("SettingsUpdateDTO rejects whitespace-only githubToken", async () => {
  const errors = await rejects({ githubToken: "    " });
  assert.ok(errors.some((message) => message.includes("githubToken must be empty")));
});

test("SettingsUpdateDTO trims surrounding whitespace from a valid token", async () => {
  const [isValid, , dto] = await validate({ githubToken: `  ${GITHUB_TOKEN}\n` });
  assert.equal(isValid, true);
  assert.equal(dto.githubToken, GITHUB_TOKEN);
});

test("SettingsUpdateDTO rejects githubToken with illegal characters", async () => {
  await rejects({ githubToken: `ghp_${"a".repeat(30)}:secret` });
});

test("SettingsUpdateDTO accepts anthropicApiKey starting with sk-ant-", async () => {
  const [isValid, , dto] = await validate({ anthropicApiKey: ANTHROPIC_KEY });
  assert.equal(isValid, true);
  assert.equal(dto.anthropicApiKey, ANTHROPIC_KEY);
});

test("SettingsUpdateDTO rejects anthropicApiKey without sk-ant- prefix", async () => {
  const errors = await rejects({ anthropicApiKey: `sk-${"x".repeat(40)}` });
  assert.ok(errors.some((message) => message.includes("starting with sk-ant-")));
});

test("SettingsUpdateDTO rejects unknown aiProvider", async () => {
  const errors = await rejects({ aiProvider: "openai" });
  assert.ok(errors.some((message) => message.includes("aiProvider must be one of: anthropic_api")));
});

test("SettingsUpdateDTO rejects the legacy claude_code provider and accepts anthropic_api", async () => {
  const errors = await rejects({ aiProvider: "claude_code" });
  assert.ok(errors.some((message) => message.includes("aiProvider must be one of: anthropic_api")));
  const [isValid, , dto] = await validate({ aiProvider: "anthropic_api" });
  assert.equal(isValid, true);
  assert.equal(dto.aiProvider, "anthropic_api");
});

test("SettingsUpdateDTO rejects unknown effort value", async () => {
  await rejects({ aiHarnessEffort: "extreme" });
  await rejects({ aiSummaryEffort: "none" });
  const [isValid] = await validate({ aiHarnessEffort: "xhigh", aiSummaryEffort: "low" });
  assert.equal(isValid, true);
});

test("SettingsUpdateDTO rejects aiModel with uppercase or spaces", async () => {
  await rejects({ aiModel: "Claude-Opus" });
  await rejects({ aiModel: "claude opus" });
  const [isValid, , dto] = await validate({ aiModel: " claude-opus-5-5 " });
  assert.equal(isValid, true);
  assert.equal(dto.aiModel, "claude-opus-5-5");
});

test("SettingsUpdateDTO rejects unknown property hasGithubToken", async () => {
  const errors = await rejects({ hasGithubToken: true });
  assert.ok(errors.some((message) => message.includes("hasGithubToken")));
});
