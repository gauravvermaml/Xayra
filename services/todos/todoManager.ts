import * as Crypto from "expo-crypto";

import { getRawDatabase } from "../../db/client";
import { DEFAULT_NOTIFICATION_TIME, type Recurrence } from "../../db/schema";
import { cancelToDoNotification, scheduleToDoNotification } from "../notifications/todoNotifications";

export type ToDo = {
  id: string;
  text: string;
  actionDate: string; // ISO YYYY-MM-DD
  /** End of a date span ("from 27th Sep to 10th Oct") — see db/schema.ts's
   * `toDate` doc comment. Null for the (far more common) single-day to-do. */
  toDate: string | null;
  /** 24-hour "HH:MM" local reminder time — see db/schema.ts's
   * `notificationTime`/`DEFAULT_NOTIFICATION_TIME` doc comments. */
  notificationTime: string;
  isCompleted: boolean;
  recurrence: Recurrence;
  /** Multiplier on `recurrence`'s unit — see db/schema.ts's doc comment on
   * the `recurrenceInterval` column. Always >= 1. */
  recurrenceInterval: number;
  createdAt: string; // ISO timestamp
  /** The note this was auto-extracted from — see db/schema.ts's `noteId`
   * doc comment. Null for a to-do entered directly via the Add modal. */
  noteId: string | null;
};

function rowToToDo(row: Record<string, unknown>): ToDo {
  // `?? 1` covers a row written before this column existed reaching here
  // between the ALTER TABLE migration and any backfill — op-sqlite returns
  // the column's own DEFAULT 1 for those anyway, so this is a belt-and-
  // suspenders fallback, not the primary path.
  const interval = Number(row.recurrence_interval);
  return {
    id: row.id as string,
    text: row.text as string,
    actionDate: row.action_date as string,
    toDate: (row.to_date as string | null) ?? null,
    // Same belt-and-suspenders fallback as `recurrenceInterval` above, for a
    // row written before this column existed — op-sqlite's own column
    // DEFAULT already covers this in practice, but a falsy/missing value
    // here should never surface as an empty string to a caller.
    notificationTime: (row.notification_time as string | null) || DEFAULT_NOTIFICATION_TIME,
    isCompleted: Boolean(row.is_completed),
    recurrence: row.recurrence as Recurrence,
    recurrenceInterval: Number.isFinite(interval) && interval >= 1 ? interval : 1,
    createdAt: row.created_at as string,
    noteId: (row.note_id as string | null) ?? null,
  };
}

/**
 * Plain in-process pub/sub so every hooks/useToDos.ts instance across the app
 * — the home screen's pill and the /todos screen's list are two separate
 * instances — refreshes the moment ANY write happens, not just on its own
 * next screen focus. Without this, a to-do added by
 * services/notes/noteManager.ts's background extraction pipeline (which
 * calls addToDo() directly, with nothing else on screen to trigger a
 * re-render) left the home screen's pill count stale until the user
 * navigated away and back — confirmed on-device: the count only updated
 * after visiting /todos and returning, which is exactly what re-triggers
 * useToDos' useFocusEffect. A plain module-level Set of listeners is enough
 * here — this only ever runs within one JS context, never across processes,
 * so there's no need for anything heavier (an EventEmitter import, a context
 * provider) just to fan a "something changed" signal out to a handful of
 * hook instances.
 */
type ToDosChangedListener = () => void;
const changeListeners = new Set<ToDosChangedListener>();

/** Subscribes to every todos write (add/update/complete). Returns an
 * unsubscribe function — call it on unmount, same shape as any other
 * addEventListener-style API in this codebase. */
export function subscribeToToDosChanged(listener: ToDosChangedListener): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function notifyToDosChanged(): void {
  changeListeners.forEach((listener) => listener());
}

