/**
 * Voice Ask: from the moment recording ends, the tray is the single progress
 * surface — raised once, "Got it…" → (only if slow) "Turning that into
 * text…" → retrieval/inference progress → validated answer — and Cancel or a
 * discarded recording cleans it up.
 */
import { act, create, type ReactTestRenderer } from "react-test-renderer";

let mockResolveAnswer: ((a: { text: string; citations: []; relatedNotes: [] }) => void) | null = null;
const mockGenerate = jest.fn(() => new Promise((resolve) => (mockResolveAnswer = resolve)));
jest.mock("../services/ai/rag", () => ({
  generateRAGAnswer: (...a: unknown[]) => mockGenerate(...(a as [])),
}));
jest.mock("../services/ai/localLlama", () => {
  class LlamaCancelledError extends Error {}
  return { LlamaCancelledError, LLAMA_MODEL_MISSING_ERROR_PREFIX: "No local Llama model found." };
});
jest.mock("../services/ai/modelDownloadManager", () => ({ useModelDownload: () => ({ status: "ready" }) }));
jest.mock("../services/audio/tts", () => ({
  speakText: jest.fn(),
  speakTextAndWait: jest.fn(() => Promise.resolve()),
  stopSpeech: jest.fn(() => Promise.resolve()),
}));
jest.mock("../components/Toast", () => ({ showToast: jest.fn() }));
let mockUuid = 0;
jest.mock("expo-crypto", () => ({ randomUUID: () => `id-${++mockUuid}` }));
jest.mock("../services/ai/localWhisper", () => ({ cancelActiveTranscription: jest.fn() }));

import {
  AskProgress,
  getPipelineStage,
  getPipelineStageLabel,
  setPipelineStage,
  subscribeToPipelineStage,
  TRANSCRIPTION_SLOW_MS,
} from "../services/ai/pipelineStage";
import { ProcessingJob } from "../services/ai/processingJob";
import { useChatSession } from "../services/ai/useChatSession";
import { discardVoiceAskReservation, reserveVoiceAsk } from "../services/ai/voiceAsk";
import { centralStatusText, ManualUtteranceController } from "../services/audio/manualUtterance";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function recordLabels() {
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeToPipelineStage("chat", (_s, label) => seen.push(label));
  return { seen, unsubscribe };
}

beforeEach(() => {
  jest.clearAllMocks();
  setPipelineStage("chat", null);
});
afterEach(() => jest.useRealTimers());

describe("transcription progress (voice Ask)", () => {
  it("'Got it…' at once; 'Turning that into text…' only if transcription is still running at the threshold", () => {
    jest.useFakeTimers();
    expect(TRANSCRIPTION_SLOW_MS).toBe(2500);
    const { seen, unsubscribe } = recordLabels();
    const progress = new AskProgress();
    progress.transcribing();
    expect(getPipelineStageLabel("chat")).toBe("Got it…");
    jest.advanceTimersByTime(2499);
    expect(getPipelineStageLabel("chat")).toBe("Got it…");
    jest.advanceTimersByTime(1);
    expect(getPipelineStageLabel("chat")).toBe("Turning that into text…");
    progress.end();
    unsubscribe();
    expect(seen).toEqual(["Got it…", "Turning that into text…", null]);
  });

  it("fast transcription never shows the second phrase — the next stage supersedes it", () => {
    jest.useFakeTimers();
    const { seen, unsubscribe } = recordLabels();
    const transcription = new AskProgress();
    transcription.transcribing();
    jest.advanceTimersByTime(1200);
    const request = new AskProgress(); // the RAG request takes over
    request.retrieving();
    jest.advanceTimersByTime(10_000); // the old threshold passes
    transcription.end(); // late cleanup can't clear the new stage
    unsubscribe();
    expect(seen).toEqual(["Got it…", "Looking through your memories…"]);
    expect(getPipelineStageLabel("chat")).toBe("Looking through your memories…");
    request.end();
  });

  it("the inference phrases after it are unchanged", () => {
    jest.useFakeTimers();
    const request = new AskProgress();
    request.evidence(3);
    request.answering();
    expect(getPipelineStageLabel("chat")).toBe("Found 3 related memories · Piecing it together…");
    jest.advanceTimersByTime(3000);
    expect(getPipelineStageLabel("chat")).toBe("Connecting the dots…");
    jest.advanceTimersByTime(5000);
    expect(getPipelineStageLabel("chat")).toBe("Working through your memories…");
    request.end();
  });
});

