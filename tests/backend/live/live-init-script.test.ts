import assert from "node:assert/strict";
import { test } from "node:test";
import vm from "node:vm";
import { RENDER_FIXED_TIME_ISO, RENDER_RANDOM_SEED } from "../../../backend/src/config-consts/render.config";
import { buildDeterminismInitScript } from "../../../backend/src/services/visualizations/pipeline/render/page-scripts";
import {
  LIVE_INIT_SCRIPT_ID,
  buildLiveInitScript,
  injectLiveInitScript,
  liveInitScriptTag
} from "../../../backend/src/services/visualizations/pipeline/render/live/live-init-script";

interface PageGlobals {
  Math: Math;
  Date: DateConstructor;
  Reflect: typeof Reflect;
  Object: ObjectConstructor;
  globalThis?: unknown;
  document?: unknown;
}

/** Runs a script in a fresh context with its own Math and Date (like a page); returns the context. */
function runInPage(source: string, extra: Record<string, unknown> = {}): PageGlobals {
  const context = vm.createContext({ ...extra }) as PageGlobals;
  vm.runInContext("globalThis.Math = Math; globalThis.Date = Date;", context);
  vm.runInContext(source, context);
  return context;
}

function randoms(context: PageGlobals, count: number): number[] {
  return Array.from({ length: count }, () => context.Math.random());
}

test("the live random sequence equals the screenshot init script's for the same seed", () => {
  const live = runInPage(buildLiveInitScript(RENDER_RANDOM_SEED));
  const screenshot = runInPage(buildDeterminismInitScript(RENDER_RANDOM_SEED), {
    document: { documentElement: {}, getElementById: () => ({}) } // style already present: install() returns early
  });
  const expected = randoms(screenshot, 20);
  assert.deepEqual(randoms(live, 20), expected);
  assert.ok(expected.every((value) => value >= 0 && value < 1));
  assert.notDeepEqual(randoms(runInPage(buildLiveInitScript(RENDER_RANDOM_SEED + 1)), 5), expected.slice(0, 5));
});

test("Date.now() and new Date() start at RENDER_FIXED_TIME_ISO and then advance", async () => {
  const page = runInPage(buildLiveInitScript());
  const start = Date.parse(RENDER_FIXED_TIME_ISO);
  const first = page.Date.now();
  assert.ok(first >= start && first < start + 1_000, `starts at the fixed time (${String(first - start)} ms)`);
  const created = vm.runInContext("new Date().getTime()", page) as number;
  assert.ok(created >= start && created < start + 1_000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.ok(page.Date.now() - first >= 20, "time advances normally");
});

test("the shifted Date keeps explicit arguments, statics, instanceof and the string form of Date()", () => {
  const page = runInPage(buildLiveInitScript());
  assert.equal(
    vm.runInContext('new Date("2020-02-03T04:05:06.000Z").toISOString()', page as vm.Context),
    "2020-02-03T04:05:06.000Z"
  );
  assert.equal(vm.runInContext("new Date(0).getTime()", page as vm.Context), 0);
  assert.equal(vm.runInContext("new Date() instanceof Date", page as vm.Context), true);
  assert.equal(
    vm.runInContext('Date.UTC(2020, 0, 1) === Date.parse("2020-01-01T00:00:00Z")', page as vm.Context),
    true
  );
  assert.equal(vm.runInContext("typeof Date()", page as vm.Context), "string");
  assert.match(vm.runInContext("Date()", page) as string, /2025/);
});

test("an unparseable start time is refused", () => {
  assert.throws(() => buildLiveInitScript(1, "not a date"), /Invalid live start time/);
});

test("the init script is injected as the first child of <head>", () => {
  const tag = liveInitScriptTag("void 0;");
  assert.equal(tag, `<script id="${LIVE_INIT_SCRIPT_ID}">void 0;</script>`);
  const html =
    '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n  </head><body></body></html>';
  const out = injectLiveInitScript(html, tag);
  assert.equal(out, html.replace("<head>", `<head>${tag}`));
  assert.equal(injectLiveInitScript(out, tag), out, "idempotent");
  assert.equal(
    injectLiveInitScript('<html><head data-x="1"><title>t</title></head></html>', tag),
    `<html><head data-x="1">${tag}<title>t</title></head></html>`
  );
  assert.equal(
    injectLiveInitScript("<!doctype html><html><body></body></html>", tag),
    `<!doctype html><html><head>${tag}</head><body></body></html>`
  );
  assert.equal(
    injectLiveInitScript("<!doctype html><prvision-root></prvision-root>", tag),
    `<!doctype html><head>${tag}</head><prvision-root></prvision-root>`
  );
  assert.equal(injectLiveInitScript("<header>x</header>", tag), `<head>${tag}</head><header>x</header>`);
});

test("a </script inside the source cannot close the tag early", () => {
  assert.equal(liveInitScriptTag('"</script>"'), `<script id="${LIVE_INIT_SCRIPT_ID}">"<\\/script>"</script>`);
});
