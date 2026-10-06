/**
 * Angular change analysis over every branch of the sample-angular-monorepo fixture (15 §5.9.3
 * "angular-analysis", §5.9.2 branch table): real git (a clone, detached worktrees of the merge-base and the branch
 * head), the real GitClient, the real ProjectDetectionService for the repository fields, and 15b's
 * AngularChangeAnalysisService with stub persistence (no database). Asserts kinds, reasons, ranks and counts.
 *
 * Gated on PRVISION_IT_RENDER=1 or PRVISION_INTEGRATION=1 (15 §5.9.3: analysis runs with the render flag too).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { ProjectDetectionService } from "../../../backend/src/services/repositories/project-detection-service";
import { AngularChangeAnalysisService } from "../../../backend/src/services/visualizations/pipeline/angular/angular-change-analysis-service";
import type { ChangeAnalysisResult, PipelineContext } from "../../../backend/src/types/visualization-pipeline";
import { isolatedGitEnv } from "../helpers/temp-git-repo";
import { makeTempDir } from "../helpers/temp-dir";
import { makeContext, stubPersistence } from "../pipeline/change-analysis/helpers/worktree-fixture";
import {
  ANGULAR_APP_ROOT,
  ANGULAR_PROJECT,
  requireAngularFixtureRepo,
  type AngularFixtureBranch
} from "./helpers/angular-fixture";
import { itSkip } from "./helpers/it-flags";

const SKIP = itSkip("render");
const web = (relative: string): string => `${ANGULAR_APP_ROOT}/${relative}`;

interface Row {
  displayName: string;
  changeKind: string;
  reason: string;
  rank: number;
}

/**
 * 15 §5.9.2 analysis column on the fixture's component graph (15f build note). qa/replaced-component (00 §17) is
 * analysed per its last commit in its own test below.
 */
const EXPECTED: Record<Exclude<AngularFixtureBranch, "main" | "qa/replaced-component">, Row[]> = {
  "feature/badge-restyle": [
    {
      displayName: "BadgeComponent",
      changeKind: "modified",
      reason: `Template changed: ${web("src/app/shared/badge/badge.component.html")}`,
      rank: 0
    },
    {
      displayName: "OrderListComponent",
      changeKind: "affected_parent",
      reason: "Uses changed component BadgeComponent (app-badge) in its template",
      rank: 1
    }
  ],
  "qa/service-change": [
    {
      displayName: "OrderListComponent",
      changeKind: "affected_parent",
      reason: `Injects changed service ${web("src/app/orders/orders.service.ts")}`,
      rank: 0
    }
  ],
  "qa/template-formatting": [],
  "qa/signal-inputs": [
    { displayName: "SignalCardComponent", changeKind: "modified", reason: "Component code changed", rank: 0 }
  ],
  "qa/ngmodule-chip": [
    { displayName: "LegacyChipComponent", changeKind: "modified", reason: "Component code changed", rank: 0 },
    {
      displayName: "NotificationBellComponent",
      changeKind: "affected_parent",
      reason: "Uses changed component LegacyChipComponent (app-legacy-chip) in its template",
      rank: 1
    }
  ],
  "qa/build-error": [
    {
      displayName: "OrderListComponent",
      changeKind: "modified",
      reason: `Template changed: ${web("src/app/orders/order-list/order-list.component.html")}`,
      rank: 0
    }
  ],
  "qa/render-failure": [
    { displayName: "BadgeComponent", changeKind: "modified", reason: "Component code changed", rank: 0 },
    {
      displayName: "OrderListComponent",
      changeKind: "affected_parent",
      reason: "Uses changed component BadgeComponent (app-badge) in its template",
      rank: 1
    }
  ],
  // Representatives by template usage (BadgeComponent and LegacyChipComponent have one usage each; the tie is
  // broken by path), then the components without usages by path.
  "qa/global-style": [
    "BadgeComponent",
    "LegacyChipComponent",
    "AppComponent",
    "NotificationBellComponent",
    "OrderListComponent",
    "SignalCardComponent"
  ].map((displayName, rank) => ({
    displayName,
    changeKind: "affected_parent",
    reason: `Global stylesheet changed: ${web("src/styles.css")}`,
    rank
  }))
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { env: isolatedGitEnv(), encoding: "utf8" }).trim();
}

