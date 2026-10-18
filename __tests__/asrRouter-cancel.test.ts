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
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0) }));
jest.mock("../services/ai/modelDownloadManager", () => ({
  getCurrentModelDownloadStatus: jest.fn(() => ({ status: "ready" })),
}));
jest.mock("../components/Toast", () => ({ showToast: jest.fn() }));

import { ExpoSpeechRecognitionModule } from "expo-speech-recognition";
import { cancelListening, startListening, transcribe } from "../services/ai/asrRouter";

const native = ExpoSpeechRecognitionModule as unknown as Record<"start" | "stop" | "abort" | "addListener", jest.Mock>;

beforeEach(() => jest.clearAllMocks());

describe("asrRouter.cancelListening", () => {
  it("aborts the native session and removes its listeners", () => {
    startListening();
    expect(native.start).toHaveBeenCalledTimes(1);
    const subscriptions = native.addListener.mock.results.map((r) => r.value as { remove: jest.Mock });
    cancelListening();
    expect(native.abort).toHaveBeenCalledTimes(1);
    expect(native.stop).not.toHaveBeenCalled();
    subscriptions.forEach((sub) => expect(sub.remove).toHaveBeenCalled());
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
