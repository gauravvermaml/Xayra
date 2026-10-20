/**
 * The merge that builds each new encrypted backup generation
 * (services/backup/backupDb.ts mergeLocalIntoBase): local notes and to-dos are
 * merged INTO the downloaded base generation — insert-only, a strictly newer
 * local edit replaces the backed-up text, nothing is ever removed — then the
 * result is sealed into a new file. Ported from the legacy delta-backup tests
 * (2026-09-16 data-loss fix), which these guarantees came from.
 */
// The live vault: only its to-do edit timestamps are read here.
const mockLocalStamps: { id: string; updated_at: number | null }[] = [];
jest.mock("../db/client", () => ({
  getRawDatabase: async () => ({ execute: async () => ({ rows: mockLocalStamps.map((r) => ({ ...r })) }) }),
}));
jest.mock("../services/vault/vaultIdentity", () => ({ getSessionVaultKey: () => "a".repeat(64) }));
jest.mock("../services/crypto/keyManager", () => ({ isWellFormedDatabaseKey: (k: string) => /^[0-9a-f]{64}$/.test(k) }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "run" }));
jest.mock("expo-file-system/legacy", () => ({ documentDirectory: "file:///data/app/files/" }));

const mockListNotes = jest.fn();
const mockListNoteRevisions = jest.fn(() => Promise.resolve([] as unknown[]));
jest.mock("../services/notes/noteManager", () => ({
  listNotes: () => mockListNotes(),
  listNoteRevisions: () => mockListNoteRevisions(),
}));
const mockListAllToDos = jest.fn(() => Promise.resolve([] as unknown[]));
jest.mock("../services/todos/todoManager", () => ({ listAllToDos: () => mockListAllToDos() }));

type Note = { id: string; content?: string; transcript?: string | null; created_at?: number; updated_at?: number };
type Todo = { id: string; text?: string; action_date?: string; to_date?: string | null; notification_time?: string; is_completed?: number; recurrence?: string; recurrence_interval?: number; note_id?: string | null; updated_at?: number | null };
function fakeBase(seed: Note[], todoSeed: (string | Todo)[] = []) {
  const notes: Note[] = seed.map((n) => ({ ...n }));
  const todos: Todo[] = todoSeed.map((t) => (typeof t === "string" ? { id: t } : { ...t }));
  const statements: string[] = [];
  const execute = jest.fn(async (query: string, params: unknown[] = []) => {
    const q = query.trim();
    statements.push(q);
    if (/^SELECT id FROM notes/i.test(q)) return { rows: notes.map((n) => ({ id: n.id })) };
    if (/^SELECT id, content, transcript, updated_at FROM notes/i.test(q)) return { rows: notes.map((n) => ({ ...n })) };
    if (/^UPDATE notes SET content = \?, transcript = \?, updated_at = \? WHERE id = \?/i.test(q)) {
      const [content, transcript, updated_at, id] = params as [string, string | null, number, string];
      Object.assign(notes.find((n) => n.id === id)!, { content, transcript, updated_at });
      return { rows: [] };
    }
    if (/^SELECT id FROM todos/i.test(q)) return { rows: todos.map((t) => ({ id: t.id })) };
    if (/^SELECT id, text, action_date/i.test(q)) return { rows: todos.map((t) => ({ ...t })) };
    if (/^UPDATE todos SET/i.test(q)) {
      const [text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, note_id, updated_at, id] = params as [string, string, string | null, string, number, string, number, string | null, number | null, string];
      Object.assign(todos.find((t) => t.id === id)!, { text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, note_id, updated_at });
      return { rows: [] };
    }
    if (/^PRAGMA main\.table_info\(todos\)/i.test(q)) return { rows: [{ name: "id" }, { name: "updated_at" }] };
    if (/^INSERT OR IGNORE INTO notes/i.test(q)) {
      notes.push({ id: params[0] as string });
      return { rows: [] };
    }
    if (/^INSERT OR IGNORE INTO todos/i.test(q)) {
      todos.push({ id: params[0] as string });
      return { rows: [] };
    }
    if (/^(VACUUM INTO|ATTACH DATABASE|SELECT sqlcipher_export|DETACH DATABASE)/i.test(q)) return { rows: [] };
    throw new Error(`fake base: unhandled ${q}`);
  });
  return {
    execute,
    transaction: jest.fn(async (fn: (tx: { execute: typeof execute }) => Promise<void>) => fn({ execute })),
    close: jest.fn(),
    noteIds: () => notes.map((n) => n.id),
    note: (id: string) => notes.find((n) => n.id === id),
    todoIds: () => todos.map((t) => t.id),
    todo: (id: string) => todos.find((t) => t.id === id),
    statements,
  };
}

