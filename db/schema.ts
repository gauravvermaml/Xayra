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
  /** Which local Whisper engine ("base" | "tiny") produced this note's
   * transcript — null for text notes or notes transcribed by the native
   * (Tier 1) speech recognizer instead of local Whisper. */
  transcriptionModel: text("transcription_model"),
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

/** Auto-Structured "Your To-Dos" module (Phase 2) — how often a completed
 * to-do respawns a fresh occurrence. See services/todos/todoManager.ts's
 * `completeToDo()` for the actual respawn logic. */
export const RECURRENCE_OPTIONS = ["none", "daily", "weekly", "monthly"] as const;
export type Recurrence = (typeof RECURRENCE_OPTIONS)[number];

/** Phase 2 Step 4: a to-do with no explicitly spoken/typed reminder time
 * fires its local notification at 5 AM on `actionDate` — an early, out-of-
 * the-way default that's still guaranteed to land before a normal day
 * starts, rather than an arbitrary daytime hour that might already have
 * passed by the time the to-do is saved. Exported as a single named
 * constant (not a literal duplicated at every call site) so
 * services/ai/transformationEngine.ts, services/todos/todoManager.ts, and
 * components/TodoItemRow.tsx's "only show a time badge when it's NOT the
 * default" check can never drift out of sync with the column's own default
 * below. */
export const DEFAULT_NOTIFICATION_TIME = "05:00";

/**
 * A single actionable to-do, either entered directly or extracted from a
 * note's text by services/ai/transformationEngine.ts's local Llama pass.
 * `actionDate`/`createdAt` are plain ISO strings (`YYYY-MM-DD` /
 * `toISOString()`), not drizzle's integer timestamp mode like `notes` above —
 * a to-do's action date is a calendar day a user reasons about directly
 * ("do this on the 3rd"), not an instant in time, so keeping it as the exact
 * string the extraction model and the UI both read/write avoids a timezone
 * round-trip through `Date` on every read.
 */
export const todos = sqliteTable("todos", {
  id: text("id").primaryKey(),
  text: text("text").notNull(),
  actionDate: text("action_date").notNull(),
  /**
   * Phase 2 Step 4: end of a date span ("from 27th Sep to 10th Oct"),
   * nullable — most to-dos are a single day, so this is null far more often
   * than not. Deliberately still a plain ISO string, not a computed
   * duration/interval, for the same reason `actionDate` is: a calendar day
   * a user reasons about directly, not an instant to round-trip through
   * `Date`. See services/ai/transformationEngine.ts's `resolveDateAndTime()`
   * for how this is derived — via chrono-node's own native range detection
   * on the SAME extracted phrase `actionDate` comes from, never a second
   * field asked of the LLM itself (a small model splitting one range
   * mention into two independently-copied substrings is exactly the kind of
   * task this codebase has repeatedly found small models unreliable at —
   * see that file's own doc comments for the history of why date arithmetic/
   * splitting stays out of the model's hands).
   */
  toDate: text("to_date"),
  /**
   * Phase 2 Step 4: 24-hour "HH:MM" local time-of-day the to-do's local
   * notification fires on `actionDate` (or `toDate` when a range's time was
   * stated relative to its end — see `resolveDateAndTime()`). Defaults to
   * `DEFAULT_NOTIFICATION_TIME` (see its own doc comment above) when no time
   * was explicitly spoken/typed, matching notification_time's SQL-level
   * `DEFAULT '05:00'` in db/client.ts's migration — keep both in sync with
   * the exported constant, never a bare literal, if this default ever
   * changes.
   */
  notificationTime: text("notification_time").notNull().default(DEFAULT_NOTIFICATION_TIME),
  isCompleted: integer("is_completed").notNull().default(0),
  recurrence: text("recurrence").notNull().default("none"),
  /**
   * Multiplier on `recurrence`'s base unit — `recurrence: "weekly"` +
   * `recurrenceInterval: 2` means "every 2 weeks", matching the standard
   * iCalendar RRULE FREQ+INTERVAL pattern rather than inventing a bespoke
   * one. Added after on-device testing showed the bare 4-value enum
   * silently mis-rounding "every second week"/"every second Monday" to a
   * plain weekly respawn — see services/ai/transformationEngine.ts's
   * `resolveRecurrenceInterval()` for how this is derived (deterministically
   * from the extracted date phrase, never asked of the LLM itself) and
   * services/todos/todoManager.ts's `computeNextActionDate()` for how it's
   * applied. Always >= 1; 1 means "every single occurrence of the unit",
   * i.e. the exact previous (interval-less) behavior.
   */
  recurrenceInterval: integer("recurrence_interval").notNull().default(1),
  createdAt: text("created_at").notNull(),
  /** The note this to-do was auto-extracted from (services/ai/
   * transformationEngine.ts + noteManager.ts's `scheduleToDoExtraction`) —
   * null for a to-do entered directly via the Add modal, which has no
   * originating note. Deliberately no foreign-key/cascade-delete wiring to
   * `notes.id`: a to-do citing a since-deleted note should keep existing
   * (the task itself is still real) with its "Source Note" link simply
   * resolving to nothing — see components/TodoItemRow.tsx and
   * NoteDetailModal's own "this note could not be found" handling, which
   * already covers exactly that case for other stale-note-id references. */
  noteId: text("note_id"),
});

/**
 * Generic one-row-per-flag key/value store for small durable app state that
 * isn't really "data" (no user-facing list/search/query needs) but still
 * belongs in the same encrypted SQLite DB as everything else rather than a
 * second storage mechanism — see services/settings/appSettings.ts, whose
 * `isSetupComplete()`/`markSetupComplete()` are its first use (the "One
 * Door, Opens Once" onboarding gate in app/_layout.tsx). Deliberately NOT
 * the same thing as services/settings/preferences.ts's plain-JSON-file
 * `allowCellularDownloads` flag, which predates this table and was left
 * as-is rather than migrated — this table is for state added going forward.
 */
export const appSettings = sqliteTable("app_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

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