export type AddToDoInput = {
  text: string;
  actionDate: string;
  /** See db/schema.ts's `toDate` doc comment. Omit or pass null for a
   * single-day to-do (the common case). */
  toDate?: string | null;
  /** See db/schema.ts's `notificationTime`/`DEFAULT_NOTIFICATION_TIME` doc
   * comments. Omit to use the 5 AM default. */
  notificationTime?: string;
  recurrence?: Recurrence;
  recurrenceInterval?: number;
  noteId?: string | null;
};

/**
 * Adds a single to-do, either entered directly (no `noteId`) or from a
 * single extracted item in services/ai/transformationEngine.ts's output
 * (`noteId` = the note it came from, wired through by noteManager.ts's
 * `scheduleToDoExtraction`). `recurrenceInterval` is clamped to at least 1 —
 * a 0 or negative value would either spawn the next occurrence on the same
 * day (0) or drift backward in time (negative) in computeNextActionDate
 * below.
 *
 * An options object, not positional params — Phase 2 Step 4 added two more
 * optional fields (`toDate`, `notificationTime`) on top of the existing
 * `recurrence`/`recurrenceInterval`/`noteId`, which would have made a 7th
 * and 8th positional argument; `updateToDo` already took this shape (see
 * `ToDoUpdateFields` below) for the same reason.
 *
 * Schedules (fire-and-forget) this to-do's local reminder notification via
 * services/notifications/todoNotifications.ts once the row is written —
 * never awaited, and any scheduling failure there is already swallowed
 * internally (soft-failure by design): a to-do must always save
 * successfully regardless of whether its reminder could be scheduled.
 */
export async function addToDo(input: AddToDoInput): Promise<ToDo> {
  const {
    text,
    actionDate,
    toDate = null,
    notificationTime = DEFAULT_NOTIFICATION_TIME,
    recurrence = "none",
    recurrenceInterval = 1,
    noteId = null,
  } = input;

  const db = await getRawDatabase();
  const id = Crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const interval = recurrenceInterval >= 1 ? Math.round(recurrenceInterval) : 1;

  await db.execute(
    "INSERT INTO todos (id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
    [id, text, actionDate, toDate, notificationTime, recurrence, interval, createdAt, noteId]
  );
  notifyToDosChanged();

  const toDo: ToDo = {
    id,
    text,
    actionDate,
    toDate,
    notificationTime,
    isCompleted: false,
    recurrence,
    recurrenceInterval: interval,
    createdAt,
    noteId,
  };
  void scheduleToDoNotification(toDo);
  return toDo;
}

/** Lists every not-yet-completed to-do, soonest action date first. Used by
 * the "Your To-Dos" module's default view. */
export async function getPendingToDos(): Promise<ToDo[]> {
  const db = await getRawDatabase();

  const result = await db.execute(
    `
      SELECT id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id
      FROM todos
      WHERE is_completed = 0
      ORDER BY action_date ASC, created_at ASC
    `
  );

  return result.rows.map(rowToToDo);
}

/** Every to-do regardless of completion status — unlike `getPendingToDos()`,
 * which is scoped to what "Your To-Dos" shows. Added for `driveSync.ts`'s
 * delta backup (2026-09-16): a completed to-do is still real data a backup
 * must not silently drop. */
export async function listAllToDos(): Promise<ToDo[]> {
  const db = await getRawDatabase();

  const result = await db.execute(
    `
      SELECT id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id
      FROM todos
      ORDER BY created_at ASC
    `
  );

  return result.rows.map(rowToToDo);
}

/** Cheap count-only query for a badge/pill UI that just needs "how many" —
 * avoids pulling every pending row's full text over the bridge just to
 * measure `.length`. */
export async function getPendingCount(): Promise<number> {
  const db = await getRawDatabase();
  const result = await db.execute("SELECT COUNT(*) as count FROM todos WHERE is_completed = 0");
  return (result.rows[0]?.count as number | undefined) ?? 0;
}

/** Single-row lookup by id, used by `updateToDo` below to re-read the
 * merged post-update state (needed to reschedule a notification correctly —
 * any one of text/actionDate/notificationTime could have just changed) and
 * available for any future caller that needs one full row rather than the
 * whole pending list. */
