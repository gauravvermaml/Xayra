import { Platform } from "react-native";
import * as Notifications from "expo-notifications";

import { getResolvedVaultMode } from "../dev/disposableVault";
import type { ToDo } from "../todos/todoManager";
// Side-effect import — see notificationHandler.ts's own doc comment for why
// the one app-wide `setNotificationHandler` call lives there, not here.
import "./notificationHandler";

/**
 * Phase 2 Step 4: local (on-device, no push server, no network call — same
 * Zero-cloud-API-dependency rule as every other core-loop feature in this
 * app per CLAUDE.md) Android notifications for a to-do's own reminder time,
 * as distinct from downloadNotification.ts's unrelated setup-progress
 * mirror. One responsibility: turn a `ToDo` row into a scheduled OS
 * notification (or cancel one), never anything about when a to-do's fields
 * themselves change — that's services/todos/todoManager.ts's job, which
 * calls into this file's exports after every add/update/complete/delete.
 *
 * A missing/denied notification permission is treated as a soft failure
 * throughout, same as downloadNotification.ts: a to-do itself must always
 * save successfully regardless of whether its reminder could be scheduled.
 */

const CHANNEL_ID = "todo-reminders";

let channelReady = false;
let permissionRequested = false;

/**
 * `DEFAULT` (not `MIN`/`LOW` like downloadNotification.ts's silent channel)
 * — a to-do reminder exists specifically to interrupt the user at the right
 * moment, the opposite intent from a background download's quiet progress
 * mirror. Sound left as the channel's own default rather than silenced.
 */
async function ensureChannel(): Promise<void> {
  if (channelReady || Platform.OS !== "android") {
    return;
  }
  channelReady = true;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: "To-Do reminders",
    importance: Notifications.AndroidImportance.DEFAULT,
  }).catch(() => {
    channelReady = false;
  });
}

async function ensurePermission(): Promise<boolean> {
  if (permissionRequested) {
    const existing = await Notifications.getPermissionsAsync().catch(() => null);
    return existing?.granted ?? false;
  }
  permissionRequested = true;
  const existing = await Notifications.getPermissionsAsync().catch(() => null);
  if (existing?.granted) {
    return true;
  }
  const requested = await Notifications.requestPermissionsAsync().catch(() => null);
  return requested?.granted ?? false;
}

/** One stable identifier per to-do id, reused across every schedule call for
 * the same to-do — `scheduleNotificationAsync` with a repeated `identifier`
 * replaces whatever trigger that identifier previously held, so editing a
 * to-do's date/time/text and calling `scheduleToDoNotification` again just
 * naturally supersedes the old trigger with no separate cancel-then-
 * reschedule dance needed at the call site. */
export function notificationIdFor(todoId: string): string {
  return `${reminderNamespace()}${todoId}`;
}

/**
 * Normal-vault reminders use `todo-`; a Xayra Dev disposable test vault
 * (services/dev/disposableVault.ts) uses its own prefix, so nothing done in
 * or to a disposable vault can touch a normal reminder. The prefixes don't
 * overlap: a normal id never starts with the disposable prefix and vice versa.
 */
export const NORMAL_REMINDER_PREFIX = "todo-";
export const DISPOSABLE_REMINDER_PREFIX = "disposable-reminder-";

function reminderNamespace(): string {
  return getResolvedVaultMode() === "disposable" ? DISPOSABLE_REMINDER_PREFIX : NORMAL_REMINDER_PREFIX;
}

/** Parses `actionDate` (YYYY-MM-DD) + `notificationTime` (HH:MM) into a
 * single local `Date` — local `Date` components, not `new Date(iso)` (which
 * JS parses as UTC midnight), for the exact same reason every other date
 * computation in this codebase (todoManager.ts's `computeNextActionDate`,
 * transformationEngine.ts's `parseIsoDateLocal`) avoids that trap: a device
 * west of UTC would otherwise see every reminder fire a day early. */
