/**
 * Locating and cloning the sample-react-app fixture (sheet 14 §5.8, §5.10). The fixture lives in the developer's
 * REAL data dir (setup.ts records it in PRVISION_REAL_DATA_DIR before isolating PRVISION_DATA_DIR).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { makeTempDir } from "../../helpers/temp-dir";
import { isolatedGitEnv } from "../../helpers/temp-git-repo";

export const FIXTURE_BRANCHES = [
  "main",
  "feature/button-restyle",
  "qa/render-failure",
  "qa/no-visual-change",
  "qa/css-module-only",
  "qa/dependency-drift",
  "qa/replaced-component"
] as const;

/** <real data dir>/fixtures/sample-react-app. */
export function fixturePath(): string {
  return path.join(process.env.PRVISION_REAL_DATA_DIR!, "fixtures", "sample-react-app");
}

/** Throws a helpful error if the fixture is missing or not installed (flag on ⇒ the developer wants these to run). */
export function requireFixtureRepo(): string {
  const root = fixturePath();
  if (!fs.existsSync(path.join(root, ".git", "prvision-fixture.json"))) {
    throw new Error(
      `Fixture repo missing at ${root}. Run: npm run fixture:create (node tools/create-fixture-repo.mjs)`
    );
  }
  if (!fs.existsSync(path.join(root, "node_modules", "vite", "package.json"))) {
    throw new Error(
      "Fixture dependencies missing. Run: npm run fixture:create (node tools/create-fixture-repo.mjs; it re-runs only the install)"
    );
  }
  return root;
}

/** Clones the fixture into a temp dir with all branches local and node_modules symlinked. Never mutates the shared fixture. */
export function cloneFixture(t: TestContext): string {
  const source = requireFixtureRepo();
  const temp = makeTempDir("it-clone");
  const target = path.join(temp.path, "sample-react-app");
  const env = isolatedGitEnv();
  execFileSync("git", ["clone", "--quiet", "--no-hardlinks", source, target], { env });
  for (const branch of FIXTURE_BRANCHES.filter((b) => b !== "main")) {
    execFileSync("git", ["-C", target, "branch", "--quiet", branch, `origin/${branch}`], { env });
  }
  execFileSync("git", ["-C", target, "remote", "remove", "origin"], { env });
  fs.symlinkSync(path.join(source, "node_modules"), path.join(target, "node_modules"), "dir");
  t.after(() => {
    temp.cleanup();
  });
  return target;
}
