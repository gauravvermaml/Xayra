import type { ReactNode } from "react";
import { Pressable, StyleSheet, type PressableProps } from "react-native";

import { MIN_TOUCH_TARGET, xayraColors, xayraRadius } from "../../constants/xayraTheme";

export type IconButtonTone = "plain" | "send" | "sendReady";

export type IconButtonProps = Omit<PressableProps, "children" | "style" | "accessibilityLabel"> & {
  /** Required: an icon-only button needs a spoken name. */
  accessibilityLabel: string;
  icon: ReactNode;
  /** Visible diameter; the touch area is always at least 48dp. */
  size?: number;
  /** `send`: quiet teal circle (empty field). `sendReady`: solid teal. */
  tone?: IconButtonTone;
};

export function IconButton({ accessibilityLabel, icon, size = 44, tone = "plain", ...rest }: IconButtonProps) {
  const slop = Math.max(0, (MIN_TOUCH_TARGET - size) / 2);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      hitSlop={slop}
      style={({ pressed }) => [
        styles.base,
        { width: size, height: size },
        tone === "send" && styles.send,
        tone === "sendReady" && styles.sendReady,
        pressed && styles.pressed,
      ]}
      {...rest}
    >
      {icon}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: xayraRadius.pill,
    alignItems: "center",
    justifyContent: "center",
  },
  send: {
    backgroundColor: xayraColors.tealSoft,
  },
  sendReady: {
    backgroundColor: xayraColors.teal,
  },
  pressed: {
    opacity: 0.7,
  },
});
