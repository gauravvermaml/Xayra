/**
 * Xayra Dev disposable test vault (services/dev/disposableVault.ts): who can
 * enter it, how, and that it stays isolated from the normal vault.
 * Every test runs in a fresh module registry (`jest.isolateModules`) — the
 * equivalent of a new app process, since the mode is resolved once per process.
 */
const DOCS = "file:///data/user/0/app/files/";
const DEV = "com.anonymous.silentconfidant.dev";
const PROD = "com.anonymous.silentconfidant";
const MARKER = `${DOCS}dev-disposable-vault.json`;
const DISPOSABLE_DIR = `${DOCS}disposable-vault/`;

let mockPackage: string | (() => string) = PROD;
const mockFiles = new Map<string, string>();
const mockDeleted: string[] = [];
const mockWritten: string[] = [];
let mockRandomFill = 1;

jest.mock("expo-app-signature", () => ({
  getRuntimePackageName: () => (typeof mockPackage === "function" ? mockPackage() : mockPackage),
}));
jest.mock("expo-crypto", () => ({
  getRandomBytesAsync: jest.fn(async () => new Uint8Array(32).fill(mockRandomFill++)),
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/user/0/app/files/",
  getInfoAsync: jest.fn(async (path: string) => ({ exists: mockFiles.has(path) })),
  readAsStringAsync: jest.fn(async (path: string) => {
    if (!mockFiles.has(path)) throw new Error("ENOENT");
    return mockFiles.get(path);
  }),
  writeAsStringAsync: jest.fn(async (path: string, text: string) => {
    mockWritten.push(path);
    mockFiles.set(path, text);
  }),
  deleteAsync: jest.fn(async (path: string) => {
    mockDeleted.push(path);
    mockFiles.delete(path);
  }),
  makeDirectoryAsync: jest.fn(async () => undefined),
}));
const mockSecureStore = { getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn() };
jest.mock("expo-secure-store", () => mockSecureStore);

type DisposableModule = typeof import("../services/dev/disposableVault");

/** A fresh "app process". */
function freshProcess(): DisposableModule {
  let mod!: DisposableModule;
  jest.isolateModules(() => {
    mod = require("../services/dev/disposableVault");
  });
  return mod;
}

function writeValidMarker(): void {
  mockFiles.set(MARKER, JSON.stringify({ version: 1, package: DEV, confirmedAt: "2026-10-14T00:00:00Z" }));
}

beforeEach(() => {
  mockPackage = PROD;
  mockFiles.clear();
  mockDeleted.length = 0;
  mockWritten.length = 0;
  jest.clearAllMocks();
});

describe("which process can be a disposable vault", () => {
  it("production: always normal, even with a valid marker — and never reads it", async () => {
    writeValidMarker();
    const FileSystem = require("expo-file-system/legacy");
    const vault = freshProcess();
    expect(await vault.resolveVaultMode()).toBe("normal");
    expect(FileSystem.readAsStringAsync).not.toHaveBeenCalled();
  });

  it("production: an unreadable package name counts as not-Dev", async () => {
    mockPackage = () => {
      throw new Error("PackageManager unavailable");
    };
    writeValidMarker();
    expect(await freshProcess().resolveVaultMode()).toBe("normal");
  });

  it("Xayra Dev without a marker: normal", async () => {
    mockPackage = DEV;
    expect(await freshProcess().resolveVaultMode()).toBe("normal");
  });

  it("Xayra Dev with a valid marker: disposable", async () => {
    mockPackage = DEV;
    writeValidMarker();
    expect(await freshProcess().resolveVaultMode()).toBe("disposable");
  });

  it("Xayra Test (.devtest) counts as a development package; its marker must name it", async () => {
    mockPackage = "com.anonymous.silentconfidant.devtest";
    mockFiles.set(MARKER, JSON.stringify({ version: 1, package: "com.anonymous.silentconfidant.devtest" }));
    expect(await freshProcess().resolveVaultMode()).toBe("disposable");
    // A marker naming another package (e.g. copied from Xayra Dev) is ignored.
    mockFiles.set(MARKER, JSON.stringify({ version: 1, package: DEV }));
    expect(await freshProcess().resolveVaultMode()).toBe("normal");
  });

  it("entering writes the running package's own name into the marker", async () => {
    mockPackage = "com.anonymous.silentconfidant.devtest";
    const vault = freshProcess();
    await vault.enterDisposableModeOnNextStart(vault.DISPOSABLE_CONFIRMATION);
    expect(JSON.parse(mockFiles.get(MARKER)!).package).toBe("com.anonymous.silentconfidant.devtest");
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["wrong version", JSON.stringify({ version: 2, package: DEV })],
    ["another package", JSON.stringify({ version: 1, package: PROD })],
    ["empty", ""],
  ])("Xayra Dev with an invalid marker (%s): normal", async (_label, text) => {
    mockPackage = DEV;
    mockFiles.set(MARKER, text);
    expect(await freshProcess().resolveVaultMode()).toBe("normal");
  });
});

