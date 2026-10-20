#!/usr/bin/env node
// Drives a PRVision run from the command line for the Claude Code `prvision` skill (sheet 17 §10).
//
//   prvision-run.mjs [run] [--path <dir>] [--source auto|working|branch] [--base <ref>] [--limit <n>]
//                          [--ai agent|settings] [--no-open]
//   prvision-run.mjs wait <visualizationId> [--no-open]
//   prvision-run.mjs continue <visualizationId> --limit <n> [--no-open]
//   prvision-run.mjs answer <requestId> <answer.json>
//   prvision-run.mjs fail <requestId> <message>
//
// `run` starts PRVision if it is down, registers the repository that holds --path (default: cwd) if needed,
// starts a visualization of the working tree (or the current branch when the tree is clean), opens it in the
// browser and waits. With `--ai agent` (the default) the run makes no model call of its own: its AI requests are
// claimed here and written to one folder each for the calling Claude Code session to answer.
//
// Exit codes: 0 completed, 1 failed or error, 2 paused for confirmation, 3 AI requests need answers.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = process.env.PRVISION_API_URL ?? "http://localhost:3100";
const WEB = process.env.PRVISION_WEB_URL ?? "http://localhost:4210";
const DATA_DIR = expandHome(process.env.PRVISION_DATA_DIR ?? "~/.prvision");
const PRVISION_ROOT = path.resolve(path.dirname(realpathSync(fileURLToPath(import.meta.url))), "../../..");

const HANDOFF_DIR = path.join(os.tmpdir(), "prvision-agent");
const SKILL_SCRIPT = "~/.claude/skills/prvision/prvision-run.mjs";

const START_TIMEOUT_MS = 15 * 60_000;
const RUN_TIMEOUT_MS = 90 * 60_000;
const POLL_MS = 3_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const RISK_ORDER = { likely_regression: 0, check: 1, none: 2 };

class CliError extends Error {}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

const COMMANDS = ["run", "wait", "continue", "answer", "fail"];

