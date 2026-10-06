// Test data builders shared by the visualization specs (not part of the app bundle: only specs import this file).
import {
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
    ...overrides,
  };
}

export function componentView(overrides: Partial<VisualizationComponentView> = {}): VisualizationComponentView {
  return {
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
