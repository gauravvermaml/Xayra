/**
 * Prompt-session cache: persists the evaluated KV state of the static prompt
 * prefix so a fresh context skips re-prefilling it.
 *
 * This exists because the background memory release is deliberately KEPT —
 * measured on a Redmi Note 8 Pro, the model resident costs 1.98GB of native
 * heap against 0.51GB after release, and holding ~2GB while backgrounded is
 * what gets a process reaped by Android's low-memory killer. The cache does
 * not remove the release, it removes its cost.
 *
 * The dangerous failure mode is a STALE restore rather than a missing one:
 * the system prompt embeds today's date and the Monday-to-today calendar
 * baseline, so a session restored the next morning would leave the model
 * resolving "yesterday" and "this week" against the wrong dates —
 * confidently, silently, and with no error anywhere. These tests pin the
 * invalidation behaviour that prevents that, and the graceful degradation
 * that keeps a cache miss from ever becoming a crash.
 */

jest.mock("expo-device-cpu", () => ({ getCpuCoreCount: () => 8 }));
jest.mock("../services/ai/localWhisper", () => ({
  isTranscriptionInProgress: jest.fn(() => false),
}));
jest.mock("../services/ai/modelPerformanceTracker", () => ({
  MIN_USABLE_TOKENS_PER_SECOND: 5,
  recordCompletionSpeed: jest.fn(() => Promise.resolve()),
}));
jest.mock("../services/settings/preferences", () => ({
  readPreferences: jest.fn(() => Promise.resolve({ llamaThreadCount: null })),
}));

// Imported rather than duplicated so this can't silently drift out of sync
// with the real production model filename the way a hardcoded copy did
// during the Hybrid Architecture cutover (CHAT_MODEL.filename changed,
// this constant didn't, and every "does the model file exist" mock below
// silently started asserting against the wrong filename).
const { CHAT_MODEL } = require("../services/ai/localLlama");
const MODEL_FILENAME: string = CHAT_MODEL.filename;
const SESSION_FILE = "llama-prompt-session-rag.bin";
const META_FILE = "llama-prompt-session-rag.json";

/** In-memory stand-in for the document directory. */
let files: Record<string, string> = {};
let loadSessionMock: jest.Mock;
let saveSessionMock: jest.Mock;

function installMocks() {
  jest.doMock("expo-file-system/legacy", () => ({
    documentDirectory: "file:///doc/",
    getInfoAsync: jest.fn((path: string) =>
      Promise.resolve({ exists: path.endsWith(MODEL_FILENAME) || files[basename(path)] !== undefined })
    ),
    readAsStringAsync: jest.fn((path: string) => {
      const content = files[basename(path)];
      return content === undefined ? Promise.reject(new Error("ENOENT")) : Promise.resolve(content);
    }),
    writeAsStringAsync: jest.fn((path: string, content: string) => {
      files[basename(path)] = content;
      return Promise.resolve();
    }),
    deleteAsync: jest.fn((path: string) => {
      delete files[basename(path)];
      return Promise.resolve();
    }),
  }));

  jest.doMock("llama.rn", () => ({
    initLlama: jest.fn(() =>
      Promise.resolve({
        completion: jest.fn(() => Promise.resolve({ text: "ok", timings: { predicted_per_second: 10 } })),
        stopCompletion: jest.fn(() => Promise.resolve()),
        release: jest.fn(() => Promise.resolve()),
        loadSession: loadSessionMock,
        saveSession: saveSessionMock,
      })
    ),
  }));
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  files = {};
  loadSessionMock = jest.fn(() => Promise.resolve({ tokens_loaded: 400 }));
  // Must actually materialise the file: the restore path checks the session
  // blob exists before trusting the metadata, so a save that writes only
  // metadata would make every later restore look like a stale-cache miss.
  saveSessionMock = jest.fn((path: string) => {
    files[basename(path)] = "SESSION_BLOB";
    return Promise.resolve(400);
  });
  installMocks();
});

