import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Table } from "../../../backend/src/enums";
import { HarnessGenerationService } from "../../../backend/src/services/visualizations/pipeline/harness-generation-service";
import type { HarnessGenerationResult, HarnessRenderError } from "../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../backend/src/utilities";
import { respond, type ScriptStep } from "./helpers/fake-ai-provider";
import {
  VISUALIZATION_ID,
  componentCandidate,
  invalidHarness,
  okResponse,
  setupService,
  validHarness,
  type ServiceSetup
} from "./helpers/service-setup";

const button = componentCandidate("Button", { componentId: 1 });

const RENDER_ERROR: HarnessRenderError = {
  sides: ["base", "head"],
  kind: "render_error",
  message: "[render_error] Render error: useAuth must be used within AuthProvider",
  otherSideMessage: "[render_error] Render error: useAuth must be used within AuthProvider"
};

/** Generates Button's harness, then scripts the repair calls. */
async function generated(
  t: TestContext,
  repairSteps: ScriptStep[]
): Promise<ServiceSetup & { previous: HarnessGenerationResult; componentUpdates: () => number }> {
  const setup = setupService(t, {
    candidates: [button],
    script: { harness: [respond(okResponse("Button"))], harness_repair: repairSteps }
  });
  const batch = await setup.service.generateAll([button]);
  const previous = batch.results[0];
  assert.ok(previous);
  return {
    ...setup,
    previous,
    componentUpdates: () => setup.db.callsFor("update", Table.VISUALIZATION_COMPONENTS).length
  };
}

test("repair with ok status returns the new harness with appended notes and writes nothing to visualization_components", async (t) => {
  const fixed = validHarness("Button").replace("width: 360", "width: 320");
  const setup = await generated(t, [
    respond(okResponse("Button", { harnessSource: fixed, notes: "Wrapped in the auth provider." }))
  ]);
  const before = setup.componentUpdates();
  const rowBefore = setup.db.row(Table.VISUALIZATION_COMPONENTS, 1);
  const outcome = await setup.service.repairHarness(1, setup.previous, RENDER_ERROR);
  assert.deepEqual(outcome, {
    ok: true,
    result: {
      componentId: 1,
      harnessSource: fixed,
      mockedModules: [],
      notes:
        "Shows Button.\n\nRepaired after base and head render failure (render_error): Wrapped in the auth provider.",
      states: [{ name: "Default", steps: [] }],
      origin: "written",
      libraryEntryId: null
    }
  });
  assert.equal(setup.componentUpdates(), before);
  assert.deepEqual(setup.db.row(Table.VISUALIZATION_COMPONENTS, 1), rowBefore);
  const request = setup.ai.callsFor("harness_repair")[0];
  assert.ok(request?.prompt.includes('<render_failure sides="base,head" kind="render_error">'));
  assert.ok(request?.prompt.includes(`<previous_harness>\n${validHarness("Button")}\n</previous_harness>`));
  assert.equal(request?.workingDirectory, setup.trees.headDir);
  assert.deepEqual(
    setup.console.messages().filter((m) => m.includes("epair")),
    [],
    "repair emits no console events"
  );
});

test("repair with component_defect returns reason and notesAppendix and writes nothing", async (t) => {
  const notes = `The component reads order.total.toFixed on undefined totals. ${"x".repeat(700)}`;
  const setup = await generated(t, [respond(okResponse("Button", { status: "component_defect", notes }))]);
  const before = setup.componentUpdates();
  const outcome = await setup.service.repairHarness(1, setup.previous, RENDER_ERROR);
  assert.deepEqual(outcome, {
    ok: false,
    reason: "component_defect",
    message: notes,
    notesAppendix: `Repair check: the render failure looks like a defect in the component itself: ${notes.slice(0, 600)}`
  });
  assert.equal(setup.componentUpdates(), before);
});

test("repair with cannot_render returns a verdict without changing render_status", async (t) => {
  const setup = await generated(t, [
    respond(okResponse("Button", { status: "cannot_render", harnessSource: "", notes: "Needs WebGL." }))
  ]);
  const outcome = await setup.service.repairHarness(1, setup.previous, RENDER_ERROR);
  assert.deepEqual(outcome, {
    ok: false,
    reason: "cannot_render",
    message: "Needs WebGL.",
    notesAppendix: "Repair check: the AI considers this component not renderable in isolation: Needs WebGL."
  });
  assert.equal(setup.db.row(Table.VISUALIZATION_COMPONENTS, 1)?.renderStatus, "pending");
});

