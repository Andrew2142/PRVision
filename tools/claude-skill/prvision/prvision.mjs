#!/usr/bin/env node
// Headless PRVision for the Claude Code `prvision` skill: no server, database or Docker.
//
//   prvision.mjs init [--path <dir>] [--viewport desktop|tablet|mobile] [--states <1-5>] [--limit <n>]
//                     [--app-root <dir>] [--angular-project <name>]
//   prvision.mjs run [--path <dir>] [--source auto|working|branch] [--head <ref>] [--base <ref>] [--limit <n>]
//   prvision.mjs wait <runDir>
//   prvision.mjs continue <runDir> --limit <n>
//   prvision.mjs answer <runDir> <requestId> <answer.json>
//   prvision.mjs fail <runDir> <requestId> <message>
//   prvision.mjs open <runDir> [--port <n>] [--no-open]
//
// `run` starts the engine (backend/dist/headless/engine.js) in the background with its run folder under
// ~/.prvision/runs/<repo>-<hash>/<timestamp>, then waits like `wait`. The engine hands every AI request to this Claude
// Code session as a folder (task.md, schema.json); answers come back through `answer`.
//
// Exit codes of run/wait/continue: 0 completed, 1 failed or error, 2 paused for confirmation, 3 AI requests need
// answers, 4 (run only) the repository has no .prvision/config.json yet: ask the setup questions, then `init`.
//
// .prvision/config.json (committed with the repository) holds the answers to the setup questions:
//   { "viewport": "desktop", "states": 3, "componentLimit": 12, "appRoot": ".", "angularProject": null }
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, statSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PRVISION_ROOT = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..");
const ENGINE = path.join(PRVISION_ROOT, "backend", "dist", "headless", "engine.js");
const SELF = `node ${realpathSync(fileURLToPath(import.meta.url))}`;
/** Run folders (engine data, screenshots, the report) live outside the repository: PRVision never renders its own data. */
const RUNS_ROOT = path.join(os.homedir(), ".prvision", "runs");
const POLL_MS = 1_500;
const WAIT_TIMEOUT_MS = 90 * 60_000;
const ANSWER_TIMEOUT_MS = 60_000;
const TERMINAL = new Set(["completed", "failed", "cancelled", "error"]);
const COMMANDS = ["init", "run", "wait", "continue", "answer", "fail", "open"];
const CONFIG_FILE = path.join(".prvision", "config.json");
const NEEDS_SETUP = 4;
const VIEWER_DIR = path.join(PRVISION_ROOT, "frontend", "dist", "frontend", "browser");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8"
};

class CliError extends Error {}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function log(message) {
  console.log(`[prvision] ${message}`);
}

function parseArgs(argv) {
  const rest = [...argv];
  const command = COMMANDS.includes(rest[0]) ? rest.shift() : "run";
  const args = {
    command,
    path: process.cwd(),
    source: "auto",
    head: null,
    base: null,
    limit: null,
    port: 4317,
    open: true,
    viewport: null,
    states: null,
    appRoot: null,
    angularProject: null,
    positional: []
  };
  while (rest.length > 0) {
    const item = rest.shift();
    const value = () => {
      const next = rest.shift();
      if (next === undefined) throw new CliError(`${item} needs a value`);
      return next;
    };
    if (item === "--path") args.path = path.resolve(expandHome(value()));
    else if (item === "--source") args.source = value();
    else if (item === "--head") args.head = value();
    else if (item === "--base") args.base = value();
    else if (item === "--limit") args.limit = Number(value());
    else if (item === "--port") args.port = Number(value());
    else if (item === "--viewport") args.viewport = value();
    else if (item === "--states") args.states = Number(value());
    else if (item === "--app-root") args.appRoot = value();
    else if (item === "--angular-project") args.angularProject = value();
    else if (item === "--no-open") args.open = false;
    else if (item.startsWith("--")) throw new CliError(`Unknown option ${item}`);
    else args.positional.push(item);
  }
  if (!["auto", "working", "branch"].includes(args.source)) throw new CliError("--source must be auto, working or branch");
  if (args.limit !== null && !(Number.isSafeInteger(args.limit) && args.limit > 0)) {
    throw new CliError("--limit must be a positive integer");
  }
  return args;
}

