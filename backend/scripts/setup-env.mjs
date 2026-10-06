#!/usr/bin/env node
// Creates or completes the repo-root .env from .env.example (02 §6.6).
//
// - Idempotent: never overwrites a non-empty value already in .env.
// - Adds keys present (uncommented) in .env.example but missing or blank in .env.
// - Generates PRVISION_SECRET_KEY (32 random bytes, base64) when missing or blank.
// - Leaves comments, ordering and unknown keys in an existing .env untouched.
// - Picks a free Docker host port when PRVISION_PG_PORT / PRVISION_REDIS_PORT are not pinned in .env and
//   the default port is busy (00 §14.1), and rewrites DATABASE_URL / REDIS_URL to match.
// - Writes .env with mode 0600. Never prints secret values.
//
// Usage: node backend/scripts/setup-env.mjs [--check]
//   --check  exit 1 (and list keys) when a required key is missing or blank; writes nothing.

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const examplePath = path.join(repoRoot, ".env.example");
const envPath = path.join(repoRoot, ".env");

const REQUIRED_KEYS = ["DATABASE_URL", "REDIS_URL", "PRVISION_SECRET_KEY"];
const GENERATORS = {
  PRVISION_SECRET_KEY: () => crypto.randomBytes(32).toString("base64")
};
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/;
const PORT_SERVICES = [
  {
    label: "Postgres",
    portKey: "PRVISION_PG_PORT",
    urlKey: "DATABASE_URL",
    fallback: 5433,
    container: "prvision-postgres"
  },
  { label: "Redis", portKey: "PRVISION_REDIS_PORT", urlKey: "REDIS_URL", fallback: 6380, container: "prvision-redis" }
];
const PORT_SEARCH_RANGE = 100;

function portInUse(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(true));
    server.once("listening", () => server.close(() => resolve(false)));
    server.listen(port, "127.0.0.1");
  });
}

function runningContainers() {
  try {
    const out = execFileSync("docker", ["ps", "--format", "{{.Names}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000
    });
    return out.split(/\s+/).filter(Boolean);
  } catch {
    return [];
  }
}

/** Replaces the port of a loopback URL that still uses `fromPort`; returns null when the URL is not ours to change. */
function withPort(urlValue, fromPort, toPort) {
  try {
    const url = new URL(urlValue);
    if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.port !== String(fromPort)) return null;
    url.port = String(toPort);
    return url.toString();
  } catch {
    return null;
  }
}

function parse(text) {
  const values = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = ASSIGNMENT.exec(line.trim());
    if (match) values.set(match[1], match[2].trim());
  }
  return values;
}

async function main() {
  if (!fs.existsSync(examplePath)) {
    console.error(`Missing ${path.relative(repoRoot, examplePath)}; cannot create .env.`);
    process.exit(1);
  }

  const example = parse(fs.readFileSync(examplePath, "utf8"));
  const existed = fs.existsSync(envPath);
  const currentText = existed ? fs.readFileSync(envPath, "utf8") : "";
  const current = parse(currentText);

  if (process.argv.includes("--check")) {
    const missing = REQUIRED_KEYS.filter((key) => !current.get(key));
    if (missing.length > 0) {
      console.error(`.env is missing required values: ${missing.join(", ")}. Run npm run setup:env.`);
      process.exit(1);
    }
    console.log(".env has every required value.");
    return;
  }

  const added = [];
  const filled = [];
  const moved = [];
  const lines = existed ? currentText.split(/\r?\n/) : fs.readFileSync(examplePath, "utf8").split(/\r?\n/);
  const values = new Map(existed ? current : example);

  /** Sets KEY=value in place (uncommented line) or appends it. Returns "filled" | "added". */
  function setLine(key, value) {
    values.set(key, value);
    const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
    if (index >= 0) {
      lines[index] = `${key}=${value}`;
      return "filled";
    }
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${value}`, "");
    return "added";
  }

  for (const [key, exampleValue] of example) {
    const present = existed ? current.get(key) : exampleValue;
    if (present) continue;

    const generator = GENERATORS[key];
    const value = generator ? generator() : exampleValue;
    if (!value) continue;

    (setLine(key, value) === "filled" ? filled : added).push(key);
  }

  // Free-port detection (00 §14.1). Only for ports the user has not pinned in .env.
  const containers = runningContainers();
  for (const service of PORT_SERVICES) {
    if (values.get(service.portKey) || process.env[service.portKey]) continue; // pinned in .env or the shell
    if (containers.includes(service.container)) continue; // our own container holds the default port
    if (!(await portInUse(service.fallback))) continue;

    let free = null;
    for (let port = service.fallback + 1; port <= service.fallback + PORT_SEARCH_RANGE; port += 1) {
      if (!(await portInUse(port))) {
        free = port;
        break;
      }
    }
    if (free === null) {
      console.warn(
        `Port ${service.fallback} is busy and no free port was found up to ${service.fallback + PORT_SEARCH_RANGE}; set ${service.portKey} manually.`
      );
      continue;
    }
    setLine(service.portKey, String(free));
    const rewritten = withPort(values.get(service.urlKey) ?? "", service.fallback, free);
    if (rewritten !== null) setLine(service.urlKey, rewritten);
    moved.push(
      `Port ${service.fallback} is busy; using ${free} for ${service.label} (${service.portKey}${rewritten !== null ? `, ${service.urlKey}` : ""}).`
    );
  }

  const output = lines.join("\n").replace(/\n*$/, "\n");
  fs.writeFileSync(envPath, output, { mode: 0o600 });
  fs.chmodSync(envPath, 0o600);

  if (!existed) console.log("Created .env from .env.example.");
  for (const key of filled) console.log(`Filled ${key}${GENERATORS[key] ? " (generated)" : ""}.`);
  for (const key of added) console.log(`Added ${key}${GENERATORS[key] ? " (generated)" : ""}.`);
  for (const line of moved) console.log(line);
  if (existed && filled.length === 0 && added.length === 0 && moved.length === 0) {
    console.log(".env already complete; nothing changed.");
  }
}

await main();
