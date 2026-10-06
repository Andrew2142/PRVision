#!/usr/bin/env node
// Runs `ng test` in headless Chrome. When CHROME_BIN is unset, points it at the Chromium that
// `npm run setup` installed for the backend through Playwright (02 §6.11). Extra args pass through.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };

if (!env.CHROME_BIN) {
  try {
    const backendRequire = createRequire(path.join(frontendDir, '..', 'backend', 'package.json'));
    const { chromium } = backendRequire('playwright');
    const executable = chromium.executablePath();
    if (fs.existsSync(executable)) env.CHROME_BIN = executable;
  } catch {
    // Fall through: karma-chrome-launcher looks for a system Chrome.
  }
}

const ngBin = path.join(frontendDir, 'node_modules', '@angular', 'cli', 'bin', 'ng.js');
const child = spawn(process.execPath, [ngBin, 'test', '--browsers=ChromeHeadless', ...process.argv.slice(2)], {
  cwd: frontendDir,
  env,
  stdio: 'inherit',
});
child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
