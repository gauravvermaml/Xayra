/**
 * Live data-loss incident, fixed 2026-09-16: a user uninstalled the dev
 * build on their Pixel 9, installed the Play Store tester build (fresh app
 * identity, 0 local notes), then tapped "Back Up Now" — which silently
 * uploaded that empty local vault over a real, populated backup already
 * sitting in their Google Drive, with no warning. By the time "Restore /
 * Sync Notes" was tapped afterward, Drive had nothing left to restore.
 *
 * Locks in `backupToDrive()`'s new guard: it must refuse to upload (throwing
 * BackupWouldReplaceExistingBackupError instead) whenever the local vault is
 * empty AND a remote backup already exists — the one combination that can
 * never legitimately justify a silent overwrite — unless explicitly
 * overridden with `{ force: true }`.
 */

jest.mock("@op-engineering/op-sqlite", () => ({ open: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-app-signature", () => ({
  getRuntimePackageName: jest.fn(() => "com.anonymous.silentconfidant"),
  getSigningSha1Fingerprint: jest.fn(() => "fake-sha1"),
}));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "fake-uuid") }));
jest.mock("../db/client", () => ({ getRawDatabase: jest.fn() }));
jest.mock("../services/crypto/keyManager", () => ({ getOrCreateDatabaseKey: jest.fn(() => Promise.resolve("fake-key")) }));
jest.mock("../services/todos/todoManager", () => ({ mergeMissingToDos: jest.fn(() => Promise.resolve(0)) }));

const mockListNotes = jest.fn();
jest.mock("../services/notes/noteManager", () => ({
  listNotes: mockListNotes,
  mergeMissingNotes: jest.fn(() => Promise.resolve(0)),
}));

const mockGetCurrentUser = jest.fn(() => ({ user: { email: "test@example.com", name: "Test User" } }));
const mockGetTokens = jest.fn(() => Promise.resolve({ accessToken: "fake-token" }));
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: {
    configure: jest.fn(),
    getCurrentUser: mockGetCurrentUser,
    getTokens: mockGetTokens,
  },
  isSuccessResponse: jest.fn(() => true),
}));

const mockGetInfoAsync = jest.fn(() => Promise.resolve({ exists: true, size: 1234 }));
const mockUploadAsync = jest.fn(() => Promise.resolve({ status: 200, body: "" }));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///fake-cache/",
  getInfoAsync: mockGetInfoAsync,
  writeAsStringAsync: jest.fn(() => Promise.resolve()),
  deleteAsync: jest.fn(() => Promise.resolve()),
  uploadAsync: mockUploadAsync,
  FileSystemUploadType: { BINARY_CONTENT: "BINARY_CONTENT" },
}));

/** Drives every Google Drive REST call `driveFetch` makes. `remoteFileExists`
 * controls whether `findAppDataFile` reports remi_backup.db as already
 * present — the one thing that decides whether the guard should fire. */
function mockDriveFetch(remoteFileExists: boolean) {
  return jest.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (method === "GET" && url.includes("q=")) {
      // findAppDataFile — used both by the guard's getBackupMetadata() call
      // and by the real upload path's findOrCreateAppDataFile().
      const files = remoteFileExists ? [{ id: "existing-file-id", name: "remi_backup.db" }] : [];
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ files }) } as Response);
    }
    if (method === "GET" && /\/files\/[^/?]+\?fields=modifiedTime/.test(url)) {
      // getBackupMetadata()'s follow-up read once a file id is known.
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ modifiedTime: "2026-09-10T12:00:00.000Z", size: "999" }),
      } as Response);
    }
    if (method === "POST") {
      // createAppDataFile
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: "new-file-id" }) } as Response);
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
  });
}

describe("backupToDrive's empty-vault-would-overwrite-remote-backup guard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCurrentUser.mockReturnValue({ user: { email: "test@example.com", name: "Test User" } });
    mockGetTokens.mockResolvedValue({ accessToken: "fake-token" });
    const { getRawDatabase } = require("../db/client");
    getRawDatabase.mockResolvedValue({ execute: jest.fn(() => Promise.resolve({ rows: [] })) });
  });

  it("refuses to back up an empty local vault when a remote backup already exists", async () => {
    global.fetch = mockDriveFetch(true) as unknown as typeof fetch;
    mockListNotes.mockResolvedValue([]);
    const { backupToDrive, BackupWouldReplaceExistingBackupError } = require("../services/sync/driveSync");

    await expect(backupToDrive()).rejects.toBeInstanceOf(BackupWouldReplaceExistingBackupError);
    // The whole point: it must bail out BEFORE ever uploading anything.
    expect(mockUploadAsync).not.toHaveBeenCalled();
  });

  it("proceeds normally when the local vault is empty but no remote backup exists yet (a genuinely fresh account)", async () => {
    global.fetch = mockDriveFetch(false) as unknown as typeof fetch;
    mockListNotes.mockResolvedValue([]);
    const { backupToDrive } = require("../services/sync/driveSync");

    await expect(backupToDrive()).resolves.toMatchObject({ sizeBytes: 1234 });
    expect(mockUploadAsync).toHaveBeenCalled();
  });

  it("proceeds normally when the local vault is non-empty, regardless of what's already in Drive", async () => {
    global.fetch = mockDriveFetch(true) as unknown as typeof fetch;
    mockListNotes.mockResolvedValue([{ id: "note-1" }]);
    const { backupToDrive } = require("../services/sync/driveSync");

    await expect(backupToDrive()).resolves.toMatchObject({ sizeBytes: 1234 });
    expect(mockUploadAsync).toHaveBeenCalled();
  });

  it("force: true bypasses the guard even for an empty local vault over an existing remote backup", async () => {
    global.fetch = mockDriveFetch(true) as unknown as typeof fetch;
    mockListNotes.mockResolvedValue([]);
    const { backupToDrive } = require("../services/sync/driveSync");

    await expect(backupToDrive({ force: true })).resolves.toMatchObject({ sizeBytes: 1234 });
    expect(mockUploadAsync).toHaveBeenCalled();
  });
});
