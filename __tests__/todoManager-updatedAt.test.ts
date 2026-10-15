/**
 * To-do changes made after the update carry an edit timestamp (`updated_at`),
 * which backup merges use so the newer change wins (services/backup/backupDb.ts).
 * Rows from before the column existed stay null — the documented limitation.
 */
const mockStatements: { sql: string; params: unknown[] }[] = [];
const mockRow = { text: "Synthetic task", action_date: "2026-10-16", to_date: null, notification_time: "09:00", recurrence: "none", recurrence_interval: 1, note_id: null, is_completed: 0, created_at: "x", id: "t1" };
type Execute = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
const mockExecute: Execute = async (sql, params = []) => {
  mockStatements.push({ sql, params });
  return { rows: /^\s*SELECT/i.test(sql) ? [mockRow] : [] };
};
const mockDb = {
  execute: mockExecute,
  transaction: async (fn: (tx: { execute: Execute }) => Promise<void>) => fn({ execute: mockExecute }),
};
jest.mock("../db/client", () => ({ getRawDatabase: async () => mockDb }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "new-id" }));
jest.mock("../services/notifications/todoNotifications", () => ({
  cancelToDoNotification: jest.fn(async () => undefined),
  scheduleToDoNotification: jest.fn(async () => undefined),
}));
jest.mock("../services/sync/calendarSync", () => ({
  createCalendarEvent: jest.fn(),
  deleteCalendarEvent: jest.fn(),
  updateCalendarEvent: jest.fn(),
}));

import { completeToDo, updateToDo } from "../services/todos/todoManager";

beforeEach(() => {
  mockStatements.length = 0;
});

it("an edit stamps updated_at", async () => {
  const before = Date.now();
  await updateToDo("t1", { text: "Synthetic task, renamed" });
  const update = mockStatements.find((s) => /^UPDATE todos SET/i.test(s.sql))!;
  expect(update.sql).toMatch(/updated_at = \?/);
  const stamp = update.params[update.params.length - 2] as number;
  expect(stamp).toBeGreaterThanOrEqual(before);
});

it("completing stamps updated_at", async () => {
  const before = Date.now();
  await completeToDo("t1");
  const update = mockStatements.find((s) => /UPDATE todos SET is_completed = 1/i.test(s.sql))!;
  expect(update.sql).toMatch(/updated_at = \?/);
  expect(update.params[0] as number).toBeGreaterThanOrEqual(before);
});
