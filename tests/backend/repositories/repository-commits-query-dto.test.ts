import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { COMMIT_LIST_MAX_LIMIT } from "../../../backend/src/config-consts";
import { RepositoryCommitsQueryDTO } from "../../../backend/src/dtos/repositories/repository-commits-query.dto";
import { Validation } from "../../../backend/src/utilities/validation/validation";

const validation = new Validation();

/** Query strings arrive as strings, exactly as Express parses them. */
async function validate(
  query: Record<string, string | string[]>
): Promise<{ ok: boolean; dto: RepositoryCommitsQueryDTO | null; errors: string[] }> {
  const [isValid, errorResponse, dto] = await validation.validate(
    validation.compileJsonData(query),
    RepositoryCommitsQueryDTO
  );
  if (isValid) {
    return { ok: true, dto, errors: [] };
  }
  assert.equal(errorResponse.status, 400);
  assert.equal(errorResponse.error_reason, "validation_failed");
  const error = errorResponse.error;
  return { ok: false, dto: null, errors: Array.isArray(error) ? error : [String(error)] };
}

test("RepositoryCommitsQueryDTO accepts a branch alone, coerces limit and lower-cases before", async () => {
  const bare = await validate({ branch: " feature/x " });
  assert.equal(bare.ok, true);
  assert.equal(bare.dto?.branch, "feature/x");
  assert.equal(bare.dto.limit, undefined);
  assert.equal(bare.dto.before, undefined);

  const full = await validate({ branch: "main", limit: "25", before: "ABCDEF".padEnd(40, "0") });
  assert.equal(full.ok, true);
  assert.equal(full.dto?.limit, 25);
  assert.equal(full.dto.before, "abcdef".padEnd(40, "0"));
  assert.equal((await validate({ branch: "main", limit: String(COMMIT_LIST_MAX_LIMIT) })).ok, true);
});

test("RepositoryCommitsQueryDTO rejects a missing or unsafe branch, a limit outside 1..200 and a short or non-hex before", async () => {
  assert.equal((await validate({})).ok, false);
  for (const branch of ["--all", "a..b", "HEAD", "main@{1}", ""]) {
    assert.equal((await validate({ branch })).ok, false, branch);
  }
  for (const limit of ["0", "201", "-1", "1.5", "ten"]) {
    assert.equal((await validate({ branch: "main", limit })).ok, false, limit);
  }
  const short = await validate({ branch: "main", before: "abc1234" });
  assert.ok(short.errors.some((e) => e.includes("before must be a full 40-character commit sha")));
  assert.equal((await validate({ branch: "main", before: "z".repeat(40) })).ok, false);
  assert.equal((await validate({ branch: "main", unknown: "1" })).ok, false, "unknown query keys are rejected");
});

test("RepositoryCommitsQueryDTO q is trimmed, blank means no search, and it must be one line of at most 100 characters", async () => {
  const search = await validate({ branch: "main", q: "  sidebar  " });
  assert.equal(search.ok, true);
  assert.equal(search.dto?.q, "sidebar");
  const blank = await validate({ branch: "main", q: "   " });
  assert.equal(blank.ok, true);
  assert.equal(blank.dto?.q, undefined);
  assert.equal((await validate({ branch: "main", q: "x".repeat(100) })).ok, true);
  assert.equal((await validate({ branch: "main", q: "x".repeat(101) })).ok, false);
  assert.equal((await validate({ branch: "main", q: "two\nlines" })).ok, false);
});
