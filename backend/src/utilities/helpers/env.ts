import path from "node:path";
import { config } from "dotenv";

/**
 * Loads the repository-root `.env` once, at first import. Values already present in `process.env` win
 * (override: false), so shell exports take precedence. Skipped under NODE_ENV=test: tests are hermetic and get
 * every value from the preload tests/backend/helpers/setup.ts (00 §14.10).
 * Path is identical from src/ (ts-node) and dist/ (compiled): both sit 4 levels below the repo root.
 */
if (process.env.NODE_ENV !== "test") {
  config({
    path: path.resolve(__dirname, "../../../../.env"),
    override: false,
    quiet: true
  });
}

export interface EnvOptions {
  trim?: boolean;
  allowEmpty?: boolean;
}

function readEnv(name: string, options: EnvOptions = {}): string | undefined {
  const raw = process.env[name];
  if (raw === undefined) {
    return undefined;
  }

  const value = options.trim === false ? raw : raw.trim();
  if (options.allowEmpty !== true && value.length === 0) {
    return undefined;
  }

  return value;
}

/** Returns the variable, or undefined when unset or blank. Never throws. */
export function optionalEnv(name: string, options: EnvOptions = {}): string | undefined {
  return readEnv(name, options);
}

/**
 * Returns the variable as an integer, undefined when unset or blank, and NaN when it is not a safe integer.
 * Never throws: validateConfig() (04) reports NaN with the variable name.
 */
export function optionalIntegerEnv(name: string): number | undefined {
  const raw = readEnv(name);
  if (raw === undefined) {
    return undefined;
  }

  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : Number.NaN;
}

/** Raw (untrimmed) values of the named variables plus every variable whose name starts with one of `prefixes`. */
export function pickEnv(names: readonly string[], prefixes: readonly string[] = []): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (names.includes(name) || prefixes.some((prefix) => name.startsWith(prefix))) {
      picked[name] = value;
    }
  }
  return picked;
}
