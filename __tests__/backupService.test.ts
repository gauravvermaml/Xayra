/**
 * Standard Protection encrypted backup (services/backup/backupService.ts)
 * against an in-memory Google Drive and an in-memory "SQLCipher" adapter:
 * verification gating, generation chains, concurrent heads, keyring races,
 * device entries, account binding, restore, legacy fallback and recovery
 * candidates. Real SQL is exercised on the emulator; this pins the lifecycle.
 */
type DbFile = { kind: "db"; key: string | null; notes: string[]; todos: string[]; rev?: string; device?: { vaultId: string; vaultKeyHex: string } };
type DriveFile = { id: string; name: string; content: string; createdTime: string; appProperties: Record<string, string> };

const mockDrive = new Map<string, DriveFile>();
const mockLocalFs = new Map<string, DbFile>();
const mockOps: string[] = [];
const mockState = {
  clock: 0,
  nextId: 0,
  localNotes: [] as string[],
  localTodos: [] as string[],
  localRev: "r0",
  vaultId: "11111111-1111-1111-1111-111111111111" as string | null,
  vaultKey: "a".repeat(64) as string | null,
  corruptUploadOnce: false,
  wrongKeyAt: null as string | null,
  failAt: null as string | null,
  boundAccount: null as string | null,
};

const mockHash = (text: string) => `h${[...text].reduce((h, c) => (h * 33 + c.charCodeAt(0)) >>> 0, 5381).toString(16)}`;
const mockTick = () => new Date(Date.UTC(2026, 9, 15, 0, 0, mockState.clock++)).toISOString();

jest.mock("../services/backup/driveAppData", () => ({
  listAppDataFiles: jest.fn(async (_t: string, prefix: string) =>
    [...mockDrive.values()]
      .filter((f) => f.name.startsWith(prefix))
      .map((f) => ({ id: f.id, name: f.name, createdTime: f.createdTime, appProperties: { ...f.appProperties }, md5Checksum: mockHash(f.content), size: String(f.content.length), modifiedTime: f.createdTime }))
  ),
  getAppDataFile: jest.fn(async (_t: string, id: string) => {
    const f = mockDrive.get(id)!;
    return { id, name: f.name, md5Checksum: mockHash(f.content), size: String(f.content.length) };
  }),
  createFileFromDisk: jest.fn(async (_t: string, name: string, localUri: string, appProperties: Record<string, string>) => {
    const id = `f${mockState.nextId++}`;
    let content = JSON.stringify(mockLocalFs.get(localUri.replace("file://", ""))!);
    if (mockState.corruptUploadOnce) {
      mockState.corruptUploadOnce = false;
      content = `${content} `;
    }
    mockDrive.set(id, { id, name, content, createdTime: mockTick(), appProperties: { ...appProperties } });
    mockOps.push(`create ${name}`);
    return id;
  }),
  createJsonFile: jest.fn(async (_t: string, name: string, value: unknown, appProperties: Record<string, string>) => {
    const id = `f${mockState.nextId++}`;
    mockDrive.set(id, { id, name, content: JSON.stringify(value), createdTime: mockTick(), appProperties: { ...appProperties } });
    mockOps.push(`create ${name}`);
    return id;
  }),
  downloadToDisk: jest.fn(async (_t: string, id: string, dest: string) => {
    mockLocalFs.set(dest.replace("file://", ""), JSON.parse(mockDrive.get(id)!.content));
  }),
  downloadText: jest.fn(async (_t: string, id: string) => mockDrive.get(id)!.content),
  setAppProperties: jest.fn(async (_t: string, id: string, props: Record<string, string>) => {
    Object.assign(mockDrive.get(id)!.appProperties, props);
    mockOps.push(`props ${mockDrive.get(id)!.name}`);
  }),
  deleteOwnUnreferencedFile: jest.fn(async (_t: string, id: string) => {
    mockOps.push(`delete ${mockDrive.get(id)?.name}`);
    mockDrive.delete(id);
  }),
}));

