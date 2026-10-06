import assert from "node:assert/strict";
import test from "node:test";
import { getTableColumns } from "drizzle-orm";
import { TABLE_SCHEMAS } from "../../../backend/src/database/table-registry";
import { DeletionMode, Table } from "../../../backend/src/enums";
import { RepositoryModel } from "../../../backend/src/models";
import { Where, type WhereOperator } from "../../../backend/src/utilities/handlers/query-conditions";
import { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { QueryHandlerError } from "../../../backend/src/utilities/handlers/query-handler-drizzle";
import {
  idModel,
  makeComponentRow,
  makeConsoleEventRow,
  makeRepositoryModel,
  makeRepositoryRow,
  makeSettingsRow,
  makeVisualizationModel,
  makeVisualizationRow
} from "../helpers/factories";
import { InMemoryQueryHandler, installQueryHandlerStub } from "../helpers/query-handler-stub";

const CLOCK = new Date("2026-03-04T05:06:07.000Z");
const STUB_ONLY_MEMBERS = new Set([
  "constructor",
  // test API
  "seed",
  "rows",
  "row",
  "callsFor",
  "failNext",
  // internals
  "insertOne",
  "defaultsFor",
  "missingNotNull",
  "checkedValues",
  "checkedConditions",
  "assertColumn",
  "withSoftDeleteDefault",
  "hasEffectiveConditions",
  "match",
  "matches",
  "record",
  "responseFailure",
  "throwingFailure"
]);
const isQueryHandlerError = { name: "QueryHandlerError" };

function stubWithClock(): InMemoryQueryHandler {
  const stub = new InMemoryQueryHandler();
  stub.now = () => CLOCK;
  return stub;
}

const MINIMAL_VISUALIZATION = {
  repositoryId: 1,
  sourceType: "local_branch",
  title: "t",
  baseRef: "main",
  headRef: "feature",
  aiProvider: "anthropic_api",
  aiModel: "claude-opus-5-5"
};

test("the stub exposes exactly QueryHandler's public method names", () => {
  const facade = Object.getOwnPropertyNames(QueryHandler.prototype)
    .filter((name) => name !== "constructor")
    .sort();
  const stub = Object.getOwnPropertyNames(InMemoryQueryHandler.prototype)
    .filter((name) => !STUB_ONLY_MEMBERS.has(name))
    .sort();
  assert.deepEqual(stub, facade);

  const statics = (target: object): string[] =>
    Object.getOwnPropertyNames(target)
      .filter((name) => !["length", "name", "prototype"].includes(name))
      .sort();
  assert.deepEqual(statics(InMemoryQueryHandler), statics(QueryHandler));
  assert.deepEqual(statics(QueryHandler), ["firstInsertedId", "normalizeData"]);
});

test("insert fills every column: literal defaults, now() timestamps, '[]'::jsonb, null for nullable columns", async () => {
  const stub = stubWithClock();
  const response = await stub.insert(MINIMAL_VISUALIZATION, Table.VISUALIZATIONS);
  assert.equal(response.status, 200);
  const row = response.data?.[0];
  assert.ok(row);
  assert.deepEqual(Object.keys(row).sort(), Object.keys(getTableColumns(TABLE_SCHEMAS.visualizations)).sort());
  assert.equal(row.id, 1);
  assert.equal(row.status, "queued");
  assert.equal(row.componentCount, 0);
  assert.equal(row.changedCount, 0);
  assert.equal(row.isDeleted, false);
  assert.equal(row.failedStage, null);
  assert.equal(row.prNumber, null);
  assert.deepEqual(row.createdAt, CLOCK);
  assert.deepEqual(row.updatedAt, CLOCK);

  const component = await stub.insert(
    {
      visualizationId: 1,
      filePath: "src/A.tsx",
      exportName: "default",
      displayName: "A",
      changeKind: "added",
      rank: 0
    },
    Table.VISUALIZATION_COMPONENTS
  );
  assert.deepEqual(component.data?.[0]?.mockedModules, []);
  assert.equal(component.data[0].renderStatus, "pending");
  const second = await stub.insert(MINIMAL_VISUALIZATION, Table.VISUALIZATIONS);
  assert.equal(InMemoryQueryHandler.firstInsertedId(second), 2);
});

test("insert without a NOT NULL value returns 400 validation_failed; insert with an unknown column throws QueryHandlerError; insert([]) returns 200 []", async () => {
  const stub = stubWithClock();
  const { title: _title, ...withoutTitle } = MINIMAL_VISUALIZATION;
  const missing = await stub.insert(withoutTitle, Table.VISUALIZATIONS);
  assert.equal(missing.status, 400);
  assert.equal(missing.error_reason, "validation_failed");
  await assert.rejects(
    stub.insert({ ...MINIMAL_VISUALIZATION, colour: "red" }, Table.VISUALIZATIONS),
    isQueryHandlerError
  );
  assert.deepEqual(await stub.insert([], Table.VISUALIZATIONS), { status: 200, data: [] });
  assert.deepEqual(stub.rows(Table.VISUALIZATIONS), []);
});

test("select applies isDeleted=false by default on soft tables; an explicit isDeleted condition overrides it", async () => {
  const stub = stubWithClock();
  stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 }), makeRepositoryRow({ id: 2, isDeleted: true })]);
  const ids = (rows: Array<Record<string, unknown>>): unknown[] => rows.map((row) => row.id);
  assert.deepEqual(ids(await stub.select({}, Table.REPOSITORIES, true)), [1]);
  assert.deepEqual(ids(await stub.select({ isDeleted: true }, Table.REPOSITORIES, true)), [2]);
  assert.deepEqual(ids(await stub.select({ isDeleted: undefined }, Table.REPOSITORIES, true)), [1, 2]);
  assert.deepEqual(await stub.count({}, Table.REPOSITORIES), { status: 200, data: { count: 1 } });
  const response = await stub.select({}, Table.REPOSITORIES);
  assert.equal(response.status, 200);
  assert.equal(response.data?.length, 1);
});

