import path from "node:path";
import {
  CHILD_PROCESS_BASE_ENV,
  DATA_DIR,
  GIT_BINARY,
  GIT_DEFAULT_TIMEOUT_MS,
  GIT_FETCH_TIMEOUT_MS,
  GIT_MAX_BUFFER_BYTES,
  GIT_MIN_VERSION,
  GIT_REF_NAMESPACE,
  GIT_WORKTREE_TIMEOUT_MS,
  WORKTREES_DIR_NAME
} from "../../config-consts";
import { isPathInside, normalizeRepoRelativePath } from "../helpers/paths";
import { ProcessError, runProcess, type ProcessResult } from "../helpers/process";
import { createLogger, redactSecrets } from "../loggers/logger";

const log = createLogger("git");

/** Top-level options placed before the subcommand of every invocation (04 §9.5). */
export const GIT_SAFE_ARGS: readonly string[] = [
  "-c",
  "core.hooksPath=/dev/null", // never run the user's hooks (post-checkout runs on worktree add)
  "-c",
  "core.fsmonitor=false", // fsmonitor can execute a configured program
  "-c",
  "core.quotepath=false", // UTF-8 paths unescaped
  "-c",
  "color.ui=never",
  "-c",
  "advice.detachedHead=false",
  "-c",
  "gc.auto=0", // no background gc in the user's repo
  "-c",
  "maintenance.auto=false",
  "-c",
  "credential.helper=", // no credential helpers (keychain prompts, stored creds); 00 §14.8
  "-c",
  "protocol.ext.allow=never", // ext:: remotes run arbitrary commands
  "-c",
  "filter.lfs.required=false", // LFS pointers stay pointers (with GIT_LFS_SKIP_SMUDGE) even without git-lfs
  "-c",
  "submodule.recurse=false",
  "--no-pager"
];

/** Environment added to CHILD_PROCESS_BASE_ENV for every git child. */
export const GIT_ENV: Readonly<Record<string, string>> = Object.freeze({
  GIT_TERMINAL_PROMPT: "0", // fail instead of prompting for credentials
  GCM_INTERACTIVE: "never",
  GIT_LFS_SKIP_SMUDGE: "1", // no LFS downloads into worktrees
  GIT_OPTIONAL_LOCKS: "0", // status/diff never take index.lock in the user's repo
  LC_ALL: "C",
  LANG: "C", // stable stderr for error mapping
  GIT_PAGER: "cat",
  PAGER: "cat"
});

/** Options of diff commands that make user-configured programs (external diff, textconv) inert. */
const DIFF_SAFE_ARGS = ["--no-ext-diff", "--no-textconv", "--no-color"] as const;
const STDERR_LOG_MAX_CHARS = 2_000;
const STDERR_KEEP_MAX_CHARS = 4_000;
const SHOW_FILE_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export type GitErrorCode =
  | "git_not_found"
  | "unsupported_version"
  | "not_a_repository"
  | "unknown_revision"
  | "no_merge_base"
  | "auth_failed"
  | "network"
  | "worktree_exists"
  | "patch_failed"
  | "invalid_argument"
  | "timeout"
  | "aborted"
  | "output_too_large"
  | "command_failed";

/** Every git failure. `stderr` is redacted and truncated; the message never contains argv or output. */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly code: GitErrorCode,
    readonly subcommand: string,
    readonly exitCode: number | null,
    readonly stderr: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "GitCommandError";
  }
}

/** One `--name-status -z` record, uninterpreted (08 maps it to 00 §8 changedFiles). */
export interface GitNameStatusEntry {
  /** First letter of git's status column. */
  status: "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X";
  /** R/C similarity, e.g. 87. */
  score?: number;
  /** New path (R/C) or the only path, as git printed it. */
  path: string;
  /** R/C only. */
  previousPath?: string;
}

/** One commit of `logCommits` (00 §16 CommitView source). */
export interface GitCommitEntry {
  sha: string;
  /** First parent (`%P`, first token); null for a root commit (00 §16.1). */
  parentSha: string | null;
  /** True when the commit has more than one parent. */
  isMerge: boolean;
  subject: string;
  authorName: string;
  /** Committer date, strict ISO 8601 with the committer's offset (`%cI`). */
  committedAt: string;
}

/** One `status --porcelain=v1 -z` record. */
export interface GitStatusEntry {
  index: string;
  worktree: string;
  path: string;
  originalPath?: string;
}

export interface GitVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

