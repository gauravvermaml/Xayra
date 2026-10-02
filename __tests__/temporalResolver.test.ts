import { buildNoteContext } from "../services/ai/ragFormatting";
import {
  checkAnswerDates,
  classifyNoteForPeriods,
  establishedPeriods,
  relatePeriods,
  resolveMemory,
  resolveQueryTemporalTarget,
  resolveTemporalReferences,
  splitIntoClauses,
  toQueryPeriod,
  type Period,
  type QueryTemporalTarget,
  type TemporalAnchor,
  type TemporalReference,
} from "../services/ai/temporalResolver";

// Local-time construction throughout — a raw epoch literal would land on a
// different local day depending on the test machine's timezone.
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const memoryAnchor = (d: Date): TemporalAnchor => ({ kind: "memoryCreatedAt", date: d });

const OCT_1_2026 = new Date(2026, 9, 1, 12); // Thursday
const OCT_2_2026 = new Date(2026, 9, 2, 12); // Friday — "now" for every query below
const OCT_15_2025 = new Date(2025, 9, 15, 12); // Wednesday

const HOT_DAY_NOTE =
  "It was a very hot day today, perhaps 40 degrees plus. Quite unusual for this month. Last year same time it was so much better. " +
  "Glad we had a plunge pool to cool ourselves off, which we didn't have last year. We caught up with a bunch of friends, had a few beers " +
  "and called it a day. I am reading an interesting history book these days, it's called Why West Rules for Now.";
const HOT_DAY_QUERY = "How was the weather last year same time?";
const VARUN_NOTE = "Yesterday we celebrated Varun's birthday.";
const VARUN_QUERY = "Did I celebrate Varun's birthday yesterday?";

function only(refs: TemporalReference[]): TemporalReference {
  expect(refs).toHaveLength(1);
  return refs[0];
}

function periodOf(ref: TemporalReference): Period {
  if (ref.resolution.status !== "resolved") {
    throw new Error(`expected resolved, got ${JSON.stringify(ref.resolution)}`);
  }
  return ref.resolution.period;
}

const day = (iso: string): Period => ({ start: iso, end: iso, precision: "day" });

describe("resolveTemporalReferences — the same words, different anchors", () => {
  it('resolves the memory\'s "yesterday" against the day the memory was recorded', () => {
    expect(periodOf(only(resolveTemporalReferences(VARUN_NOTE, memoryAnchor(OCT_1_2026))))).toEqual(day("2026-09-30"));
  });

  it('resolves the question\'s "yesterday" against the moment the question is asked', () => {
    const ref = only(resolveTemporalReferences(VARUN_QUERY, { kind: "queryTime", date: OCT_2_2026 }));
    expect(periodOf(ref)).toEqual(day("2026-10-01"));
  });

  it('resolves a memory\'s own "last year" to the year before ITS recording, not before today', () => {
    const refs = resolveTemporalReferences("Last year same time it was so much better.", memoryAnchor(OCT_15_2025));
    expect(periodOf(only(refs))).toEqual({ start: "2024-01-01", end: "2024-12-31", precision: "year" });
  });

  it("records each expression's span and anchor", () => {
    const anchor = memoryAnchor(OCT_15_2025);
    const ref = only(resolveTemporalReferences("It was hot today.", anchor));
    expect(ref).toMatchObject({ text: "today", index: 11, anchor });
  });
});

