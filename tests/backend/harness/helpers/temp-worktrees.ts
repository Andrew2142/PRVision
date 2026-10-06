/**
 * Temporary base/head worktree folders with fixture files (09 §9). Lives under the test scratch dir
 * (`prvision-test-*`), removed in t.after.
 */
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import type { WorktreeSide } from "../../../../backend/src/types/visualization-pipeline";
import { makeTempDir } from "../../helpers/temp-dir";

export interface TempWorktrees {
  root: string;
  baseDir: string;
  headDir: string;
  /** Repo-relative files written per side. */
  files: Record<WorktreeSide, string[]>;
  write(side: WorktreeSide | "both", repoRelativePath: string, content: string): void;
  dirOf(side: WorktreeSide): string;
}

/** Creates `<tmp>/base` and `<tmp>/head`; cleaned up after the test. */
export function createTempWorktrees(t: TestContext): TempWorktrees {
  const temp = makeTempDir("harness");
  t.after(() => {
    temp.cleanup();
  });
  const baseDir = path.join(temp.path, "base");
  const headDir = path.join(temp.path, "head");
  fs.mkdirSync(baseDir, { recursive: true });
  fs.mkdirSync(headDir, { recursive: true });
  const files: Record<WorktreeSide, string[]> = { base: [], head: [] };
  const dirOf = (side: WorktreeSide): string => (side === "base" ? baseDir : headDir);
  return {
    root: temp.path,
    baseDir,
    headDir,
    files,
    dirOf,
    write(side, repoRelativePath, content) {
      for (const target of side === "both" ? (["base", "head"] as const) : [side]) {
        const file = path.join(dirOf(target), repoRelativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
        if (!files[target].includes(repoRelativePath)) {
          files[target].push(repoRelativePath);
        }
      }
    }
  };
}

/** Reads a file of tests/fixtures/harness/. */
export function harnessFixture(relativePath: string): string {
  return fs.readFileSync(path.join(__dirname, "../../../fixtures/harness", relativePath), "utf8");
}
