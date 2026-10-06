import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import {
  AngularStructuralDiffService,
  locateAngularTemplate
} from "../../../../backend/src/services/visualizations/pipeline/angular/angular-structural-diff-service";
import {
  PipelineStepError,
  type ChangeAnalysisResult,
  type ComponentCandidate,
  type ComponentRenderResult,
  type ComponentSourceQueries,
  type StructuralChange
} from "../../../../backend/src/types/visualization-pipeline";
import { createPipelineContext } from "../../helpers/pipeline-context";
import { VISUALIZATION_ID, failedSide, okSide, recordingQueryHandler } from "../diff-summary/helpers/png-fixtures";

const BASE_DIR = "/worktrees/1/base";
const HEAD_DIR = "/worktrees/1/head";
const TS_PATH = "src/app/badge/badge.component.ts";
const HTML_PATH = "src/app/badge/badge.component.html";

/** A component file with an external template. */
function externalComponent(templateUrl = "./badge.component.html", className = "BadgeComponent"): string {
  return `import { Component, Input } from "@angular/core";

@Component({
  selector: "app-badge",
  standalone: true,
  templateUrl: "${templateUrl}",
  styleUrl: "./badge.component.css"
})
export class ${className} {
  @Input() label = "";
  @Input() count = 0;
}
`;
}

/** A component file with an inline template (backtick literal). */
function inlineComponent(template: string, header = `import { Component } from "@angular/core";`): string {
  return `${header}

@Component({
  selector: "app-badge",
  template: \`${template}\`
})
export class BadgeComponent {}
`;
}

function candidate(componentId: number, overrides: Partial<ComponentCandidate> = {}): ComponentCandidate {
  return {
    componentId,
    filePath: TS_PATH,
    exportName: "BadgeComponent",
    displayName: "BadgeComponent",
    changeKind: "modified",
    rank: componentId,
    codeDiff: null,
    reason: "Template changed: src/app/badge/badge.component.html",
    ...overrides
  };
}

function analysisOf(
  candidates: ComponentCandidate[],
  changedFiles: ChangeAnalysisResult["changedFiles"] = []
): ChangeAnalysisResult {
  return { candidates, skipped: [], changedFiles, sourceQueries: {} as ComponentSourceQueries };
}

function headFailed(componentId: number): ComponentRenderResult {
  return { componentId, base: okSide("base", componentId), head: failedSide("head") };
}

function setupService(files: { base?: Record<string, string>; head?: Record<string, string> }, componentIds: number[]) {
  const db = recordingQueryHandler(componentIds.map((id) => ({ id })));
  const handle = createPipelineContext({
    visualizationId: VISUALIZATION_ID,
    dataDir: "/tmp/unused",
    repositoryPath: "/tmp/repo",
    baseDir: BASE_DIR,
    headDir: HEAD_DIR,
    repository: { framework: "angular", appRoot: ".", angularProject: "app" }
  });
  const reads: string[] = [];
  const service = new AngularStructuralDiffService({
    createQueryHandler: () => db.asQueryHandler(),
    readSource: (root, repoPath) => {
      reads.push(`${root === BASE_DIR ? "base" : "head"}:${repoPath}`);
      const side = root === BASE_DIR ? files.base : files.head;
      return Promise.resolve(side?.[repoPath] ?? null);
    }
  });
  return { db, handle, service, reads };
}

const BADGE_EXPECTED: StructuralChange[] = [
  {
    kind: "attribute_changed",
    path: "span",
    tag: "span",
    attribute: "class",
    before: "badge",
    after: "badge badge-lg",
    tokensAdded: ["badge-lg"],
    tokensRemoved: []
  },
  { kind: "element_added", path: "@if", tag: "@if" }
];

