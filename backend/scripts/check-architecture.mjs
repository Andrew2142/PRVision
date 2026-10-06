#!/usr/bin/env node
// Architecture checks that ESLint cannot express cleanly. No dependencies.
// Spec: docs/specs/01-engineering-standards.md §5.6.4 and 02 §6.9.
//
// Rules:
//   direct-drizzle   A file under src/services/** that imports drizzle-orm must
//                    carry at least one `// Direct Drizzle: <why>` comment.
//   process-env      process.env may only be read in src/config-consts/** and
//                    src/utilities/helpers/env.ts.
//   env-helper       utilities/helpers/env may only be imported by
//                    src/config-consts/**.
//   utilities-services  A file under src/utilities/** may not import a module
//                    under src/services/** (04 §9.4, 05 §1: utilities never
//                    depend on services; relative imports are resolved).
//
// PRVision is greenfield: there is no baseline. Any offender fails the check.
// Usage: node scripts/check-architecture.mjs [--list]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = path.join(backendDir, "src");

const PROCESS_ENV_ALLOWED = [/^src\/config-consts\//, /^src\/utilities\/helpers\/env\.ts$/];
const ENV_HELPER_IMPORT_ALLOWED = [/^src\/config-consts\//, /^src\/utilities\/helpers\/env\.ts$/];

const DRIZZLE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']drizzle-orm(?:\/[^"']*)?["']/m;
const DRIZZLE_JUSTIFICATION = /\/\/\s*Direct Drizzle:\s*\S/;
const PROCESS_ENV =
  /\bprocess\s*(?:\.\s*env\b|\[\s*["'`]env["'`]\s*\])|\{[^}]*\benv\b[^}]*\}\s*=\s*process\b|\bglobalThis\s*\.\s*process\s*\.\s*env\b/;
const ENV_HELPER_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'][^"']*\/helpers\/env["']/;
const RELATIVE_IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']*)["']/gm;

const rules = {
  "direct-drizzle": {
    description: "src/services file imports drizzle-orm without a `// Direct Drizzle: <why>` comment",
    test(relPath, source) {
      if (!relPath.startsWith("src/services/")) return false;
      return DRIZZLE_IMPORT.test(stripComments(source)) && !DRIZZLE_JUSTIFICATION.test(source);
    }
  },
  "process-env": {
    description: "process.env read outside src/config-consts and utilities/helpers/env.ts",
    test(relPath, source) {
      if (PROCESS_ENV_ALLOWED.some((pattern) => pattern.test(relPath))) return false;
      return PROCESS_ENV.test(stripComments(source));
    }
  },
  "env-helper": {
    description: "utilities/helpers/env imported outside src/config-consts (import the config constant instead)",
    test(relPath, source) {
      if (ENV_HELPER_IMPORT_ALLOWED.some((pattern) => pattern.test(relPath))) return false;
      return ENV_HELPER_IMPORT.test(stripComments(source));
    }
  },
  "utilities-services": {
    description: "src/utilities file imports from src/services (utilities never depend on services)",
    test(relPath, source) {
      if (!relPath.startsWith("src/utilities/")) return false;
      const dir = path.posix.dirname(relPath);
      for (const match of stripComments(source).matchAll(RELATIVE_IMPORT)) {
        const target = path.posix.normalize(path.posix.join(dir, match[1]));
        if (target === "src/services" || target.startsWith("src/services/")) return true;
      }
      return false;
    }
  }
};

/** Drops whole-line comments so documentation mentioning process.env does not count. */
function stripComments(source) {
  return source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n");
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "migrations" || entry.name === "models") continue;
      walk(full, out);
    } else if (/\.(c|m)?ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

const offenders = Object.fromEntries(Object.keys(rules).map((name) => [name, []]));
for (const file of walk(srcDir).sort()) {
  const relPath = path.relative(backendDir, file).split(path.sep).join("/");
  const source = fs.readFileSync(file, "utf8");
  for (const [name, rule] of Object.entries(rules)) {
    if (rule.test(relPath, source)) offenders[name].push(relPath);
  }
}

if (process.argv.includes("--list")) {
  process.stdout.write(`${JSON.stringify(offenders, null, 2)}\n`);
  process.exit(0);
}

const failures = Object.entries(offenders).flatMap(([name, files]) =>
  files.map((file) => `[${name}] ${file}: ${rules[name].description}`)
);

if (failures.length > 0) {
  console.error("Architecture check failed:\n");
  for (const line of failures) console.error(`  ${line}`);
  process.exit(1);
}

console.log(`Architecture check passed (${Object.keys(rules).length} rules).`);
