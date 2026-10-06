// Type declarations for sample-app-files.mjs (sheet 14 §5.10.3), so `npm run typecheck` covers tests that import it.

export interface FixtureCommit {
  message: string;
  files?: Record<string, string>;
  remove?: string[];
}

export interface FixtureBranch {
  name: string;
  from: string;
  commits: FixtureCommit[];
}

export const FIXTURE_VERSION: number;
export const MAIN_FILES: Record<string, string>;
export const BRANCHES: FixtureBranch[];
export const WORKING_TREE_EXTRAS: { modify: Record<string, string>; untracked: Record<string, string> };
