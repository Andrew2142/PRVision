import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import { DatabaseError } from "pg";
import * as schema from "../../../backend/src/database/schema";
import { getTableSchema } from "../../../backend/src/database/table-registry";
import { DeletionMode, Table } from "../../../backend/src/enums";
import { Where } from "../../../backend/src/utilities/handlers/query-conditions";
import { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { QueryHandlerDrizzle, QueryHandlerError } from "../../../backend/src/utilities/handlers/query-handler-drizzle";
import type { DbExecutor } from "../../../backend/src/utilities/services/drizzle-db";

interface RecordedQuery {
  text: string;
  params: unknown[];
}

/** A drizzle database on a recording fake pg client. `respond` returns the row count or throws. */
function recordingDb(respond: (text: string) => number = () => 0): { db: DbExecutor; queries: RecordedQuery[] } {
  const queries: RecordedQuery[] = [];
  const client = {
    query(config: string | { text: string }, params: unknown[] = []) {
      const text = typeof config === "string" ? config : config.text;
      queries.push({ text, params });
      try {
        const rowCount = respond(text);
        // Array-mode rows; null for every column (decoders map null to null).
        return Promise.resolve({ rows: Array.from({ length: rowCount }, () => new Array(64).fill(null)), rowCount });
      } catch (error: unknown) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  };
  return { db: drizzle(client as never, { schema }), queries };
}

function pgError(code: string, constraint?: string): DatabaseError {
  return Object.assign(new DatabaseError("db failure", 0, "error"), { code, constraint });
}

const dialect = new PgDialect();
function render(
  handler: QueryHandlerDrizzle,
  table: Table,
  conditions: Parameters<QueryHandlerDrizzle["buildWhere"]>[2]
) {
  const where = handler.buildWhere(getTableSchema(table), table, conditions);
  return where ? dialect.sqlToQuery(where) : undefined;
}

class RowModel {
  private _id!: number;
  setId(value: number): void {
    this._id = value;
  }
  get id(): number {
    return this._id;
  }
}

test("QueryHandlerDrizzle.buildWhere renders equality, IS NULL and every Where operator", () => {
  const handler = new QueryHandlerDrizzle(recordingDb().db);
  const query = render(handler, Table.VISUALIZATIONS, {
    repositoryId: 3,
    errorMessage: null,
    id: Where.gt(10),
    componentCount: Where.gte(1),
    changedCount: Where.lt(5),
    prNumber: Where.lte(9),
    title: Where.ne("x"),
    status: Where.in(["queued", "rendering"]),
    sourceType: Where.notIn(["working_tree"]),
    baseSha: Where.isNull(),
    headSha: Where.isNotNull()
  });
  assert.ok(query);
  const sql = query.sql;
  for (const fragment of [
    '"visualizations"."repository_id" = $1',
    '"visualizations"."error_message" is null',
    '"visualizations"."id" > $2',
    '"visualizations"."component_count" >= $3',
    '"visualizations"."changed_count" < $4',
    '"visualizations"."pr_number" <= $5',
    '"visualizations"."title" <> $6',
    '"visualizations"."status" in ($7, $8)',
    '"visualizations"."source_type" not in ($9)',
    '"visualizations"."base_sha" is null',
    '"visualizations"."head_sha" is not null'
  ]) {
    assert.ok(sql.includes(fragment), `missing ${fragment} in ${sql}`);
  }
  assert.deepEqual(query.params, [3, 10, 1, 5, 9, "x", "queued", "rendering", "working_tree"]);
});

test("QueryHandlerDrizzle.buildWhere ignores undefined values", () => {
  const handler = new QueryHandlerDrizzle(recordingDb().db);
  assert.equal(render(handler, Table.REPOSITORIES, { name: undefined }), undefined);
  assert.equal(render(handler, Table.REPOSITORIES, { id: 1, name: undefined })?.sql, '"repositories"."id" = $1');
});

test("QueryHandlerDrizzle.buildWhere throws QueryHandlerError for unknown keys", () => {
  const handler = new QueryHandlerDrizzle(recordingDb().db);
  assert.throws(() => render(handler, Table.REPOSITORIES, { local_path: "/x" }), QueryHandlerError);
  assert.throws(() => render(handler, Table.REPOSITORIES, { toString: "x" }), QueryHandlerError);
});

test("Where.in([]) renders a false predicate and Where.notIn([]) a true one", () => {
  const handler = new QueryHandlerDrizzle(recordingDb().db);
  assert.equal(render(handler, Table.VISUALIZATIONS, { status: Where.in([]) })?.sql, "false");
  assert.equal(render(handler, Table.VISUALIZATIONS, { status: Where.notIn([]) })?.sql, "true");
});

test("QueryHandler.select adds isDeleted = false for repositories and visualizations only", async () => {
  const { db, queries } = recordingDb();
  const handler = new QueryHandler(db);
  await handler.select({ id: 1 }, Table.REPOSITORIES);
  await handler.select({ id: 1 }, Table.VISUALIZATIONS);
  await handler.select({ id: 1 }, Table.VISUALIZATION_COMPONENTS);
  await handler.select({}, Table.APP_SETTINGS);
  assert.match(queries[0]!.text, /"repositories"\."is_deleted" = \$1/);
  assert.match(queries[1]!.text, /"visualizations"\."is_deleted" = \$1/);
  assert.doesNotMatch(queries[2]!.text, /is_deleted/);
  assert.doesNotMatch(queries[3]!.text, /is_deleted|where/);
  assert.deepEqual(queries[0]!.params, [false, 1]);
});

test("QueryHandler.select with an explicit isDeleted condition overrides the default", async () => {
  const { db, queries } = recordingDb();
  await new QueryHandler(db).select({ isDeleted: true }, Table.REPOSITORIES);
  assert.deepEqual(queries[0]!.params, [true]);
  assert.equal(queries[0]!.text.split(" where ")[1]?.match(/is_deleted/g)?.length, 1);
});

test("QueryHandler.update without conditions returns 400 and does not execute", async () => {
  const { db, queries } = recordingDb();
  const response = await new QueryHandler(db).update({ name: "x" }, {}, Table.REPOSITORIES);
  assert.deepEqual(response, { status: 400, error: "No valid conditions provided", error_reason: "validation_failed" });
  const deleted = await new QueryHandler(db).delete({ id: undefined }, Table.REPOSITORIES, DeletionMode.HARD);
  assert.equal(deleted.status, 400);
  assert.equal(queries.length, 0);
});

test("QueryHandler.update stamps updatedAt only on tables that have it", async () => {
  const { db, queries } = recordingDb(() => 1);
  const handler = new QueryHandler(db);
  const updated = await handler.update({ name: "renamed" }, { id: 4 }, Table.REPOSITORIES);
  assert.deepEqual(updated, { status: 200, data: { rowsAffected: 1 } });
  assert.match(queries[0]!.text, /"updated_at" = \$2/);
  await handler.update({ message: "m" }, { id: 4 }, Table.VISUALIZATION_CONSOLE_EVENTS);
  assert.doesNotMatch(queries[1]!.text, /updated_at/);
  await assert.rejects(handler.update({ bogus: 1 }, { id: 1 }, Table.REPOSITORIES), QueryHandlerError);
});

test("QueryHandler.update and delete return 404 not_found when nothing matched; soft delete sets isDeleted", async () => {
  const { db, queries } = recordingDb(() => 0);
  const handler = new QueryHandler(db);
  assert.deepEqual(await handler.update({ name: "x" }, { id: 9 }, Table.REPOSITORIES), {
    status: 404,
    error: "Record not found",
    error_reason: "not_found"
  });
  const soft = await handler.delete({ id: 9 }, Table.REPOSITORIES, DeletionMode.SOFT);
  assert.equal(soft.status, 404);
  assert.match(queries[1]!.text, /^update "repositories" set "is_deleted" = \$1, "updated_at" = \$2/);
});

test("QueryHandler soft delete on visualization_components throws", async () => {
  const { db, queries } = recordingDb();
  await assert.rejects(
    new QueryHandler(db).delete({ id: 1 }, Table.VISUALIZATION_COMPONENTS, DeletionMode.SOFT),
    QueryHandlerError
  );
  assert.equal(queries.length, 0);
});

test("QueryHandler maps 23505 to 409 conflict with the constraint name; 23503 → 409; 22P02 → 400; 23514 → 500", async () => {
  const cases: Array<[DatabaseError, number, string, RegExp]> = [
    [pgError("23505", "repositories_local_path_active_key"), 409, "conflict", /repositories_local_path_active_key/],
    [pgError("23503", "visualizations_repository_id_fk"), 409, "conflict", /visualizations_repository_id_fk/],
    [pgError("22P02"), 400, "validation_failed", /Invalid value/],
    [pgError("23514", "visualizations_status_check"), 500, "internal_error", /Internal server error/]
  ];
  for (const [error, status, reason, message] of cases) {
    const { db } = recordingDb(() => {
      throw error;
    });
    const response = await new QueryHandler(db).insert({ name: "x", localPath: "/x" }, Table.REPOSITORIES);
    assert.equal(response.status, status, error.code);
    assert.equal(response.error_reason, reason);
    assert.match(String(response.error), message);
  }
});

test("QueryHandler isolated select and selectMany throw QueryHandlerError on DB failure", async () => {
  const { db } = recordingDb(() => {
    throw pgError("57P01");
  });
  const handler = new QueryHandler(db);
  await assert.rejects(handler.select({ id: 1 }, Table.REPOSITORIES, true), QueryHandlerError);
  await assert.rejects(handler.selectMany(RowModel, {}, Table.REPOSITORIES), QueryHandlerError);
  await assert.rejects(handler.validateAndSelect(RowModel, { id: 1 }, Table.REPOSITORIES), QueryHandlerError);
  const enveloped = await handler.select({ id: 1 }, Table.REPOSITORIES);
  assert.deepEqual(enveloped, { status: 500, error: "Internal server error", error_reason: "internal_error" });
  const counted = await handler.count({}, Table.REPOSITORIES);
  assert.equal(counted.status, 500);
});

test("QueryHandler.selectMany applies default id asc order and no limit by default", async () => {
  const { db, queries } = recordingDb(() => 2);
  const handler = new QueryHandler(db);
  const rows = await handler.selectMany(RowModel, { repositoryId: 1 }, Table.VISUALIZATIONS);
  assert.equal(rows.length, 2);
  assert.ok(rows[0] instanceof RowModel);
  assert.match(queries[0]!.text, /order by "visualizations"\."id" asc/);
  assert.doesNotMatch(queries[0]!.text, /limit/);

  await handler.selectMany(RowModel, {}, Table.VISUALIZATION_CONSOLE_EVENTS, {
    orderBy: [{ column: "createdAt", direction: "desc" }],
    limit: 500,
    offset: 20,
    search: { message: "50%_done" }
  });
  assert.match(queries[1]!.text, /"message" ilike \$1/);
  assert.match(queries[1]!.text, /order by "visualization_console_events"\."created_at" desc limit \$2 offset \$3/);
  assert.deepEqual(queries[1]!.params, ["%50\\%\\_done%", 500, 20]);
  await assert.rejects(
    handler.selectMany(RowModel, {}, Table.REPOSITORIES, { orderBy: [{ column: "nope", direction: "asc" }] }),
    QueryHandlerError
  );
});

test("QueryHandler.normalizeData strips underscores, functions and undefined but keeps null", () => {
  const model = { _name: "n", _missing: undefined, _nullable: null, method: () => 1, plain: 2 };
  assert.deepEqual(QueryHandler.normalizeData(model), { name: "n", nullable: null, plain: 2 });
  assert.deepEqual(QueryHandler.normalizeData(model, ["plain", "_name"]), { nullable: null });
});

test("QueryHandler.firstInsertedId reads data[0].id", () => {
  assert.equal(QueryHandler.firstInsertedId({ status: 200, data: [{ id: 7 }, { id: 8 }] }), 7);
  assert.equal(QueryHandler.firstInsertedId({ status: 200, data: [] }), null);
  assert.equal(QueryHandler.firstInsertedId({ status: 409, error: "dup" }), null);
});

test("QueryHandler.insert of an empty array is 200 [] without a query; unknown keys throw", async () => {
  const { db, queries } = recordingDb();
  const handler = new QueryHandler(db);
  assert.deepEqual(await handler.insert([], Table.VISUALIZATION_COMPONENTS), { status: 200, data: [] });
  await assert.rejects(handler.insert({ nope: 1 }, Table.REPOSITORIES), QueryHandlerError);
  assert.equal(queries.length, 0);
});
