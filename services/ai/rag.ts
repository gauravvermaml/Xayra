import { generateLocalRAGAnswer } from "./localLlama";
import { setPipelineStage } from "./pipelineStage";
import {
  formatNoteContext,
  isAnswerGroundedInContext,
  resolveNoteText,
  sanitizeLLMResponse,
  UNGROUNDED_ANSWER_FALLBACK,
} from "./ragFormatting";
import { getNotesInDateRange, getRecentNotes, hybridSearchNotes, type HybridSearchResult } from "../notes/noteManager";
import { detectQueryDateRange } from "./queryDateRange";

// Re-exported so existing importers (and the UI) keep their current import
// path while the implementation lives in the dependency-free module.
export { sanitizeLLMResponse } from "./ragFormatting";

/**
 * Lowered from 5: at 5 notes, a small (1B) model reliably lost track of
 * which fact came from which note and started blending/conflating details
 * across notes in its answer ("context noise"). 3 keeps the strongest
 * hybrid-search matches while staying well within what a 1B model can
 * actually attend to distinctly.
 */
const CONTEXT_NOTE_LIMIT = 3;

/**
 * "Summarise my latest notes" asks for RECENCY, not relevance — but
 * `hybridSearchNotes` below treats every word in the query (including
 * "latest"/"recent") as a semantic/keyword signal against note CONTENT, with
 * no use of the notes' own real timestamps at all. Live bug this closes: a
 * note recorded Sep 20 ("Vishwa gave me an idea about the app yesterday")
 * got retrieved and summarized for "summarise my latest notes" asked on
 * Sep 30 — its own transcript's literal use of "yesterday" created genuine
 * lexical/semantic overlap with the query's "latest," same confound class
 * this file's `MAX_NOTE_VECTOR_DISTANCE`/`FTS_STOPWORDS` comments already
 * document, just not a word either of those covered. A query matching this
 * pattern bypasses `hybridSearchNotes` entirely and pulls from
 * `getRecentNotes` instead — real `created_at DESC` order, the same
 * ordering the Notes tab's own default view already uses and trusts.
 */
const RECENCY_INTENT_PATTERN = /\b(latest|recent|newest|most\s+recent)\b/i;
const NOTES_MENTION_PATTERN = /\bnotes?\b/i;

function isRecentNotesQuery(query: string): boolean {
  return RECENCY_INTENT_PATTERN.test(query) && NOTES_MENTION_PATTERN.test(query);
}

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
  setPipelineStage("chat", "retrieving");
  // Priority: a real past-date/period reference ("27th September", "October
  // last year", "last week") beats everything else — see
  // queryDateRange.ts's own doc comment for why generic semantic/keyword
  // search is the wrong tool for a question whose actual ask is "what's
  // timestamped in this window," not "what's topically similar to these
  // words." Falls through to the existing recency bypass, then to hybrid
  // search, for queries that name no real date/period at all.
  const dateRange = detectQueryDateRange(userQuery, new Date());
  const notes = dateRange
    ? await getNotesInDateRange(dateRange.start, dateRange.end, CONTEXT_NOTE_LIMIT)
    : isRecentNotesQuery(userQuery)
      ? await getRecentNotes(CONTEXT_NOTE_LIMIT)
      : await hybridSearchNotes(userQuery, CONTEXT_NOTE_LIMIT);

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

  setPipelineStage("chat", "answering");
  let firstTokenSeen = false;
  try {
    const rawText = await generateLocalRAGAnswer(userQuery, noteContext, (token) => {
      if (!firstTokenSeen) {
        firstTokenSeen = true;
        // The streaming answer itself takes over from here — see
        // ChatSheetContent.tsx's own `item.isStreaming && item.text.length
        // === 0` check, which this same first-token moment already governs.
        setPipelineStage("chat", null);
      }
      onChunk?.(token);
    });
    const sanitized = sanitizeLLMResponse(rawText);

    // Grounding backstop — see `isAnswerGroundedInContext`'s own doc comment
    // for the exact live bug this closes (the minimal-mode few-shot demo
    // leaking fabricated content into a real answer), and its own note on
    // why `userQuery` is ALSO passed in (a correct answer echoing the
    // user's own question phrasing was a second live bug, caught after the
    // first fix shipped). Only runs when there was real note context to
    // ground against; `notes.length === 0` already has its own dedicated
    // "no relevant voice notes" context block above and the model is
    // separately instructed to refuse on that, so there's nothing
    // meaningful to check in that case. On failure, citations are cleared
    // too — showing citation chips next to a rejected, replaced answer
    // would misleadingly imply they back content that was in fact thrown
    // out.
    if (notes.length > 0 && !isAnswerGroundedInContext(sanitized, noteContext, userQuery)) {
      if (__DEV__) {
        console.log("[RAG] Rejected ungrounded answer:", sanitized);
      }
      return { text: UNGROUNDED_ANSWER_FALLBACK, citations: [] };
    }

    return { text: sanitized, citations };
  } finally {
    // Safety net for a zero-token answer or a thrown error, where the
    // onToken callback above never ran to clear this itself.
    setPipelineStage("chat", null);
  }
}
