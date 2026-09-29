import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

import { filterToDosByRange, getDateRangeForMode, groupToDosByDate, type CalendarLayoutMode, type DateRange } from "../../services/calendar/dateRange";
import type { ToDo } from "../../services/todos/todoManager";
import { CalendarDateNavigator } from "./CalendarDateNavigator";
import { SwipeableCalendarPager } from "./SwipeableCalendarPager";
import { DayLayout } from "./views/DayLayout";
import { MonthLayout } from "./views/MonthLayout";
import { ScheduleLayout } from "./views/ScheduleLayout";
import { WeekLayout } from "./views/WeekLayout";
import { WorkWeekLayout } from "./views/WorkWeekLayout";

/** Minimum horizontal drag (px) OR release velocity (px/s) that counts as a
 * deliberate swipe rather than an accidental brush — matches the "obviously
 * on purpose" feel of a real gesture, not a hair-trigger on any sideways
 * finger movement. Either threshold alone is enough: a short fast flick and
 * a slow deliberate drag should both register. Used by Week/Work Week/
 * Month's plain jump-on-release swipe below — Day's own copy of this same
 * pair of constants lives in SwipeableCalendarPager.tsx. */
const SWIPE_TRANSLATION_THRESHOLD = 50;
const SWIPE_VELOCITY_THRESHOLD = 400;

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
 * SWIPE: DAY VS. EVERYTHING ELSE (deliberate, measured split). Day view uses
 * SwipeableCalendarPager's continuous 1:1-finger-tracking drag. Work Week/
 * Week/Month use the plain "jump on release" swipe below instead — NOT a
 * regression, a measured decision. All four originally used the continuous
 * pager, but live on-device logcat timing (adb, one commit traced end to
 * end) showed WeekGridLayout/MonthLayout's real NATIVE commit — not any JS
 * logic, not the swipe mechanism itself — takes ~500ms per page on this
 * hardware (MonthLayout alone mounts ~35-42 `TouchableOpacity` cells). That
 * cost exists identically via the plain date-navigator arrow buttons too;
 * it only reads as "broken" after a continuous drag because the drag
 * promises instant continuity that a pre-existing ~500ms native-render
 * pause then breaks. Fixing that render cost is real, separate work — see
 * BACKLOG.md's "Month/Week grid native render cost" entry — not something
 * to bolt onto the swipe engine. Day has no such per-cell-heavy structure
 * (a single hourly gutter) and measured fine, so it keeps the fuller effect.
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
}: CalendarBodyProps) {
  const rangeFilteredTodos = filterToDosByRange(calendarTodos, activeRange);

  // Day view has no per-column header the way Week/Work Week do (see
  // CalendarDateNavigator's own doc comment on `taskCount`) — this is the
  // one place left to give it the same "know there's something without
  // scrolling" dot. Only computed for "day" — Week/Work Week/Month already
  // carry their own dots elsewhere and don't need this value at all.
  // `true`: a ranged to-do spanning through `selectedDate` should count here
  // even if it started on an earlier day — same expansion every grid layout
  // now applies (see groupToDosByDate's own doc comment).
  const selectedDayTaskCount =
    mode === "day" ? (groupToDosByDate(rangeFilteredTodos, true).find((g) => g.date === selectedDate)?.items.length ?? 0) : 0;

  // Renders one full grid page for an arbitrary date — used directly for
  // Week/Work Week/Month's single current page below, and passed to
  // SwipeableCalendarPager for Day, which calls it again for the previous/
  // next dates too (see that file's own doc comment). Independent of the
  // outer `selectedDate`/`activeRange` props so it can recompute its own
  // range/filtered-todos per date rather than assuming it's always the one
  // the user is currently on.
  const renderGridForDate = (dateForPage: string) => {
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
          />
        )}
        {mode === "work_week" && pageRange && (
          <WorkWeekLayout
            range={pageRange}
            todos={pageTodos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onLongPressDelete={onLongPressDelete}
          />
        )}
        {mode === "week" && pageRange && (
          <WeekLayout
            range={pageRange}
            todos={pageTodos}
            onOpenTask={onOpenTask}
            onCheckTask={onCheckTask}
            onLongPressDelete={onLongPressDelete}
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
          />
        )}
      </View>
    );
  };

  // Plain "jump on release" swipe for Week/Work Week/Month — see this
  // component's own doc comment for why these three don't get the
  // continuous pager. Same activation thresholds and activeOffsetX/
  // failOffsetY gesture-composition technique the original single swipe
  // gesture used, just without any drag-following visual.
  const jumpSwipeGesture = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-15, 15])
    .onEnd((event) => {
      if (event.translationX <= -SWIPE_TRANSLATION_THRESHOLD || event.velocityX <= -SWIPE_VELOCITY_THRESHOLD) {
        runOnJS(onNext)();
      } else if (event.translationX >= SWIPE_TRANSLATION_THRESHOLD || event.velocityX >= SWIPE_VELOCITY_THRESHOLD) {
        runOnJS(onPrevious)();
      }
    });

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
          selectedDate={selectedDate}
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
          />
        </View>
      ) : mode === "day" ? (
        <SwipeableCalendarPager mode={mode} selectedDate={selectedDate} onNext={onNext} onPrevious={onPrevious} renderPage={renderGridForDate} />
      ) : (
        <GestureDetector gesture={jumpSwipeGesture}>{renderGridForDate(selectedDate)}</GestureDetector>
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