/** e.g. `{ urlPrefix: "https://github.com/", header: "AUTHORIZATION: basic <b64>" }` (built by 06). */
export interface GitAuthHeader {
  urlPrefix: string;
  header: string;
}

export interface GitCallOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface RunOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  input?: string;
  env?: Record<string, string>;
  allowedExitCodes?: readonly number[];
  signal?: AbortSignal;
  /** Extra `-c key=value` pairs placed before `-C` (after GIT_SAFE_ARGS). */
  configArgs?: readonly string[];
}

const STDERR_PATTERNS: ReadonlyArray<[RegExp, GitErrorCode]> = [
  [/not a git repository|cannot change to/i, "not_a_repository"],
  [
    /authentication failed|could not read username|terminal prompts disabled|invalid username or password|\b40[13]\b|permission denied \(publickey\)/i,
    "auth_failed"
  ],
  [
    /could not resolve host|failed to connect|connection (timed out|refused)|network is unreachable|unable to access/i,
    "network"
  ],
  [
    /couldn't find remote ref|unknown revision|bad revision|invalid object name|not a valid (object|commit) name|needed a single revision|ambiguous argument/i,
    "unknown_revision"
  ],
  [/already exists|is a missing but already registered worktree/i, "worktree_exists"]
];

/**
 * Maps a runProcess failure to a GitCommandError (redacted, truncated stderr).
 *
 * @param error - What the runner threw.
 * @param subcommand - git subcommand, e.g. "fetch".
 */
export function toGitCommandError(error: unknown, subcommand: string): GitCommandError {
  if (!(error instanceof ProcessError)) {
    return new GitCommandError(`git ${subcommand} failed`, "command_failed", subcommand, null, "", { cause: error });
  }
  const stderr = redactSecrets(error.stderr).slice(0, STDERR_KEEP_MAX_CHARS);
  const code: GitErrorCode =
    error.kind === "spawn_failed"
      ? "git_not_found"
      : error.kind === "timeout"
        ? "timeout"
        : error.kind === "aborted"
          ? "aborted"
          : error.kind === "max_buffer"
            ? "output_too_large"
            : subcommand === "apply"
              ? "patch_failed"
              : (STDERR_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "command_failed");
  return new GitCommandError(`git ${subcommand} failed (${code})`, code, subcommand, error.exitCode, stderr, {
    cause: error
  });
}

const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[A-Za-z0-9._/+-]{1,255}(\^\{commit\})?$/;
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const REMOTE_NAME = /^(?!-)[A-Za-z0-9._-]{1,100}$/;

/**
 * Validates a ref/revision argument before it reaches git.
 *
 * @throws GitCommandError("invalid_argument") for anything that could be an option, a range or a reflog query.
 */
export function assertSafeRef(ref: string): void {
  if (!SAFE_REF.test(ref) || ref.endsWith(".lock") || ref.endsWith("/")) {
    throw invalidArgument("ref");
  }
}

function invalidArgument(what: string): GitCommandError {
  return new GitCommandError(`git invalid argument (${what})`, "invalid_argument", "validate", null, "");
}

function assertAbsolutePath(value: string, what: string): void {
  if (value.includes("\0") || !path.isAbsolute(value)) {
    throw invalidArgument(what);
  }
}

function assertSafeRefspec(refspec: string): void {
  const body = refspec.startsWith("+") ? refspec.slice(1) : refspec;
  const [src, dst, ...rest] = body.split(":");
  if (src === undefined || dst === undefined || rest.length > 0) {
    throw invalidArgument("refspec");
  }
  assertSafeRef(src);
  assertSafeRef(dst);
  if (!dst.startsWith(`${GIT_REF_NAMESPACE}/`) && !dst.startsWith("refs/remotes/")) {
    throw invalidArgument("refspec destination");
  }
}

function assertSafeRemote(remote: string): void {
  if (REMOTE_NAME.test(remote)) {
    return;
  }
  let url: URL;
  try {
    url = new URL(remote);
  } catch {
    throw invalidArgument("remote");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw invalidArgument("remote");
  }
}

function splitZ(stdout: string): string[] {
  const tokens = stdout.split("\0");
  if (tokens.length > 0 && tokens[tokens.length - 1] === "") {
    tokens.pop();
  }
  return tokens;
}

function splitLines(stdout: string): string[] {
  return stdout.split("\n").filter((line) => line.trim() !== "");
}

const NAME_STATUS_LETTERS = new Set(["A", "M", "D", "R", "C", "T", "U", "X"]);

