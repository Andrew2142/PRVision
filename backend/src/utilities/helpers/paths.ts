import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Raised when a path would leave the root it must stay inside. Never contains file contents. */
export class PathOutsideRootError extends Error {
  constructor(
    readonly root: string,
    readonly attempted: string
  ) {
    super("Path escapes root");
    this.name = "PathOutsideRootError";
  }
}

/**
 * "~" or "~/x" → homedir-based absolute path. Other inputs are returned unchanged ("~user" is not supported).
 *
 * @param input - Raw path, e.g. from a request body.
 * @param homeDir - Home directory (injectable for tests).
 */
export function expandHome(input: string, homeDir: string = os.homedir()): string {
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/")) {
    return path.join(homeDir, input.slice(2));
  }
  return input;
}

/** Backslashes → "/" (for values coming from tools). Does not resolve. */
export function toPosixPath(input: string): string {
  return input.replace(/\\/g, "/");
}

/**
 * True when `child` (resolved) equals or is inside `parent` (resolved). Lexical only: does not follow symlinks
 * (use isRealPathInside for repository-controlled content).
 */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  if (relative === "") {
    return true;
  }
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/**
 * path.resolve(root, ...segments) and asserts the result stays inside root. Rejects NUL bytes.
 *
 * @throws PathOutsideRootError when the result escapes root or a segment contains NUL.
 */
export function resolveInside(root: string, ...segments: string[]): string {
  const attempted = path.resolve(root, ...segments);
  if (segments.some((segment) => segment.includes("\0")) || root.includes("\0")) {
    throw new PathOutsideRootError(root, attempted);
  }
  if (!isPathInside(root, attempted)) {
    throw new PathOutsideRootError(root, attempted);
  }
  return attempted;
}

/**
 * Normalizes a repo-relative path to POSIX form: strips leading "./", rejects absolute paths, NUL, empty
 * input and any ".." segment.
 *
 * @throws PathOutsideRootError for any rejected input.
 */
export function normalizeRepoRelativePath(input: string): string {
  const posix = toPosixPath(input);
  if (posix.includes("\0") || posix.startsWith("/") || /^[A-Za-z]:\//.test(posix)) {
    throw new PathOutsideRootError(".", input);
  }
  const segments = posix.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) {
    throw new PathOutsideRootError(".", input);
  }
  return segments.join("/");
}

/**
 * Symlink-safe containment: realpath(root) vs the realpath of `candidate`, or of its deepest existing ancestor
 * when `candidate` does not exist yet (a file about to be written). Use it before reading or writing any path
 * that could traverse a symlink created by repository content (worktrees, harness folder, untracked files).
 */
export async function isRealPathInside(root: string, candidate: string): Promise<boolean> {
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(root);
  } catch {
    return false;
  }
  const resolved = path.resolve(candidate);
  if (!isPathInside(root, resolved) && !isPathInside(realRoot, resolved)) {
    return false;
  }
  let current = resolved;
  let suffix = "";
  for (;;) {
    try {
      const real = await fs.promises.realpath(current);
      return isPathInside(realRoot, suffix === "" ? real : path.join(real, suffix));
    } catch (error: unknown) {
      if (!isMissingPathError(error) || (await isSymlink(current))) {
        // A dangling symlink is treated as an escape: its target is outside our control.
        return false;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      suffix = suffix === "" ? path.basename(current) : path.join(path.basename(current), suffix);
      current = parent;
    }
  }
}

/** Synchronous variant of isRealPathInside (used by ArtifactStore.resolveSafe). */
export function isRealPathInsideSync(root: string, candidate: string): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return false;
  }
  const resolved = path.resolve(candidate);
  if (!isPathInside(root, resolved) && !isPathInside(realRoot, resolved)) {
    return false;
  }
  let current = resolved;
  let suffix = "";
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return isPathInside(realRoot, suffix === "" ? real : path.join(real, suffix));
    } catch (error: unknown) {
      if (!isMissingPathError(error) || isSymlinkSync(current)) {
        return false;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return false;
      }
      suffix = suffix === "" ? path.basename(current) : path.join(path.basename(current), suffix);
      current = parent;
    }
  }
}

async function isSymlink(target: string): Promise<boolean> {
  try {
    return (await fs.promises.lstat(target)).isSymbolicLink();
  } catch {
    return false;
  }
}

function isSymlinkSync(target: string): boolean {
  try {
    return fs.lstatSync(target).isSymbolicLink();
  } catch {
    return false;
  }
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}
