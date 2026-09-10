import * as chrono from "chrono-node";

import { DEFAULT_NOTIFICATION_TIME, RECURRENCE_OPTIONS, type Recurrence } from "../../db/schema";
import { runQueuedLlamaCompletion } from "./localLlama";
import { logDuration, nowMs } from "./perf";

/** One task pulled out of a note's raw text by extractToDosFromText(). Shape
 * matches services/todos/todoManager.ts's `AddToDoInput` 1:1 so the caller
 * (Phase 2's UI/save flow) can pass an item straight through. */
export type ExtractedToDo = {
  task: string;
  actionDate: string; // ISO YYYY-MM-DD
  /** Phase 2 Step 4: end of a date span ("from 27th Sep to 10th Oct"), or
   * null for a single-day to-do. See resolveDateAndTime's doc comment for
   * how this is derived — via chrono-node's own native range detection on
   * the SAME extracted phrase `actionDate` comes from, never a second field
   * asked of the model itself. */
  toDate: string | null;
  /** Phase 2 Step 4: 24-hour "HH:MM" local reminder time, extracted from an
   * explicitly spoken/typed clock time in the SAME phrase ("at 3:30 PM") —
   * see resolveDateAndTime's doc comment. Defaults to
   * DEFAULT_NOTIFICATION_TIME (05:00) when no time was mentioned. */
  notificationTime: string;
  recurrence: Recurrence;
  /** Multiplier on `recurrence`'s unit — see db/schema.ts's doc comment on
   * `recurrenceInterval`. Derived deterministically from the same date
   * phrase the model extracts (see resolveRecurrenceInterval below), never
   * asked of the LLM itself as a separate field — a numeric interval is one
   * more thing a 1B model would get wrong, on top of everything else this
   * file already had to move out of its hands. */
  recurrenceInterval: number;
};

/** Llama-3.2's instruct template stop marker — see localLlama.ts's own
 * EOT_TOKEN for why this has to be in `stop`. */
const EOT_TOKEN = "<|eot_id|>";

/**
 * GBNF grammar passed to llama.rn's `completion()` `grammar` option —
 * constrains token sampling so the model is STRUCTURALLY INCAPABLE of
 * producing anything other than a JSON array of objects matching this exact
 * shape (fixed key order: task, date_phrase, recurrence; recurrence
 * restricted to exactly the 4 enum strings). This is what finally closes
 * the class of bug every one of this file's earlier fixes could only ever
 * patch around one symptom at a time: a bare-prompt "please output ONLY
 * JSON" instruction is persuasion, not enforcement — the model can still
 * ignore it (confirmed on-device: a plain-prose reply with no JSON array at
 * all) or emit an invalid recurrence value. Grammar-constrained decoding
 * makes both of those impossible at the sampling level, for any model size,
 * not just this device's 1B — see this file's own git history for the
 * few-shot-patch approach this replaces for the STRUCTURAL half of the
 * problem (extractJsonArray's old prose-stripping fallback is gone; see its
 * own comment below for why it's no longer needed).
 *
 * Grammar can only enforce SYNTAX, never semantics — it guarantees every
 * object has a `recurrence` that's one of the four valid strings, but not
 * that the model chose the *correct* one for what the note actually said.
 * The recurrence lookup table and worked examples in buildSystemPrompt/
 * FEW_SHOT_EXAMPLES below are still doing real, distinct work (teaching
 * "every second Monday" means weekly-interval-2, not daily; teaching a
 * multi-task note needs every task extracted, not just the first) and
 * are deliberately NOT removed just because the grammar exists — only the
 * prose that was purely policing OUTPUT FORMAT (no prose, no code fences)
 * was safe to cut, since grammar makes that impossible to violate.
 *
 * Field is named `date_phrase`, not the literal `action_date` originally
 * specified for this step, to preserve a proven earlier fix: an LLM asked
 * to compute an absolute `action_date` itself is unreliable at date
 * arithmetic (confirmed on-device — see resolveDateAndTime's own comment),
 * so the model still only ever extracts the raw date phrase as written;
 * resolveDateAndTime() does the actual date math deterministically outside
 * the model, same as before this refactor. Reverting to a computed
 * `action_date` field here would silently undo that fix.
 *
 * Phase 2 Step 4 (date ranges, spoken times, notifications) deliberately
 * did NOT add separate `from_date`/`to_date`/`notification_time` fields to
 * this grammar, even though the feature spec that requested it asked for
 * exactly that shape. Doing so would have meant asking the model to split
 * ONE range/time mention ("from 27th Sep to 10th Oct at 3:30 PM") into two
 * or three independently-copied substrings and, for the date fields,
 * compute/normalize them into `YYYY-MM-DD` itself — reintroducing the
 * precise date-arithmetic-and-splitting unreliability the `date_phrase`
 * redesign above already exists to avoid (see commit `ca66581`'s history:
 * "pay rent on the 1st of every month" asked on Sep 9 came back as
 * "2026-11-01", one month too far, when the model computed it directly).
 * Instead, `date_phrase` alone now also carries a range or a time when the
 * note mentions one — the model's job stays "copy the whole span verbatim,"
 * unchanged in kind, and resolveDateAndTime() below does the actual
 * range/time extraction deterministically via chrono-node's own native
 * support for exactly this ("from X to Y" ranges, explicit clock times),
 * the same pre-pass-and-reconcile architecture the whole date_phrase
 * pipeline already uses (see detectDatePhrases's doc comment).
 *
 * Built from llama.cpp's own canonical JSON primitive rules (`string`/
 * `char`, taken from its `json-schema-to-grammar.cpp`) rather than
 * hand-rolled ones, since a subtly wrong string/escape rule is the easiest
 * way for a hand-written grammar to misbehave.
 */
const TODO_EXTRACTION_GRAMMAR = String.raw`
root       ::= "[" ws ( item ( "," ws item )* )? ws "]"
item       ::= "{" ws "\"task\"" ws ":" ws string ws "," ws "\"date_phrase\"" ws ":" ws string ws "," ws "\"recurrence\"" ws ":" ws recurrence ws "}"
string     ::= "\"" char* "\""
char       ::= [^"\\\x7F\x00-\x1F] | "\\" (["\\bfnrt] | "u" [0-9a-fA-F]{4})
recurrence ::= "\"none\"" | "\"daily\"" | "\"weekly\"" | "\"monthly\""
ws         ::= [ \t\n]*
`;

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso(): string {
  return formatIsoDate(new Date());
}