/** Parses `diff --name-status -z` output (pure). */
export function parseNameStatusZ(stdout: string): GitNameStatusEntry[] {
  const tokens = splitZ(stdout);
  const entries: GitNameStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusToken = tokens[index] ?? "";
    index += 1;
    const letter = statusToken.charAt(0);
    if (!NAME_STATUS_LETTERS.has(letter)) {
      throw new GitCommandError("git diff output not understood", "command_failed", "diff", null, "");
    }
    const status = letter as GitNameStatusEntry["status"];
    if (status === "R" || status === "C") {
      const previousPath = tokens[index];
      const newPath = tokens[index + 1];
      index += 2;
      if (previousPath === undefined || newPath === undefined) {
        throw new GitCommandError("git diff output not understood", "command_failed", "diff", null, "");
      }
      const score = Number(statusToken.slice(1));
      entries.push({
        status,
        ...(statusToken.length > 1 && Number.isFinite(score) ? { score } : {}),
        path: newPath,
        previousPath
      });
      continue;
    }
    const filePath = tokens[index];
    index += 1;
    if (filePath === undefined) {
      throw new GitCommandError("git diff output not understood", "command_failed", "diff", null, "");
    }
    entries.push({ status, path: filePath });
  }
  return entries;
}

/** Parses `status --porcelain=v1 -z` output (pure). */
export function parseStatusPorcelainZ(stdout: string): GitStatusEntry[] {
  const tokens = splitZ(stdout);
  const entries: GitStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const record = tokens[index] ?? "";
    index += 1;
    if (record.length < 4) {
      continue;
    }
    const indexStatus = record.charAt(0);
    const entry: GitStatusEntry = { index: indexStatus, worktree: record.charAt(1), path: record.slice(3) };
    if (indexStatus === "R" || indexStatus === "C") {
      const originalPath = tokens[index];
      index += 1;
      if (originalPath !== undefined) {
        entry.originalPath = originalPath;
      }
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * `git log` format of logCommits: sha, parent shas (space separated, empty for a root commit), subject, author name,
 * committer date; NUL between fields, RS after each.
 */
const LOG_COMMIT_FORMAT = "%H%x00%P%x00%s%x00%an%x00%cI%x1e";
const LOG_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Parses logCommits output (pure). `parentSha` is the first token of `%P` (the first parent), or null for a root
 * commit; `isMerge` is true for more than one parent.
 *
 * @throws GitCommandError("command_failed") for a record that is not sha, parents, subject, author and date.
 */
export function parseLogCommits(stdout: string): GitCommitEntry[] {
  const malformed = (): GitCommandError =>
    new GitCommandError("git log output not understood", "command_failed", "log", null, "");
  return stdout
    .split("\x1e")
    .map((record) => record.replace(/^\r?\n/, ""))
    .filter((record) => record !== "")
    .map((record) => {
      const [sha, parents, subject, authorName, committedAt, ...rest] = record.split("\0");
      if (
        sha === undefined ||
        parents === undefined ||
        subject === undefined ||
        authorName === undefined ||
        committedAt === undefined ||
        rest.length > 0 ||
        !LOG_SHA.test(sha)
      ) {
        throw malformed();
      }
      const parentShas = parents.trim() === "" ? [] : parents.trim().split(/\s+/);
      if (!parentShas.every((parent) => LOG_SHA.test(parent))) {
        throw malformed();
      }
      return {
        sha,
        parentSha: parentShas[0] ?? null,
        isMerge: parentShas.length > 1,
        subject,
        authorName,
        committedAt: committedAt.trim()
      };
    });
}

/** Parses `worktree list --porcelain -z` output into absolute worktree dirs (pure). */
export function parseWorktreeListZ(stdout: string): string[] {
  return stdout
    .split("\0")
    .filter((token) => token.startsWith("worktree "))
    .map((token) => token.slice("worktree ".length));
}

/**
 * Parses `git --version` output (pure). Tolerates suffixes like ".windows.1" or "(Apple Git-146)".
 *
 * @throws GitCommandError("command_failed") when no version number is present.
 */
export function parseGitVersion(raw: string): GitVersion {
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw);
  if (!match) {
    throw new GitCommandError("git version not understood", "command_failed", "--version", null, "");
  }
  return {
    raw: raw.trim(),
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] === undefined ? 0 : Number(match[3])
  };
}

function compareVersions(a: GitVersion, b: GitVersion): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * All git access in PRVision (04 §9.5): argv only, hardened config on every call, allow-listed environment,
 * validated refs after `--end-of-options`, paths after `--`, timeouts, abort support and error mapping to
 * GitCommandError. Commands run with `-C <cwd>`; the spawn cwd is the data dir.
 */
