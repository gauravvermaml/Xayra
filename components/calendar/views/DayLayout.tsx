import { useEffect, useMemo, useState } from "react";
import { StyleSheet, Text, View, type NativeScrollEvent, type NativeSyntheticEvent } from "react-native";
// RNGH's own ScrollView, not plain react-native's — CalendarBody.tsx wraps
// this whole layout in a `Gesture.Pan()` swipe-to-navigate detector, and a
// vanilla RN ScrollView doesn't participate in RNGH's native gesture
// negotiation at all, so `failOffsetY` had nothing to actually hand control
// back to. Importing RNGH's own ScrollView is the documented fix — it's
// built specifically to compose with gesture-handler gestures the way
// react-native's is not.
import { ScrollView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, spacing } from "../../../constants/theme";
import { groupToDosByDate, todayIso } from "../../../services/calendar/dateRange";
import type { ToDo } from "../../../services/todos/todoManager";
import { CalendarTaskCard } from "../CalendarTaskCard";

const HOUR_HEIGHT = 56;
const TASK_BLOCK_HEIGHT = 40;
/** Clearance beyond `insets.bottom` alone, on top of the Android nav bar's
 * own height — a little breathing room so midnight doesn't sit flush
 * against the very edge of what's reachable, same reasoning as
 * NotesSheetContent's own extra scroll-content padding elsewhere in this
 * app. */
const BOTTOM_SCROLL_BUFFER = 24;
const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