function parseIsoDateLocal(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Next calendar date landing on `dayOfMonth`, strictly after `from`. Rolls
 * to next month whenever `from`'s day-of-month has already reached
 * `dayOfMonth` this month. Used for the "the 1st"/"the 15th" style bare
 * day-of-month phrasing that chrono-node can't reliably resolve on its own
 * (see resolveDateAndTime's own comment for why this exists alongside it). */
function nextDayOfMonth(from: Date, dayOfMonth: number): Date {
  const candidate = new Date(from.getFullYear(), from.getMonth(), dayOfMonth);
  if (candidate <= from) {
    candidate.setMonth(candidate.getMonth() + 1);
  }
  return candidate;
}

/** Matches a bare day-of-month reference with no month attached — "the
 * 1st", "1st of every month", "on the 15th", "day 1" — the one common
 * phrasing chrono-node (see resolveDateAndTime) doesn't resolve to a sane
 * future date on its own (tested on-device: it either returns null or
 * silently adds a month while keeping today's day-of-month, e.g. "1st of
 * the month" from Sep 9 came back Oct 9, not Oct 1). */
const BARE_DAY_OF_MONTH_PATTERN = /\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)?\b(?!\s*(?:am|pm|:))/i;

/**
 * Resolves the model's extracted natural-language date reference into a
 * concrete ISO date. This is the fix for a real on-device bug: the previous
 * version of this file asked the LLM to compute the absolute action_date
 * itself, and a 1B/3B instruct model is unreliable at date ARITHMETIC even
 * when it correctly understands the note's language — confirmed on-device,
 * "pay rent on the 1st of every month" (asked on Sep 9) came back as
 * "2026-11-01" (one month too far) despite the model correctly identifying
 * the task and recurrence.
 *
 * The fix moves arithmetic out of the model entirely: the model's only job
 * (see buildSystemPrompt) is to extract the literal date phrase as it
 * appears in the note (or "" if none is mentioned) — a much easier,
 * near-copy-paste extraction task — and this function resolves that phrase
 * deterministically:
 *  1. Empty phrase → today (no date was mentioned).
 *  2. A bare day-of-month with no month attached ("the 1st", "1st of every
 *     month") → nextDayOfMonth() above, since chrono-node doesn't handle
 *     this phrasing reliably on its own (tested — see BARE_DAY_OF_MONTH_PATTERN
 *     doc comment for the exact failures observed).
 *  3. Everything else (weekday names, "tomorrow", "March 3rd", full dates)
 *     → chrono-node's `parseDate` with `forwardDate: true`, which resolves
 *     an otherwise-past-implied date to its next future occurrence — exactly
 *     the "next upcoming occurrence" rule this module needs, and something
 *     chrono-node (a dedicated, battle-tested date-parsing library) is far
 *     more reliable at than a 1B language model doing arithmetic by "feel."
 *  4. Anything chrono-node can't parse at all → today, same safe fallback as
 *     an empty phrase, rather than leaving the to-do dateless.
 */
/**
 * Deterministically finds every date/time expression chrono-node can
 * identify in the raw note text, independent of the LLM entirely — the fix
 * for the actual scaling problem with the few-shot-example approach below
 * (see FEW_SHOT_EXAMPLES's own doc comment): teaching the model one more
 * phrasing shape at a time only ever covers the exact shapes someone
 * happened to hit on-device, and inflates the prompt (more tokens, more
 * TTFT on mobile hardware) forever without ever generalizing. chrono-node
 * is a dedicated, actively maintained date-parsing library — running it
 * directly on the raw note BEFORE the LLM call turns "recall this
 * substring from scratch" (what a 1B model keeps missing — see the
 * "Book a movie ticket this Friday." on-device repro) into "select one of
 * these already-found candidates" (a much easier task for a small model),
 * and covers whatever phrasing chrono itself can parse, not just phrasings
 * this file has a dedicated example for.
 *
 * `{ forwardDate: true }` matches resolveDateAndTime's own chrono options —
 * a bare "Friday" should be treated as the NEXT Friday, and detection
 * should agree with resolution about what counts as a valid reference.
 *
 * Returns unique, trimmed `.text` substrings only (not parsed Date
 * objects) — normalizeExtracted only needs to know what substrings are
 * legitimate to hand back as a task's date_phrase; the actual date
 * arithmetic still happens exactly once, in resolveDateAndTime, unchanged.
 */
function detectDatePhrases(rawText: string, todayISO: string): string[] {
  const referenceDate = parseIsoDateLocal(todayISO);
  const results = chrono.parse(rawText, referenceDate, { forwardDate: true });

  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const result of results) {
    const text = result.text.trim();
    const key = text.toLowerCase();
    if (text && !seen.has(key)) {
      seen.add(key);
      phrases.push(text);
    }
  }
  return phrases;
}

/** Matches "every 3 days"/"every 2 weeks"/"every 6 months" — shared between
 * resolveRecurrenceInterval (where it reads off the interval number) and
 * resolveDateAndTime below (where it flags a phrase chrono-node would
 * otherwise misread — see that function's own doc comment for the
 * confirmed on-device bug this guards against). Kept as one exported-within-
 * file constant specifically so the two can never drift into checking
 * subtly different things. */
const NUMERIC_RECURRENCE_INTERVAL_PATTERN = /every\s+(\d+)\s*(?:day|week|month)/;

