import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { Table } from "../../../backend/src/enums";
import {
  HARNESS_RESPONSE_SCHEMA,
  HARNESS_SYSTEM_PROMPT
} from "../../../backend/src/services/visualizations/pipeline/harness-prompts";
import { createAngularHarnessGeneration } from "../../../backend/src/services/visualizations/pipeline/angular/angular-harness-generation";
import {
  ANGULAR_HARNESS_RESPONSE_SCHEMA,
  ANGULAR_HARNESS_SYSTEM_PROMPT
} from "../../../backend/src/services/visualizations/pipeline/angular/angular-harness-prompts";
import { AiProviderError, PipelineStepError } from "../../../backend/src/types/visualization-pipeline";
import type { QueryHandler } from "../../../backend/src/utilities";
import { makeComponentRow, makeVisualizationRow } from "../helpers/factories";
import { createPipelineContext } from "../helpers/pipeline-context";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { FakeAngularSourceQueries, angularInput, angularMeta } from "./helpers/fake-angular-source-queries";
import { FakeSourceQueries } from "./helpers/fake-source-queries";
import { createTempWorktrees } from "./helpers/temp-worktrees";
import { recordLogger } from "../helpers/console-recorder";
import { ConcurrencyProbe, byComponent, componentOf, respond, type Script } from "./helpers/fake-ai-provider";
import {
  VISUALIZATION_ID,
  componentCandidate,
  invalidHarness,
  okResponse,
  setupService,
  validHarness
} from "./helpers/service-setup";

const STAGE = "generating_harnesses";
const NOT_RENDERED = "Not rendered: harness generation failed.";

const button = componentCandidate("Button", { componentId: 1, rank: 0 });
const card = componentCandidate("Card", { componentId: 2, rank: 1 });
const badge = componentCandidate("Badge", { componentId: 3, rank: 2 });

test("generates harnesses in rank order and persists source, notes and mocks", async (t) => {
  const clsxMock =
    'export default function clsx(...parts: unknown[]): string { return parts.filter(Boolean).join(" "); }';
  const { service, db, ai } = setupService(t, {
    candidates: [badge, button, card],
    script: {
      harness: [
        respond(
          okResponse("Button", {
            mockedModules: [{ specifier: "clsx", source: clsxMock, reason: "Keeps class names stable." }]
          })
        ),
        ...[1, 2].map(() => byComponent({ Card: okResponse("Card"), Badge: okResponse("Badge") }))
      ]
    }
  });
  const batch = await service.generateAll([badge, button, card]);
  assert.deepEqual(
    batch.results.map((r) => r.componentId),
    [1, 2, 3]
  );
  assert.equal(componentOf(ai.requests[0]!), "Button", "the first-ranked component runs first, alone");
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.cancelled, false);
  const row = db.row(Table.VISUALIZATION_COMPONENTS, 1);
  assert.equal(row?.harnessSource, validHarness("Button"));
  assert.deepEqual(row.mockedModules, [{ specifier: "clsx", source: clsxMock }]);
  assert.equal(row.harnessNotes, "Shows Button.\n\nMocks:\n- clsx — Keeps class names stable.");
  assert.deepEqual(batch.results[0]?.mockedModules, [{ specifier: "clsx", source: clsxMock }]);
  assert.equal(batch.results[0].notes, row.harnessNotes);
  ai.assertExhausted();
});

test("runs first component alone then up to four in parallel for anthropic_api", async (t) => {
  const probe = new ConcurrencyProbe();
  const candidates = ["A1", "A2", "A3", "A4", "A5"].map((name, index) =>
    componentCandidate(name, { componentId: index + 1, rank: index })
  );
  const { service } = setupService(t, {
    candidates,
    script: { harness: candidates.map(() => probe.step((request) => okResponse(componentOf(request)), 30)) }
  });
  const batch = await service.generateAll(candidates);
  assert.equal(batch.results.length, 5);
  assert.equal(probe.inFlightAtStart[0], 1, "first call alone");
  assert.equal(probe.inFlightAtStart[1], 1, "second call starts after the first finished");
  assert.equal(probe.maxInFlight, 4);
});

