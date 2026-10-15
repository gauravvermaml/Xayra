/**
 * Recovery's Google Drive access (services/sync/driveSync.ts): silent sign-in
 * first, the picker only when asked, account switching without revoking
 * access, and a key download that is a GET into memory — no Drive changes and
 * no file writes.
 */
jest.mock("@op-engineering/op-sqlite", () => ({ open: jest.fn() }));
jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(() => Promise.resolve(null)),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock("expo-app-signature", () => ({
  getRuntimePackageName: jest.fn(() => "com.anonymous.silentconfidant.dev"),
  getSigningSha1Fingerprint: jest.fn(() => "fake-sha1"),
}));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "id") }));
jest.mock("../db/client", () => ({ getRawDatabase: jest.fn() }));
jest.mock("../services/crypto/keyManager", () => ({ getOrCreateDatabaseKey: jest.fn() }));
jest.mock("../services/notes/noteManager", () => ({ listNotes: jest.fn(), listNoteRevisions: jest.fn(), mergeMissingNotes: jest.fn() }));
jest.mock("../services/todos/todoManager", () => ({ listAllToDos: jest.fn(), mergeMissingToDos: jest.fn() }));
let mockMode: "normal" | "disposable" = "normal";
jest.mock("../services/dev/disposableVault", () => {
  class DisposableModeError extends Error {}
  return {
    DisposableModeError,
    assertNetworkFeatureAllowed: jest.fn(async (feature: string) => {
      if (mockMode === "disposable") throw new DisposableModeError(feature);
    }),
  };
});

const user = { user: { email: "test.account@example.com", name: "Test" } };
const mockGoogle = {
  configure: jest.fn(),
  hasPlayServices: jest.fn(async () => true),
  signInSilently: jest.fn(async () => ({ type: "success", data: user })),
  signIn: jest.fn(async () => ({ type: "success", data: user })),
  signOut: jest.fn(async () => undefined),
  revokeAccess: jest.fn(async () => undefined),
  addScopes: jest.fn(async () => ({ type: "success", data: { scopes: ["https://www.googleapis.com/auth/drive.appdata"] } })),
  getCurrentUser: jest.fn(() => user),
  getTokens: jest.fn(async () => ({ accessToken: "token" })),
};
jest.mock("@react-native-google-signin/google-signin", () => ({
  GoogleSignin: mockGoogle,
  isSuccessResponse: (response: { type: string }) => response.type === "success",
}));
const mockFileSystem = {
  cacheDirectory: "file:///cache/",
  writeAsStringAsync: jest.fn(),
  downloadAsync: jest.fn(),
  uploadAsync: jest.fn(),
  deleteAsync: jest.fn(),
  getInfoAsync: jest.fn(),
  readAsStringAsync: jest.fn(),
  FileSystemUploadType: { BINARY_CONTENT: "BINARY_CONTENT" },
};
jest.mock("expo-file-system/legacy", () => mockFileSystem);

const mockCollect = jest.fn(async (_token: string) => [] as string[]);
jest.mock("../services/backup/backupService", () => ({
  collectRecoveryKeyCandidates: (token: string) => mockCollect(token),
  restoreLatestBackup: jest.fn(),
  runEncryptedBackup: jest.fn(),
}));
jest.mock("../services/backup/backupAccount", () => ({ rebindBackupAccount: jest.fn(), BackupAccountMismatchError: class extends Error {} }));
const { signInForRecovery, switchRecoveryAccount, fetchRecoveryKeyCandidates, signInWithGoogle } = require("../services/sync/driveSync");

const KEY = "b".repeat(64);
let mockKeyFile: { id: string; name: string; size?: string } | null = { id: "key-file", name: "remi_backup.key", size: "64" };
let mockKeyBody = `${KEY}\n`;
const fetchSpy = jest.spyOn(global, "fetch").mockImplementation((async (url: string) => {
  if (String(url).includes("?spaces=appDataFolder")) {
    return new Response(JSON.stringify({ files: mockKeyFile ? [mockKeyFile] : [] }), { status: 200 });
  }
  if (String(url).endsWith("/key-file?alt=media")) return new Response(mockKeyBody, { status: 200 });
  return new Response("unexpected", { status: 500 });
}) as typeof fetch);

beforeEach(() => {
  jest.clearAllMocks();
  mockMode = "normal";
  mockKeyFile = { id: "key-file", name: "remi_backup.key", size: "64" };
  mockKeyBody = `${KEY}\n`;
  mockGoogle.signInSilently.mockResolvedValue({ type: "success", data: user });
});

afterAll(() => fetchSpy.mockRestore());

describe("recovery sign-in", () => {
  it("uses the remembered account silently — no picker", async () => {
    expect((await signInForRecovery({ interactive: false })).email).toBe("test.account@example.com");
    expect(mockGoogle.signIn).not.toHaveBeenCalled();
    expect(mockGoogle.addScopes).toHaveBeenCalledWith({ scopes: ["https://www.googleapis.com/auth/drive.appdata"] });
  });

  it("no remembered account: null without a picker, the picker only when interactive", async () => {
    mockGoogle.signInSilently.mockResolvedValue({ type: "noSavedCredentialFound", data: null } as never);
    expect(await signInForRecovery({ interactive: false })).toBeNull();
    expect(mockGoogle.signIn).not.toHaveBeenCalled();
    expect((await signInForRecovery({ interactive: true })).email).toBe("test.account@example.com");
    expect(mockGoogle.signIn).toHaveBeenCalledTimes(1);
  });

  it("switching account signs out locally and opens the picker — access isn't revoked", async () => {
    await switchRecoveryAccount();
    expect(mockGoogle.signOut).toHaveBeenCalledTimes(1);
    expect(mockGoogle.signIn).toHaveBeenCalledTimes(1);
    expect(mockGoogle.revokeAccess).not.toHaveBeenCalled();
  });

  it("a Drive permission left unticked is reported once, never re-asked in a loop", async () => {
    mockGoogle.addScopes.mockResolvedValueOnce({ type: "success", data: { scopes: [] } } as never);
    await expect(signInWithGoogle()).rejects.toThrow(/allow Google Drive access/);
    expect(mockGoogle.addScopes).toHaveBeenCalledTimes(1);
    expect(mockGoogle.signOut).toHaveBeenCalledTimes(1);
    // Android rejects (rather than returning "cancelled") when it's declined.
    mockGoogle.addScopes.mockRejectedValueOnce(Object.assign(new Error("Failed to add scopes."), { code: "addScopes" }) as never);
    await expect(signInWithGoogle()).rejects.toThrow(/allow Google Drive access/);
  });

  it("is refused in a disposable test vault", async () => {
    mockMode = "disposable";
    await expect(signInForRecovery({ interactive: true })).rejects.toThrow();
    expect(mockGoogle.signInSilently).not.toHaveBeenCalled();
  });
});

describe("fetchRecoveryKeyCandidates", () => {
  it("delegates to the encrypted backup's candidate collection with the signed-in token", async () => {
    mockCollect.mockResolvedValueOnce([KEY]);
    expect(await fetchRecoveryKeyCandidates()).toEqual([KEY]);
    expect(mockCollect).toHaveBeenCalledTimes(1);
  });

  it("is refused in a disposable test vault before any Drive call", async () => {
    mockMode = "disposable";
    await expect(fetchRecoveryKeyCandidates()).rejects.toThrow();
    expect(mockCollect).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
