import { open, type DB } from "@op-engineering/op-sqlite";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

import { getRawDatabase } from "../../db/client";
import type { Recurrence } from "../../db/schema";
import { listNoteRevisions, listNotes, type CloudNoteRecord, type NoteRevision } from "../notes/noteManager";
import { listAllToDos, type CloudToDoRecord } from "../todos/todoManager";
import { getSessionVaultKey } from "../vault/vaultIdentity";
import { toRawSqlcipherKey } from "../vault/vaultKey";

/**
 * Every database operation the encrypted backup needs, on real SQLCipher.
 * Backup files live only in a private staging folder (files/backup-staging/
 * <run>/) that is removed after each run. Backup keys are raw SQLCipher keys
 * (vaultKey.ts); `null` key means a legacy plaintext file, which is only ever
 * opened read-only.
 */

const STAGING_ROOT = () => `${(FileSystem.documentDirectory ?? "").replace(/^file:\/\//, "")}backup-staging`;

export type IdSets = { noteIds: string[]; todoIds: string[] };

export async function createStaging(): Promise<string> {
  const dir = `${STAGING_ROOT()}/${Crypto.randomUUID()}`;
  await FileSystem.makeDirectoryAsync(`file://${dir}`, { intermediates: true });
  return dir;
}

export async function removeStaging(dir: string): Promise<void> {
  if (!dir.startsWith(`${STAGING_ROOT()}/`) || dir.includes("..")) {
    throw new Error("Refusing to delete outside backup staging.");
  }
  await FileSystem.deleteAsync(`file://${dir}`, { idempotent: true });
}

/** Staging left by an interrupted run (all derived copies). */
export async function removeAllStaging(): Promise<void> {
  await FileSystem.deleteAsync(`file://${STAGING_ROOT()}`, { idempotent: true });
}

export async function fileMd5(barePath: string): Promise<{ md5: string; size: number }> {
  const info = await FileSystem.getInfoAsync(`file://${barePath}`, { md5: true });
  if (!info.exists || info.isDirectory || !info.md5) {
    throw new Error("Backup file is missing.");
  }
  return { md5: info.md5, size: info.size ?? 0 };
}

function safeClose(db: DB | null): void {
  try {
    db?.close();
  } catch {
    // already closed
  }
}

async function scalar(db: DB, sql: string): Promise<unknown> {
  const row = (await db.execute(sql)).rows?.[0];
  return row ? Object.values(row)[0] : undefined;
}

function openFile(dir: string, name: string, key: string | null, readOnly: boolean): DB {
  return open({ name, location: dir, ...(key ? { encryptionKey: key } : {}), ...(readOnly ? { readOnly: true } : {}) });
}

async function readIds(db: DB, schema = "main"): Promise<IdSets> {
  const notes = (await db.execute(`SELECT id FROM ${schema}.notes`)).rows ?? [];
  const todos = (await db.execute(`SELECT id FROM ${schema}.todos`)).rows ?? [];
  return { noteIds: notes.map((r) => String(r.id)), todoIds: todos.map((r) => String(r.id)) };
}

/**
 * Opens a backup file read-only and checks it really is a readable, intact
 * database with the expected tables. Wrong key → throws.
 */
export async function inspectBackupFile(dir: string, name: string, key: string | null): Promise<IdSets> {
  const db = openFile(dir, name, key, true);
  try {
    if (!(Number(await scalar(db, "SELECT count(*) FROM sqlite_master")) > 0)) {
      throw new Error("Backup file has no tables.");
    }
    if ((await scalar(db, "PRAGMA integrity_check")) !== "ok") {
      throw new Error("Backup file failed its integrity check.");
    }
    if (key && ((await db.execute("PRAGMA cipher_integrity_check")).rows ?? []).length > 0) {
      throw new Error("Backup file failed its encryption integrity check.");
    }
    return await readIds(db);
  } finally {
    safeClose(db);
  }
}

/** The live vault's note and to-do ids. */
export async function readLocalIds(): Promise<IdSets> {
  return readIds(await getRawDatabase());
}

/**
 * First generation (no earlier backup): a consistent copy of the local vault,
 * re-encrypted under the backup key. `VACUUM INTO` takes an atomic snapshot
 * (still under this phone's vault key); `sqlcipher_export` then writes it to a
 * new file under the backup key.
 */
