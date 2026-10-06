#!/usr/bin/env node
// Verifies local prerequisites before `npm run setup` (02 §6.5). No dependencies.
// Fails (exit 1) on: Node < 22.12, npm < 10, missing git or git < 2.36, missing Docker Compose v2.
// Warns on: Docker daemon not reachable; Postgres/Redis host port already taken by something
// other than the PRVision containers (infra:up would fail with "address already in use").

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const failures = [];
const warnings = [];

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}

function atLeast(version, minimum) {
  const parts = version.replace(/^v/, "").split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = parts[index] ?? 0;
    if (actual !== minimum[index]) return actual > minimum[index];
  }
  return true;
}

if (!atLeast(process.version, [22, 12, 0])) {
  failures.push(`Node ${process.version} found; PRVision needs >= 22.12.0 (see .nvmrc).`);
}

const npmVersion = run("npm", ["--version"]);
if (npmVersion === null || !atLeast(npmVersion, [10, 0, 0])) {
  failures.push(`npm ${npmVersion ?? "not found"}; PRVision needs >= 10.`);
}

const gitVersion = run("git", ["--version"]); // "git version 2.43.0" (macOS: "... (Apple Git-146)")
const gitNumber = gitVersion?.match(/(\d+\.\d+(?:\.\d+)?)/)?.[1] ?? null;
if (gitVersion === null) {
  failures.push("git not found on PATH.");
} else if (gitNumber === null || !atLeast(gitNumber, [2, 36, 0])) {
  failures.push(`${gitVersion} found; PRVision needs git >= 2.36 (worktree list -z).`);
}

if (run("docker", ["compose", "version", "--short"]) === null) {
  failures.push("Docker Compose v2 not found (`docker compose version` failed). Install Docker Desktop or the compose plugin.");
} else if (run("docker", ["info", "--format", "{{.ServerVersion}}"]) === null) {
  warnings.push("Docker daemon is not reachable; start Docker before `npm run infra:up`.");
}

function envValue(name) {
  if (process.env[name]) return process.env[name];
  const envPath = path.join(repoRoot, ".env");
  if (!fs.existsSync(envPath)) return undefined;
  const line = fs.readFileSync(envPath, "utf8").split(/\r?\n/).find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).trim() || undefined : undefined;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

const runningContainers = (run("docker", ["ps", "--format", "{{.Names}}"]) ?? "").split(/\s+/);
for (const [name, variable, fallback, container] of [
  ["Postgres", "PRVISION_PG_PORT", "5433", "prvision-postgres"],
  ["Redis", "PRVISION_REDIS_PORT", "6380", "prvision-redis"]
]) {
  const port = Number(envValue(variable) ?? fallback);
  if (!runningContainers.includes(container) && (await portInUse(port))) {
    warnings.push(
      `${name} host port ${port} is already in use by another process. Stop it, or set ${variable} in .env ` +
        `and update ${name === "Postgres" ? "DATABASE_URL" : "REDIS_URL"} to the same port.`
    );
  }
}

for (const warning of warnings) console.warn(`warn: ${warning}`);
if (failures.length > 0) {
  for (const failure of failures) console.error(`error: ${failure}`);
  process.exit(1);
}
console.log(`Prerequisites OK (node ${process.version}, npm ${npmVersion}).`);
