import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LIVE_ALLOWED_METHODS,
  buildLiveCsp,
  decideLiveRequest,
  isAllowedLiveHost,
  liveFrontendOrigins,
  livePageHeaders
} from "../../../backend/src/services/visualizations/pipeline/render/live/live-page-headers";

const ORIGINS = ["http://localhost:4210", "http://127.0.0.1:4210"];

test("liveFrontendOrigins returns FRONTEND_URL's origin and its loopback twin, in that order", () => {
  assert.deepEqual(liveFrontendOrigins("http://localhost:4210"), ORIGINS);
  assert.deepEqual(liveFrontendOrigins("http://127.0.0.1:4210/some/path"), [
    "http://127.0.0.1:4210",
    "http://localhost:4210"
  ]);
  assert.deepEqual(liveFrontendOrigins("https://review.example:8443"), ["https://review.example:8443"]);
});

test("the live CSP is exactly the 16 §12.5 policy with the frontend and its twin as frame ancestors", () => {
  assert.equal(
    buildLiveCsp(ORIGINS),
    "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; " +
      "worker-src 'none'; frame-ancestors http://localhost:4210 http://127.0.0.1:4210; base-uri 'self'; " +
      "form-action 'none'"
  );
});

test("frame-ancestors never takes a wildcard, a path or a non-http origin; none left → 'none'", () => {
  assert.match(
    buildLiveCsp(["*", "http://localhost:4210/x", "javascript:alert(1)", "http://localhost:4210"]),
    /frame-ancestors http:\/\/localhost:4210;/
  );
  assert.match(buildLiveCsp(["*"]), /frame-ancestors 'none';/);
});

test("every live response carries the CSP, nosniff, no-referrer, no-store and CORP same-origin", () => {
  assert.deepEqual(livePageHeaders(ORIGINS), {
    "Content-Security-Policy": buildLiveCsp(ORIGINS),
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Cross-Origin-Resource-Policy": "same-origin"
  });
});

test("the Host guard accepts exactly 127.0.0.1:<port> and localhost:<port>", () => {
  assert.equal(isAllowedLiveHost("127.0.0.1:51000", 51000), true);
  assert.equal(isAllowedLiveHost("localhost:51000", 51000), true);
  assert.equal(isAllowedLiveHost("LOCALHOST:51000", 51000), true);
  for (const host of ["evil.example", "evil.example:51000", "127.0.0.1", "127.0.0.1:51001", "[::1]:51000", ""]) {
    assert.equal(isAllowedLiveHost(host, 51000), false, host);
  }
  assert.equal(isAllowedLiveHost(undefined, 51000), false);
  assert.equal(isAllowedLiveHost("127.0.0.1:51000", undefined), false);
});

test("decideLiveRequest: Host guard 403 first, then GET/HEAD only (405)", () => {
  assert.deepEqual(LIVE_ALLOWED_METHODS, ["GET", "HEAD"]);
  assert.deepEqual(decideLiveRequest({ method: "GET", host: "127.0.0.1:5000", port: 5000 }), { ok: true });
  assert.deepEqual(decideLiveRequest({ method: "HEAD", host: "localhost:5000", port: 5000 }), { ok: true });
  assert.deepEqual(decideLiveRequest({ method: "POST", host: "evil.example", port: 5000 }), {
    ok: false,
    status: 403,
    reason: "host",
    message: "Forbidden host"
  });
  for (const method of ["POST", "PUT", "DELETE", "OPTIONS", "PATCH"]) {
    assert.deepEqual(decideLiveRequest({ method, host: "127.0.0.1:5000", port: 5000 }), {
      ok: false,
      status: 405,
      reason: "method",
      message: "Method not allowed"
    });
  }
});
