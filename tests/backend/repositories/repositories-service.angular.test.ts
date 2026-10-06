/**
 * RepositoriesService with app roots and Angular projects (15 §5.4.5): selection pass-through, uniqueness per
 * (localPath, appRoot, angularProject), detect-apps registration ids, redetect with the stored app, cache removal.
 */
import "reflect-metadata";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Table } from "../../../backend/src/enums";
import { RepositoryModel } from "../../../backend/src/models";
import type {
  AppCandidate,
  AppDiscoveryResult,
  AppSelection,
  DetectedProject,
  DetectionResult
} from "../../../backend/src/services/repositories/project-detection-service";
import {
  RepositoriesService,
  type RepositoriesServiceDependencies
} from "../../../backend/src/services/repositories/repositories-service";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";
import { ArtifactStore } from "../../../backend/src/utilities/services/artifact-store";
import { idModel, makeRepositoryRow } from "../helpers/factories";
import { InMemoryQueryHandler } from "../helpers/query-handler-stub";
import { useTempDataDir } from "../helpers/temp-dir";
import { runWithAuthContext } from "../helpers/test-context";
import { fakeGit } from "./helpers/detection-fixture";

const NOW = new Date("2026-10-04T10:00:00.000Z");
const ROOT = "/srv/repos/acme";

function angularProject(appRoot: string, project: string): DetectedProject {
  return {
    rootPath: ROOT,
    suggestedName: `acme · ${project}`,
    githubOwner: "acme",
    githubRepo: "acme",
    githubRemoteName: "origin",
    defaultBranch: "staging",
    framework: "angular",
    packageManager: "npm",
    appRoot,
    angularProject: project,
    angularBuildConfiguration: "development",
    viteConfigPath: null,
    tsconfigPath: `${appRoot}/tsconfig.app.json`,
    entryFilePath: `${appRoot}/src/main.ts`,
    globalStylePaths: [`/${appRoot}/src/styles.css`],
    warnings: []
  };
}

function candidate(appRoot: string, project: string | null, supported = true): AppCandidate {
  return {
    appRoot,
    framework: project === null ? "react_vite" : "angular",
    angularProject: project,
    suggestedName: project ?? "site",
    supported,
    reason: supported ? null : "React apps in sub-folders are not supported yet."
  };
}

interface Harness {
  stub: InMemoryQueryHandler;
  detectCalls: Array<{ inputPath: string; selection: AppSelection | undefined }>;
  service(payload: RepositoryModel, deps?: Partial<RepositoriesServiceDependencies>): RepositoriesService;
}

/** The fake detector answers each selection with the matching Angular project. */
function harness(options: { discovery?: AppDiscoveryResult; detection?: DetectionResult } = {}): Harness {
  const stub = new InMemoryQueryHandler();
  const detectCalls: Harness["detectCalls"] = [];
  const defaults: Partial<RepositoriesServiceDependencies> = {
    queryHandler: stub as unknown as QueryHandler,
    detector: {
      detect: (inputPath: string, selection?: AppSelection) => {
        detectCalls.push({ inputPath, selection });
        return Promise.resolve(
          options.detection ?? {
            ok: true,
            project: angularProject(
              selection?.appRoot ?? "src/tenant-frontend",
              selection?.angularProject ?? "tenant-frontend"
            )
          }
        );
      }
    },
    discoverer: {
      discoverApps: () =>
        Promise.resolve(
          options.discovery ?? {
            ok: true,
            discovery: { rootPath: ROOT, hint: null, apps: [], warnings: [] }
          }
        )
    },
    git: fakeGit(),
    readGithubToken: () => Promise.resolve({ state: "absent" }),
    githubClientFactory: () => {
      throw new Error("githubClientFactory not stubbed");
    },
    now: () => NOW
  };
  return {
    stub,
    detectCalls,
    service: (payload, deps = {}) => new RepositoriesService(payload, { ...defaults, ...deps })
  };
}

