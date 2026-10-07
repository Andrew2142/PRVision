import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp } from "../http/app-fixture";

/**
 * The 16f library routes (16 §14.1) are registered behind requireLocal and validate their params, queries and bodies
 * before the service runs. Only validation and guard paths are exercised (they never reach the database); service
 * behaviour is covered by harness-library-service.test.ts.
 */

type Route = [method: string, path: string, body?: unknown];

const ROUTES: Route[] = [
  ["POST", "/api/repositories/library-estimate", { localPath: "/srv/app", stateAllowance: 3 }],
  ["GET", "/api/repositories/1/library"],
  ["GET", "/api/repositories/1/library/estimate"],
  ["POST", "/api/repositories/1/library/scans", { kind: "scan", spendCapUsd: null }],
  ["GET", "/api/library-jobs/1"],
  ["GET", "/api/library-jobs/1/events"],
  ["POST", "/api/library-jobs/1/cancel", {}]
];

async function send(
  baseUrl: string,
  [method, url, body]: Route,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: { status: number; error?: string | string[]; error_reason?: string } }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  return {
    status: response.status,
    body: (await response.json()) as { status: number; error?: string | string[]; error_reason?: string }
  };
}

test("every state-changing 16f route is behind requireLocal (a foreign Origin is refused before the service)", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  // requireLocal checks Origin and Sec-Fetch-Site on state-changing methods only (00 §14.5); GET routes are reached
  // through the same guard (their validation is exercised below).
  for (const route of ROUTES.filter(([method]) => method !== "GET")) {
    const response = await send(app.baseUrl, route, { Origin: "http://evil.example" });
    assert.equal(response.status, 403, `${route[0]} ${route[1]}`);
    assert.equal(response.body.error_reason, "forbidden_origin", `${route[0]} ${route[1]}`);
    const crossSite = await send(app.baseUrl, route, { "Sec-Fetch-Site": "cross-site" });
    assert.equal(crossSite.status, 403, `${route[0]} ${route[1]} cross-site`);
  }
});

test("every :id of the library routes is validated through IdParamDTO", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const routes: Route[] = [
    ["GET", "/api/repositories/abc/library"],
    ["GET", "/api/repositories/0/library/estimate"],
    ["POST", "/api/repositories/-1/library/scans", { kind: "scan", spendCapUsd: null }],
    ["GET", "/api/library-jobs/1.5"],
    ["GET", "/api/library-jobs/x/events"],
    ["POST", "/api/library-jobs/99999999999/cancel", {}]
  ];
  for (const route of routes) {
    const response = await send(app.baseUrl, route);
    assert.equal(response.status, 400, `${route[0]} ${route[1]}`);
    assert.equal(response.body.error_reason, "validation_failed", `${route[0]} ${route[1]}`);
  }
});

test("the estimate and events queries are validated (allowance 1–5, kind scan|rescan, afterId ≥ 0, limit 1–500)", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const url of [
    "/api/repositories/1/library/estimate?stateAllowance=0",
    "/api/repositories/1/library/estimate?stateAllowance=6",
    "/api/repositories/1/library/estimate?stateAllowance=2.5",
    "/api/repositories/1/library/estimate?kind=repair",
    "/api/repositories/1/library/estimate?other=1",
    "/api/library-jobs/1/events?afterId=-1",
    "/api/library-jobs/1/events?limit=0",
    "/api/library-jobs/1/events?limit=501"
  ]) {
    const response = await send(app.baseUrl, ["GET", url]);
    assert.equal(response.status, 400, url);
    assert.equal(response.body.error_reason, "validation_failed", url);
  }
});

test("POST /library/scans validates kind, the spending cap (0.5–10 000, 2 decimals) and the allowance", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const body of [
    {},
    { kind: "repair", spendCapUsd: null },
    { kind: "scan", spendCapUsd: 0.25 },
    { kind: "scan", spendCapUsd: 10_001 },
    { kind: "scan", spendCapUsd: 1.234 },
    { kind: "scan", spendCapUsd: "20" },
    { kind: "rescan", spendCapUsd: null, stateAllowance: 0 },
    { kind: "rescan", spendCapUsd: null, stateAllowance: 6 },
    { kind: "scan", spendCapUsd: null, extra: true }
  ]) {
    const response = await send(app.baseUrl, ["POST", "/api/repositories/1/library/scans", body]);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error_reason, "validation_failed", JSON.stringify(body));
  }
});

test("POST /api/repositories/library-estimate is not captured by :id and validates its own body", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  const missingAllowance = await send(app.baseUrl, [
    "POST",
    "/api/repositories/library-estimate",
    { localPath: "/srv/app" }
  ]);
  assert.equal(missingAllowance.status, 400);
  assert.equal(missingAllowance.body.error_reason, "validation_failed");
  const messages = Array.isArray(missingAllowance.body.error) ? missingAllowance.body.error : [];
  assert.ok(
    messages.some((message) => message.includes("stateAllowance")),
    JSON.stringify(messages)
  );
  assert.equal(
    messages.some((message) => message.includes("id must")),
    false,
    "the path segment is never read as an :id"
  );
  for (const body of [
    { localPath: "projects/app", stateAllowance: 3 },
    { localPath: "/srv/app", stateAllowance: 9 },
    { localPath: "/srv/app", stateAllowance: 3, appRoot: "../outside" }
  ]) {
    const response = await send(app.baseUrl, ["POST", "/api/repositories/library-estimate", body]);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error_reason, "validation_failed", JSON.stringify(body));
  }
});
