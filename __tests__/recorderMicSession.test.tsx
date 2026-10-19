/**
 * Gate B step 2: manual Record/Ask on the native session API. The recorder
 * reports the microphone free only after native release, never hides a
 * missing part of a recording, and never opens over a stuck capture.
 * MOCK-BASED (fake native module); native behaviour is verified on the
 * emulator.
 */
import { act, create } from "react-test-renderer";
import { Alert } from "react-native";
import { Buffer } from "buffer";

jest.mock("@fugood/react-native-audio-pcm-stream", () => require("./support/fakeMicNative").fakeMicModule);
jest.mock("expo-audio", () => ({
  getRecordingPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  requestRecordingPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "file:///fake-cache/",
  documentDirectory: "file:///fake-doc-dir/",
}));
jest.mock("../services/audio/wav", () => ({
  ...jest.requireActual("../services/audio/wav"),
  writePcmChunksAsWav: jest.fn(() => Promise.resolve("file:///fake-cache/recordings/note-1.wav")),
}));
jest.mock("../services/audio/player", () => ({ pausePlayback: jest.fn() }));
jest.mock("../services/audio/tts", () => ({ stopSpeech: jest.fn(() => Promise.resolve()) }));
jest.mock("../services/ai/perf", () => ({ logDuration: jest.fn(), nowMs: jest.fn(() => 0), devTiming: jest.fn() }));

import { fakeMic } from "./support/fakeMicNative";
import { useVoiceRecorder, type VoiceRecorder } from "../services/audio/recorder";
import { getMicSnapshot, MicBusyError, resetMicSessionForTests } from "../services/audio/micSession";
import { isMicInUse } from "../services/audio/audioInputState";
import { writePcmChunksAsWav } from "../services/audio/wav";

const mockWrite = writePcmChunksAsWav as jest.Mock;
const chunk = (n: number) => Buffer.from([n, n]).toString("base64");
let alertSpy: jest.SpyInstance;

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function drive<T>(p: Promise<T>, maxMs = 10000): Promise<T> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  p.then(
    (value) => (outcome = { ok: true, value }),
    (error) => (outcome = { ok: false, error })
  );
  for (let t = 0; t < maxMs && !outcome; t += 25) {
    await act(async () => {
      jest.advanceTimersByTime(25);
      await flush();
    });
  }
  const settled = outcome as { ok: true; value: T } | { ok: false; error: unknown } | null;
  if (!settled) throw new Error("did not settle");
  if (!settled.ok) throw settled.error;
  return settled.value;
}

async function mount() {
  const ref: { current: VoiceRecorder | null } = { current: null };
  function Harness() {
    ref.current = useVoiceRecorder();
    return null;
  }
  let tree!: ReturnType<typeof create>;
  await act(async () => {
    tree = create(<Harness />);
  });
  const recorder = () => ref.current!;
  await act(async () => {
    await recorder().startRecording();
  });
  return { tree, recorder };
}

const incompleteAlerts = () => alertSpy.mock.calls.filter((c) => c[0] === "Recording May Be Incomplete");
const writtenChunks = () => (mockWrite.mock.calls[0][0] as Buffer[]).map((b) => b[0]);

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  fakeMic.reset();
  resetMicSessionForTests();
  alertSpy = jest.spyOn(Alert, "alert").mockImplementation(() => {});
});
afterEach(() => {
  alertSpy.mockRestore();
  jest.useRealTimers();
});

describe("manual recording on micSession", () => {
  it("complete: every chunk, in order, no warning; free after native release", async () => {
    const { recorder } = await mount();
    [1, 2, 3].forEach((n) => fakeMic.emit(chunk(n)));
    const uri = await drive(recorder().stopRecording());
    expect(uri).toBe("file:///fake-cache/recordings/note-1.wav");
    expect(writtenChunks()).toEqual([1, 2, 3]);
    expect(incompleteAlerts()).toHaveLength(0);
    expect(isMicInUse()).toBe(false);
  });

  it("a missing middle chunk: the rest is kept and processed, with a warning", async () => {
    fakeMic.dropSeqs.add(2);
    const { recorder } = await mount();
    [1, 2, 3].forEach((n) => fakeMic.emit(chunk(n)));
    const uri = await drive(recorder().stopRecording());
    expect(uri).not.toBeNull();
    expect(writtenChunks()).toEqual([1, 3]);
    expect(incompleteAlerts()).toHaveLength(1);
  });

  it("a missing final chunk: the rest is kept and processed, with a warning", async () => {
    fakeMic.dropSeqs.add(3);
    const { recorder } = await mount();
    [1, 2, 3].forEach((n) => fakeMic.emit(chunk(n)));
    const uri = await drive(recorder().stopRecording());
    expect(uri).not.toBeNull();
    expect(writtenChunks()).toEqual([1, 2]);
    expect(incompleteAlerts()).toHaveLength(1);
  });

  it("release never confirmed: the captured audio is kept (with a warning), the microphone stays busy and nothing opens", async () => {
    fakeMic.ackMode = "manual";
    fakeMic.stuck = true;
    const { recorder } = await mount();
    fakeMic.emit(chunk(1));
    const uri = await drive(recorder().stopRecording());
    expect(uri).not.toBeNull();
    expect(writtenChunks()).toEqual([1]);
    expect(incompleteAlerts()).toHaveLength(1);
    expect(recorder().isRecording).toBe(false);
    expect(getMicSnapshot().phase).toBe("releaseUnconfirmed");
    expect(isMicInUse()).toBe(true);
    await expect(drive(recorder().startRecording())).rejects.toBeInstanceOf(MicBusyError);
    expect(fakeMic.owner?.id).toBe(1); // no second native session
  });

  it("a failed stop request: still recording, mic busy; the next tap to record closes it first", async () => {
    fakeMic.failStopCount = 1;
    const { recorder } = await mount();
    await expect(drive(recorder().stopRecording())).rejects.toBeInstanceOf(MicBusyError);
    expect(recorder().isRecording).toBe(true);
    expect(isMicInUse()).toBe(true);
    expect(mockWrite).not.toHaveBeenCalled();
    // A Cancel retries the stop and succeeds.
    await drive(recorder().discardRecording());
    expect(recorder().isRecording).toBe(false);
    expect(isMicInUse()).toBe(false);
  });

  it("Cancel: no audio file, free after native release", async () => {
    fakeMic.ackMode = "manual";
    const { recorder } = await mount();
    fakeMic.emit(chunk(1));
    const p = recorder().discardRecording();
    await act(async () => {
      await flush();
    });
    expect(isMicInUse()).toBe(true); // stop requested, not yet released
    fakeMic.releaseNow();
    await drive(p);
    expect(mockWrite).not.toHaveBeenCalled();
    expect(isMicInUse()).toBe(false);
  });

  it("no chunk from an older recording reaches a newer one", async () => {
    const { recorder } = await mount();
    fakeMic.emit(chunk(1));
    await drive(recorder().stopRecording());
    mockWrite.mockClear();
    await act(async () => {
      await recorder().startRecording();
    });
    fakeMic.fireData(1, 9, chunk(9)); // late chunk of recording 1
    fakeMic.emit(chunk(2));
    await drive(recorder().stopRecording());
    expect(writtenChunks()).toEqual([2]);
  });
});
