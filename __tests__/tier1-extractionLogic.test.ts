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

import {
  computeDefaultReminderDateTime,
  containsExtractionTrigger,
  detectDatePhrases,
  normalizeExtracted,
  preFilterZeroTaskNotes,
  resolveDateAndTime,
} from "../services/ai/transformationEngine";
import {
  buildNoteContext,
  isAnswerGroundedInContext,
  sanitizeLLMResponse,
  truncateForContext,
  type FormattableNote,
} from "../services/ai/ragFormatting";

/** No question period — the paragraph format every non-date question gets. */
const formatNoteContext = (notes: FormattableNote[]) => buildNoteContext(notes, null).contextText;
import { detectQueryDateRange } from "../services/ai/queryDateRange";
import { resolveQueryTemporalTarget } from "../services/ai/temporalResolver";

const TODAY = "2026-09-20"; // Sunday
// Used wherever a test exercises the "no date/time info at all" default
// (see computeDefaultReminderDateTime) — BEFORE_CUTOFF keeps the default on
// TODAY, matching every pre-existing assertion; AFTER_CUTOFF is for the new
// tests that pin the next-day push.
const BEFORE_CUTOFF = new Date(2026, 8, 20, 9, 0);
const AFTER_CUTOFF = new Date(2026, 8, 20, 15, 0);

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

  it("falls back to today when the phrase is empty (before the 1pm cutoff)", () => {
    expect(resolveDateAndTime("", TODAY, "none", BEFORE_CUTOFF).actionDate).toBe(TODAY);
  });

  it("falls back to today when the phrase is unparseable (before the 1pm cutoff)", () => {
    expect(resolveDateAndTime("sometime whenever", TODAY, "none", BEFORE_CUTOFF).actionDate).toBe(TODAY);
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
    expect(resolveDateAndTime("tomorrow", TODAY, "none", BEFORE_CUTOFF).notificationTime).toBe("13:00");
  });
});

describe("computeDefaultReminderDateTime", () => {
  it("stays on the same day just before the cutoff", () => {
    const result = computeDefaultReminderDateTime(new Date(2026, 8, 20, 12, 59));
    expect(result).toEqual({ actionDate: "2026-09-20", notificationTime: "13:00" });
  });

  it("rolls to the next day exactly at the cutoff", () => {
    const result = computeDefaultReminderDateTime(new Date(2026, 8, 20, 13, 0));
    expect(result).toEqual({ actionDate: "2026-09-21", notificationTime: "13:00" });
  });
});

describe("default reminder date/time - 1pm cutoff", () => {
  it("defaults to 1pm the SAME day when created before 1pm", () => {
    const result = resolveDateAndTime("", TODAY, "none", BEFORE_CUTOFF);
    expect(result.actionDate).toBe(TODAY);
    expect(result.notificationTime).toBe("13:00");
  });

  it("defaults to 1pm the NEXT day when created at or after 1pm", () => {
    const result = resolveDateAndTime("", TODAY, "none", AFTER_CUTOFF);
    expect(result.actionDate).toBe("2026-09-21");
    expect(result.notificationTime).toBe("13:00");
  });

  it("pushes to the next day exactly AT the cutoff hour, not just after it", () => {
    const atCutoff = new Date(2026, 8, 20, 13, 0);
    expect(resolveDateAndTime("", TODAY, "none", atCutoff).actionDate).toBe("2026-09-21");
  });

  it("rolls across a month boundary correctly", () => {
    const lateOnLastDay = new Date(2026, 8, 30, 15, 0); // Sep 30, 3pm
    expect(resolveDateAndTime("", "2026-09-30", "none", lateOnLastDay).actionDate).toBe("2026-10-01");
  });

  it("does not push a phrase that carries its own explicit time", () => {
    // "6pm" is a real, explicit time — the cutoff logic only applies when
    // there is nothing to go on at all.
    const result = resolveDateAndTime("at 6pm", TODAY, "none", AFTER_CUTOFF);
    expect(result.actionDate).toBe(TODAY);
    expect(result.notificationTime).toBe("18:00");
  });

  it("does not push the bare day-of-month fallback, which is already a future date", () => {
    const result = resolveDateAndTime("25th", TODAY, "none", AFTER_CUTOFF);
    expect(result.actionDate).toBe("2026-09-25");
    expect(result.notificationTime).toBe("13:00");
  });
});

