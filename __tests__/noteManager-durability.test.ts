/**
 * Phase 1 P0-2 and P0-3 (qa/05-consolidated-triage.md), plus a regression
 * lock on the already-confirmed-self-healing P1 embedding gap.
 */
import { createFakeNotesDb } from "./support/fakeNotesDb";

// Must be prefixed "mock" — Jest's out-of-scope-variable check for
// jest.mock() factories only allows names starting with "mock".
const mockDbState = createFakeNotesDb();

jest.mock("../db/client", () => ({
  getRawDatabase: jest.fn(() => Promise.resolve(mockDbState.db)),
  isFtsAvailable: jest.fn(() => Promise.resolve(false)),
}));
jest.mock("../services/ai/embeddingModel", () => ({
  isEmbeddingModelDownloaded: jest.fn(() => Promise.resolve(true)),
}));
jest.mock("../services/ai/localEmbeddings", () => ({
  generateEmbeddingLocal: jest.fn(() => Promise.resolve([0.1, 0.2, 0.3])),
}));
jest.mock("../services/ai/perf", () => ({
  logDuration: jest.fn(),
  nowMs: jest.fn(() => 0),
}));
jest.mock("../services/ai/pipelineStage", () => ({
  setPipelineStage: jest.fn(),
}));
jest.mock("../services/ai/transformationEngine", () => ({
  extractToDosFromText: jest.fn(() => Promise.resolve([])),
}));
jest.mock("../services/todos/todoManager", () => ({
  addToDo: jest.fn((input: Record<string, unknown>) => Promise.resolve({ id: "fake-todo-id", ...input })),
}));
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true, size: 999999 })),
  deleteAsync: jest.fn(() => Promise.resolve()),
}));
let mockNextId = 0;
jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => `fake-id-${++mockNextId}`),
}));

describe("noteManager Phase 1 durability fixes", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockDbState.reset();
    mockNextId = 0;
  });

  describe("createVoiceNote (P0-3: stuck pending note)", () => {
    it("leaves no row at all if the transcribed-status update fails mid-transaction", async () => {
      // Force the SECOND statement inside the transaction (the
      // "transcribed" update) to fail — simulating a kill/error in exactly
      // the window the old two-statement design left unrecoverable.
      mockDbState.failNthExecute(2, "simulated interruption mid-transaction");

      const { createVoiceNote } = require("../services/notes/noteManager");

      await expect(createVoiceNote("file:///fake.wav", "a real transcript, not silence")).rejects.toThrow(
        "simulated interruption mid-transaction"
      );
      // Before the fix, this would be 1 (a permanently stuck `pending` row).
      expect(mockDbState.getRows()).toHaveLength(0);
    });

    it("saves a normal voice note successfully end to end", async () => {
      const { createVoiceNote } = require("../services/notes/noteManager");

      const note = await createVoiceNote("file:///fake.wav", "buy milk and eggs");

      expect(note.status).toBe("embedded");
      expect(mockDbState.getRows()).toHaveLength(1);
      expect(mockDbState.getRows()[0].status).toBe("embedded");
      expect(mockDbState.getRows()[0].content).toBe("buy milk and eggs");
    });

    it("never creates a row at all for a silent recording", async () => {
      const { createVoiceNote, SilentRecordingError } = require("../services/notes/noteManager");

      await expect(createVoiceNote("file:///fake.wav", "")).rejects.toBeInstanceOf(SilentRecordingError);
      expect(mockDbState.getRows()).toHaveLength(0);
    });
  });

  describe("insertEmbedding idempotency (P1, already self-healing — locked in against regression)", () => {
    it("produces exactly one embedding row per note even when embedded twice", async () => {
      const { createTextNote } = require("../services/notes/noteManager");
      const { getRawDatabase } = require("../db/client");

      const note = await createTextNote("call the dentist tomorrow");
      const db = await getRawDatabase();
      const rowidResult = await db.execute("SELECT rowid FROM notes WHERE id = ?", [note.id]);
      const rowid = rowidResult.rows[0].rowid;

      // Simulate retryPendingEmbeddings() racing another embedding pass for
      // the same note — a second INSERT OR REPLACE for the same rowid.
      await db.execute("INSERT OR REPLACE INTO note_embeddings (rowid, embedding) VALUES (?, ?)", [
        rowid,
        JSON.stringify([9, 9, 9]),
      ]);

      const matching = mockDbState.getEmbeddings().filter((e) => e.rowid === rowid);
      expect(matching).toHaveLength(1);
      expect(JSON.parse(matching[0].embedding as string)).toEqual([9, 9, 9]);
    });
  });

  describe("retryPendingExtractions (P0-2: extraction durability)", () => {
    it("recovers a note whose extraction died mid-flight, past the grace window", async () => {
      const { createTextNote, retryPendingExtractions } = require("../services/notes/noteManager");
      const { extractToDosFromText } = require("../services/ai/transformationEngine");
      const { addToDo } = require("../services/todos/todoManager");
      const { getRawDatabase } = require("../db/client");

      const note = await createTextNote("remember to call Papa tomorrow at 6pm");
      // The real scheduleToDoExtraction() call already ran and cleared the
      // marker (extractToDosFromText resolves to [] by default) — simulate
      // a kill mid-extraction by manually setting it back to a timestamp
      // well before the grace cutoff.
      const db = await getRawDatabase();
      await db.execute("UPDATE notes SET extraction_pending_since = ? WHERE id = ?", [0, note.id]);

      extractToDosFromText.mockResolvedValueOnce([
        {
          task: "Call Papa",
          actionDate: "2026-09-16",
          toDate: null,
          notificationTime: "18:00",
          recurrence: "none",
          recurrenceInterval: 1,
        },
      ]);

      const rescheduled = await retryPendingExtractions();
      // Allow the re-scheduled (fire-and-forget) extraction to actually run.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(rescheduled).toBe(1);
      expect(addToDo).toHaveBeenCalledWith(expect.objectContaining({ text: "Call Papa", noteId: note.id }));

      const row = mockDbState.getRows().find((r) => r.id === note.id);
      expect(row?.extraction_pending_since).toBeNull();
    });

    it("does not touch a note whose extraction is still genuinely in progress", async () => {
      const { createTextNote, retryPendingExtractions } = require("../services/notes/noteManager");
      const { extractToDosFromText } = require("../services/ai/transformationEngine");

      let resolveExtraction: (value: unknown[]) => void = () => {};
      extractToDosFromText.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveExtraction = resolve;
          })
      );

      const note = await createTextNote("a note whose extraction is slow");

      const rescheduled = await retryPendingExtractions();
      expect(rescheduled).toBe(0);

      const row = mockDbState.getRows().find((r) => r.id === note.id);
      expect(row?.extraction_pending_since).not.toBeNull();

      resolveExtraction([]);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
