/**
 * TIER 1 — pure-logic evaluation suite.
 *
 * Every assertion here runs without loading a model. That is the point: of the
 * extraction bugs found during the first corpus QA pass, half were not model
 * failures at all but defects in this deterministic layer — chrono misparsing
 * "end of September", the reconciliation step stapling a date from a discarded
 * clause onto a surviving task, and the detection pass offering the model a
 * menu of misleading candidates. Each cost multiple ~80s on-device round-trips
 * to find by eye. They are all catchable here in milliseconds.
 *
 * Tier 2 (`npm run eval`, against the real GGUF) covers what genuinely needs
 * the model's judgement. Nothing assertable deterministically should wait for
 * it.
 *
 * Reference date is fixed at 2026-09-20 (a Sunday) so weekday-relative phrases
 * are stable. Every expected value was verified against chrono-node directly
 * rather than worked out by hand.
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

import { detectDatePhrases, normalizeExtracted, resolveDateAndTime } from "../services/ai/transformationEngine";
import { formatNoteContext, sanitizeLLMResponse, truncateForContext } from "../services/ai/ragFormatting";

const TODAY = "2026-09-20"; // Sunday

/** The shape the model returns, before reconciliation. */
function modelSaid(task: string, date_phrase = "", recurrence = "none") {
  return [{ task, date_phrase, recurrence }];
}

// ---------------------------------------------------------------------------
// Date resolution
// ---------------------------------------------------------------------------

describe("date resolution - relative phrases", () => {
  it.each([
    ["tomorrow", "2026-09-21"],
    ["next Friday", "2026-09-25"],
    ["in 3 days", "2026-09-23"],
    ["this Saturday", "2026-09-26"],
    ["next month", "2026-10-20"],
  ])("resolves %s to %s", (phrase, expected) => {
    expect(resolveDateAndTime(phrase, TODAY, "none").actionDate).toBe(expected);
  });

  it("pushes a bare calendar date forward rather than into the past", () => {
    expect(resolveDateAndTime("March 3rd", TODAY, "none").actionDate).toBe("2027-03-03");
  });

  it("falls back to today when the phrase is empty", () => {
    expect(resolveDateAndTime("", TODAY, "none").actionDate).toBe(TODAY);
  });

  it("falls back to today when the phrase is unparseable", () => {
    expect(resolveDateAndTime("sometime whenever", TODAY, "none").actionDate).toBe(TODAY);
  });
});

describe("date resolution - ranges and clock times", () => {
  it("keeps both ends of a date range", () => {
    const { actionDate, toDate } = resolveDateAndTime("27th September to 10th October", TODAY, "none");
    expect(actionDate).toBe("2026-09-27");
    expect(toDate).toBe("2026-10-10");
  });

  it("leaves toDate null for a single-day phrase", () => {
    expect(resolveDateAndTime("tomorrow", TODAY, "none").toDate).toBeNull();
  });

  it("extracts an explicit clock time", () => {
    expect(resolveDateAndTime("at 3:30 PM tomorrow", TODAY, "none").notificationTime).toBe("15:30");
  });

  it("uses the default reminder time when no clock time is stated", () => {
    expect(resolveDateAndTime("tomorrow", TODAY, "none").notificationTime).toBe("05:00");
  });
});

describe("date resolution - bare day-of-month", () => {
  it("reads a bare day number as the next occurrence of that day", () => {
    expect(resolveDateAndTime("25th", TODAY, "none").actionDate).toBe("2026-09-25");
  });

  it("rolls a bare day number into next month once it has passed", () => {
    expect(resolveDateAndTime("5th", TODAY, "none").actionDate).toBe("2026-10-05");
  });
});

describe("date resolution - recurrence interaction", () => {
  it("does not treat the N in 'every N days' as a one-off date", () => {
    // chrono reads "3 days" inside "every 3 days" as a relative date. For a
    // recurring task that is a cadence, not an action date.
    expect(resolveDateAndTime("every 3 days", TODAY, "daily").actionDate).toBe(TODAY);
  });

  it("still resolves a real date on a recurring task without a numeric interval", () => {
    expect(resolveDateAndTime("every Monday", TODAY, "weekly").actionDate).toBe("2026-09-21");
  });
});

