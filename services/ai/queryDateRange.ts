import * as chrono from "chrono-node";

import { endOfMonth, formatIsoDate, shiftIsoDate, startOfMonth, startOfWeek, type DateRange } from "../calendar/dateRange";

/**
 * Detects a REAL past-date reference in a chat question ("what did I do on
 * 27th September", "last year same day", "October last year", "last week",
 * "between March and May", "last quarter") and resolves it to a concrete
 * date range for a deterministic, timestamp-filtered note lookup — see
 * `rag.ts`'s own doc comment for why this exists at all: without it, ANY
 * query mentioning a date gets run through the generic semantic/keyword
 * hybrid search, which can retrieve a note that merely MENTIONS a matching
 * word (e.g. a Sept-2026 note saying "due the first week of October" gets
 * pulled in for a query asking about "October LAST YEAR" — a completely
 * different October) rather than a note actually FROM the period asked
 * about.
 *
 * Imports nothing that reaches native code — same reasoning as
 * ragFormatting.ts: this is pure date-string logic, directly unit-testable
 * without a database, and importable from the Tier 1/Tier 2 eval harnesses
 * the same way.
 *
 * `chrono-node` is already a dependency, already used for to-do extraction
 * (`extractionLogic.ts`'s `resolveDateAndTime`) — but that call site uses
 * `{ forwardDate: true }` because a reminder is inherently PROSPECTIVE ("call
 * mom Friday" means the next Friday). A chat question about past notes is
 * the opposite: inherently RETROSPECTIVE.
 *
 * Real chrono-node behavior this file's logic is built against (verified via
 * live test scripts against real on-device bug reports AND two rounds of
 * follow-up phrase audits, reference date Thursday 1 Oct 2026 throughout —
 * not assumed):
 *
 *  - CRITICAL: for an AMBIGUOUS bare date with no explicit year ("March 5th",
 *    bare "March", bare "Sunday"/"Monday"), chrono ALWAYS resolves to the
 *    nearest occurrence going FORWARD once the same-cycle date has already
 *    passed — confirmed identical under `forwardDate: true`, `false`, and
 *    omitted entirely, so that option does NOT control this behavior for
 *    these phrasings the way its name suggests. Fixed below by clamping any
 *    ambiguous day/month-level result that lands in the future back by one
 *    cycle (a year, or 7 days for a bare weekday) — skipped when the query
 *    has an explicit year, or an explicit forward word ("next", "tomorrow",
 *    "upcoming"), since those genuinely do mean the future.
 *  - "27th September Sunday" -> TWO independent matches: "on 27th September"
 *    (day+month certain) AND, separately, bare "Sunday" (weekday only) —
 *    chrono does not realize "Sunday" here is just confirming the 27th's
 *    weekday, not a second date. Handled by preferring the most specific
 *    (day-certain) result when more than one is found.
 *  - "last year"/"this year" ALONE resolve to a single day (today's own
 *    month/day, shifted a year) with ONLY `year` in `knownValues` — month/day
 *    are defaulted, not certain. Expanded here to the FULL calendar year,
 *    UNLESS the query also says "same day"/"this day"/"today" (exact, single
 *    day) or "this time"/"same time"/"around the same time" (FUZZY — see the
 *    ANNIVERSARY-WINDOW section below for why these are handled differently
 *    from the exact-day qualifiers).
 *  - "October last year" -> chrono returns "October" (month certain, year
 *    defaulted to the CURRENT year) and "last year" (year certain, month/day
 *    defaulted to TODAY's) as two separate, independently-half-wrong matches
 *    — it does not combine them. Detected and combined here into the real
 *    "October of last year" full-month range.
 *  - "last week"/"this week" resolve to a single day with `knownValues: {}`
 *    (nothing certain at all) — matched directly against the query text,
 *    expanded to a real Sunday-Saturday week via this app's own
 *    `startOfWeek` (the same boundary the Week calendar view itself uses).
 *  - "last month"/"this month" resolve with `month`+`year` certain but `day`
 *    not — expanded to the full calendar month. Same forward-resolution bug
 *    as above applies to a bare month name and is fixed the same way.
 *  - "last quarter"/"this quarter" resolve to a single day with
 *    `knownValues: {}` — same as week references, no usable chrono signal,
 *    computed independently from the reference date's own quarter.
 *  - "between March and May"/"from June to August" -> chrono returns ONLY
 *    the FIRST month as its own independent match; the second month is
 *    dropped entirely. Detected via a dedicated pattern and combined into a
 *    real start-of-first-month to end-of-second-month range.
 *
 * ANNIVERSARY WINDOW ("around the same time last year"): a real voice note's
 * own temporal self-references are anchored to WHEN THE NOTE WAS RECORDED,
 * which may land weeks away from a strict one-year-back calendar point a
 * later query implies. Live scenario this is built for: a note recorded in
 * January 2027 talking about a hot day, asked about in December 2027 as
 * "was it this hot last year around the same time" — "last year" from a
 * December anchor nominally means ~December 2026, which would MISS the
 * January 2027 note entirely despite it being exactly what the question
 * means, because "around the same time" is a deliberately fuzzy reference to
 * a season of the year, not a specific calendar day or even calendar year
 * boundary. "same day"/"this day"/"today" stay exact (a user who says
 * "today" means today); "this time"/"same time"/"around ... time" get a
 * generous ±6-week window centered on the one-year-back anchor instead of
 * either a single day or the entire year — wide enough to cross a month (or
 * even a calendar-year) boundary on either side, which a strict "last year"
 * = that nominal calendar year alone could never do.
 *
 * Known gaps, deliberately NOT covered (return `null`, falling through to
 * generic semantic search rather than a wrong narrow date filter — a missed
 * detection is recoverable, a confidently wrong one is not): season words
 * ("last summer"), named holidays ("last Christmas"), personal dates chrono
 * cannot know ("my birthday"), "the week before last" (falls through to the
 * generic per-result ranking instead of a real two-weeks-ago week range),
 * and an explicit year combined with "early"/"late" ("late 2025" without the
 * word "year").
 */