function formatHHMM(date: Date): string {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

/** Resolved shape of a date_phrase — see ExtractedToDo's own doc comments
 * on `toDate`/`notificationTime` for what each field means. */
type ResolvedDateInfo = {
  actionDate: string;
  toDate: string | null;
  notificationTime: string;
};

/**
 * Resolves the model's extracted natural-language date_phrase into concrete
 * `actionDate`/`toDate`/`notificationTime` values — deterministically,
 * outside the model, for the exact same reason this file has never asked
 * the model to compute dates itself (see this function's own history: "pay
 * rent on the 1st of every month" asked on Sep 9 once came back as
 * "2026-11-01" when a 1B model tried the arithmetic directly).
 *
 * Phase 2 Step 4 extends this beyond a single date: chrono-node has native
 * support for BOTH date ranges ("27th Sep to 10th Oct" parses as one result
 * with a `.start` AND a `.end`) and explicit clock times attached to either
 * end (`.start`/`.end` each expose `.isCertain('hour')`, true only when a
 * time was actually stated, never chrono's own default fill-in) — so asking
 * the model for a single `date_phrase` covering the whole span, same as
 * before this step, is enough; chrono does the actual splitting.
 *
 * Time-of-day resolution deliberately checks `end` before `start`: for a
 * range phrase, an explicit time reads as describing the range's END
 * ("...to 10th Oct at 3:30 PM" — confirmed via chrono itself: parsing that
 * exact phrase puts `isCertain('hour')` on `.end`, not `.start`) — a single-
 * date phrase has no `.end` at all, so `.start` is always what's checked in
 * that case regardless of this ordering.
 *
 *  1. Empty phrase → today, no range, default notification time.
 *  2. A bare day-of-month with no month attached ("the 1st", "1st of every
 *     month") → nextDayOfMonth() below, since chrono-node doesn't handle
 *     this phrasing reliably on its own (see BARE_DAY_OF_MONTH_PATTERN's own
 *     doc comment) — no range/time information is available on this path.
 *  3. Everything else → chrono-node's `parse()` (not just `parseDate()`, so
 *     `.end`/`.isCertain()` are available) with `forwardDate: true`.
 *  4. Anything chrono-node can't parse at all → today, same safe fallback as
 *     an empty phrase, rather than leaving the to-do dateless.
 *
 * `recurrence` is a required third argument, not an afterthought — a real
 * bug confirmed on-device (and still present, unaffected by this file's
 * earlier `ae2f8ac`/`6e59636` fixes, since those only ever gated the
 * chrono-based single-candidate AUTO-FILL, not this function itself): a
 * numeric interval cadence like "every 3 days" contains a bare number
 * chrono-node reads as a RELATIVE OFFSET ("3 days from today") rather than
 * recognizing it's part of a repeat rule with no specific start date at
 * all — confirmed directly, `chrono.parse("every 3 days", ...)` matches
 * just the fragment "3 days" and resolves it to 3 days from now. The exact
 * same trap catches "every second Monday"/"every Monday night" (chrono
 * resolves those to the next actual Monday). For any task whose recurrence
 * isn't "none" AND whose phrase matches NUMERIC_RECURRENCE_INTERVAL_PATTERN
 * specifically (a bare digit, the one shape that's unambiguously a
 * cadence-internal number rather than a real calendar reference — "every
 * Monday" is deliberately left alone below, since chrono resolving that to
 * "the next Monday" is a reasonable, arguably CORRECT default start date
 * for a weekly reminder, not a confirmed bug the way the numeric case is),
 * the chrono-derived DATE is discarded in favor of today — recurring
 * to-dos already start "today" by default everywhere else in this app's
 * model (see todoManager.ts's `computeNextActionDate`). An explicit TIME
 * mentioned in the same phrase ("every day at 6am") is still honored,
 * since chrono's time-of-day detection isn't part of this same trap
 * (confirmed: `chrono.parse("every day at 6am", ...)` correctly returns
 * `isCertain('hour') === true` with hour 6).
 */
function resolveDateAndTime(datePhrase: string, todayISO: string, recurrence: Recurrence): ResolvedDateInfo {
  const trimmed = datePhrase.trim();
  if (!trimmed) {
    return { actionDate: todayISO, toDate: null, notificationTime: DEFAULT_NOTIFICATION_TIME };
  }

  const today = parseIsoDateLocal(todayISO);

  const bareDayMatch = trimmed.match(BARE_DAY_OF_MONTH_PATTERN);
  const results = chrono.parse(trimmed, today, { forwardDate: true });
  const result = results[0];

  // Only treat this as a bare day-of-month if chrono itself finds no
  // parseable date in the phrase — a phrase like "March 3rd" also matches
  // the bare-day regex on its "3rd", but chrono correctly resolves the
  // whole "March 3rd" and should win.
  if (!result && bareDayMatch) {
    const day = Number(bareDayMatch[1]);
    if (day >= 1 && day <= 31) {
      return {
        actionDate: formatIsoDate(nextDayOfMonth(today, day)),
        toDate: null,
        notificationTime: DEFAULT_NOTIFICATION_TIME,
      };
    }
  }

  if (!result) {
    return { actionDate: todayISO, toDate: null, notificationTime: DEFAULT_NOTIFICATION_TIME };
  }

  const timeComponent = result.end?.isCertain("hour") ? result.end : result.start;
  const notificationTime = timeComponent.isCertain("hour") ? formatHHMM(timeComponent.date()) : DEFAULT_NOTIFICATION_TIME;

  if (recurrence !== "none" && NUMERIC_RECURRENCE_INTERVAL_PATTERN.test(trimmed.toLowerCase())) {
    return { actionDate: todayISO, toDate: null, notificationTime };
  }

  return {
    actionDate: formatIsoDate(result.start.date()),
    toDate: result.end ? formatIsoDate(result.end.date()) : null,
    notificationTime,
  };
}

/** Ordinal/relative words meaning "every OTHER occurrence" or beyond —
 * "every second Monday"/"every other week" both mean interval 2, same as
 * the standard iCalendar RRULE INTERVAL semantics this whole scheme mirrors
 * (see db/schema.ts's `recurrenceInterval` doc comment). Deliberately
 * excludes "first"/"1st" — "every first Monday of the month" is a distinct,
 * more complex pattern (nth-weekday-of-month) this schema doesn't attempt
 * to represent; it falls through to the interval-1 default below instead of
 * being misread as interval 1 with false confidence. */
const ORDINAL_WORD_TO_INTERVAL: Record<string, number> = {
  other: 2,
  second: 2,
  "2nd": 2,
  two: 2,
  third: 3,
  "3rd": 3,
  three: 3,
  fourth: 4,
  "4th": 4,
  four: 4,
  fifth: 5,
  "5th": 5,
  five: 5,
};

/**
 * Derives the recurrence interval multiplier from the SAME date phrase
 * resolveDateAndTime already reads — never a separate field asked of the
 * model (see ExtractedToDo's doc comment on why). Three cases, in order:
 *
 *  1. An explicit number ("every 2 weeks", "every 3 months") — used as-is.
 *  2. An ordinal/relative word ("every second Monday", "every other week",
 *     "every third day") — looked up in ORDINAL_WORD_TO_INTERVAL above.
 *     This is the direct fix for an on-device bug: "every second Monday"
 *     was previously classified as recurrence "daily" with no interval
 *     concept to fall back on at all; it's now "weekly" + interval 2, i.e.
 *     an exact "every 2 weeks" schedule instead of a wrong one.
 *  3. A named calendar unit the 4-value `recurrence` enum has no exact
 *     bucket for ("quarterly", "yearly") — expressed as a multiple of the
 *     closest bucket buildSystemPrompt already maps it to (monthly), so
 *     what used to be a lossy approximation (quarterly rounded down to
 *     plain monthly) is now exact: quarterly → monthly × 3, yearly →
 *     monthly × 12. `recurrence` itself doesn't change; only how many
 *     months to add each time does.
 *
 * Returns 1 (i.e. "every single occurrence of the unit", the pre-interval
 * behavior) when nothing above matches, or when `recurrence` is "none"
 * (an interval is meaningless on a task that doesn't repeat at all).
 */
function resolveRecurrenceInterval(datePhrase: string, recurrence: Recurrence): number {
  if (recurrence === "none") {
    return 1;
  }

  const lower = datePhrase.trim().toLowerCase();
  if (!lower) {
    return 1;
  }

  const numericMatch = lower.match(NUMERIC_RECURRENCE_INTERVAL_PATTERN);
  if (numericMatch) {
    const n = Number(numericMatch[1]);
    if (n >= 1) {
      return n;
    }
  }

  const wordMatch = lower.match(/every\s+(other|second|2nd|two|third|3rd|three|fourth|4th|four|fifth|5th|five)\b/);
  if (wordMatch) {
    return ORDINAL_WORD_TO_INTERVAL[wordMatch[1]] ?? 1;
  }

  if (recurrence === "weekly" && /fortnight|bi-?weekly/.test(lower)) {
    return 2;
  }
  if (recurrence === "monthly") {
    if (/quarter(ly)?/.test(lower)) {
      return 3;
    }
    if (/\b(year|annual)/.test(lower)) {
      return 12;
    }
  }

  return 1;
}

/**
 * Every phrase pattern that legitimately means "this task repeats," used as
 * a deterministic cross-check on the model's own recurrence classification
 * (see hasRecurrenceEvidence below) — deliberately the same vocabulary
 * buildSystemPrompt's recurrence table teaches the model to recognize, kept
 * here too so the check and the instruction never silently drift apart.
 */
const RECURRENCE_EVIDENCE_PATTERN =
  /\bevery\s*(?:day|morning|night|evening|week|weekend|month|quarter|year)\b|\beach\s*(?:day|week|month)\b|\bevery\s+\d+\s*(?:day|week|month)s?\b|\bevery\s+(?:other|second|2nd|third|3rd|fourth|4th|fifth|5th)\s+(?:day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\bevery\s+(?:mon|tues?|wednes|thurs?|fri|satur|sun)day\b|\bdaily\b|\beveryday\b|\bweekly\b|\bmonthly\b|\bquarterly\b|\byearly\b|\bannually\b|\bfortnightly\b|\bbi-?weekly\b/i;

/**
 * Deterministic safety net for a distinct, repeated on-device failure mode
 * from the date-phrase one resolveDateAndTime exists for: the model false-
 * triggering a non-"none" recurrence with NO actual repeating language
 * anywhere in the note, apparently from the TASK'S SUBJECT MATTER alone
 * ("renew" reads as subscription-like) rather than its wording. Confirmed
 * on-device, repeatedly, even after a dedicated few-shot example using this
 * exact note and even under fully greedy (temperature: 0) decoding — a
 * consistent wrong answer is still wrong, so at some point this stops being
 * a prompt-engineering problem and becomes a case for the same principle
 * resolveDateAndTime already applies to dates: don't trust the model's
 * judgment on something a plain deterministic check can verify instead.
 *
 * This checks the FULL raw note text, not just the one task's date_phrase —
 * a real recurring task's own trigger phrase might sit elsewhere in a
 * multi-task note, so checking only the date_phrase would false-flag those.
 * The trade-off: for a multi-task note where a DIFFERENT task genuinely
 * recurs, this can't tell that task's language apart from this one's, so a
 * false positive there would survive. That's an accepted, non-regressive
 * gap — this check only ever moves a recurrence value TOWARD "none" for
 * notes with zero recurring language anywhere, never away from a value a
 * legitimate trigger phrase actually earned.
 */
function hasRecurrenceEvidence(rawNoteText: string): boolean {
  return RECURRENCE_EVIDENCE_PATTERN.test(rawNoteText);
}

/**
 * System prompt for structured extraction, not conversation. Grammar-
 * constrained decoding (see TODO_EXTRACTION_GRAMMAR above) now guarantees
 * the OUTPUT FORMAT — valid JSON array, exact three keys, recurrence
 * restricted to the 4 valid strings — so this prompt no longer needs to
 * police that ("respond with ONLY a raw JSON array, no prose, no code
 * fences" and its variants are gone). What's left is everything grammar
 * CAN'T enforce: what each field actually MEANS, and the semantic judgment
 * calls behind recurrence classification — those are still entirely on the
 * model, and still need real instruction, not just a schema.
 *
 * `detectedPhrases` (see detectDatePhrases above) is injected here as an
 * "answer key" for date_phrase specifically — the one field a small model
 * keeps failing to recall correctly from scratch. This does NOT replace
 * normalizeExtracted's own reconciliation against the same list (a prompt
 * is a request, not a guarantee — grammar is the only thing that's ever
 * actually enforced in this file); it's the other half of the same fix,
 * giving the model its best shot at getting date_phrase right in the first
 * place instead of relying entirely on the deterministic single-candidate
 * fallback to correct it after the fact.
 */
function buildSystemPrompt(todayISO: string, detectedPhrases: string[]): string {
  const detectedPhrasesBlock =
    detectedPhrases.length > 0
      ? "A separate, exact string-matching pass already found these date/time phrases in this note — " +
        "treat this as your answer key: " +
        JSON.stringify(detectedPhrases) +
        ". For every task that has a date, `date_phrase` MUST be copied EXACTLY character-for-character " +
        "from this list — never write it slightly differently, never invent a phrase that isn't in this " +
        "list, and never leave date_phrase empty if one of these phrases clearly belongs to that task. If " +
        "a task genuinely has no date of its own, still use \"\" even though other phrases were detected " +
        "elsewhere in the note." +
        (detectedPhrases.length > 1
          ? " More than one phrase is listed here because the note mentions more than one date — pick " +
            "ONLY the one that says when the task ITSELF must be done, never one that's just explaining " +
            "why the task exists (an expiry date is context, not a due date; see the rule below about " +
            "this exact trap)."
          : "") +
        "\n\n"
      : "";

  return (
    "You are a task-extraction engine for a personal notes app. Read the note text the user " +
    "provides and extract EVERY actionable to-do item mentioned in it — an actionable item is " +
    "something the user needs to DO, not just something they mentioned in passing. A note very " +
    "often names several separate tasks run together in one sentence, joined by \"and\", \"also\", " +
    "\"and also\", or just commas, with no sentence break between them — extract EACH one as its own " +
    "array entry. Never stop after the first task you find; keep reading to the end of the note and " +
    "list all of them, however many there are.\n\n" +
    `Today's Date: ${todayISO}\n\n` +
    detectedPhrasesBlock +
    "Each item has three fields:\n" +
    '  "task": a short, clear description of the action item\n' +
    '  "date_phrase": the date/time reference exactly as it appears in the note (e.g. "tomorrow", ' +
    '"next Friday", "the 1st of every month", "March 3rd") — or an empty string "" if the task has ' +
    "no date mentioned at all. Copy the phrase as written; do NOT calculate or convert it into a " +
    "calendar date yourself. If the note gives a DATE RANGE for the task (\"from the 27th to the " +
    "3rd\", \"27th Sep to 10th Oct\") or an explicit CLOCK TIME (\"at 3:30 PM\", \"at 9am\"), copy " +
    "the WHOLE span into this one field exactly as written, including the range's \"to\" and the " +
    "time's \"at\" — never split a range or a time off into a separate answer, and never invent a " +
    "time that isn't actually stated.\n" +
    '  "recurrence": "none", "daily", "weekly", or "monthly"\n\n' +
    "How to choose recurrence — the schema only has FOUR values, so map whatever cadence the task " +
    "actually describes onto the CLOSEST one of these four. Match against every row below, not just " +
    "the first one that looks similar:\n" +
    '  → "daily":   "every day", "each day", "daily", "everyday", "every morning", "every night",\n' +
    '               "every evening", "every X hours", "a few times a day", "twice a day"\n' +
    '  → "weekly":  "every Monday" / "every Friday night" / any SPECIFIC weekday name — this always\n' +
    "               means once every 7 days, never daily. Also: \"every week\", \"weekly\", \"each\n" +
    '               week", "every weekend", "every other week", "every second week", "every second\n' +
    '               Monday" (any weekday), "fortnightly", "biweekly" — all of these are technically\n' +
    "               every 2 weeks, but weekly is the closest of the four options, so use it. The word\n" +
    '               "second" in "every second Monday"/"every second week" means "every OTHER" — it is\n' +
    "               NOT a unit of time and must never be read as \"frequently\"/\"daily\".\n" +
    '  → "monthly": "every month", "monthly", "each month", "the 1st/15th/etc. of every month",\n' +
    '               "every quarter", "quarterly", "every 3 months", "every year", "yearly",\n' +
    "               \"annually\" (yearly/quarterly have no exact match among the four options —\n" +
    '               monthly is the closest, so use it).\n' +
    '  → "none":    the task has NO repeating language at all — this is the default; also use "none" ' +
    "for a task tied to a SINGLE specific occurrence (\"this Monday\", \"next Monday\", \"on Friday\", " +
    "\"this weekend\") — those are one-off dates that happen to fall on a named day, not a repeating " +
    "schedule, and must never be confused with \"every Monday\" wording. Also use \"none\" for a task " +
    "that repeats only in response to an event rather than a time interval (\"every time I see the " +
    "dentist\", \"whenever it rains\") — there's no calendar cadence to schedule there.\n\n" +
    "Rules:\n" +
    "- \"none\" is the default for every task. Only move off it when THAT task's own wording, read " +
    "on its own, clearly says it repeats on a time-based schedule — never because a different task in " +
    "the same note repeats, and never because an earlier example happened to use a non-\"none\" " +
    "value. Judge every task by its own words alone.\n" +
    "- A specific weekday (\"every Monday\", \"every Friday\") is WEEKLY, never daily — daily means " +
    "literally every single day, not once a week on a named day. A single mention of a weekday with " +
    "no \"every\"/\"each\" attached (\"call him Friday\", \"next Monday\") is a one-off date, not " +
    "recurring at all — set recurrence to \"none\" for those.\n" +
    "- A word describing what kind of task it is (\"renew\", \"expire\", \"expiring\", \"due\", " +
    "\"subscription\", \"deadline\") does NOT by itself mean the task repeats, even though the real-world " +
    "thing it's about (passports, memberships, licenses) often does. \"Renew the passport in October\" " +
    "is a single one-off reminder to do that ONE renewal — recurrence is \"none\" — unless the note " +
    "ALSO contains actual repeating language (\"every year\") separately.\n" +
    "- A note may mention more than one date for context (e.g. when something expires) while only one " +
    "of them is when the TASK itself should happen. Use the date attached to the action the user needs " +
    "to DO, never a date that's only explaining why the task exists.\n" +
    "- Never invent a date phrase that isn't actually in the note — leave date_phrase empty instead.\n\n" +
    "If the note contains no actionable to-do items at all, respond with exactly: []"
  );
}

/**
 * Eight fixed one-shot examples, injected as real prior user/assistant turns —
 * same technique localLlama.ts's RAG prompt already relies on (see its own
 * FEW_SHOT_* comment for why a demonstrated turn steers a small instruct
 * model far more reliably than the same instruction written as prose).
 * Deliberately KEPT after adding TODO_EXTRACTION_GRAMMAR above, not stripped
 * as prompt bloat — every one of these teaches a semantic judgment call
 * (which of 4 buckets a cadence maps to, whether a note has 1 task or 3,
 * one-off vs. recurring) that grammar-constrained decoding cannot enforce;
 * grammar only guarantees the OUTPUT is syntactically valid, never that the
 * model chose semantically correctly. Only the format-policing PROSE
 * ("respond with ONLY a raw JSON array...") was safe to cut for being made
 * redundant by grammar — see TODO_EXTRACTION_GRAMMAR's own comment.
 *
 * Every entry except MULTI_TASK (see below) is deliberately a SEPARATE
 * single-item turn rather than folded into one combined multi-item list —
 * the original version of this fix used one combined 3-item example, and
 * on-device testing found the model didn't apply per-item judgment at all:
 * a real 3-task note with no dates and no recurring language on any task
 * came back with task 1 correctly "none", but tasks 2 and 3 as "daily" and
 * "monthly" respectively — i.e. it pattern-matched the combined example's
 * fixed shape (item 2 always "monthly") rather than reading each task's own
 * words. Giving each recurrence value its own dedicated single-item turn
 * removes that positional shape for the model to copy.
 *
 * The bins/"every Monday night" entry directly demonstrates the exact
 * on-device miss that prompted that fix: it was previously misclassified as
 * "daily" — this turn shows that precise phrasing resolves to "weekly".
 *
 * The yellow-bins/"every second Monday" entry exists because the prose rule
 * about "second" meaning "every other" (see buildSystemPrompt's weekly row)
 * was not enough on its own — confirmed on-device, twice, with the model
 * defaulting to recurrence "none" and an empty date phrase entirely rather
 * than picking a wrong-but-present answer. "Every second Monday" is
 * genuinely ambiguous English even to a human reader (it can mean "every
 * OTHER Monday" — biweekly, this app's intended reading — or "the 2nd
 * Monday of the month," an ordinal-position pattern this schema doesn't
 * represent at all), and a small model facing real ambiguity with no
 * worked example to anchor on appears to have punted rather than guessed
 * either reading. A concrete demonstration, not more prose, is what
 * actually resolves that kind of ambiguity for a model this size.
 *
 * The "call him this Friday" entry demonstrates the other real confusion
 * the recurrence table above calls out explicitly: a weekday mentioned
 * WITHOUT "every"/"each" is a single one-off date, not a recurring
 * schedule — easy for a small model to conflate with the "every Friday"
 * example elsewhere in this list, so it gets its own side-by-side
 * demonstration rather than relying on the prose rule alone.
 *
 * MULTI_TASK (second entry) fixes a regression the single-item rework
 * above accidentally introduced: once every few-shot example showed
 * exactly one output item, the model started treating "one item per note"
 * as the pattern to copy — a genuinely multi-task voice note ("call the
 * carpenter and also withdraw cash and also buy milk") came back with only
 * the LAST task extracted, logged as "1/1 saved" (i.e. the model's own raw
 * output only ever contained one item — this wasn't a parsing loss
 * downstream). This example demonstrates pulling three tasks out of one
 * run-on "and also" sentence, matching the exact shape of the real
 * failure. It deliberately gives every item the SAME recurrence ("none")
 * so there's no per-position value pattern here either — extraction
 * completeness and per-item recurrence judgment are taught as two
 * independent lessons, never blended into one example that could
 * accidentally re-teach the original positional-copying bug.
 *
 * The Shivanya's-passport entry (last) fixes a third, distinct failure mode
 * from the first two: a false-positive recurrence triggered by the TASK'S
 * SUBJECT MATTER rather than any actual repeating language. On-device, this
 * exact note (a one-off passport renewal, no repeating words anywhere in
 * it) came back with recurrence "monthly" — almost certainly because
 * "renew" is a word strongly associated with recurring things (subscriptions,
 * memberships) in the model's training data, even though nothing in this
 * particular note says it repeats. The note also contains TWO dates (the
 * passport's December expiry, and the October date the reminder should
 * actually fire on), which is its own trap: extract the wrong one and the
 * reminder fires when the passport is *about to be already expired*
 * instead of a month ahead of that. This example demonstrates both fixes
 * at once — recurrence "none" despite "renew," and the October phrase
 * (not December) as date_phrase — since they're two symptoms of the same
 * note in the on-device report, not because they need to be taught
 * together in general.
 */
const FEW_SHOT_EXAMPLES: { input: string; answer: string }[] = [
  {
    input: "Remind me to call the dentist tomorrow.",
    answer: JSON.stringify([{ task: "Call the dentist", date_phrase: "tomorrow", recurrence: "none" }]),
  },
  {
    input:
      "Remind me to call the carpenter and also withdraw cash using the FX card and also buy milk on the way back home.",
    answer: JSON.stringify([
      { task: "Call the carpenter", date_phrase: "", recurrence: "none" },
      { task: "Withdraw cash using the FX card", date_phrase: "", recurrence: "none" },
      { task: "Buy milk", date_phrase: "", recurrence: "none" },
    ]),
  },
  {
    input: "I need to put the bins out every Monday night.",
    answer: JSON.stringify([
      { task: "Put the bins out", date_phrase: "every Monday night", recurrence: "weekly" },
    ]),
  },
  {
    input: "Remind me to put the yellow bins out every second Monday.",
    answer: JSON.stringify([
      { task: "Put the yellow bins out", date_phrase: "every second Monday", recurrence: "weekly" },
    ]),
  },
  {
    input: "Don't forget to pay the rent on the 1st of every month.",
    answer: JSON.stringify([
      { task: "Pay the rent", date_phrase: "the 1st of every month", recurrence: "monthly" },
    ]),
  },
  {
    input: "I should call mom.",
    answer: JSON.stringify([{ task: "Call mom", date_phrase: "", recurrence: "none" }]),
  },
  {
    input: "I need to call him this Friday about the invoice.",
    answer: JSON.stringify([
      { task: "Call him about the invoice", date_phrase: "this Friday", recurrence: "none" },
    ]),
  },
  {
    input:
      "Shivanya's passport is going to expire in December and so I need a reminder for getting it renewed in the first week of October.",
    answer: JSON.stringify([
      { task: "Renew Shivanya's passport", date_phrase: "the first week of October", recurrence: "none" },
    ]),
  },
  {
    // Confirmed on-device miss: every other example above is a full
    // sentence with "I need to"/"remind me to" framing, and the date phrase
    // always has more words trailing after it ("...this Friday about the
    // invoice"). A bare imperative note with NO framing verb, ending
    // directly on the date with nothing after it — the exact shape a short
    // voice-note transcript naturally takes — came back with date_phrase ""
    // every time (temperature: 0, fully reproducible) despite the phrase
    // being right there in the text. This turn demonstrates that shape
    // specifically: no "I need to"/"remind me", date phrase as the very
    // last words before the period.
    input: "Pick up the dry cleaning this Saturday.",
    answer: JSON.stringify([{ task: "Pick up the dry cleaning", date_phrase: "this Saturday", recurrence: "none" }]),
  },
  {
    // Confirmed on-device miss, found via the numeric-interval edge case:
    // "Water the plants every 3 days." classified recurrence "daily"
    // correctly but left date_phrase empty — with nowhere for the "every 3
    // days" text to live, resolveRecurrenceInterval's numeric-match regex
    // (which reads FROM date_phrase, see its own comment) had nothing to
    // find and silently fell back to interval 1, losing the "every 3" part
    // entirely. No prior example demonstrated a purely NUMERIC cadence
    // ("every N days/weeks/months") being retained in date_phrase at all —
    // only word-based ordinals ("every second Monday") had one. This also
    // matters structurally: chrono-node has no concept of a recurrence
    // cadence (it only finds one-off calendar dates), so unlike a one-off
    // date phrase, a recurring cadence phrase can ONLY ever reach
    // date_phrase via the model itself getting it right — there's no
    // deterministic detection layer backing this one up.
    input: "Water the plants every 3 days.",
    answer: JSON.stringify([{ task: "Water the plants", date_phrase: "every 3 days", recurrence: "daily" }]),
  },
  {
    // Confirmed on-device miss: a genuinely multi-task note where only the
    // LAST-mentioned task carries a trailing date came back with EVERY
    // task's date_phrase empty, even with that date listed in the prompt's
    // detected-phrases hint — the model didn't attach it to any of them.
    // Assigning it correctly here is a task-to-date ASSIGNMENT judgment call
    // (which of several tasks does this one date belong to), a different
    // problem from copying a phrase verbatim — chrono-node's detection pass
    // has no notion of "task" at all, so this one is squarely on the model,
    // same as recurrence classification. This demonstrates the common
    // English pattern the miss came from: a comma/"and also"-joined list of
    // tasks with one trailing date at the very end modifying only the task
    // immediately before it, not the earlier ones.
    input: "Pick up the dry cleaning, call the plumber, and also finish the tax return by Monday.",
    answer: JSON.stringify([
      { task: "Pick up the dry cleaning", date_phrase: "", recurrence: "none" },
      { task: "Call the plumber", date_phrase: "", recurrence: "none" },
      { task: "Finish the tax return", date_phrase: "Monday", recurrence: "none" },
    ]),
  },
  {
    // Phase 2 Step 4: date ranges + explicit clock times. Demonstrates the
    // new buildSystemPrompt rule ("copy the WHOLE span... including the
    // range's 'to' and the time's 'at'") with a shape chrono-node's own
    // native range/time detection can then split deterministically — see
    // resolveDateAndTime's doc comment. The model's job is unchanged in
    // kind from every other example here (copy verbatim, don't compute);
    // only the span being copied is now allowed to be longer than one date.
    input: "Submit the tax report from 27th September to 10th October at 3:30 PM.",
    answer: JSON.stringify([
      { task: "Submit the tax report", date_phrase: "27th September to 10th October at 3:30 PM", recurrence: "none" },
    ]),
  },
];

function buildPrompt(rawText: string, todayISO: string, detectedPhrases: string[]): string {
  const fewShotTurns = FEW_SHOT_EXAMPLES.map(
    ({ input, answer }) =>
      "<|start_header_id|>user<|end_header_id|>\n\n" +
      `${input}${EOT_TOKEN}` +
      "<|start_header_id|>assistant<|end_header_id|>\n\n" +
      `${answer}${EOT_TOKEN}`
  ).join("");

  return (
    "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n" +
    `${buildSystemPrompt(todayISO, detectedPhrases)}${EOT_TOKEN}` +
    fewShotTurns +
    "<|start_header_id|>user<|end_header_id|>\n\n" +
    `${rawText}${EOT_TOKEN}` +
    "<|start_header_id|>assistant<|end_header_id|>\n\n"
  );
}

/**
 * Parses the model's completion as JSON directly — no more scanning for a
 * "[" ... "]" substring. That scan existed only to recover a JSON array a
 * small model had wrapped in a stray sentence or a markdown code fence
 * despite being told not to (confirmed on-device pre-grammar); with
 * TODO_EXTRACTION_GRAMMAR now constraining every sampled token, the model
 * is structurally incapable of producing anything other than the bare
 * array from the very first character, so a plain `JSON.parse` is both
 * sufficient and a stricter check (a stray character anywhere would now
 * correctly fail loudly instead of being silently sliced away). Still
 * wrapped in try/catch by the caller — grammar guarantees well-FORMED
 * output, not a complete one: hitting `n_predict` mid-array would still
 * yield truncated, unparseable JSON.
 */
function parseExtractionOutput(text: string): unknown {
  return JSON.parse(text);
}

function isRecurrence(value: unknown): value is Recurrence {
  return typeof value === "string" && (RECURRENCE_OPTIONS as readonly string[]).includes(value);
}

/**
 * Defensive structural normalization on top of whatever the on-device model
 * actually returns, plus deterministic date resolution via resolveDateAndTime
 * above and a deterministic recurrence sanity check via hasRecurrenceEvidence
 * (`rawNoteText` is the whole original note, needed for that check — see its
 * own comment for why the full text, not just this one item's date_phrase).
 * A 1B/3B instruct model is not reliable enough at strict JSON schemas to
 * trust its output verbatim — any entry missing a task, or carrying a
 * malformed recurrence, is either coerced to a safe default or dropped
 * entirely (an empty/missing task), rather than throwing and discarding
 * every other item the model got right.
 */
function normalizeExtracted(
  raw: unknown,
  todayISO: string,
  rawNoteText: string,
  detectedPhrases: string[]
): ExtractedToDo[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const noteHasRecurrenceEvidence = hasRecurrenceEvidence(rawNoteText);
  const lowerNoteText = rawNoteText.toLowerCase();

  // Filtered up front, not inline in the loop below, so the "exactly one
  // task in this note" check the single-candidate fallback relies on isn't
  // thrown off by junk entries (missing/empty task) that never make it into
  // the final result anyway.
  const validEntries = raw
    .filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === "object")
    .filter((record) => typeof record.task === "string" && record.task.trim().length > 0);

  const results: ExtractedToDo[] = [];
  for (const record of validEntries) {
    const task = (record.task as string).trim();

    // Recurrence is resolved BEFORE date_phrase reconciliation below, not
    // after (as an earlier version of this function did) — the single-
    // candidate auto-fill needs to know whether this task is recurring
    // before deciding whether chrono's candidate is even the right KIND of
    // thing to fill in. See that check's own comment for why.
    let recurrence: Recurrence = isRecurrence(record.recurrence) ? record.recurrence : "none";
    if (recurrence !== "none" && !noteHasRecurrenceEvidence) {
      console.warn(
        `[transformationEngine] Model classified "${task}" as recurrence "${recurrence}" but the note ` +
          "contains no actual repeating language — overriding to \"none\"."
      );
      recurrence = "none";
    }

    let datePhrase = typeof record.date_phrase === "string" ? record.date_phrase.trim() : "";

    // Reconciles the model's claim against chrono's own deterministic
    // detection (see detectDatePhrases's doc comment) — the model's raw
    // date_phrase is treated as a claim, not ground truth, the same
    // "don't trust the model on something a plain check can verify"
    // principle hasRecurrenceEvidence above already applies to recurrence.
    if (datePhrase) {
      const matchesDetected = detectedPhrases.some((phrase) => phrase.toLowerCase() === datePhrase.toLowerCase());
      if (!matchesDetected && !lowerNoteText.includes(datePhrase.toLowerCase())) {
        // Hallucinated a phrase that isn't actually anywhere in the note —
        // never trust it. (A phrase chrono missed but that's still a real
        // substring of the note is left alone here; chrono not catching
        // every possible phrasing is expected and fine, hallucinating text
        // that was never written is not.)
        console.warn(
          `[transformationEngine] Dropping hallucinated date_phrase "${datePhrase}" for "${task}" — ` +
            "not found anywhere in the note."
        );
        datePhrase = "";
      }
    } else if (validEntries.length === 1 && detectedPhrases.length === 1 && recurrence === "none") {
      // The one case that's genuinely safe to auto-fill: a single-task,
      // NON-recurring note where chrono found exactly one date candidate
      // and the model still came back empty — no ambiguity about which
      // task it belongs to. This is the deterministic fix for the exact
      // on-device miss ("Book a movie ticket this Friday." -> date_phrase
      // "") that motivated this whole reconciliation step.
      //
      // The `recurrence === "none"` guard is required, not optional — a
      // real on-device regression this introduced without it: "Water the
      // plants every 3 days." classified recurrence "daily" correctly, but
      // chrono detected the fragment "3 days" (from within "every 3 days")
      // as its own one-off relative date ("3 days from today"). Without
      // this guard, that got auto-filled into date_phrase as if it were a
      // real action date, producing a wrong one-off actionDate ~3 days out
      // instead of the recurring schedule the task actually describes.
      // chrono only ever detects calendar DATES, never recurrence CADENCES
      // ("every N days" isn't a date, it's a repeat rule) — so its
      // candidates are only trustworthy fill-ins for non-recurring tasks.
      datePhrase = detectedPhrases[0];
    }
    // Multi-task, multi-candidate notes are deliberately left alone here —
    // matching the right date to the right task is a genuine semantic
    // judgment call still squarely on the model; a count-based heuristic
    // guessing wrong there would be a worse bug than the one being fixed.
    // Confirmed on-device to still be a real gap even with the hint list
    // (see buildSystemPrompt's detectedPhrasesBlock): a 3-task note with
    // one trailing date attached only to the last task came back with all
    // three empty, and a 2-candidate-date note came back with a hallucinated
    // phrase instead of picking the right one of the two. Mitigated (not
    // solved) via FEW_SHOT_EXAMPLES below, since this is a task-to-date
    // ASSIGNMENT judgment call, not a phrase-copying one — a different
    // problem from the one detectDatePhrases fixes, and one few-shot
    // examples remain the right tool for (same as recurrence
    // classification), not something a heuristic here can safely guess.

    const { actionDate, toDate, notificationTime } = resolveDateAndTime(datePhrase, todayISO, recurrence);
    const recurrenceInterval = resolveRecurrenceInterval(datePhrase, recurrence);

    results.push({ task, actionDate, toDate, notificationTime, recurrence, recurrenceInterval });
  }
  return results;
}

/**
 * Parses raw note text into structured to-do items entirely on-device, via
 * Xayra's existing llama.rn context (services/ai/localLlama.ts) — no network
 * call, no second model loaded into memory alongside the RAG one. Never
 * throws: a model that isn't downloaded yet, a malformed completion, or any
 * other failure resolves to an empty array rather than blocking whatever
 * caller is trying to save the underlying note.
 */
export async function extractToDosFromText(rawText: string): Promise<ExtractedToDo[]> {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return [];
  }

  const todayISO = todayIso();
  // Runs before the LLM call, entirely on the JS thread — see
  // detectDatePhrases's own doc comment. This is a plain synchronous regex/
  // pattern-matching pass, single-digit milliseconds, with zero interaction
  // with the shared llama.cpp context or the n_threads tuning in
  // localLlama.ts; it never competes with inference for CPU.
  const detectedPhrases = detectDatePhrases(trimmed, todayISO);

  try {
    const prompt = buildPrompt(trimmed, todayISO, detectedPhrases);

    const start = nowMs();
    // Routed through localLlama.ts's shared completion queue, not a direct
    // context.completion() call — extraction and RAG answers share one
    // native llama.cpp context, which allows only one in-flight completion
    // at a time. Several notes saved in quick succession used to fire
    // several of these concurrently and silently lose every one but the
    // first to "context is busy" (see runQueuedLlamaCompletion's own doc
    // comment for the on-device repro).
    const result = await runQueuedLlamaCompletion({
      prompt,
      n_predict: 512,
      // Fully greedy, not just "near-deterministic" — this is structured
      // extraction against a fixed schema, not open-ended conversation, so
      // there's no warmth/variety worth preserving the way localLlama.ts's
      // RAG generation tunes for. On-device testing found even temperature
      // 0.1 let the same exact note produce two DIFFERENT wrong answers
      // across two runs (one got the date right and recurrence wrong, the
      // other the reverse) — confusing on its own regardless of which run
      // happened to be more correct. temperature: 0 removes that source of
      // run-to-run inconsistency entirely; whatever the model's single best
      // read of a hard case is, it now gives the same answer to it every
      // time, which is itself worth having independent of raw accuracy.
      temperature: 0,
      // Grammar-constrained decoding — see TODO_EXTRACTION_GRAMMAR's own
      // comment for what this guarantees (and doesn't). `stop` is kept as a
      // belt-and-suspenders backstop, though grammar sampling should already
      // force EOS itself the moment the root rule's closing "]" is matched,
      // since no further character is valid under the grammar past that
      // point — this should rarely if ever actually trigger.
      grammar: TODO_EXTRACTION_GRAMMAR,
      stop: [EOT_TOKEN, "<|end_of_text|>"],
    });
    logDuration("Llama to-do extraction", start);

    const rawOutput = result.text.trim();
    try {
      const parsed = parseExtractionOutput(rawOutput);
      // Logs the model's raw (pre-resolveDateAndTime) date_phrase per item —
      // added to diagnose a reported "to-dos always land on today regardless
      // of what date the note actually said" issue. This is the one place
      // that can tell apart the two very different failure modes: the model
      // itself extracting an empty/wrong date_phrase (a prompt/model
      // accuracy problem) vs. resolveDateAndTime/chrono-node failing to parse
      // a date_phrase the model got right (a date-resolution bug) — normalize
      // Extracted's return value only exposes the already-resolved
      // actionDate, which collapses both cases to the same "today" result.
      console.log("[transformationEngine] Raw extracted items (pre-date-resolution):", parsed);
      return normalizeExtracted(parsed, todayISO, trimmed, detectedPhrases);
    } catch (parseErr) {
      // Logged separately from the outer catch (which also covers
      // getContext()/completion failures) specifically so a parse failure
      // shows the actual text that broke it — "no JSON array found" alone
      // isn't diagnosable on its own, and this is a 1B/3B model, so it will
      // happen again on some future input shape.
      console.warn(
        "[transformationEngine] Failed to parse to-do extraction output — skipping.",
        parseErr,
        "Raw output:",
        rawOutput.slice(0, 500)
      );
      return [];
    }
  } catch (err) {
    console.warn("[transformationEngine] To-do extraction unavailable — skipping.", err);
    return [];
  }
}
