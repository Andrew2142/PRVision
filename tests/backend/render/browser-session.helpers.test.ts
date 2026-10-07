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
  harnessUrl,
  readPngSize,
  runHarnessState,
  sameClip,
  type StatePage,
  type StateRunInput
} from "../../../backend/src/services/visualizations/pipeline/render/browser-session";
import {
  buildDeterminismInitScript,
  SETTLE_AFTER_STEPS_SCRIPT
} from "../../../backend/src/services/visualizations/pipeline/render/page-scripts";

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

// ---------------------------------------------------------------------------------------------------------------
// 16 §7.6.3: state URL, scripted steps and state checks (fake page)
// ---------------------------------------------------------------------------------------------------------------

test("harnessUrl appends the URL-encoded state name (Default when absent)", () => {
  const url = harnessUrl(ORIGIN, "/.prvision-harness/index.html", 12, "Menu open & more/2");
  assert.ok(url.startsWith(`${ORIGIN}/.prvision-harness/index.html?c=12&quiet=`));
  assert.ok(url.endsWith("&s=Menu%20open%20%26%20more%2F2"));
  assert.equal(new URL(url).searchParams.get("s"), "Menu open & more/2");
  assert.ok(harnessUrl(ORIGIN, "/index.html", 3).endsWith("&s=Default"));
});

interface FakeStatePageOptions {
  /** How many mark attempts fail before the target is found (Infinity = never). */
  missesBeforeFound?: number;
  bridge?: boolean;
  actionError?: Error;
  /** Simulates the page raising an error while a step runs. */
  errorOnAction?: string;
  settleNeverResolves?: boolean;
}

function fakeStatePage(options: FakeStatePageOptions = {}): {
  page: StatePage;
  actions: string[];
  marks: number;
  pageErrors: { count: number; last: string | null };
} {
  const state = { actions: [] as string[], marks: 0, pageErrors: { count: 0, last: null as string | null } };
  const act = (name: string) => async (): Promise<void> => {
    state.actions.push(name);
    if (options.actionError !== undefined) {
      throw options.actionError;
    }
    if (options.errorOnAction !== undefined) {
      state.pageErrors = { count: state.pageErrors.count + 1, last: options.errorOnAction };
    }
    await Promise.resolve();
  };
  const page: StatePage = {
    evaluate: async (expression: string): Promise<unknown> => {
      if (expression === SETTLE_AFTER_STEPS_SCRIPT) {
        state.actions.push("settle");
        if (options.settleNeverResolves === true) {
          return new Promise(() => undefined);
        }
        return true;
      }
      state.marks += 1;
      if (options.bridge === false) {
        return { found: false, count: 0, bridge: false };
      }
      const found = state.marks > (options.missesBeforeFound ?? 0);
      return { found, count: found ? 1 : 0, bridge: true };
    },
    locator: (selector: string) => ({
      click: act(`click ${selector}`),
      hover: act(`hover ${selector}`),
      focus: act(`focus ${selector}`)
    }),
    keyboard: {
      type: async (text: string) => {
        state.actions.push(`type ${text}`);
        await Promise.resolve();
      },
      press: async (key: string) => {
        state.actions.push(`press ${key}`);
        await Promise.resolve();
      }
    }
  };
  return {
    page,
    get actions() {
      return state.actions;
    },
    get marks() {
      return state.marks;
    },
    get pageErrors() {
      return state.pageErrors;
    }
  };
}

const MENU_STEP = { action: "click", target: { by: "role", role: "button", name: "More actions" } };

function stateInput(fake: ReturnType<typeof fakeStatePage>, overrides: Partial<StateRunInput> = {}): StateRunInput {
  return {
    stateName: "Menu open",
    pageState: { name: "Menu open", names: ["Default", "Menu open"], steps: [MENU_STEP] },
    pageErrors: () => fake.pageErrors,
    stepTimeoutMs: 300,
    settleTimeoutMs: 200,
    signal: new AbortController().signal,
    isInfraError: () => false,
    ...overrides
  };
}

test("runHarnessState runs each step on the marked element, then settles the page again", async () => {
  const fake = fakeStatePage();
  const steps = [
    MENU_STEP,
    { action: "hover", target: { by: "text", text: "Details" } },
    { action: "type", target: { by: "label", label: "Email" }, text: "a@b.c" },
    { action: "press", key: "Space" },
    { action: "press", key: "Enter", target: { by: "testId", testId: "row" } },
    { action: "waitFor", target: { by: "text", text: "Saved" } }
  ];
  const result = await runHarnessState(
    fake.page,
    stateInput(fake, { pageState: { name: "Menu open", names: ["Default", "Menu open"], steps } })
  );
  assert.deepEqual(result, { ok: true, stateNames: ["Default", "Menu open"], stepsRun: 6 });
  assert.deepEqual(fake.actions, [
    'click [data-prvision-step-target="s0"]',
    'hover [data-prvision-step-target="s1"]',
    'focus [data-prvision-step-target="s2"]',
    "type a@b.c",
    "press  ",
    'focus [data-prvision-step-target="s4"]',
    "press Enter",
    "settle"
  ]);
});