const EXACT_DAY_QUALIFIER_PATTERN = /\b(same day|this day|today)\b/i;
/** See this file's own "ANNIVERSARY WINDOW" doc comment above for why this is
 * a SEPARATE, wider-window pattern from EXACT_DAY_QUALIFIER_PATTERN rather
 * than folded into it — "this time"/"same time" reference a season, not a
 * calendar day. "around"/"about"/"roughly" are optional; "same time"/"this
 * time" alone (a very common colloquial phrasing) gets the same fuzzy
 * treatment. */
const FUZZY_TIME_QUALIFIER_PATTERN = /\b(?:around|about|roughly)?\s*(?:the\s+)?(?:same|this)\s+time\b/i;
const ANNIVERSARY_WINDOW_DAYS = 42;
const LAST_YEAR_PATTERN = /\blast\s+year\b/i;
const WEEK_REFERENCE_PATTERN = /\b(last|this)\s+week\b/i;
const QUARTER_REFERENCE_PATTERN = /\b(last|this)\s+quarter\b/i;
// "early"/"mid"/"late" (adjective) AND "earlier"/"later" (comparative) —
// a follow-up audit found real queries use both forms ("early this year" vs
// "earlier this year") and only the adjective form was originally handled.
const EARLY_LATE_YEAR_PATTERN = /\b(earl(?:y|ier)|mid|lat(?:e|er))\s+(?:this|last)\s+year\b/i;
const MONTH_NAMES = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const MONTH_NAME_PATTERN = new RegExp(`\\b(${MONTH_NAMES.join("|")})\\b`, "i");
const BETWEEN_MONTHS_PATTERN = new RegExp(
  `\\b(?:between|from)\\s+(${MONTH_NAMES.join("|")})\\s+(?:and|to)\\s+(${MONTH_NAMES.join("|")})\\b`,
  "i"
);
const YEAR_MODIFIER_PATTERN = /\b(last|this)\s+year\b/i;
/** "last <Month>"/"this <Month>" directly adjacent (as opposed to "<Month>
 * ... last year" elsewhere in the sentence, which YEAR_MODIFIER_PATTERN
 * handles) — chrono resolves BOTH of these to the identical same-cycle date
 * (verified live: "this December" and "last December" asked in October both
 * raw-resolved to the SAME upcoming December), not distinguishing the word
 * at all, so the word has to be read here instead. The two mean different
 * things and must not share one clamping rule: "last <Month>" always means
 * the most recently COMPLETED occurrence (this year's, if already passed,
 * otherwise last year's) and should clamp into the past when ambiguous;
 * "this <Month>" always means the CURRENT calendar year's occurrence,
 * full stop, even when that's still ahead of today. */
