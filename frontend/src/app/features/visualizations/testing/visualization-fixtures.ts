// Test data builders shared by the visualization specs (not part of the app bundle: only specs import this file).
import { type LibraryJobView } from '../../../core/models/harness-library.model';
import {
  type ComponentHarnessView,
  type ComponentStateView,
  type ConsoleEventView,
  type VisualizationComponentView,
  type VisualizationDetailView,
  type VisualizationSummaryView,
} from '../../../core/models/visualization.model';

export function summaryView(overrides: Partial<VisualizationSummaryView> = {}): VisualizationSummaryView {
  return {
    id: 7,
    repositoryId: 1,
    repositoryName: 'sample-react-app',
    sourceType: 'local_branch',
    prNumber: null,
    title: 'feature/button-restyle → main',
    baseRef: 'main',
    headRef: 'feature/button-restyle',
    baseSha: null,
    headSha: null,
    status: 'completed',
    componentCount: 3,
    changedCount: 1,
    checkedCount: 0,
    createdAt: '2026-10-03T10:00:00Z',
    completedAt: '2026-10-03T10:03:12Z',
    ...overrides,
  };
}

export function detailView(overrides: Partial<VisualizationDetailView> = {}): VisualizationDetailView {
  return {
    ...summaryView(),
    framework: 'react_vite',
    baseSha: 'a1b2c3d4e5f6a7b8c9d0',
    headSha: 'd4e5f6a7b8c9d0e1f2a3',
    errorMessage: null,
    summaryMarkdown: null,
    aiProvider: 'anthropic_api',
    aiModel: 'claude-opus-5-5',
    aiUsage: { inputTokens: 41_200, outputTokens: 3_100, calls: 14 },
    startedAt: '2026-10-03T10:00:00Z',
    failedStage: null,
    componentLimit: null,
    components: [],
    reusedHarnessCount: 0,
    newHarnessCount: 0,
    needsUpdateCount: 0,
    globalStyleTrigger: null,
    activeRepairJob: null,
    liveAvailable: false,
    repairEstimateUsd: null,
    ...overrides,
  };
}

export function harnessView(overrides: Partial<ComponentHarnessView> = {}): ComponentHarnessView {
  return {
    origin: 'written',
    baseOrigin: null,
    libraryEntryId: 31,
    baseLibraryEntryId: null,
    needsUpdate: false,
    sourceChangedSinceWrite: null,
    repairing: false,
    ...overrides,
  };
}

export function stateView(ordinal: number, overrides: Partial<ComponentStateView> = {}): ComponentStateView {
  const dir = ordinal === 0 ? '' : `s${String(ordinal)}/`;
  return {
    ordinal,
    name: ordinal === 0 ? 'Default' : `State ${String(ordinal)}`,
    onBase: true,
    onHead: true,
    steps: [],
    stepSummary: [],
    renderStatus: 'rendered',
    visualChange: 'unchanged',
    baseImageUrl: `/artifacts/7/11/${dir}base.png`,
    headImageUrl: `/artifacts/7/11/${dir}head.png`,
    diffImageUrl: `/artifacts/7/11/${dir}diff.png`,
    imageWidth: 800,
    imageHeight: 600,
    diffPixelRatio: 0,
    baseError: null,
    headError: null,
    ...overrides,
  };
}

/**
 * A component row. Without `states` in the overrides it gets one Default state built from the row's own columns,
 * as the API synthesizes for rows that have no state rows (16 §7.9, §14.5).
 */
export function componentView(overrides: Partial<VisualizationComponentView> = {}): VisualizationComponentView {
  const row: Omit<VisualizationComponentView, 'states'> = {
    id: 11,
    filePath: 'src/components/CartSummary.tsx',
    exportName: 'default',
    displayName: 'CartSummary',
    changeKind: 'modified',
    renderStatus: 'rendered',
    visualChange: 'changed',
    risk: 'check',
    rank: 0,
    baseImageUrl: '/artifacts/7/11/base.png',
    headImageUrl: '/artifacts/7/11/head.png',
    diffImageUrl: '/artifacts/7/11/diff.png',
    imageWidth: 800,
    imageHeight: 600,
    diffPixelRatio: 0.042,
    codeDiff: null,
    structuralDiff: null,
    aiNote: null,
    harnessSource: null,
    harnessNotes: null,
    baseError: null,
    headError: null,
    changeReason: null,
    skipReason: null,
    baseFilePath: null,
    baseExportName: null,
    baseDisplayName: null,
    successorEvidence: null,
    stateCount: 1,
    changedStateCount: 0,
    harness: harnessView(),
    ...overrides,
  };
  const changed = row.visualChange === 'changed' || row.visualChange === 'new' || row.visualChange === 'deleted';
  const states = overrides.states ?? [
    stateView(0, {
      onBase: row.changeKind !== 'added',
      onHead: row.changeKind !== 'removed',
      renderStatus: row.renderStatus,
      visualChange: row.visualChange,
      baseImageUrl: row.baseImageUrl,
      headImageUrl: row.headImageUrl,
      diffImageUrl: row.diffImageUrl,
      imageWidth: row.imageWidth,
      imageHeight: row.imageHeight,
      diffPixelRatio: row.diffPixelRatio,
      baseError: row.baseError,
      headError: row.headError,
    }),
  ];
  return {
    ...row,
    changedStateCount: overrides.changedStateCount ?? (overrides.states ? row.changedStateCount : changed ? 1 : 0),
    states,
  };
}

export function repairJobView(overrides: Partial<LibraryJobView> = {}): LibraryJobView {
  return {
    id: 21,
    repositoryId: 1,
    repositoryName: 'sample-react-app',
    kind: 'repair',
    status: 'running',
    visualizationId: 7,
    componentIds: [11, 12],
    stateAllowance: 3,
    spendCapUsd: null,
    spentUsd: 0.4,
    priceExact: true,
    totalCount: 2,
    writtenCount: 1,
    failedCount: 0,
    skippedCount: 0,
    processedCount: 1,
    currentLabel: null,
    scanSha: null,
    aiModel: 'claude-opus-5-5',
    errorMessage: null,
    createdAt: '2026-10-03T10:05:00Z',
    startedAt: '2026-10-03T10:05:01Z',
    completedAt: null,
    ...overrides,
  };
}

export function consoleEvent(id: number, overrides: Partial<ConsoleEventView> = {}): ConsoleEventView {
  return {
    id,
    level: 'info',
    stage: 'rendering',
    message: `event ${id}`,
    createdAt: '2026-10-03T10:01:03Z',
    ...overrides,
  };
}

export function consoleEvents(fromId: number, count: number): ConsoleEventView[] {
  return Array.from({ length: count }, (_, i) => consoleEvent(fromId + i));
}
