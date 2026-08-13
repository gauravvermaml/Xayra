import { open, type DB } from "@op-engineering/op-sqlite";
import { drizzle, type OPSQLiteDatabase } from "drizzle-orm/op-sqlite";

import { EMBEDDING_DIMENSIONS, generateEmbeddingLocal } from "../services/ai/localEmbeddings";
import { getOrCreateDatabaseKey } from "../services/crypto/keyManager";
import {
  NOTE_EMBEDDINGS_TABLE_SQL,
  NOTES_FTS_TABLE_SQL,
  NOTES_FTS_TRIGGERS_SQL,
} from "./schema";
import * as schema from "./schema";

const DATABASE_NAME = "silent-confidant.sqlite";

type DatabaseHandle = {
  db: DB;
  drizzleDb: OPSQLiteDatabase<typeof schema>;
  /** False when the linked SQLite build has no FTS5 module compiled in. */
  ftsAvailable: boolean;
};

/**
 * Metro Fast Refresh re-evaluates this module on edit, which would reset a
 * plain module-scoped `let` singleton to null while the native op-sqlite
 * connection for DATABASE_NAME is still open underneath it — the next
 * `open()` call then races to re-open/re-key an already-active handle.
 * Caching the connection promise on `globalThis` instead survives module
 * re-evaluation, so reloads reuse the existing connection.
 */
const GLOBAL_KEY = "__silentConfidantDbConnection__";

type GlobalWithDb = typeof globalThis & {
  [GLOBAL_KEY]?: Promise<DatabaseHandle>;
};

const globalWithDb = globalThis as GlobalWithDb;

async function openDatabase(): Promise<DatabaseHandle> {
  const encryptionKey = await getOrCreateDatabaseKey();

  const db = open({
    name: DATABASE_NAME,
    encryptionKey,
  });

  await createCoreTables(db);
  const needsReembed = await dropStaleEmbeddingsTable(db);
  await db.execute(NOTE_EMBEDDINGS_TABLE_SQL);
  if (needsReembed) {
    // Deliberately not awaited: re-embedding every note can take a while on
    // a phone CPU, and every other `getConnection()` caller across the app
    // is waiting on this same promise to resolve — blocking here would
    // freeze app startup on a large note library.
    void reembedAllNotesInBackground(db);
  }
  const ftsAvailable = await createFtsIndex(db);

  return { db, drizzleDb: drizzle(db, { schema }), ftsAvailable };
}

/** Returns the memoized connection, opening it at most once per JS context. */
function getConnection(): Promise<DatabaseHandle> {
  if (!globalWithDb[GLOBAL_KEY]) {
    globalWithDb[GLOBAL_KEY] = openDatabase().catch((err) => {
      // Allow a retry on the next call instead of caching a failed open.
      globalWithDb[GLOBAL_KEY] = undefined;
      throw err;
    });
  }
  return globalWithDb[GLOBAL_KEY];
}

/**
 * Opens (or returns the cached) encrypted, sqlite-vec-enabled database.
 * The encryption key never touches disk unencrypted: it's minted and
 * stored via the hardware keystore/keychain in keyManager, and only
 * held in memory here for the lifetime of the open connection.
 */
export async function getDatabase(): Promise<OPSQLiteDatabase<typeof schema>> {
  const { drizzleDb } = await getConnection();
  return drizzleDb;
}

/**
 * Returns the raw op-sqlite connection for operations drizzle has no
 * first-class support for, namely the `vec0` virtual table.
 */
export async function getRawDatabase(): Promise<DB> {
  const { db } = await getConnection();
  return db;
}

/**
 * Whether `notes_fts` (and its sync triggers) were successfully created.
 * False on a dev client whose bundled SQLite wasn't compiled with FTS5 —
 * callers should skip keyword-search/notes_fts operations in that case
 * rather than crashing on "no such table: notes_fts".
 */
export async function isFtsAvailable(): Promise<boolean> {
  const { ftsAvailable } = await getConnection();
  return ftsAvailable;
}

async function createCoreTables(db: DB): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY NOT NULL,
      content TEXT NOT NULL,
      audio_uri TEXT,
      transcript TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  // `CREATE TABLE IF NOT EXISTS` above is a no-op against a notes table that
  // already existed before the `status` column was introduced, so add it
  // separately. SQLite's ALTER TABLE has no `IF NOT EXISTS` for columns, so
  // a "duplicate column name" failure here just means it's already there.
  try {
    await db.execute("ALTER TABLE notes ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/duplicate column/i.test(message)) {
      throw err;
    }
  }

}

