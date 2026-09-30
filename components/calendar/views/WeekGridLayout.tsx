import { useEffect, useMemo, useState } from "react";
import { StyleSheet, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
// RNGH's own ScrollView — see DayLayout.tsx's identical import comment for
// why (CalendarBody.tsx's swipe-to-navigate gesture needs it to negotiate
// with this ScrollView correctly).
import { ScrollView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { spacing } from "../../../constants/theme";
import { enumerateRangeDates, groupToDosByDate, todayIso, type DateRange } from "../../../services/calendar/dateRange";
import {
  BOTTOM_SCROLL_BUFFER,
  computeWeekGridColumnGeometry,
  computeWeekGridInitialScrollY,
  HOUR_ROW_HEIGHT,
} from "../../../services/calendar/weekGridGeometry";
import type { ToDo } from "../../../services/todos/todoManager";
import { DayColumnHeader } from "./DayColumnHeader";
import { DayColumnTimeline } from "./DayColumnTimeline";
import { SharedHourGridLines } from "./SharedHourGridLines";
import { TimelineHourGutter } from "./TimelineHourGutter";

export type WeekGridLayoutProps = {
  range: DateRange;
  todos: ToDo[];
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onLongPressDelete: (item: ToDo) => void;
  /** See SwipeableCalendarPager.tsx's `PageScrollSync` doc comment — `null`
   * means "no shared position yet, use the wall-clock default below." */
  initialScrollY?: number | null;
  onScrollYChange?: (y: number) => void;
};

/**
 * Shared implementation behind both WorkWeekLayout.tsx (5 columns) and
 * WeekLayout.tsx (7 columns) — per the user's explicit, final spec: NO
 * horizontal scrolling anywhere, every column divides 100% of the
 * available width exactly, vertical-only scroll for the 24-hour timeline.
 * This is what makes the two views structurally identical (only the day
 * count differs), unlike an earlier iteration where Week needed real
 * horizontal scrolling and Work Week didn't — now that neither does, one
 * shared component is the right call instead of two near-duplicates.
 *
 * Column width is computed once, live, from `useWindowDimensions()`, and
 * passed as the SAME number to both `DayColumnHeader` (the non-scrolling
 * date header) and `DayColumnTimeline` (the hourly grid, inside the shared
 * vertical `ScrollView`) — that shared value, not a shared parent
 * container, is what actually keeps header and grid columns aligned under
 * each other.
 *
 * Every to-do plots on the hourly grid at its own `notificationTime`,
 * including `DEFAULT_NOTIFICATION_TIME` (5 AM) — an earlier version routed
 * that specific value to a separate all-day slot, per explicit user
 * correction that conflated a genuine 5 AM reminder with "no time was ever
 * set." There is no all-day concept in this calendar system today (see
 * DayColumnHeader.tsx's own doc comment).
 *
 * Both Work Week's 5 columns and Week's 7 render plain single-line text
 * chips (`CalendarTaskCard`'s "micro" variant, hardcoded in
 * DayColumnTimeline.tsx) — no checkbox, no time, no recurrence icon. An
 * earlier version gave Work Week the fuller "compact" card (checkbox + time
 * chip + recurrence emoji) on the theory that 5 columns had the room; a real
 * on-device screenshot showed it overflowing badly even there — a checkbox,
 * a truncated title, a wrapped time string and an emoji stacked into one
 * ~90px-tall slot has nowhere near enough room regardless of column count.
 * "Compact" is still used, unchanged, by DayLayout.tsx's own floating
 * chips, which have real room to spare.
 */
export function WeekGridLayout({
  range,
  todos,
  onOpenTask,
  onCheckTask,
  onLongPressDelete,
  initialScrollY,
  onScrollYChange,
}: WeekGridLayoutProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const dates = useMemo(() => enumerateRangeDates(range), [range]);
  const today = todayIso();

  const { timeGutterWidth, availableWidth, columnWidth } = useMemo(
    () => computeWeekGridColumnGeometry(screenWidth, dates.length),
    [screenWidth, dates.length]
  );

  // A declarative initial scroll position, not an imperative `scrollTo`
  // fired from `onLayout` — see weekGridGeometry.ts's own doc comment for
  // why this matters beyond just "less code": the old two-step mount-then-
  // jump pattern is what made a freshly-mounted real grid visibly snap from
  // scroll position 0 to the current hour a beat after appearing.
  //
  // `initialScrollY` prop (from `scrollSync`, see SwipeableCalendarPager's
  // `PageScrollSync` doc comment): when provided, this is wherever the user
  // was ACTUALLY looking on whatever page was current a moment ago — a
  // brand new week entering the window starts there instead of
  // independently defaulting to "an hour before now," which is what a live
  // on-device report caught (scroll to 6 PM, swipe, land back at the
  // morning). Falls back to the wall-clock default when `null` (no shared
  // position yet).
  const resolvedInitialScrollY = useMemo(
    () => (initialScrollY != null ? initialScrollY : computeWeekGridInitialScrollY()),
    [initialScrollY]
  );
  const contentOffset = useMemo(() => ({ x: 0, y: resolvedInitialScrollY }), [resolvedInitialScrollY]);
  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScrollYChange?.(event.nativeEvent.contentOffset.y);
  };

  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const groups = useMemo(() => groupToDosByDate(todos, true), [todos]);
  const groupByDate = useMemo(() => new Map(groups.map((group) => [group.date, group.items])), [groups]);

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={{ width: timeGutterWidth }} />
        {dates.map((date, index) => (
          <DayColumnHeader
            key={date}
            date={date}
            isToday={date === today}
            width={columnWidth}
            taskCount={(groupByDate.get(date) ?? []).length}
            showRightBorder={index < dates.length - 1}
          />
        ))}
      </View>

      <ScrollView
        contentOffset={contentOffset}
        onScroll={handleScroll}
        // 16ms (~60fps) — see DayLayout.tsx's identical comment for why a
        // coarser throttle here directly causes a stale-scroll-position lag
        // when swiping right after scrolling.
        scrollEventThrottle={16}
        style={styles.verticalScroll}
        showsVerticalScrollIndicator={false}
        // Real content ends at exactly `HOURS.length * HOUR_ROW_HEIGHT`
        // (midnight) — this trailing padding is blank, existing purely so
        // the last hour can scroll clear of the Android nav bar.
        // TodosOverlay.tsx's own SafeAreaView deliberately omits the
        // bottom edge (its undo-snackbar needs that space), so nothing
        // upstream already accounts for `insets.bottom` here; without
        // this, the ScrollView's own maximum scroll position left midnight
        // sitting exactly behind the nav bar, unreachable.
        contentContainerStyle={{ paddingBottom: insets.bottom + BOTTOM_SCROLL_BUFFER }}
      >
        <View style={styles.grid}>
          <TimelineHourGutter width={timeGutterWidth} hourHeight={HOUR_ROW_HEIGHT} />
          {/* SharedHourGridLines draws the 24 hour-boundary lines ONCE,
              spanning every column combined, instead of each
              DayColumnTimeline drawing an identical copy of its own — see
              that file's own doc comment for the measured render-cost
              reasoning. `columnsWrap` gives it a `position: "relative"`
              anchor scoped to just the columns (not the gutter beside
              them). */}
          <View style={styles.columnsWrap}>
            <SharedHourGridLines width={availableWidth} hourHeight={HOUR_ROW_HEIGHT} />
            {dates.map((date, index) => (
              <DayColumnTimeline
                key={date}
                items={groupByDate.get(date) ?? []}
                isToday={date === today}
                nowMinutes={nowMinutes}
                width={columnWidth}
                hourHeight={HOUR_ROW_HEIGHT}
                showRightBorder={index < dates.length - 1}
                onOpenTask={onOpenTask}
                onCheckTask={onCheckTask}
                onLongPressDelete={onLongPressDelete}
              />
            ))}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    width: "100%",
    paddingHorizontal: spacing.base,
  },
  headerRow: {
    flexDirection: "row",
    marginBottom: spacing.xs,
  },
  verticalScroll: {
    flex: 1,
  },
  grid: {
    flexDirection: "row",
  },
  columnsWrap: {
    flexDirection: "row",
    position: "relative",
  },
});