const mockOpen = jest.fn();
jest.mock("@op-engineering/op-sqlite", () => ({ open: (...args: unknown[]) => mockOpen(...args) }));

import { mergeLocalIntoBase } from "../services/backup/backupDb";

const KEY = `x'${"b".repeat(64)}'`;
const OTHER_KEY = `x'${"c".repeat(64)}'`;
const localNote = (id: string) => ({ id, content: `synthetic ${id}`, transcript: null, transcriptionModel: null, createdAt: 1 });

beforeEach(() => {
  jest.clearAllMocks();
  mockLocalStamps.length = 0;
  mockListNoteRevisions.mockResolvedValue([]);
  mockListAllToDos.mockResolvedValue([]);
});

it("15 backed-up notes + 2 new local ones: only the 2 are added, becoming 17", async () => {
  const base = fakeBase(Array.from({ length: 15 }, (_, i) => ({ id: `r${i}` })));
  mockOpen.mockReturnValue(base);
  mockListNotes.mockResolvedValue([localNote("r0"), localNote("new1"), localNote("new2")]);
  const counts = await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY);
  expect(counts).toEqual({ addedNotes: 2, updatedNotes: 0, addedTodos: 0, updatedTodos: 0 });
  expect(base.noteIds()).toHaveLength(17);
});

it("0 local notes: the backup keeps every note — nothing is removed or overwritten", async () => {
  const base = fakeBase([{ id: "r1" }, { id: "r2" }], ["t1"]);
  mockOpen.mockReturnValue(base);
  mockListNotes.mockResolvedValue([]);
  const counts = await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY);
  expect(counts).toEqual({ addedNotes: 0, updatedNotes: 0, addedTodos: 0, updatedTodos: 0 });
  expect(base.noteIds()).toEqual(["r1", "r2"]);
  expect(base.todoIds()).toEqual(["t1"]);
  expect(base.statements.some((q) => /^(DELETE|DROP)/i.test(q))).toBe(false);
});

describe("edits", () => {
  const BACKED_UP = { id: "n1", content: "Synthetic note with a typo, recieve.", transcript: null, created_at: 1_000, updated_at: 2_000 };
  beforeEach(() => mockListNotes.mockResolvedValue([localNote("n1")]));

  it("a newer local edit replaces the backed-up text in place (same id, created_at kept)", async () => {
    const base = fakeBase([BACKED_UP]);
    mockOpen.mockReturnValue(base);
    mockListNoteRevisions.mockResolvedValue([{ id: "n1", content: "Synthetic note with a typo, receive.", transcript: null, updatedAt: 5_000 }]);
    const counts = await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY);
    expect(counts.updatedNotes).toBe(1);
    expect(base.note("n1")).toMatchObject({ content: "Synthetic note with a typo, receive.", created_at: 1_000, updated_at: 5_000 });
    expect(base.noteIds()).toEqual(["n1"]);
  });

  it("an OLDER local copy never overwrites a later edit already in the backup", async () => {
    const base = fakeBase([{ ...BACKED_UP, content: "Newest wording from another device.", updated_at: 9_000 }]);
    mockOpen.mockReturnValue(base);
    mockListNoteRevisions.mockResolvedValue([{ id: "n1", content: "Older wording.", transcript: null, updatedAt: 5_000 }]);
    expect((await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY)).updatedNotes).toBe(0);
    expect(base.note("n1")).toMatchObject({ content: "Newest wording from another device." });
  });

  it("a newer timestamp with identical text writes nothing", async () => {
    const base = fakeBase([BACKED_UP]);
    mockOpen.mockReturnValue(base);
    mockListNoteRevisions.mockResolvedValue([{ id: "n1", content: BACKED_UP.content, transcript: null, updatedAt: 9_000 }]);
    await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY);
    expect(base.statements.some((q) => /^UPDATE notes/i.test(q))).toBe(false);
  });
});

