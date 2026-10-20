/**
 * The encrypted Google Drive backup format, version 2 ("xayra2-" files in the
 * hidden app-data folder). Legacy `remi_backup.db` / `remi_backup.key` are a
 * different format and are never written by this code.
 *
 *  xayra2-keyring-<keyId>.json   the account's backup key (Standard Protection:
 *                                stored in the Google account by design — see
 *                                the Settings copy)
 *  xayra2-device-<vaultId>-<fp>.db   one phone's vault key, inside a SQLCipher
 *                                file keyed with the backup key (lets that phone
 *                                reopen its own vault after a fingerprint change)
 *  xayra2-gen-<genId>.db         one backup generation: SQLCipher, backup key
 *  xayra2-gen-<genId>.json       its manifest — the commit point. A generation
 *                                counts only once its manifest exists, and is
 *                                used for restore only once verified
 *                                (appProperties.verifiedAt).
 */

export const V2_PREFIX = "xayra2-";
export const KEYRING_PREFIX = `${V2_PREFIX}keyring-`;
export const DEVICE_PREFIX = `${V2_PREFIX}device-`;
export const XKEYRING_PREFIX = `${V2_PREFIX}xkeyring-`;
export const MODE_PREFIX = `${V2_PREFIX}mode-`;
export const GENERATION_PREFIX = `${V2_PREFIX}gen-`;
export const LEGACY_DB_NAME = "remi_backup.db";
export const LEGACY_KEY_NAME = "remi_backup.key";

const HEX64 = /^[0-9a-f]{64}$/;
const ID = /^[0-9a-f-]{8,64}$/;

export type Keyring = {
  format: "xayra-keyring";
  version: 1;
  mode: "standard";
  keyId: string;
  key: string;
  createdAt: string;
};

export function keyringFileName(keyId: string): string {
  return `${KEYRING_PREFIX}${keyId}.json`;
}

export function parseKeyring(text: string): Keyring | null {
  try {
    const k = JSON.parse(text) as Partial<Keyring>;
    if (
      k.format === "xayra-keyring" &&
      k.version === 1 &&
      k.mode === "standard" &&
      typeof k.keyId === "string" &&
      ID.test(k.keyId) &&
      typeof k.key === "string" &&
      HEX64.test(k.key) &&
      typeof k.createdAt === "string"
    ) {
      return k as Keyring;
    }
  } catch {
    // fall through
  }
  return null;
}

export type GenerationManifest = {
  format: "xayra-backup-manifest";
  version: 1;
  genId: string;
  keyId: string;
  dbFileId: string;
  sizeBytes: number;
  md5: string;
  counts: { notes: number; todos: number };
  noteIdDigest: string;
  todoIdDigest: string;
  parents: string[];
  vaultId: string;
  createdAt: string;
};

export function generationDbName(genId: string): string {
  return `${GENERATION_PREFIX}${genId}.db`;
}

export function generationManifestName(genId: string): string {
  return `${GENERATION_PREFIX}${genId}.json`;
}

export function parseManifest(text: string): GenerationManifest | null {
  try {
    const m = JSON.parse(text) as Partial<GenerationManifest>;
    const ok =
      m.format === "xayra-backup-manifest" &&
      m.version === 1 &&
      typeof m.genId === "string" &&
      ID.test(m.genId) &&
      typeof m.keyId === "string" &&
      ID.test(m.keyId) &&
      typeof m.dbFileId === "string" &&
      m.dbFileId.length > 0 &&
      typeof m.sizeBytes === "number" &&
      typeof m.md5 === "string" &&
      typeof m.counts?.notes === "number" &&
      typeof m.counts?.todos === "number" &&
      typeof m.noteIdDigest === "string" &&
      typeof m.todoIdDigest === "string" &&
      Array.isArray(m.parents) &&
      typeof m.vaultId === "string" &&
      typeof m.createdAt === "string";
    return ok ? (m as GenerationManifest) : null;
  } catch {
    return null;
  }
}

/** `keyId` (the backup key the entry is encrypted with) is part of the name
 * so a phone's Standard and Extra Privacy entries are distinct files. */
export function deviceEntryName(vaultId: string, keyFingerprint: string, keyId: string): string {
  return `${DEVICE_PREFIX}${vaultId}-${keyFingerprint}-${keyId.slice(0, 8)}.db`;
}

/** A backup key in memory. Standard keys come from the plaintext keyring in
 * the Google account; Extra Privacy keys only from a recovery-code-protected
 * keyring, this phone's fingerprint-protected store, or the local escrow. */
export type BackupKey = { keyId: string; key: string; mode: "standard" | "extra" };

/**
 * Extra Privacy keyring: a SQLCipher file opened with the recovery code as its
 * passphrase (PBKDF2-HMAC-SHA512, SQLCipher defaults), holding the account's
 * Extra Privacy backup key. A new recovery code is a new epoch file holding
 * the same key; older epochs are removed once the replacement has committed
 * (new epoch verified and the phone's escrow rewritten under the new code).
 */
export function xkeyringName(keyId: string, epoch: number): string {
  return `${XKEYRING_PREFIX}${keyId}-e${epoch}.db`;
}

export function parseXkeyringName(name: string): { keyId: string; epoch: number } | null {
  const m = name.match(/^xayra2-xkeyring-([0-9a-f-]{36})-e(\d+)\.db$/);
  return m ? { keyId: m[1], epoch: Number(m[2]) } : null;
}

/** The account's protection mode. A change is a NEW mode file; the newest
 * (Drive createdTime) is authoritative for every phone. */
export type ModeRecord = { format: "xayra-mode"; version: 1; mode: "standard" | "extra"; keyId: string; createdAt: string };

export function modeFileName(id: string): string {
  return `${MODE_PREFIX}${id}.json`;
}

export function parseModeRecord(text: string): ModeRecord | null {
  try {
    const m = JSON.parse(text) as Partial<ModeRecord>;
    return m.format === "xayra-mode" &&
      m.version === 1 &&
      (m.mode === "standard" || m.mode === "extra") &&
      typeof m.keyId === "string" &&
      ID.test(m.keyId) &&
      typeof m.createdAt === "string"
      ? (m as ModeRecord)
      : null;
  } catch {
    return null;
  }
}
