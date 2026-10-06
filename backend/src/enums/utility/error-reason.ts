import { enumValues, type ValueOf } from "./value-of";

/**
 * Machine-readable `error_reason` codes of the HTTP envelope: the complete list of 00 §14.2, nothing more.
 * The comment on each value is the HTTP status it is sent with (01 §5.7.1, 00 §14.12).
 */
export const ErrorReason = {
  VALIDATION_FAILED: "validation_failed", // 400
  NOT_FOUND: "not_found", // 404
  CONFLICT: "conflict", // 409 (unique/FK violation, delete while running)
  FORBIDDEN_ORIGIN: "forbidden_origin", // 403 (LocalAuthMiddleware only)
  PAYLOAD_TOO_LARGE: "payload_too_large", // 413
  INTERNAL_ERROR: "internal_error", // 500
  NOT_GIT_REPO: "not_git_repo", // 400
  UNSUPPORTED_FRAMEWORK: "unsupported_framework", // 400
  MISSING_NODE_MODULES: "missing_node_modules", // 400
  NO_GITHUB_REMOTE: "no_github_remote", // 400
  GITHUB_TOKEN_MISSING: "github_token_missing", // 400
  GITHUB_UNAUTHORIZED: "github_unauthorized", // 400
  GITHUB_RATE_LIMITED: "github_rate_limited", // 429
  GITHUB_UNAVAILABLE: "github_unavailable", // 502
  AI_NOT_CONFIGURED: "ai_not_configured", // 400
  AI_UNAUTHORIZED: "ai_unauthorized", // 400
  ALREADY_TERMINAL: "already_terminal", // 409
  WORKING_TREE_CLEAN: "working_tree_clean" // 400
} as const;
export type ErrorReason = ValueOf<typeof ErrorReason>;
export const ERROR_REASON_VALUES = enumValues(ErrorReason);
