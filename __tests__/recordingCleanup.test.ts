/**
 * Launch-time cleanup of input audio: temporary recordings go, audio a
 * historical note still links to stays.
 */
const CACHE = "file:///data/user/0/app/cache/";
const DOCS = "file:///data/user/0/app/files/";

// In-memory file system: path -> "file" | "dir".
const mockFs = new Map<string, "file" | "dir">();
const mockDeleted: string[] = [];

jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///data/user/0/app/cache/",
  documentDirectory: "file:///data/user/0/app/files/",
  readDirectoryAsync: jest.fn(async (dir: string) => {
    if (mockFs.get(dir.replace(/\/$/, "")) !== "dir") throw new Error(`no such directory: ${dir}`);
    const children = new Set<string>();
    for (const path of mockFs.keys()) {
      if (path.startsWith(dir) && path !== dir) children.add(path.slice(dir.length).split("/")[0]);
    }
    return [...children];
  }),
  getInfoAsync: jest.fn(async (path: string) => {
    const kind = mockFs.get(path.replace(/\/$/, ""));
    return { exists: kind !== undefined, isDirectory: kind === "dir" };
  }),
  deleteAsync: jest.fn(async (path: string) => {
    mockDeleted.push(path);
    mockFs.delete(path);
  }),
  readAsStringAsync: jest.fn(async (path: string) => mockFileText.get(path) ?? ""),
}));

// Vault mode (services/dev/disposableVault.ts): production package by default.
let mockPackage = "com.anonymous.silentconfidant";
const mockFileText = new Map<string, string>();
jest.mock("expo-app-signature", () => ({ getRuntimePackageName: () => mockPackage }));
jest.mock("expo-crypto", () => ({ getRandomBytesAsync: jest.fn() }));

import { cleanupOrphanRecordings } from "../services/audio/recordingCleanup";

function seed(paths: Record<string, "file" | "dir">) {
  mockFs.clear();
  mockDeleted.length = 0;
  for (const [path, kind] of Object.entries(paths)) mockFs.set(path, kind);
}

describe("cleanupOrphanRecordings", () => {
  it("removes every temporary recording left in the cache folder", async () => {
    seed({
      [`${CACHE}recordings`]: "dir",
      [`${CACHE}recordings/note-1.wav`]: "file",
      [`${CACHE}recordings/active-mode-2.wav`]: "file",
    });
    const result = await cleanupOrphanRecordings(async () => []);
    expect(result.deletedTemporary).toBe(2);
    expect(mockDeleted.sort()).toEqual([`${CACHE}recordings/active-mode-2.wav`, `${CACHE}recordings/note-1.wav`]);
  });

  it("removes unlinked WAVs from the old folder but keeps audio a note still links to", async () => {
    seed({
      [`${DOCS}recordings`]: "dir",
      [`${DOCS}recordings/note-linked.wav`]: "file",
      [`${DOCS}recordings/note-orphan.wav`]: "file",
    });
    const result = await cleanupOrphanRecordings(async () => [`${DOCS}recordings/note-linked.wav`]);
    expect(result).toEqual({ deletedTemporary: 0, deletedLegacyOrphans: 1, keptLinkedLegacy: 1 });
    expect(mockDeleted).toEqual([`${DOCS}recordings/note-orphan.wav`]);
    expect(mockFs.has(`${DOCS}recordings/note-linked.wav`)).toBe(true);
  });

  it("recognises a linked file whatever form its stored URI takes", async () => {
    seed({ [`${DOCS}recordings`]: "dir", [`${DOCS}recordings/note-old.wav`]: "file" });
    await cleanupOrphanRecordings(async () => ["/data/user/0/app/files/recordings/note-old.wav"]);
    expect(mockDeleted).toEqual([]);
  });

  it("deletes nothing from the old folder if the linked-audio list can't be read", async () => {
    seed({
      [`${CACHE}recordings`]: "dir",
      [`${CACHE}recordings/note-tmp.wav`]: "file",
      [`${DOCS}recordings`]: "dir",
      [`${DOCS}recordings/note-maybe-linked.wav`]: "file",
    });
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    const result = await cleanupOrphanRecordings(async () => {
      throw new Error("database locked");
    });
    warn.mockRestore();
    expect(result.deletedLegacyOrphans).toBe(0);
    expect(mockDeleted).toEqual([`${CACHE}recordings/note-tmp.wav`]);
  });

  it("never touches non-WAV files, subfolders, models, the database or other caches", async () => {
    seed({
      [`${CACHE}recordings`]: "dir",
      [`${CACHE}recordings/notes.txt`]: "file",
      [`${CACHE}recordings/nested`]: "dir",
      [`${CACHE}recordings/nested/deep.wav`]: "file",
      [`${CACHE}other-cache.wav`]: "file",
      [`${DOCS}recordings`]: "dir",
      [`${DOCS}qwen-task-extractor-q4_k_m.gguf`]: "file",
      [`${DOCS}SQLite/xayra.db`]: "file",
      [`${DOCS}tts-session.wav`]: "file",
    });
    const result = await cleanupOrphanRecordings(async () => []);
    expect(result).toEqual({ deletedTemporary: 0, deletedLegacyOrphans: 0, keptLinkedLegacy: 0 });
    expect(mockDeleted).toEqual([]);
  });

  it("in a Xayra Dev disposable test vault, never deletes old-folder audio (the normal vault's notes link to it)", async () => {
    const marker = `${DOCS}dev-disposable-vault.json`;
    seed({
      [`${CACHE}recordings`]: "dir",
      [`${CACHE}recordings/note-tmp.wav`]: "file",
      [`${DOCS}recordings`]: "dir",
      [`${DOCS}recordings/note-linked-by-normal-vault.wav`]: "file",
      [marker]: "file",
    });
    mockFileText.set(marker, JSON.stringify({ version: 1, package: "com.anonymous.silentconfidant.dev" }));
    mockPackage = "com.anonymous.silentconfidant.dev";
    let cleanup!: typeof cleanupOrphanRecordings;
    jest.isolateModules(() => {
      cleanup = require("../services/audio/recordingCleanup").cleanupOrphanRecordings;
    });
    try {
      // The disposable vault has no notes, so it would report nothing linked.
      const result = await cleanup(async () => []);
      expect(result.deletedLegacyOrphans).toBe(0);
      expect(mockFs.has(`${DOCS}recordings/note-linked-by-normal-vault.wav`)).toBe(true);
      expect(mockDeleted).toEqual([`${CACHE}recordings/note-tmp.wav`]);
    } finally {
      mockPackage = "com.anonymous.silentconfidant";
      mockFileText.clear();
    }
  });

  it("is a no-op when neither folder exists", async () => {
    seed({});
    expect(await cleanupOrphanRecordings(async () => [])).toEqual({ deletedTemporary: 0, deletedLegacyOrphans: 0, keptLinkedLegacy: 0 });
  });
});
