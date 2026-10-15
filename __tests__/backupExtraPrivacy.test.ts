/**
 * Extra Privacy (services/backup/backupService.ts): activation, mode
 * transitions, recovery-code protection, rotation, retirement of older
 * Google-only backups, multiple phones and recovery — against an in-memory
 * Google Drive, "SQLCipher" and protection store that persist across runs.
 */
type DbFile = { kind: "db"; key: string | null; notes: string[]; todos: string[]; rev?: string; device?: { vaultId: string; vaultKeyHex: string }; secret?: Record<string, string> };
type DriveFile = { id: string; name: string; content: string; createdTime: string; appProperties: Record<string, string> };

const mockDrive = new Map<string, DriveFile>();
const mockLocalFs = new Map<string, DbFile>();
const mockOps: string[] = [];
const mockProtection = {
  local: { mode: "standard" } as Record<string, unknown>,
  extraKey: null as null | { keyId: string; key: string; mode: string },
  escrow: null as null | { code: string; contents: any },
};
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
  deleteAppDataFile: jest.fn(async (_t: string, id: string) => {
    mockOps.push(`userDelete ${mockDrive.get(id)?.name}`);
    mockDrive.delete(id);
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
    writeSecretContainer: async (dir: string, name: string, key: string, values: Record<string, string>) => {
      mockLocalFs.set(`${dir}/${name}`, { kind: "db", key, notes: [], todos: [], secret: { ...values } });
    },
    readSecretContainer: async (dir: string, name: string, key: string) => {
      const f = get(dir, name);
      return f && f.key === key && f.secret ? { ...f.secret } : null;
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
jest.mock("../services/backup/protection", () => ({
  readLocalProtection: async () => ({ ...mockProtection.local }),
  writeLocalProtection: async (state: Record<string, unknown>) => {
    mockProtection.local = { ...state };
  },
  readExtraKey: async () => (mockProtection.extraKey ? { ...mockProtection.extraKey } : null),
  storeExtraKey: async (key: { keyId: string; key: string; mode: string }) => {
    mockProtection.extraKey = { ...key };
  },
  writeEscrow: async (code: string, contents: unknown) => {
    mockProtection.escrow = { code, contents: JSON.parse(JSON.stringify(contents)) };
  },
  readEscrow: async (code: string) => (mockProtection.escrow && mockProtection.escrow.code === code ? mockProtection.escrow.contents : null),
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


import {
  activateExtraPrivacy,
  collectRecoveryKeyCandidates,
  joinWithRecoveryCode,
  replaceRecoveryCode,
  restoreExtraKeyFromEscrow,
  restoreLatestBackup,
  retireStandardBackups,
  runEncryptedBackup,
  switchToStandard,
} from "../services/backup/backupService";

const CTX = { token: "t", accountId: "acct-1" };
const CODE = "AAAABBBBCCCCDDDDEEEEFFFFGGGG";
const NEW_CODE = "HHHHJJJJKKKKMMMMNNNNPPPPQQQQ";
const files = (prefix: string) => [...mockDrive.values()].filter((f) => f.name.startsWith(prefix));
const manifests = () =>
  files("xayra2-gen-")
    .filter((f) => f.name.endsWith(".json"))
    .map((f) => ({ ...JSON.parse(f.content), verifiedAt: f.appProperties.verifiedAt, createdTime: f.createdTime }));
const verified = () => manifests().filter((m) => m.verifiedAt);
const modes = () => files("xayra2-mode-").map((f) => JSON.parse(f.content).mode);
const extraKeyId = () => mockProtection.extraKey!.keyId;

/** A phone that has never held the Extra Privacy key (new install). */
function newPhone(vault: string, key: string) {
  mockProtection.extraKey = null;
  mockProtection.escrow = null;
  mockProtection.local = { mode: "standard" };
  mockState.vaultId = vault;
  mockState.vaultKey = key;
  mockState.localNotes = [];
  mockState.localTodos = [];
}

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
  mockProtection.local = { mode: "standard" };
  mockProtection.extraKey = null;
  mockProtection.escrow = null;
  jest.spyOn(console, "log").mockImplementation(() => undefined);
});
afterEach(() => jest.restoreAllMocks());

async function standardThenExtra() {
  await runEncryptedBackup(CTX); // a Standard backup exists first
  mockState.localNotes.push("n3");
  return activateExtraPrivacy(CTX, CODE);
}

describe("turning on Extra Privacy", () => {
  it("protects new backups with the code; the generation is verified only after the mode commit; Standard backups untouched", async () => {
    const outcome = await standardThenExtra();
    expect(outcome).toMatchObject({ mode: "extra", counts: { notes: 3, todos: 1 } });
    expect(modes()).toEqual(["extra"]);
    const xk = files("xayra2-xkeyring-");
    expect(xk).toHaveLength(1);
    expect(JSON.parse(xk[0].content)).toMatchObject({ key: CODE }); // opened only with the code
    expect(xk[0].appProperties.verifiedAt).toBeDefined();
    const extraGens = verified().filter((m) => m.keyId === extraKeyId());
    expect(extraGens).toHaveLength(1);
    expect(verified().filter((m) => m.keyId !== extraKeyId())).toHaveLength(1); // old Standard backup kept
    const commitIdx = mockOps.findIndex((op) => op.startsWith("create xayra2-mode-"));
    const markIdx = mockOps.findIndex((op, i) => i > commitIdx && op.startsWith("props xayra2-gen-"));
    expect(commitIdx).toBeGreaterThan(-1);
    expect(markIdx).toBeGreaterThan(commitIdx);
    expect(mockProtection.extraKey?.keyId).toBe(extraGens[0].keyId);
    expect(mockProtection.escrow?.code).toBe(CODE);
    expect(mockProtection.escrow?.contents.vaultKeyHex).toBe("a".repeat(64));
    expect(mockProtection.local).toMatchObject({ mode: "extra", state: "active" });
    expect(mockOps.filter((op) => op.startsWith("userDelete") || op.startsWith("delete"))).toEqual([]);
  });

  it("this phone's device entry for Extra Privacy is a separate file encrypted with the new key", async () => {
    await standardThenExtra();
    const entries = files("xayra2-device-");
    expect(entries).toHaveLength(2);
    expect(entries.some((f) => f.name.endsWith(`-${extraKeyId().slice(0, 8)}.db`))).toBe(true);
  });

  it.each(["xkeyring", "storeKey", "device", "build", "verifyLocal", "uploadDb", "manifest", "verifyRemote", "escrow", "commitMode"])(
    "interrupted at %s: the account stays on Standard and Google-only restore still works",
    async (stepName) => {
      await runEncryptedBackup(CTX);
      mockState.localNotes.push("n3");
      mockState.failAt = stepName;
      await expect(activateExtraPrivacy(CTX, CODE)).rejects.toThrow();
      mockState.failAt = null;
      expect(modes()).toEqual([]);
      expect(verified().every((m) => files("xayra2-keyring-").some((k) => JSON.parse(k.content).keyId === m.keyId))).toBe(true);
      newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
      await expect(restoreLatestBackup(CTX)).resolves.toMatchObject({ mode: "standard", restoredNotes: 2 });
      // And trying again succeeds.
      mockState.vaultId = "11111111-1111-1111-1111-111111111111";
      mockState.vaultKey = "a".repeat(64);
      await expect(activateExtraPrivacy(CTX, CODE)).resolves.toMatchObject({ mode: "extra" });
    }
  );

  it("interrupted after the commit (before marking verified): the next backup finishes it under Extra Privacy", async () => {
    await runEncryptedBackup(CTX);
    mockState.failAt = "markVerified";
    await expect(activateExtraPrivacy(CTX, CODE)).rejects.toThrow();
    mockState.failAt = null;
    expect(modes()).toEqual(["extra"]);
    expect(mockProtection.local).toMatchObject({ state: "activating" });
    mockState.localNotes.push("n4");
    const next = await runEncryptedBackup(CTX);
    expect(next.mode).toBe("extra");
    expect(mockProtection.local).toMatchObject({ mode: "extra", state: "active" });
  });

  it("is refused when Extra Privacy is already on", async () => {
    await standardThenExtra();
    await expect(activateExtraPrivacy(CTX, NEW_CODE)).rejects.toThrow(/already on/);
  });
});

describe("restoring Extra Privacy backups", () => {
  it("Google access alone is not enough; a wrong code is refused; the right code restores and adopts the key", async () => {
    await standardThenExtra();
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX)).rejects.toMatchObject({ name: "RecoveryCodeRequiredError" });
    expect(mockState.localNotes).toEqual([]);
    await expect(restoreLatestBackup(CTX, { recoveryCode: NEW_CODE })).rejects.toMatchObject({ name: "RecoveryCodeIncorrectError" });
    expect(mockState.localNotes).toEqual([]);
    const outcome = await restoreLatestBackup(CTX, { recoveryCode: CODE });
    expect(outcome).toMatchObject({ mode: "extra", restoredNotes: 3, restoredTodos: 1 });
    expect(mockProtection.extraKey?.keyId).toBeDefined();
    expect(mockProtection.local).toMatchObject({ mode: "extra", state: "active" });
  });

  it("a trusted phone (holding the key behind its fingerprint) restores without the code", async () => {
    await standardThenExtra();
    mockState.localNotes = [];
    await expect(restoreLatestBackup(CTX)).resolves.toMatchObject({ mode: "extra", restoredNotes: 3 });
  });
});

describe("other phones", () => {
  it("a phone without the key refuses to back up (no new Google-readable backups), then joins with the code", async () => {
    await standardThenExtra();
    newPhone("33333333-3333-3333-3333-333333333333", "c".repeat(64));
    mockState.localNotes = ["p1"];
    const before = files("xayra2-gen-").length;
    await expect(runEncryptedBackup(CTX)).rejects.toMatchObject({ name: "ExtraPrivacyKeyNeededError" });
    expect(files("xayra2-gen-").length).toBe(before);
    expect(files("xayra2-keyring-")).toHaveLength(1); // no new Standard key created
    await expect(joinWithRecoveryCode(CTX, NEW_CODE)).rejects.toMatchObject({ name: "RecoveryCodeIncorrectError" });
    await joinWithRecoveryCode(CTX, CODE);
    const outcome = await runEncryptedBackup(CTX);
    expect(outcome).toMatchObject({ mode: "extra", counts: { notes: 4 } });
    expect(files("xayra2-device-").filter((f) => f.name.includes("33333333"))).toHaveLength(1);
  });
});

describe("replacing the recovery code", () => {
  it("the same key under the new code (verified), escrow rewritten, the old code retired; backups untouched", async () => {
    await standardThenExtra();
    const gensBefore = files("xayra2-gen-").length;
    await replaceRecoveryCode(CTX, NEW_CODE);
    const xk = files("xayra2-xkeyring-");
    expect(xk.map((f) => f.name.match(/-e(\d+)\.db$/)![1])).toEqual(["2"]);
    expect(mockProtection.escrow?.code).toBe(NEW_CODE);
    expect(files("xayra2-gen-").length).toBe(gensBefore);
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX, { recoveryCode: CODE })).rejects.toMatchObject({ name: "RecoveryCodeIncorrectError" });
    await expect(restoreLatestBackup(CTX, { recoveryCode: NEW_CODE })).resolves.toMatchObject({ restoredNotes: 3 });
  });

  it("committed but the old code couldn't be removed yet: reported, and the next backup removes it", async () => {
    await standardThenExtra();
    mockState.failAt = "retireOldCode";
    await expect(replaceRecoveryCode(CTX, NEW_CODE)).resolves.toEqual({ oldCodeRemoved: false });
    mockState.failAt = null;
    expect(mockProtection.escrow?.code).toBe(NEW_CODE);
    expect(files("xayra2-xkeyring-")).toHaveLength(2);
    mockState.localNotes.push("n9");
    await runEncryptedBackup(CTX);
    expect(files("xayra2-xkeyring-").map((f) => f.name.match(/-e(\d+)\.db$/)![1])).toEqual(["2"]);
    expect(mockProtection.local).not.toHaveProperty("retireBelowEpoch", expect.anything());
  });

  it("failed before it committed: the new code is withdrawn and later backups never retire the old one", async () => {
    await standardThenExtra();
    mockState.failAt = "escrow";
    await expect(replaceRecoveryCode(CTX, NEW_CODE)).rejects.toThrow();
    mockState.failAt = null;
    expect(mockProtection.escrow?.code).toBe(CODE);
    expect(files("xayra2-xkeyring-").map((f) => f.name.match(/-e(\d+)\.db$/)![1])).toEqual(["1"]);
    mockState.localNotes.push("n9");
    await runEncryptedBackup(CTX);
    expect(files("xayra2-xkeyring-").map((f) => f.name.match(/-e(\d+)\.db$/)![1])).toEqual(["1"]);
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX, { recoveryCode: NEW_CODE })).rejects.toMatchObject({ name: "RecoveryCodeIncorrectError" });
    await expect(restoreLatestBackup(CTX, { recoveryCode: CODE })).resolves.toMatchObject({ restoredNotes: 4 });
  });

  it("interrupted before the new code verified: the old code keeps working", async () => {
    await standardThenExtra();
    mockState.failAt = "xkeyring";
    await expect(replaceRecoveryCode(CTX, NEW_CODE)).rejects.toThrow();
    mockState.failAt = null;
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX, { recoveryCode: CODE })).resolves.toMatchObject({ restoredNotes: 3 });
  });
});

