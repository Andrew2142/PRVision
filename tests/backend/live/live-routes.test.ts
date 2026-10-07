import "reflect-metadata";
import assert from "node:assert/strict";
import test from "node:test";
import { LiveSessionService } from "../../../backend/src/services/live/live-session-service";
import { patchStaticMethod } from "../helpers/test-context";
import { startTestApp } from "../http/app-fixture";

/**
 * The 16i live routes (16 §14.1, §14.6) are behind requireLocal, validate `:id` and the bodies before the service
 * runs, and map an unreadable stop body (sendBeacon's text/plain blob) to reason "left". Service behaviour is covered
 * by live-session-service.test.ts.
 */

type Body = { status: number; data?: unknown; error?: string | string[]; error_reason?: string };

async function send(
  baseUrl: string,
  method: string,
  url: string,
  options: { headers?: Record<string, string>; body?: string } = {}
): Promise<{ status: number; body: Body }> {
  const response = await fetch(`${baseUrl}${url}`, {
    method,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...(method === "GET" ? {} : { body: options.body ?? "{}" })
  });
  return { status: response.status, body: (await response.json()) as Body };
}

const ROUTES: Array<[string, string]> = [
  ["POST", "/api/visualizations/1/live"],
  ["POST", "/api/visualizations/1/live/open"],
  ["POST", "/api/visualizations/1/live/heartbeat"],
  ["POST", "/api/visualizations/1/live/stop"]
];

test("the live write routes refuse a live page's origin and any other foreign origin (403 forbidden_origin)", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const [method, url] of ROUTES) {
    for (const origin of ["http://127.0.0.1:51234", "http://localhost:51234", "http://evil.example"]) {
      const response = await send(app.baseUrl, method, url, { headers: { Origin: origin } });
      assert.equal(response.status, 403, `${url} ${origin}`);
      assert.equal(response.body.error_reason, "forbidden_origin", `${url} ${origin}`);
    }
  }
});

test("every live route validates :id through IdParamDTO", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const [method, url] of [...ROUTES, ["GET", "/api/visualizations/1/live"] as [string, string]]) {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      const response = await send(app.baseUrl, method, url.replace("/1/", `/${bad}/`));
      assert.equal(response.status, 400, `${method} ${url} ${bad}`);
      assert.equal(response.body.error_reason, "validation_failed");
    }
  }
});

test("open and heartbeat validate their bodies; stop accepts only user or left", async (t) => {
  const app = await startTestApp();
  t.after(() => app.close());
  for (const body of [
    "{}",
    '{"componentId":1}',
    '{"componentId":0,"stateName":"Default"}',
    '{"componentId":"1","stateName":"Default"}',
    '{"componentId":1,"stateName":""}',
    `{"componentId":1,"stateName":"${"x".repeat(41)}"}`,
    '{"componentId":1,"stateName":"Default","extra":true}'
  ]) {
    const response = await send(app.baseUrl, "POST", "/api/visualizations/1/live/open", { body });
    assert.equal(response.status, 400, body);
    assert.equal(response.body.error_reason, "validation_failed", body);
  }
  for (const body of ["{}", '{"active":"yes"}', '{"active":1}']) {
    const response = await send(app.baseUrl, "POST", "/api/visualizations/1/live/heartbeat", { body });
    assert.equal(response.status, 400, body);
  }
  const bogus = await send(app.baseUrl, "POST", "/api/visualizations/1/live/stop", { body: '{"reason":"idle"}' });
  assert.equal(bogus.status, 400);
});

test("stop maps a missing, empty or text/plain beacon body to reason left and accepts the frontend origin", async (t) => {
  const calls: Array<[number, unknown]> = [];
  const restore = patchStaticMethod(
    LiveSessionService.prototype,
    "stop",
    (visualizationId: number, input: { reason?: "user" | "left" }) => {
      calls.push([visualizationId, input]);
      return Promise.resolve({ status: 200, data: { id: 7, status: "stopping" as const } });
    }
  );
  t.after(restore);
  const app = await startTestApp();
  t.after(() => app.close());
  const beacon = await fetch(`${app.baseUrl}/api/visualizations/3/live/stop`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", Origin: "http://localhost:4210" },
    body: "{}"
  });
  assert.equal(beacon.status, 200);
  assert.deepEqual(await beacon.json(), { status: 200, data: { id: 7, status: "stopping" } });
  const empty = await fetch(`${app.baseUrl}/api/visualizations/3/live/stop`, {
    method: "POST",
    headers: { Origin: "http://127.0.0.1:4210" }
  });
  assert.equal(empty.status, 200);
  const user = await send(app.baseUrl, "POST", "/api/visualizations/3/live/stop", { body: '{"reason":"user"}' });
  assert.equal(user.status, 200);
  assert.deepEqual(calls, [
    [3, {}],
    [3, {}],
    [3, { reason: "user" }]
  ]);
});
