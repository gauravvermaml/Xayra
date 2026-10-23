/**
 * The one-line summary shown after a restore (Settings and Archive). Pure, so
 * the wording is tested. Counts only — never note or to-do text.
 *
 * When restore kept some of the phone's own records because a newer version
 * couldn't be established safely (services/backup/restoreMerge.ts), it says
 * so, and never claims the phone already has everything.
 */

export const RESTORE_KEPT_ITEMS_SENTENCE = "Some existing items were kept because their changes couldn't be safely compared.";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function restoreSummary(input: {
  /** "your backup of 23 Oct 2026" / "your older backup". */
  from: string;
  addedNotes: number;
  addedTodos: number;
  updatedNotes?: number;
  updatedTodos?: number;
  conflicts?: number;
}): string {
  const added = [input.addedNotes ? plural(input.addedNotes, "note") : "", input.addedTodos ? plural(input.addedTodos, "to-do") : ""].filter(Boolean);
  const updated = [input.updatedNotes ? plural(input.updatedNotes, "note") : "", input.updatedTodos ? plural(input.updatedTodos, "to-do") : ""].filter(Boolean);
  const sentences: string[] = [];
  if (added.length) sentences.push(`Restored ${added.join(" and ")} from ${input.from}.`);
  if (updated.length) sentences.push(`Updated ${updated.join(" and ")} to a newer version from ${added.length ? "it" : input.from}.`);
  if (input.conflicts) {
    return ["Restore completed.", ...sentences, RESTORE_KEPT_ITEMS_SENTENCE].join(" ");
  }
  return sentences.length ? sentences.join(" ") : `Your notes already include everything in ${input.from}.`;
}

/** The alert title: "Already up to date" only when restore added, updated
 * and kept nothing. */
export function restoreTitle(result: { restoredCount: number; restoredToDoCount: number; updatedCount?: number; keptCount?: number }): string {
  if (result.restoredCount || result.restoredToDoCount || result.updatedCount) return "Notes restored";
  return result.keptCount ? "Restore completed" : "Already up to date";
}
