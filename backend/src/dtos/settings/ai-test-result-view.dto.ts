import type { AiProviderKind } from "../../enums";

/** POST /api/settings/test-ai → 200 (00 §14.4). */
export interface AiTestResultView {
  provider: AiProviderKind;
  /** Model id that actually answered (AiStructuredResult.model; differs from settings after a server-side fallback). */
  model: string;
  /** Wall time of generateStructured, integer ms. */
  latencyMs: number;
}
