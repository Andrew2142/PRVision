import { enumValues, type ValueOf } from "../utility/value-of";

/** `agent` (17 §6.1) is chosen per run only: the Claude Code session that started the run answers its AI requests. */
export const AiProviderKind = { ANTHROPIC_API: "anthropic_api", CLAUDE_CODE: "claude_code", AGENT: "agent" } as const;
export type AiProviderKind = ValueOf<typeof AiProviderKind>;
export const AI_PROVIDER_KIND_VALUES = enumValues(AiProviderKind);

/** Providers Settings may store (17 E1). `agent` is never a setting. */
export const SELECTABLE_AI_PROVIDER_KINDS = [
  "anthropic_api",
  "claude_code"
] as const satisfies readonly AiProviderKind[];
export type SelectableAiProviderKind = (typeof SELECTABLE_AI_PROVIDER_KINDS)[number];