export class GitClient {
  constructor(private readonly options: { binary?: string; runner?: typeof runProcess } = {}) {}

  /** `git --version`. ENOENT → git_not_found. */
  async version(options: GitCallOptions = {}): Promise<GitVersion> {
    const result = await this.run(null, ["--version"], { ...options });
    return parseGitVersion(result.stdout);
  }

  /** Throws GitCommandError("unsupported_version") when git is older than GIT_MIN_VERSION (00 §14.1). */
  async assertSupportedVersion(options: GitCallOptions = {}): Promise<void> {
    const current = await this.version(options);
    if (compareVersions(current, parseGitVersion(GIT_MIN_VERSION)) < 0) {
      throw new GitCommandError(
        `git ${current.major}.${current.minor}.${current.patch} is older than ${GIT_MIN_VERSION}`,
        "unsupported_version",
        "--version",
        null,
        ""
      );
    }
  }

  /** True when `repoPath` is inside a git work tree; false for a plain or missing directory. */
  async isRepository(repoPath: string, options: GitCallOptions = {}): Promise<boolean> {
    assertAbsolutePath(repoPath, "path");
    try {
      const result = await this.run(repoPath, ["rev-parse", "--is-inside-work-tree"], { ...options, quiet: true });
      return result.stdout.trim() === "true";
    } catch (error: unknown) {
      if (error instanceof GitCommandError && error.code === "not_a_repository") {
        return false;
      }
      throw error;
    }
  }

  /** Absolute top-level directory of the repository containing `repoPath`. */
  async topLevel(repoPath: string, options: GitCallOptions = {}): Promise<string> {
    assertAbsolutePath(repoPath, "path");
    const result = await this.run(repoPath, ["rev-parse", "--show-toplevel"], options);
    return result.stdout.trim();
  }

