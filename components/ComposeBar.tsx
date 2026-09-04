import { memo } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, radius, spacing } from "../constants/theme";

export type ComposeBarProps = {
  inputText: string;
  onInputChange: (text: string) => void;
  onInputFocus: () => void;
  onSubmit: (text: string) => void;
  onSettingsPress: () => void;
  /** Distance from the bottom of the screen — computed by the caller from
   * the sheet's own peek height, so this floats visually just below the
   * sheet's drag handle rather than at an unrelated fixed offset. */
  bottom: number;
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
 */
export const ComposeBar = memo(function ComposeBar({
  inputText,
  onInputChange,
  onInputFocus,
  onSubmit,
  onSettingsPress,
  bottom,
}: ComposeBarProps) {
  const canSubmit = inputText.trim().length > 0;
  const handleSubmit = () => {
    if (canSubmit) {
      onSubmit(inputText.trim());
    }
  };

  return (
    <View style={[styles.container, { bottom }]} pointerEvents="box-none">
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
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    paddingHorizontal: spacing.base,
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