it("a to-do completed on this phone is carried into the backup; a deleted one is never removed", async () => {
  const backed = { id: "t1", text: "Synthetic task", action_date: "2026-10-15", to_date: null, notification_time: "09:00", is_completed: 0, recurrence: "none", recurrence_interval: 1, note_id: null };
  const base = fakeBase([], [backed, { ...backed, id: "t2" }]);
  mockOpen.mockReturnValue(base);
  mockListNotes.mockResolvedValue([]);
  mockListAllToDos.mockResolvedValue([
    { id: "t1", text: "Synthetic task", actionDate: "2026-10-15", toDate: null, notificationTime: "09:00", isCompleted: true, recurrence: "none", recurrenceInterval: 1, createdAt: "x", noteId: null },
  ]);
  const counts = await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY);
  expect(counts.updatedTodos).toBe(1);
  expect(base.todo("t1")).toMatchObject({ is_completed: 1 });
  expect(base.todoIds()).toEqual(["t1", "t2"]);
});

describe("to-dos changed on more than one phone", () => {
  const backed = { id: "t1", text: "Synthetic task", action_date: "2026-10-15", to_date: null, notification_time: "09:00", is_completed: 1, recurrence: "none", recurrence_interval: 1, note_id: null };
  const local = { id: "t1", text: "Synthetic task", actionDate: "2026-10-15", toDate: null, notificationTime: "09:00", isCompleted: false, recurrence: "none", recurrenceInterval: 1, createdAt: "x", noteId: null };
  beforeEach(() => {
    mockListNotes.mockResolvedValue([]);
    mockListAllToDos.mockResolvedValue([local]);
  });

  it("a phone holding an OLDER copy never overwrites another phone's later change", async () => {
    const base = fakeBase([], [{ ...backed, updated_at: 9_000 }]); // completed elsewhere at 9000
    mockOpen.mockReturnValue(base);
    mockLocalStamps.push({ id: "t1", updated_at: null }); // never changed on this phone
    expect((await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY)).updatedTodos).toBe(0);
    expect(base.todo("t1")).toMatchObject({ is_completed: 1, updated_at: 9_000 });
  });

  it("a NEWER change on this phone replaces the backed-up copy, with its timestamp", async () => {
    const base = fakeBase([], [{ ...backed, updated_at: 9_000 }]);
    mockOpen.mockReturnValue(base);
    mockLocalStamps.push({ id: "t1", updated_at: 12_000 }); // re-opened here later
    expect((await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY)).updatedTodos).toBe(1);
    expect(base.todo("t1")).toMatchObject({ is_completed: 0, updated_at: 12_000 });
  });
});

it("seals with VACUUM INTO under the same key, or sqlcipher_export into the account's key", async () => {
  mockListNotes.mockResolvedValue([]);
  const same = fakeBase([]);
  mockOpen.mockReturnValue(same);
  await mergeLocalIntoBase("/stage", "base.db", KEY, "gen.db", KEY);
  expect(same.statements).toContain("VACUUM INTO ?");
  const changed = fakeBase([]);
  mockOpen.mockReturnValue(changed);
  await mergeLocalIntoBase("/stage", "base.db", OTHER_KEY, "gen.db", KEY);
  expect(changed.statements).toEqual(expect.arrayContaining(["ATTACH DATABASE ? AS gen KEY ?", "SELECT sqlcipher_export('gen')"]));
  expect(changed.statements).not.toContain("VACUUM INTO ?");
});
