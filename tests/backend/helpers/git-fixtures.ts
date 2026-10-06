import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHILD_PROCESS_BASE_ENV } from "../../../backend/src/config-consts";
import { runProcess } from "../../../backend/src/utilities/helpers/process";

/** A throw-away git repository for GitClient tests. */
export interface TempGitRepo {
  dir: string;
  /** runProcess("git", ["-C", dir, ...args]); resolves stdout. */
  git(args: readonly string[]): Promise<string>;
  /** Writes (or deletes, for null) the files, commits everything and returns the new sha. */
  commit(message: string, files: Record<string, string | null>): Promise<string>;
  cleanup(): Promise<void>;
}

/** Isolated from the developer's global git config and identity. */
const GIT_TEST_ENV: Record<string, string> = {
  ...CHILD_PROCESS_BASE_ENV,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "PRVision Test",
  GIT_AUTHOR_EMAIL: "test@prvision.invalid",
  GIT_COMMITTER_NAME: "PRVision Test",
  GIT_COMMITTER_EMAIL: "test@prvision.invalid",
  LC_ALL: "C"
};

async function writeFiles(dir: string, files: Record<string, string | null>): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(dir, relativePath);
    if (content === null) {
      await fs.rm(target, { force: true });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

/** git init -b main with user.name/email set locally and one initial commit of `files`. */
export async function createTempGitRepo(files: Record<string, string>): Promise<TempGitRepo> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-git-")));
  const git = async (args: readonly string[]): Promise<string> => {
    const result = await runProcess("git", ["-C", dir, ...args], {
      cwd: dir,
      env: GIT_TEST_ENV,
      timeoutMs: 30_000,
      logLabel: "git (test)"
    });
    return result.stdout;
  };
  const commit = async (message: string, changed: Record<string, string | null>): Promise<string> => {
    await writeFiles(dir, changed);
    await git(["add", "-A"]);
    await git(["commit", "--allow-empty", "-q", "-m", message]);
    return (await git(["rev-parse", "HEAD"])).trim();
  };

  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.name", "PRVision Test"]);
  await git(["config", "user.email", "test@prvision.invalid"]);
  await git(["config", "commit.gpgsign", "false"]);
  await commit("initial", files);

  return {
    dir,
    git,
    commit,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    }
  };
}
