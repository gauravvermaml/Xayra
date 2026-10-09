/**
 * Central-button voice flow: tap → speak → auto-finish after trailing
 * silence (or a second tap) → process, with Record/Ask frozen per utterance
 * and processing cancellable only through the explicit Cancel action.
 *
 * Runs the real recorder hook (mic mocked, fed synthetic PCM on a fake
 * clock) wired to the real ManualUtteranceController, the same way
 * app/index.tsx wires them.
 */
import { act, create } from "react-test-renderer";
import { QUIET, SPEECH, feedAudio } from "./support/pcm";

let mockEmitData: (base64: string) => void = () => {};
jest.mock("@fugood/react-native-audio-pcm-stream", () => ({
  __esModule: true,
  default: {
    init: jest.fn(),
    start: jest.fn(),
    stop: jest.fn(),
    on: jest.fn((event: string, handler: (data: string) => void) => {
      if (event === "data") mockEmitData = handler;
      return { remove: jest.fn() };
    }),
  },
}));
jest.mock("expo-audio", () => ({
  requestRecordingPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///fake-cache/",
  documentDirectory: "file:///fake-doc-dir/",
}));
let mockWavCount = 0;
jest.mock("../services/audio/wav", () => ({
  ...jest.requireActual("../services/audio/wav"),
  writePcmChunksAsWav: jest.fn(() => Promise.resolve(`file:///fake-cache/recordings/note-${++mockWavCount}.wav`)),
}));
jest.mock("../services/audio/player", () => ({ pausePlayback: jest.fn() }));
jest.mock("../services/audio/tts", () => ({ stopSpeech: jest.fn(() => Promise.resolve()) }));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0) }));
const mockCancelTranscription = jest.fn();
const mockCancelCompletion = jest.fn();
jest.mock("../services/ai/localWhisper", () => ({ cancelActiveTranscription: () => mockCancelTranscription() }));
jest.mock("../services/ai/localLlama", () => ({ cancelActiveLlamaCompletion: () => mockCancelCompletion() }));

import AudioRecord from "@fugood/react-native-audio-pcm-stream";
import { useVoiceRecorder, type VoiceRecorder } from "../services/audio/recorder";
import {
  AUTO_STOP_TRAILING_SILENCE_MS,
  cancelProcessing,
  decideCentralTap,
  ManualUtteranceController,
  type UtteranceMode,
} from "../services/audio/manualUtterance";

const mockAudioRecord = AudioRecord as unknown as Record<"init" | "start" | "stop", jest.Mock>;
const emit = (base64: string) => mockEmitData(base64);

/** Lets promise chains (stop → WAV write → process) settle. */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** Advances the fake clock inside act, then lets async work settle. */
async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    await flush();
  });
}

async function feed(level: number, ms: number) {
  await act(async () => {
    feedAudio(emit, level, ms);
    await flush();
  });
}

type Processed = { uri: string; mode: UtteranceMode; trigger: string };

/** The real recorder hook + controller, wired like app/index.tsx. */
async function setup(options?: { processUtterance?: (p: Processed, release: () => void) => Promise<void> }) {
  const recorderRef: { current: VoiceRecorder | null } = { current: null };
  function Harness() {
    recorderRef.current = useVoiceRecorder();
    return null;
  }
  await act(async () => {
    create(<Harness />);
  });
  const processed: Processed[] = [];
  const controller = new ManualUtteranceController({
    startRecording: (o) => recorderRef.current!.startRecording(o),
    stopRecording: () => recorderRef.current!.stopRecording(),
    processUtterance: async (uri, mode, trigger, release) => {
      processed.push({ uri, mode, trigger });
      await options?.processUtterance?.({ uri, mode, trigger }, release);
    },
  });
  const start = async (mode: UtteranceMode) => {
    await act(async () => {
      await controller.start(mode);
    });
  };
  return { controller, processed, start, recorder: () => recorderRef.current! };
}