describe("resolveTemporalReferences — precision from chrono's certainty", () => {
  const anchor = memoryAnchor(OCT_1_2026);
  const periodFor = (text: string) => periodOf(only(resolveTemporalReferences(text, anchor)));

  it("day-level", () => {
    expect(periodFor("We met two days ago.")).toEqual(day("2026-09-29"));
    expect(periodFor("We went last night.")).toEqual(day("2026-09-30"));
    expect(periodFor("We went last Monday.")).toEqual(day("2026-09-28"));
    expect(periodFor("We went the day before yesterday.")).toEqual(day("2026-09-29"));
  });

  it("week, month, quarter, year", () => {
    expect(periodFor("We did it last week.")).toEqual({ start: "2026-09-20", end: "2026-09-26", precision: "week" });
    expect(periodFor("We did it last month.")).toEqual({ start: "2026-09-01", end: "2026-09-30", precision: "month" });
    expect(periodFor("We did it last quarter.")).toEqual({ start: "2026-07-01", end: "2026-09-30", precision: "quarter" });
    expect(periodFor("It was a good year this year.")).toEqual({ start: "2026-01-01", end: "2026-12-31", precision: "year" });
  });

  it("a bare time of day is not a date reference on its own (Phase 1 fix 3)", () => {
    expect(resolveTemporalReferences("I woke up at 7am and went for a run in the morning.", anchor)).toEqual([]);
  });

  it("an absolute year chrono doesn't parse on its own", () => {
    expect(periodFor("Back in 2024 it was cooler.")).toEqual({ start: "2024-01-01", end: "2024-12-31", precision: "year" });
  });

  it("does not read a bare count as a year", () => {
    expect(resolveTemporalReferences("A crowd of 2000 people showed up.", anchor)).toEqual([]);
  });
});

describe("resolveTemporalReferences — unresolved rather than guessed", () => {
  const anchor = memoryAnchor(OCT_1_2026);
  const reasonFor = (text: string) => {
    const ref = only(resolveTemporalReferences(text, anchor));
    return ref.resolution.status === "unresolved" ? ref.resolution.reason : "resolved";
  };

  it.each([
    "We left the day before.",
    "We left the day before that.",
    "It happened the year before.",
    "It happened the year before that.",
    "We moved three weeks earlier.",
    "We did it the previous month.",
    "We met the previous Saturday.",
    "We met the Saturday before.",
    "Two weeks later we came back.",
    "The day after, we left.",
  ])("anchored to another event: %s", (text) => {
    expect(reasonFor(text)).toBe("anaphoric");
  });

  it.each(["On Saturday we went hiking.", "In March we moved.", "On October 15 we flew out."])(
    "no year and no direction word: %s",
    (text) => {
      expect(reasonFor(text)).toBe("ambiguous-direction");
    }
  );

  it("a direction word keeps a deictic expression resolved even beside an anaphoric marker", () => {
    expect(periodOf(resolveTemporalReferences("Yesterday before lunch we met.", anchor)[0])).toEqual(day("2026-09-30"));
  });
});

describe("splitIntoClauses", () => {
  it("splits sentences, and a comma before a subordinate clause", () => {
    expect(
      splitIntoClauses("Glad we had a plunge pool to cool ourselves off, which we didn't have last year. We went home.").map(
        (c) => c.text
      )
    ).toEqual(["Glad we had a plunge pool to cool ourselves off,", "which we didn't have last year.", "We went home."]);
  });

  it("keeps offsets pointing at the clause in the source text", () => {
    const text = "First one.   Second one.";
    for (const clause of splitIntoClauses(text)) {
      expect(text.slice(clause.index, clause.index + clause.text.length)).toBe(clause.text);
    }
  });

  it("does not split inside a decimal number", () => {
    expect(splitIntoClauses("We ran 3.5 km today.")).toHaveLength(1);
  });
});

describe("relatePeriods", () => {
  const query: Period = { start: "2025-08-21", end: "2025-11-13", precision: "range" };

  it("inside, outside, overlaps", () => {
    expect(relatePeriods(day("2025-10-15"), query)).toBe("inside");
    expect(relatePeriods({ start: "2024-01-01", end: "2024-12-31", precision: "year" }, query)).toBe("outside");
    expect(relatePeriods({ start: "2025-01-01", end: "2025-12-31", precision: "year" }, query)).toBe("overlaps");
  });
});

