import type { GitHubPullRequestSummary } from "../../utilities";

/** Response view of one open pull request (00 §9). */
export interface PullRequestView {
  number: number;
  title: string;
  author: string;
  headRef: string;
  baseRef: string;
  updatedAt: string;
  draft: boolean;
  url: string;
}

/** Maps a GitHubClient PR summary to its response view. */
export function toPullRequestView(pr: GitHubPullRequestSummary): PullRequestView {
  return {
    number: pr.number,
    title: pr.title,
    author: pr.authorLogin,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    updatedAt: pr.updatedAt,
    draft: pr.draft,
    url: pr.htmlUrl
  };
}
