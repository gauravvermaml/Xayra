/**
 * Log-safe view of a value that may carry the user's words — a transcript,
 * a note, an extracted to-do. Every string becomes its length ("<12
 * chars>"), recursively through arrays and objects; numbers, booleans and
 * null pass through. Diagnostics keep their shape (how many items, which
 * fields, how long) without ever printing personal text, in any build.
 */
export function redactForLog(value: unknown): unknown {
  if (typeof value === "string") return `<${value.length} chars>`;
  if (Array.isArray(value)) return value.map(redactForLog);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, redactForLog(v)]));
  }
  return value;
}

/** Word count of a transcript, for diagnostics that must not include it. */
export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
