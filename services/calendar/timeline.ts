/**
 * Shared time-grid pure helpers for the WorkWeek/Week hourly timeline
 * (DayColumnTimeline.tsx, TimelineHourGutter.tsx, and the two layout
 * files). Deliberately holds no fixed pixel constants — per the layout
 * mandate, hour row height and column widths are computed live from
 * `useWindowDimensions()` by each layout file itself, not read from a
 * shared constant here. (DayLayout.tsx keeps its own separate, already-
 * verified-working local constants — it wasn't reported broken and isn't
 * touched by this refactor.)
 */

export const HOURS: readonly number[] = Array.from({ length: 24 }, (_, hour) => hour);

/** Synthetic default task duration, in HOURS (a ratio, not a pixel value) —
 * `ToDo` (services/todos/todoManager.ts) has only a single reminder time,
 * never a start+end span, so there is no real per-task duration to size a
 * block against. Multiplied by a live-computed `hourHeight` at the call
 * site to get an actual block height. */
export const DEFAULT_TASK_DURATION_HOURS = 0.75;

export function formatHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

export function minutesSinceMidnight(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

/** Buckets same-clock-time items together so a timeline column can lay
 * overlapping tasks out side by side within their shared slot instead of
 * stacking one on top of the other. */
export function bucketByTime<T extends { notificationTime: string }>(items: T[]): [string, T[]][] {
  const byTime = new Map<string, T[]>();
  for (const item of items) {
    const list = byTime.get(item.notificationTime);
    if (list) {
      list.push(item);
    } else {
      byTime.set(item.notificationTime, [item]);
    }
  }
  return Array.from(byTime.entries());
}
