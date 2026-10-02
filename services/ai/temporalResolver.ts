import * as chrono from "chrono-node";

import { endOfMonth, formatIsoDate, shiftIsoDate, startOfMonth, startOfWeek, type DateRange } from "../calendar/dateRange";
import { detectQueryDateRange } from "./queryDateRange";

/**
 * Anchor-aware temporal resolution for the RAG pipeline — the app, not the
 * model, decides what every relative-time expression means.
 *
 * Why this exists: the same words mean different dates depending on who said
 * them and when. "Yesterday" in a note recorded 1 Oct is 30 Sep; "yesterday" in
 * a question asked 2 Oct is 1 Oct. A note recorded Oct 2025 saying "last year
 * it was better" means 2024, while a question asked Oct 2026 about "last year"
 * means 2025. The 1.5B model was confirmed (live, temperature 0, byte-exact
 * prompt reconstruction) to get this wrong no matter how it was instructed or
 * shown — it generated a year that appeared nowhere in its context. So every
 * expression is resolved here, against its own anchor, before the model sees
 * anything.
 *
 * chrono-node does all date arithmetic, unmodified. This module only:
 *  - passes the correct anchor (a note's own `createdAt`, or the query time)
 *  - expands chrono's certainty flags into a calendar Period
 *  - refuses to trust chrono where it is silently wrong (see below)
 *
 * Deictic vs anaphoric — the one rule that decides resolved vs unresolved,
 * instead of a phrase dictionary. Deictic expressions are anchored to the
 * moment of speaking ("yesterday", "two days ago", "last year", "this
 * month") and resolve against the anchor. Anaphoric expressions are anchored
 * to ANOTHER event in the text ("the day before that", "three weeks
 * earlier", "the previous Saturday", "the year before"); resolving them
 * needs that other event, which this v1 does not track. chrono gets these
 * silently wrong (verified: "the day before that" resolves as if "that" were
 * absent; "Two weeks later" resolves against the anchor), so they are marked
 * unresolved rather than guessed — a missed resolution is recoverable, a
 * confidently wrong one is not (same principle as queryDateRange.ts).
 *
 * Direction ambiguity is the second refusal: a bare weekday or month with no
 * year and no direction word ("On Saturday...", "In March...") could be
 * past or future in a note, and chrono resolves it forward (verified:
 * "Saturday" from a Thursday → the coming Saturday) — unresolved too.
 *
 * Pure: no native imports, directly unit-testable with fixed anchors.
 */

/** Local calendar date, "YYYY-MM-DD" — built via services/calendar/dateRange's
 * local-time helpers, never `new Date(iso)` (UTC midnight). */
export type IsoDate = string;

/** Ordered fine → coarse. "range" is a span that isn't calendar-aligned (e.g.
 * the ±42-day anniversary window queryDateRange.ts produces). */
export type Precision = "day" | "week" | "month" | "range" | "quarter" | "year";

export type Period = { start: IsoDate; end: IsoDate; precision: Precision };

export type TemporalAnchor = { kind: "queryTime" | "memoryCreatedAt"; date: Date };

export type UnresolvedReason = "anaphoric" | "ambiguous-direction";

export type TemporalReference = {
  /** Exact matched span from the source text. */
  text: string;
  /** Character offset of `text` in the source. */
  index: number;
  anchor: TemporalAnchor;
  resolution: { status: "resolved"; period: Period } | { status: "unresolved"; reason: UnresolvedReason };
};

export type ClauseRelation = "inside" | "outside" | "mixed" | "unknown" | "noQueryPeriod";

/**
 * What a question asks about, in time. `periods` has one entry for a plain
 * temporal question and several when it names more than one period ("2025
 * compared with 2024", "2025 … the previous year"). `comparative` is true
 * when the question's structure (two or more periods) or its wording ("hotter
 * than", "compared with") asks for a comparison — context construction then
 * keeps clauses from every relevant period instead of only the asked one.
 */
export type QueryTemporalTarget = { periods: Period[]; comparative: boolean };

export type MemoryClause = {
  /** Trimmed original text of the clause. */
  text: string;
  /** Offset of `text` in the (truncated) note text it was split from. */
  index: number;
  /** Every resolved reference's period in this clause; the note's own
   * recorded day when the clause has no references at all; empty when its
   * only references are unresolved. */
  periods: Period[];
  source: "explicit" | "recordedDate";
  relation: ClauseRelation;
  /** Indices into `QueryTemporalTarget.periods` this clause falls in (wholly
   * or partly) — which asked period each clause belongs to. */
  matches: number[];
};

/**
 * A time of day ("at 4pm", "in the morning") — never a date on its own. It is
 * attached to the day the same sentence establishes ("Tomorrow I have an
 * interview at 4pm" → tomorrow, 16:00), or to the anchor's own day when the
 * sentence names no day at all ("I woke up at 7am"). Kept separately from
 * TemporalReference so a bare time can never become a second, competing date.
 */
export type TimeOfDay = {
  text: string;
  index: number;
  /** null when chrono only implies it ("in the morning"). */
  hour: number | null;
  minute: number | null;
  day: Period;
  attachedTo: "reference" | "anchorDay";
  /** Index into `references` when attachedTo is "reference". */
  referenceIndex?: number;
};

/** A sentence of the note, as indices into `clauses` — the unit of
 * provenance relationship grounding cites (noteId + sentence index). */
export type MemorySentence = { index: number; clauseIndices: number[] };

export type ResolvedMemory = {
  /** Epoch seconds, as stored. */
  createdAt: number;
  recordedDay: Period;
  references: TemporalReference[];
  times: TimeOfDay[];
  clauses: MemoryClause[];
  sentences: MemorySentence[];
};

