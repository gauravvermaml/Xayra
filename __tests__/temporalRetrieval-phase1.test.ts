import { buildNoteContext, finalizeAnswer, NO_RELEVANT_NOTES_MESSAGE, UNVERIFIED_ANSWER_MESSAGE } from "../services/ai/ragFormatting";
import {
  buildGroundedQuestion,
  classifyEventEvidence,
  classifyNoteForPeriods,
  detectEventVerification,
  questionTerms,
  rankNotesForTarget,
  resolveMemory,
  resolveQueryTemporalTarget,
  resolveTemporalExpressions,
  resolveTemporalReferences,
  type Period,
  type TemporalAnchor,
  type TemporalReference,
} from "../services/ai/temporalResolver";

// Phase 1 retrieval fixes, tested against real notes from the 50-question
// evaluation vault. Local-time construction throughout — a raw epoch literal
// would land on a different local day depending on the machine's timezone.
const epoch = (d: Date) => Math.floor(d.getTime() / 1000);
const at = (y: number, m: number, d: number, h = 12, min = 0) => epoch(new Date(y, m - 1, d, h, min));
const memoryAnchor = (d: Date): TemporalAnchor => ({ kind: "memoryCreatedAt", date: d });
const day = (iso: string): Period => ({ start: iso, end: iso, precision: "day" });
const year = (y: number): Period => ({ start: `${y}-01-01`, end: `${y}-12-31`, precision: "year" });
const periodOf = (ref: TemporalReference): Period => {
  if (ref.resolution.status !== "resolved") throw new Error(`unresolved: ${ref.text}`);
  return ref.resolution.period;
};

const OCT_1_2026 = new Date(2026, 9, 1, 12);
/** "Now" for every question: Friday 2 October 2026, noon. */
const NOW = new Date(2026, 9, 2, 12);

const NOTES = {
  varunJob: { text: "Varun is starting a new job at Atlassian next month. He sounded really excited.", createdAt: at(2026, 9, 20, 18, 30) },
  knee: { text: "Dr Patel said my knee is just a mild sprain. Ice it twice a day for a week and no running for a fortnight.", createdAt: at(2026, 9, 18, 16) },
  ptInterview: { text: "Tomorrow I have the parent-teacher interview at 4pm with Ms Rossi.", createdAt: at(2026, 10, 2, 9) },
  market: { text: "Today we went to the farmers market and bought a box of peaches. Sam made a peach crumble for dessert.", createdAt: at(2026, 10, 1, 18) },
  varunBday: { text: "Yesterday we celebrated Varun's 40th birthday at Bella Napoli. The tiramisu was amazing.", createdAt: at(2026, 10, 1, 9) },
  grampians: { text: "Next weekend we are driving to the Grampians for a hike. Need to book the cabin.", createdAt: at(2026, 10, 1, 21) },
  walk: { text: "Went for a 5k walk along the river this morning. Saw a family of ducks.", createdAt: at(2026, 10, 2, 8) },
};
type NoteKey = keyof typeof NOTES;

/** The production retrieval + context path over the named notes. */
function retrieveFor(question: string, keys: NoteKey[]) {
  const target = resolveQueryTemporalTarget(question, NOW)!;
  const verification = detectEventVerification(question, NOW, target);
  const eventTerms = verification?.eventTerms ?? [];
  const ranked = rankNotesForTarget(
    keys.map((key) => ({ note: key, text: NOTES[key].text, createdAt: NOTES[key].createdAt })),
    target,
    { question: questionTerms(question, NOW), event: eventTerms },
    3
  );
  const selected = ranked.map((r) => r.note);
  const built = buildNoteContext(
    selected.map((k) => ({ content: NOTES[k].text, transcript: null, createdAt: NOTES[k].createdAt })),
    target,
    { eventTerms }
  );
  return { target, eventTerms, ranked, selected, built };
}