test("AngularStructuralDiffService.compare runs only for components without pixel output", async () => {
  const files = { [TS_PATH]: externalComponent(), [HTML_PATH]: `<span class="badge">{{ label }}</span>` };
  const { db, handle, service } = setupService({ base: files, head: files }, [1, 2]);
  const outcomes = await service.compare(handle.context, {
    renders: [{ componentId: 1, base: okSide("base", 1), head: okSide("head", 1) }, headFailed(2)],
    diffs: [{ componentId: 1, diffImagePath: "artifacts/1/1/diff.png", diffPixelRatio: 0, width: 100, height: 50 }],
    analysis: analysisOf([candidate(1), candidate(2)])
  });
  assert.deepEqual(outcomes, [
    { componentId: 1, ran: false, changes: null, truncated: false, note: null },
    { componentId: 2, ran: true, changes: [], truncated: false, note: null }
  ]);
  assert.deepEqual(db.updatesFor(1), []);
  assert.deepEqual(db.updatesFor(2), [{ structuralDiff: [] }]);
  assert.ok(
    handle.console.has("info", "Comparing template structure for 1 components that could not be compared visually.")
  );
});

test("AngularStructuralDiffService.compare does not run for new, deleted or missing-on-both-sides components", async () => {
  const { db, handle, service, reads } = setupService({}, [1, 2, 3]);
  const outcomes = await service.compare(handle.context, {
    renders: [
      { componentId: 1, base: null, head: okSide("head", 1) },
      { componentId: 2, base: okSide("base", 2), head: null },
      { componentId: 3, base: null, head: null }
    ],
    diffs: [],
    analysis: analysisOf([candidate(1, { changeKind: "added" }), candidate(2, { changeKind: "removed" }), candidate(3)])
  });
  assert.ok(outcomes.every((outcome) => !outcome.ran && outcome.changes === null));
  assert.equal(db.updates.length, 0);
  assert.equal(reads.length, 0);
  assert.equal(handle.console.events.length, 0);
});

