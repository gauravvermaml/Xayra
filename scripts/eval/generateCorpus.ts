import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Generates the held-out half of the evaluation corpus.
 *
 * WHY GENERATE RATHER THAN HAND-WRITE. The 36 curated cases were the ones the
 * prompt was iterated against, so they are no longer an honest test of
 * anything — every fix today was made with them in view. This file produces
 * notes the prompt has never seen, from vocabulary and sentence shapes chosen
 * independently, so a score here measures generalization rather than recall.
 *
 * WHY THE ANSWER KEYS ARE COMPUTED HERE. Two curated cases shipped with WRONG
 * expected values earlier today — one demanded "registration" where the note
 * said "rego", another expected a single task where the prompt explicitly
 * instructs splitting. Both were scored as model failures until the raw output
 * was checked. Generating note and answer together from one template removes
 * that whole class of mistake: the expected task is not a guess about what the
 * model should say, it is the thing the note was built from.
 *
 * Dates are computed with plain Date arithmetic, deliberately NOT by calling
 * resolveDateAndTime. Using the system under test to produce its own answer
 * key would make every date case pass by construction.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** Fixed so the corpus is byte-stable across runs and across machines. */
const REFERENCE_DAY = "2026-09-20"; // a Sunday

type GeneratedCase = {
  id: string;
  category: string;
  kind?: "rag";
  today: string;
  note: string;
  query?: string;
  contexts?: Array<{ content: string; createdAt: number }>;
  expect: Record<string, unknown>;
};

