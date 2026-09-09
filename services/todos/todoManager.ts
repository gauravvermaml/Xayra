import * as Crypto from "expo-crypto";

import { getRawDatabase } from "../../db/client";
import type { Recurrence } from "../../db/schema";

export type ToDo = {
  id: string;
  text: string;
  actionDate: string; // ISO YYYY-MM-DD
  isCompleted: boolean;
  recurrence: Recurrence;
  createdAt: string; // ISO timestamp
};

function rowToToDo(row: Record<string, unknown>): ToDo {
  return {
    id: row.id as string,
    text: row.text as string,
    actionDate: row.action_date as string,
    isCompleted: Boolean(row.is_completed),
    recurrence: row.recurrence as Recurrence,
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
 * item in services/ai/transformationEngine.ts's output. */
export async function addToDo(
  text: string,
  actionDate: string,
  recurrence: Recurrence = "none"
): Promise<ToDo> {
  const db = await getRawDatabase();
  const id = Crypto.randomUUID();
  const createdAt = new Date().toISOString();

  await db.execute(
    "INSERT INTO todos (id, text, action_date, is_completed, recurrence, created_at) VALUES (?, ?, ?, 0, ?, ?)",
    [id, text, actionDate, recurrence, createdAt]
  );
  notifyToDosChanged();

  return { id, text, actionDate, isCompleted: false, recurrence, createdAt };
}

/** Lists every not-yet-completed to-do, soonest action date first. Used by
 * the "Your To-Dos" module's default view. */
export async function getPendingToDos(): Promise<ToDo[]> {
  const db = await getRawDatabase();

  const result = await db.execute(
    `
      SELECT id, text, action_date, is_completed, recurrence, created_at
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
}>;

/** Patches one or more editable fields on an existing to-do (e.g. a user
 * correcting a misextracted date or task text). No-ops on an empty patch
 * rather than issuing a no-column `UPDATE ... SET WHERE`. */
export async function updateToDo(id: string, fields: ToDoUpdateFields): Promise<void> {
  const setClauses: string[] = [];
  const params: string[] = [];

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
  if (setClauses.length === 0) {
    return;
  }

  const db = await getRawDatabase();
  params.push(id);
  await db.execute(`UPDATE todos SET ${setClauses.join(", ")} WHERE id = ?`, params);
  notifyToDosChanged();
}

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Advances a recurring to-do's `action_date` by one interval. Parses
 * `action_date` into local-time year/month/day components (rather than
 * `new Date(actionDate)`, which JS parses as UTC midnight) and reconstructs
 * it as a local `Date` before adding the interval — otherwise a device west
 * of UTC would see the date roll back a day on every respawn.
 */
function computeNextActionDate(actionDate: string, recurrence: Recurrence): string {
  const [year, month, day] = actionDate.split("-").map(Number);
  const next = new Date(year, month - 1, day);

  switch (recurrence) {
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
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
    "SELECT text, action_date, recurrence FROM todos WHERE id = ?",
    [id]
  );
  const row = lookup.rows[0];
  if (!row) {
    return;
  }

  const text = row.text as string;
  const actionDate = row.action_date as string;
  const recurrence = row.recurrence as Recurrence;

  await db.transaction(async (tx) => {
    await tx.execute("UPDATE todos SET is_completed = 1, recurrence = 'none' WHERE id = ?", [id]);

    if (recurrence !== "none") {
      const nextDate = computeNextActionDate(actionDate, recurrence);
      const nextId = Crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await tx.execute(
        "INSERT INTO todos (id, text, action_date, is_completed, recurrence, created_at) VALUES (?, ?, ?, 0, ?, ?)",
        [nextId, text, nextDate, recurrence, createdAt]
      );
    }
  });
  notifyToDosChanged();
}
