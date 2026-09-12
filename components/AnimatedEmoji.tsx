import { useEffect, useRef } from "react";
import { Animated, Easing, type StyleProp, type TextStyle } from "react-native";

export type AnimatedEmojiType = "pulse" | "rotate" | "bounce";

export type AnimatedEmojiProps = {
  /** The emoji glyph itself — rendered as plain text, not an image asset. */
  emoji: string;
  type: AnimatedEmojiType;
  /** Font size the emoji renders at. Defaults to a size that reads clearly
   * inline with body text without the caller needing to hand-tune it. */
  size?: number;
  /** Same shape React Native's own `style` props accept — a single style
   * object or an array of them (e.g. a shared icon style plus a state-
   * specific color override), not just one object. */
  style?: StyleProp<TextStyle>;
};

/**
 * Small, dependency-free emoji "micro-animation" wrapper built on React
 * Native's own `Animated` API (not Reanimated — this doesn't need a worklet
 * runtime for three simple transform loops) — deliberately scoped to
 * exactly the three motions the onboarding screen (`OnboardingSetupScreen`)
 * needs, not a general-purpose animation library:
 *
 * - `"pulse"`: a continuous, gentle scale breathing loop — for a persistent
 *   header icon (e.g. 🧠) that should feel alive without being distracting.
 * - `"rotate"`: a continuous 360° spin loop — for an in-progress indicator
 *   (e.g. ⏳) shown only while its step is actively working.
 * - `"bounce"`: a ONE-SHOT spring bounce played once on mount, not a loop.
 *   By design, this has no "trigger" prop to diff against — the intended
 *   usage is to mount a *fresh* `AnimatedEmoji` exactly at the moment a
 *   state transition happens (e.g. a checklist row's icon switching from
 *   "in progress" to "done"), so "play once when this just became true"
 *   falls straight out of normal React mount semantics instead of needing
 *   extra plumbing here to detect the transition itself.
 *
 * All three animate only `transform` (scale/rotate), never layout-affecting
 * properties, so `useNativeDriver: true` is safe throughout.
 */
export function AnimatedEmoji({ emoji, type, size = 20, style }: AnimatedEmojiProps) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    let animation: Animated.CompositeAnimation;

    if (type === "pulse") {
      animation = Animated.loop(
        Animated.sequence([
          Animated.timing(progress, {
            toValue: 1,
            duration: 700,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
          Animated.timing(progress, {
            toValue: 0,
            duration: 700,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: true,
          }),
        ])
      );
    } else if (type === "rotate") {
      animation = Animated.loop(
        Animated.timing(progress, {
          toValue: 1,
          duration: 1400,
          easing: Easing.linear,
          useNativeDriver: true,
        })
      );
    } else {
      // "bounce": a single spring overshoot-and-settle from a slightly
      // shrunken start, played exactly once — see this component's own doc
      // comment above for why there's no explicit re-trigger mechanism.
      animation = Animated.spring(progress, {
        toValue: 1,
        friction: 3,
        tension: 140,
        useNativeDriver: true,
      });
    }

    animation.start();
    return () => animation.stop();
  }, [type, progress]);

  const animatedStyle: TextStyle =
    type === "pulse"
      ? { transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] }) }] }
      : type === "rotate"
        ? { transform: [{ rotate: progress.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] }) }] }
        : { transform: [{ scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }] };

  return <Animated.Text style={[{ fontSize: size }, animatedStyle, style]}>{emoji}</Animated.Text>;
}
