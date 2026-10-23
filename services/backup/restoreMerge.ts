/**
 * Restore merge rules for records that exist BOTH on this phone and in the
 * backup — pure, so every rule is tested on its own (no database, no Drive).
 *
 * Restore used to only insert records the phone didn't have, so a phone
 * holding an older copy of an edited note or to-do kept it forever. For each
 * record id held on both sides the newest version now wins, conservatively:
 *
 *  - Same content → nothing to do.
 *  - The backup's copy has no timestamp → keep the phone's ("no chronology
 *    is invented").
 *  - The phone's copy is newer → keep it.
 *  - Same timestamp, different content → keep the phone's; reported as a
 *    conflict, never silently overwritten.
 *  - The backup's copy is newer (or the phone's has no timestamp — it hasn't
 *    changed since timestamps existed) → replace, BUT only when the phone's
 *    current version is itself in one of the verified backups just read.
 *    Then nothing is lost: that version stays in an immutable backup
 *    generation. A phone version found in no backup is a change not yet
 *    backed up and is kept (a conflict). This also guards against the one
 *    known timestamp weakness: a backup copy's time is when it was first
 *    copied into a backup, which can be later than the edit itself.
 *
 * Records only on the phone are kept; records only in the backup are
 * inserted by the existing insert path. Nothing is ever deleted (backups
 * keep no deletions, so a record deleted on the phone since a backup comes
 * back on restore — the existing behaviour, unchanged here).
 */

/** A note version, from the phone or a backup. `updatedAt`: seconds. */
export type NoteVersion = { id: string; content: string; transcript: string | null; updatedAt?: number | null };

/** A to-do version, from the phone or a backup. `updatedAt`: milliseconds. */
export type ToDoVersion = {
  id: string;
  text: string;
  actionDate: string;
  toDate: string | null;
  notificationTime: string;
  isCompleted: boolean;
  recurrence: string;
  recurrenceInterval: number;
  noteId: string | null;
  updatedAt?: number | null;
};

export type RestoreConflictReason = "same-time-different-content" | "backup-has-no-time" | "phone-change-not-backed-up";
export type RestoreConflict = { id: string; reason: RestoreConflictReason };

export type RestorePlan<R> = { updates: R[]; conflicts: RestoreConflict[] };

const time = (t: number | null | undefined): number | null => (typeof t === "number" && Number.isFinite(t) ? t : null);

export function sameNote(a: NoteVersion, b: NoteVersion): boolean {
  return a.content === b.content && (a.transcript ?? null) === (b.transcript ?? null);
}

/** Every field a to-do's behaviour depends on — text, schedule, recurrence,
 * completion and the note it came from — compared together, so a replace
 * always takes one consistent version, never a mix. */
export function sameToDo(a: ToDoVersion, b: ToDoVersion): boolean {
  return (
    a.text === b.text &&
    a.actionDate === b.actionDate &&
    (a.toDate ?? null) === (b.toDate ?? null) &&
    a.notificationTime === b.notificationTime &&
    a.isCompleted === b.isCompleted &&
    a.recurrence === b.recurrence &&
    a.recurrenceInterval === b.recurrenceInterval &&
    (a.noteId ?? null) === (b.noteId ?? null)
  );
}

/**
 * One version per id from several verified backups (several heads after
 * phones backed up at the same time), given newest backup first: the copy
 * with the newest timestamp; a copy without one loses to any that has one;
 * on a tie the newest backup's copy (the order given).
 */
export function newestPerId<R extends { id: string; updatedAt?: number | null }>(backups: R[][]): R[] {
  const chosen = new Map<string, R>();
  for (const records of backups) {
    for (const record of records) {
      const held = chosen.get(record.id);
      if (!held) {
        chosen.set(record.id, record);
        continue;
      }
      const t = time(record.updatedAt);
      const h = time(held.updatedAt);
      if (t !== null && (h === null || t > h)) chosen.set(record.id, record);
    }
  }
  return [...chosen.values()];
}

/** Every version of each id across the verified backups — what "already
 * backed up" is checked against. */
export function versionsById<R extends { id: string }>(backups: R[][]): Map<string, R[]> {
  const all = new Map<string, R[]>();
  for (const records of backups) {
    for (const record of records) all.set(record.id, [...(all.get(record.id) ?? []), record]);
  }
  return all;
}

function plan<R extends { id: string; updatedAt?: number | null }>(
  local: R[],
  remote: R[],
  backedUp: Map<string, R[]>,
  same: (a: R, b: R) => boolean
): RestorePlan<R> {
  const onPhone = new Map(local.map((r) => [r.id, r]));
  const updates: R[] = [];
  const conflicts: RestoreConflict[] = [];
  for (const theirs of remote) {
    const ours = onPhone.get(theirs.id);
    if (!ours || same(ours, theirs)) continue;
    const t = time(theirs.updatedAt);
    const o = time(ours.updatedAt);
    if (t === null) {
      conflicts.push({ id: theirs.id, reason: "backup-has-no-time" });
      continue;
    }
    if (o !== null && t < o) continue;
    if (o !== null && t === o) {
      conflicts.push({ id: theirs.id, reason: "same-time-different-content" });
      continue;
    }
    if ((backedUp.get(theirs.id) ?? []).some((version) => same(version, ours))) {
      updates.push(theirs);
    } else {
      conflicts.push({ id: theirs.id, reason: "phone-change-not-backed-up" });
    }
  }
  return { updates, conflicts };
}

export function planNoteRestore(local: NoteVersion[], remote: NoteVersion[], backedUp: Map<string, NoteVersion[]>): RestorePlan<NoteVersion> {
  return plan(local, remote, backedUp, sameNote);
}

export function planToDoRestore(local: ToDoVersion[], remote: ToDoVersion[], backedUp: Map<string, ToDoVersion[]>): RestorePlan<ToDoVersion> {
  return plan(local, remote, backedUp, sameToDo);
}