describe("prompt-session cache", () => {
  it("writes a session after the first warm-up, since none exists yet", async () => {
    const { prewarmLocalLlama } = require("../services/ai/localLlama");

    await prewarmLocalLlama();

    expect(saveSessionMock).toHaveBeenCalledTimes(1);
    expect(files[META_FILE]).toBeDefined();
    expect(JSON.parse(files[META_FILE]).key).toEqual(expect.any(String));
  });

  it("passes saveSession a bare path, not a file:// URL", async () => {
    // loadSession strips a file:// prefix internally; saveSession does not,
    // so handing it the URL form would write to a path that never loads back.
    const { prewarmLocalLlama } = require("../services/ai/localLlama");

    await prewarmLocalLlama();

    expect(saveSessionMock.mock.calls[0][0]).not.toContain("file://");
    expect(saveSessionMock.mock.calls[0][0]).toContain(SESSION_FILE);
  });

  it("does not rewrite an identical, still-valid session", async () => {
    const first = require("../services/ai/localLlama");
    await first.prewarmLocalLlama();
    expect(saveSessionMock).toHaveBeenCalledTimes(1);

    // Fresh module registry, same day, same prompt, same on-disk files.
    jest.resetModules();
    installMocks();
    saveSessionMock.mockClear();
    const second = require("../services/ai/localLlama");
    await second.prewarmLocalLlama();

    // Rewriting tens of MB of byte-identical state on every launch would be
    // pure flash wear for no benefit.
    expect(saveSessionMock).not.toHaveBeenCalled();
  });

  it("discards the session and re-saves when the date has rolled over", async () => {
    const first = require("../services/ai/localLlama");
    await first.prewarmLocalLlama();
    const keyToday = JSON.parse(files[META_FILE]).key;

    // The date lives inside the hashed prompt text, so advancing the clock is
    // what a real midnight rollover looks like to this cache.
    jest.resetModules();
    installMocks();
    saveSessionMock.mockClear();
    const realNow = Date.now;
    const tomorrow = realNow() + 24 * 60 * 60 * 1000;
    jest.spyOn(Date, "now").mockReturnValue(tomorrow);
    const RealDate = Date;
    // eslint-disable-next-line no-global-assign
    global.Date = class extends RealDate {
      constructor(...args: unknown[]) {
        // @ts-expect-error - passthrough constructor for the fake clock
        super(...(args.length ? args : [tomorrow]));
      }
      static now() {
        return tomorrow;
      }
    } as DateConstructor;

    try {
      const second = require("../services/ai/localLlama");
      await second.prewarmLocalLlama();
      expect(saveSessionMock).toHaveBeenCalledTimes(1);
      expect(JSON.parse(files[META_FILE]).key).not.toBe(keyToday);
    } finally {
      global.Date = RealDate;
      jest.restoreAllMocks();
    }
  });

  it("falls back to prefill without throwing when loadSession fails", async () => {
    // Seed a session whose key matches so a restore is genuinely attempted.
    const seed = require("../services/ai/localLlama");
    await seed.prewarmLocalLlama();

    jest.resetModules();
    loadSessionMock = jest.fn(() => Promise.reject(new Error("corrupt session")));
    installMocks();

    const { prewarmLocalLlama, generateLocalRAGAnswer } = require("../services/ai/localLlama");
    await expect(prewarmLocalLlama()).resolves.toBeUndefined();
    // The app must stay fully usable after a failed restore.
    await expect(generateLocalRAGAnswer("q", "ctx", () => {})).resolves.toEqual(expect.any(String));
  });

  it("replaces a session that failed to load, rather than retrying it every launch", async () => {
    const seed = require("../services/ai/localLlama");
    await seed.prewarmLocalLlama();
    expect(files[SESSION_FILE]).toBeDefined();

    jest.resetModules();
    loadSessionMock = jest.fn(() => Promise.reject(new Error("corrupt session")));
    installMocks();
    saveSessionMock.mockClear();
    const { prewarmLocalLlama } = require("../services/ai/localLlama");
    await prewarmLocalLlama();

    // The corrupt pair is discarded on the failed restore, which invalidates
    // the key and makes the warm-up write a fresh one — so the next launch
    // gets a working cache instead of hitting the same bad file forever.
    expect(loadSessionMock).toHaveBeenCalled();
    expect(saveSessionMock).toHaveBeenCalledTimes(1);
    expect(files[META_FILE]).toBeDefined();
  });
});
