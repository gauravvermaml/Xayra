import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

import { getRawDatabase, isFtsAvailable } from "../../db/client";
import type { NoteStatus } from "../../db/schema";
import { isEmbeddingModelDownloaded } from "../ai/embeddingModel";
import { generateEmbeddingLocal } from "../ai/localEmbeddings";
import { logDuration, nowMs } from "../ai/perf";

export type Note = {
  id: string;
  content: string;
  audioUri: string | null;
  transcript: string | null;
  status: NoteStatus;
  /** Which local Whisper engine ("base" | "tiny") transcribed this note —
   * null for text notes or notes transcribed by the native speech recognizer. */
  transcriptionModel: string | null;
  createdAt: number;
};

export class EmptyRecordingError extends Error {
  constructor() {
    super("Recording was too short or empty, please try again");
    this.name = "EmptyRecordingError";
  }
}

export class SilentRecordingError extends Error {
  constructor() {
    super(
      "Microphone captured silence. Please ensure host microphone is enabled in emulator settings."
    );
    this.name = "SilentRecordingError";
  }
}

/** Below this, a recording is almost certainly a misfire (tap-and-release, no audio captured). */
const MIN_AUDIO_BYTES = 2000;

/**
 * Matches Whisper's output for a genuinely silent/near-silent recording —
 * on the emulator this is typically a string of dots/ellipses ("... ... ...")
 * with no actual words, which happens when the host mic isn't routed
 * through to the AVD.
 */
const SILENCE_TRANSCRIPT_PATTERN = /^[\s.,\-]+$/;

/** Shared with app/chat.tsx's voice-query flow so both surfaces agree on
 * what counts as "Whisper heard nothing" instead of drifting independently. */
