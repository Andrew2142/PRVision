import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createWorkspaceSourceQueries,
  reactSourceRoot
} from "../../../backend/src/services/harness-library/library-source-queries";
import { isAngularSourceQueries } from "../../../backend/src/types/angular-analysis";
import type { PipelineContext } from "../../../backend/src/types/visualization-pipeline";
import { reactViteFiles, withTempGitRepo } from "../helpers/temp-git-repo";

function context(
  dir: string,
  framework: "react_vite" | "angular"
): Pick<PipelineContext, "workspace" | "repository" | "libraryJob"> {
  return {
    workspace: {
      visualizationId: 0,
      repositoryPath: dir,
      baseDir: dir,
      headDir: dir,
      baseSha: "a".repeat(40),
      headSha: "a".repeat(40),
      sourceType: "local_branch",
      dependencyDrift: false
    },
    repository: {
      id: 1,
      localPath: dir,
      framework,
      appRoot: ".",
      angularProject: framework === "angular" ? "shop" : null,
      angularBuildConfiguration: null,
      viteConfigPath: framework === "angular" ? null : "vite.config.ts",
      tsconfigPath: "tsconfig.json",
      entryFilePath: null,
      globalStylePaths: []
    },
    libraryJob: { kind: "scan", libraryJobId: 3 }
  };
}

test("reactSourceRoot follows 08's rule", () => {
  assert.equal(reactSourceRoot("."), "src");
  assert.equal(reactSourceRoot("apps/web"), "apps/web/src");
});

test("scan source queries read the worktree on both sides without analysed rows", async (t) => {
  const repo = withTempGitRepo(t, {
    files: reactViteFiles({ "src/components/Card.tsx": "export function Card() {\n  return <div>Card</div>;\n}\n" })
  });
  const queries = await createWorkspaceSourceQueries(context(repo.path, "react_vite"));
  assert.equal(isAngularSourceQueries(queries), false);
  assert.deepEqual(await queries.componentPaths("src/components/Card.tsx"), {
    base: "src/components/Card.tsx",
    head: "src/components/Card.tsx"
  });
  assert.deepEqual(await queries.componentPaths("src/components/Missing.tsx"), { base: null, head: null });

  const angular = await createWorkspaceSourceQueries(context(repo.path, "angular"));
  assert.equal(isAngularSourceQueries(angular), true, "Angular repositories get 15b's queries");
});