test("conditions: undefined ignored, null matches IS NULL, every Where operator evaluates like SQL", async (t) => {
  const stub = stubWithClock();
  // prNumber 1, 2, 3 and NULL (CHECKs are not evaluated by the stub).
  stub.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({ id: 1 }),
    makeVisualizationRow({ id: 2 }),
    makeVisualizationRow({ id: 3 }),
    makeVisualizationRow({ id: 4 })
  ]);
  for (const [id, prNumber] of [
    [1, 1],
    [2, 2],
    [3, 3]
  ] as const) {
    await stub.update({ prNumber }, { id }, Table.VISUALIZATIONS);
  }
  const idsWhere = async (conditions: Record<string, WhereOperator | number | null | undefined>): Promise<unknown[]> =>
    (await stub.select(conditions, Table.VISUALIZATIONS, true)).map((row) => row.id);

  assert.deepEqual(await idsWhere({ prNumber: undefined }), [1, 2, 3, 4]);
  assert.deepEqual(await idsWhere({ prNumber: null }), [4]);
  assert.deepEqual(await idsWhere({ prNumber: 2 }), [2]);

  const table: Array<[string, WhereOperator, number[]]> = [
    ["ne", Where.ne(2), [1, 3]],
    ["gt", Where.gt(1), [2, 3]],
    ["gte", Where.gte(2), [2, 3]],
    ["lt", Where.lt(3), [1, 2]],
    ["lte", Where.lte(1), [1]],
    ["in", Where.in([1, 3]), [1, 3]],
    ["in([])", Where.in([]), []],
    ["notIn", Where.notIn([1]), [2, 3]],
    ["notIn([])", Where.notIn([]), [1, 2, 3, 4]],
    ["isNull", Where.isNull(), [4]],
    ["isNotNull", Where.isNotNull(), [1, 2, 3]]
  ];
  for (const [name, operator, expected] of table) {
    await t.test(`${name} (the NULL row matches only isNull and notIn([]))`, async () => {
      assert.deepEqual(await idsWhere({ prNumber: operator }), expected);
    });
  }
});

test("unknown condition keys throw on select, count, update and delete before any write", async () => {
  const stub = stubWithClock();
  stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  const before = stub.rows(Table.REPOSITORIES);
  await assert.rejects(stub.select({ nope: 1 }, Table.REPOSITORIES), isQueryHandlerError);
  await assert.rejects(stub.count({ nope: 1 }, Table.REPOSITORIES), isQueryHandlerError);
  await assert.rejects(stub.update({ name: "x" }, { nope: 1 }, Table.REPOSITORIES), isQueryHandlerError);
  await assert.rejects(stub.update({ nope: "x" }, { id: 1 }, Table.REPOSITORIES), isQueryHandlerError);
  await assert.rejects(stub.delete({ nope: 1 }, Table.REPOSITORIES, DeletionMode.HARD), isQueryHandlerError);
  assert.deepEqual(stub.rows(Table.REPOSITORIES), before);
});

