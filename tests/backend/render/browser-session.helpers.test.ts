import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "node:test";
import { PNG } from "pngjs";
import {
  CHROMIUM_LAUNCH_ARGS,
  TRANSPARENT_PNG_1X1,
  buildContextOptions,
  compactServerLog,
  decideRoute,
  readPngSize,
  sameClip
} from "../../../backend/src/services/visualizations/pipeline/render/browser-session";
import { buildDeterminismInitScript } from "../../../backend/src/services/visualizations/pipeline/render/page-scripts";

const ORIGIN = "http://127.0.0.1:53817";

test("decideRoute continues same-origin, data and blob URLs", () => {
  assert.deepEqual(decideRoute(`${ORIGIN}/src/App.tsx`, "script", ORIGIN), { action: "continue" });
  assert.deepEqual(decideRoute(`${ORIGIN}/api/users`, "fetch", ORIGIN), { action: "continue" });
  assert.deepEqual(decideRoute("data:image/png;base64,AAAA", "image", ORIGIN), { action: "continue" });
  assert.deepEqual(decideRoute("blob:http://127.0.0.1:53817/123", "fetch", ORIGIN), { action: "continue" });
  assert.equal(decideRoute("http://127.0.0.1:9999/x", "fetch", ORIGIN).action, "fulfill", "another port is off-origin");
});

test("decideRoute fulfils off-origin images with a 1x1 PNG, styles and scripts with empty bodies, and fetches with {}", () => {
  assert.deepEqual(decideRoute("https://cdn.example.com/a.png", "image", ORIGIN), {
    action: "fulfill",
    status: 200,
    contentType: "image/png",
    body: TRANSPARENT_PNG_1X1
  });
  assert.deepEqual(readPngSize(TRANSPARENT_PNG_1X1), { width: 1, height: 1 });
  assert.deepEqual(decideRoute("https://fonts.googleapis.com/css2?family=Inter", "stylesheet", ORIGIN), {
    action: "fulfill",
    status: 200,
    contentType: "text/css",
    body: ""
  });
  assert.deepEqual(decideRoute("https://cdn.example.com/x.js", "script", ORIGIN), {
    action: "fulfill",
    status: 200,
    contentType: "text/javascript",
    body: ""
  });
  for (const type of ["fetch", "xhr", "eventsource", "other"]) {
    assert.deepEqual(decideRoute("https://api.example.com/users", type, ORIGIN), {
      action: "fulfill",
      status: 200,
      contentType: "application/json",
      body: "{}"
    });
  }
  assert.equal(decideRoute("https://example.com/", "document", ORIGIN).action, "fulfill");
});

test("decideRoute aborts off-origin fonts and media", () => {
  assert.deepEqual(decideRoute("https://fonts.gstatic.com/a.woff2", "font", ORIGIN), { action: "abort" });
  assert.deepEqual(decideRoute("https://cdn.example.com/v.mp4", "media", ORIGIN), { action: "abort" });
});

test("decideRoute aborts unparsable URLs", () => {
  assert.deepEqual(decideRoute("not a url", "fetch", ORIGIN), { action: "abort" });
});

test("readPngSize reads width and height from the IHDR chunk", () => {
  const png = new PNG({ width: 412, height: 88 });
  assert.deepEqual(readPngSize(PNG.sync.write(png)), { width: 412, height: 88 });
  assert.throws(() => readPngSize(Buffer.from("not a png at all, really")), /Not a PNG/);
});

test("sameClip compares integer clip rectangles", () => {
  assert.equal(sameClip({ x: 0, y: 0, width: 10, height: 20 }, { x: 0, y: 0, width: 10, height: 20 }), true);
  assert.equal(sameClip({ x: 0, y: 0, width: 10, height: 20 }, { x: 0, y: 0, width: 11, height: 20 }), false);
  assert.equal(sameClip({ x: 0, y: 0, width: 10, height: 20 }, { x: 0, y: 0, width: 10, height: 21 }), false);
});

test("buildContextOptions sets viewport, scale 1, reduced motion, light scheme, en-US, UTC, blocked service workers and no permissions", () => {
  const options = buildContextOptions();
  assert.deepEqual(options.viewport, { width: 1280, height: 800 });
  assert.deepEqual(options.screen, { width: 1280, height: 800 });
  assert.equal(options.deviceScaleFactor, 1);
  assert.equal(options.isMobile, false);
  assert.equal(options.hasTouch, false);
  assert.equal(options.reducedMotion, "reduce");
  assert.equal(options.colorScheme, "light");
  assert.equal(options.forcedColors, "none");
  assert.equal(options.locale, "en-US");
  assert.equal(options.timezoneId, "UTC");
  assert.equal(options.serviceWorkers, "block");
  assert.deepEqual(options.permissions, []);
  assert.ok(CHROMIUM_LAUNCH_ARGS.includes("--force-color-profile=srgb"));
  assert.ok(CHROMIUM_LAUNCH_ARGS.includes("--disable-gpu"));
});

test("buildDeterminismInitScript is deterministic for a seed and produces the same first random values", () => {
  assert.equal(buildDeterminismInitScript(1337), buildDeterminismInitScript(1337));
  assert.notEqual(buildDeterminismInitScript(1337), buildDeterminismInitScript(42));
  const run = (seed: number): number[] => {
    const appended: unknown[] = [];
    const element = { appendChild: (node: unknown) => appended.push(node) };
    const sandbox = {
      Math: Object.create(Math) as Math,
      document: {
        documentElement: element,
        head: element,
        getElementById: () => null,
        createElement: () => ({ id: "", textContent: "" }),
        addEventListener: () => undefined
      }
    };
    vm.runInNewContext(buildDeterminismInitScript(seed), sandbox);
    assert.equal(appended.length, 1, "style element installed");
    return [sandbox.Math.random(), sandbox.Math.random(), sandbox.Math.random()];
  };
  const first = run(1337);
  assert.deepEqual(run(1337), first);
  assert.notDeepEqual(run(7), first);
  assert.ok(first.every((value) => value >= 0 && value < 1));
});

test("compactServerLog drops stack frames and the repeated error line", () => {
  const log = [
    'Internal server error: Failed to resolve import "./x" from "a.tsx". Does the file exist?',
    "  Plugin: vite:import-analysis",
    "      at TransformPluginContext._formatLog (file://node_modules/vite/dist/node/chunks/config.js:1:1)",
    '  Error: Failed to resolve import "./x" from "a.tsx". Does the file exist?',
    "    at normalizeUrl (file://node_modules/vite/dist/node/chunks/config.js:2:2)"
  ].join("\n");
  assert.equal(
    compactServerLog(log),
    'Internal server error: Failed to resolve import "./x" from "a.tsx". Does the file exist?\n  Plugin: vite:import-analysis'
  );
});
