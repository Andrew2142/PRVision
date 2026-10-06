/**
 * Angular successor matching through AngularChangeAnalysisService (00 §17): a template call-site swap of selectors
 * (the TS import swap of the same component is not counted twice), git renames, similar class names and templates,
 * one-to-one pairing of two replacements, and no pairing of unrelated components.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileMap } from "../change-analysis/helpers/worktree-fixture";
import { APP_DIR, MAIN_FILES, analyzeAngular, rows, withChanges } from "./helpers/angular-analysis-fixture";

const ORDERS = `${APP_DIR}/orders`;
const ORDER_LIST = `${ORDERS}/order-list/order-list.component`;

const form = (name: string, selector: string, klass: string, heading: string, extraClass = ""): string =>
  `import { Component, EventEmitter, Output } from "@angular/core";

@Component({
  selector: "${selector}",
  templateUrl: "./${name}.component.html"
})
export class ${klass} {
  @Output() saved = new EventEmitter<string>();
  heading = "${heading}";
}
`.replace("export class", `${extraClass}export class`);

const FORM_HTML = `<form class="space-y-3 rounded border p-4">
  <label class="block text-sm font-medium">Note</label>
  <textarea class="w-full rounded border p-2" name="note"></textarea>
  <button type="button" class="rounded bg-indigo-600 px-3 py-1 text-white" (click)="saved.emit('x')">Save note</button>
</form>
`;
const MODAL_HTML = `<div class="rounded-xl shadow-lg" role="dialog">
  <h2 class="px-4 pt-4 text-lg font-semibold">{{ heading }}</h2>
${FORM_HTML}</div>
`;

/** OrderList that imports and renders `klass` (selector `selector`). */
function orderListWith(klass: string, file: string, selector: string): Record<string, string> {
  const ts = MAIN_FILES[`${ORDER_LIST}.ts`] ?? "";
  const html = MAIN_FILES[`${ORDER_LIST}.html`] ?? "";
  return {
    [`${ORDER_LIST}.ts`]: ts
      .replace(
        'import { Order, OrdersService } from "../orders.service";',
        `import { Order, OrdersService } from "../orders.service";\nimport { ${klass} } from "../${file}/${file}.component";`
      )
      .replace(
        "imports: [BadgeComponent, MoneyPipe, HighlightDirective]",
        `imports: [BadgeComponent, MoneyPipe, HighlightDirective, ${klass}]`
      ),
    [`${ORDER_LIST}.html`]: `${html}<${selector} />\n`
  };
}

const BASE: FileMap = withChanges({
  [`${ORDERS}/note-form/note-form.component.ts`]: form("note-form", "app-note-form", "NoteFormComponent", "Note"),
  [`${ORDERS}/note-form/note-form.component.html`]: FORM_HTML,
  ...orderListWith("NoteFormComponent", "note-form", "app-note-form")
});

const HEAD: FileMap = withChanges(
  {
    [`${ORDERS}/note-form/note-form.component.ts`]: null,
    [`${ORDERS}/note-form/note-form.component.html`]: null,
    [`${ORDERS}/note-form-modal/note-form-modal.component.ts`]: form(
      "note-form-modal",
      "app-note-form-modal",
      "NoteFormModalComponent",
      "New note"
    ),
    [`${ORDERS}/note-form-modal/note-form-modal.component.html`]: MODAL_HTML,
    ...orderListWith("NoteFormModalComponent", "note-form-modal", "app-note-form-modal")
  },
  BASE
);

test("AngularChangeAnalysisService.analyze pairs a removed form and its -modal successor from the selector swap", async (t) => {
  const { result, ctx, persistence } = await analyzeAngular(t, BASE, HEAD);
  assert.deepEqual(rows(result), [
    [
      0,
      "NoteFormModalComponent",
      "replaced",
      "Replaced by NoteFormModalComponent (call site swap in order-list, similar name, similar markup)"
    ],
    [1, "OrderListComponent", "modified", "Component code changed"],
    [2, "AppComponent", "affected_parent", "Uses changed component OrderListComponent (app-order-list) in its template"]
  ]);
  const replaced = result.candidates[0];
  assert.equal(replaced?.filePath, `${ORDERS}/note-form-modal/note-form-modal.component.ts`);
  assert.equal(replaced.exportName, "NoteFormModalComponent");
  assert.deepEqual(replaced.predecessor, {
    filePath: `${ORDERS}/note-form/note-form.component.ts`,
    exportName: "NoteFormComponent",
    displayName: "NoteFormComponent",
    evidence: [
      {
        kind: "call_site_swap",
        detail: `${ORDER_LIST}.html: <app-note-form> → <app-note-form-modal>`
      },
      {
        kind: "name_similarity",
        detail: `NoteFormComponent → NoteFormModalComponent: one name contains the other, both in ${ORDERS}`
      },
      { kind: "content_similarity", detail: "template tokens 70% alike" }
    ]
  });
  // the code diff compares R's class and template with A's
  const diff = replaced.codeDiff ?? "";
  assert.ok(
    diff.includes(
      `diff --git a/${ORDERS}/note-form/note-form.component.ts b/${ORDERS}/note-form-modal/note-form-modal.component.ts`
    ),
    diff
  );
  assert.ok(
    diff.includes(
      `diff --git a/${ORDERS}/note-form/note-form.component.html b/${ORDERS}/note-form-modal/note-form-modal.component.html`
    ),
    diff
  );
  const row = persistence.inserted.flat().find((inserted) => inserted.changeKind === "replaced");
  assert.equal(row?.baseFilePath, `${ORDERS}/note-form/note-form.component.ts`);
  assert.equal(row.baseExportName, "NoteFormComponent");
  assert.equal(row.baseDisplayName, "NoteFormComponent");
  assert.deepEqual(row.successorEvidence, replaced.predecessor.evidence);
  assert.deepEqual(await result.sourceQueries.componentPaths(`${ORDERS}/note-form/note-form.component.ts`), {
    base: `${ORDERS}/note-form/note-form.component.ts`,
    head: null
  });
  assert.deepEqual(
    await result.sourceQueries.componentPaths(`${ORDERS}/note-form-modal/note-form-modal.component.ts`),
    { base: null, head: `${ORDERS}/note-form-modal/note-form-modal.component.ts` }
  );
  assert.ok(
    ctx.consoleEvents.some((event) =>
      event.message.startsWith("NoteFormComponent was replaced by NoteFormModalComponent")
    ),
    JSON.stringify(ctx.consoleEvents)
  );
});