export async function writeLocalSnapshot(dir: string, outName: string, backupKey: string): Promise<void> {
  const vaultHex = getSessionVaultKey();
  if (!vaultHex) {
    throw new Error("The vault key isn't available for this backup.");
  }
  const live = await getRawDatabase();
  await live.execute("VACUUM INTO ?", [`${dir}/local-snapshot.sqlite`]);
  const snap = openFile(dir, "local-snapshot.sqlite", toRawSqlcipherKey(vaultHex), false);
  try {
    await snap.execute("ATTACH DATABASE ? AS gen KEY ?", [`${dir}/${outName}`, backupKey]);
    await snap.execute("SELECT sqlcipher_export('gen')");
    await snap.execute("DETACH DATABASE gen");
  } finally {
    safeClose(snap);
    await FileSystem.deleteAsync(`file://${dir}/local-snapshot.sqlite`, { idempotent: true });
  }
}

export type MergeCounts = { addedNotes: number; updatedNotes: number; addedTodos: number; updatedTodos: number };

/**
 * Later generations: local notes and to-dos merged INTO the downloaded base
 * generation (insert-only, newer edit wins — nothing is ever removed from a
 * backup), then sealed into a new file under `outKey`: `VACUUM INTO` when the
 * key stays the same, `sqlcipher_export` when it changes.
 */
export async function mergeLocalIntoBase(
  dir: string,
  baseName: string,
  baseKey: string,
  outName: string,
  outKey: string
): Promise<MergeCounts> {
  const base = openFile(dir, baseName, baseKey, false);
  try {
    const [localNotes, localToDos, revisions] = await Promise.all([listNotes(), listAllToDos(), listNoteRevisions()]);
    const addedNotes = await insertMissingNoteRows(base, localNotes.map(toCloudNoteRecord));
    const updatedNotes = await updateEditedNoteRows(base, revisions);
    const addedTodos = await insertMissingToDoRows(base, localToDos.map(toCloudToDoRecord));
    const updatedTodos = await updateChangedToDoRows(base, localToDos.map(toCloudToDoRecord));
    if (outKey === baseKey) {
      await base.execute("VACUUM INTO ?", [`${dir}/${outName}`]);
    } else {
      await base.execute("ATTACH DATABASE ? AS gen KEY ?", [`${dir}/${outName}`, outKey]);
      await base.execute("SELECT sqlcipher_export('gen')");
      await base.execute("DETACH DATABASE gen");
    }
    return { addedNotes, updatedNotes, addedTodos, updatedTodos };
  } finally {
    safeClose(base);
  }
}

/**
 * A canonical digest of a backup file's notes and to-dos (every column,
 * ordered by id) — used to tell whether a new generation would differ in any
 * way from the last verified one. Counts are never used for this.
 */
export async function contentDigest(dir: string, name: string, key: string): Promise<string> {
  const db = openFile(dir, name, key, true);
  try {
    const notes = (await db.execute("SELECT * FROM notes ORDER BY id")).rows ?? [];
    const todos = (await db.execute("SELECT * FROM todos ORDER BY id")).rows ?? [];
    const canonical = (rows: Record<string, unknown>[]) =>
      rows.map((row) => Object.keys(row).sort().map((k) => [k, row[k] ?? null]));
    return Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, JSON.stringify([canonical(notes), canonical(todos)]));
  } finally {
    safeClose(db);
  }
}

/**
 * Another device's newest backup (a concurrent "head") merged into the base:
 * rows missing from the base are inserted, and a strictly newer note edit
 * replaces the base's text. Nothing is removed.
 */
export async function mergeOtherHeadInto(dir: string, baseName: string, baseKey: string, otherName: string, otherKey: string): Promise<void> {
  const base = openFile(dir, baseName, baseKey, false);
  try {
    await base.execute("ATTACH DATABASE ? AS other KEY ?", [`${dir}/${otherName}`, otherKey]);
    const noteCols = "id, content, audio_uri, transcript, status, transcription_model, created_at, updated_at";
    const todoCols = "id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id";
    await base.execute(`INSERT OR IGNORE INTO main.notes (${noteCols}) SELECT ${noteCols} FROM other.notes`);
    await base.execute(
      `UPDATE main.notes SET
         content = (SELECT o.content FROM other.notes o WHERE o.id = main.notes.id),
         transcript = (SELECT o.transcript FROM other.notes o WHERE o.id = main.notes.id),
         updated_at = (SELECT o.updated_at FROM other.notes o WHERE o.id = main.notes.id)
       WHERE id IN (SELECT o.id FROM other.notes o JOIN main.notes m ON m.id = o.id WHERE o.updated_at > m.updated_at)`
    );
    await base.execute(`INSERT OR IGNORE INTO main.todos (${todoCols}) SELECT ${todoCols} FROM other.todos`);
    await base.execute("DETACH DATABASE other");
  } finally {
    safeClose(base);
  }
}

