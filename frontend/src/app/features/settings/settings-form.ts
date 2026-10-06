import {
  type AbstractControl,
  type FormControl,
  type FormGroup,
  type ValidationErrors,
  type ValidatorFn,
  Validators,
} from '@angular/forms';
import { type AiProviderKind, type Effort } from '../../core/models/domain-enums.model';
import { type SettingsUpdateRequest, type SettingsView } from '../../core/models/settings.model';

export interface SettingsFormValue {
  githubToken: string;
  aiProvider: AiProviderKind;
  anthropicApiKey: string;
  aiModel: string;
  aiHarnessEffort: Effort;
  aiSummaryEffort: Effort;
}

export interface SecretClearFlags {
  githubToken: boolean;
  anthropicApiKey: boolean;
}

export type SecretField = keyof SecretClearFlags;

/** Only changed fields are sent. Secrets: omitted = keep, "" = clear, non-empty string = replace (00 §14.4). */
export function buildSettingsUpdate(
  saved: SettingsView,
  form: SettingsFormValue,
  clear: SecretClearFlags,
): SettingsUpdateRequest {
  const update: SettingsUpdateRequest = {};
  const token = form.githubToken.trim();
  if (clear.githubToken) update.githubToken = '';
  else if (token) update.githubToken = token;
  const key = form.anthropicApiKey.trim();
  if (clear.anthropicApiKey) update.anthropicApiKey = '';
  else if (key) update.anthropicApiKey = key;
  if (form.aiProvider !== saved.aiProvider) update.aiProvider = form.aiProvider;
  const model = form.aiModel.trim();
  if (model !== saved.aiModel) update.aiModel = model;
  if (form.aiHarnessEffort !== saved.aiHarnessEffort) update.aiHarnessEffort = form.aiHarnessEffort;
  if (form.aiSummaryEffort !== saved.aiSummaryEffort) update.aiSummaryEffort = form.aiSummaryEffort;
  return update;
}

export const NO_WHITESPACE = Validators.pattern(/^\S*$/);

/** Same rule as 05's SettingsUpdateDTO.aiModel (`^[a-z0-9][a-z0-9.-]*$`, max 100), so the form never sends a model the API rejects. */
export const AI_MODEL_PATTERN = /^[a-z0-9][a-z0-9.-]*$/;

/** Group validator: anthropic_api needs a saved key (not being cleared) or a newly typed key. */
export function anthropicKeyRequired(hasSavedKey: () => boolean, clearing: () => boolean): ValidatorFn {
  return (control: AbstractControl): ValidationErrors | null => {
    const group = control as FormGroup<{
      aiProvider: FormControl<AiProviderKind>;
      anthropicApiKey: FormControl<string>;
    }>;
    if (group.controls.aiProvider.value !== 'anthropic_api') return null;
    const usable = (hasSavedKey() && !clearing()) || group.controls.anthropicApiKey.getRawValue().trim().length > 0;
    return usable ? null : { anthropicKeyRequired: true };
  };
}

export function githubTokenHint(value: string): string | null {
  const v = value.trim();
  if (!v || v.startsWith('github_pat_') || v.startsWith('ghp_')) return null;
  return 'This does not look like a GitHub token (expected github_pat_… or ghp_…).';
}

export function anthropicKeyHint(value: string): string | null {
  const v = value.trim();
  return !v || v.startsWith('sk-ant-') ? null : 'Anthropic API keys usually start with sk-ant-.';
}