test("runs first component alone then up to four in parallel for claude_code", async (t) => {
  const probe = new ConcurrencyProbe();
  const candidates = ["B1", "B2", "B3", "B4", "B5", "B6"].map((name, index) =>
    componentCandidate(name, { componentId: index + 1, rank: index })
  );
  const { service, console } = setupService(t, {
    kind: "claude_code",
    candidates,
    script: { harness: candidates.map(() => probe.step((request) => okResponse(componentOf(request)), 10)) }
  });
  await service.generateAll(candidates);
  assert.equal(probe.inFlightAtStart[0], 1, "first call alone");
  assert.equal(probe.inFlightAtStart[1], 1, "second call starts after the first finished");
  assert.equal(probe.maxInFlight, 4);
  assert.ok(console.has("info", "(claude_code, model claude-opus-5-5, effort high, concurrency 4)."));
});

test("uses identical system prompt, schema and effort for every call", async (t) => {
  const { service, ai } = setupService(t, {
    candidates: [button, card],
    script: {
      harness: [
        respond(okResponse("Button", { harnessSource: invalidHarness("Button") })),
        respond(okResponse("Card"))
      ],
      harness_repair: [respond(okResponse("Button"))]
    }
  });
  await service.generateAll([button, card]);
  assert.equal(ai.requests.length, 3);
  for (const request of ai.requests) {
    assert.equal(request.system, HARNESS_SYSTEM_PROMPT);
    assert.equal(request.jsonSchema, HARNESS_RESPONSE_SCHEMA);
    assert.equal(request.effort, "high");
  }
});

test("passes headDir as workingDirectory, baseDir for removed", async (t) => {
  const removed = componentCandidate("Gone", { componentId: 2, rank: 1, changeKind: "removed", codeDiff: null });
  const { service, ai, trees } = setupService(t, {
    candidates: [button, removed],
    script: { harness: [respond(okResponse("Button")), respond(okResponse("Gone"))] }
  });
  const batch = await service.generateAll([button, removed]);
  assert.equal(batch.results.length, 2);
  const [first, second] = ai.callsFor("harness");
  assert.equal(first?.workingDirectory, trees.headDir);
  assert.equal(second?.workingDirectory, trees.baseDir);
  assert.ok(first.signal instanceof AbortSignal);
});

test("asks for one correction when validation fails then persists the fixed harness", async (t) => {
  const { service, ai, db, console } = setupService(t, {
    candidates: [button],
    script: {
      harness: [respond(okResponse("Button", { harnessSource: invalidHarness("Button") }))],
      harness_repair: [respond(okResponse("Button"))]
    }
  });
  const batch = await service.generateAll([button]);
  assert.equal(batch.results.length, 1);
  const correction = ai.callsFor("harness_repair")[0];
  assert.ok(correction?.prompt.includes("<validation_errors>\n- [default_export_wrong_name]"));
  assert.ok(correction?.prompt.includes("<previous_response>"));
  assert.ok(
    console.has("warn", "Harness for Button failed static checks (1 issues); asking the AI to correct it.", STAGE)
  );
  assert.equal(db.row(Table.VISUALIZATION_COMPONENTS, 1)?.harnessSource, validHarness("Button"));
});

test("fails component as invalid_harness after failed correction and keeps last harness", async (t) => {
  const second = invalidHarness("Button").replace("width: 360", "width: 320");
  const { service, db, console } = setupService(t, {
    candidates: [button],
    script: {
      harness: [respond(okResponse("Button", { harnessSource: invalidHarness("Button") }))],
      harness_repair: [respond(okResponse("Button", { harnessSource: second }))]
    }
  });
  const batch = await service.generateAll([button]);
  assert.deepEqual(batch.results, []);
  assert.deepEqual(batch.failures, [
    {
      componentId: 1,
      kind: "invalid_harness",
      aiReason: null,
      message: "AI harness failed static checks: default_export_wrong_name"
    }
  ]);
  const row = db.row(Table.VISUALIZATION_COMPONENTS, 1);
  assert.equal(row?.renderStatus, "failed");
  assert.equal(row.harnessSource, second);
  assert.deepEqual(row.mockedModules, []);
  assert.match(
    String(row.harnessNotes),
    /^Harness generation failed: AI harness failed static checks: default_export_wrong_name\n- \[default_export_wrong_name\] /
  );
  assert.equal(row.baseError, NOT_RENDERED);
  assert.equal(row.headError, NOT_RENDERED);
  assert.ok(
    console.has(
      "warn",
      "Harness generation failed for Button: AI harness failed static checks: default_export_wrong_name"
    )
  );
});

