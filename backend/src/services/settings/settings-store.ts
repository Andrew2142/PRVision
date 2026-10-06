import {
  AI_DEFAULT_HARNESS_EFFORT,
  AI_DEFAULT_MODEL,
  AI_DEFAULT_PROVIDER,
  AI_DEFAULT_SUMMARY_EFFORT
} from "../../config-consts";
import { appSettings } from "../../database/schema";
import { Table } from "../../enums";
import { AppSettingModel } from "../../models";
import { DrizzleDb, Encryption, EncryptionError, QueryHandler, createLogger, type Database } from "../../utilities";
import type {
  AiEffortValue,
  AiProviderKindValue,
  ResolvedAiSettings,
  SecretRead
} from "../../utilities/services/ai/ai-provider";

export type { ResolvedAiSettings, SecretRead }; // re-exported for 06/07 convenience

/** The singleton row id of app_settings (00 §6). */
export const SETTINGS_ROW_ID = 1;
/** Versioned prefix of every stored secret; a value without it is never used (no plaintext passthrough). */
export const SECRET_PREFIX = "enc:v1:";

/** Token plus the exact ciphertext it came from, so a later write can be made conditional on it. */
export interface GithubTokenSnapshot {
  secret: SecretRead;
  storedCiphertext: string | null;
}

/** Columns SettingsService may patch. Secrets arrive already encrypted (or null to clear). */
export interface AppSettingsPatch {
  githubTokenEncrypted?: string | null;
  githubLogin?: string | null;
  aiProvider?: AiProviderKindValue;
  anthropicApiKeyEncrypted?: string | null;
  aiModel?: string;
  aiHarnessEffort?: AiEffortValue;
  aiSummaryEffort?: AiEffortValue;
}

type AppSettingsInsert = typeof appSettings.$inferInsert;

/**
 * The only code that reads or writes app_settings (00 §14.8). Not HTTP-facing: returns models and values and
 * throws only on infrastructure failure. SettingsService (HTTP) and sheets 06/07 (readGithubToken,
 * readAiSettings) use it.
 */
export class SettingsStore {
  private static readonly log = createLogger("settings-store");

  constructor(
    private readonly queryHandler: QueryHandler = new QueryHandler(),
    private readonly db: Database = DrizzleDb.getInstance()
  ) {}

  /**
   * Returns the singleton row. The row is seeded by migration 0001 (00 §14.3), so the normal path is one
   * SELECT. Only when it is missing (manual delete) is it re-created with defaults; ON CONFLICT DO NOTHING
   * keeps concurrent first requests race-free.
   */
  async getOrCreate(): Promise<AppSettingModel> {
    const existing = await this.queryHandler.validateAndSelect(
      AppSettingModel,
      { id: SETTINGS_ROW_ID },
      Table.APP_SETTINGS
    );
    if (existing) {
      return existing;
    }
    // Direct Drizzle: QueryHandler has no insert-on-conflict.
    await this.db
      .insert(appSettings)
      .values(SettingsStore.defaultRow())
      .onConflictDoNothing({ target: appSettings.id });
    const row = await this.queryHandler.validateAndSelect(AppSettingModel, { id: SETTINGS_ROW_ID }, Table.APP_SETTINGS);
    if (!row) {
      throw new Error("app_settings row missing after insert");
    }
    return row;
  }

  /**
   * Atomic upsert of the singleton row. Only keys present in `patch` are written.
   *
   * @param patch - Columns to write; undefined keys are left untouched.
   * @returns The row after the write.
   */
  async patch(patch: AppSettingsPatch): Promise<AppSettingModel> {
    const set: Partial<AppSettingsInsert> = { ...SettingsStore.definedOnly(patch), updatedAt: new Date() };
    // Direct Drizzle: QueryHandler has no upsert. Single statement => no read-modify-write race.
    await this.db
      .insert(appSettings)
      .values({ ...SettingsStore.defaultRow(), ...set })
      .onConflictDoUpdate({ target: appSettings.id, set });
    return this.getOrCreate();
  }

  /** The decrypted GitHub token (06 reads it before every GitHub call). */
  async readGithubToken(): Promise<SecretRead> {
    return (await this.readGithubTokenSnapshot()).secret;
  }

  /** Used by test-github: the ciphertext lets setGithubLoginIfTokenUnchanged detect a concurrent token change. */
  async readGithubTokenSnapshot(): Promise<GithubTokenSnapshot> {
    const row = await this.getOrCreate();
    return {
      secret: SettingsStore.readSecret(row.githubTokenEncrypted, "github_token"),
      storedCiphertext: row.githubTokenEncrypted ?? null
    };
  }

