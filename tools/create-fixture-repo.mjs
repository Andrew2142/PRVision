#!/usr/bin/env node
// tools/create-fixture-repo.mjs — creates <dataDir>/fixtures/sample-react-app (sheet 14 §5.10)
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BRANCHES, FIXTURE_VERSION, MAIN_FILES } from "./fixture-repo/sample-app-files.mjs";

const FIXTURE_NAME = "sample-react-app";
const BASE_TIME = Date.parse("2026-01-01T09:00:00Z");
const IDENTITY = { name: "PRVision Fixture", email: "fixture@prvision.local" };
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INSTALL_COMMANDS = {
  npm: ["npm", ["install", "--no-audit", "--no-fund"]],
  pnpm: ["pnpm", ["install"]],
  yarn: ["yarn", ["install"]],
};

class FixtureError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const log = (message) => console.log(`[fixture] ${message}`);

export function parseArgs(argv) {
  const options = { force: false, reset: false, skipInstall: false, dataDir: null, pm: "npm", help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--force") options.force = true;
    else if (arg === "--reset") options.reset = true;
    else if (arg === "--skip-install") options.skipInstall = true;
    else if (arg === "--data-dir") options.dataDir = argv[++i];
    else if (arg === "--pm") options.pm = argv[++i];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new FixtureError(`Unknown argument: ${arg}`);
  }
  if (!INSTALL_COMMANDS[options.pm]) throw new FixtureError(`--pm must be one of npm, pnpm, yarn`);
  if (options.force && options.reset) throw new FixtureError("--force and --reset are mutually exclusive");
  if (options.dataDir === undefined) throw new FixtureError("--data-dir needs a value");
  return options;
}

export function resolveDataDir(flagValue) {
  const raw = flagValue ?? process.env.PRVISION_DATA_DIR ?? path.join(os.homedir(), ".prvision");
  const expanded = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  return path.resolve(expanded);
}

function assertNodeVersion() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new FixtureError(`Node >= 22.12 is required (found ${process.versions.node})`);
  }
}

function assertTool(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.error) throw new FixtureError(`${command} not found on PATH`, 3);
}

let commitCounter = 0;
function gitEnv() {
  const date = new Date(BASE_TIME + commitCounter * 3_600_000).toISOString();
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    GIT_COMMITTER_DATE: date,
  };
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, env: gitEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function writeFiles(root, files) {
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.endsWith("\n") ? content : `${content}\n`, { mode: 0o644 });
  }
}