export const PRECISION_RANK: Record<Precision, number> = {
  day: 0,
  week: 1,
  month: 2,
  range: 2,
  quarter: 3,
  year: 4,
};

const DIRECTION_WORD = /\b(last|next|this|ago|yesterday|today|tomorrow|tonight)\b/i;
const ANAPHORIC_WORD = /\b(before|after|earlier|later|previous|prior|preceding|following)\b/i;
/** "the day before yesterday" contains "before" but is anchored to now. */
const DEICTIC_COMPOUND = /\b(day before yesterday|day after tomorrow)\b/i;
/** Marker chrono leaves OUTSIDE its match: "the Saturday before" → chrono
 * matches only "Saturday". */
const TRAILING_ANAPHOR = /^\s+(before|after|earlier|later)\b/i;
/** "the previous Saturday" → chrono matches only "Saturday". */
const LEADING_ANAPHOR = /\b(previous|prior|preceding|following)\s+$/i;
const ANAPHOR_WINDOW_CHARS = 16;

const TIME_UNIT =
  "(?:days?|weeks?|weekend|months?|years?|quarter|monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
/** Anaphoric phrases chrono doesn't match AT ALL (verified: "the previous
 * month" → no match). Without this, the clause containing one would fall back
 * to the note's recorded date — a wrong date, not a missing one. */
const STANDALONE_ANAPHORIC_PATTERN = new RegExp(
  `\\b(?:the\\s+)?(?:previous|prior|preceding|following)\\s+${TIME_UNIT}\\b` +
    `|\\b(?:the\\s+)?${TIME_UNIT}\\s+(?:before|after)\\b` +
    `|\\b(?:\\w+\\s+)?${TIME_UNIT}\\s+(?:earlier|later)\\b`,
  "gi"
);

/** Anchor-free absolute years chrono doesn't parse (verified: "in 2024" → no
 * match). Requires a leading preposition or parentheses so a bare count
 * ("a crowd of 2000 people") isn't read as a year. */
const BARE_YEAR_PATTERN = /\b(?:in|during|since|year)\s+((?:19|20)\d{2})\b|\(((?:19|20)\d{2})\)/gi;
const FOUR_DIGIT_YEAR = /\b(?:19|20)\d{2}\b/;

function parseIsoLocal(iso: IsoDate): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dayPeriod(iso: IsoDate): Period {
  return { start: iso, end: iso, precision: "day" };
}

function yearPeriod(year: number): Period {
  return { start: `${year}-01-01`, end: `${year}-12-31`, precision: "year" };
}

function quarterPeriod(date: Date): Period {
  const startMonth = Math.floor(date.getMonth() / 3) * 3;
  return {
    start: startOfMonth(formatIsoDate(new Date(date.getFullYear(), startMonth, 1))),
    end: endOfMonth(formatIsoDate(new Date(date.getFullYear(), startMonth + 2, 1))),
    precision: "quarter",
  };
}

/** A fresh copy per scan — a shared `g` regex carries `lastIndex` between calls. */
function scan(pattern: RegExp, text: string): RegExpExecArray[] {
  const regex = new RegExp(pattern.source, pattern.flags);
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    matches.push(match);
  }
  return matches;
}

function overlapsSpan(index: number, length: number, refs: { index: number; text: string }[]): boolean {
  return refs.some((ref) => index < ref.index + ref.text.length && ref.index < index + length);
}

function isAnaphoric(source: string, matchText: string, index: number): boolean {
  if (DEICTIC_COMPOUND.test(matchText)) {
    return false;
  }
  if (ANAPHORIC_WORD.test(matchText)) {
    return true;
  }
  // Only a bare weekday/unit match can have its anaphoric marker sitting
  // outside chrono's span. "Yesterday before lunch" is deictic — the
  // direction word already pins it to the anchor.
  if (DIRECTION_WORD.test(matchText)) {
    return false;
  }
  const end = index + matchText.length;
  return (
    TRAILING_ANAPHOR.test(source.slice(end, end + ANAPHOR_WINDOW_CHARS)) ||
    LEADING_ANAPHOR.test(source.slice(Math.max(0, index - ANAPHOR_WINDOW_CHARS), index))
  );
}

/** "for a week", "for 3 days" — a duration, not a date. chrono resolves these
 * to a date anyway (verified: "Ice it twice a day for a week" → "the week of
 * September 20"), which made a knee-treatment note match "last week". One
 * grammatical shape (for + amount + unit), not a phrase list; a real date in
 * the same sentence ("for a week last year") is a separate match and still
 * resolves. */
const DURATION = /^for\s+(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|several|a few|a couple of|\d+)\s+(?:minute|hour|day|night|week|fortnight|month|year)s?$/i;

/** No calendar component and no direction word — "at 4pm", "in the
 * morning". Insufficient to establish a date on its own. */
function isTimeOnly(result: chrono.ParsedResult): boolean {
  const namesACalendarDate = (["year", "month", "day", "weekday"] as const).some((c) => result.start.isCertain(c));
  return !namesACalendarDate && !DIRECTION_WORD.test(result.text);
}

function sentenceBounds(text: string, index: number): { start: number; end: number } {
  let start = 0;
  let end = text.length;
  for (const match of scan(SENTENCE_END, text)) {
    const boundary = match.index + match[0].length;
    if (boundary <= index) start = boundary;
    else if (match.index >= index) {
      end = match.index;
      break;
    }
  }
  return { start, end };
}

function timeFields(result: chrono.ParsedResult): { hour: number | null; minute: number | null } {
  return result.start.isCertain("hour")
    ? { hour: result.start.get("hour") ?? null, minute: result.start.get("minute") ?? 0 }
    : { hour: null, minute: null };
}

/** null = direction-ambiguous: names a weekday/month/day but no year and no
 * direction word, so it could be past or future. */
