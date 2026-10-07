import assert from "node:assert/strict";
import { test } from "node:test";
import { ANALYSIS_MAX_CANDIDATES, MAX_COMPONENTS } from "../../../../backend/src/config-consts";
import { Table } from "../../../../backend/src/enums";
import { PipelineStepError } from "../../../../backend/src/types/visualization-pipeline";
import { stubPersistence } from "../change-analysis/helpers/worktree-fixture";
import { APP, APP_DIR, MAIN_FILES, SRC, analyzeAngular, rows, withChanges } from "./helpers/angular-analysis-fixture";

const BADGE = `${APP_DIR}/shared/badge/badge.component`;
const ORDER_LIST = `${APP_DIR}/orders/order-list/order-list.component`;
const MAIN = MAIN_FILES;

function file(path: string): string {
  const content = MAIN[path];
  assert.ok(content !== undefined, `fixture has ${path}`);
  return content;
}

test("AngularChangeAnalysisService.analyze maps a changed template and style to the owner and reaches parents through the selector", async (t) => {
  const head = withChanges({
    [`${BADGE}.html`]: '<span class="badge rounded" [class.warn]="tone === \'warn\'">{{ label }}!</span>\n',
    [`${BADGE}.css`]: ".badge { color: red; }\n"
  });
  const { result, ctx } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(rows(result), [
    [0, "BadgeComponent", "modified", `Template changed: ${BADGE}.html`],
    [1, "OrderListComponent", "affected_parent", "Uses changed component BadgeComponent (app-badge) in its template"]
  ]);
  const badge = result.candidates[0];
  assert.equal(badge?.filePath, `${BADGE}.ts`);
  assert.equal(badge.exportName, "BadgeComponent");
  const diff = badge.codeDiff ?? "";
  assert.ok(diff.indexOf(`diff --git a/${BADGE}.html`) >= 0, "template diff present");
  assert.ok(
    diff.indexOf(`diff --git a/${BADGE}.css`) > diff.indexOf(`${BADGE}.html`),
    "style diff after template diff"
  );
  assert.equal(result.candidates[1]?.codeDiff, null);
  assert.ok(
    ctx.consoleEvents.some((e) =>
      /Angular workspace apps\/web, project web: \d+ components indexed on head/.test(e.message)
    )
  );
});

test("AngularChangeAnalysisService.analyze reports a changed component class as modified with its TS diff first", async (t) => {
  const head = withChanges({
    [`${BADGE}.ts`]: file(`${BADGE}.ts`).replace('= "info";', '= "warn";'),
    [`${BADGE}.html`]: '<b class="badge">{{ label }}</b>\n'
  });
  const { result } = await analyzeAngular(t, MAIN, head);
  const badge = result.candidates.find((c) => c.displayName === "BadgeComponent");
  assert.equal(badge?.changeKind, "modified");
  const diff = badge.codeDiff ?? "";
  assert.ok(diff.startsWith(`diff --git a/${BADGE}.ts`), "TS diff first");
  assert.ok(diff.includes(`diff --git a/${BADGE}.html`), "then the template diff");
});

test("AngularChangeAnalysisService.analyze reports Component code changed when only the class changed", async (t) => {
  const head = withChanges({ [`${BADGE}.ts`]: file(`${BADGE}.ts`).replace('= "info";', '= "warn";') });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(rows(result)[0], [0, "BadgeComponent", "modified", "Component code changed"]);
});

test("AngularChangeAnalysisService.analyze ignores formatting-only TS and template changes", async (t) => {
  const head = withChanges({
    [`${BADGE}.ts`]: file(`${BADGE}.ts`).replace(
      "@Input() label!: string;",
      "@Input()   label!:    string; // reformatted"
    ),
    [`${ORDER_LIST}.html`]: file(`${ORDER_LIST}.html`)
      .split("\n")
      .map((line) => `    ${line.trim()}`)
      .join("\n")
      .replace('<app-badge [label]="order.status" tone="info" />', '<app-badge tone="info"   [label]="order.status"/>')
  });
  const { result, ctx } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.changedFiles.length, 2);
  assert.ok(ctx.consoleEvents.some((e) => e.message === "No Angular components are affected by this change."));
});