async function getToDoById(id: string): Promise<ToDo | null> {
  const db = await getRawDatabase();
  const result = await db.execute(
    "SELECT id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id FROM todos WHERE id = ?",
    [id]
  );
  const row = result.rows[0];
  return row ? rowToToDo(row) : null;
}

export type ToDoUpdateFields = Partial<{
  text: string;
  actionDate: string;
  toDate: string | null;
  notificationTime: string;
  recurrence: Recurrence;
  recurrenceInterval: number;
}>;

/**
 * Patches one or more editable fields on an existing to-do (e.g. a user
 * correcting a misextracted date or task text). No-ops on an empty patch
 * rather than issuing a no-column `UPDATE ... SET WHERE`.
 *
 * Re-reads the row after writing and reschedules its notification via
 * services/notifications/todoNotifications.ts (fire-and-forget) — any one
 * of text/actionDate/notificationTime could have just changed, and
 * `scheduleToDoNotification` always works from the CURRENT full row rather
 * than trying to patch an already-scheduled native trigger in place.
 */
export async function updateToDo(id: string, fields: ToDoUpdateFields): Promise<void> {
  const setClauses: string[] = [];
  const params: (string | null | number)[] = [];

  if (fields.text !== undefined) {
    setClauses.push("text = ?");
    params.push(fields.text);
  }
  if (fields.actionDate !== undefined) {
    setClauses.push("action_date = ?");
    params.push(fields.actionDate);
  }
  if (fields.toDate !== undefined) {
    setClauses.push("to_date = ?");
    params.push(fields.toDate);
  }
  if (fields.notificationTime !== undefined) {
    setClauses.push("notification_time = ?");
    params.push(fields.notificationTime);
  }
  if (fields.recurrence !== undefined) {
    setClauses.push("recurrence = ?");
    params.push(fields.recurrence);
  }
  if (fields.recurrenceInterval !== undefined) {
    setClauses.push("recurrence_interval = ?");
    params.push(fields.recurrenceInterval >= 1 ? Math.round(fields.recurrenceInterval) : 1);
  }
  if (setClauses.length === 0) {
    return;
  }

  const db = await getRawDatabase();
  params.push(id);
  await db.execute(`UPDATE todos SET ${setClauses.join(", ")} WHERE id = ?`, params);
  notifyToDosChanged();

  const updated = await getToDoById(id);
  if (updated && !updated.isCompleted) {
    void scheduleToDoNotification(updated);
  }
}

/**
 * Permanently removes a to-do — the escape hatch for a wrongly-extracted
 * item (most commonly one the model incorrectly tagged as recurring, or
 * invented from a note that wasn't actually a task) that a plain "complete"
 * tap can't get rid of: completing a recurring to-do respawns its next
 * occurrence by design, so it would keep coming back forever instead of
 * going away. A no-op if the id no longer exists (already deleted from
 * another screen, say) rather than throwing.
 */
export async function deleteToDo(id: string): Promise<void> {
  const db = await getRawDatabase();
  await db.execute("DELETE FROM todos WHERE id = ?", [id]);
  notifyToDosChanged();
  void cancelToDoNotification(id);
}

/** A to-do as read out of a downloaded Google Drive backup database — see
 * driveSync.ts's `restoreFromDrive()`, which opens that backup as a second,
 * read-only op-sqlite connection and extracts rows in this shape before
 * handing them here. Mirrors `ToDo` field-for-field (unlike
 * services/notes/noteManager.ts's `CloudNoteRecord`, there's no `audioUri`-
 * style field to exclude — a to-do carries no on-disk asset of its own). */
export type CloudToDoRecord = {
  id: string;
  text: string;
  actionDate: string;
  toDate: string | null;
  notificationTime: string;
  isCompleted: boolean;
  recurrence: Recurrence;
  recurrenceInterval: number;
  createdAt: string;
  noteId: string | null;
};

