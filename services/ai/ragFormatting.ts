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
    .map(
      (note, i) =>
        `--- NOTE ${i + 1} [Recorded: ${formatNoteDate(note.createdAt)}] ---\n${truncateForContext(resolveNoteText(note))}`
    )
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
