import { useCallback, useMemo } from "react";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
// RNGH's own ScrollView, not plain react-native's — see DayLayout.tsx's
// identical import comment for why (CalendarBody.tsx's swipe-to-navigate
// gesture needs it to negotiate with this ScrollView correctly; this is
// also the real fix for "the day panel below the grid doesn't scroll" —
// a vanilla ScrollView never had anything to actually claim the gesture in
// the first place once it sat inside a Gesture.Pan detector).
import { Gesture, GestureDetector, ScrollView } from "react-native-gesture-handler";
import { runOnJS } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, radius, spacing, typography } from "../../../constants/theme";
import {
  endOfMonth,
  groupToDosByDate,
  shiftIsoDate,
  startOfMonth,
  startOfWeek,
  todayIso,
  type DateRange,
} from "../../../services/calendar/dateRange";
import type { ToDo } from "../../../services/todos/todoManager";
import { CalendarTaskCard } from "../CalendarTaskCard";

const DAY_INITIALS = ["S", "M", "T", "W", "T", "F", "S"] as const;
const MAX_DOTS = 3;
/** Fixed, not intrinsic — applied to `cell`'s own style below (overriding
 * whatever its content would otherwise size to) so this value exactly
 * matches the real rendered row height, which the single shared tap
 * gesture's manual hit-testing depends on being accurate. Matches the
 * pre-existing intrinsic size (4px top/bottom padding + 28px date bubble +
 * 4px gap + 8px dots row = 48px) so this change is a pure performance
 * fix, not a visual one. */
const CELL_HEIGHT = 48;

function parseIso(iso: string): { year: number; month: number; day: number } {
  const [year, month, day] = iso.split("-").map(Number);
  return { year, month, day };
}

function parseIsoAsDate(iso: string): Date {
  const { year, month, day } = parseIso(iso);
  return new Date(year, month - 1, day);
}

/** "Friday, 25 September 2026" for the day panel's own header — same shape
 * CalendarDayTray.tsx's now-removed formatter used. */