export function isSilentTranscript(text: string): boolean {
  return SILENCE_TRANSCRIPT_PATTERN.test(text.trim());
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

async function updateNoteStatus(
  id: string,
  status: NoteStatus,
  fields: { content?: string; transcript?: string; transcriptionModel?: string | null } = {}
): Promise<void> {
  const db = await getRawDatabase();
  const setClauses = ["status = ?", "updated_at = ?"];
  const params: (string | number | null)[] = [status, nowUnix()];

  if (fields.content !== undefined) {
    setClauses.push("content = ?");
    params.push(fields.content);
  }
  if (fields.transcript !== undefined) {
    setClauses.push("transcript = ?");
    params.push(fields.transcript);
  }
  if (fields.transcriptionModel !== undefined) {
    setClauses.push("transcription_model = ?");
    params.push(fields.transcriptionModel);
  }
  params.push(id);

  await db.execute(`UPDATE notes SET ${setClauses.join(", ")} WHERE id = ?`, params);
}

/**
 * note_embeddings has no explicit primary key (see db/schema.ts), so it
 * relies on sqlite-vec's implicit integer rowid rather than the note's own
 * TEXT id — looking it back up rather than trusting `insertId` keeps this
 * correct even if another statement runs on the connection in between.
 * sqlite-vec accepts a JSON-text array for the vector column.
 */
/**
 * Best-effort embedding attempt for an already-saved note: on success,
 * inserts the vector and flips status to `embedded`; on any failure (no
 * network to auto-download the embedding model, model download itself
 * failing, etc.) leaves the note at `transcribed` and returns false rather
 * than throwing — a voice note must never be lost just because the device
 * was offline when it was recorded. `notes` and `notes_fts` already have
 * the row either way; only the vector index is deferred.
 */
async function tryEmbedNote(id: string, text: string): Promise<boolean> {
  try {
    const embedding = await generateEmbeddingLocal(text);
    await insertEmbedding(id, embedding);
    await updateNoteStatus(id, "embedded");
    return true;
  } catch (err) {
    console.warn(
      "[Note] Embedding unavailable (offline or model not downloaded) — note saved without a " +
        "vector index; it will be indexed automatically next time the app is online.",
      id,
      err
    );
    return false;
  }
}

async function insertEmbedding(noteId: string, embedding: number[]): Promise<void> {
  const db = await getRawDatabase();

  const rowidResult = await db.execute("SELECT rowid FROM notes WHERE id = ?", [noteId]);
  const rowid = rowidResult.rows[0]?.rowid;
  if (rowid == null) {
    throw new Error("Failed to look up the inserted note's rowid.");
  }

  await db.execute(
    "INSERT INTO note_embeddings (rowid, embedding) VALUES (?, ?)",
    [rowid, JSON.stringify(embedding)]
  );
}

/** Embeds and persists a recorded voice note — updating `status` at each
 * step of the pipeline so stalled/failed notes are visible. Transcription
 * itself happens upstream via `services/ai/asrRouter.ts` (Tier 1 native /
 * Tier 2 Whisper) — the caller passes the resolved transcript in rather than
 * this function calling Whisper directly, since the router may have already
 * produced it live during recording via the native tier. */
export async function createVoiceNote(
  audioUri: string,
  transcript: string,
  transcriptionModel: string | null = null
): Promise<Note> {
  if (typeof FileSystem.getInfoAsync !== "function") {
    throw new Error(
      "expo-file-system/legacy: getInfoAsync is not available on this build."
    );
  }

  const info = await FileSystem.getInfoAsync(audioUri);
  if (!info.exists || info.size <= MIN_AUDIO_BYTES) {
    // Guards against persisting a ~0-second recording.
    throw new EmptyRecordingError();
  }

  const id = Crypto.randomUUID();
  const createdAt = nowUnix();
  const db = await getRawDatabase();

  // The audio file is already on disk (written by the recorder before this
  // is called) — insert a `pending` row right away so the note is visible
  // while transcription/embedding are still in flight.
  await db.execute(
    "INSERT INTO notes (id, content, audio_uri, transcript, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, "", audioUri, null, "pending", createdAt]
  );

  try {
    if (isSilentTranscript(transcript)) {
      throw new SilentRecordingError();
    }
    await updateNoteStatus(id, "transcribed", { content: transcript, transcript, transcriptionModel });

    const embedded = await tryEmbedNote(id, transcript);

    console.log("[Note] voice note saved", id, embedded ? "status=embedded" : "status=transcribed (offline)");
    return {
      id,
      content: transcript,
      audioUri,
      transcript,
      status: embedded ? "embedded" : "transcribed",
      transcriptionModel,
      createdAt,
    };
  } catch (err) {
    // Only reaches here for genuine failures (silent recording, DB errors) —
    // embedding failures are handled inside tryEmbedNote and never surface
    // as a failed note.
    console.error("[Note] voice note failed", id, err);
    await updateNoteStatus(id, "failed").catch(() => {});
    throw err;
  }
}

/** Embeds a plain-text note and persists it. */
export async function createTextNote(text: string): Promise<Note> {
  const id = Crypto.randomUUID();
  const createdAt = nowUnix();
  const db = await getRawDatabase();

  await db.execute(
    "INSERT INTO notes (id, content, audio_uri, transcript, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [id, text, null, null, "transcribed", createdAt]
  );

  const embedded = await tryEmbedNote(id, text);
  console.log("[Note] text note saved", id, embedded ? "status=embedded" : "status=transcribed (offline)");

  return {
    id,
    content: text,
    audioUri: null,
    transcript: null,
    status: embedded ? "embedded" : "transcribed",
    transcriptionModel: null,
    createdAt,
  };
}

/**
 * Deletes a note and every dependent row atomically: the `notes` row, its
 * `note_embeddings` vector, and its `notes_fts` index entry (the latter is
 * also handled by the `notes_fts_ad` trigger on `notes` — this delete is a
 * harmless no-op if the trigger already ran). The on-disk audio file is
 * removed only after the transaction commits, since there's no way to
 * "roll back" a deleted file if the transaction were to fail afterward.
 */
export async function deleteNote(noteId: string): Promise<void> {
  const db = await getRawDatabase();
  const ftsAvailable = await isFtsAvailable();
  let audioUri: string | null = null;

  await db.transaction(async (tx) => {
    const lookup = await tx.execute(
      "SELECT rowid, audio_uri FROM notes WHERE id = ?",
      [noteId]
    );
    const row = lookup.rows[0];
    if (!row) {
      return;
    }

    const rowid = row.rowid;
    audioUri = (row.audio_uri as string | null) ?? null;

    await tx.execute("DELETE FROM notes WHERE id = ?", [noteId]);
    await tx.execute("DELETE FROM note_embeddings WHERE rowid = ?", [rowid]);
    // Skipped when the build has no FTS5 module — notes_fts was never
    // created in that case (see db/client.ts's createFtsIndex).
    if (ftsAvailable) {
      await tx.execute("DELETE FROM notes_fts WHERE rowid = ?", [rowid]);
    }
  });

  if (audioUri && typeof FileSystem.deleteAsync === "function") {
    await FileSystem.deleteAsync(audioUri, { idempotent: true });
  }
}

/** A note as read out of a downloaded Google Drive backup database — see
 * driveSync.ts's `restoreFromDrive()`, which opens that backup as a second,
 * read-only op-sqlite connection and extracts rows in this shape before
 * handing them here. Deliberately excludes `audioUri`: backups only ever
 * contain the notes database, never the audio files themselves (see
 * `backupToDrive`), so a cloud note's original audio path is meaningless on
 * whatever device is restoring it. */
export type CloudNoteRecord = {
  id: string;
  content: string;
  transcript: string | null;
  transcriptionModel: string | null;
  createdAt: number;
};

/**
 * Delta/merge restore: inserts only the cloud notes this device doesn't
 * already have (matched by `id`), never overwriting or duplicating a note
 * that already exists locally — the local `notes` table is the source of
 * truth for anything already here. Newly-inserted notes land at `transcribed`
 * (not `content`'s original cloud `status`) and with no vector row yet, so
 * they're immediately visible in the Notes tab but intentionally excluded
 * from `hybridSearchNotes()`'s "WHERE status = 'embedded'" results until the
 * fire-and-forget embedding pass below (or the next `retryPendingEmbeddings`
 * call) catches up — the same "saved but not yet searchable" state every
 * other note passes through while offline. Returns the number of notes
 * actually restored.
 */
export async function mergeMissingNotes(cloudNotes: CloudNoteRecord[]): Promise<number> {
  const db = await getRawDatabase();

  const localIdsResult = await db.execute("SELECT id FROM notes");
  const localIds = new Set(localIdsResult.rows.map((row) => row.id as string));
  const missingNotes = cloudNotes.filter((note) => !localIds.has(note.id));
  if (missingNotes.length === 0) {
    return 0;
  }

  const insertedAt = nowUnix();
  await db.transaction(async (tx) => {
    for (const note of missingNotes) {
      // `audio_uri` is deliberately NULL (see CloudNoteRecord above) and
      // `INSERT OR IGNORE` is belt-and-suspenders against the id already
      // existing — the id filter above already guarantees that in the
      // common case, but guards against a note being created locally in the
      // moment between that filter and this transaction committing.
      await tx.execute(
        `INSERT OR IGNORE INTO notes (id, content, audio_uri, transcript, status, transcription_model, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'transcribed', ?, ?, ?)`,
        [note.id, note.content, note.transcript, note.transcriptionModel, note.createdAt, insertedAt]
      );
    }
  });

  // Not awaited: embedding every restored note can take a while (a large
  // backup could mean dozens of notes), and the restore itself should
  // resolve as soon as the notes are safely on disk — `retryPendingEmbeddings`
  // would catch any of these up anyway on the next app focus if this doesn't
  // finish first (e.g. the app is backgrounded mid-restore).
  void (async () => {
    let embedded = 0;
    for (const note of missingNotes) {
      const text = (note.content || note.transcript || "").trim();
      if (!text) {
        continue;
      }
      if (await tryEmbedNote(note.id, text)) {
        embedded += 1;
      }
    }
    console.log(`[Note] Restore embedding pass complete: ${embedded}/${missingNotes.length} notes indexed.`);
  })();

  return missingNotes.length;
}

/**
 * Best-effort reconciliation pass for notes saved while the embedding
 * model wasn't available (offline first-run skip, or the model download
 * itself failed) — attempts to embed every note still sitting at
 * `transcribed`. Checks `isEmbeddingModelDownloaded()` up front and returns
 * immediately if it's not there yet, so this is a cheap, instant no-op when
 * still offline rather than repeatedly attempting (and failing) a network
 * download every time it's called. Returns how many notes were newly
 * embedded, so callers can decide whether to refresh their note list.
 */
export async function retryPendingEmbeddings(): Promise<number> {
  if (!(await isEmbeddingModelDownloaded())) {
    return 0;
  }

  const db = await getRawDatabase();
  const result = await db.execute("SELECT id, content, transcript FROM notes WHERE status = 'transcribed'");

  let succeeded = 0;
  for (const row of result.rows) {
    const text = ((row.content as string) || (row.transcript as string) || "").trim();
    if (!text) {
      continue;
    }
    if (await tryEmbedNote(row.id as string, text)) {
      succeeded += 1;
    }
  }
  return succeeded;
}

/**
 * Lists every note that isn't `failed`, newest first. Used by the Notes
 * tab's default (non-search) view.
 */
export async function listNotes(): Promise<Note[]> {
  const db = await getRawDatabase();

  const result = await db.execute(
    `
      SELECT id, content, audio_uri, transcript, status, transcription_model, created_at
      FROM notes
      WHERE status != 'failed'
      ORDER BY created_at DESC
    `
  );

  return result.rows.map((row) => ({
    id: row.id as string,
    content: row.content as string,
    audioUri: (row.audio_uri as string | null) ?? null,
    transcript: (row.transcript as string | null) ?? null,
    status: row.status as NoteStatus,
    transcriptionModel: (row.transcription_model as string | null) ?? null,
    createdAt: row.created_at as number,
  }));
}

/** Fetches a single note by id, or `null` if it doesn't exist (e.g. deleted
 * out from under a stale reference like a chat citation). */
export async function getNoteById(id: string): Promise<Note | null> {
  const db = await getRawDatabase();

  const result = await db.execute(
    "SELECT id, content, audio_uri, transcript, status, transcription_model, created_at FROM notes WHERE id = ?",
    [id]
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  return {
    id: row.id as string,
    content: row.content as string,
    audioUri: (row.audio_uri as string | null) ?? null,
    transcript: (row.transcript as string | null) ?? null,
    status: row.status as NoteStatus,
    transcriptionModel: (row.transcription_model as string | null) ?? null,
    createdAt: row.created_at as number,
  };
}

/**
 * Developer utility: wipes every note, embedding, and FTS row. Used to
 * clear out stale/junk notes (e.g. silence-transcription noise recorded
 * before the guard in `createVoiceNote` existed) during testing.
 * Irreversible — also deletes every note's on-disk audio file.
 */
export async function purgeAllNotes(): Promise<void> {
  const db = await getRawDatabase();
  const ftsAvailable = await isFtsAvailable();

  const audioResult = await db.execute("SELECT audio_uri FROM notes WHERE audio_uri IS NOT NULL");
  const audioUris = audioResult.rows.map((row) => row.audio_uri as string);

  await db.transaction(async (tx) => {
    await tx.execute("DELETE FROM notes");
    await tx.execute("DELETE FROM note_embeddings");
    if (ftsAvailable) {
      await tx.execute("DELETE FROM notes_fts");
    }
  });

  if (typeof FileSystem.deleteAsync === "function") {
    await Promise.all(
      audioUris.map((uri) => FileSystem.deleteAsync(uri, { idempotent: true }))
    );
  }
}


export type HybridSearchResult = Pick<
  Note,
  "id" | "content" | "transcript" | "audioUri" | "transcriptionModel" | "createdAt"
> & {
  score: number;
};

/** Reciprocal rank fusion constant — standard default (see the original RRF paper). */
const RRF_K = 60;

/**
 * Whisper hallucinates this exact phrase (and close variants) on
 * silence/near-silence audio. A `pending`/`transcribed`-but-not-yet-`failed`
 * row with this content isn't useful grounding for anything and otherwise
 * keeps winning FTS/vector matches by sheer genericness.
 */
const NOISE_TRANSCRIPTS = ["thank you.", "thank you", "thanks for watching."];

function isUsableNoteRow(row: { content?: unknown; transcript?: unknown }): boolean {
  const text = ((row.content as string) || (row.transcript as string) || "").trim();
  if (!text) {
    return false;
  }
  return !NOISE_TRANSCRIPTS.includes(text.toLowerCase());
}

/**
 * Wraps free-form user text as an FTS5 query that can't throw a syntax
 * error: each token is quoted as a literal (escaping embedded quotes) and
 * OR'd together, so operators/punctuation in the input (AND, -, *, ") are
 * treated as plain text instead of FTS5 query syntax.
 */
function toFtsQuery(text: string): string {
  const terms = text
    .split(/\s+/)
    .map((term) => term.replace(/"/g, '""').trim())
    .filter(Boolean);
  if (terms.length === 0) {
    return '""';
  }
  return terms.map((term) => `"${term}"`).join(" OR ");
}

/**
 * Combines vector similarity (sqlite-vec) and keyword search (FTS5) via
 * reciprocal rank fusion, so a query that's a strong keyword match but a
 * weak semantic match (or vice versa) still surfaces. Falls back to
 * vector-only ranking when the build has no FTS5 module.
 */
export async function hybridSearchNotes(
  query: string,
  limit = 10
): Promise<HybridSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  const db = await getRawDatabase();
  const poolSize = limit * 4;

  const embedding = await generateEmbeddingLocal(trimmed);

  const searchStart = nowMs();
  const vectorResult = await db.execute(
    `
      SELECT n.id, n.content, n.transcript, n.audio_uri, n.transcription_model, n.created_at
      FROM note_embeddings e
      JOIN notes n ON n.rowid = e.rowid
      WHERE n.status = 'embedded'
      ORDER BY vec_distance_cosine(e.embedding, ?) ASC
      LIMIT ?
    `,
    [JSON.stringify(embedding), poolSize]
  );

  let ftsRows: typeof vectorResult.rows = [];
  if (await isFtsAvailable()) {
    const ftsResult = await db.execute(
      `
        SELECT notes.id, notes.content, notes.transcript, notes.audio_uri, notes.transcription_model, notes.created_at
        FROM notes_fts
        JOIN notes ON notes.rowid = notes_fts.rowid
        WHERE notes_fts MATCH ? AND notes.status = 'embedded'
        ORDER BY bm25(notes_fts) ASC
        LIMIT ?
      `,
      [toFtsQuery(trimmed), poolSize]
    );
    ftsRows = ftsResult.rows;
  }
  logDuration("SQLite-vec + FTS5 search retrieval", searchStart);

  const fused = new Map<
    string,
    {
      note: Pick<Note, "id" | "content" | "transcript" | "audioUri" | "transcriptionModel" | "createdAt">;
      score: number;
    }
  >();

  const addRanked = (rows: typeof vectorResult.rows) => {
    rows.forEach((row, rank) => {
      if (!isUsableNoteRow(row)) {
        return;
      }
      const id = row.id as string;
      const contribution = 1 / (RRF_K + rank + 1);
      const existing = fused.get(id);
      if (existing) {
        existing.score += contribution;
      } else {
        fused.set(id, {
          note: {
            id,
            content: row.content as string,
            transcript: (row.transcript as string | null) ?? null,
            audioUri: (row.audio_uri as string | null) ?? null,
            transcriptionModel: (row.transcription_model as string | null) ?? null,
            createdAt: row.created_at as number,
          },
          score: contribution,
        });
      }
    });
  };

  addRanked(vectorResult.rows);
  addRanked(ftsRows);

  return Array.from(fused.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ note, score }) => ({ ...note, score }));
}
