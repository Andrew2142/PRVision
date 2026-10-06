import {
  TERMINAL_VISUALIZATION_STATUSES,
  type TerminalVisualizationStatus,
  type VisualizationStatus,
} from '../models/domain-enums.model';

export interface PipelineStage {
  status: Exclude<VisualizationStatus, TerminalVisualizationStatus>;
  label: string;
  icon: string;
}

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  { status: 'queued', label: 'Queued', icon: 'schedule' },
  { status: 'preparing', label: 'Preparing workspace', icon: 'folder_copy' },
  { status: 'analyzing', label: 'Analyzing changes', icon: 'manage_search' },
  { status: 'generating_harnesses', label: 'Generating harnesses', icon: 'auto_awesome' },
  { status: 'rendering', label: 'Rendering', icon: 'photo_camera' },
  { status: 'diffing', label: 'Diffing', icon: 'difference' },
  { status: 'summarizing', label: 'Summarizing', icon: 'summarize' },
];

export function isTerminalStatus(status: VisualizationStatus): status is TerminalVisualizationStatus {
  return (TERMINAL_VISUALIZATION_STATUSES as readonly string[]).includes(status);
}

/**
 * Index in PIPELINE_STAGES for a stage name (a non-terminal status or a console `stage`); -1 otherwise.
 * Console event `stage` values are the pipeline status names (00 §14.4), so this serves both.
 */
export function stageIndex(stage: string): number {
  // Paused after analysis waiting for the user's component-limit choice: shown on the Analyzing step.
  const status = stage === 'awaiting_confirmation' ? 'analyzing' : stage;
  return PIPELINE_STAGES.findIndex((s) => s.status === status);
}
