/**
 * Non-destructive original-vault recovery (services/recovery/originalVaultRecovery.ts):
 * a candidate key is tried only on a complete copy of the vault; the original
 * is only ever read; the copy is always removed; the key never touches disk.
 */
const VAULT_DIR = "/data/user/0/app/databases/";
const FILES_DIR = "/data/user/0/app/files/"; // documentDirectory: where staging copies go
const DB = "silent-confidant.sqlite";
const GOOD_KEY = "a".repeat(64);

type MockFile = { size: number; content: string };
const mockFs = new Map<string, MockFile>(); // bare path -> file
const mockDirs = new Set<string>();
const mockOps: { op: string; path: string; detail?: string }[] = [];
let mockFreeBytes = 10 * 1024 * 1024 * 1024;
let mockCopyBehaviour: "ok" | "truncate" | "throw" | "growOriginal" = "ok";

const bare = (uri: string) => uri.replace(/^file:\/\//, "");

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/user/0/app/files/",
  getInfoAsync: jest.fn(async (uri: string) => {
    const path = bare(uri);
    const file = mockFs.get(path);
    if (file) return { exists: true, isDirectory: false, size: file.size };
    if (mockDirs.has(path.replace(/\/$/, ""))) return { exists: true, isDirectory: true };
    return { exists: false };
  }),
  getFreeDiskStorageAsync: jest.fn(async () => mockFreeBytes),
  makeDirectoryAsync: jest.fn(async (uri: string) => {
    // Real expo-file-system: databases/ is "external", and a not-yet-existing
    // path there is refused as unwritable (found on device).
    if (bare(uri).startsWith("/data/user/0/app/databases/")) throw new Error("Location isn't writable");
    mockOps.push({ op: "mkdir", path: bare(uri) });
    mockDirs.add(bare(uri).replace(/\/$/, ""));
  }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    if (bare(to).startsWith("/data/user/0/app/databases/")) throw new Error("Location isn't writable");
    mockOps.push({ op: "copy", path: bare(to), detail: bare(from) });
    if (mockCopyBehaviour === "throw") throw new Error("ENOSPC");
    const source = mockFs.get(bare(from))!;
    const size = mockCopyBehaviour === "truncate" ? Math.floor(source.size / 2) : source.size;
    mockFs.set(bare(to), { size, content: source.content });
    if (mockCopyBehaviour === "growOriginal") mockFs.set(bare(from), { ...source, size: source.size + 4096 });
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    const path = bare(uri);
    mockOps.push({ op: "delete", path });
    for (const key of [...mockFs.keys()]) if (key === path || key.startsWith(path)) mockFs.delete(key);
    mockDirs.delete(path.replace(/\/$/, ""));
  }),
  readDirectoryAsync: jest.fn(async (uri: string) => {
    const dir = bare(uri);
    const names = new Set<string>();
    for (const key of [...mockFs.keys(), ...mockDirs]) {
      if (key.startsWith(dir) && key !== dir) names.add(key.slice(dir.length).split("/")[0]);
    }
    return [...names];
  }),
  writeAsStringAsync: jest.fn(async (uri: string, text: string) => {
    mockOps.push({ op: "write", path: bare(uri), detail: text });
    mockFs.set(bare(uri), { size: text.length, content: text });
  }),
  readAsStringAsync: jest.fn(async (uri: string) => mockFs.get(bare(uri))?.content ?? ""),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    mockOps.push({ op: "move", path: bare(to), detail: bare(from) });
    const file = mockFs.get(bare(from));
    if (file) {
      mockFs.set(bare(to), file);
      mockFs.delete(bare(from));
    }
  }),
}));

jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "probe-id") }));
jest.mock("../db/client", () => ({
  VAULT_DATABASE_NAME: "silent-confidant.sqlite",
  vaultDirectoryPath: () => "/data/user/0/app/databases/",
}));
jest.mock("../services/crypto/keyManager", () => ({
  isWellFormedDatabaseKey: (key: string) => /^[0-9a-f]{64}$/.test(key),
}));

