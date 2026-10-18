/**
 * Xayra 2.0 Stage 5a: Cancel during an active manual recording. Cancel
 * closes the microphone and throws the utterance away — never transcribed,
 * saved, asked or turned into a to-do — and is distinct from the existing
 * processing Cancel.
 *
 * Runs the real recorder hook (mic mocked, fed synthetic PCM on a fake
 * clock) wired to the real ManualUtteranceController, as app/index.tsx
 * wires them. `processUtterance` is the controller's only route into the
 * pipeline (transcription → note / Ask / reminder), so "never processed"
 * means none of those happen.
 */
import { act, create } from "react-test-renderer";
import { Alert, AppState, type AppStateStatus } from "react-native";
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
jest.mock("../services/ai/localWhisper", () => ({ cancelActiveTranscription: jest.fn() }));
jest.mock("../services/ai/localLlama", () => ({ cancelActiveLlamaCompletion: jest.fn() }));

import AudioRecord from "@fugood/react-native-audio-pcm-stream";
import { isMicInUse } from "../services/audio/audioInputState";
import { useVoiceRecorder, type VoiceRecorder } from "../services/audio/recorder";
import { writePcmChunksAsWav } from "../services/audio/wav";
import {
  decideCentralTap,
  ManualUtteranceController,
  type ManualUtterancePhase,
  type UtteranceMode,
} from "../services/audio/manualUtterance";

const mockAudioRecord = AudioRecord as unknown as Record<"init" | "start" | "stop", jest.Mock>;
const mockWrite = writePcmChunksAsWav as jest.Mock;
const emit = (base64: string) => mockEmitData(base64);

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
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
/** Runs a controller call to completion, draining the recorder's 200 ms
 * stop/discard drain on the fake clock. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  let result!: T;
  await act(async () => {
    const p = fn();
    for (let i = 0; i < 5; i++) {
      jest.advanceTimersByTime(100);
      await flush();
    }
    result = await p;
  });
  return result;
}

type Processed = { uri: string; mode: UtteranceMode; trigger: string };

async function setup() {
  const recorderRef: { current: VoiceRecorder | null } = { current: null };
  function Harness() {
    recorderRef.current = useVoiceRecorder();
    return null;
  }
  await act(async () => {
    mounted.push(create(<Harness />));
  });
  const processed: Processed[] = [];
  const phases: ManualUtterancePhase[] = [];
  const captureEnds: UtteranceMode[] = [];
  const cleanupErrors: unknown[] = [];
  const controller = new ManualUtteranceController({
    startRecording: (o) => recorderRef.current!.startRecording(o),
    stopRecording: () => recorderRef.current!.stopRecording(),
    discardRecording: () => recorderRef.current!.discardRecording(),
    processUtterance: async (uri, mode, trigger) => {
      processed.push({ uri, mode, trigger });
    },
    onChange: (s) => phases.push(s.phase),
    onCaptureEnd: (mode) => captureEnds.push(mode),
    onCancelCleanupError: (err) => cleanupErrors.push(err),
  });
  const start = (mode: UtteranceMode) => run(() => controller.start(mode));
  return { controller, processed, phases, captureEnds, cleanupErrors, start, recorder: () => recorderRef.current! };
}

// Unmounted after each test: the recorder hook closes the mic on unmount,
// as the real screen does, so no capture leaks into the next test.
const mounted: ReturnType<typeof create>[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockWavCount = 0;
});
afterEach(() => {
  act(() => mounted.splice(0).forEach((tree) => tree.unmount()));
  jest.useRealTimers();
});

/** Nothing reached the pipeline and no audio file was ever written. */
function expectNothingKept(s: { processed: Processed[]; captureEnds: UtteranceMode[] }) {
  expect(s.processed).toHaveLength(0);
  expect(s.captureEnds).toHaveLength(0);
  expect(mockWrite).not.toHaveBeenCalled();
}