/** Notes and to-dos from a backup file, for restore (read-only). */
export async function readBackupRecords(
  dir: string,
  name: string,
  key: string | null
): Promise<{ notes: CloudNoteRecord[]; todos: CloudToDoRecord[] }> {
  const db = openFile(dir, name, key, true);
  try {
    const noteRows = (await db.execute("SELECT id, content, transcript, transcription_model, created_at FROM notes")).rows ?? [];
    const todoRows =
      (
        await db.execute(
          "SELECT id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id FROM todos"
        )
      ).rows ?? [];
    return {
      notes: noteRows.map((row) => ({
        id: String(row.id),
        content: (row.content as string) || (row.transcript as string) || "",
        transcript: (row.transcript as string | null) ?? null,
        transcriptionModel: (row.transcription_model as string | null) ?? null,
        createdAt: Number(row.created_at),
      })),
      todos: todoRows.map((row) => ({
        id: String(row.id),
        text: String(row.text),
        actionDate: String(row.action_date),
        toDate: (row.to_date as string | null) ?? null,
        notificationTime: (row.notification_time as string | null) || "05:00",
        isCompleted: Boolean(row.is_completed),
        recurrence: ((row.recurrence as Recurrence) || "none") as Recurrence,
        recurrenceInterval: Number(row.recurrence_interval) || 1,
        createdAt: String(row.created_at),
        noteId: (row.note_id as string | null) ?? null,
      })),
    };
  } finally {
    safeClose(db);
  }
}

/** A device key entry: this phone's vault key inside a tiny SQLCipher file
 * keyed with the backup key. */
export async function writeDeviceEntry(
  dir: string,
  name: string,
  backupKey: string,
  entry: { vaultId: string; vaultKeyHex: string; label: string }
): Promise<void> {
  const db = openFile(dir, name, backupKey, false);
  try {
    await db.execute("CREATE TABLE device (vault_id TEXT NOT NULL, vault_key TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL)");
    await db.execute("INSERT INTO device (vault_id, vault_key, label, created_at) VALUES (?, ?, ?, ?)", [
      entry.vaultId,
      entry.vaultKeyHex,
      entry.label,
      new Date().toISOString(),
    ]);
  } finally {
    safeClose(db);
  }
}

/** Reads a device entry; null if this key can't open it or it's malformed. */
export async function readDeviceEntry(dir: string, name: string, backupKey: string): Promise<{ vaultId: string; vaultKeyHex: string } | null> {
  const db = openFile(dir, name, backupKey, true);
  try {
    const row = (await db.execute("SELECT vault_id, vault_key FROM device LIMIT 1")).rows?.[0];
    const vaultKeyHex = String(row?.vault_key ?? "");
    return /^[0-9a-f]{64}$/.test(vaultKeyHex) ? { vaultId: String(row?.vault_id ?? ""), vaultKeyHex } : null;
  } catch {
    return null;
  } finally {
    safeClose(db);
  }
}

// ---------------------------------------------------------------------------
// Record merge helpers (moved unchanged from driveSync.ts's legacy backup).

function toCloudNoteRecord(note: { id: string; content: string; transcript: string | null; transcriptionModel: string | null; createdAt: number }): CloudNoteRecord {
  return { id: note.id, content: note.content, transcript: note.transcript, transcriptionModel: note.transcriptionModel, createdAt: note.createdAt };
}

function toCloudToDoRecord(todo: CloudToDoRecord): CloudToDoRecord {
  return {
    id: todo.id,
    text: todo.text,
    actionDate: todo.actionDate,
    toDate: todo.toDate,
    notificationTime: todo.notificationTime,
    isCompleted: todo.isCompleted,
    recurrence: todo.recurrence,
    recurrenceInterval: todo.recurrenceInterval,
    createdAt: todo.createdAt,
    noteId: todo.noteId,
  };
}

/** Inserts notes missing (by id) from a backup copy. INSERT-only: the result
 * is always a superset. Never the live database (no embedding side effects). */
