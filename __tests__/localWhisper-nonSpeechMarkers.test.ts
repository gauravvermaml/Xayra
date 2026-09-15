/**
 * QA Phase 3, Agent 4 test backlog item 2 (qa/04-test-strategy-report.md):
 * locks in `stripNonSpeechMarkers` (services/ai/localWhisper.ts), which
 * removes whisper.cpp's own non-speech segment markers (confirmed live on a
 * real Handsfree recording: "...call Papa tonight at 6 p.m. [BLANK_AUDIO]")
 * wherever they occur in a transcript, in either bracket style, without
 * touching real surrounding speech.
 */
jest.mock("whisper.rn/index", () => ({
  initWhisper: jest.fn(),
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///fake-doc-dir/",
  getInfoAsync: jest.fn(() => Promise.resolve({ exists: true })),
}));

import { stripNonSpeechMarkers } from "../services/ai/localWhisper";

describe("stripNonSpeechMarkers", () => {
  it("strips a trailing bracketed marker, keeping the real speech before it", () => {
    expect(stripNonSpeechMarkers("call Papa tonight at 6 p.m. [BLANK_AUDIO]")).toBe("call Papa tonight at 6 p.m.");
  });

  it("strips a leading marker", () => {
    expect(stripNonSpeechMarkers("[SILENCE] remember to buy milk")).toBe("remember to buy milk");
  });

  it("strips a parenthesized marker in the middle of real speech", () => {
    expect(stripNonSpeechMarkers("call Papa (silence) tonight at 6")).toBe("call Papa tonight at 6");
  });

  it("is case-insensitive and handles multiple documented marker types in one transcript", () => {
    expect(stripNonSpeechMarkers("[MUSIC] hello there [NOISE] general kenobi (Inaudible)")).toBe(
      "hello there general kenobi"
    );
  });

  it("leaves a transcript with no markers untouched", () => {
    expect(stripNonSpeechMarkers("remind me to call the dentist tomorrow")).toBe(
      "remind me to call the dentist tomorrow"
    );
  });

  it("collapses the whitespace left behind by a stripped marker rather than leaving a double space", () => {
    const result = stripNonSpeechMarkers("hello  [BLANK_AUDIO]  world");
    expect(result).toBe("hello world");
  });
});
