import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";

import { colors, radius, spacing, typography } from "../constants/theme";
import type { ActiveModeState } from "../services/audio/activeMode";

export type ActiveModePillProps = {
  isActive: boolean;
  state: ActiveModeState;
  onPress: () => void;
  disabled?: boolean;
};

function labelForState(isActive: boolean, state: ActiveModeState): string {
  if (!isActive) {
    return "Active Mode";
  }
  switch (state) {
    case "listening":
      return "Listening…";
    case "processing":
      return "Thinking…";
    case "speaking":
      return "Speaking…";
    default:
      return "Active Mode";
  }
}

function dotColorForState(isActive: boolean, state: ActiveModeState): string {
  if (!isActive) {
    return colors.textMuted;
  }
  switch (state) {
    case "listening":
      return colors.danger;
    case "processing":
      return colors.warning;
    case "speaking":
      return colors.success;
    default:
      return colors.accent;
  }
}

/**
 * Soft toggle pill shown on both the Notes and Chat headers. Rendered
 * identically (same position, same component) on both screens so it's a
 * stable, predictable control regardless of which tab hands-free mode was
 * started from — matching the CentralMicButton's identical-position
 * philosophy from the Category A pass.
 */
export function ActiveModePill({ isActive, state, onPress, disabled }: ActiveModePillProps) {
  const dotPulse = useRef(new Animated.Value(1)).current;

  // Subtle breathing dot while active — a quieter echo of the mic button's
  // aura ring, communicating "still listening/thinking" without a spinner
  // dominating a small pill.
  useEffect(() => {
    if (!isActive) {
      dotPulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dotPulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(dotPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [isActive, dotPulse]);

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.pill,
        isActive && styles.pillActive,
        pressed && styles.pillPressed,
        disabled && styles.pillDisabled,
      ]}
    >
      <Animated.View
        style={[
          styles.dot,
          { backgroundColor: dotColorForState(isActive, state), opacity: dotPulse },
        ]}
      />
      <Text style={[styles.label, isActive && styles.labelActive]}>{labelForState(isActive, state)}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm,
    marginBottom: spacing.base,
    gap: spacing.sm,
  },
  pillActive: {
    backgroundColor: colors.surfaceActive,
    borderColor: colors.accent,
  },
  pillPressed: {
    opacity: 0.85,
  },
  pillDisabled: {
    opacity: 0.5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  label: {
    color: colors.textMuted,
    ...typography.label,
  },
  labelActive: {
    color: colors.textPrimary,
  },
});
