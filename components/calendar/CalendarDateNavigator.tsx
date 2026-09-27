import { StyleSheet, Text, View } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import { Feather } from "@expo/vector-icons";

import { colors, radius, spacing, typography } from "../../constants/theme";
import { getDateRangeForMode, todayIso, type CalendarLayoutMode } from "../../services/calendar/dateRange";

/** Same cap as MonthLayout.tsx's per-cell dots and DayHeaderCell.tsx's own
 * copy of the same constant — kept in sync visually, not by import, since
 * each of the three is a small enough local concern (see those files' own
 * "duplicated on purpose" convention elsewhere in this calendar system). */
const MAX_DOTS = 3;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;

function parseIso(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

/** "Friday, 25 Sep" for Day view. */
function formatDayLabel(iso: string): string {
  const { year, month, day } = parseIso(iso);
  const weekday = WEEKDAY_NAMES[new Date(year, month - 1, day).getDay()];
  return `${weekday}, ${day} ${MONTH_ABBR[month - 1]}`;
}

/** "Sep 21 – 25, 2026" for Week/Work Week; drops the repeated month when the
 * range doesn't cross a month boundary, spells both out when it does. */
function formatRangeLabel(startIso: string, endIso: string): string {
  const start = parseIso(startIso);
  const end = parseIso(endIso);
  if (start.month === end.month) {
    return `${MONTH_ABBR[start.month - 1]} ${start.day} – ${end.day}, ${end.year}`;
  }
  return `${MONTH_ABBR[start.month - 1]} ${start.day} – ${MONTH_ABBR[end.month - 1]} ${end.day}, ${end.year}`;
}

/** "September 2026" for Month view. */
function formatMonthLabel(iso: string): string {
  const { year, month } = parseIso(iso);
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function formatLabelForMode(mode: CalendarLayoutMode, selectedDate: string): string {
  switch (mode) {
    case "day":
      return formatDayLabel(selectedDate);
    case "work_week":
    case "week": {
      const range = getDateRangeForMode(mode, selectedDate);
      return range ? formatRangeLabel(range.start, range.end) : "";
    }
    case "month":
      return formatMonthLabel(selectedDate);
    case "schedule":
      return "";
  }
}

export type CalendarDateNavigatorProps = {
  mode: CalendarLayoutMode;
  selectedDate: string;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
  /** Day view only — count of to-dos on `selectedDate`, shown as small dots
   * under the label (same visual language as MonthLayout.tsx's per-cell
   * dots and DayHeaderCell.tsx's per-column ones). Day view has no per-
   * column header the way Week/Work Week do (there's only ever one date on
   * screen), so this bar is the one place left for the same "know there's
   * something without scrolling the hourly grid" signal. Week/Work Week/
   * Month already have their own dots elsewhere, so callers only pass this
   * for `mode === "day"`. */
  taskCount?: number;
};

/**
 * The sticky "< Friday, 25 Sep >" controller bar sitting above the active
 * grid layout, plus a "Today" quick-jump chip (hidden when already viewing
 * today, since it would be a no-op tap otherwise). Not rendered at all for
 * Schedule view — see CalendarBody.tsx for why: a continuous feed has
 * nothing for prev/next/today to page through.
 *
 * `TouchableOpacity` from `react-native-gesture-handler`, not plain RN
 * `Pressable` — see CalendarViewSelector.tsx's own doc comment for why,
 * under this specific screen (TodosOverlay.tsx, which mounts
 * `@gorhom/bottom-sheet`).
 */
export function CalendarDateNavigator({ mode, selectedDate, onPrevious, onNext, onToday, taskCount = 0 }: CalendarDateNavigatorProps) {
  const label = formatLabelForMode(mode, selectedDate);
  const isToday = selectedDate === todayIso();

  return (
    <View style={styles.row}>
      <TouchableOpacity onPress={onPrevious} hitSlop={10} activeOpacity={0.7} style={styles.arrowButton}>
        <Feather name="chevron-left" size={18} color={colors.textPrimary} />
      </TouchableOpacity>

      <View style={styles.labelColumn}>
        <Text style={styles.label} numberOfLines={1}>
          {label}
        </Text>
        {taskCount > 0 && (
          <View style={styles.dotsRow}>
            {Array.from({ length: Math.min(taskCount, MAX_DOTS) }).map((_, index) => (
              <View key={index} style={styles.dot} />
            ))}
            {taskCount > MAX_DOTS && <Text style={styles.moreText}>+{taskCount - MAX_DOTS}</Text>}
          </View>
        )}
      </View>

      <TouchableOpacity onPress={onNext} hitSlop={10} activeOpacity={0.7} style={styles.arrowButton}>
        <Feather name="chevron-right" size={18} color={colors.textPrimary} />
      </TouchableOpacity>

      {!isToday && (
        <TouchableOpacity onPress={onToday} activeOpacity={0.7} style={styles.todayChip}>
          <Text style={styles.todayChipText}>Today</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
  },
  arrowButton: {
    width: 32,
    height: 32,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
  },
  labelColumn: {
    flex: 1,
    alignItems: "center",
    gap: 2,
  },
  label: {
    color: colors.textPrimary,
    ...typography.subheading,
    textAlign: "center",
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
  todayChip: {
    backgroundColor: colors.accentMuted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm + 2,
    paddingVertical: spacing.xs,
  },
  todayChipText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "700",
  },
});
