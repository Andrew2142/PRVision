/**
 * Render groups (10 §5.3, §5.3.1): components are batched by an exact fingerprint of their accepted mocks; one
 * Vite server per side per group. Groups are split at RENDER_GROUP_MAX_ITEMS and the stage budget is derived from
 * the planned pages (16 §9.2).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import {
  ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS,
  RENDER_GROUP_STARTUP_ALLOWANCE_MS,
  RENDER_PAGE_CONCURRENCY,
  RENDER_STAGE_MS_PER_PAGE,
  RENDER_STAGE_TIMEOUT_MAX_MS,
  RENDER_STAGE_TIMEOUT_MS
} from "../../../../config-consts/render.config";
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

/**
 * Splits groups above `maxItems` into consecutive chunks keyed `<key>#<n>` (n from 1), keeping order, so one build
 * and one warm-up list stay bounded and one broken harness affects at most `maxItems` items (16 §9.2).
 */
export function splitLargeGroups(groups: readonly RenderGroup[], maxItems: number): RenderGroup[] {
  const out: RenderGroup[] = [];
  for (const group of groups) {
    if (group.items.length <= maxItems) {
      out.push(group);
      continue;
    }
    for (let start = 0, n = 1; start < group.items.length; start += maxItems, n += 1) {
      out.push({ key: `${group.key}#${String(n)}`, items: group.items.slice(start, start + maxItems) });
    }
  }
  return out;
}

/** Pages one item renders: states × present sides that declare them (16 §9.2). */
export function plannedPagesOf(item: Pick<RenderWorkItem, "states" | "sides">): number {
  return item.states.reduce(
    (sum, state) => sum + (item.sides.base && state.onBase ? 1 : 0) + (item.sides.head && state.onHead ? 1 : 0),
    0
  );
}

/**
 * The dynamic render stage budget (16 §9.2): `min(MAX, max(FLOOR, ceil(pages / PAGE_CONCURRENCY) × MS_PER_PAGE +
 * hostStarts × startupAllowance))`. `hostStarts` counts, per group, the sides the group renders.
 */
export function renderStageBudgetMs(
  framework: "react_vite" | "angular",
  items: ReadonlyArray<Pick<RenderWorkItem, "states" | "sides">>,
  groups: ReadonlyArray<{ items: ReadonlyArray<Pick<RenderWorkItem, "sides">> }>
): number {
  const plannedPages = items.reduce((sum, item) => sum + plannedPagesOf(item), 0);
  const hostStarts = groups.reduce(
    (sum, group) =>
      sum +
      (group.items.some((item) => item.sides.base) ? 1 : 0) +
      (group.items.some((item) => item.sides.head) ? 1 : 0),
    0
  );
  const startupAllowance =
    framework === "angular" ? ANGULAR_RENDER_GROUP_STARTUP_ALLOWANCE_MS : RENDER_GROUP_STARTUP_ALLOWANCE_MS;
  const wanted =
    Math.ceil(plannedPages / RENDER_PAGE_CONCURRENCY) * RENDER_STAGE_MS_PER_PAGE + hostStarts * startupAllowance;
  return Math.min(RENDER_STAGE_TIMEOUT_MAX_MS, Math.max(RENDER_STAGE_TIMEOUT_MS, wanted));
}
