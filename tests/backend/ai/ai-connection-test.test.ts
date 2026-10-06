import assert from "node:assert/strict";
import test from "node:test";
import {
  CONNECTION_TEST_SCHEMA,
  CONNECTION_TEST_SYSTEM,
  buildConnectionTestRequest
} from "../../../backend/src/utilities/services/ai/ai-connection-test";
import { JsonSchemaValidator } from "../../../backend/src/utilities/services/ai/json-schema-validator";

test("connection test schema passes compatibility check", () => {
  assert.doesNotThrow(() => JsonSchemaValidator.assertStructuredOutputCompatible(CONNECTION_TEST_SCHEMA));
  assert.equal(JsonSchemaValidator.validate(CONNECTION_TEST_SCHEMA, { ok: true, echo: "prv-1" }).ok, true);
  assert.equal(JsonSchemaValidator.validate(CONNECTION_TEST_SCHEMA, { ok: true }).ok, false);
});

test("buildConnectionTestRequest uses purpose connection_test, effort low and the caller's signal", () => {
  const controller = new AbortController();
  const request = buildConnectionTestRequest({ nonce: "prv-abc", signal: controller.signal });
  assert.equal(request.purpose, "connection_test");
  assert.equal(request.effort, "low");
  assert.equal(request.signal, controller.signal);
  assert.equal(request.system, CONNECTION_TEST_SYSTEM);
  assert.equal(request.jsonSchema, CONNECTION_TEST_SCHEMA);
  assert.equal(request.workingDirectory, undefined);
  assert.equal(request.images, undefined);
});

test("buildConnectionTestRequest prompt contains the nonce", () => {
  const request = buildConnectionTestRequest({ nonce: "prv-9f8e7d", signal: new AbortController().signal });
  assert.ok(request.prompt.endsWith("prv-9f8e7d"));
});
