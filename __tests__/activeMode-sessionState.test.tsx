/**
 * Xayra 2.0 Stage 5b: Handsfree's visible state comes from its controller
 * alone and is never wrong — listening, processing and speaking as they
 * happen; Stop ends the session in every phase; a stopped session's late
 * reports can't relight it (or a newer one); rapid taps and a Stop during
 * the start can't open a second microphone session or leave it "on".
 */
import { act, create } from "react-test-renderer";
import { AppState, type AppStateStatus } from "react-native";
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
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(() => Promise.resolve()),
  deactivateKeepAwake: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///fake-cache/",
  documentDirectory: "file:///fake-doc-dir/",
}));
jest.mock("../services/audio/wav", () => ({
  ...jest.requireActual("../services/audio/wav"),
  writePcmChunksAsWav: jest.fn(() => Promise.resolve("file:///fake-cache/recordings/active-mode.wav")),
}));
jest.mock("../services/audio/player", () => ({ pausePlayback: jest.fn() }));
jest.mock("../services/audio/tts", () => ({ stopSpeech: jest.fn(() => Promise.resolve()) }));
jest.mock("../services/audio/wakeChime", () => ({ preloadWakeChime: jest.fn(), releaseWakeChime: jest.fn() }));

import AudioRecord from "@fugood/react-native-audio-pcm-stream";
import { ActiveModeManager, type ActiveModeState, type UseActiveMode, useActiveMode } from "../services/audio/activeMode";
import { isMicInUse } from "../services/audio/audioInputState";

const mockAudioRecord = AudioRecord as unknown as Record<"init" | "start" | "stop", jest.Mock>;
const emit = (base64: string) => mockEmitData(base64);

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

type ReportState = (state: "processing" | "speaking") => void;

/** A manager whose utterance pipeline is held open until released, so each
 * phase can be stopped in. */
function heldManager() {
  const states: ActiveModeState[] = [];
  let report!: ReportState;
  let finish!: () => void;
  const onUtterance = jest.fn(
    (_uri: string, reportState: ReportState) =>
      new Promise<void>((resolve) => {
        report = reportState;
        finish = resolve;
      })
  );
  const manager = new ActiveModeManager({ onUtterance, onStateChange: (s) => states.push(s) });
  return { manager, states, onUtterance, report: (s: "processing" | "speaking") => report(s), finish: () => finish() };
}

