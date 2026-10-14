import { isWellFormedDatabaseKey } from "../crypto/keyManager";

/**
 * The exact bytes handed to SQLCipher for a vault key.
 *
 * keyManager stores 32 random bytes as 64 lowercase hex characters. op-sqlite
 * passes the `encryptionKey` string's bytes unchanged to `sqlite3_key_v2`
 * (and `ATTACH … KEY ?` passes the bound text the same way). SQLCipher 4 then
 * treats a key as RAW only when it is exactly `x'` + 64 hex characters + `'`
 * (67 bytes, "option 1 — raw key consisting of only the encryption key" in
 * sqlcipher's `sqlcipher_cipher_ctx_key_derive`); anything else, including the
 * bare 64-character hex, is a passphrase run through PBKDF2-HMAC-SHA512
 * (256,000 iterations). The two produce different keys and can't open each
 * other's files.
 *
 * Every vault (normal, migrated, disposable) and every staged copy uses this
 * one function, so the representation can't drift between creation,
 * migration, reopening and recovery. The key is already uniformly random, so
 * skipping the PBKDF2 stretch costs no security and saves ~0.5 s+ per open.
 */
export function toRawSqlcipherKey(hexKey: string): string {
  if (!isWellFormedDatabaseKey(hexKey)) {
    throw new Error("Vault key must be 64 lowercase hex characters.");
  }
  return `x'${hexKey}'`;
}

/** Recorded in the vault pointer; bump only with a deliberate re-key. */
export const VAULT_KEY_FORMAT = "raw-hex-v1";