function createPayload(localPath: string, selection: AppSelection = {}): RepositoryModel {
  const model = new RepositoryModel();
  model.setLocalPath(localPath);
  if (selection.appRoot !== undefined) {
    model.setAppRoot(selection.appRoot);
  }
  if (selection.angularProject !== undefined) {
    model.setAngularProject(selection.angularProject);
  }
  return model;
}

const call = <T>(fn: () => Promise<T>): Promise<T> => runWithAuthContext(fn);

test("create passes appRoot/angularProject to detection and stores the app fields", async () => {
  const h = harness();
  const response = await call(() =>
    h.service(createPayload(ROOT, { appRoot: "src/tenant-frontend", angularProject: "tenant-frontend" })).create()
  );
  assert.equal(response.status, 201);
  assert.deepEqual(h.detectCalls, [
    { inputPath: ROOT, selection: { appRoot: "src/tenant-frontend", angularProject: "tenant-frontend" } }
  ]);
  assert.equal(response.data?.name, "acme · tenant-frontend");
  assert.equal(response.data.framework, "angular");
  assert.equal(response.data.appRoot, "src/tenant-frontend");
  assert.equal(response.data.angularProject, "tenant-frontend");
  assert.equal(response.data.angularBuildConfiguration, "development");
  assert.equal(response.data.viteConfigPath, null);
  const row = h.stub.row(Table.REPOSITORIES, 1);
  assert.equal(row?.appRoot, "src/tenant-frontend");
  assert.equal(row.angularProject, "tenant-frontend");
});

test("create without appRoot/angularProject passes no selection (React and auto-choice path)", async () => {
  const h = harness();
  await call(() => h.service(createPayload(ROOT)).create());
  assert.deepEqual(h.detectCalls, [{ inputPath: ROOT, selection: undefined }]);
});

test("create returns 409 for the same (localPath, appRoot, angularProject); two apps of one clone coexist", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({
      id: 4,
      name: "Tenant",
      localPath: ROOT,
      framework: "angular",
      appRoot: "src/tenant-frontend",
      angularProject: "tenant-frontend",
      viteConfigPath: null
    })
  ]);
  const duplicate = await call(() =>
    h.service(createPayload(ROOT, { appRoot: "src/tenant-frontend", angularProject: "tenant-frontend" })).create()
  );
  assert.deepEqual(duplicate, {
    status: 409,
    error: 'This app is already registered as "Tenant" (id 4)',
    error_reason: "conflict"
  });
  assert.equal(h.stub.callsFor("insert").length, 0);

  const other = await call(() =>
    h.service(createPayload(ROOT, { appRoot: "src/core-frontend", angularProject: "core-frontend" })).create()
  );
  assert.equal(other.status, 201);
  assert.equal(other.data?.appRoot, "src/core-frontend");
  assert.equal(other.data.localPath, ROOT);
});

test("detectApps marks registered apps with their repository id", async () => {
  const h = harness({
    discovery: {
      ok: true,
      discovery: {
        rootPath: ROOT,
        hint: "src/tenant-frontend",
        apps: [
          candidate("src/tenant-frontend", "tenant-frontend"),
          candidate("src/core-frontend", "core-frontend"),
          candidate("src/site", null, false)
        ],
        warnings: []
      }
    }
  });
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({
      id: 7,
      localPath: ROOT,
      framework: "angular",
      appRoot: "src/core-frontend",
      angularProject: "core-frontend",
      viteConfigPath: null
    }),
    makeRepositoryRow({
      id: 8,
      localPath: ROOT,
      framework: "angular",
      appRoot: "src/tenant-frontend",
      angularProject: "tenant-frontend",
      isDeleted: true
    })
  ]);
  const response = await call(() => h.service(createPayload(`${ROOT}/src/tenant-frontend`)).detectApps());
  assert.equal(response.status, 200);
  assert.equal(response.data?.rootPath, ROOT);
  assert.equal(response.data.hint, "src/tenant-frontend");
  assert.deepEqual(
    response.data.apps.map((app) => [app.appRoot, app.repositoryId]),
    [
      ["src/tenant-frontend", null],
      ["src/core-frontend", 7],
      ["src/site", null]
    ]
  );
  assert.equal(response.data.apps[2]?.reason, "React apps in sub-folders are not supported yet.");
});

