// Test data builders for the harness library specs (only specs import this file).
import {
  type HarnessLibrarySummaryView,
  type LibraryEstimateView,
  type LibraryJobEventView,
  type LibraryJobView,
} from '../../../core/models/harness-library.model';
import { type RepositoryView } from '../../../core/models/repository.model';

export function repositoryView(overrides: Partial<RepositoryView> = {}): RepositoryView {
  return {
    id: 3,
    name: 'my-shop',
    localPath: '/home/dev/projects/my-shop',
    githubOwner: 'acme',
    githubRepo: 'my-shop',
    defaultBranch: 'main',
    framework: 'react_vite',
    appRoot: '.',
    angularProject: null,
    angularBuildConfiguration: null,
    renderViewport: 'desktop',
    packageManager: 'pnpm',
    viteConfigPath: 'vite.config.ts',
    tsconfigPath: 'tsconfig.json',
    entryFilePath: 'src/main.tsx',
    globalStylePaths: [],
    lastDetectedAt: '2026-10-03T10:00:00Z',
    createdAt: '2026-10-01T10:00:00Z',
    libraryBuildMode: 'grow',
    stateAllowance: 3,
    ...overrides,
  };
}

export function estimateView(overrides: Partial<LibraryEstimateView> = {}): LibraryEstimateView {
  return {
    componentCount: 201,
    toWriteCount: 201,
    truncated: false,
    stateAllowance: 3,
    kind: 'scan',
    model: 'claude-opus-5-5',
    priceModel: 'claude-opus-5-5',
    priceExact: true,
    basis: 'default',
    perHarnessUsd: 0.19,
    estimatedUsd: 38.2,
    lowUsd: 22.92,
    highUsd: 61.12,
    estimatedMinutes: 84,
    warnings: [],
    ...overrides,
  };
}

export function libraryJobView(overrides: Partial<LibraryJobView> = {}): LibraryJobView {
  const job: LibraryJobView = {
    id: 5,
    repositoryId: 3,
    repositoryName: 'my-shop',
    kind: 'scan',
    status: 'running',
    visualizationId: null,
    componentIds: null,
    stateAllowance: 3,
    spendCapUsd: 20,
    spentUsd: 12.4,
    priceExact: true,
    totalCount: 201,
    writtenCount: 80,
    failedCount: 3,
    skippedCount: 1,
    processedCount: 84,
    currentLabel: 'Writing InvoiceRow (src/components/InvoiceRow.tsx)',
    scanSha: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
    aiModel: 'claude-opus-5-5',
    errorMessage: null,
    createdAt: '2026-10-03T10:00:00Z',
    startedAt: '2026-10-03T10:00:02Z',
    completedAt: null,
    ...overrides,
  };
  return job;
}

export function librarySummaryView(overrides: Partial<HarnessLibrarySummaryView> = {}): HarnessLibrarySummaryView {
  return {
    repositoryId: 3,
    buildMode: 'grow',
    stateAllowance: 3,
    rescanSuggested: false,
    counts: { total: 40, ready: 37, needsUpdate: 3, withoutHarness: 0, otherAllowance: 0 },
    activeJob: null,
    lastScanJob: null,
    canContinue: false,
    ...overrides,
  };
}

export function libraryJobEvent(id: number, overrides: Partial<LibraryJobEventView> = {}): LibraryJobEventView {
  return { id, level: 'info', message: `event ${String(id)}`, createdAt: '2026-10-03T10:01:00Z', ...overrides };
}