function toLocalTriggerDate(dateIso: string, timeHHMM: string): Date {
  const [year, month, day] = dateIso.split("-").map(Number);
  const [hour, minute] = timeHHMM.split(":").map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

/**
 * Schedules (or reschedules — see `notificationIdFor`) a to-do's local
 * reminder, or cancels any existing one if the trigger time has already
 * passed. Called automatically by services/todos/todoManager.ts's
 * `addToDo`/`updateToDo`, and again for a freshly-respawned recurring
 * occurrence inside `completeToDo` — never called directly by any UI code.
 *
 * Android-only: this app has no iOS build target (see CLAUDE.md's
 * environment notes), and expo-notifications' scheduling semantics differ
 * enough between platforms that silently no-op'ing on anything else is
 * safer than assuming iOS behaves identically.
 */
export async function scheduleToDoNotification(todo: ToDo): Promise<void> {
  if (Platform.OS !== "android") {
    return;
  }

  const triggerDate = toLocalTriggerDate(todo.actionDate, todo.notificationTime);
  if (triggerDate.getTime() <= Date.now()) {
    // The trigger time is already in the past (e.g. a to-do added today
    // after its 5 AM default has already passed, or edited to an earlier
    // time than "now"). Cancel any stale trigger a previous edit might have
    // left scheduled rather than silently leaving it in place, and don't
    // schedule a new one — firing a reminder for a moment that's already
    // gone would be confusing, not useful. A recurring to-do's NEXT
    // occurrence gets its own fresh, future-dated call from
    // todoManager.ts's `completeToDo` respawn instead.
    await cancelToDoNotification(todo.id);
    return;
  }

  await ensureChannel();
  const granted = await ensurePermission();
  if (!granted) {
    return;
  }

  await Notifications.scheduleNotificationAsync({
    identifier: notificationIdFor(todo.id),
    content: {
      title: "Xayra To-Do",
      body: todo.text,
      sound: true,
      // `todoId`/`kind` are read back in two places: notificationHandler.ts
      // branches foreground display behavior on `kind`, and this file's own
      // tap-response listener below reads `todoId` to tell app/index.tsx
      // which to-do (really: "open the To-Dos overlay at all" — there's no
      // per-item deep view yet) a notification tap was for.
      data: { todoId: todo.id, kind: "todo-reminder" },
    },
    // `channelId` belongs on the TRIGGER, not `content` — see
    // downloadNotification.ts's own doc comment for the real on-device bug
    // (every notification silently landing on Android's noisy fallback
    // channel) that already taught this codebase that lesson once.
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: triggerDate,
      channelId: CHANNEL_ID,
    },
  }).catch((err) => {
    console.warn("[todoNotifications] Failed to schedule reminder for", todo.id, err);
  });
}

/** Cancels a to-do's scheduled reminder, if any — called on completion and
 * on deletion (see todoManager.ts). A no-op, not a throw, if nothing was
 * ever scheduled for this id (permission was denied, the trigger time had
 * already passed at save time, etc.). */
export async function cancelToDoNotification(todoId: string): Promise<void> {
  await Notifications.cancelScheduledNotificationAsync(notificationIdFor(todoId)).catch(() => {});
}

let staleDisposableCleanupStarted = false;

/**
 * Cancels reminders left by a previous disposable test-vault session (their
 * to-dos died with that session's in-memory key). Run once when a vault opens,
 * in either mode, before any to-do exists in it. Only ids carrying the
 * disposable prefix are ever cancelled — normal reminders are never touched.
 * Returns how many were cancelled.
 */
export async function cancelStaleDisposableReminders(): Promise<number> {
  // Once per app process: the caller's effect can run again if Android
  // recreates the activity while the process lives on, and by then this
  // session's own disposable reminders exist and must be kept.
  if (staleDisposableCleanupStarted || Platform.OS !== "android") {
    return 0;
  }
  staleDisposableCleanupStarted = true;
  const scheduled = await Notifications.getAllScheduledNotificationsAsync().catch(() => []);
  const stale = scheduled
    .map((request) => request.identifier)
    .filter((identifier) => identifier.startsWith(DISPOSABLE_REMINDER_PREFIX));
  for (const identifier of stale) {
    await Notifications.cancelScheduledNotificationAsync(identifier).catch(() => {});
  }
  return stale.length;
}

