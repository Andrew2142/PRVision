/**
 * Creates the PRVision data directory layout (00 §4) with owner-only permissions. Idempotent.
 */
import fs from "node:fs";
import path from "node:path";
import { ARTIFACTS_DIR_NAME, DATA_DIR, FIXTURES_DIR_NAME, WORKTREES_DIR_NAME } from "../src/config-consts";

function main(): void {
  for (const dir of [
    DATA_DIR,
    ...[WORKTREES_DIR_NAME, ARTIFACTS_DIR_NAME, FIXTURES_DIR_NAME].map((name) => path.join(DATA_DIR, name))
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.chmodSync(DATA_DIR, 0o700);
  console.log(`PRVision data dir ready: ${DATA_DIR}`);
}

main();
