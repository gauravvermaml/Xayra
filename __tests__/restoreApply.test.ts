/**
 * Restore's newer-wins update applied to the phone's database: notes
 * (applyNewerNotesFromBackup) and to-dos (applyNewerToDosFromBackup).
 * Synthetic records only.
 */
import { createFakeNotesDb, type FakeDb, type FakeRow } from "./support/fakeNotesDb";
import { versionsById, type NoteVersion, type ToDoVersion } from "../services/backup/restoreMerge";

const mockNotes = createFakeNotesDb();
let mockTodoRows: FakeRow[] = [];
/** Runs before a guarded re-read inside the update transaction — lets a test
 * change a row "on the phone" between the plan and the write. */
let mockBeforeReread: ((id: unknown) => void) | null = null;

const mockTodoDb: FakeDb = {
  execute: async (query: string, params: unknown[] = []) => {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT id, text, action_date")) return { rows: mockTodoRows.map((r) => ({ ...r })) };
    if (q === "SELECT updated_at FROM todos WHERE id = ?") {
      mockBeforeReread?.(params[0]);
      const row = mockTodoRows.find((r) => r.id === params[0]);
      return { rows: row ? [{ updated_at: row.updated_at }] : [] };
    }
    if (q.startsWith("UPDATE todos SET text = ?")) {
      const row = mockTodoRows.find((r) => r.id === params[9]);
      if (row) {
        Object.assign(row, {
          text: params[0],
          action_date: params[1],
          to_date: params[2],
          notification_time: params[3],
          is_completed: params[4],
          recurrence: params[5],
          recurrence_interval: params[6],
          note_id: params[7],
          updated_at: params[8],
        });
      }
      return { rows: [] };
    }
    throw new Error(`todo fake: unhandled ${q}`);
  },
  transaction: async (fn) => {
    const snapshot = mockTodoRows.map((r) => ({ ...r }));
    try {
      await fn({ execute: mockTodoDb.execute });
    } catch (err) {
      mockTodoRows = snapshot;
      throw err;
    }
  },
};

const mockNotesDbWithHook: FakeDb = {
  execute: async (query: string, params: unknown[] = []) => {
    if (/^SELECT rowid, updated_at FROM notes WHERE id = \?/.test(query.trim())) mockBeforeReread?.(params[0]);
    return mockNotes.db.execute(query, params);
  },
  transaction: (fn) => mockNotes.db.transaction(() => fn({ execute: (q, p) => mockNotesDbWithHook.execute(q, p) })),
};

let mockUseTodoDb = false;
jest.mock("../db/client", () => ({
  getRawDatabase: jest.fn(() => Promise.resolve(mockUseTodoDb ? mockTodoDb : mockNotesDbWithHook)),
  isFtsAvailable: jest.fn(() => Promise.resolve(false)),
}));
jest.mock("../services/ai/embeddingModel", () => ({ isEmbeddingModelDownloaded: jest.fn(() => Promise.resolve(true)) }));
let mockEmbedGate: Promise<void> = Promise.resolve();
jest.mock("../services/ai/localEmbeddings", () => ({
  generateEmbeddingLocal: async (text: string) => {
    await mockEmbedGate;
    return [text.length, 0.5];
  },
}));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0) }));
jest.mock("../services/ai/pipelineStage", () => ({ setPipelineStage: jest.fn() }));
jest.mock("../services/ai/transformationEngine", () => ({ extractToDosFromText: jest.fn(() => Promise.resolve([])) }));
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: jest.fn(), deleteAsync: jest.fn() }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "uuid") }));
const mockSchedule = jest.fn();
const mockCancel = jest.fn();
jest.mock("../services/notifications/todoNotifications", () => ({
  scheduleToDoNotification: (t: unknown) => mockSchedule(t),
  cancelToDoNotification: (id: unknown) => mockCancel(id),
}));
jest.mock("../services/sync/calendarSync", () => ({ createCalendarEvent: jest.fn(), deleteCalendarEvent: jest.fn(), updateCalendarEvent: jest.fn() }));

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function seedNote(id: string, content: string, updatedAt: number, rowid: number) {
  mockNotes.getRows().push({ id, content, transcript: null, status: "embedded", created_at: 50, updated_at: updatedAt, rowid });
  mockNotes.getEmbeddings().push({ rowid, embedding: JSON.stringify([content.length, 0.5]) });
}
const v = (id: string, content: string, updatedAt: number): NoteVersion => ({ id, content, transcript: null, updatedAt });

