/**
 * Redmi uplift Stage 1: Cancel acts on the screen at once. On a real Redmi
 * the pending question stayed visible for several seconds after Cancel
 * ("Connecting the dots…") — the exchange was only removed once the RAG
 * pipeline noticed. Now the bubbles go, and "sending" is released, inside
 * the tap; nothing the cancelled exchange produces later can appear, speak,
 * or disturb a newer request. MOCK-BASED (RAG mocked at its boundary).
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";

type Answer = { text: string; citations: []; relatedNotes: [] };
const mockResolvers: Array<(a: Answer) => void> = [];
const mockChunks: Array<(chunk: string) => void> = [];
const mockGenerate = jest.fn(
  (_q: string, onChunk?: (chunk: string) => void, _signal?: unknown) =>
    new Promise<Answer>((resolve) => {
      mockResolvers.push(resolve);
      if (onChunk) mockChunks.push(onChunk);
    })
);
jest.mock("../services/ai/rag", () => ({
  generateRAGAnswer: (q: string, c: (chunk: string) => void, x?: unknown) => mockGenerate(q, c, x),
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
jest.mock("../services/audio/audioInputState", () => ({ isMicInUse: () => false }));
let mockUuid = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `id-${++mockUuid}` }));

import { ProcessingJob } from "../services/ai/processingJob";
import { useChatSession } from "../services/ai/useChatSession";
import { cancelProcessing } from "../services/audio/manualUtterance";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

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
const answer = (text: string): Answer => ({ text, citations: [], relatedNotes: [] });

beforeEach(() => {
  jest.clearAllMocks();
  mockResolvers.length = 0;
  mockChunks.length = 0;
});

describe("Cancel during an Ask", () => {
  it("removes the pending exchange and releases 'sending' inside the tap — before the pipeline returns", async () => {
    const { session } = await mountSession();
    const job = new ProcessingJob();
    await act(async () => {
      void session().submitQuery("synthetic question one", "text", job);
      await flush();
    });
    expect(session().messages).toHaveLength(2); // question + "thinking" bubble
    expect(session().isSending).toBe(true);
    // Retrieval/generation still running underneath: nothing resolved yet.
    act(() => {
      cancelProcessing(job);
    });
    expect(session().messages).toHaveLength(0);
    expect(session().isSending).toBe(false);
  });

  it("a streamed chunk or a finished answer arriving after Cancel never appears; nothing speaks", async () => {
    const { session } = await mountSession();
    const job = new ProcessingJob();
    let done!: Promise<void>;
    await act(async () => {
      done = session().submitQuery("synthetic question one", "voice", job);
      await flush();
    });
    act(() => {
      cancelProcessing(job);
    });
    await act(async () => {
      mockChunks[0]?.("late streamed text");
      mockResolvers[0]?.(answer("late answer"));
      await done;
      await flush();
    });
    expect(session().messages).toHaveLength(0);
    expect(mockSpeak).not.toHaveBeenCalled();
  });

  it("a new question can start immediately; the cancelled one finishing later can't disturb it", async () => {
    const { session } = await mountSession();
    const first = new ProcessingJob();
    let firstDone!: Promise<void>;
    await act(async () => {
      firstDone = session().submitQuery("synthetic question one", "text", first);
      await flush();
    });
    act(() => {
      cancelProcessing(first);
    });
    const second = new ProcessingJob();
    let secondDone!: Promise<void>;
    await act(async () => {
      secondDone = session().submitQuery("synthetic question two", "text", second);
      await flush();
    });
    expect(mockGenerate).toHaveBeenCalledTimes(2); // not refused as "already sending"
    expect(session().isSending).toBe(true);
    // The cancelled exchange unwinds now — it must not end the newer one's "sending".
    await act(async () => {
      mockResolvers[0]?.(answer("late answer"));
      await firstDone;
      await flush();
    });
    expect(session().isSending).toBe(true);
    expect(session().messages.map((m) => m.text)).toEqual(["synthetic question two", ""]);
    await act(async () => {
      mockResolvers[1]?.(answer("second answer"));
      await secondDone;
      await flush();
    });
    expect(session().isSending).toBe(false);
    expect(session().messages.map((m) => m.text)).toEqual(["synthetic question two", "second answer"]);
  });

  it("repeated Cancel is harmless", async () => {
    const { session } = await mountSession();
    const job = new ProcessingJob();
    await act(async () => {
      void session().submitQuery("synthetic question one", "text", job);
      await flush();
    });
    act(() => {
      expect(cancelProcessing(job)).toBe(true);
      expect(cancelProcessing(job)).toBe(false);
    });
    expect(session().messages).toHaveLength(0);
  });

  it("voice ask(): the reserved exchange taken over by the question also goes at once", async () => {
    const { session } = await mountSession();
    const job = new ProcessingJob();
    await act(async () => {
      const pending = session().beginPendingAsk();
      void session().ask("synthetic voice question", job, pending);
      await flush();
    });
    expect(session().messages).toHaveLength(2);
    act(() => {
      cancelProcessing(job);
    });
    expect(session().messages).toHaveLength(0);
    expect(session().isSending).toBe(false);
  });
});

describe("the commit boundary", () => {
  it("a job past its point of no return (a note write began) can no longer be cancelled", () => {
    const job = new ProcessingJob();
    expect(job.commit()).toBe(true);
    expect(cancelProcessing(job)).toBe(false);
    expect(job.cancelled).toBe(false);
  });
  it("a job cancelled first can never commit (its note is never written)", () => {
    const job = new ProcessingJob();
    cancelProcessing(job);
    expect(job.commit()).toBe(false);
  });
});
