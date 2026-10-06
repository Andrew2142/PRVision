import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LOCAL_USER, type LocalUser } from "../../../backend/src/types/local-user";
import { AuthContext } from "../../../backend/src/utilities/context/auth-context";
import type { QueryHandler } from "../../../backend/src/utilities/handlers/query-handler";

/** Runs callback inside a fresh AuthContext store with LOCAL_USER (overridable) and requestId "test-request". */
export async function runWithAuthContext<T>(
  callback: () => Promise<T> | T,
  overrides: Partial<LocalUser> = {}
): Promise<T> {
  return AuthContext.runAsLocalUser(callback, {
    user: { ...LOCAL_USER, ...overrides },
    requestId: "test-request"
  });
}

/** Uply's helper, unchanged: replaces a static member and returns a restore function. */
export function patchStaticMethod<T extends object, K extends keyof T>(
  target: T,
  key: K,
  replacement: T[K]
): () => void {
  const originalValue = target[key];
  target[key] = replacement;
  return () => {
    target[key] = originalValue;
  };
}

const QUERY_HANDLER_METHODS = [
  "normalizeData",
  "insert",
  "select",
  "update",
  "delete",
  "count",
  "checkDuplicates",
  "validateAndSelect",
  "selectMany"
] as const satisfies ReadonlyArray<keyof QueryHandler>;

/**
 * Replaces a service's private `queryHandler` with a partial fake. Methods the fake does not implement throw
 * "not stubbed: <name>" when called.
 */
export function injectQueryHandler(service: object, fake: Partial<Record<keyof QueryHandler, unknown>>): void {
  const handler: Record<string, unknown> = {};
  for (const name of QUERY_HANDLER_METHODS) {
    handler[name] =
      fake[name] ??
      (() => {
        throw new Error(`not stubbed: ${name}`);
      });
  }
  (service as { queryHandler: unknown }).queryHandler = handler;
}

/** Creates a temp dir under os.tmpdir() (prefix "prvision-test-"), passes it to fn, removes it afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prvision-test-")));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---- Sheet 14 additions (14 §5.4.3); sheet 04's exports above are unchanged ----

/** Patches several members of one target; returns one restore function (restores in reverse order). */
export function patchMethods<T extends object>(target: T, replacements: Partial<T>): () => void {
  const restores = (Object.keys(replacements) as Array<keyof T>).map((key) =>
    patchStaticMethod(target, key, replacements[key] as T[keyof T])
  );
  return () => {
    for (const restore of restores.reverse()) {
      restore();
    }
  };
}

/** Runs fn and restores every patch afterwards, even when fn throws. */
export async function withPatches<T>(restores: Array<() => void>, fn: () => Promise<T> | T): Promise<T> {
  try {
    return await fn();
  } finally {
    for (const restore of restores.reverse()) {
      restore();
    }
  }
}
