/**
 * Harness library contracts (sheet 16 §6.11, verbatim; 00 §21). Written by 16a; every other sheet-16 task imports it.
 * This file and visualization-pipeline.ts import each other with `import type` only.
 */
import type { HarnessLibraryOrigin, HarnessLibraryStatus, LibraryBuildMode, RepositoryFramework } from "../enums";
import type { AiUsage, MockedModule, WorktreeSide } from "./visualization-pipeline";

/** Name of the first state of every harness (D4, E7). */
export const DEFAULT_STATE_NAME = "Default";

/** How a step finds its element (§7.5). `nth` (0-based) picks among visible matches in document order. */
export type HarnessStepTarget =
  | { by: "role"; role: string; name: string; nth?: number }
  | { by: "text"; text: string; nth?: number }
  | { by: "label"; label: string; nth?: number }
  | { by: "placeholder"; placeholder: string; nth?: number }
  | { by: "testId"; testId: string; nth?: number };

export type HarnessStepKey =
  "Enter" | "Escape" | "Tab" | "Space" | "ArrowDown" | "ArrowUp" | "ArrowLeft" | "ArrowRight" | "Home" | "End";

/** One scripted interaction (D5). At most STATE_MAX_STEPS per state; Default has none (E7). */
export type HarnessStep =
  | { action: "click"; target: HarnessStepTarget }
  | { action: "hover"; target: HarnessStepTarget }
  | { action: "focus"; target: HarnessStepTarget }
  | { action: "type"; target: HarnessStepTarget; text: string }
  | { action: "press"; key: HarnessStepKey; target?: HarnessStepTarget }
  | { action: "waitFor"; target: HarnessStepTarget };

/** A state as stored in the library and on run rows (E6). */
export interface HarnessStateSpec {
  name: string;
  steps: HarnessStep[];
}

/** Library identity (E1). */
export interface LibraryComponentIdentity {
  filePath: string; // repo-relative POSIX, inside the app root
  exportName: string;
}

export function identityKey(identity: LibraryComponentIdentity): string {
  return `${identity.filePath}\u0000${identity.exportName}`;
}

/** One library entry as services see it (row → record mapping lives in 16c's store). */
export interface HarnessLibraryEntryRecord {
  id: number;
  repositoryId: number;
  framework: RepositoryFramework;
  filePath: string;
  exportName: string;
  displayName: string;
  selector: string | null;
  sourceFingerprint: string | null;
  harnessSource: string | null;
  mockedModules: MockedModule[];
  notes: string;
  states: HarnessStateSpec[];
  stateAllowance: number;
  status: HarnessLibraryStatus;
  origin: HarnessLibraryOrigin;
  revision: number;
  lastError: string | null;
  lastFailedVisualizationId: number | null;
  aiModel: string | null;
  aiUsage: AiUsage | null;
  costUsd: number | null;
  writtenAt: Date | null;
  lastRenderedAt: Date | null;
}

/** Input to save a written harness (insert, or replace with revision + 1). */
export interface SaveWrittenHarnessInput {
  repositoryId: number;
  framework: RepositoryFramework;
  identity: LibraryComponentIdentity;
  displayName: string;
  selector: string | null;
  sourceFingerprint: string | null;
  harness: { harnessSource: string; mockedModules: MockedModule[]; notes: string; states: HarnessStateSpec[] } | null;
  stateAllowance: number;
  status: HarnessLibraryStatus;
  origin: HarnessLibraryOrigin;
  lastError: string | null;
  lastFailedVisualizationId: number | null;
  aiModel: string | null;
  aiUsage: AiUsage | null;
  /**
   * Optimistic concurrency (E25): 0 = insert only (an existing entry → revision_changed); n ≥ 1 = replace only while the
   * stored revision equals n (no stored entry → insert); null = insert or replace unconditionally (repair, import).
   */
  expectedRevision: number | null;
}

export type SaveWrittenHarnessOutcome =
  | { saved: true; entry: HarnessLibraryEntryRecord }
  | { saved: false; reason: "revision_changed"; current: HarnessLibraryEntryRecord };

