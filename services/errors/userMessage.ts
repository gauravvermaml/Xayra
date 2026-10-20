import { devTiming } from "../ai/perf";

/**
 * The one way an error's text reaches a screen. Messages Xayra wrote for the
 * user pass through; raw technical text — Java exceptions, failed fetches,
 * SQLite errors, Google sign-in diagnostics, JS engine errors — becomes a
 * plain message saying what to do. The raw text goes to development logs
 * only (it carries error metadata, never note text), so it stays diagnosable.
 */

export const NETWORK_MESSAGE = "Xayra couldn't reach Google. Check your internet connection and try again.";
export const DATABASE_MESSAGE = "Xayra couldn't read or save your notes just now. Close and reopen Xayra, then try again.";

const NETWORK_PATTERN =
  /fetch failed|network request failed|unknownhostexception|unable to resolve host|failed to connect to|connectexception|sockettimeoutexception|sslexception|econnrefused|econnreset|enotfound|no address associated with hostname|^network ?error$|network_error/i;
const DATABASE_PATTERN = /sqlite|sqlcipher|no such (table|column)|database (is locked|disk image)|constraint failed|op-sqlite/i;
const RAW_PATTERN =
  /java\.|kotlin\.|exception|\berror code\b|code=|developer_error|sha-1|client id|package name|undefined is not|null is not|cannot read propert|is not a function|typeerror|referenceerror|syntaxerror|\bat \S+ \(|injected failure|err_[a-z_]+|\[object /i;

export type UserMessageKind = "authored" | "network" | "database" | "raw";

export function classifyErrorText(text: string): UserMessageKind {
  if (NETWORK_PATTERN.test(text)) return "network";
  if (DATABASE_PATTERN.test(text)) return "database";
  if (RAW_PATTERN.test(text) || text.length > 400) return "raw";
  return "authored";
}

/** A user-facing message for `err`; `fallback` when its own text isn't one. */
export function userFacingMessage(err: unknown, fallback: string): string {
  const text = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (!text.trim()) return fallback;
  const kind = classifyErrorText(text);
  if (kind === "authored") return text;
  devTiming("Error", "raw error replaced for display", {
    kind,
    name: err instanceof Error ? err.name : typeof err,
    detail: text.slice(0, 300),
  });
  if (kind === "network") return NETWORK_MESSAGE;
  if (kind === "database") return DATABASE_MESSAGE;
  return fallback;
}
