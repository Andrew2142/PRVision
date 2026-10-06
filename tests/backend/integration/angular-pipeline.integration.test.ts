/**
 * Angular full-chain pipeline integration test (15 §5.9.3 "angular-pipeline", §5.9.2 branch table): the real
 * VisualizationWorkerService drives `local_branch` visualizations of the sample-angular-monorepo fixture (app root
 * `apps/web`, project `web`) through queued → preparing → analyzing → generating_harnesses → rendering → diffing →
 * summarizing → completed with real git, the repository's own Angular build (@angular/build through Architect),
 * real Chromium and a real Postgres test database. Every stage goes through the framework seam
 * (`stepFactoriesFor("angular")`). Only the AI provider is scripted (14's ScriptedAiProvider through the worker's
 * `createProvider` seam): it answers each harness request with a hand-written `definePrvisionHarness` module that
 * passes 15c's validator, every repair request with `component_defect`, and the summary with a schema-valid result.
 *
 * Gated on PRVISION_IT_RENDER=1 (or PRVISION_INTEGRATION=1) and PRVISION_TEST_DATABASE_URL (a `*_test` database;
 * its public and drizzle schemas are dropped and re-migrated, as in the React pipeline e2e test).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test, type TestContext } from "node:test";
import * as drizzleNodePostgres from "drizzle-orm/node-postgres";
import * as drizzleMigrator from "drizzle-orm/node-postgres/migrator";
import pg, { type Pool as PgPool } from "pg";
import { DATA_DIR } from "../../../backend/src/config-consts";
import * as schema from "../../../backend/src/database/schema";
import { MIGRATIONS_FOLDER } from "../../../backend/src/database/schema-readiness";
import { VisualizationCreateDTO } from "../../../backend/src/dtos/visualizations/visualization-create.dto";
import type { CreateVisualizationResponse } from "../../../backend/src/dtos/visualizations/visualization-view.dto";
import { Table, VisualizationSourceType } from "../../../backend/src/enums";
import { RepositoryModel, VisualizationModel } from "../../../backend/src/models";
import { RepositoriesService } from "../../../backend/src/services/repositories/repositories-service";
import { AngularHostClient } from "../../../backend/src/services/visualizations/pipeline/render/angular/angular-host-client";
import { VisualizationWorkerService } from "../../../backend/src/services/visualizations/pipeline/visualization-worker-service";
import { VisualizationsService } from "../../../backend/src/services/visualizations/visualizations-service";
import type { AiStructuredRequest, StructuralChange } from "../../../backend/src/types/visualization-pipeline";
import { DrizzleDb } from "../../../backend/src/utilities/services/drizzle-db";
import { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { ScriptedAiProvider, type ScriptStep } from "../helpers/ai-provider-stub";
import { makeJob } from "../helpers/fake-queue";
import { isolatedGitEnv } from "../helpers/temp-git-repo";
import { patchStaticMethod } from "../helpers/test-context";
import { FakeQueueStatics } from "../visualizations/helpers/fakes";
import {
  ANGULAR_APP_ROOT,
  ANGULAR_PROJECT,
  angularFixtureHarness,
  cloneAngularFixture,
  type AngularFixtureBranch
} from "./helpers/angular-fixture";
import { itSkip } from "./helpers/it-flags";

const { drizzle } = drizzleNodePostgres;
const { migrate } = drizzleMigrator;
const { Pool } = pg;

const TEST_DATABASE_URL = process.env.PRVISION_TEST_DATABASE_URL ?? "";
const SKIP =
  itSkip("render") ||
  (TEST_DATABASE_URL === "" ? "set PRVISION_TEST_DATABASE_URL (a *_test Postgres database; it is reset)" : false);

const PIPELINE_STAGES = [
  "queued",
  "preparing",
  "analyzing",
  "generating_harnesses",
  "rendering",
  "diffing",
  "summarizing",
  "completed"
] as const;
/** DEFAULT_USAGE of ScriptedAiProvider for every `fn` step. */
const STEP_USAGE = { inputTokens: 100, outputTokens: 50, calls: 1 };
const SUMMARY_TEXT = "Scripted Angular summary.";
const web = (relative: string): string => `${ANGULAR_APP_ROOT}/${relative}`;

