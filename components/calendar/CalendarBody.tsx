import { useCallback, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";

import {
  filterToDosByRange,
  getDateRangeForMode,
  groupToDosByDate,
  type CalendarLayoutMode,
  type DateRange,
} from "../../services/calendar/dateRange";
import type { ToDo } from "../../services/todos/todoManager";
import { CalendarDateNavigator } from "./CalendarDateNavigator";
import { SwipeableCalendarPager, type PageScrollSync } from "./SwipeableCalendarPager";
import { DayLayout } from "./views/DayLayout";
import { MonthLayout } from "./views/MonthLayout";
import { ScheduleLayout } from "./views/ScheduleLayout";
import { WeekLayout } from "./views/WeekLayout";
import { WorkWeekLayout } from "./views/WorkWeekLayout";

export type CalendarBodyProps = {
  mode: CalendarLayoutMode;
  selectedDate: string;
  onSelectDate: (date: string) => void;
  activeRange: DateRange | null;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Already keyword-search-filtered by the caller (TodosOverlay.tsx).
   * Pending-only — feeds Schedule view and the search override below. */
  todos: ToDo[];
  /** Same filtering as `todos`, but pending AND completed — feeds the four
   * GRID layouts (Day/Work Week/Week/Month) only. Per explicit product
   * decision, a to-do's calendar entry behaves like a Google Calendar
   * event: it keeps showing there, indefinitely, once checked off, with no
   * visual difference from a pending one. Schedule view deliberately keeps
   * using `todos` above instead — completing a recurring to-do should still
   * make the just-finished occurrence disappear from Schedule and the
   * freshly-spawned next occurrence take its place, unchanged from before. */
  calendarTodos: ToDo[];
  /** True whenever the search box has a non-empty (trimmed) query — see
   * this component's own doc comment for what it overrides. */
  isSearching: boolean;
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onOpenSourceNote: (noteId: string) => void;
  onLongPressDelete: (item: ToDo) => void;
  onSendToCalendar: (item: ToDo) => void;
};

/**
 * The sticky date navigator (hidden for Schedule, which isn't range-scoped
 * — see dateRange.ts) plus whichever of the five layout components is
 * currently active. Deliberately does NOT own `CalendarViewSelector` or the
 * search bar — the spec places the selector directly above the search
 * input and this navigator+grid block below it, so `TodosOverlay.tsx`
 * calls `useCalendarViewStore()` itself and renders the search bar between
 * `CalendarViewSelector` and this component, rather than this component
 * trying to own a layout slot that isn't contiguous with the rest of it.
 *
 * SEARCH OVERRIDES THE LAYOUT (live user correction): an earlier version
 * kept applying each grid layout's own date-range filter on TOP of the
 * keyword-search filter — a real search match dated outside whatever
 * range Day/Work Week/Week/Month happened to be showing was silently
 * dropped before it ever reached the grid, which read as "search doesn't
 * find this to-do" even though it matched. Per explicit correction: a
 * non-empty search query now always renders as the flat, date-grouped
 * Schedule-view list, REGARDLESS of which layout mode is selected — search
 * means "find this, wherever it is," not "find this only if it also falls
 * in whatever window I'm currently looking at." Clearing the search
 * returns to the selected layout's normal, range-scoped behavior. The date
 * navigator hides during a search for the same reason it hides in
 * Schedule mode itself — there's no date range being browsed to navigate.
 *
 * SWIPE: all four grid modes use SwipeableCalendarPager's continuous
 * 1:1-finger-tracking drag, ALWAYS with real pages — see that file's own
 * top doc comment for the full history (a ghost-preview era existed in
 * between and was removed: it traded one bottleneck for an unbounded
 * "does this element match the real one" audit surface, and was replaced
 * by pre-mounting real neighbor pages off-screen during idle time instead
 * of approximating them).
 */
export function CalendarBody({
  mode,
  selectedDate,
  onSelectDate,
  activeRange,
  onPrevious,
  onNext,
  onToday,
  todos,
  calendarTodos,
  isSearching,
  onOpenTask,
  onCheckTask,
  onOpenSourceNote,
  onLongPressDelete,
  onSendToCalendar,
}: CalendarBodyProps) {
  const rangeFilteredTodos = filterToDosByRange(calendarTodos, activeRange);

  // Drives CalendarDateNavigator's own label/dots during an active swipe —
  // see SwipeableCalendarPager's own `onPreviewChange` doc comment for why
  // this exists at all (the header used to only update once a swipe fully
  // committed, visibly lagging behind the grid content it sits above, which
  // already tracks the finger continuously), and for why it's a real date
  // string here rather than a relative offset re-derived via
  // `stepSelectedDate` — an earlier version did the re-derive here, which
  // combined with the pager's own now-fixed sign bug to show the wrong
  // month partway through a drag, and separately could flash the OLD
  // month's neighbor for one frame right at landing (a race between
  // `selectedDate` updating and this offset resetting). Reset to neutral
  // whenever `selectedDate` actually changes — covers non-drag navigation
  // (arrow taps, "Today") too, which never touches this at all and should
  // just keep reading `selectedDate` directly.
  const [previewDate, setPreviewDate] = useState<string | null>(null);
  useEffect(() => setPreviewDate(null), [selectedDate]);
  const headerDate = previewDate ?? selectedDate;

  // Day view has no per-column header the way Week/Work Week do (see
  // CalendarDateNavigator's own doc comment on `taskCount`) — this is the
  // one place left to give it the same "know there's something without
  // scrolling" dot. Only computed for "day" — Week/Work Week/Month already
  // carry their own dots elsewhere and don't need this value at all.
  // `true`: a ranged to-do spanning through `selectedDate` should count here
  // even if it started on an earlier day — same expansion every grid layout
  // now applies (see groupToDosByDate's own doc comment). Reads `headerDate`
  // (not the raw `selectedDate`), so the dot count previews correctly too.
  const selectedDayTaskCount =
    mode === "day" ? (groupToDosByDate(rangeFilteredTodos, true).find((g) => g.date === headerDate)?.items.length ?? 0) : 0;

  // Renders one full, ALWAYS-REAL grid page for an arbitrary date,
  // independent of the outer `selectedDate`/`activeRange` props —
  // SwipeableCalendarPager calls this for every page in its mounted window
  // (current plus pre-mounted neighbors, see that file's own doc comment),
  // so it must recompute its own range/filtered-todos per date rather than
  // reusing the top-level `activeRange`/`rangeFilteredTodos` above (which
  // are only ever valid for the single date the user is actually on right
  // now).
  //
  // WRAPPED IN useCallback, deliberately excluding `previewOffset`/
  // `headerDate` (neither is referenced in the body below) — this is the
  // fix for a measured, on-device root cause: `onPreviewChange` firing
  // during a drag calls `setPreviewOffset` right here in CalendarBody, and
  // an unmemoized `renderGridForDate` being recreated on every one of those
  // state updates fed SwipeableCalendarPager a fresh function + fresh
  // `pageTodos` array identity on every render, defeating MonthLayout's/
  // WeekGridLayout's own internal `useMemo`s and forcing a full unnecessary
  // native re-commit of the ALREADY-SETTLED, on-screen page mid-gesture.
  // Live adb-logcat timing traced one real swipe: three full render
  // cascades (preview-flip, actual commit, offset-reset-to-0 on settle)
  // instead of one. Paired with wrapping SwipeableCalendarPager itself in
  // `React.memo` (see that file), a `previewOffset` update now only
  // re-renders CalendarDateNavigator, never touches the pager/grid subtree
  // at all.
  // `scrollSync`: only Day/Work Week/Week have a per-time-of-day vertical
  // scroll to keep in sync across pages — see SwipeableCalendarPager's own
  // `PageScrollSync` doc comment for the full reasoning (swiping used to
  // reset to "an hour before now" instead of wherever the user was actually
  // looking). Month has no equivalent concept, so its branch ignores it.
  const renderGridForDate = useCallback((dateForPage: string, scrollSync: PageScrollSync) => {
    const pageRange = getDateRangeForMode(mode, dateForPage);
    const pageTodos = filterToDosByRange(calendarTodos, pageRange);
    return (
      <View style={styles.body}>
        {mode === "day" && (
          <DayLayout
            selectedDate={dateForPage}
            todos={pageTodos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onLongPressDelete={onLongPressDelete}
            initialScrollY={scrollSync.initialScrollY}
            onScrollYChange={scrollSync.onScrollYChange}
          />
        )}
        {mode === "work_week" && pageRange && (
          <WorkWeekLayout
            range={pageRange}
            todos={pageTodos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onLongPressDelete={onLongPressDelete}
            initialScrollY={scrollSync.initialScrollY}
            onScrollYChange={scrollSync.onScrollYChange}
          />
        )}
        {mode === "week" && pageRange && (
          <WeekLayout
            range={pageRange}
            todos={pageTodos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onLongPressDelete={onLongPressDelete}
            initialScrollY={scrollSync.initialScrollY}
            onScrollYChange={scrollSync.onScrollYChange}
          />
        )}
        {mode === "month" && pageRange && (
          <MonthLayout
            range={pageRange}
            selectedDate={dateForPage}
            onSelectDate={onSelectDate}
            todos={pageTodos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onOpenSourceNote={onOpenSourceNote}
            onLongPressDelete={onLongPressDelete}
            onSendToCalendar={onSendToCalendar}
          />
        )}
      </View>
    );
  }, [mode, calendarTodos, onOpenTask, onCheckTask, onLongPressDelete, onOpenSourceNote, onSendToCalendar, onSelectDate]);

  if (isSearching) {
    return (
      <View style={styles.container}>
        <View style={styles.body}>
          <ScheduleLayout
            todos={todos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onOpenSourceNote={onOpenSourceNote}
            onLongPressDelete={onLongPressDelete}
            onSendToCalendar={onSendToCalendar}
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {mode !== "schedule" && (
        <CalendarDateNavigator
          mode={mode}
          selectedDate={headerDate}
          onPrevious={onPrevious}
          onNext={onNext}
          onToday={onToday}
          taskCount={selectedDayTaskCount}
        />
      )}

      {mode === "schedule" ? (
        <View style={styles.body}>
          <ScheduleLayout
            todos={todos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onOpenSourceNote={onOpenSourceNote}
            onLongPressDelete={onLongPressDelete}
            onSendToCalendar={onSendToCalendar}
          />
        </View>
      ) : (
        <SwipeableCalendarPager
          mode={mode}
          selectedDate={selectedDate}
          onNext={onNext}
          onPrevious={onPrevious}
          renderPage={renderGridForDate}
          onPreviewChange={setPreviewDate}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  body: {
    flex: 1,
  },
});
