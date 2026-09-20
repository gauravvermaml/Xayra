/**
 * The one string both prompts open with, kept in a module that imports
 * nothing.
 *
 * Build 38 PREFIX HARMONIZATION: this exact text, word-for-word including its
 * trailing blank line, begins BOTH the RAG system prompt (localLlama.ts) and
 * the to-do extraction system prompt (transformationEngine.ts). llama.cpp
 * reuses cached KV state only up to the first differing token, so a shared
 * opening means a query landing right after an extraction gets at least this
 * much back from cache instead of re-evaluating from token zero. Editing it in
 * one place and not the other silently destroys that.
 *
 * It lives here rather than in localLlama.ts so the extraction prompt can be
 * built without importing llama.rn. That matters for the Tier 2 eval harness,
 * which runs the same prompts against a desktop llama.cpp binary from plain
 * Node, where native React Native modules cannot load at all.
 */
export const SHARED_XAYRA_PREAMBLE =
  "You are Xayra, an on-device personal voice notes assistant. Audio was processed via STT; contextually correct phonetic typos (e.g., translate \"I need a\" or \"a neater\" to the name \"Anita\").\n\n";
