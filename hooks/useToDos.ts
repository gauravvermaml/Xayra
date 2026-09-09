import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";

import type { Recurrence } from "../db/schema";
import {
  addToDo as addToDoRecord,
  completeToDo as completeToDoRecord,
  deleteToDo as deleteToDoRecord,
  getPendingToDos,
  subscribeToToDosChanged,
  updateToDo as updateToDoRecord,
  type ToDo,
  type ToDoUpdateFields,
} from "../services/todos/todoManager";

export type UseToDosResult = {
  todos: ToDo[];
  pendingCount: number;
  refreshToDos: () => Promise<void>;
  addToDo: (text: string, actionDate: string, recurrence?: Recurrence, recurrenceInterval?: number) => Promise<void>;
  updateToDo: (id: string, fields: ToDoUpdateFields) => Promise<void>;
  completeToDo: (id: string) => Promise<void>;
  deleteToDo: (id: string) => Promise<void>;
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
 */
export function useToDos(): UseToDosResult {
  const [todos, setTodos] = useState<ToDo[]>([]);

  const refreshToDos = useCallback(async () => {
    const pending = await getPendingToDos();
    setTodos(pending);
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
    async (text: string, actionDate: string, recurrence: Recurrence = "none", recurrenceInterval = 1) => {
      await addToDoRecord(text, actionDate, recurrence, recurrenceInterval);
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

  return {
    todos,
    pendingCount: todos.length,
    refreshToDos,
    addToDo,
    updateToDo,
    completeToDo,
    deleteToDo,
  };
}
