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

export function deviceEntryName(vaultId: string, keyFingerprint: string): string {
  return `${DEVICE_PREFIX}${vaultId}-${keyFingerprint}.db`;
}
