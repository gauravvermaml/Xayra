/**
 * db/client.ts opens exactly one vault per process, chosen by the resolved
 * vault mode: the normal vault through keyManager's persistent key, or the
 * Xayra Dev disposable vault with its own file, folder and in-memory key —
 * never both, and the disposable path never touches keyManager or the
 * normal vault file.
 */
let mockMode: "normal" | "disposable" = "normal";
let mockVaultFileExists = true;

const mockOpen = jest.fn((_options: { name: string; location?: string; encryptionKey: string }) => ({
  execute: jest.fn(async () => ({ rows: [] })),
  transaction: jest.fn(),
  close: jest.fn(),
}));
jest.mock("@op-engineering/op-sqlite", () => ({
  ANDROID_DATABASE_PATH: "/data/user/0/app/databases/",
  open: mockOpen,
}));
jest.mock("drizzle-orm/op-sqlite", () => ({ drizzle: jest.fn(() => ({})) }));
const mockGetInfoAsync = jest.fn(async (_uri: string) => ({ exists: mockVaultFileExists }));
jest.mock("expo-file-system/legacy", () => ({ getInfoAsync: mockGetInfoAsync }));
jest.mock("../services/ai/localEmbeddings", () => ({ EMBEDDING_DIMENSIONS: 384, generateEmbeddingLocal: jest.fn() }));
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));
const mockGetKey = jest.fn(async (_options?: { allowCreate?: boolean }) => "normal-persistent-key");
jest.mock("../services/crypto/keyManager", () => ({ getOrCreateDatabaseKey: mockGetKey }));
const mockPrepareDisposable = jest.fn(async () => "/data/user/0/app/files/disposable-vault");
jest.mock("../services/dev/disposableVault", () => ({
  DISPOSABLE_DATABASE_NAME: "xayra-disposable.sqlite",
  resolveVaultMode: jest.fn(async () => mockMode),
  getDisposableVaultKey: jest.fn(async () => "disposable-memory-key"),
  prepareDisposableVaultStorage: mockPrepareDisposable,
}));

function freshClient(): typeof import("../db/client") {
  delete (globalThis as Record<string, unknown>).__silentConfidantDbConnection__;
  let mod!: typeof import("../db/client");
  jest.isolateModules(() => {
    mod = require("../db/client");
  });
  return mod;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockMode = "normal";
  mockVaultFileExists = true;
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("vault routing", () => {
  it("normal, existing vault: persistent key, read-only (no key creation), normal file", async () => {
    await freshClient().getRawDatabase();
    expect(mockGetKey).toHaveBeenCalledWith({ allowCreate: false });
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toEqual({ name: "silent-confidant.sqlite", encryptionKey: "normal-persistent-key" });
    expect(mockPrepareDisposable).not.toHaveBeenCalled();
  });

  it("normal, first run (no vault file): key creation allowed", async () => {
    mockVaultFileExists = false;
    await freshClient().getRawDatabase();
    expect(mockGetKey).toHaveBeenCalledWith({ allowCreate: true });
  });

  it("normal: a key failure opens nothing — no fallback vault of any kind", async () => {
    mockGetKey.mockRejectedValueOnce(new Error("key unavailable"));
    await expect(freshClient().getRawDatabase()).rejects.toThrow("key unavailable");
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockPrepareDisposable).not.toHaveBeenCalled();
  });

  it("disposable: its own file, folder and key; never keyManager or the normal vault file", async () => {
    mockMode = "disposable";
    await freshClient().getRawDatabase();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toEqual({
      name: "xayra-disposable.sqlite",
      location: "/data/user/0/app/files/disposable-vault",
      encryptionKey: "disposable-memory-key",
    });
    expect(mockGetKey).not.toHaveBeenCalled();
    expect(mockGetInfoAsync).not.toHaveBeenCalled(); // the normal vault file isn't even checked
  });
});
