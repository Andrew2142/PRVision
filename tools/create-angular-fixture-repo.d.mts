// Type declarations for create-angular-fixture-repo.mjs, so tests can import parseArgs/resolveDataDir (sheet 15 §5.9.2, §9.6).

export interface FixtureOptions {
  force: boolean;
  reset: boolean;
  skipInstall: boolean;
  dataDir: string | null;
  pm: "npm" | "pnpm" | "yarn";
  help: boolean;
}

/** Parses CLI arguments; throws (exit code 1) on unknown or conflicting arguments. */
export function parseArgs(argv: readonly string[]): FixtureOptions;

/** --data-dir value, else PRVISION_DATA_DIR, else ~/.prvision; expands a leading "~" and resolves to an absolute path. */
export function resolveDataDir(flagValue: string | null | undefined): string;

/** Runs the CLI; resolves with the exit code. */
export function main(argv?: readonly string[]): Promise<number>;