test("retries a retryable error once after delay", async (t) => {
  const logs = recordLogger();
  t.after(logs.restore);
  const { service, sleeps, console, ai } = setupService(t, {
    candidates: [button],
    script: { harness: [{ kind: "error", reason: "rate_limit" }, respond(okResponse("Button"))] }
  });
  const batch = await service.generateAll([button]);
  assert.equal(batch.results.length, 1);
  assert.deepEqual(sleeps, [10_000]);
  assert.equal(ai.callsFor("harness").length, 2);
  assert.ok(console.has("warn", "AI call for Button failed (rate_limit); retrying in 10 s.", STAGE));
  assert.ok(
    logs.lines.some((line) => line.event === "harness.ai.retry" && line.attempt === 1 && line.delayMs === 10_000)
  );

  // a retryable error on every call fails the component after HARNESS_MAX_CALLS_PER_COMPONENT (3) calls
  const exhausted = setupService(t, {
    candidates: [button],
    script: {
      harness: [
        { kind: "error", reason: "network" },
        { kind: "error", reason: "network" },
        { kind: "error", reason: "network" }
      ]
    }
  });
  const failed = await exhausted.service.generateAll([button]);
  assert.equal(exhausted.ai.requests.length, 3);
  assert.deepEqual(failed.failures[0], {
    componentId: 1,
    kind: "ai_error",
    aiReason: "network",
    message: "Could not reach the AI provider (or it timed out)."
  });
});

test("marks cannot_render as skipped with notes", async (t) => {
  const { service, db, console } = setupService(t, {
    candidates: [button],
    script: {
      harness: [
        respond({
          status: "cannot_render",
          harnessSource: "",
          mockedModules: [],
          notes: "Renders nothing visible.\nIt only registers a hook."
        })
      ]
    }
  });
  const batch = await service.generateAll([button]);
  assert.deepEqual(batch.failures, [
    {
      componentId: 1,
      kind: "cannot_render",
      aiReason: null,
      message: "Not rendered: Renders nothing visible.\nIt only registers a hook."
    }
  ]);
  const row = db.row(Table.VISUALIZATION_COMPONENTS, 1);
  assert.equal(row?.renderStatus, "skipped");
  assert.equal(row.harnessSource, null);
  assert.equal(row.harnessNotes, "Not rendered: Renders nothing visible.\nIt only registers a hook.");
  assert.equal(row.baseError, null);
  assert.equal(row.headError, null);
  assert.ok(console.has("info", "Button cannot be rendered in isolation: Renders nothing visible.", STAGE));
});

test("treats component_defect on first generation as invalid", async (t) => {
  const { service, ai } = setupService(t, {
    candidates: [button],
    script: {
      harness: [respond(okResponse("Button", { status: "component_defect" }))],
      harness_repair: [respond(okResponse("Button", { status: "component_defect" }))]
    }
  });
  const batch = await service.generateAll([button]);
  assert.equal(batch.failures[0]?.kind, "invalid_harness");
  assert.equal(batch.failures[0].message, "AI harness failed static checks: invalid_status");
  assert.ok(
    ai.callsFor("harness_repair")[0]?.prompt.includes("status component_defect is only valid in repair requests")
  );
});

test("refusal becomes per-component ai_error with category in message", async (t) => {
  const { service, db } = setupService(t, {
    candidates: [button, card],
    script: {
      harness: [
        {
          kind: "error",
          reason: "refusal",
          message: "The model declined the request (category: cyber).",
          usage: { inputTokens: 10, outputTokens: 0, calls: 1 }
        },
        respond(okResponse("Card"))
      ]
    }
  });
  const batch = await service.generateAll([button, card]);
  assert.deepEqual(batch.failures, [
    { componentId: 1, kind: "ai_error", aiReason: "refusal", message: "AI declined to write a harness (cyber)." }
  ]);
  assert.equal(batch.results.length, 1);
  assert.equal(
    db.row(Table.VISUALIZATION_COMPONENTS, 1)?.harnessNotes,
    "Harness generation failed: AI declined to write a harness (cyber)."
  );
});

