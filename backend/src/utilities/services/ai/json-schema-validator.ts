import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";

/** Outcome of JsonSchemaValidator.validate. */
export type SchemaValidation<T> = { ok: true; value: T } | { ok: false; errors: string[]; summary: string };

/** Compiled validators for dynamically built schemas (looked up by JSON text) are capped at this many. */
const TEXT_CACHE_MAX_ENTRIES = 50;
const ERROR_LINE_MAX_CHARS = 200;

/**
 * Keywords Anthropic structured outputs does not support (05 §5.13; checked against the structured-outputs
 * "JSON Schema limitations" list). Lengths, ranges and array/object size constraints are enforced in code by the
 * consuming service instead.
 */
const UNSUPPORTED_KEYWORDS = [
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "if",
  "then",
  "else",
  "$schema",
  "$id"
] as const;

/** Keywords whose value is a single sub-schema. */
const SUBSCHEMA_KEYWORDS = ["items", "not", "additionalProperties"] as const;
/** Keywords whose value is an array of sub-schemas. */
const SUBSCHEMA_LIST_KEYWORDS = ["anyOf", "allOf", "oneOf", "prefixItems"] as const;
/** Keywords whose value is a map of name → sub-schema. */
const SUBSCHEMA_MAP_KEYWORDS = ["properties", "$defs", "definitions"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasObjectType(node: Record<string, unknown>): boolean {
  const type = node.type;
  return type === "object" || (Array.isArray(type) && type.includes("object"));
}

/**
 * JSON Schema (draft 2020-12) validation of AI output with ajv. Every provider validates parsed output here
 * (defence in depth on top of the API's structured outputs), and every request schema must pass
 * assertStructuredOutputCompatible.
 */
export class JsonSchemaValidator {
  private static readonly ajv = new Ajv2020({
    strict: true, // unknown keywords, ambiguous types => compile error (catches schema bugs at first use)
    allErrors: true, // report all problems so retry prompts can fix them in one go
    allowUnionTypes: true, // permits type: ["string", "null"]
    validateFormats: false // PRVision schemas do not rely on "format"
  });
  private static readonly byIdentity = new WeakMap<object, ValidateFunction>();
  private static readonly byText = new Map<string, { schema: object; validate: ValidateFunction }>();
  private static readonly compatChecked = new WeakSet<object>();

  /**
   * Validates `data` against `schema`.
   *
   * @returns `{ ok: true, value }` (typed as T) or the formatted errors with a one-line summary (first 3).
   * @throws Error when the schema itself does not compile (strict mode): a programming bug.
   */
  static validate<T>(schema: Record<string, unknown>, data: unknown): SchemaValidation<T> {
    const validateFn = JsonSchemaValidator.compile(schema);
    if (validateFn(data)) {
      return { ok: true, value: data as T }; // the only cast: ajv has just proven the shape
    }
    const errors = JsonSchemaValidator.formatErrors(validateFn.errors ?? []);
    return { ok: false, errors, summary: errors.slice(0, 3).join("; ") };
  }

  /**
   * Compiled validator for `schema`: cached by object identity (static schemas), then by JSON text (schemas built
   * per call, at most 50 entries, FIFO eviction), else compiled by ajv.
   */
  static compile(schema: Record<string, unknown>): ValidateFunction {
    const byIdentity = JsonSchemaValidator.byIdentity.get(schema);
    if (byIdentity) {
      return byIdentity;
    }
    const text = JSON.stringify(schema);
    const byText = JsonSchemaValidator.byText.get(text);
    if (byText) {
      JsonSchemaValidator.byIdentity.set(schema, byText.validate);
      return byText.validate;
    }
    const compiled = JsonSchemaValidator.ajv.compile(schema);
    JsonSchemaValidator.byIdentity.set(schema, compiled);
    JsonSchemaValidator.byText.set(text, { schema, validate: compiled });
    if (JsonSchemaValidator.byText.size > TEXT_CACHE_MAX_ENTRIES) {
      const oldest = JsonSchemaValidator.byText.entries().next().value;
      if (oldest) {
        JsonSchemaValidator.byText.delete(oldest[0]);
        JsonSchemaValidator.ajv.removeSchema(oldest[1].schema); // ajv keeps its own per-object cache
      }
    }
    return compiled;
  }

  /** "/mockedModules/0/specifier: must be string" — at most `max` lines, each at most 200 chars. */
  static formatErrors(errors: readonly ErrorObject[], max = 10): string[] {
    return errors.slice(0, max).map((error) => {
      const where = error.instancePath === "" ? "(root)" : error.instancePath;
      let extra = "";
      if (error.keyword === "additionalProperties") {
        extra = ` "${String((error.params as { additionalProperty?: unknown }).additionalProperty)}"`;
      } else if (error.keyword === "enum") {
        extra = ` (${JSON.stringify((error.params as { allowedValues?: unknown }).allowedValues)})`;
      } else if (error.keyword === "required") {
        extra = ` "${String((error.params as { missingProperty?: unknown }).missingProperty)}"`;
      }
      return `${where}: ${error.message ?? error.keyword}${extra}`.slice(0, ERROR_LINE_MAX_CHARS);
    });
  }

  /**
   * Throws Error (programming bug, not AiProviderError) when the schema uses keywords Anthropic structured
   * outputs does not support, or when an object schema is not closed:
   *  - every `type: "object"` has `additionalProperties: false` and `required` listing every key in `properties`
   *  - none of UNSUPPORTED_KEYWORDS anywhere
   *  - no recursive `$ref` (`#`, or a `$defs` entry that reaches itself)
   * Optional fields are expressed as `type: ["string", "null"]` and still listed in `required`. Cached per
   * schema object.
   */
  static assertStructuredOutputCompatible(schema: Record<string, unknown>): void {
    if (JsonSchemaValidator.compatChecked.has(schema)) {
      return;
    }
    JsonSchemaValidator.checkNode(schema, "#");
    JsonSchemaValidator.checkRefCycles(schema);
    JsonSchemaValidator.compatChecked.add(schema);
  }

  private static checkNode(node: unknown, where: string): void {
    if (!isRecord(node)) {
      return; // boolean schemas (e.g. additionalProperties: false) and non-schema values
    }
    for (const keyword of UNSUPPORTED_KEYWORDS) {
      if (keyword in node) {
        throw new Error(`Schema keyword "${keyword}" at ${where} is not supported by structured outputs`);
      }
    }
    if (hasObjectType(node)) {
      if (node.additionalProperties !== false) {
        throw new Error(`Object schema at ${where} must set additionalProperties: false`);
      }
      const properties = isRecord(node.properties) ? Object.keys(node.properties) : [];
      const required = Array.isArray(node.required) ? node.required : [];
      const missing = properties.filter((name) => !required.includes(name));
      if (missing.length > 0) {
        throw new Error(
          `Object schema at ${where} must list every property in required (missing: ${missing.join(", ")})`
        );
      }
    }
    if (node.$ref === "#") {
      throw new Error(`Recursive $ref at ${where} is not supported by structured outputs`);
    }
    for (const keyword of SUBSCHEMA_KEYWORDS) {
      JsonSchemaValidator.checkNode(node[keyword], `${where}/${keyword}`);
    }
    for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
      const list = node[keyword];
      if (Array.isArray(list)) {
        list.forEach((child, index) => {
          JsonSchemaValidator.checkNode(child, `${where}/${keyword}/${index}`);
        });
      }
    }
    for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
      const map = node[keyword];
      if (isRecord(map)) {
        for (const [name, child] of Object.entries(map)) {
          JsonSchemaValidator.checkNode(child, `${where}/${keyword}/${name}`);
        }
      }
    }
  }

  /** Rejects `$defs` entries that reference themselves directly or through other definitions. */
  private static checkRefCycles(schema: Record<string, unknown>): void {
    const definitions = new Map<string, unknown>();
    for (const keyword of ["$defs", "definitions"] as const) {
      const map = schema[keyword];
      if (isRecord(map)) {
        for (const [name, child] of Object.entries(map)) {
          definitions.set(`#/${keyword}/${name}`, child);
        }
      }
    }
    const refsOf = (node: unknown, out: Set<string>): Set<string> => {
      if (Array.isArray(node)) {
        for (const child of node) {
          refsOf(child, out);
        }
      } else if (isRecord(node)) {
        for (const [key, value] of Object.entries(node)) {
          if (key === "$ref" && typeof value === "string") {
            out.add(value);
          } else {
            refsOf(value, out);
          }
        }
      }
      return out;
    };
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (ref: string): void => {
      if (done.has(ref) || !definitions.has(ref)) {
        return;
      }
      if (visiting.has(ref)) {
        throw new Error(`Recursive $ref "${ref}" is not supported by structured outputs`);
      }
      visiting.add(ref);
      for (const next of refsOf(definitions.get(ref), new Set<string>())) {
        visit(next);
      }
      visiting.delete(ref);
      done.add(ref);
    };
    for (const ref of definitions.keys()) {
      visit(ref);
    }
  }
}
