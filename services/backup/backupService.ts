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
import { ExtraPrivacyKeyNeededError, ProtectionChangeUnfinishedError, RecoveryCodeIncorrectError, RecoveryCodeRequiredError } from "./backupErrors";
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
  MODE_PREFIX,
  modeFileName,
  parseKeyring,
  parseManifest,
  parseModeRecord,
  parseXkeyringName,
  V2_PREFIX,
  XKEYRING_PREFIX,
  xkeyringName,
  type BackupKey,
  type GenerationManifest,
  type Keyring,
  type ModeRecord,
} from "./backupFormat";
import * as drive from "./driveAppData";
import { readExtraKey, readEscrow, readLocalProtection, storeExtraKey, writeEscrow, writeLocalProtection } from "./protection";

/**
 * Encrypted Google Drive backup and restore, in two protection modes.
 *
 * Standard Protection (default): generations are SQLCipher files under the
 * account's backup key, which is kept in the same Google account — restoring
 * needs only the account, and sufficient access to the account can decrypt
 * the backup (the Settings copy says so).
 *
 * Extra Privacy (optional): new generations use a separate Extra Privacy key
 * that exists in Google Drive only inside a keyring protected by the user's
 * recovery code (SQLCipher passphrase), and on trusted phones only behind the
 * fingerprint. The account mode lives in Drive (newest xayra2-mode-*.json), so
 * every phone follows it; a phone without the Extra Privacy key refuses to
 * back up rather than create new Google-readable backups.
 *
 * Safety rules (both modes):
 *  - Files are only ever created, never overwritten. A generation is
 *    restore-eligible only after an independent download → decrypt →
 *    integrity check → record comparison (appProperties.verifiedAt).
 *  - Nothing is deleted automatically. The only deletions are of files a run
 *    itself just created and nothing references, superseded recovery-code
 *    epochs once a code replacement has committed, and backups the user explicitly
 *    retires (retireStandardBackups).
 *  - Mode changes commit by writing a new mode record only after the new
 *    protected generation is verified; that generation is marked verified
 *    after the commit, so an interruption never makes the newest restorable
 *    backup depend on a key the account isn't using.
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
  mode: "standard" | "extra";
};

export type RestoreOutcome = {
  source: "encrypted" | "legacy";
  backupDate: string;
  restoredNotes: number;
  restoredTodos: number;
  mode: "standard" | "extra";
};

export type AccountProtection = { mode: "standard" | "extra"; keyId: string | null };

const FAULT = "backup";
const MAX_MANIFESTS = 40;
const MAX_DEVICE_ENTRIES = 12;

type VerifiedGeneration = { manifest: GenerationManifest; manifestFileId: string; verifiedAt: string };

/** Keys usable in one operation: standard keyrings (from the account), this
 * phone's Extra Privacy key, and keys unlocked with a recovery code. */
type KeySource = { token: string; extra: BackupKey | null; unlocked: BackupKey[] };

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
      xkeyrings: v2.filter((f) => f.name.startsWith(XKEYRING_PREFIX)).length,
      modes: v2.filter((f) => f.name.startsWith(MODE_PREFIX)).length,
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

async function withStaging<T>(run: (dir: string) => Promise<T>): Promise<T> {
  await db.removeAllStaging();
  const dir = await db.createStaging();
  try {
    return await run(dir);
  } finally {
    await db.removeStaging(dir).catch(() => {});
  }
}

function requireSessionVault(): string {
  const vaultHex = getSessionVaultKey();
  if (!vaultHex) {
    throw new DriveSyncError("Unlock Xayra again, then try once more.");
  }
  return vaultHex;
}

// ---------------------------------------------------------------------------
// Standard keyrings

async function loadStandardKeyrings(token: string): Promise<{ keyring: Keyring; file: drive.AppDataFile }[]> {
  const out: { keyring: Keyring; file: drive.AppDataFile }[] = [];
  for (const file of (await drive.listAppDataFiles(token, KEYRING_PREFIX)).slice(0, 10)) {
    const keyring = parseKeyring(await drive.downloadText(token, file.id, 4096));
    if (keyring && file.name === keyringFileName(keyring.keyId)) {
      out.push({ keyring, file });
    }
  }
  return out;
}

function oldest(rings: { keyring: Keyring; file: drive.AppDataFile }[]): Keyring | null {
  const sorted = [...rings].sort(
    (a, b) => (a.file.createdTime ?? "").localeCompare(b.file.createdTime ?? "") || a.file.name.localeCompare(b.file.name)
  );
  return sorted[0]?.keyring ?? null;
}

function asKey(keyring: Keyring): BackupKey {
  return { keyId: keyring.keyId, key: keyring.key, mode: "standard" };
}