function git(cwd, gitArgs) {
  return execFileSync("git", gitArgs, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function topLevel(dir) {
  try {
    return realpathSync(git(dir, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new CliError(`${dir} is not inside a git repository`);
  }
}

function defaultBranch(repo) {
  try {
    return git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]).replace(/^origin\//, "");
  } catch {
    for (const name of ["main", "master"]) {
      try {
        git(repo, ["rev-parse", "--verify", "--quiet", name]);
        return name;
      } catch {
        // try the next
      }
    }
    throw new CliError("Could not tell the default branch; pass --base <ref>");
  }
}

/** Working tree when it is dirty (auto), else the current branch against the default branch. */
function chooseSource(args, repo) {
  const dirty = git(repo, ["status", "--porcelain"]).length > 0;
  const wantBranch = args.head !== null || args.source === "branch" || (args.source === "auto" && !dirty);
  if (!wantBranch) {
    if (!dirty) throw new CliError("The working tree is clean; there are no uncommitted changes to show");
    return { flags: ["--working"], label: "uncommitted changes" };
  }
  const head = args.head ?? git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head === "HEAD") throw new CliError("HEAD is detached; check out a branch or use --source working");
  const base = args.base ?? defaultBranch(repo);
  if (head === base && args.head === null) {
    throw new CliError(`On ${head} with a clean working tree: nothing to compare. Pass --base <ref> to compare.`);
  }
  return { flags: ["--head", head, "--base", base], label: `${head} against ${base}` };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function writeJsonAtomic(file, value) {
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temp, file);
}

function runDirArg(args) {
  const dir = args.positional[0];
  if (!dir) throw new CliError(`${args.command} needs the run folder`);
  const resolved = path.resolve(expandHome(dir));
  if (!existsSync(path.join(resolved, "requests"))) throw new CliError(`${resolved} is not a PRVision run folder`);
  return resolved;
}

function readConfig(repo) {
  const config = readJson(path.join(repo, CONFIG_FILE));
  return config && typeof config === "object" ? config : null;
}

/** Writes the setup answers to .prvision/config.json; unspecified answers keep their previous value or default. */
function init(args) {
  const repo = topLevel(args.path);
  const previous = readConfig(repo) ?? {};
  const config = {
    viewport: args.viewport ?? previous.viewport ?? "desktop",
    states: args.states ?? previous.states ?? 3,
    componentLimit: args.limit ?? previous.componentLimit ?? 12,
    appRoot: args.appRoot ?? previous.appRoot ?? ".",
    angularProject: args.angularProject ?? previous.angularProject ?? null
  };
  if (!["desktop", "tablet", "mobile"].includes(config.viewport)) throw new CliError("--viewport must be desktop, tablet or mobile");
  if (!(Number.isSafeInteger(config.states) && config.states >= 1 && config.states <= 5)) {
    throw new CliError("--states must be between 1 and 5");
  }
  mkdirSync(path.join(repo, ".prvision"), { recursive: true });
  writeFileSync(path.join(repo, CONFIG_FILE), `${JSON.stringify(config, null, 2)}\n`);
  log(`Saved ${path.join(repo, CONFIG_FILE)}`);
}

function startEngine(args) {
  if (!existsSync(ENGINE)) {
    throw new CliError(`The engine is not built: run "npm install && npm run build" in ${path.join(PRVISION_ROOT, "backend")}`);
  }
  const repo = topLevel(args.path);
  const config = readConfig(repo);
  if (config === null) {
    console.log(`[prvision] ${repo} is not set up for PRVision yet (no ${CONFIG_FILE}).`);
    console.log("Ask the setup questions, then run init with the answers.");
    process.exit(NEEDS_SETUP);
  }
  const source = chooseSource(args, repo);
  const limit = args.limit ?? config.componentLimit ?? null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const repoKey = `${path.basename(repo)}-${createHash("sha256").update(repo).digest("hex").slice(0, 8)}`;
  const runDir = path.join(RUNS_ROOT, repoKey, stamp);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const out = openSync(path.join(runDir, "engine.log"), "a");
  const child = spawn(
    process.execPath,
    [
      ENGINE,
      "--run",
      runDir,
      "--repo",
      repo,
      ...source.flags,
      ...(limit !== null ? ["--limit", String(limit)] : []),
      ...(config.viewport ? ["--viewport", config.viewport] : []),
      ...(config.states ? ["--states", String(config.states)] : []),
      ...(config.appRoot && config.appRoot !== "." ? ["--app-root", config.appRoot] : []),
      ...(config.angularProject ? ["--angular-project", config.angularProject] : []),
      "--cli",
      SELF
    ],
    {
      detached: true,
      stdio: ["ignore", out, out],
      env: { ...process.env, PRVISION_DATA_DIR: path.join(runDir, "data"), NODE_ENV: "production" }
    }
  );
  child.unref();
  log(`Started: ${source.label}`);
  log(`Run folder: ${runDir}`);
  return runDir;
}

async function waitForRun(runDir) {
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let last = null;
  for (;;) {
    const status = readJson(path.join(runDir, "status.json"));
    if (status) {
      if (status.state !== last) {
        log(`status: ${status.state}`);
        last = status.state;
      }
      if (TERMINAL.has(status.state) || status.state === "awaiting_confirmation") return status;
      const handed = readJson(path.join(runDir, "handed.json")) ?? [];
      const fresh = status.openRequests.filter((id) => !handed.includes(id));
      if (fresh.length > 0) {
        writeJsonAtomic(path.join(runDir, "handed.json"), [...handed, ...fresh]);
        return { ...status, fresh };
      }
    }
    if (Date.now() > deadline) throw new CliError(`The run is still ${last ?? "starting"} after 90 minutes`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function inlineFileRefs(value, baseDir) {
  if (typeof value === "string") {
    const match = /^@file:(.+)$/s.exec(value);
    if (!match) return value;
    const target = path.resolve(baseDir, expandHome(match[1].trim()));
    try {
      return readFileSync(target, "utf8");
    } catch {
      throw new CliError(`Cannot read ${target} (referenced as ${value})`);
    }
  }
  if (Array.isArray(value)) return value.map((item) => inlineFileRefs(item, baseDir));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inlineFileRefs(item, baseDir)]));
  }
  return value;
}

/** Drops a submission into the request folder and waits for the engine's verdict. */
async function submit(runDir, requestId, kind, body) {
  const dir = path.join(runDir, "requests", String(requestId));
  if (!existsSync(dir)) throw new CliError(`No request ${requestId} in ${runDir}`);
  const resultFile = path.join(dir, "result.json");
  rmSync(resultFile, { force: true });
  writeJsonAtomic(path.join(dir, `${kind}.json`), body);
  const deadline = Date.now() + ANSWER_TIMEOUT_MS;
  for (;;) {
    const result = readJson(resultFile);
    if (result) return result;
    if (Date.now() > deadline) throw new CliError("The engine did not pick up the answer (is the run still going?)");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}

async function answer(args) {
  const runDir = runDirArg(args);
  const [, id, file] = args.positional;
  if (!id || !file) throw new CliError("answer needs <runDir> <requestId> <answer.json>");
  const filePath = path.resolve(expandHome(file));
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new CliError(`${filePath} is not valid JSON: ${error.message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("The answer must be a JSON object");
  }
  const result = await submit(runDir, id, "submit", inlineFileRefs(parsed, path.dirname(filePath)));
  if (result.accepted) {
    console.log(`accepted #${id}`);
    return;
  }
  console.log(`rejected #${id}:`);
  for (const error of result.errors ?? []) console.log(`  - ${error}`);
  process.exitCode = 1;
}

async function fail(args) {
  const runDir = runDirArg(args);
  const [, id, ...words] = args.positional;
  const message = words.join(" ").trim();
  if (!id || !message) throw new CliError("fail needs <runDir> <requestId> <message>");
  const result = await submit(runDir, id, "fail", { message });
  console.log(result.accepted ? `failed #${id}` : `could not fail #${id}: ${(result.errors ?? []).join(" ")}`);
}

function printOutcome(runDir, status) {
  if (status.fresh) {
    console.log(`\n[prvision] ${status.fresh.length} AI request(s) need answers:`);
    for (const id of status.fresh) {
      const folder = path.join(runDir, "requests", String(id));
      const purpose = /\((\w+)\)/.exec(readFileSync(path.join(folder, "task.md"), "utf8").split("\n")[0] ?? "")?.[1] ?? "";
      console.log(`  #${id} ${purpose.padEnd(14)} ${folder}`);
    }
    console.log(`Answer each (one subagent per folder: read task.md), then run: ${SELF} wait ${runDir}`);
    return 3;
  }
  if (status.state === "awaiting_confirmation") {
    console.log(`\n[prvision] ${status.componentCount} components need new harnesses. Choose how many to render, then run:`);
    console.log(`  ${SELF} continue ${runDir} --limit <n>`);
    return 2;
  }
  if (status.state === "completed") {
    console.log(`\n[prvision] Completed: ${status.title} (${status.changedCount} changed of ${status.componentCount})`);
    if (status.reportDir) {
      console.log(`Report folder: ${status.reportDir}`);
      console.log(`View it (keep this running in the background): ${SELF} open ${runDir}`);
    }
    return 0;
  }
  console.log(`\n[prvision] Run ${status.state}${status.message ? `: ${status.message}` : ""}`);
  console.log(`Engine log: ${path.join(runDir, "engine.log")}`);
  return 1;
}

/** Serves a file under `root`, or null when the path leaves it or does not exist. */
function fileUnder(root, urlPath) {
  const target = path.resolve(root, `.${decodeURIComponent(urlPath)}`);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  return existsSync(target) && statSync(target).isFile() ? target : null;
}

/**
 * The report viewer on localhost: the PRVision frontend build at /, the run's report folder at /report-data/.
 * Anything else falls back to index.html (the app routes it). Bound to 127.0.0.1 only.
 */
function openReport(args) {
  const runDir = runDirArg(args);
  const reportDir = path.join(runDir, "report");
  if (!existsSync(path.join(reportDir, "report.json"))) throw new CliError(`No report yet in ${runDir}`);
  if (!existsSync(path.join(VIEWER_DIR, "index.html"))) {
    throw new CliError(`The viewer is not built: run "npm install && npm run build" in ${path.join(PRVISION_ROOT, "frontend")}`);
  }
  const server = createServer((req, res) => {
    const urlPath = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = urlPath.startsWith("/report-data/")
      ? fileUnder(reportDir, urlPath.slice("/report-data".length))
      : (fileUnder(VIEWER_DIR, urlPath) ?? path.join(VIEWER_DIR, "index.html"));
    if (file === null) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(readFileSync(file));
  });
  server.on("error", (error) => {
    console.error(`[prvision] ${error.code === "EADDRINUSE" ? `Port ${args.port} is in use; pass --port <n>` : error.message}`);
    process.exit(1);
  });
  server.listen(args.port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${args.port}/report?src=/report-data/report.json`;
    log(`Report: ${url}`);
    log("Ctrl+C stops it.");
    if (args.open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
      spawnSync(opener, [url], { stdio: "ignore", timeout: 10_000 });
    }
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "open") return openReport(args);
  if (args.command === "init") return init(args);
  if (args.command === "answer") return answer(args);
  if (args.command === "fail") return fail(args);
  let runDir;
  if (args.command === "run") {
    runDir = startEngine(args);
  } else {
    runDir = runDirArg(args);
    if (args.command === "continue") {
      if (args.limit === null) throw new CliError("continue needs --limit <n>");
      writeJsonAtomic(path.join(runDir, "continue.json"), { limit: args.limit });
      log(`Continuing with up to ${args.limit} components`);
    }
  }
  process.exitCode = printOutcome(runDir, await waitForRun(runDir));
}

main().catch((error) => {
  console.error(`[prvision] ${error instanceof CliError ? error.message : (error?.stack ?? String(error))}`);
  process.exitCode = 1;
});
