import { forwardRef } from "react";
import { type LayoutChangeEvent, PixelRatio, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { Feather } from "@expo/vector-icons";

import { xayraColors, xayraRadius, xayraType } from "../constants/xayraTheme";
import type { ActiveModeState } from "../services/audio/activeMode";

/** Spoken/visible Handsfree states. `idle` never shows while active. */
/** What the dock and typing strip show: the controller's state, plus
 * "starting" while a start is opening the microphone. */
export type HandsfreeDisplayState = ActiveModeState | "starting";

export const HANDSFREE_STATE_LABEL: Record<HandsfreeDisplayState, string> = {
  starting: "starting",
  idle: "on",
  listening: "listening",
  processing: "processing",
  speaking: "speaking",
};

/** The active Handsfree item widens so "Handsfree · listening" fits on one
 * line beside its dot on a ~390dp phone (canvas: 1.7 on a 390 artboard;
 * real DM Sans metrics need a little more). */
const ACTIVE_HANDSFREE_FLEX = 2.2;
const ACTIVE_HANDSFREE_FLEX_STACKED = 1.5;

export type HomeDockProps = {
  handsfreeActive: boolean;
  handsfreeState: HandsfreeDisplayState;
  pendingCount: number;
  /** Bottom safe-area inset — the dock is the one place it's added. */
  bottomInset: number;
  onHandsfree: () => void;
  onTodos: () => void;
  onMore: () => void;
  /** Rendered height (inset included) — feeds the tray's rest height. */
  onHeightChange: (height: number) => void;
};

/**
 * The Balanced Dock (canvas rows P/Q): Handsfree, To-Dos and More in one
 * quiet panel at the bottom of the tray, no dividers. Presentational only —
 * every action is the home screen's existing handler, and Handsfree's state
 * comes from the existing controller (useActiveMode).
 *
 * Three layouts, picked from the screen width and text size (never by
 * shrinking the text):
 *  - inline: label beside its icon (typical phone, normal text);
 *  - stacked: label under its icon, count badge on the icon (narrow
 *    screens or larger text);
 *  - rows: Handsfree on its own full-width row, To-Dos and More side by side
 *    (very large text), so every label fits whole words on a line.
 * Labels may still wrap rather than clip; the dock's measured height, not an
 * assumed one, sizes the tray.
 */
export type DockLayout = "inline" | "stacked" | "rows";

export function dockLayout(width: number, fontScale: number): DockLayout {
  // Android reports e.g. 1.3 as 1.2999…; compare with a small tolerance.
  const fs = fontScale + 0.01;
  if (fs >= 1.5 || (width < 380 && fs >= 1.3)) return "rows";
  if (width < 380 || fs > 1.11) return "stacked";
  return "inline";
}
export const HomeDock = forwardRef<View, HomeDockProps>(function HomeDock(
  { handsfreeActive, handsfreeState, pendingCount, bottomInset, onHandsfree, onTodos, onMore, onHeightChange },
  moreRef
) {
  const { width } = useWindowDimensions();
  const layout = dockLayout(width, PixelRatio.getFontScale());
  const stacked = layout === "stacked";
  const handsfreeLabel = handsfreeActive ? `Handsfree · ${HANDSFREE_STATE_LABEL[handsfreeState]}` : "Handsfree";
  const itemStyle = [styles.item, stacked ? styles.itemStacked : styles.itemInline];
  // Rows: Handsfree spans the first row. Otherwise the active item widens
  // (less in the stacked layout, where its label may take two lines).
  const handsfreeSize =
    layout === "rows"
      ? styles.fullRow
      : { flex: handsfreeActive ? (stacked ? ACTIVE_HANDSFREE_FLEX_STACKED : ACTIVE_HANDSFREE_FLEX) : 1 };
  const badge =
    pendingCount > 0 ? (
      <View style={[styles.badge, stacked && styles.badgeOnIcon]}>
        <Text style={styles.badgeText}>{pendingCount > 99 ? "99+" : pendingCount}</Text>
      </View>
    ) : null;

  return (
    <View
      testID="home-dock"
      onLayout={(e: LayoutChangeEvent) => onHeightChange(Math.round(e.nativeEvent.layout.height))}
      style={[styles.wrap, { paddingBottom: bottomInset + 8 }]}
    >
      <View style={[styles.panel, layout === "rows" && styles.panelRows]}>
        <Pressable
          testID="dock-handsfree"
          onPress={onHandsfree}
          accessibilityRole="switch"
          accessibilityLabel={handsfreeActive ? `Handsfree, ${HANDSFREE_STATE_LABEL[handsfreeState]}` : "Handsfree"}
          accessibilityHint={handsfreeActive ? "Turns Handsfree off" : "Turns Handsfree on"}
          accessibilityState={{ checked: handsfreeActive }}
          // Listening → processing → speaking is announced as it changes.
          accessibilityLiveRegion={handsfreeActive ? "polite" : "none"}
          style={({ pressed }) => [
            itemStyle,
            handsfreeSize,
            handsfreeActive && styles.itemActive,
            pressed && styles.pressed,
          ]}
        >
          {handsfreeActive ? (
            <View style={styles.activeDot} />
          ) : (
            <Feather name="headphones" size={19} color={xayraColors.dockText} />
          )}
          <Text style={[styles.label, handsfreeActive && styles.labelActive]} numberOfLines={2}>
            {handsfreeLabel}
          </Text>
        </Pressable>

        <Pressable
          testID="dock-todos"
          onPress={onTodos}
          accessibilityRole="button"
          accessibilityLabel={pendingCount > 0 ? `To-Dos, ${pendingCount} pending` : "To-Dos"}
          style={({ pressed }) => [itemStyle, styles.flex1, pressed && styles.pressed]}
        >
          {stacked ? (
            // Badge on the icon, so the label keeps the item's full width.
            <View>
              <Feather name="check-circle" size={19} color={xayraColors.dockText} />
              {badge}
            </View>
          ) : (
            <Feather name="check-circle" size={19} color={xayraColors.dockText} />
          )}
          <View style={styles.labelRow}>
            <Text style={styles.label} numberOfLines={2}>
              To-Dos
            </Text>
            {!stacked && badge}
          </View>
        </Pressable>

        <View ref={moreRef} collapsable={false} style={styles.flex1}>
          <Pressable
            testID="dock-more"
            onPress={onMore}
            accessibilityRole="button"
            accessibilityLabel="More"
            accessibilityHint="Opens Archived notes and Settings"
            style={({ pressed }) => [itemStyle, styles.flex1, pressed && styles.pressed]}
          >
            <Feather name="more-horizontal" size={19} color={xayraColors.dockText} />
            <Text style={styles.label} numberOfLines={2}>
              More
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: {
    paddingTop: 6,
    paddingHorizontal: 14,
    backgroundColor: xayraColors.surface,
  },
  panel: {
    flexDirection: "row",
    gap: 4,
    padding: 4,
    borderRadius: xayraRadius.dock,
    backgroundColor: xayraColors.dock,
    borderWidth: 1,
    borderColor: "rgba(225,228,236,0.13)",
  },
  panelRows: {
    flexWrap: "wrap",
  },
  fullRow: {
    flexBasis: "100%",
  },
  flex1: {
    flex: 1,
  },
  item: {
    minWidth: 0,
    minHeight: 52,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  itemInline: {
    flexDirection: "row",
    gap: 7,
  },
  itemStacked: {
    flexDirection: "column",
    gap: 3,
  },
  itemActive: {
    backgroundColor: "rgba(143,214,207,0.16)",
    borderWidth: 1,
    borderColor: xayraColors.tealRing,
  },
  pressed: {
    opacity: 0.7,
  },
  activeDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: xayraColors.teal,
  },
  labelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  label: {
    ...xayraType.dock,
    color: xayraColors.dockText,
    textAlign: "center",
    flexShrink: 1,
  },
  labelActive: {
    color: xayraColors.teal,
  },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: 11,
    backgroundColor: xayraColors.badge,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeOnIcon: {
    position: "absolute",
    top: -8,
    left: 12,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    borderRadius: 9,
  },
  badgeText: {
    ...xayraType.badge,
    color: xayraColors.badgeText,
  },
});
