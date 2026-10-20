import { Pressable, StyleSheet, Text } from "react-native";
import { Feather } from "@expo/vector-icons";

import { MIN_TOUCH_TARGET, xayraColors, xayraType } from "../../constants/xayraTheme";

/**
 * The Back control for full screens off Home (Archive, Settings): a chevron
 * and "Back" in the quiet text tone — the same chevron the To-Dos header
 * uses, not a coloured "‹ Back" text link (Redmi uplift Stage 4).
 */
export function BackLink({ onPress }: { onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      accessibilityRole="button"
      accessibilityLabel="Back"
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <Feather name="chevron-left" size={22} color={xayraColors.textSoft} />
      <Text style={styles.label}>Back</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
    minHeight: MIN_TOUCH_TARGET,
    marginLeft: -6,
    marginBottom: 4,
  },
  pressed: {
    opacity: 0.6,
  },
  label: {
    ...xayraType.cue,
    color: xayraColors.textSoft,
  },
});
