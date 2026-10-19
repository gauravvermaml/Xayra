/**
 * Phase 2 P1-1c (qa/05-consolidated-triage.md P1-1): the shared "is the mic
 * currently in use" signal that AudioPlayerControls and useChatSession's
 * toggleSpeech both gate playback on — derived from micSession since Gate B.
 * MOCK-BASED (fake native module).
 */
jest.mock("@fugood/react-native-audio-pcm-stream", () => require("./support/fakeMicNative").fakeMicModule);
jest.mock("../services/ai/perf", () => ({ devTiming: jest.fn() }));

import { fakeMic } from "./support/fakeMicNative";
import { isMicInUse } from "../services/audio/audioInputState";
import { openMicSession, resetMicSessionForTests, stopMicSession } from "../services/audio/micSession";

describe("audioInputState (Phase 2 P1-1c, Gate B)", () => {
  beforeEach(() => {
    fakeMic.reset();
    resetMicSessionForTests();
  });

  it("defaults to not in use", () => {
    expect(isMicInUse()).toBe(false);
  });

  it("in use from opening until the native release is confirmed", async () => {
    fakeMic.ackMode = "manual";
    const opening = openMicSession("manual", { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, {}, { collect: false });
    expect(isMicInUse()).toBe(true);
    const id = await opening;
    const stopping = stopMicSession(id);
    await Promise.resolve();
    expect(isMicInUse()).toBe(true);
    fakeMic.releaseNow();
    await stopping;
    expect(isMicInUse()).toBe(false);
  });
});
