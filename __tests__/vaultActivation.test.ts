/**
 * Vault activation and plaintext → encrypted migration
 * (services/vault/vaultActivation.ts), against a fake filesystem and a fake
 * SQLCipher that persist across simulated process restarts. Covers fresh
 * creation, migration, reopening, failure and kill -9 at every step,
 * filesystem failures, low storage, verification failures and inconsistent
 * states — and that the legacy plaintext database is never written, moved or
 * deleted on any path.
 */
const DOCS = "/data/user/0/app/files/";
const LEGACY_DIR = "/data/user/0/app/databases/";
const LEGACY = `${LEGACY_DIR}silent-confidant.sqlite`;
const VAULT = `${DOCS}vault/xayra.sqlite`;
const POINTER = `${DOCS}vault-pointer.json`;
const MIGRATION_DIR = `${DOCS}vault-migration`;
const FAULT = `${DOCS}dev-vault-fault.json`;
const HEX = "b".repeat(64);
const RAW = `x'${HEX}'`;
const PLAINTEXT_HEADER = "SQLite format 3\u0000";

type FakeDb = { key: string | null; tables: Record<string, number> };
type FakeFile = { content: string; db?: FakeDb };

const mockFiles = new Map<string, FakeFile>();
const mockDirs = new Set<string>();
const mockOps: { op: string; path: string }[] = [];
const mockSecure = new Map<string, string>();
const mockState = {
  freeBytes: 10 * 1024 ** 3,
  dev: true,
  secureStoreThrows: false,
  exportFails: null as string | null,
  copyCorrupts: false,
  legacyGrowsDuringCopy: false,
  acceptAnyKey: false,
  rowDiff: 0,
  schemaDiff: 0,
};

const mockBare = (uri: string) => uri.replace(/^file:\/\//, "").replace(/\/$/, "");
const mockMd5 = (text: string) => `md5-${text.length}-${[...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`;
const mockIsUnder = (path: string, dir: string) => path === dir || path.startsWith(`${dir}/`);

function mockRecordWrite(op: string, path: string): void {
  mockOps.push({ op, path });
}

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/user/0/app/files/",
  EncodingType: { Base64: "base64" },
  getInfoAsync: jest.fn(async (uri: string) => {
    const path = mockBare(uri);
    const file = mockFiles.get(path);
    if (file) return { exists: true, isDirectory: false, size: file.content.length, md5: mockMd5(file.content) };
    if (mockDirs.has(path)) return { exists: true, isDirectory: true };
    return { exists: false, isDirectory: false };
  }),
  readAsStringAsync: jest.fn(async (uri: string, options?: { encoding?: string; position?: number; length?: number }) => {
    const file = mockFiles.get(mockBare(uri));
    if (!file) throw new Error("ENOENT");
    if (options?.encoding === "base64") {
      const start = options.position ?? 0;
      return Buffer.from(file.content.slice(start, start + (options.length ?? file.content.length)), "latin1").toString("base64");
    }
    return file.content;
  }),
  writeAsStringAsync: jest.fn(async (uri: string, text: string) => {
    mockRecordWrite("write", mockBare(uri));
    mockFiles.set(mockBare(uri), { content: text });
  }),
  makeDirectoryAsync: jest.fn(async (uri: string) => {
    const path = mockBare(uri);
    mockRecordWrite("mkdir", path);
    const parts = path.split("/");
    for (let i = 2; i <= parts.length; i += 1) mockDirs.add(parts.slice(0, i).join("/"));
  }),
  copyAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    mockRecordWrite("copy", mockBare(to));
    const source = mockFiles.get(mockBare(from));
    if (!source) throw new Error("ENOENT");
    const content = mockState.copyCorrupts ? source.content.slice(0, -1) + "#" : source.content;
    mockFiles.set(mockBare(to), { content, db: source.db && { key: source.db.key, tables: { ...source.db.tables } } });
    if (mockState.legacyGrowsDuringCopy && mockBare(from) === "/data/user/0/app/databases/silent-confidant.sqlite") {
      mockFiles.set("/data/user/0/app/databases/silent-confidant.sqlite", { ...source, content: `${source.content}more` });
    }
  }),
  moveAsync: jest.fn(async ({ from, to }: { from: string; to: string }) => {
    const src = mockBare(from);
    const dst = mockBare(to);
    mockRecordWrite("move", dst);
    mockRecordWrite("moveFrom", src);
    let moved = false;
    for (const [path, file] of [...mockFiles]) {
      if (mockIsUnder(path, src)) {
        mockFiles.set(dst + path.slice(src.length), file);
        mockFiles.delete(path);
        moved = true;
      }
    }
    for (const dir of [...mockDirs]) {
      if (mockIsUnder(dir, src)) {
        mockDirs.add(dst + dir.slice(src.length));
        mockDirs.delete(dir);
        moved = true;
      }
    }
    if (!moved) throw new Error("ENOENT");
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    const path = mockBare(uri);
    mockRecordWrite("delete", path);
    for (const key of [...mockFiles.keys()]) if (mockIsUnder(key, path)) mockFiles.delete(key);
    for (const dir of [...mockDirs]) if (mockIsUnder(dir, path)) mockDirs.delete(dir);
  }),
  getFreeDiskStorageAsync: jest.fn(async () => mockState.freeBytes),
}));

jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: jest.fn(async (key: string) => {
    if (mockState.secureStoreThrows) throw new Error("keystore down");
    return mockSecure.get(key) ?? null;
  }),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockSecure.set(key, value);
  }),
}));

jest.mock("expo-crypto", () => ({ getRandomBytesAsync: jest.fn(async () => new Uint8Array(32).fill(0x77)) }));
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));
jest.mock("../services/dev/disposableVault", () => ({ isRunningDevPackage: () => mockState.dev }));
const mockGetKey = jest.fn(async (_options: { allowCreate?: boolean }) => HEX);
jest.mock("../services/crypto/keyManager", () => {
  class DatabaseKeyError extends Error {
    kind: string;
    constructor(kind: string) {
      super(kind);
      this.name = "DatabaseKeyError";
      this.kind = kind;
    }
  }
  return {
    DatabaseKeyError,
    getOrCreateDatabaseKey: (options: { allowCreate?: boolean }) => mockGetKey(options),
    isWellFormedDatabaseKey: (key: string) => /^[0-9a-f]{64}$/.test(key),
  };
});

/** A fake SQLCipher: a file is readable only with the key it was written
 * with (plaintext: no key). Every SQL the module issues is answered here. */
jest.mock("@op-engineering/op-sqlite", () => {
  const notADatabase = () => new Error("[op-sqlite] sqlite query error: file is not a database");
  return {
    ANDROID_DATABASE_PATH: "/data/user/0/app/databases",
    isSQLCipher: () => true,
    open: ({ name, location, encryptionKey }: { name: string; location: string; encryptionKey?: string }) => {
      const path = `${location}/${name}`;
      const key = encryptionKey ?? null;
      const attached: Record<string, { path: string; key: string | null }> = {};
      const file = () => mockFiles.get(path);
      const assertReadable = () => {
        const f = file();
        if (!f) return;
        if (!f.db) throw notADatabase();
        if (!mockState.acceptAnyKey && f.db.key !== key) throw notADatabase();
      };
      const row = (value: unknown) => ({ rows: [{ v: value }] });
      const tablesOf = (schema: string) => (schema === "main" ? file()?.db?.tables ?? {} : mockFiles.get(attached[schema].path)?.db?.tables ?? {});
      return {
        close: jest.fn(),
        execute: jest.fn(async (sql: string, params: unknown[] = []) => {
          assertReadable();
          let m: RegExpMatchArray | null;
          if (sql === "SELECT count(*) FROM sqlite_master") return row(Object.keys(file()?.db?.tables ?? {}).length);
          if ((m = sql.match(/^ATTACH DATABASE \? AS (\w+) KEY (\?|'')$/))) {
            attached[m[1]] = { path: String(params[0]), key: m[2] === "''" ? null : String(params[1]) };
            return { rows: [] };
          }
          if ((m = sql.match(/^DETACH DATABASE (\w+)$/))) {
            delete attached[m[1]];
            return { rows: [] };
          }
          if (sql === "SELECT sqlcipher_export('staged')") {
            if (mockState.exportFails) throw new Error(mockState.exportFails);
            const target = attached.staged;
            mockRecordWrite("sqlite-write", target.path);
            mockFiles.set(target.path, {
              content: `ENC${target.key}${"\u0001".repeat(64)}`,
              db: { key: target.key, tables: { ...(file()?.db?.tables ?? {}) } },
            });
            return { rows: [] };
          }
          if (sql.startsWith("CREATE TABLE IF NOT EXISTS app_settings")) {
            mockRecordWrite("sqlite-write", path);
            if (!file()) mockFiles.set(path, { content: `ENC${key}${"\u0001".repeat(64)}`, db: { key, tables: { app_settings: 0 } } });
            return { rows: [] };
          }
          if (/^PRAGMA (main\.|legacy\.)?user_version$/.test(sql)) return row(0);
          if (sql.startsWith("PRAGMA staged.user_version")) return { rows: [] };
          if (sql === "PRAGMA cipher_integrity_check") return { rows: [] };
          if (sql === "PRAGMA integrity_check") return row("ok");
          if (sql.includes("FROM main.sqlite_master EXCEPT") || sql.includes("FROM legacy.sqlite_master EXCEPT")) return row(mockState.schemaDiff);
          if (sql.startsWith("SELECT name FROM legacy.sqlite_master")) {
            return { rows: Object.keys(tablesOf("legacy")).filter((t) => t !== "note_embeddings").map((name) => ({ name })) };
          }
          if ((m = sql.match(/^SELECT count\(\*\) FROM (main|legacy)\.sqlite_master WHERE type = 'table' AND name = \?$/))) {
            return row(String(params[0]) in tablesOf(m[1]) ? 1 : 0);
          }
          if (sql.includes(" EXCEPT SELECT")) return row(mockState.rowDiff);
          if ((m = sql.match(/^SELECT count\(\*\) FROM (?:(main|legacy)\.)?"?(\w+)"?$/))) return row(tablesOf(m[1] ?? "main")[m[2]] ?? 0);
          if (sql.startsWith("SELECT rowid, embedding FROM note_embeddings")) return { rows: [{ rowid: 1, embedding: new ArrayBuffer(8) }] };
          if (sql.includes("WHERE embedding MATCH ?")) return { rows: [{ rowid: 1 }] };
          if (sql.startsWith("INSERT INTO notes_fts")) return { rows: [] };
          throw new Error(`fake sqlite: unhandled SQL ${sql}`);
        }),
      };
    },
  };
});

