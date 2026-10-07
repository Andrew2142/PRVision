import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { liveInitScriptTag } from "../../../backend/src/services/visualizations/pipeline/render/live/live-init-script";
import { buildLiveCsp } from "../../../backend/src/services/visualizations/pipeline/render/live/live-page-headers";
import {
  LIVE_PLUGIN_NAME,
  createLivePlugin,
  type LiveMiddleware,
  type LiveRejection
} from "../../../backend/src/services/visualizations/pipeline/render/live/live-vite-plugin";

const ORIGINS = ["http://localhost:4210", "http://127.0.0.1:4210"];

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A tiny connect-like app: the live middleware first, then a handler standing in for Vite. */
async function serve(
  t: TestContext,
  rejections: LiveRejection[],
  downstream: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<number> {
  const stack: Array<{ route: string; handle: LiveMiddleware }> = [
    { route: "", handle: (req, res, next) => (req.url === "/user-plugin" ? res.end("user plugin first") : next()) }
  ];
  const plugin = createLivePlugin({ frontendOrigins: ORIGINS, onReject: (rejection) => rejections.push(rejection) });
  plugin.configureServer({
    middlewares: {
      use: (fn) => stack.push({ route: "", handle: fn }),
      stack
    }
  });
  assert.equal(stack.length, 2);
  const server = http.createServer((req, res) => {
    const run = (index: number): void => {
      const layer = stack[index];
      if (layer === undefined) {
        downstream(req, res);
        return;
      }
      layer.handle(req, res, () => run(index + 1));
    };
    run(0);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return (server.address() as AddressInfo).port;
}

function request(port: number, rawPath: string, method = "GET", host?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: rawPath,
        method,
        agent: false,
        headers: { Host: host ?? `127.0.0.1:${String(port)}` }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") });
        });
      }
    );
    req.on("error", reject);
    req.end();
  });
}

test("the live plugin is a serve-only plugin with a post transformIndexHtml hook", () => {
  const plugin = createLivePlugin({ frontendOrigins: ORIGINS });
  assert.equal(plugin.name, LIVE_PLUGIN_NAME);
  assert.equal(plugin.apply, "serve");
  assert.equal(plugin.transformIndexHtml.order, "post");
  const html = '<!doctype html><html><head><script type="module" src="/@vite/client"></script></head></html>';
  assert.equal(
    plugin.transformIndexHtml.handler(html),
    html.replace("<head>", `<head>${liveInitScriptTag()}`),
    "the init script ends up before Vite's own injected scripts"
  );
});

test("the middleware runs first, answers 403 to a foreign Host and 405 to non-GET methods", async (t) => {
  const rejections: LiveRejection[] = [];
  let reached = 0;
  const port = await serve(t, rejections, (_req, res) => {
    reached += 1;
    res.end("ok");
  });
  const evil = await request(port, "/.prvision-harness/index.html", "GET", "evil.example");
  assert.equal(evil.status, 403);
  assert.equal(evil.body, "Forbidden host");
  assert.equal(evil.headers["content-security-policy"], buildLiveCsp(ORIGINS));
  const wrongPort = await request(port, "/", "GET", `127.0.0.1:${String(port + 1)}`);
  assert.equal(wrongPort.status, 403);
  const userPlugin = await request(port, "/user-plugin", "GET", "evil.example");
  assert.equal(userPlugin.status, 403, "user plugin middlewares run after the guard");
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS"]) {
    const response = await request(port, "/.prvision-harness/index.html", method);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, "GET, HEAD");
  }
  assert.equal(reached, 0, "nothing reached Vite");
  assert.deepEqual(
    rejections.map((rejection) => [rejection.reason, rejection.method, rejection.host]),
    [
      ["host", "GET", "evil.example"],
      ["host", "GET", `127.0.0.1:${String(port + 1)}`],
      ["host", "GET", "evil.example"],
      ["method", "POST", `127.0.0.1:${String(port)}`],
      ["method", "PUT", `127.0.0.1:${String(port)}`],
      ["method", "DELETE", `127.0.0.1:${String(port)}`],
      ["method", "OPTIONS", `127.0.0.1:${String(port)}`]
    ]
  );
});

test("allowed requests pass on with the live headers, which later setHeader or writeHead calls cannot replace", async (t) => {
  const port = await serve(t, [], (req, res) => {
    if (req.url === "/implicit") {
      res.setHeader("Cache-Control", "max-age=31536000,immutable");
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.end("implicit head");
      return;
    }
    res.writeHead(200, { "cache-control": "no-cache", "Content-Type": "text/javascript" });
    res.end("explicit head");
  });
  for (const [path, host] of [
    ["/implicit", `127.0.0.1:${String(port)}`],
    ["/explicit", `localhost:${String(port)}`]
  ] as const) {
    const response = await request(port, path, "GET", host);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers["content-security-policy"], buildLiveCsp(ORIGINS), path);
    assert.equal(response.headers["cache-control"], "no-store", path);
    assert.equal(response.headers["x-content-type-options"], "nosniff", path);
    assert.equal(response.headers["referrer-policy"], "no-referrer", path);
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin", path);
  }
  assert.equal((await request(port, "/explicit", "HEAD")).status, 200);
});
