/**
 * db/client.ts opens exactly one vault per process, chosen by the resolved
 * vault mode: the normal vault through vaultActivation.ts (encrypted, raw
 * key), or the Xayra Dev disposable vault with its own file, folder and
 * in-memory key — encrypted with the same key representation, never both,
 * and the disposable path never touches the normal vault.
 */
let mockMode: "normal" | "disposable" = "normal";
let mockSqlcipher = true;
let mockSchemaObjects = 3;

const mockClose = jest.fn();
const mockOpen = jest.fn((_options: { name: string; location?: string; encryptionKey: string }) => ({
  execute: jest.fn(async (sql: string) =>
    sql === "SELECT count(*) FROM sqlite_master" ? { rows: [{ n: mockSchemaObjects }] } : { rows: [] }
  ),
  transaction: jest.fn(),
  close: mockClose,
}));
jest.mock("@op-engineering/op-sqlite", () => ({
  isSQLCipher: () => mockSqlcipher,
  open: mockOpen,
}));
jest.mock("drizzle-orm/op-sqlite", () => ({ drizzle: jest.fn(() => ({})) }));
jest.mock("../services/ai/localEmbeddings", () => ({ EMBEDDING_DIMENSIONS: 384, generateEmbeddingLocal: jest.fn() }));
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));
const mockPrepareNormal = jest.fn(async () => ({
  name: "xayra.sqlite",
  location: "/data/user/0/app/files/vault",
  encryptionKey: `x'${"b".repeat(64)}'`,
}));
jest.mock("../services/vault/vaultActivation", () => {
  const actual = jest.requireActual("../services/vault/vaultActivation");
  return {
    VAULT_DATABASE_NAME: "xayra.sqlite",
    encryptedVaultDirectory: () => "/data/user/0/app/files/vault",
    prepareNormalVault: mockPrepareNormal,
    assertEstablishedVault: actual.assertEstablishedVault,
  };
});
jest.mock("../services/crypto/keyManager", () => ({
  isWellFormedDatabaseKey: (key: string) => /^[0-9a-f]{64}$/.test(key),
}));
const mockPrepareDisposable = jest.fn(async () => "/data/user/0/app/files/disposable-vault");
jest.mock("../services/dev/disposableVault", () => ({
  DISPOSABLE_DATABASE_NAME: "xayra-disposable.sqlite",
  isRunningDevPackage: () => true,
  resolveVaultMode: jest.fn(async () => mockMode),
  getDisposableVaultKey: jest.fn(async () => "c".repeat(64)),
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
  mockSqlcipher = true;
  mockSchemaObjects = 3;
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("vault routing", () => {
  it("normal: opens exactly what vaultActivation prepared (files/vault, raw key)", async () => {
    await freshClient().getRawDatabase();
    expect(mockPrepareNormal).toHaveBeenCalledTimes(1);
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toEqual({
      name: "xayra.sqlite",
      location: "/data/user/0/app/files/vault",
      encryptionKey: `x'${"b".repeat(64)}'`,
    });
    expect(mockPrepareDisposable).not.toHaveBeenCalled();
  });

  it("normal: a preparation failure opens nothing — no fallback vault of any kind", async () => {
    mockPrepareNormal.mockRejectedValueOnce(new Error("key unavailable"));
    await expect(freshClient().getRawDatabase()).rejects.toThrow("key unavailable");
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockPrepareDisposable).not.toHaveBeenCalled();
  });

  it("normal: a committed vault that opens EMPTY (file re-created) is refused and closed", async () => {
    mockSchemaObjects = 0;
    await expect(freshClient().getRawDatabase()).rejects.toMatchObject({ name: "VaultStateError", kind: "conflict" });
    expect(mockClose).toHaveBeenCalled();
  });

  it("disposable: its own file and folder, a raw in-memory key; never the normal vault", async () => {
    mockMode = "disposable";
    await freshClient().getRawDatabase();
    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toEqual({
      name: "xayra-disposable.sqlite",
      location: "/data/user/0/app/files/disposable-vault",
      encryptionKey: `x'${"c".repeat(64)}'`,
    });
    expect(mockPrepareNormal).not.toHaveBeenCalled();
  });

  it("disposable: refuses to open without SQLCipher", async () => {
    mockMode = "disposable";
    mockSqlcipher = false;
    await expect(freshClient().getRawDatabase()).rejects.toMatchObject({ kind: "encryptionUnavailable" });
    expect(mockOpen).not.toHaveBeenCalled();
  });
});
