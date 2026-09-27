import { useCallback, useMemo, useState } from "react";

import {
  getDateRangeForMode,
  stepSelectedDate,
  todayIso,
  type CalendarLayoutMode,
  type DateRange,
} from "../services/calendar/dateRange";

export type { CalendarLayoutMode } from "../services/calendar/dateRange";

export type UseCalendarViewStoreResult = {
  layoutMode: CalendarLayoutMode;
  setLayoutMode: (mode: CalendarLayoutMode) => void;
  selectedDate: string; // ISO YYYY-MM-DD, local
  setSelectedDate: (iso: string) => void;
  /** The current mode's own navigable range — `null` for "schedule", which
   * isn't range-scoped (see dateRange.ts's own doc comment). */
  activeRange: DateRange | null;
  goToToday: () => void;
  goToPrevious: () => void;
  goToNext: () => void;
};

/**
 * To-Do screen calendar state: which layout is active (Day/Work Week/Week/
 * Month/Schedule) and which date is the current navigation anchor. Plain
 * component-local hook state, not a global store (e.g. Zustand) — this
 * project has no state-management dependency and nothing else needs this
 * state outside the To-Dos screen's own component tree, so introducing one
 * would be a new dependency decision for no real benefit (see CLAUDE.md's
 * own package-provenance rule for why that's not taken lightly here).
 *
 * "Previous"/"Next" step size depends on the active mode — see
 * `stepSelectedDate` (services/calendar/dateRange.ts) for the actual rule
 * and why it's a standalone, directly-unit-tested function rather than
 * inline here.
 */
export function useCalendarViewStore(): UseCalendarViewStoreResult {
  const [layoutMode, setLayoutMode] = useState<CalendarLayoutMode>("schedule");
  const [selectedDate, setSelectedDate] = useState<string>(todayIso());

  const activeRange = useMemo(() => getDateRangeForMode(layoutMode, selectedDate), [layoutMode, selectedDate]);

  const goToToday = useCallback(() => setSelectedDate(todayIso()), []);
  const goToPrevious = useCallback(() => {
    setSelectedDate((current) => stepSelectedDate(layoutMode, current, -1));
  }, [layoutMode]);
  const goToNext = useCallback(() => {
    setSelectedDate((current) => stepSelectedDate(layoutMode, current, 1));
  }, [layoutMode]);

  return { layoutMode, setLayoutMode, selectedDate, setSelectedDate, activeRange, goToToday, goToPrevious, goToNext };
}