test("AngularStructuralDiffService.compare diffs external templates (15 §9.5 example)", async () => {
  const { db, handle, service, reads } = setupService(
    {
      base: { [TS_PATH]: externalComponent(), [HTML_PATH]: `<span class="badge">{{ label }}</span>` },
      head: {
        [TS_PATH]: externalComponent(),
        [HTML_PATH]: `<span class="badge badge-lg">{{ label }}</span> @if (count) {<b>{{ count }}</b>}`
      }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome, { componentId: 1, ran: true, changes: BADGE_EXPECTED, truncated: false, note: null });
  assert.deepEqual(JSON.parse(JSON.stringify(db.updatesFor(1)[0]?.structuralDiff)), BADGE_EXPECTED);
  assert.deepEqual(reads, [`base:${TS_PATH}`, `base:${HTML_PATH}`, `head:${TS_PATH}`, `head:${HTML_PATH}`]);
  assert.equal(handle.console.messages("warn").length, 0);
});

test("AngularStructuralDiffService.compare diffs inline templates and a switch from inline to external", async () => {
  const { service, handle, reads } = setupService(
    {
      base: { [TS_PATH]: inlineComponent(`<span class="badge">{{ label }}</span>`) },
      head: {
        [TS_PATH]: inlineComponent(`<span class="badge badge-lg">{{ label }}</span>\n@if (count) {<b>{{ count }}</b>}`)
      }
    },
    [1]
  );
  const [inline] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(inline?.changes, BADGE_EXPECTED);
  assert.deepEqual(reads, [`base:${TS_PATH}`, `head:${TS_PATH}`]);

  const mixed = setupService(
    {
      base: { [TS_PATH]: inlineComponent(`<span class="badge">{{ label }}</span>`) },
      head: {
        [TS_PATH]: externalComponent("badge.component.html"),
        [HTML_PATH]: `<span class="badge badge-lg">{{ label }}</span> @if (count) {<b>{{ count }}</b>}`
      }
    },
    [1]
  );
  const [switched] = await mixed.service.compare(mixed.handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(switched?.changes, BADGE_EXPECTED);
});

test("AngularStructuralDiffService.compare treats a missing component file as an empty side with a note", async () => {
  const { db, handle, service } = setupService(
    { base: { [TS_PATH]: externalComponent(), [HTML_PATH]: `<header></header><main></main>` } },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome?.changes, [
    { kind: "element_removed", path: "header", tag: "header" },
    { kind: "element_removed", path: "main", tag: "main" }
  ]);
  assert.equal(outcome.note, "component source not found on head");
  assert.equal(db.updatesFor(1).length, 1);
  assert.ok(
    handle.console.has("warn", "Could not compare the template of BadgeComponent: component source not found on head.")
  );
});

test("AngularStructuralDiffService.compare notes a class that is not found and a missing external template", async () => {
  const { service, handle } = setupService(
    {
      base: { [TS_PATH]: externalComponent(), [HTML_PATH]: `<p>x</p>` },
      head: { [TS_PATH]: externalComponent("./badge.component.html", "RenamedComponent") }
    },
    [1]
  );
  const [renamed] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(renamed?.changes, [{ kind: "element_removed", path: "p", tag: "p" }]);
  assert.equal(renamed.note, "export BadgeComponent not found on head");

  const missingTemplate = setupService(
    { base: { [TS_PATH]: externalComponent(), [HTML_PATH]: `<p>x</p>` }, head: { [TS_PATH]: externalComponent() } },
    [1]
  );
  const [outcome] = await missingTemplate.service.compare(missingTemplate.handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome?.changes, [{ kind: "element_removed", path: "p", tag: "p" }]);
  assert.equal(outcome.note, `template ${HTML_PATH} not found on head`);
});

test("AngularStructuralDiffService.compare notes a template that is not static", async () => {
  const dynamic = `import { Component } from "@angular/core";
const TEMPLATE = "<p>x</p>";
@Component({ selector: "app-badge", template: TEMPLATE })
export class BadgeComponent {}
`;
  const { service, handle } = setupService({ base: { [TS_PATH]: dynamic }, head: { [TS_PATH]: dynamic } }, [1]);
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome?.changes, []);
  assert.equal(
    outcome.note,
    "the template of BadgeComponent is not static on base; the template of BadgeComponent is not static on head"
  );
});

test("AngularStructuralDiffService.compare stores [] with a note when a side's template cannot be parsed", async () => {
  const { db, handle, service } = setupService(
    {
      base: { [TS_PATH]: externalComponent(), [HTML_PATH]: `<span class="badge">{{ label }}</span>` },
      head: { [TS_PATH]: externalComponent(), [HTML_PATH]: `@if (count) {` }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)])
  });
  assert.deepEqual(outcome, {
    componentId: 1,
    ran: true,
    changes: [],
    truncated: false,
    note: "could not parse the head template"
  });
  assert.deepEqual(db.updatesFor(1), [{ structuralDiff: [] }]);
  assert.ok(
    handle.console.has("warn", "Could not compare the template of BadgeComponent: could not parse the head template.")
  );
});

test("AngularStructuralDiffService.compare reads the base side from the renamed path", async () => {
  const oldPath = "src/app/old/badge.component.ts";
  const { service, handle, reads } = setupService(
    {
      base: { [oldPath]: inlineComponent(`<p>a</p>`) },
      head: { [TS_PATH]: inlineComponent(`<p>b</p>`) }
    },
    [1]
  );
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([candidate(1)], [{ path: TS_PATH, status: "R", previousPath: oldPath }])
  });
  assert.deepEqual(outcome?.changes, [{ kind: "text_changed", path: "p > #text[0]", before: "a", after: "b" }]);
  assert.deepEqual(reads, [`base:${oldPath}`, `head:${TS_PATH}`]);
});