describe("capture end raises the tray once (Ask only)", () => {
  it("Ask: reserves the answer bubble, starts 'Got it…' and raises the tray exactly once", () => {
    const raiseTray = jest.fn();
    const beginPendingAsk = jest.fn(() => ({ userId: "u", assistantId: "a" }));
    const reservation = reserveVoiceAsk("ask", { beginPendingAsk, raiseTray });
    expect(raiseTray).toHaveBeenCalledTimes(1);
    expect(beginPendingAsk).toHaveBeenCalledTimes(1);
    expect(getPipelineStageLabel("chat")).toBe("Got it…");
    discardVoiceAskReservation(reservation!, jest.fn());
    expect(getPipelineStage("chat")).toBeNull();
  });

  it("Record: nothing — no tray raise, no bubble, no progress", () => {
    const raiseTray = jest.fn();
    const beginPendingAsk = jest.fn();
    expect(reserveVoiceAsk("record", { beginPendingAsk, raiseTray })).toBeNull();
    expect(raiseTray).not.toHaveBeenCalled();
    expect(beginPendingAsk).not.toHaveBeenCalled();
    expect(getPipelineStage("chat")).toBeNull();
  });

  it("the controller reports capture end the instant recording stops — before the audio is finalized or transcribed", async () => {
    let finishStop!: (uri: string) => void;
    const events: string[] = [];
    const controller = new ManualUtteranceController({
      startRecording: async () => true,
      discardRecording: async () => {},
      stopRecording: () => {
        events.push("stop requested");
        return new Promise((resolve) => (finishStop = resolve));
      },
      processUtterance: async () => {
        events.push("processing (transcription) starts");
      },
      onCaptureEnd: (mode) => events.push(`capture end (${mode})`),
    });
    await controller.start("ask");
    const finishing = controller.finish("silence");
    expect(events).toEqual(["capture end (ask)", "stop requested"]);
    finishStop("file:///x.wav");
    await finishing;
    expect(events).toEqual(["capture end (ask)", "stop requested", "processing (transcription) starts"]);
    await controller.finish("tap"); // already finished: no second capture end
    expect(events.filter((e) => e.startsWith("capture end"))).toHaveLength(1);
  });

  it("a recording that yields no audio undoes the reservation", async () => {
    const discarded = jest.fn();
    const controller = new ManualUtteranceController({
      startRecording: async () => true,
      stopRecording: async () => null,
      discardRecording: async () => {},
      processUtterance: async () => {},
      onCaptureDiscarded: discarded,
    });
    await controller.start("ask");
    await controller.finish("tap");
    expect(discarded).toHaveBeenCalledTimes(1);
  });
});

describe("the central control stays quiet for a voice Ask after capture", () => {
  it("no 'Got it' / progress under the button once a voice Ask's recording has ended", () => {
    for (const phase of ["stopping", "processing"] as const) {
      for (const stage of [null, "transcribing", "retrieving", "answering"] as const) {
        expect(centralStatusText({ phase, pipelineStage: stage, isHandsfreeActive: false, isVoiceAskInTray: true })).toBeNull();
      }
    }
  });
  it("…while recording it still says Listening, and Record keeps its own status", () => {
    expect(
      centralStatusText({ phase: "recording", pipelineStage: null, isHandsfreeActive: false, isVoiceAskInTray: false })
    ).toMatch(/Listening/);
    expect(centralStatusText({ phase: "processing", pipelineStage: "transcribing", isHandsfreeActive: false })).toBe("Got it");
    expect(centralStatusText({ phase: "processing", pipelineStage: "saving", isHandsfreeActive: false })).toBe(
      "Tucked away safely"
    );
  });
});

