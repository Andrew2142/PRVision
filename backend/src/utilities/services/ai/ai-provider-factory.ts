// Imports only ./ai-provider, the provider and the logger. Never imports services/** (layering rule, 05 §1):
// callers read settings with SettingsStore.readAiSettings() and pass the result in.
import { createLogger } from "../../loggers/logger";
import { AiProviderError, type AiProvider, type AiProviderKindValue, type ResolvedAiSettings } from "./ai-provider";
import { AnthropicApiProvider } from "./anthropic-api-provider";

/** Outcome of AiProviderFactory.readiness. */
export type AiReadiness =
  | { ready: true; provider: AiProviderKindValue; model: string }
  | { ready: false; reason: "ai_not_configured"; message: string };

export const AI_MESSAGE_NO_MODEL = "No AI model is configured. Set a model in Settings.";
export const AI_MESSAGE_KEY_ABSENT = "Add an Anthropic API key in Settings.";
/** Settings saved by an older build still name the removed Claude Code provider (legacy `claude_code`). */
export const AI_MESSAGE_LEGACY_PROVIDER =
  "The Claude Code provider is no longer available. Add an Anthropic API key in Settings and save.";
export const AI_MESSAGE_KEY_UNREADABLE =
  "The stored Anthropic API key can no longer be decrypted (PRVISION_SECRET_KEY changed). Enter the key again.";

const log = createLogger("ai.provider_factory");

/** Builds the configured AiProvider from already-resolved settings. Pure: never reads the database. */
export class AiProviderFactory {
  /**
   * Cheap check used by 07 at POST /api/visualizations (no network, no model call): create(settings) in
   * try/catch. Non-AiProviderError exceptions reject the promise. Synchronous work, but it stays a Promise so the
   * 00 §14.7 signature and its callers are unchanged.
   */
  static readiness(settings: ResolvedAiSettings): Promise<AiReadiness> {
    return new Promise<AiReadiness>((resolve) => {
      try {
        AiProviderFactory.create(settings);
      } catch (error: unknown) {
        if (error instanceof AiProviderError && error.reason === "config") {
          resolve({ ready: false, reason: "ai_not_configured", message: error.message });
          return;
        }
        throw error; // a throw inside the executor rejects the promise
      }
      resolve({ ready: true, provider: settings.provider, model: settings.model });
    });
  }

  /**
   * Pure construction from resolved settings.
   *
   * @throws AiProviderError(reason "config") when the model is empty, the API key is absent/unreadable, or the
   *   stored provider is the legacy claude_code.
   */
  static create(settings: ResolvedAiSettings): AiProvider {
    const model = settings.model.trim();
    if (model === "") {
      throw new AiProviderError(AI_MESSAGE_NO_MODEL, "config", false);
    }
    let provider: AiProvider;
    switch (settings.provider) {
      case "anthropic_api": {
        const key = settings.anthropicApiKey;
        if (key.state === "absent") {
          throw new AiProviderError(AI_MESSAGE_KEY_ABSENT, "config", false);
        }
        if (key.state === "unreadable") {
          throw new AiProviderError(AI_MESSAGE_KEY_UNREADABLE, "config", false);
        }
        provider = new AnthropicApiProvider({ apiKey: key.value, model });
        break;
      }
      case "claude_code":
        // Legacy value kept so old rows stay valid; the provider was removed and is never constructed.
        throw new AiProviderError(AI_MESSAGE_LEGACY_PROVIDER, "config", false);
      default:
        // Impossible by the CHECK constraint; kept for rows edited by hand.
        throw new AiProviderError("Unknown AI provider", "config", false);
    }
    log.info({ event: "ai.provider.created", provider: settings.provider, model }, "AI provider created");
    return provider;
  }
}
