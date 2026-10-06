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
