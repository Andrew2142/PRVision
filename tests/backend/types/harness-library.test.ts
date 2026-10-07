import assert from "node:assert/strict";
import { test } from "node:test";
import type { RenderFailureKind } from "../../../backend/src/services/visualizations/pipeline/render/render-types";
import { DEFAULT_STATE_NAME, identityKey, type RenderFailureKindValue } from "../../../backend/src/types";

/** Compile-time equality of two types (both directions of assignability). */
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("RenderFailureKindValue and 10's RenderFailureKind are mutually assignable (16 §6.12)", () => {
  const equal: Equal<RenderFailureKindValue, RenderFailureKind> = true;
  assert.equal(equal, true);
  const step: RenderFailureKind = "step_failed" satisfies RenderFailureKindValue;
  assert.equal(step, "step_failed");
});

test("identityKey joins file path and export name with a NUL separator", () => {
  assert.equal(
    identityKey({ filePath: "src/components/Button.tsx", exportName: "default" }),
    "src/components/Button.tsx\u0000default"
  );
  assert.notEqual(
    identityKey({ filePath: "src/a", exportName: "b/c" }),
    identityKey({ filePath: "src/a/b", exportName: "c" })
  );
});

test("DEFAULT_STATE_NAME is Default", () => {
  assert.equal(DEFAULT_STATE_NAME, "Default");
});