const LAST_OR_THIS_MONTH_PATTERN = new RegExp(`\\b(last|this)\\s+(${MONTH_NAMES.join("|")})\\b`, "i");
const EXPLICIT_YEAR_PATTERN = /\b(19|20)\d{2}\b/;
const FORWARD_INDICATOR_PATTERN = /\b(next|tomorrow|upcoming|coming)\b/i;

function toIso(date: Date): string {
  return formatIsoDate(date);
}

function fullYearRange(year: number): DateRange {
  return { start: `${year}-01-01`, end: `${year}-12-31` };
}

function fullMonthRange(year: number, monthIndex0: number): DateRange {
  const sample = toIso(new Date(year, monthIndex0, 1));
  return { start: startOfMonth(sample), end: endOfMonth(sample) };
}

function weekRangeContaining(anchorIso: string): DateRange {
  const start = startOfWeek(anchorIso);
  return { start, end: shiftIsoDate(start, 6) };
}

/** Rough, deliberately simple thirds — chrono has no concept of "early"/
 * "mid"/"late" at all, so there's no finer signal to resolve this against.
 * A coarse but correct-direction range beats either ignoring the qualifier
 * (searching the whole year) or failing to match anything. */
function earlyMidLateYearRange(year: number, portion: string): DateRange {
  const lower = portion.toLowerCase();
  if (lower.startsWith("earl")) return { start: `${year}-01-01`, end: `${year}-04-30` };
  if (lower === "mid") return { start: `${year}-05-01`, end: `${year}-08-31` };
  return { start: `${year}-09-01`, end: `${year}-12-31` };
}

function quarterRange(year: number, quarterIndex0: number): DateRange {
  const startMonth = quarterIndex0 * 3;
  return { start: startOfMonth(toIso(new Date(year, startMonth, 1))), end: endOfMonth(toIso(new Date(year, startMonth + 2, 1))) };
}

/** "last quarter"/"this quarter" relative to `referenceDate`'s own quarter —
 * Q1=Jan-Mar .. Q4=Oct-Dec. "Last quarter" from Q1 wraps to Q4 of the
 * PREVIOUS year. */
function resolveQuarterReference(query: string, referenceDate: Date): DateRange | null {
  const match = query.match(QUARTER_REFERENCE_PATTERN);
  if (!match) {
    return null;
  }
  const currentQuarter = Math.floor(referenceDate.getMonth() / 3);
  if (match[1].toLowerCase() === "this") {
    return quarterRange(referenceDate.getFullYear(), currentQuarter);
  }
  return currentQuarter === 0
    ? quarterRange(referenceDate.getFullYear() - 1, 3)
    : quarterRange(referenceDate.getFullYear(), currentQuarter - 1);
}

/** "between March and May"/"from June to August" — chrono only ever
 * captures the FIRST month as an independent match (verified live); this
 * combines both named months into one real range. Year: an explicit
 * "last year"/"this year" modifier wins if present; otherwise defaults to
 * the reference year, UNLESS that would place the ENTIRE range in the
 * future relative to `referenceDate` with no explicit year or forward word
 * in the query, in which case it steps back a year — same reasoning as the
 * single-month clamp elsewhere in this file. */
