import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";

import type { Recurrence } from "../db/schema";
import {
  addToDo as addToDoRecord,
  completeToDo as completeToDoRecord,
  getPendingToDos,
  updateToDo as updateToDoRecord,
  type ToDo,
  type ToDoUpdateFields,
} from "../services/todos/todoManager";

export type UseToDosResult = {
  todos: ToDo[];
  pendingCount: number;
  refreshToDos: () => Promise<void>;
  addToDo: (text: string, actionDate: string, recurrence?: Recurrence) => Promise<void>;
  updateToDo: (id: string, fields: ToDoUpdateFields) => Promise<void>;
  completeToDo: (id: string) => Promise<void>;
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
 * Refreshes automatically on every screen focus (not just on mount), since
 * services/notes/noteManager.ts's background auto-extraction pipeline can
 * populate new rows from a note saved on a completely different screen (or
 * while this one wasn't focused) — a mount-only fetch would go stale the
 * moment a voice note's extraction finishes after the To-Dos screen already
 * loaded once.
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

  useFocusEffect(
    useCallback(() => {
      void refreshToDos();
    }, [refreshToDos])
  );

  const addToDo = useCallback(
    async (text: string, actionDate: string, recurrence: Recurrence = "none") => {
      await addToDoRecord(text, actionDate, recurrence);
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

  return {
    todos,
    pendingCount: todos.length,
    refreshToDos,
    addToDo,
    updateToDo,
    completeToDo,
  };
}
