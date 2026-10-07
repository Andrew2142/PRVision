// Enum values from 00 §5, mirrored as `as const` arrays plus union types.

/** `claude_code` is legacy: the provider was removed, but old settings and visualizations may still carry it. */
export const AI_PROVIDER_KINDS = ['anthropic_api', 'claude_code'] as const;
export type AiProviderKind = (typeof AI_PROVIDER_KINDS)[number];
/** The only provider that can be saved. */
export type SelectableAiProviderKind = 'anthropic_api';

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

/** `rechecked`: a saved harness re-rendered because a global style changed (16 E11). */
export const CHANGE_KINDS = ['modified', 'added', 'removed', 'affected_parent', 'replaced', 'rechecked'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const RENDER_STATUSES = ['pending', 'rendered', 'partial', 'failed', 'skipped'] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

export const VISUAL_CHANGES = ['changed', 'unchanged', 'new', 'deleted'] as const;
export type VisualChange = (typeof VISUAL_CHANGES)[number];

export const RISKS = ['none', 'check', 'likely_regression'] as const;
export type Risk = (typeof RISKS)[number];

export const CONSOLE_LEVELS = ['info', 'warn', 'error'] as const;
export type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

// Harness library (sheet 16 §6.1).

export const LIBRARY_BUILD_MODES = ['grow', 'scan'] as const;
export type LibraryBuildMode = (typeof LIBRARY_BUILD_MODES)[number];

export const LIBRARY_JOB_KINDS = ['scan', 'rescan', 'repair'] as const;
export type LibraryJobKind = (typeof LIBRARY_JOB_KINDS)[number];

export const LIBRARY_JOB_STATUSES = [
  'queued',
  'preparing',
  'running',
  'completed',
  'cap_reached',
  'failed',
  'cancelled',
] as const;
export type LibraryJobStatus = (typeof LIBRARY_JOB_STATUSES)[number];

export const TERMINAL_LIBRARY_JOB_STATUSES = ['completed', 'cap_reached', 'failed', 'cancelled'] as const;
export type TerminalLibraryJobStatus = (typeof TERMINAL_LIBRARY_JOB_STATUSES)[number];

export const LIVE_SESSION_STATUSES = ['starting', 'ready', 'stopping', 'stopped', 'failed'] as const;
export type LiveSessionStatus = (typeof LIVE_SESSION_STATUSES)[number];

/** Where a run row's harness came from (16 §6.1 `ComponentHarnessOrigin`). */
export const HARNESS_ORIGINS = ['library', 'written', 'repaired'] as const;
export type HarnessOrigin = (typeof HARNESS_ORIGINS)[number];