describe("Angular change analysis on the fixture branches (real git and worktrees)", { skip: SKIP }, () => {
  let clone = "";
  let tempRoot = "";
  let repository: Partial<PipelineContext["repository"]> = {};
  let cleanup: () => void = () => undefined;

  after(() => {
    cleanup();
  });

  before(async () => {
    const source = requireAngularFixtureRepo();
    const temp = makeTempDir("it-angular-analysis");
    cleanup = temp.cleanup;
    tempRoot = temp.path;
    clone = path.join(tempRoot, "clone");
    execFileSync("git", ["clone", "--quiet", "--no-hardlinks", source, clone], { env: isolatedGitEnv() });
    for (const branch of [...Object.keys(EXPECTED), "qa/replaced-component"]) {
      git(clone, ["branch", "--quiet", branch, `origin/${branch}`]);
    }
    fs.symlinkSync(
      path.join(source, ANGULAR_APP_ROOT, "node_modules"),
      path.join(clone, ANGULAR_APP_ROOT, "node_modules"),
      "dir"
    );
    const detected = await new ProjectDetectionService().detect(clone, {
      appRoot: ANGULAR_APP_ROOT,
      angularProject: ANGULAR_PROJECT
    });
    assert.ok(detected.ok, `detection: ${JSON.stringify(detected)}`);
    const project = detected.project;
    assert.equal(project.framework, "angular");
    assert.equal(project.tsconfigPath, web("tsconfig.app.json"));
    assert.equal(project.entryFilePath, web("src/main.ts"));
    repository = {
      localPath: clone,
      framework: "angular",
      appRoot: project.appRoot,
      angularProject: project.angularProject,
      angularBuildConfiguration: project.angularBuildConfiguration,
      viteConfigPath: null,
      tsconfigPath: project.tsconfigPath,
      entryFilePath: project.entryFilePath,
      globalStylePaths: project.globalStylePaths
    };
  });

  /** `baseRef` defaults to the merge-base with main; `<branch>~1` analyses the branch's last commit only. */
  async function analyze(
    branch: AngularFixtureBranch,
    baseRef?: string
  ): Promise<{
    result: ChangeAnalysisResult;
    console: Array<{ level: string; message: string }>;
    inserted: number;
  }> {
    const baseSha =
      baseRef === undefined ? git(clone, ["merge-base", "main", branch]) : git(clone, ["rev-parse", baseRef]);
    const headSha = git(clone, ["rev-parse", branch]);
    const dir = path.join(tempRoot, `${branch.replace(/\//g, "-")}${baseRef === undefined ? "" : "-last"}`);
    const baseDir = path.join(dir, "base");
    const headDir = path.join(dir, "head");
    git(clone, ["worktree", "add", "--quiet", "--detach", baseDir, baseSha]);
    git(clone, ["worktree", "add", "--quiet", "--detach", headDir, headSha]);
    try {
      const ctx = makeContext({ repositoryPath: clone, baseDir, headDir, baseSha, headSha }, repository);
      const persistence = stubPersistence();
      const result = await new AngularChangeAnalysisService({
        runInTransaction: persistence.runInTransaction,
        createQueryHandler: persistence.createQueryHandler
      }).analyze(ctx);
      return {
        result,
        console: ctx.consoleEvents,
        inserted: persistence.inserted.reduce((sum, rows) => sum + rows.length, 0)
      };
    } finally {
      git(clone, ["worktree", "remove", "--force", baseDir]);
      git(clone, ["worktree", "remove", "--force", headDir]);
    }
  }

  for (const [branch, expected] of Object.entries(EXPECTED) as Array<
    [Exclude<AngularFixtureBranch, "main" | "qa/replaced-component">, Row[]]
  >) {
    test(`${branch}: ${expected.length === 0 ? "no candidates" : expected.map((r) => r.displayName).join(", ")}`, async () => {
      const { result, console: events, inserted } = await analyze(branch);
      const dump = events.map((e) => `[${e.level}] ${e.message}`).join("\n");
      assert.deepEqual(
        result.candidates.map((c) => ({
          displayName: c.displayName,
          changeKind: c.changeKind,
          reason: c.reason,
          rank: c.rank
        })),
        expected,
        dump
      );
      assert.deepEqual(result.skipped, [], dump);
      assert.equal(inserted, expected.length, "componentCount rows persisted");
      for (const candidate of result.candidates) {
        assert.equal(candidate.exportName, candidate.displayName, "export = class name");
        assert.match(candidate.filePath, /^apps\/web\/src\/app\/.+\.ts$/);
        if (candidate.changeKind === "affected_parent") {
          assert.equal(candidate.codeDiff, null, `${candidate.displayName} has no code diff`);
        } else {
          assert.match(String(candidate.codeDiff), /^diff --git /, `${candidate.displayName} code diff`);
        }
      }
      assert.ok(
        events.some((e) =>
          /^Angular workspace apps\/web, project web: 6 components indexed on head \(6 templates\)\.$/.test(e.message)
        ),
        dump
      );
      if (branch === "qa/global-style") {
        assert.ok(
          events.some((e) => e.message === "Global change: showing 6 widely used components."),
          dump
        );
      }
      assert.equal(git(clone, ["status", "--porcelain"]), "", "clone untouched");
    });
  }

  test("qa/replaced-component (last commit): OrderNoteFormComponent → OrderNoteFormModalComponent is one replaced row (00 §17)", async () => {
    const { result, console: events } = await analyze("qa/replaced-component", "qa/replaced-component~1");
    const dump = events.map((e) => `[${e.level}] ${e.message}`).join("\n");
    assert.deepEqual(
      result.candidates.map((c) => ({
        displayName: c.displayName,
        changeKind: c.changeKind,
        reason: c.reason,
        rank: c.rank
      })),
      [
        {
          displayName: "OrderNoteFormModalComponent",
          changeKind: "replaced",
          reason:
            "Replaced by OrderNoteFormModalComponent (call site swap in order-list, similar name, similar markup)",
          rank: 0
        },
        { displayName: "OrderListComponent", changeKind: "modified", reason: "Component code changed", rank: 1 }
      ],
      dump
    );
    const replaced = result.candidates[0];
    assert.deepEqual(
      replaced?.predecessor?.evidence.map((item) => item.kind),
      ["call_site_swap", "name_similarity", "content_similarity"]
    );
    assert.equal(replaced.predecessor.filePath, web("src/app/orders/order-note-form/order-note-form.component.ts"));
    assert.match(
      String(replaced.codeDiff),
      /^diff --git a\/apps\/web\/src\/app\/orders\/order-note-form\/order-note-form\.component\.ts b\//
    );
    assert.equal(git(clone, ["status", "--porcelain"]), "", "clone untouched");
  });
});