test("auth error is fatal: throws PipelineStepError and stops scheduling", async (t) => {
  const { service, ai, db, console } = setupService(t, {
    candidates: [button, card, badge],
    script: {
      harness: [
        { kind: "error", reason: "auth", message: "invalid x-api-key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }
      ]
    }
  });
  const error = await service.generateAll([button, card, badge]).then(
    () => assert.fail("expected a rejection"),
    (rejection: unknown) => rejection
  );
  assert.ok(error instanceof PipelineStepError);
  assert.equal(error.stage, STAGE);
  assert.equal(error.code, "ai_auth");
  assert.match(error.userMessage, /^AI provider error: invalid x-api-key /);
  assert.ok(!error.userMessage.includes("sk-ant-api03-AAAA"), "secrets redacted");
  assert.equal(ai.requests.length, 1);
  assert.ok(console.has("error", "AI provider error:", STAGE));
  for (const id of [1, 2, 3]) {
    assert.equal(db.row(Table.VISUALIZATION_COMPONENTS, id)?.renderStatus, "pending");
  }
  assert.equal(db.callsFor("update", Table.VISUALIZATION_COMPONENTS).length, 0);
});

test("stops when isCancelled turns true and returns cancelled", async (t) => {
  const { service, handle, ai, db } = setupService(t, {
    candidates: [button, card, badge],
    script: { harness: [respond(okResponse("Button"))] }
  });
  let checks = 0;
  handle.context.isCancelled = () => {
    checks += 1;
    return Promise.resolve(checks > 1);
  };
  const batch = await service.generateAll([button, card, badge]);
  assert.equal(batch.cancelled, true);
  assert.deepEqual(
    batch.results.map((r) => r.componentId),
    [1]
  );
  assert.equal(ai.requests.length, 1);
  assert.equal(db.row(Table.VISUALIZATION_COMPONENTS, 2)?.renderStatus, "pending");
  assert.equal(db.row(Table.VISUALIZATION_COMPONENTS, 2)?.harnessSource, null);
});

test("abort during sleep returns cancelled", async (t) => {
  let cancel: () => void = () => undefined;
  const setup = setupService(t, {
    candidates: [button, card],
    script: { harness: [{ kind: "error", reason: "rate_limit" }] },
    deps: {
      sleep: async (ms, signal) => {
        cancel();
        await delay(ms, undefined, { signal });
      }
    }
  });
  cancel = () => {
    setup.handle.cancel();
  };
  const batch = await setup.service.generateAll([button, card]);
  assert.equal(batch.cancelled, true);
  assert.deepEqual(batch.failures, []);
  assert.deepEqual(batch.results, []);
  assert.equal(setup.ai.requests.length, 1);
  assert.equal(setup.db.callsFor("update", Table.VISUALIZATION_COMPONENTS).length, 0);
});

test("accumulates usage including usage attached to errors", async (t) => {
  const { service, db } = setupService(t, {
    candidates: [button, card],
    script: {
      harness: [
        { kind: "error", reason: "rate_limit", usage: { inputTokens: 40, outputTokens: 0, calls: 1 } },
        respond(okResponse("Button"), { inputTokens: 1_000, outputTokens: 500, calls: 1, cacheReadInputTokens: 800 }),
        { kind: "invalid_output", usage: { inputTokens: 7, outputTokens: 3, calls: 1 } },
        { kind: "invalid_output", usage: { inputTokens: 7, outputTokens: 3, calls: 1 } },
        { kind: "invalid_output", usage: { inputTokens: 7, outputTokens: 3, calls: 1 } }
      ]
    }
  });
  const batch = await service.generateAll([button, card]);
  assert.deepEqual(
    { inputTokens: batch.usage.inputTokens, outputTokens: batch.usage.outputTokens, calls: batch.usage.calls },
    { inputTokens: 1_061, outputTokens: 509, calls: 5 }
  );
  assert.deepEqual(db.row(Table.VISUALIZATIONS, VISUALIZATION_ID)?.aiUsage, {
    inputTokens: 1_061,
    outputTokens: 509,
    calls: 5
  });
  assert.equal(batch.failures[0]?.message, "AI returned output that did not match the harness format.");
});

test("sets base_error/head_error only for present sides on failure", async (t) => {
  const added = componentCandidate("Fresh", { componentId: 1, changeKind: "added", codeDiff: null });
  const removed = componentCandidate("Gone", { componentId: 2, rank: 1, changeKind: "removed", codeDiff: null });
  const { service, db } = setupService(t, {
    candidates: [added, removed],
    script: {
      harness: [
        { kind: "error", reason: "unknown", message: "boom" },
        { kind: "error", reason: "max_tokens" }
      ]
    }
  });
  const batch = await service.generateAll([added, removed]);
  assert.deepEqual(
    batch.failures.map((f) => f.message),
    ["AI provider error: boom", "AI response exceeded the output limit."]
  );
  assert.deepEqual(
    [1, 2].map((id) => {
      const row = db.row(Table.VISUALIZATION_COMPONENTS, id);
      return [row?.renderStatus, row?.baseError, row?.headError];
    }),
    [
      ["failed", null, NOT_RENDERED],
      ["failed", NOT_RENDERED, null]
    ]
  );
});

test("leaves render_status pending for ready harnesses", async (t) => {
  const { service, db } = setupService(t, {
    candidates: [button],
    script: { harness: [respond(okResponse("Button"))] }
  });
  await service.generateAll([button]);
  const updates = db.callsFor("update", Table.VISUALIZATION_COMPONENTS);
  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0]?.args[0] as object).sort(), [
    "harnessNotes",
    "harnessSource",
    "mockedModules"
  ]);
  assert.deepEqual(updates[0]?.args[1], { id: 1, visualizationId: VISUALIZATION_ID });
  assert.equal(db.row(Table.VISUALIZATION_COMPONENTS, 1)?.renderStatus, "pending");
});

