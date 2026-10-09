import { Pressable, StyleSheet, Text } from "react-native";
import * as Haptics from "expo-haptics";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

const PRESSED_SCALE = 0.9;

/**
 * The explicit "stop processing" action under the central button. Same
 * press physics as CentralRecorderCanvas's own button, scaled down: a quick
 * depress plus a light haptic on press-in, so the tap registers at once,
 * and a spring back on release. `onCancel` fires on the normal press —
 * nothing waits for the animation.
 */
export function CancelProcessingButton({ onCancel }: { onCancel: () => void }) {
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
      testID="cancel-processing"
      onPress={onCancel}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel="Cancel"
    >
      {({ pressed }) => (
        <Animated.View style={[styles.button, pressed && styles.buttonPressed, animatedStyle]}>
          <Text style={styles.text}>Cancel</Text>
        </Animated.View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.35)",
  },
  buttonPressed: {
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  text: {
    color: "rgba(255,255,255,0.8)",
    fontSize: 12,
    fontWeight: "600",
  },
});
