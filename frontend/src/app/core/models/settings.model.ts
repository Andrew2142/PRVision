import { type AiProviderKind, type Effort } from './domain-enums.model';

export interface SettingsView {
  hasGithubToken: boolean;
  githubLogin: string | null;
  aiProvider: AiProviderKind;
  hasAnthropicApiKey: boolean;
  aiModel: string;
  aiHarnessEffort: Effort;
  aiSummaryEffort: Effort;
}

/**
 * PUT /api/settings — partial update (00 §14.4). Secret fields (githubToken, anthropicApiKey):
 * omitted → keep stored value; "" → clear; non-empty string → replace. `null` is never sent (the API answers 400).
 */
export interface SettingsUpdateRequest {
  githubToken?: string;
  anthropicApiKey?: string;
  aiProvider?: AiProviderKind;
  aiModel?: string;
  aiHarnessEffort?: Effort;
  aiSummaryEffort?: Effort;
}

/** POST /api/settings/test-github → 200 (00 §14.4). */
export interface GithubTestResultView {
  login: string;
}

/** POST /api/settings/test-ai → 200 (00 §14.4). */
export interface AiTestResultView {
  provider: AiProviderKind;
  model: string;
  latencyMs: number;
}
