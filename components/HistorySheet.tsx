import { forwardRef } from "react";
import { Dimensions, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import BottomSheet, { type BottomSheetProps } from "@gorhom/bottom-sheet";
import type { SharedValue } from "react-native-reanimated";

import type { SheetMode } from "./ModeSwitcherPill";
import { colors, radius, spacing } from "../constants/theme";

const { height: SCREEN_HEIGHT } = Dimensions.get("window");

/** ~20% of screen height, clamped to a 160–180dp band — enough resting room
 * for the drag handle, the compose/search row, and the settings gear to sit
 * comfortably without feeling cramped, per this pass's explicit peek-height
 * requirement (a plain fixed 70px, from the previous pass, clipped the row
 * against Android's gesture nav bar on shorter screens). `bottomInset`
 * (the device's safe-area bottom inset) is added on top so the sheet's
 * resting content never sits under the system nav bar/gesture strip. */
export function getSheetPeekHeight(bottomInset: number): number {
  const base = Math.round(Math.min(180, Math.max(160, SCREEN_HEIGHT * 0.2)));
  return base + bottomInset;
}

function snapPointsFor(bottomInset: number): (string | number)[] {
  return [getSheetPeekHeight(bottomInset), "92%"];
}

function placeholderFor(mode: SheetMode): string {
  return mode === "notes" ? "Type your thoughts..." : "Search your thoughts...";
}

export type HistorySheetProps = {
  mode: SheetMode;
  inputText: string;
  onInputChange: (text: string) => void;
  onInputFocus: () => void;
  /** Fired on the up-arrow tap (or the input's own submit key) with the
   * current, non-empty, trimmed `inputText` — Notes mode saves it as a new
   * note, Chat mode asks it as a question. Clearing the field afterward is
   * the caller's job (app/index.tsx), since only it knows whether the
   * submission actually succeeded. */
  onSubmit: (text: string) => void;
  onSettingsPress: () => void;
  onIndexChange?: BottomSheetProps["onChange"];
  animatedIndex: SharedValue<number>;
  /** Device's safe-area bottom inset (`useSafeAreaInsets().bottom`) — see
   * getSheetPeekHeight above. */
  bottomInset: number;
  children: React.ReactNode;
};

/**
 * Sticky Apple-Maps-style bottom sheet: true jet-black background/handle so
 * it reads as part of the same canvas as the screen behind it, not a
 * separate card floating on top. The entire "handle" area (drag grip +
 * compose bar + settings gear) is a single custom `handleComponent` — it's
 * what keeps that row interactive and visible even at the resting peek
 * height, rather than being sheet *content* that's clipped away until
 * expanded. This row is now the ONLY text-entry surface in the app — the
 * separate chat composer bar that used to live at the bottom of Chat mode's
 * content has been removed entirely (see ChatSheetContent) so there is
 * exactly one place to type, in either mode.
 */
export const HistorySheet = forwardRef<BottomSheet, HistorySheetProps>(function HistorySheet(
  {
    mode,
    inputText,
    onInputChange,
    onInputFocus,
    onSubmit,
    onSettingsPress,
    onIndexChange,
    animatedIndex,
    bottomInset,
    children,
  },
  ref
) {
  const canSubmit = inputText.trim().length > 0;
  const handleSubmit = () => {
    if (canSubmit) {
      onSubmit(inputText.trim());
    }
  };

  return (
    <BottomSheet
      ref={ref}
      index={0}
      snapPoints={snapPointsFor(bottomInset)}
      animatedIndex={animatedIndex}
      onChange={onIndexChange}
      enableDynamicSizing={false}
      // Prevents Android/iOS keyboard-avoiding jank (the sheet and the
      // keyboard fighting over the same screen space) when the compose
      // TextInput is focused with the sheet expanded.
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backgroundStyle={styles.background}
      handleComponent={() => (
        <View style={[styles.handleWrap, { paddingBottom: spacing.sm + bottomInset }]}>
          <View style={styles.dragHandle} />
          <View style={styles.searchRow}>
            <View style={styles.searchBar}>
              <Text style={styles.searchIcon}>⌕</Text>
              <TextInput
                value={inputText}
                onChangeText={onInputChange}
                onFocus={onInputFocus}
                placeholder={placeholderFor(mode)}
                placeholderTextColor="rgba(235,235,245,0.45)"
                style={styles.searchInput}
                returnKeyType="send"
                onSubmitEditing={handleSubmit}
              />
              <Pressable
                onPress={handleSubmit}
                disabled={!canSubmit}
                hitSlop={8}
                style={[styles.submitButton, !canSubmit && styles.submitButtonDisabled]}
              >
                <Text style={styles.submitIcon}>↑</Text>
              </Pressable>
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
    // True jet black / matches the canvas exactly — deliberately NOT the
    // app's usual slate `colors.background`.
    backgroundColor: "#000000",
  },
  handleWrap: {
    backgroundColor: "#000000",
    paddingHorizontal: spacing.base,
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
    paddingLeft: spacing.base,
    paddingRight: spacing.xs,
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
  submitButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
  },
  submitButtonDisabled: {
    backgroundColor: "rgba(99,102,241,0.35)",
  },
  submitIcon: {
    color: colors.onAccent,
    fontSize: 16,
    fontWeight: "700",
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
