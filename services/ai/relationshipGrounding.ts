/**
 * Relationship-aware answer grounding — the post-generation check that each
 * statement in a generated answer is supported by ONE sentence of the
 * evidence the model was actually shown, not merely by words scattered across
 * it.
 *
 * The word-overlap check (`isAnswerGroundedInContext`) passes "The plumber
 * charged $480" when the context holds "Car service at Ultra Tune came to
 * $480": every word but "plumber" is there somewhere. This module binds each
 * value — an amount, a number, a name, a date — to the statement it appears
 * in, and requires a single evidence sentence that holds the value AND shares
 * the statement's other terms. Conservative by design (v1): a correct answer
 * that synthesizes across two sentences is rejected rather than risk passing
 * a misattribution.
 *
 * Pure and deterministic. Never rewrites an answer; the only text it produces
 * is `verificationAddendum`, a fixed sentence about what the notes record.
 */

import {
  describePeriod,
  PRECISION_RANK,
  questionTerms,
  relatePeriods,
  resolveTemporalExpressions,
  splitIntoClauses,
  stem,
  type EventEvidence,
  type Period,
  type TemporalAnchor,
} from "./temporalResolver";

/** One sentence of a note exactly as the model saw it, with provenance. */
export type EvidenceSentence = {
  /** The note's id, when the caller has one (rag.ts always does). */
  noteId: string | null;
  /** Position of the note in the list passed to buildNoteContext. */
  noteIndex: number;
  /** Index into that note's `ResolvedMemory.sentences`. */
  sentenceIndex: number;
  createdAt: number;
  /** The kept clauses, rendered exactly as they appear in the context. */
  text: string;
  /** Each kept clause's resolved periods — explicit (a written time
   * expression) or the recording-day default. */
  dates: { period: Period; explicit: boolean }[];
};

export type SupportLink = {
  statement: string;
  value: string;
  noteId: string | null;
  noteIndex: number;
  sentenceIndex: number;
};

export type RelationshipViolation = { statement: string; reason: string };

export type RelationshipCheck = {
  ok: boolean;
  violations: RelationshipViolation[];
  /** Which evidence sentence supported each checked value (diagnostics). */
  support: SupportLink[];
};

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

const FUNCTION_WORDS = new Set(
  ("a an and are as at be been but by can could did do does for from had has have he her his i if in into is it its me my of on or our she so than " +
    "that the their them then there these they this to too was we were what when where which who whom why will with would you your about any all am " +
    "not no yes also just very really quite some more much").split(" ")
);
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const CALENDAR_WORDS = new Set([...MONTHS, ...WEEKDAYS]);
/** Month/weekday abbreviations ("Oct 7", "Tue") are dates, never names. */
const CALENDAR_ABBREVIATIONS = new Set([
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
]);

/** One edit — including one swapped adjacent pair — between two words of
 * five or more letters: the spelling variants speech-to-text produces for
 * one word ("vaccum" in a spoken question, "vacuum" in the note). The same
 * tolerance extraction's task-anchoring check already gives transcripts. */
export function isSpellingVariant(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length] <= 1;
}

/** `term` is in `terms`, allowing speech-to-text spelling variants. */
export const hasTerm = (terms: string[], term: string) => terms.some((t) => isSpellingVariant(t, term));
/** Subject pronouns end an agent search: the agent is then unknown, not a
 * different name. Possessive determiners ("his brother Elias") are skipped. */
const SUBJECT_PRONOUNS = new Set(["i", "you", "we", "he", "she", "they", "it"]);
const POSSESSIVE_DETERMINERS = new Set(["my", "your", "his", "her", "our", "their", "its"]);
/** How many words back from a predicate its agent may sit ("Eli is moving",
 * "Elias, Eli's brother, is moving"). */
const AGENT_WINDOW = 4;

