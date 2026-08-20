import { useEffect, useRef } from "react";
import { ActivityIndicator, Animated, Image, Pressable, StyleSheet, View } from "react-native";

import { colors, elevation } from "../constants/theme";

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
  const pulse = useRef(new Animated.Value(0)).current;

  // A slow breathing aura while actively recording — RN's built-in Animated
  // API (no reanimated in this project), looped scale + fade so the ring
  // expands outward and dissolves, then resets. Two rings (violet + cyan),
  // the cyan one started on a slight delay so the two glows visibly
  // separate as they expand rather than staying perfectly stacked — that
  // offset is what actually reads as a "neon violet/cyan" pulse rather than
  // a single-color ring.
  useEffect(() => {
    if (state !== "recording") {
      pulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 1600,
        useNativeDriver: true,
      })
    );
    loop.start();
    return () => loop.stop();
  }, [state, pulse]);

  const violetAuraScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.7] });
  const violetAuraOpacity = pulse.interpolate({ inputRange: [0, 0.6, 1], outputRange: [0.5, 0.18, 0] });
  const cyanAuraScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.45] });
  const cyanAuraOpacity = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.55, 0.2, 0] });

  return (
    <View style={styles.wrapper}>
      {state === "recording" && (
        <>
          <Animated.View
            pointerEvents="none"
            style={[
              styles.aura,
              styles.auraViolet,
              { transform: [{ scale: violetAuraScale }], opacity: violetAuraOpacity },
            ]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.aura,
              styles.auraCyan,
              { transform: [{ scale: cyanAuraScale }], opacity: cyanAuraOpacity },
            ]}
          />
        </>
      )}
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
          <ActivityIndicator color={colors.onAccent} size="small" />
        ) : (
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          <Image source={require("../assets/icon.png")} style={styles.emblem} resizeMode="contain" />
        )}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  aura: {
    position: "absolute",
    width: 76,
    height: 76,
    borderRadius: 38,
  },
  auraViolet: {
    backgroundColor: colors.accent,
  },
  auraCyan: {
    backgroundColor: colors.accentCyan,
  },
  button: {
    width: 76,
    height: 76,
    borderRadius: 38,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    ...elevation.floating,
  },
  buttonRecording: {
    backgroundColor: colors.accentCyan,
    shadowColor: colors.accentCyan,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.85,
  },
  emblem: {
    width: 44,
    height: 44,
  },
});
