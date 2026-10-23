import { buildNoteContext, finalizeAnswer, isRecencyQuestion, RECENT_WINDOW_DAYS, withinRecentWindow } from "../services/ai/ragFormatting";
import { OPEN_QUESTION_PREFIX, questionForModel, withAccompaniment } from "../services/ai/relationshipGrounding";
import { buildGroundedQuestion, classifyEventEvidence, detectEventVerification, resolveQueryTemporalTarget } from "../services/ai/temporalResolver";
import { NOW, VAULT, type VaultNote } from "../scripts/eval/askQualityCorpus";

// Ask answer quality (2.0 dogfood): fixed synthetic answers through rag.ts's
// context and post-generation path. Every note is invented.
const note = (id: string): VaultNote => {
  const found = VAULT.find((n) => n.id === id);
  if (!found) throw new Error(`no vault note ${id}`);
  return found;
};
const custom = (id: string, content: string, createdAt: number): VaultNote => ({ id, content, createdAt });

function outcome(question: string, notes: VaultNote[], answer: string): string {
  const target = resolveQueryTemporalTarget(question, NOW);
  const verification = detectEventVerification(question, NOW, target);
  const eventTerms = verification?.eventTerms ?? [];
  const built = buildNoteContext(
    notes.map((n) => ({ id: n.id, content: n.content, transcript: null, createdAt: n.createdAt })),
    target,
    { eventTerms }
  );
  const memories = built.includedIndices.map((i) => built.memories[i]);
  return finalizeAnswer({
    raw: answer,
    notesIncluded: built.includedIndices.length,
    contextText: built.contextText,
    question: verification ? buildGroundedQuestion(question, NOW) : question,
    memories,
    evidence: built.evidence,
    target,
    now: NOW,
    eventEvidence: verification && target ? classifyEventEvidence(memories, target, eventTerms) : null,
  }).outcome;
}

const RONNIE_HOME = ["ronnieSettle", "ronnieOffer", "ronnieWarming"].map(note);
const PRIYA_WARMING = custom(
  "priyaWarming",
  "Went to Priya's housewarming in Brunswick. She wants to repaint the hallway green.",
  note("ronnieWarming").createdAt
);

describe("summaries across several notes", () => {
  it("a statement wholly supported by one note is shown, even when a value it uses ('Brunswick') is in another note too", () => {
    const answer =
      "Ronnie got the keys to his new home. The kitchen needs a full renovation. He wants to repaint the hallway green at Ronnie's housewarming in Brunswick.";
    expect(outcome("Summarise notes related to Ronnie's new home", RONNIE_HOME, answer)).toBe("shown");
  });

  it("a statement combining two notes is still rejected (Priya's hallway is not Ronnie's)", () => {
    const answer = "Ronnie wants to repaint the hallway green in Brunswick.";
    expect(outcome("Summarise notes related to Ronnie's new home", [note("ronnieOffer"), PRIYA_WARMING], answer)).toBe("relationship-rejected");
  });

  it("individually supported facts about a person from different notes are shown", () => {
    const answer =
      "Ronnie has been struggling with back pain since the move. He also said work has been stressful because his team lost two people.";
    expect(outcome("What problems has Ronnie had recently?", ["ronnieBack", "ronnieWork", "ronnieOld"].map(note), answer)).toBe("shown");
  });
});

describe("who / when", () => {
  it("companions named in the same sentence as the trip are shown", () => {
    const trip = custom("ski", "Skied Queenstown with Dev and Anika, the snow was perfect.", note("qtBack").createdAt);
    expect(outcome("Who did I go skiing with in Queenstown?", [trip], "You went skiing in Queenstown with Dev and Anika.")).toBe("shown");
  });

  it("people from another sentence of the note are not taken as companions", () => {
    const trip = custom("ski2", "Booked the Queenstown ski trip for July. I also had lunch with Priya and Sam.", note("qtBook").createdAt);
    expect(outcome("Who did I go skiing with in Queenstown?", [trip], "You went skiing in Queenstown with Priya and Sam.")).toBe("relationship-rejected");
  });

  it("a past-tense accompaniment sentence right after the trip supports the companions", () => {
    const notes = ["qtDone", "skiGloves"].map(note);
    expect(outcome("Who did I go skiing with in Queenstown?", notes, "You went skiing in Queenstown with Dev and Anika.")).toBe("shown");
  });

  it("an accompaniment sentence after a DIFFERENT sentence (visiting Mum) is not joined to the trip", () => {
    expect(outcome("Who did I go skiing with in Queenstown?", [note("qtMum")], "You went skiing in Queenstown with Priya and Sam.")).toBe("relationship-rejected");
  });

  it.each([
    ["Dev and Anika came with me.", true],
    ["Went with Dev and Anika.", true],
    ["Mum came with us too.", true],
    ["Dev and Anika are coming with me.", false], // a plan, not evidence they went
    ["Mum will join us.", false],
    ["Dev didn't come with me.", false],
    ["Dev and Anika came with me to the concert.", false],
    ["I had lunch with Priya and Sam.", false],
  ])("accompaniment shape: %s → joined %s", (sentence, joins) => {
    const evidence = [
      { noteId: "n", noteIndex: 0, sentenceIndex: 0, createdAt: 0, text: "Booked the Queenstown ski trip.", dates: [] },
      { noteId: "n", noteIndex: 0, sentenceIndex: 1, createdAt: 0, text: sentence, dates: [] },
    ];
    expect(withAccompaniment(evidence).length).toBe(joins ? 3 : 2);
  });
});

