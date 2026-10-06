import type { AiEffort, AiProviderKind } from "../../enums";

/** GET/PUT /api/settings response (00 §9). Secrets are never returned: only whether one is stored. */
export interface SettingsView {
  hasGithubToken: boolean;
  githubLogin: string | null;
  aiProvider: AiProviderKind;
  hasAnthropicApiKey: boolean;
  aiModel: string;
  aiHarnessEffort: AiEffort;
  aiSummaryEffort: AiEffort;
}
