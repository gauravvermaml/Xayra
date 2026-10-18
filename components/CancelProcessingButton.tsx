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
}: {
  onCancel: () => void;
  testID?: string;
  accessibilityLabel?: string;
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
        <Animated.View style={[styles.button, pressed && styles.buttonPressed, animatedStyle]}>
          <Text style={styles.text}>Cancel</Text>
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
  buttonPressed: {
    backgroundColor: xayraColors.line,
  },
  text: {
    ...xayraType.chip,
    color: xayraColors.text,
  },
});
