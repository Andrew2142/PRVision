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
    title: 'Claude Code (your subscription)',
    description:
      'Runs the Claude Code CLI installed on this machine with the account it is signed in to, such as your Pro or Max plan. Run `claude auth login` once in a terminal. No key is stored in PRVision.',
  },
];

/** Revision 10 note, shown whenever the Claude Code provider is selected. */
export const CLAUDE_CODE_POLICY_NOTE =
  "Runs count against your Claude plan's usage limits, not an API bill. Anthropic's rules for using a " +
  'subscription outside Claude Code itself have changed several times; check its current terms before relying on this.';

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
