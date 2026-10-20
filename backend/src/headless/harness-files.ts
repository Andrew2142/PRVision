import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { RepositoryFramework, Table } from "../enums";
import { HarnessLibraryStore } from "../services/harness-library/harness-library-store";
import type { HarnessLibraryEntryRecord } from "../types/harness-library";
import { QueryHandler, createLogger } from "../utilities";

/**
 * The harness library as files in the user's repository, so every run (and every teammate) reuses what earlier
 * runs wrote and the harnesses are reviewed like code:
 *
 *   .prvision/harnesses/<component file path>/<export>.json         what PRVision knows about the harness
 *   .prvision/harnesses/<component file path>/<export>.harness.tsx  the harness itself (.ts for Angular)
 *
 * A headless run imports them into its in-memory library before it starts and exports the library after it ends.
 */

export const HARNESSES_DIR = path.join(".prvision", "harnesses");
const META_VERSION = 1;
const log = createLogger("headless.harness_files");

/** The `.json` half of a saved harness. `harnessFile` is null when PRVision could not write a harness. */
interface HarnessMetaFile {
  version: number;
  framework: string;
  filePath: string;
  exportName: string;
  displayName: string;
  selector: string | null;
  sourceFingerprint: string | null;
  harnessFile: string | null;
  mockedModules: unknown[];
  notes: string;
  states: unknown[];
  stateAllowance: number;
  status: string;
  origin: string;
  revision: number;
  lastError: string | null;
  aiModel: string | null;
  writtenAt: string | null;
}

function harnessExtension(framework: string): string {
  return framework === RepositoryFramework.ANGULAR ? ".harness.ts" : ".harness.tsx";
}

/** `default` exports and names are file-safe already; anything else is reduced to letters, digits, - and _. */
function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "_") || "_";
}

/** The folder for one component: its repo-relative path, refused if it tries to leave `.prvision/harnesses`. */
function componentDir(root: string, filePath: string): string | null {
  const dir = path.resolve(root, ...filePath.split("/"));
  return dir.startsWith(`${path.resolve(root)}${path.sep}`) ? dir : null;
}

export async function exportHarnesses(repositoryId: number, repoRoot: string): Promise<number> {
  const root = path.join(repoRoot, HARNESSES_DIR);
  const entries = await new HarnessLibraryStore().listForRepository(repositoryId);
  let written = 0;
  for (const entry of entries) {
    const dir = componentDir(root, entry.filePath);
    if (dir === null) {
      continue;
    }
    await mkdir(dir, { recursive: true });
    const base = safeName(entry.exportName);
    const harnessFile = entry.harnessSource === null ? null : `${base}${harnessExtension(entry.framework)}`;
    if (harnessFile !== null && entry.harnessSource !== null) {
      await writeFile(path.join(dir, harnessFile), entry.harnessSource);
    }
    await writeFile(path.join(dir, `${base}.json`), `${JSON.stringify(toMeta(entry, harnessFile), null, 2)}\n`);
    written += 1;
  }
  return written;
}

function toMeta(entry: HarnessLibraryEntryRecord, harnessFile: string | null): HarnessMetaFile {
  return {
    version: META_VERSION,
    framework: entry.framework,
    filePath: entry.filePath,
    exportName: entry.exportName,
    displayName: entry.displayName,
    selector: entry.selector,
    sourceFingerprint: entry.sourceFingerprint,
    harnessFile,
    mockedModules: entry.mockedModules,
    notes: entry.notes,
    states: entry.states,
    stateAllowance: entry.stateAllowance,
    status: entry.status,
    origin: entry.origin,
    revision: entry.revision,
    lastError: entry.lastError,
    aiModel: entry.aiModel,
    writtenAt: entry.writtenAt === null ? null : entry.writtenAt.toISOString()
  };
}

async function listJsonFiles(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(".json")).map((name) => path.join(dir, name));
}

/** Loads every saved harness of the repository into the (empty) library of this run. */
export async function importHarnesses(repositoryId: number, framework: string, repoRoot: string): Promise<number> {
  const root = path.join(repoRoot, HARNESSES_DIR);
  const handler = new QueryHandler();
  let imported = 0;
  for (const file of await listJsonFiles(root)) {
    try {
      const meta = JSON.parse(await readFile(file, "utf8")) as HarnessMetaFile;
      if (meta.version !== META_VERSION || meta.framework !== framework) {
        continue;
      }
      const harnessSource =
        meta.harnessFile === null ? null : await readFile(path.join(path.dirname(file), meta.harnessFile), "utf8");
      const inserted = await handler.insert(
        {
          repositoryId,
          framework: meta.framework,
          filePath: meta.filePath,
          exportName: meta.exportName,
          displayName: meta.displayName,
          selector: meta.selector,
          sourceFingerprint: meta.sourceFingerprint,
          harnessSource,
          mockedModules: meta.mockedModules,
          notes: meta.notes,
          states: meta.states,
          stateCount: harnessSource === null ? 0 : meta.states.length,
          stateAllowance: meta.stateAllowance,
          status: meta.status,
          origin: meta.origin,
          revision: meta.revision,
          lastError: meta.lastError,
          aiModel: meta.aiModel,
          writtenAt: meta.writtenAt === null ? null : new Date(meta.writtenAt)
        },
        Table.HARNESS_LIBRARY_ENTRIES
      );
      if (inserted.status === 200) {
        imported += 1;
      } else {
        log.warn({ event: "headless.harness.import_rejected", file, status: inserted.status }, "Skipped");
      }
    } catch (error: unknown) {
      log.warn({ event: "headless.harness.import_failed", file, err: error }, "Could not read a saved harness");
    }
  }
  return imported;
}
