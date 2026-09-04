import { memo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, {
  interpolate,
  useAnimatedKeyboard,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";

import { colors, radius, spacing } from "../constants/theme";

/** Keeps this bar reliably painted above the bottom sheet's own (Reanimated-
 * transformed) surface on Android, where sibling paint order alone can be
 * unreliable once transforms are involved — belt-and-suspenders alongside
 * being the later sibling in app/index.tsx's JSX (see PREVENT CONTENT BLEED). */
const COMPOSE_BAR_Z_INDEX = 20;

/** ComposeBar's own row height + the drag-handle stub's hit area above it —
 * subtracted from the sheet's current top edge so the bar's search row (not
 * its top padding) is what actually sits flush with the handle. */
const COMPOSE_BAR_TOP_OFFSET = 76;

export type ComposeBarProps = {
  inputText: string;
  onInputChange: (text: string) => void;
  onInputFocus: () => void;
  onSubmit: (text: string) => void;
  onSettingsPress: () => void;
  /** Floor for the bar's resting distance from the bottom of the screen —
   * the device's safe-area inset plus a small margin, used so the bar never
   * sits closer to the screen edge than that even if a sheet-height
   * computation ever produced something smaller. */
  restBottom: number;
  /** The bottom sheet's own animated snap index (0/1/2, fractional while
   * dragging) — read directly so this bar's position tracks the sheet's
   * actual current height every frame, not just at rest. */
  sheetAnimatedIndex: SharedValue<number>;
  /** Pixel height (distance from the bottom of the screen to the sheet's
   * top edge) at each of the sheet's three snap indices, in index order —
   * see HistorySheet's SHEET_SNAP_POINTS, the single source of truth these
   * are derived from in app/index.tsx. */
  sheetHeightsPx: readonly [number, number, number];
};

/**
 * The app's ONE text-entry surface (see Requirement 3 — "unify input bar").
 * Rendered as a plain sibling of `<HistorySheet>` in app/index.tsx, OUTSIDE
 * the bottom sheet's own `handleComponent` render prop entirely — that's a
 * deliberate fix, not a style choice.
 *
 * `handleComponent` is a render *function* the bottom sheet library calls
 * internally; passing it an inline arrow (as the previous pass did) creates
 * a new function identity on every parent re-render, and every parent
 * re-render includes the one caused by `inputText` changing on each
 * keystroke. React treats "a different function used as a JSX element
 * type" as a different component, so the whole subtree — including this
 * TextInput — was unmounted and remounted on every character typed, which
 * is what silently dropped keyboard focus after one letter. Because
 * `ComposeBar` is instead an ordinary named component referenced as
 * `<ComposeBar />` in a stable parent tree, React keeps the same underlying
 * TextInput instance across every keystroke — its identity is no longer
 * tied to the bottom sheet's internal render cycle at all. Wrapped in
 * `memo` so a value-only prop change elsewhere in app/index.tsx (unrelated
 * state) can't re-render this either.
 *
 * Build 20 — PINNED DRAWER HEADER: this bar's *position* now tracks the
 * sheet's live height (via `sheetAnimatedIndex`/`sheetHeightsPx`), so it
 * stays visually pinned to the top of the sheet — right above the drag
 * handle, i.e. where the segment control/history content start once the
 * sheet expands — at every snap index, not just the 20% resting peek it was
 * hardcoded to before. Its *identity* is completely unaffected by this: it's
 * still an ordinary sibling of <HistorySheet>, never part of that
 * component's own render tree, so none of the above keyboard-focus
 * reasoning changes.
 */
export const ComposeBar = memo(function ComposeBar({
  inputText,
  onInputChange,
  onInputFocus,
  onSubmit,
  onSettingsPress,
  restBottom,
  sheetAnimatedIndex,
  sheetHeightsPx,
}: ComposeBarProps) {
  const canSubmit = inputText.trim().length > 0;
  const handleSubmit = () => {
    if (canSubmit) {
      onSubmit(inputText.trim());
    }
  };

  // Keeps this bar pinned directly above the soft keyboard: as the keyboard
  // rises, `keyboard.height` tracks its live height (0 when closed), and
  // this row rides up by exactly that much on top of whatever its current
  // sheet-tracking position is.
  const keyboard = useAnimatedKeyboard();
  const keyboardFollowStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -keyboard.height.value }],
  }));

  // Tracks the sheet's own current height every frame (including mid-drag,
  // since sheetAnimatedIndex is a live shared value, not just the settled
  // index) so the bar's top edge always sits just above the sheet's actual
  // top edge — clamped to never go below `restBottom` even if the
  // interpolation would otherwise put it closer to the screen edge.
  const sheetTrackingStyle = useAnimatedStyle(() => {
    const sheetTopPx = interpolate(sheetAnimatedIndex.value, [0, 1, 2], sheetHeightsPx, "clamp");
    return {
      bottom: Math.max(restBottom, sheetTopPx - COMPOSE_BAR_TOP_OFFSET),
    };
  });

  return (
    <Animated.View
      style={[styles.container, sheetTrackingStyle, keyboardFollowStyle]}
      pointerEvents="box-none"
    >
      <View style={styles.row}>
        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            value={inputText}
            onChangeText={onInputChange}
            onFocus={onInputFocus}
            placeholder="Search or type your thoughts..."
            placeholderTextColor="rgba(235,235,245,0.45)"
            style={styles.input}
            returnKeyType="send"
            blurOnSubmit={false}
            onSubmitEditing={handleSubmit}
          />
          {/* The keyboard is dismissed ONLY here, on an explicit tap — never
              as a side effect of typing (see the component doc above). */}
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
    </Animated.View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    paddingHorizontal: spacing.base,
    zIndex: COMPOSE_BAR_Z_INDEX,
    elevation: COMPOSE_BAR_Z_INDEX,
  },
  row: {
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
  input: {
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
