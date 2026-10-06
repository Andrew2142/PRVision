// Type declarations for sample-angular-app-files.mjs (sheet 15 §5.9.2), so `npm run typecheck` covers tests that import it.

import type { FixtureBranch } from "./sample-app-files.mjs";

export type { FixtureBranch, FixtureCommit } from "./sample-app-files.mjs";

export const FIXTURE_VERSION: number;
export const APP_ROOT: "apps/web";
export const ANGULAR_PROJECT: "web";
export const PINNED_VERSIONS: {
  angular: string;
  angularCdk: string;
  angularCli: string;
  rxjs: string;
  zoneJs: string;
  tslib: string;
  typescript: string;
  tailwindcss: string;
  postcss: string;
  autoprefixer: string;
};
export const MAIN_FILES: Record<string, string>;
export const BRANCHES: FixtureBranch[];
export const BUILD_FAILURE_BRANCHES: string[];
