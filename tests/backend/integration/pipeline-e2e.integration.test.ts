/**
 * Full-chain pipeline integration test (00 §11, 14 §5.8 "pipeline-local-branch", 14 §5.10.6): the real
 * VisualizationWorkerService drives a `local_branch` visualization of `feature/button-restyle` on a clone of the
 * fixture repo through queued → preparing → analyzing → generating_harnesses → rendering → diffing → summarizing →
 * completed, with real git, real Vite, real Chromium and a real Postgres test database. Only the AI provider is
 * scripted (14's ScriptedAiProvider, injected through the worker's `createProvider` seam): it returns hand-written
 * harnesses that pass 09's validator and a schema-valid summary.
 *
 * Gated on PRVISION_IT_RENDER=1 (or PRVISION_INTEGRATION=1) and PRVISION_TEST_DATABASE_URL (a `*_test` database;
 * its public and drizzle schemas are dropped and re-migrated, as in sheet 03's migrations test).
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
import { ViteHostClient } from "../../../backend/src/services/visualizations/pipeline/render/vite-host-client";
import { VisualizationWorkerService } from "../../../backend/src/services/visualizations/pipeline/visualization-worker-service";
import { VisualizationsService } from "../../../backend/src/services/visualizations/visualizations-service";
import type { AiStructuredRequest } from "../../../backend/src/types/visualization-pipeline";
import { DrizzleDb } from "../../../backend/src/utilities/services/drizzle-db";
import { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { ScriptedAiProvider, type ScriptStep } from "../helpers/ai-provider-stub";
import { makeJob } from "../helpers/fake-queue";
import { isolatedGitEnv } from "../helpers/temp-git-repo";
import { patchStaticMethod } from "../helpers/test-context";
import { FakeQueueStatics } from "../visualizations/helpers/fakes";
import { cloneFixture } from "./helpers/fixture";
import { itSkip } from "./helpers/it-flags";

const { drizzle } = drizzleNodePostgres;
const { migrate } = drizzleMigrator;
const { Pool } = pg;

const TEST_DATABASE_URL = process.env.PRVISION_TEST_DATABASE_URL ?? "";
const SKIP =
  itSkip("render") ||
  (TEST_DATABASE_URL === "" ? "set PRVISION_TEST_DATABASE_URL (a *_test Postgres database; it is reset)" : false);

const HEAD_BRANCH = "feature/button-restyle";
/** Console stages in order: `queued` is written by VisualizationsService.create, the rest by the worker. */
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

// ---------------------------------------------------------------------------------------------------------------
// Hand-written harnesses (16 §7.3 shape: definePrvisionHarness with a Default state, exact target import, inline styles only)
// ---------------------------------------------------------------------------------------------------------------

const NOOP = "const noop = (): void => {};\n";

interface ScriptedHarness {
  /** The exact import statement 09 puts in <target> (targetImportStatement). */
  importStatement: string;
  harnessSource: string;
  mockedModules: Array<{ specifier: string; source: string; reason: string }>;
  notes: string;
}

