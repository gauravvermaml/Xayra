import { generateLocalRAGAnswer } from "./localLlama";
import { hybridSearchNotes, type HybridSearchResult } from "../notes/noteManager";

const CONTEXT_NOTE_LIMIT = 5;

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

/** Minimal XML-escaping — note text is arbitrary transcribed/typed user
 * content, so `&`/`<`/`>` etc. must be escaped to keep the context block
 * well-formed for the model's prompt. */
function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Notes arrive already ordered by reciprocal-rank-fusion score (descending)
 * from `hybridSearchNotes` — that order is preserved here and in the
 * citation list below, so "[Note 1]" is always the strongest match. */
function formatNoteContextXml(notes: HybridSearchResult[]): string {
  const noteTags = notes
    .map(
      (note) =>
        `  <note id="${escapeXml(note.id)}" date="${formatNoteDate(note.createdAt)}">` +
        `${escapeXml(resolveNoteText(note))}</note>`
    )
    .join("\n");
  return `<context>\n${noteTags}\n</context>`;
}

/**
 * Retrieves the top matching notes via hybrid search (already RRF-ordered),
 * grounds a local on-device LLM completion in them as an XML context block,
 * and streams the answer token-by-token through `onChunk` as it's generated.
 * Resolves with the full text plus the citation list once generation ends.
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

  const contextXml =
    notes.length > 0 ? formatNoteContextXml(notes) : "<context>No relevant voice notes were found.</context>";

  console.log("[RAG Prompt Context]", contextXml);

  const text = await generateLocalRAGAnswer(userQuery, contextXml, (token) => onChunk?.(token));
  return { text, citations };
}