/**
 * `note_embeddings` is a `vec0` virtual table, so its declared vector
 * dimension is baked into the `CREATE VIRTUAL TABLE` statement itself —
 * `sqlite_master.sql` is the only place to read it back from (there's no
 * `PRAGMA table_info`-style introspection for vec0's column). If a
 * previous build created it at a different dimension (1536-d OpenAI
 * embeddings, pre-Stage-4B), the table is dropped here so the caller can
 * recreate it fresh at the current `EMBEDDING_DIMENSIONS`. Returns whether
 * a stale table was actually found and dropped, so the caller knows
 * whether a re-embedding pass is needed.
 */
async function dropStaleEmbeddingsTable(db: DB): Promise<boolean> {
  const existing = await db.execute(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'note_embeddings'"
  );
  const existingSql = existing.rows[0]?.sql as string | undefined;
  if (!existingSql) {
    return false;
  }

  const match = existingSql.match(/float\[(\d+)\]/i);
  const existingDim = match ? Number(match[1]) : null;
  if (existingDim === EMBEDDING_DIMENSIONS) {
    return false;
  }

  console.warn(
    `[db] note_embeddings is ${existingDim ?? "an unrecognized"}-d, migrating to ` +
      `${EMBEDDING_DIMENSIONS}-d for local ONNX embeddings. Existing vectors will be ` +
      "dropped and regenerated in the background."
  );
  await db.execute("DROP TABLE note_embeddings");
  return true;
}

/**
 * Re-embeds every note with usable text after a dimension migration, since
 * the old vectors were just dropped wholesale rather than converted (there's
 * no way to project a 1536-d OpenAI embedding into 384-d bge-space).
 * Failures on individual notes are logged and skipped rather than aborting
 * the whole pass — one bad note shouldn't leave every other note unsearchable.
 */
async function reembedAllNotesInBackground(db: DB): Promise<void> {
  try {
    const result = await db.execute(
      "SELECT rowid, id, content, transcript FROM notes WHERE status != 'failed'"
    );

    let succeeded = 0;
    for (const row of result.rows) {
      const text = ((row.content as string) || (row.transcript as string) || "").trim();
      if (!text) {
        continue;
      }

      try {
        const embedding = await generateEmbeddingLocal(text);
        await db.execute("INSERT INTO note_embeddings (rowid, embedding) VALUES (?, ?)", [
          row.rowid,
          JSON.stringify(embedding),
        ]);
        await db.execute("UPDATE notes SET status = 'embedded', updated_at = ? WHERE id = ?", [
          Math.floor(Date.now() / 1000),
          row.id,
        ]);
        succeeded += 1;
      } catch (err) {
        console.error("[db] Failed to re-embed note during migration", row.id, err);
      }
    }

    console.log(`[db] Background re-embedding migration complete: ${succeeded}/${result.rows.length} notes.`);
  } catch (err) {
    console.error("[db] Background re-embedding migration failed", err);
  }
}

/**
 * Creates the FTS5 index and its sync triggers. FTS5 is a compile-time
 * SQLite option (`op-sqlite.fts5: true` in package.json, which requires a
 * native rebuild to take effect) — on a dev client built before that flag
 * was set, `CREATE VIRTUAL TABLE ... USING fts5` fails with
 * "no such module: fts5". That's treated as a degraded-mode condition
 * rather than a fatal one: the rest of the database (notes, embeddings,
 * search) still needs to work without keyword search.
 */
async function createFtsIndex(db: DB): Promise<boolean> {
  try {
    await db.execute(NOTES_FTS_TABLE_SQL);
    for (const triggerSql of NOTES_FTS_TRIGGERS_SQL) {
      await db.execute(triggerSql);
    }
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!/no such module.*fts5/i.test(message)) {
      throw err;
    }
    console.warn(
      "[db] FTS5 is not compiled into this build's SQLite — keyword search is disabled. " +
        "Rebuild the native app (e.g. `npx expo prebuild --clean` then `npx expo run:android`) " +
        "to pick up the `op-sqlite.fts5: true` setting in package.json."
    );
    return false;
  }
}

/** Closes the underlying connection. Mainly useful for tests/teardown. */
export function closeDatabase(): void {
  const pending = globalWithDb[GLOBAL_KEY];
  globalWithDb[GLOBAL_KEY] = undefined;
  void pending?.then(({ db }) => db.close());
}
