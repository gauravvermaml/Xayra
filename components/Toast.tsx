import { useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text } from "react-native";

import { colors, radius, spacing, typography } from "../constants/theme";

/**
 * Deliberately a plain module-level listener rather than React context: the
 * screens that need to show a toast (chat bubbles, note cards, the note
 * detail modal) don't share a common ancestor closer than the root layout,
 * and threading a context provider/consumer through all of them just to
 * call one function is more machinery than a single global "show this
 * message" event needs. `<ToastHost />` is mounted once in app/_layout.tsx;
 * `showToast()` is safe to call before it mounts or after it unmounts —
 * the call is just a no-op in that case, never a crash.
 */
type ToastListener = (message: string) => void;
let currentListener: ToastListener | null = null;

export function showToast(message: string): void {
  currentListener?.(message);
}

const TOAST_VISIBLE_MS = 1400;
const FADE_IN_MS = 150;
const FADE_OUT_MS = 200;

/** Renders the actual toast banner — mount exactly one of these near the
 * root of the app (see app/_layout.tsx) so every screen's `showToast()`
 * calls land on the same overlay. */
export function ToastHost() {
  const [message, setMessage] = useState<string | null>(null);
  const opacity = useRef(new Animated.Value(0)).current;
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    currentListener = (nextMessage) => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
      setMessage(nextMessage);
      opacity.setValue(0);
      Animated.timing(opacity, {
        toValue: 1,
        duration: FADE_IN_MS,
        useNativeDriver: true,
      }).start();
      hideTimer.current = setTimeout(() => {
        Animated.timing(opacity, {
          toValue: 0,
          duration: FADE_OUT_MS,
          useNativeDriver: true,
        }).start(() => setMessage(null));
      }, TOAST_VISIBLE_MS);
    };
    return () => {
      currentListener = null;
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
      }
    };
  }, [opacity]);

  if (!message) {
    return null;
  }

  return (
    <Animated.View pointerEvents="none" style={[styles.toast, { opacity }]}>
      <Text style={styles.toastText}>{message}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  toast: {
    position: "absolute",
    bottom: 96,
    alignSelf: "center",
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.borderStrong,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm + 2,
    zIndex: 999,
    elevation: 8,
  },
  toastText: {
    color: colors.textPrimary,
    ...typography.caption,
    fontWeight: "600",
  },
});
