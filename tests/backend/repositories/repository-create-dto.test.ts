import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RepositoryCreateDTO } from "../../../backend/src/dtos/repositories/repository-create.dto";
import { Validation } from "../../../backend/src/utilities/validation/validation";

const validation = new Validation();

async function validate(body: unknown): Promise<{ ok: boolean; dto: RepositoryCreateDTO | null; errors: string[] }> {
  const [isValid, errorResponse, dto] = await validation.validate(
    validation.compileJsonData(body),
    RepositoryCreateDTO
  );
  if (isValid) {
    return { ok: true, dto, errors: [] };
  }
  assert.equal(errorResponse.status, 400);
  assert.equal(errorResponse.error_reason, "validation_failed");
  const error = errorResponse.error;
  return { ok: false, dto: null, errors: Array.isArray(error) ? error : [String(error)] };
}

test("accepts an absolute path", async () => {
  const result = await validate({ localPath: "/home/me/projects/app" });
  assert.equal(result.ok, true);
  assert.equal(result.dto?.localPath, "/home/me/projects/app");
  assert.equal(result.dto.name, undefined);
});

test("expands ~/ to the home directory", async () => {
  const result = await validate({ localPath: "  ~/projects/app " });
  assert.equal(result.ok, true);
  assert.equal(result.dto?.localPath, path.join(os.homedir(), "projects/app"));
  const bare = await validate({ localPath: "~" });
  assert.equal(bare.dto?.localPath, os.homedir());
});

test("rejects a relative path", async () => {
  const result = await validate({ localPath: "projects/app" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("absolute folder path")));
});

test("rejects an empty string", async () => {
  assert.equal((await validate({ localPath: "" })).ok, false);
  assert.equal((await validate({ localPath: "   " })).ok, false);
  assert.equal((await validate({})).ok, false);
});

test("rejects file:// URLs", async () => {
  assert.equal((await validate({ localPath: "file:///home/me/app" })).ok, false);
  assert.equal((await validate({ localPath: "https://github.com/acme/web" })).ok, false);
});

test("rejects strings containing NUL", async () => {
  assert.equal((await validate({ localPath: "/home/me/app\0/x" })).ok, false);
});

test("trims name and rejects names over 200 chars", async () => {
  const trimmed = await validate({ localPath: "/srv/app", name: "  My App  " });
  assert.equal(trimmed.ok, true);
  assert.equal(trimmed.dto?.name, "My App");
  assert.equal((await validate({ localPath: "/srv/app", name: "x".repeat(200) })).ok, true);
  assert.equal((await validate({ localPath: "/srv/app", name: "x".repeat(201) })).ok, false);
  assert.equal((await validate({ localPath: "/srv/app", name: "   " })).ok, false);
  const nullName = await validate({ localPath: "/srv/app", name: null });
  assert.equal(nullName.ok, true, "null is treated as omitted");
});

test("rejects unknown properties (forbidNonWhitelisted)", async () => {
  const result = await validate({ localPath: "/srv/app", framework: "react_vite" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((message) => message.includes("framework")));
});

test("does not expand ~user/x and rejects it as not absolute", async () => {
  const result = await validate({ localPath: "~alice/projects/app" });
  assert.equal(result.ok, false);
});

test("rejects names with control characters", async () => {
  const result = await validate({ localPath: "/srv/app", name: "bad\u0007name" });
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("name must not contain control characters"));
  assert.equal((await validate({ localPath: "/srv/app", name: "tab\tname" })).ok, false);
});

// ----- 16f block (16 §14.2): library choices -----

test("accepts libraryBuildMode, stateAllowance 1–5 and a cap with two decimals for a scan", async () => {
  const result = await validate({
    localPath: "/srv/app",
    libraryBuildMode: "scan",
    stateAllowance: 5,
    scanSpendCapUsd: 12.5
  });
  assert.equal(result.ok, true);
  assert.equal(result.dto?.libraryBuildMode, "scan");
  assert.equal(result.dto.stateAllowance, 5);
  assert.equal(result.dto.scanSpendCapUsd, 12.5);
  assert.equal((await validate({ localPath: "/srv/app", libraryBuildMode: "grow" })).ok, true);
  assert.equal((await validate({ localPath: "/srv/app", libraryBuildMode: "scan", scanSpendCapUsd: null })).ok, true);
});

test("rejects a spending cap without a scan with 'A spending cap only applies to a scan.'", async () => {
  for (const body of [
    { localPath: "/srv/app", scanSpendCapUsd: 20 },
    { localPath: "/srv/app", libraryBuildMode: "grow", scanSpendCapUsd: 20 }
  ]) {
    const result = await validate(body);
    assert.equal(result.ok, false);
    assert.ok(result.errors.includes("A spending cap only applies to a scan."), JSON.stringify(result.errors));
  }
  assert.equal((await validate({ localPath: "/srv/app", libraryBuildMode: "grow", scanSpendCapUsd: null })).ok, true);
});

test("rejects an unknown build mode, an allowance outside 1–5 and a cap outside 0.5–10 000 or with 3 decimals", async () => {
  for (const body of [
    { localPath: "/srv/app", libraryBuildMode: "whole" },
    { localPath: "/srv/app", stateAllowance: 0 },
    { localPath: "/srv/app", stateAllowance: 6 },
    { localPath: "/srv/app", stateAllowance: 2.5 },
    { localPath: "/srv/app", libraryBuildMode: "scan", scanSpendCapUsd: 0.25 },
    { localPath: "/srv/app", libraryBuildMode: "scan", scanSpendCapUsd: 10_000.5 },
    { localPath: "/srv/app", libraryBuildMode: "scan", scanSpendCapUsd: 1.005 }
  ]) {
    assert.equal((await validate(body)).ok, false, JSON.stringify(body));
  }
});