test("update(values, conditions, table): no effective conditions → 400 validation_failed; zero matches → 404 not_found; success → rowsAffected and updatedAt bumped only where the column exists", async () => {
  const stub = stubWithClock();
  stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 }), makeRepositoryRow({ id: 2, name: "other" })]);
  stub.seed(Table.VISUALIZATION_CONSOLE_EVENTS, [makeConsoleEventRow({ id: 1 })]);

  const none = await stub.update({ name: "x" }, { id: undefined }, Table.REPOSITORIES);
  assert.equal(none.status, 400);
  assert.equal(none.error_reason, "validation_failed");
  const missing = await stub.update({ name: "x" }, { id: 99 }, Table.REPOSITORIES);
  assert.equal(missing.status, 404);
  assert.equal(missing.error_reason, "not_found");

  assert.deepEqual(await stub.update({ name: "renamed" }, { id: 1 }, Table.REPOSITORIES), {
    status: 200,
    data: { rowsAffected: 1 }
  });
  assert.equal(stub.row(Table.REPOSITORIES, 1)?.name, "renamed");
  assert.deepEqual(stub.row(Table.REPOSITORIES, 1)?.updatedAt, CLOCK);
  assert.deepEqual(stub.row(Table.REPOSITORIES, 2)?.updatedAt, new Date("2026-01-01T00:00:00.000Z"));

  await stub.update({ message: "edited" }, { id: 1 }, Table.VISUALIZATION_CONSOLE_EVENTS);
  const event = stub.row(Table.VISUALIZATION_CONSOLE_EVENTS, 1);
  assert.equal(event?.message, "edited");
  assert.equal(Object.prototype.hasOwnProperty.call(event, "updatedAt"), false);
});

test("soft delete on a table without isDeleted throws; soft delete sets isDeleted and updatedAt; hard delete removes; zero matches 404", async () => {
  const stub = stubWithClock();
  stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  stub.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 1 }),
    makeComponentRow({ id: 2, filePath: "b.tsx" })
  ]);

  await assert.rejects(stub.delete({ id: 1 }, Table.VISUALIZATION_COMPONENTS, DeletionMode.SOFT), isQueryHandlerError);
  assert.equal(stub.rows(Table.VISUALIZATION_COMPONENTS).length, 2);

  assert.deepEqual(await stub.delete({ id: 1 }, Table.REPOSITORIES, DeletionMode.SOFT), {
    status: 200,
    data: { rowsAffected: 1 }
  });
  assert.equal(stub.row(Table.REPOSITORIES, 1)?.isDeleted, true);
  assert.deepEqual(stub.row(Table.REPOSITORIES, 1)?.updatedAt, CLOCK);

  await stub.delete({ id: 1 }, Table.VISUALIZATION_COMPONENTS, DeletionMode.HARD);
  assert.deepEqual(
    stub.rows(Table.VISUALIZATION_COMPONENTS).map((row) => row.id),
    [2]
  );
  const missing = await stub.delete({ id: 1 }, Table.VISUALIZATION_COMPONENTS, DeletionMode.HARD);
  assert.equal(missing.status, 404);
  assert.equal((await stub.delete({}, Table.VISUALIZATION_COMPONENTS, DeletionMode.HARD)).status, 400);
});

