import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { startTestApp } from "../http/app-fixture";

/**
 * The 16g repair routes (16 §14.1, §14.4) are registered behind requireLocal and validate `:id` and `:componentId`
 * (ComponentParamDTO) before the service runs. Only guard and validation paths are exercised (they never reach the
 * database); service behaviour is covered by harness-library-service.repair.test.ts.
 */

type Route = [method: string, path: string];

async function send(
  baseUrl: string,
  [method, url]: Route,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: { status: number; error?: string | string[]; error_reason?: string } }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: "{}"
  });
  return {
    status: response.status,
    body: (await response.json()) as { status: number; error?: string | string[]; error_reason?: string }
  };
}

test("the repair routes are behind requireLocal (a foreign Origin is refused before the service)", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const route of [
    ["POST", "/api/visualizations/1/components/2/repair"],
    ["POST", "/api/visualizations/1/repair-broken"]
  ] as Route[]) {
    const foreign = await send(app.baseUrl, route, { Origin: "http://evil.example" });
    assert.equal(foreign.status, 403, route[1]);
    assert.equal(foreign.body.error_reason, "forbidden_origin", route[1]);
    const crossSite = await send(app.baseUrl, route, { "Sec-Fetch-Site": "cross-site" });
    assert.equal(crossSite.status, 403, `${route[1]} cross-site`);
  }
});

test("POST /components/:componentId/repair validates both path ids through ComponentParamDTO", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const url of [
    "/api/visualizations/abc/components/2/repair",
    "/api/visualizations/0/components/2/repair",
    "/api/visualizations/1/components/x/repair",
    "/api/visualizations/1/components/0/repair",
    "/api/visualizations/1/components/1.5/repair",
    "/api/visualizations/1/components/99999999999/repair"
  ]) {
    const response = await send(app.baseUrl, ["POST", url]);
    assert.equal(response.status, 400, url);
    assert.equal(response.body.error_reason, "validation_failed", url);
  }
});

test("POST /repair-broken validates :id through IdParamDTO", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const url of ["/api/visualizations/x/repair-broken", "/api/visualizations/-3/repair-broken"]) {
    const response = await send(app.baseUrl, ["POST", url]);
    assert.equal(response.status, 400, url);
    assert.equal(response.body.error_reason, "validation_failed", url);
  }
});