const HARNESSES: Record<string, ScriptedHarness> = {
  Button: {
    importStatement: `import Button from "../../src/components/Button";`,
    harnessSource: `import type { ReactElement } from "react";
import { definePrvisionHarness } from "../harness-api";
import Button from "../../src/components/Button";

${NOOP}
function DefaultState(): ReactElement {
  return (
    <div style={{ padding: 24, width: 360, display: "flex", flexDirection: "column", gap: 16, alignItems: "flex-start" }}>
      <Button variant="primary" onClick={noop}>Save changes</Button>
      <Button variant="secondary" onClick={noop}>Cancel</Button>
    </div>
  );
}

export default definePrvisionHarness({ states: [{ name: "Default", render: DefaultState }] });
`,
    mockedModules: [],
    notes: "Primary and secondary variants."
  },
  Card: {
    importStatement: `import Card from "../../src/components/Card";`,
    harnessSource: `import type { ReactElement } from "react";
import { definePrvisionHarness } from "../harness-api";
import Card from "../../src/components/Card";

${NOOP}
function DefaultState(): ReactElement {
  return (
    <div style={{ padding: 24, width: 360 }}>
      <Card title="Quarterly report" description="Revenue grew 12% over the last quarter." actionLabel="Open report" status="new" onAction={noop} />
    </div>
  );
}

export default definePrvisionHarness({ states: [{ name: "Default", render: DefaultState }] });
`,
    mockedModules: [],
    notes: "Card with the new status badge (base ignores the status prop)."
  },
  Badge: {
    importStatement: `import { Badge } from "../../src/components/Badge";`,
    harnessSource: `import type { ReactElement } from "react";
import { definePrvisionHarness } from "../harness-api";
import { Badge } from "../../src/components/Badge";

function DefaultState(): ReactElement {
  return (
    <div style={{ padding: 24, width: 360, display: "flex", gap: 8 }}>
      <Badge tone="neutral">Draft</Badge>
      <Badge tone="success">New</Badge>
      <Badge tone="warning">Pending</Badge>
    </div>
  );
}

export default definePrvisionHarness({ states: [{ name: "Default", render: DefaultState }] });
`,
    mockedModules: [],
    notes: "All three tones."
  },
  UserMenu: {
    importStatement: `import UserMenu from "../../src/components/UserMenu";`,
    harnessSource: `import type { ReactElement } from "react";
import { definePrvisionHarness } from "../harness-api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import UserMenu from "../../src/components/UserMenu";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnMount: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false
    },
    mutations: { retry: false }
  }
});
queryClient.setQueryData(["auth", "me"], {
  id: "usr_1001",
  firstName: "Ada",
  lastName: "Lovelace",
  email: "ada@example.com"
});

function DefaultState(): ReactElement {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/dashboard"]}>
        <div style={{ padding: 24, width: 360 }}>
          <UserMenu />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

export default definePrvisionHarness({ states: [{ name: "Default", render: DefaultState }] });
`,
    mockedModules: [],
    notes: "Signed-in user seeded into the react-query cache under [auth, me]."
  },
  // qa/replaced-component (00 §17): the page, the removed form (base harness) and its successor (head harness)
  Notes: {
    importStatement: `import Notes from "../../src/pages/Notes";`,
    harnessSource: `import type { ReactElement } from "react";
import { definePrvisionHarness } from "../harness-api";
import Notes from "../../src/pages/Notes";

function DefaultState(): ReactElement {
  return (
    <div style={{ width: 560 }}>
      <Notes />
    </div>
  );
}

export default definePrvisionHarness({ states: [{ name: "Default", render: DefaultState }] });
`,
    mockedModules: [],
    notes: "The notes page."
  },
  NoteFormModal: {
    importStatement: `import { NoteFormModal } from "../../src/components/notes/NoteFormModal";`,
    harnessSource: `import type { ReactElement } from "react";
import { definePrvisionHarness } from "../harness-api";
import { NoteFormModal } from "../../src/components/notes/NoteFormModal";

${NOOP}
function DefaultState(): ReactElement {
  return (
    <div style={{ padding: 24, width: 480 }}>
      <NoteFormModal title="Add a note" onSave={noop} onClose={noop} />
    </div>
  );
}

export default definePrvisionHarness({ states: [{ name: "Default", render: DefaultState }] });
`,
    mockedModules: [],
    notes: "The note dialog."
  },
  NoteForm: {
    importStatement: `import { NoteForm } from "../../src/components/notes/NoteForm";`,
    harnessSource: `import type { ReactElement } from "react";
import { definePrvisionHarness } from "../harness-api";
import { NoteForm } from "../../src/components/notes/NoteForm";

${NOOP}
function DefaultState(): ReactElement {
  return (
    <div style={{ padding: 24, width: 480 }}>
      <NoteForm title="Add a note" onSave={noop} />
    </div>
  );
}

export default definePrvisionHarness({ states: [{ name: "Default", render: DefaultState }] });
`,
    mockedModules: [],
    notes: "The inline note form."
  }
};

/** Answers a harness request with the harness whose exact target import statement the prompt carries. */
function harnessFor(request: AiStructuredRequest): unknown {
  const match = Object.entries(HARNESSES).find(([, h]) => request.prompt.includes(h.importStatement));
  if (!match) {
    throw new Error(`no scripted harness for this prompt:\n${request.prompt.slice(0, 2_000)}`);
  }
  const [, h] = match;
  return { status: "ok", harnessSource: h.harnessSource, mockedModules: h.mockedModules, notes: h.notes };
}