test("selectMany orders by id asc by default, honours orderBy/limit/offset/search, sorts NULLs last ascending and first descending, and throws for an unknown orderBy column", async () => {
  const stub = stubWithClock();
  stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({ id: 3, name: "Gamma app", githubOwner: "a", githubRepo: "r" }),
    makeRepositoryRow({ id: 1, name: "alpha", githubOwner: "b", githubRepo: "r" }),
    makeRepositoryRow({ id: 2, name: "beta APP" }),
    makeRepositoryRow({ id: 4, name: "delta", githubOwner: "c", githubRepo: "r" })
  ]);
  const ids = (models: RepositoryModel[]): number[] => models.map((model) => model.id);
  assert.deepEqual(ids(await stub.selectMany(RepositoryModel, {}, Table.REPOSITORIES)), [1, 2, 3, 4]);
  assert.deepEqual(
    ids(
      await stub.selectMany(RepositoryModel, {}, Table.REPOSITORIES, {
        orderBy: [{ column: "githubOwner", direction: "asc" }]
      })
    ),
    [3, 1, 4, 2]
  );
  assert.deepEqual(
    ids(
      await stub.selectMany(RepositoryModel, {}, Table.REPOSITORIES, {
        orderBy: [{ column: "githubOwner", direction: "desc" }]
      })
    ),
    [2, 4, 1, 3]
  );
  assert.deepEqual(
    ids(await stub.selectMany(RepositoryModel, {}, Table.REPOSITORIES, { limit: 2, offset: 1 })),
    [2, 3]
  );
  assert.deepEqual(
    ids(await stub.selectMany(RepositoryModel, {}, Table.REPOSITORIES, { search: { name: "app" } })),
    [2, 3]
  );
  await assert.rejects(
    stub.selectMany(RepositoryModel, {}, Table.REPOSITORIES, { orderBy: [{ column: "nope", direction: "asc" }] }),
    isQueryHandlerError
  );
});

test("validateAndSelect and selectMany hydrate through ModelHandler.hydrate, including null values", async () => {
  const stub = stubWithClock();
  stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2 }), makeRepositoryRow({ id: 1, name: "first" })]);
  const model = await stub.validateAndSelect(RepositoryModel, {}, Table.REPOSITORIES);
  assert.ok(model instanceof RepositoryModel);
  assert.equal(model.id, 1);
  assert.equal(model.name, "first");
  assert.equal(model.githubOwner, null);
  assert.deepEqual(model.globalStylePaths, ["/src/index.css"]);
  assert.equal(await stub.validateAndSelect(RepositoryModel, { id: 42 }, Table.REPOSITORIES), null);
  const [many] = await stub.selectMany(RepositoryModel, { id: 2 }, Table.REPOSITORIES);
  assert.equal(many?.githubRepo, null);
});

test("firstInsertedId reads data[0].id", () => {
  assert.equal(InMemoryQueryHandler.firstInsertedId({ status: 200, data: [{ id: 7 }, { id: 8 }] }), 7);
  assert.equal(InMemoryQueryHandler.firstInsertedId({ status: 200, data: [] }), null);
  assert.equal(InMemoryQueryHandler.firstInsertedId({ status: 500, error: "x" }), null);
});

test("failNext: ApiResponse methods return the scripted response once; row and model methods throw QueryHandlerError once; validation still runs first", async () => {
  const stub = stubWithClock();
  stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);

  stub.failNext("count");
  assert.deepEqual(await stub.count({}, Table.REPOSITORIES), {
    status: 500,
    error: "Internal server error",
    error_reason: "internal_error"
  });
  assert.equal((await stub.count({}, Table.REPOSITORIES)).status, 200);

  stub.failNext("update", { status: 409, error: "Duplicate record", error_reason: "conflict" });
  await assert.rejects(stub.update({ name: "x" }, { nope: 1 }, Table.REPOSITORIES), isQueryHandlerError);
  assert.equal((await stub.update({ name: "x" }, { id: 1 }, Table.REPOSITORIES)).status, 409);
  assert.equal(stub.row(Table.REPOSITORIES, 1)?.name, "sample-react-app");

  stub.failNext("select");
  await assert.rejects(stub.select({}, Table.REPOSITORIES, true), (error: unknown) => {
    assert.ok(error instanceof QueryHandlerError);
    assert.equal(error.operation, "select");
    return true;
  });
  assert.equal((await stub.select({}, Table.REPOSITORIES, true)).length, 1);

  stub.failNext("validateAndSelect");
  await assert.rejects(stub.validateAndSelect(RepositoryModel, { id: 1 }, Table.REPOSITORIES), isQueryHandlerError);
  stub.failNext("selectMany", new Error("connection reset"));
  await assert.rejects(stub.selectMany(RepositoryModel, {}, Table.REPOSITORIES), { message: "connection reset" });
  assert.ok(await stub.validateAndSelect(RepositoryModel, { id: 1 }, Table.REPOSITORIES));
});