test("AngularChangeAnalysisService.analyze ignores whitespace-only inline template changes and detects real ones", async (t) => {
  const path = `${APP_DIR}/shared/signal-card/signal-card.component.ts`;
  const reflowed = file(path).replace("<h2>{{ title() }}</h2>", "\n      <h2>{{title()}}</h2>\n   ");
  const { result: formatting } = await analyzeAngular(t, MAIN, withChanges({ [path]: reflowed }));
  assert.deepEqual(formatting.candidates, []);
  const changed = file(path).replace("<h2>{{ title() }}</h2>", "<h3>{{ title() }}</h3>");
  const { result } = await analyzeAngular(t, MAIN, withChanges({ [path]: changed }));
  assert.deepEqual(rows(result), [[0, "SignalCardComponent", "modified", "Component code changed"]]);
});

test("AngularChangeAnalysisService.analyze maps a changed SCSS partial to the components using it", async (t) => {
  const head = withChanges({ [`${APP_DIR}/styles/_variables.scss`]: "$gap: 12px;\n" });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(rows(result)[0], [
    0,
    "OrderListComponent",
    "modified",
    `Uses changed stylesheet ${APP_DIR}/styles/_variables.scss`
  ]);
  assert.ok(result.candidates[0]?.codeDiff?.includes("_variables.scss"), "the partial diff is part of the code diff");
});

test("AngularChangeAnalysisService.analyze reports Styles changed for a style-only change", async (t) => {
  const head = withChanges({ [`${ORDER_LIST}.scss`]: '@use "../../styles/variables" as v;\n.orders { gap: 2px; }\n' });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(rows(result)[0], [0, "OrderListComponent", "modified", `Styles changed: ${ORDER_LIST}.scss`]);
});

test("AngularChangeAnalysisService.analyze reaches components that inject a changed service", async (t) => {
  const path = `${APP_DIR}/orders/orders.service.ts`;
  const head = withChanges({ [path]: file(path).replace('"/orders"', '"/orders?expand=items"') });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(rows(result), [[0, "OrderListComponent", "affected_parent", `Injects changed service ${path}`]]);
});

test("AngularChangeAnalysisService.analyze reaches template users of an NgModule-declared component", async (t) => {
  const html = `${APP_DIR}/shared/legacy-chip/legacy-chip.component.html`;
  const head = withChanges({ [html]: '<span class="chip chip--new">{{ text }}</span>\n' });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(rows(result), [
    [0, "LegacyChipComponent", "modified", `Template changed: ${html}`],
    [
      1,
      "OrderSummaryComponent",
      "affected_parent",
      "Uses changed component LegacyChipComponent (app-legacy-chip) in its template"
    ]
  ]);
});

test("AngularChangeAnalysisService.analyze reaches template users of a changed pipe and directive", async (t) => {
  const pipe = `${APP_DIR}/shared/pipes/money.pipe.ts`;
  const directive = `${APP_DIR}/shared/directives/highlight.directive.ts`;
  const { result: pipeRun } = await analyzeAngular(
    t,
    MAIN,
    withChanges({ [pipe]: file(pipe).replace('"$"', '"USD "') })
  );
  assert.deepEqual(rows(pipeRun), [[0, "OrderListComponent", "affected_parent", "Uses changed pipe money"]]);
  const { result: directiveRun } = await analyzeAngular(
    t,
    MAIN,
    withChanges({ [directive]: file(directive).replace('class: "highlight"', 'class: "highlight strong"') })
  );
  assert.deepEqual(rows(directiveRun), [
    [0, "OrderListComponent", "affected_parent", "Uses changed directive [appHighlight]"]
  ]);
});

test("AngularChangeAnalysisService.analyze reports new and removed component files", async (t) => {
  const added = `${APP_DIR}/shared/tag/tag.component.ts`;
  const head = withChanges({
    [added]: `import { Component } from "@angular/core";\n@Component({ selector: "app-tag", template: "<i>tag</i>" })\nexport class TagComponent {}\n`,
    [`${APP_DIR}/notifications/notification-bell.component.ts`]: null
  });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(
    rows(result).map(([, name, kind, reason]) => [name, kind, reason]),
    [
      ["TagComponent", "added", "New component"],
      ["NotificationBellComponent", "removed", "Component removed"]
    ]
  );
  const removed = result.candidates.find((c) => c.changeKind === "removed");
  assert.equal(removed?.filePath, `${APP_DIR}/notifications/notification-bell.component.ts`);
  assert.ok(removed.codeDiff?.includes("+++ /dev/null") ?? false);
});

