/**
 * QA Phase 3, Agent 4 test backlog item 1 (qa/04-test-strategy-report.md):
 * locks in the Levenshtein fuzzy wake-word match (services/audio/
 * activeMode.ts, MAX_EDIT_DISTANCE=2) — Handsfree wake-word root-cause
 * chain bug #3 (Build 33): a hardcoded exact-spelling list rejected
 * plausible Whisper mis-transcriptions of "Xayra" ("zyra", "zaira", etc.);
 * replaced with a bounded edit-distance match against the canonical word.
 */
jest.mock("expo-audio", () => ({
  requestRecordingPermissionsAsync: jest.fn(),
  setAudioModeAsync: jest.fn(),
}));
jest.mock("expo-keep-awake", () => ({
  activateKeepAwakeAsync: jest.fn(),
  deactivateKeepAwake: jest.fn(),
}));
jest.mock("@fugood/react-native-audio-pcm-stream", () => ({
  __esModule: true,
  default: { init: jest.fn(), start: jest.fn(), stop: jest.fn(), on: jest.fn() },
}));
jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///fake-doc-dir/",
}));
jest.mock("../services/audio/player", () => ({ pausePlayback: jest.fn() }));
jest.mock("../services/audio/tts", () => ({ stopSpeech: jest.fn() }));

import { containsWakeWord } from "../services/audio/activeMode";

describe("containsWakeWord fuzzy match (Phase 3, Agent 4 backlog item 1)", () => {
  it("matches the exact canonical word", () => {
    expect(containsWakeWord("hey xayra what time is it")).toBe(true);
  });

  it("matches plausible near-miss Whisper transcriptions within edit distance 2", () => {
    expect(containsWakeWord("hey zyra can you help")).toBe(true); // distance 2 (missing 'a', 'x'->'z')
    expect(containsWakeWord("ok zaira remind me")).toBe(true); // distance 2
  });

  it("rejects a transcript with no plausible match at all", () => {
    expect(containsWakeWord("remind me to call the dentist tomorrow")).toBe(false);
  });

  it("rejects a real, plausible name that's still outside the edit-distance gate", () => {
    // Per activeMode.ts's own doc comment: "sarah" sits at edit-distance 3
    // from "xayra" — deliberately just outside MAX_EDIT_DISTANCE=2, the
    // exact boundary this gate exists to draw (raising it further starts
    // pulling in unrelated short words as false positives).
    expect(containsWakeWord("is sarah coming over tonight")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(containsWakeWord("HEY XAYRA")).toBe(true);
  });
});