test("repair records usage through the AiUsageRecorder", async (t) => {
  const setup = await generated(t, [
    { kind: "error", reason: "rate_limit", usage: { inputTokens: 5, outputTokens: 0, calls: 1 } },
    respond(okResponse("Button"), { inputTokens: 300, outputTokens: 60, calls: 1 })
  ]);
  assert.deepEqual(setup.db.row(Table.VISUALIZATIONS, VISUALIZATION_ID)?.aiUsage, {
    inputTokens: 100,
    outputTokens: 50,
    calls: 1
  });
  const outcome = await setup.service.repairHarness(1, setup.previous, RENDER_ERROR);
  assert.equal(outcome.ok, true);
  assert.deepEqual(setup.db.row(Table.VISUALIZATIONS, VISUALIZATION_ID)?.aiUsage, {
    inputTokens: 405,
    outputTokens: 110,
    calls: 3
  });
  assert.deepEqual(setup.sleeps, [10_000], "repair retries a retryable error inside its budget");
});

test("second repair for same component returns budget_exhausted", async (t) => {
  const setup = await generated(t, [respond(okResponse("Button"))]);
  assert.equal((await setup.service.repairHarness(1, setup.previous, RENDER_ERROR)).ok, true);
  const calls = setup.ai.requests.length;
  assert.deepEqual(await setup.service.repairHarness(1, setup.previous, RENDER_ERROR), {
    ok: false,
    reason: "budget_exhausted",
    message: "Harness was already repaired once."
  });
  assert.equal(setup.ai.requests.length, calls);
});

test("repair rebuilds context package from DB on a fresh instance", async (t) => {
  const setup = await generated(t, [respond(okResponse("Button"))]);
  const fresh = new HarnessGenerationService(setup.handle.context, setup.queries, {
    queryHandler: setup.db as unknown as QueryHandler,
    sleep: () => Promise.resolve()
  });
  const outcome = await fresh.repairHarness(1, setup.previous, RENDER_ERROR);
  assert.equal(outcome.ok, true);
  const lookup = setup.db.callsFor("validateAndSelect", Table.VISUALIZATION_COMPONENTS)[0];
  assert.deepEqual(lookup?.args, ["VisualizationComponentModel", { id: 1, visualizationId: VISUALIZATION_ID }]);
  const prompt = setup.ai.callsFor("harness_repair")[0]?.prompt ?? "";
  assert.ok(prompt.includes("selected because: Component code changed"));
  assert.ok(
    prompt.includes('import the target with exactly: import { Button } from "../../src/components/Button/Button";')
  );

  assert.deepEqual(await fresh.repairHarness(99, setup.previous, RENDER_ERROR), {
    ok: false,
    reason: "ai_error",
    message: "Component not found."
  });
});

test("repair auth error returns ai_error without throwing", async (t) => {
  const setup = await generated(t, [{ kind: "error", reason: "auth", message: "invalid x-api-key" }]);
  const outcome = await setup.service.repairHarness(1, setup.previous, RENDER_ERROR);
  assert.deepEqual(outcome, { ok: false, reason: "ai_error", message: "AI provider error: invalid x-api-key" });
});

test("repair validates and corrects once", async (t) => {
  const corrected = await generated(t, [
    respond(okResponse("Button", { harnessSource: invalidHarness("Button") })),
    respond(okResponse("Button", { notes: "Fixed the export name." }))
  ]);
  const outcome = await corrected.service.repairHarness(1, corrected.previous, RENDER_ERROR);
  assert.equal(outcome.ok, true);
  const correction = corrected.ai.callsFor("harness_repair")[1];
  assert.ok(correction?.prompt.includes("<validation_errors>\n- [default_export_wrong_name]"));

  const stillInvalid = await generated(t, [
    respond(okResponse("Button", { harnessSource: invalidHarness("Button") })),
    respond(okResponse("Button", { harnessSource: invalidHarness("Button") }))
  ]);
  assert.deepEqual(await stillInvalid.service.repairHarness(1, stillInvalid.previous, RENDER_ERROR), {
    ok: false,
    reason: "invalid_harness",
    message: "Repaired harness failed static checks: default_export_wrong_name"
  });
  assert.equal(stillInvalid.ai.callsFor("harness_repair").length, 2, "repair + one correction");
});

test("repair on cancelled visualization returns cancelled", async (t) => {
  const setup = await generated(t, []);
  setup.handle.cancel();
  const calls = setup.ai.requests.length;
  assert.deepEqual(await setup.service.repairHarness(1, setup.previous, RENDER_ERROR), {
    ok: false,
    reason: "cancelled",
    message: "Cancelled."
  });
  assert.equal(setup.ai.requests.length, calls);
});
