/**
 * Pure formatting and sanitization for the RAG pipeline.
 *
 * Deliberately has NO imports from `noteManager`, `db/`, or anything that
 * reaches native code. `rag.ts` owns retrieval and orchestration; everything
 * here is a plain function of its arguments.
 *
 * The split exists for testability. These are the highest-value functions to
 * assert directly — context framing, truncation and output cleanup are where
 * silent formatting regressions hide — but importing them from `rag.ts` drags
 * in `noteManager -> db/client -> op-sqlite`, whose Node build needs a native
 * `better-sqlite3` that does not exist under Jest or in a headless eval
 * runner. Tests previously had to stub that whole chain to reach a string
 * function. They no longer do, and neither will the Tier 2 harness.
 */

/**
 * The shape this module needs from a retrieved note, declared structurally
 * rather than imported. `HybridSearchResult` satisfies it, but depending on
 * that type would re-introduce the very import chain this file exists to
 * avoid.
 */
export type FormattableNote = {
  content: string | null;
  transcript: string | null;
  createdAt: number;
};

/** `content` is the source of truth, but falls back to `transcript` in case
 * a row was written before both columns were kept in sync (see noteManager). */
export function resolveNoteText(note: FormattableNote): string {
  return note.content || note.transcript || "";
}

/**
 * Every note carries an explicit recorded timestamp into the prompt: a query
 * like "when did I say X" or "what did I record last Thursday" has nothing to
 * resolve against otherwise. Deliberately in the device's local time (not
 * UTC/ISO) since that is the time the user actually recorded in and would
 * recognize.
 */
