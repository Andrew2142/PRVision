/**
 * Real throw-away git repos for sheet 07's integration tests (07 §4). A thin layer over sheet 14's shared
 * sandbox (tests/backend/helpers/temp-git-repo.ts; 14 §5.4.6), so there is one implementation of repo setup and
 * isolation. Test code may call git directly (execFileSync); application code never does.
 */
import { execFileSync } from "node:child_process";
import type { TestContext } from "node:test";
import { reactViteFiles, withTempGitRepo, type TempGitRepo } from "../../helpers/temp-git-repo";

export { createTempGitRepo, withTempGitRepo, type TempGitRepo } from "../../helpers/temp-git-repo";

/** True when a git binary is available (integration tests skip otherwise). */
export function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * A small React + Vite clone with `main` and a `feature/restyle` branch that changes one component, a package.json
 * dependency and adds a file; `main` gets one more commit after the branch point (so the merge-base differs from
 * the main tip). Leaves `main` checked out.
 */
export function createBranchRepo(t: TestContext): {
  repo: TempGitRepo;
  mainTip: string;
  branchPoint: string;
  featureTip: string;
} {
  const repo = withTempGitRepo(t, {
    files: reactViteFiles({
      "src/components/Button.tsx": "export default function Button() { return <button>A</button>; }\n"
    })
  });
  const branchPoint = repo.sha();
  repo.branch("feature/restyle");
  const featureTip = repo.commit("restyle", {
    "src/components/Button.tsx": 'export default function Button() { return <button className="b">B</button>; }\n',
    "src/components/Badge.tsx": "export const Badge = () => <span>new</span>;\n"
  });
  repo.checkout("main");
  const mainTip = repo.commit("unrelated", { "README.md": "# readme\n" });
  return { repo, mainTip, branchPoint, featureTip };
}
