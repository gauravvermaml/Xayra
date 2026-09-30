import { spacing } from "../../constants/theme";
import { HOURS } from "./timeline";

/**
 * Single source of truth for WeekGridLayout.tsx's own geometry — pulled out
 * of that file so its numbers (hour row height, scrollable content height,
 * column widths, initial scroll offset) live in one place rather than being
 * recomputed inline. Originally also shared with a ghost-preview stand-in
 * used by SwipeableCalendarPager.tsx during a since-removed architecture
 * (see that file's own doc comment) — the ghost is gone, but this module
 * stayed as the one place WeekGridLayout's geometry is defined.
 */

/** Per the layout spec's exact instruction — fixed, not computed from
 * screen height (unlike `timeGutterWidth`/`columnWidth` below, which the
 * same spec explicitly DOES want computed live). */
export const HOUR_ROW_HEIGHT = 52;

/** The real grid's total scrollable content height — every column is
 * exactly this tall, always, regardless of how many tasks it holds. */
export const WEEK_GRID_CONTENT_HEIGHT = HOURS.length * HOUR_ROW_HEIGHT;

/** Clearance beyond `insets.bottom` alone, on top of the Android nav bar's
 * own height — a little breathing room so midnight doesn't sit flush
 * against the very edge of what's reachable. Same value/reasoning as
 * DayLayout.tsx's own `BOTTOM_SCROLL_BUFFER`. */
export const BOTTOM_SCROLL_BUFFER = 24;

export type WeekGridColumnGeometry = {
  timeGutterWidth: number;
  availableWidth: number;
  columnWidth: number;
};

/** Same computation WeekGridLayout.tsx's own render body does — pulled out
 * so it isn't recomputed inline. */
export function computeWeekGridColumnGeometry(screenWidth: number, columnCount: number): WeekGridColumnGeometry {
  const timeGutterWidth = Math.max(44, screenWidth * 0.11);
  const availableWidth = screenWidth - timeGutterWidth - spacing.base * 2;
  const columnWidth = availableWidth / columnCount;
  return { timeGutterWidth, availableWidth, columnWidth };
}

/**
 * Where the grid should sit scrolled to on mount — one hour of lead-in above
 * the current hour, matching DayLayout.tsx's own identical reasoning (the
 * "now" line stays comfortably inside the viewport instead of flush against
 * its top edge). A PURE function of the wall clock, not of which date/range
 * is being shown — deliberately so: the real grid's own auto-scroll only
 * ever fires once per mounted instance and then stays wherever the user
 * left it, so a neighbor pane that was auto-scrolled once and then reused
 * across many date changes (see SwipeableCalendarPager.tsx) should already
 * agree with this value without needing to be told what date it's on.
 */
export function computeWeekGridInitialScrollY(): number {
  const now = new Date();
  return Math.max(0, (now.getHours() - 1) * HOUR_ROW_HEIGHT);
}