export type LibraryRenderOutcome =
  { ok: true; at: Date } | { ok: false; at: Date; error: string; visualizationId: number | null };

/** Every count excludes `off_default_branch` entries (E26). */
export interface LibraryCounts {
  total: number; // entries
  ready: number;
  needsUpdate: number;
  withoutHarness: number; // needs_update entries with harness_source null
  otherAllowance: number; // entries with a harness whose state_allowance differs from the allowance passed in (E24)
}

/** 16c implements; 16d, 16f, 16g, 16k depend on this port only. */
export interface HarnessLibraryStorePort {
  findByIdentities(
    repositoryId: number,
    identities: readonly LibraryComponentIdentity[]
  ): Promise<Map<string, HarnessLibraryEntryRecord>>;
  listForRepository(
    repositoryId: number,
    options?: { withHarnessOnly?: boolean; onDefaultBranchOnly?: boolean }
  ): Promise<HarnessLibraryEntryRecord[]>;
  get(entryId: number): Promise<HarnessLibraryEntryRecord | null>;
  saveWritten(input: SaveWrittenHarnessInput): Promise<SaveWrittenHarnessOutcome>;
  markRenderOutcome(entryId: number, outcome: LibraryRenderOutcome): Promise<void>;
  moveIdentity(entryId: number, to: LibraryComponentIdentity & { displayName: string }): Promise<void>;
  /** E26: scans mark and restore; nothing in this port deletes an entry. Both return the number of rows changed. */
  markOffDefaultBranch(repositoryId: number, entryIds: readonly number[]): Promise<number>;
  restoreOnDefaultBranch(repositoryId: number, entryIds: readonly number[]): Promise<number>;
  counts(repositoryId: number, currentAllowance: number): Promise<LibraryCounts>;
}

/** One component found by the inventory (§8.3). */
export interface InventoryComponent {
  identity: LibraryComponentIdentity;
  displayName: string;
  selector: string | null;
  /** null when not computed (estimates) or when the component cannot be located (§8.1). */
  sourceFingerprint: string | null;
  /** Component children it renders (direct); used for ordering. */
  childCount: number;
  /** 0 = renders no other component of the app; else 1 + max child layer (cycles collapsed). */
  layer: number;
  sourceLines: number;
}

export interface ComponentInventory {
  framework: RepositoryFramework;
  components: InventoryComponent[]; // smallest first (§8.3.3)
  truncated: boolean;
  warnings: string[];
}

/** Per-side harness choice for one run row (§8.4). */
export interface SideHarnessPlan {
  side: WorktreeSide;
  identity: LibraryComponentIdentity;
  entry: HarnessLibraryEntryRecord | null; // reused entry, or null = write a new harness
}

export interface LibraryResolution {
  /** componentId → plan per present side (one item, or two for `replaced` rows); `rechecked` rows included (one plan, the entry). */
  plans: Map<number, SideHarnessPlan[]>;
  newHarnessCount: number; // harnesses to write if nothing is capped
  reusedCount: number; // rows with at least one reused side
  recheckedCount: number; // `rechecked` rows inserted
  globalStyleTrigger: string | null;
  /** True when the run must pause (D9) before any AI call. */
  pause: boolean;
  /** Rows skipped because they need a new harness and are over the limit. */
  skippedOverLimit: number[];
}

/** Live mode (§12). One per (side, render group). */
export interface LiveHostState {
  side: WorktreeSide;
  groupKey: string;
  componentIds: number[];
  status: "starting" | "ready" | "failed" | "stopped";
  origin: string | null; // "http://127.0.0.1:<port>"
  harnessUrlPath: string | null; // "/.prvision-harness/index.html" or "/index.html"
  error: string | null;
  lastUsedAt: string; // ISO
}

/** Stored in live_sessions.open_requests (not the HTTP body, which is LiveOpenRequest in §14.6). */
export interface LiveOpenRequestRecord {
  componentId: number;
  requestedAt: string; // ISO
}

export interface RepositoryLibrarySettings {
  buildMode: LibraryBuildMode;
  stateAllowance: number;
}
