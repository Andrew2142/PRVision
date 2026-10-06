import { type AiProviderKind, type Effort } from '../../core/models/domain-enums.model';
import { type ThemeMode } from '../../core/services/theme.service';
import { type SegmentOption } from '../../shared/components/segmented-control/segmented-control.component';

export const DEFAULT_AI_MODEL = 'claude-opus-5-5';

export const PROVIDER_OPTIONS: readonly { value: AiProviderKind; title: string; description: string }[] = [
  {
    value: 'anthropic_api',
    title: 'Anthropic API key',
    description:
      'Calls the Anthropic API directly with your API key. Usage is billed to the account that owns the key.',
  },
  {
    value: 'claude_code',
    title: 'Claude Code (local login)',
    description:
      'Uses the Claude Code CLI installed on this machine and the account it is signed in to. Run `claude` once in a terminal to sign in. No key is stored in PRVision.',
  },
];

/** 00 D5 policy note, shown whenever the Claude Code provider is selected. */
export const CLAUDE_CODE_POLICY_NOTE =
  'Personal prototype only. Anthropic does not allow third-party products to route requests through Claude.ai ' +
  'subscription logins. Using your own Claude Code login is acceptable for this local prototype; before PRVision ' +
  'is shared or distributed, this option must switch to API-key authentication or be removed.';

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