test("constructs PipelineStepError with stage generating_harnesses and the 04 constructor", async (t) => {
  const { service, db } = setupService(t, {
    candidates: [button, card],
    script: { harness: [respond(okResponse("Button"))] }
  });
  db.failNext("update"); // the usage write (visualizations) is the first update
  const error = await service.generateAll([button, card]).then(
    () => assert.fail("expected a rejection"),
    (rejection: unknown) => rejection
  );
  assert.ok(error instanceof PipelineStepError);
  assert.equal(error.name, "PipelineStepError");
  assert.equal(error.stage, "generating_harnesses");
  assert.equal(error.userMessage, "Could not save harness results.");
  assert.equal(error.code, "HARNESS_PERSIST_FAILED");
  assert.ok(error.cause instanceof Error);

  const second = setupService(t, { candidates: [button], script: { harness: [respond(okResponse("Button"))] } });
  second.db.failNext("update", new Error("connection reset"));
  second.db.failNext("update", new Error("connection reset"));
  await assert.rejects(second.service.generateAll([button]), (rejection: unknown) => {
    assert.ok(rejection instanceof PipelineStepError);
    assert.equal(rejection.code, "HARNESS_PERSIST_FAILED");
    return true;
  });
});

test("console messages match templates", async (t) => {
  const candidates = [button, card, badge, componentCandidate("Menu", { componentId: 4, rank: 3 })];
  const { service, console } = setupService(t, {
    candidates,
    script: {
      harness: candidates.map(() =>
        byComponent({
          Button: okResponse("Button"),
          Card: okResponse("Card"),
          Badge: { status: "cannot_render", harnessSource: "", mockedModules: [], notes: "Only a context provider." },
          Menu: new AiProviderError("max_tokens", "max_tokens", false, {
            inputTokens: 100,
            outputTokens: 64_000,
            calls: 1
          })
        })
      )
    }
  });
  await service.generateAll(candidates);
  assert.deepEqual(
    console.events
      .filter((e) => e.stage === STAGE)
      .map((e) => [e.level, e.message])
      .sort(),
    [
      ["info", "Badge cannot be rendered in isolation: Only a context provider."],
      [
        "info",
        "Generating render harnesses for 4 components (anthropic_api, model claude-opus-5-5, effort high, concurrency 4)."
      ],
      [
        "info",
        "Harness generation finished: 2 ready, 1 failed, 1 not renderable. AI usage this stage: 400 input / 64,150 output tokens over 4 calls."
      ],
      ["info", "Harness ready for Button (src/components/Button/Button.tsx): 0 mocks."],
      ["info", "Harness ready for Card (src/components/Card/Card.tsx): 0 mocks."],
      ["warn", "Harness generation failed for Menu: AI response exceeded the output limit."]
    ]
  );
  console.assertStagesAreStatusNames();

  const empty = setupService(t, { candidates: [] });
  const batch = await empty.service.generateAll([]);
  assert.deepEqual(batch, {
    results: [],
    failures: [],
    usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
    cancelled: false
  });
  assert.deepEqual(empty.console.messages(), ["No components to generate harnesses for."]);
});

