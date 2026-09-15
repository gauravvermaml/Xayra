/**
 * QA Phase 3, Agent 4 test backlog item 7 (qa/04-test-strategy-report.md):
 * locks in the Build 39 "stop, don't execute this" cancel gesture
 * (`cancelActiveLlamaCompletion`) — a cancelled interactive completion must
 * reject with `LlamaCancelledError` and never resolve with a partial/
 * truncated answer, "no trace left" per the original feature's own
 * requirement.
 *
 * Also locks in a real bug found live while writing this test:
 * `cancelActiveLlamaCompletion()` called `.catch()` directly on
 * `stopCompletion()`'s return value — the same latent misbehavior
 * `localLlama-preemption-hardening.test.ts` already locks in for
 * `enqueue()`'s preemption path, confirmed on-device to genuinely return
 * `undefined` at runtime rather than always a `Promise<void>`. Fixed with
 * the same `safelyStopCompletion()` helper both call sites now share.
 */

jest.mock("expo-device-cpu", () => ({ getCpuCoreCount: () => 8 }));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///fake-doc-dir/",
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true })),
}));
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

let mockResolveCompletion: ((value: unknown) => void) | null = null;

jest.mock("llama.rn", () => ({
  initLlama: jest.fn(() =>
    Promise.resolve({
      completion: jest.fn(
        () =>
          new Promise((resolve) => {
            mockResolveCompletion = resolve;
          })
      ),
      // The exact real-world misbehavior confirmed on-device: not a
      // rejected/resolved promise, but `undefined` outright.
      stopCompletion: jest.fn(() => undefined),
      release: jest.fn(() => Promise.resolve()),
    })
  ),
}));

describe("cancelActiveLlamaCompletion (Phase 3, Agent 4 backlog item 7)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockResolveCompletion = null;
  });

  it("does not throw when the native stopCompletion() misbehaves, and rejects the caller with LlamaCancelledError", async () => {
    const { runQueuedLlamaCompletion, cancelActiveLlamaCompletion, LlamaCancelledError } = require("../services/ai/localLlama");

    const answerPromise = runQueuedLlamaCompletion({ prompt: "what's on my list", n_predict: 128 }, "interactive", () => {});
    // Let it actually start running before cancelling.
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Before the fix: this line itself threw ("Cannot read properties of
    // undefined, reading 'catch'") — asserting it doesn't is the whole
    // point of this test.
    expect(() => cancelActiveLlamaCompletion()).not.toThrow();

    // Simulate the native completion settling after being cut short (a
    // real stopCompletion() call resolves the in-flight completion() promise
    // with whatever partial result had streamed so far).
    mockResolveCompletion?.({ text: "partial answer that should never", timings: null });

    await expect(answerPromise).rejects.toBeInstanceOf(LlamaCancelledError);
  });

  it("is a no-op if nothing interactive is running (no throw, nothing to cancel)", () => {
    const { cancelActiveLlamaCompletion } = require("../services/ai/localLlama");
    expect(() => cancelActiveLlamaCompletion()).not.toThrow();
  });
});
