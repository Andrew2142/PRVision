#!/usr/bin/env node
// Drives a PRVision run from the command line for the Claude Code `prvision` skill.
//
//   prvision-run.mjs [run] [--path <dir>] [--source auto|working|branch] [--base <ref>] [--limit <n>] [--no-open]
//   prvision-run.mjs wait <visualizationId> [--no-open]
//   prvision-run.mjs continue <visualizationId> --limit <n> [--no-open]
//
// `run` starts PRVision if it is down, registers the repository that holds --path (default: cwd) if needed,
// starts a visualization of the working tree (or the current branch when the tree is clean), opens it in the
// browser and waits for it to finish. It then prints the summary and every component with the image paths on disk.
//
// Exit codes: 0 completed, 2 paused for confirmation (more components than the default limit), 1 anything else.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.PRVISION_API_URL ?? "http://localhost:3100";
const WEB = process.env.PRVISION_WEB_URL ?? "http://localhost:4210";
const DATA_DIR = expandHome(process.env.PRVISION_DATA_DIR ?? "~/.prvision");
const PRVISION_ROOT = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..");

const START_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 50 * 60_000;
const POLL_MS = 3_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RISK_ORDER = { likely_regression: 0, check: 1, none: 2 };

class CliError extends Error {}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function parseArgs(argv) {
  const args = { command: "run", id: null, path: process.cwd(), source: "auto", base: null, limit: null, open: true };
  const rest = [...argv];
  if (rest[0] === "run" || rest[0] === "wait" || rest[0] === "continue") {
    args.command = rest.shift();
  }
  if (args.command !== "run") {
    args.id = Number(rest.shift());
    if (!Number.isInteger(args.id) || args.id < 1) {
      throw new CliError(`${args.command} needs a visualization id`);
    }
  }
  while (rest.length > 0) {
    const flag = rest.shift();
    const value = () => {
      const next = rest.shift();
      if (next === undefined) throw new CliError(`${flag} needs a value`);
      return next;
    };
    if (flag === "--path") args.path = path.resolve(expandHome(value()));
    else if (flag === "--source") args.source = value();
    else if (flag === "--base") args.base = value();
    else if (flag === "--limit") args.limit = Number(value());
    else if (flag === "--no-open") args.open = false;
    else throw new CliError(`Unknown argument ${flag}`);
  }
  if (!["auto", "working", "branch"].includes(args.source)) {
    throw new CliError("--source must be auto, working or branch");
  }
  if (args.limit !== null && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100)) {
    throw new CliError("--limit must be a whole number from 1 to 100");
  }
  if (args.command === "continue" && args.limit === null) {
    throw new CliError("continue needs --limit <n>");
  }
  return args;
}