/**
 * The account's Standard backup key, creating it on the very first backup.
 * If two phones create one at the same moment, both settle on the oldest; a
 * phone whose own just-created keyring lost the race deletes it (unused).
 */
async function ensureStandardKey(token: string): Promise<BackupKey> {
  const existing = oldest(await loadStandardKeyrings(token));
  if (existing) return asKey(existing);
  const keyring: Keyring = { format: "xayra-keyring", version: 1, mode: "standard", keyId: newId(), key: await randomHex(), createdAt: new Date().toISOString() };
  const fileId = await drive.createJsonFile(token, keyringFileName(keyring.keyId), keyring, { xayraKind: "keyring", keyId: keyring.keyId });
  const winner = oldest(await loadStandardKeyrings(token));
  if (!winner) {
    throw new DriveSyncError("The backup key couldn't be read back after it was created.");
  }
  if (winner.keyId !== keyring.keyId) {
    await drive.deleteOwnUnreferencedFile(token, fileId);
  }
  return asKey(winner);
}

/** The key a generation was made with. Standard keys come from the account;
 * Extra Privacy keys only from `src` — otherwise the recovery code is needed. */
async function keyById(src: KeySource, keyId: string): Promise<BackupKey> {
  const local = [src.extra, ...src.unlocked].find((k) => k?.keyId === keyId);
  if (local) return local;
  const ring = (await loadStandardKeyrings(src.token)).find((r) => r.keyring.keyId === keyId)?.keyring;
  if (ring) return asKey(ring);
  if ((await listXkeyrings(src.token, keyId)).length > 0) {
    // e.g. a switch back to Standard interrupted before its backup was marked
    // verified: the newest verified backup is still Extra Privacy, and this
    // phone's own key (fingerprint) opens it.
    const stored = await readExtraKey().catch(() => null);
    if (stored?.keyId === keyId) {
      src.unlocked.push(stored);
      return stored;
    }
    throw new RecoveryCodeRequiredError();
  }
  throw new DriveSyncError("The key for this backup is missing from your Google account.");
}

// ---------------------------------------------------------------------------
// Account mode

export async function resolveAccountMode(token: string): Promise<ModeRecord | null> {
  const files = (await drive.listAppDataFiles(token, MODE_PREFIX)).sort(
    (a, b) => (b.createdTime ?? "").localeCompare(a.createdTime ?? "") || b.name.localeCompare(a.name)
  );
  for (const file of files.slice(0, 5)) {
    const record = parseModeRecord(await drive.downloadText(token, file.id, 4096));
    if (record) return record;
  }
  return null;
}

/** The commit point of a mode change: a new mode record, confirmed to be the
 * newest one the account now reports. */
async function commitMode(token: string, mode: "standard" | "extra", keyId: string): Promise<void> {
  const record: ModeRecord = { format: "xayra-mode", version: 1, mode, keyId, createdAt: new Date().toISOString() };
  await drive.createJsonFile(token, modeFileName(newId()), record, { xayraKind: "mode", mode, keyId });
  const now = await resolveAccountMode(token);
  if (now?.mode !== mode || now.keyId !== keyId) {
    throw new DriveSyncError("The protection change couldn't be confirmed. Nothing was switched.");
  }
}

/** Whether anything Google account access alone can open is still in Drive:
 * a Standard keyring (every Standard backup needs one) or the legacy files.
 * What retireStandardBackups removes; false once it has run. */
export async function hasGoogleOnlyBackups(token: string): Promise<boolean> {
  if ((await drive.listAppDataFiles(token, KEYRING_PREFIX)).length > 0) return true;
  return (await drive.listAppDataFiles(token, "remi_backup.")).some((f) => f.name === LEGACY_DB_NAME || f.name === LEGACY_KEY_NAME);
}

export async function getAccountProtection(token: string): Promise<AccountProtection> {
  const record = await resolveAccountMode(token);
  return record ? { mode: record.mode, keyId: record.keyId } : { mode: "standard", keyId: null };
}

// ---------------------------------------------------------------------------
// Extra Privacy keyrings (recovery-code protected)

async function listXkeyrings(token: string, keyId?: string): Promise<(drive.AppDataFile & { keyId: string; epoch: number })[]> {
  return (await drive.listAppDataFiles(token, XKEYRING_PREFIX))
    .map((file) => ({ ...file, ...(parseXkeyringName(file.name) ?? { keyId: "", epoch: -1 }) }))
    .filter((file) => file.epoch >= 0 && (!keyId || file.keyId === keyId))
    .sort((a, b) => b.epoch - a.epoch);
}

/** Uploads the Extra Privacy key protected by `code`, then proves the uploaded
 * copy opens with that code and holds that key before marking it verified. */
