import { type ApiError } from '../models/api-error.model';
import { type ApiErrorReason } from '../models/api.model';

export interface ErrorCopy {
  title: string;
  /** Fixed user copy. Omitted → the server's message is shown (it is more specific). */
  message?: string;
  actionLabel?: string;
  actionRoute?: string;
}

export const ERROR_REASON_COPY: Record<ApiErrorReason, ErrorCopy> = {
  validation_failed: { title: 'Invalid input' },
  not_found: { title: 'Not found', message: 'That item no longer exists. It may have been removed.' },
  conflict: { title: 'Not possible right now' },
  forbidden_origin: {
    title: 'Request blocked',
    message: 'The API only accepts requests from the PRVision UI at http://localhost:4210.',
  },
  payload_too_large: { title: 'Too large' },
  internal_error: { title: 'Something went wrong' },
  not_git_repo: {
    title: 'Not a git repository',
    message: 'That folder is not a git repository. Choose the root folder of a local clone (the one containing .git).',
  },
  unsupported_framework: {
    title: 'Unsupported project',
    message:
      'PRVision supports Vite + React projects at the repository root and Angular 17+ apps built with the application builder. No supported app was found in that folder.',
  },
  missing_node_modules: {
    title: 'Dependencies not installed',
    message:
      "node_modules is missing. Run your package manager's install command (npm install, pnpm install or yarn) in that folder, then try again.",
  },
  no_github_remote: {
    title: 'No GitHub remote',
    message:
      'This repository has no GitHub remote, so pull requests are unavailable. Local branches and the working tree still work.',
  },
  github_token_missing: {
    title: 'GitHub token needed',
    message: 'Add a GitHub token in Settings to list and visualize pull requests.',
    actionLabel: 'Open settings',
    actionRoute: '/settings',
  },
  github_unauthorized: {
    title: 'GitHub rejected the token',
    message: 'The GitHub token was rejected. Check it has not expired and can read this repository.',
    actionLabel: 'Open settings',
    actionRoute: '/settings',
  },
  github_rate_limited: {
    title: 'GitHub rate limit reached',
    message: 'GitHub is rate limiting requests. Try again in a few minutes.',
  },
  github_unavailable: {
    title: 'GitHub unavailable',
    message: 'Could not reach GitHub. Check your network connection and try again.',
  },
  ai_not_configured: { title: 'AI provider not configured', actionLabel: 'Open settings', actionRoute: '/settings' },
  ai_unauthorized: { title: 'AI credentials rejected', actionLabel: 'Open settings', actionRoute: '/settings' },
  already_terminal: { title: 'Already finished', message: 'This visualization has already finished.' },
  working_tree_clean: { title: 'Nothing to visualize', message: 'The working tree has no uncommitted changes.' },
};

export type ResolvedErrorCopy = Required<Pick<ErrorCopy, 'title' | 'message'>> &
  Pick<ErrorCopy, 'actionLabel' | 'actionRoute'>;

/** One-line text for toasts and alert bodies. */
export function userMessageFor(error: ApiError): string {
  const copy = error.errorReason ? ERROR_REASON_COPY[error.errorReason] : null;
  return copy?.message ?? error.message;
}

/** Title + message + optional settings action for inline alerts and action prompts. */
export function errorCopyFor(error: ApiError): ResolvedErrorCopy {
  const copy: ErrorCopy = error.errorReason ? ERROR_REASON_COPY[error.errorReason] : { title: 'Something went wrong' };
  return { ...copy, message: copy.message ?? error.message };
}
