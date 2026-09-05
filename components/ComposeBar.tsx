import { memo, useEffect, useRef } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";

import { colors, radius, spacing } from "../constants/theme";

export type ComposeBarProps = {
  inputText: string;
  onInputChange: (text: string) => void;
  onInputFocus: () => void;
  onSubmit: (text: string) => void;
  /** Build 22 DYNAMIC SEARCH PLACEHOLDER: driven by app/index.tsx's explicit
   * Record/Ask pill state — "Type your thoughts..." while Record is active,
   * "Search your thoughts..." while Ask is active. This component has no
   * opinion of its own on which mode is active; it just renders whatever
   * string it's given. */
  placeholder: string;
  /** Build 23: the settings cogwheel is back in this row (it left briefly in
   * Build 22 for the floating control stack) — see this component's own doc
   * comment for why it moved back. */
  onSettingsPress: () => void;
};

/**
 * The app's ONE text-entry surface (see Requirement 3 — "unify input bar").
 *
 * Build 21 — UNIFY DRAWER HEADER: this now lives INSIDE `<BottomSheet>`,
 * rendered by HistorySheet as a sticky header row above the segment
 * pill/history content (see that file), not as a floating sibling
 * positioned with manual bottom/transform math against the sheet's height —
 * that Build 20 approach and Build 19's `useAnimatedKeyboard()` follow logic
 * before it are both gone. The bug that motivated them (see below) is fixed
 * at its actual root now instead of being chased with more positioning math.
 *
 * Root cause of the Build 20 "search bar shoots to the top of the screen on
 * focus" bug: THREE separate mechanisms were all compensating for the same
 * keyboard at once — Android's `windowSoftInputMode="resize"` (already
 * shrinks the whole window), `@gorhom/bottom-sheet`'s own
 * `keyboardBehavior="interactive"` (already translates the sheet), and this
 * component's own `useAnimatedKeyboard()`-driven `translateY` on top of
 * both. Stacking three keyboard offsets on one element is what sent it flying
 * off-screen. The fix is to let ONE thing own keyboard avoidance: the sheet
 * itself. Because this component is now a normal child inside `<BottomSheet>`
 * — not positioned independently at all — it moves as part of the sheet's
 * own single, unified upward translation, with no separate compensation of
 * its own left to conflict with it.
 *
 * That does mean solving the ORIGINAL keyboard-focus-drop bug (Build
 * 18 — typing more than one character silently blurred the input) a
 * different way than "keep this component fully outside the sheet," since
 * that's no longer true. The original diagnosis was specific to
 * `handleComponent`: it's a render *function* the bottom-sheet library
 * invokes directly, and passing it a reference that changes identity across
 * renders (an inline arrow recreated by a parent re-render, e.g. on every
 * keystroke) makes the library treat it as a different component and
 * remount the whole subtree underneath it. This component is deliberately
 * NOT passed through `handleComponent` — HistorySheet renders it as an
 * ordinary `ReactNode` prop (`composeBarSlot`), the exact same mechanism
 * `notesContent`/`qaContent` already use safely in that file. A JSX element
 * passed as a normal prop/child is diffed by React's ordinary
 * reconciliation (same element type in the same tree position keeps its
 * instance, full stop) — it never goes through whatever special handling
 * `handleComponent` gets internally, so recreating the `<ComposeBar />`
 * element on every keystroke (which app/index.tsx still does, same as it
 * always has) is exactly as safe here as `notesContent` already was.
 *
 * The other half of the real fix: `TextInput` from "react-native" is
 * swapped for `@gorhom/bottom-sheet`'s own `BottomSheetTextInput`, a
 * near-drop-in wrapper that reports focus/blur into the sheet's internal
 * keyboard-tracking state. Without it, the sheet has no reliable way to know
 * an input *inside* it is focused, which undermines `keyboardBehavior`
 * needing to compensate at all correctly. Wrapped in `memo` so a value-only
 * prop change elsewhere in app/index.tsx (unrelated state) can't re-render
 * this either.
 *
 * Build 22 moved the settings gear out of this row into a floating
 * Handsfree/Record-Ask/Settings stack in app/index.tsx; Build 23 moved it
 * back here, restoring `[ 🔍 Search or type... | ↑ ] [ ⚙️ ]` as the row's
 * layout — the floating stack above the drawer is now Handsfree + the
 * Record/Ask mode pill only.
 */
export const ComposeBar = memo(function ComposeBar({
  inputText,
  onInputChange,
  onInputFocus,
  onSubmit,
  placeholder,
  onSettingsPress,
}: ComposeBarProps) {
  const canSubmit = inputText.trim().length > 0;

  // Build 22 FIX DUPLICATE SUBMISSIONS: guards the window between a submit
  // firing and the parent's cleared `inputText` prop actually landing back
  // here. Without it, a fast double-tap on the submit button (or a quirky
  // double-fire of the keyboard's "send" action) could call `onSubmit` twice
  // with the exact same text before React ever re-renders this component
  // with the parent's `inputText=""` update, re-processing an identical
  // query/note. Re-armed the moment the prop confirms the clear — not a
  // content-based "block this exact string" guard, which would wrongly stop
  // a legitimately repeated question asked again later.
  const hasPendingSubmitRef = useRef(false);
  useEffect(() => {
    if (inputText === "") {
      hasPendingSubmitRef.current = false;
    }
  }, [inputText]);

  const handleSubmit = () => {
    if (hasPendingSubmitRef.current || !canSubmit) {
      return;
    }
    hasPendingSubmitRef.current = true;
    onSubmit(inputText.trim());
  };

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>⌕</Text>
          <BottomSheetTextInput
            value={inputText}
            onChangeText={onInputChange}
            onFocus={onInputFocus}
            placeholder={placeholder}
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
  // No more position:absolute/zIndex/elevation — this is now an ordinary
  // flex child inside HistorySheet's sticky header, in normal document flow
  // above the segment pills/history content, so there's nothing left for it
  // to visually collide with (see HISTORYSHEET's own PREVENT OVERLAP note).
  container: {
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
