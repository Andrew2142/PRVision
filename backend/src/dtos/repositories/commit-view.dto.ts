import type { GitCommitEntry } from "../../utilities";

/** Length of `CommitView.shortSha` (git's default abbreviation). */
export const SHORT_SHA_LENGTH = 7;

/** One commit of GET /api/repositories/:id/commits (00 §16, §16.1). */
export interface CommitView {
  sha: string;
  /** First parent; null for a root commit. A single-commit pick compares parentSha → sha (00 §16.1). */
  parentSha: string | null;
  /** More than one parent: a single-commit pick shows everything the merge brought in. */
  isMerge: boolean;
  shortSha: string;
  subject: string;
  authorName: string;
  /** Committer date, ISO 8601 UTC. */
  committedAt: string;
}

/** Maps a GitClient log entry to its response view (dates normalized to UTC ISO). */
export function toCommitView(commit: GitCommitEntry): CommitView {
  const committed = new Date(commit.committedAt);
  return {
    sha: commit.sha,
    parentSha: commit.parentSha,
    isMerge: commit.isMerge,
    shortSha: commit.sha.slice(0, SHORT_SHA_LENGTH),
    subject: commit.subject,
    authorName: commit.authorName,
    committedAt: Number.isNaN(committed.getTime()) ? commit.committedAt : committed.toISOString()
  };
}