export function formatNoteDate(createdAt: number): string {
  const date = new Date(createdAt * 1000);
  const datePart = date.toLocaleDateString("en-US", {
    weekday: "long",
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const timePart = date.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${datePart} at ${timePart}`;
}

/**
 * A note is transcribed in the user's own voice AT RECORDING TIME, so "today"
 * in its text means the day it was recorded — not "today" relative to
 * whenever the chat question is actually asked, which can be days or weeks
 * later. Live bug this fixes: a note recorded Sunday 27 Sep ("Today it's
 * Sunday and we started really slow...") was retrieved for a later query
 * asking specifically about 27 Sep, and the model's answer just echoed the
 * note's own "Today it's Sunday" framing verbatim — technically true THAT
 * day, nonsensical read back later, and doubly confusing since the system
 * prompt separately injects the CURRENT date as "today" for its own
 * relative-time reasoning (see ragPrompt.ts's `buildSystemPromptWithDate`) —
 * two different "today"s colliding in the same context.
 *
 * Fixed deterministically, at the formatting layer, rather than by
 * instructing the model to do this conversion itself: ragPrompt.ts's own
 * `buildCalendarBaseline` doc comment already documents that a model this
 * size "reliably gets [date arithmetic] wrong" purely from a prompt
 * instruction. Rewriting the actual words before the model ever sees them
 * removes the ambiguity by construction instead of hoping a 1.5B model
 * resolves it correctly every time. A short instruction is still added to
 * the minimal prompt as a defense-in-depth backup for any relative-time
 * phrasing this pattern doesn't catch (e.g. "this morning", "last night").
 *
 * Deliberately applied only to the text that reaches the LLM's context
 * (`formatNoteContext` below), never to `RagCitation.content` in rag.ts —
 * citations show the user their own note back verbatim; this rewrite is
 * purely to ground the model's own answer correctly.
 */
const RELATIVE_DAY_OFFSETS: Record<string, number> = {
  today: 0,
  yesterday: -1,
  tomorrow: 1,
};

const RELATIVE_DAY_PATTERN = /\b(today|yesterday|tomorrow)\b/gi;

/** Local-time year/month/day arithmetic, never `new Date(isoString)` — same
 * UTC-off-by-one-day discipline `services/calendar/dateRange.ts` documents
 * and follows for the identical reason. */
function formatAbsoluteDayPhrase(createdAt: number, dayOffset: number): string {
  const recorded = new Date(createdAt * 1000);
  const target = new Date(recorded.getFullYear(), recorded.getMonth(), recorded.getDate() + dayOffset);
  const weekday = target.toLocaleDateString("en-US", { weekday: "long" });
  const monthDay = target.toLocaleDateString("en-US", { month: "long", day: "numeric" });
  return `${weekday}, ${monthDay} ${target.getFullYear()}`;
}

/**
 * Extension of the day-level rewrite above to year/month-grain relative
 * phrases — same root cause, same fix philosophy, added after a live
 * scenario exposed the gap: a note recorded Jan 2027 saying "last year same
 * time it was so much better" and "unusual for this month" was asked about
 * from December 2027, 11 months later, via "was it this hot last year
 * around the same time." The QUERY's own "last year" (~Dec 2026) and the
 * NOTE's own "last year" (~Jan 2026, one year before ITS OWN recording date)
 * use the identical two words but anchor to completely different periods —
 * a small model has to silently disambiguate that collision with no help
 * unless the words are resolved before it ever sees them, same reasoning as
 * `RELATIVE_DAY_PATTERN` above. "these days"/"this week" are deliberately
 * NOT covered — "these days" in particular is already vague even to a human
 * reader (it doesn't pin to a specific period the way "last year" or "this
 * month" do), so there's no single unambiguous absolute phrase to rewrite it
 * to; leaving it as-is is honest rather than inventing false precision.
 *
 * ANNOTATE, DON'T REPLACE — deliberately different from the day-level
 * rewrite above, after a second live bug this exact extension caused: the
 * first version REPLACED "last year" outright with a bare number ("In
 * 2024"), which fixed the word-ambiguity problem above but created a worse
 * one — a note mentioning its own main year ("October 15 2025") alongside a
 * comparison year ("last year") now had TWO bare, visually-identical-shaped
 * 4-digit numbers sitting close together with nothing to tell the model
 * which one was the main fact and which was the aside, and the model
 * (confirmed live) swapped them, attaching the comparison year to the main
 * event. "Last year"/"this month" are themselves a stronger, more distinct
 * token than a second bare number — keeping the original word and
 * appending its resolved value in parentheses ("last year (2024)") preserves
 * that word's own "this is a comparison, not the main fact" signal instead
 * of erasing it, while still giving the exact number the grounding check and
 * the model's own date math need. Not a guarantee a small model never
 * confuses two related numbers again, but it removes the specific
 * bare-number-collision shape that caused the observed failure, applied
 * generically to every note with this pattern — not a fix for one note.
 */
const RELATIVE_YEAR_OFFSETS: Record<string, number> = {
  "last year": -1,
  "this year": 0,
};

const RELATIVE_YEAR_PATTERN = /\b(last year|this year)\b/gi;
const RELATIVE_MONTH_PATTERN = /\bthis month\b/gi;

function formatAbsoluteYearPhrase(createdAt: number, yearOffset: number): string {
  const recorded = new Date(createdAt * 1000);
  return `${recorded.getFullYear() + yearOffset}`;
}

function formatAbsoluteMonthPhrase(createdAt: number): string {
  const recorded = new Date(createdAt * 1000);
  const month = recorded.toLocaleDateString("en-US", { month: "long" });
  return `${month} ${recorded.getFullYear()}`;
}

export function normalizeRelativeTimeInNoteText(text: string, createdAt: number): string {
  const withDaysResolved = text.replace(RELATIVE_DAY_PATTERN, (match) => {
    const offset = RELATIVE_DAY_OFFSETS[match.toLowerCase()];
    const datePhrase = formatAbsoluteDayPhrase(createdAt, offset);
    const isCapitalized = match[0] === match[0].toUpperCase();
    return isCapitalized ? `On ${datePhrase}` : `on ${datePhrase}`;
  });

  const withYearsResolved = withDaysResolved.replace(RELATIVE_YEAR_PATTERN, (match) => {
    const offset = RELATIVE_YEAR_OFFSETS[match.toLowerCase()];
    const yearPhrase = formatAbsoluteYearPhrase(createdAt, offset);
    return `${match} (${yearPhrase})`;
  });

  return withYearsResolved.replace(RELATIVE_MONTH_PATTERN, (match) => {
    const monthPhrase = formatAbsoluteMonthPhrase(createdAt);
    return `${match} (${monthPhrase})`;
  });
}

/**
 * Caps how much of a single note's text reaches the model. Time-to-first-token
 * (prompt processing), not decode speed, dominates a query's wall clock on
 * this device class, and that scales with context length.
 */
export const MAX_NOTE_CONTEXT_WORDS = 200;

export function truncateForContext(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= MAX_NOTE_CONTEXT_WORDS) {
    return text;
  }
  return `${words.slice(0, MAX_NOTE_CONTEXT_WORDS).join(" ")}…`;
}

/**
 * Notes arrive already ordered by reciprocal-rank-fusion score (descending);
 * that order is preserved, so "NOTE 1" is always the strongest match.
 *
 * Plain-text `--- NOTE N [Recorded: ...] ---` headers rather than XML tags: a
 * small instruct model given XML-tagged context has been observed echoing a
 * stray tag back in its answer, and plain text gives it nothing markup-shaped
 * to imitate. The note's own id is deliberately omitted — the model has no
 * legitimate reason to surface an internal id, and the UI attaches citation
 * chips structurally rather than parsing them out of the answer text.
 */
export function formatNoteContext(notes: FormattableNote[]): string {
  return notes
    .map((note, i) => {
      const normalized = normalizeRelativeTimeInNoteText(resolveNoteText(note), note.createdAt);
      return `--- NOTE ${i + 1} [Recorded: ${formatNoteDate(note.createdAt)}] ---\n${truncateForContext(normalized)}`;
    })
    .join("\n\n");
}

/** Matches a residual instruct-template special token, e.g. `<|im_end|>` or
 * `<|start_header_id|>`. These use `<|...|>` delimiters, not `<tag>`, so the
 * general markup regex below does not catch them on its own. A `stop`
 * sequence should prevent them being generated at all, but a truncated
 * completion has been observed leaking a trailing fragment on-device. */
const SPECIAL_TOKEN_PATTERN = /<\|[a-zA-Z0-9_]+\|>/g;

const MIN_REPEATED_TAIL_LENGTH = 20;
const MAX_REPEATED_TAIL_LENGTH = 400;

/** A run of characters that can sit BETWEEN two copies of a looped phrase
 * without belonging to either. Whitespace and sentence punctuation cover what
 * a looping model actually emits between repeats. */
const REPEAT_SEPARATOR_RUN = /^[\s.,;:!?—–-]+$/;

/** Longest separator run tolerated between two copies. Generous enough for
 * ". " or " — " or a blank line, tight enough that it cannot swallow real
 * content and manufacture a match. */
const MAX_REPEAT_GAP = 4;

/**
 * Detects a suffix that repeats immediately before itself (the classic
 * small-model "loop" signature) and drops the duplicate — scanning from the
 * longest plausible repeat down, so a long exact repetition wins over a
 * shorter coincidental one.
 *
 * An explicit separator GAP between the copies is allowed. The original
 * version required them to be byte-adjacent, which meant a single space
 * defeated it — and a looping model nearly always emits one ("…on 30
 * September. Your registration expires on 30 September."), so the detector
 * missed the overwhelming majority of what it was written to catch.
 *
 * The gap is searched explicitly rather than by walking backwards over
 * separator characters. That first attempt looked equivalent and was not: with
 * two copies of a sentence ending in ".", the backward walk consumed the FIRST
 * copy's own full stop, shifted the comparison window by one, and broke even
 * the byte-adjacent case that previously worked. Trailing punctuation is part
 * of the sentence, not the separator, and only trying each gap width
 * separately distinguishes the two.
 */
function stripDuplicatedTail(text: string): string {
  const trimmed = text.trimEnd();
  const maxLen = Math.min(Math.floor(trimmed.length / 2), MAX_REPEATED_TAIL_LENGTH);

  for (let len = maxLen; len >= MIN_REPEATED_TAIL_LENGTH; len--) {
    const tail = trimmed.slice(trimmed.length - len);

    for (let gap = 0; gap <= MAX_REPEAT_GAP; gap++) {
      const end = trimmed.length - len - gap;
      if (end < len) {
        break;
      }
      if (gap > 0 && !REPEAT_SEPARATOR_RUN.test(trimmed.slice(end, end + gap))) {
        continue;
      }
      if (trimmed.slice(end - len, end) === tail) {
        // Keep the FIRST copy and everything before it; separator and
        // duplicate both go.
        return trimmed.slice(0, end).trim();
      }
    }
  }
  return trimmed;
}

/**
 * Defensive last-pass cleanup applied to every generated answer before it
 * reaches the UI. Not a substitute for good prompting — the system prompt
 * already forbids markup — but a small model occasionally ignores that, and a
 * stray tag or a repeated paragraph is worse in the UI than a slightly
 * over-trimmed answer.
 */
export function sanitizeLLMResponse(text: string): string {
  const withoutSpecialTokens = text.replace(SPECIAL_TOKEN_PATTERN, "");
  const withoutTags = withoutSpecialTokens.replace(/<\/?[a-zA-Z!][^>]*>/g, "").trim();
  return stripDuplicatedTail(withoutTags);
}

/** Fixed refusal line this file's grounding check falls back to — same
 * wording `MINIMAL_RAG_SYSTEM_PROMPT` (ragPrompt.ts) already instructs the
 * model to produce verbatim when it genuinely has nothing, so a rejected
 * answer is indistinguishable from a model-issued refusal rather than
 * reading as a different, unexplained failure mode. */
export const UNGROUNDED_ANSWER_FALLBACK = "No information found in your notes.";

/** Below this length a word is almost always a function word ("the", "and",
 * "this") rather than real content — skipping them without needing a
 * dedicated stopword list keeps this function self-contained (see this
 * file's own top doc comment on why it imports nothing from noteManager,
 * which is where the app's real stopword list already lives). */
const MIN_CONTENT_WORD_LENGTH = 4;

/** Below this fraction of an answer's own content words actually appearing
 * somewhere in the context it was grounded in, the answer is treated as
 * likely fabricated rather than a legitimate paraphrase. A real summary
 * naturally reuses most of its source's specific nouns/terms even while
 * rephrasing connective language around them; an answer inventing unrelated
 * facts (the failure this exists to catch) will have most of its specific
 * content words matching nothing in the source at all. Starting value, not
 * empirically tuned yet — see this function's own doc comment. */
const MIN_GROUNDED_WORD_RATIO = 0.5;

function extractContentWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length >= MIN_CONTENT_WORD_LENGTH);
}

/**
 * Post-generation grounding check — catches a model answer that references
 * something with no basis anywhere in the note context it was actually given,
 * independent of why that happened (the specific bug this was added for was
 * `MINIMAL_PERSON_VOICE_EXAMPLE_CONTEXT`'s own fake demo note leaking into a
 * real answer, but this check doesn't care about the cause, only the
 * symptom). Mirrors `transformationEngine.ts`'s existing "hallucinated
 * date_phrase" check for to-do extraction (drops any extracted date phrase
 * not found verbatim in the source note) — same principle, applied here to a
 * full RAG answer instead of a single extracted field.
 *
 * Checked against `contextText` — the EXACT context block string the model
 * was actually shown (already including `normalizeRelativeTimeInNoteText`'s
 * rewritten dates, via `formatNoteContext`) — not a fresh re-derivation from
 * the raw notes. Rebuilding it separately here would let a correctly
 * date-converted answer ("On Sunday, 27 September...") get wrongly flagged,
 * since that exact phrase only exists in the NORMALIZED text, never in a
 * note's own raw, un-rewritten words.
 *
 * ALSO checked against `userQuery` (a live bug, caught after the anniversary
 * window + relative-time-phrase normalization both shipped): a correct
 * answer naturally echoes the user's own question phrasing — "was it this
 * hot LAST YEAR AROUND THE SAME TIME" answered as "it was not this hot last
 * year around the same time" is a perfectly grounded, correct answer — but
 * `normalizeRelativeTimeInNoteText` had already rewritten "last year"/"this
 * month" OUT of the note context into absolute dates, so those exact words
 * no longer existed anywhere this function was checking, and a genuinely
 * correct answer was rejected as "fabricated" for reusing the question's own
 * words. Words the user themselves already used are definitionally not
 * something the model could be hallucinating, so they count as grounded too.
 * Confirmed this doesn't reopen the original leak bug: the fabricated
 * "milk/eggs/dentist" content from that bug report appeared in neither the
 * real note context NOR that query's own text, so it still fails correctly.
 *
 * The model's own fixed refusal lines ("No information found in your
 * notes.", and the "full"-prompt-mode equivalent) trivially pass without
 * running the ratio check at all — checked explicitly, NOT inferred from
 * "zero content words," since both actually contain real words 4+ letters
 * long ("information", "notes", "details") that legitimately won't appear in
 * most note context, which would otherwise flag the model correctly
 * refusing as if it were the fabrication this function exists to catch.
 */
const KNOWN_REFUSAL_LINES = new Set([
  UNGROUNDED_ANSWER_FALLBACK,
  "I couldn't find any details about that in your notes.",
]);

export function isAnswerGroundedInContext(answerText: string, contextText: string, userQuery: string): boolean {
  if (KNOWN_REFUSAL_LINES.has(answerText.trim())) {
    return true;
  }
  const contentWords = extractContentWords(answerText);
  if (contentWords.length === 0) {
    return true;
  }
  const searchableLower = `${contextText} ${userQuery}`.toLowerCase();
  const groundedCount = contentWords.filter((word) => searchableLower.includes(word)).length;
  return groundedCount / contentWords.length >= MIN_GROUNDED_WORD_RATIO;
}