test("detectApps returns the discovery failure unchanged", async () => {
  const h = harness({
    discovery: {
      ok: false,
      failure: { status: 400, errorReason: "not_git_repo", message: "Not a git repository: /x" }
    }
  });
  const response = await call(() => h.service(createPayload("/x")).detectApps());
  assert.deepEqual(response, { status: 400, error: "Not a git repository: /x", error_reason: "not_git_repo" });
});

test("redetect re-reads the stored app; a vanished project leaves the row unchanged", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({
      id: 3,
      localPath: ROOT,
      framework: "angular",
      appRoot: "src/tenant-frontend",
      angularProject: "tenant-frontend",
      viteConfigPath: null
    })
  ]);
  const ok = await call(() => h.service(idModel(3)).redetect());
  assert.equal(ok.status, 200);
  assert.deepEqual(h.detectCalls.at(-1), {
    inputPath: ROOT,
    selection: { appRoot: "src/tenant-frontend", angularProject: "tenant-frontend" }
  });

  const gone = harness({
    detection: {
      ok: false,
      failure: {
        status: 400,
        errorReason: "unsupported_framework",
        message: "Project tenant-frontend no longer exists in src/tenant-frontend/angular.json"
      }
    }
  });
  gone.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({
      id: 3,
      localPath: ROOT,
      framework: "angular",
      appRoot: "src/tenant-frontend",
      angularProject: "tenant-frontend",
      viteConfigPath: null
    })
  ]);
  const failed = await call(() => gone.service(idModel(3)).redetect());
  assert.equal(failed.status, 400);
  assert.equal(failed.error_reason, "unsupported_framework");
  assert.equal(gone.stub.callsFor("update").length, 0);
});

test("redetect of a React row passes the root selection", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 2, localPath: "/srv/repos/web" })]);
  await call(() => h.service(idModel(2)).redetect());
  assert.deepEqual(h.detectCalls, [{ inputPath: "/srv/repos/web", selection: { appRoot: "." } }]);
});

test("remove deletes <dataDir>/cache/angular/<id> and nothing else", async (t: TestContext) => {
  const dataDir = useTempDataDir(t);
  const cacheDir = path.join(dataDir, "cache", "angular", "5");
  const otherCache = path.join(dataDir, "cache", "angular", "6");
  fs.mkdirSync(path.join(cacheDir, "nested"), { recursive: true });
  fs.writeFileSync(path.join(cacheDir, "nested", "entry.bin"), "x");
  fs.mkdirSync(otherCache, { recursive: true });

  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [
    makeRepositoryRow({
      id: 5,
      localPath: ROOT,
      framework: "angular",
      appRoot: "src/tenant-frontend",
      angularProject: "tenant-frontend",
      viteConfigPath: null
    })
  ]);
  const response = await call(() => h.service(idModel(5), { artifacts: new ArtifactStore(dataDir) }).remove());
  assert.deepEqual(response, { status: 200, data: { id: 5 } });
  assert.equal(fs.existsSync(cacheDir), false);
  assert.equal(fs.existsSync(otherCache), true);
});

test("remove still succeeds when the cache dir cannot be resolved (best effort)", async () => {
  const h = harness();
  h.stub.seed(Table.REPOSITORIES, [makeRepositoryRow({ id: 1 })]);
  const response = await call(() =>
    h
      .service(idModel(1), {
        artifacts: {
          resolveSafe: () => {
            throw new Error("Path resolves outside the data dir");
          }
        }
      })
      .remove()
  );
  assert.deepEqual(response, { status: 200, data: { id: 1 } });
});
