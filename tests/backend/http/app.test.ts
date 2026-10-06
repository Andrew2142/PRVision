import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Request, Response } from "express";
import { AuthContext } from "../../../backend/src/utilities/context/auth-context";
import { ResponseHandler } from "../../../backend/src/utilities/handlers/response-handler";
import { rawRequest } from "../helpers/http";
import { startTestApp, type TestApp } from "./app-fixture";

const responseHandler = new ResponseHandler();
let testApp: TestApp;
let seenInHandler: { requestId: string | undefined; body: unknown } | null = null;

before(async () => {
  testApp = await startTestApp((app) => {
    app.get("/api/test/throw", () => {
      throw new Error("secret detail /home/user/.prvision");
    });
    app.post("/api/test/echo", (req: Request, res: Response) => {
      seenInHandler = { requestId: AuthContext.getRequestId(), body: req.body as unknown };
      return responseHandler.controllerResponse({ status: 200, data: { ok: true } }, res);
    });
  });
});

after(async () => {
  await testApp.close();
});

test("app: unknown route → 404 not_found envelope", async () => {
  const response = await fetch(`${testApp.baseUrl}/nope`);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { status: 404, error: "Resource not found", error_reason: "not_found" });
});

test("app: malformed JSON → 400 validation_failed; 2 MB body → 413 payload_too_large", async () => {
  const malformed = await fetch(`${testApp.baseUrl}/api/test/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{bad json"
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), {
    status: 400,
    error: "Malformed JSON body",
    error_reason: "validation_failed"
  });

  const large = await fetch(`${testApp.baseUrl}/api/test/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ blob: "x".repeat(2 * 1024 * 1024) })
  });
  assert.equal(large.status, 413);
  assert.deepEqual(await large.json(), {
    status: 413,
    error: "Request body too large",
    error_reason: "payload_too_large"
  });
});

test("app: thrown error in a handler → 500 internal_error with a generic message", async () => {
  const response = await fetch(`${testApp.baseUrl}/api/test/throw`);
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { status: 500, error: "Internal server error", error_reason: "internal_error" });
  assert.ok(!text.includes("secret detail"));
});

test("app: responses carry X-Request-Id; a valid incoming X-Request-Id is echoed", async () => {
  const generated = await fetch(`${testApp.baseUrl}/api/health`);
  assert.match(generated.headers.get("x-request-id") ?? "", /^[0-9a-f-]{36}$/);
  const echoed = await fetch(`${testApp.baseUrl}/api/health`, { headers: { "X-Request-Id": "abc.123_x-y" } });
  assert.equal(echoed.headers.get("x-request-id"), "abc.123_x-y");
  const replaced = await fetch(`${testApp.baseUrl}/api/health`, { headers: { "X-Request-Id": "bad id with spaces" } });
  assert.notEqual(replaced.headers.get("x-request-id"), "bad id with spaces");
  assert.deepEqual(await echoed.json(), { status: 200, data: { stub: true } });
});

test("app: the AuthContext request id is available inside a POST handler with a JSON body", async () => {
  seenInHandler = null;
  const response = await fetch(`${testApp.baseUrl}/api/test/echo`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Request-Id": "post-req-1" },
    body: JSON.stringify({ hello: "world" })
  });
  assert.equal(response.status, 200);
  assert.deepEqual(seenInHandler, { requestId: "post-req-1", body: { hello: "world" } });
});

test("app: Host evil.test → 403 forbidden_origin before CORS", async () => {
  const response = await rawRequest(testApp.baseUrl, {
    method: "OPTIONS",
    path: "/api/health",
    headers: {
      Host: "evil.test",
      Origin: "http://localhost:4210",
      "Access-Control-Request-Method": "POST"
    }
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(JSON.parse(response.body), {
    status: 403,
    error: "Forbidden host",
    error_reason: "forbidden_origin"
  });
});

test("app: CORS preflight from http://localhost:4210 succeeds; another origin gets no ACAO header", async () => {
  const allowed = await fetch(`${testApp.baseUrl}/api/health`, {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:4210", "Access-Control-Request-Method": "PUT" }
  });
  assert.ok(allowed.status === 204 || allowed.status === 200);
  assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:4210");
  assert.equal(allowed.headers.get("access-control-allow-credentials"), null);

  const twin = await fetch(`${testApp.baseUrl}/api/health`, { headers: { Origin: "http://127.0.0.1:4210" } });
  assert.equal(twin.headers.get("access-control-allow-origin"), "http://127.0.0.1:4210");

  const other = await fetch(`${testApp.baseUrl}/api/health`, {
    method: "OPTIONS",
    headers: { Origin: "https://evil.test", "Access-Control-Request-Method": "PUT" }
  });
  assert.equal(other.headers.get("access-control-allow-origin"), null);
});

test("app: Cross-Origin-Resource-Policy is same-site and x-powered-by is absent", async () => {
  const response = await fetch(`${testApp.baseUrl}/api/health`);
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-site");
  assert.equal(response.headers.get("x-powered-by"), null);
});