function resolveMonthRangeReference(query: string, referenceDate: Date): DateRange | null {
  const match = query.match(BETWEEN_MONTHS_PATTERN);
  if (!match) {
    return null;
  }
  const startMonthIndex0 = MONTH_NAMES.indexOf(match[1].toLowerCase());
  const endMonthIndex0 = MONTH_NAMES.indexOf(match[2].toLowerCase());

  const yearModifierMatch = query.match(YEAR_MODIFIER_PATTERN);
  let year = referenceDate.getFullYear();
  if (yearModifierMatch) {
    year = /last/i.test(yearModifierMatch[1]) ? referenceDate.getFullYear() - 1 : referenceDate.getFullYear();
  } else if (shouldClampToPast(query)) {
    const candidateStart = new Date(year, startMonthIndex0, 1);
    if (candidateStart.getTime() > referenceDate.getTime()) {
      year -= 1;
    }
  }

  return {
    start: startOfMonth(toIso(new Date(year, startMonthIndex0, 1))),
    end: endOfMonth(toIso(new Date(year, endMonthIndex0, 1))),
  };
}

/**
 * "last year" combined with a day/time qualifier, computed directly from
 * `referenceDate` rather than through chrono's own parsing of the combined
 * phrase — verified live that chrono is inconsistent across word order for
 * this exact category: "last year same day" parses as two separate matches
 * chrono itself resolves correctly, but "this day last year" (same meaning,
 * different order) parses as ONE combined match chrono resolves to TODAY
 * with zero certainty, silently discarding the "last year" part entirely.
 * Detecting both pattern types independently and computing the anniversary
 * anchor directly (`referenceDate` minus exactly one year) sidesteps that
 * word-order sensitivity altogether — this function doesn't care where in
 * the sentence either phrase appears, only that both are present somewhere.
 * Runs BEFORE the general chrono-result flow below; a bare "last year" with
 * no day/time qualifier returns null here and falls through normally to get
 * the full-calendar-year widening instead.
 */
function resolveLastYearAnniversary(query: string, referenceDate: Date): DateRange | null {
  if (!LAST_YEAR_PATTERN.test(query)) {
    return null;
  }
  const anchorIso = toIso(new Date(referenceDate.getFullYear() - 1, referenceDate.getMonth(), referenceDate.getDate()));
  if (EXACT_DAY_QUALIFIER_PATTERN.test(query)) {
    return { start: anchorIso, end: anchorIso };
  }
  if (FUZZY_TIME_QUALIFIER_PATTERN.test(query)) {
    return { start: shiftIsoDate(anchorIso, -ANNIVERSARY_WINDOW_DAYS), end: shiftIsoDate(anchorIso, ANNIVERSARY_WINDOW_DAYS) };
  }
  return null;
}

/** See this file's own top doc comment's "CRITICAL" bullet — true when
 * nothing in the query explains why a resolved date would legitimately be
 * in the future (no explicit year, no forward-pointing word), meaning a
 * future result is chrono's own same-cycle-already-passed ambiguity rather
 * than the user genuinely asking about something upcoming. */
function shouldClampToPast(query: string): boolean {
  return !EXPLICIT_YEAR_PATTERN.test(query) && !FORWARD_INDICATOR_PATTERN.test(query);
}