describe("pending exchange in the chat session", () => {
  function Harness({ onSession }: { onSession: (s: ReturnType<typeof useChatSession>) => void }) {
    onSession(useChatSession());
    return null;
  }
  async function mount() {
    const ref: { current: ReturnType<typeof useChatSession> | null } = { current: null };
    let tree!: ReactTestRenderer;
    await act(async () => {
      tree = create(<Harness onSession={(s) => (ref.current = s)} />);
    });
    return { tree, session: () => ref.current! };
  }

  it("reserves the answer bubble with no question text, then fills the SAME bubbles when transcription returns", async () => {
    const { session } = await mount();
    let pending!: { userId: string; assistantId: string };
    act(() => {
      pending = session().beginPendingAsk();
    });
    expect(session().messages).toEqual([
      { id: pending.userId, role: "user", text: "", pending: true },
      { id: pending.assistantId, role: "assistant", text: "", isStreaming: true },
    ]);
    const job = new ProcessingJob();
    let result!: { assistantId: string; text: string };
    await act(async () => {
      const p = session().ask("What did Eli recommend?", job, pending);
      await flush();
      mockResolveAnswer?.({ text: "Eli recommended The Overstory.", citations: [], relatedNotes: [] });
      result = await p;
    });
    expect(result.assistantId).toBe(pending.assistantId);
    expect(session().messages.map((m) => [m.id, m.role, m.text, !!m.pending])).toEqual([
      [pending.userId, "user", "What did Eli recommend?", false],
      [pending.assistantId, "assistant", "Eli recommended The Overstory.", false],
    ]);
  });

  it("discarding a reservation removes it; discarding after ask() took over keeps it", async () => {
    const { session } = await mount();
    let pending!: { userId: string; assistantId: string };
    act(() => {
      pending = session().beginPendingAsk();
    });
    act(() => session().discardPendingAsk(pending));
    expect(session().messages).toHaveLength(0);

    act(() => {
      pending = session().beginPendingAsk();
    });
    await act(async () => {
      const p = session().ask("What did Eli recommend?", new ProcessingJob(), pending);
      await flush();
      mockResolveAnswer?.({ text: "Eli recommended The Overstory.", citations: [], relatedNotes: [] });
      await p;
    });
    act(() => session().discardPendingAsk(pending)); // finishUtterance's finally
    expect(session().messages).toHaveLength(2);
  });

  it("Cancel during transcription clears the bubble and its progress at once; the late transcript can't bring it back", async () => {
    const { session } = await mount();
    const job = new ProcessingJob();
    let reservation!: ReturnType<typeof reserveVoiceAsk>;
    act(() => {
      reservation = reserveVoiceAsk("ask", { beginPendingAsk: () => session().beginPendingAsk(), raiseTray: () => {} });
      // what finishUtterance registers
      job.onCancel(() => discardVoiceAskReservation(reservation!, session().discardPendingAsk));
    });
    expect(session().messages).toHaveLength(2);
    expect(getPipelineStageLabel("chat")).toBe("Got it…");
    act(() => {
      job.cancel();
    });
    expect(session().messages).toHaveLength(0);
    expect(getPipelineStage("chat")).toBeNull();
    // The stale transcription returns: finishUtterance sees job.cancelled and stops before ask().
    expect(job.cancelled).toBe(true);
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("typed Ask is unchanged: no reservation, a fresh exchange, no transcription phrases", async () => {
    const { session } = await mount();
    const { seen, unsubscribe } = recordLabels();
    await act(async () => {
      const p = session().ask("What did Eli recommend?", new ProcessingJob());
      await flush();
      mockResolveAnswer?.({ text: "Eli recommended The Overstory.", citations: [], relatedNotes: [] });
      await p;
    });
    unsubscribe();
    expect(session().messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(seen.join(" ")).not.toMatch(/Got it|Turning that into text/);
  });
});