test("installQueryHandlerStub routes every QueryHandler instance (including new QueryHandler(tx)) and both normalizeData forms; restore puts the originals back", async () => {
  const originals = {
    insert: Object.getOwnPropertyDescriptor(QueryHandler.prototype, "insert")?.value as unknown,
    normalize: Object.getOwnPropertyDescriptor(QueryHandler, "normalizeData")?.value as unknown
  };
  const { stub, restore } = installQueryHandlerStub(stubWithClock());
  try {
    const plain = new QueryHandler({} as never);
    const tx = new QueryHandler({} as never);
    await plain.insert({ ...MINIMAL_VISUALIZATION }, Table.VISUALIZATIONS);
    await tx.insert({ ...MINIMAL_VISUALIZATION }, Table.VISUALIZATIONS);
    assert.equal(stub.rows(Table.VISUALIZATIONS).length, 2);
    assert.equal((await tx.count({}, Table.VISUALIZATIONS)).data?.count, 2);
    assert.equal(stub.callsFor("insert", Table.VISUALIZATIONS).length, 2);

    const model = makeRepositoryModel({ githubOwner: null });
    assert.deepEqual(QueryHandler.normalizeData(model), stub.normalizeData(model));
    assert.deepEqual(plain.normalizeData(model, ["name"]), stub.normalizeData(model, ["name"]));
    assert.equal(plain.normalizeData(model).githubOwner, null);
  } finally {
    restore();
  }
  assert.equal(Object.getOwnPropertyDescriptor(QueryHandler.prototype, "insert")?.value, originals.insert);
  assert.equal(Object.getOwnPropertyDescriptor(QueryHandler, "normalizeData")?.value, originals.normalize);
});

test("factories produce rows whose keys are exactly the table's columns", () => {
  const cases: Array<[Table, Record<string, unknown>]> = [
    [Table.APP_SETTINGS, makeSettingsRow()],
    [Table.REPOSITORIES, makeRepositoryRow()],
    [Table.VISUALIZATIONS, makeVisualizationRow()],
    [Table.VISUALIZATION_COMPONENTS, makeComponentRow()],
    [Table.VISUALIZATION_CONSOLE_EVENTS, makeConsoleEventRow()]
  ];
  for (const [table, row] of cases) {
    assert.deepEqual(Object.keys(row).sort(), Object.keys(getTableColumns(TABLE_SCHEMAS[table])).sort(), table);
  }
  assert.equal(makeVisualizationRow({ id: 9 }).jobId, "viz-9");
  assert.equal(makeVisualizationModel({ id: 9 }).jobId, "viz-9");
  assert.equal(makeRepositoryModel().framework, "react_vite");
  assert.equal(idModel(4).id, 4);
});

test("factory overrides that violate a 03 CHECK throw", () => {
  assert.throws(() => makeVisualizationRow({ failedStage: "rendering" }), /visualizations_failed_stage_status_check/);
  assert.doesNotThrow(() => makeVisualizationRow({ status: "failed", failedStage: "rendering" }));
  assert.throws(
    () => makeVisualizationRow({ status: "failed", failedStage: "completed" as never }),
    /failed_stage_check/
  );
  assert.throws(() => makeVisualizationRow({ completedAt: new Date() }), /visualizations_completed_at_check/);
  assert.throws(() => makeVisualizationRow({ sourceType: "github_pr" }), /visualizations_pr_number_check/);
  assert.throws(() => makeVisualizationRow({ changedCount: 2, componentCount: 1 }), /visualizations_counts_check/);
  assert.throws(() => makeComponentRow({ skipReason: "over the cap" }), /visualization_components_skip_reason_check/);
  assert.doesNotThrow(() => makeComponentRow({ renderStatus: "skipped", skipReason: "over the cap" }));
  assert.throws(() => makeComponentRow({ baseImagePath: "/abs/base.png" }), /image_path_relative_check/);
  assert.throws(() => makeComponentRow({ diffPixelRatio: 1.5 }), /diff_pixel_ratio_check/);
  assert.throws(() => makeRepositoryRow({ githubOwner: "acme" }), /repositories_github_pair_check/);
  assert.throws(() => makeRepositoryRow({ localPath: "relative/path" }), /repositories_local_path_absolute_check/);
  assert.throws(() => makeSettingsRow({ id: 2 }), /app_settings_singleton_check/);
  assert.throws(
    () => makeConsoleEventRow({ stage: "render:Button" as never }),
    /visualization_console_events_stage_check/
  );
});