test("AngularStructuralDiffService.compare diffs R's template on base against A's on head for a replaced row (00 §17)", async () => {
  const oldTs = "src/app/note-form/note-form.component.ts";
  const newTs = "src/app/note-form-modal/note-form-modal.component.ts";
  const { handle, service, reads } = setupService(
    {
      base: {
        [oldTs]: externalComponent("./note-form.component.html", "NoteFormComponent"),
        "src/app/note-form/note-form.component.html": "<form><textarea></textarea></form>"
      },
      head: {
        [newTs]: externalComponent("./note-form-modal.component.html", "NoteFormModalComponent"),
        "src/app/note-form-modal/note-form-modal.component.html":
          '<div role="dialog"><form><textarea></textarea></form></div>'
      }
    },
    [1]
  );
  const outcomes = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([
      candidate(1, {
        filePath: newTs,
        exportName: "NoteFormModalComponent",
        displayName: "NoteFormModalComponent",
        changeKind: "replaced",
        predecessor: {
          filePath: oldTs,
          exportName: "NoteFormComponent",
          displayName: "NoteFormComponent",
          evidence: []
        }
      })
    ])
  });
  assert.deepEqual(reads, [
    `base:${oldTs}`,
    "base:src/app/note-form/note-form.component.html",
    `head:${newTs}`,
    "head:src/app/note-form-modal/note-form-modal.component.html"
  ]);
  assert.equal(outcomes[0]?.note, null);
  assert.deepEqual(outcomes[0].changes, [
    { kind: "element_added", path: "div", tag: "div" },
    { kind: "element_removed", path: "form", tag: "form" }
  ]);
});

test("AngularStructuralDiffService.compare notes a candidate missing from the analysis", async () => {
  const { service, handle } = setupService({}, [1]);
  const [outcome] = await service.compare(handle.context, {
    renders: [headFailed(1)],
    diffs: [],
    analysis: analysisOf([])
  });
  assert.deepEqual(outcome, {
    componentId: 1,
    ran: true,
    changes: [],
    truncated: false,
    note: "component not found in the analysis"
  });
});

test("AngularStructuralDiffService.compare throws STRUCTURAL_DIFF_PERSIST_FAILED on update error", async () => {
  const files = { [TS_PATH]: inlineComponent(`<p>a</p>`) };
  const { db, handle, service } = setupService({ base: files, head: files }, [1]);
  db.failNext("update");
  await assert.rejects(
    service.compare(handle.context, { renders: [headFailed(1)], diffs: [], analysis: analysisOf([candidate(1)]) }),
    (error: unknown) => error instanceof PipelineStepError && error.code === "STRUCTURAL_DIFF_PERSIST_FAILED"
  );
});

test("AngularStructuralDiffService.compare stops when the job is cancelled", async () => {
  const files = { [TS_PATH]: inlineComponent(`<p>a</p>`) };
  const { db, handle, service } = setupService({ base: files, head: files }, [1]);
  handle.cancel();
  await assert.rejects(
    service.compare(handle.context, { renders: [headFailed(1)], diffs: [], analysis: analysisOf([candidate(1)]) }),
    (error: unknown) => error === "cancelled"
  );
  assert.equal(db.updates.length, 0);
});

test("locateAngularTemplate resolves aliased imports, default exports and non-component classes", () => {
  const parse = (text: string): ts.SourceFile =>
    ts.createSourceFile("c.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliased = parse(`import { Component as Cmp } from "@angular/core";
@Cmp({ selector: "x", templateUrl: "./x.html" })
export class XComponent {}`);
  assert.deepEqual(locateAngularTemplate(aliased, "XComponent"), { kind: "external", templateUrl: "./x.html" });

  const namespaced = parse(`import * as ng from "@angular/core";
@ng.Component({ selector: "x", template: '<p class="a">it\\'s</p>' })
export default class XComponent {}`);
  assert.deepEqual(locateAngularTemplate(namespaced, "default"), { kind: "inline", text: `<p class="a">it's</p>` });

  const notAComponent = parse(`import { Directive } from "@angular/core";
@Directive({ selector: "[x]" })
export class XDirective {}`);
  assert.deepEqual(locateAngularTemplate(notAComponent, "XDirective"), { kind: "class_not_found" });

  const foreignDecorator = parse(`import { Component } from "./my-decorators";
@Component({ template: "<p></p>" })
export class XComponent {}`);
  assert.deepEqual(locateAngularTemplate(foreignDecorator, "XComponent"), { kind: "class_not_found" });
});
