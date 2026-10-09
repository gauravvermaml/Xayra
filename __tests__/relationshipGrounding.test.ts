import { buildNoteContext, finalizeAnswer, UNVERIFIED_ANSWER_MESSAGE } from "../services/ai/ragFormatting";
import { checkAffirmativeAnswer, checkVerificationAnswer, isSpellingVariant, relatedEvidenceNotes, validateRelationships, verificationAddendum } from "../services/ai/relationshipGrounding";
import {
  classifyEventEvidence,
  describeQueriedDate,
  detectEventVerification,
  resolveQueryTemporalTarget,
  type Period,
} from "../services/ai/temporalResolver";
import { NOW, VAULT, type VaultNote } from "../scripts/eval/ragComparisonCorpus";

// Phase 2 relationship grounding, through the production context path: the
// evidence is exactly the sentences buildNoteContext shows the model.
const day = (iso: string): Period => ({ start: iso, end: iso, precision: "day" });
const note = (id: string): VaultNote => {
  const found = VAULT.find((n) => n.id === id);
  if (!found) throw new Error(`no vault note ${id}`);
  return found;
};
const custom = (id: string, content: string, createdAt = note("car").createdAt): VaultNote => ({ id, content, createdAt });

/** rag.ts's path up to generation, for the given notes. */
function pipeline(question: string, notes: VaultNote[]) {
  const target = resolveQueryTemporalTarget(question, NOW);
  const verification = detectEventVerification(question, NOW, target);
  const eventTerms = verification?.eventTerms ?? [];
  const built = buildNoteContext(
    notes.map((n) => ({ id: n.id, content: n.content, transcript: null, createdAt: n.createdAt })),
    target,
    { eventTerms }
  );
  const memories = built.includedIndices.map((i) => built.memories[i]);
  const eventEvidence = verification && target ? classifyEventEvidence(memories, target, eventTerms) : null;
  return { target, built, memories, eventEvidence };
}

function verdict(question: string, notes: VaultNote[], answer: string): "accept" | "reject" {
  const { built, eventEvidence } = pipeline(question, notes);
  return validateRelationships({ answer, question, evidence: built.evidence, now: NOW, eventEvidence }).ok ? "accept" : "reject";
}

describe("the six relationship-grounding failure cases", () => {
  const cases: [string, string, string[], [string, "accept" | "reject"][]][] = [
    ["1 plumber vs car service", "How much did the plumber charge?", ["car"], [
      ["• Car service at Ultra Tune came to $480.", "reject"],
      ["The plumber charged $480.", "reject"],
      ["Your notes don't mention a plumber's charge.", "accept"],
    ]],
    ["1b control", "How much did the car service cost?", ["car"], [
      ["The car service at Ultra Tune came to $480.", "accept"],
      ["It cost $480 and they replaced the front brake pads.", "accept"],
    ]],
    ["2 Eli / Elias", "Is Eli moving to Perth?", ["eli"], [
      ["Eli is moving to Perth.", "reject"],
      ["• Eli is moving to Perth in January.", "reject"],
      ["No — Eli's brother Elias is moving to Perth in January.", "accept"],
      ["Elias, Eli's brother, is moving to Perth in January.", "accept"],
    ]],
    ["3 Tokyo dates", "When did I go to Tokyo?", ["tokyoBook", "tokyoBack"], [
      ["• Went to Tokyo on Tuesday, February 10, 2026.", "reject"],
      ["You went to Tokyo in the first week of April.", "accept"],
      ["You flew to Tokyo in April 2026.", "accept"],
      ["You got back from Tokyo on Sunday, April 12, 2026.", "accept"],
    ]],
    ["4 hotel", "Which hotel did I stay at in Tokyo?", ["tokyoBook", "tokyoBack"], [
      ["You stayed at the Park Hyatt in Tokyo.", "reject"],
      ["Your notes don't mention a hotel in Tokyo.", "accept"],
    ]],
    ["5 hot weather, 2024", "How was the weather in 2024?", ["hot"], [
      ["In 2024 it was 40 degrees plus.", "reject"],
      ["Last year (2024) same time it was so much better.", "accept"],
    ]],
    ["5b comparison", "How was the weather in 2025 compared with 2024?", ["hot"], [
      ["It was a very hot day on Wednesday, October 15, 2025, perhaps 40 degrees plus. Last year (2024) same time it was so much better.", "accept"],
      ["2024 was much better weather than 2025.", "accept"],
    ]],
    ["6 Varun", "Did I celebrate Varun's birthday yesterday?", ["varunBday", "market"], [
      ["Yes, you celebrated Varun's birthday yesterday.", "reject"],
      ["You celebrated Varun's 40th birthday at Bella Napoli on Wednesday, September 30, 2026.", "accept"],
    ]],
  ];
  for (const [label, question, ids, answers] of cases) {
    describe(label, () => {
      for (const [answer, expected] of answers) {
        it(`${expected}: ${answer}`, () => {
          expect(verdict(question, ids.map(note), answer)).toBe(expected);
        });
      }
    });
  }

  it("records sentence-level provenance for what it accepted", () => {
    const { built } = pipeline("How much did the car service cost?", [note("car")]);
    const check = validateRelationships({ answer: "It cost $480.", question: "How much did the car service cost?", evidence: built.evidence, now: NOW, eventEvidence: null });
    expect(check.support).toEqual([{ statement: "It cost $480.", value: "$480", noteId: "car", noteIndex: 0, sentenceIndex: 0 }]);
  });
});

