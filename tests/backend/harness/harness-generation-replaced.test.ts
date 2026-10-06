/**
 * Two-sided harnesses for `replaced` rows (00 §17): a base harness for R built from base sources and a head harness
 * for A built from head sources, each validated by its side's rules, persisted together, usage recorded for both
 * calls; per-side repair (own package, own budget, rebuilt from the row's base columns on a fresh instance).
 */
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Table } from "../../../backend/src/enums";
import { HarnessGenerationService } from "../../../backend/src/services/visualizations/pipeline/harness-generation-service";
import type {
  ComponentCandidate,
  HarnessGenerationResult,
  HarnessRenderError
} from "../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../backend/src/utilities";
import type { Script } from "../helpers/ai-provider-stub";
import { makeComponentRow, makeVisualizationRow } from "../helpers/factories";
import { createPipelineContext, type PipelineContextHandle } from "../helpers/pipeline-context";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { byComponent, respond } from "./helpers/fake-ai-provider";
import { FakeSourceQueries } from "./helpers/fake-source-queries";
import {
  VISUALIZATION_ID,
  componentCandidate,
  invalidHarness,
  okResponse,
  validHarness
} from "./helpers/service-setup";
import { createTempWorktrees, type TempWorktrees } from "./helpers/temp-worktrees";

const OLD = "NoteForm";
const NEW = "NoteFormModal";
const OLD_PATH = `src/components/${OLD}/${OLD}.tsx`;
const EVIDENCE = [{ kind: "call_site_swap" as const, detail: "src/pages/Notes.tsx: <NoteForm> → <NoteFormModal>" }];

const replaced: ComponentCandidate = componentCandidate(NEW, {
  componentId: 1,
  changeKind: "replaced",
  reason: "Replaced by NoteFormModal (call site swap in Notes)",
  predecessor: { filePath: OLD_PATH, exportName: OLD, displayName: OLD, evidence: EVIDENCE }
});

interface Setup {
  service: HarnessGenerationService;
  handle: PipelineContextHandle;
  db: InMemoryQueryHandler;
  trees: TempWorktrees;
  queries: FakeSourceQueries;
}

/** R's file only on base, A's file only on head; the row carries the base columns. */
function setup(t: TestContext, script: Script): Setup {
  const trees = createTempWorktrees(t);
  trees.write("base", OLD_PATH, `export function ${OLD}() { return <form>${OLD}</form>; }\n`);
  trees.write("head", replaced.filePath, `export function ${NEW}() { return <div><form>${NEW}</form></div>; }\n`);
  trees.write("both", "package.json", JSON.stringify({ dependencies: { react: "^19.0.0" } }));
  const queries = new FakeSourceQueries({ files: { base: trees.files.base, head: trees.files.head } });
  const handle = createPipelineContext({
    visualizationId: VISUALIZATION_ID,
    dataDir: trees.root,
    repositoryPath: trees.root,
    baseDir: trees.baseDir,
    headDir: trees.headDir,
    script
  });
  const db = new InMemoryQueryHandler();
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: VISUALIZATION_ID, status: "generating_harnesses" })]);
  db.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({
      id: 1,
      visualizationId: VISUALIZATION_ID,
      filePath: replaced.filePath,
      exportName: NEW,
      displayName: NEW,
      changeKind: "replaced",
      codeDiff: replaced.codeDiff,
      changeReason: replaced.reason,
      baseFilePath: OLD_PATH,
      baseExportName: OLD,
      baseDisplayName: OLD,
      successorEvidence: EVIDENCE
    })
  ]);
  const service = new HarnessGenerationService(handle.context, queries, {
    queryHandler: db as unknown as QueryHandler,
    sleep: () => Promise.resolve(),
    now: () => 0
  });
  return { service, handle, db, trees, queries };
}

const both = (): Script["harness"] => [
  byComponent({ [NEW]: okResponse(NEW), [OLD]: okResponse(OLD) }),
  byComponent({ [NEW]: okResponse(NEW), [OLD]: okResponse(OLD) })
];

