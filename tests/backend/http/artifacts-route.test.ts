import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { rawRequest } from "../helpers/http";
import { startTestApp, type TestApp } from "./app-fixture";

// 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64"
);
let testApp: TestApp;

before(async () => {
  testApp = await startTestApp();
  await testApp.store.write(testApp.store.componentImagePath(1, 2, "base"), PNG);
  await fs.writeFile(path.join(testApp.store.componentDir(1, 2), ".secret"), "dot");
  await fs.writeFile(path.join(testApp.store.componentDir(1, 2), "notes.txt"), "txt");
  await fs.writeFile(path.join(testApp.store.dataDir, "outside.txt"), "outside");
});

after(async () => {
  await testApp.close();
});

const NOT_FOUND = { status: 404, error: "Resource not found", error_reason: "not_found" };

test("artifacts: serves an existing base.png with image/png, ETag and Cache-Control private, no-cache", async () => {
  const response = await fetch(`${testApp.baseUrl}/artifacts/1/2/base.png`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "image/png");
  assert.ok(response.headers.get("etag"));
  assert.equal(response.headers.get("cache-control"), "private, no-cache");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), PNG);
});

test("artifacts: missing file → 404 envelope", async () => {
  const response = await fetch(`${testApp.baseUrl}/artifacts/1/2/head.png`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), NOT_FOUND);
});

test("artifacts: traversal attempts (../, %2e%2e, %2f, backslash) → 404 without fs access", async () => {
  for (const attempt of [
    "/artifacts/1/2/../../../outside.txt",
    "/artifacts/1/2/../2/base.png",
    "/artifacts/%2e%2e/outside.txt",
    "/artifacts/1/2/%2e%2e%2f%2e%2e%2foutside.txt",
    "/artifacts/1%2f2/base.png",
    "/artifacts/1/2/base.png%00",
    "/artifacts/1\\2\\base.png",
    "/artifacts/1/2/%E0%A4%A"
  ]) {
    const response = await rawRequest(testApp.baseUrl, { path: attempt });
    assert.ok(response.status === 404 || response.status === 400, `${attempt} → ${response.status}`);
    assert.ok(!response.body.includes("outside"), attempt);
    const body = JSON.parse(response.body) as { error_reason: string };
    assert.ok(["not_found", "validation_failed"].includes(body.error_reason));
  }
});

test("artifacts: non-png, dotfiles or extra segments → 404; POST → 404", async () => {
  for (const attempt of [
    "/artifacts/1/2/notes.txt",
    "/artifacts/1/2/.secret",
    "/artifacts/1/2/3/base.png",
    "/artifacts/1/2",
    "/artifacts/0/2/base.png",
    "/artifacts/"
  ]) {
    const response = await fetch(`${testApp.baseUrl}${attempt}`);
    assert.equal(response.status, 404, attempt);
    assert.deepEqual(await response.json(), NOT_FOUND);
  }
  const post = await fetch(`${testApp.baseUrl}/artifacts/1/2/base.png`, { method: "POST" });
  assert.equal(post.status, 404);
});

test("artifacts: a POST with a foreign Origin → 403 forbidden_origin", async () => {
  const response = await fetch(`${testApp.baseUrl}/artifacts/1/2/base.png`, {
    method: "POST",
    headers: { Origin: "https://evil.test" }
  });
  assert.equal(response.status, 403);
  assert.equal(((await response.json()) as { error_reason: string }).error_reason, "forbidden_origin");
});
