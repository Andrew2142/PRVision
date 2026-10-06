import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isValidGitBranchName,
  VisualizationCreateDTO
} from "../../../backend/src/dtos/visualizations/visualization-create.dto";
import { Validation, type ApiResponse } from "../../../backend/src/utilities";

const validation = new Validation();

async function validate(body: unknown): Promise<{ ok: boolean; errors: string[]; dto: VisualizationCreateDTO | null }> {
  const [isValid, errorResponse, dto] = await validation.validate(
    validation.compileJsonData(body),
    VisualizationCreateDTO
  );
  if (isValid) {
    return { ok: true, errors: [], dto };
  }
  const response: ApiResponse = errorResponse;
  assert.equal(response.status, 400);
  assert.equal(response.error_reason, "validation_failed");
  return { ok: false, errors: Array.isArray(response.error) ? response.error : [String(response.error)], dto: null };
}

test("VisualizationCreateDTO accepts github_pr with prNumber, with and without baseRef", async () => {
  assert.equal((await validate({ repositoryId: 1, sourceType: "github_pr", prNumber: 12 })).ok, true);
  const withBase = await validate({ repositoryId: 1, sourceType: "github_pr", prNumber: 12, baseRef: " main " });
  assert.equal(withBase.ok, true);
  assert.equal(withBase.dto?.baseRef, "main");
});

test("VisualizationCreateDTO rejects github_pr without prNumber, and with headRef", async () => {
  assert.equal((await validate({ repositoryId: 1, sourceType: "github_pr" })).ok, false);
  const withHead = await validate({ repositoryId: 1, sourceType: "github_pr", prNumber: 3, headRef: "feature/x" });
  assert.equal(withHead.ok, false);
  assert.ok(withHead.errors.some((e) => e.includes("headRef is only allowed when sourceType is local_branch")));
});

test("VisualizationCreateDTO accepts local_branch with headRef only, and with headRef + baseRef", async () => {
  const headOnly = await validate({ repositoryId: 1, sourceType: "local_branch", headRef: "feature/x" });
  assert.equal(headOnly.ok, true);
  assert.equal(headOnly.dto?.baseRef, undefined);
  assert.equal(
    (await validate({ repositoryId: 1, sourceType: "local_branch", headRef: "feature/x", baseRef: "develop" })).ok,
    true
  );
});

test("VisualizationCreateDTO rejects local_branch with prNumber, or with baseRef equal to headRef", async () => {
  const withPr = await validate({ repositoryId: 1, sourceType: "local_branch", headRef: "feature/x", prNumber: 1 });
  assert.equal(withPr.ok, false);
  assert.ok(withPr.errors.some((e) => e.includes("prNumber is only allowed when sourceType is github_pr")));
  const same = await validate({ repositoryId: 1, sourceType: "local_branch", headRef: "main", baseRef: "main" });
  assert.equal(same.ok, false);
  assert.ok(same.errors.some((e) => e.includes("baseRef and headRef must be different")));
  assert.equal((await validate({ repositoryId: 1, sourceType: "local_branch" })).ok, false, "headRef is required");
});

test("VisualizationCreateDTO accepts working_tree with no source fields; rejects any ref or prNumber", async () => {
  assert.equal((await validate({ repositoryId: 1, sourceType: "working_tree" })).ok, true);
  for (const extra of [{ prNumber: 1 }, { headRef: "x" }, { baseRef: "main" }]) {
    const result = await validate({ repositoryId: 1, sourceType: "working_tree", ...extra });
    assert.equal(result.ok, false, JSON.stringify(extra));
    assert.ok(result.errors.some((e) => e.includes("cannot be set when sourceType is working_tree")));
  }
});

const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "a".repeat(40);

test("VisualizationCreateDTO accepts commit_range with headRef, baseSha and headSha (trimmed, lower-cased)", async () => {
  const result = await validate({
    repositoryId: 1,
    sourceType: "commit_range",
    headRef: " feature/x ",
    baseSha: ` ${BASE_SHA} `,
    headSha: "A".repeat(40)
  });
  assert.equal(result.ok, true);
  assert.equal(result.dto?.headRef, "feature/x");
  assert.equal(result.dto.baseSha, BASE_SHA);
  assert.equal(result.dto.headSha, HEAD_SHA);
});

