import { open, type DB } from "@op-engineering/op-sqlite";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

import { VAULT_DATABASE_NAME, vaultDirectoryPath } from "../../db/client";
import { isWellFormedDatabaseKey } from "../crypto/keyManager";
import { toRawSqlcipherKey } from "../vault/vaultKey";

/**
 * Non-destructive original-vault recovery (every build; offered only for a
 * genuinely missing key — see vaultLockState.ts `canRecoverOriginalVault`).
 *
 * When this phone's vault exists but its key is gone (keyMissing), a key from
 * the user's Google Drive backup may still open it — a first backup uploads
 * the phone's own vault key. This module decides that WITHOUT touching the
 * original vault:
 *
 *  1. The vault's file set (database plus any rollback-journal or WAL/SHM
 *     side files) is copied into a private staging folder (app files dir) — only
 *     after checking free space, and each copy's size is verified, so a
 *     partial copy is rejected rather than probed.
 *  2. Only the COPY is opened with the candidate key (read-write, so a hot
 *     journal is rolled back on the copy, never the original). It must pass
 *     an actual read, SQLCipher's `cipher_integrity_check`, SQLite's
 *     `integrity_check` and the required-table check. A key "matches" only if
 *     it demonstrably opens the copy — never because of account or metadata.
 *  3. The staging copy is always deleted afterwards.
 *
 * The original vault is never opened, written, moved or deleted here, and
 * the candidate key lives only in memory: it is never written to a file,
 * AsyncStorage, a log or the progress record below.
 */

export type ProbeResult =
  | { kind: "match"; journalMode: string }
  /** The key can't read the copy — wrong key (e.g. another phone's). */
  | { kind: "doesNotOpen" }
  /** The key reads the copy but it fails integrity or table checks. */
  | { kind: "corrupt" }
  | { kind: "malformedKey" }
  | { kind: "noVault" }
  | { kind: "insufficientStorage"; neededBytes: number; freeBytes: number }
  /** The copy couldn't be made completely; nothing was probed. */
  | { kind: "copyFailed" };

/** Side files SQLite may keep next to the database, in either journal mode. */
export const VAULT_SIDE_FILE_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
const STAGING_PREFIX = "recovery-probe-";
/** Headroom on top of the copy itself: SQLite needs room to roll back a hot
 * journal or checkpoint WAL on the copy, and the phone needs room to breathe. */
const STORAGE_MARGIN_BYTES = 16 * 1024 * 1024;
const REQUIRED_TABLES = ["notes", "todos", "app_settings"];

type VaultFile = { name: string; size: number };

function fileUri(barePath: string): string {
  return `file://${barePath}`;
}

/** The vault database and whichever side files exist right now. */
export async function listVaultFileSet(): Promise<VaultFile[]> {
  const dir = vaultDirectoryPath();
  const names = [VAULT_DATABASE_NAME, ...VAULT_SIDE_FILE_SUFFIXES.map((suffix) => `${VAULT_DATABASE_NAME}${suffix}`)];
  const files: VaultFile[] = [];
  for (const name of names) {
    const info = await FileSystem.getInfoAsync(fileUri(`${dir}${name}`));
    if (info.exists && !info.isDirectory) {
      files.push({ name, size: info.size ?? 0 });
    }
  }
  return files;
}

/**
 * Where staging copies go: the app's private files directory, in their own
 * `recovery-probe-*` folder beside (never inside) the encrypted vault's
 * files/vault/. (expo-file-system can't create files in op-sqlite's
 * databases/ directory at all — found on device.) The vault itself is only
 * ever read.
 */