type Activation = typeof import("../services/vault/vaultActivation");

/** A new app process: fresh module state (fault spec, etc.), same disk. */
function freshProcess(): Activation {
  let mod!: Activation;
  jest.isolateModules(() => {
    mod = require("../services/vault/vaultActivation");
  });
  return mod;
}

function seedLegacy(tables: Record<string, number> = { notes: 8, todos: 3, note_embeddings: 8, note_embeddings_rowids: 8 }): void {
  mockDirs.add("/data/user/0/app/databases");
  mockFiles.set(LEGACY, { content: `${PLAINTEXT_HEADER}${"p".repeat(4080)}`, db: { key: null, tables } });
}

function legacySnapshot(): string {
  return JSON.stringify(mockFiles.get(LEGACY));
}

function setFault(spec: Record<string, string>): void {
  mockFiles.set(FAULT, { content: JSON.stringify(spec) });
}

function assertLegacyNeverTouched(): void {
  const touched = mockOps.filter((op) => op.path.startsWith(LEGACY_DIR) || op.path === LEGACY_DIR.replace(/\/$/, ""));
  expect(touched).toEqual([]);
}

function pointer(): Record<string, unknown> | null {
  const file = mockFiles.get(POINTER);
  return file ? JSON.parse(file.content) : null;
}

const MARKER = "xayra.vault.encryption-established";
const STEPS = ["prepare", "copy", "export", "verify", "place", "commit"] as const;

