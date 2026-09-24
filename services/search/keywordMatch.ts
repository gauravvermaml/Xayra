/**
 * Pure keyword-matching logic shared by any list this app lets the user
 * filter by typed text (currently the to-do search bar in
 * components/TodosOverlay.tsx — Build 39's "keyword search bar" — deliberately
 * kept here rather than inline so it's reusable if a notes-list search is
 * ever added; nothing about this function is to-do-specific).
 *
 * A single query ("carpenter") is a plain case-insensitive substring match,
 * same as before this file existed. A query containing one or more literal
 * "+" characters ("soccer+eli") is treated as an AND of every '+'-separated
 * term — every term must appear somewhere in the text, not necessarily
 * adjacent or in that order, for the text to match at all.
 */

/**
 * Whether `text` matches a keyword search `query`.
 *
 * - No `+`: plain case-insensitive substring match (`"carpenter"` matches
 *   "Called the carpenter about the fence").
 * - One or more `+`: every `+`-separated term must be present somewhere in
 *   `text` (AND, not phrase order) — `"soccer+eli"` matches "Eli has soccer
 *   practice Tuesday" but not a note that only mentions one of the two.
 * - Each term is trimmed and lowercased independently, so stray whitespace
 *   around a `+` (`"soccer + eli"`) behaves identically to none.
 * - An empty/whitespace-only query (or one that reduces to zero real terms,
 *   e.g. a bare `"+"`) matches everything — mirrors the "no filter active"
 *   convention the to-do search bar already used before this function
 *   existed, rather than treating a degenerate query as an error.
 */
export function matchesKeywordSearch(text: string, query: string): boolean {
  const terms = query
    .trim()
    .split("+")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);

  if (terms.length === 0) {
    return true;
  }

  const haystack = text.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}
