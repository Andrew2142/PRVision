/**
 * Re-exports the cross-sheet AI contract (00 §8, §14.4) so consumers import from one place, plus the settings
 * types the provider factory needs. Declared here (utilities) so utilities/services/ai never imports services/**
 * (05 §1, 04 §9.4).
 */
import type { AiEffort, AiProviderKind } from "../../../enums";
import type { AiProviderError, AiStructuredRequest, AiUsage } from "../../../types/visualization-pipeline";

export type {
  AiProvider,
  AiStructuredRequest,
  AiStructuredResult,
  AiUsage
} from "../../../types/visualization-pipeline";
export { AiProviderError } from "../../../types/visualization-pipeline";

export type AiEffortValue = (typeof AiEffort)[keyof typeof AiEffort];
export type AiProviderKindValue = (typeof AiProviderKind)[keyof typeof AiProviderKind];
export type AiPurpose = AiStructuredRequest["purpose"];
export type AiProviderErrorReason = AiProviderError["reason"];

/** Result of decrypting a stored secret. */
export type SecretRead = { state: "absent" } | { state: "present"; value: string } | { state: "unreadable" }; // wrong key, tampered, or unknown format

/** Settings as read by SettingsStore.readAiSettings(). The key is decrypted only in memory. */
export interface ResolvedAiSettings {
  provider: AiProviderKindValue;
  model: string;
  harnessEffort: AiEffortValue;
  summaryEffort: AiEffortValue;
  anthropicApiKey: SecretRead;
}

/**
 * Adds two usage records. Used by providers (retries) and by 09/11 accumulation. Each optional cache count
 * (`cacheReadInputTokens`, `cacheWriteInputTokens`, 16 §6.13) is kept only when at least one side reports it; an
 * absent count is 0.
 *
 * @param a - First usage record.
 * @param b - Second usage record.
 * @returns The field-wise sum.
 */
export function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    calls: a.calls + b.calls,
    ...(a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined
      ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) }
      : {}),
    ...(a.cacheWriteInputTokens !== undefined || b.cacheWriteInputTokens !== undefined
      ? { cacheWriteInputTokens: (a.cacheWriteInputTokens ?? 0) + (b.cacheWriteInputTokens ?? 0) }
      : {})
  };
}

/** Neutral element of addUsage (no cache counts: adding it never adds a cache field). */
export const ZERO_USAGE: AiUsage = Object.freeze({ inputTokens: 0, outputTokens: 0, calls: 0 });
