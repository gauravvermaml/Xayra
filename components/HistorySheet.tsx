import { forwardRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import BottomSheet, { type BottomSheetProps } from "@gorhom/bottom-sheet";
import type { SharedValue } from "react-native-reanimated";

import type { SheetMode } from "./ModeSwitcherPill";
import { colors, radius, spacing } from "../constants/theme";

/** ~70px peek — just enough for the drag handle + search row to read as "a
 * sheet resting at the bottom," matching the Apple Maps reference height. */
export const SHEET_PEEK_HEIGHT = 70;
const SNAP_POINTS = [SHEET_PEEK_HEIGHT, "92%"];

export type HistorySheetProps = {
  mode: SheetMode;
  searchQuery: string;
  onSearchChange: (text: string) => void;
  onSearchFocus: () => void;
  onSettingsPress: () => void;
  onIndexChange?: BottomSheetProps["onChange"];
  animatedIndex: SharedValue<number>;
  children: React.ReactNode;
};

function placeholderFor(mode: SheetMode): string {
  return mode === "notes" ? "Search notes..." : "Search chat...";
}

/**
 * Sticky Apple-Maps-style bottom sheet: true jet-black background/handle so
 * it reads as part of the same canvas as the screen behind it, not a
 * separate card floating on top. The entire "handle" area (drag grip +
 * search bar + settings gear) is a single custom `handleComponent` — it's
 * what keeps the search bar interactive and visible even at the ~70px peek
 * height, rather than being sheet *content* that's clipped away until
 * expanded.
 */
export const HistorySheet = forwardRef<BottomSheet, HistorySheetProps>(function HistorySheet(
  { mode, searchQuery, onSearchChange, onSearchFocus, onSettingsPress, onIndexChange, animatedIndex, children },
  ref
) {
  return (
    <BottomSheet
      ref={ref}
      index={0}
      snapPoints={SNAP_POINTS}
      animatedIndex={animatedIndex}
      onChange={onIndexChange}
      enableDynamicSizing={false}
      // Prevents Android/iOS keyboard-avoiding jank (the sheet and the
      // keyboard fighting over the same screen space) when the search
      // TextInput is focused with the sheet expanded — the #1 stutter
      // source called out for this redesign.
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backgroundStyle={styles.background}
      handleComponent={() => (
        <View style={styles.handleWrap}>
          <View style={styles.dragHandle} />
          <View style={styles.searchRow}>
            <View style={styles.searchBar}>
              <Text style={styles.searchIcon}>⌕</Text>
              <TextInput
                value={searchQuery}
                onChangeText={onSearchChange}
                onFocus={onSearchFocus}
                placeholder={placeholderFor(mode)}
                placeholderTextColor="rgba(235,235,245,0.45)"
                style={styles.searchInput}
                returnKeyType="search"
              />
            </View>
            <Pressable onPress={onSettingsPress} hitSlop={12} style={styles.settingsButton}>
              <Text style={styles.settingsIcon}>⚙️</Text>
            </Pressable>
          </View>
        </View>
      )}
    >
      {children}
    </BottomSheet>
  );
});

const styles = StyleSheet.create({
  background: {
    // True jet black / matches the canvas exactly (see CANVAS & CENTER
    // TACTILE CONTROL) — deliberately NOT the app's usual slate
    // `colors.background`, per this redesign's explicit architecture.
    backgroundColor: "#000000",
  },
  handleWrap: {
    backgroundColor: "#000000",
    paddingHorizontal: spacing.base,
    paddingBottom: spacing.sm,
  },
  dragHandle: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  searchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1C1C1E",
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base,
    height: 40,
  },
  searchIcon: {
    color: "rgba(235,235,245,0.6)",
    fontSize: 16,
    marginRight: spacing.sm,
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 15,
    height: 40,
  },
  settingsButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "#1C1C1E",
    alignItems: "center",
    justifyContent: "center",
  },
  settingsIcon: {
    fontSize: 18,
  },
});