/** What the screen does with a central-button tap. */
function tap(controller: ManualUtteranceController, extra?: { isProcessing?: boolean; isHandsfreeActive?: boolean }) {
  return decideCentralTap({
    manualPhase: controller.snapshot.phase,
    isProcessing: extra?.isProcessing ?? false,
    isHandsfreeActive: extra?.isHandsfreeActive ?? false,
    isRecorderTransitioning: false,
  });
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockWavCount = 0;
});
afterEach(() => {
  jest.useRealTimers();
});

describe("auto-finish after trailing silence", () => {
  it("uses a shorter window for Ask than for Record", () => {
    expect(AUTO_STOP_TRAILING_SILENCE_MS).toEqual({ ask: 1500, record: 2200 });
  });

  it("Ask: speech then ~1.5 s of silence finishes the utterance exactly once", async () => {
    const { start, processed, controller } = await setup();
    await start("ask");
    await feed(QUIET, 320); // calibration
    await feed(SPEECH, 1200);
    await feed(QUIET, 1300);
    expect(processed).toHaveLength(0);
    await feed(QUIET, 500);
    await advance(300); // recorder drain
    expect(processed).toEqual([expect.objectContaining({ mode: "ask", trigger: "silence" })]);
    expect(mockAudioRecord.stop).toHaveBeenCalledTimes(1);
    expect(controller.snapshot.phase).toBe("idle");
    await feed(QUIET, 5000);
    expect(processed).toHaveLength(1);
  });

  it("Record: a thinking pause shorter than 2.2 s does not finish the note", async () => {
    const { start, processed, controller } = await setup();
    await start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 1500);
    await feed(QUIET, 1900); // a pause that would already end an Ask
    await feed(SPEECH, 1500);
    expect(processed).toHaveLength(0);
    expect(controller.snapshot.phase).toBe("recording");
  });

  it("Record: sustained silence after speech finishes the note", async () => {
    const { start, processed } = await setup();
    await start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 1500);
    await feed(QUIET, 2500);
    await advance(300);
    expect(processed).toEqual([expect.objectContaining({ mode: "record", trigger: "silence" })]);
  });

  it("never finishes on silence alone — no speech means no auto-stop and nothing saved", async () => {
    const { start, processed, controller } = await setup();
    await start("record");
    await feed(QUIET, 30_000);
    await advance(1000);
    expect(processed).toHaveLength(0);
    expect(mockAudioRecord.stop).not.toHaveBeenCalled();
    expect(controller.snapshot.phase).toBe("recording");
  });

  it("has no maximum length: continuous speech keeps recording until a tap", async () => {
    const { start, processed, controller } = await setup();
    await start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 120_000);
    expect(processed).toHaveLength(0);
    expect(tap(controller)).toBe("finish-manual");
    await act(async () => {
      void controller.finish("tap");
      await flush();
    });
    await advance(300);
    expect(processed).toEqual([expect.objectContaining({ trigger: "tap" })]);
  });

  it("is off when no window is given (recorder used without auto-finish)", async () => {
    const { recorder } = await setup();
    const onAutoStop = jest.fn();
    await act(async () => {
      await recorder().startRecording({ onAutoStop });
    });
    await feed(QUIET, 320);
    await feed(SPEECH, 1000);
    await feed(QUIET, 5000);
    expect(onAutoStop).not.toHaveBeenCalled();
  });
});