// ---------------------------------------------------------------------------------------------------------------
// Scripted AI
// ---------------------------------------------------------------------------------------------------------------

/** Answers an Angular harness request from the `<target>` block (class name and exact import statement). */
function harnessFor(request: AiStructuredRequest): unknown {
  const className = /^component: (\w+)$/m.exec(request.prompt)?.[1];
  const statement = /^import the target with exactly: (.+)$/m.exec(request.prompt)?.[1];
  if (className === undefined || statement === undefined) {
    throw new Error(`not an Angular harness prompt:\n${request.prompt.slice(0, 2_000)}`);
  }
  const { harnessSource, notes } = angularFixtureHarness(className, statement, request.prompt);
  return { status: "ok", harnessSource, mockedModules: [], notes };
}

/**
 * A `harness_repair` request. A correction (static-check failure, `<validation_errors>`) gets the same harness again
 * (the tests assert there are none); a render repair is answered with component_defect: the head component itself
 * fails (qa/render-failure, qa/build-error).
 */
function repairFor(request: AiStructuredRequest): unknown {
  if (request.prompt.includes("<validation_errors>")) {
    return harnessFor(request);
  }
  return {
    status: "component_defect",
    harnessSource: "",
    mockedModules: [],
    notes: "The head version of the component fails on its own; the harness is correct."
  };
}

/** A schema-valid summary covering exactly the `[#id]` components of the prompt (11 §5.4). */
function summaryFor(request: AiStructuredRequest): unknown {
  const ids = [...request.prompt.matchAll(/^## \[#(\d+)\]/gm)].map((m) => Number(m[1]));
  return {
    summaryMarkdown: SUMMARY_TEXT,
    components: ids.map((componentId) => ({ componentId, note: "Scripted note.", risk: "check" }))
  };
}

function corrections(run: RunResult): AiStructuredRequest[] {
  return run.scripted.callsFor("harness_repair").filter((request) => request.prompt.includes("<validation_errors>"));
}

function renderRepairs(run: RunResult): AiStructuredRequest[] {
  return run.scripted.callsFor("harness_repair").filter((request) => !request.prompt.includes("<validation_errors>"));
}

const many = (fn: (request: AiStructuredRequest) => unknown, count = 16): ScriptStep[] =>
  Array.from({ length: count }, (): ScriptStep => ({ kind: "fn", fn: (request) => fn(request) }));

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

function git(repo: string, args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], { env: isolatedGitEnv(), encoding: "utf8" });
}

/** Command lines of every live descendant of this test process. */
function descendantCommands(): string[] {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  const children = new Map<number, Array<{ pid: number; args: string }>>();
  for (const line of out.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const ppid = Number(m[2]);
    const list = children.get(ppid) ?? [];
    list.push({ pid: Number(m[1]), args: m[3] ?? "" });
    children.set(ppid, list);
  }
  const found: string[] = [];
  const queue = [process.pid];
  while (queue.length > 0) {
    const pid = queue.shift() ?? 0;
    for (const child of children.get(pid) ?? []) {
      found.push(child.args);
      queue.push(child.pid);
    }
  }
  return found;
}

/** Angular host, esbuild or Chromium processes still running under this test process (waits up to 5 s). */
async function leftoverRenderProcesses(): Promise<string[]> {
  const pattern = /angular-host-process|esbuild|chrom(e|ium)|headless_shell|ms-playwright/i;
  let leftovers: string[] = [];
  for (let attempt = 0; attempt < 25; attempt += 1) {
    leftovers = descendantCommands().filter((args) => pattern.test(args) && !args.startsWith("ps "));
    if (leftovers.length === 0) {
      return [];
    }
    await delay(200);
  }
  return leftovers;
}

interface RunResult {
  visualizationId: number;
  repositoryId: number;
  outcome: string;
  clone: string;
  nodeModulesEntries: string[];
  scripted: ScriptedAiProvider;
  visualization: Record<string, unknown>;
  components: Array<Record<string, unknown>>;
  consoleEvents: Array<Record<string, unknown>>;
  dump: string;
}

