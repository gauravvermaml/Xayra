import { classifyIntentWithLlama, type Intent } from "./localLlama";

export type { Intent };

/**
 * Stage 1 of the two-stage router: obvious question anchors get routed
 * immediately, with no model call at all — this is the common case (most
 * questions start with one of these) and answering it with a keyword check
 * is both instant and free. `\b` word boundaries so e.g. "however" doesn't
 * false-positive on "how".
 */
const QUESTION_ANCHOR_PATTERN =
  /\b(what|where|when|who|how|remind me|did i|search|find|how much)\b/i;

/**
 * Classifies free text as RECORD (save it as a new note) or ASK (treat it
 * as a question for the RAG/Llama pipeline) — shared by both the header
 * compose bar's text submission and the voice pipeline's transcript, so
 * typing and speaking the exact same sentence always route the same way
 * (see app/index.tsx).
 *
 * Stage 2 (an actual Llama call) only runs for text Stage 1's heuristics
 * couldn't confidently place — ambiguous statements without a question
 * anchor, e.g. "milk is in the fridge" vs. "is there milk in the fridge".
 * Falls back to ASK, not RECORD, if Stage 2 itself fails (model not
 * downloaded/loaded yet, a native error): silently mis-filing an ambiguous
 * utterance as a permanent note is worse than answering "I don't have
 * anything on that yet" for a question that got treated as a note lookup.
 */
export async function classifyIntent(text: string): Promise<Intent> {
  if (QUESTION_ANCHOR_PATTERN.test(text)) {
    return "ASK";
  }
  try {
    return await classifyIntentWithLlama(text);
  } catch (err) {
    console.warn("[IntentRouter] Stage 2 classification failed, defaulting to ASK:", err);
    return "ASK";
  }
}
