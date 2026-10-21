/**
 * Gate 2: reminders re-armed on reopening. A force-stop removes an app's
 * alarms; after the vault opens, every pending future reminder is scheduled
 * again from the encrypted to-dos — idempotently (same notification id), never
 * for completed or past to-dos, and never prompting for permission.
 */
jest.mock("../services/dev/disposableVault", () => ({ getResolvedVaultMode: () => "normal" }));
const mockScheduled: { identifier: string; date: Date }[] = [];
const mockGranted = { value: true };
const mockRequested = jest.fn();
jest.mock("expo-notifications", () => ({
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  setNotificationChannelAsync: jest.fn(async () => {}),
  getPermissionsAsync: jest.fn(async () => ({ granted: mockGranted.value })),
  requestPermissionsAsync: (...a: unknown[]) => mockRequested(...a),
  cancelScheduledNotificationAsync: jest.fn(async () => {}),
  getAllScheduledNotificationsAsync: jest.fn(async () => []),
  // Same identifier replaces — the store and the alarm are both keyed by id.
  scheduleNotificationAsync: jest.fn(async (req: { identifier: string; trigger: { date: Date } }) => {
    const i = mockScheduled.findIndex((s) => s.identifier === req.identifier);
    const entry = { identifier: req.identifier, date: req.trigger.date };
    if (i >= 0) mockScheduled[i] = entry;
    else mockScheduled.push(entry);
  }),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: "date" },
}));
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));

import type { ToDo } from "../services/todos/todoManager";

const NOW = new Date(2026, 9, 21, 12, 0).getTime();
const todo = (id: string, actionDate: string, extra: Partial<ToDo> = {}): ToDo =>
  ({
    id,
    text: `synthetic ${id}`,
    actionDate,
    toDate: null,
    notificationTime: "13:00",
    isCompleted: false,
    recurrence: "none",
    recurrenceInterval: 1,
    createdAt: "2026-10-01T00:00:00Z",
    noteId: null,
    googleCalendarEventId: null,
    ...extra,
  }) as ToDo;

const TODOS = [
  todo("future", "2026-10-22"),
  todo("weekly", "2026-10-29", { recurrence: "weekly", noteId: "n1" }),
  todo("done", "2026-10-23", { isCompleted: true }),
  todo("past", "2026-10-20"),
];

/** Reconciliation runs once per app process: each test gets a fresh one. */
function freshModule() {
  let mod!: typeof import("../services/notifications/todoNotifications");
  jest.isolateModules(() => {
    mod = require("../services/notifications/todoNotifications");
  });
  return mod;
}

beforeEach(() => {
  mockScheduled.length = 0;
  mockGranted.value = true;
  mockRequested.mockReset();
});

describe("remindersToReconcile", () => {
  it("only pending to-dos whose trigger is still in the future", () => {
    expect(freshModule().remindersToReconcile(TODOS, NOW).map((t) => t.id)).toEqual(["future", "weekly"]);
  });
});

describe("reconcileToDoNotifications", () => {
  it("re-arms pending future reminders with their existing ids and times", async () => {
    const n = await freshModule().reconcileToDoNotifications(TODOS, NOW);
    expect(n).toBe(2);
    expect(mockScheduled.map((s) => s.identifier).sort()).toEqual(["todo-future", "todo-weekly"]);
    expect(mockScheduled.find((s) => s.identifier === "todo-future")?.date).toEqual(new Date(2026, 9, 22, 13, 0));
  });

  it("never brings back a completed or past reminder", async () => {
    await freshModule().reconcileToDoNotifications(TODOS, NOW);
    expect(mockScheduled.some((s) => /done|past/.test(s.identifier))).toBe(false);
  });

  it("is idempotent — running again in a new process duplicates nothing", async () => {
    await freshModule().reconcileToDoNotifications(TODOS, NOW);
    await freshModule().reconcileToDoNotifications(TODOS, NOW);
    expect(mockScheduled).toHaveLength(2);
  });

  it("runs once per process (repeated vault-open effects do nothing)", async () => {
    const mod = freshModule();
    expect(await mod.reconcileToDoNotifications(TODOS, NOW)).toBe(2);
    expect(await mod.reconcileToDoNotifications(TODOS, NOW)).toBe(0);
  });

  it("without the notification permission: schedules nothing and never prompts", async () => {
    mockGranted.value = false;
    expect(await freshModule().reconcileToDoNotifications(TODOS, NOW)).toBe(0);
    expect(mockScheduled).toHaveLength(0);
    expect(mockRequested).not.toHaveBeenCalled();
  });
});
