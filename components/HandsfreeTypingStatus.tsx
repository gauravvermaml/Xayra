import { Pressable, StyleSheet, Text, View } from "react-native";

import { HANDSFREE_STATE_LABEL, type HandsfreeDisplayState } from "./HomeDock";
import { MIN_TOUCH_TARGET, xayraColors, xayraRadius, xayraType } from "../constants/xayraTheme";

const STOP_HEIGHT = 40;

/**
 * While typing, the dock is hidden — this keeps an active Handsfree session
 * visible: its real state (from the existing controller) and a Stop that
 * calls the controller's own stop. Presentational only: no state of its own,
 * no microphone access.
 */
export function HandsfreeTypingStatus({ state, onStop }: { state: HandsfreeDisplayState; onStop: () => void }) {
  return (
    <View testID="handsfree-typing-status" style={styles.row} accessibilityLiveRegion="polite">
      <View style={styles.dot} />
      <Text style={styles.label} numberOfLines={2}>{`Handsfree · ${HANDSFREE_STATE_LABEL[state]}`}</Text>
      <Pressable
        testID="handsfree-typing-stop"
        onPress={onStop}
        hitSlop={(MIN_TOUCH_TARGET - STOP_HEIGHT) / 2}
        accessibilityRole="button"
        accessibilityLabel="Stop Handsfree"
        style={({ pressed }) => [styles.stop, pressed && styles.pressed]}
      >
        <Text style={styles.stopText}>Stop</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "center",
    gap: 10,
    paddingLeft: 14,
    paddingRight: 4,
    paddingVertical: 4,
    marginHorizontal: 16,
    borderRadius: xayraRadius.pill,
    backgroundColor: xayraColors.tealSoft,
    borderWidth: 1,
    borderColor: xayraColors.tealRing,
  },
  dot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: xayraColors.teal,
  },
  label: {
    ...xayraType.chip,
    color: xayraColors.teal,
    flexShrink: 1,
  },
  stop: {
    minHeight: STOP_HEIGHT,
    paddingHorizontal: 16,
    borderRadius: xayraRadius.pill,
    backgroundColor: xayraColors.raised,
    alignItems: "center",
    justifyContent: "center",
  },
  pressed: {
    opacity: 0.7,
  },
  stopText: {
    ...xayraType.chip,
    fontWeight: "600",
    color: xayraColors.text,
  },
});