/** A schema-valid summary covering exactly the `[#id]` components of the prompt (11 §5.4). */
function summaryFor(request: AiStructuredRequest): unknown {
  const ids = [...request.prompt.matchAll(/^## \[#(\d+)\]/gm)].map((m) => Number(m[1]));
  return {
    summaryMarkdown: "The primary button moved from indigo to emerald and Card gained a status badge.",
    components: ids.map((componentId) => ({ componentId, note: "Visible restyle.", risk: "check" }))
  };
}

const harnessSteps = (count = 4): ScriptStep[] =>
  Array.from({ length: count }, (): ScriptStep => ({ kind: "fn", fn: (request) => harnessFor(request) }));

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

/** Vite host or Chromium processes still running under this test process (waits up to 5 s for exits). */
async function leftoverRenderProcesses(): Promise<string[]> {
  const pattern = /vite-host-process|chrom(e|ium)|headless_shell|ms-playwright/i;
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
  outcome: string;
  clone: string;
  scripted: ScriptedAiProvider;
  visualization: Record<string, unknown>;
  components: Array<Record<string, unknown>>;
  consoleEvents: Array<Record<string, unknown>>;
}

/**
 * Registers a fresh clone, creates the visualization through the API service, runs the real worker. By default the
 * `local_branch` HEAD_BRANCH vs main; `lastCommitOnly` visualizes `headRef`'s last commit as a `commit_range`.
 */
async function runVisualization(
  t: TestContext,
  summary: ScriptStep[],
  options: { headRef?: string; lastCommitOnly?: boolean; harnessCalls?: number } = {}
): Promise<RunResult> {
  const clone = cloneFixture(t);
  const queryHandler = new QueryHandler();
  const queue = new FakeQueueStatics();

  const payload = new RepositoryModel();
  payload.setLocalPath(clone);
  const registered = await new RepositoriesService(payload).create();
  assert.equal(registered.status, 201, `repository registration: ${JSON.stringify(registered)}`);
  const repositoryId = registered.data?.id ?? 0;

  const headRef = options.headRef ?? HEAD_BRANCH;
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
  assert.deepEqual(queue.enqueued, [visualizationId]);

  const scripted = new ScriptedAiProvider({ harness: harnessSteps(options.harnessCalls), summary });
  const worker = new VisualizationWorkerService({ createProvider: () => scripted, queue });
  const outcome = await worker.run(makeJob(visualizationId).job);

  const [visualization] = await queryHandler.select({ id: visualizationId }, Table.VISUALIZATIONS, true);
  assert.ok(visualization, "visualization row");
  const components = await queryHandler.select({ visualizationId }, Table.VISUALIZATION_COMPONENTS, true);
  components.sort((a, b) => Number(a.rank) - Number(b.rank));
  const consoleEvents = await queryHandler.select({ visualizationId }, Table.VISUALIZATION_CONSOLE_EVENTS, true);
  consoleEvents.sort((a, b) => Number(a.id) - Number(b.id));
  return { visualizationId, outcome, clone, scripted, visualization, components, consoleEvents };
}

function consoleDump(events: Array<Record<string, unknown>>): string {
  return events.map((e) => `[${String(e.level)}] ${String(e.stage)}: ${String(e.message)}`).join("\n");
}

function artifactPath(visualizationId: number, componentId: unknown, kind: "base" | "head" | "diff"): string {
  return `artifacts/${String(visualizationId)}/${String(componentId)}/${kind}.png`;
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
  assert.equal(ViteHostClient.liveCount(), 0, "no Vite host registered as live");
  assert.deepEqual(await leftoverRenderProcesses(), [], "no Vite or Chromium process left behind");
}

// ---------------------------------------------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------------------------------------------

describe("pipeline end to end (real git, Vite, Chromium and Postgres; scripted AI)", { skip: SKIP }, () => {
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
    // Every QueryHandler, transaction and SettingsStore goes through DrizzleDb.getInstance().
    restoreDb = patchStaticMethod(DrizzleDb, "getInstance", () => db);
  });

  after(async () => {
    restoreDb();
    await pool.end();
  });

  test("feature/button-restyle runs every stage and completes with the expected components", async (t) => {
    const run = await runVisualization(t, [{ kind: "fn", fn: (request) => summaryFor(request) }]);
    const { visualizationId, visualization: v, components } = run;
    const dump = consoleDump(run.consoleEvents);

    assert.equal(run.outcome, "completed", dump);
    assert.equal(v.status, "completed", dump);
    assert.equal(v.failedStage, null);
    assert.equal(v.errorMessage, null);
    assert.ok(v.completedAt instanceof Date, "completed_at set");
    assert.match(String(v.baseSha), /^[0-9a-f]{40}$/);
    assert.equal(String(v.baseSha), git(run.clone, ["merge-base", "main", HEAD_BRANCH]).trim(), "baseSha = merge-base");
    assert.equal(String(v.headSha), git(run.clone, ["rev-parse", HEAD_BRANCH]).trim());

    // Components (14 §5.10.6).
    const expected = [
      { displayName: "Card", exportName: "default", changeKind: "modified", visualChange: "changed" },
      { displayName: "Button", exportName: "default", changeKind: "modified", visualChange: "changed" },
      { displayName: "Badge", exportName: "Badge", changeKind: "added", visualChange: "new" },
      { displayName: "UserMenu", exportName: "default", changeKind: "affected_parent", visualChange: "changed" }
    ];
    assert.deepEqual(
      components.map((c) => ({
        displayName: c.displayName,
        exportName: c.exportName,
        changeKind: c.changeKind,
        visualChange: c.visualChange
      })),
      expected,
      dump
    );
    for (const [index, c] of components.entries()) {
      const label = String(c.displayName);
      assert.equal(c.rank, index, `${label} rank`);
      assert.equal(
        c.renderStatus,
        "rendered",
        `${label} renderStatus (base: ${String(c.baseError)}; head: ${String(c.headError)})`
      );
      assert.equal(c.skipReason, null, `${label} skipReason`);
      assert.equal(typeof c.changeReason, "string", `${label} changeReason`);
      assert.equal(c.baseError, null, `${label} baseError`);
      assert.equal(c.headError, null, `${label} headError`);
      assert.ok(String(c.harnessSource).includes("definePrvisionHarness"), `${label} harness persisted`);
      assert.equal(c.headImagePath, artifactPath(visualizationId, c.id, "head"), `${label} head image path`);
      assert.ok(fs.existsSync(path.join(DATA_DIR, c.headImagePath)), `${label} head.png on disk`);
      assert.ok(Number(c.imageWidth) > 0 && Number(c.imageHeight) > 0, `${label} image size`);
      assert.equal(typeof c.aiNote, "string", `${label} ai note from the summary`);
      assert.equal(c.risk, "check", `${label} risk from the summary`);
      if (c.changeKind === "added") {
        assert.equal(c.baseImagePath, null, `${label} has no base image`);
        assert.equal(c.diffPixelRatio, null, `${label} has no pixel ratio`);
        continue;
      }
      assert.equal(c.baseImagePath, artifactPath(visualizationId, c.id, "base"), `${label} base image path`);
      assert.ok(fs.existsSync(path.join(DATA_DIR, c.baseImagePath)), `${label} base.png on disk`);
      assert.equal(c.diffImagePath, artifactPath(visualizationId, c.id, "diff"), `${label} diff image path`);
      assert.ok(fs.existsSync(path.join(DATA_DIR, c.diffImagePath)), `${label} diff.png on disk`);
      assert.ok(Number(c.diffPixelRatio) > 0, `${label} diffPixelRatio > 0 (got ${String(c.diffPixelRatio)})`);
      // 11 §5.3.1: structural diff runs only when there is no pixel comparison, so it stays null here.
      assert.equal(c.structuralDiff, null, `${label} structural diff not run for a pixel-compared pair`);
    }
    const [card, , , userMenu] = components;
    assert.ok(card && userMenu);
    assert.equal(card.changeReason, "Component code changed");
    assert.equal(userMenu.changeReason, "Imports changed hook src/auth/useAuth.ts");
    assert.equal(userMenu.codeDiff, null);

    // Counts (00 §14.3) and summary.
    assert.equal(v.componentCount, 4);
    assert.equal(v.changedCount, 4);
    assert.equal(v.summaryMarkdown, "The primary button moved from indigo to emerald and Card gained a status badge.");

    // AI usage: 4 harness calls + 1 summary call, accumulated only through AiUsageRecorder.
    assert.equal(run.scripted.callsFor("harness").length, 4);
    assert.equal(run.scripted.callsFor("harness_repair").length, 0);
    assert.equal(run.scripted.callsFor("summary").length, 1);
    run.scripted.assertExhausted();
    const usage = v.aiUsage as Record<string, unknown>;
    assert.equal(usage.inputTokens, 5 * STEP_USAGE.inputTokens);
    assert.equal(usage.outputTokens, 5 * STEP_USAGE.outputTokens);
    assert.equal(usage.calls, 5);

    // Console: every stage, first events in pipeline order, no errors.
    const firstSeen: string[] = [];
    for (const event of run.consoleEvents) {
      const stage = String(event.stage);
      if (!firstSeen.includes(stage)) {
        firstSeen.push(stage);
      }
    }
    assert.deepEqual(firstSeen, [...PIPELINE_STAGES], dump);
    assert.deepEqual(
      run.consoleEvents.filter((e) => e.level === "error").map((e) => e.message),
      [],
      "no console errors"
    );
    assert.ok(
      run.consoleEvents.some(
        (e) => e.stage === "completed" && /Completed: 4 of 4 component\(s\) changed/.test(String(e.message))
      ),
      dump
    );

    await assertCleanedUp(run);
  });

  test("an AI error in the summary still completes the run with summary null and a console warning", async (t) => {
    const errorUsage = { inputTokens: 10, outputTokens: 0, calls: 1 };
    const run = await runVisualization(t, [
      { kind: "error", reason: "network", message: "scripted summary outage", retryable: false, usage: errorUsage }
    ]);
    const { visualization: v, components } = run;
    const dump = consoleDump(run.consoleEvents);

    assert.equal(run.outcome, "completed", dump);
    assert.equal(v.status, "completed", dump);
    assert.equal(v.failedStage, null);
    assert.equal(v.summaryMarkdown, null);
    assert.equal(v.componentCount, 4);
    assert.equal(v.changedCount, 4);
    assert.ok(
      components.every((c) => c.renderStatus === "rendered"),
      dump
    );
    assert.ok(components.every((c) => c.aiNote === null));

    assert.ok(
      run.consoleEvents.some((e) => e.stage === "summarizing" && e.level === "warn"),
      `summary warning expected:\n${dump}`
    );
    assert.ok(
      run.consoleEvents.some((e) => e.stage === "completed"),
      `completed event expected:\n${dump}`
    );

    // The failed call's usage is recorded too (00 §14.4 AiProviderError.usage).
    const usage = v.aiUsage as Record<string, unknown>;
    assert.equal(usage.inputTokens, 4 * STEP_USAGE.inputTokens + errorUsage.inputTokens);
    assert.equal(usage.outputTokens, 4 * STEP_USAGE.outputTokens);
    assert.equal(usage.calls, 5);

    await assertCleanedUp(run);
  });

  test("qa/replaced-component (last commit): one replaced row, NoteForm on base and NoteFormModal on head (00 §17)", async (t) => {
    const run = await runVisualization(t, [{ kind: "fn", fn: (request) => summaryFor(request) }], {
      headRef: "qa/replaced-component",
      lastCommitOnly: true,
      harnessCalls: 3
    });
    const { visualizationId, visualization: v, components } = run;
    const dump = [
      consoleDump(run.consoleEvents),
      ...components.map(
        (c) => `#${String(c.rank)} ${String(c.displayName)} ${String(c.changeKind)} ${String(c.renderStatus)}`
      )
    ].join("\n");
    assert.equal(run.outcome, "completed", dump);
    assert.equal(v.status, "completed", dump);
    assert.deepEqual(
      components.map((c) => [c.displayName, c.changeKind]),
      [
        ["NoteFormModal", "replaced"],
        ["Notes", "modified"]
      ],
      dump
    );
    const replaced = components[0] ?? {};
    assert.equal(replaced.filePath, "src/components/notes/NoteFormModal.tsx");
    assert.equal(replaced.exportName, "NoteFormModal");
    assert.equal(replaced.baseFilePath, "src/components/notes/NoteForm.tsx");
    assert.equal(replaced.baseExportName, "NoteForm");
    assert.equal(replaced.baseDisplayName, "NoteForm");
    assert.equal(
      replaced.changeReason,
      "Replaced by NoteFormModal (call site swap in Notes, similar name, similar markup)"
    );
    assert.deepEqual((replaced.successorEvidence as Array<{ kind: string; detail: string }>)[0], {
      kind: "call_site_swap",
      detail: "src/pages/Notes.tsx: <NoteForm> → <NoteFormModal>"
    });

    // images on both sides plus a pixel diff; each side rendered its own harness
    assert.equal(replaced.renderStatus, "rendered", dump);
    assert.equal(replaced.baseError, null);
    assert.equal(replaced.headError, null);
    for (const kind of ["base", "head", "diff"] as const) {
      const relative = artifactPath(visualizationId, replaced.id, kind);
      assert.equal(replaced[`${kind}ImagePath`], relative);
      assert.ok(fs.existsSync(path.join(DATA_DIR, relative)), `${kind}.png on disk`);
    }
    assert.equal(replaced.visualChange, "changed", dump);
    assert.ok(Number(replaced.diffPixelRatio) > 0.01, `ratio ${String(replaced.diffPixelRatio)}`);
    assert.equal(replaced.harnessSource, HARNESSES.NoteFormModal?.harnessSource);
    assert.equal(replaced.baseHarnessSource, HARNESSES.NoteForm?.harnessSource);
    assert.equal(run.scripted.callsFor("harness").length, 3, "Notes, then A from head and R from base");
    assert.match(
      run.scripted.callsFor("summary")[0]?.prompt ?? "",
      /- Replaces: NoteForm \(`src\/components\/notes\/NoteForm\.tsx`/
    );
    assert.equal(v.changedCount, 2, dump);
    await assertCleanedUp(run);
  });
});