/**
 * Which to-dos should have a reminder armed right now: not completed, and a
 * trigger time still in the future. Completed ones never get one back (their
 * reminder was cancelled on completion); past ones are left alone, exactly
 * as scheduleToDoNotification itself does. Pure — tested directly.
 */
export function remindersToReconcile(todos: ToDo[], nowMs: number): ToDo[] {
  return todos.filter(
    (todo) => !todo.isCompleted && toLocalTriggerDate(todo.actionDate, todo.notificationTime).getTime() > nowMs
  );
}

let reconcileStarted = false;

/**
 * Re-arms every pending, future reminder from the encrypted to-dos — run once
 * per app process, after the vault opens (Gate 2). Android's force-stop
 * (Settings, or some OEMs on swipe-away) removes an app's alarms; until now
 * they came back only on a reboot or an app update, never on simply reopening
 * Xayra, so reminders could silently not fire. Scheduling is idempotent: the
 * same notification id replaces the stored request and its alarm (same
 * PendingIntent), so nothing is ever duplicated. It never prompts for the
 * notification permission — without it, nothing is scheduled, as before.
 * A force-stopped app still can't fire anything until it is opened again;
 * that is Android's rule.
 */
export async function reconcileToDoNotifications(todos: ToDo[], nowMs: number = Date.now()): Promise<number> {
  if (reconcileStarted || Platform.OS !== "android") {
    return 0;
  }
  reconcileStarted = true;
  const permission = await Notifications.getPermissionsAsync().catch(() => null);
  if (!permission?.granted) {
    return 0;
  }
  const due = remindersToReconcile(todos, nowMs);
  for (const todo of due) {
    await scheduleToDoNotification(todo);
  }
  return due.length;
}

/** Call once at app startup (see app/index.tsx's prewarm effect) to request
 * the Android notification permission up front and prime the channel/tap
 * listener, rather than only doing it lazily the first time a to-do happens
 * to be saved. */
export async function initializeToDoNotifications(): Promise<void> {
  ensureTapListener();
  await ensureChannel();
  await ensurePermission();
}

/**
 * Plain in-process pub/sub, same addEventListener-style shape as
 * todoManager.ts's `subscribeToToDosChanged` — app/index.tsx subscribes once
 * to open the To-Dos overlay (components/TodosOverlay.tsx) the moment a
 * to-do reminder notification is tapped, per the spec's "tapping opens
 * Xayra directly to the To-Dos overlay." There's no per-item deep view in
 * that overlay yet, so the tapped to-do's id is passed through to the
 * listener (for future use — e.g. scrolling to/highlighting that row) but
 * app/index.tsx's current listener only needs to know "open the overlay."
 */
type TodoNotificationTapListener = (todoId: string) => void;
const tapListeners = new Set<TodoNotificationTapListener>();
let tapListenerRegistered = false;

function ensureTapListener(): void {
  if (tapListenerRegistered) {
    return;
  }
  tapListenerRegistered = true;
  Notifications.addNotificationResponseReceivedListener((response) => {
    const data = response.notification.request.content.data as { todoId?: string; kind?: string } | undefined;
    if (data?.kind === "todo-reminder" && data.todoId) {
      const todoId = data.todoId;
      tapListeners.forEach((listener) => listener(todoId));
    }
  });
}

/** Subscribes to a to-do reminder notification actually being tapped (not
 * merely shown) — returns an unsubscribe function. Safe to call before
 * `initializeToDoNotifications()` has run; it registers the underlying
 * native listener itself on first subscription. */
export function subscribeToToDoNotificationTap(listener: TodoNotificationTapListener): () => void {
  ensureTapListener();
  tapListeners.add(listener);
  return () => tapListeners.delete(listener);
}
