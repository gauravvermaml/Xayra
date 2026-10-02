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

import {
  checkAffirmativeAnswer,
  checkVerificationAnswer,
  validateRelationships,
  verificationAddendum,
  type EvidenceSentence,
  type RelationshipCheck,
} from "./relationshipGrounding";
import {
  checkAnswerDates,
  describePeriod,
  describeQueriedDate,
  establishedPeriods,
  relatePeriods,
  resolveMemory,
  selectTemporalSentences,
  type DateCheckResult,
  type EventEvidence,
  type MemoryClause,
  type Period,
  type QueryTemporalTarget,
  type ResolvedMemory,
  type TemporalReference,
} from "./temporalResolver";

/**
 * The shape this module needs from a retrieved note, declared structurally
 * rather than imported. `HybridSearchResult` satisfies it, but depending on
 * that type would re-introduce the very import chain this file exists to
 * avoid.
 */
export type FormattableNote = {
  /** Carried into relationship-grounding provenance when present. */
  id?: string;
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

/** A preposition already sitting before the replaced phrase — "since
 * yesterday" must become "since Wednesday, ...", not "since on Wednesday". */
const PRECEDING_PREPOSITION = /\b(since|from|until|till|by|on|of|before|after)\s+$/i;
const TIME_OF_DAY = /\b(morning|afternoon|evening|night|tonight)\b/i;
const FOUR_DIGIT_YEAR = /\b(?:19|20)\d{2}\b/;
/** Only a relative expression is rewritten. A bare time ("in the morning"),
 * or a chrono match on "now" (e.g. inside a book title), names no other day
 * and must stay as written. */
const RELATIVE_DAY_WORD = /\b(last|next|this|ago|yesterday|today|tomorrow|tonight)\b/i;

/**
 * Inline resolution of a note's own relative-time expressions, against the
 * note's OWN recorded date.
 *
 * Day-level ("today", "two days ago", "last night") is replaced with the
 * absolute date — "On Wednesday, September 30 2026" — the form this pipeline
 * has always used. Live bug the original version fixed: a note's own "Today
 * it's Sunday" was echoed back weeks later as if "today" meant the question's
 * day.
 *
 * Coarser ("last year", "this month") keeps the user's own words. With
 * `annotate`, a coarse expression whose period does NOT contain the recording
 * day gets its resolved period appended — "Last year (2024)" — while "this
 * month" stays as written (the header already dates it). Annotation is safe
 * only because temporal context construction (`renderTemporalSentences`) drops
 * sentences explicitly about a different period from a focused question: the
 * one confirmed live failure of "(2024)" was a "last year" question with both
 * years' sentences side by side. Off for non-date questions, which keep the
 * pre-existing format.
 */
function inlinePhrase(ref: TemporalReference, precedingText: string, recordedDay: Period, annotate: boolean): string | null {
  if (ref.resolution.status !== "resolved" || FOUR_DIGIT_YEAR.test(ref.text) || !RELATIVE_DAY_WORD.test(ref.text)) {
    return null;
  }
  const { period } = ref.resolution;
  if (period.precision !== "day") {
    return annotate && relatePeriods(recordedDay, period) === "outside" ? `${ref.text} (${describePeriod(period)})` : null;
  }
  const date = describePeriod(period);
  const timeOfDay = ref.text.match(TIME_OF_DAY)?.[1].toLowerCase();
  const core = timeOfDay ? `the ${timeOfDay === "tonight" ? "night" : timeOfDay} of ${date}` : date;
  if (PRECEDING_PREPOSITION.test(precedingText)) {
    return core;
  }
  return /^[A-Z]/.test(ref.text) ? `On ${core}` : `on ${core}`;
}

/** Renders `text[start, end)` with every reference inside it resolved
 * inline. References carry offsets into the full note text. */
function renderSpan(text: string, memory: ResolvedMemory, start: number, end: number, annotate: boolean): string {
  let rendered = text.slice(start, end);
  const inSpan = memory.references
    .filter((ref) => ref.index >= start && ref.index + ref.text.length <= end)
    .sort((a, b) => b.index - a.index);
  for (const ref of inSpan) {
    const replacement = inlinePhrase(ref, text.slice(Math.max(0, ref.index - 12), ref.index), memory.recordedDay, annotate);
    if (replacement) {
      const offset = ref.index - start;
      rendered = rendered.slice(0, offset) + replacement + rendered.slice(offset + ref.text.length);
    }
  }
  return rendered;
}

/**
 * The paragraph a note contributes to a temporal question: the sentences
 * temporalResolver.ts's `selectTemporalSentences` keeps — the SAME function
 * retrieval ranks with, so the two can never disagree — rendered in note
 * order with dates resolved inline. Paragraph form, not one labeled line per
 * clause: confirmed live that the labeled layout made this fine-tuned model
 * copy single lines (it was trained on paragraphs).
 */
type RenderedSentence = { sentenceIndex: number; text: string; clauses: MemoryClause[] };

function renderTemporalSentences(text: string, memory: ResolvedMemory, target: QueryTemporalTarget, eventTerms: string[]): RenderedSentence[] {
  return selectTemporalSentences(memory, target, eventTerms).map(({ sentenceIndex, clauses }) => ({
    sentenceIndex,
    clauses,
    text: clauses.map((c) => renderSpan(text, memory, c.index, c.index + c.text.length, true)).join(" ").replace(/,$/, "."),
  }));
}

/** Every sentence of a note, rendered the way the non-date body renders the
 * whole note — evidence for questions that name no date. */
function renderAllSentences(text: string, memory: ResolvedMemory): RenderedSentence[] {
  return memory.sentences.map(({ index, clauseIndices }) => {
    const clauses = clauseIndices.map((i) => memory.clauses[i]);
    const last = clauses[clauses.length - 1];
    return { sentenceIndex: index, clauses, text: renderSpan(text, memory, clauses[0].index, last.index + last.text.length, false) };
  });
}

export type NoteContextBuild = {
  /** The exact context block the model is shown. */
  contextText: string;
  /** The resolver's output for each input note, in input order. */
  memories: ResolvedMemory[];
  /** Input-note indices that contributed at least one line to the context.
   * A note whose every clause was filtered out is absent — rag.ts drops its
   * citation too, rather than citing a note the model never saw. */
  includedIndices: number[];
  /** Every sentence the model was shown, with note and sentence provenance —
   * what relationship grounding validates against. */
  evidence: EvidenceSentence[];
};

/**
 * Notes arrive already ordered by reciprocal-rank-fusion score (descending);
 * that order is preserved, so "NOTE 1" is always the strongest match.
 *
 * With no `target` (the question names no date), each note renders as one
 * paragraph exactly as before — header plus text with day-level references
 * resolved inline — so non-date questions see an unchanged format.
 *
 * With a `target`, each note is still one paragraph, but only the sentences
 * `renderTemporalSentences` selects, with coarse dates resolved inline — decided
 * deterministically by temporalResolver.ts against the note's own anchor.
 *
 * Plain-text `--- NOTE N [Recorded: ...] ---` headers rather than XML tags: a
 * small instruct model given XML-tagged context has been observed echoing a
 * stray tag back in its answer, and plain text gives it nothing markup-shaped
 * to imitate. The note's own id is deliberately omitted — the model has no
 * legitimate reason to surface an internal id, and the UI attaches citation
 * chips structurally rather than parsing them out of the answer text.
 *
 * Applied only to the text that reaches the model, never to
 * `RagCitation.content` — citations show the user their own note verbatim.
 */
export function buildNoteContext(
  notes: FormattableNote[],
  target: QueryTemporalTarget | null,
  options: { eventTerms?: string[] } = {}
): NoteContextBuild {
  const memories: ResolvedMemory[] = [];
  const includedIndices: number[] = [];
  const blocks: string[] = [];
  const evidence: EvidenceSentence[] = [];
  notes.forEach((note, i) => {
    const text = truncateForContext(resolveNoteText(note));
    const memory = resolveMemory(text, note.createdAt, target);
    memories.push(memory);
    const shown = target ? renderTemporalSentences(text, memory, target, options.eventTerms ?? []) : renderAllSentences(text, memory);
    // The non-date body stays one span of the whole note, exactly as before.
    const body = target ? shown.map((s) => s.text).join(" ") : renderSpan(text, memory, 0, text.length, false);
    if (body) {
      includedIndices.push(i);
      blocks.push(`--- NOTE ${blocks.length + 1} [Recorded: ${formatNoteDate(note.createdAt)}] ---\n${body}`);
      for (const s of shown) {
        evidence.push({
          noteId: note.id ?? null,
          noteIndex: i,
          sentenceIndex: s.sentenceIndex,
          createdAt: note.createdAt,
          text: s.text,
          dates: s.clauses.flatMap((c) => c.periods.map((period) => ({ period, explicit: c.source === "explicit" }))),
        });
      }
    }
  });
  return { contextText: blocks.join("\n\n"), memories, includedIndices, evidence };
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

/** Shown when retrieval found no relevant notes at all. Same wording
 * `MINIMAL_RAG_SYSTEM_PROMPT` (ragPrompt.ts) trains the model to produce for
 * an empty context, so this case reads identically whether the model or the
 * app says it. */
export const NO_RELEVANT_NOTES_MESSAGE = "No information found in your notes.";

/** Shown when relevant notes WERE retrieved but the generated answer failed
 * the date check or the grounding check. Deliberately distinct from
 * NO_RELEVANT_NOTES_MESSAGE: telling the user nothing was found would be
 * false here — notes exist, the app just couldn't verify an answer from them. */
export const UNVERIFIED_ANSWER_MESSAGE = "I found related notes, but couldn't verify an accurate answer from them.";

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
 * was actually shown (already including `buildNoteContext`'s inline-resolved
 * dates and clause labels) — not a fresh re-derivation from
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
 * the note context's relative-time words had been rewritten into absolute
 * dates at the time, so those exact words
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
  NO_RELEVANT_NOTES_MESSAGE,
  "I couldn't find any details about that in your notes.",
]);

