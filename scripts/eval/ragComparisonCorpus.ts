/**
 * 50-question RAG comparison set over a small, realistic, dated vault.
 *
 * Temporal questions retrieve through the production path (question period →
 * event-date eligibility → context construction) over the whole vault; all
 * other questions use a fixed, realistic retrieved set (`evidence`) standing
 * in for hybrid search — so every model sees identical evidence. Rubrics are
 * scoring-only; nothing here is ever placed in a prompt.
 *
 * "Now" for every question is Friday 2 October 2026, 15:00 local time.
 */

export const NOW = new Date(2026, 9, 2, 15, 0);

const at = (y: number, m: number, d: number, h = 12, min = 0) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);

export type VaultNote = { id: string; createdAt: number; content: string };

export const VAULT: VaultNote[] = [
  {
    id: "hot",
    createdAt: at(2025, 10, 15, 12),
    content:
      "It was a very hot day today, perhaps 40 degrees plus. Quite unusual for this month. Last year same time it was so much better. " +
      "Glad we had a plunge pool to cool ourselves off, which we didn't have last year. We caught up with a bunch of friends, had a few beers " +
      "and called it a day. I am reading an interesting history book these days, it's called Why West Rules for Now.",
  },
  { id: "market", createdAt: at(2026, 10, 1, 18), content: "Today we went to the farmers market and bought a box of peaches. Sam made a peach crumble for dessert." },
  { id: "varunBday", createdAt: at(2026, 10, 1, 9), content: "Yesterday we celebrated Varun's 40th birthday at Bella Napoli. The tiramisu was amazing." },
  { id: "pottery", createdAt: at(2026, 9, 23, 19), content: "Started the new pottery class at the community centre tonight. I made a very wonky bowl." },
  { id: "swim", createdAt: at(2026, 9, 29, 7, 30), content: "Swam 20 laps at the aquatic centre this morning. Shoulder felt fine." },
  { id: "dentist", createdAt: at(2026, 9, 28, 10), content: "Dentist appointment moved to Thursday at 3pm." },
  { id: "knee", createdAt: at(2026, 9, 18, 16), content: "Dr Patel said my knee is just a mild sprain. Ice it twice a day for a week and no running for a fortnight." },
  { id: "priya", createdAt: at(2026, 8, 30, 20), content: "Priya moved into her new flat at 14 Elm Street, Carlton. Her cat Biscuit already loves the balcony." },
  { id: "wifi", createdAt: at(2026, 7, 4, 14), content: "Beach house wifi password is seagull42." },
  { id: "car", createdAt: at(2026, 9, 10, 17), content: "Car service at Ultra Tune came to $480. They replaced the front brake pads. Rego renewal is due on 30 November." },
  { id: "mumGift", createdAt: at(2026, 9, 5, 21), content: "Gift idea for Mum: a silk scarf from that little shop in Fitzroy." },
  { id: "eli", createdAt: at(2026, 9, 14, 13), content: "Eli recommended the book The Overstory. His brother Elias is moving to Perth in January." },
  { id: "plants", createdAt: at(2026, 8, 12, 9), content: "Water the fiddle leaf fig only once a week, it hates soggy soil." },
  { id: "varunJob", createdAt: at(2026, 9, 20, 18, 30), content: "Varun is starting a new job at Atlassian next month. He sounded really excited." },
  { id: "grampians", createdAt: at(2026, 10, 1, 21), content: "Next weekend we are driving to the Grampians for a hike. Need to book the cabin." },
  { id: "xmas", createdAt: at(2025, 12, 26, 10), content: "Yesterday we had Christmas lunch at Mum's place in Geelong. Way too much pavlova." },
  { id: "bday", createdAt: at(2026, 6, 14, 20), content: "Spent my birthday at the Daylesford hot springs. Perfect day, totally relaxed." },
  { id: "tokyoBook", createdAt: at(2026, 2, 10, 19), content: "Booked flights to Tokyo for the first week of April." },
  { id: "tokyoBack", createdAt: at(2026, 4, 12, 11), content: "Back from Tokyo. The cherry blossoms in Ueno Park were incredible." },
  { id: "walk", createdAt: at(2026, 10, 2, 8), content: "Went for a 5k walk along the river this morning. Saw a family of ducks." },
  { id: "ptInterview", createdAt: at(2026, 10, 2, 9), content: "Tomorrow I have the parent-teacher interview at 4pm with Ms Rossi." },
];

/** Case-insensitive substring; a string starting "re:" is a regex. Each inner
 * array is an any-of group; every group must be satisfied. */
export type Rubric = string[][];

