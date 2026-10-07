// Harness library HTTP shapes (sheet 16 §14.2–§14.4, §14.7) and the harness state types they carry (§6.11).
import {
  type LibraryBuildMode,
  type LibraryJobKind,
  type LibraryJobStatus,
  type RepositoryFramework,
} from './domain-enums.model';

/** How a step finds its element. `nth` (0-based) picks among visible matches in document order. */
export type HarnessStepTarget =
  | { by: 'role'; role: string; name: string; nth?: number }
  | { by: 'text'; text: string; nth?: number }
  | { by: 'label'; label: string; nth?: number }
  | { by: 'placeholder'; placeholder: string; nth?: number }
  | { by: 'testId'; testId: string; nth?: number };

export type HarnessStepKey =
  'Enter' | 'Escape' | 'Tab' | 'Space' | 'ArrowDown' | 'ArrowUp' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End';

/** One scripted interaction that reaches a state (16 D5). Default has none. */
export type HarnessStep =
  | { action: 'click'; target: HarnessStepTarget }
  | { action: 'hover'; target: HarnessStepTarget }
  | { action: 'focus'; target: HarnessStepTarget }
  | { action: 'type'; target: HarnessStepTarget; text: string }
  | { action: 'press'; key: HarnessStepKey; target?: HarnessStepTarget }
  | { action: 'waitFor'; target: HarnessStepTarget };

export interface HarnessStateSpec {
  name: string;
  steps: HarnessStep[];
}

/** Counts of the saved library; entries not on the default branch are never counted (16 E26). */
export interface LibraryCountsView {
  total: number;
  ready: number;
  needsUpdate: number;
  /** needs_update entries without a harness (writing failed). */
  withoutHarness: number;
  /** Entries with a harness written with another state allowance (16 E24). */
  otherAllowance: number;
}

/** GET /api/repositories/:id/library. */
export interface HarnessLibrarySummaryView {
  repositoryId: number;
  buildMode: LibraryBuildMode;
  stateAllowance: number;
  /** buildMode "scan" and counts.otherAllowance > 0. */
  rescanSuggested: boolean;
  counts: LibraryCountsView;
  /** Active scan or rescan. */
  activeJob: LibraryJobView | null;
  /** Most recent terminal scan or rescan. */
  lastScanJob: LibraryJobView | null;
  /** No active job and lastScanJob ended cancelled, cap_reached or failed. */
  canContinue: boolean;
}

/** A scan, rescan or repair job (GET /api/library-jobs/:id). */
export interface LibraryJobView {
  id: number;
  repositoryId: number;
  repositoryName: string;
  kind: LibraryJobKind;
  status: LibraryJobStatus;
  visualizationId: number | null;
  componentIds: number[] | null;
  stateAllowance: number;
  spendCapUsd: number | null;
  spentUsd: number;
  priceExact: boolean;
  totalCount: number;
  writtenCount: number;
  failedCount: number;
  skippedCount: number;
  /** written + failed + skipped. */
  processedCount: number;
  currentLabel: string | null;
  scanSha: string | null;
  aiModel: string;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

/** GET /api/library-jobs/:id/events → oldest first. */
export interface LibraryJobEventView {
  id: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

/** `afterId` is exclusive; `limit` defaults to and is capped at 500. */
export interface LibraryJobEventsQuery {
  afterId?: number;
  limit?: number;
}

/** POST /api/library-jobs/:id/cancel: 200 → "cancelled", 202 → "cancel_requested"; 409 already_terminal. */
export interface CancelLibraryJobResponse {
  id: number;
  status: 'cancelled' | 'cancel_requested';
}

/** POST /api/repositories/:id/library/scans → 202 LibraryJobView. */
export interface LibraryScanCreateRequest {
  kind: 'scan' | 'rescan';
  /** null = no cap. */
  spendCapUsd: number | null;
  stateAllowance?: number;
}

/** POST /api/repositories/library-estimate (a folder that is not registered yet). */
export interface LibraryEstimateRequest {
  localPath: string;
  appRoot?: string;
  angularProject?: string;
  stateAllowance: number;
}

/** GET /api/repositories/:id/library/estimate query; the API defaults to the repository's allowance and "scan". */
export interface LibraryEstimateQuery {
  stateAllowance?: number;
  kind?: 'scan' | 'rescan';
}

export interface LibraryEstimateView {
  componentCount: number;
  toWriteCount: number;
  truncated: boolean;
  stateAllowance: number;
  kind: 'scan' | 'rescan';
  model: string;
  priceModel: string;
  priceExact: boolean;
  basis: 'history' | 'default';
  perHarnessUsd: number;
  estimatedUsd: number;
  lowUsd: number;
  highUsd: number;
  estimatedMinutes: number;
  warnings: string[];
}

// Export and import (16 §13.2, §14.7). The UI for them is task 16k.

export interface MockedModuleView {
  specifier: string;
  source: string;
}

export interface HarnessLibraryExportFile {
  format: 'prvision-harness-library';
  version: 1;
  exportedAt: string;
  prvisionVersion: string;
  repository: {
    name: string;
    framework: RepositoryFramework;
    appRoot: string;
    angularProject: string | null;
    githubOwner: string | null;
    githubRepo: string | null;
    defaultBranch: string;
  };
  stateAllowance: number;
  entries: {
    filePath: string;
    exportName: string;
    displayName: string;
    selector: string | null;
    sourceFingerprint: string | null;
    harnessSource: string;
    mockedModules: MockedModuleView[];
    notes: string;
    states: HarnessStateSpec[];
    stateAllowance: number;
    status: 'ready' | 'needs_update';
    revision: number;
    writtenAt: string | null;
  }[];
}

export interface LibraryImportRequest {
  mode: 'add_missing' | 'replace_all';
  file: HarnessLibraryExportFile;
}

export interface LibraryImportResultView {
  imported: number;
  replaced: number;
  kept: number;
  skippedMissing: number;
  skippedInvalid: number;
  stateAllowance: number;
  warnings: string[];
}