type StagedBehaviour = "match" | "wrongKey" | "cipherCorrupt" | "integrityFail" | "missingTable" | "openThrows";
let mockStaged: StagedBehaviour = "match";
const mockOpen = jest.fn((options: { name: string; location?: string; encryptionKey: string }) => {
  if (mockStaged === "openThrows") throw new Error("SQLITE_NOTADB");
  return {
    close: jest.fn(),
    execute: jest.fn(async (sql: string) => {
      if (sql.startsWith("SELECT count(*) FROM sqlite_master")) {
        if (mockStaged === "wrongKey") throw new Error("file is not a database");
        return { rows: [{ "count(*)": 12 }] };
      }
      if (sql === "PRAGMA cipher_integrity_check") return { rows: mockStaged === "cipherCorrupt" ? [{ error: "HMAC check failed for pgno=3" }] : [] };
      if (sql === "PRAGMA integrity_check") return { rows: [{ integrity_check: mockStaged === "integrityFail" ? "*** in database main ***" : "ok" }] };
      if (sql.startsWith("SELECT name FROM sqlite_master")) {
        const all = [{ name: "notes" }, { name: "todos" }, { name: "app_settings" }];
        return { rows: mockStaged === "missingTable" ? all.slice(0, 2) : all };
      }
      if (sql === "PRAGMA journal_mode") return { rows: [{ journal_mode: "delete" }] };
      return { rows: [] };
    }),
    options,
  };
});
jest.mock("@op-engineering/op-sqlite", () => ({ open: mockOpen }));

const {
  probeOriginalVaultWithKey,
  cleanupStaleRecoveryStaging,
  writeRecoveryPhase,
  readRecoveryPhase,
  clearRecoveryRecord,
} = require("../services/recovery/originalVaultRecovery");

function seedVault(sideFiles: string[] = []): void {
  mockFs.set(`${VAULT_DIR}${DB}`, { size: 4096 * 40, content: "ENCRYPTED-ORIGINAL" });
  for (const suffix of sideFiles) mockFs.set(`${VAULT_DIR}${DB}${suffix}`, { size: 4096 * 2, content: `SIDE${suffix}` });
}

function originalSnapshot(): string {
  return JSON.stringify([...mockFs.entries()].filter(([path]) => path.startsWith(`${VAULT_DIR}${DB}`)).sort());
}

function expectOriginalOnlyRead(before: string): void {
  expect(originalSnapshot()).toBe(before);
  for (const op of mockOps) {
    if (op.op === "copy") {
      expect(op.path.startsWith(`${FILES_DIR}recovery-probe-`)).toBe(true); // copies only INTO staging
    } else {
      expect(op.path.startsWith(`${VAULT_DIR}${DB}`)).toBe(false); // nothing written/moved/deleted on the original
    }
  }
  for (const call of mockOpen.mock.calls) {
    expect(call[0].location).toBe(`${FILES_DIR}recovery-probe-probe-id`); // only the copy is ever opened
  }
}

function expectStagingGone(): void {
  expect([...mockFs.keys()].some((path) => path.includes("recovery-probe-"))).toBe(false);
}

beforeEach(() => {
  mockFs.clear();
  mockDirs.clear();
  mockOps.length = 0;
  mockFreeBytes = 10 * 1024 * 1024 * 1024;
  mockCopyBehaviour = "ok";
  mockStaged = "match";
  mockOpen.mockClear();
});