function periodFromChrono(result: chrono.ParsedResult): Period | null {
  const text = result.text;
  const startDate = result.start.date();
  const startIso = formatIsoDate(startDate);
  const yearCertain = result.start.isCertain("year");
  const hasDirection = DIRECTION_WORD.test(text);
  const namesACalendarDate = (["month", "day", "weekday"] as const).some((c) => result.start.isCertain(c));

  if (!yearCertain && !hasDirection && namesACalendarDate) {
    return null;
  }
  if (/\bweek\b/i.test(text)) {
    const weekStart = startOfWeek(startIso);
    return { start: weekStart, end: shiftIsoDate(weekStart, 6), precision: "week" };
  }
  if (/\bquarter\b/i.test(text)) {
    return quarterPeriod(startDate);
  }
  if (result.start.isCertain("day")) {
    if (result.end) {
      const endIso = formatIsoDate(result.end.date());
      return endIso === startIso ? dayPeriod(startIso) : { start: startIso, end: endIso, precision: "range" };
    }
    return dayPeriod(startIso);
  }
  if (result.start.isCertain("month")) {
    return { start: startOfMonth(startIso), end: endOfMonth(startIso), precision: "month" };
  }
  if (yearCertain) {
    return yearPeriod(startDate.getFullYear());
  }
  // A direction word with only a weekday or nothing certain ("last Monday",
  // "this morning") — a single, determinate day. (Bare times without a
  // direction word never reach here; see isTimeOnly.)
  return dayPeriod(startIso);
}

export function resolveTemporalReferences(text: string, anchor: TemporalAnchor): TemporalReference[] {
  return resolveTemporalExpressions(text, anchor).references;
}

/** Dates and times of day in `text`, each resolved against `anchor`. */
export function resolveTemporalExpressions(text: string, anchor: TemporalAnchor): { references: TemporalReference[]; times: TimeOfDay[] } {
  const refs: TemporalReference[] = [];
  const bareTimes: { result: chrono.ParsedResult }[] = [];
  const timedRefs: { ref: TemporalReference; result: chrono.ParsedResult }[] = [];

  for (const result of chrono.parse(text, anchor.date, { forwardDate: false })) {
    if (DURATION.test(result.text.trim())) {
      continue;
    }
    if (isTimeOnly(result)) {
      bareTimes.push({ result });
      continue;
    }
    if (isAnaphoric(text, result.text, result.index)) {
      refs.push({ text: result.text, index: result.index, anchor, resolution: { status: "unresolved", reason: "anaphoric" } });
      continue;
    }
    const period = periodFromChrono(result);
    const ref: TemporalReference = {
      text: result.text,
      index: result.index,
      anchor,
      resolution: period ? { status: "resolved", period } : { status: "unresolved", reason: "ambiguous-direction" },
    };
    refs.push(ref);
    // "Tomorrow at 4pm" as one match: the time belongs to that same day.
    if (period?.precision === "day" && result.start.isCertain("hour")) {
      timedRefs.push({ ref, result });
    }
  }

  for (const match of scan(BARE_YEAR_PATTERN, text)) {
    const year = match[1] ?? match[2];
    const index = match.index + match[0].indexOf(year);
    if (!overlapsSpan(index, year.length, refs)) {
      refs.push({ text: year, index, anchor, resolution: { status: "resolved", period: yearPeriod(Number(year)) } });
    }
  }

  for (const match of scan(STANDALONE_ANAPHORIC_PATTERN, text)) {
    if (!overlapsSpan(match.index, match[0].length, refs)) {
      refs.push({ text: match[0], index: match.index, anchor, resolution: { status: "unresolved", reason: "anaphoric" } });
    }
  }

  const references = refs.sort((a, b) => a.index - b.index);
  const anchorDay = dayPeriod(formatIsoDate(anchor.date));
  const times: TimeOfDay[] = timedRefs.map(({ ref, result }) => ({
    text: result.text,
    index: result.index,
    ...timeFields(result),
    day: ref.resolution.status === "resolved" ? ref.resolution.period : anchorDay,
    attachedTo: "reference" as const,
    referenceIndex: references.indexOf(ref),
  }));
  // A bare time takes the day its own sentence establishes — the nearest
  // day-level date before it, else after it — and the anchor's day only when
  // the sentence names none.
  for (const { result } of bareTimes) {
    const { start, end } = sentenceBounds(text, result.index);
    const dayRefs = references.filter(
      (r) => r.index >= start && r.index < end && r.resolution.status === "resolved" && r.resolution.period.precision === "day"
    );
    const owner = [...dayRefs].reverse().find((r) => r.index < result.index) ?? dayRefs.find((r) => r.index > result.index);
    times.push({
      text: result.text,
      index: result.index,
      ...timeFields(result),
      day: owner && owner.resolution.status === "resolved" ? owner.resolution.period : anchorDay,
      attachedTo: owner ? "reference" : "anchorDay",
      ...(owner ? { referenceIndex: references.indexOf(owner) } : {}),
    });
  }
  return { references, times: times.sort((a, b) => a.index - b.index) };
}

const SENTENCE_END = /[.!?]+(?:\s+|$)/g;
/** A comma before a subordinate/coordinating word starts a clause that can
 * carry a different time than the main clause: "Glad we had a plunge pool,
 * which we didn't have last year." */
const CLAUSE_BREAK = /,\s+(?=(?:which|but|while|whereas|although|though|because)\b)/gi;

