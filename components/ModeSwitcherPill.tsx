import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { colors, radius, spacing, typography } from "../constants/theme";

export type SheetMode = "notes" | "chat";

export type ModeSwitcherPillProps = {
  mode: SheetMode;
  onChange: (mode: SheetMode) => void;
  /** The bottom sheet's own `animatedIndex` (see components/HistorySheet.tsx)
   * — this pill's opacity is a direct function of it, not a separately
   * tracked "is the sheet expanded" boolean, so the fade tracks the sheet's
   * actual drag position (including mid-drag) rather than snapping only
   * once a snap point is reached. */
  sheetAnimatedIndex: SharedValue<number>;
  /** How far above the sheet's peek height to float — the caller (which
   * knows the peek height and the device's bottom safe-area inset) owns
   * this positioning rather than it being hardcoded here. */
  bottomOffset: number;
};

/**
 * Compact translucent [Notes | Chat] pill floating above the bottom sheet's
 * peek position — fades out entirely as the sheet expands (index 0 → 1) so
 * it never sits on top of the scrollable history content once that's
 * visible, per the Apple Maps reference: floating chrome recedes the moment
 * the sheet takes over the screen.
 */
export function ModeSwitcherPill({ mode, onChange, sheetAnimatedIndex, bottomOffset }: ModeSwitcherPillProps) {
  const fadeStyle = useAnimatedStyle(() => {
    const opacity = interpolate(sheetAnimatedIndex.value, [0, 0.6, 1], [1, 0.3, 0], "clamp");
    return {
      opacity,
      // Pull the pill out of the touch hierarchy once it's faded out, so a
      // tap meant for the expanded sheet's content underneath can't be
      // swallowed by an invisible pill still sitting on top of it.
      pointerEvents: opacity < 0.05 ? "none" : "auto",
    };
  });

  return (
    <Animated.View style={[styles.container, { bottom: bottomOffset }, fadeStyle]} pointerEvents="box-none">
      <View style={styles.pill}>
        {(["notes", "chat"] as const).map((option) => (
          <Pressable
            key={option}
            onPress={() => onChange(option)}
            style={[styles.option, mode === option && styles.optionActive]}
          >
            <Text style={[styles.optionText, mode === option && styles.optionTextActive]}>
              {option === "notes" ? "Notes" : "Chat"}
            </Text>
          </Pressable>
        ))}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    right: spacing.base,
    alignItems: "flex-end",
  },
  pill: {
    flexDirection: "row",
    backgroundColor: "rgba(28, 28, 30, 0.78)",
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    padding: 3,
  },
  option: {
    paddingHorizontal: spacing.md,
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  optionActive: {
    backgroundColor: colors.accent,
  },
  optionText: {
    color: "rgba(255,255,255,0.6)",
    ...typography.label,
    fontSize: 12,
  },
  optionTextActive: {
    color: colors.onAccent,
  },
});
