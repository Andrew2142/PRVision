import { enumValues, type ValueOf } from "../utility/value-of";

export const AiProviderKind = {
  ANTHROPIC_API: "anthropic_api",
  /** Legacy: the Claude Code provider was removed. Kept only so existing rows stay valid; not selectable. */
  CLAUDE_CODE: "claude_code"
} as const;
export type AiProviderKind = ValueOf<typeof AiProviderKind>;
export const AI_PROVIDER_KIND_VALUES = enumValues(AiProviderKind);
/** Providers a user can select and save (excludes the legacy claude_code). */
export const SELECTABLE_AI_PROVIDER_KIND_VALUES = [AiProviderKind.ANTHROPIC_API] as const;
