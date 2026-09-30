import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";

import {
  addToDo as addToDoRecord,
  completeToDo as completeToDoRecord,
  deleteToDo as deleteToDoRecord,
  getPendingToDos,
  listAllToDos,
  removeToDoFromCalendar as removeToDoFromCalendarRecord,
  sendToDoToCalendar as sendToDoToCalendarRecord,
  subscribeToToDosChanged,
  updateToDo as updateToDoRecord,
  type AddToDoInput,
  type ToDo,
  type ToDoUpdateFields,
} from "../services/todos/todoManager";

export type UseToDosResult = {
  todos: ToDo[];
  /** Every to-do regardless of completion status — for the calendar grid
   * views (Day/Work Week/Week/Month) ONLY. Per explicit product decision, a
   * to-do's calendar entry behaves like a Google Calendar event: it keeps
   * showing, indefinitely, once checked off, styled no differently than a
   * pending one. `todos` above stays pending-only for everything else
   * (Schedule view, the pending-count badge) — completing a recurring to-do
   * should still make the just-finished occurrence disappear from Schedule
   * and the freshly-spawned next occurrence take its place there, unchanged
   * from today's behavior. Reuses `listAllToDos()` (already existed for
   * driveSync's delta backup), not a new query. */
  allTodos: ToDo[];
  pendingCount: number;
  refreshToDos: () => Promise<void>;
  addToDo: (input: AddToDoInput) => Promise<void>;
  updateToDo: (id: string, fields: ToDoUpdateFields) => Promise<void>;
  completeToDo: (id: string) => Promise<void>;
  deleteToDo: (id: string) => Promise<void>;
  /** Throws (a `CalendarSyncError`, see services/sync/calendarSync.ts) on
   * failure, unlike every other action here — the caller is expected to
   * catch and surface it, since this is a user-initiated action they're
   * actively waiting on the result of, not a background sync. */
  sendToDoToCalendar: (id: string) => Promise<void>;
  removeToDoFromCalendar: (id: string) => Promise<void>;
};

/**
 * Screen-level state for the "Your To-Dos" module — mirrors this project's
 * existing pattern (see app/index.tsx's `refreshNotes`/`listNotes` pair) of
 * an in-memory list kept in sync with SQLite by re-querying after every
 * write, rather than a normalized client-side store. `todos` only ever holds
 * pending items (services/todos/todoManager.ts's `getPendingToDos()` already
 * filters `is_completed = 0`), so `pendingCount` is just its length — no
 * separate `getPendingCount()` round-trip needed for a consumer that's
 * already loaded the list.
 *
 * Refreshes on mount, on every screen focus, AND on a live change-event
 * subscription (subscribeToToDosChanged) — three overlapping triggers for
 * what's really one requirement: a to-do added from anywhere should show up
 * everywhere this hook is mounted. The focus-only version of this hook had a
 * real on-device bug: services/notes/noteManager.ts's background
 * auto-extraction pipeline calls addToDo() directly (there's no screen
 * navigation involved in saving a note), so the home screen's pill —
 * mounted the whole time, never re-focused — kept showing a stale count
 * until the user happened to visit /todos and come back, which is what
 * actually re-triggered its useFocusEffect. The subscription closes that
 * gap: every addToDo/updateToDo/completeToDo call notifies every mounted
 * useToDos instance immediately, screen navigation or not.
 *
 * MAIN-THREAD-BLOCKING AUDIT (touch-freeze investigation): every write here
 * (addToDo/updateToDo/completeToDo) and services/todos/todoManager.ts's own
 * getPendingToDos() go through op-sqlite's `db.execute()`, whose own type
 * signature returns `Promise<QueryResult>` (verified against
 * node_modules/@op-engineering/op-sqlite's types) — the work happens off the
 * JS thread on op-sqlite's native thread pool, not synchronously inside
 * whatever gesture handler triggered it. Nothing in this hook or
 * todoManager.ts calls op-sqlite's separate `executeSync` API. Every call
 * site here is also `void asyncFn()` fire-and-forget, so a slow write
 * delays this hook's own next `refreshToDos()`, never the tap handler that
 * initiated it. Confirmed clean — not the source of the on-device freeze.
 */
export function useToDos(): UseToDosResult {
  const [todos, setTodos] = useState<ToDo[]>([]);
  const [allTodos, setAllTodos] = useState<ToDo[]>([]);

  const refreshToDos = useCallback(async () => {
    const [pending, all] = await Promise.all([getPendingToDos(), listAllToDos()]);
    setTodos(pending);
    setAllTodos(all);
  }, []);

  useEffect(() => {
    void refreshToDos();
  }, [refreshToDos]);

  useEffect(() => {
    return subscribeToToDosChanged(() => {
      void refreshToDos();
    });
  }, [refreshToDos]);

  useFocusEffect(
    useCallback(() => {
      void refreshToDos();
    }, [refreshToDos])
  );

  const addToDo = useCallback(
    async (input: AddToDoInput) => {
      await addToDoRecord(input);
      await refreshToDos();
    },
    [refreshToDos]
  );

  const updateToDo = useCallback(
    async (id: string, fields: ToDoUpdateFields) => {
      await updateToDoRecord(id, fields);
      await refreshToDos();
    },
    [refreshToDos]
  );

  const completeToDo = useCallback(
    async (id: string) => {
      await completeToDoRecord(id);
      await refreshToDos();
    },
    [refreshToDos]
  );

  const deleteToDo = useCallback(
    async (id: string) => {
      await deleteToDoRecord(id);
      await refreshToDos();
    },
    [refreshToDos]
  );

  const sendToDoToCalendar = useCallback(
    async (id: string) => {
      await sendToDoToCalendarRecord(id);
      await refreshToDos();
    },
    [refreshToDos]
  );

  const removeToDoFromCalendar = useCallback(
    async (id: string) => {
      await removeToDoFromCalendarRecord(id);
      await refreshToDos();
    },
    [refreshToDos]
  );

  return {
    todos,
    allTodos,
    pendingCount: todos.length,
    refreshToDos,
    addToDo,
    updateToDo,
    completeToDo,
    deleteToDo,
    sendToDoToCalendar,
    removeToDoFromCalendar,
  };
}