async function createXkeyring(token: string, key: BackupKey, code: string, epoch: number, dir: string): Promise<string> {
  const name = xkeyringName(key.keyId, epoch);
  await db.writeSecretContainer(dir, "xkeyring.db", code, { key_id: key.keyId, key: key.key, epoch: String(epoch), created_at: new Date().toISOString() });
  const fileId = await drive.createFileFromDisk(token, name, `file://${dir}/xkeyring.db`, { xayraKind: "xkeyring", keyId: key.keyId, epoch: String(epoch) });
  await drive.downloadToDisk(token, fileId, `file://${dir}/xkeyring-verify.db`);
  const check = await db.readSecretContainer(dir, "xkeyring-verify.db", code);
  if (check?.key !== key.key || check.key_id !== key.keyId) {
    await drive.deleteOwnUnreferencedFile(token, fileId);
    throw new DriveSyncError("The protected key didn't verify after upload. Nothing was changed.");
  }
  await drive.setAppProperties(token, fileId, { xayraKind: "xkeyring", keyId: key.keyId, epoch: String(epoch), verifiedAt: new Date().toISOString() });
  return fileId;
}

/** Every Extra Privacy key the code opens (each keyring epoch tried), or
 * only `keyId`'s keyrings when the needed key is known, so leftover keyrings
 * from abandoned activations can't crowd out the one in use. */
async function unwrapWithCode(token: string, code: string, dir: string, keyId?: string): Promise<BackupKey[]> {
  const keys: BackupKey[] = [];
  for (const file of (await listXkeyrings(token, keyId)).filter((f) => f.appProperties?.verifiedAt).slice(0, 10)) {
    if (keys.some((k) => k.keyId === file.keyId)) continue;
    const name = `xk-${file.id}.db`;
    await drive.downloadToDisk(token, file.id, `file://${dir}/${name}`);
    const values = await db.readSecretContainer(dir, name, code);
    if (values?.key_id === file.keyId && /^[0-9a-f]{64}$/.test(values.key ?? "")) {
      keys.push({ keyId: file.keyId, key: values.key, mode: "extra" });
    }
  }
  return keys;
}

/** Once a code replacement has committed (epoch `epoch` verified and this
 * phone's escrow rewritten under its code), the older epochs — older recovery
 * codes — are removed. Only key wrappers, never backups. Never called for an
 * epoch whose replacement didn't commit, so an abandoned new code can't
 * retire the code the user still relies on. */
