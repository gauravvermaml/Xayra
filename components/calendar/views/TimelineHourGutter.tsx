import { StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "../../../constants/theme";
import { formatHourLabel, HOURS } from "../../../services/calendar/timeline";

export type TimelineHourGutterProps = {
  /** Live-computed from `useWindowDimensions()` by the caller — see
   * WeekLayout.tsx/WorkWeekLayout.tsx's own `timeGutterWidth` — never a
   * fixed constant, per the layout mandate. */
  width: number;
  hourHeight: number;
};

/**
 * The 12 AM-11 PM label column running down the left edge of the timeline
 * grid, shared by WorkWeekLayout.tsx and WeekLayout.tsx. Every row is
 * exactly `hourHeight` tall and stacked in normal document flow (no
 * absolute positioning needed here — unlike task blocks, which can land at
 * an arbitrary minute, every hour boundary is already a fixed, regular
 * interval).
 */
export function TimelineHourGutter({ width, hourHeight }: TimelineHourGutterProps) {
  return (
    <View style={{ width }}>
      {HOURS.map((hour) => (
        <View key={hour} style={[styles.hourRow, { height: hourHeight }]}>
          <Text style={styles.hourLabel}>{formatHourLabel(hour)}</Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  hourRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingRight: spacing.xs,
    alignItems: "flex-end",
  },
  // A `View`'s default `justifyContent: "flex-start"` already places this
  // label at the very top of its OWN row, right against that row's own
  // `borderTopWidth` line — no negative offset is needed to achieve that.
  // An earlier version used `marginTop: -6` here, borrowing space from the
  // row ABOVE to nudge the label up further still; every row except the
  // very first one (12 AM, with no row above it to borrow from) absorbed
  // that harmlessly, but 12 AM's label rendered 6px above the scrollable
  // content's own top edge and was clipped by the ScrollView's bounds.
  hourLabel: {
    color: colors.textMuted,
    fontSize: 9,
    marginTop: 2,
  },
});
