/**
 * Live mode against the fixture repo (16 §12, 16i): the real session job recreates the run's worktrees from its
 * commits, writes the run's harness, and starts real Vite live hosts per side when a card is opened. Both origins
 * serve the page with the live CSP and the init script; a foreign Host gets 403 and POST gets 405; the page renders
 * in Chromium with the screenshot clock. A stop (and a worker shutdown) leaves no Vite child, worktree or folder.
 * Gated on PRVISION_IT_RENDER=1 or PRVISION_INTEGRATION=1. The database is the in-memory QueryHandler.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { chromium } from "playwright";
import { FRONTEND_URL, RENDER_FIXED_TIME_ISO } from "../../../backend/src/config-consts";
import { Table } from "../../../backend/src/enums";
import { LiveSessionService } from "../../../backend/src/services/live/live-session-service";
import { LiveSessionWorkerService } from "../../../backend/src/services/live/live-session-worker-service";
import { LIVE_INIT_SCRIPT_ID } from "../../../backend/src/services/visualizations/pipeline/render/live/live-init-script";
import {
  buildLiveCsp,
  liveFrontendOrigins
} from "../../../backend/src/services/visualizations/pipeline/render/live/live-page-headers";
import type { LiveHostState } from "../../../backend/src/types/harness-library";
import { ArtifactStore, type QueryHandler } from "../../../backend/src/utilities";
import { ProjectDetectionService } from "../../../backend/src/services/repositories/project-detection-service";
import { targetImportStatement } from "../../../backend/src/services/visualizations/pipeline/harness-prompts";
import {
  ANGULAR_APP_ROOT,
  ANGULAR_PROJECT,
  angularFixtureHarness,
  cloneAngularFixture
} from "../integration/helpers/angular-fixture";
import { cloneFixture } from "../integration/helpers/fixture";
import { itSkip } from "../integration/helpers/it-flags";
import { makeComponentRow, makeRepositoryRow, makeVisualizationRow } from "../helpers/factories";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { isolatedGitEnv } from "../helpers/temp-git-repo";

const SKIP = itSkip("render");
const FRONTEND_ORIGINS = liveFrontendOrigins(FRONTEND_URL);
const BUTTON_HARNESS = `import { definePrvisionHarness } from "../harness-api";
import Target from "../../src/components/Button";
export default definePrvisionHarness({
  states: [
    { name: "Default", render: () => <Target>Save</Target> },
    { name: "Secondary", render: () => <Target variant="secondary">Cancel</Target> }
  ]
});
`;

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(origin: string, rawPath: string, method = "GET", host?: string): Promise<RawResponse> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: rawPath,
        method,
        agent: false,
        headers: { Host: host ?? url.host }
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

async function waitFor<T>(label: string, probe: () => T | null | Promise<T | null>, timeoutMs = 180_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Descendants of this test process (Vite live hosts, their esbuild/Tailwind workers), the `ps` call excluded. */
function viteChildren(): string[] {
  const out = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  const rows = out
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] ?? "" }));
  const tree = new Set([process.pid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
    }
  }
  return rows
    .filter((row) => row.pid !== process.pid && tree.has(row.pid) && !row.args.startsWith("ps "))
    .map((row) => `${String(row.pid)} ${row.args}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: isolatedGitEnv() }).trim();
}

interface Setup {
  clone: string;
  store: InMemoryQueryHandler;
  service: LiveSessionService;
  worker: LiveSessionWorkerService;
}

function setup(t: TestContext): Setup {
  const clone = cloneFixture(t);
  const store = new InMemoryQueryHandler();
  store.now = () => new Date();
  store.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1, localPath: clone })]);
  store.seed(Table.VISUALIZATIONS, [
    makeVisualizationRow({
      id: 1,
      status: "completed",
      completedAt: new Date(),
      baseSha: git(clone, ["rev-parse", "main"]),
      headSha: git(clone, ["rev-parse", "feature/button-restyle"])
    })
  ]);
  store.seed(Table.VISUALIZATION_COMPONENTS, [
    makeComponentRow({ id: 11, renderStatus: "rendered", harnessSource: BUTTON_HARNESS, harnessOrigin: "written" })
  ]);
  const queryHandler = store as unknown as QueryHandler;
  return {
    clone,
    store,
    service: new LiveSessionService({
      queryHandler,
      queue: {
        enqueueLiveSession: (id: number) => Promise.resolve({ jobId: `live-${String(id)}`, alreadyQueued: false })
      }
    }),
    worker: new LiveSessionWorkerService({ queryHandler })
  };
}

function hostsOf(s: Setup, sessionId: number): LiveHostState[] {
  return (s.store.row(Table.LIVE_SESSIONS, sessionId)?.hosts ?? []) as LiveHostState[];
}

async function startSession(
  s: Setup,
  signal: AbortSignal
): Promise<{ sessionId: number; running: Promise<string>; hosts: LiveHostState[] }> {
  const started = await s.service.start(1);
  assert.equal(started.status, 202, JSON.stringify(started));
  const sessionId = started.data?.id ?? 0;
  const running = s.worker.run({ liveSessionId: sessionId, jobId: `live-${String(sessionId)}`, signal });
  await waitFor("ready", () => {
    const row = s.store.row(Table.LIVE_SESSIONS, sessionId);
    if (row?.status === "failed") {
      throw new Error(`session failed: ${String(row.errorMessage)}`);
    }
    return row?.status === "ready" ? true : null;
  });
  const opened = await s.service.open(1, { componentId: 11, stateName: "Secondary" });
  assert.equal(opened.status, 202, JSON.stringify(opened));
  const hosts = await waitFor("both hosts", async () => {
    await s.service.heartbeat(1, { active: true });
    const list = hostsOf(s, sessionId);
    const failed = list.find((host) => host.status === "failed");
    if (failed) {
      throw new Error(`host failed: ${String(failed.error)}`);
    }
    return list.length === 2 && list.every((host) => host.status === "ready") ? list : null;
  });
  return { sessionId, running, hosts };
}

function assertReleased(s: Setup, sessionId: number): void {
  assert.deepEqual(viteChildren(), [], "no Vite live host survives");
  const liveRoot = path.join(new ArtifactStore().worktreesRoot(), `live-${String(sessionId)}`);
  assert.equal(fs.existsSync(liveRoot), false, "the live worktree folder is removed");
  const worktrees = git(s.clone, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
  assert.equal(worktrees.length, 1, `only the clone itself remains: ${worktrees.join(", ")}`);
  assert.equal(git(s.clone, ["status", "--porcelain"]), "", "the clone's working copy is untouched");
  assert.equal(git(s.clone, ["for-each-ref", "refs/prvision"]), "", "no PRVision ref is left");
}

test(
  "a live session serves both sides with the live CSP and guards, renders in Chromium, and stops cleanly",
  { skip: SKIP, timeout: 600_000 },
  async (t) => {
    const s = setup(t);
    const controller = new AbortController();
    const { sessionId, running, hosts } = await startSession(s, controller.signal);
    try {
      assert.deepEqual(
        hosts.map((host) => [host.side, host.componentIds, host.harnessUrlPath]),
        [
          ["base", [11], "/.prvision-harness/index.html"],
          ["head", [11], "/.prvision-harness/index.html"]
        ]
      );
      const origins = hosts.map((host) => host.origin ?? "");
      assert.ok(
        origins.every((origin) => /^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(origin)),
        origins.join(", ")
      );
      assert.notEqual(origins[0], origins[1], "independent origins per side");
      const query = `?c=11&s=Secondary&live=1&parent=${encodeURIComponent(FRONTEND_ORIGINS[0] ?? "")}`;
      for (const origin of origins) {
        const page = await request(origin, `/.prvision-harness/index.html${query}`);
        assert.equal(page.status, 200);
        assert.equal(page.headers["content-security-policy"], buildLiveCsp(FRONTEND_ORIGINS));
        assert.equal(page.headers["cache-control"], "no-store");
        assert.equal(page.headers["access-control-allow-origin"], undefined);
        assert.match(page.body, new RegExp(`<head>\\s*<script id="${LIVE_INIT_SCRIPT_ID}">`), "first child of <head>");
        const viaLocalhost = await request(
          origin,
          "/.prvision-harness/entry.tsx",
          "GET",
          `localhost:${new URL(origin).port}`
        );
        assert.equal(viaLocalhost.status, 200);
        assert.equal(viaLocalhost.headers["content-security-policy"], buildLiveCsp(FRONTEND_ORIGINS));
        const evil = await request(origin, "/.prvision-harness/index.html", "GET", "evil.example");
        assert.equal(evil.status, 403);
        const post = await request(origin, "/.prvision-harness/index.html", "POST");
        assert.equal(post.status, 405);
      }

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        for (const origin of origins) {
          await page.goto(`${origin}/.prvision-harness/index.html${query}`);
          await page.waitForFunction("window.__PRVISION_READY__ === true", null, { timeout: 60_000 });
          assert.equal(await page.locator("button", { hasText: "Cancel" }).count(), 1, "the Secondary state rendered");
          const now = await page.evaluate(() => Date.now());
          const start = Date.parse(RENDER_FIXED_TIME_ISO);
          assert.ok(
            now >= start && now < start + 120_000,
            `page clock starts at the fixed time (${String(now - start)} ms)`
          );
        }
      } finally {
        await browser.close();
      }

      assert.deepEqual(await s.service.stop(1, {}), { status: 200, data: { id: sessionId, status: "stopping" } });
      assert.equal(await running, "stopped");
      const row = s.store.row(Table.LIVE_SESSIONS, sessionId);
      assert.deepEqual([row?.status, row?.stopReason], ["stopped", "left"]);
      assertReleased(s, sessionId);
    } finally {
      controller.abort("shutdown");
      await running.catch(() => undefined);
    }
  }
);

test(
  "a worker shutdown stops a ready live session and releases its hosts and worktrees",
  { skip: SKIP, timeout: 600_000 },
  async (t) => {
    const s = setup(t);
    const controller = new AbortController();
    const { sessionId, running } = await startSession(s, controller.signal);
    controller.abort("shutdown");
    assert.equal(await running, "stopped");
    const row = s.store.row(Table.LIVE_SESSIONS, sessionId);
    assert.deepEqual([row?.status, row?.stopReason], ["stopped", "shutdown"]);
    assertReleased(s, sessionId);
  }
);

test(
  "an Angular live session builds the group per side and serves it with the live CSP, guards and init script",
  { skip: SKIP, timeout: 900_000 },
  async (t) => {
    const clone = cloneAngularFixture(t);
    const detected = await new ProjectDetectionService().detect(clone, {
      appRoot: ANGULAR_APP_ROOT,
      angularProject: ANGULAR_PROJECT
    });
    assert.ok(detected.ok, JSON.stringify(detected));
    const project = detected.project;
    const store = new InMemoryQueryHandler();
    store.now = () => new Date();
    store.seed(Table.REPOSITORIES, [
      makeRepositoryRow({
        id: 1,
        name: "sample-angular-monorepo",
        localPath: clone,
        framework: "angular",
        appRoot: project.appRoot,
        angularProject: project.angularProject,
        angularBuildConfiguration: project.angularBuildConfiguration,
        viteConfigPath: null,
        tsconfigPath: project.tsconfigPath,
        entryFilePath: project.entryFilePath,
        globalStylePaths: project.globalStylePaths
      })
    ]);
    store.seed(Table.VISUALIZATIONS, [
      makeVisualizationRow({
        id: 1,
        status: "completed",
        completedAt: new Date(),
        baseSha: git(clone, ["rev-parse", "main"]),
        headSha: git(clone, ["rev-parse", "feature/badge-restyle"])
      })
    ]);
    const filePath = `${ANGULAR_APP_ROOT}/src/app/shared/badge/badge.component.ts`;
    const statement = targetImportStatement(
      { filePath, exportName: "BadgeComponent", displayName: "BadgeComponent" },
      ANGULAR_APP_ROOT
    );
    store.seed(Table.VISUALIZATION_COMPONENTS, [
      makeComponentRow({
        id: 21,
        filePath,
        exportName: "BadgeComponent",
        displayName: "BadgeComponent",
        renderStatus: "rendered",
        harnessSource: angularFixtureHarness("BadgeComponent", statement, "").harnessSource,
        harnessOrigin: "written"
      })
    ]);
    const queryHandler = store as unknown as QueryHandler;
    const s: Setup = {
      clone,
      store,
      service: new LiveSessionService({
        queryHandler,
        queue: {
          enqueueLiveSession: (id: number) => Promise.resolve({ jobId: `live-${String(id)}`, alreadyQueued: false })
        }
      }),
      worker: new LiveSessionWorkerService({ queryHandler })
    };
    const controller = new AbortController();
    const started = await s.service.start(1);
    const sessionId = started.data?.id ?? 0;
    const running = s.worker.run({
      liveSessionId: sessionId,
      jobId: `live-${String(sessionId)}`,
      signal: controller.signal
    });
    try {
      await waitFor("ready", () => {
        const row = s.store.row(Table.LIVE_SESSIONS, sessionId);
        if (row?.status === "failed") {
          throw new Error(`session failed: ${String(row.errorMessage)}`);
        }
        return row?.status === "ready" ? true : null;
      });
      assert.equal((await s.service.open(1, { componentId: 21, stateName: "Default" })).status, 202);
      const hosts = await waitFor(
        "both Angular hosts",
        async () => {
          await s.service.heartbeat(1, { active: true });
          const list = hostsOf(s, sessionId);
          const failed = list.find((host) => host.status === "failed");
          if (failed) {
            throw new Error(`host failed: ${String(failed.error)}`);
          }
          return list.length === 2 && list.every((host) => host.status === "ready") ? list : null;
        },
        600_000
      );
      const query = `?c=21&s=Default&live=1&parent=${encodeURIComponent(FRONTEND_ORIGINS[0] ?? "")}`;
      const browser = await chromium.launch();
      try {
        const page = await browser.newPage();
        for (const host of hosts) {
          const origin = host.origin ?? "";
          assert.match(origin, /^http:\/\/127\.0\.0\.1:\d{1,5}$/);
          assert.equal(host.harnessUrlPath, "/index.html");
          const index = await request(origin, `/index.html${query}`);
          assert.equal(index.status, 200);
          assert.equal(index.headers["content-security-policy"], buildLiveCsp(FRONTEND_ORIGINS));
          assert.ok(index.body.includes(`<script id="${LIVE_INIT_SCRIPT_ID}">`));
          assert.equal((await request(origin, "/index.html", "GET", "evil.example")).status, 403);
          assert.equal((await request(origin, "/index.html", "POST")).status, 405);
          await page.goto(`${origin}/index.html${query}`);
          await page.waitForFunction("window.__PRVISION_READY__ === true", null, { timeout: 60_000 });
        }
      } finally {
        await browser.close();
      }
      await s.service.stop(1, { reason: "user" });
      assert.equal(await running, "stopped");
      assertReleased(s, sessionId);
    } finally {
      controller.abort("shutdown");
      await running.catch(() => undefined);
    }
  }
);
