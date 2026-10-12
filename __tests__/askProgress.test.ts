/**
 * Ask progress: one owner per Ask (retrieval → evidence count → inference
 * phrases → stop), one surface, no streaming, and the zero-note fast path.
 */
const mockSearch = jest.fn();
jest.mock("../services/notes/noteManager", () => ({
  hybridSearchNotes: (...a: unknown[]) => mockSearch(...a),
  getRecentNotes: (...a: unknown[]) => mockSearch(...a),
  getNotesForTarget: (...a: unknown[]) => mockSearch(...a),
}));
const mockGenerate = jest.fn();
jest.mock("../services/ai/localLlama", () => {
  class LlamaCancelledError extends Error {}
  return {
    LlamaCancelledError,
    generateLocalRAGAnswer: (...a: unknown[]) => mockGenerate(...a),
  };
});
const mockBuildOverride: { fn: ((...a: unknown[]) => unknown) | null } = { fn: null };
jest.mock("../services/ai/ragFormatting", () => {
  const actual = jest.requireActual("../services/ai/ragFormatting");
  return {
    ...actual,
    buildNoteContext: (...a: unknown[]) => (mockBuildOverride.fn ?? actual.buildNoteContext)(...a),
  };
});

import { generateRAGAnswer } from "../services/ai/rag";
import {
  ASK_INFERENCE_PHRASES,
  AskProgress,
  evidenceLabel,
  getPipelineStage,
  getPipelineStageLabel,
  setPipelineStage,
  subscribeToPipelineStage,
} from "../services/ai/pipelineStage";
import { NO_RELEVANT_NOTES_MESSAGE } from "../services/ai/ragFormatting";
import { ProcessingJob } from "../services/ai/processingJob";
import { centralStatusText } from "../services/audio/manualUtterance";

const NOTE = (id: string, content: string) => ({
  id,
  content,
  transcript: null,
  audioUri: null,
  transcriptionModel: null,
  createdAt: Math.floor(new Date(2026, 9, 5, 18, 0).getTime() / 1000),
  score: 1,
});

/** Records every label the chat flow shows, in order. */
function recordLabels() {
  const seen: (string | null)[] = [];
  const unsubscribe = subscribeToPipelineStage("chat", (_stage, label) => seen.push(label));
  return { seen, unsubscribe };
}

let log: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockBuildOverride.fn = null;
  setPipelineStage("chat", null);
  log = jest.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  jest.useRealTimers();
});

describe("wording", () => {
  it("evidence uses 'related memories', singular and plural, never 'relevant'", () => {
    expect(evidenceLabel(1)).toBe("Found a related memory");
    expect(evidenceLabel(2)).toBe("Found 2 related memories");
    expect(evidenceLabel(3)).toBe("Found 3 related memories");
    expect(evidenceLabel(0)).toBeNull();
    expect([1, 2, 3].map(evidenceLabel).join(" ")).not.toMatch(/relevant/i);
  });

  it("inference phrases: Piecing → Connecting (3 s) → Working through (8 s), no 'Almost there'", () => {
    expect(ASK_INFERENCE_PHRASES).toEqual([
      { afterMs: 0, label: "Piecing it together…" },
      { afterMs: 3000, label: "Connecting the dots…" },
      { afterMs: 8000, label: "Working through your memories…" },
    ]);
    expect(ASK_INFERENCE_PHRASES.map((p) => p.label).join(" ")).not.toMatch(/almost/i);
  });
});