beforeEach(() => {
  mockFiles.clear();
  mockDirs.clear();
  mockOps.length = 0;
  mockSecure.clear();
  Object.assign(mockState, {
    freeBytes: 10 * 1024 ** 3,
    dev: true,
    secureStoreThrows: false,
    exportFails: null,
    copyCorrupts: false,
    legacyGrowsDuringCopy: false,
    acceptAnyKey: false,
    rowDiff: 0,
    schemaDiff: 0,
  });
  mockGetKey.mockClear();
  mockDirs.add(DOCS.replace(/\/$/, ""));
  jest.spyOn(console, "log").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => jest.restoreAllMocks());

describe("fresh install", () => {
  it("creates an encrypted vault, commits the pointer, then the marker", async () => {
    const params = await freshProcess().prepareNormalVault();
    expect(params).toEqual({ name: "xayra.sqlite", location: `${DOCS}vault`, encryptionKey: RAW });
    expect(mockGetKey).toHaveBeenCalledWith({ allowCreate: true });
    expect(mockFiles.get(VAULT)?.db?.key).toBe(RAW);
    expect(mockFiles.get(VAULT)!.content.startsWith(PLAINTEXT_HEADER)).toBe(false);
    expect(pointer()).toMatchObject({ version: 1, database: "vault/xayra.sqlite", cipher: "sqlcipher4", keyFormat: "raw-hex-v1", origin: "created" });
    expect(mockSecure.get(MARKER)).toBe("1");
    expect(mockFiles.has(MIGRATION_DIR)).toBe(false);
    assertLegacyNeverTouched();
  });

  it("the next launch opens it without allowing key creation", async () => {
    await freshProcess().prepareNormalVault();
    mockGetKey.mockClear();
    mockOps.length = 0;
    const params = await freshProcess().prepareNormalVault();
    expect(params.encryptionKey).toBe(RAW);
    expect(mockGetKey).toHaveBeenCalledWith({ allowCreate: false });
    expect(mockOps.filter((op) => op.op !== "delete")).toEqual([]); // only idempotent leftover cleanup
  });
});

describe("migrating a legacy plaintext vault", () => {
  it("copies, exports, verifies, places and commits — the original is preserved byte for byte", async () => {
    seedLegacy();
    const before = legacySnapshot();
    await freshProcess().prepareNormalVault();

    expect(legacySnapshot()).toBe(before);
    assertLegacyNeverTouched();
    const vault = mockFiles.get(VAULT)!;
    expect(vault.db).toEqual({ key: RAW, tables: { notes: 8, todos: 3, note_embeddings: 8, note_embeddings_rowids: 8 } });
    expect(pointer()).toMatchObject({ origin: "migrated" });
    expect(mockSecure.get(MARKER)).toBe("1");
    expect([...mockFiles.keys()].some((p) => mockIsUnder(p, MIGRATION_DIR))).toBe(false);

    // Order: vault placed → pointer committed → marker (marker is SecureStore).
    const placeIdx = mockOps.findIndex((op) => op.op === "move" && op.path === `${DOCS}vault`);
    const pointerIdx = mockOps.findIndex((op) => op.op === "move" && op.path === POINTER);
    expect(placeIdx).toBeGreaterThan(-1);
    expect(pointerIdx).toBeGreaterThan(placeIdx);
    const journal = JSON.parse(mockFiles.get(`${DOCS}vault-migration.json`)!.content);
    expect(journal).toMatchObject({ phase: "complete", origin: "migrated", report: { notes: 8, todos: 3, embeddings: 8 } });
    expect(JSON.stringify(journal)).not.toMatch(/pppp/); // no file content in the journal
  });

  it("copies a hot journal with the database, so it's rolled back on the copy, not the original", async () => {
    seedLegacy();
    mockFiles.set(`${LEGACY}-journal`, { content: "hot-journal-bytes" });
    await freshProcess().prepareNormalVault();
    expect(mockOps).toContainEqual({ op: "copy", path: `${MIGRATION_DIR}/legacy-copy/silent-confidant.sqlite-journal` });
    expect(mockFiles.get(`${LEGACY}-journal`)!.content).toBe("hot-journal-bytes");
    assertLegacyNeverTouched();
  });

  it("after migration, the plaintext original is never opened again — even if it changes", async () => {
    seedLegacy();
    await freshProcess().prepareNormalVault();
    mockFiles.set(LEGACY, { content: `${PLAINTEXT_HEADER}changed`, db: { key: null, tables: { notes: 1 } } });
    mockOps.length = 0;
    const params = await freshProcess().prepareNormalVault();
    expect(params.location).toBe(`${DOCS}vault`);
    expect(mockFiles.get(VAULT)!.db!.tables.notes).toBe(8);
    expect(mockOps.some((op) => op.op === "copy")).toBe(false);
  });
});

describe("failure at each step: nothing committed, original intact, the retry succeeds", () => {
  it.each(STEPS)("failAt %s", async (stepName) => {
    seedLegacy();
    const before = legacySnapshot();
    setFault({ failAt: stepName });
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ name: "VaultStateError", kind: "migrationFailed" });
    expect(pointer()).toBeNull();
    expect(mockSecure.has(MARKER)).toBe(false);
    expect(legacySnapshot()).toBe(before);

    mockFiles.delete(FAULT);
    await freshProcess().prepareNormalVault();
    expect(pointer()).toMatchObject({ origin: "migrated" });
    expect(mockFiles.get(VAULT)!.db!.tables.notes).toBe(8);
    expect(legacySnapshot()).toBe(before);
    assertLegacyNeverTouched();
  });

  it.each(["place", "commit"])("the rename itself fails at %s", async (stepName) => {
    seedLegacy();
    setFault({ failRenameAt: stepName });
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "migrationFailed", detail: `${stepName}Failed` });
    expect(pointer()).toBeNull();
    mockFiles.delete(FAULT);
    await freshProcess().prepareNormalVault();
    expect(pointer()).toMatchObject({ origin: "migrated" });
    assertLegacyNeverTouched();
  });

  it.each(["mark", "cleanup"])("a failure after the commit (%s) doesn't fail the open", async (stepName) => {
    seedLegacy();
    setFault({ failAt: stepName });
    await expect(freshProcess().prepareNormalVault()).resolves.toMatchObject({ encryptionKey: RAW });
    expect(pointer()).toMatchObject({ origin: "migrated" });
    mockFiles.delete(FAULT);
    await freshProcess().prepareNormalVault();
    expect(mockSecure.get(MARKER)).toBe("1");
    expect([...mockFiles.keys()].some((p) => mockIsUnder(p, MIGRATION_DIR))).toBe(false);
  });
});

