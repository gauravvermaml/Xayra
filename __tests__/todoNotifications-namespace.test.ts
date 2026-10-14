/**
 * Reminder namespaces (services/notifications/todoNotifications.ts): a Xayra
 * Dev disposable test vault's reminders can never collide with, or clean up,
 * the normal vault's reminders.
 */
let mockMode: "normal" | "disposable" = "normal";
jest.mock("../services/dev/disposableVault", () => ({ getResolvedVaultMode: () => mockMode }));

const mockScheduled: { identifier: string }[] = [];
const mockCancelled: string[] = [];
jest.mock("expo-notifications", () => ({
  getAllScheduledNotificationsAsync: jest.fn(async () => mockScheduled),
  cancelScheduledNotificationAsync: jest.fn(async (id: string) => {
    mockCancelled.push(id);
  }),
  setNotificationHandler: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  AndroidImportance: { HIGH: 4, DEFAULT: 3 },
  SchedulableTriggerInputTypes: { DATE: "date" },
}));
jest.mock("react-native", () => ({ Platform: { OS: "android" } }));

const { notificationIdFor, cancelToDoNotification, NORMAL_REMINDER_PREFIX, DISPOSABLE_REMINDER_PREFIX } =
  require("../services/notifications/todoNotifications");

/** The cleanup runs once per app process, so each test gets a fresh "process". */
function freshCleanup(): () => Promise<number> {
  let fn!: () => Promise<number>;
  jest.isolateModules(() => {
    fn = require("../services/notifications/todoNotifications").cancelStaleDisposableReminders;
  });
  return fn;
}

beforeEach(() => {
  mockMode = "normal";
  mockScheduled.length = 0;
  mockCancelled.length = 0;
});

describe("reminder namespaces", () => {
  it("the two prefixes can't overlap", () => {
    expect(NORMAL_REMINDER_PREFIX.startsWith(DISPOSABLE_REMINDER_PREFIX)).toBe(false);
    expect(DISPOSABLE_REMINDER_PREFIX.startsWith(NORMAL_REMINDER_PREFIX)).toBe(false);
  });

  it("the same to-do id gets a different alarm id in each mode", () => {
    expect(notificationIdFor("abc")).toBe("todo-abc");
    mockMode = "disposable";
    expect(notificationIdFor("abc")).toBe("disposable-reminder-abc");
  });

  it("cancelling a disposable to-do's reminder can't cancel the normal one with the same id", async () => {
    mockMode = "disposable";
    await cancelToDoNotification("abc");
    expect(mockCancelled).toEqual(["disposable-reminder-abc"]);
  });

  it.each(["normal", "disposable"] as const)(
    "stale-disposable cleanup (in %s mode) cancels only disposable reminders, never normal ones",
    async (mode) => {
      mockMode = mode;
      mockScheduled.push(
        { identifier: "todo-1" },
        { identifier: "todo-disposable-lookalike" },
        { identifier: "disposable-reminder-1" },
        { identifier: "disposable-reminder-2" },
        { identifier: "download-progress" }
      );
      expect(await freshCleanup()()).toBe(2);
      expect(mockCancelled).toEqual(["disposable-reminder-1", "disposable-reminder-2"]);
    }
  );

  it("runs once per process: a remount can't cancel the current session's disposable reminders", async () => {
    mockMode = "disposable";
    const cleanup = freshCleanup();
    expect(await cleanup()).toBe(0); // session start: nothing stale
    mockScheduled.push({ identifier: "disposable-reminder-current" }, { identifier: "todo-1" });
    expect(await cleanup()).toBe(0); // activity recreated in the same process
    expect(mockCancelled).toEqual([]);
  });
});