describe("date resolution - weekday plus explicit day-of-month", () => {
  it("prioritizes the explicit day-of-month over the weekday name", () => {
    // Real on-device miss: chrono has no rule combining a weekday with a
    // day-of-month, so it used to match only "Tuesday" (the next Tuesday)
    // and silently drop "22nd" entirely.
    const { actionDate, notificationTime } = resolveDateAndTime("Tuesday the 22nd at 6:40 am", TODAY, "none");
    expect(actionDate).toBe("2026-09-22");
    expect(notificationTime).toBe("06:40");
  });

  it("rolls into next month once the day-of-month has passed", () => {
    expect(resolveDateAndTime("Friday the 3rd", TODAY, "none").actionDate).toBe("2026-10-03");
  });
});

describe("date-phrase detection - weekday plus explicit day-of-month", () => {
  it("detects one combined candidate instead of two disconnected ones", () => {
    // Before the fix, this produced ["Tuesday", "at 6:40 am"] — two
    // fragments, which meant the single-candidate auto-fill in
    // normalizeExtracted could never apply even after relaxing its
    // multi-sentence restriction.
    const phrases = detectDatePhrases(
      "Mum's flight lands Tuesday the 22nd at 6:40 am, terminal 1. Remind me to arrange the airport pickup.",
      TODAY
    );
    expect(phrases).toHaveLength(1);
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
    expect(resolveDateAndTime("every 3 days", TODAY, "daily", BEFORE_CUTOFF).actionDate).toBe(TODAY);
  });

  it("still resolves a real date on a recurring task without a numeric interval", () => {
    expect(resolveDateAndTime("every Monday", TODAY, "weekly").actionDate).toBe("2026-09-21");
  });
});

describe("date resolution - past-date backstop", () => {
  it.each([["3 days ago"], ["yesterday"], ["last week"]])("clamps a backward phrase (%s) to today", (phrase) => {
    // >= rather than exact equality: none of these phrases carry an
    // explicit time, so the result could legitimately be pushed to
    // tomorrow depending on `now` — either way it must never be in the past.
    expect(resolveDateAndTime(phrase, TODAY, "none", BEFORE_CUTOFF).actionDate >= TODAY).toBe(true);
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
      [],
      false,
      BEFORE_CUTOFF
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
      ["January"],
      false,
      BEFORE_CUTOFF
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
      ["tomorrow"],
      false,
      BEFORE_CUTOFF
    );
    expect(result.every((r) => r.actionDate === TODAY)).toBe(true);
  });

  it("refuses to fill from a cadence candidate on a recurring task", () => {
    const result = normalizeExtracted(
      [{ task: "Water the plants", date_phrase: "", recurrence: "daily" }],
      TODAY,
      "Water the plants every 3 days",
      ["3 days"],
      false,
      BEFORE_CUTOFF
    );
    expect(result[0].actionDate).toBe(TODAY);
  });

  it("DOES borrow a date across a sentence boundary when allowMultiSentenceAutoFill is set", () => {
    // Same shape as "refuses to borrow a date across a sentence boundary"
    // above, but this is the case the trigger-phrase gate exists to enable:
    // a note only ever reaches extraction because it contains "remind me" /
    // "make a note", so once there is exactly one task and exactly one date
    // candidate, they belong together even across a sentence break.
    const result = normalizeExtracted(
      modelSaid("Arrange the airport pickup"),
      TODAY,
      "Mum's flight lands Tuesday the 22nd at 6:40am, terminal 1. Remind me to arrange the airport pickup.",
      ["Tuesday the 22nd at 6:40am"],
      true
    );
    expect(result[0].actionDate).not.toBe(TODAY);
  });
});