export type RagComparisonCase = {
  id: string;
  category: "temporal" | "fact" | "multi" | "unanswerable";
  question: string;
  /** Fixed retrieved set for non-temporal questions. Ignored when the
   * question resolves to a period — production then retrieves temporally. */
  evidence?: string[];
  mustInclude?: Rubric;
  mustNotInclude?: string[];
  /** Temporal interpretation, scored separately from the facts. */
  periodMustInclude?: Rubric;
  periodMustNotInclude?: string[];
  expectRefusal?: boolean;
};

const HOT_IN_2024 = ["re:\\bhot\\b[^.]*\\b2024\\b", "re:\\b2024\\b[^.]*\\b(hot|40)\\b"];

export const CASES: RagComparisonCase[] = [
  // ---- The six temporal regression questions (exact seeded note) ----
  { id: "T1", category: "temporal", question: "How was the weather last year?", mustInclude: [["hot", "40"]], periodMustNotInclude: HOT_IN_2024 },
  { id: "T2", category: "temporal", question: "How was the weather in 2024?", mustInclude: [["better", "pleasant", "cooler", "milder", "nicer"]], periodMustNotInclude: HOT_IN_2024 },
  { id: "T3", category: "temporal", question: "How was the weather in 2025 compared with 2024?", mustInclude: [["hot", "40"], ["better", "pleasant", "cooler", "milder", "nicer"]], periodMustNotInclude: HOT_IN_2024 },
  { id: "T4", category: "temporal", question: "Was 2025 hotter than the previous year?", mustInclude: [["yes", "hotter", "hot"]], mustNotInclude: ["not hotter", "wasn't hotter", "was not hotter", "no,"], periodMustNotInclude: HOT_IN_2024 },
  { id: "T5", category: "temporal", question: "How was the weather two years ago?", mustInclude: [["better", "pleasant", "cooler", "milder", "nicer"]], periodMustNotInclude: HOT_IN_2024 },
  { id: "T6", category: "temporal", question: "What happened in 2025?", mustInclude: [["hot", "40"]], periodMustNotInclude: HOT_IN_2024 },
  // ---- Other temporal questions ----
  { id: "T7", category: "temporal", question: "What did I do yesterday?", mustInclude: [["market", "peach"]], periodMustNotInclude: ["birthday"] },
  { id: "T8", category: "temporal", question: "Did I celebrate Varun's birthday yesterday?", mustInclude: [["bella napoli", "birthday", "varun"]], periodMustInclude: [["september 30", "30 september", "30th", "wednesday", "day before"]] },
  { id: "T9", category: "temporal", question: "What did I do last week?", mustInclude: [["pottery"]] },
  { id: "T10", category: "temporal", question: "What happened in September 2026?", mustInclude: [["scarf", "car service", "brake", "overstory", "480"]] },
  { id: "T11", category: "temporal", question: "What did I note on 15 October 2025?", mustInclude: [["hot", "40"]], periodMustNotInclude: HOT_IN_2024 },
  { id: "T12", category: "temporal", question: "What did I do in June?", mustInclude: [["daylesford", "hot springs", "birthday"]] },
  { id: "T13", category: "temporal", question: "What did I do earlier this year?", mustInclude: [["tokyo"]] },
  { id: "T14", category: "temporal", question: "What did I do this morning?", mustInclude: [["walk"]], periodMustNotInclude: ["parent-teacher", "interview"] },
  { id: "T15", category: "temporal", question: "What's on for tomorrow?", mustInclude: [["parent-teacher", "rossi", "interview"]] },
  { id: "T16", category: "temporal", question: "What did I plan for next weekend?", mustInclude: [["grampians"]] },
  { id: "T17", category: "temporal", question: "How many days ago did I start the pottery class?", evidence: ["pottery"], mustInclude: [["pottery"]], periodMustInclude: [["9 days", "nine days", "september 23", "23 september", "23rd"]] },
  // ---- Single facts (fixed evidence) ----
  { id: "F1", category: "fact", question: "What's the name of the history book I'm reading?", evidence: ["hot", "eli"], mustInclude: [["why west rules"]], mustNotInclude: ["overstory"] },
  { id: "F2", category: "fact", question: "What did the doctor say about my knee?", evidence: ["knee", "swim"], mustInclude: [["sprain"], ["ice"]] },
  { id: "F3", category: "fact", question: "What's Priya's new address?", evidence: ["priya"], mustInclude: [["14 elm street"]] },
  { id: "F4", category: "fact", question: "What's the wifi password at the beach house?", evidence: ["wifi"], mustInclude: [["seagull42"]] },
  { id: "F5", category: "fact", question: "How much did the car service cost?", evidence: ["car"], mustInclude: [["480"]] },
  { id: "F6", category: "fact", question: "What gift idea did I have for Mum?", evidence: ["mumGift", "xmas"], mustInclude: [["silk scarf", "scarf"]] },
  { id: "F7", category: "fact", question: "Which restaurant did we go to for Varun's birthday?", evidence: ["varunBday", "varunJob"], mustInclude: [["bella napoli"]] },
  { id: "F8", category: "fact", question: "What did Eli recommend?", evidence: ["eli"], mustInclude: [["overstory"]] },
  { id: "F9", category: "fact", question: "Where is Elias moving to?", evidence: ["eli"], mustInclude: [["perth"]] },
  { id: "F10", category: "fact", question: "Is Eli moving to Perth?", evidence: ["eli"], mustInclude: [["brother", "elias"]], mustNotInclude: ["eli is moving", "yes, eli"] },
  { id: "F11", category: "fact", question: "What time is my dentist appointment?", evidence: ["dentist"], mustInclude: [["3pm", "3 pm", "3:00"]] },
  { id: "F12", category: "fact", question: "How often should I water the fiddle leaf fig?", evidence: ["plants"], mustInclude: [["once a week", "weekly"]] },
  { id: "F13", category: "fact", question: "What's Priya's cat called?", evidence: ["priya"], mustInclude: [["biscuit"]] },
  { id: "F14", category: "fact", question: "Where was I last Christmas?", evidence: ["xmas", "mumGift"], mustInclude: [["geelong"]] },
  { id: "F15", category: "fact", question: "What did I do on my birthday?", evidence: ["bday"], mustInclude: [["daylesford", "hot springs"]] },
  { id: "F16", category: "fact", question: "When did I go to Tokyo?", evidence: ["tokyoBook", "tokyoBack"], mustInclude: [["april"]] },
  { id: "F17", category: "fact", question: "Where did I see the cherry blossoms?", evidence: ["tokyoBack"], mustInclude: [["ueno"]] },
  { id: "F18", category: "fact", question: "Where is Varun starting his new job?", evidence: ["varunJob", "varunBday"], mustInclude: [["atlassian"]] },
  { id: "F19", category: "fact", question: "What did I do with my friends on the hot day?", evidence: ["hot"], mustInclude: [["beer"]] },
  { id: "F20", category: "fact", question: "How hot did it get on the hot day?", evidence: ["hot"], mustInclude: [["40"]] },
  { id: "F21", category: "fact", question: "When is my rego due?", evidence: ["car"], mustInclude: [["30 november", "november 30", "30th of november", "november 30th"]] },
  { id: "F22", category: "fact", question: "Who is the parent-teacher interview with?", evidence: ["ptInterview"], mustInclude: [["rossi"]] },
  // ---- Multi-note summaries (fixed evidence) ----
  { id: "M1", category: "multi", question: "What exercise have I been doing?", evidence: ["swim", "walk", "knee"], mustInclude: [["swam", "swim", "laps"], ["walk"]] },
  { id: "M2", category: "multi", question: "What do I know about Varun?", evidence: ["varunBday", "varunJob"], mustInclude: [["bella napoli", "birthday"], ["atlassian"]] },
  { id: "M3", category: "multi", question: "What do I know about Priya?", evidence: ["priya"], mustInclude: [["elm street"], ["biscuit"]] },
  { id: "M4", category: "multi", question: "What car things have I noted?", evidence: ["car"], mustInclude: [["480"], ["brake"], ["november"]] },
  // ---- Unanswerable from the retrieved notes (should decline, not invent) ----
  { id: "U1", category: "unanswerable", question: "What's my passport number?", evidence: ["wifi"], expectRefusal: true },
  { id: "U2", category: "unanswerable", question: "What did the vet say about Biscuit?", evidence: ["priya"], expectRefusal: true },
  { id: "U3", category: "unanswerable", question: "How much did the plumber charge?", evidence: ["car"], expectRefusal: true, mustNotInclude: ["480"] },
  { id: "U4", category: "unanswerable", question: "When is Varun's wedding?", evidence: ["varunBday", "varunJob"], expectRefusal: true },
  { id: "U5", category: "unanswerable", question: "Did Dr Patel prescribe painkillers?", evidence: ["knee"], expectRefusal: true, mustNotInclude: ["yes"] },
  { id: "U6", category: "unanswerable", question: "What is Elias's job?", evidence: ["eli"], expectRefusal: true },
  { id: "U7", category: "unanswerable", question: "Which hotel did I stay at in Tokyo?", evidence: ["tokyoBook", "tokyoBack"], expectRefusal: true },
];
