// Enum values from 00 §5, mirrored as `as const` arrays plus union types.

export const AI_PROVIDER_KINDS = ['anthropic_api', 'claude_code'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof AI_EFFORTS)[number];

export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn'] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export const REPOSITORY_FRAMEWORKS = ['react_vite', 'angular'] as const;
export type RepositoryFramework = (typeof REPOSITORY_FRAMEWORKS)[number];

export const SOURCE_TYPES = ['github_pr', 'local_branch', 'working_tree', 'commit_range'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const VISUALIZATION_STATUSES = [
  'queued',
  'preparing',
  'analyzing',
  'awaiting_confirmation',
  'generating_harnesses',
  'rendering',
  'diffing',
  'summarizing',
  'completed',
  'failed',
  'cancelled',
] as const;
export type VisualizationStatus = (typeof VISUALIZATION_STATUSES)[number];

export const TERMINAL_VISUALIZATION_STATUSES = ['completed', 'failed', 'cancelled'] as const;
export type TerminalVisualizationStatus = (typeof TERMINAL_VISUALIZATION_STATUSES)[number];

export const CHANGE_KINDS = ['modified', 'added', 'removed', 'affected_parent', 'replaced'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const RENDER_STATUSES = ['pending', 'rendered', 'partial', 'failed', 'skipped'] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

export const VISUAL_CHANGES = ['changed', 'unchanged', 'new', 'deleted'] as const;
export type VisualChange = (typeof VISUAL_CHANGES)[number];

export const RISKS = ['none', 'check', 'likely_regression'] as const;
export type Risk = (typeof RISKS)[number];

export const CONSOLE_LEVELS = ['info', 'warn', 'error'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];