/**
 * Delta/merge restore: inserts only the cloud to-dos this device doesn't
 * already have (matched by `id`), never overwriting or duplicating one that
 * already exists locally — same idempotent shape as
 * services/notes/noteManager.ts's `mergeMissingNotes`, which
 * driveSync.ts's `restoreFromDrive()` calls alongside this one restore run.
 *
 * A restored to-do that's still pending (`isCompleted` false) gets its local
 * notification (re-)scheduled via `scheduleToDoNotification` — the same
 * function every other write path in this file already goes through, so the
 * "already in the past? cancel instead of scheduling" check lives in exactly
 * one place rather than being duplicated here. This is what actually
 * re-registers the native Android alarm on a new device: a backup restored
 * on a fresh install would otherwise leave every pending to-do with no
 * reminder at all until it was next edited. Returns the number of to-dos
 * actually restored.
 */
export async function mergeMissingToDos(cloudToDos: CloudToDoRecord[]): Promise<number> {
  const db = await getRawDatabase();

  const localIdsResult = await db.execute("SELECT id FROM todos");
  const localIds = new Set(localIdsResult.rows.map((row) => row.id as string));
  const missingToDos = cloudToDos.filter((todo) => !localIds.has(todo.id));
  if (missingToDos.length === 0) {
    return 0;
  }

  await db.transaction(async (tx) => {
    for (const todo of missingToDos) {
      // `INSERT OR IGNORE` is belt-and-suspenders against the id already
      // existing — the id filter above already guarantees that in the
      // common case, but guards against the same to-do being created
      // locally (e.g. re-extracted from a note also being restored right
      // now) in the moment between that filter and this transaction
      // committing.
      await tx.execute(
        `INSERT OR IGNORE INTO todos
           (id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          todo.id,
          todo.text,
          todo.actionDate,
          todo.toDate,
          todo.notificationTime,
          todo.isCompleted ? 1 : 0,
          todo.recurrence,
          todo.recurrenceInterval,
          todo.createdAt,
          todo.noteId,
        ]
      );
    }
  });

  notifyToDosChanged();

  for (const todo of missingToDos) {
    if (todo.isCompleted) {
      continue;
    }
    void scheduleToDoNotification({
      id: todo.id,
      text: todo.text,
      actionDate: todo.actionDate,
      toDate: todo.toDate,
      notificationTime: todo.notificationTime,
      isCompleted: false,
      recurrence: todo.recurrence,
      recurrenceInterval: todo.recurrenceInterval,
      createdAt: todo.createdAt,
      noteId: todo.noteId,
    });
  }

  return missingToDos.length;
}

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Adds `days` (may be negative) to a local YYYY-MM-DD date and returns the
 * result as a `Date` — a small shared primitive `daysBetweenLocal`'s own
 * caller below uses to reconstruct a shifted `to_date` from a day count,
 * same local-components approach as every other date computation here. */
function shiftLocalDate(iso: string, days: number): Date {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return date;
}

/**
 * Advances a recurring to-do's `action_date` by `interval` units of
 * `recurrence` — `("weekly", 2)` means 2 weeks, matching the standard
 * iCalendar RRULE FREQ+INTERVAL pattern (see db/schema.ts's doc comment on
 * `recurrenceInterval`). Parses `action_date` into local-time year/month/day
 * components (rather than `new Date(actionDate)`, which JS parses as UTC
 * midnight) and reconstructs it as a local `Date` before adding the
 * interval — otherwise a device west of UTC would see the date roll back a
 * day on every respawn.
 */
function computeNextActionDate(actionDate: string, recurrence: Recurrence, interval: number): string {
  const [year, month, day] = actionDate.split("-").map(Number);
  const next = new Date(year, month - 1, day);
  const step = interval >= 1 ? interval : 1;

  switch (recurrence) {
    case "daily":
      next.setDate(next.getDate() + step);
      break;
    case "weekly":
      next.setDate(next.getDate() + step * 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + step);
      break;
    case "none":
      return actionDate;
  }

  return formatIsoDate(next);
}

/** Whole-day difference between two local YYYY-MM-DD dates (`to` minus
 * `from`), used only to preserve a date range's LENGTH across a recurring
 * respawn below — e.g. a 3-day-long recurring to-do's next occurrence
 * should still span 3 days, not carry forward the same absolute `to_date`
 * (which could now be before the new `action_date` entirely, or the same
 * length by coincidence only on the first respawn). Computed via local
 * `Date` components (never `new Date(iso)`, the same UTC-midnight trap every
 * other date computation in this file already avoids) and rounded — day-
 * count subtraction between two local midnights is always a whole number
 * except across a DST transition, where `Math.round` lands on the
 * calendar-day count a user actually means rather than a fractional one. */
function daysBetweenLocal(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = new Date(fy, fm - 1, fd);
  const to = new Date(ty, tm - 1, td);
  return Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
}

/**
 * Marks a to-do done. If it recurs, this also spawns the next occurrence as
 * a brand-new row rather than just rewriting `action_date` in place, so the
 * completed occurrence stays in history as its own row (e.g. for a future
 * "completed to-dos" list) instead of being overwritten and lost. The
 * completed row's own `recurrence` is reset to `'none'` so it can never spawn
 * again itself — only the fresh row carries the original recurrence forward.
 * Both writes happen in one transaction so a crash between them can never
 * leave a recurring to-do completed with no successor.
 *
 * Cancels the completed row's own scheduled notification (it's done, its
 * reminder no longer means anything) and, if a next occurrence was spawned,
 * schedules a fresh notification for THAT row — never the other way around,
 * and never reusing the completed row's now-cancelled trigger.
 */
export async function completeToDo(id: string): Promise<void> {
  const db = await getRawDatabase();

  const lookup = await db.execute(
    "SELECT text, action_date, to_date, notification_time, recurrence, recurrence_interval, note_id FROM todos WHERE id = ?",
    [id]
  );
  const row = lookup.rows[0];
  if (!row) {
    return;
  }

  const text = row.text as string;
  const actionDate = row.action_date as string;
  const toDate = (row.to_date as string | null) ?? null;
  const notificationTime = (row.notification_time as string | null) || DEFAULT_NOTIFICATION_TIME;
  const recurrence = row.recurrence as Recurrence;
  const rawInterval = Number(row.recurrence_interval);
  const recurrenceInterval = Number.isFinite(rawInterval) && rawInterval >= 1 ? rawInterval : 1;
  const noteId = (row.note_id as string | null) ?? null;

  let respawned: ToDo | null = null;

  await db.transaction(async (tx) => {
    // recurrence_interval is also reset to 1 alongside recurrence — a
    // completed row is done for good, so its interval no longer means
    // anything; only the freshly-spawned row below carries it forward.
    await tx.execute(
      "UPDATE todos SET is_completed = 1, recurrence = 'none', recurrence_interval = 1 WHERE id = ?",
      [id]
    );

    if (recurrence !== "none") {
      const nextDate = computeNextActionDate(actionDate, recurrence, recurrenceInterval);
      // Preserve the range's LENGTH, not its absolute end date — see
      // daysBetweenLocal's own doc comment.
      const nextToDate = toDate ? formatIsoDate(shiftLocalDate(nextDate, daysBetweenLocal(actionDate, toDate))) : null;
      const nextId = Crypto.randomUUID();
      const createdAt = new Date().toISOString();
      // note_id carries forward too — the respawned occurrence is still the
      // same recurring task traced back to the same original note.
      await tx.execute(
        "INSERT INTO todos (id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?)",
        [nextId, text, nextDate, nextToDate, notificationTime, recurrence, recurrenceInterval, createdAt, noteId]
      );
      respawned = {
        id: nextId,
        text,
        actionDate: nextDate,
        toDate: nextToDate,
        notificationTime,
        isCompleted: false,
        recurrence,
        recurrenceInterval,
        createdAt,
        noteId,
      };
    }
  });
  notifyToDosChanged();

  void cancelToDoNotification(id);
  if (respawned) {
    void scheduleToDoNotification(respawned);
  }
}
