/**
 * Phase 2 P2-1 (qa/05-consolidated-triage.md P2-1): both Whisper-contention
 * gates (`transformationEngine.ts`'s extraction gate,
 * `localLlama.ts`'s boot-warmup gate) used a fixed 6-second total retry
 * schedule, but this same codebase's own doc comments document a real
 * on-device transcription measured at 24.4 seconds under exactly the
 * contention these gates exist to avoid — meaning the gate could give up
 * and let its competing job proceed while the protected transcription was
 * still running. This locks in that the schedule now comfortably exceeds
 * that measured worst case, without needing to actually drive a ~29-second
 * real timer.
 */

jest.mock("expo-device-cpu", () => ({
  getCpuCoreCount: () => 8,
  getThermalStatus: () => 0,
  ThermalStatus: { NONE: 0, LIGHT: 1, MODERATE: 2, SEVERE: 3, CRITICAL: 4, EMERGENCY: 5, SHUTDOWN: 6 },
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///fake-doc-dir/",
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true })),
}));
jest.mock("llama.rn", () => ({ initLlama: jest.fn() }));
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

// The documented worst-case measurement both gates' own doc comments cite —
// see services/ai/localLlama.ts's WARMUP_TRANSCRIPTION_RECHECK_DELAYS_MS
// doc comment and qa/02-audio-engine-report.md's P2-1 finding.
const DOCUMENTED_WORST_CASE_MS = 24_400;

function totalDelayMs(schedule: number[]): number {
  return schedule.reduce((sum, ms) => sum + ms, 0);
}

describe("Whisper-contention gate schedules (Phase 2 P2-1)", () => {
  it("transformationEngine's extraction gate now waits longer than the documented worst case", () => {
    const { TRANSCRIPTION_RECHECK_DELAYS_MS } = require("../services/ai/transformationEngine");
    expect(totalDelayMs(TRANSCRIPTION_RECHECK_DELAYS_MS)).toBeGreaterThan(DOCUMENTED_WORST_CASE_MS);
  });

  it("localLlama's boot-warmup gate now waits longer than the documented worst case", () => {
    const { WARMUP_TRANSCRIPTION_RECHECK_DELAYS_MS } = require("../services/ai/localLlama");
    expect(totalDelayMs(WARMUP_TRANSCRIPTION_RECHECK_DELAYS_MS)).toBeGreaterThan(DOCUMENTED_WORST_CASE_MS);
  });
});