  /** Full commit sha of `rev`. Unknown → GitCommandError("unknown_revision"). */
  async revParse(cwd: string, rev: string, options: GitCallOptions = {}): Promise<string> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(rev);
    const commitRev = rev.endsWith("^{commit}") ? rev : `${rev}^{commit}`;
    const result = await this.run(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", commitRev], {
      ...options,
      allowedExitCodes: [0, 1]
    });
    if (result.exitCode === 1) {
      throw this.logged(
        new GitCommandError("git rev-parse failed (unknown_revision)", "unknown_revision", "rev-parse", 1, "")
      );
    }
    return result.stdout.trim();
  }

  /** True when `sha` names a commit present in the repository. */
  async hasCommit(cwd: string, sha: string, options: GitCallOptions = {}): Promise<boolean> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(sha);
    const result = await this.run(cwd, ["cat-file", "-e", "--end-of-options", `${sha}^{commit}`], {
      ...options,
      allowedExitCodes: [0, 1, 128]
    });
    return result.exitCode === 0;
  }

  /** Merge base of `a` and `b`. None → GitCommandError("no_merge_base"). */
  async mergeBase(cwd: string, a: string, b: string, options: GitCallOptions = {}): Promise<string> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(a);
    assertSafeRef(b);
    const result = await this.run(cwd, ["merge-base", "--end-of-options", a, b], {
      ...options,
      allowedExitCodes: [0, 1]
    });
    if (result.exitCode === 1) {
      throw this.logged(
        new GitCommandError("git merge-base failed (no_merge_base)", "no_merge_base", "merge-base", 1, "")
      );
    }
    return result.stdout.trim();
  }

  /**
   * Fetches refspecs without writing FETCH_HEAD. The auth header travels in the child's environment
   * (GIT_CONFIG_*), scoped to `auth.urlPrefix`, never in argv or the URL.
   */
  async fetch(
    cwd: string,
    request: { remote: string; refspecs: readonly string[]; auth?: GitAuthHeader; depth?: number },
    options: GitCallOptions = {}
  ): Promise<void> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRemote(request.remote);
    if (request.refspecs.length === 0) {
      throw invalidArgument("refspecs");
    }
    request.refspecs.forEach(assertSafeRefspec);
    const args = [
      "fetch",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      "--no-auto-maintenance",
      "--quiet"
    ];
    if (request.depth !== undefined) {
      if (!Number.isSafeInteger(request.depth) || request.depth <= 0) {
        throw invalidArgument("depth");
      }
      args.push(`--depth=${request.depth}`);
    }
    args.push("--end-of-options", request.remote, ...request.refspecs);
    const env: Record<string, string> = {};
    if (request.auth) {
      const prefix = request.auth.urlPrefix;
      if (prefix.includes("\n") || request.auth.header.includes("\n") || !prefix.startsWith("https://")) {
        throw invalidArgument("auth");
      }
      env.GIT_CONFIG_COUNT = "1";
      env.GIT_CONFIG_KEY_0 = `http.${prefix}.extraHeader`;
      env.GIT_CONFIG_VALUE_0 = request.auth.header;
    }
    await this.run(cwd, args, { ...options, timeoutMs: options.timeoutMs ?? GIT_FETCH_TIMEOUT_MS, env });
  }

  /** Deletes a ref under refs/prvision/ (idempotent: a missing ref is success). */
  async deleteRef(cwd: string, ref: string, options: GitCallOptions = {}): Promise<void> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(ref);
    if (!ref.startsWith(`${GIT_REF_NAMESPACE}/`)) {
      throw invalidArgument("ref namespace");
    }
    const result = await this.run(cwd, ["update-ref", "-d", "--end-of-options", ref], {
      ...options,
      allowedExitCodes: [0, 1, 128]
    });
    if (result.exitCode !== 0 && !/not exist|unable to resolve|cannot lock ref/i.test(result.stderr)) {
      throw this.logged(this.exitError("update-ref", result));
    }
  }

  /** `worktree add --detach` of a full sha into a directory inside <dataDir>/worktrees/. */
  async worktreeAdd(repoPath: string, dir: string, sha: string, options: GitCallOptions = {}): Promise<void> {
    assertAbsolutePath(repoPath, "path");
    assertAbsolutePath(dir, "dir");
    if (!FULL_SHA.test(sha)) {
      throw invalidArgument("sha");
    }
    const worktreesRoot = path.join(DATA_DIR, WORKTREES_DIR_NAME);
    if (!isPathInside(worktreesRoot, dir) || path.resolve(dir) === path.resolve(worktreesRoot)) {
      throw invalidArgument("dir");
    }
    await this.run(repoPath, ["worktree", "add", "--detach", "--quiet", dir, sha], {
      ...options,
      timeoutMs: options.timeoutMs ?? GIT_WORKTREE_TIMEOUT_MS
    });
  }

  /** `worktree remove --force --force` (idempotent: an unknown or missing worktree is success). */
  async worktreeRemove(repoPath: string, dir: string, options: GitCallOptions = {}): Promise<void> {
    assertAbsolutePath(repoPath, "path");
    assertAbsolutePath(dir, "dir");
    const result = await this.run(repoPath, ["worktree", "remove", "--force", "--force", dir], {
      ...options,
      timeoutMs: options.timeoutMs ?? GIT_WORKTREE_TIMEOUT_MS,
      allowedExitCodes: [0, 128]
    });
    if (result.exitCode !== 0 && !/is not a working tree|no such file/i.test(result.stderr)) {
      throw this.logged(this.exitError("worktree", result));
    }
  }

  /** `worktree prune`. */
  async worktreePrune(repoPath: string, options: GitCallOptions = {}): Promise<void> {
    assertAbsolutePath(repoPath, "path");
    await this.run(repoPath, ["worktree", "prune"], options);
  }

  /** Absolute directories of every worktree of the repository (main worktree first). */
  async worktreeList(repoPath: string, options: GitCallOptions = {}): Promise<string[]> {
    assertAbsolutePath(repoPath, "path");
    const result = await this.run(repoPath, ["worktree", "list", "--porcelain", "-z"], options);
    return parseWorktreeListZ(result.stdout);
  }

  /** Name-status diff of `from` against `to` (or the working tree when `to` is null). */
  async diffNameStatus(
    cwd: string,
    from: string,
    to: string | null,
    diffOptions: { renames?: boolean; pathspecs?: readonly string[] } = {},
    options: GitCallOptions = {}
  ): Promise<GitNameStatusEntry[]> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(from);
    if (to !== null) {
      assertSafeRef(to);
    }
    const pathspecs = (diffOptions.pathspecs ?? []).map(normalizeRepoRelativePathArg);
    const args = [
      "diff",
      "--name-status",
      "-z",
      diffOptions.renames === false ? "--no-renames" : "-M",
      ...DIFF_SAFE_ARGS,
      "--end-of-options",
      from,
      ...(to === null ? [] : [to]),
      "--",
      ...pathspecs
    ];
    const result = await this.run(cwd, args, options);
    return parseNameStatusZ(result.stdout);
  }

  /**
   * Name-status diff of two directories (`git diff --no-index`). Paths are returned exactly as git prints them
   * (prefixed with left/ and right/); exit code 1 ("differences found") is success.
   */
  async diffNameStatusNoIndex(
    cwd: string,
    left: string,
    right: string,
    diffOptions: { renames?: boolean } = {},
    options: GitCallOptions = {}
  ): Promise<GitNameStatusEntry[]> {
    assertAbsolutePath(cwd, "cwd");
    const args = [
      "diff",
      "--no-index",
      "--name-status",
      "-z",
      diffOptions.renames === false ? "--no-renames" : "-M",
      ...DIFF_SAFE_ARGS,
      "--",
      normalizeRepoRelativePathArg(left),
      normalizeRepoRelativePathArg(right)
    ];
    const result = await this.run(cwd, args, { ...options, allowedExitCodes: [0, 1] });
    return parseNameStatusZ(result.stdout);
  }

  /** Unified diff of `base` against `head` (or the working tree when `head` is null), optionally limited to paths. */
  async diffUnified(
    cwd: string,
    base: string,
    head: string | null,
    diffOptions: { paths?: readonly string[]; contextLines?: number } = {},
    options: GitCallOptions = {}
  ): Promise<string> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(base);
    if (head !== null) {
      assertSafeRef(head);
    }
    const contextLines = diffOptions.contextLines ?? 3;
    if (!Number.isSafeInteger(contextLines) || contextLines < 0) {
      throw invalidArgument("contextLines");
    }
    const paths = (diffOptions.paths ?? []).map(normalizeRepoRelativePathArg);
    const args = [
      "diff",
      ...DIFF_SAFE_ARGS,
      "-M",
      `-U${contextLines}`,
      "--end-of-options",
      base,
      ...(head === null ? [] : [head]),
      "--",
      ...paths
    ];
    const result = await this.run(cwd, args, options);
    return result.stdout;
  }

  /**
   * Binary patch of staged + unstaged tracked changes against HEAD. The -c options keep a/ b/ prefixes so
   * `git apply` works whatever the user's config. Over GIT_MAX_BUFFER_BYTES → output_too_large.
   */
  async diffBinaryHead(cwd: string, options: GitCallOptions = {}): Promise<string> {
    assertAbsolutePath(cwd, "cwd");
    const result = await this.run(
      cwd,
      ["diff", "--binary", ...DIFF_SAFE_ARGS, "--ignore-submodules=all", "HEAD", "--"],
      {
        ...options,
        maxBufferBytes: GIT_MAX_BUFFER_BYTES,
        configArgs: ["-c", "diff.noprefix=false", "-c", "diff.mnemonicPrefix=false", "-c", "diff.relative=false"]
      }
    );
    return result.stdout;
  }

  /** `git apply --binary -` with the patch on stdin. An empty patch is a no-op (no spawn). Failure → patch_failed. */
  async applyPatch(cwd: string, patch: string, options: GitCallOptions = {}): Promise<void> {
    assertAbsolutePath(cwd, "cwd");
    if (patch.trim() === "") {
      return;
    }
    await this.run(cwd, ["apply", "--whitespace=nowarn", "--binary", "-"], { ...options, input: patch });
  }

  /** Untracked, non-ignored files (POSIX, repo-relative). */
  async lsUntracked(cwd: string, options: GitCallOptions = {}): Promise<string[]> {
    assertAbsolutePath(cwd, "cwd");
    const result = await this.run(cwd, ["ls-files", "--others", "--exclude-standard", "-z"], options);
    return splitZ(result.stdout);
  }

  /**
   * Tracked files matching the pathspecs (`git ls-files -z -- <pathspecs>`; POSIX, repo-relative). Pathspec magic
   * such as `:(glob)` is allowed; every pathspec sits after `--`, so none is read as an option.
   */
  async lsFiles(cwd: string, pathspecs: readonly string[], options: GitCallOptions = {}): Promise<string[]> {
    assertAbsolutePath(cwd, "cwd");
    if (pathspecs.length === 0 || pathspecs.some((spec) => spec === "" || spec.includes("\0"))) {
      throw invalidArgument("pathspec");
    }
    const result = await this.run(cwd, ["ls-files", "-z", "--", ...pathspecs], options);
    return splitZ(result.stdout);
  }

  /** `status --porcelain=v1 -z --untracked-files=all`, parsed. */
  async statusPorcelain(cwd: string, options: GitCallOptions = {}): Promise<GitStatusEntry[]> {
    assertAbsolutePath(cwd, "cwd");
    const result = await this.run(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], options);
    return parseStatusPorcelainZ(result.stdout);
  }

  /** True when the working tree has staged, unstaged or untracked changes. */
  async isDirty(cwd: string, options: GitCallOptions = {}): Promise<boolean> {
    return (await this.statusPorcelain(cwd, options)).length > 0;
  }

  /** Local branch names, most recently committed first. */
  async listBranches(cwd: string, options: GitCallOptions = {}): Promise<string[]> {
    assertAbsolutePath(cwd, "cwd");
    const result = await this.run(
      cwd,
      ["for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads/"],
      options
    );
    return splitLines(result.stdout);
  }

  /** Current branch name, or null when HEAD is detached. */
  async currentBranch(cwd: string, options: GitCallOptions = {}): Promise<string | null> {
    assertAbsolutePath(cwd, "cwd");
    const result = await this.run(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      ...options,
      allowedExitCodes: [0, 1]
    });
    return result.exitCode === 0 ? result.stdout.trim() || null : null;
  }

  /** URL of `remote`, or null when the remote does not exist. */
  async remoteUrl(cwd: string, remote = "origin", options: GitCallOptions = {}): Promise<string | null> {
    assertAbsolutePath(cwd, "cwd");
    if (!REMOTE_NAME.test(remote)) {
      throw invalidArgument("remote");
    }
    const result = await this.run(cwd, ["remote", "get-url", "--end-of-options", remote], {
      ...options,
      allowedExitCodes: [0, 2, 128]
    });
    if (result.exitCode !== 0) {
      if (/no such remote/i.test(result.stderr) || result.exitCode === 2) {
        return null;
      }
      throw this.logged(this.exitError("remote", result));
    }
    return result.stdout.trim() || null;
  }

  /** Default branch from refs/remotes/<remote>/HEAD (e.g. "main"), or null when unknown. */
  async symbolicRefDefault(cwd: string, remote = "origin", options: GitCallOptions = {}): Promise<string | null> {
    assertAbsolutePath(cwd, "cwd");
    if (!REMOTE_NAME.test(remote)) {
      throw invalidArgument("remote");
    }
    const result = await this.run(cwd, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${remote}/HEAD`], {
      ...options,
      allowedExitCodes: [0, 1, 128]
    });
    if (result.exitCode !== 0) {
      return null;
    }
    const short = result.stdout.trim();
    const prefix = `${remote}/`;
    const branch = short.startsWith(prefix) ? short.slice(prefix.length) : short;
    return branch === "" ? null : branch;
  }

  /**
   * Content of `path` at `rev` (`cat-file blob`, never `git show`, which may apply textconv), or null when the
   * path does not exist at that revision. Callers resolve `rev` first.
   */
  async showFile(cwd: string, rev: string, filePath: string, options: GitCallOptions = {}): Promise<string | null> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(rev);
    const relativePath = normalizeRepoRelativePathArg(filePath);
    const result = await this.run(cwd, ["cat-file", "blob", `${rev}:${relativePath}`], {
      ...options,
      maxBufferBytes: SHOW_FILE_MAX_BUFFER_BYTES,
      allowedExitCodes: [0, 128]
    });
    if (result.exitCode === 0) {
      return result.stdout;
    }
    if (/does not exist|not a valid object name|exists on disk, but not in/i.test(result.stderr)) {
      return null;
    }
    throw this.logged(this.exitError("cat-file", result));
  }

  /** Every file path in the tree of `rev` (POSIX, repo-relative). */
  async listFiles(cwd: string, rev: string, options: GitCallOptions = {}): Promise<string[]> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(rev);
    const result = await this.run(cwd, ["ls-tree", "-r", "--name-only", "-z", "--end-of-options", rev], options);
    return splitZ(result.stdout);
  }

  /**
   * True when `ancestor` is an ancestor of (or equal to) `descendant` (`merge-base --is-ancestor`). Exit code 1 is
   * false; an unknown revision is GitCommandError("unknown_revision").
   */
  async isAncestor(cwd: string, ancestor: string, descendant: string, options: GitCallOptions = {}): Promise<boolean> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(ancestor);
    assertSafeRef(descendant);
    const result = await this.run(cwd, ["merge-base", "--is-ancestor", "--end-of-options", ancestor, descendant], {
      ...options,
      allowedExitCodes: [0, 1]
    });
    return result.exitCode === 0;
  }

  /**
   * Commits of `rev`'s first-parent history, newest first (`git log --first-parent`), at most `limit`, after skipping
   * `skip` commits. First-parent keeps the list linear: every listed commit descends from each one below it.
   */
  async logCommits(
    cwd: string,
    rev: string,
    logOptions: { limit: number; skip?: number; grep?: string; author?: string },
    options: GitCallOptions = {}
  ): Promise<GitCommitEntry[]> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(rev);
    for (const [what, pattern] of [
      ["grep", logOptions.grep],
      ["author", logOptions.author]
    ] as const) {
      if (pattern !== undefined && (pattern === "" || pattern.length > 200 || /[\0\r\n]/.test(pattern))) {
        throw invalidArgument(what);
      }
    }
    const skip = logOptions.skip ?? 0;
    if (!Number.isSafeInteger(logOptions.limit) || logOptions.limit <= 0) {
      throw invalidArgument("limit");
    }
    if (!Number.isSafeInteger(skip) || skip < 0) {
      throw invalidArgument("skip");
    }
    const args = [
      "log",
      "--first-parent",
      "--no-show-signature",
      "--no-color",
      `--format=${LOG_COMMIT_FORMAT}`,
      `--max-count=${String(logOptions.limit)}`,
      ...(skip > 0 ? [`--skip=${String(skip)}`] : []),
      // Search text is matched literally and case-insensitively; each is a single argv entry (no shell).
      ...(logOptions.grep !== undefined
        ? ["--regexp-ignore-case", "--fixed-strings", `--grep=${logOptions.grep}`]
        : []),
      ...(logOptions.author !== undefined
        ? ["--regexp-ignore-case", "--fixed-strings", `--author=${logOptions.author}`]
        : []),
      "--end-of-options",
      rev,
      "--"
    ];
    const result = await this.run(cwd, args, options);
    return parseLogCommits(result.stdout);
  }

  /** Subject line of the commit `rev`. */
  async logSubject(cwd: string, rev: string, options: GitCallOptions = {}): Promise<string> {
    assertAbsolutePath(cwd, "cwd");
    assertSafeRef(rev);
    const result = await this.run(cwd, ["log", "-1", "--format=%s", "--end-of-options", rev], options);
    return result.stdout.replace(/\r?\n$/, "");
  }

  private async run(
    cwd: string | null,
    args: readonly string[],
    options: RunOptions & GitCallOptions & { quiet?: boolean } = {}
  ): Promise<ProcessResult> {
    const argv = [...GIT_SAFE_ARGS, ...(options.configArgs ?? []), ...(cwd === null ? [] : ["-C", cwd]), ...args];
    const subcommand = args[0] ?? "unknown";
    try {
      return await (this.options.runner ?? runProcess)(this.options.binary ?? GIT_BINARY, argv, {
        cwd: DATA_DIR,
        env: { ...CHILD_PROCESS_BASE_ENV, ...GIT_ENV, ...options.env },
        timeoutMs: options.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
        maxBufferBytes: options.maxBufferBytes ?? GIT_MAX_BUFFER_BYTES,
        input: options.input,
        allowedExitCodes: options.allowedExitCodes ?? [0],
        signal: options.signal,
        logLabel: `git ${subcommand}`
      });
    } catch (error: unknown) {
      const mapped = toGitCommandError(error, subcommand);
      if (options.quiet === true && mapped.code === "not_a_repository") {
        throw mapped;
      }
      throw this.logged(mapped);
    }
  }

  /** Logs a mapped failure once (warn; aborted at debug) and returns it for throwing. */
  private logged(error: GitCommandError): GitCommandError {
    const fields = {
      event: "git.command.failed",
      subcommand: error.subcommand,
      code: error.code,
      exitCode: error.exitCode,
      stderr: error.stderr.slice(0, STDERR_LOG_MAX_CHARS)
    };
    if (error.code === "aborted") {
      log.debug(fields, "git command failed");
    } else {
      log.warn(fields, "git command failed");
    }
    return error;
  }

  private exitError(subcommand: string, result: ProcessResult): GitCommandError {
    const stderr = redactSecrets(result.stderr).slice(0, STDERR_KEEP_MAX_CHARS);
    const code = STDERR_PATTERNS.find(([pattern]) => pattern.test(stderr))?.[1] ?? "command_failed";
    return new GitCommandError(`git ${subcommand} failed (${code})`, code, subcommand, result.exitCode, stderr);
  }
}

function normalizeRepoRelativePathArg(value: string): string {
  try {
    return normalizeRepoRelativePath(value);
  } catch {
    throw invalidArgument("path");
  }
}