async function api(method, route, body) {
  let response;
  try {
    response = await fetch(`${API}${route}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch {
    throw new CliError(`PRVision API is not reachable at ${API}`);
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = payload?.error;
    const message = Array.isArray(error) ? error.join("; ") : (error ?? response.statusText);
    const reason = payload?.error_reason ? ` (${payload.error_reason})` : "";
    throw new CliError(`${method} ${route} → ${response.status}: ${message}${reason}`);
  }
  return payload?.data;
}

async function isHealthy() {
  try {
    const response = await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function ensureRunning() {
  if (await isHealthy()) return;
  log(`PRVision is not running; starting it with docker compose in ${PRVISION_ROOT} (first build takes a few minutes)`);
  const result = spawnSync("docker", ["compose", "up", "-d", "--wait"], {
    cwd: PRVISION_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "pipe"],
    timeout: START_TIMEOUT_MS
  });
  if (result.status !== 0 || !(await isHealthy())) {
    const tail = (result.stderr ?? "").trim().split("\n").slice(-15).join("\n");
    throw new CliError(`Could not start PRVision.\n${tail || result.error?.message || "docker compose failed"}`);
  }
  log("PRVision is up");
}

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 30_000
  }).trim();
}

function gitTopLevel(dir) {
  try {
    return realpathSync(git(dir, ["rev-parse", "--show-toplevel"]));
  } catch {
    throw new CliError(`${dir} is not inside a git repository`);
  }
}

async function findOrRegisterRepository(topLevel, cwd) {
  const repositories = await api("GET", "/api/repositories");
  const matches = repositories.filter((r) => existsSync(r.localPath) && realpathSync(r.localPath) === topLevel);
  if (matches.length > 0) {
    // Monorepo with several registered apps: prefer the app folder that contains the current directory.
    const relative = path.relative(topLevel, cwd);
    const scored = matches
      .map((r) => ({ r, root: r.appRoot && r.appRoot !== "." ? r.appRoot : "" }))
      .filter(({ root }) => root === "" || relative === root || relative.startsWith(`${root}${path.sep}`))
      .sort((a, b) => b.root.length - a.root.length);
    return (scored[0] ?? { r: matches[0] }).r;
  }
  log(`Registering ${topLevel} with PRVision`);
  return api("POST", "/api/repositories", { localPath: topLevel });
}

function chooseSource(args, topLevel, repository) {
  const dirty = git(topLevel, ["status", "--porcelain"]).length > 0;
  const branch = git(topLevel, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const wantBranch = args.source === "branch" || (args.source === "auto" && !dirty);
  if (!wantBranch) {
    if (!dirty) throw new CliError("The working tree is clean; there are no uncommitted changes to show");
    return { sourceType: "working_tree", label: "uncommitted changes" };
  }
  if (branch === "HEAD") throw new CliError("HEAD is detached; check out a branch or use --source working");
  const baseRef = args.base ?? repository.defaultBranch;
  if (branch === baseRef) {
    throw new CliError(`On ${branch} with a clean working tree: nothing to compare. Pass --base <ref> to compare.`);
  }
  return { sourceType: "local_branch", headRef: branch, baseRef, label: `${branch} against ${baseRef}` };
}

function openBrowser(url) {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  spawnSync(opener, [url], { stdio: "ignore", timeout: 10_000 });
}

async function waitForRun(id) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let lastStatus = null;
  for (;;) {
    const detail = await api("GET", `/api/visualizations/${id}`);
    if (detail.status !== lastStatus) {
      log(`status: ${detail.status}`);
      lastStatus = detail.status;
    }
    if (TERMINAL.has(detail.status) || detail.status === "awaiting_confirmation") return detail;
    if (Date.now() > deadline) {
      throw new CliError(`Run ${id} is still ${detail.status} after ${RUN_TIMEOUT_MS / 60_000} minutes`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

function imagePath(url) {
  if (!url) return null;
  const onDisk = path.join(DATA_DIR, url);
  return existsSync(onDisk) ? onDisk : `${API}${url}`;
}

function report(detail) {
  const lines = [];
  lines.push(`Run ${detail.id}: ${detail.status}  ${WEB}/visualizations/${detail.id}`);
  lines.push(`Title: ${detail.title}`);
  if (detail.status === "awaiting_confirmation") {
    lines.push(
      `Paused: ${detail.componentCount} components changed, above the default limit.`,
      `Continue with: prvision-run.mjs continue ${detail.id} --limit <n>  (max 100), or choose in the browser and run: prvision-run.mjs wait ${detail.id}`
    );
    return lines.join("\n");
  }
  if (detail.status !== "completed") {
    lines.push(`Error${detail.failedStage ? ` in ${detail.failedStage}` : ""}: ${detail.errorMessage ?? "none given"}`);
    return lines.join("\n");
  }
  const usage = detail.aiUsage;
  if (usage) lines.push(`AI usage: ${usage.inputTokens} in / ${usage.outputTokens} out over ${usage.calls} calls`);
  lines.push("", "## Summary", detail.summaryMarkdown?.trim() || "(no summary)", "", "## Components");
  const order = (c) => (c.renderStatus === "failed" || c.renderStatus === "partial" ? 1 : (RISK_ORDER[c.risk] ?? 3));
  const components = [...detail.components].sort((a, b) => order(a) - order(b) || a.rank - b.rank);
  // Rendered with no visual change and no risk: one line of names, no image paths.
  const quiet = (c) => c.renderStatus === "rendered" && c.visualChange === "unchanged" && c.risk === "none";
  for (const c of components.filter((c) => !quiet(c))) {
    const ratio = c.diffPixelRatio === null ? "" : ` diff ${(c.diffPixelRatio * 100).toFixed(2)}%`;
    lines.push(
      `- ${c.displayName} (${c.filePath}) ${c.changeKind}, ${c.renderStatus}, ${c.visualChange ?? "n/a"}, risk ${c.risk ?? "n/a"}${ratio}`
    );
    if (c.aiNote) lines.push(`  note: ${c.aiNote}`);
    for (const error of [c.baseError && `base error: ${c.baseError}`, c.headError && `head error: ${c.headError}`]) {
      if (error) lines.push(`  ${error.split("\n")[0]}`);
    }
    for (const [kind, url] of [
      ["base", c.baseImageUrl],
      ["head", c.headImageUrl],
      ["diff", c.diffImageUrl]
    ]) {
      const where = imagePath(url);
      if (where) lines.push(`  ${kind}: ${where}`);
    }
  }
  const unchanged = components.filter(quiet).map((c) => c.displayName);
  if (unchanged.length > 0) lines.push(`- Unchanged (${unchanged.length}): ${unchanged.join(", ")}`);
  return lines.join("\n");
}

function log(message) {
  console.log(`[prvision] ${message}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await ensureRunning();
  let id = args.id;
  if (args.command === "run") {
    const topLevel = gitTopLevel(args.path);
    const repository = await findOrRegisterRepository(topLevel, realpathSync(args.path));
    const source = chooseSource(args, topLevel, repository);
    const { label, ...request } = source;
    const created = await api("POST", "/api/visualizations", { repositoryId: repository.id, ...request });
    id = created.visualizationId;
    log(`Started run ${id} for ${repository.name}: ${label}`);
  } else if (args.command === "continue") {
    await api("POST", `/api/visualizations/${id}/continue`, { componentLimit: args.limit });
    log(`Continuing run ${id} with up to ${args.limit} components`);
  }
  if (args.open) openBrowser(`${WEB}/visualizations/${id}`);

  let detail = await waitForRun(id);
  if (detail.status === "awaiting_confirmation" && args.command === "run" && args.limit !== null) {
    await api("POST", `/api/visualizations/${id}/continue`, { componentLimit: args.limit });
    log(`Paused at ${detail.componentCount} components; continuing with up to ${args.limit}`);
    detail = await waitForRun(id);
  }
  console.log(`\n${report(detail)}`);
  process.exitCode = detail.status === "completed" ? 0 : detail.status === "awaiting_confirmation" ? 2 : 1;
}

main().catch((error) => {
  console.error(`[prvision] ${error instanceof CliError ? error.message : (error?.stack ?? String(error))}`);
  process.exitCode = 1;
});