function formatFullDate(iso: string): string {
  const { year, month, day } = parseIso(iso);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

export type MonthLayoutProps = {
  range: DateRange;
  /** The calendar store's shared anchor date — a tapped cell reports itself
   * here (via `onSelectDate`) so it renders with a visible "selected" ring
   * distinct from "today"'s filled bubble, drives which date's cards the
   * panel below the grid shows, and keeps the other layouts in sync if the
   * user switches to one of them next. Defaulting to today (so the panel
   * shows today's cards the instant Month view mounts, with no tap needed)
   * is the intended behavior now that the panel is a persistent fixture
   * rather than something that has to be opened. */
  selectedDate: string;
  onSelectDate: (date: string) => void;
  todos: ToDo[];
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onOpenSourceNote: (noteId: string) => void;
  onLongPressDelete: (item: ToDo) => void;
  onSendToCalendar: (item: ToDo) => void;
};

/**
 * Sleek month grid: 7 columns, as many rows as the month actually needs
 * (4-6, computed from the real calendar rather than a hardcoded "7x5" that
 * would either clip a 6-row month or waste a row on a 4-row one). Each cell
 * shows its date number and up to `MAX_DOTS` small colored dots — one per
 * task that day — with a "+N" label once there are more than that.
 *
 * Below the grid: a persistent, always-visible panel showing `selectedDate`'s
 * full task list (Google Calendar's own month-view layout — an inline
 * agenda under the grid, not a sheet that has to be opened). Tapping a date
 * cell just calls `onSelectDate`, same as every other layout's date
 * navigation; the panel below reacts to that immediately, no separate
 * "open" step or local open/closed state of its own. Replaces an earlier
 * version of this file that opened `CalendarDayTray`, an animated bottom
 * sheet, on tap — removed per explicit correction: this panel should be
 * there to look at, the same way the month grid itself always is, not
 * something you have to summon per date and dismiss again to see the next.
 * Tapping a card in the panel still opens the full edit sheet directly
 * (`onOpenTask`), completing the same two-step ("see the day's cards, then
 * open one") the tray gave before.
 */
export function MonthLayout({
  range,
  selectedDate,
  onSelectDate,
  todos,
  onOpenTask,
  onCheckTask,
  onOpenSourceNote,
  onLongPressDelete,
  onSendToCalendar,
}: MonthLayoutProps) {
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();

  // Explicit computed width per cell, not `flex: 1` on the cell itself —
  // this RNGH version's touchables (this grid used a `TouchableOpacity` per
  // cell until the single-shared-gesture rewrite below) did not reliably
  // propagate `flex` sizing to their rendered native view on Android in this
  // RNGH version, which collapsed every cell to its own intrinsic content
  // width instead of 1/7 of the row — the on-device symptom was the whole
  // month's dates rendering packed into what looked like one jumbled row
  // instead of clean 7-wide weeks. Computing the width here, from a live
  // `useWindowDimensions()` (reactive to rotation/foldable resize, unlike a
  // one-time `Dimensions.get()` snapshot) and applying it as an explicit
  // number, sidesteps that flex-propagation gap entirely rather than
  // depending on it.
  const cellWidth = Math.floor((screenWidth - spacing.base * 2) / 7);

  const groups = useMemo(() => groupToDosByDate(todos, true), [todos]);
  const groupByDate = useMemo(() => new Map(groups.map((group) => [group.date, group.items])), [groups]);
  const today = todayIso();

  // Weeks fully covering the month (leading/trailing days from adjacent
  // months included, dimmed, so the grid is always a clean rectangle). Row
  // count is computed directly from the calendar (gridStart -> month's last
  // day, inclusive, rounded up to whole weeks) rather than grown
  // iteratively — a "keep adding rows while the last one still touches the
  // target month" loop always overshoots by exactly one trailing
  // all-out-of-month row, since the row that finally leaves the month is
  // still the one that needs to be kept.
  const weeks = useMemo(() => {
    const monthStart = startOfMonth(range.start);
    const monthEnd = endOfMonth(range.start);
    const { month: targetMonth } = parseIso(monthStart);
    const gridStart = startOfWeek(monthStart);

    const daysInGrid = Math.round(
      (parseIsoAsDate(monthEnd).getTime() - parseIsoAsDate(gridStart).getTime()) / (24 * 60 * 60 * 1000)
    ) + 1;
    const rowCount = Math.ceil(daysInGrid / 7);

    const rows: { date: string; inMonth: boolean }[][] = [];
    let cursor = gridStart;
    for (let r = 0; r < rowCount; r += 1) {
      const row: { date: string; inMonth: boolean }[] = [];
      for (let i = 0; i < 7; i += 1) {
        row.push({ date: cursor, inMonth: parseIso(cursor).month === targetMonth });
        cursor = shiftIsoDate(cursor, 1);
      }
      rows.push(row);
    }
    return rows;
  }, [range.start]);

  const selectedDayTodos = groupByDate.get(selectedDate) ?? [];

  // ONE shared gesture recognizer for the whole grid, doing manual
  // row/column hit-testing from the tap's local coordinates, instead of a
  // separate `TouchableOpacity` (its own native gesture recognizer) per
  // cell — up to 35-42 of them for a 5-6 row month. Live on-device logcat
  // timing (see BACKLOG.md's now-resolved "Month/Week grid native render
  // cost" entry) measured ~500ms of native view-creation cost per page
  // change, and per-cell touchables were a real, mountable-view-count
  // contributor to that. `cellWidth`/`CELL_HEIGHT` are both applied as
  // EXPLICIT, fixed styles on the cell View below (not left to intrinsic
  // sizing) specifically so this math can trust them.
  const handleGridTap = useCallback(
    (localX: number, localY: number) => {
      const col = Math.min(6, Math.max(0, Math.floor(localX / cellWidth)));
      const row = Math.min(weeks.length - 1, Math.max(0, Math.floor(localY / CELL_HEIGHT)));
      const cell = weeks[row]?.[col];
      if (!cell) {
        return;
      }
      const items = groupByDate.get(cell.date) ?? [];
      const disabled = items.length === 0 && !cell.inMonth;
      if (disabled) {
        return;
      }
      onSelectDate(cell.date);
    },
    [weeks, cellWidth, groupByDate, onSelectDate]
  );

  const gridTapGesture = Gesture.Tap().onEnd((event) => {
    runOnJS(handleGridTap)(event.x, event.y);
  });

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={[styles.container, { paddingBottom: insets.bottom + spacing.lg }]}
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.weekdayRow}>
        {DAY_INITIALS.map((initial, index) => (
          <Text key={index} style={[styles.weekdayLabel, { width: cellWidth }]}>
            {initial}
          </Text>
        ))}
      </View>

      <GestureDetector gesture={gridTapGesture}>
        <View>
          {weeks.map((week, rowIndex) => (
            <View key={rowIndex} style={styles.weekRow}>
              {week.map(({ date, inMonth }) => {
                const { day } = parseIso(date);
                const items = groupByDate.get(date) ?? [];
                const isToday = date === today;
                const isSelected = date === selectedDate && !isToday;

                return (
                  <View key={date} style={[styles.cell, { width: cellWidth, height: CELL_HEIGHT }]}>
                    <View
                      style={[
                        styles.dateBubble,
                        isSelected && styles.dateBubbleSelected,
                        isToday && styles.dateBubbleActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.dateNumber,
                          !inMonth && styles.dateNumberDimmed,
                          isToday && styles.dateNumberActive,
                        ]}
                      >
                        {day}
                      </Text>
                    </View>
                    <View style={styles.dotsRow}>
                      {items.slice(0, MAX_DOTS).map((item) => (
                        <View key={item.id} style={styles.dot} />
                      ))}
                      {items.length > MAX_DOTS && <Text style={styles.moreText}>+{items.length - MAX_DOTS}</Text>}
                    </View>
                  </View>
                );
              })}
            </View>
          ))}
        </View>
      </GestureDetector>

      <View style={styles.dayPanel}>
        <Text style={styles.dayPanelTitle}>{formatFullDate(selectedDate)}</Text>
        {selectedDayTodos.length === 0 ? (
          <Text style={styles.emptyText}>Nothing scheduled this day.</Text>
        ) : (
          <View style={styles.dayPanelList}>
            {selectedDayTodos.map((item) => (
              <CalendarTaskCard
                key={item.id}
                item={item}
                variant="full"
                onPress={onOpenTask}
                onCheck={onCheckTask}
                onOpenSourceNote={onOpenSourceNote}
                onLongPressDelete={onLongPressDelete}
                onSendToCalendar={onSendToCalendar}
              />
            ))}
          </View>
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
  },
  container: {
    paddingHorizontal: spacing.base,
  },
  dayPanel: {
    marginTop: spacing.lg,
    paddingTop: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  dayPanelTitle: {
    color: colors.textPrimary,
    ...typography.heading,
    marginBottom: spacing.md,
  },
  dayPanelList: {
    gap: spacing.sm,
  },
  emptyText: {
    color: colors.textMuted,
    ...typography.body,
    marginTop: spacing.lg,
    textAlign: "center",
  },
  weekdayRow: {
    flexDirection: "row",
    marginBottom: spacing.xs,
  },
  weekdayLabel: {
    textAlign: "center",
    color: colors.textMuted,
    ...typography.caption,
  },
  weekRow: {
    flexDirection: "row",
  },
  cell: {
    alignItems: "center",
    paddingVertical: spacing.xs,
    gap: 4,
  },
  dateBubble: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  dateBubbleActive: {
    backgroundColor: colors.accent,
  },
  dateBubbleSelected: {
    borderWidth: 2,
    borderColor: colors.accent,
  },
  dateNumber: {
    color: colors.textPrimary,
    fontSize: 13,
    fontWeight: "600",
  },
  dateNumberDimmed: {
    color: colors.textMuted,
    opacity: 0.4,
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
