import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ARTIFACTS_DIR_NAME, DATA_DIR, FIXTURES_DIR_NAME, WORKTREES_DIR_NAME } from "../../config-consts";
import type { WorktreeSide } from "../../types/visualization-pipeline";
import { isPathInside, isRealPathInside, isRealPathInsideSync } from "../helpers/paths";

export type ArtifactImageKind = "base" | "head" | "diff";

/** Raised for any path that is malformed or would leave the data dir. */
export class ArtifactPathError extends Error {
  constructor(
    message: string,
    readonly attemptedPath: string
  ) {
    super(message);
    this.name = "ArtifactPathError";
  }
}

const DIR_MODE = 0o700;
const IMAGE_KINDS: readonly string[] = ["base", "head", "diff"];
/**
 * "artifacts/<v>/<c>/<kind>.png" (state ordinal 0) or "artifacts/<v>/<c>/s<ordinal>/<kind>.png" (ordinals 1–9):
 * the only shapes stored in *_image_path (00 §14.3, 16 §6.14).
 */
const RELATIVE_IMAGE_PATH = /^artifacts\/([1-9]\d{0,15})\/([1-9]\d{0,15})\/(?:s([1-9])\/)?(base|head|diff)\.png$/;
/** Highest state ordinal (16 §6.6: ordinals 0–9; MAX_STATE_ORDINALS = 10). */
const MAX_STATE_ORDINAL = 9;

/**
 * Owns the data-dir layout of 00 §4. Paths stored in the DB are relative to the data dir and POSIX
 * (`artifacts/12/345/base.png`, 00 §14.3); absolute paths never leave the backend. Every filesystem access goes
 * through resolveSafe (lexical + realpath containment) or resolveInside + isRealPathInside.
 */
export class ArtifactStore {
  /** @param dataDir - Absolute data dir (DATA_DIR by default). Read by 06 to refuse registering a folder inside it. */
  constructor(readonly dataDir: string = DATA_DIR) {
    if (!path.isAbsolute(dataDir)) {
      throw new ArtifactPathError("Data dir must be absolute", dataDir);
    }
  }

  // ----- roots -----

  /** Absolute <dataDir>/artifacts (the /artifacts static root). */
  artifactsRoot(): string {
    return path.join(this.dataDir, ARTIFACTS_DIR_NAME);
  }

  /** Absolute <dataDir>/worktrees. */
  worktreesRoot(): string {
    return path.join(this.dataDir, WORKTREES_DIR_NAME);
  }

  /** Absolute <dataDir>/fixtures. */
  fixturesRoot(): string {
    return path.join(this.dataDir, FIXTURES_DIR_NAME);
  }

  /** mkdir -p dataDir (mode 0o700, chmod 0o700 if it already existed), artifacts, worktrees, fixtures. */
  async ensureRoots(): Promise<void> {
    await fs.mkdir(this.dataDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(this.dataDir, DIR_MODE);
    for (const root of [this.artifactsRoot(), this.worktreesRoot(), this.fixturesRoot()]) {
      await fs.mkdir(root, { recursive: true, mode: DIR_MODE });
    }
  }

  // ----- path builders (pure) -----

  /** "artifacts/<v>/<c>/<kind>.png": the value stored in *_image_path and RenderSideResult.imagePath. */
  componentImagePath(visualizationId: number, componentId: number, kind: ArtifactImageKind): string {
    assertId(visualizationId, "visualizationId");
    assertId(componentId, "componentId");
    if (!IMAGE_KINDS.includes(kind)) {
      throw new ArtifactPathError("Invalid artifact kind", kind);
    }
    return `${ARTIFACTS_DIR_NAME}/${visualizationId}/${componentId}/${kind}.png`;
  }

  /**
   * State image path (16 §6.14): "artifacts/<v>/<c>/<kind>.png" for ordinal 0 (unchanged, the Default state) and
   * "artifacts/<v>/<c>/s<ordinal>/<kind>.png" for ordinals 1–9.
   *
   * @throws ArtifactPathError for an ordinal outside 0–9, an invalid id or kind.
   */
  componentStateImagePath(
    visualizationId: number,
    componentId: number,
    ordinal: number,
    kind: ArtifactImageKind
  ): string {
    assertOrdinal(ordinal);
    const defaultPath = this.componentImagePath(visualizationId, componentId, kind);
    return ordinal === 0
      ? defaultPath
      : `${ARTIFACTS_DIR_NAME}/${visualizationId}/${componentId}/${stateDirName(ordinal)}/${kind}.png`;
  }

  /** Absolute <dataDir>/artifacts/<v>/<c>. */
  componentDir(visualizationId: number, componentId: number): string {
    assertId(componentId, "componentId");
    return path.join(this.visualizationArtifactsDir(visualizationId), String(componentId));
  }

  /** Absolute <dataDir>/artifacts/<v>. */
  visualizationArtifactsDir(visualizationId: number): string {
    assertId(visualizationId, "visualizationId");
    return path.join(this.artifactsRoot(), String(visualizationId));
  }

  /** Absolute <dataDir>/worktrees/<v> (07). */
  visualizationWorktreeRoot(visualizationId: number): string {
    assertId(visualizationId, "visualizationId");
    return path.join(this.worktreesRoot(), String(visualizationId));
  }

  /** Absolute <dataDir>/worktrees/<v>/<side> (07). */
  worktreeDir(visualizationId: number, side: WorktreeSide): string {
    return path.join(this.visualizationWorktreeRoot(visualizationId), side);
  }

  // ----- safe resolution -----

  /**
   * dataDir-relative POSIX path → absolute path. Throws ArtifactPathError on absolute input, NUL, backslash, a
   * `..` segment, a lexical escape, or a symlink anywhere on the path that resolves outside the data dir.
   */
  resolveSafe(relativePath: string): string {
    if (
      relativePath === "" ||
      relativePath.includes("\0") ||
      relativePath.includes("\\") ||
      path.isAbsolute(relativePath) ||
      relativePath.startsWith("/") ||
      relativePath.split("/").some((segment) => segment === "..")
    ) {
      throw new ArtifactPathError("Invalid data-dir relative path", relativePath);
    }
    const absolute = path.resolve(this.dataDir, relativePath);
    if (!isPathInside(this.dataDir, absolute) || absolute === path.resolve(this.dataDir)) {
      throw new ArtifactPathError("Path escapes the data dir", relativePath);
    }
    if (!isRealPathInsideSync(this.dataDir, absolute)) {
      throw new ArtifactPathError("Path resolves outside the data dir", relativePath);
    }
    return absolute;
  }

  // ----- I/O -----

  /** mkdir -p <dataDir>/artifacts/<v>/<c> (mode 0o700). */
  async ensureComponentDir(visualizationId: number, componentId: number): Promise<void> {
    await this.ensureDir(this.componentDir(visualizationId, componentId));
  }

  /** mkdir -p of the component dir and, for ordinal > 0, its s<ordinal> subfolder (16 §6.14). */
  async ensureComponentStateDir(visualizationId: number, componentId: number, ordinal: number): Promise<void> {
    assertOrdinal(ordinal);
    const componentDir = this.componentDir(visualizationId, componentId);
    await this.ensureDir(ordinal === 0 ? componentDir : path.join(componentDir, stateDirName(ordinal)));
  }

  /** Reads a dataDir-relative file. Missing file → the fs ENOENT error (callers check `code === "ENOENT"`). */
  async read(relativePath: string): Promise<Buffer> {
    return fs.readFile(this.resolveSafe(relativePath));
  }

  /**
   * Atomic write: parent dirs are created, data goes to "<file>.<pid>.<random>.tmp" in the same directory, then
   * rename. Never follows a symlink at the destination (rename replaces the link itself).
   *
   * @returns relativePath.
   */
  async write(relativePath: string, data: Buffer | string): Promise<string> {
    const target = this.resolveSafe(relativePath);
    await this.ensureDir(path.dirname(target));
    const tempPath = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await fs.writeFile(tempPath, data, { mode: 0o600, flag: "wx" });
      await fs.rename(tempPath, target);
    } catch (error: unknown) {
      await fs.rm(tempPath, { force: true });
      throw error;
    }
    return relativePath;
  }