test("AngularChangeAnalysisService.analyze follows a renamed component file", async (t) => {
  const from = `${APP_DIR}/notifications/notification-bell.component.ts`;
  const to = `${APP_DIR}/notifications/bell/notification-bell.component.ts`;
  const content = file(from)
    .replace("./poller.service", "../poller.service")
    .replace("<button>", '<button class="bell">');
  const head = withChanges({ [from]: null, [to]: content });
  const { result } = await analyzeAngular(t, MAIN, head, {
    entries: [{ status: "R", path: to, previousPath: from }]
  });
  assert.deepEqual(rows(result), [[0, "NotificationBellComponent", "modified", "Component code changed"]]);
  assert.equal(result.candidates[0]?.filePath, to);
  assert.deepEqual(result.changedFiles, [{ path: to, status: "R", previousPath: from }]);
  assert.deepEqual(await result.sourceQueries.componentPaths(to), { base: from, head: to });
});

// 00 §17 (revision 5) turned this case from "added + removed" into one `replaced` row: git reports the rename and
// the class names share a stem in one folder. It is still never "modified" (the base build would import a class
// that does not exist there).
test("AngularChangeAnalysisService.analyze reports a component renamed with its class and template as replaced, not modified", async (t) => {
  const dir = `${APP_DIR}/shared/badge`;
  const ts = file(`${dir}/badge.component.ts`)
    .replace("export class BadgeComponent", "export class BadgeModalComponent")
    .replace("./badge.component.html", "./badge-modal.component.html")
    .replace("./badge.component.css", "./badge-modal.component.css");
  const html = file(`${dir}/badge.component.html`).replace('class="badge"', 'class="badge modal"');
  const head = withChanges({
    [`${dir}/badge.component.ts`]: null,
    [`${dir}/badge.component.html`]: null,
    [`${dir}/badge.component.css`]: null,
    [`${dir}/badge-modal.component.ts`]: ts,
    [`${dir}/badge-modal.component.html`]: html,
    [`${dir}/badge-modal.component.css`]: file(`${dir}/badge.component.css`)
  });
  const { result } = await analyzeAngular(t, MAIN, head, {
    entries: [
      { status: "R", path: `${dir}/badge-modal.component.ts`, previousPath: `${dir}/badge.component.ts` },
      { status: "R", path: `${dir}/badge-modal.component.html`, previousPath: `${dir}/badge.component.html` },
      { status: "R", path: `${dir}/badge-modal.component.css`, previousPath: `${dir}/badge.component.css` }
    ]
  });
  const kinds = new Map(rows(result).map(([, name, kind]) => [name, kind]));
  assert.equal(kinds.get("BadgeModalComponent"), "replaced");
  assert.equal(kinds.has("BadgeComponent"), false, "R is no longer a separate removed row");
  const replaced = result.candidates.find((candidate) => candidate.displayName === "BadgeModalComponent");
  assert.equal(replaced?.filePath, `${dir}/badge-modal.component.ts`);
  assert.deepEqual(
    {
      filePath: replaced.predecessor?.filePath,
      exportName: replaced.predecessor?.exportName,
      displayName: replaced.predecessor?.displayName
    },
    { filePath: `${dir}/badge.component.ts`, exportName: "BadgeComponent", displayName: "BadgeComponent" }
  );
  assert.deepEqual(
    replaced.predecessor?.evidence.map((item) => item.kind),
    ["git_rename", "name_similarity", "content_similarity"]
  );
});

test("AngularChangeAnalysisService.analyze reports per-class candidates for two components in one file", async (t) => {
  const path = `${APP_DIR}/shared/pair.component.ts`;
  const two = (a: string, b: string): string =>
    `import { Component } from "@angular/core";\n@Component({ selector: "app-a", template: "<i>${a}</i>" })\nexport class AComponent {}\n@Component({ selector: "app-b", template: "<i>${b}</i>" })\nexport class BComponent {}\n`;
  const base = withChanges({ [path]: two("a", "b") });
  const { result } = await analyzeAngular(t, base, withChanges({ [path]: two("a", "B!") }, base));
  assert.deepEqual(rows(result), [[0, "BComponent", "modified", "Component code changed"]]);
  assert.equal(result.candidates[0]?.exportName, "BComponent");
});