function commit(root, message, { files = {}, remove = [] } = {}) {
  writeFiles(root, files);
  for (const relative of remove) fs.rmSync(path.join(root, relative), { force: true });
  git(root, ["add", "-A"]);
  commitCounter += 1;
  git(root, ["commit", "--quiet", "--no-verify", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}

function markerPath(target) {
  return path.join(target, ".git", "prvision-fixture.json");
}

function readMarker(target) {
  try {
    return JSON.parse(fs.readFileSync(markerPath(target), "utf8"));
  } catch {
    return null;
  }
}

function assertSafeTarget(dataDir, target) {
  const expected = path.join(dataDir, "fixtures", FIXTURE_NAME);
  const forbidden = [path.parse(dataDir).root, os.homedir(), REPO_ROOT];
  if (target !== expected) throw new FixtureError(`Refusing to touch unexpected path ${target}`);
  if (forbidden.includes(dataDir)) throw new FixtureError(`Refusing to use ${dataDir} as the data dir`);
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new FixtureError(`${target} is a symlink; refusing`);
  }
}

function createRepository(target) {
  // Commit dates count from BASE_TIME for every creation, so SHAs are identical across runs (§5.10.2).
  commitCounter = 0;
  fs.mkdirSync(target, { recursive: true });
  try {
    git(target, ["init", "--quiet", "-b", "main"]);
  } catch {
    git(target, ["init", "--quiet"]);
    git(target, ["symbolic-ref", "HEAD", "refs/heads/main"]);
  }
  git(target, ["config", "commit.gpgsign", "false"]);
  git(target, ["config", "core.autocrlf", "false"]);

  const shas = { main: commit(target, "chore: scaffold sample react app", { files: MAIN_FILES }) };
  for (const branch of BRANCHES) {
    git(target, ["checkout", "--quiet", "-b", branch.name, branch.from]);
    for (const step of branch.commits) shas[branch.name] = commit(target, step.message, step);
    git(target, ["checkout", "--quiet", "main"]);
  }
  const status = git(target, ["status", "--porcelain"]);
  if (status) throw new FixtureError(`Fixture working tree not clean after creation:\n${status}`);
  return shas;
}

function install(target, pm) {
  if (pm === "yarn") writeFiles(target, { ".yarnrc.yml": "nodeLinker: node-modules\n" });
  const [command, args] = INSTALL_COMMANDS[pm];
  log(`Installing dependencies with ${pm} (this takes a minute the first time)…`);
  const result = spawnSync(command, args, { cwd: target, stdio: "inherit", env: process.env });
  if (result.error) throw new FixtureError(`${pm} not found on PATH`, 3);
  if (result.status !== 0) {
    throw new FixtureError(
      `${pm} install failed (exit ${result.status}). Fix the problem and re-run \`npm run fixture:create\`; it retries the install only.`,
      2,
    );
  }
}

function writeMarker(target, data) {
  fs.writeFileSync(markerPath(target), `${JSON.stringify(data, null, 2)}\n`);
}

function branchesMatch(target, marker) {
  return Object.entries(marker.branches).every(([name, sha]) => {
    try {
      return git(target, ["rev-parse", `refs/heads/${name}`]) === sha;
    } catch {
      return false;
    }
  });
}

function resetFixture(target, marker) {
  git(target, ["checkout", "--quiet", "-f", "main"]);
  git(target, ["reset", "--quiet", "--hard", marker.branches.main]);
  git(target, ["clean", "-fdq"]);
  for (const [name, sha] of Object.entries(marker.branches)) {
    if (name !== "main") git(target, ["branch", "-f", name, sha]);
  }
  const keep = new Set(Object.keys(marker.branches));
  for (const name of git(target, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean)) {
    if (!keep.has(name)) git(target, ["branch", "-D", name]);
  }
  for (const ref of git(target, ["for-each-ref", "--format=%(refname)", "refs/prvision"]).split("\n").filter(Boolean)) {
    git(target, ["update-ref", "-d", ref]);
  }
  git(target, ["worktree", "prune"]);
}

function printNextSteps(target, marker) {
  const branches = Object.keys(marker.branches).join(", ");
  console.log(`
Fixture ready: ${target}
Branches: ${branches}

Next steps:
  1. From the PRVision root: npm run dev, then open http://localhost:4210
  2. Repositories → Add repository → paste: ${target}
  3. New visualization → Local branch → head "feature/button-restyle", base "main"
  4. Manual QA scenarios: docs/specs/14-testing-fixtures-and-qa.md §5.11
  5. Integration tests: npm run test:it

Optional: cd "${target}" && npm run dev   # view the sample app itself at http://localhost:5173
Reset after QA: npm run fixture:reset     Recreate from scratch: npm run fixture:recreate
`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log("usage: create-fixture-repo.mjs [--force] [--reset] [--skip-install] [--data-dir <path>] [--pm npm|pnpm|yarn]");
    return 0;
  }
  assertNodeVersion();
  assertTool("git");
  if (!options.skipInstall) assertTool(options.pm);

  const dataDir = resolveDataDir(options.dataDir);
  const target = path.join(dataDir, "fixtures", FIXTURE_NAME);
  assertSafeTarget(dataDir, target);
  const exists = fs.existsSync(target);
  let marker = exists ? readMarker(target) : null;

  if (options.reset) {
    if (!marker || marker.version !== FIXTURE_VERSION) {
      throw new FixtureError("No valid fixture to reset; run npm run fixture:recreate");
    }
    resetFixture(target, marker);
    log("Fixture reset to pristine state.");
    printNextSteps(target, marker);
    return 0;
  }

  if (exists && options.force) {
    log(`Removing ${target}`);
    fs.rmSync(target, { recursive: true, force: true });
    marker = null;
  } else if (exists && (!marker || marker.version !== FIXTURE_VERSION)) {
    throw new FixtureError(
      `${target} exists but was not created by fixture version ${FIXTURE_VERSION}. Re-run with --force (npm run fixture:recreate).`,
    );
  } else if (exists && !branchesMatch(target, marker)) {
    throw new FixtureError("Fixture branches were modified. Run npm run fixture:reset.");
  }

  if (!marker) {
    log(`Creating ${target}`);
    const branches = createRepository(target);
    marker = { version: FIXTURE_VERSION, packageManager: options.pm, installed: false, branches, createdAt: new Date().toISOString() };
    writeMarker(target, marker);
  } else {
    log("Fixture repository already exists.");
    if (git(target, ["status", "--porcelain"])) {
      log(
        "Warning: uncommitted changes present (expected only during the working-tree QA scenario). Run npm run fixture:reset to discard.",
      );
    }
  }

  const needsInstall = !fs.existsSync(path.join(target, "node_modules", "vite"));
  if (!options.skipInstall && needsInstall) {
    install(target, options.pm);
    marker = { ...marker, packageManager: options.pm, installed: true };
    writeMarker(target, marker);
  } else if (options.skipInstall) {
    log("Skipping dependency install (--skip-install).");
  }

  printNextSteps(target, marker);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[fixture] ${error.message}`);
      process.exit(error instanceof FixtureError ? error.exitCode : 1);
    });
}
