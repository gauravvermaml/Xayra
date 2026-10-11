/**
 * Cancel during processing: acknowledged immediately, scoped to its own job,
 * and no late result (transcript, note, answer, speech) can act afterwards.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";

// --- Whisper (native) -------------------------------------------------------
let mockResolveContext: (() => void) | null = null;
const mockStop = jest.fn(() => Promise.resolve());
let mockResolveTranscribe: ((r: { result: string; isAborted: boolean }) => void) | null = null;
const mockTranscribe = jest.fn(() => ({
  stop: mockStop,
  promise: new Promise((resolve) => (mockResolveTranscribe = resolve)),
}));
jest.mock("whisper.rn/index", () => ({
  initWhisper: jest.fn(
    () => new Promise((resolve) => (mockResolveContext = () => resolve({ transcribe: mockTranscribe, release: jest.fn() })))
  ),
}));
jest.mock("../services/ai/whisperModels", () => ({
  getActiveWhisperModel: jest.fn(() => Promise.resolve("base")),
  getWhisperModelPath: jest.fn(() => "file:///models/ggml-base.en.bin"),
}));
jest.mock("expo-file-system/legacy", () => ({ documentDirectory: "file:///docs/" }));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0) }));

// --- Chat session (RAG mocked at its boundary) -------------------------------
let mockResolveAnswer: ((a: { text: string; citations: []; relatedNotes: [] }) => void) | null = null;
const mockGenerate = jest.fn(
  (_q: string, _onChunk?: unknown, _isCancelled?: () => boolean) =>
    new Promise((resolve) => (mockResolveAnswer = resolve))
);
jest.mock("../services/ai/rag", () => ({
  generateRAGAnswer: (q: string, c: unknown, x?: () => boolean) => mockGenerate(q, c, x),
}));
jest.mock("../services/ai/localLlama", () => {
  class LlamaCancelledError extends Error {}
  return { LlamaCancelledError, LLAMA_MODEL_MISSING_ERROR_PREFIX: "No local Llama model found." };
});
jest.mock("../services/ai/modelDownloadManager", () => ({ useModelDownload: () => ({ status: "ready" }) }));
const mockSpeak = jest.fn(() => Promise.resolve());
jest.mock("../services/audio/tts", () => ({
  speakText: mockSpeak,
  speakTextAndWait: mockSpeak,
  stopSpeech: jest.fn(() => Promise.resolve()),
}));
jest.mock("../components/Toast", () => ({ showToast: jest.fn() }));
let mockUuid = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `id-${++mockUuid}` }));

import { ProcessingJob } from "../services/ai/processingJob";
import { transcribeAudioLocal } from "../services/ai/localWhisper";
import { useChatSession } from "../services/ai/useChatSession";
import { cancelProcessing } from "../services/audio/manualUtterance";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("ProcessingJob", () => {
  it("acknowledges synchronously: listeners fire inside the tap, once", () => {
    const job = new ProcessingJob();
    const abort = jest.fn();
    job.onCancel(abort);
    expect(cancelProcessing(job)).toBe(true);
    expect(job.cancelled).toBe(true);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(cancelProcessing(job)).toBe(false);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("cancelling one job never cancels a later one", () => {
    const first = new ProcessingJob();
    const second = new ProcessingJob();
    const secondAbort = jest.fn();
    second.onCancel(secondAbort);
    cancelProcessing(first);
    expect(second.cancelled).toBe(false);
    expect(secondAbort).not.toHaveBeenCalled();
    expect(second.id).not.toBe(first.id);
  });

  it("a stale note can't be saved: a cancelled job can't reach its point of no return", () => {
    const job = new ProcessingJob();
    cancelProcessing(job);
    expect(job.commit()).toBe(false);
  });

  it("once committed (note being written), Cancel no longer applies", () => {
    const job = new ProcessingJob();
    expect(job.commit()).toBe(true);
    expect(cancelProcessing(job)).toBe(false);
    expect(job.cancelled).toBe(false);
  });

  it("a listener added after cancel runs immediately (late-registered aborts still fire)", () => {
    const job = new ProcessingJob();
    cancelProcessing(job);
    const late = jest.fn();
    job.onCancel(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("nothing to cancel → no acknowledgement", () => {
    expect(cancelProcessing(null)).toBe(false);
  });
});

describe("Whisper: cancellable vs ignorable", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveContext = null;
    mockResolveTranscribe = null;
  });

  it("cancelled during the (uninterruptible) model load: decoding is skipped entirely", async () => {
    const job = new ProcessingJob();
    const pending = transcribeAudioLocal("file:///a.wav", job);
    await flush();
    cancelProcessing(job); // used to be a silent no-op here (no stop handle yet)
    mockResolveContext?.();
    await expect(pending).resolves.toEqual({ transcript: "", modelId: "base" });
    expect(mockTranscribe).not.toHaveBeenCalled();
  });

  it("cancelled mid-decode: this job's own native abort is called", async () => {
    const job = new ProcessingJob();
    const pending = transcribeAudioLocal("file:///b.wav", job);
    await flush();
    mockResolveContext?.();
    await flush();
    expect(mockTranscribe).toHaveBeenCalledTimes(1);
    cancelProcessing(job);
    expect(mockStop).toHaveBeenCalledTimes(1);
    mockResolveTranscribe?.({ result: "partial", isAborted: true });
    await pending;
  });

  it("a new transcription waits for a cancelled one still occupying the native context", async () => {
    const resolvers: ((r: { result: string; isAborted: boolean }) => void)[] = [];
    mockTranscribe.mockImplementation(() => ({
      stop: mockStop,
      promise: new Promise((resolve) => resolvers.push(resolve)),
    }));
    const oldJob = new ProcessingJob();
    const old = transcribeAudioLocal("file:///old.wav", oldJob);
    await flush();
    mockResolveContext?.();
    await flush();
    cancelProcessing(oldJob); // result will be discarded, but the decode keeps running
    const next = transcribeAudioLocal("file:///next.wav", new ProcessingJob());
    await flush();
    expect(mockTranscribe).toHaveBeenCalledTimes(1); // not started on a busy context
    resolvers[0]({ result: "", isAborted: true }); // old native decode finally ends
    await old;
    await flush();
    expect(mockTranscribe).toHaveBeenCalledTimes(2);
    resolvers[1]({ result: " Theo called.", isAborted: false });
    await expect(next).resolves.toMatchObject({ transcript: expect.stringContaining("Theo called.") });
    mockTranscribe.mockImplementation(() => ({
      stop: mockStop,
      promise: new Promise((resolve) => (mockResolveTranscribe = resolve)),
    }));
  });

  it("a normal, uncancelled transcription is unchanged", async () => {
    const job = new ProcessingJob();
    const pending = transcribeAudioLocal("file:///c.wav", job);
    await flush();
    mockResolveContext?.();
    await flush();
    mockResolveTranscribe?.({ result: " Theo came by.", isAborted: false });
    await expect(pending).resolves.toMatchObject({ transcript: expect.stringContaining("Theo came by.") });
    expect(mockStop).not.toHaveBeenCalled();
  });
});

describe("Ask: a cancelled answer never appears or speaks", () => {
  function Harness({ onSession }: { onSession: (s: ReturnType<typeof useChatSession>) => void }) {
    onSession(useChatSession());
    return null;
  }
  async function mountSession() {
    const ref: { current: ReturnType<typeof useChatSession> | null } = { current: null };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Harness onSession={(s) => (ref.current = s)} />);
    });
    return { tree, session: () => ref.current! };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockResolveAnswer = null;
  });

  it("an answer finishing after Cancel is discarded: no bubble, nothing to speak", async () => {
    const { session } = await mountSession();
    const job = new ProcessingJob();
    let result!: { assistantId: string; text: string };
    await act(async () => {
      const p = session().ask("What did I record about work?", () => job.cancelled);
      await flush();
      expect(mockGenerate).toHaveBeenCalledTimes(1); // exchange under way
      cancelProcessing(job);
      mockResolveAnswer?.({ text: "You noted a meeting with Theo.", citations: [], relatedNotes: [] });
      result = await p;
    });
    expect(result).toEqual({ assistantId: "", text: "" });
    expect(session().messages).toHaveLength(0);
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it("passes the job's cancel check down so generation that hasn't started is skipped", async () => {
    const { session } = await mountSession();
    const job = new ProcessingJob();
    await act(async () => {
      void session().ask("Any reminders?", () => job.cancelled);
      await flush();
    });
    const isCancelled = mockGenerate.mock.calls[0][2] as () => boolean;
    expect(isCancelled()).toBe(false);
    cancelProcessing(job);
    expect(isCancelled()).toBe(true);
    await act(async () => {
      mockResolveAnswer?.({ text: "x", citations: [], relatedNotes: [] });
      await flush();
    });
  });

  it("an uncancelled Ask is unchanged", async () => {
    const { session } = await mountSession();
    const job = new ProcessingJob();
    let result!: { assistantId: string; text: string };
    await act(async () => {
      const p = session().ask("What did I record about work?", () => job.cancelled);
      await flush();
      mockResolveAnswer?.({ text: "You noted a meeting with Theo.", citations: [], relatedNotes: [] });
      result = await p;
    });
    expect(result.text).toBe("You noted a meeting with Theo.");
    expect(session().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});