test("AngularChangeAnalysisService.analyze reports a global stylesheet change in globalStyleChanges and adds no representative rows (16 §8.5.4)", async (t) => {
  const host = `${APP_DIR}/shared/badge-host.component.ts`;
  const base = withChanges({
    [host]: `import { Component } from "@angular/core";\nimport { BadgeComponent } from "./badge/badge.component";\n@Component({ selector: "app-badge-host", imports: [BadgeComponent], template: '<app-badge label="a" /><app-badge label="b" />' })\nexport class BadgeHostComponent {}\n`
  });
  const head = withChanges({ [`${SRC}/styles.css`]: '@import "./styles/base.css";\n.card { padding: 2rem; }\n' }, base);
  const { result, ctx } = await analyzeAngular(t, base, head);
  assert.deepEqual(result.candidates, [], "no representative rows: library resolution re-checks the saved harnesses");
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.globalStyleChanges, [`${SRC}/styles.css`]);
  assert.deepEqual(result.changedFiles, [{ path: `${SRC}/styles.css`, status: "M" }]);
  assert.equal(
    ctx.consoleEvents.some((e) => e.message.startsWith("Global change: showing")),
    false,
    "no representative console line"
  );
});

test("AngularChangeAnalysisService.analyze treats a partial of a global stylesheet as a global style", async (t) => {
  const head = withChanges({ [`${SRC}/styles/base.css`]: "body { margin: 4px; }\n" });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(result.globalStyleChanges, [`${SRC}/styles/base.css`]);
  assert.deepEqual(result.candidates, []);
});

test("AngularChangeAnalysisService.analyze adds no rows for angular.json, tailwind config or index.html; they stay in changedFiles for the trigger check", async (t) => {
  const head = withChanges({ [`${APP}/tailwind.config.js`]: "module.exports = { content: [] };\n" });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.globalStyleChanges, [], "a config file is a trigger (16 §8.5.1), not a global stylesheet");
  assert.deepEqual(result.changedFiles, [{ path: `${APP}/tailwind.config.js`, status: "M" }]);
  const { result: tsconfig } = await analyzeAngular(
    t,
    MAIN,
    withChanges({ [`${APP}/tsconfig.json`]: JSON.stringify({ compilerOptions: { strict: true } }) })
  );
  assert.deepEqual(tsconfig.candidates, []);
  const { result: index } = await analyzeAngular(
    t,
    MAIN,
    withChanges({ [`${SRC}/index.html`]: "<!doctype html><html><body><app-root></app-root><!-- y --></body></html>\n" })
  );
  assert.deepEqual(index.candidates, [], "index.html produces no candidates");
  assert.deepEqual(index.changedFiles, [{ path: `${SRC}/index.html`, status: "M" }]);
});

test("AngularChangeAnalysisService.analyze maps a changed asset to templates that reference it", async (t) => {
  const asset = `${SRC}/assets/logo.svg`;
  const head = withChanges({ [asset]: '<svg xmlns="http://www.w3.org/2000/svg"><circle r="1"/></svg>\n' });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(rows(result), [[0, "AppComponent", "affected_parent", `References changed asset ${asset}`]]);
});

test("AngularChangeAnalysisService.analyze ignores files outside the app and the build index", async (t) => {
  const head = withChanges({
    "README.md": "# changed\n",
    [`${SRC}/index.html`]: "<!doctype html><html><body><app-root></app-root><!-- x --></body></html>\n",
    [`${ORDER_LIST}.spec.ts`]: file(`${ORDER_LIST}.spec.ts`).replace("describe(", "describe.skip(")
  });
  const { result } = await analyzeAngular(t, MAIN, head);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.changedFiles.length, 3);
});

function bulkComponents(count: number): { base: Record<string, string>; head: Record<string, string> } {
  const extra: Record<string, string> = {};
  const changed: Record<string, string> = {};
  for (let index = 0; index < count; index++) {
    const path = `${APP_DIR}/bulk/c${String(index).padStart(3, "0")}.component.ts`;
    const body = (text: string): string =>
      `import { Component } from "@angular/core";\n@Component({ selector: "app-c${String(index)}", template: "<i>${text}</i>" })\nexport class C${String(index)}Component {}\n`;
    extra[path] = body("a");
    changed[path] = body("b");
  }
  const base = withChanges(extra);
  return { base, head: withChanges(changed, base) };
}

