import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp } from "../http/app-fixture";

/**
 * The eight repository routes are registered behind requireLocal (06 §5.9). Only validation paths are exercised
 * here (they never reach the database); service behaviour is covered by repositories-service.test.ts.
 */
test("every repository route is registered and validates its :id before the service runs", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const routes: Array<[string, string]> = [
    ["GET", "/api/repositories/abc"],
    ["POST", "/api/repositories/0/redetect"],
    ["DELETE", "/api/repositories/12abc"],
    ["GET", "/api/repositories/-1/pull-requests"],
    ["GET", "/api/repositories/1.5/branches"],
    ["GET", "/api/repositories/x/commits?branch=main"]
  ];
  for (const [method, url] of routes) {
    const response = await fetch(`${app.baseUrl}${url}`, { method });
    const body = (await response.json()) as { status: number; error_reason?: string };
    assert.equal(response.status, 400, `${method} ${url}`);
    assert.equal(body.error_reason, "validation_failed", `${method} ${url}`);
  }
});

test("GET /api/repositories/:id/commits is registered and validates branch, limit and before (00 §16)", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const query of [
    "",
    "?branch=--all",
    "?branch=main&limit=201",
    "?branch=main&limit=0",
    "?branch=main&before=abc1234"
  ]) {
    const response = await fetch(`${app.baseUrl}/api/repositories/1/commits${query}`);
    const body = (await response.json()) as { status: number; error_reason?: string };
    assert.equal(response.status, 400, query);
    assert.equal(body.error_reason, "validation_failed", query);
  }
});

test("POST /api/repositories validates the body and rejects a foreign Origin", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${app.baseUrl}/api/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    });

  const relative = await post({ localPath: "projects/app" });
  assert.equal(relative.status, 400);
  const body = (await relative.json()) as { error: string[]; error_reason: string };
  assert.equal(body.error_reason, "validation_failed");
  assert.ok(body.error.some((message) => message.includes("absolute folder path")));

  const foreign = await post({ localPath: "/srv/app" }, { Origin: "http://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal(((await foreign.json()) as { error_reason: string }).error_reason, "forbidden_origin");
});

test("POST /api/repositories/detect-apps is registered behind requireLocal and validates localPath", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const post = (body: unknown, headers: Record<string, string> = {}): Promise<Response> =>
    fetch(`${app.baseUrl}/api/repositories/detect-apps`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body)
    });

  for (const localPath of ["projects/app", "file:///srv/app", "/srv/\u0000app", ""]) {
    const response = await post({ localPath });
    assert.equal(response.status, 400, localPath);
    assert.equal(((await response.json()) as { error_reason: string }).error_reason, "validation_failed", localPath);
  }
  const foreign = await post({ localPath: "/srv/app" }, { Origin: "http://evil.example" });
  assert.equal(foreign.status, 403);
  assert.equal(((await foreign.json()) as { error_reason: string }).error_reason, "forbidden_origin");
});

test("POST /api/repositories rejects an appRoot with '..', a leading '/', or NUL, and a malformed angularProject", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const post = (body: unknown): Promise<Response> =>
    fetch(`${app.baseUrl}/api/repositories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ localPath: "/srv/app", appRoot: "../other" }, /appRoot must be a folder inside the repository/],
    [{ localPath: "/srv/app", appRoot: "src/../../x" }, /appRoot must be a folder inside the repository/],
    [{ localPath: "/srv/app", appRoot: "/etc" }, /appRoot must be a folder inside the repository/],
    [{ localPath: "/srv/app", appRoot: "src/\u0000x" }, /appRoot must be a folder inside the repository/],
    [{ localPath: "/srv/app", appRoot: "a".repeat(301) }, /appRoot must be shorter than or equal to 300/],
    [{ localPath: "/srv/app", angularProject: "bad name" }, /angularProject may only contain/],
    [{ localPath: "/srv/app", angularProject: "x".repeat(201) }, /angularProject must be shorter than or equal to 200/]
  ];
  for (const [body, message] of cases) {
    const response = await post(body);
    const parsed = (await response.json()) as { error: string[]; error_reason: string };
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(parsed.error_reason, "validation_failed");
    assert.ok(
      parsed.error.some((line) => message.test(line)),
      `${JSON.stringify(body)}: ${parsed.error.join("; ")}`
    );
  }
});
