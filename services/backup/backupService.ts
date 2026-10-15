import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

import { mergeMissingNotes } from "../notes/noteManager";
import { mergeMissingToDos } from "../todos/todoManager";
import { DriveSyncError, NoBackupFoundError } from "../sync/driveErrors";
import { devTiming } from "../ai/perf";
import { devFailAt, devPauseAfter, devWrongKeyAt } from "../dev/devFaults";
import { getOrCreateVaultId, getSessionVaultKey, readVaultId } from "../vault/vaultIdentity";
import { toRawSqlcipherKey } from "../vault/vaultKey";
import { assertAccountAllowed, bindIfUnbound } from "./backupAccount";
import * as db from "./backupDb";
import {
  DEVICE_PREFIX,
  deviceEntryName,
  GENERATION_PREFIX,
  generationDbName,
  generationManifestName,
  KEYRING_PREFIX,
  keyringFileName,
  LEGACY_DB_NAME,
  LEGACY_KEY_NAME,
  parseKeyring,
  parseManifest,
  V2_PREFIX,
  type GenerationManifest,
  type Keyring,
} from "./backupFormat";
import * as drive from "./driveAppData";

/**
 * Standard Protection — encrypted Google Drive backup and restore.
 *
 * Every generation is a SQLCipher database under the account's backup key.
 * In Standard Protection that key is kept in the same Google account (by
 * design: restoring needs nothing but the account) — so the backup is
 * encrypted, but sufficient access to the Google account can decrypt it. The
 * Settings copy says so.
 *
 * Safety rules:
 *  - Files are only ever created, never overwritten. A generation becomes
 *    eligible for restore only after its manifest exists AND an independent
 *    download → decrypt → integrity check → record comparison passed
 *    (appProperties.verifiedAt). An interrupted run leaves, at worst, ignored
 *    files; the previous verified generation stays the restore source.
 *  - Nothing is deleted from Drive (no pruning in this stage). Legacy
 *    remi_backup.* files are never written.
 *  - Each phone writes only its own device entry; concurrent backups from
 *    several phones each produce a generation, and the next run merges every
 *    verified head.
 *  - The phone is bound to the account of its first backup/restore
 *    (backupAccount.ts); a different account is refused.
 *  - Success is reported only after verification.
 */

export type BackupContext = { token: string; accountId: string };

export type BackupOutcome = {
  /** True when nothing would change: no upload happened, and `verifiedAt` /
   * `counts` describe the existing last verified backup. */
  skipped: boolean;
  genId: string;
  verifiedAt: string;
  counts: { notes: number; todos: number };
  added: { notes: number; todos: number; updatedNotes: number; updatedTodos: number };
  sizeBytes: number;
  firstBackup: boolean;
};

export type RestoreOutcome = {
  source: "encrypted" | "legacy";
  backupDate: string;
  restoredNotes: number;
  restoredTodos: number;
};

const FAULT = "backup";
const MAX_MANIFESTS = 40;
const MAX_DEVICE_ENTRIES = 12;

type VerifiedGeneration = { manifest: GenerationManifest; manifestFileId: string; verifiedAt: string };

async function sha256Lines(ids: string[]): Promise<string> {
  return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, [...ids].sort().join("\n"));
}

