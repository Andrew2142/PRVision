import assert from "node:assert/strict";
import { test } from "node:test";
import { RENDER_ERROR_MAX_CHARS } from "../../../backend/src/config-consts";
import {
  extractViteErrorFromBody,
  formatRenderError,
  headlineFor,
  isOptimizeDepsChurn,
  isRepairableFailure,
  rewriteMockIds,
  type FormatRenderErrorInput
} from "../../../backend/src/services/visualizations/pipeline/render/render-errors";
import type { RenderFailureKind } from "../../../backend/src/services/visualizations/pipeline/render/render-types";

const VITE_ERROR = {
  message: 'Failed to resolve import "../hooks/useCart" from "src/components/CartBadge.tsx". Does the file exist?',
  plugin: "vite:import-analysis",
  id: "/wt/head/src/components/CartBadge.tsx",
  loc: { file: "src/components/CartBadge.tsx", line: 3, column: 24 },
  frame: "1 | import x\n2 | import y\n"
};

function input(overrides: Partial<FormatRenderErrorInput> = {}): FormatRenderErrorInput {
  return {
    kind: "module_load",
    headline: "Module load failed: Failed to fetch dynamically imported module: /.prvision-harness/components/42.tsx",
    stack: null,
    componentStack: null,
    serverErrors: [],
    consoleErrors: [],
    viteOrigin: "http://127.0.0.1:53817",
    mockLabels: new Map(),
    ...overrides
  };
}

test("extractViteErrorFromBody parses the Vite 4 ErrorOverlay body", () => {
  const body = `<!DOCTYPE html><html><script type="module">import { ErrorOverlay } from '/@vite/client'\ndocument.body.appendChild(new ErrorOverlay(${JSON.stringify(VITE_ERROR)}))\n</script></html>`;
  const parsed = extractViteErrorFromBody(body);
  assert.equal(
    parsed,
    `[plugin:vite:import-analysis] ${VITE_ERROR.message}\n  File: src/components/CartBadge.tsx:3:24\n1 | import x\n2 | import y`
  );
});

test("extractViteErrorFromBody parses the Vite 5+ const error body", () => {
  const body = `<!DOCTYPE html>\n<script type="module">\nimport { ErrorOverlay } from '/@vite/client'\ntry {\n  const error = ${JSON.stringify({ message: "Transform failed", id: "/src/x.tsx" })}\n  try { document.body.appendChild(new ErrorOverlay(error)) } catch {}\n} catch {}\n</script>`;
  assert.equal(extractViteErrorFromBody(body), "Transform failed\n  File: /src/x.tsx");
});

test("extractViteErrorFromBody falls back to stripped text", () => {
  assert.equal(
    extractViteErrorFromBody("<html><body><h1>500</h1>  <p>Internal   error</p></body></html>"),
    "500 Internal error"
  );
  assert.equal(extractViteErrorFromBody("<html></html>"), null);
  assert.equal(extractViteErrorFromBody("x".repeat(800))?.length, 500);
});

test("formatRenderError orders sections and truncates at RENDER_ERROR_MAX_CHARS", () => {
  const formatted = formatRenderError(
    input({
      kind: "render_error",
      headline: "Render error: boom",
      stack: "Error: boom\n    at A (src/A.tsx:1:1)",
      componentStack: "\n    at A (src/A.tsx:1:1)\n    at PRVisionHarness",
      serverErrors: ["[plugin:x] first\n  File: a.ts:1:1", "second"],
      consoleErrors: ["console one", "console two"]
    })
  );
  const lines = formatted.split("\n");
  assert.equal(lines[0], "[render_error] Render error: boom");
  const order = ["Vite:", "Stack:", "Component stack:", "Console errors:"].map((section) => lines.indexOf(section));
  assert.ok(order.every((index) => index > 0));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order
  );
  assert.ok(formatted.includes("- [plugin:x] first\n  File: a.ts:1:1\n- second"));
  assert.ok(formatted.includes("Component stack:\n  at A (src/A.tsx:1:1)\n  at PRVisionHarness"));

  const long = formatRenderError(
    input({
      stack: Array.from({ length: 50 }, (_, i) => `at frame${String(i)} ${"x".repeat(200)}`).join("\n"),
      consoleErrors: ["y".repeat(5000)]
    })
  );
  assert.ok(long.length <= RENDER_ERROR_MAX_CHARS);
  assert.ok(long.endsWith("… (truncated)"));
  const stackLines =
    long
      .split("Stack:\n")[1]
      ?.split("\n")
      .filter((line) => line.startsWith("  at frame")) ?? [];
  assert.equal(stackLines.length, 12);

  const minimal = formatRenderError(input());
  assert.equal(minimal.split("\n").length, 1, "empty sections are omitted");
});

