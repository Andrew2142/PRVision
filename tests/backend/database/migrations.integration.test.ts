/**
 * Real-Postgres migration tests (03 §13). Skipped unless PRVISION_TEST_DATABASE_URL points at a database whose
 * name ends in `_test`: the suite drops and recreates the public and drizzle schemas of that database.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import * as schema from "../../../backend/src/database/schema";
import {
  DatabaseNotReadyError,
  MIGRATIONS_FOLDER,
  assertDatabaseReady
} from "../../../backend/src/database/schema-readiness";
import * as drizzleMigrator from "drizzle-orm/node-postgres/migrator";
import * as drizzleNodePostgres from "drizzle-orm/node-postgres";
import * as drizzleOrm from "drizzle-orm";
import pg, { type Pool as PgPool } from "pg";

const { eq } = drizzleOrm;
const { drizzle } = drizzleNodePostgres;
const { migrate } = drizzleMigrator;
const { DatabaseError, Pool } = pg;

const TEST_DATABASE_URL = process.env.PRVISION_TEST_DATABASE_URL ?? "";
const skip = TEST_DATABASE_URL === "" ? "PRVISION_TEST_DATABASE_URL is not set" : false;

function databaseName(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
}

/**
 * Asserts that a promise rejects with the given pg SQLSTATE (and constraint, when given). Drizzle wraps driver
 * errors in DrizzleQueryError with the pg DatabaseError as `cause`; raw pool queries reject with it directly.
 */
async function rejectsWithCode(promise: Promise<unknown>, code: string, constraint?: string): Promise<void> {
  await assert.rejects(promise, (thrown: unknown) => {
    const error = thrown instanceof DatabaseError ? thrown : thrown instanceof Error ? thrown.cause : thrown;
    assert.ok(error instanceof DatabaseError, `expected a pg DatabaseError, got ${String(thrown)}`);
    assert.equal(error.code, code);
    if (constraint !== undefined) {
      assert.equal(error.constraint, constraint);
    }
    return true;
  });
}