test("runHarnessState: a step whose target never resolves fails with step_failed and the exact message", async () => {
  const fake = fakeStatePage({ missesBeforeFound: Number.POSITIVE_INFINITY });
  const result = await runHarnessState(fake.page, stateInput(fake, { stepTimeoutMs: 3_000 }));
  assert.deepEqual(result, {
    ok: false,
    kind: "step_failed",
    detail: 'State "Menu open", step 1 (click role=button "More actions"): no visible element matched within 3 s.'
  });
  assert.ok(fake.marks > 1, "the target is polled until the step timeout");
  assert.deepEqual(fake.actions, [], "no action without a resolved target");
});

test("runHarnessState polls the target until it appears", async () => {
  const fake = fakeStatePage({ missesBeforeFound: 2 });
  const result = await runHarnessState(fake.page, stateInput(fake));
  assert.equal(result.ok, true);
  assert.equal(fake.marks, 3);
});

test("runHarnessState: a Playwright action error is step_failed with its first line (≤ 300 chars)", async () => {
  const fake = fakeStatePage({
    actionError: new Error(`locator.click: Element is not visible ${"x".repeat(400)}\nCall log: …`)
  });
  const result = await runHarnessState(fake.page, stateInput(fake));
  assert.ok(!result.ok);
  assert.equal(result.kind, "step_failed");
  assert.ok(
    result.detail.startsWith(
      'State "Menu open", step 1 (click role=button "More actions"): locator.click: Element is not visible'
    )
  );
  assert.ok(!result.detail.includes("Call log"));
  const reason = result.detail.slice(result.detail.indexOf("): ") + 3);
  assert.equal(reason.length, 300);
});

test("runHarnessState rethrows infrastructure errors (page closed) for the session to classify", async () => {
  const closed = new Error("Target page, context or browser has been closed");
  const fake = fakeStatePage({ actionError: closed });
  await assert.rejects(
    runHarnessState(fake.page, stateInput(fake, { isInfraError: (error) => error === closed })),
    (error: unknown) => error === closed
  );
});

test("runHarnessState: a settle timeout after the steps is a timeout", async () => {
  const fake = fakeStatePage({ settleNeverResolves: true });
  const result = await runHarnessState(fake.page, stateInput(fake, { settleTimeoutMs: 50 }));
  assert.deepEqual(result, {
    ok: false,
    kind: "timeout",
    detail: 'State "Menu open": the page did not settle within 50 ms after its steps.'
  });
});

test("runHarnessState: a page error after a step is render_error naming the step", async () => {
  const fake = fakeStatePage({ errorOnAction: "Cannot read properties of undefined (reading 'items')" });
  const result = await runHarnessState(fake.page, stateInput(fake));
  assert.deepEqual(result, {
    ok: false,
    kind: "render_error",
    detail: `State "Menu open": error after step 1: Cannot read properties of undefined (reading 'items')`
  });
});

test("runHarnessState: errors before the steps started do not count", async () => {
  const fake = fakeStatePage();
  const before = { count: 2, last: "earlier" };
  const result = await runHarnessState(fake.page, stateInput(fake, { pageErrors: () => before }));
  assert.equal(result.ok, true);
});

test("runHarnessState: a state name mismatch is render_error", async () => {
  const fake = fakeStatePage();
  const result = await runHarnessState(
    fake.page,
    stateInput(fake, { stateName: "Overdue", pageState: { name: "Default", names: ["Default"], steps: [] } })
  );
  assert.deepEqual(result, {
    ok: false,
    kind: "render_error",
    detail: "Harness reported state Default, expected Overdue"
  });
});

test("runHarnessState: pages without __PRVISION_STATE__ behave as Default with no steps", async () => {
  const fake = fakeStatePage();
  const result = await runHarnessState(fake.page, stateInput(fake, { stateName: "Default", pageState: null }));
  assert.deepEqual(result, { ok: true, stateNames: ["Default"], stepsRun: 0 });
  assert.deepEqual(fake.actions, [], "no settle without steps");
  const other = await runHarnessState(fake.page, stateInput(fake, { stateName: "Overdue", pageState: null }));
  assert.deepEqual(other, {
    ok: false,
    kind: "render_error",
    detail: "Harness reported state Default, expected Overdue"
  });
});

test("runHarnessState: an invalid step reported by the page and a page without the step bridge fail the state", async () => {
  const fake = fakeStatePage();
  const invalid = await runHarnessState(
    fake.page,
    stateInput(fake, { pageState: { name: "Menu open", names: [], steps: [{ action: "drag" }] } })
  );
  assert.ok(!invalid.ok);
  assert.equal(invalid.kind, "step_failed");
  const noBridge = fakeStatePage({ bridge: false });
  const result = await runHarnessState(noBridge.page, stateInput(noBridge));
  assert.deepEqual(result, {
    ok: false,
    kind: "step_failed",
    detail:
      'State "Menu open", step 1 (click role=button "More actions"): the harness page cannot run steps (no step runtime).'
  });
});

test("runHarnessState stops on cancellation", async () => {
  const fake = fakeStatePage();
  const controller = new AbortController();
  controller.abort("cancelled");
  const result = await runHarnessState(fake.page, stateInput(fake, { signal: controller.signal }));
  assert.deepEqual(result, { ok: false, kind: "cancelled", detail: "Cancelled." });
});
