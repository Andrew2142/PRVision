import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DATA_DIR, IS_TEST, PRVISION_SECRET_KEY } from "../../../backend/src/config-consts";

const GUARD_MESSAGE = /\[network-guard\] .* blocked in tests/;

test("fetch to a non-loopback host throws the guard error", async () => {
  await assert.rejects(fetch("https://api.github.com/user"), { message: GUARD_MESSAGE });
});

test("fetch to 127.0.0.1 is allowed", async (t) => {
  const server = http.createServer((_req, res) => {
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await response.text(), "ok");
});

test("https.request to api.github.com throws", () => {
  assert.throws(() => https.request("https://api.github.com/user"), { message: GUARD_MESSAGE });
  assert.throws(() => https.request({ hostname: "api.github.com", path: "/user" }), { message: GUARD_MESSAGE });
  assert.throws(() => http.get({ host: "example.com:80", path: "/" }), { message: GUARD_MESSAGE });
});

test("DATA_DIR from config-consts is inside os.tmpdir()", () => {
  assert.ok(DATA_DIR.startsWith(fs.realpathSync(os.tmpdir()) + path.sep), DATA_DIR);
  assert.match(path.basename(DATA_DIR), /^prvision-test-session-/);
});

test("PRVISION_SECRET_KEY is the fixed test key", () => {
  assert.equal(PRVISION_SECRET_KEY, Buffer.alloc(32, 7).toString("base64"));
});

test("NODE_ENV is test and IS_TEST is true", () => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(IS_TEST, true);
});
