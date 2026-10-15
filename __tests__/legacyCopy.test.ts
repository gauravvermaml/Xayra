/**
 * Removing the old unencrypted database after the migration to encryption
 * (services/vault/legacyCopy.ts): offered only once the encrypted vault is
 * committed, checks the vault first, removes only the known legacy file set,
 * and reports partial failures honestly.
 */
const LEGACY_DIR = "/data/data/app/databases/";
const mockFiles = new Map<string, number>();
const mockUndeletable = new Set<string>();
const mockDeleted: string[] = [];
jest.mock("expo-file-system/legacy", () => ({
  getInfoAsync: async (uri: string) => {
    const path = uri.replace(/^file:\/\//, "");
    return mockFiles.has(path) ? { exists: true, isDirectory: false, size: mockFiles.get(path) } : { exists: false };
  },
  deleteAsync: async (uri: string) => {
    const path = uri.replace(/^file:\/\//, "");
    mockDeleted.push(path);
    if (mockUndeletable.has(path)) throw new Error("EACCES");
    mockFiles.delete(path);
  },
}));
jest.mock("expo-file-system", () => ({
  File: class {
    mockUri: string;
    constructor(uri: string) {
      this.mockUri = uri;
    }
    delete(): void {
      const path = this.mockUri.replace(/^file:\/\//, "");
      mockDeleted.push(path);
      if (mockUndeletable.has(path)) throw new Error("EACCES");
      mockFiles.delete(path);
    }
  },
}));
const mockFacts = { pointer: "valid", vault: "encrypted" };
jest.mock("../services/vault/vaultActivation", () => ({
  LEGACY_DATABASE_NAME: "silent-confidant.sqlite",
  LEGACY_SIDE_FILE_SUFFIXES: ["-journal", "-wal", "-shm"],
  legacyVaultDirectoryPath: () => "/data/data/app/databases/",
  readVaultFacts: async () => ({ ...mockFacts }),
}));
const mockSql: string[] = [];
let mockQuickCheck = "ok";
let mockMissing = { notes: 0, todos: 0 };
jest.mock("../db/client", () => ({
  getRawDatabase: async () => ({
    execute: async (sql: string) => {
      mockSql.push(sql);
      if (/quick_check/.test(sql)) return { rows: [{ quick_check: mockQuickCheck }] };
      if (/sqlite_master/.test(sql)) return { rows: [{ n: 1 }] };
      if (/FROM legacy\.notes/.test(sql)) return { rows: [{ n: mockMissing.notes }] };
      if (/FROM legacy\.todos/.test(sql)) return { rows: [{ n: mockMissing.todos }] };
      return { rows: [] };
    },
  }),
}));

import { checkVaultAgainstLegacy, getLegacyCopyStatus, removeLegacyCopy } from "../services/vault/legacyCopy";

beforeEach(() => {
  mockFiles.clear();
  mockUndeletable.clear();
  mockDeleted.length = 0;
  mockSql.length = 0;
  mockFacts.pointer = "valid";
  mockFacts.vault = "encrypted";
  mockQuickCheck = "ok";
  mockMissing = { notes: 0, todos: 0 };
  mockFiles.set(`${LEGACY_DIR}silent-confidant.sqlite`, 4096);
  mockFiles.set(`${LEGACY_DIR}silent-confidant.sqlite-wal`, 100);
  // Things that must never be touched:
  mockFiles.set("/data/data/app/files/vault/xayra.sqlite", 8192);
  mockFiles.set("/data/data/app/files/vault-pointer.json", 10);
  mockFiles.set("/data/data/app/files/vault-escrow.db", 10);
  mockFiles.set(`${LEGACY_DIR}AsyncStorage`, 10);
});

it("is offered only once the encrypted vault is committed and in use", async () => {
  expect(await getLegacyCopyStatus()).toEqual({ present: true, bytes: 4196 });
  mockFacts.pointer = "absent"; // still mid-migration: the old file is the source
  expect((await getLegacyCopyStatus()).present).toBe(false);
});

it("removes only the old database and its side files — never the vault, pointer, escrow or other files", async () => {
  expect(await removeLegacyCopy()).toEqual({ removed: ["silent-confidant.sqlite", "silent-confidant.sqlite-wal"], failed: [] });
  expect(mockDeleted.every((p) => p.startsWith(`${LEGACY_DIR}silent-confidant.sqlite`))).toBe(true);
  expect(mockFiles.has("/data/data/app/files/vault/xayra.sqlite")).toBe(true);
  expect(mockFiles.has("/data/data/app/files/vault-pointer.json")).toBe(true);
  expect(mockFiles.has("/data/data/app/files/vault-escrow.db")).toBe(true);
  expect(mockFiles.has(`${LEGACY_DIR}AsyncStorage`)).toBe(true);
  expect((await getLegacyCopyStatus()).present).toBe(false);
});

it("reports a partial removal honestly", async () => {
  mockUndeletable.add(`${LEGACY_DIR}silent-confidant.sqlite`);
  expect(await removeLegacyCopy()).toEqual({ removed: ["silent-confidant.sqlite-wal"], failed: ["silent-confidant.sqlite"] });
  expect((await getLegacyCopyStatus()).present).toBe(true);
});

it("checks the encrypted vault first and counts what the old copy holds that the vault doesn't", async () => {
  mockMissing = { notes: 2, todos: 1 };
  expect(await checkVaultAgainstLegacy()).toEqual({ missingNotes: 2, missingTodos: 1 });
  expect(mockSql[0]).toMatch(/quick_check/);
  expect(mockSql.some((q) => /ATTACH DATABASE \? AS legacy KEY ''/.test(q))).toBe(true);
  expect(mockSql[mockSql.length - 1]).toBe("DETACH DATABASE legacy");
  expect(mockSql.some((q) => /^\s*(INSERT|UPDATE|DELETE|DROP)/i.test(q))).toBe(false);
});

it("a vault that fails its integrity check keeps the old copy", async () => {
  mockQuickCheck = "*** in database main ***";
  await expect(checkVaultAgainstLegacy()).rejects.toThrow(/integrity check/);
  expect(mockSql.some((q) => /ATTACH/.test(q))).toBe(false);
});