describe("manual finish and the habitual second tap", () => {
  it("a tap while recording finishes immediately, before any silence", async () => {
    const { start, processed, controller } = await setup();
    await start("ask");
    await feed(QUIET, 320);
    await feed(SPEECH, 600);
    expect(tap(controller)).toBe("finish-manual");
    await act(async () => {
      void controller.finish("tap");
      await flush();
    });
    await advance(300);
    expect(processed).toEqual([expect.objectContaining({ mode: "ask", trigger: "tap" })]);
  });

  it("a tap racing the auto-stop processes the utterance once", async () => {
    const { start, processed, controller } = await setup();
    await start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 1000);
    await feed(QUIET, 2300); // auto-stop fires; recorder is still draining
    await act(async () => {
      void controller.finish("tap");
      await flush();
    });
    await advance(300);
    expect(processed).toHaveLength(1);
    expect(mockAudioRecord.stop).toHaveBeenCalledTimes(1);
  });

  it("a habitual tap just after auto-stop does not cancel processing", async () => {
    let finishProcessing!: () => void;
    const { start, processed, controller } = await setup({
      processUtterance: () => new Promise<void>((resolve) => (finishProcessing = resolve)),
    });
    await start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 1000);
    await feed(QUIET, 2300);
    await advance(300);
    expect(controller.snapshot.phase).toBe("processing");

    // The old double-tap habit, during the drain/transcription window.
    expect(tap(controller, { isProcessing: true })).toBe("ignore");
    expect(tap(controller, { isProcessing: false })).toBe("ignore");
    expect(mockCancelTranscription).not.toHaveBeenCalled();
    expect(mockCancelCompletion).not.toHaveBeenCalled();

    await act(async () => {
      finishProcessing();
      await flush();
    });
    expect(processed).toHaveLength(1);
    expect(controller.snapshot.phase).toBe("idle");
  });

  it("a typed submission's processing is not cancelled by a central tap either", () => {
    expect(
      decideCentralTap({ manualPhase: "idle", isProcessing: true, isHandsfreeActive: false, isRecorderTransitioning: false })
    ).toBe("ignore");
  });

  it("the explicit Cancel action still cancels processing", async () => {
    const cancelRequested = { current: false };
    let transcriptionDone!: () => void;
    const saved: string[] = [];
    const { start, controller } = await setup({
      // Mirrors finishUtterance's checkpoint: the cancel flag is checked
      // once transcription returns, before anything is saved.
      processUtterance: async ({ uri }) => {
        cancelRequested.current = false;
        await new Promise<void>((resolve) => (transcriptionDone = resolve));
        if (cancelRequested.current) return;
        saved.push(uri);
      },
    });
    await start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 1000);
    await feed(QUIET, 2300);
    await advance(300);
    expect(controller.snapshot.phase).toBe("processing");

    cancelProcessing(cancelRequested);
    expect(mockCancelTranscription).toHaveBeenCalledTimes(1);
    expect(mockCancelCompletion).toHaveBeenCalledTimes(1);

    await act(async () => {
      transcriptionDone();
      await flush();
    });
    expect(saved).toEqual([]);
    expect(controller.snapshot.phase).toBe("idle");
  });

  it("releases the utterance once routed, so a tap while the answer is spoken starts a new one", async () => {
    let finishSpeaking!: () => void;
    const { start, controller } = await setup({
      processUtterance: async (_p, release) => {
        release(); // answer ready
        await new Promise<void>((resolve) => (finishSpeaking = resolve)); // TTS
      },
    });
    await start("ask");
    await feed(QUIET, 320);
    await feed(SPEECH, 800);
    await feed(QUIET, 1700);
    await advance(300);
    expect(controller.snapshot.phase).toBe("idle");
    expect(tap(controller)).toBe("start-manual");

    await start("record"); // new utterance while the old answer is still "speaking"
    await act(async () => {
      finishSpeaking();
      await flush();
    });
    // The first utterance's late cleanup doesn't clobber the new one.
    expect(controller.snapshot).toEqual({ phase: "recording", mode: "record" });
  });
});