describe("toQueryPeriod", () => {
  it("classifies queryDateRange.ts's ranges by shape", () => {
    expect(toQueryPeriod(null)).toBeNull();
    expect(toQueryPeriod({ start: "2026-10-01", end: "2026-10-01" })?.precision).toBe("day");
    expect(toQueryPeriod({ start: "2025-01-01", end: "2025-12-31" })?.precision).toBe("year");
    expect(toQueryPeriod({ start: "2026-02-01", end: "2026-02-28" })?.precision).toBe("month");
    expect(toQueryPeriod({ start: "2025-08-21", end: "2025-11-13" })?.precision).toBe("range");
  });
});

const year = (y: number): Period => ({ start: `${y}-01-01`, end: `${y}-12-31`, precision: "year" });
const focused = (...periods: Period[]): QueryTemporalTarget => ({ periods, comparative: false });

describe("resolveMemory — clause relation to the question's periods", () => {
  it("hot-day note asked about a year later: the main fact matches, the internal comparison does not", () => {
    const target = resolveQueryTemporalTarget(HOT_DAY_QUERY, OCT_2_2026);
    const memory = resolveMemory(HOT_DAY_NOTE, epoch(OCT_15_2025), target);
    expect(memory.clauses.map((c) => [c.text.slice(0, 22), c.relation])).toEqual([
      ["It was a very hot day ", "inside"],
      ["Quite unusual for this", "inside"],
      ["Last year same time it", "outside"],
      ["Glad we had a plunge p", "inside"],
      ["which we didn't have l", "outside"],
      ["We caught up with a bu", "inside"],
      ["I am reading an intere", "inside"],
    ]);
  });

  it("with two asked periods, records which period each clause belongs to", () => {
    const target = resolveQueryTemporalTarget("How was the weather in 2025 compared with 2024?", OCT_2_2026);
    const memory = resolveMemory(HOT_DAY_NOTE, epoch(OCT_15_2025), target);
    expect(memory.clauses.map((c) => [c.text.slice(0, 22), c.relation, c.matches])).toEqual([
      ["It was a very hot day ", "inside", [0]],
      ["Quite unusual for this", "inside", [0]],
      ["Last year same time it", "inside", [1]],
      ["Glad we had a plunge p", "inside", [0]],
      ["which we didn't have l", "inside", [1]],
      ["We caught up with a bu", "inside", [0]],
      ["I am reading an intere", "inside", [0]],
    ]);
  });

  it("Varun: the event's own day is not the day the question asks about", () => {
    const target = resolveQueryTemporalTarget(VARUN_QUERY, OCT_2_2026);
    expect(target?.periods).toEqual([day("2026-10-01")]);
    const [clause] = resolveMemory(VARUN_NOTE, epoch(OCT_1_2026), target).clauses;
    expect(clause).toMatchObject({ periods: [day("2026-09-30")], source: "explicit", relation: "outside", matches: [] });
  });

  it("a clause naming two periods on either side of the question's period is mixed", () => {
    const [clause] = resolveMemory("Today was hotter than last year.", epoch(OCT_15_2025), focused(day("2025-10-15"))).clauses;
    expect(clause.relation).toBe("mixed");
  });

  it("a clause with an unresolved expression is unknown, never defaulted to the recorded date", () => {
    const [clause] = resolveMemory("We did it the previous month.", epoch(OCT_1_2026), focused(day("2026-10-01"))).clauses;
    expect(clause).toMatchObject({ periods: [], relation: "unknown" });
  });

  it("a clause with no time expression takes the note's recorded day", () => {
    const [clause] = resolveMemory("We went home.", epoch(OCT_1_2026), null).clauses;
    expect(clause).toMatchObject({ periods: [day("2026-10-01")], source: "recordedDate", relation: "noQueryPeriod" });
  });
});

describe("resolveQueryTemporalTarget — the six required questions (asked 2 Oct 2026)", () => {
  it.each([
    ["How was the weather last year?", [year(2025)], false],
    ["How was the weather in 2024?", [year(2024)], false],
    ["How was the weather in 2025 compared with 2024?", [year(2025), year(2024)], true],
    ["Was 2025 hotter than the previous year?", [year(2025), year(2024)], true],
    ["How was the weather two years ago?", [year(2024)], false],
    ["What happened in 2025?", [year(2025)], false],
  ] as const)("%s", (question, periods, comparative) => {
    expect(resolveQueryTemporalTarget(question, OCT_2_2026)).toEqual({ periods, comparative });
  });
});

