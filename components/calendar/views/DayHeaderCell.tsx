import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { colors, radius, typography } from "../../../constants/theme";

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;

/** Same cap as MonthLayout.tsx's own dot row — keeps the "glance at the
 * header, know there's something that day" signal consistent across every
 * layout rather than each one inventing its own threshold. */
const MAX_DOTS = 3;

function parseIso(iso: string): { day: number; weekday: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { day, weekday: new Date(year, month - 1, day).getDay() };
}

export type DayHeaderCellProps = {
  date: string;
  isToday: boolean;
  /** Count of to-dos on this date — renders as small dots (capped at
   * `MAX_DOTS`, "+N" beyond that) under the date bubble, same visual
   * language as MonthLayout.tsx's per-cell dots. Lets a reminder set for
   * later in the day be spotted right at the header, without scrolling the
   * hourly grid below to find it (the exact gap this was added to close).
   * Omitted/0 renders nothing — no empty placeholder row. */
  taskCount?: number;
  style?: StyleProp<ViewStyle>;
};

/** One column's header — day initial + date-number bubble, today filled
 * with the accent color — shared by WorkWeekLayout and WeekLayout so both
 * headers stay visually identical (they only differ in sizing strategy,
 * passed via `style`). Plain `View`/`Text`, no touchable, so `flex`/`width`
 * passed through `style` sizes it reliably either way. */
export function DayHeaderCell({ date, isToday, taskCount = 0, style }: DayHeaderCellProps) {
  const { day, weekday } = parseIso(date);

  return (
    <View style={[styles.column, style]}>
      <Text style={styles.dayInitial}>{DAY_INITIALS[weekday]}</Text>
      <View style={[styles.dateBubble, isToday && styles.dateBubbleActive]}>
        <Text style={[styles.dateNumber, isToday && styles.dateNumberActive]}>{day}</Text>
      </View>
      {taskCount > 0 && (
        <View style={styles.dotsRow}>
          {Array.from({ length: Math.min(taskCount, MAX_DOTS) }).map((_, index) => (
            <View key={index} style={styles.dot} />
          ))}
          {taskCount > MAX_DOTS && <Text style={styles.moreText}>+{taskCount - MAX_DOTS}</Text>}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    alignItems: "center",
    gap: 4,
  },
  dayInitial: {
    color: colors.textMuted,
    ...typography.caption,
  },
  dateBubble: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  dateBubbleActive: {
    backgroundColor: colors.accent,
  },
  dateNumber: {
    color: colors.textPrimary,
    ...typography.subheading,
  },
  dateNumberActive: {
    color: colors.onAccent,
  },
  dotsRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    height: 8,
  },
  dot: {
    width: 5,
    height: 5,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  moreText: {
    color: colors.textMuted,
    fontSize: 8,
    fontWeight: "700",
  },
});
