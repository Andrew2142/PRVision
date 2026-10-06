import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { Encryption, EncryptionError } from "../../../backend/src/utilities/processors/encryption";

const TEST_SECRET = Buffer.alloc(32, 7).toString("base64"); // the preload's fake key

function assertEncryptionError(fn: () => unknown, reason: EncryptionError["reason"]): void {
  assert.throws(fn, (error: unknown) => error instanceof EncryptionError && error.reason === reason);
}

test("Encryption round-trips unicode text", () => {
  const plain = "ghp_example token — ünïcødé 🔐";
  assert.equal(Encryption.decrypt(Encryption.encrypt(plain)), plain);
});

test("Encryption.encrypt produces a different payload each call (random IV)", () => {
  assert.notEqual(Encryption.encrypt("same"), Encryption.encrypt("same"));
});

test("Encryption payload format is three base64 parts with 12-byte IV and 16-byte tag", () => {
  const parts = Encryption.encrypt("value").split(".");
  assert.equal(parts.length, 3);
  assert.equal(Buffer.from(parts[0]!, "base64").length, 12);
  assert.equal(Buffer.from(parts[1]!, "base64").length, 16);
  assert.ok(Encryption.isEncryptedPayload(parts.join(".")));
});

test("Encryption.decrypt of a payload produced by Uply's algorithm with the same secret succeeds", () => {
  // Uply-v2: key = sha256(utf8(secret)), AES-256-GCM, 12-byte IV, base64(iv).base64(tag).base64(ciphertext).
  const key = crypto.createHash("sha256").update(TEST_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update("uply-compatible", "utf8"), cipher.final()]);
  const payload = [iv, cipher.getAuthTag(), ciphertext].map((part) => part.toString("base64")).join(".");
  assert.equal(Encryption.decrypt(payload), "uply-compatible");
});

test("Encryption.decrypt of tampered ciphertext throws decrypt_failed", () => {
  const [iv, tag, ciphertext] = Encryption.encrypt("secret value").split(".");
  const bytes = Buffer.from(ciphertext!, "base64");
  bytes[0] = bytes[0]! ^ 0xff;
  assertEncryptionError(() => Encryption.decrypt([iv, tag, bytes.toString("base64")].join(".")), "decrypt_failed");
});

test("Encryption.decrypt with the wrong key throws decrypt_failed", (t) => {
  const payload = Encryption.encrypt("secret value");
  Encryption.setKeyForTesting(Buffer.alloc(32, 9).toString("base64"));
  t.after(() => {
    Encryption.setKeyForTesting(null);
  });
  assertEncryptionError(() => Encryption.decrypt(payload), "decrypt_failed");
});

test("Encryption.decrypt of a malformed payload throws malformed_payload", () => {
  for (const payload of [
    "",
    "plaintext-token",
    "a.b",
    "a.b.c.d",
    "!!!.###.$$$",
    `${Buffer.alloc(5).toString("base64")}.AA==.AA==`
  ]) {
    assertEncryptionError(() => Encryption.decrypt(payload), "malformed_payload");
  }
});

test("Encryption with an empty key throws missing_key", (t) => {
  Encryption.setKeyForTesting("");
  t.after(() => {
    Encryption.setKeyForTesting(null);
  });
  assertEncryptionError(() => Encryption.encrypt("x"), "missing_key");
});
