import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { colors, radius } from "../../../constants/theme";
import { bucketByTime, HOURS, minutesSinceMidnight } from "../../../services/calendar/timeline";
import type { ToDo } from "../../../services/todos/todoManager";
import { CalendarTaskCard } from "../CalendarTaskCard";

/** Cards fill most, not all, of the column so the vertical divider between
 * columns (see `showRightBorder` below) always shows a sliver of gutter on
 * both sides — a ratio, not a pixel value, applied via `alignSelf: "center"`
 * so it scales with whatever `width` the caller computed rather than a
 * left/width percentage split. */
const CARD_WIDTH_RATIO = 0.94;

/** Same cap/overflow-label pattern as MonthLayout.tsx's per-cell dots and
 * DayHeaderCell.tsx's own header dots — see the doc comment below for why a
 * same-time collision needs this at all. */
const MAX_STACK = 3;

export type DayColumnTimelineProps = {
  /** Every one of this date's to-dos — including any sitting at
   * `DEFAULT_NOTIFICATION_TIME`, which is a fallback reminder time, not an
   * all-day marker (see WeekGridLayout.tsx's own doc comment). Every item
   * plots on the grid at its own `notificationTime`. */
  items: ToDo[];
  isToday: boolean;
  nowMinutes: number;
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onLongPressDelete: (item: ToDo) => void;
  /** Live-computed by the caller (`useWindowDimensions()`-derived), never a
   * fixed constant — see WeekLayout.tsx/WorkWeekLayout.tsx. */
  width: number;
  hourHeight: number;
  /** Vertical divider on this column's trailing edge — the caller passes
   * `false` for the last column so the grid doesn't end on a stray line. */
  showRightBorder?: boolean;
  style?: StyleProp<ViewStyle>;
};

/**
 * One day's hourly grid: a `HOURS.length * hourHeight`-tall column with a
 * subtle horizontal line at every hour boundary and, optionally, a vertical
 * divider on its trailing edge (the "structural grid" the layout spec asks
 * for), task chips positioned by their own `notificationTime`, and a live
 * red "now" line when `isToday`. Same positioning math as DayLayout.tsx's
 * single-day timeline, generalized to one column among several, but with
 * every dimension passed in live rather than read from a fixed constant.
 *
 * Tasks sharing the exact same clock time fill ONE hour-row's worth of
 * height (from the gridline above to the one below, never beyond it) and
 * split its width evenly between up to `MAX_STACK` of them side by side,
 * with a plain "+N" indicator once there are more — never tappable itself,
 * just a signal that there's more here than this view can show at a glance.
 * Real on-device bug this replaces: the previous version stacked colliding
 * tasks vertically, one synthetic-duration block below the next, with no
 * cap — six reminders at the same 5am slot spilled all the way down through
 * the 6am and 7am rows, visually misrepresenting when they were actually
 * due. Every card is `CARD_WIDTH_RATIO` of the FULL column width, centered
 * (`alignSelf: "center"`), matching the layout spec's literal
 * `width: '94%', alignSelf: 'center'`.
 */
export function DayColumnTimeline({
  items,
  isToday,
  nowMinutes,
  onOpenTask,
  onCheckTask,
  onLongPressDelete,
  width,
  hourHeight,
  showRightBorder = true,
  style,
}: DayColumnTimelineProps) {
  const slots = bucketByTime(items);
  const totalHeight = HOURS.length * hourHeight;

  return (
    <View
      style={[
        styles.column,
        { width, height: totalHeight },
        showRightBorder && styles.rightBorder,
        style,
      ]}
    >
      {HOURS.map((hour) => (
        <View key={hour} style={[styles.hourLine, { top: hour * hourHeight }]} />
      ))}

      {isToday && <View style={[styles.nowLine, { top: (nowMinutes / 60) * hourHeight }]} />}

      {slots.map(([time, group]) => {
        const baseTop = (minutesSinceMidnight(time) / 60) * hourHeight;
        const visible = group.slice(0, MAX_STACK);
        const overflowCount = group.length - visible.length;

        return (
          <View key={time} style={[styles.timeSlot, { top: baseTop, height: hourHeight }]}>
            {visible.map((item) => (
              <View key={item.id} style={styles.stackedCard}>
                <CalendarTaskCard
                  item={item}
                  variant="micro"
                  onPress={onOpenTask}
                  onCheck={onCheckTask}
                  onLongPressDelete={onLongPressDelete}
                  style={styles.cardFill}
                />
              </View>
            ))}
            {overflowCount > 0 && (
              <View style={styles.overflowBadge}>
                <Text style={styles.overflowText}>+{overflowCount}</Text>
              </View>
            )}
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    // `width`/`height` set inline per-instance, computed live by the
    // caller — see this component's own prop doc comments.
  },
  rightBorder: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
  hourLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  nowLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: colors.danger,
    zIndex: 5,
  },
  timeSlot: {
    position: "absolute",
    width: `${CARD_WIDTH_RATIO * 100}%`,
    alignSelf: "center",
    flexDirection: "row",
    gap: 2,
  },
  stackedCard: {
    flex: 1,
    height: "100%",
  },
  cardFill: {
    width: "100%",
    height: "100%",
  },
  overflowBadge: {
    flex: 1,
    height: "100%",
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  overflowText: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "700",
  },
});