describe("date resolution - past-date backstop", () => {
  it.each([["3 days ago"], ["yesterday"], ["last week"]])("clamps a backward phrase (%s) to today", (phrase) => {
    expect(resolveDateAndTime(phrase, TODAY, "none").actionDate >= TODAY).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Detection - what the model is offered as candidates
// ---------------------------------------------------------------------------

describe("date-phrase detection", () => {
  it("finds a plain relative phrase in running text", () => {
    expect(detectDatePhrases("Call the dentist tomorrow.", TODAY)).toContain("tomorrow");
  });

  it("returns nothing when the note has no date at all", () => {
    expect(detectDatePhrases("Replace the kitchen tap washer.", TODAY)).toEqual([]);
  });

  it("de-duplicates a phrase repeated in the same note", () => {
    const phrases = detectDatePhrases("Call him tomorrow, and text him tomorrow too.", TODAY);
    expect(phrases.filter((p) => p.toLowerCase() === "tomorrow")).toHaveLength(1);
  });

  it("offers one resolvable candidate for an end-of-month phrase, not fragments", () => {
    const phrases = detectDatePhrases("File the tax returns 7 days before the end of September this year.", TODAY);
    expect(phrases).toHaveLength(1);
    expect(resolveDateAndTime(phrases[0], TODAY, "none").actionDate).toBe("2026-09-23");
  });
});

// ---------------------------------------------------------------------------
// Reconciliation - the model's claims vs deterministic checks
// ---------------------------------------------------------------------------

describe("reconciliation - input validation", () => {
  it("returns nothing for a non-array", () => {
    expect(normalizeExtracted({ task: "nope" }, TODAY, "note", [])).toEqual([]);
    expect(normalizeExtracted(null, TODAY, "note", [])).toEqual([]);
    expect(normalizeExtracted("[]", TODAY, "note", [])).toEqual([]);
  });

  it("drops entries with a missing, empty or non-string task", () => {
    const result = normalizeExtracted(
      [
        { task: "Keep me", date_phrase: "", recurrence: "none" },
        { task: "   ", date_phrase: "", recurrence: "none" },
        { task: 42, date_phrase: "", recurrence: "none" },
        { date_phrase: "", recurrence: "none" },
        null,
      ],
      TODAY,
      "Keep me.",
      []
    );
    expect(result.map((r) => r.task)).toEqual(["Keep me"]);
  });

  it("trims whitespace off the task text", () => {
    const result = normalizeExtracted(modelSaid("  Book the table  "), TODAY, "Book the table.", []);
    expect(result[0].task).toBe("Book the table");
  });
});

describe("reconciliation - hallucinated date phrases", () => {
  it("drops a date phrase that appears nowhere in the note", () => {
    const result = normalizeExtracted(
      modelSaid("Call the plumber", "next Tuesday"),
      TODAY,
      "Call the plumber about the leak.",
      []
    );
    expect(result[0].actionDate).toBe(TODAY);
  });

  it("keeps a real substring of the note that chrono happened to miss", () => {
    // chrono missing a phrasing is expected; the phrase genuinely being in the
    // note is what makes it trustworthy.
    const result = normalizeExtracted(modelSaid("Submit the form", "tomorrow"), TODAY, "Submit the form tomorrow.", []);
    expect(result[0].actionDate).toBe("2026-09-21");
  });
});

describe("reconciliation - recurrence evidence", () => {
  it("honours a recurrence the note actually supports", () => {
    const result = normalizeExtracted(
      modelSaid("Pay the rent", "the 1st of every month", "monthly"),
      TODAY,
      "Pay the rent on the 1st of every month.",
      ["the 1st of every month"]
    );
    expect(result[0].recurrence).toBe("monthly");
  });

  it("overrides a recurrence the note has no repeating language for", () => {
    const result = normalizeExtracted(
      modelSaid("Call the dentist", "tomorrow", "weekly"),
      TODAY,
      "Call the dentist tomorrow.",
      ["tomorrow"]
    );
    expect(result[0].recurrence).toBe("none");
  });

  it("falls back to none for an unrecognised recurrence value", () => {
    const result = normalizeExtracted(
      [{ task: "Do the thing", date_phrase: "", recurrence: "fortnightly-ish" }],
      TODAY,
      "Do the thing.",
      []
    );
    expect(result[0].recurrence).toBe("none");
  });
});

describe("reconciliation - empty-date auto-fill", () => {
  it("fills a missing date on a single-sentence, single-task note", () => {
    const result = normalizeExtracted(modelSaid("Book a movie ticket"), TODAY, "Book a movie ticket this Friday.", [
      "this Friday",
    ]);
    expect(result[0].actionDate).toBe("2026-09-25");
  });

  it("refuses to borrow a date across a sentence boundary", () => {
    // The lone candidate belongs to a clause that produced no task.
    const result = normalizeExtracted(
      modelSaid("Read The Overstory"),
      TODAY,
      "Eli recommended The Overstory. His brother Elias is moving to Perth in January.",
      ["January"]
    );
    expect(result[0].actionDate).toBe(TODAY);
  });

  it("refuses to guess when the note yielded more than one task", () => {
    const result = normalizeExtracted(
      [
        { task: "Buy milk", date_phrase: "", recurrence: "none" },
        { task: "Call the bank", date_phrase: "", recurrence: "none" },
      ],
      TODAY,
      "Buy milk and call the bank tomorrow",
      ["tomorrow"]
    );
    expect(result.every((r) => r.actionDate === TODAY)).toBe(true);
  });

  it("refuses to fill from a cadence candidate on a recurring task", () => {
    const result = normalizeExtracted(
      [{ task: "Water the plants", date_phrase: "", recurrence: "daily" }],
      TODAY,
      "Water the plants every 3 days",
      ["3 days"]
    );
    expect(result[0].actionDate).toBe(TODAY);
  });
});

// ---------------------------------------------------------------------------
// Output sanitization
// ---------------------------------------------------------------------------

const LOOPED = "Your registration expires on 30 September.";

describe("response sanitization", () => {
  it("strips leaked chat-template special tokens", () => {
    expect(sanitizeLLMResponse("You have two notes.<|im_end|>")).toBe("You have two notes.");
    expect(sanitizeLLMResponse("Answer<|eot_id|>")).toBe("Answer");
  });

  it("strips XML/HTML-style tags", () => {
    expect(sanitizeLLMResponse("<p>You saw Eli.</p>")).toBe("You saw Eli.");
  });

  it("leaves clean prose untouched", () => {
    const clean = "You saw Eli on Thursday, 14 August.";
    expect(sanitizeLLMResponse(clean)).toBe(clean);
  });

  it("does not mangle a legitimate comparison character", () => {
    expect(sanitizeLLMResponse("Budget is < 500 dollars.")).toBe("Budget is < 500 dollars.");
  });

  it("collapses a byte-adjacent repeat", () => {
    expect(sanitizeLLMResponse(LOOPED + LOOPED)).toBe(LOOPED);
  });

  it.each([
    ["a single space", " "],
    ["a newline", "\n"],
    ["a blank line", "\n\n"],
    ["a spaced dash", " — "],
  ])("collapses a repeat separated by %s", (_label, separator) => {
    // The separated case is what actually occurs in production: a looping
    // model nearly always emits whitespace or punctuation between copies. The
    // original detector required byte-adjacency and missed all of them.
    expect(sanitizeLLMResponse(LOOPED + separator + LOOPED)).toBe(LOOPED);
  });

  it("does not collapse two genuinely different sentences", () => {
    const text = `${LOOPED} Your dentist appointment is on Tuesday.`;
    expect(sanitizeLLMResponse(text)).toBe(text);
  });

  it("does not collapse a short repeat below the length floor", () => {
    // Under 20 characters a repeat is as likely to be real phrasing as a loop.
    const text = "Buy milk. Buy milk.";
    expect(sanitizeLLMResponse(text)).toBe(text);
  });

  it("keeps the prefix when only the tail loops", () => {
    const prefix = "Here is what you noted. ";
    expect(sanitizeLLMResponse(prefix + LOOPED + " " + LOOPED)).toBe((prefix + LOOPED).trim());
  });
});

// ---------------------------------------------------------------------------
// Context formatting - reachable without a database
// ---------------------------------------------------------------------------

describe("note context formatting", () => {
  const note = (content: string, createdAt: number) => ({ content, transcript: null, createdAt });

  it("numbers notes from 1 in the order given", () => {
    const block = formatNoteContext([note("First", 1789000000), note("Second", 1789100000)]);
    expect(block).toContain("--- NOTE 1 [Recorded:");
    expect(block).toContain("--- NOTE 2 [Recorded:");
    expect(block.indexOf("NOTE 1")).toBeLessThan(block.indexOf("NOTE 2"));
  });

  it("never leaks a note id into the context", () => {
    expect(formatNoteContext([note("Buy milk", 1789000000)])).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("falls back to transcript when content is empty", () => {
    const block = formatNoteContext([{ content: null, transcript: "From audio", createdAt: 1789000000 }]);
    expect(block).toContain("From audio");
  });

  it("returns an empty string for no notes", () => {
    expect(formatNoteContext([])).toBe("");
  });

  it("truncates an over-long note and marks it", () => {
    const long = Array.from({ length: 250 }, (_, i) => `w${i}`).join(" ");
    const truncated = truncateForContext(long);
    expect(truncated.endsWith("…")).toBe(true);
    expect(truncated.split(/\s+/).length).toBeLessThanOrEqual(201);
  });

  it("leaves a short note untouched", () => {
    expect(truncateForContext("Buy milk")).toBe("Buy milk");
  });
});