describe("database migrations (real Postgres)", { skip }, () => {
  let pool: PgPool;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  async function resetDatabase(): Promise<void> {
    await pool.query("drop schema public cascade");
    await pool.query("create schema public");
    await pool.query("drop schema if exists drizzle cascade");
  }

  async function runMigrations(): Promise<void> {
    await migrate(drizzle(pool), {
      migrationsFolder: MIGRATIONS_FOLDER,
      migrationsTable: "__drizzle_migrations",
      migrationsSchema: "drizzle"
    });
  }

  async function insertRepository(
    localPath: string,
    values: Partial<typeof schema.repositories.$inferInsert> = {}
  ): Promise<number> {
    const [row] = await db
      .insert(schema.repositories)
      .values({
        name: "sample",
        localPath,
        defaultBranch: "main",
        packageManager: "npm",
        ...values
      })
      .returning({ id: schema.repositories.id });
    assert.ok(row);
    return row.id;
  }

  async function insertVisualization(repositoryId: number): Promise<number> {
    const [row] = await db
      .insert(schema.visualizations)
      .values({
        repositoryId,
        sourceType: "local_branch",
        title: "feature",
        baseRef: "main",
        headRef: "feature",
        aiProvider: "anthropic_api",
        aiModel: "claude-opus-5-5"
      })
      .returning({ id: schema.visualizations.id });
    assert.ok(row);
    return row.id;
  }

  async function insertComponent(
    visualizationId: number,
    values: Partial<typeof schema.visualizationComponents.$inferInsert> = {}
  ): Promise<number> {
    const [row] = await db
      .insert(schema.visualizationComponents)
      .values({
        visualizationId,
        filePath: `src/components/Button${String(Math.random()).slice(2)}.tsx`,
        exportName: "default",
        displayName: "Button",
        changeKind: "modified",
        rank: 0,
        ...values
      })
      .returning({ id: schema.visualizationComponents.id });
    assert.ok(row);
    return row.id;
  }

  before(async () => {
    assert.match(databaseName(TEST_DATABASE_URL), /_test$/, "PRVISION_TEST_DATABASE_URL must name a *_test database");
    pool = new Pool({
      connectionString: TEST_DATABASE_URL,
      max: 2,
      options: "-c timezone=UTC"
    });
    db = drizzle(pool, { schema });
    await resetDatabase();
  });

  after(async () => {
    await pool.end();
  });

  test("migrations apply to an empty database and seed app_settings id=1 with defaults", async () => {
    await runMigrations();
    const result = await pool.query<{
      id: number;
      ai_provider: string;
      ai_model: string;
      ai_harness_effort: string;
      ai_summary_effort: string;
      github_token_encrypted: string | null;
      anthropic_api_key_encrypted: string | null;
    }>("select * from app_settings");
    assert.equal(result.rowCount, 1);
    const row = result.rows[0];
    assert.ok(row);
    assert.equal(row.id, 1);
    assert.equal(row.ai_provider, "anthropic_api");
    assert.equal(row.ai_model, "claude-opus-5-5");
    assert.equal(row.ai_harness_effort, "high");
    assert.equal(row.ai_summary_effort, "medium");
    assert.equal(row.github_token_encrypted, null);
    assert.equal(row.anthropic_api_key_encrypted, null);
  });

  test("re-running migrations is a no-op", async () => {
    const countMigrations = async (): Promise<number> =>
      (await pool.query<{ count: number }>("select count(*)::int as count from drizzle.__drizzle_migrations")).rows[0]
        ?.count ?? -1;
    const before = await countMigrations();
    await runMigrations();
    assert.equal(await countMigrations(), before);
    // Every journal entry is applied once (0000 schema … 0009 harness library, 00 §21).
    const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
      entries: Array<{ tag: string }>;
    };
    assert.equal(before, journal.entries.length);
    assert.equal(journal.entries.at(-1)?.tag, "0009_harness_library");
    const settings = await pool.query("select id from app_settings");
    assert.equal(settings.rowCount, 1);
  });

  test("inserting app_settings id=2 fails the singleton check", async () => {
    await rejectsWithCode(
      pool.query("insert into app_settings (id) values (2)"),
      "23514",
      "app_settings_singleton_check"
    );
  });

  test("invalid visualization status is rejected by the CHECK", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/status");
    const visualizationId = await insertVisualization(repositoryId);
    await rejectsWithCode(
      pool.query("update visualizations set status = 'exploded' where id = $1", [visualizationId]),
      "23514",
      "visualizations_status_check"
    );
  });

  test("local_path can be re-registered after soft delete but not while active", async () => {
    const localPath = "/tmp/prvision-it/reregister";
    const firstId = await insertRepository(localPath);
    await rejectsWithCode(insertRepository(localPath), "23505", "repositories_local_path_app_active_key");
    await db.update(schema.repositories).set({ isDeleted: true }).where(eq(schema.repositories.id, firstId));
    const secondId = await insertRepository(localPath);
    assert.notEqual(secondId, firstId);
  });

  test("one row per app: (local_path, app_root, angular_project) is unique among active rows", async () => {
    const localPath = "/tmp/prvision-it/monorepo";
    const angular = (appRoot: string, angularProject: string) =>
      insertRepository(localPath, { framework: "angular", appRoot, angularProject });
    await angular("src/tenant-frontend", "tenant-frontend");
    await angular("src/core-frontend", "core-frontend");
    await angular("src/tenant-frontend", "admin"); // second project of the same workspace
    await insertRepository(localPath); // the root React app of the same clone
    await rejectsWithCode(
      angular("src/tenant-frontend", "tenant-frontend"),
      "23505",
      "repositories_local_path_app_active_key"
    );
    await rejectsWithCode(insertRepository(localPath), "23505", "repositories_local_path_app_active_key");
  });

  test("app_root, angular project and React root CHECKs (15 §5.4.1)", async () => {
    const localPath = "/tmp/prvision-it/checks";
    for (const appRoot of ["/abs", "../x", "a/../b", "./a", "a/.", "a/", "a\\b"]) {
      await rejectsWithCode(
        insertRepository(`${localPath}/${appRoot}`, { framework: "angular", appRoot, angularProject: "p" }),
        "23514",
        "repositories_app_root_check"
      );
    }
    await insertRepository(`${localPath}/ok`, { framework: "angular", appRoot: "src/app.v2", angularProject: "p" });
    await rejectsWithCode(
      insertRepository(`${localPath}/no-project`, { framework: "angular", appRoot: "src/app" }),
      "23514",
      "repositories_angular_project_check"
    );
    await rejectsWithCode(
      insertRepository(`${localPath}/react-project`, { angularProject: "p" }),
      "23514",
      "repositories_angular_project_check"
    );
    await rejectsWithCode(
      insertRepository(`${localPath}/react-sub`, { appRoot: "apps/web" }),
      "23514",
      "repositories_react_root_check"
    );
  });

  test("github_pr requires pr_number and other source types forbid it", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/pr-number");
    const insert = (sourceType: string, prNumber: number | null) =>
      pool.query(
        `insert into visualizations (repository_id, source_type, pr_number, title, base_ref, head_ref, ai_provider, ai_model)
         values ($1, $2, $3, 't', 'main', 'feature', 'anthropic_api', 'claude-opus-5-5')`,
        [repositoryId, sourceType, prNumber]
      );
    await rejectsWithCode(insert("github_pr", null), "23514", "visualizations_pr_number_check");
    await rejectsWithCode(insert("github_pr", 0), "23514", "visualizations_pr_number_check");
    await rejectsWithCode(insert("local_branch", 7), "23514", "visualizations_pr_number_check");
    await rejectsWithCode(insert("working_tree", 7), "23514", "visualizations_pr_number_check");
    await insert("github_pr", 7);
    await insert("local_branch", null);
    await insert("working_tree", null);
  });

  test("commit_range is an accepted source_type and requires base_sha and head_sha (00 §16)", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/commit-range");
    const insert = (sourceType: string, baseSha: string | null, headSha: string | null) =>
      pool.query(
        `insert into visualizations (repository_id, source_type, title, base_ref, head_ref, base_sha, head_sha, ai_provider, ai_model)
         values ($1, $2, 't', 'feature', 'feature', $3, $4, 'anthropic_api', 'claude-opus-5-5')`,
        [repositoryId, sourceType, baseSha, headSha]
      );
    const sha = (c: string): string => c.repeat(40);
    await rejectsWithCode(insert("commit_range", null, sha("b")), "23514", "visualizations_commit_range_shas_check");
    await rejectsWithCode(insert("commit_range", sha("a"), null), "23514", "visualizations_commit_range_shas_check");
    await rejectsWithCode(insert("commit_ranges", sha("a"), sha("b")), "23514", "visualizations_source_type_check");
    await insert("commit_range", sha("a"), sha("b"));
    await insert("local_branch", null, null);
  });

  test("replaced is an accepted change_kind; base columns are required for it and forbidden otherwise (00 §17)", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/replaced");
    const visualizationId = await insertVisualization(repositoryId);
    const base = { baseFilePath: "src/components/Old.tsx", baseExportName: "default", baseDisplayName: "Old" };
    const evidence = [{ kind: "call_site_swap" as const, detail: "src/pages/P.tsx: <Old> → <New>" }];
    const id = await insertComponent(visualizationId, {
      changeKind: "replaced",
      ...base,
      baseHarnessSource: 'export default definePrvisionHarness({ states: [{ name: "Default", render: () => null }] });',
      baseHarnessNotes: "notes",
      baseMockedModules: [],
      successorEvidence: evidence
    });
    const [row] = await db
      .select()
      .from(schema.visualizationComponents)
      .where(eq(schema.visualizationComponents.id, id));
    assert.equal(row?.changeKind, "replaced");
    assert.deepEqual(row.successorEvidence, evidence);
    assert.deepEqual(row.baseMockedModules, []);
    await rejectsWithCode(
      insertComponent(visualizationId, { changeKind: "replaced" }),
      "23514",
      "visualization_components_replaced_columns_check"
    );
    await rejectsWithCode(
      insertComponent(visualizationId, { changeKind: "modified", ...base }),
      "23514",
      "visualization_components_replaced_columns_check"
    );
    await rejectsWithCode(
      insertComponent(visualizationId, { changeKind: "added", successorEvidence: evidence }),
      "23514",
      "visualization_components_replaced_columns_check"
    );
    await rejectsWithCode(
      insertComponent(visualizationId, { changeKind: "replaced", ...base, baseFilePath: "/abs/Old.tsx" }),
      "23514",
      "visualization_components_base_file_path_relative_check"
    );
    await rejectsWithCode(
      pool.query(
        `insert into visualization_components (visualization_id, file_path, export_name, display_name, change_kind, rank)
         values ($1, 'src/X.tsx', 'default', 'X', 'renamed', 0)`,
        [visualizationId]
      ),
      "23514",
      "visualization_components_change_kind_check"
    );
  });

  test("diff_pixel_ratio round-trips as a JS number (0.123456) and rejects 1.5", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/ratio");
    const visualizationId = await insertVisualization(repositoryId);
    const componentId = await insertComponent(visualizationId, {
      diffPixelRatio: 0.123456
    });
    const [row] = await db
      .select({ diffPixelRatio: schema.visualizationComponents.diffPixelRatio })
      .from(schema.visualizationComponents)
      .where(eq(schema.visualizationComponents.id, componentId));
    assert.ok(row);
    assert.equal(typeof row.diffPixelRatio, "number");
    assert.equal(row.diffPixelRatio, 0.123456);
    await rejectsWithCode(
      insertComponent(visualizationId, { diffPixelRatio: 1.5 }),
      "23514",
      "visualization_components_diff_pixel_ratio_check"
    );
  });

  test("deleting a visualization row cascades to components and console events", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/cascade");
    const visualizationId = await insertVisualization(repositoryId);
    await insertComponent(visualizationId);
    await insertComponent(visualizationId, { rank: 1 });
    await db.insert(schema.visualizationConsoleEvents).values({
      visualizationId,
      level: "info",
      stage: "queued",
      message: "Queued"
    });

    await pool.query("delete from visualizations where id = $1", [visualizationId]);

    const components = await pool.query("select id from visualization_components where visualization_id = $1", [
      visualizationId
    ]);
    const events = await pool.query("select id from visualization_console_events where visualization_id = $1", [
      visualizationId
    ]);
    assert.equal(components.rowCount, 0);
    assert.equal(events.rowCount, 0);
  });

  test("hard-deleting a repository with visualizations fails with 23503", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/restrict");
    await insertVisualization(repositoryId);
    await rejectsWithCode(
      pool.query("delete from repositories where id = $1", [repositoryId]),
      "23503",
      "visualizations_repository_id_repositories_id_fk"
    );
  });

  test("failed_stage is rejected while status is rendering and accepted with status failed", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/failed-stage");
    const visualizationId = await insertVisualization(repositoryId);
    await rejectsWithCode(
      pool.query("update visualizations set status = 'rendering', failed_stage = 'rendering' where id = $1", [
        visualizationId
      ]),
      "23514",
      "visualizations_failed_stage_status_check"
    );
    await rejectsWithCode(
      pool.query("update visualizations set status = 'failed', failed_stage = 'completed' where id = $1", [
        visualizationId
      ]),
      "23514",
      "visualizations_failed_stage_check"
    );
    await db
      .update(schema.visualizations)
      .set({
        status: "failed",
        failedStage: "rendering",
        completedAt: new Date()
      })
      .where(eq(schema.visualizations.id, visualizationId));
    const [row] = await db
      .select({ failedStage: schema.visualizations.failedStage })
      .from(schema.visualizations)
      .where(eq(schema.visualizations.id, visualizationId));
    assert.equal(row?.failedStage, "rendering");
  });

  test("skip_reason is rejected on a rendered row and accepted on a skipped row", async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/skip-reason");
    const visualizationId = await insertVisualization(repositoryId);
    await rejectsWithCode(
      insertComponent(visualizationId, {
        renderStatus: "rendered",
        skipReason: "over the cap"
      }),
      "23514",
      "visualization_components_skip_reason_check"
    );
    await insertComponent(visualizationId, {
      renderStatus: "skipped",
      skipReason: "over the cap"
    });
  });

  test('console event stage "render:Button" is rejected', async () => {
    const repositoryId = await insertRepository("/tmp/prvision-it/console-stage");
    const visualizationId = await insertVisualization(repositoryId);
    await rejectsWithCode(
      pool.query(
        "insert into visualization_console_events (visualization_id, level, stage, message) values ($1, 'info', 'render:Button', 'x')",
        [visualizationId]
      ),
      "23514",
      "visualization_console_events_stage_check"
    );
  });

  test("migration 0002 applies over existing repository rows (app_root = '.', react_vite, no project)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prvision-test-migrations-"));
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const before0002 = journal.entries.filter((entry) => entry.tag < "0002");
      fs.mkdirSync(path.join(tempDir, "meta"));
      fs.writeFileSync(
        path.join(tempDir, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: before0002 })
      );
      for (const entry of before0002) {
        fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(tempDir, `${entry.tag}.sql`));
      }
      await resetDatabase();
      await migrate(drizzle(pool), {
        migrationsFolder: tempDir,
        migrationsTable: "__drizzle_migrations",
        migrationsSchema: "drizzle"
      });
      await pool.query(
        "insert into repositories (name, local_path, default_branch, package_manager) values ('old', '/tmp/prvision-it/old', 'main', 'npm')"
      );
      await runMigrations();
      const rows = await pool.query<{
        framework: string;
        app_root: string;
        angular_project: string | null;
        angular_build_configuration: string | null;
      }>(
        "select framework, app_root, angular_project, angular_build_configuration from repositories where name = 'old'"
      );
      assert.deepEqual(rows.rows, [
        { framework: "react_vite", app_root: ".", angular_project: null, angular_build_configuration: null }
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("migration 0009 applies over rows from 0008 with the 16 §6 defaults and enforces its CHECKs and keys", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prvision-test-migrations-"));
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
        entries: Array<{ tag: string }>;
      };
      const before0009 = journal.entries.filter((entry) => entry.tag < "0009");
      fs.mkdirSync(path.join(tempDir, "meta"));
      fs.writeFileSync(
        path.join(tempDir, "meta", "_journal.json"),
        JSON.stringify({ ...journal, entries: before0009 })
      );
      for (const entry of before0009) {
        fs.copyFileSync(path.join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), path.join(tempDir, `${entry.tag}.sql`));
      }
      await resetDatabase();
      await migrate(drizzle(pool), {
        migrationsFolder: tempDir,
        migrationsTable: "__drizzle_migrations",
        migrationsSchema: "drizzle"
      });
      // Rows written by the 0008 schema.
      const repo = await pool.query<{ id: number }>(
        "insert into repositories (name, local_path, default_branch, package_manager) values ('old', '/tmp/prvision-it/old9', 'main', 'npm') returning id"
      );
      const repositoryId = repo.rows[0]?.id ?? 0;
      const viz = await pool.query<{ id: number }>(
        `insert into visualizations (repository_id, source_type, title, base_ref, head_ref, ai_provider, ai_model)
         values ($1, 'local_branch', 't', 'main', 'f', 'anthropic_api', 'claude-opus-5-5') returning id`,
        [repositoryId]
      );
      const visualizationId = viz.rows[0]?.id ?? 0;
      const component = await pool.query<{ id: number }>(
        `insert into visualization_components (visualization_id, file_path, export_name, display_name, change_kind, rank)
         values ($1, 'src/A.tsx', 'default', 'A', 'modified', 0) returning id`,
        [visualizationId]
      );
      const componentId = component.rows[0]?.id ?? 0;

      await runMigrations();

      const repositoryRow = await pool.query(
        "select library_build_mode, state_allowance from repositories where id = $1",
        [repositoryId]
      );
      assert.deepEqual(repositoryRow.rows, [{ library_build_mode: "grow", state_allowance: 3 }]);
      const visualizationRow = await pool.query(
        `select checked_count, reused_harness_count, new_harness_count, needs_update_count, global_style_trigger,
                working_tree_snapshot from visualizations where id = $1`,
        [visualizationId]
      );
      assert.deepEqual(visualizationRow.rows, [
        {
          checked_count: 0,
          reused_harness_count: 0,
          new_harness_count: 0,
          needs_update_count: 0,
          global_style_trigger: null,
          working_tree_snapshot: false
        }
      ]);
      const componentRow = await pool.query(
        `select library_entry_id, base_library_entry_id, harness_origin, base_harness_origin, harness_needs_update,
                source_changed_since_write, state_count, changed_state_count from visualization_components where id = $1`,
        [componentId]
      );
      assert.deepEqual(componentRow.rows, [
        {
          library_entry_id: null,
          base_library_entry_id: null,
          harness_origin: null,
          base_harness_origin: null,
          harness_needs_update: false,
          source_changed_since_write: null,
          state_count: 0,
          changed_state_count: 0
        }
      ]);
      const stateRows = await pool.query("select count(*)::int as count from visualization_component_states");
      assert.deepEqual(stateRows.rows, [{ count: 0 }], "no state rows are back-filled");

      // Rejected rows.
      for (const allowance of [0, 6]) {
        await rejectsWithCode(
          pool.query("update repositories set state_allowance = $1 where id = $2", [allowance, repositoryId]),
          "23514",
          "repositories_state_allowance_check"
        );
      }
      await rejectsWithCode(
        pool.query("update visualizations set working_tree_snapshot = true where id = $1", [visualizationId]),
        "23514",
        "visualizations_working_tree_snapshot_check"
      );
      const entrySql = `insert into harness_library_entries
        (repository_id, framework, file_path, export_name, display_name, source_fingerprint, harness_source, state_count,
         state_allowance, status, origin)
        values ($1, 'react_vite', $2, 'default', 'A', $3, $4, $5, 3, $6, 'run') returning id`;
      await rejectsWithCode(
        pool.query(entrySql, [repositoryId, "src/Bad.tsx", "ABC", "export default 1", 1, "ready"]),
        "23514",
        "harness_library_entries_source_fingerprint_check"
      );
      await rejectsWithCode(
        pool.query(entrySql, [repositoryId, "src/NoHarness.tsx", null, null, 0, "ready"]),
        "23514",
        "harness_library_entries_ready_harness_check"
      );
      // Accepted: off_default_branch with and without a harness (E26), and a valid fingerprint.
      const fingerprint = "a".repeat(64);
      const offWith = await pool.query<{ id: number }>(entrySql, [
        repositoryId,
        "src/Off.tsx",
        fingerprint,
        "export default 1",
        1,
        "off_default_branch"
      ]);
      await pool.query(entrySql, [repositoryId, "src/OffEmpty.tsx", null, null, 0, "off_default_branch"]);
      const entryId = offWith.rows[0]?.id ?? 0;
      await rejectsWithCode(
        pool.query("update visualization_components set base_library_entry_id = $1 where id = $2", [
          entryId,
          componentId
        ]),
        "23514",
        "visualization_components_base_library_entry_id_check"
      );
      await pool.query("update visualization_components set library_entry_id = $1 where id = $2", [
        entryId,
        componentId
      ]);

      await rejectsWithCode(
        pool.query(
          `insert into visualization_component_states (visualization_component_id, visualization_id, ordinal, state_name,
             on_base, on_head) values ($1, $2, 0, 'Open', true, true)`,
          [componentId, visualizationId]
        ),
        "23514",
        "visualization_component_states_default_ordinal_check"
      );
      await pool.query(
        `insert into visualization_component_states (visualization_component_id, visualization_id, ordinal, state_name,
           on_base, on_head) values ($1, $2, 0, 'Default', true, true)`,
        [componentId, visualizationId]
      );

      const scanSql = `insert into harness_library_jobs (repository_id, kind, state_allowance, ai_model)
        values ($1, 'scan', 3, 'claude-opus-5-5')`;
      await pool.query(scanSql, [repositoryId]);
      await rejectsWithCode(pool.query(scanSql, [repositoryId]), "23505", "harness_library_jobs_active_scan_key");
      await rejectsWithCode(
        pool.query(
          `insert into harness_library_jobs (repository_id, kind, visualization_id, component_ids, state_allowance,
             spend_cap_usd, ai_model) values ($1, 'repair', $2, '[1]'::jsonb, 3, 5, 'claude-opus-5-5')`,
          [repositoryId, visualizationId]
        ),
        "23514",
        "harness_library_jobs_spend_cap_usd_check"
      );

      await pool.query("insert into live_sessions (visualization_id) values ($1)", [visualizationId]);
      await rejectsWithCode(
        pool.query("insert into live_sessions (visualization_id) values ($1)", [visualizationId]),
        "23505",
        "live_sessions_active_visualization_key"
      );

      // Deleting the entry keeps the run row and clears its link (on delete set null).
      await pool.query("delete from harness_library_entries where id = $1", [entryId]);
      const unlinked = await pool.query("select library_entry_id from visualization_components where id = $1", [
        componentId
      ]);
      assert.deepEqual(unlinked.rows, [{ library_entry_id: null }]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("assertDatabaseReady passes after migrate, throws DatabaseNotReadyError on an empty schema, and throws when the journal lists more migrations than were applied", async () => {
    await assertDatabaseReady(pool);

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "prvision-test-journal-"));
    try {
      const journal = JSON.parse(fs.readFileSync(path.join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8")) as {
        entries: Array<Record<string, unknown>>;
      };
      journal.entries.push({
        idx: journal.entries.length,
        version: "7",
        when: 0,
        tag: "9999_future",
        breakpoints: true
      });
      fs.mkdirSync(path.join(tempDir, "meta"));
      fs.writeFileSync(path.join(tempDir, "meta", "_journal.json"), JSON.stringify(journal));
      await assert.rejects(assertDatabaseReady(pool, tempDir), (error: unknown) => {
        assert.ok(error instanceof DatabaseNotReadyError);
        assert.match(error.message, /1 database migration\(s\) are not applied/);
        assert.match(error.hint, /npm run db:migrate/);
        return true;
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    await pool.query("delete from app_settings");
    await assert.rejects(assertDatabaseReady(pool), (error: unknown) => {
      assert.ok(error instanceof DatabaseNotReadyError);
      assert.match(error.message, /app_settings singleton row is missing/);
      return true;
    });

    await resetDatabase();
    await assert.rejects(assertDatabaseReady(pool), (error: unknown) => {
      assert.ok(error instanceof DatabaseNotReadyError);
      assert.equal(error.message, "Database schema is not migrated");
      return true;
    });

    // Leave the test database migrated for later suites.
    await runMigrations();
    await assertDatabaseReady(pool);
  });
});