describe("kill -9 after each step: the next launch reaches one consistent committed vault", () => {
  it.each([...STEPS, "mark"])("killed after %s", async (stepName) => {
    seedLegacy();
    const before = legacySnapshot();
    setFault({ pauseAfter: stepName });
    // The process "dies" while paused: its promise never settles.
    const dying = freshProcess().prepareNormalVault();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await Promise.race([dying.then(() => "settled"), Promise.resolve("pending")])).toBe("pending");

    mockFiles.delete(FAULT);
    const params = await freshProcess().prepareNormalVault();
    expect(params).toEqual({ name: "xayra.sqlite", location: `${DOCS}vault`, encryptionKey: RAW });
    expect(pointer()).toMatchObject({ origin: "migrated" });
    expect(mockFiles.get(VAULT)!.db).toEqual({ key: RAW, tables: { notes: 8, todos: 3, note_embeddings: 8, note_embeddings_rowids: 8 } });
    expect(mockSecure.get(MARKER)).toBe("1");
    expect(legacySnapshot()).toBe(before);
    assertLegacyNeverTouched();
  });
});

describe("storage and filesystem failures", () => {
  it("not enough free space: refuses before asking for the key; nothing created", async () => {
    seedLegacy();
    mockState.freeBytes = 1024;
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "insufficientStorage" });
    expect(mockGetKey).not.toHaveBeenCalled();
    expect(mockOps.filter((op) => op.op !== "delete")).toEqual([]);
  });

  it("disk fills during the export: insufficientStorage, nothing committed", async () => {
    seedLegacy();
    mockState.exportFails = "sqlite query error: database or disk is full";
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "insufficientStorage" });
    expect(pointer()).toBeNull();
    assertLegacyNeverTouched();
  });

  it("a corrupted copy (MD5 mismatch) is never exported", async () => {
    seedLegacy();
    mockState.copyCorrupts = true;
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "migrationFailed", detail: "copyMismatch" });
    expect(mockOps.some((op) => op.op === "sqlite-write")).toBe(false);
    expect(pointer()).toBeNull();
  });

  it("the original changing while it's copied aborts the migration", async () => {
    seedLegacy();
    mockState.legacyGrowsDuringCopy = true;
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "migrationFailed", detail: "legacyChangedDuringCopy" });
    expect(pointer()).toBeNull();
  });
});