describe("retiring older Google-only backups", () => {
  it("is the user's explicit action; keeps the verified Extra Privacy backup; removes Standard backups, key, entries and legacy", async () => {
    mockDrive.set("legacyDb", { id: "legacyDb", name: "remi_backup.db", content: JSON.stringify({ kind: "db", key: null, notes: ["old"], todos: [] }), createdTime: "2000", appProperties: {} });
    mockDrive.set("legacyKey", { id: "legacyKey", name: "remi_backup.key", content: "e".repeat(64), createdTime: "2000", appProperties: {} });
    await standardThenExtra();
    const result = await retireStandardBackups(CTX, { includeLegacy: true });
    expect(result).toMatchObject({ generations: 1, keyrings: 1, legacyFiles: 2 });
    expect(files("xayra2-keyring-")).toHaveLength(0);
    expect(files("remi_backup")).toHaveLength(0);
    expect(verified().map((m) => m.keyId)).toEqual([extraKeyId()]);
    expect(files("xayra2-device-").every((f) => f.name.endsWith(`-${extraKeyId().slice(0, 8)}.db`))).toBe(true);
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX)).rejects.toMatchObject({ name: "RecoveryCodeRequiredError" });
    await expect(restoreLatestBackup(CTX, { recoveryCode: CODE })).resolves.toMatchObject({ restoredNotes: 3 });
  });

  it("is refused (nothing removed) while no verified Extra Privacy backup exists", async () => {
    await runEncryptedBackup(CTX);
    mockState.failAt = "markVerified";
    await activateExtraPrivacy(CTX, CODE).catch(() => undefined);
    mockState.failAt = null;
    await expect(retireStandardBackups(CTX, { includeLegacy: true })).rejects.toThrow(/no verified Extra Privacy backup/);
    expect(files("xayra2-keyring-")).toHaveLength(1);
    expect(mockOps.filter((op) => op.startsWith("userDelete"))).toEqual([]);
  });

  it("is refused when the protected backup no longer verifies", async () => {
    await standardThenExtra();
    mockState.wrongKeyAt = "verifyRemote";
    await expect(retireStandardBackups(CTX, { includeLegacy: true })).rejects.toThrow();
    expect(mockOps.filter((op) => op.startsWith("userDelete"))).toEqual([]);
  });
});

