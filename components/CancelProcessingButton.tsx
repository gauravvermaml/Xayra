import { Pressable, StyleSheet, Text } from "react-native";
import * as Haptics from "expo-haptics";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { MIN_TOUCH_TARGET, xayraColors, xayraType } from "../constants/xayraTheme";

const PRESSED_SCALE = 0.9;

/**
 * The explicit "stop processing" action under the central button. Same
 * press physics as CentralRecorderCanvas's own button, scaled down: a quick
 * depress plus a light haptic on press-in, so the tap registers at once,
 * and a spring back on release. `onCancel` fires on the normal press —
 * nothing waits for the animation.
 */
export function CancelProcessingButton({
  onCancel,
  testID = "cancel-processing",
  accessibilityLabel = "Cancel",
  label = "Cancel",
  tone = "outline",
}: {
  onCancel: () => void;
  testID?: string;
  accessibilityLabel?: string;
  /** Visible text. "Finish" is the only other use (recording, when the
   * emblem is hidden). */
  label?: string;
  /** "filled" sets the primary of a Finish / Cancel pair apart. */
  tone?: "outline" | "filled";
}) {
  const scale = useSharedValue(1);
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const handlePressIn = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    scale.value = withTiming(PRESSED_SCALE, { duration: 80, easing: Easing.out(Easing.quad) });
  };
  const handlePressOut = () => {
    scale.value = withSpring(1, { damping: 9, stiffness: 220, mass: 0.6 });
  };

  return (
    <Pressable
      testID={testID}
      onPress={onCancel}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      hitSlop={(MIN_TOUCH_TARGET - BUTTON_HEIGHT) / 2}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
    >
      {({ pressed }) => (
        <Animated.View
          style={[
            styles.button,
            tone === "filled" && styles.buttonFilled,
            pressed && (tone === "filled" ? styles.buttonFilledPressed : styles.buttonPressed),
            animatedStyle,
          ]}
        >
          <Text style={[styles.text, tone === "filled" && styles.textFilled]}>{label}</Text>
        </Animated.View>
      )}
    </Pressable>
  );
}

const BUTTON_HEIGHT = 40;

/** Xayra 2.0: the same quiet outlined pill as Listen. */
const styles = StyleSheet.create({
  button: {
    minHeight: BUTTON_HEIGHT,
    paddingHorizontal: 18,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: xayraColors.outline,
    alignItems: "center",
    justifyContent: "center",
  },
  /** The primary of a Finish / Cancel pair (Stage 5d): solid lilac with
   * dark text, so it reads as the main action next to the outline Cancel
   * (the earlier 13% lilac tint was too close to it). */
  buttonFilled: {
    backgroundColor: xayraColors.lilac,
    borderColor: xayraColors.lilac,
  },
  buttonFilledPressed: {
    backgroundColor: xayraColors.lilacText,
  },
  textFilled: {
    color: xayraColors.surface,
    fontWeight: "600",
  },
  buttonPressed: {
    backgroundColor: xayraColors.line,
  },
  text: {
    ...xayraType.chip,
    color: xayraColors.text,
  },
});