function stagingRoot(): string {
  const root = (FileSystem.documentDirectory ?? "").replace(/^file:\/\//, "");
  if (!root) {
    throw new Error("No private app directory available for recovery staging.");
  }
  return root.endsWith("/") ? root : `${root}/`;
}

function isStagingPath(barePath: string): boolean {
  const root = stagingRoot();
  return barePath.startsWith(`${root}${STAGING_PREFIX}`) && !barePath.slice(root.length).includes("..");
}

async function deleteStaging(stagingDir: string): Promise<void> {
  if (!isStagingPath(stagingDir)) {
    throw new Error("Refusing to delete a path outside recovery staging.");
  }
  await FileSystem.deleteAsync(fileUri(stagingDir), { idempotent: true });
}

/** Removes staging copies a previous, interrupted probe left behind. Only
 * `recovery-probe-*` folders inside the staging root are touched. */
export async function cleanupStaleRecoveryStaging(): Promise<number> {
  const dir = stagingRoot();
  let entries: string[];
  try {
    entries = await FileSystem.readDirectoryAsync(fileUri(dir));
  } catch {
    return 0;
  }
  const stale = entries.filter((name) => name.startsWith(STAGING_PREFIX));
  for (const name of stale) {
    await deleteStaging(`${dir}${name}`);
  }
  return stale.length;
}

function firstValue(rows: Record<string, unknown>[] | undefined): unknown {
  const row = rows?.[0];
  return row ? Object.values(row)[0] : undefined;
}

/** Runs the checks on an opened staged copy. */
async function checkStagedCopy(db: DB): Promise<ProbeResult> {
  try {
    // An actual read: with the wrong key SQLCipher fails right here.
    await db.execute("SELECT count(*) FROM sqlite_master");
  } catch {
    return { kind: "doesNotOpen" };
  }
  try {
    const cipherCheck = await db.execute("PRAGMA cipher_integrity_check");
    if ((cipherCheck.rows ?? []).length > 0) {
      return { kind: "corrupt" };
    }
    const integrity = await db.execute("PRAGMA integrity_check");
    if (firstValue(integrity.rows) !== "ok") {
      return { kind: "corrupt" };
    }
    const tables = await db.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(", ")})`,
      REQUIRED_TABLES
    );
    if ((tables.rows ?? []).length !== REQUIRED_TABLES.length) {
      return { kind: "corrupt" };
    }
    const journalMode = String(firstValue((await db.execute("PRAGMA journal_mode")).rows) ?? "unknown");
    return { kind: "match", journalMode };
  } catch {
    return { kind: "corrupt" };
  }
}

/**
 * Tries `candidateKey` against a complete copy of this phone's vault. The
 * original is only ever read (copied); the copy is always deleted.
 */
export async function probeOriginalVaultWithKey(candidateKey: string): Promise<ProbeResult> {
  if (!isWellFormedDatabaseKey(candidateKey)) {
    return { kind: "malformedKey" };
  }
  const files = await listVaultFileSet();
  if (!files.some((file) => file.name === VAULT_DATABASE_NAME)) {
    return { kind: "noVault" };
  }

  const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
  const neededBytes = totalBytes * 2 + STORAGE_MARGIN_BYTES;
  const freeBytes = await FileSystem.getFreeDiskStorageAsync();
  if (freeBytes < neededBytes) {
    return { kind: "insufficientStorage", neededBytes, freeBytes };
  }

  const dir = vaultDirectoryPath();
  const stagingDir = `${stagingRoot()}${STAGING_PREFIX}${Crypto.randomUUID()}/`;
  let staged: DB | null = null;
  try {
    try {
      await FileSystem.makeDirectoryAsync(fileUri(stagingDir), { intermediates: true });
      for (const file of files) {
        await FileSystem.copyAsync({ from: fileUri(`${dir}${file.name}`), to: fileUri(`${stagingDir}${file.name}`) });
        const copied = await FileSystem.getInfoAsync(fileUri(`${stagingDir}${file.name}`));
        if (!copied.exists || (copied.size ?? -1) !== file.size) {
          return { kind: "copyFailed" };
        }
      }
      // The file set must not have changed while copying (it shouldn't: the
      // vault is closed while its key is missing).
      const after = await listVaultFileSet();
      if (after.length !== files.length || after.some((file, index) => file.size !== files[index].size)) {
        return { kind: "copyFailed" };
      }
    } catch {
      return { kind: "copyFailed" };
    }

    try {
      staged = open({
        name: VAULT_DATABASE_NAME,
        location: stagingDir.replace(/\/$/, ""),
        // The same raw-key representation every vault uses (vaultKey.ts).
        encryptionKey: toRawSqlcipherKey(candidateKey),
      });
    } catch {
      return { kind: "doesNotOpen" };
    }
    return await checkStagedCopy(staged);
  } finally {
    try {
      staged?.close();
    } catch {
      // Closing a copy that never opened properly — nothing to keep.
    }
    await deleteStaging(stagingDir).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Progress record — what to tell the user after a restart. Never holds a key.

export type RecoveryPhase = "keyValidated" | "installingKey" | "keyInstalled";
type RecoveryRecord = { version: 1; phase: RecoveryPhase; updatedAt: string };

const RECORD_URI = `${FileSystem.documentDirectory}vault-recovery.json`;

export async function writeRecoveryPhase(phase: RecoveryPhase): Promise<void> {
  const record: RecoveryRecord = { version: 1, phase, updatedAt: new Date().toISOString() };
  const tmp = `${RECORD_URI}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify(record));
  await FileSystem.moveAsync({ from: tmp, to: RECORD_URI });
}

export async function readRecoveryPhase(): Promise<RecoveryPhase | null> {
  try {
    const info = await FileSystem.getInfoAsync(RECORD_URI);
    if (!info.exists) {
      return null;
    }
    const record = JSON.parse(await FileSystem.readAsStringAsync(RECORD_URI)) as Partial<RecoveryRecord>;
    return record.version === 1 && typeof record.phase === "string" ? (record.phase as RecoveryPhase) : null;
  } catch {
    return null;
  }
}

export async function clearRecoveryRecord(): Promise<void> {
  await FileSystem.deleteAsync(RECORD_URI, { idempotent: true });
}