export function splitIntoClauses(text: string): { text: string; index: number }[] {
  const cuts: { end: number; nextStart: number }[] = [];
  for (const match of scan(SENTENCE_END, text)) {
    cuts.push({ end: match.index + match[0].trimEnd().length, nextStart: match.index + match[0].length });
  }
  for (const match of scan(CLAUSE_BREAK, text)) {
    cuts.push({ end: match.index + 1, nextStart: match.index + match[0].length });
  }
  cuts.sort((a, b) => a.end - b.end);

  const segments: { text: string; index: number }[] = [];
  let start = 0;
  const pushSegment = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const trimmed = raw.trim();
    if (trimmed) {
      segments.push({ text: trimmed, index: from + (raw.length - raw.trimStart().length) });
    }
  };
  for (const cut of cuts) {
    if (cut.end <= start) {
      continue;
    }
    pushSegment(start, cut.end);
    start = cut.nextStart;
  }
  pushSegment(start, text.length);
  return segments;
}

/** "inside" = fully within the query period; "outside" = no overlap. */
export function relatePeriods(clausePeriod: Period, queryPeriod: Period): "inside" | "outside" | "overlaps" {
  if (clausePeriod.end < queryPeriod.start || clausePeriod.start > queryPeriod.end) {
    return "outside";
  }
  if (clausePeriod.start >= queryPeriod.start && clausePeriod.end <= queryPeriod.end) {
    return "inside";
  }
  return "overlaps";
}

/**
 * Like relatePeriods, but a period COARSER than the asked one counts as
 * outside even where it overlaps: "next month" (all of October) is not
 * evidence about 1 October. Confirmed live: a note saying Varun starts a job
 * "next month" was retrieved for "yesterday", "this morning" and "tomorrow".
 * An equally or more specific period relates normally — "next month" still
 * answers "What happened in October?", "last year" still answers "in 2024".
 */
export function relateForEvidence(period: Period, asked: Period): "inside" | "outside" | "overlaps" {
  const relation = relatePeriods(period, asked);
  return relation !== "outside" && PRECISION_RANK[period.precision] > PRECISION_RANK[asked.precision] ? "outside" : relation;
}

/** A clause period is inside the target if some asked period wholly contains
 * it, outside if it misses (or is coarser than) every asked period, partial
 * otherwise. */
function relateToTarget(periods: Period[], target: Period[]): { relation: "inside" | "outside" | "mixed"; matches: number[] } {
  const matches = target.flatMap((asked, i) => (periods.some((p) => relateForEvidence(p, asked) !== "outside") ? [i] : []));
  const perPeriod = periods.map((p) => {
    const relations = target.map((asked) => relateForEvidence(p, asked));
    if (relations.includes("inside")) return "inside";
    return relations.every((r) => r === "outside") ? "outside" : "overlaps";
  });
  const relation = perPeriod.every((r) => r === "inside")
    ? "inside"
    : perPeriod.every((r) => r === "outside")
      ? "outside"
      : "mixed";
  return { relation, matches };
}

export function resolveMemory(text: string, createdAt: number, target: QueryTemporalTarget | null): ResolvedMemory {
  const anchorDate = new Date(createdAt * 1000);
  const recordedDay = dayPeriod(formatIsoDate(anchorDate));
  const { references, times } = resolveTemporalExpressions(text, { kind: "memoryCreatedAt", date: anchorDate });

  const clauses = splitIntoClauses(text).map((segment): MemoryClause => {
    const segmentEnd = segment.index + segment.text.length;
    const inClause = references.filter((ref) => ref.index >= segment.index && ref.index < segmentEnd);
    const resolved = inClause.flatMap((ref) => (ref.resolution.status === "resolved" ? [ref.resolution.period] : []));
    const hasUnresolved = inClause.some((ref) => ref.resolution.status === "unresolved");
    const periods = inClause.length === 0 ? [recordedDay] : resolved;

    let relation: ClauseRelation = "noQueryPeriod";
    let matches: number[] = [];
    if (target && hasUnresolved) {
      relation = "unknown";
    } else if (target) {
      ({ relation, matches } = relateToTarget(periods, target.periods));
    }

    return {
      text: segment.text,
      index: segment.index,
      periods,
      source: inClause.length === 0 ? "recordedDate" : "explicit",
      relation,
      matches,
    };
  });

  const sentences: MemorySentence[] = [];
  clauses.forEach((clause, i) => {
    if (sentences.length === 0 || /[.!?…]$/.test(clauses[i - 1].text)) {
      sentences.push({ index: sentences.length, clauseIndices: [] });
    }
    sentences[sentences.length - 1].clauseIndices.push(i);
  });

  return { createdAt, recordedDay, references, times, clauses, sentences };
}

/**
 * Why a note is eligible for a temporal question — or null if it isn't.
 * "recorded": written during an asked period. "referenced": written at some
 * other time but containing an expression that resolves (against its own
 * recording date) into an asked period — a note recorded October 2025 that
 * says "last year it was better" is about 2024 too. createdAt is never
 * assumed to be the date of every event a note describes.
 */
export function classifyNoteForPeriods(text: string, createdAt: number, periods: Period[]): "recorded" | "referenced" | null {
  const anchorDate = new Date(createdAt * 1000);
  const recordedDay = dayPeriod(formatIsoDate(anchorDate));
  if (periods.some((p) => relatePeriods(recordedDay, p) !== "outside")) {
    return "recorded";
  }
  const referencesAskedPeriod = resolveTemporalReferences(text, { kind: "memoryCreatedAt", date: anchorDate }).some((ref) => {
    const { resolution } = ref;
    return resolution.status === "resolved" && periods.some((p) => relateForEvidence(resolution.period, p) !== "outside");
  });
  return referencesAskedPeriod ? "referenced" : null;
}

/** In a QUESTION, a standalone four-digit year is a year — there is no
 * "a crowd of 2000 people" ambiguity worth guarding against the way note
 * text needs (see BARE_YEAR_PATTERN). */
