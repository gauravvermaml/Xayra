import { generateLocalRAGAnswer } from "./localLlama";
import { setPipelineStage } from "./pipelineStage";
import { hybridSearchNotes, type HybridSearchResult } from "../notes/noteManager";

/**
 * Lowered from 5: at 5 notes, a small (1B) model reliably lost track of
 * which fact came from which note and started blending/conflating details
 * across notes in its answer ("context noise"). 3 keeps the strongest
 * hybrid-search matches while staying well within what a 1B model can
 * actually attend to distinctly.
 */
const CONTEXT_NOTE_LIMIT = 3;

export type RagCitation = {
  /** 1-based position matching the "[Note N]" label shown in the UI. */
  index: number;
  noteId: string;
  content: string;
  createdAt: number;
};

export type RagAnswer = {
  text: string;
  citations: RagCitation[];
};

/**
 * Full weekday + date + 24-hour time (e.g. "Thursday, 14 Aug 2026 at 09:32")
 * rather than the previous bare `YYYY-MM-DD` — a small model asked "when did
 * I say X" or "what did I record last Thursday" has nothing to resolve that
 * against without an explicit, unambiguous timestamp on every note it's
 * given. Deliberately in the device's local time (not UTC/ISO) since that's
 * the time the user actually recorded in and would recognize.
 */
function formatNoteDate(createdAt: number): string {
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

/** `content` is the source of truth, but falls back to `transcript` in case
 * a row was written before both columns were kept in sync (see noteManager). */
function resolveNoteText(note: HybridSearchResult): string {
  return note.content || note.transcript || "";
}

/**
 * Notes arrive already ordered by reciprocal-rank-fusion score (descending)
 * from `hybridSearchNotes` — that order is preserved here and in the
 * citation list below, so "[Note 1]" is always the strongest match.
 *
 * Plain-text `--- NOTE N [Recorded: ...] ---` headers instead of XML tags
 * (`<note id="...">`): a small instruct model given XML-tagged context has
 * been observed occasionally echoing a stray tag back in its answer (see
 * `sanitizeLLMResponse` below for the safety-net side of this fix) — plain
 * text headers give it nothing markup-shaped to imitate. Deliberately
 * omits the note's own `id` from the context entirely (the model has no
 * legitimate reason to ever surface an internal note ID in an answer; the
 * UI's citation chips are attached structurally from `citations` below,
 * never parsed from the model's text). The `[Recorded: ...]` label (rather
 * than a bare date in parens) is what the system prompt's date-resolution
 * rule below refers to by name, so the two stay in sync.
 */
function formatNoteContext(notes: HybridSearchResult[]): string {
  return notes
    .map(
      (note, i) =>
        `--- NOTE ${i + 1} [Recorded: ${formatNoteDate(note.createdAt)}] ---\n${resolveNoteText(note)}`
    )
    .join("\n\n");
}

/**
 * Defensive last-pass cleanup applied to every generated answer before it
 * reaches the UI — not a substitute for good prompting (see the system
 * prompt in localLlama.ts, which already instructs the model not to do
 * either of these), just a safety net for the two failure modes actually
 * observed on-device with the 1B model:
 *   1. A stray XML/HTML-style tag echoed back (residual habit from earlier
 *      XML-tagged context — see formatNoteContext above).
 *   2. Looping: repeating its own last sentence/paragraph verbatim right
 *      before hitting the stop token.
 */
/** Matches a residual Llama-3.2 instruct-template special token, e.g.
 * `<|eot_id|>` or `<|start_header_id|>assistant<|end_header_id|>` — these
 * use `<|...|>` delimiters, not `<tag>`, so the general XML/HTML regex below
 * doesn't catch them on its own. A `stop` sequence should prevent these from
 * ever being generated, but a truncated/edge-case completion has been
 * observed leaking a trailing `<|eot_id|>` fragment on-device. */
const SPECIAL_TOKEN_PATTERN = /<\|[a-zA-Z0-9_]+\|>/g;

export function sanitizeLLMResponse(text: string): string {
  const withoutSpecialTokens = text.replace(SPECIAL_TOKEN_PATTERN, "");
  const withoutTags = withoutSpecialTokens.replace(/<\/?[a-zA-Z!][^>]*>/g, "").trim();
  return stripDuplicatedTail(withoutTags);
}

const MIN_REPEATED_TAIL_LENGTH = 20;
const MAX_REPEATED_TAIL_LENGTH = 400;

/** Detects a suffix that's immediately repeated right before it (the
 * classic small-model "loop" signature) and drops the duplicate — scanning
 * from the longest plausible repeat down so a long, exact repetition wins
 * over a shorter coincidental one. */
function stripDuplicatedTail(text: string): string {
  const trimmed = text.trimEnd();
  const maxLen = Math.min(Math.floor(trimmed.length / 2), MAX_REPEATED_TAIL_LENGTH);

  for (let len = maxLen; len >= MIN_REPEATED_TAIL_LENGTH; len--) {
    const tail = trimmed.slice(trimmed.length - len);
    const before = trimmed.slice(trimmed.length - 2 * len, trimmed.length - len);
    if (tail === before) {
      return trimmed.slice(0, trimmed.length - len).trim();
    }
  }
  return trimmed;
}

/**
 * Retrieves the top matching notes via hybrid search (already RRF-ordered),
 * grounds a local on-device LLM completion in them as a plain-text context
 * block, and streams the answer token-by-token through `onChunk` as it's
 * generated. Resolves with the full, sanitized text plus the citation list
 * once generation ends.
 */
export async function generateRAGAnswer(
  userQuery: string,
  onChunk?: (chunk: string) => void
): Promise<RagAnswer> {
  setPipelineStage("retrieving");
  const notes = await hybridSearchNotes(userQuery, CONTEXT_NOTE_LIMIT);

  const citations: RagCitation[] = notes.map((note, i) => ({
    index: i + 1,
    noteId: note.id,
    content: resolveNoteText(note),
    createdAt: note.createdAt,
  }));

  // Deliberately worded so an empty-context turn still reads as one of the
  // "NOTE" sections the system prompt already knows how to ground answers
  // in — that's what reliably gets the model to actually say the fixed
  // "I couldn't find any details..." line instead of inventing something,
  // rather than leaving it to notice an unusual, unlabeled context string.
  const noteContext =
    notes.length > 0 ? formatNoteContext(notes) : "--- NOTE CONTEXT ---\nNo relevant voice notes were found.";

  // Security audit finding: this used to log unconditionally, in every
  // build including release — printing the user's full private note content
  // to logcat on every single query, where it's exposed to anything with
  // device-debugging or (on older/rooted devices) READ_LOGS access. Gated
  // behind `__DEV__` (false and dead in a release JS bundle) so it stays
  // useful for local development without ever reaching a real user's device.
  if (__DEV__) {
    console.log("[RAG Prompt Context]", noteContext);
  }

  setPipelineStage("answering");
  let firstTokenSeen = false;
  try {
    const rawText = await generateLocalRAGAnswer(userQuery, noteContext, (token) => {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        // The streaming answer itself takes over from here — see
        // ChatSheetContent.tsx's own `item.isStreaming && item.text.length
        // === 0` check, which this same first-token moment already governs.
        setPipelineStage(null);
      }
      onChunk?.(token);
    });
    return { text: sanitizeLLMResponse(rawText), citations };
  } finally {
    // Safety net for a zero-token answer or a thrown error, where the
    // onToken callback above never ran to clear this itself.
    setPipelineStage(null);
  }
}