async function retireEpochsBelow(token: string, keyId: string, epoch: number): Promise<number> {
  const rings = await listXkeyrings(token, keyId);
  if (!rings.some((r) => r.epoch === epoch && r.appProperties?.verifiedAt)) return 0;
  let removed = 0;
  for (const ring of rings.filter((r) => r.epoch < epoch)) {
    await drive.deleteAppDataFile(token, ring.id);
    removed += 1;
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Device entries

async function keyFingerprint(hexKey: string): Promise<string> {
  return (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, `xayra-device-fp:${hexKey}`)).slice(0, 12);
}

/** Records this phone's vault key (inside a file keyed with `key`), once per
 * vault key and backup key. Never touches another phone's entry. Verified by
 * reading it back from Drive. Returns whether a new entry was created. */
async function ensureDeviceEntry(token: string, key: BackupKey, dir: string): Promise<boolean> {
  const vaultHex = requireSessionVault();
  const vaultId = await getOrCreateVaultId();
  const name = deviceEntryName(vaultId, await keyFingerprint(vaultHex), key.keyId);
  const raw = toRawSqlcipherKey(key.key);
  for (const file of (await drive.listAppDataFiles(token, name)).filter((f) => f.name === name)) {
    await drive.downloadToDisk(token, file.id, `file://${dir}/check-${file.id}.db`);
    if ((await db.readDeviceEntry(dir, `check-${file.id}.db`, raw))?.vaultKeyHex === vaultHex) return false;
  }
  await db.writeDeviceEntry(dir, "device-entry.db", raw, { vaultId, vaultKeyHex: vaultHex, label: "Android phone" });
  const fileId = await drive.createFileFromDisk(token, name, `file://${dir}/device-entry.db`, { xayraKind: "device", vaultId, keyId: key.keyId });
  await drive.downloadToDisk(token, fileId, `file://${dir}/device-verify.db`);
  if ((await db.readDeviceEntry(dir, "device-verify.db", raw))?.vaultKeyHex !== vaultHex) {
    await drive.deleteOwnUnreferencedFile(token, fileId);
    throw new DriveSyncError("This phone's recovery entry didn't verify after upload.");
  }
  return true;
}

// ---------------------------------------------------------------------------
// Generations

async function listVerifiedGenerations(token: string): Promise<VerifiedGeneration[]> {
  const manifests = (await drive.listAppDataFiles(token, GENERATION_PREFIX))
    .filter((f) => f.name.endsWith(".json") && f.appProperties?.verifiedAt)
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
 * re-read the manifest, re-download the database by the id it names, resolve
 * its key, decrypt, run the integrity checks and compare the record ids.
 */
async function verifyGenerationOnDrive(src: KeySource, manifestFileId: string, dir: string): Promise<GenerationManifest> {
  const { token } = src;
  const manifest = parseManifest(await drive.downloadText(token, manifestFileId, 16 * 1024));
  if (!manifest) throw new DriveSyncError("The backup's manifest couldn't be read back.");
  const local = "verify.db";
  await drive.downloadToDisk(token, manifest.dbFileId, `file://${dir}/${local}`);
  const { md5, size } = await db.fileMd5(`${dir}/${local}`);
  if (md5 !== manifest.md5 || size !== manifest.sizeBytes) {
    throw new DriveSyncError("The backup in Google Drive didn't match what was sent.");
  }
  const key = await keyById(src, manifest.keyId);
  const raw = (await devWrongKeyAt(FAULT, "verifyRemote")) ? toRawSqlcipherKey(await randomHex()) : toRawSqlcipherKey(key.key);
  let ids: db.IdSets;
  try {
    ids = await db.inspectBackupFile(dir, local, raw);
  } catch {
    throw new DriveSyncError("The backup couldn't be opened and checked, so it wasn't used.");
  }
  if (
    ids.noteIds.length !== manifest.counts.notes ||
    ids.todoIds.length !== manifest.counts.todos ||
    (await sha256Lines(ids.noteIds)) !== manifest.noteIdDigest ||
    (await sha256Lines(ids.todoIds)) !== manifest.todoIdDigest
  ) {
    throw new DriveSyncError("The backup's contents didn't match its manifest.");
  }
  return manifest;
}

type BuiltGeneration = { outcome: BackupOutcome; markVerified: () => Promise<string> };

/**
 * Builds, uploads and independently verifies one generation under `key`,
 * merging every verified head and this phone's notes. With `deferMark` the
 * caller marks it verified after its own commit (mode changes); otherwise it
 * is marked here. Unchanged content returns `skipped` without uploading.
 */
async function buildGeneration(ctx: BackupContext, key: BackupKey, src: KeySource, dir: string, deferMark: boolean): Promise<BuiltGeneration> {
  const { token } = ctx;
  const deviceEntryCreated = await step("device", () => ensureDeviceEntry(token, key, dir));
  const headGens = heads(await listVerifiedGenerations(token));
  const outKey = toRawSqlcipherKey(key.key);
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
    const baseKey = toRawSqlcipherKey((await keyById(src, base.manifest.keyId)).key);
    await drive.downloadToDisk(token, base.manifest.dbFileId, `file://${dir}/base.db`);
    const baseIds = await db.inspectBackupFile(dir, "base.db", baseKey);
    baseDigest = await db.contentDigest(dir, "base.db", baseKey);
    baseKeyId = base.manifest.keyId;
    required = { noteIds: [...required.noteIds, ...baseIds.noteIds], todoIds: [...required.todoIds, ...baseIds.todoIds] };
    for (const [index, other] of others.slice(0, 3).entries()) {
      const otherKey = toRawSqlcipherKey((await keyById(src, other.manifest.keyId)).key);
      const name = `head-${index}.db`;
      await drive.downloadToDisk(token, other.manifest.dbFileId, `file://${dir}/${name}`);
      const otherIds = await db.inspectBackupFile(dir, name, otherKey);
      required = { noteIds: [...required.noteIds, ...otherIds.noteIds], todoIds: [...required.todoIds, ...otherIds.todoIds] };
      await db.mergeOtherHeadInto(dir, "base.db", baseKey, name, otherKey);
    }
    const counts = await db.mergeLocalIntoBase(dir, "base.db", baseKey, outName, outKey);
    added = { notes: counts.addedNotes, todos: counts.addedTodos, updatedNotes: counts.updatedNotes, updatedTodos: counts.updatedTodos };
  });

  const sealed = await step("verifyLocal", async () => {
    const ids = await db.inspectBackupFile(dir, outName, outKey);
    if (!isSuperset(ids.noteIds, required.noteIds) || !isSuperset(ids.todoIds, required.todoIds)) {
      throw new DriveSyncError("The new backup was missing notes, so it wasn't uploaded.");
    }
    return ids;
  });

  // Nothing would change: the only head is already exactly this content,
  // under the same key, and this phone's recovery entry already existed.
  // The full content digest of every note and to-do — never counts.
  if (
    !deferMark &&
    headGens.length === 1 &&
    !deviceEntryCreated &&
    baseKeyId === key.keyId &&
    baseDigest !== null &&
    (await db.contentDigest(dir, outName, outKey)) === baseDigest
  ) {
    const [head] = headGens;
    devTiming("Backup", "unchanged — upload skipped");
    return {
      outcome: {
        skipped: true,
        genId: head.manifest.genId,
        verifiedAt: head.verifiedAt,
        counts: { notes: sealed.noteIds.length, todos: sealed.todoIds.length },
        added: { notes: 0, todos: 0, updatedNotes: 0, updatedTodos: 0 },
        sizeBytes: head.manifest.sizeBytes,
        firstBackup: false,
        mode: key.mode,
      },
      markVerified: async () => head.verifiedAt,
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
    keyId: key.keyId,
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
    drive.createJsonFile(token, generationManifestName(genId), manifest, { xayraKind: "gen-manifest", genId, keyId: key.keyId })
  );
  await step("verifyRemote", () => verifyGenerationOnDrive(src, manifestFileId, dir));

  const markVerified = async (): Promise<string> => {
    const verifiedAt = new Date().toISOString();
    await step("markVerified", () =>
      drive.setAppProperties(token, manifestFileId, { xayraKind: "gen-manifest", genId, keyId: key.keyId, verifiedAt })
    );
    return verifiedAt;
  };
  const outcome: BackupOutcome = {
    skipped: false,
    genId,
    verifiedAt: deferMark ? "" : await markVerified(),
    counts: manifest.counts,
    added,
    sizeBytes: size,
    firstBackup: headGens.length === 0,
    mode: key.mode,
  };
  console.log(`[Backup] Generation verified (mode=${key.mode} notes=${manifest.counts.notes} todos=${manifest.counts.todos} parents=${manifest.parents.length}).`);
  return { outcome, markVerified };
}

/** This phone's key for the account's current mode. Extra Privacy needs the
 * fingerprint-protected key; without it, nothing is uploaded. */
async function currentModeKey(token: string, mode: ModeRecord | null): Promise<BackupKey> {
  if (mode?.mode === "extra") {
    const extra = await readExtraKey();
    if (!extra || extra.keyId !== mode.keyId) {
      throw new ExtraPrivacyKeyNeededError();
    }
    return extra;
  }
  return ensureStandardKey(token);
}

export async function runEncryptedBackup(ctx: BackupContext): Promise<BackupOutcome> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  await logDriveSummary(token, "before backup");
  const mode = await resolveAccountMode(token);
  const key = await step("keyring", () => currentModeKey(token, mode));
  const src: KeySource = { token, extra: key.mode === "extra" ? key : null, unlocked: [] };
  const { outcome } = await withStaging((dir) => buildGeneration(ctx, key, src, dir, false));
  if (key.mode === "extra") {
    // Finishes a code replacement that committed on this phone but couldn't
    // remove the old code at the time.
    const local = await readLocalProtection();
    let retireBelowEpoch = local.keyId === key.keyId ? local.retireBelowEpoch : undefined;
    if (retireBelowEpoch) {
      const pending = retireBelowEpoch;
      retireBelowEpoch = await retireEpochsBelow(token, key.keyId, pending).then(
        () => undefined,
        () => pending
      );
    }
    await writeLocalProtection({ mode: "extra", keyId: key.keyId, state: "active", retireBelowEpoch });
  } else if ((await readLocalProtection()).mode !== "standard") {
    await writeLocalProtection({ mode: "standard" });
  }
  await bindIfUnbound(ctx.accountId);
  await logDriveSummary(token, "after backup");
  return outcome;
}