  /**
   * Compare-and-set: writes github_login only if the stored token is still the one that was verified.
   *
   * @returns false when the token was replaced or cleared meanwhile (the login is then not written).
   */
  async setGithubLoginIfTokenUnchanged(storedCiphertext: string, login: string): Promise<boolean> {
    const result = await this.queryHandler.update(
      { githubLogin: login },
      { id: SETTINGS_ROW_ID, githubTokenEncrypted: storedCiphertext },
      Table.APP_SETTINGS
    );
    if (result.status === 200) {
      return true;
    }
    if (result.status === 404) {
      return false;
    }
    throw new Error(`app_settings github_login update failed (${result.status})`);
  }

  /**
   * Provider, model, efforts and the decrypted API key from ONE row read, so callers get a consistent snapshot
   * (07 builds the provider and PipelineContext.aiSettings from the same object).
   */
  async readAiSettings(): Promise<ResolvedAiSettings> {
    const row = await this.getOrCreate();
    return {
      provider: row.aiProvider,
      model: row.aiModel,
      harnessEffort: row.aiHarnessEffort,
      summaryEffort: row.aiSummaryEffort,
      anthropicApiKey: SettingsStore.readSecret(row.anthropicApiKeyEncrypted, "anthropic_api_key")
    };
  }

  /** `enc:v1:` + Encryption.encrypt(plain). Throws EncryptionError("missing_key") without a configured key. */
  static encryptSecret(plain: string): string {
    return `${SECRET_PREFIX}${Encryption.encrypt(plain)}`;
  }

  /**
   * Decrypts a stored secret. Never throws. Never logs the value or the error object (it could carry
   * ciphertext); only the secret's name and EncryptionError.reason.
   *
   * @param stored - Column value.
   * @param name - Secret name for logs ("github_token" | "anthropic_api_key").
   */
  static readSecret(stored: string | null | undefined, name: string): SecretRead {
    if (stored === null || stored === undefined || stored === "") {
      return { state: "absent" };
    }
    if (!stored.startsWith(SECRET_PREFIX)) {
      SettingsStore.log.warn(
        { event: "settings.secret.unknown_format", secretName: name },
        "Stored secret has an unknown format"
      );
      return { state: "unreadable" };
    }
    try {
      const value = Encryption.decrypt(stored.slice(SECRET_PREFIX.length));
      return value === "" ? { state: "absent" } : { state: "present", value };
    } catch (error: unknown) {
      // EncryptionError.reason is safe to log ("missing_key" | "malformed_payload" | "decrypt_failed").
      // The name goes in `secretName`: `secret` is a redacted log key (REDACT_PATHS), so 05 §7's field is renamed.
      const reason = error instanceof EncryptionError ? error.reason : "unknown";
      SettingsStore.log.warn(
        { event: "settings.secret.decrypt_failed", secretName: name, reason },
        "Stored secret could not be decrypted"
      );
      return { state: "unreadable" };
    }
  }

  private static defaultRow(): AppSettingsInsert {
    return {
      id: SETTINGS_ROW_ID,
      aiProvider: AI_DEFAULT_PROVIDER,
      aiModel: AI_DEFAULT_MODEL,
      aiHarnessEffort: AI_DEFAULT_HARNESS_EFFORT,
      aiSummaryEffort: AI_DEFAULT_SUMMARY_EFFORT
    };
  }

  private static definedOnly(patch: AppSettingsPatch): Partial<AppSettingsInsert> {
    const set: Partial<AppSettingsInsert> = {};
    if (patch.githubTokenEncrypted !== undefined) {
      set.githubTokenEncrypted = patch.githubTokenEncrypted;
    }
    if (patch.githubLogin !== undefined) {
      set.githubLogin = patch.githubLogin;
    }
    if (patch.aiProvider !== undefined) {
      set.aiProvider = patch.aiProvider;
    }
    if (patch.anthropicApiKeyEncrypted !== undefined) {
      set.anthropicApiKeyEncrypted = patch.anthropicApiKeyEncrypted;
    }
    if (patch.aiModel !== undefined) {
      set.aiModel = patch.aiModel;
    }
    if (patch.aiHarnessEffort !== undefined) {
      set.aiHarnessEffort = patch.aiHarnessEffort;
    }
    if (patch.aiSummaryEffort !== undefined) {
      set.aiSummaryEffort = patch.aiSummaryEffort;
    }
    return set;
  }
}
