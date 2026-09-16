/**
 * Live data-loss incident + explicit user redesign request (2026-09-16):
 * `backupToDrive()` used to `VACUUM INTO` the LOCAL database and overwrite
 * Google Drive with it wholesale — a freshly-reinstalled app with 0 local
 * notes silently replaced a real, populated Drive backup with nothing. The
 * user asked for backup to be a TRUE delta, symmetric with how restore
 * already works: "if there are 2 new notes on device compared to the notes
 * that exist in Google Drive (15 notes), then only those notes must get
 * added... to make it 17" and "if there are zero notes to backup, and
 * there are more than zero notes in Google Drive, Google Drive shouldn't
 * be written over."
 *
 * This locks in the redesigned `backupToDrive()`: when a remote backup
 * already exists, it downloads it, INSERT-OR-IGNOREs whichever local notes/
 * to-dos aren't already in it (by id), and re-uploads that merged result —
 * an operation that can only ever ADD rows, never remove or replace any.
 */

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-app-signature", () => ({
  getRuntimePackageName: jest.fn(() => "com.anonymous.silentconfidant"),
  getSigningSha1Fingerprint: jest.fn(() => "fake-sha1"),
}));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "fake-merge-id") }));
jest.mock("../db/client", () => ({ getRawDatabase: jest.fn() }));
jest.mock("../services/crypto/keyManager", () => ({ getOrCreateDatabaseKey: jest.fn(() => Promise.resolve("local-fake-key")) }));

const mockListNotes = jest.fn();
jest.mock("../services/notes/noteManager", () => ({
  listNotes: mockListNotes,
  mergeMissingNotes: jest.fn(() => Promise.resolve(0)),
}));

const mockListAllToDos = jest.fn();
jest.mock("../services/todos/todoManager", () => ({
  listAllToDos: mockListAllToDos,
  mergeMissingToDos: jest.fn(() => Promise.resolve(0)),
}));

const mockGetCurrentUser = jest.fn(() => ({ user: { email: "test@example.com", name: "Test User" } }));
const mockGetTokens = jest.fn(() => Promise.resolve({ accessToken: "fake-token" }));
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: { configure: jest.fn(), getCurrentUser: mockGetCurrentUser, getTokens: mockGetTokens },
  isSuccessResponse: jest.fn(() => true),
}));

const mockGetInfoAsync = jest.fn(() => Promise.resolve({ exists: true, size: 4321 }));
const mockUploadAsync = jest.fn((_url: string, _localUri: string, _opts?: unknown) =>
  Promise.resolve({ status: 200, body: "" })
);
const mockDownloadAsync = jest.fn((_url: string, _destUri: string, _opts?: unknown) =>
  Promise.resolve({ status: 200 })
);
const mockReadAsStringAsync = jest.fn(() => Promise.resolve("remote-fake-key"));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///fake-cache/",
  getInfoAsync: mockGetInfoAsync,
  writeAsStringAsync: jest.fn(() => Promise.resolve()),
  readAsStringAsync: mockReadAsStringAsync,
  deleteAsync: jest.fn(() => Promise.resolve()),
  uploadAsync: mockUploadAsync,
  downloadAsync: mockDownloadAsync,
  FileSystemUploadType: { BINARY_CONTENT: "BINARY_CONTENT" },
}));

/** A minimal in-memory stand-in for the DOWNLOADED remote backup's op-sqlite
 * connection — just enough to drive `insertMissingNoteRows`/
 * `insertMissingToDoRows`'s real SELECT/INSERT/transaction pattern. */
function createFakeMergeDb(seedNoteIds: string[], seedToDoIds: string[] = []) {
  let notes = seedNoteIds.map((id) => ({ id }));
  let todos = seedToDoIds.map((id) => ({ id }));
  const execute = jest.fn(async (query: string, params: unknown[] = []) => {
    const q = query.trim();
    if (/^SELECT id FROM notes/i.test(q)) return { rows: notes.map((n) => ({ id: n.id })) };
    if (/^SELECT id FROM todos/i.test(q)) return { rows: todos.map((t) => ({ id: t.id })) };
    if (/^INSERT OR IGNORE INTO notes/i.test(q)) {
      notes.push({ id: params[0] as string });
      return { rows: [] };
    }
    if (/^INSERT OR IGNORE INTO todos/i.test(q)) {
      todos.push({ id: params[0] as string });
      return { rows: [] };
    }
    if (/^VACUUM INTO/i.test(q)) return { rows: [] };
    throw new Error(`fake merge db: unhandled query — ${q}`);
  });
  const transaction = jest.fn(async (fn: (tx: { execute: typeof execute }) => Promise<void>) => {
    await fn({ execute });
  });
  return {
    execute,
    transaction,
    close: jest.fn(),
    getNoteIds: () => notes.map((n) => n.id),
    getToDoIds: () => todos.map((t) => t.id),
  };
}

