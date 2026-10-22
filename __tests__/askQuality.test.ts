import { buildNoteContext, finalizeAnswer } from "../services/ai/ragFormatting";
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
