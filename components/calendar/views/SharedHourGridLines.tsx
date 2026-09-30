import { StyleSheet, View } from "react-native";

import { colors } from "../../../constants/theme";
import { HOURS } from "../../../services/calendar/timeline";

export type SharedHourGridLinesProps = {
  /** Combined width of every day column, NOT including the time gutter —
   * same `availableWidth` value WeekGridLayout.tsx already derives its own
   * `columnWidth` from. */
  width: number;
  hourHeight: number;
};

/**
 * The 24 horizontal hour-boundary lines spanning the full width of all day
 * columns combined, drawn ONCE and layered behind them (`pointerEvents=
 * "none"`, absolutely positioned) — replaces every `DayColumnTimeline`
 * drawing its own identical copy of these same 24 lines, redundantly, once
 * per column (5-7x over for Work Week/Week). Every column sits at the exact
 * same vertical hour positions, so there was never a reason for each one to
 * own a separate copy.
 *
 * This is a real, measured performance fix, not a style preference: see
 * BACKLOG.md's now-resolved "Month/Week grid native render cost" entry —
 * live on-device logcat timing found ~500ms of native view-creation cost
 * per page change on constrained hardware, and per-column duplicate hour
 * lines were a genuine contributor (24 lines × up to 7 columns = up to 168
 * native Views, down to 24 once shared).
 */
export function SharedHourGridLines({ width, hourHeight }: SharedHourGridLinesProps) {
  return (
    <View pointerEvents="none" style={[styles.container, { width }]}>
      {HOURS.map((hour) => (
        <View key={hour} style={[styles.hourLine, { top: hour * hourHeight }]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
  },
  hourLine: {
    position: "absolute",
    left: 0,
    right: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
});
