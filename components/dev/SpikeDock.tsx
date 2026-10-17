/**
 * STAGE 2 SPIKE ONLY — placeholder bottom dock (Handsfree, To-Dos, More)
 * wired to the existing handlers. Plain styling on purpose: the spike
 * measures layout and behaviour, not the final look.
 */
import { forwardRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

/** Height of the dock's own row, excluding the bottom safe-area inset. */
export const SPIKE_DOCK_ROW_HEIGHT = 64;

export type SpikeDockProps = {
  handsfreeActive: boolean;
  handsfreeState: string;
  pendingCount: number;
  bottomInset: number;
  onHandsfree: () => void;
  onTodos: () => void;
  onMore: () => void;
};

export const SpikeDock = forwardRef<View, SpikeDockProps>(function SpikeDock(
  { handsfreeActive, handsfreeState, pendingCount, bottomInset, onHandsfree, onTodos, onMore },
  moreRef
) {
  return (
    <View testID="spike-dock" style={[styles.dock, { paddingBottom: bottomInset + 6 }]}>
      <Pressable
        testID="spike-dock-handsfree"
        accessibilityRole="button"
        accessibilityState={{ selected: handsfreeActive }}
        onPress={onHandsfree}
        style={[styles.item, handsfreeActive && styles.itemActive]}
      >
        <Text style={[styles.label, handsfreeActive && styles.labelActive]} numberOfLines={2}>
          {handsfreeActive ? `Handsfree · ${handsfreeState}` : "Handsfree"}
        </Text>
      </Pressable>
      <Pressable testID="spike-dock-todos" accessibilityRole="button" onPress={onTodos} style={styles.item}>
        <Text style={styles.label} numberOfLines={2}>
          {pendingCount > 0 ? `To-Dos ${pendingCount}` : "To-Dos"}
        </Text>
      </Pressable>
      <View ref={moreRef} collapsable={false} style={styles.itemWrap}>
        <Pressable
          testID="spike-dock-more"
          accessibilityRole="button"
          accessibilityHint="Opens a menu"
          onPress={onMore}
          style={styles.item}
        >
          <Text style={styles.label}>More</Text>
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  dock: {
    flexDirection: "row",
    gap: 6,
    paddingTop: 6,
    paddingHorizontal: 12,
    backgroundColor: "#16181C",
    borderTopWidth: 1,
    borderTopColor: "rgba(225,228,236,0.16)",
  },
  itemWrap: { flex: 1 },
  item: {
    flex: 1,
    minHeight: SPIKE_DOCK_ROW_HEIGHT - 12,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  itemActive: { backgroundColor: "rgba(143,214,207,0.16)" },
  label: { color: "#D5D7DE", fontSize: 14.5, fontWeight: "500", textAlign: "center" },
  labelActive: { color: "#8FD6CF" },
});