describe("planned vs completed events (no event-status engine; regression only)", () => {
  const PLAN = [note("byronPlan")]; // "Booked the Byron Bay surf trip for the first week of December. Dev and Anika are coming with me."

  it("a plan stated as a plan is shown", () => {
    expect(outcome("Who is coming with me to Byron Bay?", PLAN, "Dev and Anika are coming with you to Byron Bay in the first week of December.")).toBe("shown");
  });

  it("planned companions are not shown as having gone", () => {
    expect(outcome("Who did I go surfing with in Byron Bay?", PLAN, "You went surfing in Byron Bay with Dev and Anika.")).toBe("relationship-rejected");
  });

  it("a booking note's recording day is not the trip date", () => {
    expect(outcome("When did I go to Byron Bay?", PLAN, "You went to Byron Bay on Saturday, October 10, 2026.")).toBe("relationship-rejected");
    const both = ["qtBook", "qtBack"].map(note);
    expect(outcome("When did I go to Queenstown?", both, "You went to Queenstown on Tuesday, June 2, 2026.")).toBe("relationship-rejected");
  });

  it("with the completion note too, the planned period and the return day are shown", () => {
    const both = ["qtBook", "qtBack"].map(note);
    expect(outcome("When did I go to Queenstown?", both, "You went to Queenstown in the second week of July.")).toBe("shown");
    expect(outcome("When did I go to Queenstown?", both, "You got back from Queenstown on Tuesday, July 14, 2026.")).toBe("shown");
  });

  // Known limitation (BACKLOG): with ONLY a plan, "You went to Byron Bay in the
  // first week of December" is still accepted — tense and future dates aren't
  // checked. Not pinned here, so a future fix doesn't have to break a test.
});

describe("general yes/no questions and 'lately'", () => {
  const RONNIE_ISSUES = ["ronnieBack", "ronnieWork"].map(note);
  const evidenceFor = (question: string, notes: VaultNote[]) =>
    buildNoteContext(notes.map((n) => ({ id: n.id, content: n.content, transcript: null, createdAt: n.createdAt })), resolveQueryTemporalTarget(question, NOW)).evidence;

  it("a yes/no question no shown sentence can confirm is asked in open form", () => {
    const q = "Has Ronnie been having issues lately?";
    const open = "What do my notes say about whether Ronnie has been having issues lately?";
    expect(questionForModel(q, evidenceFor(q, RONNIE_ISSUES), NOW)).toBe(open);
    // Also with a third same-day note in context, and when a note does use the word "issue".
    expect(questionForModel(q, evidenceFor(q, [...RONNIE_ISSUES, note("ronnieWarming")]), NOW)).toBe(open);
    const landlord = custom("landlord", "Ronnie mentioned an issue with his landlord about the bond.", note("ronnieBack").createdAt);
    expect(questionForModel(q, evidenceFor(q, [landlord, ...RONNIE_ISSUES]), NOW)).toBe(open);
  });

  it("a question not shaped 'Has <Name> …' keeps the prefix form", () => {
    const q = "Is Ronnie's back getting better lately?";
    expect(questionForModel(q, evidenceFor(q, RONNIE_ISSUES), NOW)).toBe(`${OPEN_QUESTION_PREFIX}${q}`);
    const patel = custom("patel", "Dr Patel said my knee is just a mild sprain.", note("ronnieBack").createdAt);
    const p = "Did Dr Patel prescribe painkillers?";
    expect(questionForModel(p, evidenceFor(p, [patel]), NOW)).toBe(`${OPEN_QUESTION_PREFIX}${p}`);
  });

  it.each([
    ["Did Ronnie buy a road bike?", ["ronan", "ronnieOffer"]], // the notes hold "road bike" (Ronan's)
    ["Did Ronnie get the keys to his new home?", ["ronnieSettle", "ronnieOffer"]], // a "Yes" can be verified
    ["Has Zoe been having issues lately?", ["ronnieBack", "ronnieWork"]], // Zoe is in no note
    ["What problems has Ronnie had recently?", ["ronnieBack", "ronnieWork"]], // not yes/no
  ])("is unchanged: %s", (q, ids) => {
    expect(questionForModel(q, evidenceFor(q, ids.map(note)), NOW)).toBe(q);
  });

  it("the open-form answer is shown; a 'Yes' is still checked against the original question", () => {
    const q = "Has Ronnie been having issues lately?";
    const open = "Your notes indicate that Ronnie has been struggling with back pain since the move and is seeing a physio on Monday.";
    expect(outcome(q, RONNIE_ISSUES, open)).toBe("shown");
    expect(outcome(q, RONNIE_ISSUES, "Yes, Ronnie has been struggling with back pain since the move.")).toBe("verification-contradicted");
  });

  it("'lately' keeps only notes from the last RECENT_WINDOW_DAYS days", () => {
    expect(isRecencyQuestion("Has Ronnie been having issues lately?")).toBe(true);
    expect(isRecencyQuestion("What did I do recently?")).toBe(true);
    expect(isRecencyQuestion("Summarise my latest notes")).toBe(false);
    const kept = withinRecentWindow(["ronnieBack", "ronnieWork", "ronnieOld"].map(note), NOW).map((n) => n.id);
    expect(kept).toEqual(["ronnieBack", "ronnieWork"]);
    expect(RECENT_WINDOW_DAYS).toBe(30);
  });
});

