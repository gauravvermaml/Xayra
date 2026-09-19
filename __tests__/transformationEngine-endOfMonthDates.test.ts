/**
 * Regression cover for a date bug reproduced from a real on-device note.
 *
 * A voice note saying the tax return was due "7 days before the end of
 * September this year" produced an action date of 2026-09-12 — seven days
 * before TODAY (2026-09-19) rather than seven days before 30 September. The
 * to-do was therefore created already overdue, and its reminder could never
 * fire.
 *
 * Root cause, confirmed directly against chrono-node 2.x: it has no concept
 * of "end of <month>". It discards those words, keeps whatever fragment it
 * recognises ("7 days before"), and anchors that to the reference date.
 * The same gap makes a bare "end of September" resolve to 2027-09-01 —
 * wrong day and wrong year.
 *
 * Two defences, both asserted here: rewriting "end of <month>" to an
 * explicit date before chrono sees it, and a backstop that refuses to hand
 * back an action date in the past.
 */

jest.mock("expo-device-cpu", () => ({
  getThermalStatus: jest.fn(() => 0),
  ThermalStatus: { NONE: 0 },
}));
jest.mock("../services/ai/localLlama", () => ({
  CHAT_TEMPLATE_STOP_TOKENS: ["<|im_end|>"],
  runQueuedLlamaCompletion: jest.fn(),
  SHARED_XAYRA_PREAMBLE: "preamble\n\n",
}));
jest.mock("../services/ai/localWhisper", () => ({
  isTranscriptionInProgress: jest.fn(() => false),
}));

import { resolveDateAndTime } from "../services/ai/transformationEngine";

// A Saturday, deliberately mid-month so "end of September" is still ahead of
// it while "7 days before today" would land in the past.
const TODAY = "2026-09-19";

describe('"end of <month>" phrasing', () => {
  it("resolves the original failing note to 7 days before 30 September, not before today", () => {
    const { actionDate } = resolveDateAndTime(
      "7 days before the end of September this year",
      TODAY,
      "none"
    );
    expect(actionDate).toBe("2026-09-23");
  });

  it("treats a bare 'end of September' as the last day of the month, in the right year", () => {
    // chrono alone returns 2027-09-01 here — wrong day and wrong year.
    expect(resolveDateAndTime("end of September", TODAY, "none").actionDate).toBe("2026-09-30");
  });

  it("handles 'end of the month' against the current month", () => {
    expect(resolveDateAndTime("end of the month", TODAY, "none").actionDate).toBe("2026-09-30");
  });

  it("rolls to next year when the named month has already passed", () => {
    // Said in September, "end of March" means the March that is still ahead.
    expect(resolveDateAndTime("end of March", TODAY, "none").actionDate).toBe("2027-03-31");
  });

  it("honours an explicit year rather than rolling forward", () => {
    expect(resolveDateAndTime("end of March 2027", TODAY, "none").actionDate).toBe("2027-03-31");
  });

  it("gets February's last day right in a leap year", () => {
    expect(resolveDateAndTime("end of February 2028", TODAY, "none").actionDate).toBe("2028-02-29");
  });

  it("still applies the offset when the phrase points into next year", () => {
    expect(resolveDateAndTime("3 days before the end of March", TODAY, "none").actionDate).toBe("2027-03-28");
  });
});

describe("past-date backstop", () => {
  it("never returns an action date before today, even for an explicitly backward phrase", () => {
    // "3 days ago" is a note ABOUT the past, not a task to action in it.
    const { actionDate } = resolveDateAndTime("3 days ago", TODAY, "none");
    expect(actionDate).toBe(TODAY);
  });

  it("leaves genuine future dates untouched", () => {
    expect(resolveDateAndTime("in 3 days", TODAY, "none").actionDate).toBe("2026-09-22");
    expect(resolveDateAndTime("tomorrow", TODAY, "none").actionDate).toBe("2026-09-20");
  });
});