describe("probeOriginalVaultWithKey", () => {
  it("matching key: opens only a complete copy (with its hot journal), passes every check, removes the copy", async () => {
    seedVault(["-journal"]);
    const before = originalSnapshot();
    expect(await probeOriginalVaultWithKey(GOOD_KEY)).toEqual({ kind: "match", journalMode: "delete" });
    const copied = mockOps.filter((op) => op.op === "copy").map((op) => op.detail);
    expect(copied).toEqual([`${VAULT_DIR}${DB}`, `${VAULT_DIR}${DB}-journal`]);
    expect(mockOpen).toHaveBeenCalledTimes(1);
    // The raw-key representation every vault uses (services/vault/vaultKey.ts).
    expect(mockOpen.mock.calls[0][0].encryptionKey).toBe(`x'${GOOD_KEY}'`);
    expectOriginalOnlyRead(before);
    expectStagingGone();
  });

  it("WAL vault: database, -wal and -shm are copied together", async () => {
    seedVault(["-wal", "-shm"]);
    await probeOriginalVaultWithKey(GOOD_KEY);
    const copied = mockOps.filter((op) => op.op === "copy").map((op) => op.detail);
    expect(copied).toEqual([`${VAULT_DIR}${DB}`, `${VAULT_DIR}${DB}-wal`, `${VAULT_DIR}${DB}-shm`]);
  });

  it.each([
    ["wrongKey", { kind: "doesNotOpen" }],
    ["openThrows", { kind: "doesNotOpen" }],
    ["cipherCorrupt", { kind: "corrupt" }],
    ["integrityFail", { kind: "corrupt" }],
    ["missingTable", { kind: "corrupt" }],
  ] as const)("%s → %o, original untouched, copy removed", async (behaviour, expected) => {
    seedVault(["-journal"]);
    const before = originalSnapshot();
    mockStaged = behaviour;
    expect(await probeOriginalVaultWithKey(GOOD_KEY)).toEqual(expected);
    expectOriginalOnlyRead(before);
    expectStagingGone();
  });

  it.each(["", "A".repeat(64), "a".repeat(63), "zz".repeat(32), `${"a".repeat(64)}\n`])(
    "malformed key %p is rejected before any file is touched",
    async (key) => {
      seedVault();
      expect(await probeOriginalVaultWithKey(key)).toEqual({ kind: "malformedKey" });
      expect(mockOps).toEqual([]);
      expect(mockOpen).not.toHaveBeenCalled();
    }
  );

  it("no vault on this phone → noVault, nothing copied", async () => {
    expect(await probeOriginalVaultWithKey(GOOD_KEY)).toEqual({ kind: "noVault" });
    expect(mockOps).toEqual([]);
  });

  it("not enough free space → stops before copying anything", async () => {
    seedVault(["-journal"]);
    mockFreeBytes = 1024;
    const result = await probeOriginalVaultWithKey(GOOD_KEY);
    expect(result.kind).toBe("insufficientStorage");
    expect(mockOps).toEqual([]);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it.each(["truncate", "throw", "growOriginal"] as const)(
    "incomplete copy (%s) → copyFailed, never probed, copy removed",
    async (behaviour) => {
      seedVault(["-journal"]);
      mockCopyBehaviour = behaviour;
      const before = behaviour === "growOriginal" ? null : originalSnapshot();
      expect(await probeOriginalVaultWithKey(GOOD_KEY)).toEqual({ kind: "copyFailed" });
      expect(mockOpen).not.toHaveBeenCalled();
      if (before) expectOriginalOnlyRead(before);
      expectStagingGone();
    }
  );

  it("never writes the candidate key to any file", async () => {
    seedVault(["-journal"]);
    await probeOriginalVaultWithKey(GOOD_KEY);
    await writeRecoveryPhase("installingKey");
    for (const op of mockOps) expect(`${op.path} ${op.detail ?? ""}`).not.toContain(GOOD_KEY);
  });
});

describe("staging cleanup and progress record", () => {
  it("removes only leftover recovery-probe-* folders — never the vault or other files", async () => {
    seedVault(["-journal"]);
    mockFs.set(`${FILES_DIR}recovery-probe-old/${DB}`, { size: 10, content: "copy" });
    mockDirs.add(`${FILES_DIR}recovery-probe-old`);
    mockFs.set(`${VAULT_DIR}other.sqlite`, { size: 10, content: "other" });
    const before = originalSnapshot();
    expect(await cleanupStaleRecoveryStaging()).toBe(1);
    expect(mockOps.filter((op) => op.op === "delete").map((op) => op.path)).toEqual([`${FILES_DIR}recovery-probe-old`]);
    expect(mockFs.has(`${VAULT_DIR}other.sqlite`)).toBe(true);
    expect(originalSnapshot()).toBe(before);
  });

  it("the record holds only the phase, survives a restart, and clears", async () => {
    await writeRecoveryPhase("keyInstalled");
    expect(await readRecoveryPhase()).toBe("keyInstalled");
    const written = mockOps.filter((op) => op.op === "write").map((op) => JSON.parse(op.detail!));
    expect(Object.keys(written[0]).sort()).toEqual(["phase", "updatedAt", "version"]);
    await clearRecoveryRecord();
    expect(await readRecoveryPhase()).toBeNull();
  });

  it("a missing or damaged record reads as no recovery in progress", async () => {
    expect(await readRecoveryPhase()).toBeNull();
    mockFs.set("/data/user/0/app/files/vault-recovery.json", { size: 3, content: "{x" });
    expect(await readRecoveryPhase()).toBeNull();
  });
});