function formatHourLabel(hour: number): string {
  if (hour === 0) return "12 AM";
  if (hour === 12) return "12 PM";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

function minutesSinceMidnight(hhmm: string): number {
  const [hour, minute] = hhmm.split(":").map(Number);
  return hour * 60 + minute;
}

export type DayLayoutProps = {
  selectedDate: string;
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
 * Single-day view: a minimalist 00:00-23:00 time gutter on the left, and
 * floating rounded task chips on the right positioned by `notificationTime`.
 * Every to-do plots at its own `notificationTime`, including
 * `DEFAULT_NOTIFICATION_TIME` (5 AM) — an earlier version of this file
 * treated that specific value as "no time was ever set" and routed it to a
 * separate all-day row instead. Per explicit user correction: that default
 * exists to give a new to-do SOME reminder time when the user never picks
 * one (see db/schema.ts's own doc comment); it is not a signal that the
 * task is all-day, and conflating the two hid a real 5 AM reminder instead
 * of showing it. There is no all-day concept in this calendar system today.
 *
 * Task chips have a fixed synthetic height (`TASK_BLOCK_HEIGHT`) rather than
 * a real start/end span — `ToDo` has no duration field, only a single
 * reminder time, so there's no real "end time" to size a block against.
 * Two or more tasks sharing the same clock time are laid out side by side
 * within the same slot (the spec's "multi-task overlaps stack side-by-
 * side"), splitting the available width evenly.
 */
export function DayLayout({
  selectedDate,
  todos,
  onOpenTask,
  onCheckTask,
  onLongPressDelete,
  initialScrollY,
  onScrollYChange,
}: DayLayoutProps) {
  const insets = useSafeAreaInsets();
  const [nowMinutes, setNowMinutes] = useState(() => {
    const now = new Date();
    return now.getHours() * 60 + now.getMinutes();
  });

  // Re-measure "now" every minute so the red line actually creeps forward
  // while this screen is left open, rather than freezing at whatever time
  // it was when the layout first mounted.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = new Date();
      setNowMinutes(now.getHours() * 60 + now.getMinutes());
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // A declarative initial scroll position, not an imperative `scrollTo`
  // fired from `onLayout` — matches WeekGridLayout.tsx's own identical fix
  // and reasoning (see weekGridGeometry.ts's doc comment): the old two-step
  // mount-then-jump pattern visibly snapped once this component started
  // being freshly mounted per date under SwipeableCalendarPager's keyed
  // window, instead of being one long-lived instance reused across date
  // changes forever the way it used to be.
  //
  // `initialScrollY` (from `scrollSync`, see SwipeableCalendarPager's
  // `PageScrollSync` doc comment): when provided, this is wherever the user
  // was ACTUALLY looking on whatever page was current a moment ago — a
  // brand new day entering the window starts there instead of independently
  // defaulting to "an hour before now," which is what a live on-device
  // report caught (scroll to 6 PM, swipe, land back at the morning).
  // Falling back to the wall-clock default when it's `null` (no shared
  // position yet) matches this component's old one-shot auto-scroll intent:
  // without it, Day view would always open scrolled to 12 AM.
  const initialScrollOffset = useMemo(() => {
    if (initialScrollY != null) {
      return initialScrollY;
    }
    const now = new Date();
    return Math.max(0, (now.getHours() - 1) * HOUR_HEIGHT);
  }, [initialScrollY]);
  const contentOffset = useMemo(() => ({ x: 0, y: initialScrollOffset }), [initialScrollOffset]);

  const handleScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    onScrollYChange?.(event.nativeEvent.contentOffset.y);
  };

  const dayTodos = useMemo(() => {
    const grouped = groupToDosByDate(todos, true);
    return grouped.find((group) => group.date === selectedDate)?.items ?? [];
  }, [todos, selectedDate]);

  // Every to-do plots at its own `notificationTime`, including
  // `DEFAULT_NOTIFICATION_TIME` (5 AM) — that default exists to give a new
  // to-do SOME reminder time when the user never picks one explicitly
  // (see db/schema.ts's own doc comment); it is not a signal that the task
  // is "all-day," and the calendar grid must not treat it as one. Per
  // explicit user correction: if the stored time is 5 AM, it shows at 5 AM,
  // full stop — no separate all-day bucket for this value.
  //
  // Bucket same-clock-time tasks together so they can share a row width —
  // the "multi-task overlaps stack side-by-side" requirement.
  const slots = useMemo(() => {
    const byTime = new Map<string, ToDo[]>();
    for (const item of dayTodos) {
      const list = byTime.get(item.notificationTime);
      if (list) {
        list.push(item);
      } else {
        byTime.set(item.notificationTime, [item]);
      }
    }
    return Array.from(byTime.entries());
  }, [dayTodos]);

  const isToday = selectedDate === todayIso();

  return (
    <View style={styles.container}>
      <ScrollView
        contentOffset={contentOffset}
        onScroll={handleScroll}
        // 16ms (~60fps), not RN's usual 100-200ms default throttle — this
        // value feeds `onScrollYChange`, which SwipeableCalendarPager reads
        // at the exact moment a neighbor page mounts to decide its own
        // starting scroll position (see PageScrollSync's doc comment). A
        // coarser throttle means swiping right after scrolling can hand the
        // new page a position that's up to that many ms stale — live
        // on-device report of "still a minor lag" after the initial scroll-
        // sync fix, traced to exactly this.
        scrollEventThrottle={16}
        style={styles.timeline}
        // Real content ends at exactly `HOUR_HEIGHT * 24` (midnight, the
        // end of the 11 PM row) — the extra space beyond that is blank,
        // existing purely so the last hour can scroll clear of the Android
        // nav bar. TodosOverlay.tsx's own SafeAreaView deliberately omits
        // the bottom edge (its undo-snackbar needs to sit in that space),
        // so nothing upstream already accounts for `insets.bottom` here;
        // without this, the ScrollView's own maximum scroll position left
        // midnight sitting exactly behind the nav bar, unreachable, the
        // same class of bug this codebase's Archive screen already hit
        // once for the same underlying reason (see its own navBarInset).
        contentContainerStyle={{ height: HOUR_HEIGHT * 24 + insets.bottom + BOTTOM_SCROLL_BUFFER }}
      >
        {HOURS.map((hour) => (
          <View key={hour} style={[styles.hourRow, { top: hour * HOUR_HEIGHT, height: HOUR_HEIGHT }]}>
            <Text style={styles.hourLabel}>{formatHourLabel(hour)}</Text>
            <View style={styles.hourLine} />
          </View>
        ))}

        {isToday && (
          <View style={[styles.nowLine, { top: (nowMinutes / 60) * HOUR_HEIGHT }]}>
            <View style={styles.nowDot} />
            <View style={styles.nowLineBar} />
          </View>
        )}

        {slots.map(([time, items]) => {
          const top = (minutesSinceMidnight(time) / 60) * HOUR_HEIGHT;
          const width = 100 / items.length;
          return (
            <View key={time} style={[styles.slotRow, { top, height: TASK_BLOCK_HEIGHT }]}>
              {items.map((item) => (
                <View key={item.id} style={{ width: `${width}%`, paddingHorizontal: 2 }}>
                  <CalendarTaskCard
                    item={item}
                    variant="micro"
                    onPress={onOpenTask}
                    onCheck={onCheckTask}
                    onLongPressDelete={onLongPressDelete}
                    style={styles.taskCardFill}
                  />
                </View>
              ))}
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

const GUTTER_WIDTH = 56;

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  timeline: {
    flex: 1,
  },
  hourRow: {
    position: "absolute",
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "flex-start",
  },
  hourLabel: {
    width: GUTTER_WIDTH,
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "right",
    paddingRight: spacing.sm,
  },
  hourLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginTop: 6,
  },
  nowLine: {
    position: "absolute",
    left: GUTTER_WIDTH,
    right: spacing.base,
    flexDirection: "row",
    alignItems: "center",
    zIndex: 5,
  },
  nowDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.danger,
    marginLeft: -4,
  },
  nowLineBar: {
    flex: 1,
    height: 2,
    backgroundColor: colors.danger,
  },
  slotRow: {
    position: "absolute",
    left: GUTTER_WIDTH + spacing.sm,
    right: spacing.base,
    flexDirection: "row",
  },
  // "micro" cards size to their own small intrinsic content by default (see
  // CalendarTaskCard.tsx's own `microCard` style) — without this, they'd sit
  // as a thin sliver inside `slotRow`'s full `TASK_BLOCK_HEIGHT` instead of
  // filling it.
  taskCardFill: {
    width: "100%",
    height: "100%",
  },
});
