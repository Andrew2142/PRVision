import { type PageQuery } from './api.model';
import {
  type ChangeKind,
  type ConsoleLevel,
  type RenderStatus,
  type RepositoryFramework,
  type Risk,
  type SourceType,
  type VisualChange,
  type VisualizationStatus,
} from './domain-enums.model';

export interface VisualizationSummaryView {
  id: number;
  repositoryId: number;
  repositoryName: string;
  sourceType: SourceType;
  prNumber: number | null;
  title: string;
  baseRef: string;
  headRef: string;
  /** Set at create for commit_range (00 §16); for the other sources once the run has resolved its commits. */
  baseSha: string | null;
  headSha: string | null;
  status: VisualizationStatus;
  componentCount: number;
  changedCount: number;
  createdAt: string;
  completedAt: string | null;
}

export interface AiUsageView {
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

export interface VisualizationDetailView extends VisualizationSummaryView {
  /** Framework of the visualization's repository (15 §5.9.1): drives framework-aware labels. */
  framework: RepositoryFramework;
  errorMessage: string | null;
  summaryMarkdown: string | null;
  aiProvider: string;
  aiModel: string;
  aiUsage: AiUsageView | null;
  startedAt: string | null;
  /** Stage active when the run failed or was cancelled; null otherwise (00 §14.4). */
  failedStage: VisualizationStatus | null;
  /** The confirmed component limit; null = the default (12). */
  componentLimit: number | null;
  components: VisualizationComponentView[];
}

export interface ElementAddedChange {
  kind: 'element_added';
  path: string;
  tag: string;
}

export interface ElementRemovedChange {
  kind: 'element_removed';
  path: string;
  tag: string;
}

export interface AttributeChangedChange {
  kind: 'attribute_changed';
  path: string;
  tag: string;
  attribute: string;
  before: string | null;
  after: string | null;
  /** Present for `className` (00 §14.4). */
  tokensAdded?: string[];
  tokensRemoved?: string[];
}

export interface TextChangedChange {
  kind: 'text_changed';
  path: string;
  before: string;
  after: string;
}

export type StructuralChange = ElementAddedChange | ElementRemovedChange | AttributeChangedChange | TextChangedChange;

/** Why a removed component and an added one were paired as a replacement (00 §17). */
export interface SuccessorEvidence {
  kind: 'call_site_swap' | 'git_rename' | 'name_similarity' | 'content_similarity';
  /** call_site_swap: "<place file>: <old reference> → <new reference>". */
  detail: string;
}

export interface VisualizationComponentView {
  id: number;
  filePath: string;
  exportName: string;
  displayName: string;
  changeKind: ChangeKind;
  renderStatus: RenderStatus;
  visualChange: VisualChange | null;
  risk: Risk | null;
  rank: number;
  /** "/artifacts/…" */
  baseImageUrl: string | null;
  headImageUrl: string | null;
  diffImageUrl: string | null;
  imageWidth: number | null;
  imageHeight: number | null;
  diffPixelRatio: number | null;
  codeDiff: string | null;
  structuralDiff: StructuralChange[] | null;
  aiNote: string | null;
  harnessSource: string | null;
  harnessNotes: string | null;
  baseError: string | null;
  headError: string | null;
  /** Why the component is in the set, e.g. "imports changed hook src/hooks/useCart.ts" (00 §14.4). */
  changeReason: string | null;
  /** Why it was not rendered; set when renderStatus is "skipped" (00 §14.4). */
  skipReason: string | null;
  /** The removed component a "replaced" row stands in for; the row's own name and path are the new one (00 §17). */
  baseFilePath: string | null;
  baseExportName: string | null;
  baseDisplayName: string | null;
  /** Why the two were paired ("replaced" rows only). */
  successorEvidence: SuccessorEvidence[] | null;
}

export interface ConsoleEventView {
  id: number;
  level: ConsoleLevel;
  stage: string;
  message: string;
  createdAt: string;
}

export interface CreateVisualizationResponse {
  visualizationId: number;
  jobId: string;
}

/** POST /api/visualizations → 202 (00 §14.4). Discriminated so each source type sends only its fields. */
export interface GithubPrCreateRequest {
  repositoryId: number;
  sourceType: 'github_pr';
  prNumber: number;
  /** Screen size for this run; omitted = the repository's screen size. */
  renderViewport?: 'desktop' | 'tablet' | 'mobile';
}

export interface LocalBranchCreateRequest {
  repositoryId: number;
  sourceType: 'local_branch';
  headRef: string;
  baseRef?: string;
  /** Screen size for this run; omitted = the repository's screen size. */
  renderViewport?: 'desktop' | 'tablet' | 'mobile';
}

/** The UI never sends baseRef for working_tree; the backend compares against the checked-out commit (07). */
export interface WorkingTreeCreateRequest {
  repositoryId: number;
  sourceType: 'working_tree';
  /** Screen size for this run; omitted = the repository's screen size. */
  renderViewport?: 'desktop' | 'tablet' | 'mobile';
}

/** Two commits on one branch (00 §16): `baseSha` must be an ancestor of `headSha`; both full 40-hex SHAs. */
export interface CommitRangeCreateRequest {
  repositoryId: number;
  sourceType: 'commit_range';
  headRef: string;
  baseSha: string;
  headSha: string;
  /** Screen size for this run; omitted = the repository's screen size. */
  renderViewport?: 'desktop' | 'tablet' | 'mobile';
}

export type VisualizationCreateRequest =
  GithubPrCreateRequest | LocalBranchCreateRequest | WorkingTreeCreateRequest | CommitRangeCreateRequest;

/** POST /api/visualizations/:id/cancel: 200 → "cancelled" (job removed while queued), 202 → "cancel_requested". */
export interface CancelVisualizationResponse {
  id: number;
  status: 'cancelled' | 'cancel_requested';
}

/** `statuses` is serialized as one comma-separated `status` query param (e.g. `status=queued,rendering`). */
export interface VisualizationListQuery extends PageQuery {
  statuses?: readonly VisualizationStatus[];
  repositoryId?: number;
}

/** `afterId` is exclusive; events come back oldest first; `limit` defaults to and is capped at 500 (00 §14.4). */
export interface ConsoleQuery {
  afterId?: number;
  limit?: number;
}