test("HarnessGenerationService.generateAll builds a head harness for A and a base harness for R of a replaced row", async (t) => {
  const s = setup(t, { harness: both() });
  const batch = await s.service.generateAll([replaced]);

  assert.deepEqual(batch.failures, []);
  assert.deepEqual(batch.results, [
    {
      componentId: 1,
      harnessSource: validHarness(NEW),
      mockedModules: [],
      notes: `Shows ${NEW}.`,
      baseHarness: { harnessSource: validHarness(OLD), mockedModules: [], notes: `Shows ${OLD}.` }
    }
  ]);
  // two AI calls: head first (A from head sources), then base (R from base sources)
  const calls = s.handle.ai.callsFor("harness");
  assert.equal(calls.length, 2);
  assert.match(calls[0]?.prompt ?? "", new RegExp(`^component: ${NEW}$`, "m"));
  assert.match(calls[0]?.prompt ?? "", /^change: new component added in this change$/m);
  assert.equal(calls[0]?.workingDirectory, s.trees.headDir);
  assert.match(calls[1]?.prompt ?? "", new RegExp(`^component: ${OLD}$`, "m"));
  assert.match(calls[1]?.prompt ?? "", /^change: component deleted in this change; only the base version can render$/m);
  assert.equal(calls[1]?.workingDirectory, s.trees.baseDir);
  assert.ok(calls[1].prompt.includes(`import { ${OLD} } from "../../src/components/${OLD}/${OLD}";`));

  // one update with both sides
  const updates = s.db.callsFor("update", Table.VISUALIZATION_COMPONENTS);
  assert.equal(updates.length, 1);
  const row = s.db.row(Table.VISUALIZATION_COMPONENTS, 1);
  assert.equal(row?.harnessSource, validHarness(NEW));
  assert.equal(row.harnessNotes, `Shows ${NEW}.`);
  assert.equal(row.baseHarnessSource, validHarness(OLD));
  assert.equal(row.baseHarnessNotes, `Shows ${OLD}.`);
  assert.deepEqual(row.baseMockedModules, []);
  assert.equal(row.renderStatus, "pending");
  // AiUsageRecorder saw both calls
  assert.deepEqual(s.db.row(Table.VISUALIZATIONS, VISUALIZATION_ID)?.aiUsage, batch.usage);
  assert.equal(batch.usage.calls, 2);
  assert.ok(
    s.handle.console
      .messages()
      .some((message) => message === `Harnesses ready for ${OLD} → ${NEW}: 0 mocks before, 0 after.`),
    s.handle.console.messages().join("\n")
  );
});

test("HarnessGenerationService.generateAll validates the base harness against R: importing A on base fails, then a correction fixes it", async (t) => {
  const wrongBase = okResponse(OLD, { harnessSource: validHarness(NEW) }); // imports A's head path on the base side
  const s = setup(t, {
    harness: [byComponent({ [NEW]: okResponse(NEW) }), byComponent({ [OLD]: wrongBase })],
    harness_repair: [respond(okResponse(OLD))]
  });
  const batch = await s.service.generateAll([replaced]);
  assert.equal(batch.results[0]?.baseHarness?.harnessSource, validHarness(OLD));
  const correction = s.handle.ai.callsFor("harness_repair")[0];
  assert.ok(correction?.prompt.includes("<validation_errors>"), "a static-check correction for the base side");
  assert.equal(correction?.workingDirectory, s.trees.baseDir);
});

