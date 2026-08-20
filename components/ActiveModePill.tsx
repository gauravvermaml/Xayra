import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, Text } from "react-native";

import { colors, elevation, radius, spacing, typography } from "../constants/theme";
import type { ActiveModeState } from "../services/audio/activeMode";

export type ActiveModePillProps = {
  isActive: boolean;
  state: ActiveModeState;
  onPress: () => void;
  disabled?: boolean;
};

function iconForState(isActive: boolean, state: ActiveModeState): string {
  if (!isActive) {
    return "🎧";
  }
  switch (state) {
    case "listening":
      return "👂";
    case "processing":
      return "⏳";
    case "speaking":
      return "🔊";
    default:
      return "🎧";
  }
}

function labelForState(isActive: boolean, state: ActiveModeState): string {
  if (!isActive) {
    return "Handsfree Mode";
  }
  switch (state) {
    case "listening":
      return "Listening…";
    case "processing":
      return "Thinking…";
    case "speaking":
      return "Speaking…";
    default:
      return "Handsfree Mode";
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
 * Toggle pill shown on both the Notes and Chat headers. Rendered identically
 * (same position, same component) on both screens so it's a stable,
 * predictable control regardless of which tab hands-free mode was started
 * from — matching the CentralMicButton's identical-position philosophy.
 *
 * Styled with a raised surface (border + soft shadow) and a leading icon
 * even at rest, specifically so it reads as an interactive control rather
 * than static status text — a flat hairline-bordered pill with muted-gray
 * text was found to look inert/non-clickable in on-device testing.
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
      hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
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
      <Text style={styles.icon}>{iconForState(isActive, state)}</Text>
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
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderWidth: 1,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.base,
    gap: spacing.sm,
    ...elevation.card,
  },
  pillActive: {
    backgroundColor: colors.surfaceActive,
    borderColor: colors.accent,
  },
  pillPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  pillDisabled: {
    opacity: 0.5,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  icon: {
    fontSize: 13,
  },
  label: {
    color: colors.textSecondary,
    ...typography.label,
  },
  labelActive: {
    color: colors.textPrimary,
  },
});
