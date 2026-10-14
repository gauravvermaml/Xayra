/**
 * While protected backups are pending, Google Drive backup and restore refuse
 * before any Google call, download, upload or database access: encrypted-vault
 * data never goes through the legacy format, and the legacy Drive files are
 * never overwritten. The user gets an explanatory "paused" message.
 */
jest.mock("../services/dev/disposableVault", () => ({
  DisposableModeError: class extends Error {},
  assertNetworkFeatureAllowed: jest.fn(async () => undefined),
}));
const mockSqliteOpen = jest.fn();
jest.mock("@op-engineering/op-sqlite", () => ({ open: mockSqliteOpen }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(() => Promise.resolve()),
  removeItem: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-app-signature", () => ({
  getRuntimePackageName: jest.fn(() => "com.anonymous.silentconfidant.dev"),
  getSigningSha1Fingerprint: jest.fn(() => "fake-sha1"),
}));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "id") }));
const mockGetRawDatabase = jest.fn();
jest.mock("../db/client", () => ({ getRawDatabase: mockGetRawDatabase }));
const mockGetKey = jest.fn();
jest.mock("../services/crypto/keyManager", () => ({ getOrCreateDatabaseKey: mockGetKey }));
jest.mock("../services/notes/noteManager", () => ({
  listNotes: jest.fn(),
  listNoteRevisions: jest.fn(),
  mergeMissingNotes: jest.fn(),
}));
jest.mock("../services/todos/todoManager", () => ({ listAllToDos: jest.fn(), mergeMissingToDos: jest.fn() }));
const mockGoogle = {
  configure: jest.fn(),
  getCurrentUser: jest.fn(() => ({ user: { email: "test@example.com" } })),
  getTokens: jest.fn(() => Promise.resolve({ accessToken: "token" })),
  hasPlayServices: jest.fn(() => Promise.resolve(true)),
  addScopes: jest.fn(),
  signIn: jest.fn(),
};
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: mockGoogle,
  isSuccessResponse: jest.fn(() => true),
}));
const mockDownload = jest.fn();
const mockUpload = jest.fn();
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///fake-cache/",
  getInfoAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  deleteAsync: jest.fn(),
  uploadAsync: mockUpload,
  downloadAsync: mockDownload,
  FileSystemUploadType: { BINARY_CONTENT: "BINARY_CONTENT" },
}));
const mockFetch = jest.fn();
(globalThis as { fetch?: unknown }).fetch = mockFetch;

import { BackupPausedError, backupToDrive, DRIVE_BACKUP_PAUSED, restoreFromDrive } from "../services/sync/driveSync";

beforeEach(() => jest.clearAllMocks());

it("backups are paused in this stage", () => {
  expect(DRIVE_BACKUP_PAUSED).toBe(true);
});

it.each([
  ["backup", backupToDrive, "Backup paused", /Nothing was uploaded/],
  ["restore", restoreFromDrive, "Restore paused", /nothing on this phone was changed/],
])("%s: refuses with a paused message and touches nothing", async (_label, action, title, wording) => {
  const err = await (action as () => Promise<unknown>)().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(BackupPausedError);
  expect((err as BackupPausedError).title).toBe(title);
  expect((err as Error).message).toMatch(wording);
  expect((err as Error).message).toMatch(/existing Drive backup is left as it is/);
  expect(mockGoogle.getTokens).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
  expect(mockDownload).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockSqliteOpen).not.toHaveBeenCalled();
  expect(mockGetRawDatabase).not.toHaveBeenCalled();
  expect(mockGetKey).not.toHaveBeenCalled();
});
