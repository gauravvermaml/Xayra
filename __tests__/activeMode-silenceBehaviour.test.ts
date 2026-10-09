/**
 * Characterizes Handsfree's listen → speech → trailing-silence loop
 * (ActiveModeManager). Written against the original implementation before
 * its silence detector was shared with the manual recorder, so these lock
 * the Handsfree timings and thresholds in unchanged.
 */
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

import { ActiveModeManager } from "../services/audio/activeMode";

const emit = (base64: string) => mockEmitData(base64);

async function startManager() {
  const onUtterance = jest.fn(() => Promise.resolve());
  const manager = new ActiveModeManager({ onUtterance });
  await manager.start();
  return { manager, onUtterance };
}

/** Lets the async finalize (WAV write → onUtterance) settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("Handsfree silence detection (unchanged by the shared detector)", () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it("hands an utterance off after ~1.5 s of trailing silence, exactly once", async () => {
    const { manager, onUtterance } = await startManager();
    feedAudio(emit, QUIET, 320); // calibration
    feedAudio(emit, SPEECH, 1000);
    feedAudio(emit, QUIET, 1300);
    await flush();
    expect(onUtterance).not.toHaveBeenCalled();
    feedAudio(emit, QUIET, 500);
    await flush();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    feedAudio(emit, QUIET, 3000);
    await flush();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("never hands off a cycle with no speech, however long it listens", async () => {
    const { manager, onUtterance } = await startManager();
    feedAudio(emit, QUIET, 10_000);
    await flush();
    expect(onUtterance).not.toHaveBeenCalled();
    expect(manager.state).toBe("listening");
    await manager.stop();
  });

  it("keeps its 60 s safety cap when the room never goes quiet", async () => {
    const { manager, onUtterance } = await startManager();
    feedAudio(emit, QUIET, 320);
    feedAudio(emit, SPEECH, 59_000);
    await flush();
    expect(onUtterance).not.toHaveBeenCalled();
    feedAudio(emit, SPEECH, 1_200);
    await flush();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("adapts its threshold to the room: a quiet room hears a soft voice", async () => {
    const { manager, onUtterance } = await startManager();
    feedAudio(emit, QUIET, 320); // floor 0.001 -> threshold clamps to 0.006
    feedAudio(emit, 0.01, 800);
    feedAudio(emit, QUIET, 1800);
    await flush();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("never needs a louder trigger than the old fixed 0.02, but ignores sound below it in a noisy room", async () => {
    const { manager, onUtterance } = await startManager();
    feedAudio(emit, 0.012, 320); // floor 0.012 -> threshold clamps to 0.02
    feedAudio(emit, 0.015, 800); // below threshold: not speech
    feedAudio(emit, 0.012, 1800);
    await flush();
    expect(onUtterance).not.toHaveBeenCalled();
    feedAudio(emit, 0.03, 800); // above it: speech
    feedAudio(emit, 0.012, 1800);
    await flush();
    expect(onUtterance).toHaveBeenCalledTimes(1);
    await manager.stop();
  });

  it("cancelCurrentUtterance only acts once speech has been heard", async () => {
    const { manager, onUtterance } = await startManager();
    feedAudio(emit, QUIET, 600);
    expect(manager.cancelCurrentUtterance()).toBe(false);
    feedAudio(emit, SPEECH, 600);
    expect(manager.cancelCurrentUtterance()).toBe(true);
    feedAudio(emit, QUIET, 2000);
    await flush();
    expect(onUtterance).not.toHaveBeenCalled();
    await manager.stop();
  });
});