// ---------------------------------------------------------------------------
// Mode transitions

/**
 * Standard → Extra Privacy. Order (each step verified):
 *  1. a new Extra Privacy key, uploaded only inside a keyring protected by the
 *     recovery code — downloaded back and opened with the code;
 *  2. the key stored on this phone behind the fingerprint;
 *  3. a new generation under that key (merging every existing backup), with
 *     this phone's device entry under that key — independently verified;
 *  4. the local escrow (vault key + Extra Privacy key under the code);
 *  5. commit: the account's mode record switches to Extra Privacy;
 *  6. the new generation is marked verified; local state "active".
 * Interrupted before 5: the account is still Standard and nothing it relies
 * on changed. Interrupted after 5: the next backup (Extra Privacy) finishes.
 * Existing Standard backups are left exactly as they are.
 */
export async function activateExtraPrivacy(ctx: BackupContext, code: string): Promise<BackupOutcome> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  const vaultHex = requireSessionVault();
  if ((await resolveAccountMode(token))?.mode === "extra") {
    throw new DriveSyncError("Extra Privacy is already on for this account.");
  }
  const key: BackupKey = { keyId: newId(), key: await randomHex(), mode: "extra" };
  const src: KeySource = { token, extra: key, unlocked: [] };
  const outcome = await withStaging(async (dir) => {
    await step("xkeyring", () => createXkeyring(token, key, code, 1, dir));
    await step("storeKey", () => storeExtraKey(key));
    const built = await buildGeneration(ctx, key, src, dir, true);
    await step("escrow", async () => writeEscrow(code, { vaultKeyHex: vaultHex, vaultId: await getOrCreateVaultId(), extraKey: key }));
    await step("commitMode", () => commitMode(token, "extra", key.keyId));
    try {
      await writeLocalProtection({ mode: "extra", keyId: key.keyId, state: "activating" });
      const verifiedAt = await built.markVerified();
      await writeLocalProtection({ mode: "extra", keyId: key.keyId, state: "active" });
      return { ...built.outcome, verifiedAt };
    } catch {
      throw new ProtectionChangeUnfinishedError("extra");
    }
  });
  await bindIfUnbound(ctx.accountId);
  await logDriveSummary(token, "after extra privacy on");
  return outcome;
}

