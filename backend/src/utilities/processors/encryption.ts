import crypto from "node:crypto";
import { PRVISION_SECRET_KEY } from "../../config-consts";

const IV_BYTES = 12;
const TAG_BYTES = 16;
const BASE64_PART = /^[A-Za-z0-9+/]*={0,2}$/;

/** Encryption failure. The message contains only the reason, never plaintext, ciphertext or the key. */
export class EncryptionError extends Error {
  constructor(
    readonly reason: "missing_key" | "malformed_payload" | "decrypt_failed",
    options?: { cause?: unknown }
  ) {
    super(`Encryption error: ${reason}`, options);
    this.name = "EncryptionError";
  }
}

let keyOverride: string | null = null;

/**
 * Reversible encryption of secrets at rest (GitHub token, Anthropic API key): AES-256-GCM with a key derived as
 * sha256(utf8(PRVISION_SECRET_KEY)), a random 12-byte IV and the payload `base64(iv).base64(tag).base64(ct)`.
 * Compatible with Uply-v2's algorithm; unlike Uply, malformed input throws instead of passing through.
 */
export class Encryption {
  /** Encrypts a UTF-8 string. Throws EncryptionError("missing_key") when no key is configured. */
  static encrypt(value: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", Encryption.getSecretKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [iv, authTag, encrypted].map((part) => part.toString("base64")).join(".");
  }

  /**
   * Decrypts a payload produced by encrypt.
   *
   * @throws EncryptionError("malformed_payload") when not 3 base64 parts with a 12-byte IV and 16-byte tag;
   *   EncryptionError("decrypt_failed") when GCM authentication fails (wrong key or tampered payload).
   */
  static decrypt(payload: string): string {
    const parts = Encryption.parsePayload(payload);
    if (!parts) {
      throw new EncryptionError("malformed_payload");
    }
    const key = Encryption.getSecretKey();
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, parts.iv);
      decipher.setAuthTag(parts.tag);
      return Buffer.concat([decipher.update(parts.ciphertext), decipher.final()]).toString("utf8");
    } catch (error: unknown) {
      throw new EncryptionError("decrypt_failed", { cause: error });
    }
  }

  /** True when `value` has the payload shape (does not verify the key). */
  static isEncryptedPayload(value: string): boolean {
    return Encryption.parsePayload(value) !== null;
  }

  /** Test hook: overrides the key for the current process (null restores PRVISION_SECRET_KEY). */
  static setKeyForTesting(secret: string | null): void {
    keyOverride = secret;
  }

  private static parsePayload(payload: string): { iv: Buffer; tag: Buffer; ciphertext: Buffer } | null {
    const parts = payload.split(".");
    if (parts.length !== 3 || parts.some((part) => !BASE64_PART.test(part))) {
      return null;
    }
    const [iv, tag, ciphertext] = parts.map((part) => Buffer.from(part, "base64"));
    if (!iv || !tag || !ciphertext || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      return null;
    }
    return { iv, tag, ciphertext };
  }

  private static getSecretKey(): Buffer {
    const secret = keyOverride ?? PRVISION_SECRET_KEY;
    if (secret === "") {
      throw new EncryptionError("missing_key");
    }
    return crypto.createHash("sha256").update(secret, "utf8").digest();
  }
}