describe("Cancel during recording discards the utterance", () => {
  it("before any speech: mic closed once, nothing written or processed, idle", async () => {
    const s = await setup();
    await s.start("record");
    await feed(QUIET, 500);
    expect(await run(() => s.controller.cancel())).toBe(true);
    expect(mockAudioRecord.stop).toHaveBeenCalledTimes(1);
    expect(isMicInUse()).toBe(false);
    expect(s.controller.snapshot).toEqual({ phase: "idle", mode: null });
    await advance(5000);
    expectNothingKept(s);
  });

  it("after speech has started: the trailing silence later never finishes it", async () => {
    const s = await setup();
    await s.start("record");
    await feed(QUIET, 320);
    await feed(SPEECH, 1200);
    expect(await run(() => s.controller.cancel())).toBe(true);
    await feed(QUIET, 3000);
    await advance(1000);
    expectNothingKept(s);
  });

  it("Ask: cancelled before its question exists — no voice-Ask reservation or chat entry", async () => {
    const s = await setup();
    await s.start("ask");
    await feed(SPEECH, 800);
    await run(() => s.controller.cancel());
    await feed(QUIET, 3000);
    expectNothingKept(s);
  });

  it("just before silence auto-finish: Cancel wins and the auto-stop never fires", async () => {
    const s = await setup();
    await s.start("ask");
    await feed(QUIET, 320);
    await feed(SPEECH, 1000);
    await feed(QUIET, 1280); // Ask finishes after 1500 ms of trailing silence
    expect(await run(() => s.controller.cancel())).toBe(true);
    await feed(QUIET, 2000);
    await advance(1000);
    expectNothingKept(s);
  });

  it("just after silence auto-finish: Cancel is a no-op and the utterance is processed once", async () => {
    const s = await setup();
    await s.start("ask");
    await feed(QUIET, 320);
    await feed(SPEECH, 1000);
    await feed(QUIET, 1800);
    await advance(400);
    expect(await run(() => s.controller.cancel())).toBe(false);
    expect(s.processed).toHaveLength(1);
    expect(s.processed[0]).toMatchObject({ mode: "ask", trigger: "silence" });
  });

  it("racing a manual Finish: whichever comes first wins, exactly once", async () => {
    const a = await setup();
    await a.start("record");
    await feed(SPEECH, 600);
    let cancelled!: boolean;
    await run(async () => {
      const finishing = a.controller.finish("tap");
      cancelled = await a.controller.cancel();
      await finishing;
    });
    expect(cancelled).toBe(false);
    expect(a.processed).toHaveLength(1);

    jest.clearAllMocks();
    const b = await setup();
    await b.start("record");
    await feed(SPEECH, 600);
    await run(async () => {
      const cancelling = b.controller.cancel();
      await b.controller.finish("tap");
      cancelled = await cancelling;
    });
    expect(cancelled).toBe(true);
    expectNothingKept(b);
  });

  it("repeated Cancel taps clean up once", async () => {
    const s = await setup();
    await s.start("record");
    let results!: boolean[];
    await run(async () => {
      results = await Promise.all([s.controller.cancel(), s.controller.cancel(), s.controller.cancel()]);
    });
    expect(results).toEqual([true, false, false]);
    expect(mockAudioRecord.stop).toHaveBeenCalledTimes(1);
    expect(s.phases.filter((p) => p === "cancelling")).toHaveLength(1);
  });

  it("a Cancel aimed at an earlier recording never cancels a newer one", async () => {
    const s = await setup();
    await s.start("record");
    const firstId = s.controller.utteranceId;
    await run(() => s.controller.cancel(firstId));
    await s.start("record");
    expect(await run(() => s.controller.cancel(firstId))).toBe(false);
    expect(s.controller.snapshot.phase).toBe("recording");
  });

  it("once capture has ended (processing), Cancel leaves it to the processing Cancel", async () => {
    let releaseProcessing!: () => void;
    const s = await setup();
    const controller = new ManualUtteranceController({
      startRecording: (o) => s.recorder().startRecording(o),
      stopRecording: () => s.recorder().stopRecording(),
      discardRecording: () => s.recorder().discardRecording(),
      processUtterance: () => new Promise<void>((resolve) => (releaseProcessing = resolve)),
    });
    await run(() => controller.start("record"));
    await feed(SPEECH, 500);
    await act(async () => {
      void controller.finish("tap");
      jest.advanceTimersByTime(300);
      await flush();
    });
    expect(controller.snapshot.phase).toBe("processing");
    expect(await run(() => controller.cancel())).toBe(false);
    expect(controller.snapshot.phase).toBe("processing");
    await act(async () => releaseProcessing());
  });
});