describe("resolveQueryTemporalTarget — preserves queryDateRange.ts for everything else", () => {
  it("keeps the detector's more specific result when a single year sits inside a fuller date", () => {
    expect(resolveQueryTemporalTarget("What did I note on 15th March 2025?", OCT_2_2026)?.periods).toEqual([day("2025-03-15")]);
    expect(resolveQueryTemporalTarget("What did I do in October 2025?", OCT_2_2026)?.periods).toEqual([
      { start: "2025-10-01", end: "2025-10-31", precision: "month" },
    ]);
  });

  it("keeps the anniversary window for 'same time last year'", () => {
    expect(resolveQueryTemporalTarget(HOT_DAY_QUERY, OCT_2_2026)?.periods).toEqual([
      { start: "2025-08-21", end: "2025-11-13", precision: "range" },
    ]);
  });

  it("returns null for a question with no time reference", () => {
    expect(resolveQueryTemporalTarget("Tell me about the plunge pool", OCT_2_2026)).toBeNull();
  });

  it("resolves 'the following year' forward from the year it follows", () => {
    expect(resolveQueryTemporalTarget("Was 2024 cooler than the following year?", OCT_2_2026)?.periods).toEqual([
      year(2024),
      year(2025),
    ]);
  });

  it("ignores 'the previous year' when no year precedes it to anchor to", () => {
    expect(resolveQueryTemporalTarget("What did I do the previous year?", OCT_2_2026)).toBeNull();
  });
});

describe("resolveQueryTemporalTarget — comparative intent", () => {
  it("structure alone: two periods are a comparison without any comparison word", () => {
    expect(resolveQueryTemporalTarget("What happened in 2024 and 2025?", OCT_2_2026)?.comparative).toBe(true);
  });

  it("wording alone, with one period", () => {
    expect(resolveQueryTemporalTarget("Was last year hotter than usual?", OCT_2_2026)?.comparative).toBe(true);
  });

  it("a quantity is not a comparison between periods", () => {
    expect(resolveQueryTemporalTarget("Was it more than 40 degrees last year?", OCT_2_2026)?.comparative).toBe(false);
  });
});

describe("classifyNoteForPeriods — event-date eligibility, not only createdAt", () => {
  const classify = (periods: Period[]) => classifyNoteForPeriods(HOT_DAY_NOTE, epoch(OCT_15_2025), periods);

  it("recorded during the asked period", () => {
    expect(classify([year(2025)])).toBe("recorded");
  });

  it("recorded in 2025 but describing 2024 — eligible for a 2024 question", () => {
    expect(classify([year(2024)])).toBe("referenced");
  });

  it("neither recorded in nor referring to the asked period", () => {
    expect(classify([year(2023)])).toBeNull();
  });
});

/** The paragraph (minus the header) the model sees for a question about the
 * real seeded hot-day note. */
function hotDayBody(question: string): string {
  const target = resolveQueryTemporalTarget(question, OCT_2_2026);
  const { contextText } = buildNoteContext([{ content: HOT_DAY_NOTE, transcript: null, createdAt: epoch(OCT_15_2025) }], target);
  return contextText.split("\n").slice(1).join("\n");
}

const HOT_DAY_2025_BODY =
  "It was a very hot day on Wednesday, October 15 2025, perhaps 40 degrees plus. Quite unusual for this month. " +
  "Glad we had a plunge pool to cool ourselves off. We caught up with a bunch of friends, had a few beers and called it a day. " +
  "I am reading an interesting history book these days, it's called Why West Rules for Now.";
const HOT_DAY_2024_BODY =
  "It was a very hot day on Wednesday, October 15 2025, perhaps 40 degrees plus. Quite unusual for this month. " +
  "Last year (2024) same time it was so much better. Glad we had a plunge pool to cool ourselves off, which we didn't have last year (2024).";
