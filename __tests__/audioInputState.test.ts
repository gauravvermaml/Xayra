/**
 * Phase 2 P1-1c (qa/05-consolidated-triage.md P1-1): the shared "is the mic
 * currently in use" signal that AudioPlayerControls and useChatSession's
 * toggleSpeech both gate playback on.
 */
import { isMicInUse, setMicInUse } from "../services/audio/audioInputState";

describe("audioInputState (Phase 2 P1-1c)", () => {
  afterEach(() => {
    setMicInUse(false);
  });

  it("defaults to not in use", () => {
    expect(isMicInUse()).toBe(false);
  });

  it("reflects the most recent call", () => {
    setMicInUse(true);
    expect(isMicInUse()).toBe(true);
    setMicInUse(false);
    expect(isMicInUse()).toBe(false);
  });
});