/**
 * A new recovery code from a trusted phone (fingerprint gives the Extra
 * Privacy key). The same key is protected by the new code in a new keyring
 * epoch — verified with the new code — then the local escrow is rewritten
 * under it, and only then are the older epochs (older codes) removed. Backups
 * are untouched, so nothing becomes unrecoverable.
 */
export async function replaceRecoveryCode(ctx: BackupContext, newCode: string): Promise<{ oldCodeRemoved: boolean }> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  const vaultHex = requireSessionVault();
  const mode = await resolveAccountMode(token);
  if (mode?.mode !== "extra") throw new DriveSyncError("Extra Privacy isn't on for this account.");
  const key = await currentModeKey(token, mode);
  return withStaging(async (dir) => {
    const epoch = ((await listXkeyrings(token, key.keyId))[0]?.epoch ?? 0) + 1;
    const fileId = await step("xkeyring", () => createXkeyring(token, key, newCode, epoch, dir));
    try {
      await step("escrow", async () => writeEscrow(newCode, { vaultKeyHex: vaultHex, vaultId: await getOrCreateVaultId(), extraKey: key }));
    } catch (err) {
      // Not committed: the current code stays the one in use, so the new code
      // mustn't open anything either.
      await drive.deleteOwnUnreferencedFile(token, fileId);
      throw err;
    }
    // Committed: this phone's recovery copy now uses the new code. Removing
    // the old code is finished by the next backup if it can't happen now.
    await writeLocalProtection({ mode: "extra", keyId: key.keyId, state: "active", retireBelowEpoch: epoch });
    try {
      await step("retireOldCode", () => retireEpochsBelow(token, key.keyId, epoch));
    } catch {
      return { oldCodeRemoved: false };
    }
    await writeLocalProtection({ mode: "extra", keyId: key.keyId, state: "active" });
    return { oldCodeRemoved: true };
  });
}

export type RetireResult = { generations: number; deviceEntries: number; keyrings: number; legacyFiles: number };

/**
 * The user's explicit choice to remove older backups that Google access alone
 * can open (Standard generations, their keyring and device entries, and —
 * if chosen — the legacy remi_backup files). Allowed only while Extra Privacy
 * is on and its newest backup verifies again right now, so the last
 * recoverable backup is never among what's removed.
 */