test("HarnessGenerationService.generateAll fails a replaced row when one side's harness cannot be produced", async (t) => {
  const s = setup(t, {
    harness: [
      byComponent({ [NEW]: okResponse(NEW) }),
      byComponent({ [OLD]: okResponse(OLD, { harnessSource: invalidHarness(OLD) }) })
    ],
    harness_repair: [respond(okResponse(OLD, { harnessSource: invalidHarness(OLD) }))]
  });
  const batch = await s.service.generateAll([replaced]);
  assert.deepEqual(batch.results, []);
  assert.equal(batch.failures.length, 1);
  assert.equal(batch.failures[0]?.kind, "invalid_harness");
  assert.equal(
    batch.failures[0].message,
    `before (${OLD}): AI harness failed static checks: default_export_wrong_name`
  );
  const row = s.db.row(Table.VISUALIZATION_COMPONENTS, 1);
  assert.equal(row?.renderStatus, "failed");
  assert.equal(row.baseError, "Not rendered: harness generation failed.");
  assert.equal(row.headError, "Not rendered: harness generation failed.");
  assert.equal(row.harnessSource, validHarness(NEW), "the head harness that passed is kept");
  assert.equal(row.harnessNotes, `Shows ${NEW}.`);
  assert.equal(row.baseHarnessSource, invalidHarness(OLD), "the last base attempt is kept for inspection");
  assert.match(String(row.baseHarnessNotes), /^Harness generation failed: AI harness failed static checks/);
  assert.ok(
    s.handle.console
      .messages()
      .some((message) => message.startsWith(`Harness generation failed for ${OLD} → ${NEW}, before (${OLD}):`)),
    s.handle.console.messages().join("\n")
  );
});

const BASE_RENDER_ERROR: HarnessRenderError = {
  sides: ["base"],
  kind: "render_error",
  message: "[render_error] Render error: NoteForm needs a FormProvider",
  otherSideMessage: null,
  targetSide: "base"
};

function sideResult(name: string): HarnessGenerationResult {
  return { componentId: 1, harnessSource: validHarness(name), mockedModules: [], notes: `Shows ${name}.` };
}

test("HarnessGenerationService.repairHarness repairs the side named by targetSide with that side's package and budget", async (t) => {
  const fixedBase = validHarness(OLD).replace("width: 360", "width: 300");
  const s = setup(t, {
    harness: both(),
    harness_repair: [
      respond(okResponse(OLD, { harnessSource: fixedBase, notes: "Wrapped in a form provider." })),
      respond(okResponse(NEW))
    ]
  });
  await s.service.generateAll([replaced]);

  const base = await s.service.repairHarness(1, sideResult(OLD), BASE_RENDER_ERROR);
  assert.deepEqual(base, {
    ok: true,
    result: {
      componentId: 1,
      harnessSource: fixedBase,
      mockedModules: [],
      notes: `Shows ${OLD}.\n\nRepaired after base render failure (render_error): Wrapped in a form provider.`
    }
  });
  const request = s.handle.ai.callsFor("harness_repair")[0];
  assert.match(request?.prompt ?? "", new RegExp(`^component: ${OLD}$`, "m"));
  assert.ok(request?.prompt.includes('<render_failure sides="base" kind="render_error">'));
  assert.equal(request?.workingDirectory, s.trees.baseDir);

  // the base side's budget is used up; the head side still has its own
  const again = await s.service.repairHarness(1, sideResult(OLD), BASE_RENDER_ERROR);
  assert.deepEqual(again, { ok: false, reason: "budget_exhausted", message: "Harness was already repaired once." });
  const head = await s.service.repairHarness(1, sideResult(NEW), {
    ...BASE_RENDER_ERROR,
    sides: ["head"],
    targetSide: "head"
  });
  assert.equal(head.ok, true);
  assert.match(s.handle.ai.callsFor("harness_repair")[1]?.prompt ?? "", new RegExp(`^component: ${NEW}$`, "m"));
});

test("HarnessGenerationService.repairHarness on a fresh instance rebuilds the base package from the row's base columns", async (t) => {
  const s = setup(t, { harness_repair: [respond(okResponse(OLD))] });
  const outcome = await s.service.repairHarness(1, sideResult(OLD), BASE_RENDER_ERROR);
  assert.equal(outcome.ok, true);
  const request = s.handle.ai.callsFor("harness_repair")[0];
  assert.match(request?.prompt ?? "", new RegExp(`^component: ${OLD}$`, "m"));
  assert.ok(request?.prompt.includes(`import { ${OLD} } from "../../src/components/${OLD}/${OLD}";`));
  assert.equal(request?.workingDirectory, s.trees.baseDir);
});
