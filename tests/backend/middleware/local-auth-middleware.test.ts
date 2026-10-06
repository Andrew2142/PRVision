import assert from "node:assert/strict";
import test from "node:test";
import type { NextFunction, Request, Response } from "express";
import { APP_PORT } from "../../../backend/src/config-consts";
import { LocalAuthMiddleware } from "../../../backend/src/middleware/local-auth-middleware";
import { LOCAL_USER } from "../../../backend/src/types/local-user";
import { AuthContext } from "../../../backend/src/utilities/context/auth-context";

interface Outcome {
  nextCalled: boolean;
  status: number | null;
  body: unknown;
}

function makeRequest(method: string, headers: Record<string, string | undefined>, localPort = APP_PORT): Request {
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    path: "/api/x",
    headers: lower,
    socket: { localPort },
    get(name: string) {
      return lower[name.toLowerCase()];
    }
  } as unknown as Request;
}

function run(handler: (req: Request, res: Response, next: NextFunction) => void, req: Request): Outcome {
  const outcome: Outcome = { nextCalled: false, status: null, body: undefined };
  const res = {
    status(code: number) {
      outcome.status = code;
      return this;
    },
    json(body: unknown) {
      outcome.body = body;
      return this;
    }
  } as unknown as Response;
  handler(req, res, () => {
    outcome.nextCalled = true;
  });
  return outcome;
}

const FORBIDDEN = { status: 403, error: "Forbidden host", error_reason: "forbidden_origin" };

test("LocalAuthMiddleware.guardHost allows localhost:<PORT> and 127.0.0.1:<PORT>", () => {
  const middleware = new LocalAuthMiddleware();
  const guard = middleware.guardHost.bind(middleware);
  for (const host of [`localhost:${APP_PORT}`, `127.0.0.1:${APP_PORT}`, `LOCALHOST:${APP_PORT}`]) {
    assert.equal(run(guard, makeRequest("GET", { host })).nextCalled, true, host);
  }
});

test("LocalAuthMiddleware.guardHost rejects other hosts, another port, a missing port and a missing Host with 403 forbidden_origin", () => {
  const middleware = new LocalAuthMiddleware();
  const guard = middleware.guardHost.bind(middleware);
  for (const host of [
    "evil.test:3100",
    `evil.test:${APP_PORT}`,
    "localhost",
    "localhost:9999",
    "127.0.0.2:3100",
    undefined
  ]) {
    const outcome = run(guard, makeRequest("GET", { host }));
    assert.equal(outcome.nextCalled, false, String(host));
    assert.equal(outcome.status, 403);
    assert.deepEqual(outcome.body, FORBIDDEN);
  }
});

test('LocalAuthMiddleware.guardHost with apiPort "socket" compares against the listening port', () => {
  const middleware = new LocalAuthMiddleware({ apiPort: "socket" });
  const guard = middleware.guardHost.bind(middleware);
  assert.equal(run(guard, makeRequest("GET", { host: "127.0.0.1:45678" }, 45678)).nextCalled, true);
  assert.equal(run(guard, makeRequest("GET", { host: `127.0.0.1:${APP_PORT}` }, 45678)).nextCalled, false);
});

test("LocalAuthMiddleware.requireLocal allows GET from any origin (CORS handles reads)", async () => {
  const middleware = new LocalAuthMiddleware({ frontendUrl: "http://localhost:4210" });
  await AuthContext.runAsLocalUser(() => {
    const outcome = run(
      middleware.requireLocal.bind(middleware),
      makeRequest("GET", { origin: "https://evil.test", "sec-fetch-site": "cross-site" })
    );
    assert.equal(outcome.nextCalled, true);
  });
});

test('LocalAuthMiddleware.requireLocal rejects POST with a foreign Origin, the API\'s own origin, Origin "null", or Sec-Fetch-Site cross-site', async () => {
  const middleware = new LocalAuthMiddleware({ frontendUrl: "http://localhost:4210" });
  const requireLocal = middleware.requireLocal.bind(middleware);
  await AuthContext.runAsLocalUser(() => {
    for (const headers of [
      { origin: "https://evil.test" },
      { origin: "http://localhost:3100" },
      { origin: "http://localhost:5173", "sec-fetch-site": "same-site" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" }
    ]) {
      for (const method of ["POST", "PUT", "DELETE"]) {
        const outcome = run(requireLocal, makeRequest(method, headers));
        assert.equal(outcome.nextCalled, false, `${method} ${JSON.stringify(headers)}`);
        assert.equal(outcome.status, 403);
        assert.deepEqual(outcome.body, { status: 403, error: "Forbidden origin", error_reason: "forbidden_origin" });
      }
    }
  });
});

test("LocalAuthMiddleware.requireLocal allows POST from FRONTEND_URL, its 127.0.0.1 twin, and from curl (no Origin)", async () => {
  const middleware = new LocalAuthMiddleware({ frontendUrl: "http://localhost:4210" });
  assert.deepEqual(middleware.allowedOriginList().sort(), ["http://127.0.0.1:4210", "http://localhost:4210"]);
  const requireLocal = middleware.requireLocal.bind(middleware);
  await AuthContext.runAsLocalUser(() => {
    for (const headers of [
      { origin: "http://localhost:4210", "sec-fetch-site": "same-site" },
      { origin: "http://127.0.0.1:4210" },
      {}
    ]) {
      assert.equal(run(requireLocal, makeRequest("POST", headers)).nextCalled, true, JSON.stringify(headers));
    }
  });
});

test("LocalAuthMiddleware.requireLocal sets the AuthContext user and req.localUser", async () => {
  const middleware = new LocalAuthMiddleware();
  await new Promise<void>((resolve) => {
    const req = makeRequest("GET", {}) as Request & { requestId?: string };
    req.requestId = "req-1";
    AuthContext.middleware(req, {} as Response, () => {
      assert.equal(AuthContext.getUser(), undefined);
      run(middleware.requireLocal.bind(middleware), req);
      assert.equal(req.localUser, LOCAL_USER);
      assert.equal(AuthContext.requireUser(), LOCAL_USER);
      assert.equal(AuthContext.requireUserId(), 1);
      assert.equal(AuthContext.getRequestId(), "req-1");
      resolve();
    });
  });
});