const wordsOf = (t: string) => t.match(/[A-Za-z][A-Za-z'’]*/g) ?? [];
const contentTerms = (t: string) => [
  ...new Set(
    wordsOf(t)
      .map((w) => w.toLowerCase())
      .filter((w) => w.length >= 3 && !FUNCTION_WORDS.has(w.replace(/['’]s$/, "")))
      .map(stem)
  ),
];
const calendarLiterals = (t: string) => wordsOf(t).map((w) => w.toLowerCase()).filter((w) => CALENDAR_WORDS.has(w));

// ---------------------------------------------------------------------------
// Numbers and currency — a small grammar, not a dictionary.
// ---------------------------------------------------------------------------

const SMALL_NUMBERS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const NUMBER_WORD = `(?:${Object.keys(SMALL_NUMBERS).join("|")}|hundred|thousand)`;
/** "forty", "twenty-one", "a hundred", "two hundred and fifty". "and" only
 * after a scale word, so "two and three" stays two numbers. */
const NUMBER_WORD_RUN = new RegExp(`\\b(?:a|${NUMBER_WORD})(?:(?:-|\\s+|(?<=hundred|thousand)\\s+and\\s+)${NUMBER_WORD})*\\b`, "gi");

function numberWordValue(run: string): number | null {
  const parts = run.toLowerCase().split(/[\s-]+/).filter((w) => w !== "and");
  // A lone "one" or "a" is almost always a pronoun or article, not a claim.
  if (parts.length === 1 && (parts[0] === "one" || parts[0] === "a")) return null;
  if (parts[0] === "a" && parts[1] !== "hundred" && parts[1] !== "thousand") return null;
  let total = 0;
  let current = 0;
  for (const p of parts) {
    if (p === "a") current = 1;
    else if (p === "hundred") current = (current || 1) * 100;
    else if (p === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else current += SMALL_NUMBERS[p];
  }
  return total + current;
}

/** Number words rewritten as digits — done BEFORE any splitting, so "two
 * hundred and fifty" is never cut at its "and". */
function normalizeNumberWords(text: string): string {
  return text.replace(NUMBER_WORD_RUN, (run) => {
    const value = numberWordValue(run);
    return value === null ? run : String(value);
  });
}

type Currency = "dollar" | "euro" | "pound";
type Amount = { value: number; currency: Currency | null };

function currencyOf(token: string): Currency {
  const t = token.toLowerCase();
  if (t === "€" || t.startsWith("eur")) return "euro";
  if (t === "£" || t === "gbp" || t.startsWith("pound")) return "pound";
  return "dollar";
}

const DIGITS = String.raw`(\d[\d,]*(?:\.\d+)?)`;
const AMOUNT = new RegExp(
  String.raw`(?:\b(AUD|USD|EUR|GBP)\s?|(A\$|US\$|[$€£])\s?)${DIGITS}|${DIGITS}\s?(dollars?|bucks|euros?|pounds?|AUD|USD|EUR|GBP)\b`,
  "gi"
);
/** Years are dates, not numbers. */
const NUMBER = /\b(?!(?:19|20)\d{2}\b)(\d+(?:\.\d+)?)(?:k|st|nd|rd|th)?\b/gi;
const YEAR = /\b((?:19|20)\d{2})\b/g;
const CLOCK_TIME = /\d\s*(?:am|pm|a\.m\.|p\.m\.)|\d:\d{2}|o['’]?clock|noon|midnight/i;
const toNumber = (s: string) => Number(s.replace(/,/g, ""));

function blank(text: string, spans: { index: number; length: number }[]): string {
  return spans.reduce((s, e) => s.slice(0, e.index) + " ".repeat(e.length) + s.slice(e.index + e.length), text);
}

/** Amounts and plain numbers in `text` (number words already normalized),
 * with its time expressions (dates and clock times — "September 30", "3pm")
 * masked out first. */
function valuesOf(text: string, anchor: TemporalAnchor): { amounts: Amount[]; numbers: number[] } {
  const { references, times } = resolveTemporalExpressions(text, anchor);
  // Only unmistakable clock times are masked: chrono also reads the "at 14"
  // of "at 14 Elm Street" as 2pm, which would hide a real house number.
  const clockTimes = times.filter((t) => CLOCK_TIME.test(t.text));
  const masked = blank(text, [...references, ...clockTimes].map((r) => ({ index: r.index, length: r.text.length })));
  const amounts: Amount[] = [];
  const withoutAmounts = masked.replace(AMOUNT, (match, code, symbol, prefixed, suffixed, word) => {
    amounts.push({ value: toNumber(prefixed ?? suffixed), currency: currencyOf(code ?? symbol ?? word) });
    return " ".repeat(match.length);
  });
  return { amounts, numbers: [...withoutAmounts.matchAll(NUMBER)].map((m) => Number(m[1])) };
}

const sameAmount = (a: Amount, b: Amount) => a.value === b.value && (a.currency === null || b.currency === null || a.currency === b.currency);

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Names: capitalized words seen somewhere NOT sentence-initially, minus
 * function and calendar words ("The Overstory" is not a name "the"). */
export function buildNameLexicon(...texts: string[]): Set<string> {
  const lexicon = new Set<string>();
  for (const t of texts) {
    for (const m of t.matchAll(/(?<![.!?:•]\s|^)(?<!^\s*)\b([A-Z][a-z]+)/gm)) {
      const w = m[1].toLowerCase();
      if (w !== "i" && w !== "now" && !CALENDAR_WORDS.has(w) && !CALENDAR_ABBREVIATIONS.has(w) && !FUNCTION_WORDS.has(w)) lexicon.add(w);
    }
  }
  return lexicon;
}

type Token = { word: string; stem: string; name: string | null; possessive: boolean };

function tokensOf(text: string, lexicon: Set<string>): Token[] {
  return wordsOf(text).map((raw) => {
    const possessive = /['’]s$/.test(raw);
    const word = raw.toLowerCase().replace(/['’]s$/, "");
    return { word, stem: stem(raw), name: lexicon.has(word) ? word : null, possessive };
  });
}

type NameMention = { name: string; possessive: boolean };
const namesOf = (tokens: Token[]): NameMention[] =>
  tokens.flatMap((t) => (t.name ? [{ name: t.name, possessive: t.possessive }] : []));

/** The agent of `predicate` in `tokens`: the nearest non-possessive name
 * within AGENT_WINDOW words before it. Null when none, or when a subject
 * pronoun comes first — the agent is then unknown, never a mismatch. */
function agentOf(tokens: Token[], predicate: string): string | null {
  const at = tokens.findIndex((t) => t.stem === predicate && !t.name);
  if (at === -1) return null;
  for (let i = at - 1; i >= Math.max(0, at - AGENT_WINDOW); i--) {
    const t = tokens[i];
    if (SUBJECT_PRONOUNS.has(t.word)) return null;
    if (t.name && !t.possessive) return t.name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** A conjunction-split part of a sentence: an amount or number binds to the
 * event its own part describes, not to every event the sentence mentions. */
const SEGMENT_BREAK = /;\s*|,?\s+(?:and|but|while|whereas|then)\s+/i;

type Segment = { terms: string[]; amounts: Amount[]; numbers: number[] };

type ParsedSentence = {
  source: EvidenceSentence;
  terms: string[];
  tokens: Token[];
  names: string[];
  amounts: Amount[];
  numbers: number[];
  segments: Segment[];
  literals: string[];
  negated: boolean;
};

const NEGATION =
  /\b(?:not|no|never|nothing|none|nobody|cannot|(?:did|does|do|was|were|is|are|has|have|had|wo|ca|could|would|should)n['’]?t)\b/i;

function parseEvidence(sentence: EvidenceSentence, lexicon: Set<string>): ParsedSentence {
  const anchor: TemporalAnchor = { kind: "memoryCreatedAt", date: new Date(sentence.createdAt * 1000) };
  const segments = normalizeNumberWords(sentence.text)
    .split(SEGMENT_BREAK)
    .filter((s) => s.trim().length > 0)
    .map((s) => ({ terms: contentTerms(s), ...valuesOf(s, anchor) }));
  const tokens = tokensOf(sentence.text, lexicon);
  return {
    source: sentence,
    terms: contentTerms(sentence.text),
    tokens,
    names: namesOf(tokens).map((n) => n.name),
    amounts: segments.flatMap((s) => s.amounts),
    numbers: segments.flatMap((s) => s.numbers),
    segments,
    literals: calendarLiterals(sentence.text),
    negated: NEGATION.test(sentence.text),
  };
}

// ---------------------------------------------------------------------------
// Answer statements
// ---------------------------------------------------------------------------

/** The answer says the notes don't hold the asked-for information. */
const DECLINE =
  /\b(?:no information|couldn['’]?t find|could not find|no mention|not mentioned|not specified|isn['’]?t specified|not recorded|no record|no details|(?:don['’]?t|do not|doesn['’]?t|does not|didn['’]?t|did not) (?:have|mention|say|specify|provide|record|note|include))\b/i;
const LEADING_PARTICLE = /^\s*(?:yes|no)\b[\s,.:;!—–-]*/i;
/** "It was not this hot last year", "not as warm as" — a comparison, not a
 * claim that something didn't happen. */
const COMPARATIVE_NEGATION = /\bnot\s+(?:as|so|this|that|quite|very|too)\b|\bthan\b/i;
const RELATIVE_WORD = /\b(last|next|this|ago|yesterday|today|tomorrow|tonight|now)\b/i;

export type AnswerFact = {
  text: string;
  terms: string[];
  tokens: Token[];
  names: NameMention[];
  amounts: Amount[];
  numbers: number[];
  dates: Period[];
  literals: string[];
  decline: boolean;
  negated: boolean;
};

/**
 * Splits an answer into statements: clauses, then `;` and "and <word>"
 * joins. Bullets and "Label:" prefixes are stripped; an echoed question is
 * not a claim. A relative date word is validated only when it echoes the
 * question ("yesterday") — otherwise it may be the note's own wording ("this
 * month") and resolving it against today would be wrong. A bracketed
 * resolution copied from the context ("last year (2024)") wins over the
 * relative words before it.
 */
export function extractAnswerFacts(answer: string, question: string, now: Date, lexicon: Set<string>): AnswerFact[] {
  const cleaned = normalizeNumberWords(answer).replace(/^\s*[•\-*]\s*/gm, "").replace(/^\s*[A-Z][a-z]+:\s*/gm, "");
  const anchor: TemporalAnchor = { kind: "queryTime", date: now };
  return splitIntoClauses(cleaned)
    .flatMap((c) => c.text.split(/;\s*|\s+and\s+(?=[a-z]+\b)/))
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.endsWith("?"))
    .map((text) => {
      const { references } = resolveTemporalExpressions(text, anchor);
      const dates = references.flatMap((r) => {
        if (r.resolution.status !== "resolved") return [];
        if (/^\s*\(/.test(text.slice(r.index + r.text.length))) return [];
        if (RELATIVE_WORD.test(r.text) && !question.toLowerCase().includes(r.text.toLowerCase())) return [];
        return [r.resolution.period];
      });
      for (const m of text.matchAll(YEAR)) {
        const index = m.index ?? 0;
        if (!references.some((r) => index >= r.index && index < r.index + r.text.length)) {
          dates.push({ start: `${m[1]}-01-01`, end: `${m[1]}-12-31`, precision: "year" });
        }
      }
      const tokens = tokensOf(text, lexicon);
      const decline = DECLINE.test(text);
      const claim = text.replace(LEADING_PARTICLE, "");
      return {
        text,
        terms: contentTerms(text),
        tokens,
        names: namesOf(tokens),
        ...valuesOf(text, anchor),
        dates,
        literals: calendarLiterals(text),
        decline,
        negated: !decline && NEGATION.test(claim) && !COMPARATIVE_NEGATION.test(claim),
      };
    });
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const rankOf = (p: Period) => PRECISION_RANK[p.precision];
const yearOf = (p: Period) => p.start.slice(0, 4);

/** The sentence establishes `d`: a date overlapping it at equal or coarser
 * precision, or — for a coarse claim chrono can only half-resolve ("in
 * April") — the calendar word itself in a sentence recorded or dated in the
 * same year. */
function dateSupported(d: Period, s: ParsedSentence): boolean {
  if (s.source.dates.some((e) => relatePeriods(d, e.period) !== "outside" && rankOf(d) >= rankOf(e.period))) return true;
  const recordedYear = String(new Date(s.source.createdAt * 1000).getFullYear());
  return (
    d.precision !== "day" &&
    (recordedYear === yearOf(d) || s.source.dates.some((e) => yearOf(e.period) === yearOf(d))) &&
    s.literals.some((l) => describePeriod(d).toLowerCase().includes(l))
  );
}

/** Written in the sentence, not just its recording-day default. */
function explicitDate(d: Period, s: ParsedSentence): boolean {
  return (
    s.source.dates.some((e) => e.explicit && relatePeriods(d, e.period) !== "outside") ||
    s.literals.some((l) => describePeriod(d).toLowerCase().includes(l))
  );
}

/** Value-type questions: the asked-for value must come from a sentence about
 * the question's subject. */
const ASKS: { pattern: RegExp; type: "number" | "date" | "name" }[] = [
  { pattern: /^\s*how\s+(?:much|many)\b/i, type: "number" },
  { pattern: /^\s*(?:when|what\s+(?:date|day|time)|which\s+(?:date|day|month|year))\b/i, type: "date" },
  { pattern: /^\s*(?:where|who|whom|whose|which)\b/i, type: "name" },
];

export function validateRelationships(input: {
  answer: string;
  question: string;
  evidence: EvidenceSentence[];
  now: Date;
  eventEvidence: EventEvidence | null;
}): RelationshipCheck {
  const { answer, question, evidence, now, eventEvidence } = input;
  const lexicon = buildNameLexicon(question, ...evidence.map((s) => s.text), answer);
  const sentences = evidence.map((s) => parseEvidence(s, lexicon));
  const facts = extractAnswerFacts(answer, question, now, lexicon);
  const focus = questionTerms(question, now).filter((f) => !FUNCTION_WORDS.has(f));
  const known = new Set([...sentences.flatMap((s) => s.names), ...namesOf(tokensOf(question, lexicon)).map((n) => n.name)]);
  const violations: RelationshipViolation[] = [];
  const support: SupportLink[] = [];
  const supporting = new Set<ParsedSentence>();
  // The sentences the CURRENT statement's values were anchored to.
  let anchors = new Set<ParsedSentence>();
  const link = (statement: string, value: string, s: ParsedSentence) => {
    supporting.add(s);
    anchors.add(s);
    support.push({ statement, value, noteId: s.source.noteId, noteIndex: s.source.noteIndex, sentenceIndex: s.source.sentenceIndex });
  };
  const ask = ASKS.find((a) => a.pattern.test(question));

  for (const fact of facts) {
    const reject = (reason: string) => violations.push({ statement: fact.text, reason });
    anchors = new Set<ParsedSentence>();

    if (fact.decline) {
      // A decline is accepted only when the evidence really lacks the asked
      // value: a sentence about the question's subject holding a value of the
      // asked type contradicts it.
      if (ask) {
        const holder = sentences.find(
          (s) =>
            focus.some((f) => s.terms.includes(f)) &&
            (ask.type === "number"
              ? s.amounts.length + s.numbers.length > 0
              : ask.type === "date"
                ? s.source.dates.some((d) => d.explicit)
                : s.names.some((n) => !focus.includes(stem(n))))
        );
        if (holder) reject(`says the notes lack this, but a note sentence about ${focus.join("/")} gives a ${ask.type}`);
      }
      continue;
    }

    // The question's own words count as part of every statement: "It cost
    // $480" answers "How much did the car service cost?" about the service.
    const statementTerms = [...fact.terms, ...focus, ...fact.literals];
    const shares = (terms: string[], literals: string[], self: string) =>
      statementTerms.some((t) => t !== self && (hasTerm(terms, t) || literals.includes(t)));
    const predicates = fact.terms.filter((t) => !fact.names.some((n) => stem(n.name) === t));
    // "Eli recommended that his brother Elias move to Perth" does not support
    // "Eli is moving to Perth": the shared predicate has a different agent.
    const agentConsistent = (s: ParsedSentence) =>
      predicates
        .filter((p) => hasTerm(s.terms, p))
        .every((p) => {
          const claimed = agentOf(fact.tokens, p);
          const recorded = agentOf(s.tokens, p);
          return claimed === null || recorded === null || claimed === recorded;
        });
    const binds = (s: ParsedSentence, self: string) => shares(s.terms, s.literals, self) && agentConsistent(s);

    for (const n of fact.names) {
      if (!known.has(n.name)) reject(`name "${n.name}" appears in no retrieved note`);
    }

    if (fact.negated) {
      // "The plumber didn't charge anything" is never inferred from a missing
      // amount: a negative claim needs a negative sentence — or, for a
      // verification question, notes that date the event to another day.
      const negative = sentences.find((s) => s.negated && binds(s, ""));
      if (negative) link(fact.text, "negation", negative);
      else if (eventEvidence?.kind !== "different-date") reject("states that something did not happen, but no note sentence says so");
    }

    const values: { label: string; self: string; holders: () => ParsedSentence[] }[] = [
      ...fact.amounts.map((a) => ({
        label: `${a.currency === "euro" ? "€" : a.currency === "pound" ? "£" : "$"}${a.value}`,
        self: String(a.value),
        holders: () =>
          sentences.filter(
            (s) =>
              agentConsistent(s) &&
              s.segments.some(
                (seg) => (seg.amounts.some((b) => sameAmount(a, b)) || seg.numbers.includes(a.value)) && shares(seg.terms, s.literals, String(a.value))
              )
          ),
      })),
      ...fact.numbers.map((x) => ({
        label: String(x),
        self: String(x),
        holders: () =>
          sentences.filter(
            (s) =>
              agentConsistent(s) &&
              s.segments.some((seg) => (seg.numbers.includes(x) || seg.amounts.some((b) => b.value === x)) && shares(seg.terms, s.literals, String(x)))
          ),
      })),
      ...fact.names
        .filter((n) => !n.possessive)
        .map((n) => ({ label: n.name, self: stem(n.name), holders: () => sentences.filter((s) => s.names.includes(n.name) && binds(s, stem(n.name))) })),
    ];
    for (const v of values) {
      const holders = v.holders();
      if (holders.length === 0) {
        reject(`"${v.label}" is not associated with the rest of this statement in any note sentence`);
        continue;
      }
      const dated = fact.dates.length === 0 ? holders : holders.filter((s) => fact.dates.every((d) => dateSupported(d, s)));
      if (dated.length === 0) {
        reject(`"${v.label}" belongs to a different date than ${fact.dates.map(describePeriod).join("/")}`);
        continue;
      }
      link(fact.text, v.label, dated[0]);
    }

    // A comparison ("2024 was better than 2025") binds two dates to each
    // other, not to shared wording: each only has to be established.
    const distinctDates = new Set(fact.dates.map(describePeriod)).size;
    for (const d of fact.dates) {
      if (distinctDates >= 2 && values.length === 0) {
        const holder = sentences.find((s) => dateSupported(d, s));
        if (holder) link(fact.text, describePeriod(d), holder);
        else reject(`${describePeriod(d)} is not established by any note`);
        continue;
      }
      const holders = sentences.filter((s) => dateSupported(d, s) && binds(s, ""));
      // A date that is only a note's recording day needs a shared predicate
      // word too — sharing a name or place is not enough.
      const ok = holders.find((s) => explicitDate(d, s) || predicates.some((p) => hasTerm(s.terms, p)));
      if (ok) link(fact.text, describePeriod(d), ok);
      else reject(`${describePeriod(d)} is not recorded as the date of this event (${holders.length ? "only a note's recording date" : "no sentence"})`);
    }

    // Note-level coverage: a statement anchored to a note by its values may
    // not take any other word the evidence holds from a DIFFERENT note —
    // "Theo picked the garden studio" anchors to Theo's note and borrows "garden
    // flat" from Marco's. Same-note combinations stay allowed (sentence
    // level rejected 9 correct answers that join neighbouring sentences).
    // Words found nowhere in the evidence are left to the other checks.
    // Possessive names are exempt, as everywhere here ("Eli's brother").
    if (anchors.size > 0) {
      const anchorNotes = new Set([...anchors].map((s) => s.source.noteIndex));
      for (const t of fact.terms) {
        if (CALENDAR_WORDS.has(t) || fact.names.some((n) => n.possessive && stem(n.name) === t)) continue;
        const holders = sentences.filter((s) => hasTerm(s.terms, t));
        if (holders.length > 0 && !holders.some((s) => anchorNotes.has(s.source.noteIndex))) {
          reject(`"${t}" comes from a different note than the rest of this statement`);
        }
      }
    }
  }

  violations.push(...checkAskedRelationship(question, answer, facts, sentences, focus, lexicon));

  // The asked-for value must come from a sentence about the question's
  // subject — unless the answer itself says the notes lack it.
  if (ask && supporting.size > 0 && focus.length > 0 && !facts.some((f) => f.decline)) {
    if (![...supporting].some((s) => focus.some((f) => hasTerm(s.terms, f)))) {
      violations.push({ statement: answer, reason: `the ${ask.type} given comes from a note sentence that is not about ${focus.join("/")}` });
    }
  }
  return { ok: violations.length === 0, violations, support };
}

// ---------------------------------------------------------------------------
// Asked relationship — does the evidence state what the question asks?
// ---------------------------------------------------------------------------

/**
 * English irregular past forms → base form. Grammatical normalization only,
 * so "Spoke to Marco" matches "speak" and "Sam made" matches "make" — a
 * closed list, like the number words. Never synonyms: "chat" is not
 * "speak", "visit" is not "meet".
 */
const IRREGULAR_VERB_BASE: Record<string, string> = Object.fromEntries(
  (
    "said:say made:make went:go gone:go saw:see seen:see spoke:speak spoken:speak met:meet bought:buy brought:bring " +
    "thought:think told:tell came:come got:get gave:give given:give took:take taken:take ate:eat eaten:eat drank:drink " +
    "swam:swim ran:run left:leave paid:pay sent:send found:find had:have did:do done:do wrote:write written:write " +
    "sold:sell kept:keep slept:sleep felt:feel taught:teach caught:catch flew:fly drove:drive driven:drive rode:ride " +
    "won:win lost:lose spent:spend built:build heard:hear held:hold stood:stand sat:sit began:begin broke:break " +
    "broken:break chose:choose forgot:forget grew:grow knew:know wore:wear woke:wake lent:lend"
  )
    .split(" ")
    .map((pair) => pair.split(":"))
);
const verbBase = (word: string) => stem(IRREGULAR_VERB_BASE[word] ?? word);

/** Question words that frame the question rather than name what it asks
 * about ("When did I LAST…", "What do I KNOW about…", "What DATE…"). */
const QUESTION_FRAME_TERMS = new Set(["last", "know", "rememb", "dat", "time"]);

/** "did I…", "have I…" — the question is about the user's own participation. */
const USER_IS_SUBJECT = /\b(?:did|do|have|was|am|had)\s+i\b/i;

/**
 * The answer must answer the relationship the question asks about, not a
 * different one the notes also record. Scoped — exactly as tested — to
 * questions that name a person (possessives like "Priya's" don't count):
 *
 *  - "Relationship sentences" are evidence sentences naming that person and
 *    containing the question's action/object words (spelling variants and
 *    irregular verb forms allowed).
 *  - A question about the user's OWN participation ("When did I speak to
 *    Marco?") needs ALL its action/object words in one such sentence; with
 *    none, nothing records what was asked and the answer is rejected —
 *    information ABOUT Marco is not a conversation WITH him. Other
 *    questions skip this rejection: "Where does Priya live?" is legitimately
 *    answered by "Priya moved into her new flat", a paraphrase no word check
 *    can tell from an unrecorded event.
 *  - When relationship sentences exist, every answer word the evidence
 *    holds must come from one of them: "What did Theo pick from me?" is
 *    answered by "Theo just came by to pick the vacuum", not by the roller
 *    he picked at Penrith Hardware.
 *
 * Applying this to every question rejected 14 correct answers in the
 * 132-answer sweep (weather, knee, car); in this scope it rejects none.
 */
function checkAskedRelationship(
  question: string,
  answer: string,
  facts: AnswerFact[],
  sentences: ParsedSentence[],
  focus: string[],
  lexicon: Set<string>
): RelationshipViolation[] {
  const statements = facts.filter((f) => !f.decline);
  const asked = tokensOf(question, lexicon);
  const askedNames = [...new Set(asked.flatMap((t) => (t.name && !t.possessive ? [t.name] : [])))];
  const anyNames = new Set(asked.flatMap((t) => (t.name ? [stem(t.name)] : [])));
  const askedTerms = focus.filter((f) => !anyNames.has(f) && !CALENDAR_WORDS.has(f) && !QUESTION_FRAME_TERMS.has(f));
  if (statements.length === 0 || askedNames.length === 0 || askedTerms.length === 0) return [];

  const userIsSubject = USER_IS_SUBJECT.test(question);
  const needed = userIsSubject ? askedTerms.length : 1;
  const baseForms = (s: ParsedSentence) => [...new Set([...s.terms, ...s.tokens.map((t) => verbBase(t.word))])];
  const relationship = sentences.filter(
    (s) =>
      askedNames.some((n) => s.names.includes(n)) &&
      askedTerms.filter((q) => hasTerm(baseForms(s), verbBase(q))).length >= needed
  );

  if (relationship.length === 0) {
    return userIsSubject
      ? [{ statement: answer, reason: `no note sentence states what the question asks (${[...askedNames, ...askedTerms].join("/")})` }]
      : [];
  }
  const questionStems = asked.map((t) => t.stem);
  const violations: RelationshipViolation[] = [];
  for (const fact of statements) {
    for (const t of fact.terms) {
      if (CALENDAR_WORDS.has(t) || hasTerm(questionStems, t) || fact.names.some((n) => n.possessive && stem(n.name) === t)) continue;
      const holders = sentences.filter((s) => hasTerm(s.terms, t));
      if (holders.length > 0 && !holders.some((s) => relationship.includes(s))) {
        violations.push({ statement: fact.text, reason: `"${t}" comes from a note sentence that does not state what the question asks` });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Verification questions ("Did I celebrate Varun's birthday yesterday?")
// ---------------------------------------------------------------------------

/** A "Yes" needs the event recorded on the queried date. Against a recorded
 * different date, or no record at all, it is rejected — never rewritten. */
export function checkVerificationAnswer(answer: string, eventEvidence: EventEvidence | null): string | null {
  if (!eventEvidence || !/^\s*yes\b/i.test(answer) || eventEvidence.kind === "on-queried-date") {
    return null;
  }
  return `affirms the event although the notes record it ${eventEvidence.kind === "none" ? "nowhere" : "on a different date"}`;
}

/** A yes/no question opens with an auxiliary verb. */
const YES_NO_QUESTION = /^\s*(?:did|was|were|is|are|have|has|had|do|does)\b/i;

/**
 * A "Yes" must confirm the relationship the question actually asked about:
 * "Is Eli moving to Perth?" answered "Yes, Eli's brother Elias is moving to
 * Perth." confirms that ELI is moving — which no note says. Required: one
 * clause of a shown sentence that is not negated, shares the question's
 * predicate words (at least two, or the only one), has the question's agent
 * for each of them ("Eli" before "moving"), and sits in a sentence naming
 * everyone the question names. Rejected otherwise — never turned into a "No".
 * Comparison questions ("Was 2025 hotter than…") are out of scope: their
 * "Yes" rests on two sentences, not one.
 */
export function checkAffirmativeAnswer(input: {
  answer: string;
  question: string;
  evidence: EvidenceSentence[];
  now: Date;
  comparative: boolean;
}): string | null {
  const { answer, question, evidence, now, comparative } = input;
  if (comparative || !YES_NO_QUESTION.test(question) || !/^\s*yes\b/i.test(answer)) return null;
  const lexicon = buildNameLexicon(question, ...evidence.map((s) => s.text), answer);
  const asked = tokensOf(question, lexicon);
  const askedNames = [...new Set(namesOf(asked).map((n) => n.name))];
  const predicates = questionTerms(question, now).filter((t) => !FUNCTION_WORDS.has(t) && !CALENDAR_WORDS.has(t) && !askedNames.some((n) => stem(n) === t));
  if (predicates.length === 0) return null;
  const needed = Math.min(2, predicates.length);
  const supported = evidence.some((sentence) => {
    const names = new Set(namesOf(tokensOf(sentence.text, lexicon)).map((n) => n.name));
    if (!askedNames.every((n) => names.has(n))) return false;
    return splitIntoClauses(sentence.text).some(({ text }) => {
      if (NEGATION.test(text)) return false;
      const tokens = tokensOf(text, lexicon);
      const shared = predicates.filter((p) => tokens.some((t) => t.stem === p && !t.name));
      return (
        shared.length >= needed &&
        shared.every((p) => {
          const askedAgent = agentOf(asked, p);
          return askedAgent === null || agentOf(tokens, p) === askedAgent;
        })
      );
    });
  });
  return supported ? null : "answers Yes, but no note sentence states what the question asks";
}

const MS_PER_DAY = 86_400_000;

/** "September 30" / "30th of September" written for a day — year-less dates
 * the resolver deliberately leaves unresolved, but which still state the day
 * here, where the event's own date is already known. */
function namesMonthDay(text: string, p: Period): boolean {
  if (p.precision !== "day") return false;
  const month = MONTHS[Number(p.start.slice(5, 7)) - 1];
  const dayOfMonth = Number(p.start.slice(8, 10));
  return new RegExp(`\\b${month}\\s+${dayOfMonth}(?:st|nd|rd|th)?\\b|\\b${dayOfMonth}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${month}\\b`, "i").test(text);
}

/** "the day before yesterday", "3 days after October 1" — a day event's
 * distance from the queried day, in the question's own words when it had
 * them. */
function dayContrast(event: Period, queried: Period, reference: string): string {
  const days = Math.round((Date.parse(queried.start) - Date.parse(event.start)) / MS_PER_DAY);
  const side = days > 0 ? "before" : "after";
  const n = Math.abs(days);
  return n === 1 ? `the day ${side} ${reference}` : `${n} days ${side} ${reference}`;
}

/**
 * Deterministic text appended to an already-validated answer when the notes
 * unambiguously date the asked-about event to a different day — only when
 * every matching event sentence gives the SAME date. What it adds depends on
 * what the answer already says, so nothing is repeated:
 *  - neither date: "Your notes date this to Wednesday, September 30 2026,
 *    not Thursday, October 1 2026 (yesterday)."
 *  - the event date only: just the contrast — "That was the day before
 *    yesterday, not yesterday."
 *  - the queried date only: just the event date — "Your notes date it to
 *    Wednesday, September 30 2026."
 *  - both: nothing.
 * It speaks only about the event the notes record — never that nothing else
 * happened on the queried day.
 */
export function verificationAddendum(
  answer: string,
  eventEvidence: EventEvidence | null,
  queried: { period: Period; label: string; relative: string | null } | null,
  now: Date
): string | null {
  if (!queried || eventEvidence?.kind !== "different-date") return null;
  const eventDates = [...new Map(eventEvidence.eventDates.map((p) => [describePeriod(p), p])).values()];
  if (eventDates.length !== 1) return null;
  const event = eventDates[0];
  // Dates the answer states, at least as precise as the one compared — a bare
  // "2026" mentions neither day.
  const stated = resolveTemporalExpressions(answer, { kind: "queryTime", date: now }).references.flatMap((r) =>
    r.resolution.status === "resolved" ? [r.resolution.period] : []
  );
  const states = (p: Period) =>
    stated.some((s) => rankOf(s) <= rankOf(p) && relatePeriods(s, p) !== "outside") || namesMonthDay(answer, p);
  const mentionsQueried = (queried.relative !== null && answer.toLowerCase().includes(queried.relative)) || states(queried.period);
  const mentionsEvent = states(event);
  const queriedText = queried.relative ?? queried.label;

  if (mentionsQueried && mentionsEvent) return null;
  if (mentionsQueried) return `Your notes date it to ${describePeriod(event)}.`;
  if (mentionsEvent) {
    return event.precision === "day" && queried.period.precision === "day"
      ? `That was ${dayContrast(event, queried.period, queriedText)}, not ${queriedText}.`
      : `That was not ${queriedText}.`;
  }
  return `Your notes date this to ${describePeriod(event)}, not ${queried.label}${queried.relative ? ` (${queried.relative})` : ""}.`;
}

// ---------------------------------------------------------------------------
// Related notes (shown under the fallback when an answer can't be verified)
// ---------------------------------------------------------------------------

/**
 * Which of the notes the model was actually shown are about the question:
 * those with a shown sentence sharing at least one of the question's own
 * content words, spelling variants included ("vaccum" finds "vacuum"). Lets
 * the UI offer the user their own notes to check when no verified answer
 * can be given — never as proof of anything, and never a retrieved note the
 * model wasn't shown, or one about something else (the Marco note for a
 * question about Theo). Returns note indices, in context order.
 */
export function relatedEvidenceNotes(evidence: EvidenceSentence[], question: string, now: Date): number[] {
  const focus = questionTerms(question, now).filter((f) => !FUNCTION_WORDS.has(f) && !CALENDAR_WORDS.has(f));
  const related: number[] = [];
  for (const sentence of evidence) {
    if (related.includes(sentence.noteIndex)) continue;
    const terms = contentTerms(sentence.text);
    if (focus.some((f) => hasTerm(terms, f))) related.push(sentence.noteIndex);
  }
  return related;
}