function nodeModulesEntries(clone: string): string[] {
  return fs.readdirSync(path.join(clone, ANGULAR_APP_ROOT, "node_modules")).sort();
}

/**
 * Registers a fresh clone as the Angular app, creates the visualization through the API service, runs the worker.
 * `lastCommitOnly` visualizes the branch's last commit as a `commit_range` (base = its parent, 00 §16.1).
 */
async function runVisualization(
  t: TestContext,
  headRef: AngularFixtureBranch,
  options: { lastCommitOnly?: boolean } = {}
): Promise<RunResult> {
  const clone = cloneAngularFixture(t);
  const before = nodeModulesEntries(clone);
  const queryHandler = new QueryHandler();
  const queue = new FakeQueueStatics();

  const payload = new RepositoryModel();
  payload.setLocalPath(clone);
  payload.setAppRoot(ANGULAR_APP_ROOT);
  payload.setAngularProject(ANGULAR_PROJECT);
  const registered = await new RepositoriesService(payload).create();
  assert.equal(registered.status, 201, `repository registration: ${JSON.stringify(registered)}`);
  const view = registered.data;
  assert.ok(view, "registered repository view");
  assert.equal(view.framework, "angular");
  assert.equal(view.appRoot, ANGULAR_APP_ROOT);
  assert.equal(view.angularProject, ANGULAR_PROJECT);
  const repositoryId = view.id;

  const dto = Object.assign(
    new VisualizationCreateDTO(),
    options.lastCommitOnly === true
      ? {
          repositoryId,
          sourceType: VisualizationSourceType.COMMIT_RANGE,
          headRef,
          baseSha: git(clone, ["rev-parse", `${headRef}~1`]).trim(),
          headSha: git(clone, ["rev-parse", headRef]).trim()
        }
      : { repositoryId, sourceType: VisualizationSourceType.LOCAL_BRANCH, headRef }
  );
  const created = await new VisualizationsService(new VisualizationModel(), {
    queue,
    aiReadiness: () => Promise.resolve({ ready: true, provider: "anthropic_api", model: "claude-opus-5-5" })
  }).create(dto);
  assert.equal(created.status, 202, `visualization create: ${JSON.stringify(created)}`);
  const visualizationId = (created.data as CreateVisualizationResponse).visualizationId;

  const scripted = new ScriptedAiProvider({
    harness: many(harnessFor),
    harness_repair: many(repairFor),
    summary: many(summaryFor, 1)
  });
  const worker = new VisualizationWorkerService({ createProvider: () => scripted, queue });
  const outcome = await worker.run(makeJob(visualizationId).job);

  const [visualization] = await queryHandler.select({ id: visualizationId }, Table.VISUALIZATIONS, true);
  assert.ok(visualization, "visualization row");
  const components = await queryHandler.select({ visualizationId }, Table.VISUALIZATION_COMPONENTS, true);
  components.sort((a, b) => Number(a.rank) - Number(b.rank));
  const consoleEvents = await queryHandler.select({ visualizationId }, Table.VISUALIZATION_CONSOLE_EVENTS, true);
  consoleEvents.sort((a, b) => Number(a.id) - Number(b.id));
  const dump = [
    ...consoleEvents.map((e) => `[${String(e.level)}] ${String(e.stage)}: ${String(e.message)}`),
    ...components.map(
      (c) =>
        `#${String(c.rank)} ${String(c.displayName)} ${String(c.changeKind)} ${String(c.renderStatus)} ` +
        `visual=${String(c.visualChange)} ratio=${String(c.diffPixelRatio)}\n  base: ${String(c.baseError)}\n  head: ${String(c.headError)}`
    )
  ].join("\n");
  return {
    visualizationId,
    repositoryId,
    outcome,
    clone,
    nodeModulesEntries: before,
    scripted,
    visualization,
    components,
    consoleEvents,
    dump
  };
}

function artifactPath(visualizationId: number, componentId: unknown, kind: "base" | "head" | "diff"): string {
  return `artifacts/${String(visualizationId)}/${String(componentId)}/${kind}.png`;
}

