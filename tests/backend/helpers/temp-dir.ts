/**
 * Temp directories for tests (sheet 14 §5.4.5). Every directory lives under os.tmpdir() with the
 * "prvision-test-" prefix, so setup.ts sweeps leftovers of crashed runs.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";

/** Creates `prvision-test-<label>-*` under os.tmpdir(); `cleanup` removes it (kept when PRVISION_KEEP_TEST_ARTIFACTS=1). */
export function makeTempDir(label = "dir"): { path: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `prvision-test-${label}-`));
  return {
    path: fs.realpathSync(dir), // macOS: /var -> /private/var; keeps path assertions stable
    cleanup: () => {
      if (process.env.PRVISION_KEEP_TEST_ARTIFACTS === "1") {
        return;
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Creates a fresh, empty data dir for one test and removes it in t.after. It does NOT touch process.env:
 * DATA_DIR is fixed at import (00 §14.12). Pass the path to the code under test, e.g. `new ArtifactStore(dir)`.
 */
export function useTempDataDir(t: TestContext): string {
  const temp = makeTempDir("data");
  t.after(() => {
    temp.cleanup();
  });
  return temp.path;
}
