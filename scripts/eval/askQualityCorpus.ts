/**
 * Synthetic Ask-quality set: the question shapes from the 2.0 dogfood report
 * ("Who and when did I…", "Summarise notes related to X's…", "Has X been
 * having issues lately?") plus the cases that must stay protected (partial,
 * unsupported, conflicting, similar names, temporal, same-note combination).
 *
 * Every note is invented. No real diary text — the structures, not the
 * content, reproduce what failed.
 *
 * "Now" for every question is Thursday 22 October 2026, 19:00 local time.
 * Non-temporal questions use a fixed retrieved set (`evidence`, standing in
 * for hybrid search, top 3); temporal questions retrieve over the whole vault
 * through the production ranking.
 */

export const NOW = new Date(2026, 9, 22, 19, 0);

const at = (y: number, m: number, d: number, h = 12, min = 0) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

export type VaultNote = { id: string; createdAt: number; content: string };

export const VAULT: VaultNote[] = [
  // Queenstown ski trip — the place, the people and the date sit in DIFFERENT sentences.
  { id: "qtBook", createdAt: at(2026, 6, 2, 20), content: "Booked the Queenstown ski trip for the second week of July. Dev and Anika are coming with me." },
  { id: "qtBack", createdAt: at(2026, 7, 14, 18), content: "Back from Queenstown. We skied Coronet Peak for three days and the snow was perfect. Dev hurt his wrist on the last run." },
  { id: "skiGloves", createdAt: at(2026, 5, 20, 9), content: "Need new ski gloves before winter, the old ones have holes." },
  // Ronnie's new home — several notes, each with individually supported facts.
  { id: "ronnieOffer", createdAt: at(2026, 8, 18, 19), content: "Ronnie's offer on the house in Brunswick was accepted. It has three bedrooms and a big backyard." },
  { id: "ronnieSettle", createdAt: at(2026, 9, 25, 17), content: "Ronnie got the keys to his new home today. The kitchen needs a full renovation." },
  { id: "ronnieWarming", createdAt: at(2026, 10, 10, 21), content: "Went to Ronnie's housewarming in Brunswick. He wants to repaint the hallway green." },
  // Ronnie's recent issues (inside the last few weeks) and an older one.
  { id: "ronnieBack", createdAt: at(2026, 10, 15, 20), content: "Ronnie has been struggling with back pain since the move. He's seeing a physio on Monday." },
  { id: "ronnieWork", createdAt: at(2026, 10, 16, 18), content: "Ronnie said work has been stressful because his team lost two people." },
  { id: "ronnieOld", createdAt: at(2026, 3, 3, 12), content: "Ronnie's car broke down on the freeway, the alternator was gone." },
  // Similar name — a different person.
  { id: "ronan", createdAt: at(2026, 10, 12, 13), content: "Ronan bought a second-hand road bike for $650 and wants to ride to work." },
  // Conflicting notes about one date.
  { id: "moveA", createdAt: at(2026, 9, 1, 19), content: "Maya is moving to Sydney on 14 November." },
  { id: "moveB", createdAt: at(2026, 10, 5, 19), content: "Maya's move got pushed back, she now moves to Sydney on 28 November." },
  // Same-note combination trap: two sentences that must not be fused.
  { id: "fence", createdAt: at(2026, 10, 18, 17), content: "Kabir painted the back fence on Saturday. Later he dropped his phone in the car park at Bunnings." },
  // Companions in a NON-adjacent sentence about a different event.
  { id: "qtMum", createdAt: at(2026, 6, 3, 20), content: "Booked the Queenstown ski trip for July. Then visited Mum in Geelong. Priya and Sam came with me." },
  // Pronoun trap: another person's housewarming in the same suburb.
  { id: "priyaWarming", createdAt: at(2026, 10, 11, 21), content: "Went to Priya's housewarming in Brunswick. She wants to repaint the hallway green." },
  // Grampians — for a partial answer (who is known, the price is not).
  { id: "grampians", createdAt: at(2026, 9, 28, 20), content: "Hiked the Pinnacle in the Grampians with Leo and Sara. We stayed in a cabin near Halls Gap." },
];

/** Case-insensitive substring; "re:" prefix = regex. Every group must match one of its strings. */
export type Rubric = string[][];

export type AskQualityCase = {
  id: string;
  kind: "who-when" | "summary" | "recent-person" | "partial" | "unsupported" | "conflict" | "similar-name" | "temporal" | "same-note" | "simple";
  question: string;
  evidence?: string[];
  /** "answer": a useful, correct answer should be shown. "withhold": showing any answer would be wrong.
   * "safe": either is acceptable as long as nothing in mustNotInclude is shown. */
  expect: "answer" | "withhold" | "safe";
  mustInclude?: Rubric;
  /** Shown text containing any of these is a fabrication or misattribution. */
  mustNotInclude?: string[];
};