  /** True when the dataDir-relative path exists. */
  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolveSafe(relativePath));
      return true;
    } catch (error: unknown) {
      if (error instanceof ArtifactPathError) {
        throw error;
      }
      return false;
    }
  }

  /** rm -rf <dataDir>/artifacts/<v>; no error when missing. Never follows symlinks. */
  async removeVisualization(visualizationId: number): Promise<void> {
    await fs.rm(this.visualizationArtifactsDir(visualizationId), { recursive: true, force: true });
  }

  /** @deprecated Alias of removeVisualization (00 §14.12). New code calls removeVisualization. */
  async removeVisualizationArtifacts(visualizationId: number): Promise<void> {
    await this.removeVisualization(visualizationId);
  }

  /** mkdir -p for an absolute directory that must be inside the data dir (07). */
  async ensureDir(absoluteDir: string): Promise<void> {
    if (!path.isAbsolute(absoluteDir) || absoluteDir.includes("\0") || !isPathInside(this.dataDir, absoluteDir)) {
      throw new ArtifactPathError("Directory is outside the data dir", absoluteDir);
    }
    if (!(await isRealPathInside(this.dataDir, absoluteDir))) {
      throw new ArtifactPathError("Directory resolves outside the data dir", absoluteDir);
    }
    await fs.mkdir(absoluteDir, { recursive: true, mode: DIR_MODE });
  }

  /** rm -rf <dataDir>/worktrees/<v>. Call only after GitClient.worktreeRemove + worktreePrune (07). */
  async removeVisualizationWorktreeRoot(visualizationId: number): Promise<void> {
    await fs.rm(this.visualizationWorktreeRoot(visualizationId), { recursive: true, force: true });
  }

  // ----- public URLs -----

  /**
   * "artifacts/12/345/base.png" → "/artifacts/12/345/base.png" (also "artifacts/12/345/s2/base.png", 16 §6.14);
   * null → null; any other shape → ArtifactPathError.
   */
  toPublicUrl(relativePath: string | null): string | null {
    if (relativePath === null) {
      return null;
    }
    if (!RELATIVE_IMAGE_PATH.test(relativePath)) {
      throw new ArtifactPathError("Not an artifact image path", relativePath);
    }
    return `/${relativePath}`;
  }
}

function assertOrdinal(ordinal: number): void {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0 || ordinal > MAX_STATE_ORDINAL) {
    throw new ArtifactPathError("Invalid state ordinal", String(ordinal));
  }
}

/** "s<ordinal>": the per-state folder of ordinals 1–9. */
function stateDirName(ordinal: number): string {
  return `s${String(ordinal)}`;
}

function assertId(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ArtifactPathError(`Invalid ${what}`, String(value));
  }
}