function parseArgs(argv) {
  const args = {
    command: "run",
    id: null,
    path: process.cwd(),
    source: "auto",
    base: null,
    limit: null,
    ai: "agent",
    open: true,
    file: null,
    message: null
  };
  const rest = [...argv];
  if (COMMANDS.includes(rest[0])) {
    args.command = rest.shift();
  }
  if (args.command !== "run") {
    args.id = Number(rest.shift());
    if (!Number.isInteger(args.id) || args.id < 1) {
      const what = args.command === "answer" || args.command === "fail" ? "a request id" : "a visualization id";
      throw new CliError(`${args.command} needs ${what}`);
    }
  }
  if (args.command === "answer") {
    args.file = rest.shift() ?? null;
    if (!args.file) throw new CliError("answer needs the path of an answer JSON file");
    return args;
  }
  if (args.command === "fail") {
    args.message = rest.join(" ").trim();
    if (!args.message) throw new CliError("fail needs a message");
    return args;
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
    else if (flag === "--ai") args.ai = value();
    else if (flag === "--no-open") args.open = false;
    else throw new CliError(`Unknown argument ${flag}`);
  }
  if (!["agent", "settings"].includes(args.ai)) {
    throw new CliError("--ai must be agent or settings");
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

/**
 * Polls the run until it ends, pauses, or (agent runs) has AI requests to hand off. Returns
 * `{ detail }` or `{ detail, requests }` when requests were claimed.
 */
async function waitForRun(id) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  let lastStatus = null;
  for (;;) {
    const detail = await api("GET", `/api/visualizations/${id}`);
    if (detail.status !== lastStatus) {
      log(`status: ${detail.status}`);
      lastStatus = detail.status;
    }
    if (TERMINAL.has(detail.status) || detail.status === "awaiting_confirmation") return { detail };
    if (detail.aiProvider === "agent") {
      const requests = await api("POST", `/api/visualizations/${id}/agent-requests/claim`);
      if (requests.length > 0) return { detail, requests };
    }
    if (Date.now() > deadline) {
      throw new CliError(`Run ${id} is still ${detail.status} after ${RUN_TIMEOUT_MS / 60_000} minutes`);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

const PURPOSE_TEXT = {
  harness: "Write a render harness for one UI component.",
  harness_repair: "Fix a render harness that failed to render.",
  summary: "Write the review summary of the whole run and one note per component."
};

/** Writes `<tmp>/prvision-agent/<run>/<request>/{task.md,schema.json}` for each claimed request. */
function writeHandoff(detail, repositoryPath, requests) {
  const folders = [];
  for (const request of requests) {
    const folder = path.join(HANDOFF_DIR, String(detail.id), String(request.id));
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    writeFileSync(path.join(folder, "schema.json"), `${JSON.stringify(request.jsonSchema, null, 2)}\n`);
    const images =
      request.images.length === 0
        ? []
        : ["", "## Images", "", ...request.images.map((image) => `- ${image.label}: ${image.path}`)];
    const task = [
      `# PRVision AI request #${request.id} (${request.purpose})`,
      "",
      PURPOSE_TEXT[request.purpose] ?? "Answer the request below.",
      "",
      `Run ${detail.id}: ${detail.title}. Repository: ${repositoryPath}`,
      "",
      "## How to answer",
      "",
      `1. The answer is one JSON object that matches ${path.join(folder, "schema.json")}. Write it to ${path.join(folder, "answer.json")}.`,
      '2. A string value that is exactly "@file:<path>" is replaced by that file\'s contents (path relative to this folder, or absolute). Put harness sources and mock module sources in their own files this way instead of escaping code inside JSON.',
      `3. Submit: node ${SKILL_SCRIPT} answer ${request.id} ${path.join(folder, "answer.json")}`,
      "   If it prints validation errors, fix answer.json and submit again until it is accepted.",
      `   If the request cannot be answered: node ${SKILL_SCRIPT} fail ${request.id} "<reason>"`,
      "4. You may read the repository for context. Do not modify it.",
      "5. The system instructions below are written for an API model. Follow their content rules; ignore anything about how to return output (the answer file above is the output).",
      ...images,
      "",
      "## System instructions",
      "",
      request.system,
      "",
      "## Request",
      "",
      request.prompt,
      ""
    ].join("\n");
    writeFileSync(path.join(folder, "task.md"), task);
    folders.push({ request, folder });
  }
  return folders;
}

/** Replaces every string that is exactly "@file:<path>" with the file's contents (relative to `baseDir`). */
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

async function answerRequest(requestId, file) {
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
  const response = inlineFileRefs(parsed, path.dirname(filePath));
  await api("POST", `/api/agent-requests/${requestId}/answer`, { response });
  console.log(`accepted #${requestId}`);
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
  if (usage && detail.aiProvider === "agent") lines.push(`AI: Claude Code session, ${usage.calls} calls`);
  else if (usage) lines.push(`AI usage: ${usage.inputTokens} in / ${usage.outputTokens} out over ${usage.calls} calls`);
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
  if (args.command === "answer") return answerRequest(args.id, args.file);
  if (args.command === "fail") {
    await api("POST", `/api/agent-requests/${args.id}/fail`, { message: args.message });
    console.log(`failed #${args.id}`);
    return;
  }
  await ensureRunning();
  let id = args.id;
  if (args.command === "run") {
    const topLevel = gitTopLevel(args.path);
    const repository = await findOrRegisterRepository(topLevel, realpathSync(args.path));
    const source = chooseSource(args, topLevel, repository);
    const { label, ...request } = source;
    const created = await api("POST", "/api/visualizations", {
      repositoryId: repository.id,
      ...request,
      ...(args.ai === "agent" ? { aiProvider: "agent" } : {})
    });
    id = created.visualizationId;
    log(`Started run ${id} for ${repository.name}: ${label}`);
    log(`Link: ${WEB}/visualizations/${id}`);
  } else if (args.command === "continue") {
    await api("POST", `/api/visualizations/${id}/continue`, { componentLimit: args.limit });
    log(`Continuing run ${id} with up to ${args.limit} components`);
  }
  if (args.open && args.command !== "wait") openBrowser(`${WEB}/visualizations/${id}`);

  let result = await waitForRun(id);
  if (result.detail.status === "awaiting_confirmation" && args.command === "run" && args.limit !== null) {
    await api("POST", `/api/visualizations/${id}/continue`, { componentLimit: args.limit });
    log(`Paused at ${result.detail.componentCount} components; continuing with up to ${args.limit}`);
    result = await waitForRun(id);
  }
  if (result.requests) {
    const repository = await api("GET", `/api/repositories/${result.detail.repositoryId}`);
    const folders = writeHandoff(result.detail, repository.localPath, result.requests);
    console.log(`\n[prvision] ${folders.length} AI request(s) for run ${id} need answers:`);
    for (const { request, folder } of folders) {
      console.log(`  #${request.id} ${request.purpose.padEnd(14)} ${folder}`);
    }
    console.log(
      `Answer each (one subagent per folder: read task.md), then run: node ${SKILL_SCRIPT} wait ${id}\nLink: ${WEB}/visualizations/${id}`
    );
    process.exitCode = 3;
    return;
  }
  const { detail } = result;
  console.log(`\n${report(detail)}`);
  process.exitCode = detail.status === "completed" ? 0 : detail.status === "awaiting_confirmation" ? 2 : 1;
}

main().catch((error) => {
  console.error(`[prvision] ${error instanceof CliError ? error.message : (error?.stack ?? String(error))}`);
  process.exitCode = 1;
});
