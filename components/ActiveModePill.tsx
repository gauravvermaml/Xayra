import { ActivityIndicator, Pressable, StyleSheet, Text } from "react-native";

import type { ActiveModeState } from "../services/audio/activeMode";

const colors = {
  surface: "#1e293b",
  surfaceActive: "#312e81",
  border: "#334155",
  borderActive: "#6366f1",
  textPrimary: "#f8fafc",
  textMuted: "#94a3b8",
};

export type ActiveModePillProps = {
  isActive: boolean;
  state: ActiveModeState;
  onPress: () => void;
  disabled?: boolean;
};

function labelForState(isActive: boolean, state: ActiveModeState): string {
  if (!isActive) {
    return "🚿 Active Mode";
  }
  switch (state) {
    case "listening":
      return "👂 Listening…";
    case "processing":
      return "⏳ Thinking…";
    case "speaking":
      return "🔊 Speaking…";
    default:
      return "🚿 Active Mode";
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
      {isActive && state === "processing" && (
        <ActivityIndicator color={colors.textPrimary} size="small" style={styles.spinner} />
      )}
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
    borderRadius: 999,
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginBottom: 16,
    gap: 8,
  },
  pillActive: {
    backgroundColor: colors.surfaceActive,
    borderColor: colors.borderActive,
  },
  pillPressed: {
    opacity: 0.85,
  },
  pillDisabled: {
    opacity: 0.5,
  },
  spinner: {
    marginRight: 2,
  },
  label: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "700",
  },
  labelActive: {
    color: colors.textPrimary,
  },
});
