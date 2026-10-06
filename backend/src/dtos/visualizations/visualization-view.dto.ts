import type { RepositoryFramework } from "../../enums";
import type { VisualizationModel } from "../../models";
import { toIsoString, toIsoStringOrNull } from "../../utilities";
import type { VisualizationComponentView } from "./visualization-component-view.dto";

type SourceType = "github_pr" | "local_branch" | "working_tree" | "commit_range";
type Status =
  | "queued"
  | "preparing"
  | "analyzing"
  | "awaiting_confirmation"
  | "generating_harnesses"
  | "rendering"
  | "diffing"
  | "summarizing"
  | "completed"
  | "failed"
  | "cancelled";

/** Row of GET /api/visualizations (00 §9). */
export interface VisualizationSummaryView {
  id: number;
  repositoryId: number;
  repositoryName: string;
  sourceType: SourceType;
  prNumber: number | null;
  title: string;
  baseRef: string;
  headRef: string;
  /** Resolved commits; set from create for commit_range (00 §16), otherwise once preparing has resolved them. */
  baseSha: string | null;
  headSha: string | null;
  status: Status;
  componentCount: number;
  changedCount: number;
  createdAt: string;
  completedAt: string | null;
}

/** GET /api/visualizations/:id (00 §9 + §14.4 failedStage, §15 item 6 framework). */
export interface VisualizationDetailView extends VisualizationSummaryView {
  /** Framework of the visualization's repository (15 §5.9.1): drives framework-aware labels in the UI. */
  framework: RepositoryFramework;
  errorMessage: string | null;
  summaryMarkdown: string | null;
  failedStage: Exclude<Status, "completed" | "failed" | "cancelled"> | null;
  /** The confirmed component limit; null = the default (00 §19). */
  componentLimit: number | null;
  aiProvider: string;
  aiModel: string;
  aiUsage: { inputTokens: number; outputTokens: number; calls: number } | null;
  startedAt: string | null;
  components: VisualizationComponentView[];
}

/** 202 body of POST /api/visualizations (00 §9). */
export interface CreateVisualizationResponse {
  visualizationId: number;
  jobId: string;
}

/** Body of POST /api/visualizations/:id/cancel (00 §14.4). */
export interface CancelVisualizationResponse {
  id: number;
  status: "cancelled" | "cancel_requested";
}

/** Body of DELETE /api/visualizations/:id (00 §14.4). */
export interface DeleteVisualizationResponse {
  id: number;
}

/** Maps a visualization row (+ its repository name) to the list view. */
export function toVisualizationSummaryView(v: VisualizationModel, repositoryName: string): VisualizationSummaryView {
  return {
    id: v.id,
    repositoryId: v.repositoryId,
    repositoryName,
    sourceType: v.sourceType,
    prNumber: v.prNumber,
    title: v.title,
    baseRef: v.baseRef,
    headRef: v.headRef,
    baseSha: v.baseSha,
    headSha: v.headSha,
    status: v.status,
    componentCount: v.componentCount,
    changedCount: v.changedCount,
    createdAt: toIsoString(v.createdAt),
    completedAt: toIsoStringOrNull(v.completedAt)
  };
}

/** Maps a visualization row, its repository name and framework, and its component views to the detail view. */
export function toVisualizationDetailView(
  v: VisualizationModel,
  repository: { name: string; framework: RepositoryFramework },
  components: VisualizationComponentView[]
): VisualizationDetailView {
  return {
    ...toVisualizationSummaryView(v, repository.name),
    framework: repository.framework,
    errorMessage: v.errorMessage,
    summaryMarkdown: v.summaryMarkdown,
    failedStage: v.failedStage, // null unless failed/cancelled (00 §14.4)
    componentLimit: v.componentLimit,
    aiProvider: v.aiProvider,
    aiModel: v.aiModel,
    aiUsage: v.aiUsage
      ? { inputTokens: v.aiUsage.inputTokens, outputTokens: v.aiUsage.outputTokens, calls: v.aiUsage.calls }
      : null,
    startedAt: toIsoStringOrNull(v.startedAt),
    components
  };
}
