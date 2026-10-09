import { generateLocalRAGAnswer } from "./localLlama";
import { setPipelineStage } from "./pipelineStage";
import { buildNoteContext, finalizeAnswer, resolveNoteText } from "./ragFormatting";
import { relatedEvidenceNotes } from "./relationshipGrounding";
import { getNotesForTarget, getRecentNotes, hybridSearchNotes, type HybridSearchResult } from "../notes/noteManager";
import {
  buildGroundedQuestion,
  classifyEventEvidence,
  detectEventVerification,
  questionTerms,
  resolveQueryTemporalTarget,
} from "./temporalResolver";

/**
 * Development-only pipeline trace: question, resolved periods, retrieval
 * decisions, final context, raw model output, validation outcomes. Every
 * call is behind `__DEV__`, which is false in a release bundle (and the
 * branch is stripped from it) — this prints private diary text, so it must
 * never reach a real user's device. Security audit history: an earlier
 * context log here printed unconditionally, in every build, exposing note
 * content to anything with logcat access.
 */
function trace(label: string, data: unknown): void {
  if (__DEV__) {
    console.log(`[RAG_TRACE] ${label}`, typeof data === "string" ? data : JSON.stringify(data));
  }
}

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
  /** Sources of a verified answer — empty whenever the answer was replaced. */
  citations: RagCitation[];
  /** Only when notes WERE shown to the model but no verified answer came
   * back (the model refused, or a validator rejected its answer): the shown
   * notes that are about the question, offered for the user to check
   * themselves. Never proof of anything; empty otherwise. */
  relatedNotes: RagCitation[];
};

/**
 * Retrieves the top matching notes via hybrid search (already RRF-ordered),
 * grounds a local on-device LLM completion in them as a plain-text context
 * block, and resolves with the validated answer text plus the citation list
 * once generation and every post-generation check have finished.
 *
 * `onChunk` is kept for the caller's signature but no longer receives raw
 * tokens — unvalidated text is never shown (see the generation call below).
 */
export async function generateRAGAnswer(
  userQuery: string,
  onChunk?: (chunk: string) => void
): Promise<RagAnswer> {
  setPipelineStage("chat", "retrieving");
  trace("question", userQuery);
  // Priority: a real past-date/period reference ("27th September", "October
  // last year", "in 2024", "2025 compared with 2024") beats everything else —
  // see queryDateRange.ts's own doc comment for why generic semantic/keyword
  // search is the wrong tool for a question whose actual ask is "what's in
  // this window," not "what's topically similar to these words." Falls
  // through to the existing recency bypass, then to hybrid search, for
  // queries that name no real date/period at all.
  // One clock for the whole request: the query's own relative words and the
  // post-generation date check must resolve against the same moment.
  const now = new Date();
  const target = resolveQueryTemporalTarget(userQuery, now);
  // A yes/no question about whether an event happened in the asked period
  // ("Did I celebrate Varun's birthday yesterday?") also needs evidence of
  // the event on OTHER dates — see detectEventVerification.
  const verification = detectEventVerification(userQuery, now, target);
  const eventTerms = verification?.eventTerms ?? [];
  const retrievalPath = target ? "temporal" : isRecentNotesQuery(userQuery) ? "recent" : "hybrid";
  trace("resolved target", { target, retrievalPath, verification });
  const retrieved =
    retrievalPath === "temporal" && target
      ? await getNotesForTarget(target, { question: questionTerms(userQuery, now), event: eventTerms }, CONTEXT_NOTE_LIMIT)
      : retrievalPath === "recent"
        ? await getRecentNotes(CONTEXT_NOTE_LIMIT)
        : await hybridSearchNotes(userQuery, CONTEXT_NOTE_LIMIT);

  // Every relative-time expression in each note is resolved against that
  // note's own createdAt, and each clause is related to the question's
  // periods — the model only verbalizes facts the app has already dated (see
  // temporalResolver.ts). For a temporal question, a note can contribute no
  // lines at all (everything in it is about another period); it is then
  // dropped from the citations too.
  const built = retrieved.length > 0 ? buildNoteContext(retrieved, target, { eventTerms }) : null;
  const included = built ? built.includedIndices : [];
  const notes = included.map((i) => retrieved[i]);
  const memories = built ? included.map((i) => built.memories[i]) : [];
  trace("notes in context", { retrieved: retrieved.length, included: notes.map((n) => n.id) });

  // What the notes establish about the asked-about event: on the queried
  // date, on a different date, or nothing at all — the last is not proof
  // the event didn't happen (finalizeAnswer enforces that).
  const eventEvidence = verification && target ? classifyEventEvidence(memories, target, eventTerms) : null;
  // The question as the model sees it. `userQuery` itself stays untouched for
  // retrieval, chat history and diagnostics.
  const groundedQuestion = verification ? buildGroundedQuestion(userQuery, now) : userQuery;
  trace("event evidence", { eventEvidence, groundedQuestion });

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
    built && notes.length > 0 ? built.contextText : "--- NOTE CONTEXT ---\nNo relevant voice notes were found.";
  trace("context", noteContext);

  // Raw tokens are deliberately NOT forwarded to `onChunk`: an answer the
  // checks below reject must never be visible, not even transiently. The
  // bubble stays empty — so ChatSheetContent.tsx keeps showing the
  // "answering" stage label — until the validated text replaces it.
  setPipelineStage("chat", "answering");
  try {
    const rawText = await generateLocalRAGAnswer(groundedQuestion, noteContext, () => {});
    trace("raw model output", rawText);

    // Shared with the eval scripts — see finalizeAnswer for the order of
    // checks (no notes → refusal mapping → unsupported denial → verification
    // contradiction → date check → relationship check → word grounding →
    // verification addendum). Grounding is checked against the grounded question, since
    // that is what the model actually answered; a correct answer echoing the
    // user's own phrasing was a live bug once, and the inline date the app
    // itself added is equally not something the model invented. Citations are
    // cleared on any replacement: chips next to a rejected answer would imply
    // they back content that was thrown out.
    const result = finalizeAnswer({
      raw: rawText,
      notesIncluded: notes.length,
      contextText: noteContext,
      question: groundedQuestion,
      memories,
      evidence: built ? built.evidence : [],
      target,
      now,
      eventEvidence,
    });
    trace("validation", {
      outcome: result.outcome,
      reason: result.reason,
      dateCheck: result.dateCheck,
      violations: result.relationships?.violations,
      support: result.relationships?.support,
      final: result.text,
    });
    const keepCitations = result.outcome === "shown";
    // No notes shown → no related notes; a verified answer keeps its normal
    // citations instead.
    const relatedIndices =
      keepCitations || result.outcome === "no-notes" || !built ? [] : relatedEvidenceNotes(built.evidence, userQuery, now);
    const relatedNotes = citations.filter((_, k) => relatedIndices.includes(included[k]));
    return { text: result.text, citations: keepCitations ? citations : [], relatedNotes };
  } finally {
    // Ends the answering stage on every path: a validated answer, a thrown
    // error, or the user's cancel (LlamaCancelledError).
    setPipelineStage("chat", null);
  }
}