test("AngularChangeAnalysisService.analyze reports git's rename of the component file as evidence", async (t) => {
  const { result } = await analyzeAngular(t, BASE, HEAD, {
    entries: [
      {
        status: "R",
        score: 58,
        path: `${ORDERS}/note-form-modal/note-form-modal.component.ts`,
        previousPath: `${ORDERS}/note-form/note-form.component.ts`
      },
      { status: "D", path: `${ORDERS}/note-form/note-form.component.html` },
      { status: "A", path: `${ORDERS}/note-form-modal/note-form-modal.component.html` },
      { status: "M", path: `${ORDER_LIST}.html` },
      { status: "M", path: `${ORDER_LIST}.ts` }
    ]
  });
  const replaced = result.candidates.find((candidate) => candidate.changeKind === "replaced");
  assert.deepEqual(
    replaced?.predecessor?.evidence.map((item) => item.kind),
    ["call_site_swap", "git_rename", "name_similarity", "content_similarity"]
  );
  assert.equal(
    replaced.predecessor.evidence[1]?.detail,
    `${ORDERS}/note-form/note-form.component.ts → ${ORDERS}/note-form-modal/note-form-modal.component.ts (58% similar)`
  );
  assert.match(replaced.reason, /\(call site swap in order-list, rename, similar name, similar markup\)$/);
});

test("AngularChangeAnalysisService.analyze pairs two replacements one-to-one", async (t) => {
  const base = withChanges(
    {
      [`${ORDERS}/tag-form/tag-form.component.ts`]: form("tag-form", "app-tag-form", "TagFormComponent", "Tag"),
      [`${ORDERS}/tag-form/tag-form.component.html`]: '<form class="tags"><input name="tag" /></form>\n'
    },
    BASE
  );
  const head = withChanges(
    {
      [`${ORDERS}/tag-form/tag-form.component.ts`]: null,
      [`${ORDERS}/tag-form/tag-form.component.html`]: null,
      [`${ORDERS}/tag-form-modal/tag-form-modal.component.ts`]: form(
        "tag-form-modal",
        "app-tag-form-modal",
        "TagFormModalComponent",
        "New tag"
      ),
      [`${ORDERS}/tag-form-modal/tag-form-modal.component.html`]:
        '<div class="modal"><form class="tags"><input name="tag" /></form></div>\n'
    },
    HEAD
  );
  const { result } = await analyzeAngular(t, base, head);
  const pairs = result.candidates
    .filter((candidate) => candidate.changeKind === "replaced")
    .map((candidate) => `${candidate.predecessor?.displayName ?? "?"} → ${candidate.displayName}`)
    .sort();
  assert.deepEqual(pairs, ["NoteFormComponent → NoteFormModalComponent", "TagFormComponent → TagFormModalComponent"]);
  assert.equal(
    result.candidates.some((candidate) => candidate.changeKind === "added" || candidate.changeKind === "removed"),
    false
  );
});

test("AngularChangeAnalysisService.analyze keeps an unrelated removed and added component apart", async (t) => {
  const base = withChanges({
    [`${ORDERS}/note-form/note-form.component.ts`]: form("note-form", "app-note-form", "NoteFormComponent", "Note"),
    [`${ORDERS}/note-form/note-form.component.html`]: FORM_HTML
  });
  const head = withChanges({
    [`${APP_DIR}/insights/trend-chart/trend-chart.component.ts`]: form(
      "trend-chart",
      "app-trend-chart",
      "TrendChartComponent",
      "Trend"
    ),
    [`${APP_DIR}/insights/trend-chart/trend-chart.component.html`]: '<svg class="chart"><rect /></svg>\n'
  });
  const { result } = await analyzeAngular(t, base, head);
  assert.deepEqual(
    result.candidates.map((candidate) => [candidate.displayName, candidate.changeKind]),
    [
      ["TrendChartComponent", "added"],
      ["NoteFormComponent", "removed"]
    ]
  );
});