describe("reconciliation - real-world date/time regressions (RC1, Thursday 8 Oct 2026)", () => {
  // Exact on-device notes. The model outputs are what the production model
  // returned for them (desktop replay, temperature 0).
  const THURSDAY = "2026-10-08";
  const BUDGET_NOTE = "Make a note for the budget meeting with Priya coming Friday in the morning.";
  const OSCAR_NOTE = "Make a note for meeting with Oscar on 30th October at 9am.";
  const extract = (note: string, modelOutput: unknown, now: Date) =>
    normalizeExtracted(modelOutput, THURSDAY, note, detectDatePhrases(note, THURSDAY), true, now);

  it("chrono splits the budget note into a day and a time-only candidate; the day keeps its 'coming'", () => {
    expect(detectDatePhrases(BUDGET_NOTE, THURSDAY)).toEqual(["coming Friday", "morning"]);
  });

  it.each([
    ["before the 1pm cutoff", new Date(2026, 9, 8, 9, 0)],
    ["after the 1pm cutoff", new Date(2026, 9, 8, 14, 0)],
  ])("'coming Friday in the morning' is Friday 9 Oct in the morning, %s", (_label, now) => {
    const [todo] = extract(BUDGET_NOTE, modelSaid("Make a note"), now);
    expect(todo.actionDate).toBe("2026-10-09");
    expect(todo.notificationTime).toBe("08:00");
  });

  it("a model phrase of just 'Friday' still gets the note's time of day", () => {
    const [todo] = extract(BUDGET_NOTE, modelSaid("budget meeting with Priya", "Friday"), new Date(2026, 9, 8, 9, 0));
    expect(todo).toMatchObject({ actionDate: "2026-10-09", notificationTime: "08:00" });
  });

  it("'on 30th October at 9am' keeps 09:00 when the model trims the time", () => {
    const [todo] = extract(OSCAR_NOTE, modelSaid("Make a note", "on 30th October"), new Date(2026, 9, 8, 9, 0));
    expect(todo).toMatchObject({ actionDate: "2026-10-30", notificationTime: "09:00" });
  });

  it("a broad 'morning' is the 08:00 product default; an exact time stays exact", () => {
    const now = new Date(2026, 9, 8, 9, 0);
    expect(resolveDateAndTime("tomorrow morning", THURSDAY, "none", now)).toMatchObject({ actionDate: "2026-10-09", notificationTime: "08:00" });
    expect(resolveDateAndTime("tomorrow at 7am", THURSDAY, "none", now)).toMatchObject({ actionDate: "2026-10-09", notificationTime: "07:00" });
  });

  describe("'coming <weekday>' — the next future occurrence (Fri 9 Oct 2026, 17:16 on-device report)", () => {
    const FRIDAY = "2026-10-09";
    const FRIDAY_EVENING = new Date(2026, 9, 9, 17, 16);
    const THURSDAY_MORNING = new Date(2026, 9, 8, 9, 0);

    it("Thursday + 'coming Friday morning' → the next day, 08:00", () => {
      expect(resolveDateAndTime("coming Friday morning", THURSDAY, "none", THURSDAY_MORNING)).toMatchObject({ actionDate: "2026-10-09", notificationTime: "08:00" });
    });

    it("Friday + 'coming Friday morning' → the following Friday, 08:00", () => {
      expect(resolveDateAndTime("coming Friday morning", FRIDAY, "none", FRIDAY_EVENING)).toMatchObject({ actionDate: "2026-10-16", notificationTime: "08:00" });
    });

    it("Friday + 'this coming Friday morning' → the following Friday, 08:00", () => {
      expect(resolveDateAndTime("this coming Friday morning", FRIDAY, "none", FRIDAY_EVENING)).toMatchObject({ actionDate: "2026-10-16", notificationTime: "08:00" });
    });

    it("a bare 'Friday at 7pm' keeps the existing bare-weekday behaviour", () => {
      expect(resolveDateAndTime("Friday at 7pm", FRIDAY, "none", new Date(2026, 9, 9, 9, 0))).toMatchObject({ actionDate: FRIDAY, notificationTime: "19:00" });
      expect(resolveDateAndTime("Friday at 7pm", THURSDAY, "none", THURSDAY_MORNING)).toMatchObject({ actionDate: "2026-10-09", notificationTime: "19:00" });
    });

    it("'30th October at 9am' remains 09:00", () => {
      expect(resolveDateAndTime("on 30th October at 9am", FRIDAY, "none", FRIDAY_EVENING)).toMatchObject({ actionDate: "2026-10-30", notificationTime: "09:00" });
    });

    // The exact on-device note, whichever phrase the model returns.
    const PRIYA_NOTE = "Remind me of Priya's meeting coming Friday in the morning.";
    it.each([
      ["the full phrase (what the model actually returned)", "coming Friday in the morning"],
      ["a phrase that dropped 'coming'", "Friday in the morning"],
      ["no phrase at all", ""],
    ])("the real Priya note is Fri 16 Oct 08:00, never a past default — model gave %s", (_label, phrase) => {
      const [todo] = normalizeExtracted(modelSaid("Remind Priya of their meeting", phrase), FRIDAY, PRIYA_NOTE, detectDatePhrases(PRIYA_NOTE, FRIDAY), true, FRIDAY_EVENING);
      expect(todo).toMatchObject({ actionDate: "2026-10-16", notificationTime: "08:00" });
    });
  });

  it("a lone time-only candidate still auto-fills, unchanged", () => {
    const note = "Remind me to call Mum this evening.";
    expect(detectDatePhrases(note, THURSDAY)).toEqual(["this evening"]);
    const [todo] = extract(note, modelSaid("Call Mum"), new Date(2026, 9, 8, 15, 0));
    expect(todo).toMatchObject({ actionDate: THURSDAY, notificationTime: "20:00" });
  });

  it("never attaches a time to a day in a different sentence", () => {
    const note = "Remind me to call the plumber on Friday. The kids are home in the morning.";
    const [todo] = extract(note, modelSaid("Call the plumber", "on Friday"), new Date(2026, 9, 8, 9, 0));
    expect(todo).toMatchObject({ actionDate: "2026-10-09", notificationTime: "13:00" });
  });

  it("leaves multi-task notes to the model — a time may belong to another task", () => {
    const note = "Remind me to call Bob on Friday and email Sue in the morning.";
    const todos = extract(
      note,
      [
        { task: "Call Bob", date_phrase: "on Friday", recurrence: "none" },
        { task: "Email Sue", date_phrase: "", recurrence: "none" },
      ],
      new Date(2026, 9, 8, 9, 0)
    );
    expect(todos[0]).toMatchObject({ actionDate: "2026-10-09", notificationTime: "13:00" });
  });
});