describe("AskProgress lifecycle", () => {
  it("retrieval → evidence → timed phrases, then stops", () => {
    jest.useFakeTimers();
    const { seen, unsubscribe } = recordLabels();
    const progress = new AskProgress();
    progress.retrieving();
    progress.evidence(3);
    progress.answering();
    jest.advanceTimersByTime(2999);
    expect(getPipelineStageLabel("chat")).toBe("Found 3 related memories · Piecing it together…");
    jest.advanceTimersByTime(1);
    jest.advanceTimersByTime(4999);
    expect(getPipelineStageLabel("chat")).toBe("Connecting the dots…");
    jest.advanceTimersByTime(1);
    progress.end();
    jest.advanceTimersByTime(60_000);
    unsubscribe();
    // The count shows once, with the first phrase only.
    expect(seen).toEqual([
      "Looking through your memories…",
      "Found 3 related memories · Piecing it together…",
      "Connecting the dots…",
      "Working through your memories…",
      null,
    ]);
  });

  it("a quick answer skips the later phrases entirely", () => {
    jest.useFakeTimers();
    const { seen, unsubscribe } = recordLabels();
    const progress = new AskProgress();
    progress.answering();
    jest.advanceTimersByTime(1200);
    progress.end(); // validated answer / fallback / error — all end() the same way
    jest.advanceTimersByTime(60_000);
    unsubscribe();
    expect(seen).toEqual(["Piecing it together…", null]);
  });

  it("no count when zero notes remain, and no separate count line ever", () => {
    const { seen, unsubscribe } = recordLabels();
    const progress = new AskProgress();
    progress.evidence(0);
    progress.answering();
    progress.end();
    const single = new AskProgress();
    single.evidence(1);
    expect(seen).toEqual(["Piecing it together…", null]); // evidence() itself publishes nothing
    single.answering();
    single.end();
    unsubscribe();
    expect(seen).toEqual(["Piecing it together…", null, "Found a related memory · Piecing it together…", null]);
  });

  it("Cancel stops it immediately, and the cancelled job can never update it again", () => {
    jest.useFakeTimers();
    const job = new ProcessingJob();
    const progress = new AskProgress(job);
    progress.answering();
    const { seen, unsubscribe } = recordLabels();
    job.cancel();
    expect(getPipelineStage("chat")).toBeNull(); // synchronously, on the tap
    progress.answering();
    progress.evidence(2);
    jest.advanceTimersByTime(60_000);
    unsubscribe();
    expect(seen).toEqual([null]);
  });

  it("an old Ask can't overwrite or clear a newer one", () => {
    jest.useFakeTimers();
    const oldAsk = new AskProgress();
    oldAsk.answering();
    const newAsk = new AskProgress(); // supersedes
    newAsk.retrieving();
    jest.advanceTimersByTime(10_000); // old Ask's timers would have fired
    oldAsk.evidence(3);
    oldAsk.answering();
    oldAsk.end();
    expect(getPipelineStageLabel("chat")).toBe("Looking through your memories…");
    newAsk.answering();
    expect(getPipelineStageLabel("chat")).toBe("Piecing it together…"); // fresh timing
    newAsk.end();
  });

  it("an ended Ask never clears a stage someone else set afterwards (e.g. the next utterance's transcription)", () => {
    const ask = new AskProgress();
    ask.retrieving();
    setPipelineStage("chat", "transcribing"); // unowned write
    ask.end();
    expect(getPipelineStage("chat")).toBe("transcribing");
    setPipelineStage("chat", null);
  });

  it("works with no subscribers at all (lifecycle owned by the Ask, not the UI)", () => {
    jest.useFakeTimers();
    const progress = new AskProgress();
    progress.answering();
    jest.advanceTimersByTime(3000);
    expect(getPipelineStageLabel("chat")).toBe("Connecting the dots…");
    progress.end();
    expect(getPipelineStage("chat")).toBeNull();
  });
});

describe("one progress surface", () => {
  it("the central status line stays quiet during Ask retrieval/inference", () => {
    for (const stage of ["retrieving", "answering"] as const) {
      expect(centralStatusText({ phase: "processing", pipelineStage: stage, isHandsfreeActive: false })).toBeNull();
    }
  });
  it("…but still acknowledges capture, and Record keeps its stages", () => {
    expect(centralStatusText({ phase: "processing", pipelineStage: "transcribing", isHandsfreeActive: false })).toBe("Got it");
    expect(centralStatusText({ phase: "processing", pipelineStage: "saving", isHandsfreeActive: false })).toBe(
      "Tucked away safely"
    );
  });
  it("Handsfree keeps a tap-to-cancel hint there", () => {
    expect(centralStatusText({ phase: "processing", pipelineStage: "answering", isHandsfreeActive: true })).toBe(
      "Tap to cancel"
    );
  });
});