/** The model's own fixed refusal lines — minimal mode's trained "No
 * information found in your notes." and the "full"-prompt-mode equivalent.
 * Exact match after trimming; deterministic. */
export function isKnownRefusal(answerText: string): boolean {
  return KNOWN_REFUSAL_LINES.has(answerText.trim());
}

export function isAnswerGroundedInContext(answerText: string, contextText: string, userQuery: string): boolean {
  if (isKnownRefusal(answerText)) {
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

/** An answer that flatly denies the event ("No, …", "You didn't …"). */
const BARE_NEGATION = /^\s*(?:no\b|you did(?:n['’]t| not)\b|there (?:was|is) no\b|nothing\b)/i;

export type AnswerOutcome =
  | "no-notes"
  | "model-refusal"
  | "date-rejected"
  | "relationship-rejected"
  | "verification-contradicted"
  | "grounding-rejected"
  | "unsupported-negation"
  | "shown";

/**
 * The post-generation path, shared by rag.ts and the eval scripts so they can
 * never drift apart. It validates; it never rewrites a generated claim. In
 * order:
 *  - nothing retrieved → NO_RELEVANT_NOTES_MESSAGE, whatever the model said;
 *  - the model's own refusal despite retrieved notes → UNVERIFIED_ANSWER_MESSAGE
 *    (saying "nothing found" would be false);
 *  - a verification question whose notes hold NO evidence about the event,
 *    answered with a flat denial → UNVERIFIED_ANSWER_MESSAGE: an absence of
 *    notes is not proof the event didn't happen;
 *  - a bare "Yes" to a verification question whose notes record the event on
 *    a different date, or nowhere → rejected; and a "Yes" to any yes/no
 *    question must confirm the subject/action actually asked about ("Is Eli
 *    moving…?" is not confirmed by "Eli's brother Elias is moving");
 *  - date check: every explicit-year date must be established, or the answer
 *    is rejected (no year repair — dates are normalized BEFORE generation);
 *  - relationship check (relationshipGrounding.ts): each statement's values
 *    must be supported by one evidence sentence the model was shown;
 *  - word-grounding check (against the grounded question the model saw);
 *  - verification addendum: when the notes unambiguously date the event to
 *    another day, one deterministic sentence saying so is appended.
 * Citations are kept only for "shown".
 */
export function finalizeAnswer(input: {
  raw: string;
  notesIncluded: number;
  contextText: string;
  question: string;
  memories: ResolvedMemory[];
  evidence: EvidenceSentence[];
  target: QueryTemporalTarget | null;
  now: Date;
  eventEvidence: EventEvidence | null;
}): { text: string; outcome: AnswerOutcome; dateCheck?: DateCheckResult; relationships?: RelationshipCheck; reason?: string } {
  const { raw, notesIncluded, contextText, question, memories, evidence, target, now, eventEvidence } = input;
  if (notesIncluded === 0) {
    return { text: NO_RELEVANT_NOTES_MESSAGE, outcome: "no-notes" };
  }
  const sanitized = sanitizeLLMResponse(raw);
  if (isKnownRefusal(sanitized)) {
    return { text: UNVERIFIED_ANSWER_MESSAGE, outcome: "model-refusal" };
  }
  if (eventEvidence?.kind === "none" && BARE_NEGATION.test(sanitized)) {
    return { text: UNVERIFIED_ANSWER_MESSAGE, outcome: "unsupported-negation" };
  }
  const contradiction =
    checkVerificationAnswer(sanitized, eventEvidence) ??
    checkAffirmativeAnswer({ answer: sanitized, question, evidence, now, comparative: target?.comparative ?? false });
  if (contradiction) {
    return { text: UNVERIFIED_ANSWER_MESSAGE, outcome: "verification-contradicted", reason: contradiction };
  }
  const dateCheck = checkAnswerDates(sanitized, establishedPeriods(memories, target), now);
  if (dateCheck.status === "rejected") {
    return { text: UNVERIFIED_ANSWER_MESSAGE, outcome: "date-rejected", dateCheck };
  }
  const relationships = validateRelationships({ answer: sanitized, question, evidence, now, eventEvidence });
  if (!relationships.ok) {
    return { text: UNVERIFIED_ANSWER_MESSAGE, outcome: "relationship-rejected", dateCheck, relationships };
  }
  if (!isAnswerGroundedInContext(sanitized, contextText, question)) {
    return { text: UNVERIFIED_ANSWER_MESSAGE, outcome: "grounding-rejected", dateCheck, relationships };
  }
  const addendum = eventEvidence ? verificationAddendum(sanitized, eventEvidence, describeQueriedDate(question, now, target), now) : null;
  return { text: addendum ? `${sanitized} ${addendum}` : sanitized, outcome: "shown", dateCheck, relationships };
}
