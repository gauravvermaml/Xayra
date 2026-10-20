import { generateLocalRAGAnswer, LlamaCancelledError } from "./localLlama";
import { isDevelopmentBuild, nowMs } from "./perf";
import { AskProgress } from "./pipelineStage";
import type { CancelSignal } from "./processingJob";
import {
  buildNoteContext,
  finalizeAnswer,
  resolveNoteText,
  UNVERIFIED_ANSWER_MESSAGE,
  UNVERIFIED_NO_RELATED_MESSAGE,
} from "./ragFormatting";
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

let askTimingSeq = 0;

/**
 * Development-only timing for one Ask, tagged with a request id. Logs ONLY
 * event names, elapsed milliseconds and safe metadata (path, counts,
 * lengths, outcome ids) — never question, note or answer text. Off in the
 * production app (see isDevelopmentBuild).
 */
function askTimer(): (event: string, meta?: Record<string, string | number | boolean>) => void {
  const requestId = ++askTimingSeq;
  const start = nowMs();
  const enabled = isDevelopmentBuild();
  return (event, meta) => {
    if (!enabled) return;
    const extra = meta ? ` ${JSON.stringify(meta)}` : "";
    console.log(`[AskTiming] #${requestId} +${(nowMs() - start).toFixed(0)}ms ${event}${extra}`);
  };
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
 *
 * `signal` (the request's ProcessingJob) lets a cancelled request stop
 * before generation starts (retrieval itself isn't interruptible;
 * generation already running is stopped via cancelActiveLlamaCompletion)
 * and ends its progress display the moment it's cancelled.
 *
 * Progress is owned by this request (AskProgress): "Looking through your
 * memories…" during retrieval, then "Found N related memories · Piecing it
 * together…" as generation starts (N = the final notes the model is shown),
 * then the inference phrases until the validated answer or fallback — the
 * answer itself is never shown before validation.
 */
export async function generateRAGAnswer(
  userQuery: string,
  onChunk?: (chunk: string) => void,
  signal?: CancelSignal
): Promise<RagAnswer> {
  const progress = new AskProgress(signal);
  const mark = askTimer();
  try {
    return await answerQuery(userQuery, progress, mark, signal);
  } finally {
    // Answer, fallback, error or cancel — every path ends this request's
    // progress immediately (and only this request's).
    progress.end();
  }
}

async function answerQuery(
  userQuery: string,
  progress: AskProgress,
  mark: ReturnType<typeof askTimer>,
  signal?: CancelSignal
): Promise<RagAnswer> {
  mark("query received");
  progress.retrieving();
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
  mark("retrieval start", { path: retrievalPath });
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
  mark("retrieval complete", { candidates: retrieved.length });
  const built = retrieved.length > 0 ? buildNoteContext(retrieved, target, { eventTerms }) : null;
  const included = built ? built.includedIndices : [];
  const notes = included.map((i) => retrieved[i]);
  const memories = built ? included.map((i) => built.memories[i]) : [];
  trace("notes in context", { retrieved: retrieved.length, included: notes.map((n) => n.id) });
  // The final evidence: exactly the notes the model will be shown.
  mark("evidence ready", { included: notes.length });
  progress.evidence(notes.length);

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
  mark("context ready", { contextChars: noteContext.length });

  // Raw tokens are deliberately NOT forwarded to `onChunk`: an answer the
  // checks below reject must never be visible, not even transiently. The
  // bubble stays empty — so ChatSheetContent.tsx keeps showing the
  // "answering" stage label — until the validated text replaces it.
  if (signal?.cancelled) {
    throw new LlamaCancelledError();
  }

  // ZERO-NOTE FAST PATH: with no notes left after buildNoteContext the
  // outcome is already fixed — finalizeAnswer returns "No information found
  // in your notes." for notesIncluded === 0 whatever the model says — so the
  // model is not run just to produce it. Same text, same empty citations and
  // related notes, through the same finalizeAnswer path; seconds sooner.
  if (notes.length === 0) {
    const result = finalizeAnswer({
      raw: "",
      notesIncluded: 0,
      contextText: noteContext,
      question: groundedQuestion,
      memories,
      evidence: [],
      target,
      now,
      eventEvidence,
    });
    mark("inference skipped (no notes)", { outcome: result.outcome });
    mark("answer ready", { outcome: result.outcome });
    return { text: result.text, citations: [], relatedNotes: [] };
  }

  progress.answering();
  mark("inference start");
  let firstTokenMarked = false;
  const rawText = await generateLocalRAGAnswer(
    groundedQuestion,
    noteContext,
    // Raw tokens are never forwarded anywhere (see above) — only the time
    // of the first one is noted, for dev timing.
    () => {
      if (!firstTokenMarked) {
        firstTokenMarked = true;
        mark("first token");
      }
    },
    { onContextReady: () => mark("model ready") }
  );
  mark("generation complete", { rawChars: rawText.length });
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
  const validationStart = nowMs();
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
  mark("validation complete", { outcome: result.outcome, ms: Math.round(nowMs() - validationStart) });
  trace("validation", {
    outcome: result.outcome,
    reason: result.reason,
    dateCheck: result.dateCheck,
    violations: result.relationships?.violations,
    support: result.relationships?.support,
    final: result.text,
  });
  const keepCitations = result.outcome === "shown";
  const relatedIndices = relatedNoteIndices({
    verified: keepCitations,
    notesShown: result.outcome !== "no-notes" && built !== null,
    retrievalPath,
    included,
    aboutQuestion: () => (built ? relatedEvidenceNotes(built.evidence, userQuery, now) : []),
  });
  const relatedNotes = citations.filter((_, k) => relatedIndices.includes(included[k]));
  mark("answer ready", { outcome: result.outcome, citations: keepCitations ? citations.length : 0, related: relatedNotes.length });
  return { text: unverifiedWording(result.text, relatedNotes.length), citations: keepCitations ? citations : [], relatedNotes };
}

/**
 * Which shown notes are offered as "Related notes" under an answer that
 * couldn't be verified — never as citations, never as proof (Grounding v1).
 * A verified answer keeps its citations instead; no notes shown, none.
 * Normally the shown notes about the question (`aboutQuestion`). A
 * recent-notes request ("summarise my latest notes") is ABOUT the notes it
 * was shown — every one of them is its subject — but has no content words
 * of its own to match, so it got none, and the screen said "I found related
 * notes" over an empty list (Redmi uplift Stage 3). Those are the notes
 * shown, in context order.
 */
export function relatedNoteIndices(args: {
  verified: boolean;
  notesShown: boolean;
  retrievalPath: "temporal" | "recent" | "hybrid";
  included: number[];
  aboutQuestion: () => number[];
}): number[] {
  if (args.verified || !args.notesShown) return [];
  if (args.retrievalPath === "recent") return [...args.included];
  return args.aboutQuestion();
}

/** The unverified fallback promises related notes only when there are some
 * to show (Redmi uplift Stage 3). Only this fixed app message is reworded —
 * a generated answer is never touched. */
export function unverifiedWording(text: string, relatedCount: number): string {
  return text === UNVERIFIED_ANSWER_MESSAGE && relatedCount === 0 ? UNVERIFIED_NO_RELATED_MESSAGE : text;
}
