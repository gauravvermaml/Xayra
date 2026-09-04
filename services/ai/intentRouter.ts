import { classifyIntentWithLlama, type Intent } from "./localLlama";

export type { Intent };

/**
 * Tier 1a of the three-tier router (Build 20 refinement): a trailing "?" is
 * an unconditional ASK, checked before anything else — punctuation is a
 * stronger, cheaper signal than any keyword list and should win outright
 * regardless of what words came before it.
 */
const TRAILING_QUESTION_MARK_PATTERN = /\?\s*$/;

/**
 * Tier 1b: strict interrogative starters. Deliberately narrow — "what",
 * "where", "when", "why", "who", "how", "which" only. General verbs like
 * "do", "have", "will", "is" are intentionally absent: "Do laundry" and
 * "Have a meeting" are notes, not questions, and including verbs that common
 * imperative/statement sentences also start with would false-positive them
 * into ASK. `\b` word boundaries so e.g. "however" doesn't false-positive on
 * "how".
 */
const QUESTION_ANCHOR_PATTERN = /\b(what|where|when|why|who|how|which)\b/i;

/**
 * Tier 1b (cont.): explicit query phrases — multi-word requests that are
 * unambiguously asking for something back, independent of the interrogative
 * word list above.
 */
const EXPLICIT_QUERY_PHRASE_PATTERN = /\b(remind me|can you tell me|search for|find my|show me|recall)\b/i;

/**
 * Classifies free text as RECORD (save it as a new note) or ASK (treat it
 * as a question for the RAG/Llama pipeline) — shared by both the header
 * compose bar's text submission and the voice pipeline's transcript, so
 * typing and speaking the exact same sentence always route the same way
 * (see app/index.tsx). RECORD writes to SQLite + the vector index and never
 * touches the RAG/Llama pipeline; ASK runs retrieval + generation and never
 * writes a note — the two are mutually exclusive by construction in
 * app/index.tsx's routeFreeformInput, not just by convention here.
 *
 * Stage 2 (an actual Llama call) only runs for text Tier 1's heuristics
 * couldn't confidently place — ambiguous statements without a trailing "?"
 * or a question anchor, e.g. "milk is in the fridge" vs. "is there milk in
 * the fridge". Falls back to ASK, not RECORD, if Stage 2 itself fails (model
 * not downloaded/loaded yet, a native error): silently mis-filing an
 * ambiguous utterance as a permanent note is worse than answering "I don't
 * have anything on that yet" for a question that got treated as a note
 * lookup.
 */
export async function classifyIntent(text: string): Promise<Intent> {
  if (TRAILING_QUESTION_MARK_PATTERN.test(text.trim())) {
    return "ASK";
  }
  if (QUESTION_ANCHOR_PATTERN.test(text) || EXPLICIT_QUERY_PHRASE_PATTERN.test(text)) {
    return "ASK";
  }
  try {
    return await classifyIntentWithLlama(text);
  } catch (err) {
    console.warn("[IntentRouter] Stage 2 classification failed, defaulting to ASK:", err);
    return "ASK";
  }
}
