import type { ReactNode } from "react";
import { Pressable, StyleSheet, View, type PressableProps } from "react-native";

import { MIN_TOUCH_TARGET, xayraColors, xayraRadius } from "../../constants/xayraTheme";
import { XText } from "./XText";

export type PillTone = "secondary" | "active";

export type PillProps = Omit<PressableProps, "children" | "style"> & {
  label: string;
  icon?: ReactNode;
  /** `secondary`: outlined (Listen). `active`: teal tint and ring (Handsfree on). */
  tone?: PillTone;
};

/** A 40dp pill button whose touch area reaches 48dp. */
export function Pill({ label, icon, tone = "secondary", accessibilityLabel, ...rest }: PillProps) {
  const active = tone === "active";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={(MIN_TOUCH_TARGET - PILL_HEIGHT) / 2}
      style={({ pressed }) => [styles.base, active ? styles.active : styles.secondary, pressed && styles.pressed]}
      {...rest}
    >
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <XText variant="chip" color={active ? "teal" : "text"}>
        {label}
      </XText>
    </Pressable>
  );
}

export const PILL_HEIGHT = 40;

const styles = StyleSheet.create({
  base: {
    minHeight: PILL_HEIGHT,
    paddingHorizontal: 14,
    borderRadius: xayraRadius.pill,
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    gap: 7,
  },
  secondary: {
    borderWidth: 1,
    borderColor: xayraColors.outline,
  },
  active: {
    backgroundColor: xayraColors.tealSoft,
    borderWidth: 1,
    borderColor: xayraColors.tealRing,
  },
  pressed: {
    opacity: 0.7,
  },
  icon: {
    alignItems: "center",
    justifyContent: "center",
  },
});
