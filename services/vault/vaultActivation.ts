import { ANDROID_DATABASE_PATH, isSQLCipher, open, type DB } from "@op-engineering/op-sqlite";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import * as SecureStore from "expo-secure-store";

import { devTiming } from "../ai/perf";
import { DatabaseKeyError, getOrCreateDatabaseKey } from "../crypto/keyManager";
import { isRunningDevPackage } from "../dev/disposableVault";
import { VaultStateError } from "./vaultErrors";
import { setSessionVaultKey } from "./vaultIdentity";
import { toRawSqlcipherKey, VAULT_KEY_FORMAT } from "./vaultKey";
import { classifyHeader, decideVaultAction, type FileKind, type PointerState, type VaultDecision, type VaultFacts } from "./vaultState";

/**
 * Makes the encrypted vault ready to open: creates it on first run, migrates
 * a legacy plaintext vault into it, or confirms the committed one. The state
 * rules live in vaultState.ts; this file performs them.
 *
 * Layout (all inside the app's private storage):
 *   databases/silent-confidant.sqlite   legacy plaintext vault — only ever READ
 *   files/vault/xayra.sqlite            the encrypted vault (SQLCipher 4, raw key)
 *   files/vault-pointer.json            the commit point (temp file, then rename)
 *   files/vault-migration/              uncommitted work: legacy copy + staged vault
 *   files/vault-migration.json          progress journal (advisory only)
 *   SecureStore "encryption established" marker, set after the pointer.
 *
 * Migration never touches the original: the legacy file set is copied (MD5
 * checked) and the COPY is exported with `sqlcipher_export`. The staged vault
 * is verified from a fresh connection — same schema, every table identical
 * row for row (SQLite `EXCEPT` both ways, blobs included), vector and FTS
 * indexes usable, integrity checks clean, and the wrong key, no key and the
 * passphrase form of the right key all rejected — before it's moved into
 * place and the pointer is committed.
 *
 * It runs inside db/client.ts's single connection promise, before any
 * connection exists, so nothing else can read or write a vault meanwhile:
 * every database user (UI, extraction, embeddings, reminders, Drive) waits
 * on that same promise.
 */

export const VAULT_DATABASE_NAME = "xayra.sqlite";
export const LEGACY_DATABASE_NAME = "silent-confidant.sqlite";
const SIDE_FILE_SUFFIXES = ["-journal", "-wal", "-shm"] as const;
/** The legacy database's side files (legacyCopy.ts removes exactly these). */
export const LEGACY_SIDE_FILE_SUFFIXES = SIDE_FILE_SUFFIXES;
const POINTER_VERSION = 1;
const POINTER_DATABASE = `vault/${VAULT_DATABASE_NAME}`;
const POINTER_CIPHER = "sqlcipher4";
/** Not biometric-gated: it's a flag, not a secret, and must be readable
 * before any prompt to decide whether a plaintext file may ever be used. */
const MARKER_KEY = "xayra.vault.encryption-established";
const MARKER_OPTIONS: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
/** Free space beyond the legacy copy and the encrypted export themselves. */
const STORAGE_MARGIN_BYTES = 32 * 1024 * 1024;

export type VaultOpenParams = { name: string; location: string; encryptionKey: string };

function uri(barePath: string): string {
  return `file://${barePath}`;
}

