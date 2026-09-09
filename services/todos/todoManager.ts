import * as Crypto from "expo-crypto";

import { getRawDatabase } from "../../db/client";
import type { Recurrence } from "../../db/schema";

export type ToDo = {
  id: string;
  text: string;
  actionDate: string; // ISO YYYY-MM-DD
  isCompleted: boolean;
  recurrence: Recurrence;
  /** Multiplier on `recurrence`'s unit — see db/schema.ts's doc comment on
   * the `recurrenceInterval` column. Always >= 1. */
  recurrenceInterval: number;
  createdAt: string; // ISO timestamp
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
    isCompleted: Boolean(row.is_completed),
    recurrence: row.recurrence as Recurrence,
    recurrenceInterval: Number.isFinite(interval) && interval >= 1 ? interval : 1,
    createdAt: row.created_at as string,
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

/** Adds a single to-do, either entered directly or from a single extracted
 * item in services/ai/transformationEngine.ts's output. `recurrenceInterval`
 * is clamped to at least 1 — a 0 or negative value would either spawn the
 * next occurrence on the same day (0) or drift backward in time (negative)
 * in computeNextActionDate below. */
export async function addToDo(
  text: string,
  actionDate: string,
  recurrence: Recurrence = "none",
  recurrenceInterval = 1
): Promise<ToDo> {
  const db = await getRawDatabase();
  const id = Crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const interval = recurrenceInterval >= 1 ? Math.round(recurrenceInterval) : 1;

  await db.execute(
    "INSERT INTO todos (id, text, action_date, is_completed, recurrence, recurrence_interval, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
    [id, text, actionDate, recurrence, interval, createdAt]
  );
  notifyToDosChanged();

  return { id, text, actionDate, isCompleted: false, recurrence, recurrenceInterval: interval, createdAt };
}

/** Lists every not-yet-completed to-do, soonest action date first. Used by
 * the "Your To-Dos" module's default view. */
export async function getPendingToDos(): Promise<ToDo[]> {
  const db = await getRawDatabase();

  const result = await db.execute(
    `
      SELECT id, text, action_date, is_completed, recurrence, recurrence_interval, created_at
      FROM todos
      WHERE is_completed = 0
      ORDER BY action_date ASC, created_at ASC
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

export type ToDoUpdateFields = Partial<{
  text: string;
  actionDate: string;
  recurrence: Recurrence;
  recurrenceInterval: number;
}>;

/** Patches one or more editable fields on an existing to-do (e.g. a user
 * correcting a misextracted date or task text). No-ops on an empty patch
 * rather than issuing a no-column `UPDATE ... SET WHERE`. */
export async function updateToDo(id: string, fields: ToDoUpdateFields): Promise<void> {
  const setClauses: string[] = [];
  const params: (string | number)[] = [];

  if (fields.text !== undefined) {
    setClauses.push("text = ?");
    params.push(fields.text);
  }
  if (fields.actionDate !== undefined) {
    setClauses.push("action_date = ?");
    params.push(fields.actionDate);
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
}

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

/**
 * Marks a to-do done. If it recurs, this also spawns the next occurrence as
 * a brand-new row rather than just rewriting `action_date` in place, so the
 * completed occurrence stays in history as its own row (e.g. for a future
 * "completed to-dos" list) instead of being overwritten and lost. The
 * completed row's own `recurrence` is reset to `'none'` so it can never spawn
 * again itself — only the fresh row carries the original recurrence forward.
 * Both writes happen in one transaction so a crash between them can never
 * leave a recurring to-do completed with no successor.
 */
export async function completeToDo(id: string): Promise<void> {
  const db = await getRawDatabase();

  const lookup = await db.execute(
    "SELECT text, action_date, recurrence, recurrence_interval FROM todos WHERE id = ?",
    [id]
  );
  const row = lookup.rows[0];
  if (!row) {
    return;
  }

  const text = row.text as string;
  const actionDate = row.action_date as string;
  const recurrence = row.recurrence as Recurrence;
  const rawInterval = Number(row.recurrence_interval);
  const recurrenceInterval = Number.isFinite(rawInterval) && rawInterval >= 1 ? rawInterval : 1;

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
      const nextId = Crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await tx.execute(
        "INSERT INTO todos (id, text, action_date, is_completed, recurrence, recurrence_interval, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)",
        [nextId, text, nextDate, recurrence, recurrenceInterval, createdAt]
      );
    }
  });
  notifyToDosChanged();
}
