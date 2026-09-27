import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";

import { filterToDosByRange, groupToDosByDate, type CalendarLayoutMode, type DateRange } from "../../services/calendar/dateRange";
import type { ToDo } from "../../services/todos/todoManager";
import { CalendarDateNavigator } from "./CalendarDateNavigator";
import { DayLayout } from "./views/DayLayout";
import { MonthLayout } from "./views/MonthLayout";
import { ScheduleLayout } from "./views/ScheduleLayout";
import { WeekLayout } from "./views/WeekLayout";
import { WorkWeekLayout } from "./views/WorkWeekLayout";

/** Minimum horizontal drag (px) OR release velocity (px/s) that counts as a
 * deliberate swipe rather than an accidental brush — matches the "obviously
 * on purpose" feel of a real gesture, not a hair-trigger on any sideways
 * finger movement. Either threshold alone is enough: a short fast flick and
 * a slow deliberate drag should both register. */
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

  // Swipe-to-navigate: a left swipe moves forward (onNext), a right swipe
  // moves back (onPrevious) — same direction convention as swiping between
  // photos or paginated screens. Not built for Schedule (see the render
  // below): it isn't a navigable range, so there's nothing for a swipe here
  // to page through.
  //
  // `activeOffsetX([-20, 20])` + `failOffsetY([-15, 15])` is the standard
  // RNGH technique for letting a horizontal gesture coexist with vertical
  // scrolling and nested taps in the same area: the pan only "claims" the
  // gesture once the finger has moved 20px sideways, and gives up entirely
  // (deferring to whatever's underneath — Day/Week/Work Week's own vertical
  // ScrollView, or a task card's TouchableOpacity) the moment the initial
  // movement turns out to be more vertical than horizontal, or short enough
  // to just be a tap. Without both of these, a swipe here would either eat
  // every vertical scroll gesture on the timeline, or a tap on a task card
  // would occasionally get swallowed as an accidental micro-swipe.
  const swipeGesture = Gesture.Pan()
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

  const gridBody = (
    <View style={styles.body}>
      {mode === "day" && (
        <DayLayout
          selectedDate={selectedDate}
          todos={rangeFilteredTodos}
          onOpenTask={onOpenTask}
          onCheckTask={onCheckTask}
          onLongPressDelete={onLongPressDelete}
        />
      )}
      {mode === "work_week" && activeRange && (
        <WorkWeekLayout
          range={activeRange}
          todos={rangeFilteredTodos}
          onOpenTask={onOpenTask}
          onCheckTask={onCheckTask}
          onLongPressDelete={onLongPressDelete}
        />
      )}
      {mode === "week" && activeRange && (
        <WeekLayout
          range={activeRange}
          todos={rangeFilteredTodos}
          onOpenTask={onOpenTask}
          onCheckTask={onCheckTask}
          onLongPressDelete={onLongPressDelete}
        />
      )}
      {mode === "month" && activeRange && (
        <MonthLayout
          range={activeRange}
          selectedDate={selectedDate}
          onSelectDate={onSelectDate}
          todos={rangeFilteredTodos}
          onOpenTask={onOpenTask}
          onCheckTask={onCheckTask}
          onOpenSourceNote={onOpenSourceNote}
          onLongPressDelete={onLongPressDelete}
        />
      )}
    </View>
  );

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
      ) : (
        <GestureDetector gesture={swipeGesture}>{gridBody}</GestureDetector>
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