async function insertMissingNoteRows(targetDb: DB, notes: CloudNoteRecord[]): Promise<number> {
  const existing = new Set(((await targetDb.execute("SELECT id FROM notes")).rows ?? []).map((row) => row.id as string));
  const missing = notes.filter((note) => !existing.has(note.id));
  if (missing.length === 0) return 0;
  const insertedAt = Math.floor(Date.now() / 1000);
  await targetDb.transaction(async (tx) => {
    for (const note of missing) {
      await tx.execute(
        `INSERT OR IGNORE INTO notes (id, content, audio_uri, transcript, status, transcription_model, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'transcribed', ?, ?, ?)`,
        [note.id, note.content, note.transcript, note.transcriptionModel, note.createdAt, insertedAt]
      );
    }
  });
  return missing.length;
}

/** Carries local edits into a backup copy: only a strictly NEWER local
 * `updated_at` replaces the backed-up text (same id; created_at untouched). */
async function updateEditedNoteRows(targetDb: DB, local: NoteRevision[]): Promise<number> {
  const remote = await targetDb.execute("SELECT id, content, transcript, updated_at FROM notes");
  const backedUp = new Map((remote.rows ?? []).map((row) => [String(row.id), row]));
  const edited = local.filter((note) => {
    const row = backedUp.get(note.id);
    if (!row || !(note.updatedAt > Number(row.updated_at))) return false;
    return row.content !== note.content || (row.transcript ?? null) !== note.transcript;
  });
  if (edited.length === 0) return 0;
  await targetDb.transaction(async (tx) => {
    for (const note of edited) {
      await tx.execute("UPDATE notes SET content = ?, transcript = ?, updated_at = ? WHERE id = ?", [
        note.content,
        note.transcript,
        note.updatedAt,
        note.id,
      ]);
    }
  });
  return edited.length;
}

/**
 * Carries to-do changes (completed, rescheduled, edited) into a backup copy.
 * To-dos have no edit timestamp, so the backing-up phone's current version
 * replaces the backed-up copy of the same to-do. Deleted to-dos are never
 * removed from a backup (same rule as notes).
 */
async function updateChangedToDoRows(targetDb: DB, todos: CloudToDoRecord[]): Promise<number> {
  const rows = (
    await targetDb.execute(
      "SELECT id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, note_id FROM todos"
    )
  ).rows ?? [];
  const backedUp = new Map(rows.map((row) => [String(row.id), row]));
  const changed = todos.filter((todo) => {
    const row = backedUp.get(todo.id);
    if (!row) return false;
    return (
      row.text !== todo.text ||
      row.action_date !== todo.actionDate ||
      (row.to_date ?? null) !== todo.toDate ||
      row.notification_time !== todo.notificationTime ||
      Boolean(row.is_completed) !== todo.isCompleted ||
      row.recurrence !== todo.recurrence ||
      Number(row.recurrence_interval) !== todo.recurrenceInterval ||
      (row.note_id ?? null) !== todo.noteId
    );
  });
  if (changed.length === 0) return 0;
  await targetDb.transaction(async (tx) => {
    for (const todo of changed) {
      await tx.execute(
        `UPDATE todos SET text = ?, action_date = ?, to_date = ?, notification_time = ?, is_completed = ?, recurrence = ?, recurrence_interval = ?, note_id = ?
         WHERE id = ?`,
        [todo.text, todo.actionDate, todo.toDate, todo.notificationTime, todo.isCompleted ? 1 : 0, todo.recurrence, todo.recurrenceInterval, todo.noteId, todo.id]
      );
    }
  });
  return changed.length;
}

async function insertMissingToDoRows(targetDb: DB, todos: CloudToDoRecord[]): Promise<number> {
  const existing = new Set(((await targetDb.execute("SELECT id FROM todos")).rows ?? []).map((row) => row.id as string));
  const missing = todos.filter((todo) => !existing.has(todo.id));
  if (missing.length === 0) return 0;
  await targetDb.transaction(async (tx) => {
    for (const todo of missing) {
      await tx.execute(
        `INSERT OR IGNORE INTO todos
           (id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          todo.id,
          todo.text,
          todo.actionDate,
          todo.toDate,
          todo.notificationTime,
          todo.isCompleted ? 1 : 0,
          todo.recurrence,
          todo.recurrenceInterval,
          todo.createdAt,
          todo.noteId,
        ]
      );
    }
  });
  return missing.length;
}
