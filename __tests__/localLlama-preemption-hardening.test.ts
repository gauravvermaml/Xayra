/**
 * Build 41 hardening fix, found live during Phase 1 on-device verification
 * on the Redmi Note 8 Pro (qa/06-phase-execution-roadmap.md): llama.rn's
 * `stopCompletion()` is typed as always returning `Promise<void>`, but was
 * confirmed on-device to sometimes return `undefined` at runtime instead —
 * calling `.catch()` directly on that threw synchronously inside
 * `enqueue()`, which (since a synchronous throw inside a `new
 * Promise(executor)` becomes that promise's rejection) silently failed the
 * entire `runExclusiveLlamaTask()` call. This is exactly the path
 * `releaseLocalLlamaOnBackground()` (P0-4) exercises whenever it arrives
 * while a background extraction is actively running — the scenario this
 * test reproduces deterministically.
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

// A fake context whose completion() hangs (simulating a still-running
// background extraction) and whose stopCompletion() returns `undefined`
// instead of a Promise — the exact real-world misbehavior confirmed
// on-device.
const mockCompletionCalls: string[] = [];
let mockResolveBackgroundCompletion: (() => void) | null = null;

jest.mock("llama.rn", () => ({
  initLlama: jest.fn(() =>
    Promise.resolve({
      completion: jest.fn(
        (params: { n_predict?: number }) =>
          new Promise((resolve) => {
            mockCompletionCalls.push(`n_predict:${params.n_predict}`);
            mockResolveBackgroundCompletion = () => resolve({ text: "done", timings: { predicted_per_second: 10 } });
          })
      ),
      // The actual misbehavior under test: not a function returning a
      // rejected/resolved promise, but one returning `undefined` outright.
      stopCompletion: jest.fn(() => undefined),
      release: jest.fn(() => Promise.resolve()),
    })
  ),
}));

describe("localLlama enqueue() preemption hardening (Phase 1 follow-up)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockCompletionCalls.length = 0;
    mockResolveBackgroundCompletion = null;
  });

  it("does not let a misbehaving stopCompletion() reject the preempting interactive task", async () => {
    const { runQueuedLlamaCompletion, runExclusiveLlamaTask } = require("../services/ai/localLlama");

    // Start a "background" completion (models a to-do extraction) — it
    // never resolves on its own until we manually release it below.
    const backgroundPromise = runQueuedLlamaCompletion({ prompt: "extract", n_predict: 64 }, "background", () => {});
    // Let it actually start running before the interactive task arrives.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(mockCompletionCalls).toEqual(["n_predict:64"]);

    // This is releaseLocalLlamaOnBackground()'s exact call shape — an
    // "interactive"-priority task arriving while a background completion is
    // the one currently running.
    const releaseTask = jest.fn(() => Promise.resolve());
    const taskPromise = runExclusiveLlamaTask(releaseTask, "interactive");

    // Before the fix: taskPromise would reject with
    // "Cannot read property 'catch' of undefined" here, and releaseTask
    // would never even run. After the fix: the broken stopCompletion() is
    // swallowed, and once the preempted background job's own promise
    // settles (as a "preempted, retry" — never rejecting its own caller),
    // the interactive task proceeds normally.
    mockResolveBackgroundCompletion?.();
    await expect(taskPromise).resolves.toBeUndefined();
    expect(releaseTask).toHaveBeenCalledTimes(1);

    // The preempted background job replays from scratch rather than ever
    // rejecting or resolving its original caller with a truncated result —
    // release it once more so the test doesn't leave a dangling completion.
    await new Promise((resolve) => setTimeout(resolve, 0));
    mockResolveBackgroundCompletion?.();
    await backgroundPromise;
  });
});