describe("Record/Ask is frozen per utterance", () => {
  it("switching the selected mode after recording starts cannot reroute the utterance", async () => {
    let selectedMode: UtteranceMode = "ask";
    const { start, processed, controller } = await setup();
    await start(selectedMode);
    selectedMode = "record"; // the pill is changed mid-recording
    await feed(QUIET, 320);
    await feed(SPEECH, 800);
    await feed(QUIET, 1700);
    expect(selectedMode).toBe("record");
    await advance(300);
    expect(processed).toEqual([expect.objectContaining({ mode: "ask" })]);
    expect(controller.snapshot.mode).toBeNull();
  });

  it("the window is the one for the mode at start, not the current selection", async () => {
    const { start, processed } = await setup();
    await start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 800);
    await feed(QUIET, 1800); // would have finished an Ask
    expect(processed).toHaveLength(0);
  });

  it("exposes the frozen mode while recording and processing, for the UI lock", async () => {
    const snapshots: string[] = [];
    let finishProcessing!: () => void;
    const recorderRef: { current: VoiceRecorder | null } = { current: null };
    function Harness() {
      recorderRef.current = useVoiceRecorder();
      return null;
    }
    await act(async () => {
      create(<Harness />);
    });
    const controller = new ManualUtteranceController({
      startRecording: (o) => recorderRef.current!.startRecording(o),
      stopRecording: () => recorderRef.current!.stopRecording(),
      processUtterance: () => new Promise<void>((resolve) => (finishProcessing = resolve)),
      onChange: (s) => snapshots.push(`${s.phase}:${s.mode}`),
    });
    await act(async () => {
      await controller.start("ask");
    });
    await act(async () => {
      void controller.finish("tap");
      await flush();
    });
    await advance(300);
    await act(async () => {
      finishProcessing();
      await flush();
    });
    expect(snapshots).toEqual(["starting:ask", "recording:ask", "processing:ask", "idle:null"]);
  });
});

describe("recorder guards (unchanged)", () => {
  it("a double tap to start opens one capture session", async () => {
    const { recorder } = await setup();
    await act(async () => {
      await Promise.all([recorder().startRecording(), recorder().startRecording()]);
    });
    expect(mockAudioRecord.init).toHaveBeenCalledTimes(1);
    expect(mockAudioRecord.start).toHaveBeenCalledTimes(1);
  });

  it("a double stop returns one recording and stops the mic once", async () => {
    const { recorder } = await setup();
    await act(async () => {
      await recorder().startRecording();
    });
    await feed(SPEECH, 500);
    let results: (string | null)[] = [];
    await act(async () => {
      const both = Promise.all([recorder().stopRecording(), recorder().stopRecording()]);
      jest.advanceTimersByTime(300);
      results = await both;
    });
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(mockAudioRecord.stop).toHaveBeenCalledTimes(1);
  });

  it("the controller ignores a second start while one is in flight", async () => {
    const { controller, start } = await setup();
    await act(async () => {
      await Promise.all([controller.start("record"), controller.start("ask")]);
    });
    expect(mockAudioRecord.init).toHaveBeenCalledTimes(1);
    expect(controller.snapshot).toEqual({ phase: "recording", mode: "record" });
    await start("ask"); // still recording: no-op
    expect(controller.snapshot.mode).toBe("record");
  });

  it("a stopped recording's auto-stop timer can't fire later", async () => {
    const { recorder } = await setup();
    const onAutoStop = jest.fn();
    await act(async () => {
      await recorder().startRecording({ autoStopAfterSilenceMs: 1500, onAutoStop });
    });
    await feed(QUIET, 320);
    await feed(SPEECH, 800);
    await act(async () => {
      const p = recorder().stopRecording();
      jest.advanceTimersByTime(300);
      await p;
    });
    await advance(5000);
    expect(onAutoStop).not.toHaveBeenCalled();
  });
});

describe("Handsfree taps keep their meaning", () => {
  const base = { manualPhase: "idle" as const, isRecorderTransitioning: false };
  it("a tap during Handsfree processing still cancels it", () => {
    expect(decideCentralTap({ ...base, isProcessing: true, isHandsfreeActive: true })).toBe("cancel-handsfree-processing");
  });
  it("a tap while Handsfree is capturing still discards that utterance and never starts a manual recording", () => {
    expect(decideCentralTap({ ...base, isProcessing: false, isHandsfreeActive: true })).toBe("cancel-handsfree-capture");
  });
  it("a tap mid-transition is ignored", () => {
    expect(decideCentralTap({ ...base, isProcessing: false, isHandsfreeActive: false, isRecorderTransitioning: true })).toBe(
      "ignore"
    );
  });
});