const mockOpen = jest.fn();
jest.mock("@op-engineering/op-sqlite", () => ({ open: (...args: unknown[]) => mockOpen(...args) }));

function mockDriveFetchNoExistingBackup() {
  return jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ files: [] }) } as Response)
  );
}

function mockDriveFetchWithExistingBackup() {
  return jest.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("q=")) {
      // findAppDataFile is called once for each filename — distinguish by
      // which filename the query string is actually asking about.
      const isKeyLookup = decodeURIComponent(url).includes("remi_backup.key");
      const file = isKeyLookup
        ? { id: "existing-key-id", name: "remi_backup.key" }
        : { id: "existing-db-id", name: "remi_backup.db" };
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ files: [file] }) } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
}

describe("backupToDrive delta merge (explicit user redesign, 2026-09-16)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentUser.mockReturnValue({ user: { email: "test@example.com", name: "Test User" } });
    mockGetTokens.mockResolvedValue({ accessToken: "fake-token" });
    mockReadAsStringAsync.mockResolvedValue("remote-fake-key");
    const { getRawDatabase } = require("../db/client");
    getRawDatabase.mockResolvedValue({ execute: jest.fn(() => Promise.resolve({ rows: [] })) });
  });

  it("no existing remote backup: uploads a fresh snapshot and reports every local note/to-do as added", async () => {
    global.fetch = mockDriveFetchNoExistingBackup() as unknown as typeof fetch;
    mockListNotes.mockResolvedValue([
      { id: "n1", content: "a", transcript: null, transcriptionModel: null, createdAt: 1 },
      { id: "n2", content: "b", transcript: null, transcriptionModel: null, createdAt: 2 },
    ]);
    mockListAllToDos.mockResolvedValue([
      { id: "t1", text: "x", actionDate: "2026-01-01", toDate: null, notificationTime: "05:00", isCompleted: false, recurrence: "none", recurrenceInterval: 1, createdAt: "2026-01-01T00:00:00.000Z", noteId: null },
    ]);

    const { backupToDrive } = require("../services/sync/driveSync");
    const result = await backupToDrive();

    expect(result.addedNoteCount).toBe(2);
    expect(result.addedToDoCount).toBe(1);
    expect(result.message).toContain("2 notes");
    expect(mockUploadAsync).toHaveBeenCalled();
    // Never opened any downloaded db — there was nothing to merge with.
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it("existing backup with 15 notes + 2 new local notes: only the 2 new ones are added, becoming 17", async () => {
    global.fetch = mockDriveFetchWithExistingBackup() as unknown as typeof fetch;
    const existingIds = Array.from({ length: 15 }, (_, i) => `note-${i + 1}`);
    const fakeMergeDb = createFakeMergeDb(existingIds);
    mockOpen.mockReturnValue(fakeMergeDb);

    // Local device has the same 15 it always had, plus 2 genuinely new ones.
    const localNoteIds = [...existingIds, "note-16", "note-17"];
    mockListNotes.mockResolvedValue(
      localNoteIds.map((id, i) => ({ id, content: `content ${i}`, transcript: null, transcriptionModel: null, createdAt: i }))
    );
    mockListAllToDos.mockResolvedValue([]);

    const { backupToDrive } = require("../services/sync/driveSync");
    const result = await backupToDrive();

    expect(result.addedNoteCount).toBe(2);
    expect(fakeMergeDb.getNoteIds().sort()).toEqual([...existingIds, "note-16", "note-17"].sort());
    expect(fakeMergeDb.getNoteIds()).toHaveLength(17);

    // Uploads the merged DB back to the EXISTING db file id, never re-uploads
    // the key (the merged file is still encrypted under the same key it was
    // downloaded and opened with).
    const uploadedUrls = mockUploadAsync.mock.calls.map((call) => call[0] as string);
    expect(uploadedUrls.some((url) => url.includes("existing-db-id"))).toBe(true);
    expect(uploadedUrls.some((url) => url.includes("existing-key-id"))).toBe(false);
  });

  it("existing backup with 15 notes + 0 local notes: Drive is left completely intact, nothing is written over", async () => {
    global.fetch = mockDriveFetchWithExistingBackup() as unknown as typeof fetch;
    const existingIds = Array.from({ length: 15 }, (_, i) => `note-${i + 1}`);
    const fakeMergeDb = createFakeMergeDb(existingIds);
    mockOpen.mockReturnValue(fakeMergeDb);

    mockListNotes.mockResolvedValue([]);
    mockListAllToDos.mockResolvedValue([]);

    const { backupToDrive } = require("../services/sync/driveSync");
    const result = await backupToDrive();

    // The exact scenario from the live incident: this must NEVER lose the
    // 15 notes that were already in Drive.
    expect(fakeMergeDb.getNoteIds()).toHaveLength(15);
    expect(fakeMergeDb.getNoteIds().sort()).toEqual(existingIds.sort());
    expect(result.addedNoteCount).toBe(0);
    expect(result.message).toBe("Everything is already backed up!");
  });
});
