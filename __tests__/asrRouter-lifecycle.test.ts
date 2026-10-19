/**
 * Gate B step 4: the on-device recognizer (Tier 1) has its own bounded
 * lifecycle, separate from the PCM microphone session. MOCK-BASED: the
 * native recognizer is a fake that only emits what a test tells it to.
 */
type Handler = (event: { results?: { transcript: string }[]; error?: string; message?: string }) => void;
const mockHandlers: Record<string, Handler[]> = {};

jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn(() => true),
    supportsOnDeviceRecognition: jest.fn(() => true),
    addListener: jest.fn((event: string, handler: Handler) => {
      (mockHandlers[event] ??= []).push(handler);
      return { remove: jest.fn() };
    }),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
  },
}));
jest.mock("../services/ai/localWhisper", () => ({
  transcribeAudioLocal: jest.fn(() => Promise.resolve({ transcript: "from whisper", modelId: "base" })),
}));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0), devTiming: jest.fn() }));
jest.mock("../services/ai/modelDownloadManager", () => ({ getCurrentModelDownloadStatus: jest.fn(() => ({ status: "ready" })) }));
jest.mock("../components/Toast", () => ({ showToast: jest.fn() }));
jest.mock("../services/ai/tier1Config", () => ({
  loadTier1Config: jest.fn(() => Promise.resolve()),
  isConcurrentTier1Enabled: jest.fn(() => true),
}));

type Router = typeof import("../services/ai/asrRouter");
type Native = Record<"start" | "stop" | "abort", jest.Mock>;

let router: Router;
let native: Native;
let tier1Enabled: jest.Mock;

const emit = (event: string, payload: Parameters<Handler>[0] = {}) => (mockHandlers[event] ?? []).forEach((h) => h(payload));

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
async function drive<T>(p: Promise<T>, maxMs = 5000): Promise<T> {
  let done = false;
  let value!: T;
  void p.then((v) => {
    value = v;
    done = true;
  });
  for (let t = 0; t < maxMs && !done; t += 25) {
    jest.advanceTimersByTime(25);
    await flush();
  }
  if (!done) throw new Error("did not settle");
  return value;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.resetModules();
  Object.keys(mockHandlers).forEach((k) => delete mockHandlers[k]);
  router = require("../services/ai/asrRouter") as Router;
  native = (require("expo-speech-recognition") as { ExpoSpeechRecognitionModule: Native }).ExpoSpeechRecognitionModule;
  tier1Enabled = (require("../services/ai/tier1Config") as { isConcurrentTier1Enabled: jest.Mock }).isConcurrentTier1Enabled;
  tier1Enabled.mockReturnValue(true);
});
afterEach(() => jest.useRealTimers());

describe("Tier 1 recognizer lifecycle", () => {
  it("stop: waits for its own 'end', then uses its transcript", async () => {
    router.startListening();
    emit("result", { results: [{ transcript: "hello there" }] });
    const p = router.transcribe("file:///x.wav");
    await flush();
    expect(native.stop).toHaveBeenCalledTimes(1);
    emit("end");
    const result = await drive(p);
    expect(result).toEqual({ transcript: "hello there", tier: "native" });
    expect(native.abort).not.toHaveBeenCalled();
  });

  it("stop with no 'end': bounded — aborts, then falls back to Whisper; never waits forever", async () => {
    router.startListening();
    const result = await drive(router.transcribe("file:///x.wav"));
    expect(native.abort).toHaveBeenCalledTimes(1);
    expect(result.tier).toBe("whisper");
  });

  it("a recognizer that never confirmed its end: later recordings skip Tier 1 until a stray 'end' arrives", async () => {
    router.startListening();
    await drive(router.transcribe("file:///x.wav")); // never ends
    router.startListening();
    expect(native.start).toHaveBeenCalledTimes(1); // skipped
    emit("end"); // the old recognizer finally finishes
    router.startListening();
    expect(native.start).toHaveBeenCalledTimes(2);
  });

  it("cancel: aborted, its transcript never used; a late result from it is ignored", async () => {
    router.startListening();
    router.cancelListening();
    expect(native.abort).toHaveBeenCalledTimes(1);
    emit("result", { results: [{ transcript: "should not appear" }] });
    emit("end");
    await flush();
    const result = await drive(router.transcribe("file:///x.wav"));
    expect(result).toEqual({ transcript: "from whisper", tier: "whisper", whisperModelId: "base" });
    expect(native.stop).not.toHaveBeenCalled();
  });

  it("a new recording while the previous recognizer is still ending: Tier 1 skipped (PCM never waits on it)", () => {
    router.startListening();
    router.cancelListening(); // aborting, no "end" yet
    router.startListening();
    expect(native.start).toHaveBeenCalledTimes(1);
  });

  it("the old recognizer's 'end' can't end a newer one", async () => {
    router.startListening();
    router.cancelListening();
    emit("end"); // ends the aborted one
    await flush();
    router.startListening(); // new session
    expect(native.start).toHaveBeenCalledTimes(2);
    emit("result", { results: [{ transcript: "second" }] });
    const p = router.transcribe("file:///x.wav");
    await flush();
    emit("end");
    expect(await drive(p)).toEqual({ transcript: "second", tier: "native" });
  });

  it("Xayra Test switch: concurrent Tier 1 off → never started, Whisper only", async () => {
    tier1Enabled.mockReturnValue(false);
    router.startListening();
    expect(native.start).not.toHaveBeenCalled();
    const result = await drive(router.transcribe("file:///x.wav"));
    expect(result.tier).toBe("whisper");
    expect(native.stop).not.toHaveBeenCalled();
  });

  it("an error is informational: the session still ends on its 'end'", async () => {
    router.startListening();
    emit("error", { error: "no-speech", message: "No speech was detected." });
    const p = router.transcribe("file:///x.wav");
    await flush();
    emit("end");
    const result = await drive(p);
    expect(result.tier).toBe("whisper");
    expect(native.abort).not.toHaveBeenCalled();
  });
});

describe("recognizers left behind by a recording that never asked for them", () => {
  it("one that already ended doesn't block the next recording's Tier 1, and its transcript is never reused", async () => {
    router.startListening();
    emit("result", { results: [{ transcript: "stale" }] });
    emit("end"); // ended on its own; its recording never called transcribe or cancel
    router.startListening();
    expect(native.start).toHaveBeenCalledTimes(2);
    const p = router.transcribe("file:///x.wav");
    await flush();
    emit("end");
    expect(await drive(p)).toEqual({ transcript: "from whisper", tier: "whisper", whisperModelId: "base" });
  });

  it("one still listening is aborted (bounded) at the next start, and that recording skips Tier 1", async () => {
    router.startListening(); // orphan: its recording ended without transcribe/cancel
    router.startListening();
    expect(native.abort).toHaveBeenCalledTimes(1);
    expect(native.start).toHaveBeenCalledTimes(1);
    emit("end"); // the orphan ends
    await flush();
    router.startListening();
    expect(native.start).toHaveBeenCalledTimes(2);
  });
});
