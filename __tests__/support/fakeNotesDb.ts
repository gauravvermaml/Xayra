/**
 * Phase 1 QA test support: a small, purpose-built in-memory stand-in for the
 * `notes`/`note_embeddings` slice of the real op-sqlite database — NOT a
 * general SQL engine, just enough pattern-matching against the exact
 * statements `services/notes/noteManager.ts` issues to drive real
 * transaction/rollback semantics for the Phase 1 durability tests. See
 * qa/06-phase-execution-roadmap.md's Phase 1 test-infrastructure section.
 */

export type FakeRow = Record<string, unknown>;

export type FakeDb = {
  execute: (query: string, params?: unknown[]) => Promise<{ rows: FakeRow[] }>;
  transaction: (fn: (tx: { execute: FakeDb["execute"] }) => Promise<void>) => Promise<void>;
};

export function createFakeNotesDb() {
  let rows: FakeRow[] = [];
  let embeddings: FakeRow[] = [];
  let nextRowid = 1;
  let executeCallCounter = 0;
  let failAtCallNumber: number | null = null;
  let failMessage = "simulated failure";

  function findById(id: unknown): FakeRow | undefined {
    return rows.find((r) => r.id === id);
  }

  const execute: FakeDb["execute"] = async (query, params = []) => {
    executeCallCounter += 1;
    if (failAtCallNumber !== null && executeCallCounter === failAtCallNumber) {
      throw new Error(failMessage);
    }

    const q = query.trim();

    // createVoiceNote's atomic insert (literal NULL for audio_uri).
    if (/^INSERT INTO notes \(id, content, audio_uri, transcript, status, created_at\) VALUES \(\?, \?, NULL, \?, \?, \?\)/i.test(q)) {
      const [id, content, transcript, status, created_at] = params;
      rows.push({
        rowid: nextRowid++,
        id,
        content,
        audio_uri: null,
        transcript,
        status,
        created_at,
        updated_at: created_at,
        transcription_model: null,
        extraction_pending_since: null,
      });
      return { rows: [] };
    }

    // createTextNote's insert (every column as a placeholder).
    if (/^INSERT INTO notes \(id, content, audio_uri, transcript, status, created_at\) VALUES \(\?, \?, \?, \?, \?, \?\)/i.test(q)) {
      const [id, content, audio_uri, transcript, status, created_at] = params;
      rows.push({
        rowid: nextRowid++,
        id,
        content,
        audio_uri,
        transcript,
        status,
        created_at,
        updated_at: created_at,
        transcription_model: null,
        extraction_pending_since: null,
      });
      return { rows: [] };
    }

    // createVoiceNote's second statement (the atomic-transaction update).
    if (/^UPDATE notes SET status = \?, updated_at = \?, content = \?, transcript = \?, transcription_model = \? WHERE id = \?/i.test(q)) {
      const [status, updated_at, content, transcript, transcription_model, id] = params;
      const row = findById(id);
      if (row) Object.assign(row, { status, updated_at, content, transcript, transcription_model });
      return { rows: [] };
    }

    // markExtractionPending / clearExtractionPending.
    if (/^UPDATE notes SET extraction_pending_since = \? WHERE id = \?/i.test(q)) {
      const [value, id] = params;
      const row = findById(id);
      if (row) row.extraction_pending_since = value;
      return { rows: [] };
    }
    if (/^UPDATE notes SET extraction_pending_since = NULL WHERE id = \?/i.test(q)) {
      const [id] = params;
      const row = findById(id);
      if (row) row.extraction_pending_since = null;
      return { rows: [] };
    }

    // updateNoteStatus()'s dynamically-built SET clause (generic fallback —
    // must come after the more specific UPDATE patterns above).
    if (/^UPDATE notes SET (.+) WHERE id = \?$/i.test(q)) {
      const match = q.match(/^UPDATE notes SET (.+) WHERE id = \?$/i)!;
      const setColumns = match[1].split(",").map((clause) => clause.trim().split("=")[0].trim());
      const id = params[params.length - 1];
      const row = findById(id);
      if (row) {
        setColumns.forEach((col, i) => {
          row[col] = params[i];
        });
      }
      return { rows: [] };
    }

    if (/^SELECT rowid FROM notes WHERE id = \?/i.test(q)) {
      const [id] = params;
      const row = findById(id);
      return { rows: row ? [{ rowid: row.rowid }] : [] };
    }

    if (/^SELECT id, content, transcript FROM notes WHERE extraction_pending_since IS NOT NULL AND extraction_pending_since < \?/i.test(q)) {
      const [cutoff] = params;
      const matches = rows.filter(
        (r) => r.extraction_pending_since != null && (r.extraction_pending_since as number) < (cutoff as number)
      );
      return { rows: matches.map((r) => ({ id: r.id, content: r.content, transcript: r.transcript })) };
    }

    if (/^SELECT id FROM notes/i.test(q)) {
      return { rows: rows.map((r) => ({ id: r.id })) };
    }

    if (/^INSERT OR REPLACE INTO note_embeddings/i.test(q)) {
      const [rowid, embedding] = params;
      const existingIndex = embeddings.findIndex((e) => e.rowid === rowid);
      const record = { rowid, embedding };
      if (existingIndex >= 0) embeddings[existingIndex] = record;
      else embeddings.push(record);
      return { rows: [] };
    }

    throw new Error(`fakeNotesDb: unhandled query — add a pattern for it: ${q}`);
  };

  const transaction: FakeDb["transaction"] = async (fn) => {
    // Real rollback semantics: snapshot before, restore on any throw — this
    // is what makes the createVoiceNote atomicity test meaningful rather
    // than just calling execute() twice with no isolation.
    const rowsSnapshot = rows.map((r) => ({ ...r }));
    const embeddingsSnapshot = embeddings.map((e) => ({ ...e }));
    try {
      await fn({ execute });
    } catch (err) {
      rows = rowsSnapshot;
      embeddings = embeddingsSnapshot;
      throw err;
    }
  };

  return {
    db: { execute, transaction } as FakeDb,
    getRows: (): FakeRow[] => rows,
    getEmbeddings: (): FakeRow[] => embeddings,
    /** Makes the Nth-from-now call to `execute()` (top-level OR inside a
     * transaction's own `tx.execute()` — both share this same underlying
     * function, so this reaches into an open transaction too) throw once,
     * then resume normal behavior. Used to simulate a kill/error landing at
     * a specific statement, e.g. `failNthExecute(2)` fails the SECOND
     * statement inside createVoiceNote's transaction (the "transcribed"
     * update) while leaving the first (the "pending" insert) to succeed. */
    failNthExecute(n: number, message = "simulated failure"): void {
      failMessage = message;
      failAtCallNumber = executeCallCounter + n;
    },
    reset(): void {
      rows = [];
      embeddings = [];
      nextRowid = 1;
      executeCallCounter = 0;
      failAtCallNumber = null;
    },
  };
}