describe("switching back to Standard", () => {
  it("creates and verifies a Standard backup, then commits; Google-only restore works again", async () => {
    await standardThenExtra();
    mockState.localNotes.push("n5");
    const outcome = await switchToStandard(CTX);
    expect(outcome).toMatchObject({ mode: "standard", counts: { notes: 4 } });
    expect(modes().sort()).toEqual(["extra", "standard"]);
    expect(mockProtection.local).toMatchObject({ mode: "standard" });
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX)).resolves.toMatchObject({ mode: "standard", restoredNotes: 4 });
  });

  it("interrupted before the commit: Extra Privacy stays on", async () => {
    await standardThenExtra();
    mockState.failAt = "commitMode";
    await expect(switchToStandard(CTX)).rejects.toThrow();
    mockState.failAt = null;
    expect(modes()).toEqual(["extra"]);
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX)).rejects.toMatchObject({ name: "RecoveryCodeRequiredError" });
  });

  it("interrupted after the commit: reported as unfinished, still recoverable, and the next backup finishes it", async () => {
    await standardThenExtra();
    mockState.failAt = "markVerified";
    await expect(switchToStandard(CTX)).rejects.toMatchObject({ name: "ProtectionChangeUnfinishedError", mode: "standard" });
    mockState.failAt = null;
    expect(modes().sort()).toEqual(["extra", "standard"]);
    // The newest verified backup is still the Extra Privacy one: this phone's
    // own key opens it, so the next Standard backup merges it and finishes.
    const outcome = await runEncryptedBackup(CTX);
    expect(outcome).toMatchObject({ mode: "standard", skipped: false });
    newPhone("22222222-2222-2222-2222-222222222222", "b".repeat(64));
    await expect(restoreLatestBackup(CTX)).resolves.toMatchObject({ mode: "standard", restoredNotes: 3 });
  });
});

