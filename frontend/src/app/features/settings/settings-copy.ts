import { type Effort } from '../../core/models/domain-enums.model';
import { type ThemeMode } from '../../core/services/theme.service';
import { type SegmentOption } from '../../shared/components/segmented-control/segmented-control.component';

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

/** Shown when the saved settings still name the removed Claude Code provider (legacy `claude_code`). */
export const LEGACY_PROVIDER_NOTE =
  'Claude Code is no longer supported. PRVision now uses an Anthropic API key: add one below (or keep the saved key) and save.';

export const THEME_OPTIONS: readonly SegmentOption<ThemeMode>[] = [
  { value: 'dark', label: 'Dark', icon: 'dark_mode' },
  { value: 'light', label: 'Light', icon: 'light_mode' },
];

export const EFFORT_OPTIONS: readonly { value: Effort; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest, least thorough' },
  { value: 'medium', label: 'Medium', hint: 'Balanced' },
  { value: 'high', label: 'High', hint: 'Thorough (recommended for harnesses)' },
  { value: 'xhigh', label: 'Extra high', hint: 'Slower, more tokens' },
  { value: 'max', label: 'Max', hint: 'Slowest, highest token use' },
];
