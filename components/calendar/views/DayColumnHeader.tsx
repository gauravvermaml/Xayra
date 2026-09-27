import { StyleSheet, View } from "react-native";

import { colors } from "../../../constants/theme";
import { DayHeaderCell } from "./DayHeaderCell";

export type DayColumnHeaderProps = {
  date: string;
  isToday: boolean;
  width: number;
  /** Passed straight through to DayHeaderCell's own dot indicator — see its
   * doc comment. */
  taskCount?: number;
  showRightBorder?: boolean;
};

/**
 * The non-scrolling top of one day's column: just its date header. Kept as
 * its own small component (rather than using `DayHeaderCell` directly in
 * WeekGridLayout.tsx) so the vertical divider matching the grid below it
 * lives in one place. Rendered with the exact same `width` as this same
 * date's `DayColumnTimeline` below — that shared value, computed once in
 * WeekGridLayout.tsx, is what actually keeps the header and grid columns
 * aligned under each other.
 *
 * There is no all-day concept in this calendar system today — an earlier
 * version of this component also rendered an `AllDaySlot` here for to-dos
 * sitting at `DEFAULT_NOTIFICATION_TIME` (5 AM), on the theory that value
 * meant "no time was ever set." Per explicit user correction, that default
 * exists only to give a new to-do SOME reminder time when the user never
 * picks one (see db/schema.ts's own doc comment) — it does not mean
 * all-day, and every to-do now plots on the hourly grid at its own
 * `notificationTime` regardless of what that value is (see
 * DayColumnTimeline.tsx).
 */
export function DayColumnHeader({ date, isToday, width, taskCount = 0, showRightBorder = true }: DayColumnHeaderProps) {
  return (
    <View style={[styles.column, { width }, showRightBorder && styles.rightBorder]}>
      <DayHeaderCell date={date} isToday={isToday} taskCount={taskCount} />
    </View>
  );
}

const styles = StyleSheet.create({
  column: {
    paddingHorizontal: 2,
  },
  rightBorder: {
    borderRightWidth: StyleSheet.hairlineWidth,
    borderRightColor: colors.border,
  },
});
