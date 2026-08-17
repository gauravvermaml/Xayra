import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

const colors = {
  accent: "#6366f1",
  danger: "#f87171",
  textPrimary: "#f8fafc",
};

export type CentralMicButtonState = "idle" | "recording" | "busy";

export type CentralMicButtonProps = {
  state: CentralMicButtonState;
  onPress: () => void;
  disabled?: boolean;
};

/**
 * Rendered directly beneath the tab switcher on both the Notes and Chat
 * screens, immediately after <ViewToggle>. Everything above it (title,
 * subtitle, ViewToggle) is identical single-line-height content on both
 * screens, so this button lands at the same x/y on both tabs without any
 * extra positioning logic.
 */
export function CentralMicButton({ state, onPress, disabled }: CentralMicButtonProps) {
  return (
    <View style={styles.wrapper}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
        style={({ pressed }) => [
          styles.button,
          state === "recording" && styles.buttonRecording,
          disabled && styles.buttonDisabled,
          pressed && styles.buttonPressed,
        ]}
      >
        {state === "busy" ? (
          <ActivityIndicator color={colors.textPrimary} size="small" />
        ) : (
          <Text style={styles.icon}>{state === "recording" ? "■" : "🎤"}</Text>
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    marginBottom: 20,
  },
  button: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.accent,
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 8,
  },
  buttonRecording: {
    backgroundColor: colors.danger,
    shadowColor: colors.danger,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  icon: {
    fontSize: 28,
  },
});
