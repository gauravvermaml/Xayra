import { generateLocalRAGAnswer } from "./localLlama";
import { setPipelineStage } from "./pipelineStage";
import {
  formatNoteContext,
  resolveNoteText,
  sanitizeLLMResponse,
} from "./ragFormatting";
import { hybridSearchNotes, type HybridSearchResult } from "../notes/noteManager";

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
    return { text: sanitizeLLMResponse(rawText), citations };
  } finally {
    // Safety net for a zero-token answer or a thrown error, where the
    // onToken callback above never ran to clear this itself.
    setPipelineStage("chat", null);
  }
}