describe("extraction trigger phrase gating", () => {
  it.each([
    "Remind me to call the plumber tomorrow.",
    "REMIND ME to call the plumber tomorrow.",
    "Make a note to buy milk.",
    "So yeah, remind me to renew the library subscription.",
  ])("recognizes an explicit trigger phrase: %s", (note) => {
    expect(containsExtractionTrigger(note)).toBe(true);
  });

  it.each([
    "We should see them around 12:30 this afternoon.",
    "Feeling much better today than yesterday.",
    "",
    "   ",
  ])("finds no trigger in plain journal text: %s", (note) => {
    expect(containsExtractionTrigger(note)).toBe(false);
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
});

describe("inline day-level resolution in note context (no question period)", () => {
  // Local-time construction, not a raw epoch literal — a fixed number of
  // seconds would land on a different LOCAL calendar day depending on the
  // machine's timezone, making the test flaky across environments.
  const RECORDED_AT = Math.floor(new Date(2026, 8, 20, 12, 0, 0).getTime() / 1000); // Sunday, 20 Sep 2026
  const body = (text: string) =>
    formatNoteContext([{ content: text, transcript: null, createdAt: RECORDED_AT }]).split("\n").slice(1).join("\n");

  it("converts today/yesterday/tomorrow into the note's own recorded date", () => {
    expect(body("Today I did some app building.")).toBe("On Sunday, September 20 2026 I did some app building.");
    expect(body("I met Vishwa yesterday.")).toBe("I met Vishwa on Saturday, September 19 2026.");
    expect(body("I'll call tomorrow.")).toBe("I'll call on Monday, September 21 2026.");
  });

  it("generalizes to any expression the resolver pins to a single day", () => {
    expect(body("We met two days ago.")).toBe("We met on Friday, September 18 2026.");
    expect(body("Last night we watched a film.")).toBe("On the night of Saturday, September 19 2026 we watched a film.");
    expect(body("It has rained since yesterday.")).toBe("It has rained since Saturday, September 19 2026.");
  });

  it("leaves text with no relative-time words unchanged", () => {
    expect(body("Buy milk and eggs.")).toBe("Buy milk and eggs.");
  });

  it('leaves "last year"/"this year"/"this month" as the user\'s own words', () => {
    // Replacing them with a bare year, and annotating them "(2024)", both
    // backfired live — their period is carried by a clause label instead
    // when the question names a period.
    expect(body("Last year it was better.")).toBe("Last year it was better.");
    expect(body("This year has been busy.")).toBe("This year has been busy.");
    expect(body("Unusual for this month.")).toBe("Unusual for this month.");
  });
});

describe("truncateForContext", () => {
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

describe("isAnswerGroundedInContext", () => {
  const CONTEXT =
    "--- NOTE 1 [Recorded: Sunday, 27 Sep 2026 at 09:00] ---\n" +
    "On Sunday, September 27 2026 we started really slow, woke up around half past seven, did some app building.";
  const QUERY = "What did I do on 27th September Sunday?";

  it("passes an answer whose content words all appear in the context", () => {
    expect(
      isAnswerGroundedInContext("You woke up around half past seven and did some app building.", CONTEXT, QUERY)
    ).toBe(true);
  });

  it("rejects an answer referencing content absent from both the context and the query", () => {
    // The exact live bug this guards against: a leaked few-shot demo
    // fabricating facts (milk, eggs, a dentist) that exist nowhere in the
    // real cited note OR in anything the user actually asked.
    expect(
      isAnswerGroundedInContext("You bought milk and eggs and need to call the dentist tomorrow.", CONTEXT, QUERY)
    ).toBe(false);
  });

  it("trivially passes the model's own known refusal line", () => {
    // Deliberately NOT a "zero content words" case — "information"/"notes"
    // are both real 4+ letter words that won't appear in most contexts,
    // which would otherwise wrongly flag a legitimate refusal.
    expect(isAnswerGroundedInContext("No information found in your notes.", CONTEXT, QUERY)).toBe(true);
  });

  it("passes an answer that echoes the user's OWN question phrasing, even when that phrasing isn't resolved to an absolute date anywhere in context", () => {
    // Real live bug: "was it this hot LAST YEAR AROUND THE SAME TIME"
    // answered as "it was not this hot last year around the same time" is a
    // perfectly correct, grounded answer — but the day-level normalizer
    // rewrites "today" out of the note context into an absolute date, so
    // "last year" (legitimately reused from the user's own question) no
    // longer existed anywhere this check was looking, and a genuinely
    // correct answer was rejected as fabricated.
    const hotDayContext =
      "--- NOTE 1 [Recorded: Wednesday, 15 Oct 2025 at 12:00] ---\n" +
      "It was a very hot day on Wednesday, October 15 2025, perhaps 40 degrees plus. " +
      "Quite unusual for this month. Last year same time it was so much better.";
    const hotDayQuery = "Was it this hot last year around the same time?";
    expect(
      isAnswerGroundedInContext("It was not this hot last year around the same time.", hotDayContext, hotDayQuery)
    ).toBe(true);
  });

  it("integration: the real labeled context still grounds a correct comparison answer", () => {
    // Chains the actual buildNoteContext output (not a hand-built string)
    // into the grounding check, with the question's period resolved the way
    // rag.ts does it.
    const recordedAt = Math.floor(new Date(2025, 9, 15, 12, 0, 0).getTime() / 1000); // 15 Oct 2025
    const rawNote =
      "It was a very hot day today, perhaps 40 degrees plus. Quite unusual for this month. " +
      "Last year same time it was so much better.";
    const query = "Was it this hot last year around the same time?";
    const target = resolveQueryTemporalTarget(query, new Date(2026, 9, 2, 12));
    const context = buildNoteContext([{ content: rawNote, transcript: null, createdAt: recordedAt }], target).contextText;
    expect(isAnswerGroundedInContext("It was not this hot last year around the same time.", context, query)).toBe(
      true
    );
  });
});

// ---------------------------------------------------------------------------
// detectQueryDateRange — locks in real chrono-node behavior verified live
// against actual on-device bug reports, not assumed. Reference date fixed at
// Thursday 1 Oct 2026 throughout (matches this file's own TODAY/Sunday-20-Sep
// anchor one week later), so every expectation below is a concrete,
// hand-verified date, not a relative computation that could mask a
// regression by shifting alongside a bug.
// ---------------------------------------------------------------------------

describe("detectQueryDateRange", () => {
  const REFERENCE = new Date(2026, 9, 1, 12, 0, 0); // Thursday, 1 Oct 2026

  it("resolves a specific day, preferring it over a secondary bare-weekday match", () => {
    // Live bug input verbatim: chrono independently also matches "Sunday"
    // alone (-> the NEXT Sunday, Oct 4) — the day+month match must win.
    expect(detectQueryDateRange("What did I do on 27th September Sunday?", REFERENCE)).toEqual({
      start: "2026-09-27",
      end: "2026-09-27",
    });
  });

  it("resolves yesterday to a single day", () => {
    expect(detectQueryDateRange("What did I do yesterday?", REFERENCE)).toEqual({
      start: "2026-09-30",
      end: "2026-09-30",
    });
  });

  it('narrows "last year" to a single day when "same day" is explicit', () => {
    // Live bug: this query previously got answered from THIS year's recent
    // notes instead of anything from Oct 2025.
    expect(detectQueryDateRange("Where was I last year same day?", REFERENCE)).toEqual({
      start: "2025-10-01",
      end: "2025-10-01",
    });
  });

  it('widens bare "last year" (no "same day") to the full calendar year', () => {
    expect(detectQueryDateRange("What did I do last year?", REFERENCE)).toEqual({
      start: "2025-01-01",
      end: "2025-12-31",
    });
  });

  it('combines a bare month name with "last year" into that month in that year', () => {
    // Live bug: chrono resolves "October" and "last year" as two
    // independent, each-half-wrong matches (October-this-year,
    // today's-day-last-year) — the real intent (October 2025) requires
    // combining them explicitly.
    expect(detectQueryDateRange("What did I do in October last year?", REFERENCE)).toEqual({
      start: "2025-10-01",
      end: "2025-10-31",
    });
  });

  it('resolves "early this year" to the first third of the year', () => {
    expect(
      detectQueryDateRange("Who did I see early this year in Sutherland leisure centre?", REFERENCE)
    ).toEqual({ start: "2026-01-01", end: "2026-04-30" });
  });

  it('expands "last week" to a full Sunday-Saturday week, not a single day', () => {
    expect(detectQueryDateRange("What did I do last week?", REFERENCE)).toEqual({
      start: "2026-09-20",
      end: "2026-09-26",
    });
  });

  it('expands "this week" to the current Sunday-Saturday week', () => {
    expect(detectQueryDateRange("What did I do this week?", REFERENCE)).toEqual({
      start: "2026-09-27",
      end: "2026-10-03",
    });
  });

  it('expands "last month" to the full calendar month', () => {
    expect(detectQueryDateRange("What happened last month?", REFERENCE)).toEqual({
      start: "2026-09-01",
      end: "2026-09-30",
    });
  });

  it("returns null for a recency phrase with no real date reference", () => {
    // This is deliberately NOT handled here — rag.ts's own separate
    // isRecentNotesQuery bypass covers "latest/recent", which chrono does
    // not and should not parse as a date.
    expect(detectQueryDateRange("Summarise my latest notes", REFERENCE)).toBeNull();
  });

  it("returns null for a query with no date/time reference at all", () => {
    expect(detectQueryDateRange("What did Vishwa say about the app?", REFERENCE)).toBeNull();
  });

  // Follow-up audit (live user request, after the above already shipped):
  // chrono resolves ANY ambiguous bare date to the next FUTURE occurrence
  // once the same-cycle date has passed, confirmed identical under
  // forwardDate true/false/omitted — backwards for a retrospective notes
  // app. These lock in the clamp-to-past fix and its deliberate exceptions.

  it("clamps a bare month+day with no year to the most recent PAST occurrence", () => {
    // Real bug: chrono alone resolved this to 5 Mar 2027, not the nearer,
    // already-past 5 Mar 2026.
    expect(detectQueryDateRange("What did I do on March 5th?", REFERENCE)).toEqual({
      start: "2026-03-05",
      end: "2026-03-05",
    });
  });

  it("does not clamp when the query states an explicit year", () => {
    expect(detectQueryDateRange("What did I note on 15th March 2025?", REFERENCE)).toEqual({
      start: "2025-03-15",
      end: "2025-03-15",
    });
  });

  it("does not clamp when the query has an explicit forward word", () => {
    expect(detectQueryDateRange("What am I doing next Monday?", REFERENCE)).toEqual({
      start: "2026-10-05",
      end: "2026-10-05",
    });
  });

  it('clamps a bare weekday ("on Sunday") to the most recent past occurrence', () => {
    // Real bug: bare "on Sunday"/"this Sunday" resolved to the NEXT Sunday
    // (Oct 4) instead of the one just passed (Sep 27).
    expect(detectQueryDateRange("What did I do on Sunday?", REFERENCE)).toEqual({
      start: "2026-09-27",
      end: "2026-09-27",
    });
  });

  it('distinguishes "last <Month>" (clamps into the past) from "this <Month>" (stays current year even if still ahead)', () => {
    // Both raw-resolve identically from chrono (verified live) — the word
    // itself has to be read, not inferred from the resolved date.
    expect(detectQueryDateRange("What did I do last December?", REFERENCE)).toEqual({
      start: "2025-12-01",
      end: "2025-12-31",
    });
    expect(detectQueryDateRange("What happened this December?", REFERENCE)).toEqual({
      start: "2026-12-01",
      end: "2026-12-31",
    });
  });

  it('resolves "quarter" to a real 3-month range instead of chrono\'s own nonsensical single day', () => {
    // chrono has no concept of a quarter at all and returns a single
    // nonsensical day for it (verified live) — real quarter arithmetic
    // added below (see the dedicated "last quarter"/"this quarter" tests
    // further down) rather than leaving this suppressed to null forever.
    expect(detectQueryDateRange("What did I do last quarter?", REFERENCE)).toEqual({
      start: "2026-07-01",
      end: "2026-09-30",
    });
  });

  it('resolves "earlier"/"later" (comparative) the same as "early"/"late" (adjective)', () => {
    expect(detectQueryDateRange("What did I do earlier this year?", REFERENCE)).toEqual({
      start: "2026-01-01",
      end: "2026-04-30",
    });
    expect(detectQueryDateRange("What did I do later this year?", REFERENCE)).toEqual({
      start: "2026-09-01",
      end: "2026-12-31",
    });
  });

  // Live request: "between <Month> and <Month>", "last/this quarter", and a
  // real anniversary scenario (a note's own recorded date can land weeks
  // away from a strict one-year-back calendar point).

  it("combines a month range into one real start-to-end span", () => {
    // Live bug: chrono only ever captures the FIRST month as its own
    // independent match, silently dropping the second entirely.
    expect(detectQueryDateRange("What did I do between March and May?", REFERENCE)).toEqual({
      start: "2026-03-01",
      end: "2026-05-31",
    });
    expect(detectQueryDateRange("What did I do from June to August?", REFERENCE)).toEqual({
      start: "2026-06-01",
      end: "2026-08-31",
    });
  });

  it("applies a year modifier to a month range", () => {
    expect(detectQueryDateRange("What did I do between March and May last year?", REFERENCE)).toEqual({
      start: "2025-03-01",
      end: "2025-05-31",
    });
  });

  it('resolves "last quarter"/"this quarter" relative to the reference date\'s own quarter', () => {
    // Reference (1 Oct) sits in Q4 2026, so "last quarter" is Q3 2026.
    expect(detectQueryDateRange("What did I do last quarter?", REFERENCE)).toEqual({
      start: "2026-07-01",
      end: "2026-09-30",
    });
    expect(detectQueryDateRange("What did I do this quarter?", REFERENCE)).toEqual({
      start: "2026-10-01",
      end: "2026-12-31",
    });
  });

  it('wraps "last quarter" from Q1 back to Q4 of the previous year', () => {
    const q1Reference = new Date(2026, 1, 15, 12, 0, 0); // mid-February, Q1
    expect(detectQueryDateRange("What did I do last quarter?", q1Reference)).toEqual({
      start: "2025-10-01",
      end: "2025-12-31",
    });
  });

  it('gives "this time last year"/"around the same time last year" a wide window, not a single day', () => {
    // Live scenario: a note's own temporal self-reference ("today", "last
    // year") is anchored to WHEN IT WAS RECORDED, which can land weeks away
    // from a strict one-year-back calendar point a later query implies.
    // A single-day match would miss it entirely; the full year is too wide.
    const expected = { start: "2025-08-20", end: "2025-11-12" }; // +-42 days around 1 Oct 2025
    expect(detectQueryDateRange("What did I do this time last year?", REFERENCE)).toEqual(expected);
    expect(detectQueryDateRange("What did I do around the same time last year?", REFERENCE)).toEqual(expected);
    expect(detectQueryDateRange("What did I do the same time last year?", REFERENCE)).toEqual(expected);
  });

  it('keeps "same day"/"this day" + "last year" an EXACT single day, not fuzzy', () => {
    expect(detectQueryDateRange("Where was I last year same day?", REFERENCE)).toEqual({
      start: "2025-10-01",
      end: "2025-10-01",
    });
  });

  it('resolves "this day last year" correctly regardless of word order', () => {
    // Live bug: chrono parses this exact word order as ONE combined match
    // resolved to TODAY with zero certainty, silently losing the "last
    // year" part — unlike "last year same day" (different order), which it
    // already resolves correctly as two separate matches. Fixed by
    // detecting the day/time qualifier and "last year" independently rather
    // than depending on chrono parsing their combination consistently.
    expect(detectQueryDateRange("What did I do this day last year?", REFERENCE)).toEqual({
      start: "2025-10-01",
      end: "2025-10-01",
    });
  });

  it("a real end-to-end anniversary scenario: a January note is found by a December 'around the same time last year' query", () => {
    // Exact live scenario: a note recorded in January (e.g. about a hot
    // summer day) asked about from December, 11 months later, as "was it
    // this hot last year around the same time." A strict "last year" =
    // that nominal calendar year would search ~December of the prior year
    // and miss the January note entirely, despite it being exactly what
    // the question means.
    const decemberQuery = new Date(2027, 11, 10, 12, 0, 0); // 10 Dec 2027
    const range = detectQueryDateRange("Was it this hot last year around the same time?", decemberQuery);
    expect(range).not.toBeNull();
    const noteRecordedDate = "2027-01-15";
    expect(noteRecordedDate >= range!.start && noteRecordedDate <= range!.end).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hybrid Architecture (v8) — deterministic zero-task pre-filter
// ---------------------------------------------------------------------------
// See preFilterZeroTaskNotes's own doc comment in extractionLogic.ts for why
// this exists: three real fine-tuning attempts (v5-v7) failed to teach
// third-party/refusal reliably, and the model's own on-device failures were
// near-verbatim reproductions of the fabrication strings used as ORPO
// negative examples. This function replaces that with a deterministic
// decision for the same subset of notes.
//
// The critical property is ZERO false positives — a false positive here
// silently drops a real task with no LLM fallback, worse than the model
// guessing wrong. The corpus-wide test below is what actually enforces that,
// checked against every case in the frozen 103-case eval corpus, not just
// the hand-picked examples above it.

describe("preFilterZeroTaskNotes", () => {
  it.each([
    "The plumber is coming Wednesday to look at the boiler.",
    "My sister is moving house at the end of the month.",
    "The cleaner comes every second Friday.",
    "A courier is delivering the parcel tomorrow afternoon.",
    "The neighbours are having their fence resurfaced.",
    "The council is collecting green waste next week.",
    "My colleague is presenting at the conference in March.",
    "The gas company is reading the meter on Friday.",
    "The builder is coming Tuesday to look at the roof.",
  ])("fires on a third-party note: %s", (note) => {
    expect(preFilterZeroTaskNotes(note)).toBe(true);
  });

  it.each([
    "The weather was lovely today and the garden looks great after the rain.",
    "Had a really good chat with Dad about the old house.",
    "The new album is excellent, especially the third track.",
    "Feeling much better today than yesterday.",
    "That podcast episode on sleep was surprisingly good.",
    "Traffic was much lighter than usual this morning.",
    "The new bakery bread is better than the supermarket one.",
    "The old bike is holding up better than expected.",
  ])("fires on a pure-observation note: %s", (note) => {
    expect(preFilterZeroTaskNotes(note)).toBe(true);
  });

  it.each([
    "The electrician is coming Tuesday to check the wiring. Buy lightbulbs tomorrow.",
    "My cousin is moving to Berlin next month. Cancel the newspaper subscription.",
    "Eli recommended the book The Overstory. His brother Elias is moving to Perth in January.",
    "Sarah starts her new job on Monday. I should send her a card.",
  ])("does NOT fire on a contrastive note (real task after a distractor clause): %s", (note) => {
    expect(preFilterZeroTaskNotes(note)).toBe(false);
  });

  it.each([
    "Remind me to call the dentist tomorrow.",
    "Renew the parking permit by Friday.",
    "Book the flights and renew the travel insurance.",
    "so yeah remind me to renew the libary subscription tomorrow",
    "Pay the storage fee on the 5th of every month.",
  ])("does NOT fire on a genuine task note: %s", (note) => {
    expect(preFilterZeroTaskNotes(note)).toBe(false);
  });

  it("does not fire on an empty or whitespace-only note", () => {
    expect(preFilterZeroTaskNotes("")).toBe(false);
    expect(preFilterZeroTaskNotes("   ")).toBe(false);
  });

  it("has zero false positives against every non-empty-task case in the frozen 103-case eval corpus", () => {
    const fs = require("fs") as typeof import("fs");
    const path = require("path") as typeof import("path");
    const corpusDir = path.join(__dirname, "..", "scripts", "eval");
    const files = ["corpus.jsonl", "corpus-heldout.jsonl"].map((f) => path.join(corpusDir, f));

    const rows: Array<{ id: string; note?: string; expect?: { tasks?: unknown[] } }> = [];
    for (const file of files) {
      if (!fs.existsSync(file)) continue;
      const lines = fs
        .readFileSync(file, "utf8")
        .split(/\r?\n/)
        .filter((line) => line.trim() && !line.startsWith("//"));
      for (const line of lines) {
        rows.push(JSON.parse(line));
      }
    }
    // Guard against a future refactor silently pointing this at the wrong
    // files and passing vacuously with zero rows checked.
    expect(rows.length).toBeGreaterThan(50);

    const falsePositives = rows.filter(
      (r) => typeof r.note === "string" && r.expect?.tasks && r.expect.tasks.length > 0 && preFilterZeroTaskNotes(r.note)
    );
    expect(falsePositives.map((r) => r.id)).toEqual([]);
  });
});
