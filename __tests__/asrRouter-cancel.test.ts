/**
 * Xayra 2.0 Stage 5a: a cancelled recording aborts the native (Tier 1)
 * recognizer that started alongside it, and its transcript is never used.
 */
jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn(() => true),
    supportsOnDeviceRecognition: jest.fn(() => true),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
  },
}));
jest.mock("../services/ai/localWhisper", () => ({
  transcribeAudioLocal: jest.fn(() => Promise.resolve({ transcript: "synthetic", modelId: "base" })),
}));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0), devTiming: jest.fn() }));
jest.mock("../services/ai/modelDownloadManager", () => ({
  getCurrentModelDownloadStatus: jest.fn(() => ({ status: "ready" })),
}));
jest.mock("../components/Toast", () => ({ showToast: jest.fn() }));

type Router = typeof import("../services/ai/asrRouter");
let cancelListening: Router["cancelListening"];
let startListening: Router["startListening"];
let transcribe: Router["transcribe"];
let native: Record<"start" | "stop" | "abort" | "addListener", jest.Mock>;

// A fresh router per test: a recognizer left "ending" by one test would
// (correctly) make the next start skip Tier 1.
beforeEach(() => {
  jest.resetModules();
  ({ cancelListening, startListening, transcribe } = require("../services/ai/asrRouter") as Router);
  native = (require("expo-speech-recognition") as { ExpoSpeechRecognitionModule: typeof native }).ExpoSpeechRecognitionModule;
  jest.clearAllMocks();
});

describe("asrRouter.cancelListening", () => {
  it("aborts the native session (its later events are ignored: see asrRouter-lifecycle)", () => {
    startListening();
    expect(native.start).toHaveBeenCalledTimes(1);
    cancelListening();
    expect(native.abort).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();
  });

  it("a cancelled session is never transcribed from later", async () => {
    startListening();
    cancelListening();
    await transcribe(null);
    expect(native.stop).not.toHaveBeenCalled();
  });

  it("is a no-op when nothing is listening, and safe to repeat", () => {
    cancelListening();
    startListening();
    cancelListening();
    cancelListening();
    expect(native.abort).toHaveBeenCalledTimes(1);
  });
});