const HOT_DAY_COMPARISON_BODY =
  "It was a very hot day on Wednesday, October 15 2025, perhaps 40 degrees plus. Quite unusual for this month. " +
  "Last year (2024) same time it was so much better. Glad we had a plunge pool to cool ourselves off, which we didn't have last year (2024). " +
  "We caught up with a bunch of friends, had a few beers and called it a day. " +
  "I am reading an interesting history book these days, it's called Why West Rules for Now.";

describe("buildNoteContext — the six required questions against the real seeded note", () => {
  it("1. 'How was the weather last year?' — 2025 only; the note's own 2024 comparison is not shown", () => {
    expect(hotDayBody("How was the weather last year?")).toBe(HOT_DAY_2025_BODY);
  });

  it("2. 'How was the weather in 2024?' — the 2024 sentences plus the two sentences they depend on, nothing unrelated", () => {
    // "Last year same time it was so much better" pulls in "Quite unusual
    // for this month", which pulls in the hot day it is unusual about. The
    // friends and book sentences are about 2025 and depend on nothing kept.
    expect(hotDayBody("How was the weather in 2024?")).toBe(HOT_DAY_2024_BODY);
  });

  it("3. 'How was the weather in 2025 compared with 2024?' — both periods, dates inline", () => {
    expect(hotDayBody("How was the weather in 2025 compared with 2024?")).toBe(HOT_DAY_COMPARISON_BODY);
  });

  it("4. 'Was 2025 hotter than the previous year?' — same as 3", () => {
    expect(hotDayBody("Was 2025 hotter than the previous year?")).toBe(HOT_DAY_COMPARISON_BODY);
  });

  it("5. 'How was the weather two years ago?' — same as 2", () => {
    expect(hotDayBody("How was the weather two years ago?")).toBe(HOT_DAY_2024_BODY);
  });

  it("6. 'What happened in 2025?' — same as 1, the note's wider 2025 context", () => {
    expect(hotDayBody("What happened in 2025?")).toBe(HOT_DAY_2025_BODY);
  });
});

describe("buildNoteContext — filtering rules", () => {
  const build = (content: string, createdAt: Date, target: QueryTemporalTarget | null) =>
    buildNoteContext([{ content, transcript: null, createdAt: epoch(createdAt) }], target);

  it("keeps everything when comparison wording names only one period (the baseline is unknown)", () => {
    expect(hotDayBody("Was last year hotter than usual?")).toBe(HOT_DAY_COMPARISON_BODY);
  });

  it("never drops an unresolved sentence in a focused question", () => {
    const { contextText } = build("We did it the previous month. It was fun.", OCT_1_2026, focused(year(2026)));
    expect(contextText.split("\n")[1]).toBe("We did it the previous month. It was fun.");
  });

  it("a sentence that depends on nothing does not pull in its neighbour", () => {
    const note = "We painted the fence. Last year we went to Bali.";
    const { contextText } = build(note, OCT_15_2025, focused(year(2024)));
    expect(contextText.split("\n")[1]).toBe("Last year (2024) we went to Bali.");
  });

  it("leaves a note out entirely — and reports it — when nothing in it is about the asked period", () => {
    const result = build(VARUN_NOTE, OCT_1_2026, focused(day("2026-10-01")));
    expect(result).toMatchObject({ contextText: "", includedIndices: [] });
  });

  it("renumbers notes when one is left out", () => {
    const target = focused(year(2024));
    const result = buildNoteContext(
      [
        { content: "We moved house today.", transcript: null, createdAt: epoch(OCT_1_2026) },
        { content: HOT_DAY_NOTE, transcript: null, createdAt: epoch(OCT_15_2025) },
      ],
      target
    );
    expect(result.includedIndices).toEqual([1]);
    expect(result.contextText.startsWith("--- NOTE 1 [Recorded: Wednesday, Oct 15, 2025")).toBe(true);
  });

  it("contains no JSON, XML or bracketed labels — one plain paragraph per note", () => {
    const body = hotDayBody("How was the weather in 2025 compared with 2024?");
    expect(body).not.toMatch(/[{}<>[\]]/);
    expect(body).not.toContain("\n");
  });

  it("with no temporal question, renders the unchanged paragraph format", () => {
    const { contextText } = build(HOT_DAY_NOTE, OCT_15_2025, null);
    expect(contextText.split("\n")).toHaveLength(2);
  });
});