const QUERY_YEAR_PATTERN = /\b(?:19|20)\d{2}\b/g;
/** "the previous year" / "the following year", resolved against the explicit
 * year mentioned BEFORE it in the same question ("Was 2025 hotter than the
 * previous year?" → 2024). Without such a year it is left to the existing
 * detector — query-side only; inside notes these stay unresolved. */
const QUERY_YEAR_ANAPHOR_PATTERN =
  /\b(?:the\s+)?(?:previous|prior|preceding)\s+year\b|\bthe\s+year\s+before\b|\b(?:the\s+)?following\s+year\b|\bthe\s+(?:year\s+after|next\s+year)\b/gi;
/** "more than 40 degrees" is a quantity, not a comparison between periods. */
const NON_COMPARATIVE_THAN = /\b(?:other|rather|more|less|fewer)\s+than\b/gi;
const COMPARATIVE_WORDING = /\b(?:compar\w*|versus|vs\.?|than|differen\w*|differ|changed?|similar)\b/i;

/**
 * Resolves what a question asks about, in time. Extends — never replaces —
 * queryDateRange.ts:
 *  - two or more periods (explicit years, plus "the previous/following year"
 *    anchored to a year in the same question) → one period each;
 *  - exactly one explicit year → queryDateRange's result when it recognizes
 *    the phrase ("15th March 2025", "October 2025"), otherwise that whole
 *    year (chrono ignores a bare "in 2024", so the detector returns null);
 *  - no explicit year → queryDateRange's result, unchanged.
 */
export function resolveQueryTemporalTarget(query: string, now: Date): QueryTemporalTarget | null {
  const years = scan(QUERY_YEAR_PATTERN, query).map((m) => ({ year: Number(m[0]), index: m.index }));
  const anaphorYears = scan(QUERY_YEAR_ANAPHOR_PATTERN, query).flatMap((m) => {
    const antecedent = [...years].reverse().find((y) => y.index < m.index);
    if (!antecedent) return [];
    const offset = /previous|prior|preceding|before/i.test(m[0]) ? -1 : 1;
    return [antecedent.year + offset];
  });
  const distinctYears = [...new Set([...years.map((y) => y.year), ...anaphorYears])];

  let periods: Period[];
  if (distinctYears.length >= 2) {
    periods = distinctYears.map(yearPeriod);
  } else {
    const detected = toQueryPeriod(detectQueryDateRange(query, now));
    if (detected) {
      periods = [detected];
    } else if (distinctYears.length === 1) {
      periods = [yearPeriod(distinctYears[0])];
    } else {
      return null;
    }
  }

  const comparative = periods.length >= 2 || COMPARATIVE_WORDING.test(query.replace(NON_COMPARATIVE_THAN, ""));
  return { periods, comparative };
}

/** Bridges queryDateRange.ts's existing output (unchanged) into a Period. */
export function toQueryPeriod(range: DateRange | null): Period | null {
  if (!range) {
    return null;
  }
  if (range.start === range.end) {
    return dayPeriod(range.start);
  }
  const startYear = range.start.slice(0, 4);
  if (range.start === `${startYear}-01-01` && range.end === `${startYear}-12-31`) {
    return { ...range, precision: "year" };
  }
  if (range.start === startOfMonth(range.start) && range.end === endOfMonth(range.start)) {
    return { ...range, precision: "month" };
  }
  return { ...range, precision: "range" };
}

/** Every date the app itself has established for this answer: each note's
 * recorded day, every resolved reference inside the notes, and the
 * question's own periods. */
export function establishedPeriods(memories: ResolvedMemory[], target: QueryTemporalTarget | null): Period[] {
  const periods: Period[] = [];
  for (const memory of memories) {
    periods.push(memory.recordedDay);
    for (const ref of memory.references) {
      if (ref.resolution.status === "resolved") {
        periods.push(ref.resolution.period);
      }
    }
  }
  if (target) {
    periods.push(...target.periods);
  }
  return periods;
}

const MONTH_LONG: Intl.DateTimeFormatOptions = { month: "long" };

/** Shared human phrasing for a Period — "Wednesday, September 30 2026" for a
 * day matches the inline-replacement format the pipeline has always used. */
export function describePeriod(period: Period): string {
  const start = parseIsoLocal(period.start);
  const end = parseIsoLocal(period.end);
  const monthDayYear = (d: Date) =>
    `${d.toLocaleDateString("en-US", { month: "long", day: "numeric" })} ${d.getFullYear()}`;
  switch (period.precision) {
    case "day":
      return `${start.toLocaleDateString("en-US", { weekday: "long" })}, ${monthDayYear(start)}`;
    case "week":
      return `the week of ${monthDayYear(start)}`;
    case "month":
      return `${start.toLocaleDateString("en-US", MONTH_LONG)} ${start.getFullYear()}`;
    case "quarter":
      return `${start.toLocaleDateString("en-US", MONTH_LONG)} to ${end.toLocaleDateString("en-US", MONTH_LONG)} ${end.getFullYear()}`;
    case "year":
      return `${start.getFullYear()}`;
    case "range":
      return `${monthDayYear(start)} to ${monthDayYear(end)}`;
  }
}

export type DateCheckResult =
  | { status: "ok"; text: string }
  | { status: "rejected"; text: string; violations: string[] };

type StatedDate = { text: string; index: number; period: Period };

/** Only dates written with an explicit year — the v1 scope. Relative words in
 * the answer ("today", "this morning") are deliberately not validated: they
 * would be checked against the query time and falsely reject a correct
 * answer echoing the note's own phrasing. */