beforeEach(() => {
  mockNotes.reset();
  mockTodoRows = [];
  mockBeforeReread = null;
  mockUseTodoDb = false;
  mockEmbedGate = Promise.resolve();
  jest.clearAllMocks();
});

describe("notes", () => {
  it("replaces an older note in place (same id and created date), drops its old vector, then re-indexes it", async () => {
    const { applyNewerNotesFromBackup } = require("../services/notes/noteManager");
    seedNote("n1", "old wording", 100, 1);
    let release!: () => void;
    mockEmbedGate = new Promise<void>((r) => (release = r));

    const cloud = v("n1", "corrected wording", 200);
    const result = await applyNewerNotesFromBackup([cloud], versionsById([[v("n1", "old wording", 100)], [cloud]]));

    expect(result).toEqual({ updated: 1, conflicts: [] });
    // Before re-indexing: new text, not searchable, no vector of the old text left for Ask to find.
    expect(mockNotes.getRows()[0]).toMatchObject({ id: "n1", created_at: 50, content: "corrected wording", status: "transcribed", updated_at: 200 });
    expect(mockNotes.getEmbeddings()).toEqual([]);

    release();
    await flush();
    await flush();
    expect(mockNotes.getRows()[0].status).toBe("embedded");
    expect(JSON.parse(mockNotes.getEmbeddings()[0].embedding as string)[0]).toBe("corrected wording".length);
  });

  it("keeps a newer phone note, and a phone change that is in no backup", async () => {
    const { applyNewerNotesFromBackup } = require("../services/notes/noteManager");
    seedNote("newer", "phone edit", 300, 1);
    seedNote("unbacked", "phone edit, not backed up", 150, 2);
    const cloudNewer = v("newer", "older cloud", 200);
    const cloudUnbacked = v("unbacked", "cloud copy", 200);
    const result = await applyNewerNotesFromBackup([cloudNewer, cloudUnbacked], versionsById([[cloudNewer, cloudUnbacked]]));
    expect(result.updated).toBe(0);
    expect(result.conflicts).toEqual([{ id: "unbacked", reason: "phone-change-not-backed-up" }]);
    expect(mockNotes.getRows().map((r) => r.content)).toEqual(["phone edit", "phone edit, not backed up"]);
    expect(mockNotes.getEmbeddings()).toHaveLength(2);
  });

  it("an interrupted restore changes nothing; running it again completes, and a third run is a no-op", async () => {
    const { applyNewerNotesFromBackup } = require("../services/notes/noteManager");
    seedNote("n1", "a old", 100, 1);
    seedNote("n2", "b old", 100, 2);
    const cloud = [v("n1", "a new", 200), v("n2", "b new", 200)];
    const backedUp = versionsById([[v("n1", "a old", 100), v("n2", "b old", 100)], cloud]);

    // Fail the 5th statement: the listing, then n1's re-read/update/vector delete, then n2's re-read.
    mockNotes.failNthExecute(5, "process killed");
    await expect(applyNewerNotesFromBackup(cloud, backedUp)).rejects.toThrow("process killed");
    expect(mockNotes.getRows().map((r) => r.content)).toEqual(["a old", "b old"]);
    expect(mockNotes.getEmbeddings()).toHaveLength(2);

    expect((await applyNewerNotesFromBackup(cloud, backedUp)).updated).toBe(2);
    await flush();
    expect(mockNotes.getRows().map((r) => r.content)).toEqual(["a new", "b new"]);
    expect((await applyNewerNotesFromBackup(cloud, backedUp)).updated).toBe(0);
  });

  it("never creates a note: a backed-up note the phone doesn't have (e.g. deleted here) is not touched by the update", async () => {
    const { applyNewerNotesFromBackup } = require("../services/notes/noteManager");
    seedNote("kept", "kept", 100, 1);
    const cloud = v("deletedHere", "deleted on this phone", 200);
    expect(await applyNewerNotesFromBackup([cloud], versionsById([[cloud]]))).toEqual({ updated: 0, conflicts: [] });
    expect(mockNotes.getRows().map((r) => r.id)).toEqual(["kept"]);
  });

  it("a note edited on the phone while the restore runs is left alone", async () => {
    const { applyNewerNotesFromBackup } = require("../services/notes/noteManager");
    seedNote("n1", "old", 100, 1);
    mockBeforeReread = (id) => {
      const row = mockNotes.getRows().find((r) => r.id === id)!;
      Object.assign(row, { content: "edited just now", updated_at: 400 });
    };
    const cloud = v("n1", "cloud", 200);
    const result = await applyNewerNotesFromBackup([cloud], versionsById([[v("n1", "old", 100)], [cloud]]));
    expect(result.updated).toBe(0);
    expect(mockNotes.getRows()[0].content).toBe("edited just now");
  });
});