describe("dates written without a year", () => {
  const MAYA = ["moveB", "moveA", "ronnieOffer"].map(note);
  it.each([["Maya now moves to Sydney on 28 November."], ["Maya moves to Sydney on November 28th."], ["Maya was first moving on 14 November."]])(
    "a day the notes give is shown: %s",
    (answer) => {
      expect(outcome("When is Maya moving to Sydney?", MAYA, answer)).toBe("shown");
    }
  );

  it.each([["Maya moves to Sydney on 21 November."], ["Maya moves to Sydney on December 5."]])("a day no note gives is rejected: %s", (answer) => {
    expect(outcome("When is Maya moving to Sydney?", MAYA, answer)).toBe("relationship-rejected");
  });

  it("the recording day of the sentence counts as stated", () => {
    expect(outcome("When did Ronnie get the keys?", RONNIE_HOME, "Ronnie got the keys on 25 September.")).toBe("shown");
  });
});

describe("partial answers", () => {
  const GRAMPIANS = ["grampians", "ronnieOffer", "fence"].map(note);
  const Q = "Who did I go to the Grampians with and how much was the cabin?";

  it("answers the known part and says the rest isn't in the notes", () => {
    expect(outcome(Q, GRAMPIANS, "You went to the Grampians with Leo and Sara. Your notes don't mention how much the cabin cost.")).toBe("shown");
  });

  it("an invented price is still rejected", () => {
    expect(outcome(Q, GRAMPIANS, "You went to the Grampians with Leo and Sara. The cabin cost $180.")).toBe("relationship-rejected");
  });

  it("a decline of something the notes DO give is still rejected", () => {
    expect(outcome(Q, GRAMPIANS, "Your notes don't mention who you went to the Grampians with.")).toBe("relationship-rejected");
  });
});

describe("protections that must hold", () => {
  it("an unsupported event is rejected", () => {
    expect(outcome("When did I go to Paris with Ronnie?", RONNIE_HOME, "You went to Paris with Ronnie in June.")).toBe("relationship-rejected");
  });

  it("similar names: Ronan's purchase is never Ronnie's", () => {
    const notes = ["ronan", "ronnieOffer", "ronnieWarming"].map(note);
    expect(outcome("What did Ronnie buy?", notes, "Ronnie bought a second-hand road bike for $650.")).toBe("relationship-rejected");
    expect(outcome("Did Ronnie buy a road bike?", notes, "Yes, Ronnie bought a second-hand road bike for $650.")).toBe("verification-contradicted");
    expect(outcome("What did Ronan buy?", notes, "Ronan bought a second-hand road bike for $650.")).toBe("shown");
  });

  it("a 'Yes' to a question the notes don't state is not shown", () => {
    const notes = ["ronnieBack", "ronnieWork", "ronnieOld"].map(note);
    expect(outcome("Has Ronnie been having issues lately?", notes, "Yes, Ronnie has been struggling with back pain since the move.")).toBe("verification-contradicted");
  });

  it("same-note combination: the phone wasn't dropped 'on the way back from painting'", () => {
    const notes = ["fence", "ronnieWarming", "grampians"].map(note);
    expect(outcome("What happened on Kabir's way back from painting the fence?", notes, "Kabir dropped his phone at Bunnings on the way back from painting the fence.")).toBe(
      "relationship-rejected"
    );
    expect(outcome("What did Kabir paint?", notes, "Kabir painted the back fence on Saturday.")).toBe("shown");
  });
});
