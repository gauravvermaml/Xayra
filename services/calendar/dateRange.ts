import type { ToDo } from "../todos/todoManager";

export type CalendarLayoutMode = "day" | "work_week" | "week" | "month" | "schedule";

/** Inclusive ISO YYYY-MM-DD bounds. */
export type DateRange = { start: string; end: string };

/**
 * Every date computation below parses/reconstructs via local-time year/
 * month/day components, never `new Date(isoString)` (which JS parses as UTC
 * midnight) — the same UTC-off-by-one-day trap `services/todos/todoManager.ts`'s
 * own date math already documents and avoids. A device west of UTC would
 * otherwise see dates roll back a day.
 */
function parseIsoDate(iso: string): Date {
  const [year, month, day] = iso.split("-").map(Number);
  return new Date(year, month - 1, day);
}

export function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function todayIso(): string {
  return formatIsoDate(new Date());
}

export function shiftIsoDate(iso: string, days: number): string {
  const date = parseIsoDate(iso);
  date.setDate(date.getDate() + days);
  return formatIsoDate(date);
}

/** Shifts by whole calendar months, clamped to day 1 first — `setMonth` on a
 * day-31 date rolling into a shorter month (e.g. Jan 31 -> Feb) silently
 * overflows into March instead of landing on Feb 28th, which would corrupt
 * "which month is the user looking at" navigation. The month view only ever
 * cares about which month `selectedDate` falls in, never the exact day
 * within it, so anchoring to day 1 before shifting is always safe here. */
export function shiftIsoMonth(iso: string, months: number): string {
  const date = parseIsoDate(iso);
  const anchored = new Date(date.getFullYear(), date.getMonth(), 1);
  anchored.setMonth(anchored.getMonth() + months);
  return formatIsoDate(anchored);
}

/** JS `Date.getDay()` convention: Sunday = 0 ... Saturday = 6. */
function getWeekday(iso: string): number {
  return parseIsoDate(iso).getDay();
}

/** Start (Sunday) of the Sun-Sat week containing `iso`. */
export function startOfWeek(iso: string): string {
  return shiftIsoDate(iso, -getWeekday(iso));
}

/** Start (Monday) of the Mon-Fri work week containing `iso`. A weekend date
 * has no work week of its own — anchors forward to the FOLLOWING Monday
 * rather than back to the week just finished, matching how a user tapping
 * "Work Week" on a Saturday almost certainly means "show me what's coming,"
 * not "show me the week that just ended." */
export function startOfWorkWeek(iso: string): string {
  const weekday = getWeekday(iso);
  if (weekday === 0) return shiftIsoDate(iso, 1); // Sunday -> next Monday
  if (weekday === 6) return shiftIsoDate(iso, 2); // Saturday -> next Monday
  return shiftIsoDate(iso, 1 - weekday);
}

export function startOfMonth(iso: string): string {
  const date = parseIsoDate(iso);
  return formatIsoDate(new Date(date.getFullYear(), date.getMonth(), 1));
}

export function endOfMonth(iso: string): string {
  const date = parseIsoDate(iso);
  // Day 0 of the FOLLOWING month is the last day of this one.
  return formatIsoDate(new Date(date.getFullYear(), date.getMonth() + 1, 0));
}

/**
 * The inclusive date range a given layout mode + anchor date represents.
 * `null` for "schedule" — that view is a continuous feed of every pending
 * to-do (see ScheduleLayout.tsx's own doc comment), not scoped to a
 * navigable range the way the four grid layouts are.
 */
export function getDateRangeForMode(mode: CalendarLayoutMode, selectedDate: string): DateRange | null {
  switch (mode) {
    case "day":
      return { start: selectedDate, end: selectedDate };
    case "work_week": {
      const start = startOfWorkWeek(selectedDate);
      return { start, end: shiftIsoDate(start, 4) };
    }
    case "week": {
      const start = startOfWeek(selectedDate);
      return { start, end: shiftIsoDate(start, 6) };
    }
    case "month":
      return { start: startOfMonth(selectedDate), end: endOfMonth(selectedDate) };
    case "schedule":
      return null;
  }
}

/**
 * True if a to-do's own [actionDate, toDate ?? actionDate] span overlaps
 * `range` at all — a multi-day to-do that started before `range.start` and
 * ends inside it (or vice versa) still counts. Standard closed-interval
 * overlap test on plain ISO strings, which compare correctly as strings
 * since they're all fixed-width YYYY-MM-DD.
 */