describe("entering and leaving", () => {
  it("production can't enter, even with the confirmation phrase — nothing is written", async () => {
    const vault = freshProcess();
    await expect(vault.enterDisposableModeOnNextStart(vault.DISPOSABLE_CONFIRMATION)).rejects.toThrow(/only available in Xayra Dev/);
    expect(mockWritten).toEqual([]);
  });

  it("Xayra Dev needs the explicit confirmation", async () => {
    mockPackage = DEV;
    const vault = freshProcess();
    await expect(vault.enterDisposableModeOnNextStart("yes")).rejects.toThrow(/explicit confirmation/);
    expect(mockWritten).toEqual([]);
  });

  it("entering takes effect on the next start, not in the running process", async () => {
    mockPackage = DEV;
    const running = freshProcess();
    expect(await running.resolveVaultMode()).toBe("normal");
    await running.enterDisposableModeOnNextStart(running.DISPOSABLE_CONFIRMATION);
    expect(mockWritten).toEqual([MARKER]);
    expect(await running.resolveVaultMode()).toBe("normal"); // unchanged until restart
    expect(await running.isDisposableModeSetForNextStart()).toBe(true);
    expect(await freshProcess().resolveVaultMode()).toBe("disposable"); // after restart
  });

  it("leaving deletes only the marker, and the next start is normal", async () => {
    mockPackage = DEV;
    writeValidMarker();
    const disposable = freshProcess();
    expect(await disposable.resolveVaultMode()).toBe("disposable");
    await disposable.leaveDisposableModeOnNextStart();
    expect(mockDeleted).toEqual([MARKER]);
    expect(await freshProcess().resolveVaultMode()).toBe("normal");
  });
});

describe("isolation", () => {
  it("its key is random, in memory only, never SecureStore — and dies with the process", async () => {
    const first = freshProcess();
    const key = await first.getDisposableVaultKey();
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(await first.getDisposableVaultKey()).toBe(key); // stable within a process
    expect(await freshProcess().getDisposableVaultKey()).not.toBe(key); // new process, new key
    expect(mockSecureStore.getItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(mockSecureStore.deleteItemAsync).not.toHaveBeenCalled();
  });

  it("its storage is a separate folder and file; preparing it only touches that folder", async () => {
    const vault = freshProcess();
    expect(vault.DISPOSABLE_DATABASE_NAME).not.toBe("silent-confidant.sqlite");
    const location = await vault.prepareDisposableVaultStorage();
    expect(location).toBe("/data/user/0/app/files/disposable-vault");
    expect(mockDeleted.length).toBeGreaterThan(0);
    for (const path of mockDeleted) {
      expect(path.startsWith(DISPOSABLE_DIR)).toBe(true);
      expect(path).not.toContain("silent-confidant.sqlite");
    }
  });

  it("Drive and Calendar are refused in a disposable vault and allowed in a normal one", async () => {
    mockPackage = DEV;
    writeValidMarker();
    const disposable = freshProcess();
    await expect(disposable.assertNetworkFeatureAllowed("Google Drive backup")).rejects.toBeInstanceOf(
      disposable.DisposableModeError
    );
    mockFiles.clear();
    const normal = freshProcess();
    await expect(normal.assertNetworkFeatureAllowed("Google Drive backup")).resolves.toBeUndefined();
  });
});