export async function retireStandardBackups(ctx: BackupContext, options: { includeLegacy: boolean }): Promise<RetireResult> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  const mode = await resolveAccountMode(token);
  if (mode?.mode !== "extra") throw new DriveSyncError("Turn on Extra Privacy first.");
  const extra = await currentModeKey(token, mode);
  const src: KeySource = { token, extra, unlocked: [] };
  const protectedHead = heads(await listVerifiedGenerations(token)).find((g) => g.manifest.keyId === extra.keyId)
    ?? (await listVerifiedGenerations(token)).find((g) => g.manifest.keyId === extra.keyId);
  if (!protectedHead) {
    throw new DriveSyncError("There's no verified Extra Privacy backup yet, so nothing older was removed. Back up first.");
  }
  await withStaging((dir) => step("reverify", () => verifyGenerationOnDrive(src, protectedHead.manifestFileId, dir)));

  const standardIds = new Set((await loadStandardKeyrings(token)).map((r) => r.keyring.keyId));
  const result: RetireResult = { generations: 0, deviceEntries: 0, keyrings: 0, legacyFiles: 0 };
  const genFiles = await drive.listAppDataFiles(token, GENERATION_PREFIX);
  const manifests = new Map<string, GenerationManifest>();
  for (const file of genFiles.filter((f) => f.name.endsWith(".json"))) {
    const manifest = parseManifest(await drive.downloadText(token, file.id, 16 * 1024));
    if (manifest) manifests.set(file.id, manifest);
  }
  const keepDbIds = new Set([...manifests.values()].filter((m) => !standardIds.has(m.keyId)).map((m) => m.dbFileId));
  await step("retireGenerations", async () => {
    for (const [fileId, manifest] of manifests) {
      if (standardIds.has(manifest.keyId)) {
        await drive.deleteAppDataFile(token, fileId);
        result.generations += 1;
      }
    }
    // Generation databases no Extra Privacy manifest uses: Standard ones and
    // orphans from interrupted uploads (never restore candidates).
    for (const file of genFiles.filter((f) => f.name.endsWith(".db") && !keepDbIds.has(f.id))) {
      await drive.deleteAppDataFile(token, file.id);
    }
  });
  await step("retireDevices", async () => {
    const suffix = `-${extra.keyId.slice(0, 8)}.db`;
    for (const file of (await drive.listAppDataFiles(token, DEVICE_PREFIX)).filter((f) => !f.name.endsWith(suffix) && f.appProperties?.keyId !== extra.keyId)) {
      await drive.deleteAppDataFile(token, file.id);
      result.deviceEntries += 1;
    }
  });
  await step("retireKeyrings", async () => {
    for (const file of await drive.listAppDataFiles(token, KEYRING_PREFIX)) {
      await drive.deleteAppDataFile(token, file.id);
      result.keyrings += 1;
    }
  });
  if (options.includeLegacy) {
    await step("retireLegacy", async () => {
      for (const name of [LEGACY_DB_NAME, LEGACY_KEY_NAME]) {
        for (const file of (await drive.listAppDataFiles(token, name)).filter((f) => f.name === name)) {
          await drive.deleteAppDataFile(token, file.id);
          result.legacyFiles += 1;
        }
      }
    });
  }
  await logDriveSummary(token, "after retire");
  return result;
}

/**
 * Extra Privacy → Standard, explicitly. Uses this phone's Extra Privacy key
 * (fingerprint) to merge the protected backups into a new Standard
 * generation, verified, then commits the mode change and marks it verified.
 * Older Extra Privacy backups still need the recovery code (or a trusted
 * phone); the key and escrow on this phone are kept for exactly that.
 */
export async function switchToStandard(ctx: BackupContext): Promise<BackupOutcome> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  const mode = await resolveAccountMode(token);
  if (mode?.mode !== "extra") throw new DriveSyncError("This account already uses Standard Protection.");
  const extra = await currentModeKey(token, mode);
  const standard = await ensureStandardKey(token);
  const src: KeySource = { token, extra, unlocked: [] };
  const outcome = await withStaging(async (dir) => {
    const built = await buildGeneration(ctx, standard, src, dir, true);
    await step("commitMode", () => commitMode(token, "standard", standard.keyId));
    try {
      await writeLocalProtection({ mode: "standard" });
      const verifiedAt = await built.markVerified();
      return { ...built.outcome, verifiedAt };
    } catch {
      throw new ProtectionChangeUnfinishedError("standard");
    }
  });
  await logDriveSummary(token, "after standard on");
  return outcome;
}

/** Gives this phone the account's Extra Privacy key using the recovery code
 * (a second phone, or after a fingerprint change). */
export async function joinWithRecoveryCode(ctx: BackupContext, code: string): Promise<void> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  const mode = await resolveAccountMode(token);
  if (mode?.mode !== "extra") throw new DriveSyncError("Extra Privacy isn't on for this account.");
  await withStaging(async (dir) => {
    const key = (await unwrapWithCode(token, code, dir, mode.keyId)).find((k) => k.keyId === mode.keyId);
    if (!key) throw new RecoveryCodeIncorrectError();
    await adoptExtraKey(key, code);
  });
}

