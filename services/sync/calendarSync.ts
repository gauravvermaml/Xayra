import { GoogleSignin, isSuccessResponse } from "@react-native-google-signin/google-signin";

import type { Recurrence } from "../../db/schema";
import type { ToDo } from "../todos/todoManager";
import {
  CALENDAR_EVENTS_SCOPE,
  DriveSyncError,
  ensureConfigured,
  requireAccessToken,
  withDeveloperErrorHandling,
} from "./driveSync";

/**
 * Push-to-Google-Calendar — one-way sync (Xayra pushes; an edit made
 * directly in Google Calendar is never pulled back), explicit per-to-do
 * opt-in via the calendar-icon button in CalendarTaskCard.tsx, matching
 * BACKLOG.md's own recorded decisions. Reuses driveSync.ts's shared
 * Google Sign-In session/config rather than standing up a second one — see
 * that file's own `CALENDAR_EVENTS_SCOPE`/`ensureConfigured` doc comments
 * for why the SDK configuration itself stays centralized there even though
 * the actual Calendar API calls live in this file.
 */
export class CalendarSyncError extends DriveSyncError {
  constructor(message: string) {
    super(message);
    this.name = "CalendarSyncError";
  }
}

const CALENDAR_EVENTS_ENDPOINT = "https://www.googleapis.com/calendar/v3/calendars/primary/events";

/** How long a Calendar event runs when a to-do carries no explicit range of
 * its own (`toDate` unset) — see db/schema.ts's `toDate` doc comment; a
 * to-do only ever has a single reminder TIME, never a duration, so this is
 * a reasonable fixed default for a normal timed block on the calendar
 * rather than a zero-length event (which some calendar UIs render oddly). */
const EVENT_DURATION_MINUTES = 30;

/**
 * Ensures the shared GoogleSignin session has `CALENDAR_EVENTS_SCOPE`
 * granted, signing the user in first if they've never connected a Google
 * account at all (e.g. they use Calendar push without ever having set up
 * Drive backup) — reuses the SAME account-picker flow driveSync.ts's own
 * `signInWithGoogle` uses. `addScopes` is called unconditionally, belt-
 * and-suspenders exactly like driveSync.ts's own `signInWithGoogle` does
 * for its own scope: re-asserting a scope that's already granted is a fast,
 * silent no-op, while skipping it on a stale "must already be granted"
 * assumption would surface as an opaque 403 from the Calendar API instead
 * of a clear, actionable consent prompt. This is the ONLY place in this
 * file `CALENDAR_EVENTS_SCOPE`'s interactive consent is actually
 * requested — a user who never taps "Send to Calendar" is never prompted
 * for it, even though `driveSync.ts`'s `ensureConfigured` declares the
 * scope to the SDK upfront (declaring is not the same as requesting).
 */
async function ensureCalendarAccess(): Promise<string> {
  ensureConfigured();
  return withDeveloperErrorHandling(async () => {
    await GoogleSignin.hasPlayServices();
    if (!GoogleSignin.getCurrentUser()) {
      const response = await GoogleSignin.signIn();
      if (!isSuccessResponse(response)) {
        throw new CalendarSyncError("Google sign-in was cancelled.");
      }
    }
    await GoogleSignin.addScopes({ scopes: [CALENDAR_EVENTS_SCOPE] });
    return requireAccessToken();
  });
}

async function calendarFetch(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new CalendarSyncError(`Google Calendar request failed (${res.status}): ${body || res.statusText}`);
  }
  return res;
}

/** `"YYYY-MM-DDTHH:MM:00"` — a LOCAL wall-clock dateTime string, paired
 * separately with an explicit `timeZone` field on the Calendar event
 * resource (never a UTC-offset-encoded string) — the same "parse local
 * components directly, never round-trip through `new Date(isoString)`"
 * discipline services/todos/todoManager.ts's own date arithmetic already
 * follows, for the identical reason: a to-do's date/time is something a
 * user reasons about in their own local time, not an instant to convert. */