export function detectQueryDateRange(query: string, referenceDate: Date): DateRange | null {
  const anniversaryRange = resolveLastYearAnniversary(query, referenceDate);
  if (anniversaryRange) {
    return anniversaryRange;
  }

  const monthRange = resolveMonthRangeReference(query, referenceDate);
  if (monthRange) {
    return monthRange;
  }

  const quarterRangeResult = resolveQuarterReference(query, referenceDate);
  if (quarterRangeResult) {
    return quarterRangeResult;
  }

  // "last/this week" — nothing in chrono's own result for this phrase
  // carries a usable certainty signal (see this file's own doc comment), so
  // it's matched directly rather than scored alongside the other results.
  if (WEEK_REFERENCE_PATTERN.test(query)) {
    const weekResults = chrono.parse(query, referenceDate, { forwardDate: false });
    const weekResult = weekResults.find((r) => /week/i.test(r.text));
    const anchor = weekResult ? toIso(weekResult.start.date()) : toIso(referenceDate);
    return weekRangeContaining(anchor);
  }

  const results = chrono.parse(query, referenceDate, { forwardDate: false });
  if (results.length === 0) {
    return null;
  }

  // Prefer the most specific result when a query produces more than one
  // independent match (see "27th September Sunday" in this file's own doc
  // comment) — day-level precision beats month, which beats year, which
  // beats a bare weekday with nothing else to anchor it.
  const ranked = [...results].sort((a, b) => {
    const specificity = (r: (typeof results)[number]) =>
      r.start.isCertain("day") ? 3 : r.start.isCertain("month") ? 2 : r.start.isCertain("year") ? 1 : 0;
    return specificity(b) - specificity(a);
  });
  const best = ranked[0];
  const clampAllowed = shouldClampToPast(query);

  if (best.start.isCertain("day")) {
    let startDate = best.start.date();
    if (clampAllowed && startDate.getTime() > referenceDate.getTime()) {
      startDate = new Date(startDate.getFullYear() - 1, startDate.getMonth(), startDate.getDate());
    }
    const startIso = toIso(startDate);
    const endIso = best.end ? toIso(best.end.date()) : startIso;
    return { start: startIso, end: endIso };
  }

  if (best.start.isCertain("month")) {
    const monthDate = best.start.date();
    const monthIndex0 = monthDate.getMonth();
    let year = monthDate.getFullYear();

    const explicitMonthQualifier = query.match(LAST_OR_THIS_MONTH_PATTERN);
    const yearModifierMatch = query.match(YEAR_MODIFIER_PATTERN);

    if (explicitMonthQualifier) {
      if (explicitMonthQualifier[1].toLowerCase() === "this") {
        year = referenceDate.getFullYear();
      } else {
        // "last <Month>" — the most recently COMPLETED occurrence: this
        // year's, if it's already passed; last year's otherwise.
        year = monthIndex0 <= referenceDate.getMonth() ? referenceDate.getFullYear() : referenceDate.getFullYear() - 1;
      }
    } else if (yearModifierMatch && MONTH_NAME_PATTERN.test(query)) {
      // "October last year" — see this file's own doc comment: chrono
      // resolves the bare month name against the CURRENT year independently
      // of the separate "last year"/"this year" match it also returns.
      // Overridden here with the explicit year modifier when both appear.
      year = /last/i.test(yearModifierMatch[1]) ? referenceDate.getFullYear() - 1 : referenceDate.getFullYear();
    } else if (clampAllowed && monthDate.getTime() > referenceDate.getTime()) {
      year -= 1;
    }
    return fullMonthRange(year, monthIndex0);
  }

  if (best.start.isCertain("year")) {
    const year = best.start.date().getFullYear();
    if (EXACT_DAY_QUALIFIER_PATTERN.test(query)) {
      const iso = toIso(best.start.date());
      return { start: iso, end: iso };
    }
    if (FUZZY_TIME_QUALIFIER_PATTERN.test(query)) {
      const anchorIso = toIso(best.start.date());
      return { start: shiftIsoDate(anchorIso, -ANNIVERSARY_WINDOW_DAYS), end: shiftIsoDate(anchorIso, ANNIVERSARY_WINDOW_DAYS) };
    }
    const earlyLateMatch = query.match(EARLY_LATE_YEAR_PATTERN);
    if (earlyLateMatch) {
      return earlyMidLateYearRange(year, earlyLateMatch[1]);
    }
    return fullYearRange(year);
  }

  // Nothing more specific than a bare weekday ("Sunday") with no day/month/
  // year certainty at all — weekdays cycle weekly, not yearly, so the clamp
  // steps back 7 days rather than a year.
  let weekdayDate = best.start.date();
  if (clampAllowed && weekdayDate.getTime() > referenceDate.getTime()) {
    weekdayDate = new Date(weekdayDate.getFullYear(), weekdayDate.getMonth(), weekdayDate.getDate() - 7);
  }
  const iso = toIso(weekdayDate);
  return { start: iso, end: iso };
}