function docsDir(): string {
  const root = (FileSystem.documentDirectory ?? "").replace(/^file:\/\//, "");
  if (!root) {
    throw new VaultStateError("conflict", "noPrivateStorage");
  }
  return root.endsWith("/") ? root : `${root}/`;
}

/** op-sqlite's default Android database directory (the legacy vault's), with
 * a trailing slash. */
export function legacyVaultDirectoryPath(): string {
  const base: unknown = ANDROID_DATABASE_PATH;
  if (typeof base !== "string" || base.length === 0) {
    throw new Error("op-sqlite did not report its Android database directory.");
  }
  return base.endsWith("/") ? base : `${base}/`;
}

/** The encrypted vault's directory, bare path without trailing slash (the
 * form op-sqlite's `location` takes). */
export function encryptedVaultDirectory(): string {
  return `${docsDir()}vault`;
}

const paths = {
  migrationDir: () => `${docsDir()}vault-migration`,
  legacyCopyDir: () => `${docsDir()}vault-migration/legacy-copy`,
  stagedDir: () => `${docsDir()}vault-migration/staged`,
  pointer: () => `${docsDir()}vault-pointer.json`,
  journal: () => `${docsDir()}vault-migration.json`,
  devFault: () => `${docsDir()}dev-vault-fault.json`,
};

// ---------------------------------------------------------------------------
// Facts

async function fileKind(barePath: string): Promise<FileKind> {
  const info = await FileSystem.getInfoAsync(uri(barePath));
  if (!info.exists || info.isDirectory) {
    return "absent";
  }
  const size = info.size ?? 0;
  if (size === 0) {
    return "empty";
  }
  const base64 = await FileSystem.readAsStringAsync(uri(barePath), {
    encoding: FileSystem.EncodingType.Base64,
    position: 0,
    length: 16,
  });
  return classifyHeader(size, globalThis.atob(base64));
}

async function readPointer(): Promise<PointerState> {
  const info = await FileSystem.getInfoAsync(uri(paths.pointer()));
  if (!info.exists) {
    return "absent";
  }
  try {
    const pointer = JSON.parse(await FileSystem.readAsStringAsync(uri(paths.pointer()))) as Record<string, unknown>;
    const valid =
      pointer.version === POINTER_VERSION &&
      pointer.database === POINTER_DATABASE &&
      pointer.cipher === POINTER_CIPHER &&
      pointer.keyFormat === VAULT_KEY_FORMAT;
    return valid ? "valid" : "invalid";
  } catch {
    return "invalid";
  }
}

async function readMarker(): Promise<boolean> {
  try {
    return (await SecureStore.getItemAsync(MARKER_KEY, MARKER_OPTIONS)) === "1";
  } catch (err) {
    // Unknown is not "absent": refuse to decide (retryable).
    throw new DatabaseKeyError("unavailable", err);
  }
}

export async function readVaultFacts(): Promise<VaultFacts> {
  const vaultDir = await FileSystem.getInfoAsync(uri(encryptedVaultDirectory()));
  return {
    sqlcipherAvailable: isSQLCipher(),
    legacy: await fileKind(`${legacyVaultDirectoryPath()}${LEGACY_DATABASE_NAME}`),
    vault: await fileKind(`${encryptedVaultDirectory()}/${VAULT_DATABASE_NAME}`),
    vaultDirExists: vaultDir.exists,
    pointer: await readPointer(),
    marker: await readMarker(),
  };
}

// ---------------------------------------------------------------------------
// Entry point

/**
 * Returns what db/client.ts should `open()`. Throws VaultStateError for a
 * state it won't open, or keyManager's errors (cancel, missing key, …).
 */
export async function prepareNormalVault(): Promise<VaultOpenParams> {
  const facts = await readVaultFacts();
  const decision = decideVaultAction(facts);
  devTiming("Vault", "state", { ...facts, decision: decision.kind });
  if (decision.kind === "fail") {
    throw new VaultStateError(decision.reason, decision.detail);
  }

  const params = (encryptionKey: string): VaultOpenParams => ({
    name: VAULT_DATABASE_NAME,
    location: encryptedVaultDirectory(),
    encryptionKey,
  });

  if (decision.kind === "open") {
    // A committed vault only ever opens with the stored key; none is minted.
    const hexKey = await getOrCreateDatabaseKey({ allowCreate: false });
    const key = toRawSqlcipherKey(hexKey);
    setSessionVaultKey(hexKey);
    if (decision.ensureMarker) {
      await setMarkerBestEffort();
    }
    await removeMigrationLeftovers();
    return params(key);
  }

  // Nothing committed yet. A previous attempt's uncommitted vault never held
  // user writes (rule 1 in vaultState.ts), so it's rebuilt from scratch.
  if (decision.discardUncommitted) {
    await discardUncommittedVault();
  }
  if (decision.kind === "migrate") {
    await assertEnoughStorage();
  }
  // No committed vault depends on a key yet (the legacy file is plaintext),
  // so the existing key is reused if readable, otherwise one is created.
  const hexKey = await getOrCreateDatabaseKey({ allowCreate: true });
  const key = toRawSqlcipherKey(hexKey);
  await establishVault(decision, key);
  setSessionVaultKey(hexKey);
  return params(key);
}

/**
 * Right after db/client.ts opens a committed vault: the key must read it,
 * and it must already contain the schema. An empty result means op-sqlite
 * just CREATED a file where the vault should have been — never treated as
 * the vault (that would be a silent fresh start).
 */
export async function assertEstablishedVault(db: DB): Promise<void> {
  const objects = Number(await scalar(db, "SELECT count(*) FROM sqlite_master"));
  if (!(objects > 0)) {
    throw new VaultStateError("conflict", "vaultEmptyOnOpen");
  }
}

// ---------------------------------------------------------------------------
// Establishing (create or migrate)

type Step = "prepare" | "copy" | "export" | "verify" | "place" | "commit" | "mark" | "cleanup";
type Origin = "migrated" | "created";
type LegacyFile = { name: string; size: number; md5: string };
export type VerifyReport = { tables: number; notes: number; todos: number; embeddings: number; ftsRows: number };

async function establishVault(decision: Extract<VaultDecision, { kind: "migrate" | "create" }>, key: string): Promise<void> {
  const origin: Origin = decision.kind === "migrate" ? "migrated" : "created";
  const started = Date.now();
  let legacyFiles: LegacyFile[] = [];

  await step("prepare", origin, async () => {
    await deleteInsideDocs(paths.migrationDir());
    await FileSystem.makeDirectoryAsync(uri(paths.stagedDir()), { intermediates: true });
    if (origin === "migrated") {
      await FileSystem.makeDirectoryAsync(uri(paths.legacyCopyDir()), { intermediates: true });
    }
  });
  if (origin === "migrated") {
    legacyFiles = await step("copy", origin, copyLegacyFileSet);
    await step("export", origin, () => exportLegacyCopy(key));
  } else {
    await step("export", origin, () => createFreshVault(key));
  }
  const report = await step("verify", origin, () => verifyStagedVault(key, origin === "migrated"));
  await step("place", origin, placeStagedVault);
  await step("commit", origin, () => writePointer(origin));
  // Committed. Nothing below may fail the open.
  await afterCommit("mark", origin, setMarkerBestEffort);
  await afterCommit("cleanup", origin, () => deleteInsideDocs(paths.migrationDir()));
  await writeJournal({ phase: "complete", origin, legacyFiles, report });
  console.log(
    `[Vault] Encrypted vault ${origin} in ${Date.now() - started}ms ` +
      `(tables=${report.tables} notes=${report.notes} todos=${report.todos} embeddings=${report.embeddings}).`
  );
}

async function step<T>(name: Step, origin: Origin, run: () => Promise<T>): Promise<T> {
  await writeJournal({ phase: name, origin });
  await injectFault(name, "fail");
  let result: T;
  try {
    result = await run();
  } catch (err) {
    if (err instanceof VaultStateError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const kind = /SQLITE_FULL|database or disk is full|ENOSPC|no space/i.test(message) ? "insufficientStorage" : "migrationFailed";
    throw new VaultStateError(kind, `${name}Failed`, { cause: err });
  }
  devTiming("Vault", `step ${name} done`, { origin });
  await injectFault(name, "pause");
  return result;
}

async function afterCommit(name: Step, origin: Origin, run: () => Promise<void>): Promise<void> {
  try {
    await injectFault(name, "fail");
    await run();
    await injectFault(name, "pause");
  } catch (err) {
    if (err instanceof VaultStateError && err.detail.startsWith("injected")) {
      console.warn(`[Vault] ${name} after commit failed (injected); the vault stays committed.`);
      return;
    }
    console.warn(`[Vault] ${name} after commit failed; the vault stays committed.`, err);
  }
}

async function listLegacyFileSet(): Promise<LegacyFile[]> {
  const dir = legacyVaultDirectoryPath();
  const files: LegacyFile[] = [];
  for (const name of [LEGACY_DATABASE_NAME, ...SIDE_FILE_SUFFIXES.map((s) => `${LEGACY_DATABASE_NAME}${s}`)]) {
    const info = await FileSystem.getInfoAsync(uri(`${dir}${name}`), { md5: true });
    if (info.exists && !info.isDirectory) {
      files.push({ name, size: info.size ?? 0, md5: info.md5 ?? "" });
    }
  }
  return files;
}

async function assertEnoughStorage(): Promise<void> {
  const files = await listLegacyFileSet();
  const total = files.reduce((sum, file) => sum + file.size, 0);
  // The legacy copy plus the encrypted export (≈ same size) plus margin.
  const neededBytes = total * 2 + STORAGE_MARGIN_BYTES;
  const freeBytes = await FileSystem.getFreeDiskStorageAsync();
  if (freeBytes < neededBytes) {
    throw new VaultStateError("insufficientStorage", "beforeMigration", { neededBytes: neededBytes - freeBytes });
  }
}

/** Copies the legacy database and any side files; every copy must match its
 * original's MD5, and the originals must not change while copying. */
async function copyLegacyFileSet(): Promise<LegacyFile[]> {
  const before = await listLegacyFileSet();
  if (!before.some((file) => file.name === LEGACY_DATABASE_NAME)) {
    throw new VaultStateError("conflict", "legacyVanished");
  }
  const dir = legacyVaultDirectoryPath();
  for (const file of before) {
    const to = `${paths.legacyCopyDir()}/${file.name}`;
    await FileSystem.copyAsync({ from: uri(`${dir}${file.name}`), to: uri(to) });
    const copy = await FileSystem.getInfoAsync(uri(to), { md5: true });
    if (!copy.exists || copy.size !== file.size || !file.md5 || copy.md5 !== file.md5) {
      throw new VaultStateError("migrationFailed", "copyMismatch");
    }
  }
  const after = await listLegacyFileSet();
  const unchanged =
    after.length === before.length &&
    after.every((file, index) => file.name === before[index].name && file.md5 === before[index].md5);
  if (!unchanged) {
    throw new VaultStateError("migrationFailed", "legacyChangedDuringCopy");
  }
  return before;
}

async function exportLegacyCopy(key: string): Promise<void> {
  // No key: the copy is plaintext. Opening it read-write lets SQLite roll back
  // a hot journal on the COPY, never the original.
  const source = open({ name: LEGACY_DATABASE_NAME, location: paths.legacyCopyDir() });
  try {
    await scalar(source, "SELECT count(*) FROM sqlite_master");
    await source.execute("ATTACH DATABASE ? AS staged KEY ?", [`${paths.stagedDir()}/${VAULT_DATABASE_NAME}`, key]);
    await source.execute("SELECT sqlcipher_export('staged')");
    // sqlcipher_export doesn't carry user_version.
    const userVersion = Math.trunc(Number(await scalar(source, "PRAGMA main.user_version")) || 0);
    await source.execute(`PRAGMA staged.user_version = ${userVersion}`);
    await source.execute("DETACH DATABASE staged");
  } finally {
    safeClose(source);
  }
}

async function createFreshVault(key: string): Promise<void> {
  const db = open({ name: VAULT_DATABASE_NAME, location: paths.stagedDir(), encryptionKey: key });
  try {
    // A first write, so the file exists encrypted and has a schema object.
    // db/client.ts's createCoreTables() creates the rest (idempotent).
    await db.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL)");
  } finally {
    safeClose(db);
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

async function exceptCount(db: DB, left: string, right: string, table: string): Promise<number> {
  const t = quoteIdent(table);
  try {
    return Number(
      await scalar(db, `SELECT count(*) FROM (SELECT rowid, * FROM ${left}.${t} EXCEPT SELECT rowid, * FROM ${right}.${t})`)
    );
  } catch {
    // WITHOUT ROWID table.
    return Number(await scalar(db, `SELECT count(*) FROM (SELECT * FROM ${left}.${t} EXCEPT SELECT * FROM ${right}.${t})`));
  }
}

async function hasTable(db: DB, schemaName: string, table: string): Promise<boolean> {
  return Number(await scalar(db, `SELECT count(*) FROM ${schemaName}.sqlite_master WHERE type = 'table' AND name = ?`, [table])) > 0;
}

/**
 * Verifies the staged vault from a FRESH connection, after its last write.
 * Throws VaultStateError("migrationFailed", …) on any mismatch.
 */
async function verifyStagedVault(key: string, compareWithLegacy: boolean): Promise<VerifyReport> {
  const stagedPath = `${paths.stagedDir()}/${VAULT_DATABASE_NAME}`;
  const fail = (detail: string): never => {
    throw new VaultStateError("migrationFailed", `verify:${detail}`);
  };
  if ((await fileKind(stagedPath)) !== "encrypted") fail("headerNotEncrypted");

  const report: VerifyReport = { tables: 0, notes: 0, todos: 0, embeddings: 0, ftsRows: 0 };
  const db = open({ name: VAULT_DATABASE_NAME, location: paths.stagedDir(), encryptionKey: key });
  try {
    if (!(Number(await scalar(db, "SELECT count(*) FROM sqlite_master")) > 0)) fail("noSchema");
    if (((await db.execute("PRAGMA cipher_integrity_check")).rows ?? []).length !== 0) fail("cipherIntegrity");
    if ((await scalar(db, "PRAGMA integrity_check")) !== "ok") fail("integrity");

    if (compareWithLegacy) {
      await db.execute("ATTACH DATABASE ? AS legacy KEY ''", [`${paths.legacyCopyDir()}/${LEGACY_DATABASE_NAME}`]);
      try {
        const schemaCols = "type, name, tbl_name, sql";
        for (const [a, b] of [["main", "legacy"], ["legacy", "main"]]) {
          const diff = Number(
            await scalar(db, `SELECT count(*) FROM (SELECT ${schemaCols} FROM ${a}.sqlite_master EXCEPT SELECT ${schemaCols} FROM ${b}.sqlite_master)`)
          );
          if (diff !== 0) fail(`schemaDiff:${a}`);
        }
        const tables = ((await db.execute("SELECT name FROM legacy.sqlite_master WHERE type = 'table' AND rootpage > 0 ORDER BY name")).rows ?? []).map(
          (row) => String(row.name)
        );
        for (const table of tables) {
          const t = quoteIdent(table);
          const mainCount = Number(await scalar(db, `SELECT count(*) FROM main.${t}`));
          const legacyCount = Number(await scalar(db, `SELECT count(*) FROM legacy.${t}`));
          if (mainCount !== legacyCount) fail(`rowCount:${tables.indexOf(table)}`);
          if ((await exceptCount(db, "main", "legacy", table)) !== 0 || (await exceptCount(db, "legacy", "main", table)) !== 0) {
            fail(`rowDiff:${tables.indexOf(table)}`);
          }
        }
        report.tables = tables.length;
        if (Number(await scalar(db, "PRAGMA main.user_version")) !== Number(await scalar(db, "PRAGMA legacy.user_version"))) {
          fail("userVersion");
        }
        for (const virtualTable of ["note_embeddings", "notes_fts"]) {
          if (await hasTable(db, "legacy", virtualTable)) {
            const a = Number(await scalar(db, `SELECT count(*) FROM main.${virtualTable}`));
            const b = Number(await scalar(db, `SELECT count(*) FROM legacy.${virtualTable}`));
            if (a !== b) fail(`virtualCount:${virtualTable}`);
          }
        }
      } finally {
        await db.execute("DETACH DATABASE legacy");
      }
    }

    if (await hasTable(db, "main", "notes")) report.notes = Number(await scalar(db, "SELECT count(*) FROM notes"));
    if (await hasTable(db, "main", "todos")) report.todos = Number(await scalar(db, "SELECT count(*) FROM todos"));
    if (await hasTable(db, "main", "note_embeddings")) {
      report.embeddings = Number(await scalar(db, "SELECT count(*) FROM note_embeddings"));
      if (report.embeddings > 0) {
        const sample = (await db.execute("SELECT rowid, embedding FROM note_embeddings LIMIT 1")).rows?.[0];
        const nearest = (await db.execute("SELECT rowid FROM note_embeddings WHERE embedding MATCH ? AND k = 1", [sample?.embedding as never])).rows ?? [];
        if (nearest.length !== 1) fail("vectorSearch");
      }
    }
    if (await hasTable(db, "main", "notes_fts")) {
      report.ftsRows = Number(await scalar(db, "SELECT count(*) FROM notes_fts"));
      await db.execute("INSERT INTO notes_fts(notes_fts) VALUES('integrity-check')").catch(() => fail("ftsIntegrity"));
    }
  } finally {
    safeClose(db);
  }

  // The key must matter: any other key, no key, and the passphrase reading of
  // the same hex must all be unable to read the staged file.
  const hex = key.slice(2, -1);
  const wrongKey = toRawSqlcipherKey(Array.from(await Crypto.getRandomBytesAsync(32), (b) => b.toString(16).padStart(2, "0")).join(""));
  for (const [label, candidate] of [["wrongKey", wrongKey], ["noKey", undefined], ["passphraseForm", hex]] as const) {
    const probe = open({ name: VAULT_DATABASE_NAME, location: paths.stagedDir(), ...(candidate ? { encryptionKey: candidate } : {}) });
    let readable = false;
    try {
      await scalar(probe, "SELECT count(*) FROM sqlite_master");
      readable = true;
    } catch {
      // expected: "file is not a database"
    } finally {
      safeClose(probe);
    }
    if (readable) fail(`${label}Accepted`);
  }
  return report;
}

async function placeStagedVault(): Promise<void> {
  const staged = await FileSystem.getInfoAsync(uri(`${paths.stagedDir()}/${VAULT_DATABASE_NAME}`));
  const target = await FileSystem.getInfoAsync(uri(encryptedVaultDirectory()));
  if (target.exists) {
    // Discarded before establishing; reappearing means something else wrote it.
    throw new VaultStateError("conflict", "vaultDirAppeared");
  }
  await injectFault("place", "failRename");
  await FileSystem.moveAsync({ from: uri(paths.stagedDir()), to: uri(encryptedVaultDirectory()) });
  const placed = await FileSystem.getInfoAsync(uri(`${encryptedVaultDirectory()}/${VAULT_DATABASE_NAME}`));
  if (!placed.exists || !staged.exists || placed.size !== staged.size) {
    throw new VaultStateError("migrationFailed", "placedSizeMismatch");
  }
}

async function writePointer(origin: Origin): Promise<void> {
  const pointer = {
    version: POINTER_VERSION,
    database: POINTER_DATABASE,
    cipher: POINTER_CIPHER,
    keyFormat: VAULT_KEY_FORMAT,
    origin,
    committedAt: new Date().toISOString(),
  };
  const tmp = `${paths.pointer()}.tmp`;
  await FileSystem.writeAsStringAsync(uri(tmp), JSON.stringify(pointer));
  await injectFault("commit", "failRename");
  await FileSystem.moveAsync({ from: uri(tmp), to: uri(paths.pointer()) });
  if ((await readPointer()) !== "valid") {
    throw new VaultStateError("migrationFailed", "pointerUnreadable");
  }
}

async function setMarkerBestEffort(): Promise<void> {
  try {
    await SecureStore.setItemAsync(MARKER_KEY, "1", MARKER_OPTIONS);
  } catch (err) {
    // The pointer is authoritative; the next launch retries the marker.
    console.warn("[Vault] Couldn't record the encryption marker; will retry on next launch.", err);
  }
}

/** Removes an uncommitted vault and staging. Re-checks there's no pointer
 * first — a committed vault is never deleted here. */
async function discardUncommittedVault(): Promise<void> {
  if ((await readPointer()) !== "absent") {
    throw new VaultStateError("conflict", "pointerAppeared");
  }
  console.log("[Vault] Removing an uncommitted vault from an interrupted attempt; rebuilding.");
  await deleteInsideDocs(encryptedVaultDirectory());
  await deleteInsideDocs(paths.migrationDir());
  await deleteInsideDocs(`${paths.pointer()}.tmp`);
}

async function removeMigrationLeftovers(): Promise<void> {
  try {
    await deleteInsideDocs(paths.migrationDir());
    await deleteInsideDocs(`${paths.pointer()}.tmp`);
  } catch (err) {
    console.warn("[Vault] Couldn't remove migration leftovers.", err);
  }
}

/** Deletes only well-known paths inside the private files directory — never
 * the legacy database directory. */
async function deleteInsideDocs(barePath: string): Promise<void> {
  const root = docsDir();
  if (!barePath.startsWith(root) || barePath.slice(root.length).includes("..") || barePath === root) {
    throw new Error("Refusing to delete outside the private files directory.");
  }
  await FileSystem.deleteAsync(uri(barePath), { idempotent: true });
}

type JournalRecord = { phase: Step | "complete"; origin: Origin; legacyFiles?: LegacyFile[]; report?: VerifyReport };

/** Advisory progress record (what was attempted, counts, MD5s — never note
 * text). Recovery never trusts it over the facts on disk. */
async function writeJournal(record: JournalRecord): Promise<void> {
  const tmp = `${paths.journal()}.tmp`;
  try {
    await FileSystem.writeAsStringAsync(uri(tmp), JSON.stringify({ version: 1, ...record, updatedAt: new Date().toISOString() }));
    await FileSystem.moveAsync({ from: uri(tmp), to: uri(paths.journal()) });
  } catch (err) {
    console.warn("[Vault] Couldn't update the migration journal.", err);
  }
}

// ---------------------------------------------------------------------------
// Development-only fault injection (Xayra Dev / Xayra Test packages only;
// production never reads the file). files/dev-vault-fault.json:
//   { "pauseAfter": "<step>" }  — hang after the step, for a kill -9 test
//   { "failAt": "<step>" }      — throw at the start of the step
//   { "failRenameAt": "place" | "commit" } — the rename itself fails

type FaultSpec = { pauseAfter?: string; failAt?: string; failRenameAt?: string };
let faultSpec: Promise<FaultSpec | null> | null = null;

function loadFaultSpec(): Promise<FaultSpec | null> {
  if (!faultSpec) {
    faultSpec = (async () => {
      if (!isRunningDevPackage()) return null;
      try {
        const info = await FileSystem.getInfoAsync(uri(paths.devFault()));
        if (!info.exists) return null;
        return JSON.parse(await FileSystem.readAsStringAsync(uri(paths.devFault()))) as FaultSpec;
      } catch {
        return null;
      }
    })();
  }
  return faultSpec;
}

async function injectFault(name: Step, mode: "fail" | "pause" | "failRename"): Promise<void> {
  const spec = await loadFaultSpec();
  if (!spec) return;
  if (mode === "fail" && spec.failAt === name) {
    console.log(`[VaultFault] failing at ${name}`);
    throw new VaultStateError("migrationFailed", `injected:${name}`);
  }
  if (mode === "failRename" && spec.failRenameAt === name) {
    console.log(`[VaultFault] rename failing at ${name}`);
    throw new Error("Injected rename failure");
  }
  if (mode === "pause" && spec.pauseAfter === name) {
    console.log(`[VaultFault] paused after ${name}`);
    await new Promise<never>(() => undefined);
  }
}

// ---------------------------------------------------------------------------

function safeClose(db: DB | null): void {
  try {
    db?.close();
  } catch {
    // already closed
  }
}

async function scalar(db: DB, sql: string, params?: unknown[]): Promise<unknown> {
  const result = await db.execute(sql, params as never);
  const row = result.rows?.[0];
  return row ? Object.values(row)[0] : undefined;
}