describe("safeguards", () => {
  it("1. a recommendation about his brother does not support the recommender moving", () => {
    const eli = custom("eli2", "Eli recommended that his brother Elias move to Perth.");
    expect(verdict("Is Eli moving to Perth?", [eli], "Eli is moving to Perth.")).toBe("reject");
    expect(verdict("Is Eli moving to Perth?", [eli], "Eli recommended that his brother Elias move to Perth.")).toBe("accept");
  });

  it("2. 'the notes don't mention the plumber's charge' is accepted when the evidence lacks it", () => {
    expect(verdict("How much did the plumber charge?", [note("car")], "The notes don't mention the plumber's charge.")).toBe("accept");
  });

  it("2b. …but a decline is rejected when the evidence does hold the asked value", () => {
    expect(verdict("How much did the car service cost?", [note("car")], "Your notes don't mention what the car service cost.")).toBe("reject");
  });

  it("3. 'the plumber didn't charge anything' is never inferred from a missing amount", () => {
    expect(verdict("How much did the plumber charge?", [note("car")], "The plumber didn't charge anything.")).toBe("reject");
  });

  it("3b. a negative claim the note itself makes is accepted", () => {
    expect(verdict("Did we have a plunge pool last year?", [note("hot")], "You didn't have a plunge pool last year.")).toBe("accept");
  });

  it("4. an amount next to two events in one sentence binds only to its own event", () => {
    const both = custom("both", "Fixed the kitchen sink and paid $300 for the car service.");
    expect(verdict("How much did the sink repair cost?", [both], "The sink repair cost $300.")).toBe("reject");
    expect(verdict("How much did the car service cost?", [both], "The car service cost $300.")).toBe("accept");
  });

  it("5. a wrong generated date is rejected, never replaced by the correct one", () => {
    const question = "How was the weather in 2024?";
    const { target, built, memories, eventEvidence } = pipeline(question, [note("hot")]);
    const raw = "It was a very hot day on Wednesday, October 15 2024, perhaps 40 degrees plus.";
    const result = finalizeAnswer({ raw, notesIncluded: 1, contextText: built.contextText, question, memories, evidence: built.evidence, target, now: NOW, eventEvidence });
    expect(result).toMatchObject({ text: UNVERIFIED_ANSWER_MESSAGE, outcome: "date-rejected" });
    expect(result.text).not.toContain("2025");
  });
});

describe("number words and currency", () => {
  it("matches number words to digits, both ways", () => {
    expect(verdict("How hot was it?", [note("hot")], "It was forty degrees plus.")).toBe("accept");
    expect(verdict("How hot was it?", [note("hot")], "It was fifty degrees.")).toBe("reject");
    const words = custom("words", "The plumber charged two hundred and fifty dollars for the leak.");
    expect(verdict("How much did the plumber charge?", [words], "The plumber charged $250.")).toBe("accept");
  });

  it("reads written amounts and refuses a different currency", () => {
    expect(verdict("How much did the car service cost?", [note("car")], "The car service came to four hundred and eighty dollars.")).toBe("accept");
    expect(verdict("How much did the car service cost?", [note("car")], "The car service came to €480.")).toBe("reject");
    expect(verdict("How much did the car service cost?", [note("car")], "The car service came to 480 AUD.")).toBe("accept");
  });

  it("keeps a house number after 'at' (chrono reads 'at 14' as a time) but masks real clock times", () => {
    expect(verdict("Where does Priya live?", [note("priya")], "Priya's new address is 14 Elm Street, Carlton.")).toBe("accept");
    expect(verdict("Where does Priya live?", [note("priya")], "Priya's new address is 41 Elm Street, Carlton.")).toBe("reject");
    expect(verdict("When is the dentist appointment?", [note("dentist")], "Your dentist appointment moved to Thursday at 3pm.")).toBe("accept");
  });

  it("does not read a lone 'one' or 'a' as a number", () => {
    expect(verdict("What did Sam make?", [note("market")], "Sam made a peach crumble, one for dessert.")).toBe("accept");
  });
});

