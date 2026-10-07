/**
 * Step runtime integration test (16 §7.5, §20.2): loads the static template `harness-templates/shared/prvision-steps.ts`
 * (transpiled with typescript.transpileModule; the backend has no esbuild) into real Chromium over static HTML and
 * checks target resolution, visibility rules, nth, portals and the live replay. Gated on PRVISION_IT_RENDER=1.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import ts from "typescript";
import { HARNESS_TEMPLATES_DIR } from "../../../backend/src/config-consts/render.config";
import { itSkip } from "./helpers/it-flags";

const SKIP = itSkip("render");

const RUNTIME = ts.transpileModule(
  fs.readFileSync(path.join(HARNESS_TEMPLATES_DIR, "shared", "prvision-steps.ts"), "utf8"),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }
).outputText;

const FIXTURE = `<!doctype html>
<html><head><style>.hidden{display:none}.invisible{visibility:hidden}.zero{width:0;height:0;padding:0;border:0;overflow:hidden;display:block}</style></head>
<body>
<div id="prvision-root">
  <button id="b-text">More actions</button>
  <button id="b-aria" aria-label="Close dialog">×</button>
  <span id="lbl">Archive project</span><button id="b-labelledby" aria-labelledby="lbl">A</button>
  <a id="link" href="/docs">Docs</a>
  <a id="no-href">Not a link</a>
  <label for="email">Email</label><input id="email" type="email">
  <label id="wrap">Full name <input id="name"></label>
  <input id="search" type="search" placeholder="Search orders">
  <input id="submit" type="submit" value="Send now">
  <input id="check" type="checkbox" title="Remember me">
  <select id="combo"><option>One</option></select>
  <textarea id="notes" placeholder="Notes"></textarea>
  <img id="logo" alt="Company logo" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" width="10" height="10">
  <h2 id="heading">Invoices</h2>
  <table><tr id="row"><td id="cell">Paid</td></tr></table>
  <div id="custom" role="tab switch">Overview</div>
  <div id="outer"><span id="inner">Show details</span></div>
  <div id="t1" data-testid="row-menu">Row 1</div><div id="t2" data-testid="row-menu">Row 2</div>
  <div class="hidden"><button id="h-display">Hidden button</button></div>
  <div aria-hidden="true"><button id="h-aria">Aria hidden</button></div>
  <div inert><button id="h-inert">Inert button</button></div>
  <button id="h-visibility" class="invisible">Invisible button</button>
  <button id="h-zero" class="zero">Zero button</button>
  <div aria-hidden="true"><div role="dialog" id="dialog">Dialog body</div></div>
  <button id="dup1">Duplicate</button><button id="dup2">Duplicate</button>
  <button id="toggle" onclick="document.getElementById('menu').hidden = false">Open menu</button>
  <ul id="menu" hidden><li><button id="menu-item">Rename</button></li></ul>
  <input id="typed" placeholder="Type here">
  <button id="focus-me">Focus me</button>
  <div id="keys" tabindex="0" role="button" aria-label="Key target" style="width:20px;height:20px"></div>
</div>
<div id="portal"><button id="portal-btn">Portal button</button></div>
<script>
  document.getElementById('keys').addEventListener('keydown', (e) => { e.target.setAttribute('data-key', e.key); });
</script>
</body></html>`;

describe("prvision-steps runtime in Chromium (16 §7.5)", () => {
  let browser: Browser | null = null;
  let page: Page | null = null;

  before(async () => {
    if (SKIP !== false) {
      return;
    }
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent(FIXTURE);
    await page.addScriptTag({
      type: "module",
      content: `${RUNTIME}\nwindow.__steps = { findStepTargets, markStepTarget, runStepsInPage, installStepBridge };\ninstallStepBridge();\nwindow.__stepsReady = true;`
    });
    await page.waitForFunction("window.__stepsReady === true");
  });

  after(async () => {
    await browser?.close();
  });

  /** The page has no DOM typings here: every in-page call is a script string. */
  async function run(expression: string): Promise<unknown> {
    assert.ok(page);
    return page.evaluate(expression);
  }

  async function ids(target: Record<string, unknown>): Promise<string[]> {
    const found = await run(`window.__steps.findStepTargets(${JSON.stringify(target)}).map((e) => e.id)`);
    assert.ok(Array.isArray(found));
    return found.map(String);
  }

  const mark = (target: Record<string, unknown>, token: string): Promise<unknown> =>
    run(`window.__PRVISION_MARK_STEP_TARGET__(${JSON.stringify(target)}, ${JSON.stringify(token)})`);

  test("every target form resolves", { skip: SKIP }, async () => {
    assert.deepEqual(await ids({ by: "role", role: "button", name: "More actions" }), ["b-text"]);
    assert.deepEqual(await ids({ by: "text", text: "show details" }), ["inner"], "innermost match, case-insensitive");
    assert.deepEqual(await ids({ by: "label", label: "Email" }), ["email"]);
    assert.deepEqual(await ids({ by: "label", label: "Full name" }), ["name"]);
    assert.deepEqual(await ids({ by: "placeholder", placeholder: "search ORDERS" }), ["search"]);
    assert.deepEqual(await ids({ by: "testId", testId: "row-menu" }), ["t1", "t2"]);
    assert.deepEqual(await ids({ by: "testId", testId: "ROW-MENU" }), [], "test ids are exact");
  });

  test("implicit roles and accessible-name sources", { skip: SKIP }, async () => {
    assert.deepEqual(await ids({ by: "role", role: "button", name: "Close dialog" }), ["b-aria"], "aria-label");
    assert.deepEqual(await ids({ by: "role", role: "button", name: "Archive project" }), ["b-labelledby"]);
    assert.deepEqual(await ids({ by: "role", role: "link", name: "Docs" }), ["link"]);
    assert.deepEqual(await ids({ by: "role", role: "link", name: "Not a link" }), [], "a without href");
    assert.deepEqual(await ids({ by: "role", role: "textbox", name: "Email" }), ["email"], "label[for]");
    assert.deepEqual(await ids({ by: "role", role: "textbox", name: "Full name" }), ["name"], "wrapping label");
    assert.deepEqual(await ids({ by: "role", role: "searchbox", name: "Search orders" }), ["search"], "placeholder");
    assert.deepEqual(await ids({ by: "role", role: "button", name: "Send now" }), ["submit"], "input button value");
    assert.deepEqual(await ids({ by: "role", role: "checkbox", name: "Remember me" }), ["check"], "title");
    assert.deepEqual(await ids({ by: "role", role: "combobox", name: "One" }), ["combo"]);
    assert.deepEqual(await ids({ by: "role", role: "textbox", name: "Notes" }), ["notes"]);
    assert.deepEqual(await ids({ by: "role", role: "img", name: "Company logo" }), ["logo"], "alt");
    assert.deepEqual(await ids({ by: "role", role: "heading", name: "Invoices" }), ["heading"]);
    assert.deepEqual(await ids({ by: "role", role: "row", name: "Paid" }), ["row"]);
    assert.deepEqual(await ids({ by: "role", role: "cell", name: "Paid" }), ["cell"]);
    assert.deepEqual(
      await ids({ by: "role", role: "tab", name: "Overview" }),
      ["custom"],
      "explicit role, first token"
    );
  });

  test(
    "visibility rules: display none, aria-hidden, inert, visibility hidden and zero size are skipped",
    { skip: SKIP },
    async () => {
      for (const name of ["Hidden button", "Aria hidden", "Inert button", "Invisible button", "Zero button"]) {
        assert.deepEqual(await ids({ by: "role", role: "button", name }), [], name);
      }
      assert.deepEqual(
        await ids({ by: "role", role: "dialog", name: "Dialog body" }),
        ["dialog"],
        "a dialog target ignores aria-hidden"
      );
    }
  );

  test("nth picks among visible matches and portals are included", { skip: SKIP }, async () => {
    assert.ok(page);
    assert.deepEqual(await ids({ by: "role", role: "button", name: "Duplicate" }), ["dup1", "dup2"]);
    const marked = await mark({ by: "role", role: "button", name: "Duplicate", nth: 1 }, "s0");
    assert.deepEqual(marked, { found: true, count: 2 });
    assert.equal(await page.getAttribute("#dup2", "data-prvision-step-target"), "s0");
    await mark({ by: "role", role: "button", name: "Duplicate" }, "s0");
    assert.equal(
      await page.getAttribute("#dup2", "data-prvision-step-target"),
      null,
      "older marks with the token are removed"
    );
    assert.equal(await page.getAttribute("#dup1", "data-prvision-step-target"), "s0");
    const missing = await mark({ by: "role", role: "button", name: "Duplicate", nth: 5 }, "s9");
    assert.deepEqual(missing, { found: false, count: 2 });
    assert.deepEqual(await ids({ by: "text", text: "Portal button" }), ["portal-btn"]);
  });

  test("live replay: click, focus, type and press run; hover is skipped and reported", { skip: SKIP }, async () => {
    assert.ok(page);
    const steps = [
      { action: "click", target: { by: "role", role: "button", name: "Open menu" } },
      { action: "waitFor", target: { by: "role", role: "button", name: "Rename" } },
      { action: "hover", target: { by: "role", role: "button", name: "Rename" } },
      { action: "type", target: { by: "placeholder", placeholder: "Type here" }, text: "abc" },
      { action: "focus", target: { by: "role", role: "button", name: "Focus me" } },
      { action: "press", key: "Enter", target: { by: "role", role: "button", name: "Key target" } }
    ];
    const report = await run(`(async () => {
      let settled = 0;
      const result = await window.__steps.runStepsInPage(${JSON.stringify(steps)}, async () => { settled += 1; }, { timeoutMs: 1000 });
      return { result, settled, typed: document.getElementById("typed").value };
    })()`);
    assert.deepEqual(report, {
      result: {
        replayed: 5,
        skipped: [
          { index: 2, action: "hover", reason: "hover cannot be replayed in live mode; point at the element yourself" }
        ]
      },
      settled: 1,
      typed: "abc"
    });
    assert.equal(await page.getAttribute("#keys", "data-key"), "Enter");
    assert.equal(await page.isVisible("#menu-item"), true);
  });

  test("live replay never throws and reports a missing target", { skip: SKIP }, async () => {
    assert.ok(page);
    const steps = [
      { action: "click", target: { by: "text", text: "Does not exist" } },
      { action: "focus", target: { by: "role", role: "button", name: "Focus me" } }
    ];
    const result = await run(
      `window.__steps.runStepsInPage(${JSON.stringify(steps)}, async () => undefined, { timeoutMs: 200 })`
    );
    assert.deepEqual(result, {
      replayed: 0,
      skipped: [
        { index: 0, action: "click", reason: 'no visible text "Does not exist" matched' },
        { index: 1, action: "focus", reason: "an earlier step could not run" }
      ]
    });
  });
});