jest.mock("../services/backup/backupDb", () => {
  const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
  const get = (dir: string, name: string) => mockLocalFs.get(`${dir}/${name}`);
  const need = (file: DbFile | undefined, key: string | null) => {
    if (!file || file.key !== key) throw new Error("file is not a database");
    return file;
  };
  return {
    createStaging: async () => `/stage/${mockState.nextId++}`,
    removeStaging: async () => undefined,
    removeAllStaging: async () => undefined,
    fileMd5: async (path: string) => {
      const content = JSON.stringify(mockLocalFs.get(path));
      return { md5: mockHash(content), size: content.length };
    },
    readLocalIds: async () => ({ noteIds: [...mockState.localNotes], todoIds: [...mockState.localTodos] }),
    writeLocalSnapshot: async (dir: string, out: string, key: string) => {
      mockLocalFs.set(`${dir}/${out}`, { kind: "db", key, notes: [...mockState.localNotes], todos: [...mockState.localTodos], rev: mockState.localRev });
    },
    mergeLocalIntoBase: async (dir: string, base: string, baseKey: string, out: string, outKey: string) => {
      const b = need(get(dir, base), baseKey);
      const addedNotes = mockState.localNotes.filter((n) => !b.notes.includes(n)).length;
      const addedTodos = mockState.localTodos.filter((n) => !b.todos.includes(n)).length;
      const updatedTodos = b.rev === mockState.localRev ? 0 : 1;
      mockLocalFs.set(`${dir}/${out}`, { kind: "db", key: outKey, notes: union(b.notes, mockState.localNotes), todos: union(b.todos, mockState.localTodos), rev: mockState.localRev });
      return { addedNotes, updatedNotes: 0, addedTodos, updatedTodos };
    },
    mergeOtherHeadInto: async (dir: string, base: string, baseKey: string, other: string, otherKey: string) => {
      const b = need(get(dir, base), baseKey);
      const o = need(get(dir, other), otherKey);
      b.notes = union(b.notes, o.notes);
      b.todos = union(b.todos, o.todos);
    },
    contentDigest: async (dir: string, name: string, key: string) => {
      const f = need(get(dir, name), key);
      return mockHash(JSON.stringify([[...f.notes].sort(), [...f.todos].sort(), f.rev ?? ""]));
    },
    inspectBackupFile: async (dir: string, name: string, key: string | null) => {
      const f = need(get(dir, name), key);
      return { noteIds: [...f.notes], todoIds: [...f.todos] };
    },
    readBackupRecords: async (dir: string, name: string, key: string | null) => {
      const f = need(get(dir, name), key);
      return { notes: f.notes.map((id) => ({ id })), todos: f.todos.map((id) => ({ id })) };
    },
    writeDeviceEntry: async (dir: string, name: string, key: string, entry: { vaultId: string; vaultKeyHex: string }) => {
      mockLocalFs.set(`${dir}/${name}`, { kind: "db", key, notes: [], todos: [], device: { vaultId: entry.vaultId, vaultKeyHex: entry.vaultKeyHex } });
    },
    readDeviceEntry: async (dir: string, name: string, key: string) => {
      const f = get(dir, name);
      return f && f.key === key && f.device ? { ...f.device } : null;
    },
  };
});

jest.mock("../services/notes/noteManager", () => ({
  mergeMissingNotes: jest.fn(async (notes: { id: string }[]) => {
    const missing = notes.filter((n) => !mockState.localNotes.includes(n.id));
    mockState.localNotes.push(...missing.map((n) => n.id));
    return missing.length;
  }),
}));
jest.mock("../services/todos/todoManager", () => ({
  mergeMissingToDos: jest.fn(async (todos: { id: string }[]) => {
    const missing = todos.filter((t) => !mockState.localTodos.includes(t.id));
    mockState.localTodos.push(...missing.map((t) => t.id));
    return missing.length;
  }),
}));
jest.mock("../services/vault/vaultIdentity", () => ({
  getOrCreateVaultId: async () => mockState.vaultId ?? "22222222-2222-2222-2222-222222222222",
  readVaultId: async () => mockState.vaultId,
  getSessionVaultKey: () => mockState.vaultKey,
}));
jest.mock("../services/crypto/keyManager", () => ({ isWellFormedDatabaseKey: (k: string) => /^[0-9a-f]{64}$/.test(k) }));
jest.mock("../services/dev/devFaults", () => ({
  devFailAt: async (_s: string, step: string) => {
    if (mockState.failAt === step) throw new Error(`Injected failure at ${step}`);
  },
  devPauseAfter: async () => undefined,
  devWrongKeyAt: async (_s: string, step: string) => mockState.wrongKeyAt === step,
}));
jest.mock("../services/backup/backupAccount", () => ({
  assertAccountAllowed: async (id: string) => {
    if (mockState.boundAccount && mockState.boundAccount !== id) {
      const err = new Error("This phone backs up to a different Google account.");
      err.name = "BackupAccountMismatchError";
      throw err;
    }
  },
  bindIfUnbound: async (id: string) => {
    if (!mockState.boundAccount) mockState.boundAccount = id;
  },
}));
let mockUuid = 0;
jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_a: string, text: string) => mockHash(text).padEnd(64, "0"),
  getRandomBytesAsync: async (n: number) => Uint8Array.from({ length: n }, () => Math.floor(Math.random() * 256)),
  randomUUID: () => `00000000-0000-4000-8000-${String(++mockUuid).padStart(12, "0")}`,
}));
jest.mock("expo-file-system/legacy", () => ({
  EncodingType: { Base64: "base64" },
  readAsStringAsync: async () => Buffer.from("SQLite format 3\u0000", "latin1").toString("base64"),
}));

