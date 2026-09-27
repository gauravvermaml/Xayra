import { useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, useWindowDimensions, View } from "react-native";
// RNGH's own ScrollView — see DayLayout.tsx's identical import comment for
// why (CalendarBody.tsx's swipe-to-navigate gesture needs it to negotiate
// with this ScrollView correctly).
import { ScrollView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { spacing } from "../../../constants/theme";
import { enumerateRangeDates, groupToDosByDate, todayIso, type DateRange } from "../../../services/calendar/dateRange";
import type { ToDo } from "../../../services/todos/todoManager";
import { DayColumnHeader } from "./DayColumnHeader";
import { DayColumnTimeline } from "./DayColumnTimeline";
import { TimelineHourGutter } from "./TimelineHourGutter";

/** Per the layout spec's exact instruction — fixed, not computed from
 * screen height (unlike `timeGutterWidth`/`columnWidth` below, which the
 * same spec explicitly DOES want computed live). */
const HOUR_ROW_HEIGHT = 52;

/** Clearance beyond `insets.bottom` alone, on top of the Android nav bar's
 * own height — a little breathing room so midnight doesn't sit flush
 * against the very edge of what's reachable. Same value/reasoning as
 * DayLayout.tsx's own `BOTTOM_SCROLL_BUFFER`. */
const BOTTOM_SCROLL_BUFFER = 24;

export type WeekGridLayoutProps = {
  range: DateRange;
  todos: ToDo[];
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onLongPressDelete: (item: ToDo) => void;
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
export function WeekGridLayout({ range, todos, onOpenTask, onCheckTask, onLongPressDelete }: WeekGridLayoutProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const dates = useMemo(() => enumerateRangeDates(range), [range]);
  const today = todayIso();

  const timeGutterWidth = Math.max(44, screenWidth * 0.11);
  const availableWidth = screenWidth - timeGutterWidth - spacing.base * 2;
  const columnWidth = availableWidth / dates.length;

  const scrollViewRef = useRef<ScrollView>(null);
  const hasAutoScrolledRef = useRef(false);
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

  const handleLayout = () => {
    if (hasAutoScrolledRef.current) {
      return;
    }
    hasAutoScrolledRef.current = true;
    const now = new Date();
    const initialScrollY = Math.max(0, (now.getHours() - 1) * HOUR_ROW_HEIGHT);
    scrollViewRef.current?.scrollTo({ y: initialScrollY, animated: false });
  };

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
        ref={scrollViewRef}
        onLayout={handleLayout}
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
});