/** Speech then trailing silence: hands one utterance to the pipeline. */
async function speakOnce() {
  feedAudio(emit, QUIET, 320);
  feedAudio(emit, SPEECH, 1000);
  feedAudio(emit, QUIET, 1800);
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

describe("state follows the real phase", () => {
  it("listening → processing → speaking → listening again", async () => {
    const h = heldManager();
    await h.manager.start();
    expect(h.manager.state).toBe("listening");
    await speakOnce();
    expect(h.manager.state).toBe("processing");
    h.report("speaking");
    expect(h.manager.state).toBe("speaking");
    h.finish();
    await flush();
    expect(h.manager.state).toBe("listening");
    expect(h.states).toEqual(["listening", "processing", "speaking", "listening"]);
    await h.manager.stop();
  });
});

describe("Stop ends the session in every phase", () => {
  it("while listening: off, microphone closed once and released", async () => {
    const h = heldManager();
    await h.manager.start();
    expect(isMicInUse()).toBe(true);
    await h.manager.stop();
    expect(h.manager.state).toBe("idle");
    expect(h.manager.isRunning).toBe(false);
    expect(mockAudioRecord.stop).toHaveBeenCalledTimes(1);
    expect(isMicInUse()).toBe(false);
  });

  it("while processing: off at once; the pipeline's late 'speaking' and its finish can't relight it", async () => {
    const h = heldManager();
    await h.manager.start();
    await speakOnce();
    expect(h.manager.state).toBe("processing");
    await h.manager.stop();
    expect(h.manager.state).toBe("idle");
    h.report("speaking");
    h.finish();
    await flush();
    expect(h.manager.state).toBe("idle");
    expect(h.states[h.states.length - 1]).toBe("idle");
    expect(isMicInUse()).toBe(false);
  });

  it("while speaking: off at once and stays off when the speech ends", async () => {
    const h = heldManager();
    await h.manager.start();
    await speakOnce();
    h.report("speaking");
    await h.manager.stop();
    expect(h.manager.state).toBe("idle");
    h.finish();
    await flush();
    expect(h.manager.state).toBe("idle");
  });

  it("a stopped session's late reports never touch a newer session", async () => {
    const h = heldManager();
    await h.manager.start();
    await speakOnce();
    await h.manager.stop();
    await h.manager.start();
    expect(h.manager.state).toBe("listening");
    h.report("speaking");
    h.finish();
    await flush();
    expect(h.manager.state).toBe("listening");
    await h.manager.stop();
  });
});

describe("starting doesn't pause the app", () => {
  it("an already-granted microphone permission is checked, never re-requested (requesting pauses the app)", async () => {
    const expoAudio = require("expo-audio") as Record<string, jest.Mock>;
    expoAudio.getRecordingPermissionsAsync = jest.fn(() => Promise.resolve({ granted: true }));
    try {
      const h = heldManager();
      await h.manager.start();
      expect(h.manager.isRunning).toBe(true);
      expect(expoAudio.requestRecordingPermissionsAsync).not.toHaveBeenCalled();
      await h.manager.stop();
    } finally {
      delete expoAudio.getRecordingPermissionsAsync;
    }
  });
});

describe("starts and stops that overlap", () => {
  it("two starts at once open one microphone session", async () => {
    const h = heldManager();
    await Promise.all([h.manager.start(), h.manager.start()]);
    expect(mockAudioRecord.init).toHaveBeenCalledTimes(1);
    expect(mockAudioRecord.start).toHaveBeenCalledTimes(1);
    await h.manager.stop();
  });

  it("a Stop while the start is still opening: the microphone never opens", async () => {
    const h = heldManager();
    const starting = h.manager.start();
    expect(h.manager.isEngaged).toBe(true);
    expect(h.manager.isRunning).toBe(false);
    await h.manager.stop();
    await starting;
    expect(mockAudioRecord.init).not.toHaveBeenCalled();
    expect(mockAudioRecord.start).not.toHaveBeenCalled();
    expect(h.manager.isEngaged).toBe(false);
    expect(isMicInUse()).toBe(false);
  });
});

describe("useActiveMode mirrors the controller", () => {
  async function mountHook() {
    const ref: { current: UseActiveMode | null } = { current: null };
    function Harness() {
      ref.current = useActiveMode(() => Promise.resolve());
      return null;
    }
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness />);
    });
    return { hf: () => ref.current!, tree };
  }

  it("rapid on/off taps end off, with no session left open", async () => {
    const { hf, tree } = await mountHook();
    await act(async () => {
      const first = hf().toggle();
      const second = hf().toggle();
      await Promise.all([first, second]);
    });
    expect(hf().isActive).toBe(false);
    expect(mockAudioRecord.start).not.toHaveBeenCalled();
    expect(isMicInUse()).toBe(false);
    act(() => tree.unmount());
  });

  it("on, then off, then on again — each reflected exactly", async () => {
    const { hf, tree } = await mountHook();
    await act(async () => hf().toggle());
    expect(hf().isActive).toBe(true);
    expect(hf().state).toBe("listening");
    await act(async () => hf().toggle());
    expect(hf().isActive).toBe(false);
    expect(hf().state).toBe("idle");
    await act(async () => hf().toggle());
    expect(hf().isActive).toBe(true);
    act(() => tree.unmount());
  });

  /** Holds the permission step open so the start is genuinely in flight. */
  function holdPermission() {
    const expoAudio = require("expo-audio") as { requestRecordingPermissionsAsync: jest.Mock };
    let release!: () => void;
    expoAudio.requestRecordingPermissionsAsync.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ granted: true })))
    );
    return () => release();
  }
  const appStateHandler = () => {
    const calls = (AppState.addEventListener as unknown as jest.Mock).mock.calls;
    return calls[calls.length - 1][1] as (s: AppStateStatus) => void;
  };

  it("shows 'starting' while the start is opening the microphone, then listening", async () => {
    const { hf, tree } = await mountHook();
    const grant = holdPermission();
    let toggling!: Promise<void>;
    act(() => {
      toggling = hf().toggle();
    });
    expect(hf().isStarting).toBe(true);
    expect(hf().isActive).toBe(false);
    await act(async () => {
      grant();
      await toggling;
    });
    expect(hf().isStarting).toBe(false);
    expect(hf().isActive).toBe(true);
    act(() => tree.unmount());
  });

  it("a second tap while starting turns it off: never left on, microphone never opened", async () => {
    const { hf, tree } = await mountHook();
    const grant = holdPermission();
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = hf().toggle();
    });
    act(() => {
      second = hf().toggle();
    });
    await act(async () => {
      grant();
      await Promise.all([first, second]);
    });
    expect(hf().isStarting).toBe(false);
    expect(hf().isActive).toBe(false);
    expect(mockAudioRecord.start).not.toHaveBeenCalled();
    act(() => tree.unmount());
  });

  it("the permission check's own background→active flicker during the start doesn't turn it off", async () => {
    const { hf, tree } = await mountHook();
    const grant = holdPermission();
    let toggling!: Promise<void>;
    act(() => {
      toggling = hf().toggle();
    });
    await act(async () => {
      appStateHandler()("background");
      appStateHandler()("active");
      grant();
      await toggling;
    });
    expect(hf().isActive).toBe(true);
    expect(hf().state).toBe("listening");
    expect(mockAudioRecord.start).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
  });

  it("really leaving the app while the start is opening ends off", async () => {
    const { hf, tree } = await mountHook();
    const grant = holdPermission();
    let toggling!: Promise<void>;
    act(() => {
      toggling = hf().toggle();
    });
    const original = AppState.currentState;
    Object.defineProperty(AppState, "currentState", { value: "background", configurable: true });
    await act(async () => {
      appStateHandler()("background");
      grant();
      await toggling;
    });
    Object.defineProperty(AppState, "currentState", { value: original, configurable: true });
    expect(hf().isActive).toBe(false);
    expect(isMicInUse()).toBe(false);
    act(() => tree.unmount());
  });

  it("going to the background turns it off (unchanged) and the UI follows", async () => {
    const { hf, tree } = await mountHook();
    await act(async () => hf().toggle());
    const calls = (AppState.addEventListener as unknown as jest.Mock).mock.calls;
    const onAppState = calls[calls.length - 1][1] as (s: AppStateStatus) => void;
    await act(async () => {
      onAppState("background");
      await flush();
    });
    expect(hf().isActive).toBe(false);
    expect(isMicInUse()).toBe(false);
    act(() => tree.unmount());
  });
});

