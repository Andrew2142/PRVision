/**
 * IPC protocol between `AngularHostClient` (worker) and `angular-host-process` (child), 15 §5.7.7.
 *
 * PURE: loaded by the child process. Imports only types and the pure guards of `render-types`.
 */
import { isRecord } from "../render-types";

/** Messages the parent sends to the Angular host child. */
export type AngularHostRequest =
  | {
      type: "build";
      buildId: string;
      projectName: string;
      builderName: string;
      options: Record<string, unknown>;
      projectExtensions: Record<string, unknown>;
    }
  | { type: "shutdown" };

/** Installed toolchain versions reported by the child once it has loaded Architect. */
export interface AngularHostVersions {
  core: string | null;
  build: string | null;
  architect: string | null;
}

export type AngularHostLogLevel = "info" | "warn" | "error";

/** Messages the child sends to the parent. */
export type AngularHostEvent =
  | { type: "ready"; versions: AngularHostVersions }
  | { type: "log"; buildId: string; level: AngularHostLogLevel; message: string } // capped 8 KB each
  | { type: "result"; buildId: string; success: boolean; durationMs: number; outputDir: string | null }
  | { type: "fatal"; message: string }; // cannot load architect

/** Maximum characters of one forwarded log message. */
export const ANGULAR_HOST_LOG_MAX_CHARS = 8 * 1024;

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

/** Validates a message received from the Angular host child. */
export function isAngularHostEvent(value: unknown): value is AngularHostEvent {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  switch (value.type) {
    case "ready":
      return (
        isRecord(value.versions) &&
        isNullableString(value.versions.core) &&
        isNullableString(value.versions.build) &&
        isNullableString(value.versions.architect)
      );
    case "log":
      return (
        typeof value.buildId === "string" &&
        (value.level === "info" || value.level === "warn" || value.level === "error") &&
        typeof value.message === "string"
      );
    case "result":
      return (
        typeof value.buildId === "string" &&
        typeof value.success === "boolean" &&
        typeof value.durationMs === "number" &&
        isNullableString(value.outputDir)
      );
    case "fatal":
      return typeof value.message === "string";
    default:
      return false;
  }
}

/** Validates a message received by the child from the parent. */
export function isAngularHostRequest(value: unknown): value is AngularHostRequest {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "shutdown") {
    return true;
  }
  return (
    value.type === "build" &&
    typeof value.buildId === "string" &&
    typeof value.projectName === "string" &&
    typeof value.builderName === "string" &&
    isRecord(value.options) &&
    isRecord(value.projectExtensions)
  );
}
