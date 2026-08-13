import { sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Lifecycle of a voice note as it moves through the async processing pipeline. */
export const NOTE_STATUSES = ["pending", "transcribed", "embedded", "failed"] as const;
export type NoteStatus = (typeof NOTE_STATUSES)[number];

export const notes = sqliteTable("notes", {
  id: text("id").primaryKey(),
  content: text("content").notNull(),
  audioUri: text("audio_uri"),
  transcript: text("transcript"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

/**
 * sqlite-vec virtual table for 384-dim note embeddings (local ONNX
 * bge-small-en-v1.5, see services/ai/localEmbeddings.ts — was 1536-d OpenAI
 * text-embedding-3-small before Phase 4 Stage 4B; db/client.ts's startup
 * migration drops and recreates this table if it finds the old dimension).
 * drizzle-kit has no first-class support for `vec0` virtual tables, so this
 * is created directly via raw SQL in db/client.ts rather than modeled as a
 * sqliteTable. No explicit primary key column: the table relies on
 * sqlite-vec's implicit integer `rowid`, which noteManager sets explicitly
 * at insert time to match the corresponding `notes` row's `rowid` — that's
 * what search joins the two tables on.
 */
export const NOTE_EMBEDDINGS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS note_embeddings USING vec0(
    embedding float[384]
  );
`;

/**
 * FTS5 keyword index over `notes.content`, as an "external content" table:
 * it stores no copy of the text itself, just the token index, keyed by
 * `notes.rowid`. Kept in sync by the triggers below rather than updated
 * manually at call sites.
 */
export const NOTES_FTS_TABLE_SQL = `
  CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
    content,
    content='notes',
    content_rowid='rowid'
  );
`;

/**
 * External-content FTS5 tables can't re-derive a deleted/old row's text
 * from `notes` once it's gone, so SQLite requires the special `('delete', ...)`
 * command — passing the old column values explicitly — instead of a plain
 * DELETE. See https://sqlite.org/fts5.html#the_content_table_and_rowid.
 */
export const NOTES_FTS_TRIGGERS_SQL = [
  `
    CREATE TRIGGER IF NOT EXISTS notes_fts_ai AFTER INSERT ON notes BEGIN
      INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `,
  `
    CREATE TRIGGER IF NOT EXISTS notes_fts_ad AFTER DELETE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
  `,
  `
    CREATE TRIGGER IF NOT EXISTS notes_fts_au AFTER UPDATE ON notes BEGIN
      INSERT INTO notes_fts(notes_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO notes_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
  `,
];
