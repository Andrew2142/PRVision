/**
 * Render groups (10 §5.3, §5.3.1): components are batched by an exact fingerprint of their accepted mocks; one
 * Vite server per side per group.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type { MockedModule } from "../../../../types/visualization-pipeline";
import type { RenderGroup, RenderWorkItem } from "./render-types";

export const NO_MOCKS_GROUP_KEY = "none";

/** Syntactic match key: relative specifiers are anchored to the component's repo-relative directory. */
export function normalizeMockMatchKey(componentRepoPath: string, specifier: string): string {
  const isRelative =
    specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
  if (!isRelative) {
    return `spec:${specifier}`;
  }
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(componentRepoPath), specifier));
  return `rel:${joined}`;
}

/** Group key of a component: "none" without mocks, else a short hash over the normalized (match key, source) pairs. */
export function mockFingerprint(componentRepoPath: string, acceptedMocks: readonly MockedModule[]): string {
  if (acceptedMocks.length === 0) {
    return NO_MOCKS_GROUP_KEY;
  }
  const parts = acceptedMocks
    .map((mock) => `${normalizeMockMatchKey(componentRepoPath, mock.specifier)}\u0000${mock.source}`)
    .sort();
  return createHash("sha256").update(parts.join("\u0001")).digest("hex").slice(0, 16);
}

/** "none" first, then groups by their best (lowest) rank, then key. Items by rank, then componentId. */
export function buildRenderGroups(items: readonly RenderWorkItem[]): RenderGroup[] {
  const byKey = new Map<string, RenderWorkItem[]>();
  for (const item of items) {
    const bucket = byKey.get(item.fingerprint) ?? [];
    bucket.push(item);
    byKey.set(item.fingerprint, bucket);
  }
  const groups: RenderGroup[] = [...byKey.entries()].map(([key, groupItems]) => ({
    key,
    items: [...groupItems].sort(
      (a, b) => a.candidate.rank - b.candidate.rank || a.candidate.componentId - b.candidate.componentId
    )
  }));
  return groups.sort((a, b) => {
    if (a.key === NO_MOCKS_GROUP_KEY) {
      return -1;
    }
    if (b.key === NO_MOCKS_GROUP_KEY) {
      return 1;
    }
    const rankA = a.items[0]?.candidate.rank ?? Number.MAX_SAFE_INTEGER;
    const rankB = b.items[0]?.candidate.rank ?? Number.MAX_SAFE_INTEGER;
    return rankA - rankB || a.key.localeCompare(b.key);
  });
}