describe("verification questions", () => {
  const question = "Did I celebrate Varun's birthday yesterday?";

  it("a bare Yes against a recorded different date or no record is rejected", () => {
    expect(checkVerificationAnswer("Yes.", { kind: "different-date", eventDates: [day("2026-09-30")] })).not.toBeNull();
    expect(checkVerificationAnswer("Yes, you did.", { kind: "none", eventDates: [] })).not.toBeNull();
    expect(checkVerificationAnswer("Yes, you did.", { kind: "on-queried-date", eventDates: [day("2026-10-01")] })).toBeNull();
  });

  it("T8: an answer that already gives the event date gets only the missing contrast", () => {
    const { target, built, memories, eventEvidence } = pipeline(question, [note("varunBday"), note("market")]);
    const raw = "You celebrated Varun's 40th birthday at Bella Napoli on Wednesday, September 30, 2026.";
    const result = finalizeAnswer({ raw, notesIncluded: 2, contextText: built.contextText, question, memories, evidence: built.evidence, target, now: NOW, eventEvidence });
    expect(result.outcome).toBe("shown");
    expect(result.text).toBe(`${raw} That was the day before yesterday, not yesterday.`);
  });

  const queried = () => describeQueriedDate(question, NOW, resolveQueryTemporalTarget(question, NOW));
  const varunEvidence = { kind: "different-date" as const, eventDates: [day("2026-09-30")] };

  it("an answer with neither date gets the full clarification", () => {
    expect(verificationAddendum("You celebrated Varun's birthday at Bella Napoli.", varunEvidence, queried(), NOW)).toBe(
      "Your notes date this to Wednesday, September 30 2026, not Thursday, October 1 2026 (yesterday)."
    );
  });

  it("an answer with only the queried date gets only the event date", () => {
    expect(verificationAddendum("You didn't celebrate Varun's birthday yesterday.", varunEvidence, queried(), NOW)).toBe(
      "Your notes date it to Wednesday, September 30 2026."
    );
  });

  it("adds nothing when both dates and their relationship are already there", () => {
    expect(verificationAddendum("You celebrated it on September 30, not yesterday.", varunEvidence, queried(), NOW)).toBeNull();
    expect(verificationAddendum("You celebrated it the day before yesterday, on Wednesday, September 30.", varunEvidence, queried(), NOW)).toBeNull();
  });

  it("never claims nothing else happened on the queried day", () => {
    for (const answer of ["You celebrated Varun's birthday.", "You celebrated it on Wednesday, September 30, 2026.", "Not yesterday."]) {
      const added = verificationAddendum(answer, varunEvidence, queried(), NOW) ?? "";
      expect(added).not.toMatch(/(?:nothing|no other|didn't|did not|only)/i);
    }
  });

  it("adds nothing when the event dates disagree", () => {
    const queried = describeQueriedDate(question, NOW, resolveQueryTemporalTarget(question, NOW));
    const evidence = { kind: "different-date" as const, eventDates: [day("2026-09-30"), day("2026-09-29")] };
    expect(verificationAddendum("You celebrated Varun's birthday at Bella Napoli.", evidence, queried, NOW)).toBeNull();
  });
});

describe("affirmative answers to yes/no questions", () => {
  /** finalizeAnswer outcome for a question answered from the given notes. */
  function outcome(question: string, notes: VaultNote[], raw: string) {
    const { target, built, memories, eventEvidence } = pipeline(question, notes);
    return finalizeAnswer({ raw, notesIncluded: notes.length, contextText: built.contextText, question, memories, evidence: built.evidence, target, now: NOW, eventEvidence });
  }

  it("F10: a Yes confirming Eli is moving is rejected — not turned into a No", () => {
    const result = outcome("Is Eli moving to Perth?", [note("eli")], "Yes, Eli's brother Elias is moving to Perth.");
    expect(result).toMatchObject({ text: UNVERIFIED_ANSWER_MESSAGE, outcome: "verification-contradicted" });
  });

  it("the same Yes is rejected when the evidence names Eli as the brother's owner", () => {
    const eli = custom("eli3", "Eli's brother Elias is moving to Perth.");
    expect(outcome("Is Eli moving to Perth?", [eli], "Yes, Eli's brother Elias is moving to Perth.").outcome).toBe("verification-contradicted");
  });

  it("a correct Yes is shown", () => {
    expect(outcome("Is Elias moving to Perth?", [note("eli")], "Yes, Elias is moving to Perth in January.").outcome).toBe("shown");
    expect(outcome("Did Sam make a peach crumble?", [note("market")], "Yes, Sam made a peach crumble for dessert.").outcome).toBe("shown");
    expect(outcome("Did we have a plunge pool?", [note("hot")], "Yes, you had a plunge pool to cool off.").outcome).toBe("shown");
  });

  it("genuinely negative evidence: a Yes is rejected, the matching No is shown", () => {
    const notMoving = custom("notMoving", "Eli is not moving to Perth after all.");
    expect(outcome("Is Eli moving to Perth?", [notMoving], "Yes, Eli is moving to Perth.").outcome).toBe("verification-contradicted");
    expect(outcome("Is Eli moving to Perth?", [notMoving], "No, Eli is not moving to Perth.").outcome).toBe("shown");
  });

  it("leaves comparison questions and non-Yes answers alone", () => {
    const evidence = pipeline("Was 2025 hotter than the previous year?", [note("hot")]).built.evidence;
    expect(checkAffirmativeAnswer({ answer: "Yes, 2025 was hotter.", question: "Was 2025 hotter than the previous year?", evidence, now: NOW, comparative: true })).toBeNull();
    expect(checkAffirmativeAnswer({ answer: "Eli's brother Elias is moving to Perth.", question: "Is Eli moving to Perth?", evidence, now: NOW, comparative: false })).toBeNull();
  });
});

describe("real-world notes (RC1 field reports, 8 Oct 2026)", () => {
  const local = (y: number, m: number, d: number, h: number, mi: number) => Math.floor(new Date(y, m - 1, d, h, mi).getTime() / 1000);
  // The complete stored notes, exactly as recorded.
  const THEO = custom(
    "theo",
    "Theo just came by to pick the vacuum. He is painting the fence so went to Penrith Hardware to pick a roller. On the way back, he stopped by",
    local(2026, 10, 7, 21, 32)
  );
  const MARCO = custom(
    "marco",
    "Marco was away for 3 weeks while he moved house. He moved from Kingsford to Mascot into a house that has a garden studio. " +
      "He has just approved a tenant for it, a young couple. He is sorting out their internet connection. He returned to work today. " +
      "Good to have him back. He keeps things calm at work.",
    local(2026, 10, 6, 13, 8)
  );
  const THEO_Q = "When did Theo pick the vaccum from me?";

  it.each([
    ["You gave the vaccum to Theo on Wednesday, October 7, 2026."],
    ["Theo came by to pick the vacuum on Wednesday, Oct 7, 2026."],
    ["Your note from 7 October says Theo had just come by to pick the vacuum."],
  ])("Theo: the recording-date answer is accepted — %s", (answer) => {
    expect(verdict(THEO_Q, [THEO], answer)).toBe("accept");
  });

  it("Theo: an answer stitching the Penrith Hardware trip onto the vacuum pickup is rejected", () => {
    expect(verdict(THEO_Q, [THEO], "Theo picked the vaccum from you on the way back from Penrith Hardware.")).toBe("reject");
  });

  it.each([
    ["Theo picked the garden studio from you on Wednesday, October 7, 2026."],
    ["Theo picked the garden studio from you on Oct 7."],
  ])("cross-note: Marco's garden studio never attaches to Theo's pickup — %s", (answer) => {
    expect(verdict(THEO_Q, [MARCO, THEO], answer)).toBe("reject");
  });

  it.each([
    ["What date did I speak to Marco about his garden studio?", "You spoke to Marco about his garden studio on Tuesday, October 6, 2026."],
    ["When did I last speak to Marco?", "You last spoke to Marco on Tuesday, October 6, 2026."],
  ])("Marco: recording information about him is not a conversation — %s", (question, answer) => {
    expect(verdict(question, [MARCO], answer)).toBe("reject");
  });

  it("an abbreviated month is a date, not an invented name", () => {
    const check = validateRelationships({ answer: "Theo came by to pick the vacuum on Wednesday, Oct 7, 2026.", question: THEO_Q, evidence: pipeline(THEO_Q, [THEO]).built.evidence, now: NOW, eventEvidence: null });
    expect(check.violations.map((v) => v.reason).join(" ")).not.toMatch(/oct/);
  });

  it("Related notes: only shown notes about the question, spelling variants included", () => {
    const shown = pipeline(THEO_Q, [MARCO, THEO]).built.evidence;
    expect(relatedEvidenceNotes(shown, THEO_Q, NOW)).toEqual([1]); // Theo's note, not Marco's
    expect(relatedEvidenceNotes(shown, "When did I last speak to Marco?", NOW)).toEqual([0]);
    expect(relatedEvidenceNotes(shown, "Where did I park the boat?", NOW)).toEqual([]);
  });

  it("spelling variants: one edit or swap between words of five or more letters", () => {
    expect(isSpellingVariant("vaccum", "vacuum")).toBe(true); // one substitution
    expect(isSpellingVariant("trialer", "trailer")).toBe(true); // one adjacent swap
    expect(isSpellingVariant("pick", "puck")).toBe(false);
    expect(isSpellingVariant("roller", "roll")).toBe(false);
  });
});

describe("asked relationship — the answer must answer what was asked", () => {
  const local = (y: number, m: number, d: number, h: number, mi: number) => Math.floor(new Date(y, m - 1, d, h, mi).getTime() / 1000);
  const THEO = custom(
    "theo",
    "Theo just came by to pick the vacuum. He is painting the fence so went to Penrith Hardware to pick a roller. On the way back, he stopped by",
    local(2026, 10, 7, 21, 32)
  );
  const MARCO = custom(
    "marco",
    "Marco was away for 3 weeks while he moved house. He moved from Kingsford to Mascot into a house that has a garden studio. " +
      "He has just approved a tenant for it, a young couple. He is sorting out their internet connection. He returned to work today. " +
      "Good to have him back. He keeps things calm at work.",
    local(2026, 10, 6, 13, 8)
  );
  const SPOKE = custom("spoke", "Spoke to Marco about his garden studio today. He wants to rent it out.", local(2026, 10, 3, 11, 15));
  const SPEAK = custom("speak", "I had a long speak with Marco at work about the garden studio.", local(2026, 10, 3, 11, 15));
  const STUDIO_ONLY = custom("studioOnly", "Marco's new house has a garden studio.", local(2026, 10, 6, 13, 8));

  it.each([
    ["When did I speak to Marco?", [MARCO], "You last spoke to Marco when he was away for 3 weeks."],
    ["When did I speak to Marco?", [MARCO], "You spoke to Marco on Tuesday, October 6, 2026."],
    ["When did I last speak to Marco?", [MARCO], "You last spoke to Marco when he was away for 3 weeks."],
    ["When did I speak to Marco about his garden studio?", [STUDIO_ONLY], "You spoke to Marco about his garden studio on Tuesday, October 6, 2026."],
  ])("information about Marco is not a conversation with him: %s → %s", (question, notes, answer) => {
    expect(verdict(question, notes, answer)).toBe("reject");
  });

  it.each([
    ["When did I speak to Marco?", [SPOKE], "You spoke to Marco about his garden studio on Saturday, October 3, 2026."],
    ["When did I speak to Marco?", [SPEAK], "You spoke with Marco at work on Saturday, October 3, 2026."],
  ])("a recorded conversation is accepted, irregular verb forms included: %s → %s", (question, notes, answer) => {
    expect(verdict(question, notes, answer)).toBe("accept");
  });

  it.each([["Theo picked the vacuum."], ["Theo picked up the vacuum from you."]])("'What did Theo pick from me?' → the vacuum: %s", (answer) => {
    expect(verdict("What did Theo pick from me?", [THEO], answer)).toBe("accept");
  });

  it.each([["Theo picked a roller."], ["Theo picked a roller from you."]])("'What did Theo pick from me?' is not the Penrith Hardware roller: %s", (answer) => {
    expect(verdict("What did Theo pick from me?", [THEO], answer)).toBe("reject");
  });

  it("'What did Theo pick at Penrith Hardware?' may be answered with the roller", () => {
    expect(verdict("What did Theo pick at Penrith Hardware?", [THEO], "A roller.")).toBe("accept");
  });

  it("a paraphrased question about someone else is not refused for its wording", () => {
    expect(verdict("Where does Marco live?", [MARCO], "Marco moved from Kingsford to Mascot.")).toBe("accept");
  });

  it("the irregular-verb table is grammar only — no synonyms", () => {
    // "chat" is not "speak": a "did I…" question worded differently from the
    // note is refused (fallback + Related notes), never answered by guessing.
    expect(verdict("When did I chat with Marco?", [SPOKE], "You spoke to Marco on Saturday, October 3, 2026.")).toBe("reject");
  });
});
