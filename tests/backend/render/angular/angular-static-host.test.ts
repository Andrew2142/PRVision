import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  AngularStaticHost,
  mimeTypeFor,
  type AngularStaticHostHandle
} from "../../../../backend/src/services/visualizations/pipeline/render/angular/angular-static-host";
import { liveInitScriptTag } from "../../../../backend/src/services/visualizations/pipeline/render/live/live-init-script";
import { buildLiveCsp } from "../../../../backend/src/services/visualizations/pipeline/render/live/live-page-headers";
import { makeTempDir } from "../../helpers/temp-dir";

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Sends the path verbatim (no URL normalization by a client library). */
function request(origin: string, rawPath: string, method = "GET", host?: string): Promise<RawResponse> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const headers = host === undefined ? {} : { Host: host };
    const req = http.request(
      { host: url.hostname, port: url.port, path: rawPath, method, agent: false, headers },
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

async function startHost(t: TestContext): Promise<{ host: AngularStaticHostHandle; root: string; dist: string }> {
  const temp = makeTempDir("angular-static");
  const root = temp.path;
  const dist = path.join(root, "dist");
  fs.mkdirSync(path.join(dist, "media"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><prvision-root></prvision-root>");
  fs.writeFileSync(path.join(dist, "main.js"), "console.log(1);");
  fs.writeFileSync(path.join(dist, "styles.css"), "body{}");
  fs.writeFileSync(path.join(dist, "media", "font.woff2"), "w");
  fs.writeFileSync(path.join(dist, "data.bin"), "b");
  fs.writeFileSync(path.join(root, "secret.txt"), "outside");
  fs.symlinkSync(path.join(root, "secret.txt"), path.join(dist, "escape.txt"));
  const host = await AngularStaticHost.start({
    side: "head",
    groupKey: "none",
    distDir: dist,
    buildLogs: [{ level: "info", message: "Application bundle generation complete." }],
    tailwindMajor: 3,
    warnings: Array.from({ length: 12 }, (_, index) => `warning ${String(index)}`)
  });
  t.after(async () => {
    await host.stop();
    temp.cleanup();
  });
  return { host, root, dist };
}

test("AngularStaticHost.start binds 127.0.0.1 on an ephemeral port and exposes the host handle", async (t) => {
  const { host } = await startHost(t);
  assert.match(host.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(host.harnessUrlPath, "/index.html");
  assert.equal(host.side, "head");
  assert.equal(host.groupKey, "none");
  assert.equal(host.tailwindMajor, 3);
  assert.equal(host.warnings.length, 10);
  assert.equal(host.isAlive(), true);
  assert.equal(host.exitReason(), null);
  assert.equal(host.sawDepsReoptimizeSince(0), false);
  assert.equal(host.currentSeq(), 1);
});

test("AngularStaticHost serves files with MIME types, no-store and nosniff; / is the index", async (t) => {
  const { host } = await startHost(t);
  const index = await request(host.origin, "/");
  assert.equal(index.status, 200);
  assert.match(String(index.headers["content-type"]), /^text\/html/);
  assert.equal(index.headers["cache-control"], "no-store");
  assert.equal(index.headers["x-content-type-options"], "nosniff");
  assert.ok(index.body.includes("prvision-root"));
  assert.match(String((await request(host.origin, "/main.js?v=1")).headers["content-type"]), /^text\/javascript/);
  assert.match(String((await request(host.origin, "/styles.css")).headers["content-type"]), /^text\/css/);
  assert.equal((await request(host.origin, "/media/font.woff2")).headers["content-type"], "font/woff2");
  assert.equal((await request(host.origin, "/data.bin")).headers["content-type"], "application/octet-stream");
  const head = await request(host.origin, "/main.js", "HEAD");
  assert.equal(head.status, 200);
  assert.equal(head.body, "");
  assert.equal(mimeTypeFor("a.MJS"), "text/javascript; charset=utf-8");
  assert.equal(mimeTypeFor("a.svg"), "image/svg+xml");
});

test("AngularStaticHost answers 404 for traversal, encoded traversal, symlinks out of dist, directories and missing files", async (t) => {
  const { host } = await startHost(t);
  const seq = host.currentSeq();
  for (const rawPath of [
    "/../secret.txt",
    "/%2e%2e/secret.txt",
    "/media/%2E%2E/%2E%2E/secret.txt",
    "/escape.txt",
    "/media",
    "/nope.js",
    "/a%00b"
  ]) {
    const response = await request(host.origin, rawPath);
    assert.equal(response.status, 404, rawPath);
    assert.ok(!response.body.includes("outside"), rawPath);
  }
  const logged = host.logsSince(seq, "warn");
  assert.equal(logged.length, 7);
  assert.ok(logged.every((entry) => entry.level === "warn" && entry.message.endsWith(": HTTP 404")));
  assert.equal(host.logsSince(seq, "error").length, 0);
});

test("AngularStaticHost allows GET and HEAD only; stop() closes the server", async (t) => {
  const { host } = await startHost(t);
  const post = await request(host.origin, "/index.html", "POST");
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  await host.stop();
  await host.stop();
  assert.equal(host.isAlive(), false);
  assert.equal(host.exitReason(), "stopped");
  await assert.rejects(request(host.origin, "/"), /ECONNREFUSED/);
});

test("AngularStaticHost.start rejects a missing build folder", async () => {
  await assert.rejects(
    AngularStaticHost.start({ side: "base", groupKey: "none", distDir: "/nonexistent/prvision/dist" }),
    /ENOENT/
  );
});

// ----- 16i: live option (16 §12.4, §12.5) -----

const LIVE_ORIGINS = ["http://localhost:4210", "http://127.0.0.1:4210"];

async function startLiveHost(t: TestContext): Promise<AngularStaticHostHandle> {
  const temp = makeTempDir("angular-static-live");
  const dist = path.join(temp.path, "dist");
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(
    path.join(dist, "index.html"),
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>h</title></head><body><prvision-root></prvision-root></body></html>'
  );
  fs.writeFileSync(path.join(dist, "main.js"), "console.log(1);");
  const host = await AngularStaticHost.start({
    side: "base",
    groupKey: "g1",
    distDir: dist,
    live: { frontendOrigins: LIVE_ORIGINS }
  });
  t.after(async () => {
    await host.stop();
    temp.cleanup();
  });
  return host;
}

test("a live AngularStaticHost sends the live headers on every response and injects the init script first in <head>", async (t) => {
  const host = await startLiveHost(t);
  const port = new URL(host.origin).port;
  const index = await request(host.origin, "/index.html?c=1&s=Default&live=1", "GET", `127.0.0.1:${port}`);
  assert.equal(index.status, 200);
  assert.ok(index.body.includes(`<head>${liveInitScriptTag()}<meta charset="utf-8">`), "first child of <head>");
  assert.equal(index.headers["content-length"], String(Buffer.byteLength(index.body)));
  for (const response of [
    index,
    await request(host.origin, "/main.js", "GET", `localhost:${port}`),
    await request(host.origin, "/missing.js", "GET", `127.0.0.1:${port}`)
  ]) {
    assert.equal(response.headers["content-security-policy"], buildLiveCsp(LIVE_ORIGINS));
    assert.equal(response.headers["cache-control"], "no-store");
    assert.equal(response.headers["x-content-type-options"], "nosniff");
    assert.equal(response.headers["referrer-policy"], "no-referrer");
    assert.equal(response.headers["cross-origin-resource-policy"], "same-origin");
  }
  const script = await request(host.origin, "/main.js", "GET", `127.0.0.1:${port}`);
  assert.equal(script.body, "console.log(1);", "only HTML gets the script");
});

test("a live AngularStaticHost answers 403 to a foreign Host and 405 to non-GET methods", async (t) => {
  const host = await startLiveHost(t);
  const port = new URL(host.origin).port;
  const evil = await request(host.origin, "/index.html", "GET", "evil.example");
  assert.equal(evil.status, 403);
  assert.equal(evil.body, "Forbidden host");
  assert.equal(evil.headers["content-security-policy"], buildLiveCsp(LIVE_ORIGINS));
  assert.equal((await request(host.origin, "/index.html", "GET", `evil.example:${port}`)).status, 403);
  const post = await request(host.origin, "/index.html", "POST", `127.0.0.1:${port}`);
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, "GET, HEAD");
  assert.equal((await request(host.origin, "/index.html", "HEAD", `127.0.0.1:${port}`)).status, 200);
});

test("a screenshot AngularStaticHost (no live option) keeps its old behaviour: no CSP, no script", async (t) => {
  const { host } = await startHost(t);
  const index = await request(host.origin, "/", "GET", "evil.example");
  assert.equal(index.status, 200);
  assert.equal(index.headers["content-security-policy"], undefined);
  assert.ok(!index.body.includes("prvision-live-init"));
});