describe("lifecycle and failures", () => {
  it("a microphone stop failure still releases the mic, returns to idle and allows a new recording", async () => {
    const s = await setup();
    await s.start("record");
    mockAudioRecord.stop.mockImplementationOnce(() => {
      throw new Error("native stop failed");
    });
    expect(await run(() => s.controller.cancel())).toBe(true);
    expect(s.cleanupErrors).toHaveLength(1);
    expect(isMicInUse()).toBe(false);
    expect(s.controller.snapshot).toEqual({ phase: "idle", mode: null });
    expectNothingKept(s);

    await s.start("record");
    expect(s.controller.snapshot.phase).toBe("recording");
  });

  it("cancelled while the microphone is still opening: it never opens", async () => {
    const expoAudio = require("expo-audio") as { requestRecordingPermissionsAsync: jest.Mock };
    let grant!: () => void;
    expoAudio.requestRecordingPermissionsAsync.mockImplementationOnce(
      () => new Promise((resolve) => (grant = () => resolve({ granted: true })))
    );
    const s = await setup();
    let starting!: Promise<void>;
    act(() => {
      starting = s.controller.start("ask");
    });
    expect(s.controller.snapshot.phase).toBe("starting");
    await run(async () => {
      expect(await s.controller.cancel()).toBe(true);
      grant();
      await starting;
    });
    expect(mockAudioRecord.start).not.toHaveBeenCalled();
    expect(isMicInUse()).toBe(false);
    expect(s.controller.snapshot).toEqual({ phase: "idle", mode: null });
    expectNothingKept(s);
  });

  it("backgrounded during capture, then cancelled: no 'may be incomplete' warning, now or on the next recording", async () => {
    const alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
    const s = await setup();
    // The recorder's own AppState listener, as registered with the preset's
    // AppState mock (not re-spied: restoring a spy strips that mock).
    const calls = (AppState.addEventListener as unknown as jest.Mock).mock.calls;
    const appStateHandler = calls[calls.length - 1][1] as (s: AppStateStatus) => void;
    await s.start("record");
    act(() => appStateHandler("background"));
    act(() => appStateHandler("active"));
    await run(() => s.controller.cancel());
    await s.start("record");
    await feed(SPEECH, 500);
    await run(() => s.controller.finish("tap"));
    expect(s.processed).toHaveLength(1);
    expect(alertSpy).not.toHaveBeenCalled();
    alertSpy.mockRestore();
  });

  it("the screen going away: a disposed controller's Cancel does nothing (the recorder closes the mic itself)", async () => {
    const s = await setup();
    await s.start("record");
    s.controller.dispose();
    expect(await run(() => s.controller.cancel())).toBe(false);
  });

  it("the mode lock holds while cancelling and is released after; taps meanwhile are ignored", async () => {
    const s = await setup();
    await s.start("ask");
    let duringCancel!: ManualUtterancePhase;
    await run(async () => {
      const p = s.controller.cancel();
      duringCancel = s.controller.snapshot.phase;
      expect(
        decideCentralTap({
          manualPhase: duringCancel,
          isProcessing: false,
          isHandsfreeActive: false,
          isRecorderTransitioning: false,
        })
      ).toBe("ignore");
      await p;
    });
    expect(duringCancel).toBe("cancelling");
    expect(s.phases.slice(-3)).toEqual(["recording", "cancelling", "idle"]);
  });

  it("a recording started after a Cancel finishes and is processed normally, with its own mode", async () => {
    const s = await setup();
    await s.start("record");
    await run(() => s.controller.cancel());
    await s.start("ask");
    await feed(QUIET, 320);
    await feed(SPEECH, 1000);
    await feed(QUIET, 1800);
    await advance(400);
    expect(s.processed).toEqual([expect.objectContaining({ mode: "ask", trigger: "silence" })]);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });
});
