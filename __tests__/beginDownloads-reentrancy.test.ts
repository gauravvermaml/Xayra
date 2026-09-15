/**
 * Phase 1 P1-3/P1-6 (qa/05-consolidated-triage.md): `beginDownloads()` had no
 * re-entrancy guard — two concurrent triggers (the Wi-Fi-resume listener and
 * the "download over cellular" tap) could both run the full check/download
 * pipeline at once, producing a duplicate, orphaned Android DownloadManager
 * transfer. `isWhisperModelDownloaded()` is deliberately given an artificial
 * delay below so two concurrent `resumeDownloads()` calls genuinely overlap
 * in time, mirroring the real race window, rather than happening to run
 * sequentially by accident of the mock resolving instantly.
 */

jest.mock("expo-device", () => ({ totalMemory: 12 * 1024 ** 3 }));
jest.mock("expo-device-cpu", () => ({ getCpuCoreCount: () => 8 }));
jest.mock("expo-download-bridge", () => ({
  enqueueDownload: jest.fn(() => 1),
  queryDownload: jest.fn(() => ({ status: "successful", localUri: "file:///fake", bytesTotal: 1 })),
  deleteNativeFile: jest.fn(),
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///fake-doc-dir/",
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true, size: 1 })),
  moveAsync: jest.fn(() => Promise.resolve()),
  copyAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-network", () => ({
  addNetworkStateListener: jest.fn(() => ({ remove: jest.fn() })),
  getNetworkStateAsync: jest.fn(() => Promise.resolve({ type: "WIFI" })),
  NetworkStateType: { WIFI: "WIFI", NONE: "NONE" },
}));
jest.mock("../services/ai/embeddingModel", () => ({
  downloadEmbeddingAssets: jest.fn(() => Promise.resolve()),
  isEmbeddingModelDownloaded: jest.fn(() => Promise.resolve(true)),
}));
jest.mock("../services/ai/localLlama", () => ({
  attemptOptimisticThreadCalibration: jest.fn(),
  attemptThreadEscalation: jest.fn(),
  attemptTierUpgrade: jest.fn(),
  computeInferenceThreadCount: jest.fn(() => Promise.resolve(2)),
  LLAMA_MODEL_FILENAMES: [
    { filename: "Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf", label: "3B" },
    { filename: "Llama-3.2-1B-Instruct-UD-Q4_K_XL.gguf", label: "1B" },
  ],
  prewarmLocalLlama: jest.fn(() => Promise.resolve()),
}));
jest.mock("../services/ai/localWhisper", () => ({
  resetWhisperContext: jest.fn(),
}));
jest.mock("../services/ai/modelCdn", () => ({ MODEL_CDN_BASE_URL: "https://fake-cdn.example" }));
jest.mock("../services/ai/modelPerformanceTracker", () => ({
  getAverageTokensPerSecond: jest.fn(() => Promise.resolve(null)),
  MIN_USABLE_TOKENS_PER_SECOND: 5,
  resetPerformanceSamples: jest.fn(() => Promise.resolve()),
}));
jest.mock("../services/ai/whisperModels", () => ({
  getWhisperModelPath: jest.fn(() => "file:///fake-doc-dir/whisper.bin"),
  isWhisperModelDownloaded: jest.fn(
    () => new Promise((resolve) => setTimeout(() => resolve(true), 20))
  ),
  WHISPER_BASE_FILENAME: "ggml-base.en.bin",
}));
jest.mock("../services/settings/preferences", () => ({
  readPreferences: jest.fn(() => Promise.resolve({ nativeDownloadIds: {}, allowCellularDownloads: false })),
  writePreferences: jest.fn((patch: unknown) => Promise.resolve(patch)),
}));
jest.mock("../services/notifications/downloadNotification", () => ({
  syncDownloadNotification: jest.fn(),
}));

describe("beginDownloads re-entrancy guard (Phase 1 P1-3/P1-6)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it("ignores a concurrent duplicate trigger instead of running the check/download pipeline twice", async () => {
    const { resumeDownloads } = require("../services/ai/modelDownloadManager");
    const { isWhisperModelDownloaded } = require("../services/ai/whisperModels");

    await Promise.all([resumeDownloads(), resumeDownloads()]);

    // Before the fix: both concurrent calls would run the full pipeline,
    // each independently calling this (and, on a real device, each
    // independently calling enqueueDownload() for the same phase).
    expect(isWhisperModelDownloaded).toHaveBeenCalledTimes(1);
  });

  it("allows a later, non-overlapping call to run normally after the first fully settles", async () => {
    const { resumeDownloads } = require("../services/ai/modelDownloadManager");
    const { isWhisperModelDownloaded } = require("../services/ai/whisperModels");

    await resumeDownloads();
    await resumeDownloads();

    // Two genuinely sequential calls are two legitimate re-checks (e.g. a
    // manual "Resume Download" retry after a real error) — the guard must
    // only block CONCURRENT overlap, never a call that starts after the
    // previous one has fully finished.
    expect(isWhisperModelDownloaded).toHaveBeenCalledTimes(2);
  });
});