function extractExplicitDates(answer: string, queryNow: Date): StatedDate[] {
  const stated: StatedDate[] = [];
  for (const result of chrono.parse(answer, queryNow, { forwardDate: false })) {
    if (!FOUR_DIGIT_YEAR.test(result.text)) {
      continue;
    }
    const startIso = formatIsoDate(result.start.date());
    let period: Period;
    if (result.start.isCertain("day")) {
      const endIso = result.end ? formatIsoDate(result.end.date()) : startIso;
      period = endIso === startIso ? dayPeriod(startIso) : { start: startIso, end: endIso, precision: "range" };
    } else if (result.start.isCertain("month")) {
      period = { start: startOfMonth(startIso), end: endOfMonth(startIso), precision: "month" };
    } else {
      period = yearPeriod(result.start.date().getFullYear());
    }
    stated.push({ text: result.text, index: result.index, period });
  }
  for (const match of scan(BARE_YEAR_PATTERN, answer)) {
    const year = match[1] ?? match[2];
    const index = match.index + match[0].indexOf(year);
    if (!overlapsSpan(index, year.length, stated)) {
      stated.push({ text: year, index, period: yearPeriod(Number(year)) });
    }
  }
  return stated.sort((a, b) => a.index - b.index);
}

/** Allowed iff it overlaps an established period AND is no more precise than
 * it — so a specific day ("Oct 15 2024") needs an established specific day,
 * and is NOT allowed merely because some clause established the year 2024. */
function isLicensed(stated: Period, established: Period[]): boolean {
  return established.some(
    (period) =>
      relatePeriods(stated, period) !== "outside" && PRECISION_RANK[stated.precision] >= PRECISION_RANK[period.precision]
  );
}

/**
 * Post-generation backstop: every explicit-year date in the answer must have
 * been established by this module. Never rewrites a date just because it
 * differs from a note's createdAt — a legitimate "2024" in a comparison
 * answer is allowed when a clause established 2024.
 *
 * An unlicensed date rejects the whole answer. It is never rewritten to a
 * nearby established date: a wrong year is as likely the model attaching a
 * fact from a different time as a typo, and "repairing" it would silently
 * put the app's own words into a generated factual claim (confirmed: "How
 * was the weather in 2024?" answered with the 2025 hot day). Dates are made
 * right BEFORE generation — the context's inline normalization — not after.
 */
export function checkAnswerDates(answer: string, established: Period[], queryNow: Date): DateCheckResult {
  const violations = extractExplicitDates(answer, queryNow)
    .filter((stated) => !isLicensed(stated.period, established))
    .map((stated) => stated.text);
  return violations.length > 0 ? { status: "rejected", text: answer, violations } : { status: "ok", text: answer };
}

// ---------------------------------------------------------------------------
// Question terms — light, deterministic word overlap (no topic dictionary).
// ---------------------------------------------------------------------------

/** Function words and question scaffolding only; never topic words. */
const STOPWORDS = new Set(
  ("a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its just me my of on or our so " +
    "than that the their them then there these they this to too was we were what when where which who whom why will with would you your about " +
    "any all am get got go goes going went been note notes noted anything something nothing everything happen happened happening").split(" ")
);

/** Crude suffix stripping so "celebrated"/"celebrate"/"celebrating",
 * "moving"/"move" and "Varun's"/"Varun" meet. Deliberately conservative:
 * words of three letters are left alone ("hot" stays "hot"). Shared with
 * relationshipGrounding.ts so question, note and answer words always stem
 * the same way. */