test("VisualizationCreateDTO rejects commit_range without its fields, with short or equal shas, or with prNumber/baseRef", async () => {
  const body = {
    repositoryId: 1,
    sourceType: "commit_range",
    headRef: "feature/x",
    baseSha: BASE_SHA,
    headSha: HEAD_SHA
  };
  const noBranch = await validate({ ...body, headRef: undefined });
  assert.equal(noBranch.ok, false, "headRef is required");
  const noBase = await validate({ ...body, baseSha: undefined });
  assert.equal(noBase.ok, false);
  assert.ok(noBase.errors.some((e) => e.includes("baseSha and headSha are required when sourceType is commit_range")));
  const short = await validate({ ...body, headSha: "abc1234" });
  assert.equal(short.ok, false);
  assert.ok(short.errors.some((e) => e.includes("headSha must be a full 40-character commit sha")));
  const notHex = await validate({ ...body, baseSha: "g".repeat(40) });
  assert.ok(notHex.errors.some((e) => e.includes("baseSha must be a full 40-character commit sha")));
  const same = await validate({ ...body, headSha: BASE_SHA.toUpperCase() });
  assert.equal(same.ok, false);
  assert.ok(same.errors.some((e) => e.includes("baseSha and headSha must be different commits")));
  const withPr = await validate({ ...body, prNumber: 3 });
  assert.ok(
    withPr.errors.some((e) => e.includes("prNumber and baseRef cannot be set when sourceType is commit_range"))
  );
  const withBaseRef = await validate({ ...body, baseRef: "main" });
  assert.equal(withBaseRef.ok, false);
  const nullSha = await validate({ ...body, baseSha: null });
  assert.equal(nullSha.ok, false);
});

test("VisualizationCreateDTO rejects baseSha/headSha on the other source types", async () => {
  const branch = await validate({
    repositoryId: 1,
    sourceType: "local_branch",
    headRef: "feature/x",
    baseSha: BASE_SHA
  });
  assert.equal(branch.ok, false);
  assert.ok(
    branch.errors.some((e) => e.includes("baseSha and headSha are only allowed when sourceType is commit_range"))
  );
  assert.equal((await validate({ repositoryId: 1, sourceType: "working_tree", headSha: HEAD_SHA })).ok, false);
  assert.equal(
    (await validate({ repositoryId: 1, sourceType: "github_pr", prNumber: 1, headSha: HEAD_SHA })).ok,
    false
  );
});

test("VisualizationCreateDTO rejects an unknown sourceType and an explicit null prNumber, headRef or baseRef", async () => {
  assert.equal((await validate({ repositoryId: 1, sourceType: "svn" })).ok, false);
  assert.equal((await validate({ repositoryId: 1, sourceType: "github_pr", prNumber: null })).ok, false);
  assert.equal((await validate({ repositoryId: 1, sourceType: "local_branch", headRef: null })).ok, false);
  assert.equal(
    (await validate({ repositoryId: 1, sourceType: "local_branch", headRef: "x", baseRef: null })).ok,
    false
  );
  assert.equal((await validate({ repositoryId: 1, sourceType: "working_tree", baseRef: null })).ok, false);
});

test("VisualizationCreateDTO rejects title, headBranch and baseBranch as unknown properties", async () => {
  for (const key of ["title", "headBranch", "baseBranch"]) {
    const result = await validate({ repositoryId: 1, sourceType: "local_branch", headRef: "feature/x", [key]: "x" });
    assert.equal(result.ok, false, key);
    assert.ok(
      result.errors.some((e) => e.includes(`property ${key} should not exist`)),
      result.errors.join("; ")
    );
  }
});

test("VisualizationCreateDTO rejects a numeric-string repositoryId (no body coercion)", async () => {
  assert.equal((await validate({ repositoryId: "12", sourceType: "working_tree" })).ok, false);
  assert.equal((await validate({ repositoryId: 0, sourceType: "working_tree" })).ok, false);
  assert.equal((await validate({ repositoryId: 1.5, sourceType: "working_tree" })).ok, false);
});

test("isValidGitBranchName accepts feature/x, release-1.2, user+fix", () => {
  for (const name of ["feature/x", "release-1.2", "user+fix", "main", "a/b/c_d"]) {
    assert.equal(isValidGitBranchName(name), true, name);
  }
});

test('isValidGitBranchName rejects -x, a..b, "a b", fix#12, a~1, a^, a:b, a@{1}, x.lock, .hidden, trailing / and ., HEAD and non-ASCII', () => {
  for (const name of [
    "-x",
    "a..b",
    "a b",
    "fix#12",
    "a~1",
    "a^",
    "a:b",
    "a@{1}",
    "x.lock",
    ".hidden",
    "dir/.hidden",
    "x/",
    "x.",
    "HEAD",
    "brånch",
    "a//b",
    "/x",
    "",
    "x".repeat(256)
  ]) {
    assert.equal(isValidGitBranchName(name), false, name);
  }
  assert.equal(isValidGitBranchName(42), false);
});