async function adoptExtraKey(key: BackupKey, code: string): Promise<void> {
  await storeExtraKey(key);
  const vaultHex = getSessionVaultKey();
  if (vaultHex) {
    await writeEscrow(code, { vaultKeyHex: vaultHex, vaultId: await getOrCreateVaultId(), extraKey: key });
  }
  await writeLocalProtection({ mode: "extra", keyId: key.keyId, state: "active" });
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
 * Restores the newest verified generation (merge: adds what's missing, never
 * removes or overwrites). Standard generations need only the account; Extra
 * Privacy generations need this phone's key (fingerprint) or the recovery
 * code — Google access alone is refused. Legacy plaintext backups are read
 * only when the account has no encrypted one. Success only after every
 * backed-up note is confirmed present.
 */
export async function restoreLatestBackup(ctx: BackupContext, options: { recoveryCode?: string } = {}): Promise<RestoreOutcome> {
  await assertAccountAllowed(ctx.accountId);
  const { token } = ctx;
  const outcome = await withStaging(async (dir): Promise<RestoreOutcome> => {
    const [newest] = heads(await listVerifiedGenerations(token));
    if (!newest) return restoreLegacy(token, dir);
    const src: KeySource = { token, extra: null, unlocked: [] };
    let joined: BackupKey | null = null;
    const isStandard = (await loadStandardKeyrings(token)).some((r) => r.keyring.keyId === newest.manifest.keyId);
    if (!isStandard) {
      const local = await readExtraKey().catch(() => null);
      if (local?.keyId === newest.manifest.keyId) {
        src.extra = local;
      } else if (options.recoveryCode) {
        const key = (await unwrapWithCode(token, options.recoveryCode, dir, newest.manifest.keyId)).find((k) => k.keyId === newest.manifest.keyId);
        if (!key) throw new RecoveryCodeIncorrectError();
        src.unlocked.push(key);
        joined = key;
      } else {
        throw new RecoveryCodeRequiredError();
      }
    }
    const manifest = await step("restoreVerify", () => verifyGenerationOnDrive(src, newest.manifestFileId, dir));
    const key = toRawSqlcipherKey((await keyById(src, manifest.keyId)).key);
    const result = await step("restoreMerge", () => restoreRecords(dir, "verify.db", key));
    if (!isSuperset((await db.readLocalIds()).noteIds, result.noteIds)) {
      throw new DriveSyncError("Some notes from the backup couldn't be restored. Nothing else was changed.");
    }
    if (joined && options.recoveryCode) {
      await adoptExtraKey(joined, options.recoveryCode);
    }
    return {
      source: "encrypted",
      backupDate: manifest.createdAt,
      restoredNotes: result.restoredNotes,
      restoredTodos: result.restoredTodos,
      mode: isStandard ? "standard" : "extra",
    };
  });
  await bindIfUnbound(ctx.accountId);
  await logDriveSummary(token, "after restore");
  return outcome;
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
  if (!isSuperset((await db.readLocalIds()).noteIds, result.noteIds)) {
    throw new DriveSyncError("Some notes from the older backup couldn't be restored. Nothing else was changed.");
  }
  return { source: "legacy", backupDate: legacy.modifiedTime ?? "", restoredNotes: result.restoredNotes, restoredTodos: result.restoredTodos, mode: "standard" };
}

// ---------------------------------------------------------------------------
// Original-vault recovery

/**
 * Vault keys that might reopen this phone's own vault after its fingerprint-
 * protected key was lost. Without a code: Standard device entries (this
 * phone's first), then the legacy plaintext key. With the recovery code: the
 * local escrow first (works offline), then Extra Privacy device entries.
 * Each is only a candidate — originalVaultRecovery.ts proves it on a copy.
 */
export async function collectRecoveryKeyCandidates(token: string | null, options: { recoveryCode?: string } = {}): Promise<string[]> {
  const candidates: string[] = [];
  const add = (hex: string | undefined | null) => {
    if (hex && /^[0-9a-f]{64}$/.test(hex) && !candidates.includes(hex)) candidates.push(hex);
  };
  if (options.recoveryCode) {
    add((await readEscrow(options.recoveryCode))?.vaultKeyHex);
  }
  if (!token) return candidates;
  const vaultId = await readVaultId();
  const dir = await db.createStaging();
  try {
    const keys: BackupKey[] = (await loadStandardKeyrings(token)).map((r) => asKey(r.keyring));
    if (options.recoveryCode) keys.push(...(await unwrapWithCode(token, options.recoveryCode, dir)));
    const entries = (await drive.listAppDataFiles(token, DEVICE_PREFIX))
      .sort((a, b) => Number(Boolean(vaultId && b.name.includes(vaultId))) - Number(Boolean(vaultId && a.name.includes(vaultId))))
      .slice(0, MAX_DEVICE_ENTRIES);
    for (const file of entries) {
      const name = `entry-${file.id}.db`;
      await drive.downloadToDisk(token, file.id, `file://${dir}/${name}`);
      for (const key of keys) {
        const entry = await db.readDeviceEntry(dir, name, toRawSqlcipherKey(key.key));
        if (entry) {
          add(entry.vaultKeyHex);
          break;
        }
      }
    }
  } finally {
    await db.removeStaging(dir).catch(() => {});
  }
  const legacyKey = (await drive.listAppDataFiles(token, LEGACY_KEY_NAME)).find((f) => f.name === LEGACY_KEY_NAME);
  if (legacyKey) add((await drive.downloadText(token, legacyKey.id, 1024)).trim());
  return candidates;
}

/** After the vault reopens through recovery: put the Extra Privacy key back
 * behind the fingerprint (it was invalidated with the vault key). */
export async function restoreExtraKeyFromEscrow(code: string): Promise<boolean> {
  const escrow = await readEscrow(code);
  if (!escrow?.extraKey) return false;
  await storeExtraKey(escrow.extraKey);
  return true;
}