describe("fix 1 — a coarse reference is not evidence about a finer period", () => {
  it("'next month' (all of October) does not make a note about 1, 2 or 3 October", () => {
    for (const d of ["2026-10-01", "2026-10-02", "2026-10-03"]) {
      expect(classifyNoteForPeriods(NOTES.varunJob.text, NOTES.varunJob.createdAt, [day(d)])).toBeNull();
    }
  });

  it("...but still answers a question about October itself", () => {
    const october: Period = { start: "2026-10-01", end: "2026-10-31", precision: "month" };
    expect(classifyNoteForPeriods(NOTES.varunJob.text, NOTES.varunJob.createdAt, [october])).toBe("referenced");
  });

  it("a duration ('for a week') is not a date: the knee note has no date references", () => {
    expect(resolveTemporalReferences(NOTES.knee.text, memoryAnchor(new Date(NOTES.knee.createdAt * 1000)))).toEqual([]);
    const lastWeek: Period = { start: "2026-09-20", end: "2026-09-26", precision: "week" };
    expect(classifyNoteForPeriods(NOTES.knee.text, NOTES.knee.createdAt, [lastWeek])).toBeNull();
  });

  it("a real date in the same sentence as a duration still resolves", () => {
    const refs = resolveTemporalReferences("We stayed there for a week last year.", memoryAnchor(OCT_1_2026));
    expect(refs.map(periodOf)).toEqual([year(2025)]);
  });
});

