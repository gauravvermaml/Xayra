import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

/**
 * The system "remove animations" setting, kept current — for React Native
 * `Animated` loops (Reanimated components use its own `useReducedMotion`).
 * Starts false until the first read resolves.
 */
export function useReduceMotion(): boolean {
  const [reduceMotion, setReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((enabled) => {
        if (mounted) setReduceMotion(enabled);
      })
      .catch(() => {});
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduceMotion);
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return reduceMotion;
}
