import { Pressable, StyleSheet, type PressableProps } from "react-native";

import { MIN_TOUCH_TARGET, xayraColors, xayraRadius } from "../../constants/xayraTheme";
import { XText } from "./XText";

export type ChipProps = Omit<PressableProps, "children" | "style"> & {
  label: string;
};

const CHIP_HEIGHT = 40;

/** Source-note links ("[Note 1]") and starter prompts: lilac-tinted, 40dp
 * visible, 48dp touch area. */
export function Chip({ label, accessibilityLabel, ...rest }: ChipProps) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={(MIN_TOUCH_TARGET - CHIP_HEIGHT) / 2}
      style={({ pressed }) => [styles.chip, pressed && styles.pressed]}
      {...rest}
    >
      <XText variant="chip">{label}</XText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    minHeight: CHIP_HEIGHT,
    paddingHorizontal: 12,
    borderRadius: xayraRadius.pill,
    backgroundColor: xayraColors.lilacSoft,
    alignItems: "center",
    justifyContent: "center",
    alignSelf: "flex-start",
  },
  pressed: {
    opacity: 0.7,
  },
});