describe("a native stop failure never reports the microphone free (mocked native module)", () => {
  const failNextStop = () =>
    mockAudioRecord.stop.mockImplementationOnce(() => {
      throw new Error("native stop failed");
    });

  it("controller: stays open and owning the mic, captures and re-arms nothing, and a retry stops it", async () => {
    const h = heldManager();
    await h.manager.start();
    await speakOnce();
    failNextStop();
    await expect(h.manager.stop()).rejects.toThrow("native stop failed");
    expect(h.manager.isRunning).toBe(true);
    expect(h.manager.stopFailed).toBe(true);
    expect(isMicInUse()).toBe(true);
    // The in-flight utterance's late report and finish can't revive it.
    h.report("speaking");
    h.finish();
    await flush();
    expect(h.manager.state).toBe("processing");
    expect(h.manager.cancelCurrentUtterance()).toBe(false);
    await speakOnce();
    expect(h.onUtterance).toHaveBeenCalledTimes(1);

    await h.manager.stop();
    expect(h.manager.isRunning).toBe(false);
    expect(h.manager.stopFailed).toBe(false);
    expect(isMicInUse()).toBe(false);
    expect(h.manager.state).toBe("idle");
  });

  it("hook: Stop reports failure, Handsfree stays on (not 'off'), and the next Stop retries", async () => {
    const ref: { current: UseActiveMode | null } = { current: null };
    function Harness() {
      ref.current = useActiveMode(() => Promise.resolve());
      return null;
    }
    let tree!: ReturnType<typeof create>;
    await act(async () => {
      tree = create(<Harness />);
    });
    await act(async () => ref.current!.toggle());
    failNextStop();
    let first!: boolean;
    await act(async () => {
      first = await ref.current!.stop();
    });
    expect(first).toBe(false);
    expect(ref.current!.isActive).toBe(true);
    expect(ref.current!.stopFailed).toBe(true);
    expect(isMicInUse()).toBe(true);

    let second!: boolean;
    await act(async () => {
      second = await ref.current!.stop();
    });
    expect(second).toBe(true);
    expect(ref.current!.isActive).toBe(false);
    expect(ref.current!.stopFailed).toBe(false);
    expect(isMicInUse()).toBe(false);
    act(() => tree.unmount());
  });

  it("a toggle while the stop has failed retries the stop (never starts a second session)", async () => {
    const h = heldManager();
    await h.manager.start();
    failNextStop();
    await h.manager.stop().catch(() => {});
    expect(h.manager.isEngaged).toBe(true);
    await h.manager.start();
    expect(mockAudioRecord.init).toHaveBeenCalledTimes(1);
    await h.manager.stop();
    expect(isMicInUse()).toBe(false);
  });
});