function assertCompleted(run: RunResult): void {
  assert.equal(run.outcome, "completed", run.dump);
  assert.equal(run.visualization.status, "completed", run.dump);
  assert.equal(run.visualization.failedStage, null, run.dump);
  assert.equal(run.visualization.errorMessage, null, run.dump);
  // Every scripted harness passes 15c's validator on the first answer.
  assert.equal(corrections(run).length, 0, `no static-check corrections:\n${run.dump}`);
}

function component(run: RunResult, displayName: string): Record<string, unknown> {
  const found = run.components.find((c) => c.displayName === displayName);
  assert.ok(found, `component ${displayName} expected:\n${run.dump}`);
  return found;
}

function shape(run: RunResult): Array<{ displayName: unknown; changeKind: unknown; changeReason: unknown }> {
  return run.components.map((c) => ({
    displayName: c.displayName,
    changeKind: c.changeKind,
    changeReason: c.changeReason
  }));
}

/** Both sides rendered, images on disk, pixel comparison done (structural diff not run, 11 §5.3.1). */
function assertRenderedPair(run: RunResult, c: Record<string, unknown>): void {
  const label = String(c.displayName);
  assert.equal(c.renderStatus, "rendered", `${label}:\n${run.dump}`);
  assert.equal(c.baseError, null, `${label} baseError`);
  assert.equal(c.headError, null, `${label} headError`);
  assert.ok(String(c.harnessSource).includes("definePrvisionHarness("), `${label} harness persisted`);
  for (const kind of ["base", "head", "diff"] as const) {
    const key = `${kind}ImagePath`;
    const relative = artifactPath(run.visualizationId, c.id, kind);
    assert.equal(c[key], relative, `${label} ${kind} image path`);
    assert.ok(fs.existsSync(path.join(DATA_DIR, relative)), `${label} ${kind}.png on disk`);
  }
  assert.ok(Number(c.imageWidth) > 0 && Number(c.imageHeight) > 0, `${label} image size`);
  assert.equal(typeof c.diffPixelRatio, "number", `${label} diffPixelRatio`);
  assert.equal(c.structuralDiff, null, `${label} structural diff not run for a pixel-compared pair`);
}

function firstStages(run: RunResult): string[] {
  const seen: string[] = [];
  for (const event of run.consoleEvents) {
    const stage = String(event.stage);
    if (!seen.includes(stage)) {
      seen.push(stage);
    }
  }
  return seen;
}

function messages(run: RunResult, level: string, stage?: string): string[] {
  return run.consoleEvents
    .filter((e) => e.level === level && (stage === undefined || e.stage === stage))
    .map((e) => String(e.message));
}

async function assertCleanedUp(run: RunResult): Promise<void> {
  assert.equal(
    fs.existsSync(path.join(DATA_DIR, "worktrees", String(run.visualizationId))),
    false,
    "worktree folder removed"
  );
  const worktrees = git(run.clone, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 1, `only the main worktree remains: ${worktrees.join(", ")}`);
  assert.equal(git(run.clone, ["for-each-ref", "refs/prvision/"]).trim(), "", "no refs/prvision/* left");
  assert.equal(git(run.clone, ["status", "--porcelain"]).trim(), "", "clone working tree untouched");
  assert.deepEqual(nodeModulesEntries(run.clone), run.nodeModulesEntries, "no new node_modules entries in the clone");
  assert.equal(AngularHostClient.liveCount(), 0, "no Angular host registered as live");
  assert.deepEqual(await leftoverRenderProcesses(), [], "no Angular host, esbuild or Chromium process left behind");
}

function summaryUsesAngularWording(run: RunResult): void {
  const [summary] = run.scripted.callsFor("summary");
  assert.ok(summary, "one summary call");
  assert.match(summary.system, /an Angular application/, "Angular summary system prompt");
  assert.doesNotMatch(summary.system, /React application/);
}

// ---------------------------------------------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------------------------------------------