test("AngularChangeAnalysisService.analyze ranks with 08's rankAndCap and no longer caps at MAX_COMPONENTS (16 E10)", async (t) => {
  const { base, head } = bulkComponents(MAX_COMPONENTS + 2);
  const persistence = stubPersistence();
  const { result } = await analyzeAngular(t, base, head, { persistence });
  assert.equal(result.candidates.length, MAX_COMPONENTS + 2);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(
    result.candidates.map((c) => c.rank),
    Array.from({ length: MAX_COMPONENTS + 2 }, (_, index) => index)
  );
  const inserted = persistence.inserted[0] ?? [];
  assert.equal(inserted.length, MAX_COMPONENTS + 2);
  assert.equal(inserted.filter((row) => row.renderStatus === "skipped").length, 0);
});

test("AngularChangeAnalysisService.analyze caps at the analysis ceiling ANALYSIS_MAX_CANDIDATES (500)", async (t) => {
  const { base, head } = bulkComponents(ANALYSIS_MAX_CANDIDATES + 1);
  const persistence = stubPersistence();
  const { result, ctx } = await analyzeAngular(t, base, head, { persistence });
  assert.equal(result.candidates.length, ANALYSIS_MAX_CANDIDATES);
  assert.equal(result.skipped.length, 1);
  assert.equal(
    result.skipped[0]?.skipReason,
    "over_limit: ranked 501 of 501; PRVision analyses at most 500 components per visualization"
  );
  assert.ok(ctx.consoleEvents.some((e) => e.message === "1 components were skipped (limit 500)."));
  const inserted = persistence.inserted[0] ?? [];
  assert.equal(inserted.length, ANALYSIS_MAX_CANDIDATES + 1);
  assert.equal(inserted.filter((row) => row.renderStatus === "skipped").length, 1);
});

test("AngularChangeAnalysisService.analyze persists rows through the shared helper", async (t) => {
  const head = withChanges({ [`${BADGE}.css`]: ".badge { color: red; }\n" });
  const persistence = stubPersistence();
  const { result } = await analyzeAngular(t, MAIN, head, { persistence });
  assert.equal(persistence.transactions, 1);
  assert.deepEqual(persistence.deleted, [{ visualizationId: 1 }]);
  const inserted = persistence.inserted[0] ?? [];
  assert.deepEqual(
    inserted.map((row) => [row.filePath, row.exportName, row.changeKind, row.renderStatus, row.rank, row.changeReason]),
    [
      [`${BADGE}.ts`, "BadgeComponent", "modified", "pending", 0, `Styles changed: ${BADGE}.css`],
      [
        `${ORDER_LIST}.ts`,
        "OrderListComponent",
        "affected_parent",
        "pending",
        1,
        "Uses changed component BadgeComponent (app-badge) in its template"
      ]
    ]
  );
  assert.deepEqual(persistence.updates, [
    { values: { componentCount: 2 }, conditions: { id: 1 }, table: Table.VISUALIZATIONS }
  ]);
  // ids are mapped by key (the stub echoes rows in reverse order with ids 100, 101)
  assert.deepEqual(
    result.candidates.map((c) => c.componentId),
    [100, 101]
  );
});

test("AngularChangeAnalysisService.analyze stops at the cancellation checkpoint", async (t) => {
  const head = withChanges({ [`${BADGE}.css`]: ".badge { color: red; }\n" });
  let caught: unknown;
  try {
    await analyzeAngular(t, MAIN, head, { tweak: (ctx) => ctx.cancel() });
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof PipelineStepError);
  assert.equal(caught.code, "ANALYSIS_CANCELLED");
  assert.equal(caught.stage, "analyzing");
});

test("AngularChangeAnalysisService.analyze fails with ANALYSIS_WORKTREE_MISSING when a worktree is gone", async (t) => {
  let caught: unknown;
  try {
    await analyzeAngular(t, MAIN, MAIN, {
      tweak: (ctx) => {
        ctx.workspace.baseDir = "/nonexistent/prvision/base";
      }
    });
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof PipelineStepError);
  assert.equal(caught.code, "ANALYSIS_WORKTREE_MISSING");
});

test("AngularChangeAnalysisService.analyze maps persistence failures to ANALYSIS_PERSIST_FAILED", async (t) => {
  const head = withChanges({ [`${BADGE}.css`]: ".badge { color: red; }\n" });
  const persistence = stubPersistence({ insertThrows: true });
  let caught: unknown;
  try {
    await analyzeAngular(t, MAIN, head, { persistence });
  } catch (error: unknown) {
    caught = error;
  }
  assert.ok(caught instanceof PipelineStepError);
  assert.equal(caught.code, "ANALYSIS_PERSIST_FAILED");
  assert.equal(persistence.rolledBack, 1);
});