export const CASES: AskQualityCase[] = [
  {
    id: "Q1",
    kind: "who-when",
    question: "Who and when did I go to Queenstown skiing with?",
    evidence: ["qtBack", "qtBook", "skiGloves"],
    expect: "answer",
    mustInclude: [["Dev"], ["Anika"], ["July"]],
    mustNotInclude: ["Leo", "Sara", "Ronnie"],
  },
  {
    id: "Q1b",
    kind: "who-when",
    question: "Who did I go skiing with in Queenstown?",
    evidence: ["qtBook", "qtBack", "skiGloves"],
    expect: "answer",
    mustInclude: [["Dev"], ["Anika"]],
    mustNotInclude: ["Leo", "Sara"],
  },
  {
    id: "Q1c",
    kind: "who-when",
    question: "When did I go to Queenstown?",
    evidence: ["qtBack", "qtBook", "skiGloves"],
    expect: "answer",
    mustInclude: [["July"]],
    mustNotInclude: ["August", "June"],
  },
  {
    id: "Q2",
    kind: "summary",
    question: "Summarise notes related to Ronnie's new home",
    evidence: ["ronnieSettle", "ronnieOffer", "ronnieWarming"],
    expect: "answer",
    mustInclude: [["Brunswick", "keys", "kitchen", "bedroom", "backyard", "hallway"]],
    mustNotInclude: ["Ronan", "$650", "bike"],
  },
  {
    id: "Q2b",
    kind: "summary",
    question: "What do my notes say about Ronnie's new house?",
    evidence: ["ronnieOffer", "ronnieSettle", "ronnieWarming"],
    expect: "answer",
    mustInclude: [["Brunswick", "keys", "kitchen", "bedroom", "backyard", "hallway"]],
    mustNotInclude: ["Ronan", "bike"],
  },
  {
    id: "Q3",
    kind: "recent-person",
    question: "Has Ronnie been having issues lately?",
    evidence: ["ronnieBack", "ronnieWork", "ronnieOld"],
    expect: "answer",
    mustInclude: [["back", "physio", "work", "stress"]],
    mustNotInclude: ["Ronan", "bike"],
  },
  {
    id: "Q3b",
    kind: "recent-person",
    question: "What problems has Ronnie had recently?",
    evidence: ["ronnieBack", "ronnieWork", "ronnieOld"],
    expect: "answer",
    mustInclude: [["back", "physio", "work", "stress"]],
    mustNotInclude: ["Ronan", "bike"],
  },
  {
    id: "P1",
    kind: "partial",
    question: "Who did I go to the Grampians with and how much was the cabin?",
    evidence: ["grampians", "ronnieOffer", "fence"],
    expect: "answer",
    mustInclude: [["Leo"], ["Sara"]],
    mustNotInclude: ["re:\\$\\s?\\d", "re:\\d+ dollars"],
  },
  {
    id: "U1",
    kind: "unsupported",
    question: "When did I go to Paris with Ronnie?",
    evidence: ["ronnieWarming", "ronnieOffer", "ronnieSettle"],
    expect: "withhold",
    mustNotInclude: ["Paris"],
  },
  {
    id: "U2",
    kind: "unsupported",
    question: "Who did Ronnie go skiing with?",
    evidence: ["qtBack", "ronnieWarming", "qtBook"],
    expect: "withhold",
    mustNotInclude: ["Dev", "Anika"],
  },
  {
    id: "C1",
    kind: "conflict",
    question: "When is Maya moving to Sydney?",
    evidence: ["moveB", "moveA", "ronnieOffer"],
    expect: "answer",
    mustInclude: [["28"]],
    mustNotInclude: ["December", "October"],
  },
  {
    id: "N1",
    kind: "similar-name",
    question: "What did Ronan buy?",
    evidence: ["ronan", "ronnieOffer", "ronnieSettle"],
    expect: "answer",
    mustInclude: [["bike"]],
    mustNotInclude: ["house", "keys", "Brunswick"],
  },
  {
    id: "N2",
    kind: "similar-name",
    question: "Did Ronnie buy a road bike?",
    evidence: ["ronan", "ronnieOffer", "ronnieWarming"],
    expect: "safe",
    mustNotInclude: ["re:^\\s*yes", "re:Ronnie (has )?(bought|got|owns)"],
  },
  {
    id: "T1",
    kind: "temporal",
    question: "What did Ronnie say about work last week?",
    expect: "answer",
    mustInclude: [["stress", "team", "two people"]],
    mustNotInclude: ["Ronan", "alternator"],
  },
  {
    id: "S1",
    kind: "same-note",
    question: "What happened on Kabir's way back from painting the fence?",
    evidence: ["fence", "ronnieWarming", "grampians"],
    expect: "withhold",
    mustNotInclude: ["re:way back from painting"],
  },
  {
    id: "Q1d",
    kind: "who-when",
    question: "Who came with me to Queenstown?",
    evidence: ["qtBook", "qtBack", "skiGloves"],
    expect: "answer",
    mustInclude: [["Dev"], ["Anika"]],
    mustNotInclude: ["Priya", "Sam", "Leo"],
  },
  {
    id: "A1",
    kind: "same-note",
    question: "Who did I go skiing with in Queenstown?",
    evidence: ["qtMum", "skiGloves", "ronnieOffer"],
    expect: "withhold",
    mustNotInclude: ["Priya", "Sam"],
  },
  {
    id: "Q3c",
    kind: "recent-person",
    question: "Has Ronnie had car trouble lately?",
    evidence: ["ronnieOld", "ronnieOffer", "ronnieSettle"],
    expect: "withhold",
    mustNotInclude: ["alternator", "freeway", "re:^\\s*yes"],
  },
  {
    id: "Q3d",
    kind: "recent-person",
    question: "Has Ronnie moved into his new home?",
    evidence: ["ronnieSettle", "ronnieOffer", "ronnieWarming"],
    expect: "answer",
    mustInclude: [["keys", "housewarming", "Brunswick"]],
    mustNotInclude: ["Ronan"],
  },
  {
    id: "R1",
    kind: "summary",
    question: "Summarise notes related to Ronnie's new home",
    evidence: ["ronnieOffer", "priyaWarming", "ronnieSettle"],
    expect: "safe",
    mustNotInclude: ["re:(Ronnie|he)\\b[^.]*\\b(repaint|hallway|green)", "re:Ronnie's housewarming"],
  },
  {
    id: "S2",
    kind: "simple",
    question: "What did Kabir paint?",
    evidence: ["fence", "ronnieWarming", "grampians"],
    expect: "answer",
    mustInclude: [["fence"]],
    mustNotInclude: ["hallway"],
  },
];
