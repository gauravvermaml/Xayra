/**
 * The empty-date auto-fill in `normalizeExtracted` assumes that if a note
 * yielded exactly one task and chrono found exactly one date candidate, the
 * two belong together. That held while every clause produced a task.
 *
 * It stopped holding the moment extraction started correctly SKIPPING
 * clauses. Confirmed on-device: for "Eli recommended the book The Overstory.
 * His brother Elias is moving to Perth in January", the model correctly
 * returned a single task with an empty date_phrase — and this reconciliation
 * step then stapled "January" onto it, dating a book recommendation to
 * 2027-01-01. The model was right; our own code overrode it.
 *
 * The guard is that the note must be a single sentence. These tests pin both
 * directions: the new failure stays fixed, and the original motivating case
 * the auto-fill exists for keeps working.
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

import { normalizeExtracted } from "../services/ai/transformationEngine";

const TODAY = "2026-09-20";
// Before the 1pm default-reminder-time cutoff (see computeDefaultReminderDateTime
// in extractionLogic.ts) — keeps the "falls back to today" assertions below
// deterministic regardless of when this suite actually runs.
const BEFORE_CUTOFF = new Date(2026, 8, 20, 9, 0);

describe("empty-date auto-fill", () => {
  it("does not borrow a date from a different sentence", () => {
    const result = normalizeExtracted(
      [{ task: "Read The Overstory", date_phrase: "", recurrence: "none" }],
      TODAY,
      "Eli recommended the book The Overstory. His brother Elias is moving to Perth in January.",
      ["January"],
      false,
      BEFORE_CUTOFF
    );

    expect(result).toHaveLength(1);
    // "January" belongs to the discarded clause about Elias, not to the book.
    expect(result[0].actionDate).toBe(TODAY);
  });

  it("still fills a missing date on a single-sentence note", () => {
    // The on-device miss this auto-fill was originally written for: the model
    // returns date_phrase "" even though the phrase is plainly in the text.
    const result = normalizeExtracted(
      [{ task: "Book a movie ticket", date_phrase: "", recurrence: "none" }],
      TODAY,
      "Book a movie ticket this Friday.",
      ["this Friday"]
    );

    expect(result).toHaveLength(1);
    expect(result[0].actionDate).toBe("2026-09-25"); // the Friday after 2026-09-20
  });

  it("leaves a date the model supplied itself untouched", () => {
    const result = normalizeExtracted(
      [{ task: "Call the dentist", date_phrase: "tomorrow", recurrence: "none" }],
      TODAY,
      "Call the dentist tomorrow. Also the car is due for a service.",
      ["tomorrow"]
    );

    expect(result[0].actionDate).toBe("2026-09-21");
  });

  it("DOES borrow across a sentence boundary once allowMultiSentenceAutoFill is set", () => {
    // Same fixture as the first test above, opposite conclusion — this pins
    // the OTHER direction the `allowMultiSentenceAutoFill` parameter adds.
    // extractToDosFromText now only calls normalizeExtracted with this flag
    // true after containsExtractionTrigger has already confirmed the note
    // was explicitly flagged for a reminder, which is what makes trusting
    // the lone date candidate safe here where it wasn't before.
    const result = normalizeExtracted(
      [{ task: "Read The Overstory", date_phrase: "", recurrence: "none" }],
      TODAY,
      "Eli recommended the book The Overstory. His brother Elias is moving to Perth in January.",
      ["January"],
      true
    );

    expect(result).toHaveLength(1);
    expect(result[0].actionDate).not.toBe(TODAY);
  });
});