describe("to-dos", () => {
  const row = (id: string, text: string, updatedAt: number | null, extra: FakeRow = {}): FakeRow => ({
    id,
    text,
    action_date: "2026-11-02",
    to_date: null,
    notification_time: "09:00",
    is_completed: 0,
    recurrence: "none",
    recurrence_interval: 1,
    note_id: null,
    updated_at: updatedAt,
    created_at: "2026-10-01T00:00:00Z",
    google_calendar_event_id: "cal-1",
    ...extra,
  });
  const t = (id: string, text: string, updatedAt: number | null, extra: Partial<ToDoVersion> = {}): ToDoVersion => ({
    id,
    text,
    actionDate: "2026-11-02",
    toDate: null,
    notificationTime: "09:00",
    isCompleted: false,
    recurrence: "none",
    recurrenceInterval: 1,
    noteId: null,
    updatedAt,
    ...extra,
  });

  beforeEach(() => {
    mockUseTodoDb = true;
  });

  it("replaces the whole to-do with the newer version, keeps its Calendar link, and re-sets its reminder", async () => {
    const { applyNewerToDosFromBackup } = require("../services/todos/todoManager");
    mockTodoRows = [row("t1", "Water plants", 1_000, { recurrence: "weekly" })];
    const cloud = t("t1", "Water plants and herbs", 2_000, { recurrence: "daily", recurrenceInterval: 2, actionDate: "2026-11-05", notificationTime: "18:00" });
    const result = await applyNewerToDosFromBackup([cloud], versionsById([[t("t1", "Water plants", 1_000, { recurrence: "weekly" })], [cloud]]));
    expect(result).toEqual({ updated: 1, conflicts: [] });
    expect(mockTodoRows[0]).toMatchObject({
      text: "Water plants and herbs",
      action_date: "2026-11-05",
      notification_time: "18:00",
      recurrence: "daily",
      recurrence_interval: 2,
      updated_at: 2_000,
      google_calendar_event_id: "cal-1",
    });
    expect(mockSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: "t1", actionDate: "2026-11-05", notificationTime: "18:00", recurrence: "daily" }));
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("a to-do completed on another phone cancels its reminder here", async () => {
    const { applyNewerToDosFromBackup } = require("../services/todos/todoManager");
    mockTodoRows = [row("t1", "Call Mum", 1_000)];
    const cloud = t("t1", "Call Mum", 2_000, { isCompleted: true });
    await applyNewerToDosFromBackup([cloud], versionsById([[t("t1", "Call Mum", 1_000)], [cloud]]));
    expect(mockTodoRows[0].is_completed).toBe(1);
    expect(mockCancel).toHaveBeenCalledWith("t1");
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("older, untimed and same-time copies leave the phone's to-dos alone, and repeating is a no-op", async () => {
    const { applyNewerToDosFromBackup } = require("../services/todos/todoManager");
    mockTodoRows = [row("newer", "phone", 3_000), row("legacy", "phone", null), row("tie", "phone", 5)];
    const cloud = [t("newer", "cloud", 2_000), t("legacy", "cloud", null), t("tie", "cloud", 5)];
    const result = await applyNewerToDosFromBackup(cloud, versionsById([cloud]));
    expect(result.updated).toBe(0);
    expect(result.conflicts.map((c: { reason: string }) => c.reason).sort()).toEqual(["backup-has-no-time", "same-time-different-content"]);
    expect(mockTodoRows.map((r) => r.text)).toEqual(["phone", "phone", "phone"]);
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it("a to-do changed on the phone while the restore runs is left alone", async () => {
    const { applyNewerToDosFromBackup } = require("../services/todos/todoManager");
    mockTodoRows = [row("t1", "old", 1_000)];
    mockBeforeReread = (id) => Object.assign(mockTodoRows.find((r) => r.id === id)!, { text: "edited now", updated_at: 9_000 });
    const cloud = t("t1", "cloud", 2_000);
    expect((await applyNewerToDosFromBackup([cloud], versionsById([[t("t1", "old", 1_000)], [cloud]]))).updated).toBe(0);
    expect(mockTodoRows[0].text).toBe("edited now");
  });
});