async function randomHex(bytes = 32): Promise<string> {
  return Array.from(await Crypto.getRandomBytesAsync(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function newId(): string {
  return Crypto.randomUUID().toLowerCase();
}

/** Development builds only: what the Drive folder holds (counts, legacy
 * modified times) — never file contents. */
async function logDriveSummary(token: string, label: string): Promise<void> {
  try {
    const v2 = await drive.listAppDataFiles(token, V2_PREFIX);
    const legacy = await drive.listAppDataFiles(token, "remi_backup.");
    const gens = v2.filter((f) => f.name.startsWith(GENERATION_PREFIX) && f.name.endsWith(".json"));
    devTiming("Backup", `drive ${label}`, {
      keyrings: v2.filter((f) => f.name.startsWith(KEYRING_PREFIX)).length,
      devices: v2.filter((f) => f.name.startsWith(DEVICE_PREFIX)).length,
      generations: gens.length,
      verified: gens.filter((f) => f.appProperties?.verifiedAt).length,
      genDbs: v2.filter((f) => f.name.startsWith(GENERATION_PREFIX) && f.name.endsWith(".db")).length,
      legacy: legacy.map((f) => `${f.name}@${f.modifiedTime}`).join(","),
    });
  } catch {
    // diagnostics only
  }
}

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  await devFailAt(FAULT, name);
  devTiming("Backup", `step ${name}`);
  const result = await run();
  await devPauseAfter(FAULT, name);
  return result;
}

// ---------------------------------------------------------------------------
// Keyrings

async function loadKeyrings(token: string, files: drive.AppDataFile[]): Promise<{ keyring: Keyring; file: drive.AppDataFile }[]> {
  const out: { keyring: Keyring; file: drive.AppDataFile }[] = [];
  for (const file of files.filter((f) => f.name.startsWith(KEYRING_PREFIX)).slice(0, 10)) {
    const keyring = parseKeyring(await drive.downloadText(token, file.id, 4096));
    if (keyring && file.name === keyringFileName(keyring.keyId)) {
      out.push({ keyring, file });
    }
  }
  return out;
}

/** The account's canonical keyring: the oldest valid one. */
function canonical(rings: { keyring: Keyring; file: drive.AppDataFile }[]): Keyring | null {
  const sorted = [...rings].sort(
    (a, b) => (a.file.createdTime ?? "").localeCompare(b.file.createdTime ?? "") || a.file.name.localeCompare(b.file.name)
  );
  return sorted[0]?.keyring ?? null;
}

/**
 * The account's backup key, creating it on the very first backup. If two
 * phones create one at the same moment, both settle on the oldest; a phone
 * whose own just-created keyring lost the race deletes it (nothing uses it).
 */
async function ensureKeyring(token: string): Promise<Keyring> {
  const existing = canonical(await loadKeyrings(token, await drive.listAppDataFiles(token, KEYRING_PREFIX)));
  if (existing) return existing;
  const keyring: Keyring = {
    format: "xayra-keyring",
    version: 1,
    mode: "standard",
    keyId: newId(),
    key: await randomHex(),
    createdAt: new Date().toISOString(),
  };
  const fileId = await drive.createJsonFile(token, keyringFileName(keyring.keyId), keyring, { xayraKind: "keyring", keyId: keyring.keyId });
  const rings = await loadKeyrings(token, await drive.listAppDataFiles(token, KEYRING_PREFIX));
  const winner = canonical(rings);
  if (!winner) {
    throw new DriveSyncError("The backup key couldn't be read back after it was created.");
  }
  if (winner.keyId !== keyring.keyId) {
    await drive.deleteOwnUnreferencedFile(token, fileId);
  }
  return winner;
}

async function keyringById(token: string, keyId: string): Promise<Keyring> {
  const rings = await loadKeyrings(token, await drive.listAppDataFiles(token, KEYRING_PREFIX));
  const ring = rings.find((r) => r.keyring.keyId === keyId)?.keyring;
  if (!ring) {
    throw new DriveSyncError("The key for this backup is missing from your Google account.");
  }
  return ring;
}

// ---------------------------------------------------------------------------
// Device entries

async function keyFingerprint(hexKey: string): Promise<string> {
  return (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `xayra-device-fp:${hexKey}`)).slice(0, 12);
}

/** Records this phone's vault key (inside a file keyed with the backup key),
 * once per vault key. Never touches another phone's entry. Verified by
 * reading it back from Drive. */
async function ensureDeviceEntry(token: string, keyring: Keyring, dir: string): Promise<boolean> {
  const vaultHex = getSessionVaultKey();
  if (!vaultHex) {
    throw new DriveSyncError("Unlock Xayra again, then back up.");
  }
  const vaultId = await getOrCreateVaultId();
  devTiming("Backup", "device: identity ready");
  const name = deviceEntryName(vaultId, await keyFingerprint(vaultHex));
  const existing = await drive.listAppDataFiles(token, name);
  const raw = toRawSqlcipherKey(keyring.key);
  for (const file of existing) {
    const local = `${dir}/check-${file.id}.db`;
    await drive.downloadToDisk(token, file.id, `file://${local}`);
    const entry = await db.readDeviceEntry(dir, `check-${file.id}.db`, raw);
    if (entry?.vaultKeyHex === vaultHex) return false;
  }
  const localName = "device-entry.db";
  devTiming("Backup", "device: writing entry");
  await db.writeDeviceEntry(dir, localName, raw, { vaultId, vaultKeyHex: vaultHex, label: "Android phone" });
  devTiming("Backup", "device: uploading entry");
  const fileId = await drive.createFileFromDisk(token, name, `file://${dir}/${localName}`, {
    xayraKind: "device",
    vaultId,
    keyId: keyring.keyId,
  });
  await drive.downloadToDisk(token, fileId, `file://${dir}/device-verify.db`);
  const verified = await db.readDeviceEntry(dir, "device-verify.db", raw);
  if (verified?.vaultKeyHex !== vaultHex) {
    await drive.deleteOwnUnreferencedFile(token, fileId);
    throw new DriveSyncError("This phone's recovery entry didn't verify after upload.");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Generations

async function listVerifiedGenerations(token: string, files: drive.AppDataFile[]): Promise<VerifiedGeneration[]> {
  const manifests = files
    .filter((f) => f.name.startsWith(GENERATION_PREFIX) && f.name.endsWith(".json") && f.appProperties?.verifiedAt)
    .sort((a, b) => (b.createdTime ?? "").localeCompare(a.createdTime ?? ""))
    .slice(0, MAX_MANIFESTS);
  const out: VerifiedGeneration[] = [];
  for (const file of manifests) {
    const manifest = parseManifest(await drive.downloadText(token, file.id, 16 * 1024));
    if (manifest && file.name === generationManifestName(manifest.genId)) {
      out.push({ manifest, manifestFileId: file.id, verifiedAt: file.appProperties?.verifiedAt ?? "" });
    }
  }
  return out;
}

/** Verified generations no other verified generation has merged ("heads"),
 * newest first. One head normally; several after concurrent backups. */
function heads(verified: VerifiedGeneration[]): VerifiedGeneration[] {
  const merged = new Set(verified.flatMap((g) => g.manifest.parents));
  return verified.filter((g) => !merged.has(g.manifest.genId)).sort((a, b) => b.manifest.createdAt.localeCompare(a.manifest.createdAt));
}

function isSuperset(container: string[], required: string[]): boolean {
  const set = new Set(container);
  return required.every((id) => set.has(id));
}

/**
 * Independent verification of an uploaded generation, from Drive alone:
 * re-read the manifest, re-download the database by the id the manifest
 * names, re-fetch the key from the keyring, decrypt, run the integrity checks
 * and compare the record ids against the manifest. Only then is it marked
 * verified.
 */
async function verifyGenerationOnDrive(token: string, manifestFileId: string, dir: string): Promise<GenerationManifest> {
  const manifest = parseManifest(await drive.downloadText(token, manifestFileId, 16 * 1024));
  if (!manifest) throw new DriveSyncError("The uploaded backup's manifest couldn't be read back.");
  const local = "verify.db";
  await drive.downloadToDisk(token, manifest.dbFileId, `file://${dir}/${local}`);
  const { md5, size } = await db.fileMd5(`${dir}/${local}`);
  if (md5 !== manifest.md5 || size !== manifest.sizeBytes) {
    throw new DriveSyncError("The uploaded backup didn't match what was sent.");
  }
  const ring = await keyringById(token, manifest.keyId);
  const key = (await devWrongKeyAt(FAULT, "verifyRemote")) ? toRawSqlcipherKey(await randomHex()) : toRawSqlcipherKey(ring.key);
  let ids: db.IdSets;
  try {
    ids = await db.inspectBackupFile(dir, local, key);
  } catch {
    throw new DriveSyncError("The backup couldn't be opened and checked, so it wasn't used.");
  }
  if (
    ids.noteIds.length !== manifest.counts.notes ||
    ids.todoIds.length !== manifest.counts.todos ||
    (await sha256Lines(ids.noteIds)) !== manifest.noteIdDigest ||
    (await sha256Lines(ids.todoIds)) !== manifest.todoIdDigest
  ) {
    throw new DriveSyncError("The uploaded backup's contents didn't match its manifest.");
  }
  return manifest;
}

export async function runEncryptedBackup(ctx: BackupContext): Promise<BackupOutcome> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  await logDriveSummary(token, "before backup");
  await db.removeAllStaging();
  const dir = await db.createStaging();
  try {
    const keyring = await step("keyring", () => ensureKeyring(token));
    const deviceEntryCreated = await step("device", () => ensureDeviceEntry(token, keyring, dir));

    const files = await drive.listAppDataFiles(token, V2_PREFIX);
    const headGens = heads(await listVerifiedGenerations(token, files));
    const outKey = toRawSqlcipherKey(keyring.key);
    const genId = newId();
    const outName = "gen.db";
    let required: db.IdSets = await db.readLocalIds();
    let added = { notes: required.noteIds.length, todos: required.todoIds.length, updatedNotes: 0, updatedTodos: 0 };
    let baseDigest: string | null = null;
    let baseKeyId: string | null = null;

    await step("build", async () => {
      if (headGens.length === 0) {
        await db.writeLocalSnapshot(dir, outName, outKey);
        return;
      }
      const [base, ...others] = headGens;
      const baseKey = toRawSqlcipherKey((await keyringById(token, base.manifest.keyId)).key);
      await drive.downloadToDisk(token, base.manifest.dbFileId, `file://${dir}/base.db`);
      const baseIds = await db.inspectBackupFile(dir, "base.db", baseKey);
      // Taken before anything is merged into the downloaded copy.
      baseDigest = await db.contentDigest(dir, "base.db", baseKey);
      baseKeyId = base.manifest.keyId;
      required = {
        noteIds: [...required.noteIds, ...baseIds.noteIds],
        todoIds: [...required.todoIds, ...baseIds.todoIds],
      };
      for (const [index, other] of others.slice(0, 3).entries()) {
        const otherKey = toRawSqlcipherKey((await keyringById(token, other.manifest.keyId)).key);
        const name = `head-${index}.db`;
        await drive.downloadToDisk(token, other.manifest.dbFileId, `file://${dir}/${name}`);
        const otherIds = await db.inspectBackupFile(dir, name, otherKey);
        required = { noteIds: [...required.noteIds, ...otherIds.noteIds], todoIds: [...required.todoIds, ...otherIds.todoIds] };
        await db.mergeOtherHeadInto(dir, "base.db", baseKey, name, otherKey);
      }
      const counts = await db.mergeLocalIntoBase(dir, "base.db", baseKey, outName, outKey);
      added = { notes: counts.addedNotes, todos: counts.addedTodos, updatedNotes: counts.updatedNotes, updatedTodos: counts.updatedTodos };
    });

    // Local proof before anything is uploaded: the sealed file opens with the
    // backup key, is intact, and holds every note and to-do it must.
    const sealed = await step("verifyLocal", async () => {
      const ids = await db.inspectBackupFile(dir, outName, outKey);
      if (!isSuperset(ids.noteIds, required.noteIds) || !isSuperset(ids.todoIds, required.todoIds)) {
        throw new DriveSyncError("The new backup was missing notes, so it wasn't uploaded.");
      }
      return ids;
    });
    // Nothing would change: the only head is already exactly this content,
    // under the same key, and this phone's recovery entry already existed.
    // Not counts — the full content digest of every note and to-do.
    if (
      headGens.length === 1 &&
      !deviceEntryCreated &&
      baseKeyId === keyring.keyId &&
      baseDigest !== null &&
      (await db.contentDigest(dir, outName, outKey)) === baseDigest
    ) {
      const [head] = headGens;
      devTiming("Backup", "unchanged — upload skipped");
      return {
        skipped: true,
        genId: head.manifest.genId,
        verifiedAt: head.verifiedAt,
        counts: { notes: sealed.noteIds.length, todos: sealed.todoIds.length },
        added: { notes: 0, todos: 0, updatedNotes: 0, updatedTodos: 0 },
        sizeBytes: head.manifest.sizeBytes,
        firstBackup: false,
      };
    }
    const { md5, size } = await db.fileMd5(`${dir}/${outName}`);

    const dbFileId = await step("uploadDb", async () => {
      const id = await drive.createFileFromDisk(token, generationDbName(genId), `file://${dir}/${outName}`, { xayraKind: "gen-db", genId });
      const uploaded = await drive.getAppDataFile(token, id);
      if (uploaded.md5Checksum !== md5 || Number(uploaded.size) !== size) {
        await drive.deleteOwnUnreferencedFile(token, id);
        throw new DriveSyncError("The backup upload didn't arrive intact.");
      }
      return id;
    });

    const manifest: GenerationManifest = {
      format: "xayra-backup-manifest",
      version: 1,
      genId,
      keyId: keyring.keyId,
      dbFileId,
      sizeBytes: size,
      md5,
      counts: { notes: sealed.noteIds.length, todos: sealed.todoIds.length },
      noteIdDigest: await sha256Lines(sealed.noteIds),
      todoIdDigest: await sha256Lines(sealed.todoIds),
      parents: headGens.map((g) => g.manifest.genId),
      vaultId: (await readVaultId()) ?? "unknown",
      createdAt: new Date().toISOString(),
    };
    const manifestFileId = await step("manifest", () =>
      drive.createJsonFile(token, generationManifestName(genId), manifest, { xayraKind: "gen-manifest", genId, keyId: keyring.keyId })
    );

    await step("verifyRemote", () => verifyGenerationOnDrive(token, manifestFileId, dir));
    const verifiedAt = new Date().toISOString();
    await step("markVerified", () =>
      drive.setAppProperties(token, manifestFileId, { xayraKind: "gen-manifest", genId, keyId: keyring.keyId, verifiedAt })
    );
    await bindIfUnbound(ctx.accountId);
    await logDriveSummary(token, "after backup");
    console.log(`[Backup] Generation verified (notes=${manifest.counts.notes} todos=${manifest.counts.todos} parents=${manifest.parents.length}).`);
    return { skipped: false, genId, verifiedAt, counts: manifest.counts, added, sizeBytes: size, firstBackup: headGens.length === 0 };
  } finally {
    await db.removeStaging(dir).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Restore

async function restoreRecords(dir: string, name: string, key: string | null): Promise<{ restoredNotes: number; restoredTodos: number; noteIds: string[] }> {
  const { notes, todos } = await db.readBackupRecords(dir, name, key);
  const restoredNotes = await mergeMissingNotes(notes);
  const restoredTodos = await mergeMissingToDos(todos);
  return { restoredNotes, restoredTodos, noteIds: notes.map((n) => n.id) };
}

/**
 * Restores the newest verified generation into this phone's vault (merge:
 * adds what's missing, never removes or overwrites). Falls back to the legacy
 * plaintext backup, read-only, only when the account has no encrypted backup.
 * Reports success only after confirming every backed-up note is now present.
 */
export async function restoreLatestBackup(ctx: BackupContext): Promise<RestoreOutcome> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  await db.removeAllStaging();
  const dir = await db.createStaging();
  try {
    const files = await drive.listAppDataFiles(token, V2_PREFIX);
    const [newest] = heads(await listVerifiedGenerations(token, files));
    let outcome: RestoreOutcome;
    if (newest) {
      const manifest = await step("restoreVerify", () => verifyGenerationOnDrive(token, newest.manifestFileId, dir));
      const key = toRawSqlcipherKey((await keyringById(token, manifest.keyId)).key);
      const result = await step("restoreMerge", () => restoreRecords(dir, "verify.db", key));
      const local = await db.readLocalIds();
      if (!isSuperset(local.noteIds, result.noteIds)) {
        throw new DriveSyncError("Some notes from the backup couldn't be restored. Nothing else was changed.");
      }
      outcome = { source: "encrypted", backupDate: manifest.createdAt, restoredNotes: result.restoredNotes, restoredTodos: result.restoredTodos };
    } else {
      outcome = await restoreLegacy(token, dir);
    }
    await bindIfUnbound(ctx.accountId);
    await logDriveSummary(token, "after restore");
    return outcome;
  } finally {
    await db.removeStaging(dir).catch(() => {});
  }
}

/** Legacy `remi_backup.db` (plaintext SQLite): downloaded and read only. */
async function restoreLegacy(token: string, dir: string): Promise<RestoreOutcome> {
  const legacy = (await drive.listAppDataFiles(token, LEGACY_DB_NAME)).find((f) => f.name === LEGACY_DB_NAME);
  if (!legacy) throw new NoBackupFoundError();
  await drive.downloadToDisk(token, legacy.id, `file://${dir}/legacy.db`);
  const header = globalThis.atob(
    await FileSystem.readAsStringAsync(`file://${dir}/legacy.db`, { encoding: FileSystem.EncodingType.Base64, position: 0, length: 16 })
  );
  if (header !== "SQLite format 3\u0000") {
    throw new DriveSyncError("The older backup in this account isn't in a format Xayra can read.");
  }
  await db.inspectBackupFile(dir, "legacy.db", null);
  const result = await restoreRecords(dir, "legacy.db", null);
  const local = await db.readLocalIds();
  if (!isSuperset(local.noteIds, result.noteIds)) {
    throw new DriveSyncError("Some notes from the older backup couldn't be restored. Nothing else was changed.");
  }
  return { source: "legacy", backupDate: legacy.modifiedTime ?? "", restoredNotes: result.restoredNotes, restoredTodos: result.restoredTodos };
}

// ---------------------------------------------------------------------------
// Original-vault recovery

/**
 * Vault keys that might reopen this phone's own vault after its fingerprint-
 * protected key was lost: this phone's device entries first (by vault id),
 * then other entries, then the legacy plaintext key. Each is only a
 * candidate — originalVaultRecovery.ts proves a key on a copy of the vault.
 */
export async function collectRecoveryKeyCandidates(token: string): Promise<string[]> {
  const vaultId = await readVaultId();
  const rings = (await loadKeyrings(token, await drive.listAppDataFiles(token, KEYRING_PREFIX))).map((r) => r.keyring);
  const entries = (await drive.listAppDataFiles(token, DEVICE_PREFIX))
    .sort((a, b) => Number(Boolean(vaultId && b.name.includes(vaultId))) - Number(Boolean(vaultId && a.name.includes(vaultId))))
    .slice(0, MAX_DEVICE_ENTRIES);
  const candidates: string[] = [];
  const dir = await db.createStaging();
  try {
    for (const file of entries) {
      const name = `entry-${file.id}.db`;
      await drive.downloadToDisk(token, file.id, `file://${dir}/${name}`);
      for (const ring of rings) {
        const entry = await db.readDeviceEntry(dir, name, toRawSqlcipherKey(ring.key));
        if (entry && !candidates.includes(entry.vaultKeyHex)) {
          candidates.push(entry.vaultKeyHex);
          break;
        }
      }
    }
  } finally {
    await db.removeStaging(dir).catch(() => {});
  }
  const legacyKey = (await drive.listAppDataFiles(token, LEGACY_KEY_NAME)).find((f) => f.name === LEGACY_KEY_NAME);
  if (legacyKey) {
    const text = (await drive.downloadText(token, legacyKey.id, 1024)).trim();
    if (/^[0-9a-f]{64}$/.test(text) && !candidates.includes(text)) candidates.push(text);
  }
  return candidates;
}
