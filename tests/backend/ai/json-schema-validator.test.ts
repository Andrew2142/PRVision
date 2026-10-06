import assert from "node:assert/strict";
import test from "node:test";
import type { ErrorObject } from "ajv/dist/2020";
import { JsonSchemaValidator } from "../../../backend/src/utilities/services/ai/json-schema-validator";
import { patchStaticMethod } from "../helpers/test-context";

const SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["name", "tags", "note"],
  properties: {
    name: { type: "string" },
    tags: { type: "array", items: { type: "string", enum: ["a", "b"] } },
    note: { type: ["string", "null"] }
  }
};

test("JsonSchemaValidator.validate validates a conforming object", () => {
  const result = JsonSchemaValidator.validate<{ name: string }>(SCHEMA, { name: "x", tags: ["a"], note: null });
  assert.deepEqual(result, { ok: true, value: { name: "x", tags: ["a"], note: null } });
});

test("JsonSchemaValidator.validate reports additionalProperties with property name", () => {
  const result = JsonSchemaValidator.validate(SCHEMA, { name: "x", tags: [], note: null, extra: 1 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes('(root): must NOT have additional properties "extra"'));
});

test("JsonSchemaValidator.validate reports missing required property", () => {
  const result = JsonSchemaValidator.validate(SCHEMA, { tags: ["c"], note: 3 });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((line) => line.startsWith("(root): must have required property") && line.endsWith('"name"'))
  );
  assert.ok(result.errors.some((line) => line.startsWith("/tags/0: must be equal to one of the allowed values")));
  assert.ok(result.errors.some((line) => line.startsWith("/note: must be string,null")));
  assert.equal(result.summary, result.errors.slice(0, 3).join("; "));
});

test("JsonSchemaValidator.compile caches compiled validator per schema object", (t) => {
  const ajv = (JsonSchemaValidator as unknown as { ajv: { compile: (schema: object) => unknown } }).ajv;
  const original = ajv.compile.bind(ajv);
  let compiles = 0;
  const restore = patchStaticMethod(ajv, "compile", (schema: object) => {
    compiles += 1;
    return original(schema);
  });
  t.after(restore);
  const schema: Record<string, unknown> = {
    type: "object",
    additionalProperties: false,
    required: ["n"],
    properties: { n: { type: "integer" } }
  };
  assert.equal(JsonSchemaValidator.validate(schema, { n: 1 }).ok, true);
  assert.equal(JsonSchemaValidator.validate(schema, { n: "1" }).ok, false);
  assert.equal(compiles, 1);
  // A structurally identical schema built per call reuses the compiled validator by text.
  assert.equal(JsonSchemaValidator.validate(structuredClone(schema), { n: 2 }).ok, true);
  assert.equal(compiles, 1);
});

test("JsonSchemaValidator strict mode rejects unknown keyword at compile", () => {
  assert.throws(
    () => JsonSchemaValidator.validate({ type: "object", colour: "red" }, {}),
    /strict mode: unknown keyword/
  );
});

test("JsonSchemaValidator.assertStructuredOutputCompatible rejects minLength", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: { a: { type: "string", minLength: 1 } }
  };
  assert.throws(() => JsonSchemaValidator.assertStructuredOutputCompatible(schema), /"minLength" at #\/properties\/a/);
});

test("JsonSchemaValidator.assertStructuredOutputCompatible rejects object without additionalProperties false", () => {
  const nested = {
    type: "object",
    additionalProperties: false,
    required: ["items"],
    properties: { items: { type: "array", items: { type: "object", required: [], properties: {} } } }
  };
  assert.throws(
    () => JsonSchemaValidator.assertStructuredOutputCompatible(nested),
    /#\/properties\/items\/items must set additionalProperties: false/
  );
});

test("JsonSchemaValidator.assertStructuredOutputCompatible rejects property missing from required", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["a"],
    properties: { a: { type: "string" }, b: { type: ["string", "null"] } }
  };
  assert.throws(() => JsonSchemaValidator.assertStructuredOutputCompatible(schema), /missing: b/);
  assert.doesNotThrow(() => JsonSchemaValidator.assertStructuredOutputCompatible(SCHEMA));
});

test("JsonSchemaValidator.assertStructuredOutputCompatible rejects recursive $ref", () => {
  const recursive = {
    type: "object",
    additionalProperties: false,
    required: ["node"],
    properties: { node: { $ref: "#/$defs/node" } },
    $defs: {
      node: {
        type: "object",
        additionalProperties: false,
        required: ["children"],
        properties: { children: { type: "array", items: { $ref: "#/$defs/node" } } }
      }
    }
  };
  assert.throws(() => JsonSchemaValidator.assertStructuredOutputCompatible(recursive), /Recursive \$ref/);
});

test("JsonSchemaValidator.formatErrors caps at 10 lines", () => {
  const errors: ErrorObject[] = Array.from({ length: 15 }, (_, index) => ({
    keyword: "type",
    instancePath: `/items/${index}`,
    schemaPath: "#/type",
    params: { type: "string" },
    message: `must be string ${"!".repeat(300)}`
  }));
  const lines = JsonSchemaValidator.formatErrors(errors);
  assert.equal(lines.length, 10);
  assert.ok(lines.every((line) => line.length <= 200));
  assert.ok(lines[0]?.startsWith("/items/0: must be string"));
});
