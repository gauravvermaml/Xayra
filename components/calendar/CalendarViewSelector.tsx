import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import Animated, {
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { colors, radius, spacing, typography } from "../../constants/theme";
import type { CalendarLayoutMode } from "../../hooks/useCalendarViewStore";

const OPTIONS: { mode: CalendarLayoutMode; icon: string; label: string }[] = [
  { mode: "day", icon: "📅", label: "Day" },
  { mode: "work_week", icon: "📅", label: "Work Week" },
  { mode: "week", icon: "📅", label: "Week" },
  { mode: "month", icon: "📅", label: "Month" },
  { mode: "schedule", icon: "📑", label: "Schedule View" },
];

const OPTION_BY_MODE = new Map(OPTIONS.map((option) => [option.mode, option]));

export type CalendarViewSelectorProps = {
  mode: CalendarLayoutMode;
  onChange: (mode: CalendarLayoutMode) => void;
};

/**
 * The layout-mode dropdown — an elevated pill ("📅 Work Week ▼") that folds
 * a selection menu open/closed beneath it. Deliberately a plain absolutely-
 * positioned overlay driven by Reanimated (height/opacity + chevron
 * rotation), not a native `<Modal>` or a library dropdown — this codebase
 * has already hit real touch-input bugs from native `<Modal>` layered over
 * this screen's own gesture-handler root (see TodosOverlay.tsx's own top-
 * level doc comment, and app/index.tsx's quick-menu popover, which
 * established this exact "backdrop Pressable + anchored absolute View"
 * pattern this component reuses).
 *
 * Selecting an option closes the menu (folds back up) and updates the
 * button label in the same tap — there's no separate "confirm" step.
 *
 * Every touchable here is `TouchableOpacity` from `react-native-gesture-
 * handler`, not plain RN `Pressable` — this screen (TodosOverlay.tsx) also
 * mounts `@gorhom/bottom-sheet` (AddTodoBottomSheet, TaskPreviewSheet), and
 * mixing RN's plain responder system with RNGH's native touch-dispatch
 * takeover in the same gesture-handler root is a documented, previously-hit
 * source of touch bugs in this exact codebase (see TodoItemRow.tsx's own
 * doc comment for the established rule this follows).
 */
export function CalendarViewSelector({ mode, onChange }: CalendarViewSelectorProps) {
  const [isOpen, setIsOpen] = useState(false);
  const openProgress = useSharedValue(0);

  const setOpen = (next: boolean) => {
    setIsOpen(next);
    openProgress.value = withTiming(next ? 1 : 0, { duration: 220 });
  };

  const menuAnimatedStyle = useAnimatedStyle(() => ({
    opacity: openProgress.value,
    transform: [
      { scaleY: interpolate(openProgress.value, [0, 1], [0.85, 1]) },
      { translateY: interpolate(openProgress.value, [0, 1], [-8, 0]) },
    ],
  }));

  const chevronAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${interpolate(openProgress.value, [0, 1], [0, 180])}deg` }],
  }));

  const active = OPTION_BY_MODE.get(mode) ?? OPTIONS[0];

  return (
    <View style={styles.container}>
      <TouchableOpacity onPress={() => setOpen(!isOpen)} activeOpacity={0.75} style={styles.trigger}>
        <Text style={styles.triggerText}>
          {active.icon} {active.label}
        </Text>
        <Animated.Text style={[styles.chevron, chevronAnimatedStyle]}>▼</Animated.Text>
      </TouchableOpacity>

      {isOpen && (
        <View style={styles.menuWrap} pointerEvents="box-none">
          <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={() => setOpen(false)} />
          <Animated.View style={[styles.menu, menuAnimatedStyle]}>
            {OPTIONS.map((option) => (
              <TouchableOpacity
                key={option.mode}
                onPress={() => {
                  onChange(option.mode);
                  setOpen(false);
                }}
                activeOpacity={0.7}
                style={[styles.menuRow, option.mode === mode && styles.menuRowActive]}
              >
                <Text style={styles.menuRowText}>
                  {option.icon} {option.label}
                </Text>
                {option.mode === mode && <Text style={styles.menuRowCheck}>✓</Text>}
              </TouchableOpacity>
            ))}
          </Animated.View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "flex-start",
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.pill,
    paddingVertical: spacing.xs + 2,
    paddingHorizontal: spacing.base,
  },
  triggerText: {
    color: colors.textPrimary,
    ...typography.label,
  },
  chevron: {
    color: colors.textMuted,
    fontSize: 10,
  },
  // Sits below the trigger, overlaying whatever's beneath it (the search bar
  // / calendar body) rather than pushing that content down — matches the
  // "fold-down... overlay" wording in the spec.
  menuWrap: {
    position: "absolute",
    top: "100%",
    left: 0,
    right: 0,
    zIndex: 20,
    elevation: 20,
  },
  menu: {
    marginTop: spacing.xs,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    borderRadius: radius.lg,
    paddingVertical: spacing.xs,
    minWidth: 220,
    shadowColor: "#000000",
    shadowOpacity: 0.35,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: spacing.sm + 2,
    paddingHorizontal: spacing.base,
  },
  menuRowActive: {
    backgroundColor: colors.accentMuted,
  },
  menuRowText: {
    color: colors.textPrimary,
    ...typography.body,
    fontSize: 14,
  },
  menuRowCheck: {
    color: colors.accent,
    fontWeight: "700",
  },
});