describe("checkAnswerDates — only dates the resolver established", () => {
  const hotDayEstablished = (question = HOT_DAY_QUERY) => {
    const target = resolveQueryTemporalTarget(question, OCT_2_2026);
    const { memories } = buildNoteContext([{ content: HOT_DAY_NOTE, transcript: null, createdAt: epoch(OCT_15_2025) }], target);
    return { established: establishedPeriods(memories, target), asked: target?.periods ?? [] };
  };

  it("rejects the right day with the wrong year — never substitutes the established year", () => {
    // Formerly repaired to "Oct 15 2025". A generated factual claim is never
    // rewritten with the app's own date; the answer is rejected instead.
    const answer = "Your Oct 15 2024 note says it was a very hot day, perhaps 40 degrees plus.";
    expect(checkAnswerDates(answer, hotDayEstablished().established, OCT_2_2026)).toEqual({
      status: "rejected",
      text: answer,
      violations: ["Oct 15 2024"],
    });
  });

  it("rejects the live Q2 failure: the 2025 hot day placed in 2024", () => {
    const { established } = hotDayEstablished("How was the weather in 2024?");
    const result = checkAnswerDates("It was a very hot day on Wednesday, October 15 2024, perhaps 40 degrees plus.", established, OCT_2_2026);
    expect(result).toMatchObject({ status: "rejected" });
  });

  it("allows a legitimate year that differs from createdAt when a clause established it", () => {
    expect(checkAnswerDates("In 2024 it was much better.", hotDayEstablished().established, OCT_2_2026).status).toBe("ok");
  });

  it("allows the note's own date", () => {
    expect(checkAnswerDates("Your October 15, 2025 note says it was hot.", hotDayEstablished().established, OCT_2_2026).status).toBe("ok");
  });

  it("leaves an answer with no explicit-year dates alone", () => {
    const answer = "It was a very hot day, perhaps 40 degrees plus.";
    expect(checkAnswerDates(answer, hotDayEstablished().established, OCT_2_2026)).toEqual({ status: "ok", text: answer });
  });

  it("does not validate relative words in the answer (v1 scope)", () => {
    expect(checkAnswerDates("Yes, you celebrated it yesterday.", [day("2026-09-30")], OCT_2_2026).status).toBe("ok");
  });

  it("rejects a date more precise than anything established, instead of repairing by loose overlap", () => {
    // 2024 is established only as a whole year; "October 2024" is more
    // precise than that and has no same-month-and-day candidate.
    const result = checkAnswerDates("Your October 2024 note says so.", hotDayEstablished().established, OCT_2_2026);
    expect(result).toMatchObject({ status: "rejected", violations: ["October 2024"] });
  });

  it("rejects a specific day merely contained in an established year", () => {
    const result = checkAnswerDates("It rained on March 3 2024.", hotDayEstablished().established, OCT_2_2026);
    expect(result).toMatchObject({ status: "rejected", violations: ["March 3 2024"] });
  });

  it("rejects when more than one established day shares the month and day", () => {
    const established = [day("2024-10-15"), day("2025-10-15")];
    const result = checkAnswerDates("Your Oct 15 2023 note says so.", established, OCT_2_2026);
    expect(result).toMatchObject({ status: "rejected", violations: ["Oct 15 2023"] });
  });

  it("rejects a date unrelated to anything established", () => {
    const result = checkAnswerDates("In 2019 you moved house.", [day("2026-09-30")], OCT_2_2026);
    expect(result).toMatchObject({ status: "rejected", violations: ["2019"] });
  });
});