import { collectRecoveryKeyCandidates, restoreLatestBackup, runEncryptedBackup } from "../services/backup/backupService";

const CTX = { token: "t", accountId: "acct-1" };
const files = (prefix: string) => [...mockDrive.values()].filter((f) => f.name.startsWith(prefix));
const manifests = () => files("xayra2-gen-").filter((f) => f.name.endsWith(".json")).map((f) => ({ ...JSON.parse(f.content), verifiedAt: f.appProperties.verifiedAt }));

beforeEach(() => {
  mockDrive.clear();
  mockLocalFs.clear();
  mockOps.length = 0;
  Object.assign(mockState, {
    clock: 0,
    nextId: 0,
    localNotes: ["n1", "n2"],
    localTodos: ["t1"],
    localRev: "r0",
    vaultId: "11111111-1111-1111-1111-111111111111",
    vaultKey: "a".repeat(64),
    corruptUploadOnce: false,
    wrongKeyAt: null,
    failAt: null,
    boundAccount: null,
  });
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

describe("backup", () => {
  it("first backup: keyring, verified device entry, generation — marked verified only after the independent check", async () => {
    const outcome = await runEncryptedBackup(CTX);
    expect(outcome).toMatchObject({ firstBackup: true, counts: { notes: 2, todos: 1 } });
    expect(files("xayra2-keyring-")).toHaveLength(1);
    expect(files("xayra2-device-11111111")).toHaveLength(1);
    const [m] = manifests();
    expect(m).toMatchObject({ counts: { notes: 2, todos: 1 }, parents: [], vaultId: mockState.vaultId });
    expect(m.verifiedAt).toBe(outcome.verifiedAt);
    // Order: keyring → device → generation db → manifest → verified.
    const order = mockOps.map((op) => op.split(" ")[0] + " " + op.split(" ")[1].replace(/^(xayra2-[a-z]+)-.*(\.(json|db))$/, "$1$2"));
    expect(order).toEqual(["create xayra2-keyring.json", "create xayra2-device.db", "create xayra2-gen.db", "create xayra2-gen.json", "props xayra2-gen.json"]);
    expect(mockState.boundAccount).toBe("acct-1");
  });

  it("never writes legacy files and never deletes anything it didn't just create", async () => {
    await runEncryptedBackup(CTX);
    mockState.localNotes.push("n3");
    await runEncryptedBackup(CTX);
    expect(mockOps.filter((op) => op.includes("remi_backup"))).toEqual([]);
    expect(mockOps.filter((op) => op.startsWith("delete"))).toEqual([]);
  });

  it("second backup builds on the verified head and records it as parent; the device entry isn't duplicated", async () => {
    const first = await runEncryptedBackup(CTX);
    mockState.localNotes.push("n3");
    const second = await runEncryptedBackup(CTX);
    expect(second).toMatchObject({ firstBackup: false, added: { notes: 1, todos: 0 }, counts: { notes: 3, todos: 1 } });
    expect(manifests().find((m) => m.genId === second.genId).parents).toEqual([first.genId]);
    expect(files("xayra2-device-")).toHaveLength(1);
  });

  it("a phone with fewer notes than the backup never shrinks it", async () => {
    await runEncryptedBackup(CTX);
    mockState.localNotes = [];
    const outcome = await runEncryptedBackup(CTX);
    expect(outcome.counts.notes).toBe(2);
  });

  it("an upload that doesn't arrive intact: the run's own file is removed, no manifest, the previous backup stays", async () => {
    const first = await runEncryptedBackup(CTX);
    mockState.localNotes.push("n3");
    mockState.corruptUploadOnce = true;
    await expect(runEncryptedBackup(CTX)).rejects.toThrow(/didn't arrive intact/);
    expect(manifests().map((m) => m.genId)).toEqual([first.genId]);
    expect(files("xayra2-gen-").filter((f) => f.name.endsWith(".db"))).toHaveLength(1);
  });

  it("a failed independent check leaves the new manifest UNverified; restore and later backups ignore it", async () => {
    const first = await runEncryptedBackup(CTX);
    mockState.localNotes.push("n3");
    mockState.wrongKeyAt = "verifyRemote";
    await expect(runEncryptedBackup(CTX)).rejects.toThrow();
    mockState.wrongKeyAt = null;
    const unverified = manifests().filter((m) => !m.verifiedAt);
    expect(unverified).toHaveLength(1);
    mockState.localNotes = [];
    mockState.localTodos = [];
    const restored = await restoreLatestBackup(CTX);
    expect(restored).toMatchObject({ source: "encrypted", restoredNotes: 2 });
    expect(mockState.localNotes.sort()).toEqual(["n1", "n2"]);
    mockState.localNotes.push("n4");
    const next = await runEncryptedBackup(CTX);
    expect(manifests().find((m) => m.genId === next.genId).parents).toEqual([first.genId]);
  });

  it.each(["keyring", "device", "build", "verifyLocal", "uploadDb", "manifest", "verifyRemote", "markVerified"])(
    "interrupted at %s: no new verified generation; the next run succeeds",
    async (stepName) => {
      const first = await runEncryptedBackup(CTX);
      mockState.localNotes.push("n3");
      mockState.failAt = stepName;
      await expect(runEncryptedBackup(CTX)).rejects.toThrow();
      expect(manifests().filter((m) => m.verifiedAt).map((m) => m.genId)).toEqual([first.genId]);
      mockState.failAt = null;
      const next = await runEncryptedBackup(CTX);
      expect(next.counts.notes).toBe(3);
    }
  );

  it("without the session vault key nothing is uploaded", async () => {
    mockState.vaultKey = null;
    await expect(runEncryptedBackup(CTX)).rejects.toThrow(/Unlock Xayra again/);
    expect(files("xayra2-gen-")).toHaveLength(0);
  });

  it("a different signed-in account is refused before any Drive call", async () => {
    await runEncryptedBackup(CTX);
    const before = mockOps.length;
    await expect(runEncryptedBackup({ token: "t", accountId: "acct-2" })).rejects.toThrow(/different Google account/);
    await expect(restoreLatestBackup({ token: "t", accountId: "acct-2" })).rejects.toThrow(/different Google account/);
    expect(mockOps.length).toBe(before);
  });
});

describe("skipping unchanged backups", () => {
  const genDbCount = () => files("xayra2-gen-").filter((f) => f.name.endsWith(".db")).length;

  it("nothing changed: no upload, and the existing verified backup is reported (skipped, its own time)", async () => {
    const first = await runEncryptedBackup(CTX);
    const outcome = await runEncryptedBackup(CTX);
    expect(outcome).toMatchObject({ skipped: true, genId: first.genId, verifiedAt: first.verifiedAt, counts: { notes: 2, todos: 1 } });
    expect(genDbCount()).toBe(1);
  });

  it("same counts but a changed to-do (or edit): uploads — counts are never proof of no change", async () => {
    await runEncryptedBackup(CTX);
    mockState.localRev = "r1";
    const outcome = await runEncryptedBackup(CTX);
    expect(outcome).toMatchObject({ skipped: false, counts: { notes: 2, todos: 1 } });
    expect(genDbCount()).toBe(2);
  });

  it("a new device's recovery entry forces a new generation even with identical content", async () => {
    await runEncryptedBackup(CTX);
    mockState.vaultId = "44444444-4444-4444-4444-444444444444";
    mockState.vaultKey = "f".repeat(64);
    expect((await runEncryptedBackup(CTX)).skipped).toBe(false);
  });

  it("a deleted note doesn't change the backup (backups never drop notes), so nothing is uploaded", async () => {
    await runEncryptedBackup(CTX);
    mockState.localNotes = ["n1"];
    const outcome = await runEncryptedBackup(CTX);
    expect(outcome).toMatchObject({ skipped: true, counts: { notes: 2 } });
  });
});

describe("multiple devices", () => {
  it("each phone adds only its own device entry", async () => {
    await runEncryptedBackup(CTX);
    mockState.vaultId = "33333333-3333-3333-3333-333333333333";
    mockState.vaultKey = "c".repeat(64);
    await runEncryptedBackup(CTX);
    expect(files("xayra2-device-").map((f) => f.name.slice(14, 22)).sort()).toEqual(["11111111", "33333333"]);
  });

  it("concurrent backups from two phones: both kept; the next run merges both heads", async () => {
    const base = await runEncryptedBackup(CTX);
    // Phone B backs up from the same base before phone A's second backup.
    const baseManifest = files("xayra2-gen-").find((f) => f.name.endsWith(".json"))!;
    mockState.localNotes = ["n1", "n2", "b1"];
    const fromB = await runEncryptedBackup(CTX);
    // Simulate phone A uploading concurrently from the same base: rewrite
    // B's parents race by making A's generation also list only `base`.
    mockState.localNotes = ["n1", "n2", "a1"];
    const bManifestFile = files("xayra2-gen-").find((f) => f.name.includes(fromB.genId) && f.name.endsWith(".json"))!;
    const savedVerified = bManifestFile.appProperties.verifiedAt;
    delete bManifestFile.appProperties.verifiedAt; // A doesn't see B yet
    const fromA = await runEncryptedBackup(CTX);
    bManifestFile.appProperties.verifiedAt = savedVerified; // B's arrives
    expect(manifests().find((m) => m.genId === fromA.genId).parents).toEqual([base.genId]);
    // Next run on either phone merges both heads.
    mockState.localNotes = [];
    const merged = await runEncryptedBackup(CTX);
    const m = manifests().find((x) => x.genId === merged.genId);
    expect(m.parents.sort()).toEqual([fromA.genId, fromB.genId].sort());
    expect(merged.counts.notes).toBe(4); // n1, n2, a1, b1
    expect(baseManifest).toBeDefined();
  });

  it("keyring race: two phones create keyrings at once → both use the oldest; the loser's own file is removed", async () => {
    const drive = require("../services/backup/driveAppData");
    const original = drive.createJsonFile.getMockImplementation();
    drive.createJsonFile.mockImplementationOnce(async (t: string, name: string, value: unknown, props: Record<string, string>) => {
      // Another phone's keyring lands first.
      const other = { format: "xayra-keyring", version: 1, mode: "standard", keyId: "99999999-9999-4999-8999-999999999999", key: "d".repeat(64), createdAt: "x" };
      mockDrive.set("other", { id: "other", name: `xayra2-keyring-${other.keyId}.json`, content: JSON.stringify(other), createdTime: "2000-01-01T00:00:00.000Z", appProperties: {} });
      return original(t, name, value, props);
    });
    await runEncryptedBackup(CTX);
    expect(files("xayra2-keyring-").map((f) => f.id)).toEqual(["other"]);
    expect(manifests()[0].keyId).toBe("99999999-9999-4999-8999-999999999999");
  });
});

describe("restore", () => {
  it("fresh install: restores every note and to-do from the newest verified generation", async () => {
    await runEncryptedBackup(CTX);
    mockState.localNotes = [];
    mockState.localTodos = [];
    mockState.boundAccount = null;
    const outcome = await restoreLatestBackup(CTX);
    expect(outcome).toMatchObject({ source: "encrypted", restoredNotes: 2, restoredTodos: 1 });
    expect(mockState.boundAccount).toBe("acct-1");
  });

  it("re-verifies the generation before merging: a wrong key restores nothing", async () => {
    await runEncryptedBackup(CTX);
    mockState.localNotes = [];
    mockState.wrongKeyAt = "verifyRemote";
    await expect(restoreLatestBackup(CTX)).rejects.toThrow("The backup couldn't be opened and checked, so it wasn't used.");
    expect(mockState.localNotes).toEqual([]);
  });

  it("falls back to the legacy backup (read-only) only when there is no encrypted one", async () => {
    mockDrive.set("legacy", {
      id: "legacy",
      name: "remi_backup.db",
      content: JSON.stringify({ kind: "db", key: null, notes: ["old1"], todos: [] }),
      createdTime: "2026-10-14T00:00:00.000Z",
      appProperties: {},
    });
    mockState.localNotes = [];
    const outcome = await restoreLatestBackup(CTX);
    expect(outcome).toMatchObject({ source: "legacy", restoredNotes: 1 });
    expect(mockDrive.get("legacy")!.content).toContain("old1");
    expect(mockOps).toEqual([]);
  });

  it("no backup at all → NoBackupFoundError", async () => {
    await expect(restoreLatestBackup(CTX)).rejects.toMatchObject({ name: "NoBackupFoundError" });
  });
});

describe("recovery candidates", () => {
  it("this phone's entry first, then other phones', then the legacy key", async () => {
    await runEncryptedBackup(CTX);
    mockState.vaultId = "33333333-3333-3333-3333-333333333333";
    mockState.vaultKey = "c".repeat(64);
    await runEncryptedBackup(CTX);
    mockDrive.set("lk", { id: "lk", name: "remi_backup.key", content: "e".repeat(64), createdTime: "x", appProperties: {} });
    mockState.vaultId = "11111111-1111-1111-1111-111111111111";
    expect(await collectRecoveryKeyCandidates("t")).toEqual(["a".repeat(64), "c".repeat(64), "e".repeat(64)]);
  });
});