export function stem(word: string): string {
  let w = word.toLowerCase().replace(/['’]s$/, "");
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && (w.endsWith("ed") || w.endsWith("es"))) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s")) w = w.slice(0, -1);
  if (w.length >= 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

function termsOf(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z][a-z'’]*/g) ?? [];
  return [...new Set(words.filter((w) => w.length >= 3 && !STOPWORDS.has(w.replace(/['’]s$/, ""))).map(stem))];
}

/** How many of `terms` occur in `text`. */
export function countTermMatches(text: string, terms: string[]): number {
  const present = new Set(termsOf(text));
  return terms.filter((t) => present.has(t)).length;
}

/** The question's content terms, with its time expressions removed —
 * "Did I celebrate Varun's birthday yesterday?" → celebrat, varun, birthday. */
export function questionTerms(query: string, now: Date): string[] {
  const spans: { index: number; length: number }[] = [
    ...resolveTemporalReferences(query, { kind: "queryTime", date: now }).map((r) => ({ index: r.index, length: r.text.length })),
    ...scan(QUERY_YEAR_PATTERN, query).map((m) => ({ index: m.index, length: m[0].length })),
    ...scan(QUERY_YEAR_ANAPHOR_PATTERN, query).map((m) => ({ index: m.index, length: m[0].length })),
  ];
  let stripped = query;
  for (const { index, length } of spans.sort((a, b) => b.index - a.index)) {
    stripped = stripped.slice(0, index) + " ".repeat(length) + stripped.slice(index + length);
  }
  return termsOf(stripped);
}

/** An event sentence must share at least two question terms (or the only
 * one, for a one-term question) — "Varun" alone does not make a note about
 * Varun's job evidence for a question about Varun's birthday. */
function requiredEventMatches(eventTerms: string[]): number {
  return Math.min(2, eventTerms.length);
}

// ---------------------------------------------------------------------------
// Shared temporal sentence selection — the ONE rule both retrieval (ranking)
// and rendering (ragFormatting.ts) use, so a note is never retrieved for
// content the context will then drop, or vice versa.
// ---------------------------------------------------------------------------

/** "…plunge pool to cool ourselves off," + "which we didn't have last year."
 * — a relative clause modifies the clause before it. */
const DEPENDENT_FRAGMENT = /^which\b/i;
/** A sentence whose meaning leans on the one before it: a comparison
 * ("better", "same time", "hotter than"), or an opening with no subject of
 * its own or pointing back ("Quite unusual for this month.", "He sounded
 * really excited."). "Last year same time it was so much better" means
 * nothing without the hot day it is better than. */
const DEPENDENCY_CUE =
  /\b(?:better|worse|best|worst|more|less|same|similar|different|unlike|than|compared|instead|again|also|too|either|neither|usual|unusual|normal)\b|\b\w+er\s+than\b/i;
const DEPENDENT_OPENING = /^(?:it|that|this|these|those|they|there|then|he|she|his|her|which|quite|very|so|really|pretty|rather|such|not|much)\b/i;
/** Bounds how far back a dependency chain reaches — the minimal span, not
 * the whole note. */
const MAX_CONTEXT_SENTENCES = 3;

/** The note's sentences as clause lists, in note order. */
function sentenceClauses(memory: ResolvedMemory): MemoryClause[][] {
  return memory.sentences.map((s) => s.clauseIndices.map((i) => memory.clauses[i]));
}

const sentenceText = (sentence: MemoryClause[]) => sentence.map((c) => c.text).join(" ");

function dependsOnPrevious(sentence: MemoryClause[]): boolean {
  return DEPENDENCY_CUE.test(sentenceText(sentence)) || DEPENDENT_OPENING.test(sentence[0].text);
}

/**
 * The sentences (as lists of kept clauses, in note order) a note contributes
 * to a temporal question. Only the prompt's view is filtered; the stored note
 * is never modified.
 *
 * 1. RELEVANT: a sentence with any clause inside an asked period, straddling
 *    one, or unresolved ("the day before that" — its time is unknown, not
 *    shown to be wrong, so it is never dropped). A clause with no time
 *    expression counts as the recording date's: relevant when the note was
 *    recorded in the asked period, not otherwise — the recording date is
 *    never a blanket reason to keep a sentence.
 * 2. EVENT EVIDENCE (verification questions only, `eventTerms` non-empty): a
 *    sentence describing the asked-about event is kept WHOLE, whatever its
 *    date — "Did I celebrate Varun's birthday yesterday?" must see "Yesterday
 *    we celebrated Varun's birthday" in a note recorded the day after, which
 *    establishes the celebration was the day before yesterday. Only matching
 *    sentences are added, not every sentence of the note.
 * 3. CONTEXT: a kept sentence pulls in the sentence before it when it depends
 *    on it, up the chain, at most MAX_CONTEXT_SENTENCES back. Context
 *    sentences are kept whole.
 * 4. Within a relevant sentence, a clause explicitly about a different period
 *    is dropped, unless a kept "which…" clause right after it modifies it.
 *
 * Comparison questions: with two or more explicit asked periods, the same
 * rules apply across all of them. With a single period and only comparison
 * wording ("hotter than usual"), the baseline is unknown, so nothing is
 * dropped.
 */
export type SelectedSentence = { sentenceIndex: number; clauses: MemoryClause[] };

export function selectTemporalSentences(memory: ResolvedMemory, target: QueryTemporalTarget, eventTerms: string[] = []): SelectedSentence[] {
  const keepAll = target.comparative && target.periods.length === 1;
  const isRelevantClause = (c: MemoryClause) => keepAll || c.relation !== "outside";
  const sentences = sentenceClauses(memory);
  const isEvent = sentences.map(
    (s) => eventTerms.length > 0 && countTermMatches(sentenceText(s), eventTerms) >= requiredEventMatches(eventTerms)
  );
  const relevant = sentences.map((s) => s.some(isRelevantClause));
  const included = sentences.map((_, i) => relevant[i] || isEvent[i]);
  sentences.forEach((_, i) => {
    if (!relevant[i] && !isEvent[i]) return;
    let j = i;
    for (let pulled = 0; pulled < MAX_CONTEXT_SENTENCES && j > 0 && dependsOnPrevious(sentences[j]); pulled++) {
      j--;
      included[j] = true;
    }
  });

  return sentences.flatMap((sentence, i): SelectedSentence[] => {
    if (!included[i]) return [];
    if (isEvent[i] || !relevant[i]) return [{ sentenceIndex: i, clauses: sentence }];
    const drop = sentence.map((c) => !keepAll && c.relation === "outside" && c.source === "explicit");
    sentence.forEach((_, k) => {
      if (drop[k] && k + 1 < sentence.length && !drop[k + 1] && DEPENDENT_FRAGMENT.test(sentence[k + 1].text)) {
        drop[k] = false;
      }
    });
    const kept = sentence.filter((_, k) => !drop[k]);
    return kept.length > 0 ? [{ sentenceIndex: i, clauses: kept }] : [];
  });
}

// ---------------------------------------------------------------------------
// Ranking — before the context-note limit is applied.
// ---------------------------------------------------------------------------

export type RankedNote<N> = {
  note: N;
  /** recorded: written in an asked period. referenced: refers to one at an
   * equal or finer precision. event: neither, but describes the event a
   * verification question asks about. */
  reason: "recorded" | "referenced" | "event";
  /** Question terms found in the note. */
  overlap: number;
  /** Precision rank of the strongest matching evidence (0 = a day). */
  specificity: number;
};

/**
 * Picks the notes a temporal question should see, BEFORE the context limit
 * is applied — replacing oldest-first, which let a loose match from
 * 20 September crowd out a note recorded on the very day asked about.
 *
 * Eligible: the note contributes at least one sentence under
 * selectTemporalSentences — the same rule rendering uses. Ranked by question
 * terms the note shares (most first), then how specific its matching evidence
 * is, then date; the selected notes are returned in chronological order for
 * reading. Callers pass the same truncated text the context will use.
 */
export function rankNotesForTarget<N>(
  candidates: { note: N; text: string; createdAt: number }[],
  target: QueryTemporalTarget,
  terms: { question: string[]; event: string[] },
  limit: number
): RankedNote<N>[] {
  const ranked = candidates.flatMap(({ note, text, createdAt }) => {
    const memory = resolveMemory(text, createdAt, target);
    if (selectTemporalSentences(memory, target, terms.event).length === 0) {
      return [];
    }
    const recorded = target.periods.some((p) => relateForEvidence(memory.recordedDay, p) !== "outside");
    const referenceRanks = memory.references.flatMap(({ resolution }) => {
      if (resolution.status !== "resolved") return [];
      const { period } = resolution;
      return target.periods.some((p) => relateForEvidence(period, p) !== "outside") ? [PRECISION_RANK[period.precision]] : [];
    });
    const eventMatch =
      terms.event.length > 0 &&
      sentenceClauses(memory).some((s) => countTermMatches(sentenceText(s), terms.event) >= requiredEventMatches(terms.event));
    // Eligibility needs POSITIVE evidence. An unresolved expression ("due on
    // 30 November", no year) keeps its sentence inside an otherwise-eligible
    // note, but never makes a note eligible by itself — confirmed live: it
    // made a Tokyo-booking note and a rego note "about" both "last week" and
    // "this morning".
    if (!recorded && referenceRanks.length === 0 && !eventMatch) {
      return [];
    }
    const reason: RankedNote<N>["reason"] = recorded ? "recorded" : referenceRanks.length > 0 ? "referenced" : "event";
    const specificity = recorded ? 0 : referenceRanks.length > 0 ? Math.min(...referenceRanks) : PRECISION_RANK.year + 1;
    return [{ note, reason, overlap: countTermMatches(text, terms.question), specificity, createdAt }];
  });
  return ranked
    .sort((a, b) => b.overlap - a.overlap || a.specificity - b.specificity || a.createdAt - b.createdAt)
    .slice(0, limit)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ note, reason, overlap, specificity }) => ({ note, reason, overlap, specificity }));
}

// ---------------------------------------------------------------------------
// Event-verification questions ("Did I celebrate Varun's birthday yesterday?")
// ---------------------------------------------------------------------------

/** A yes/no question opens with an auxiliary verb. */
const YES_NO_OPENING = /^\s*(?:did|was|were|is|are|have|has|had|do|does)\b/i;

/**
 * A yes/no question about whether an event happened in a resolved period, as
 * opposed to a lookup of the period ("What did I do yesterday?"). Decided by
 * the question's structure — yes/no form + a resolved, non-comparative
 * period + at least one content word left once the time expression is
 * removed ("Did I note anything yesterday?" has none and stays a lookup).
 */
export function detectEventVerification(query: string, now: Date, target: QueryTemporalTarget | null): { eventTerms: string[] } | null {
  if (!target || target.comparative || !YES_NO_OPENING.test(query)) {
    return null;
  }
  const eventTerms = questionTerms(query, now);
  return eventTerms.length > 0 ? { eventTerms } : null;
}

/**
 * The question as sent to the model, with each relative time expression's
 * resolved date written inline — "Did I celebrate Varun's birthday yesterday
 * (Thursday, October 1 2026)?" — so the model compares two written dates
 * instead of subtracting from "today", the step it reliably fails. A
 * separate internal string: the user's original question is what
 * transcription, retrieval, chat history and diagnostics keep using.
 * Phase 1 applies this to event-verification questions only.
 */
export function buildGroundedQuestion(query: string, now: Date): string {
  const relative = resolveTemporalReferences(query, { kind: "queryTime", date: now }).filter(
    (r) => r.resolution.status === "resolved" && DIRECTION_WORD.test(r.text)
  );
  let grounded = query;
  for (const ref of [...relative].sort((a, b) => b.index - a.index)) {
    if (ref.resolution.status !== "resolved") continue;
    const end = ref.index + ref.text.length;
    grounded = `${grounded.slice(0, end)} (${describePeriod(ref.resolution.period)})${grounded.slice(end)}`;
  }
  return grounded;
}

/** The single date a verification question asks about, phrased for the user
 * — label "Thursday, October 1 2026", relative "yesterday" when the question
 * said it that way. Null when the question asks about several periods. */
export function describeQueriedDate(
  query: string,
  now: Date,
  target: QueryTemporalTarget | null
): { period: Period; label: string; relative: string | null } | null {
  if (!target || target.periods.length !== 1) {
    return null;
  }
  const relative = resolveTemporalReferences(query, { kind: "queryTime", date: now }).filter(
    (r) => r.resolution.status === "resolved" && DIRECTION_WORD.test(r.text)
  );
  const period = target.periods[0];
  return { period, label: describePeriod(period), relative: relative.length === 1 ? relative[0].text.toLowerCase() : null };
}

/**
 * What the retrieved notes establish about the asked-about event:
 *  - "on-queried-date": a matching event is recorded in the asked period.
 *  - "different-date": a matching event is recorded, but on another date
 *    (Varun's celebration on 30 September, asked about 1 October).
 *  - "none": no matching event evidence was retrieved — which is NOT proof
 *    the event did not happen; it only means the notes don't say.
 */
export type EventEvidence = { kind: "on-queried-date" | "different-date" | "none"; eventDates: Period[] };

export function classifyEventEvidence(memories: ResolvedMemory[], target: QueryTemporalTarget, eventTerms: string[]): EventEvidence {
  const eventDates = memories.flatMap((memory) =>
    sentenceClauses(memory)
      .filter((s) => countTermMatches(sentenceText(s), eventTerms) >= requiredEventMatches(eventTerms))
      .flatMap((s) => s.flatMap((c) => c.periods))
  );
  if (eventDates.length === 0) {
    return { kind: "none", eventDates };
  }
  const onQueriedDate = eventDates.some((d) => target.periods.some((p) => relateForEvidence(d, p) !== "outside"));
  return { kind: onQueriedDate ? "on-queried-date" : "different-date", eventDates };
}
