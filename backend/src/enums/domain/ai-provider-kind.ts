import { enumValues, type ValueOf } from "../utility/value-of";

export const AiProviderKind = { ANTHROPIC_API: "anthropic_api", CLAUDE_CODE: "claude_code" } as const;
export type AiProviderKind = ValueOf<typeof AiProviderKind>;
export const AI_PROVIDER_KIND_VALUES = enumValues(AiProviderKind);