// ---------------------------------------------------------------------------------------------------------------
// Prompt seam (15 §5.6.2): the Angular prompt set, context builder and validator through the same service
// ---------------------------------------------------------------------------------------------------------------

const ANGULAR_APP_ROOT = "apps/shop";
const ANGULAR_FILE = `${ANGULAR_APP_ROOT}/src/app/orders/order-list.component.ts`;
const ANGULAR_IMPORT = "../../src/app/orders/order-list.component";

function angularHarness(inputs: string): string {
  return [
    "import { definePrvisionHarness } from '../harness-api';",
    `import { OrderListComponent } from '${ANGULAR_IMPORT}';`,
    "",
    `export default definePrvisionHarness({ component: OrderListComponent, inputs: ${inputs} });`
  ].join("\n");
}

function angularSetup(t: TestContext, script: Script) {
  const trees = createTempWorktrees(t);
  trees.write(
    "both",
    ANGULAR_FILE,
    "import { Component, input } from '@angular/core';\n@Component({ selector: 'app-order-list', template: '<ul></ul>' })\nexport class OrderListComponent { readonly title = input.required<string>(); }\n"
  );
  const queries = new FakeAngularSourceQueries({ files: { base: trees.files.base, head: trees.files.head } });
  queries.setMeta(
    "both",
    angularMeta({
      filePath: ANGULAR_FILE,
      className: "OrderListComponent",
      selector: "app-order-list",
      template: { kind: "inline", path: null, text: "<ul></ul>", startLine: 2 },
      inputs: [angularInput({ name: "title", kind: "signal", required: true, typeText: "string" })]
    })
  );
  const handle = createPipelineContext({
    visualizationId: VISUALIZATION_ID,
    dataDir: trees.root,
    repositoryPath: trees.root,
    baseDir: trees.baseDir,
    headDir: trees.headDir,
    script,
    repository: {
      framework: "angular",
      appRoot: ANGULAR_APP_ROOT,
      angularProject: "shop",
      angularBuildConfiguration: "development",
      viteConfigPath: null,
      entryFilePath: `${ANGULAR_APP_ROOT}/src/main.ts`,
      globalStylePaths: []
    }
  });
  const candidate = {
    componentId: 1,
    filePath: ANGULAR_FILE,
    exportName: "OrderListComponent",
    displayName: "OrderListComponent",
    changeKind: "modified" as const,
    rank: 0,
    codeDiff: "@@ -1 +1 @@\n-a\n+b",
    reason: "Component code changed"
  };
  const db = new InMemoryQueryHandler();
  db.seed(Table.VISUALIZATIONS, [makeVisualizationRow({ id: VISUALIZATION_ID, status: "generating_harnesses" })]);
  db.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({
      id: 1,
      visualizationId: VISUALIZATION_ID,
      filePath: ANGULAR_FILE,
      exportName: "OrderListComponent",
      displayName: "OrderListComponent",
      changeKind: "modified",
      rank: 0,
      codeDiff: candidate.codeDiff,
      changeReason: candidate.reason
    })
  ]);
  const service = createAngularHarnessGeneration(handle.context, queries, {
    queryHandler: db as unknown as QueryHandler,
    sleep: () => Promise.resolve(),
    now: () => 0
  });
  return { service, handle, db, queries, candidate };
}

