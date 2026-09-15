/**
 * QA Phase 3, Agent 4 test backlog item 9 (qa/04-test-strategy-report.md):
 * locks in `processCompletionQueue`'s Build 36 preemption/retry ordering —
 * Agent 3 traced `isCompletionRunning` as correct during the audit; this
 * turns that one-time trace into a permanent regression guard. Specifically:
 * a background job cut short by an arriving interactive job is re-enqueued
 * exactly once (not resolved/rejected with its truncated result), the
 * interactive job runs to completion BEFORE the retried background job gets
 * another turn, and the background job's own caller never sees anything
 * settle until that retry actually finishes.
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

type PendingCall = { n_predict: number; resolve: (value: unknown) => void };
const pendingCalls: PendingCall[] = [];

jest.mock("llama.rn", () => ({
  initLlama: jest.fn(() =>
    Promise.resolve({
      completion: jest.fn(
        (params: { n_predict: number }) =>
          new Promise((resolve) => {
            pendingCalls.push({ n_predict: params.n_predict, resolve });
          })
      ),
      stopCompletion: jest.fn(() => Promise.resolve()),
      release: jest.fn(() => Promise.resolve()),
    })
  ),
}));

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("processCompletionQueue preemption/retry ordering (Phase 3, Agent 4 backlog item 9)", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    pendingCalls.length = 0;
  });

  it("re-enqueues a preempted background job exactly once, runs the interactive job first, and never resolves the background caller before the retry finishes", async () => {
    const { runQueuedLlamaCompletion } = require("../services/ai/localLlama");

    // Background job (models a to-do extraction) starts first.
    const backgroundPromise = runQueuedLlamaCompletion(
      { prompt: "extract to-dos", n_predict: 64 },
      "background",
      () => {}
    );
    await flush();
    expect(pendingCalls).toHaveLength(1);
    expect(pendingCalls[0].n_predict).toBe(64);

    // An interactive RAG query arrives while it's running — preempts it.
    const interactivePromise = runQueuedLlamaCompletion(
      { prompt: "what's on my list today", n_predict: 128 },
      "interactive",
      () => {}
    );

    // Cut the background job's native completion short (stopCompletion's
    // real-world effect: the in-flight completion() promise settles).
    pendingCalls[0].resolve({ text: "truncated", timings: { predicted_per_second: 10 } });
    await flush();

    // The background job must NOT have settled its own caller yet — it's
    // been re-enqueued to retry, not resolved with the truncated text.
    let backgroundSettled = false;
    void backgroundPromise.finally(() => {
      backgroundSettled = true;
    });
    await flush();
    expect(backgroundSettled).toBe(false);

    // The interactive job must run BEFORE the retried background job gets
    // another turn — exactly one new completion() call, and it's the
    // interactive one's params, not a second background attempt yet.
    expect(pendingCalls).toHaveLength(2);
    expect(pendingCalls[1].n_predict).toBe(128);

    // Finish the interactive job.
    pendingCalls[1].resolve({ text: "here's your list", timings: { predicted_per_second: 12 } });
    const interactiveResult = await interactivePromise;
    expect(interactiveResult.text).toBe("here's your list");

    // NOW the retried background job should get its turn — exactly one
    // retry, not two or more, and only after the interactive job's own
    // teardown (its settle + queue-advance) finished.
    await flush();
    expect(pendingCalls).toHaveLength(3);
    expect(pendingCalls[2].n_predict).toBe(64);

    pendingCalls[2].resolve({ text: "extracted to-dos, take two", timings: { predicted_per_second: 9 } });
    const backgroundResult = await backgroundPromise;
    expect(backgroundResult.text).toBe("extracted to-dos, take two");

    // Exactly 3 native completion() calls total for this whole sequence —
    // one original background attempt, one interactive job, one background
    // retry. Never a second retry, never the interactive job re-run.
    expect(pendingCalls).toHaveLength(3);
  });
});