describe("verification", () => {
  it.each([
    ["a row differs (a note omitted or replaced)", () => (mockState.rowDiff = 1), "verify:rowDiff"],
    ["the schema differs", () => (mockState.schemaDiff = 1), "verify:schemaDiff"],
    ["the staged file opens with the wrong key", () => (mockState.acceptAnyKey = true), "verify:wrongKeyAccepted"],
  ])("refuses to commit when %s", async (_label, arrange, detailPrefix) => {
    seedLegacy();
    arrange();
    const err = (await freshProcess().prepareNormalVault().catch((e: unknown) => e)) as { kind: string; detail: string };
    expect(err.kind).toBe("migrationFailed");
    expect(err.detail.startsWith(detailPrefix)).toBe(true);
    expect(pointer()).toBeNull();
    expect(mockFiles.has(VAULT)).toBe(false);
    assertLegacyNeverTouched();
  });

  it("a different row count (a note silently dropped) is caught", async () => {
    seedLegacy();
    const op = require("@op-engineering/op-sqlite");
    const realOpen = op.open;
    const spy = jest.spyOn(op, "open").mockImplementation((options: unknown) => {
      const o = options as { location: string; name: string };
      const staged = mockFiles.get(`${o.location}/${o.name}`);
      if (staged?.db && o.location.endsWith("/staged")) staged.db.tables.notes = 7;
      return realOpen(options);
    });
    const err = (await freshProcess().prepareNormalVault().catch((e: unknown) => e)) as { kind: string; detail: string };
    spy.mockRestore();
    expect(err).toMatchObject({ kind: "migrationFailed", detail: "verify:rowCount:0" });
    expect(pointer()).toBeNull();
    assertLegacyNeverTouched();
  });
});

describe("inconsistent states fail closed without prompting or deleting", () => {
  it("pointer present but the vault is missing: conflict; the plaintext original is not used", async () => {
    seedLegacy();
    mockFiles.set(POINTER, { content: JSON.stringify({ version: 1, database: "vault/xayra.sqlite", cipher: "sqlcipher4", keyFormat: "raw-hex-v1" }) });
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "conflict", detail: "pointerVaultAbsent" });
    expect(mockGetKey).not.toHaveBeenCalled();
    expect(mockOps).toEqual([]);
  });

  it("marker present but the pointer is gone: conflict; never rebuilt from plaintext", async () => {
    seedLegacy();
    mockSecure.set(MARKER, "1");
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "conflict", detail: "markerWithoutPointer" });
    expect(mockGetKey).not.toHaveBeenCalled();
    expect(mockOps).toEqual([]);
  });

  it("a tampered pointer: conflict", async () => {
    mockFiles.set(POINTER, { content: JSON.stringify({ version: 1, database: "../databases/silent-confidant.sqlite" }) });
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "conflict", detail: "pointerInvalid" });
  });

  it("a plaintext file where the encrypted vault should be is never opened", async () => {
    await freshProcess().prepareNormalVault();
    mockFiles.set(VAULT, { content: `${PLAINTEXT_HEADER}x`, db: { key: null, tables: { notes: 1 } } });
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ kind: "conflict", detail: "vaultNotEncrypted" });
  });

  it("an unreadable marker is not treated as absent", async () => {
    seedLegacy();
    mockState.secureStoreThrows = true;
    await expect(freshProcess().prepareNormalVault()).rejects.toMatchObject({ name: "DatabaseKeyError", kind: "unavailable" });
    expect(mockOps).toEqual([]);
  });
});

describe("development fault injection", () => {
  it("is ignored outside the development packages", async () => {
    seedLegacy();
    mockState.dev = false;
    setFault({ failAt: "export" });
    await expect(freshProcess().prepareNormalVault()).resolves.toMatchObject({ encryptionKey: RAW });
  });
});
