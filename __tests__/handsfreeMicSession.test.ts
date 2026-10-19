/**
 * Gate B step 3: Handsfree on the native session API. MOCK-BASED (fake
 * native module); native behaviour is verified on the emulator.
 */
jest.mock("@fugood/react-native-audio-pcm-stream", () => require("./support/fakeMicNative").fakeMicModule);
jest.mock("expo-audio", () => ({
  getRecordingPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  requestRecordingPermissionsAsync: jest.fn(() => Promise.resolve({ granted: true })),
  setAudioModeAsync: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(() => Promise.resolve()),
  deactivateKeepAwake: jest.fn(() => Promise.resolve()),
}));
jest.mock("expo-file-system/legacy", () => ({ cacheDirectory: "file:///fake-cache/", documentDirectory: "file:///fake-doc-dir/" }));
jest.mock("../services/audio/wav", () => ({
  ...jest.requireActual("../services/audio/wav"),
  writePcmChunksAsWav: jest.fn(() => Promise.resolve("file:///fake-cache/recordings/hf.wav")),
}));
jest.mock("../services/audio/player", () => ({ pausePlayback: jest.fn() }));
jest.mock("../services/audio/tts", () => ({ stopSpeech: jest.fn(() => Promise.resolve()) }));
jest.mock("../services/audio/wakeChime", () => ({ preloadWakeChime: jest.fn(), releaseWakeChime: jest.fn() }));
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn(), logDuration: jest.fn(), nowMs: jest.fn(() => 0) }));

import AudioRecord from "@fugood/react-native-audio-pcm-stream";

import { fakeMic } from "./support/fakeMicNative";
import { ActiveModeManager } from "../services/audio/activeMode";
import { isMicInUse } from "../services/audio/audioInputState";
import { getMicSnapshot, MicBusyError, openMicSession, resetMicSessionForTests, stopMicSession } from "../services/audio/micSession";

const OPTIONS = { sampleRate: 16000, channels: 1, bitsPerSample: 16 };

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
async function drive<T>(p: Promise<T>, maxMs = 15000): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  let outcome: { ok: true; value: T } | { ok: false; error: unknown } | null = null;
  p.then(
    (value) => (outcome = { ok: true, value }),
    (error) => (outcome = { ok: false, error })
  );
  for (let t = 0; t < maxMs && !outcome; t += 25) {
    jest.advanceTimersByTime(25);
    await flush();
  }
  if (!outcome) throw new Error("did not settle");
  return outcome;
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  fakeMic.reset();
  resetMicSessionForTests();
});
afterEach(() => jest.useRealTimers());

describe("Handsfree on micSession", () => {
  it("one native session per engagement; free only after native release", async () => {
    fakeMic.ackMode = "manual";
    const manager = new ActiveModeManager({ onUtterance: jest.fn(() => Promise.resolve()) });
    await manager.start();
    expect(AudioRecord.initSession).toHaveBeenCalledTimes(1);
    expect(getMicSnapshot().owner).toBe("handsfree");
    const stopping = drive(manager.stop());
    await flush();
    expect(isMicInUse()).toBe(true); // stop requested, not yet released
    fakeMic.releaseNow();
    expect((await stopping).ok).toBe(true);
    expect(manager.isRunning).toBe(false);
    expect(isMicInUse()).toBe(false);
  });

  it("release unconfirmed: Handsfree shows a failed stop (not 'off'), the mic stays busy; Stop again retries", async () => {
    fakeMic.ackMode = "manual";
    fakeMic.stuck = true;
    const manager = new ActiveModeManager({ onUtterance: jest.fn(() => Promise.resolve()) });
    await manager.start();
    const first = await drive(manager.stop());
    expect(first.ok).toBe(false);
    if (first.ok) throw new Error();
    expect(first.error).toBeInstanceOf(MicBusyError);
    expect(manager.isRunning).toBe(true);
    expect(manager.stopFailed).toBe(true);
    expect(isMicInUse()).toBe(true);
    // A manual recording can't start meanwhile.
    expect((await drive(openMicSession("manual", OPTIONS, {}, { collect: true }))).ok).toBe(false);
    // The native side finally releases; Stop again confirms it.
    fakeMic.stuck = false;
    fakeMic.releaseNow();
    const second = await drive(manager.stop());
    expect(second.ok).toBe(true);
    expect(manager.stopFailed).toBe(false);
    expect(manager.isRunning).toBe(false);
    expect(isMicInUse()).toBe(false);
  });

  it("a failed release: Handsfree stays shown as a failed stop; nothing else can open", async () => {
    fakeMic.failRelease = true;
    const manager = new ActiveModeManager({ onUtterance: jest.fn(() => Promise.resolve()) });
    await manager.start();
    expect((await drive(manager.stop())).ok).toBe(false);
    expect(manager.stopFailed).toBe(true);
    expect(getMicSnapshot().phase).toBe("releaseFailed");
    expect((await drive(openMicSession("manual", OPTIONS, {}, { collect: true }))).ok).toBe(false);
  });

  it("manual ↔ Handsfree: neither opens while the other owns (or is releasing) the microphone", async () => {
    // Manual first: Handsfree can't open.
    const manualId = await openMicSession("manual", OPTIONS, {}, { collect: true });
    const manager = new ActiveModeManager({ onUtterance: jest.fn(() => Promise.resolve()) });
    expect((await drive(manager.start())).ok).toBe(false);
    expect(manager.isRunning).toBe(false);
    // Manual stops (released) → Handsfree opens.
    await drive(stopMicSession(manualId));
    expect((await drive(manager.start())).ok).toBe(true);
    expect(getMicSnapshot().owner).toBe("handsfree");
    // Handsfree owns it → manual refused; after Handsfree's release → opens.
    expect((await drive(openMicSession("manual", OPTIONS, {}, { collect: true }))).ok).toBe(false);
    await drive(manager.stop());
    expect((await drive(openMicSession("manual", OPTIONS, {}, { collect: true }))).ok).toBe(true);
    expect(AudioRecord.initSession).toHaveBeenCalledTimes(3); // never two at once
  });

  it("rapid toggles never open two native sessions", async () => {
    const manager = new ActiveModeManager({ onUtterance: jest.fn(() => Promise.resolve()) });
    for (let i = 0; i < 5; i++) {
      await drive(manager.start());
      await drive(manager.stop());
    }
    expect(AudioRecord.initSession).toHaveBeenCalledTimes(5);
    expect(fakeMic.owner).toBeNull();
    expect(isMicInUse()).toBe(false);
  });
});