describe("recovery after a fingerprint change", () => {
  it("with the code: this phone's escrow first (works offline), then the protected device entries", async () => {
    await standardThenExtra();
    expect(await collectRecoveryKeyCandidates(null, { recoveryCode: CODE })).toEqual(["a".repeat(64)]);
    expect(await collectRecoveryKeyCandidates(null, { recoveryCode: NEW_CODE })).toEqual([]);
    const online = await collectRecoveryKeyCandidates("t", { recoveryCode: CODE });
    expect(online[0]).toBe("a".repeat(64));
  });

  it("without the code, only Standard entries are found — never the Extra Privacy ones", async () => {
    await runEncryptedBackup(CTX);
    await activateExtraPrivacy(CTX, CODE);
    await retireStandardBackups(CTX, { includeLegacy: true });
    expect(await collectRecoveryKeyCandidates("t")).toEqual([]);
  });

  it("puts the Extra Privacy key back behind the fingerprint from the escrow", async () => {
    await standardThenExtra();
    mockProtection.extraKey = null;
    expect(await restoreExtraKeyFromEscrow(NEW_CODE)).toBe(false);
    expect(await restoreExtraKeyFromEscrow(CODE)).toBe(true);
    expect(mockProtection.extraKey).not.toBeNull();
  });
});
