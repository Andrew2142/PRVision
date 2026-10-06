#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const defaultPorts = [3100, 4210];
const ports = process.argv
  .slice(2)
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0 && value < 65536);

const targetPorts = ports.length ? ports : defaultPorts;
const currentPid = process.pid;
const parentPid = process.ppid;

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function pidsFromLsof(port) {
  return run("lsof", ["-ti", `tcp:${port}`])
    .split(/\s+/)
    .filter(Boolean);
}

function pidsFromFuser(port) {
  return run("fuser", [`${port}/tcp`])
    .split(/\s+/)
    .filter(Boolean);
}

function pidsForPort(port) {
  return [...new Set([...pidsFromLsof(port), ...pidsFromFuser(port)])]
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== currentPid && pid !== parentPid);
}

function killPid(pid, signal) {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (const port of targetPorts) {
  const pids = pidsForPort(port);
  if (!pids.length) {
    console.log(`Port ${port} is clear.`);
    continue;
  }

  console.log(`Clearing port ${port}: stopping PID${pids.length === 1 ? "" : "s"} ${pids.join(", ")}.`);
  for (const pid of pids) {
    killPid(pid, "SIGTERM");
  }

  sleep(700);

  const remaining = pidsForPort(port).filter((pid) => pids.includes(pid));
  for (const pid of remaining) {
    if (killPid(pid, "SIGKILL")) {
      console.log(`Force-stopped PID ${pid} on port ${port}.`);
    }
  }
}