function localDateTimeString(dateIso: string, timeHHMM: string, addMinutes = 0): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  const [hour, minute] = timeHHMM.split(":").map(Number);
  const date = new Date(year, month - 1, day, hour, minute);
  if (addMinutes !== 0) {
    date.setMinutes(date.getMinutes() + addMinutes);
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

/** `db/schema.ts`'s `Recurrence` + `recurrenceInterval` already matches the
 * standard iCalendar RRULE FREQ+INTERVAL shape (see that file's own doc
 * comment) — this is a direct, lossless mapping, not an approximation.
 * `"none"` maps to no RRULE at all (a single, non-repeating event). There's
 * no COUNT/UNTIL to translate: this app's own recurrence model has no end
 * condition (a completed recurring to-do always respawns indefinitely —
 * see todoManager.ts's `completeToDo`), so the resulting RRULE is likewise
 * unbounded. */
function toRecurrenceRule(recurrence: Recurrence, interval: number): string[] {
  if (recurrence === "none") {
    return [];
  }
  const freq = recurrence.toUpperCase();
  return [`RRULE:FREQ=${freq};INTERVAL=${Math.max(1, Math.round(interval))}`];
}

type CalendarEventPayload = {
  summary: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  recurrence?: string[];
};

/** A to-do with `toDate` set (a date-span reminder — see db/schema.ts's own
 * doc comment) becomes a genuine multi-day Calendar event spanning
 * `actionDate`'s reminder time to `toDate`'s same time, rather than a
 * single 30-minute block that would silently drop the range's own length.
 * Without `toDate`, the event is a normal `EVENT_DURATION_MINUTES`-long
 * block starting at the to-do's reminder time. */
function buildEventPayload(todo: ToDo): CalendarEventPayload {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const startDateTime = localDateTimeString(todo.actionDate, todo.notificationTime);
  const endDateTime = todo.toDate
    ? localDateTimeString(todo.toDate, todo.notificationTime)
    : localDateTimeString(todo.actionDate, todo.notificationTime, EVENT_DURATION_MINUTES);
  const recurrence = toRecurrenceRule(todo.recurrence, todo.recurrenceInterval);

  return {
    summary: todo.text,
    start: { dateTime: startDateTime, timeZone },
    end: { dateTime: endDateTime, timeZone },
    ...(recurrence.length > 0 ? { recurrence } : {}),
  };
}

/** Creates a new Calendar event for `todo` and returns its id — the caller
 * (services/todos/todoManager.ts's `sendToDoToCalendar`) is responsible for
 * persisting that id back onto the to-do's own row. */
export async function createCalendarEvent(todo: ToDo): Promise<string> {
  const accessToken = await ensureCalendarAccess();
  const res = await calendarFetch(CALENDAR_EVENTS_ENDPOINT, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildEventPayload(todo)),
  });
  const json = (await res.json()) as { id: string };
  return json.id;
}

/** Pushes `todo`'s CURRENT fields onto its already-linked Calendar event —
 * called by todoManager.ts's `updateToDo` whenever an edit lands on a to-do
 * that's already been sent to Calendar, keeping the one-way sync current
 * without the user needing to re-press "Send." A no-op if `todo` isn't
 * actually linked (defensive — callers are expected to check first). */
export async function updateCalendarEvent(todo: ToDo): Promise<void> {
  if (!todo.googleCalendarEventId) {
    return;
  }
  const accessToken = await ensureCalendarAccess();
  await calendarFetch(`${CALENDAR_EVENTS_ENDPOINT}/${todo.googleCalendarEventId}`, accessToken, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildEventPayload(todo)),
  });
}

/** Deletes a Calendar event by id — used both by the explicit "remove from
 * Calendar" toggle and by `deleteToDo`'s own cascade. A 404/410 (the event
 * was already removed — deleted directly in Calendar, say) is treated as
 * success, not a failure: the end state ("this event doesn't exist") is
 * exactly what a delete wants either way. */
export async function deleteCalendarEvent(eventId: string): Promise<void> {
  const accessToken = await ensureCalendarAccess();
  const res = await fetch(`${CALENDAR_EVENTS_ENDPOINT}/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok && res.status !== 404 && res.status !== 410) {
    const body = await res.text().catch(() => "");
    throw new CalendarSyncError(`Google Calendar delete failed (${res.status}): ${body || res.statusText}`);
  }
}