describe("generateRAGAnswer: progress, fast path, no streaming", () => {
  it("zero notes: no model run, the exact existing fallback, no count shown", async () => {
    mockSearch.mockResolvedValue([]);
    const { seen, unsubscribe } = recordLabels();
    const answer = await generateRAGAnswer("What did Theo say about the fence?");
    unsubscribe();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(answer).toEqual({ text: NO_RELEVANT_NOTES_MESSAGE, citations: [], relatedNotes: [] });
    expect(NO_RELEVANT_NOTES_MESSAGE).toBe("No information found in your notes.");
    expect(seen).toEqual(["Looking through your memories…", null]);
    expect(log.mock.calls.flat().join(" ")).toMatch(/inference skipped \(no notes\)/);
  });

  it("a retrieved note that buildNoteContext excludes also takes the fast path", async () => {
    mockSearch.mockResolvedValue([NOTE("n1", "Theo fixed the fence at Penrith Hardware.")]);
    mockBuildOverride.fn = () => ({ includedIndices: [], memories: [], evidence: [], contextText: "" });
    const answer = await generateRAGAnswer("What did Theo say about the fence?");
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(answer.text).toBe(NO_RELEVANT_NOTES_MESSAGE);
  });

  it("count = notes actually given to the model, not raw candidates", async () => {
    mockSearch.mockResolvedValue([
      NOTE("n1", "Theo fixed the fence."),
      NOTE("n2", "Marco painted the garden studio."),
      NOTE("n3", "Priya bought a roller."),
    ]);
    const actual = jest.requireActual("../services/ai/ragFormatting");
    mockBuildOverride.fn = (...a: unknown[]) => {
      const built = actual.buildNoteContext(...a);
      return { ...built, includedIndices: built.includedIndices.slice(0, 2) }; // one candidate excluded
    };
    mockGenerate.mockResolvedValue("Theo fixed the fence.");
    const { seen, unsubscribe } = recordLabels();
    await generateRAGAnswer("What did Theo fix?");
    unsubscribe();
    expect(seen).toContain("Found 2 related memories · Piecing it together…");
    expect(seen.join(" ")).not.toContain("Found 3");
  });

  it("normal Ask: one model run, raw tokens never streamed, answer only after validation, progress cleared", async () => {
    mockSearch.mockResolvedValue([NOTE("n1", "Theo fixed the fence at Penrith Hardware.")]);
    mockGenerate.mockImplementation(async (_q: string, _ctx: string, onToken: (t: string) => void) => {
      onToken("Theo"); // tokens arrive...
      onToken(" fixed");
      return "Theo fixed the fence at Penrith Hardware.";
    });
    const onChunk = jest.fn();
    const { seen, unsubscribe } = recordLabels();
    const answer = await generateRAGAnswer("What did Theo fix?", onChunk);
    unsubscribe();
    expect(mockGenerate).toHaveBeenCalledTimes(1);
    expect(onChunk).not.toHaveBeenCalled(); // ...but never reach the UI
    expect(answer.text.length).toBeGreaterThan(0);
    expect(seen).toEqual(["Looking through your memories…", "Found a related memory · Piecing it together…", null]);
  });

  it("error during generation stops progress", async () => {
    mockSearch.mockResolvedValue([NOTE("n1", "Theo fixed the fence.")]);
    mockGenerate.mockRejectedValue(new Error("boom"));
    await expect(generateRAGAnswer("What did Theo fix?")).rejects.toThrow("boom");
    expect(getPipelineStage("chat")).toBeNull();
  });

  it("a cancelled job stops before generation and leaves no progress behind", async () => {
    mockSearch.mockResolvedValue([NOTE("n1", "Theo fixed the fence.")]);
    const job = new ProcessingJob();
    job.cancel();
    await expect(generateRAGAnswer("What did Theo fix?", undefined, job)).rejects.toBeTruthy();
    expect(mockGenerate).not.toHaveBeenCalled();
    expect(getPipelineStage("chat")).toBeNull();
  });

  it("dev timing logs carry no question or note text", async () => {
    mockSearch.mockResolvedValue([NOTE("n1", "Theo fixed the fence at Penrith Hardware.")]);
    mockGenerate.mockResolvedValue("Theo fixed the fence.");
    await generateRAGAnswer("What did Theo fix at Penrith?");
    const timing = log.mock.calls.map((c) => c.join(" ")).filter((l) => l.startsWith("[AskTiming]"));
    expect(timing.length).toBeGreaterThan(5);
    expect(timing.join("\n")).not.toMatch(/Theo|Penrith|fence/);
  });
});

describe("development-only timing gate", () => {
  const original = (global as { __DEV__?: boolean }).__DEV__;
  afterEach(() => {
    (global as { __DEV__?: boolean }).__DEV__ = original;
    jest.resetModules();
  });
  function gateFor(pkg: string): boolean {
    (global as { __DEV__?: boolean }).__DEV__ = false; // a release-type build
    let result = true;
    jest.isolateModules(() => {
      jest.doMock("expo-constants", () => ({ __esModule: true, default: { expoConfig: { android: { package: pkg } } } }));
      result = require("../services/ai/perf").isDevelopmentBuild();
    });
    return result;
  }
  it("is off in the production app", () => {
    expect(gateFor("com.anonymous.silentconfidant")).toBe(false);
  });
  it("is on in the Xayra Dev variant, even as a standalone release-type build", () => {
    expect(gateFor("com.anonymous.silentconfidant.dev")).toBe(true);
  });
});
