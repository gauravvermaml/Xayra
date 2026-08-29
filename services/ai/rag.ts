import { generateLocalRAGAnswer } from "./localLlama";
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

function formatNoteDate(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().slice(0, 10);
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
 * Plain-text `--- NOTE N (date) ---` headers instead of XML tags
 * (`<note id="...">`): a small instruct model given XML-tagged context has
 * been observed occasionally echoing a stray tag back in its answer (see
 * `sanitizeLLMResponse` below for the safety-net side of this fix) — plain
 * text headers give it nothing markup-shaped to imitate. Deliberately
 * omits the note's own `id` from the context entirely (the model has no
 * legitimate reason to ever surface an internal note ID in an answer; the
 * UI's citation chips are attached structurally from `citations` below,
 * never parsed from the model's text).
 */
function formatNoteContext(notes: HybridSearchResult[]): string {
  return notes
    .map((note, i) => `--- NOTE ${i + 1} (${formatNoteDate(note.createdAt)}) ---\n${resolveNoteText(note)}`)
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
export function sanitizeLLMResponse(text: string): string {
  const withoutTags = text.replace(/<\/?[a-zA-Z!][^>]*>/g, "").trim();
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
  const notes = await hybridSearchNotes(userQuery, CONTEXT_NOTE_LIMIT);

  const citations: RagCitation[] = notes.map((note, i) => ({
    index: i + 1,
    noteId: note.id,
    content: resolveNoteText(note),
    createdAt: note.createdAt,
  }));

  const noteContext = notes.length > 0 ? formatNoteContext(notes) : "No relevant voice notes were found.";

  console.log("[RAG Prompt Context]", noteContext);

  const rawText = await generateLocalRAGAnswer(userQuery, noteContext, (token) => onChunk?.(token));
  return { text: sanitizeLLMResponse(rawText), citations };
}