test("formatRenderError strips the Vite origin and worktree paths", () => {
  const formatted = formatRenderError(
    input({
      headline:
        "Module load failed: Failed to fetch dynamically imported module: http://127.0.0.1:53817/.prvision-harness/components/42.tsx?v=1a2b3c4d",
      stack: "TypeError: x\n    at http://127.0.0.1:53817/@fs/home/me/.prvision/worktrees/9/head/src/A.tsx:1:1",
      serverErrors: ["Internal server error: /home/me/.prvision/worktrees/9/head/src/A.tsx: Unexpected token"],
      stripPaths: ["/home/me/.prvision/worktrees/9/head", "/home/me/.prvision/worktrees/9/base"]
    })
  );
  assert.doesNotMatch(formatted, /127\.0\.0\.1/);
  assert.doesNotMatch(formatted, /\/home\/me/);
  assert.doesNotMatch(formatted, /\?v=/);
  assert.match(formatted, /\/\.prvision-harness\/components\/42\.tsx/);
  assert.match(formatted, /Internal server error: src\/A\.tsx: Unexpected token/);
  assert.match(formatted, /at src\/A\.tsx:1:1/);
});

test("formatRenderError redacts secrets", () => {
  const formatted = formatRenderError(
    input({ consoleErrors: ["token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked"] })
  );
  assert.doesNotMatch(formatted, /ghp_abcdefghijklmnopqrstuvwxyz0123456789/);
});

test("rewriteMockIds replaces encoded and raw mock ids with readable labels", () => {
  const labels = new Map([["0123456789abcdef", "@/lib/api"]]);
  const text = [
    "SyntaxError: The requested module '/@id/__x00__prvision-mock:0123456789abcdef' does not provide an export named 'fetchUser'",
    "at __x00__prvision-mock:0123456789abcdef:3:1",
    "id \u0000prvision-mock:0123456789abcdef",
    "unknown /@id/__x00__prvision-mock:ffffffffffffffff"
  ].join("\n");
  const rewritten = rewriteMockIds(text, labels);
  assert.equal(
    rewritten,
    [
      "SyntaxError: The requested module '[mock of \"@/lib/api\"]' does not provide an export named 'fetchUser'",
      'at [mock of "@/lib/api"]:3:1',
      'id [mock of "@/lib/api"]',
      "unknown [mock ffffffffffffffff]"
    ].join("\n")
  );
});

test("isRepairableFailure is true only for module_load, render_error and timeout", () => {
  const all: RenderFailureKind[] = [
    "vite_unavailable",
    "navigation",
    "module_load",
    "render_error",
    "timeout",
    "browser",
    "screenshot",
    "file_missing",
    "budget_exceeded",
    "cancelled"
  ];
  assert.deepEqual(
    all.filter((kind) => isRepairableFailure(kind)),
    ["module_load", "render_error", "timeout"]
  );
});

test("isRepairableFailure: step_failed is repairable (16 §7.6.3); infrastructure kinds stay unrepairable", () => {
  assert.equal(isRepairableFailure("step_failed"), true);
  for (const kind of [
    "vite_unavailable",
    "navigation",
    "browser",
    "screenshot",
    "file_missing",
    "budget_exceeded",
    "cancelled"
  ] as const) {
    assert.equal(isRepairableFailure(kind), false, kind);
  }
});

test("headlineFor gives step_failed the Interaction step failed headline", () => {
  const detail = 'State "Menu open", step 1 (click role=button "More actions"): no visible element matched within 3 s.';
  assert.equal(headlineFor("step_failed", detail), `Interaction step failed: ${detail}`);
  const formatted = formatRenderError({
    kind: "step_failed",
    headline: headlineFor("step_failed", detail),
    stack: null,
    componentStack: null,
    serverErrors: [],
    consoleErrors: [],
    viteOrigin: null,
    mockLabels: new Map<string, string>()
  });
  assert.equal(formatted, `[step_failed] Interaction step failed: ${detail}`);
});

test("isOptimizeDepsChurn recognises outdated optimize dep messages", () => {
  assert.equal(isOptimizeDepsChurn("504 (Outdated Optimize Dep)"), true);
  assert.equal(isOptimizeDepsChurn("[vite] ✨ optimized dependencies changed. reloading"), true);
  assert.equal(isOptimizeDepsChurn("Failed to fetch dynamically imported module: /src/x.tsx"), true);
  assert.equal(isOptimizeDepsChurn("error loading dynamically imported module"), true);
  assert.equal(isOptimizeDepsChurn("Failed to resolve import ./x"), false);
});
