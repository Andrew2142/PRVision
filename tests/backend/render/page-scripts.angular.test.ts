import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import {
  HARNESS_HTTP_UNMATCHED_MAX,
  HARNESS_HTTP_UNMATCHED_MAX_CHARS,
  READ_HARNESS_STATE_SCRIPT,
  toHarnessState
} from "../../../backend/src/services/visualizations/pipeline/render/page-scripts";
import { formatRenderError } from "../../../backend/src/services/visualizations/pipeline/render/render-errors";

/** Runs the in-page expression against a fake `window` (the script reads only window globals). */
function readState(windowGlobals: Record<string, unknown>): ReturnType<typeof toHarnessState> {
  const raw: unknown = vm.runInNewContext(READ_HARNESS_STATE_SCRIPT, { window: windowGlobals });
  return toHarnessState(JSON.parse(JSON.stringify(raw)));
}

test("readHarnessState: a React page without the Angular globals reads unstable false and empty lists", () => {
  const state = readState({ __PRVISION_STATUS__: "ready", __PRVISION_READY__: true, __PRVISION_ERROR__: null });
  assert.deepEqual(state, {
    status: "ready",
    ready: true,
    error: null,
    unstable: false,
    skippedInputs: [],
    httpUnmatched: []
  });
  assert.deepEqual(toHarnessState(null), {
    status: null,
    ready: false,
    error: null,
    unstable: false,
    skippedInputs: [],
    httpUnmatched: []
  });
});

test("readHarnessState: Angular pages report unstable, skipped inputs and HTTP requests without fixtures (bounded)", () => {
  const unmatched = Array.from(
    { length: 15 },
    (_, index) => `GET /api/items?page=${String(index)}&q=${"x".repeat(300)}`
  );
  const state = readState({
    __PRVISION_STATUS__: "ready",
    __PRVISION_READY__: true,
    __PRVISION_UNSTABLE__: true,
    __PRVISION_SKIPPED_INPUTS__: ["section", 7],
    __PRVISION_HTTP_UNMATCHED__: unmatched
  });
  assert.equal(state.unstable, true);
  assert.deepEqual(state.skippedInputs, ["section", "7"]);
  assert.equal(state.httpUnmatched.length, HARNESS_HTTP_UNMATCHED_MAX);
  assert.ok(state.httpUnmatched.every((entry) => entry.length <= HARNESS_HTTP_UNMATCHED_MAX_CHARS));
  assert.ok(state.httpUnmatched[0]?.startsWith("GET /api/items?page=0&q="), "query strings are kept");
  // The validator drops non-string entries and bounds lists coming from an untrusted page.
  const validated = toHarnessState({ ready: false, unstable: "yes", skippedInputs: [1, "a"], httpUnmatched: "GET /x" });
  assert.equal(validated.unstable, false);
  assert.deepEqual(validated.skippedInputs, ["a"]);
  assert.deepEqual(validated.httpUnmatched, []);
});

test("formatRenderError adds an `HTTP without fixture:` section only when requests are listed", () => {
  const base = {
    kind: "render_error" as const,
    headline: "Render error: boom",
    stack: null,
    componentStack: null,
    serverErrors: [],
    consoleErrors: ["pageerror: boom"],
    viteOrigin: null,
    mockLabels: new Map<string, string>()
  };
  const react = formatRenderError(base);
  assert.equal(formatRenderError({ ...base, httpUnmatched: [] }), react);
  assert.ok(!react.includes("HTTP without fixture"));
  const angular = formatRenderError({ ...base, httpUnmatched: ["GET /api/members/m-1", "POST /api/x"] });
  assert.ok(angular.startsWith(react));
  assert.ok(angular.endsWith("\nHTTP without fixture:\n- GET /api/members/m-1\n- POST /api/x"));
});