function isoDate(base: string, plusDays: number): string {
  const [y, m, d] = base.split("-").map(Number);
  const date = new Date(y, m - 1, d + plusDays);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Days until the next occurrence of a weekday, never 0 (a bare weekday name
 * means the one coming, not today). */
function daysUntilWeekday(base: string, targetDow: number): number {
  const [y, m, d] = base.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  const delta = (targetDow - dow + 7) % 7;
  return delta === 0 ? 7 : delta;
}

const cases: GeneratedCase[] = [];
let counter = 0;
const nextId = (prefix: string) => `${prefix}-${String(++counter).padStart(3, "0")}`;

// ---------------------------------------------------------------------------
// (a) Unpunctuated STT transcripts with speech typos
// ---------------------------------------------------------------------------
// Lowercase, no terminal punctuation, filler words, and one plausible
// mishearing per note — the shape a real voice transcript actually takes.

const sttCases: Array<{ note: string; task: string; alts?: string[]; date?: number }> = [
  { note: "um remind me to book the vet for the dog on thursday", task: "Book the vet for the dog", date: daysUntilWeekday(REFERENCE_DAY, 4) },
  { note: "so yeah i need to cancel the gym membership before it renews", task: "Cancel the gym membership" },
  { note: "uh order the new filter for the coffee machine", task: "Order the new filter for the coffee machine" },
  { note: "i have to chase up the electrician about the quote", task: "Chase up the electrician about the quote" },
  { note: "remind me to take the recycling out tonight", task: "Take the recycling out" },
  { note: "okay so i should probably back up the laptop this weekend", task: "Back up the laptop" },
  { note: "need to reply to the email from the landlord", task: "Reply to the email from the landlord" },
  { note: "gotta pick up the prescription from the farmacy", task: "Pick up the prescription from the pharmacy", alts: ["Pick up the prescription from the farmacy", "Pick up the prescription"] },
  { note: "remind me to water the herb garden on the balcony", task: "Water the herb garden on the balcony" },
  { note: "um i need to return the libary books", task: "Return the library books", alts: ["Return the libary books"] },
  { note: "should call the insurence company about the claim", task: "Call the insurance company about the claim", alts: ["Call the insurence company about the claim"] },
  { note: "need to defrost the freezer sometime", task: "Defrost the freezer" },
  { note: "remind me to sharpen the kitchen knifes", task: "Sharpen the kitchen knives", alts: ["Sharpen the kitchen knifes"] },
  { note: "i must remember to post the birthday card tomorrow", task: "Post the birthday card", date: 1 },
  { note: "yeah so book the car in for a wheel alignment", task: "Book the car in for a wheel alignment" },
  { note: "remind me to cancel the subscribtion before friday", task: "Cancel the subscription", alts: ["Cancel the subscribtion"], date: daysUntilWeekday(REFERENCE_DAY, 5) },
  { note: "um need to buy a new charger for the labtop", task: "Buy a new charger for the laptop", alts: ["Buy a new charger for the labtop"] },
  { note: "should probably tidy the garrage this weekend", task: "Tidy the garage", alts: ["Tidy the garrage"] },
];

for (const { note, task, alts, date } of sttCases) {
  const expectTask: Record<string, unknown> = { task };
  if (alts) expectTask.alts = alts;
  if (date !== undefined) expectTask.actionDate = isoDate(REFERENCE_DAY, date);
  cases.push({
    id: nextId("gen-stt"),
    category: "stt-noise",
    today: REFERENCE_DAY,
    note,
    expect: { tasks: [expectTask], maxOutputTokens: 110 },
  });
}

// ---------------------------------------------------------------------------
// (b) Relative dates and month boundaries
// ---------------------------------------------------------------------------
// Reference dates are varied on purpose so month-end rollover is exercised
// rather than assumed.

const dateCases: Array<{ today: string; note: string; task: string; date: string }> = [
  { today: REFERENCE_DAY, note: "Submit the expense claim tomorrow.", task: "Submit the expense claim", date: isoDate(REFERENCE_DAY, 1) },
  { today: REFERENCE_DAY, note: "Collect the keys in 3 days.", task: "Collect the keys", date: isoDate(REFERENCE_DAY, 3) },
  { today: REFERENCE_DAY, note: "Ring the clinic in two weeks.", task: "Ring the clinic", date: isoDate(REFERENCE_DAY, 14) },
  { today: REFERENCE_DAY, note: "Email the report next Wednesday.", task: "Email the report", date: isoDate(REFERENCE_DAY, daysUntilWeekday(REFERENCE_DAY, 3)) },
  { today: REFERENCE_DAY, note: "Drop the suit at the tailor this Thursday.", task: "Drop the suit at the tailor", date: isoDate(REFERENCE_DAY, daysUntilWeekday(REFERENCE_DAY, 4)) },
  { today: "2026-09-29", note: "Pay the invoice on the 2nd.", task: "Pay the invoice", date: "2026-10-02" },
  { today: "2026-09-30", note: "Renew the parking permit tomorrow.", task: "Renew the parking permit", date: "2026-10-01" },
  { today: "2026-10-30", note: "Send the quarterly update in 3 days.", task: "Send the quarterly update", date: "2026-11-02" },
  { today: "2026-12-30", note: "Book the dentist in 5 days.", task: "Book the dentist", date: "2027-01-04" },
  { today: "2026-02-26", note: "File the paperwork in 3 days.", task: "File the paperwork", date: "2026-03-01" },
  { today: REFERENCE_DAY, note: "Confirm the booking on 15 October.", task: "Confirm the booking", date: "2026-10-15" },
  { today: REFERENCE_DAY, note: "Order the cake by 3 November.", task: "Order the cake", date: "2026-11-03" },
];

for (const { today, note, task, date } of dateCases) {
  cases.push({
    id: nextId("gen-date"),
    category: "date-resolution",
    today,
    note,
    expect: { tasks: [{ task, actionDate: date }], maxOutputTokens: 100 },
  });
}

// ---------------------------------------------------------------------------
// (c) Zero-task notes: observations, thoughts, third-party mentions
// ---------------------------------------------------------------------------
// The hardest category for this model size. Third-party items are kept
// separate from pure observations because they fail for different reasons —
// one invents a task from someone else's action, the other echoes the note.

const observations = [
  "The café on the corner has completely changed its menu.",
  "It rained most of the afternoon and then cleared up.",
  "That podcast episode on sleep was surprisingly good.",
  "The garden is finally starting to look established.",
  "Traffic was much lighter than usual this morning.",
  "The new bakery bread is better than the supermarket one.",
  "Slept badly last night for no obvious reason.",
  "The film was far too long but the soundtrack was great.",
  "Prices at the market seem higher than last month.",
  "The old bike is holding up better than expected.",
  "Felt a lot sharper after a proper night's sleep.",
  "The hallway paint looks different in the evening light.",
  "That was easily the best coffee I have had all month.",
];

for (const note of observations) {
  cases.push({
    id: nextId("gen-obs"),
    category: "refusal",
    today: REFERENCE_DAY,
    note,
    expect: { tasks: [], maxOutputTokens: 40 },
  });
}

const thirdParty = [
  "The plumber is coming Wednesday to look at the boiler.",
  "My sister is moving house at the end of the month.",
  "The cleaner comes every second Friday.",
  "A courier is delivering the parcel tomorrow afternoon.",
  "The neighbours are having their driveway resurfaced.",
  "The council is collecting green waste next week.",
  "My colleague is presenting at the conference in March.",
  "The gas company is reading the meter on Friday.",
];

for (const note of thirdParty) {
  cases.push({
    id: nextId("gen-third"),
    category: "third-party",
    today: REFERENCE_DAY,
    note,
    expect: { tasks: [], maxOutputTokens: 40 },
  });
}

// ---------------------------------------------------------------------------
// Multi-task notes
// ---------------------------------------------------------------------------

const multiCases: Array<{ note: string; tasks: string[] }> = [
  { note: "Wash the car, top up the screenwash, and check the tyre pressures.", tasks: ["Wash the car", "Top up the screenwash", "Check the tyre pressures"] },
  { note: "Call the bank about the fee and then update the direct debit.", tasks: ["Call the bank about the fee", "Update the direct debit"] },
  { note: "Print the tickets, pack the chargers, and set an alarm for six.", tasks: ["Print the tickets", "Pack the chargers", "Set an alarm for six"] },
  { note: "Water the plants and bring the washing in before it rains.", tasks: ["Water the plants", "Bring the washing in"] },
  { note: "Book the ferry, reserve the campsite, and download the maps.", tasks: ["Book the ferry", "Reserve the campsite", "Download the maps"] },
];

for (const { note, tasks } of multiCases) {
  cases.push({
    id: nextId("gen-multi"),
    category: "multi-task",
    today: REFERENCE_DAY,
    note,
    expect: { tasks: tasks.map((task) => ({ task })), maxOutputTokens: 170 },
  });
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

const recurrenceCases: Array<{ note: string; task: string; recurrence: string }> = [
  { note: "Take the vitamins every morning.", task: "Take the vitamins", recurrence: "daily" },
  { note: "Back up the photos every month.", task: "Back up the photos", recurrence: "monthly" },
  { note: "Clean the filter every Sunday.", task: "Clean the filter", recurrence: "weekly" },
  { note: "Check the smoke alarms every six months.", task: "Check the smoke alarms", recurrence: "monthly" },
  { note: "Service the boiler in November.", task: "Service the boiler", recurrence: "none" },
];

for (const { note, task, recurrence } of recurrenceCases) {
  cases.push({
    id: nextId("gen-recur"),
    category: "recurrence",
    today: REFERENCE_DAY,
    note,
    expect: { tasks: [{ task, recurrence }], maxOutputTokens: 90 },
  });
}

// ---------------------------------------------------------------------------
// (d) Multi-note RAG queries
// ---------------------------------------------------------------------------
// Each carries at least one distractor note, so retrieval noise is part of the
// test rather than an idealised single-note context.

const NOTE_TIME = 1789000000;

const ragCases: Array<{
  id: string;
  category: string;
  query: string;
  contexts: string[];
  mustContain?: string[];
  mustNotContain?: string[];
  expectRefusal?: boolean;
}> = [
  {
    id: "gen-rag-boiler",
    category: "rag-factual",
    query: "When is the boiler being serviced?",
    contexts: ["Boiler service is booked for 12 November.", "The bin collection moved to Thursdays."],
    mustContain: ["12 November"],
    mustNotContain: ["bin collection"],
  },
  {
    id: "gen-rag-allergy",
    category: "rag-grounding",
    query: "Is there anything I should remember about the dinner?",
    contexts: ["Dinner at the Thai place on Friday at 8.", "One of the guests cannot eat peanuts.", "The car needs a wheel alignment."],
    mustContain: ["peanut"],
    mustNotContain: ["wheel alignment"],
  },
  {
    id: "gen-rag-multi",
    category: "rag-factual",
    query: "What do I need for the trip?",
    contexts: ["For the trip: pack the hiking boots and the rain jacket.", "Ferry leaves at 7am on the 14th.", "The bakery opens at six."],
    mustContain: ["boots"],
    mustNotContain: ["bakery"],
  },
  {
    id: "gen-rag-absent",
    category: "rag-refusal",
    query: "What did I note about the mortgage rate?",
    contexts: ["Boiler service is booked for 12 November.", "Take the vitamins every morning."],
    expectRefusal: true,
    mustNotContain: ["mortgage rate is", "mortgage rate of"],
  },
  {
    id: "gen-rag-empty",
    category: "rag-refusal",
    query: "Where did I park the car on Tuesday?",
    contexts: [],
    expectRefusal: true,
    mustNotContain: ["you parked"],
  },
  {
    id: "gen-rag-distractor",
    category: "rag-grounding",
    query: "What time does the ferry leave?",
    contexts: ["Ferry leaves at 7am on the 14th.", "The train was delayed by twenty minutes.", "Dentist at 3pm on the 9th."],
    mustContain: ["7am"],
    mustNotContain: ["dentist", "train"],
  },
];

for (const rag of ragCases) {
  const expect: Record<string, unknown> = { tasks: [], maxOutputTokens: 200 };
  if (rag.mustContain) expect.mustContain = rag.mustContain;
  if (rag.mustNotContain) expect.mustNotContain = rag.mustNotContain;
  if (rag.expectRefusal) expect.expectRefusal = true;
  cases.push({
    id: rag.id,
    category: rag.category,
    kind: "rag",
    today: REFERENCE_DAY,
    note: "",
    query: rag.query,
    contexts: rag.contexts.map((content, i) => ({ content, createdAt: NOTE_TIME - i * 86400 })),
    expect,
  });
}

const outPath = join(here, "corpus-heldout.jsonl");
writeFileSync(outPath, cases.map((c) => JSON.stringify(c)).join("\n") + "\n", "utf8");

const byCategory = cases.reduce<Record<string, number>>((acc, c) => {
  acc[c.category] = (acc[c.category] ?? 0) + 1;
  return acc;
}, {});

console.log(`Wrote ${cases.length} held-out cases to ${outPath}`);
for (const key of Object.keys(byCategory).sort()) {
  console.log(`  ${key.padEnd(18)} ${byCategory[key]}`);
}