test("Angular prompts: requests carry the Angular system prompt, schema and target block", async (t) => {
  const { service, handle, db, candidate } = angularSetup(t, {
    harness: [
      respond({
        status: "ok",
        harnessSource: angularHarness("{ titel: 'Open orders' }"),
        mockedModules: [],
        notes: "n"
      })
    ],
    harness_repair: [
      respond({
        status: "ok",
        harnessSource: angularHarness("{ title: 'Open orders' }"),
        mockedModules: [],
        notes: "List."
      })
    ]
  });
  const batch = await service.generateAll([candidate]);
  assert.deepEqual(batch.failures, []);
  assert.equal(batch.results.length, 1);
  const [first, correction] = handle.ai.requests;
  assert.ok(first !== undefined && correction !== undefined);
  assert.equal(first.system, ANGULAR_HARNESS_SYSTEM_PROMPT);
  assert.equal(first.jsonSchema, ANGULAR_HARNESS_RESPONSE_SCHEMA);
  assert.ok(first.prompt.includes("selector: app-order-list"));
  assert.ok(
    first.prompt.includes(`import the target with exactly: import { OrderListComponent } from "${ANGULAR_IMPORT}";`)
  );
  assert.ok(first.prompt.includes("<component_meta>"));
  assert.equal(correction.purpose, "harness_repair");
  assert.equal(correction.system, ANGULAR_HARNESS_SYSTEM_PROMPT, "same cached prefix for the correction");
  assert.ok(correction.prompt.includes("[unknown_input]"));
  assert.ok(correction.prompt.includes("<previous_file_replacements>"));
  assert.equal(db.row(Table.VISUALIZATION_COMPONENTS, 1)?.harnessSource, angularHarness("{ title: 'Open orders' }"));
  handle.ai.assertExhausted();
});

test("Angular prompts: repair uses the Angular repair prompt", async (t) => {
  const harness = angularHarness("{ title: 'Open orders' }");
  const { service, handle, candidate } = angularSetup(t, {
    harness: [respond({ status: "ok", harnessSource: harness, mockedModules: [], notes: "List." })],
    harness_repair: [respond({ status: "ok", harnessSource: harness, mockedModules: [], notes: "Added the token." })]
  });
  const batch = await service.generateAll([candidate]);
  const previous = batch.results[0];
  assert.ok(previous);
  const outcome = await service.repairHarness(1, previous, {
    sides: ["base", "head"],
    kind: "render_error",
    message: "NG0201: No provider found for InjectionToken API_AUTH_BRIDGE",
    otherSideMessage: null
  });
  assert.equal(outcome.ok, true);
  const repair = handle.ai.requests.at(-1);
  assert.ok(repair !== undefined);
  assert.equal(repair.system, ANGULAR_HARNESS_SYSTEM_PROMPT);
  assert.ok(repair.prompt.includes("<previous_file_replacements>"));
  assert.ok(repair.prompt.includes("missing provider (NG0201), unknown input (NG0303)"));
});

test("createAngularHarnessGeneration refuses non-Angular source queries", (t) => {
  const trees = createTempWorktrees(t);
  const handle = createPipelineContext({ dataDir: trees.root, repositoryPath: trees.root });
  assert.throws(
    () => createAngularHarnessGeneration(handle.context, new FakeSourceQueries()),
    (error: unknown) =>
      error instanceof PipelineStepError &&
      error.code === "ANGULAR_QUERIES_MISSING" &&
      error.stage === STAGE &&
      error.userMessage === "Internal error: Angular analysis did not provide Angular source queries."
  );
});

test("the default prompt set is React's", async (t) => {
  const { service, ai } = setupService(t, {
    candidates: [button],
    script: { harness: [respond(okResponse("Button"))] }
  });
  await service.generateAll([button]);
  const [request] = ai.requests;
  assert.ok(request !== undefined);
  assert.equal(request.system, HARNESS_SYSTEM_PROMPT);
  assert.equal(request.jsonSchema, HARNESS_RESPONSE_SCHEMA);
});