export function isToDoInRange(todo: Pick<ToDo, "actionDate" | "toDate">, range: DateRange): boolean {
  const todoEnd = todo.toDate ?? todo.actionDate;
  return todo.actionDate <= range.end && todoEnd >= range.start;
}

/** Filters to just the to-dos whose date span overlaps `range`. A `null`
 * range (Schedule view) returns every to-do unfiltered. */
export function filterToDosByRange<T extends Pick<ToDo, "actionDate" | "toDate">>(
  todos: T[],
  range: DateRange | null
): T[] {
  if (!range) {
    return todos;
  }
  return todos.filter((todo) => isToDoInRange(todo, range));
}

/**
 * Groups to-dos by date, sorted ascending, each date's own list sorted by
 * `notificationTime`. Used by every day-column layout (Day/WorkWeek/Week
 * pick their day's bucket out of this) plus MonthLayout's per-cell dots/day
 * tray and ScheduleLayout's sticky section headers.
 *
 * `expandRange` (default false, matching this function's original
 * single-date-only behavior) controls what a multi-day to-do (`toDate` set)
 * is grouped under:
 *  - false (ScheduleLayout's own usage): its START date (`actionDate`)
 *    only — a flat scrolling feed showing the same task repeated under
 *    every date section it spans would read as duplicate entries, not one
 *    task with a range; the range is shown in the card's own subtitle
 *    instead.
 *  - true (every grid layout — Day/WorkWeek/Week/Month): EVERY date from
 *    `actionDate` to `toDate` inclusive. This is what makes a ranged to-do
 *    ("File Tax Returns", 10th–17th) actually visible as a span across
 *    grid cells, per explicit product spec — a grid cell is looked at one
 *    day at a time, unlike Schedule's continuous feed, so repetition there
 *    is the correct, intended behavior, not visual clutter.
 */
export function groupToDosByDate<T extends Pick<ToDo, "actionDate" | "toDate" | "notificationTime">>(
  todos: T[],
  expandRange = false
): { date: string; items: T[] }[] {
  const byDate = new Map<string, T[]>();
  for (const todo of todos) {
    const dates =
      expandRange && todo.toDate && todo.toDate > todo.actionDate
        ? enumerateRangeDates({ start: todo.actionDate, end: todo.toDate })
        : [todo.actionDate];
    for (const date of dates) {
      const list = byDate.get(date);
      if (list) {
        list.push(todo);
      } else {
        byDate.set(date, [todo]);
      }
    }
  }
  return Array.from(byDate.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, items]) => ({
      date,
      items: [...items].sort((a, b) => a.notificationTime.localeCompare(b.notificationTime)),
    }));
}

/**
 * How far "previous"/"next" navigation moves for a given layout mode —
 * pulled out as its own pure function (rather than living inline in
 * useCalendarViewStore.ts) specifically so it's directly unit-testable
 * without needing a React renderer, which this codebase's test suite
 * deliberately avoids (see __tests__ conventions — every existing test
 * exercises plain logic/services, not hooks or components).
 *
 * A day at a time for Day view; a whole week at a time for Work Week/Week
 * (jumping to the next work week matches how mainstream calendar apps'
 * week views behave, not a day-by-day crawl); a whole month at a time for
 * Month view. Schedule view has no navigation concept and returns `current`
 * unchanged — its own layout component never renders the controls that
 * would call this in the first place.
 */
export function stepSelectedDate(mode: CalendarLayoutMode, current: string, direction: 1 | -1): string {
  switch (mode) {
    case "day":
      return shiftIsoDate(current, direction);
    case "work_week":
    case "week":
      return shiftIsoDate(current, direction * 7);
    case "month":
      return shiftIsoMonth(current, direction);
    case "schedule":
      return current;
  }
}

/** Every ISO date from `range.start` to `range.end` inclusive, ascending —
 * used to lay out a fixed set of day columns/cells even for days with no
 * to-dos at all (unlike `groupToDosByDate`, which only ever produces an
 * entry for a date that has at least one to-do). */
export function enumerateRangeDates(range: DateRange): string[] {
  const dates: string[] = [];
  let cursor = range.start;
  while (cursor <= range.end) {
    dates.push(cursor);
    cursor = shiftIsoDate(cursor, 1);
  }
  return dates;
}