describe("fix 2 — notes are ranked before the three-note limit", () => {
  it("'What did I do yesterday?' keeps all three notes recorded that day over the loose 'next month' match", () => {
    expect(retrieveFor("What did I do yesterday?", ["varunJob", "varunBday", "market", "grampians"]).selected).toEqual([
      "varunBday",
      "market",
      "grampians",
    ]);
  });

  it("question terms outrank date order when more notes qualify than fit", () => {
    const question = "What happened with the car in 2025?";
    const target = resolveQueryTemporalTarget(question, NOW)!;
    const candidates = [
      { note: "laptop", text: "Bought a new laptop for work.", createdAt: at(2025, 1, 10) },
      { note: "fence", text: "Fixed the back fence with Sam.", createdAt: at(2025, 2, 10) },
      { note: "shed", text: "Painted the shed a dark green.", createdAt: at(2025, 3, 10) },
      { note: "car", text: "The car failed its roadworthy, needs new tyres.", createdAt: at(2025, 11, 10) },
    ];
    const ranked = rankNotesForTarget(candidates, target, { question: questionTerms(question, NOW), event: [] }, 3);
    expect(ranked.map((r) => r.note)).toContain("car");
  });

  it("a date it cannot resolve (no year) never makes a note eligible on its own", () => {
    // Live regression caught end to end: these were selected for "last week"
    // and "this morning" because their unresolved dates counted as relevant.
    const target = resolveQueryTemporalTarget("What did I do this morning?", NOW)!;
    const candidates = [
      { note: "tokyo", text: "Booked flights to Tokyo for the first week of April.", createdAt: at(2026, 2, 10, 19) },
      { note: "rego", text: "Rego renewal is due on 30 November.", createdAt: at(2026, 9, 10, 17) },
      { note: "walk", text: NOTES.walk.text, createdAt: NOTES.walk.createdAt },
    ];
    const ranked = rankNotesForTarget(candidates, target, { question: [], event: [] }, 3);
    expect(ranked.map((r) => r.note)).toEqual(["walk"]);
  });

  it("returns the selected notes in chronological order", () => {
    const { ranked } = retrieveFor("What did I do yesterday?", ["grampians", "market", "varunBday"]);
    const times = ranked.map((r) => NOTES[r.note].createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe("fix 3 — a bare time attaches to its sentence's day", () => {
  it("'Tomorrow ... at 4pm' is one event day (tomorrow) with a time of 16:00, not two dates", () => {
    const { references, times } = resolveTemporalExpressions(NOTES.ptInterview.text, memoryAnchor(new Date(NOTES.ptInterview.createdAt * 1000)));
    expect(references.map(periodOf)).toEqual([day("2026-10-03")]);
    expect(times).toEqual([
      expect.objectContaining({ text: "at 4pm", hour: 16, minute: 0, day: day("2026-10-03"), attachedTo: "reference", referenceIndex: 0 }),
    ]);
  });

  it("with no day in the sentence, the time belongs to the recording day", () => {
    const { references, times } = resolveTemporalExpressions("I woke up at 7am.", memoryAnchor(OCT_1_2026));
    expect(references).toEqual([]);
    expect(times).toEqual([expect.objectContaining({ hour: 7, day: day("2026-10-01"), attachedTo: "anchorDay" })]);
  });

  it("the interview note is not 'this morning' -- but is 'tomorrow'", () => {
    expect(retrieveFor("What did I do this morning?", ["walk", "ptInterview", "varunJob"]).selected).toEqual(["walk"]);
    expect(retrieveFor("What's on for tomorrow?", ["walk", "ptInterview", "varunJob"]).selected).toEqual(["ptInterview"]);
  });
});

describe("fix 4 — event-verification questions", () => {
  const verificationOf = (q: string) => detectEventVerification(q, NOW, resolveQueryTemporalTarget(q, NOW));

  it("detects a yes/no question about an event in a period, from its structure", () => {
    expect(verificationOf("Did I celebrate Varun's birthday yesterday?")).toEqual({ eventTerms: ["celebrat", "varun", "birthday"] });
    expect(verificationOf("What did I do yesterday?")).toBeNull();
    expect(verificationOf("Did I note anything yesterday?")).toBeNull();
  });

  it("builds a separate grounded question with the resolved date inline", () => {
    expect(buildGroundedQuestion("Did I celebrate Varun's birthday yesterday?", NOW)).toBe(
      "Did I celebrate Varun's birthday yesterday (Thursday, October 1 2026)?"
    );
  });

  it("Varun: the celebration sentence is kept with its own date (30 Sep) -- nothing unrelated is added", () => {
    const { selected, built } = retrieveFor("Did I celebrate Varun's birthday yesterday?", ["varunJob", "varunBday", "market", "grampians"]);
    expect(selected).toEqual(["varunBday", "market", "grampians"]);
    expect(built.contextText).toContain("On Wednesday, September 30 2026 we celebrated Varun's 40th birthday at Bella Napoli.");
    expect(built.contextText).not.toContain("Atlassian");
  });

  it("an ordinary lookup of the same day does not add the celebration sentence", () => {
    expect(retrieveFor("What did I do yesterday?", ["varunBday"]).built.contextText).not.toContain("September 30");
  });

  it("classifies the evidence three ways -- and 'none' is not proof", () => {
    const evidenceFor = (question: string, keys: NoteKey[]) => {
      const { target, eventTerms, selected } = retrieveFor(question, keys);
      const memories = selected.map((k) => resolveMemory(NOTES[k].text, NOTES[k].createdAt, target));
      return classifyEventEvidence(memories, target, eventTerms);
    };
    expect(evidenceFor("Did I celebrate Varun's birthday yesterday?", ["varunBday", "market"])).toEqual({
      kind: "different-date",
      eventDates: [day("2026-09-30")],
    });
    expect(evidenceFor("Did I go to the farmers market yesterday?", ["market", "varunBday"]).kind).toBe("on-queried-date");
    expect(evidenceFor("Did I go to the dentist yesterday?", ["market", "varunBday"]).kind).toBe("none");
  });
});

describe("finalizeAnswer — the shared post-generation path", () => {
  const base = {
    contextText: "--- NOTE 1 ---\nOn Wednesday, September 30 2026 we celebrated Varun's 40th birthday at Bella Napoli.",
    question: "Did I celebrate Varun's birthday yesterday (Thursday, October 1 2026)?",
    target: null,
    now: NOW,
  };
  const varunBuild = buildNoteContext(
    [{ id: "varunBday", content: NOTES.varunBday.text, transcript: null, createdAt: NOTES.varunBday.createdAt }],
    null
  );
  const varun = { memories: varunBuild.memories, evidence: varunBuild.evidence };

  it("no retrieved notes: the no-notes message, whatever the model said", () => {
    expect(finalizeAnswer({ ...base, raw: "Yes!", notesIncluded: 0, memories: [], evidence: [], eventEvidence: null })).toMatchObject({
      text: NO_RELEVANT_NOTES_MESSAGE,
      outcome: "no-notes",
    });
  });

  it("a flat denial with NO event evidence is not shown as fact", () => {
    const result = finalizeAnswer({ ...base, raw: "No, you didn't celebrate it.", notesIncluded: 1, ...varun, eventEvidence: { kind: "none", eventDates: [] } });
    expect(result).toMatchObject({ text: UNVERIFIED_ANSWER_MESSAGE, outcome: "unsupported-negation" });
  });

  it("an answer citing the recorded different date passes", () => {
    const result = finalizeAnswer({
      ...base,
      raw: "No, you celebrated Varun's birthday on Wednesday, September 30 2026 at Bella Napoli.",
      notesIncluded: 1,
      ...varun,
      eventEvidence: { kind: "different-date", eventDates: [day("2026-09-30")] },
    });
    expect(result.outcome).toBe("shown");
  });

  it("a bare Yes against a recorded different date is rejected, not rewritten", () => {
    const result = finalizeAnswer({
      ...base,
      raw: "Yes, you celebrated Varun's birthday.",
      notesIncluded: 1,
      ...varun,
      eventEvidence: { kind: "different-date", eventDates: [day("2026-09-30")] },
    });
    expect(result).toMatchObject({ text: UNVERIFIED_ANSWER_MESSAGE, outcome: "verification-contradicted" });
  });
});
