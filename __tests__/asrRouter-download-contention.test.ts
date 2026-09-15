/**
 * Phase 2 P2-5 (qa/05-consolidated-triage.md P2-5, found live during Phase 1
 * device verification): nothing coordinates a background model download
 * with an active Whisper transcription — a transcription measured 8.9s
 * against a ~4.3s baseline while a Llama download was active. Fixed with a
 * once-per-session honest warning rather than an unproven throttling
 * mechanism this app doesn't actually have the power to enforce (the real
 * I/O happens inside Android's own DownloadManager service, outside this
 * app's process).
 */

jest.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn(() => false),
    supportsOnDeviceRecognition: jest.fn(() => false),
    addListener: jest.fn(() => ({ remove: jest.fn() })),
    start: jest.fn(),
    stop: jest.fn(),
    abort: jest.fn(),
  },
}));
jest.mock("../services/ai/localWhisper", () => ({
  transcribeAudioLocal: jest.fn(() => Promise.resolve({ transcript: "hello", modelId: "base" })),
}));
jest.mock("../services/ai/perf", () => ({
  logDuration: jest.fn(),
  nowMs: jest.fn(() => 0),
}));
jest.mock("../services/ai/modelDownloadManager", () => ({
  getCurrentModelDownloadStatus: jest.fn(),
}));
jest.mock("../components/Toast", () => ({
  showToast: jest.fn(),
}));

describe("asrRouter download-contention warning (Phase 2 P2-5)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("warns once when a download is in progress, not on every transcription", async () => {
    const { getCurrentModelDownloadStatus } = require("../services/ai/modelDownloadManager");
    const { showToast } = require("../components/Toast");
    getCurrentModelDownloadStatus.mockReturnValue({ status: "downloading" });

    const { transcribe } = require("../services/ai/asrRouter");

    await transcribe("file:///fake.wav");
    await transcribe("file:///fake.wav");
    await transcribe("file:///fake.wav");

    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("slower than usual"));
  });

  it("never warns when no download is in progress", async () => {
    const { getCurrentModelDownloadStatus } = require("../services/ai/modelDownloadManager");
    const { showToast } = require("../components/Toast");
    getCurrentModelDownloadStatus.mockReturnValue({ status: "ready" });

    const { transcribe } = require("../services/ai/asrRouter");
    await transcribe("file:///fake.wav");

    expect(showToast).not.toHaveBeenCalled();
  });
});
