#!/usr/bin/env node
// Links tools/claude-skill/prvision into ~/.claude/skills/prvision so Claude Code can run PRVision from any project.
// The link points at this checkout, so `git pull` updates the skill.
import { lstatSync, mkdirSync, readlinkSync, symlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../tools/claude-skill/prvision");
const skillsDir = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude"), "skills");
const target = path.join(skillsDir, "prvision");

function existing(linkPath) {
  try {
    const stat = lstatSync(linkPath);
    return stat.isSymbolicLink() ? { link: readlinkSync(linkPath) } : { other: true };
  } catch {
    return null;
  }
}

const current = existing(target);
if (current?.link === source) {
  console.log(`Already installed: ${target} -> ${source}`);
} else if (current) {
  console.error(`${target} already exists and is not a link to this checkout. Remove it, then run this again.`);
  process.exitCode = 1;
} else {
  mkdirSync(skillsDir, { recursive: true });
  symlinkSync(source, target, "dir");
  console.log(`Installed: ${target} -> ${source}\nIn Claude Code, say "run prvision" after making UI changes.`);
}
