/**
 * In a Xayra Dev disposable test vault, Google Drive backup/restore and every
 * Google Calendar operation stop before any Google call — so test data can
 * never reach the user's real backup or calendar.
 */
jest.mock("../services/dev/disposableVault", () => {
  class DisposableModeError extends Error {}
  return {
    DisposableModeError,
    assertNetworkFeatureAllowed: jest.fn(async (feature: string) => {
      throw new DisposableModeError(`${feature} isn't available in a disposable test vault.`);
    }),
  };
});
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

const { backupToDrive, restoreFromDrive, signInWithGoogle, signOutFromGoogle } = require("../services/sync/driveSync");
const { createCalendarEvent, updateCalendarEvent, deleteCalendarEvent } = require("../services/sync/calendarSync");
const { DisposableModeError } = require("../services/dev/disposableVault");

const todo = {
  id: "t1",
  text: "Test",
  actionDate: "2026-10-20",
  toDate: null,
  notificationTime: "09:00",
  isCompleted: false,
  recurrence: "none",
  recurrenceInterval: 1,
  createdAt: "2026-10-14",
  noteId: null,
  googleCalendarEventId: "event-1",
};

function expectNoGoogleOrVaultWork(): void {
  expect(mockGoogle.getTokens).not.toHaveBeenCalled();
  expect(mockGoogle.hasPlayServices).not.toHaveBeenCalled();
  expect(mockUpload).not.toHaveBeenCalled();
  expect(mockDownload).not.toHaveBeenCalled();
  expect(mockGetRawDatabase).not.toHaveBeenCalled();
  expect(mockGetKey).not.toHaveBeenCalled();
  expect(mockSqliteOpen).not.toHaveBeenCalled();
}

const fetchSpy = jest.spyOn(global, "fetch").mockImplementation(() => {
  throw new Error("network must not be reached");
});

beforeEach(() => {
  jest.clearAllMocks();
});

afterAll(() => fetchSpy.mockRestore());

describe("disposable test vault: Drive and Calendar are refused before any Google call", () => {
  it.each([
    ["Drive backup", () => backupToDrive()],
    ["Drive restore", () => restoreFromDrive()],
    ["Calendar create", () => createCalendarEvent(todo)],
    ["Calendar update", () => updateCalendarEvent(todo)],
    ["Calendar delete", () => deleteCalendarEvent("event-1")],
    ["Google sign-in", () => signInWithGoogle()],
    ["Google sign-out", () => signOutFromGoogle()],
  ])("%s", async (_label, action) => {
    await expect(action()).rejects.toBeInstanceOf(DisposableModeError);
    expectNoGoogleOrVaultWork();
    expect(mockGoogle.signIn).not.toHaveBeenCalled();
    expect(mockGoogle.configure).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