describe(
  "Angular pipeline end to end (real git, Angular build, Chromium and Postgres; scripted AI)",
  { skip: SKIP },
  () => {
    let pool: PgPool;
    let restoreDb: () => void = () => undefined;

    before(async () => {
      assert.match(
        decodeURIComponent(new URL(TEST_DATABASE_URL).pathname.replace(/^\//, "")),
        /_test$/,
        "PRVISION_TEST_DATABASE_URL must name a *_test database"
      );
      pool = new Pool({ connectionString: TEST_DATABASE_URL, max: 5, options: "-c timezone=UTC" });
      await pool.query("drop schema public cascade");
      await pool.query("create schema public");
      await pool.query("drop schema if exists drizzle cascade");
      await migrate(drizzle(pool), {
        migrationsFolder: MIGRATIONS_FOLDER,
        migrationsTable: "__drizzle_migrations",
        migrationsSchema: "drizzle"
      });
      const db = drizzle(pool, { schema });
      restoreDb = patchStaticMethod(DrizzleDb, "getInstance", () => db);
    });

    after(async () => {
      restoreDb();
      await pool.end();
    });

    test("feature/badge-restyle: every stage runs and BadgeComponent and its parent render on both sides", async (t) => {
      const run = await runVisualization(t, "feature/badge-restyle");
      const v = run.visualization;
      assertCompleted(run);
      assert.equal(String(v.baseSha), git(run.clone, ["merge-base", "main", "feature/badge-restyle"]).trim());
      assert.equal(String(v.headSha), git(run.clone, ["rev-parse", "feature/badge-restyle"]).trim());

      assert.deepEqual(
        shape(run),
        [
          {
            displayName: "BadgeComponent",
            changeKind: "modified",
            changeReason: `Template changed: ${web("src/app/shared/badge/badge.component.html")}`
          },
          {
            displayName: "OrderListComponent",
            changeKind: "affected_parent",
            changeReason: "Uses changed component BadgeComponent (app-badge) in its template"
          }
        ],
        run.dump
      );
      const badge = component(run, "BadgeComponent");
      const orderList = component(run, "OrderListComponent");
      assert.equal(badge.exportName, "BadgeComponent");
      assert.equal(badge.filePath, web("src/app/shared/badge/badge.component.ts"));
      assert.match(String(badge.codeDiff), /badge\.component\.html/);
      for (const c of run.components) {
        assertRenderedPair(run, c);
        assert.equal(c.visualChange, "changed", `${String(c.displayName)} visual change:\n${run.dump}`);
        assert.equal(c.aiNote, "Scripted note.");
      }
      assert.ok(Number(badge.diffPixelRatio) > 0.01, `badge ratio ${String(badge.diffPixelRatio)}`);
      assert.ok(Number(orderList.diffPixelRatio) > 0, `order list ratio ${String(orderList.diffPixelRatio)}`);

      assert.equal(v.componentCount, 2);
      assert.equal(v.changedCount, 2);
      assert.equal(v.summaryMarkdown, SUMMARY_TEXT);
      assert.equal(run.scripted.callsFor("harness").length, 2);
      assert.equal(run.scripted.callsFor("harness_repair").length, 0);
      assert.equal(run.scripted.callsFor("summary").length, 1);
      summaryUsesAngularWording(run);
      const usage = v.aiUsage as Record<string, unknown>;
      assert.equal(usage.calls, 3);
      assert.equal(usage.inputTokens, 3 * STEP_USAGE.inputTokens);

      assert.deepEqual(firstStages(run), [...PIPELINE_STAGES], run.dump);
      assert.deepEqual(messages(run, "error"), [], "no console errors");
      assert.ok(
        messages(run, "info", "analyzing").some((m) =>
          /^Angular workspace apps\/web, project web: \d+ components indexed on head/.test(m)
        ),
        run.dump
      );
      assert.ok(
        messages(run, "info", "rendering").some((m) => /^Angular [\d.]+ build \(.+\) for the base side/.test(m)),
        run.dump
      );
      await assertCleanedUp(run);
    });

    test("qa/build-error: head fails module_load with NG8002, base renders, the template structural diff runs", async (t) => {
      const run = await runVisualization(t, "qa/build-error");
      assertCompleted(run);
      assert.deepEqual(
        shape(run),
        [
          {
            displayName: "OrderListComponent",
            changeKind: "modified",
            changeReason: `Template changed: ${web("src/app/orders/order-list/order-list.component.html")}`
          }
        ],
        run.dump
      );
      const orderList = component(run, "OrderListComponent");
      assert.equal(orderList.baseError, null, run.dump);
      assert.ok(orderList.baseImagePath, "base image");
      // base_error/head_error hold formatRenderError text: "[<kind>] <headline>" plus sections (10 §5.12).
      const headError = String(orderList.headError);
      assert.match(headError, /^\[module_load\] /, run.dump);
      assert.match(headError, /NG8002: Can't bind to 'size' since it isn't a known property of 'app-badge'/);
      assert.match(headError, /order-list\.component\.html:18:/);
      assert.equal(orderList.headImagePath, null);
      assert.equal(orderList.diffPixelRatio, null);

      const structural = orderList.structuralDiff as StructuralChange[] | null;
      assert.ok(Array.isArray(structural) && structural.length > 0, `structural diff expected:\n${run.dump}`);
      assert.deepEqual(
        structural.map((change) => ({ kind: change.kind, tag: "tag" in change ? change.tag : null })),
        [{ kind: "attribute_changed", tag: "app-badge" }]
      );
      const [change] = structural;
      assert.ok(change?.kind === "attribute_changed");
      assert.equal(change.attribute, "[size]");
      assert.match(change.path, /@for > li\{key=\{order\.id\}\}.*> app-badge$/);

      // A one-side failure of a two-sided component is reported as partial and never repaired (00 §14.7, 10 R8).
      assert.equal(orderList.renderStatus, "partial", run.dump);
      assert.equal(renderRepairs(run).length, 0, run.dump);
      assert.ok(
        messages(run, "warn", "rendering").some((m) => m.startsWith("OrderListComponent: head failed (module_load)")),
        `build failure reported on the console:\n${run.dump}`
      );
      // The only harness in the build is not to blame, so nothing is excluded or rebuilt.
      assert.ok(!messages(run, "warn", "rendering").some((m) => /rebuilding without them/.test(m)), run.dump);
      summaryUsesAngularWording(run);
      await assertCleanedUp(run);
    });

    test("qa/render-failure: head throws in ngOnInit; both components end partial with the base image", async (t) => {
      const run = await runVisualization(t, "qa/render-failure");
      assertCompleted(run);
      assert.deepEqual(
        shape(run),
        [
          { displayName: "BadgeComponent", changeKind: "modified", changeReason: "Component code changed" },
          {
            displayName: "OrderListComponent",
            changeKind: "affected_parent",
            changeReason: "Uses changed component BadgeComponent (app-badge) in its template"
          }
        ],
        run.dump
      );
      for (const c of run.components) {
        const label = String(c.displayName);
        assert.equal(c.baseError, null, `${label} base renders:\n${run.dump}`);
        assert.ok(c.baseImagePath, `${label} base image`);
        const headError = String(c.headError);
        assert.match(headError, /^\[render_error\] /, `${label}:\n${run.dump}`);
        assert.match(headError, /danger tone is not supported yet/);
        assert.equal(c.headImagePath, null);
        assert.equal(c.renderStatus, "partial", `${label}:\n${run.dump}`);
        assert.equal(c.diffPixelRatio, null);
        // No pixel comparison, so 15e's template structural diff ran (the templates are identical: no changes).
        assert.deepEqual(c.structuralDiff, [], `${label} structural diff:\n${run.dump}`);
      }
      // 00 §14.7 / 10 R8: the base side renders, so the head failure is the component's own and is not repaired.
      // (15 §5.9.2 expects a component_defect repair here; the contract rule wins: see docs/build-notes/15-e2e.md.)
      assert.equal(renderRepairs(run).length, 0, run.dump);
      assert.ok(
        messages(run, "info", "diffing").includes(
          "Comparing template structure for 2 components that could not be compared visually."
        ),
        run.dump
      );
      summaryUsesAngularWording(run);
      await assertCleanedUp(run);
    });

    test("qa/ngmodule-chip: NgModule-declared chip and its parent render; the never-stable warning is logged", async (t) => {
      const run = await runVisualization(t, "qa/ngmodule-chip");
      assertCompleted(run);
      assert.deepEqual(
        shape(run),
        [
          { displayName: "LegacyChipComponent", changeKind: "modified", changeReason: "Component code changed" },
          {
            displayName: "NotificationBellComponent",
            changeKind: "affected_parent",
            changeReason: "Uses changed component LegacyChipComponent (app-legacy-chip) in its template"
          }
        ],
        run.dump
      );
      for (const c of run.components) {
        assertRenderedPair(run, c);
        assert.equal(c.visualChange, "changed", `${String(c.displayName)}:\n${run.dump}`);
      }
      for (const side of ["base", "head"]) {
        assert.ok(
          messages(run, "warn", "rendering").some(
            (m) =>
              m.startsWith(`NotificationBellComponent (${side}): the app never became stable`) &&
              m.includes("captured anyway")
          ),
          `never-stable warning for the ${side} side:\n${run.dump}`
        );
      }
      assert.ok(
        !messages(run, "warn", "rendering").some(
          (m) => m.startsWith("LegacyChipComponent") && m.includes("never became stable")
        ),
        "the chip alone is stable"
      );
      await assertCleanedUp(run);
    });

    test("qa/signal-inputs: signal inputs render; the head-only input is skipped on base", async (t) => {
      const run = await runVisualization(t, "qa/signal-inputs");
      assertCompleted(run);
      assert.deepEqual(
        shape(run),
        [{ displayName: "SignalCardComponent", changeKind: "modified", changeReason: "Component code changed" }],
        run.dump
      );
      const card = component(run, "SignalCardComponent");
      assertRenderedPair(run, card);
      assert.equal(card.visualChange, "changed");
      assert.ok(Number(card.diffPixelRatio) > 0, run.dump);
      assert.ok(
        messages(run, "info", "rendering").some(
          (m) => m === "SignalCardComponent (base): inputs not declared on this side were skipped: trend."
        ),
        run.dump
      );
      assert.ok(
        !messages(run, "info", "rendering").some((m) =>
          m.startsWith("SignalCardComponent (head): inputs not declared")
        ),
        run.dump
      );
      await assertCleanedUp(run);
    });

    test("qa/replaced-component (last commit): one replaced row, R rendered on base and A on head, with a diff (00 §17)", async (t) => {
      const run = await runVisualization(t, "qa/replaced-component", { lastCommitOnly: true });
      assertCompleted(run);
      const replacedRows = run.components.filter((c) => c.changeKind === "replaced");
      assert.equal(replacedRows.length, 1, run.dump);
      const replaced = replacedRows[0] ?? {};
      assert.equal(replaced.displayName, "OrderNoteFormModalComponent", run.dump);
      assert.equal(replaced.exportName, "OrderNoteFormModalComponent");
      assert.equal(replaced.filePath, web("src/app/orders/order-note-form-modal/order-note-form-modal.component.ts"));
      assert.equal(replaced.baseDisplayName, "OrderNoteFormComponent");
      assert.equal(replaced.baseExportName, "OrderNoteFormComponent");
      assert.equal(replaced.baseFilePath, web("src/app/orders/order-note-form/order-note-form.component.ts"));
      assert.match(
        String(replaced.changeReason),
        /^Replaced by OrderNoteFormModalComponent \(call site swap in order-list/
      );
      const evidence = replaced.successorEvidence as Array<{ kind: string; detail: string }>;
      assert.deepEqual(
        evidence[0],
        {
          kind: "call_site_swap",
          detail: `${web("src/app/orders/order-list/order-list.component.html")}: <app-order-note-form> → <app-order-note-form-modal>`
        },
        run.dump
      );
      assert.ok(evidence.some((item) => item.kind === "name_similarity"));
      // R and A are not listed again as removed and added rows
      assert.equal(
        run.components.some((c) => c.changeKind === "removed" || c.changeKind === "added"),
        false,
        run.dump
      );
      assert.ok(
        run.components.some((c) => c.displayName === "OrderListComponent" && c.changeKind === "modified"),
        run.dump
      );

      // images on both sides and a pixel diff; each side's own harness was persisted
      assertRenderedPair(run, replaced);
      assert.match(String(replaced.harnessSource), /OrderNoteFormModalComponent/);
      assert.match(String(replaced.baseHarnessSource), /import \{ OrderNoteFormComponent \} from/);
      assert.doesNotMatch(String(replaced.baseHarnessSource), /OrderNoteFormModalComponent/);
      assert.equal(replaced.visualChange, "changed", run.dump);
      assert.ok(Number(replaced.diffPixelRatio) > 0.01, `replaced ratio ${String(replaced.diffPixelRatio)}`);

      // two harness calls for the replaced row (A from head, R from base) plus OrderList; the summary is told
      const harnessPrompts = run.scripted
        .callsFor("harness")
        .map((request) => /^component: (\w+)$/m.exec(request.prompt)?.[1]);
      assert.deepEqual(
        [...harnessPrompts].sort(),
        ["OrderListComponent", "OrderNoteFormComponent", "OrderNoteFormModalComponent"].sort()
      );
      const [summary] = run.scripted.callsFor("summary");
      assert.match(summary?.prompt ?? "", /- Replaces: OrderNoteFormComponent \(/);
      summaryUsesAngularWording(run);
      assert.ok(
        messages(run, "info", "analyzing").some((m) =>
          m.startsWith("OrderNoteFormComponent was replaced by OrderNoteFormModalComponent (call site swap")
        ),
        run.dump
      );
      assert.equal(run.visualization.changedCount, run.components.filter((c) => c.visualChange === "changed").length);
      await assertCleanedUp(run);
    });

    test("qa/template-formatting: a re-indented template yields no candidates and no AI harness calls", async (t) => {
      const run = await runVisualization(t, "qa/template-formatting");
      assertCompleted(run);
      assert.deepEqual(run.components, [], run.dump);
      assert.equal(run.visualization.componentCount, 0);
      assert.equal(run.visualization.changedCount, 0);
      assert.equal(run.scripted.callsFor("harness").length, 0);
      assert.equal(run.scripted.callsFor("harness_repair").length, 0);
      assert.deepEqual(messages(run, "error"), [], "no console errors");
      await assertCleanedUp(run);
    });

    test("qa/service-change: the injecting component is an affected parent and shows the new mapping", async (t) => {
      const run = await runVisualization(t, "qa/service-change");
      assertCompleted(run);
      assert.deepEqual(
        shape(run),
        [
          {
            displayName: "OrderListComponent",
            changeKind: "affected_parent",
            changeReason: `Injects changed service ${web("src/app/orders/orders.service.ts")}`
          }
        ],
        run.dump
      );
      const orderList = component(run, "OrderListComponent");
      assertRenderedPair(run, orderList);
      assert.equal(orderList.visualChange, "changed");
      assert.ok(Number(orderList.diffPixelRatio) > 0, run.dump);
      await assertCleanedUp(run);
    });

    test("qa/global-style: representatives ranked by usage (BadgeComponent first) render on both sides", async (t) => {
      const run = await runVisualization(t, "qa/global-style");
      assertCompleted(run);
      const reason = `Global stylesheet changed: ${web("src/styles.css")}`;
      assert.ok(run.components.length >= 2, run.dump);
      assert.equal(run.components[0]?.displayName, "BadgeComponent", run.dump);
      for (const c of run.components) {
        assert.equal(c.changeKind, "affected_parent", run.dump);
        assert.equal(c.changeReason, reason, run.dump);
        assertRenderedPair(run, c);
      }
      assert.ok(
        messages(run, "info", "analyzing").includes(
          `Global change: showing ${String(run.components.length)} widely used components.`
        ),
        run.dump
      );
      // Badge does not use .card; the order list's <section class="card"> grows with the padding.
      assert.equal(component(run, "BadgeComponent").visualChange, "unchanged", run.dump);
      assert.equal(component(run, "BadgeComponent").diffPixelRatio, 0, run.dump);
      assert.equal(component(run, "OrderListComponent").visualChange, "changed", run.dump);
      await assertCleanedUp(run);
    });
  }
);
