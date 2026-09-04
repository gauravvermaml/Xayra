import { forwardRef, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, { type BottomSheetProps } from "@gorhom/bottom-sheet";
import type { SharedValue } from "react-native-reanimated";

import { colors, radius, spacing } from "../constants/theme";

/** Three explicit stages rather than the previous two: resting peek (just
 * the compose bar), a "halfway" stage the app snaps to programmatically
 * while an AI request is in flight (enough room to see the answer start
 * streaming in without fully covering the canvas), and a full expansion for
 * browsing history. */
export const SHEET_SNAP_POINTS = ["20%", "50%", "90%"];

export type HistoryTab = "notes" | "qa";

/**
 * A trivial, permanently-stable component — no props that change on every
 * keystroke or every render ever reach it — passed directly as
 * `handleComponent`. This is intentionally the ONLY thing living in the
 * bottom sheet's `handleComponent` slot; the actual compose bar lives
 * outside the sheet entirely now (see components/ComposeBar.tsx) precisely
 * because `handleComponent` re-creates its subtree whenever its function
 * reference changes, which typing into a TextInput living there would do on
 * every character.
 */
const SheetDragHandle = forwardRef<View, { onPress: () => void }>(function SheetDragHandle({ onPress }, ref) {
  return (
    <View ref={ref} style={styles.handleWrap}>
      <Pressable onPress={onPress} hitSlop={12} style={styles.dragHandleHitArea}>
        <View style={styles.dragHandle} />
      </Pressable>
    </View>
  );
});

export type HistorySheetProps = {
  historyTab: HistoryTab;
  onHistoryTabChange: (tab: HistoryTab) => void;
  notesContent: React.ReactNode;
  qaContent: React.ReactNode;
  onIndexChange?: BottomSheetProps["onChange"];
  animatedIndex: SharedValue<number>;
};

/**
 * Sticky Apple-Maps-style bottom sheet: true jet-black background so it
 * reads as part of the same canvas as the screen behind it. Three snap
 * points (see SHEET_SNAP_POINTS) rather than two — the middle stage is what
 * `app/index.tsx` snaps to automatically while an ASK-classified request is
 * processing. At full expansion, a Notes/QA History segment control filters
 * which scrollable list is shown; both segments' underlying state
 * (`allNotes` in app/index.tsx, and the chat session from
 * services/ai/useChatSession.ts) lives above this component either way, so
 * switching segments never loses anything, only which is visible.
 */
export const HistorySheet = forwardRef<BottomSheet, HistorySheetProps>(function HistorySheet(
  { historyTab, onHistoryTabChange, notesContent, qaContent, onIndexChange, animatedIndex },
  ref
) {
  // Stable across every render regardless of any other state in the app —
  // `ref` (a React ref object) never changes identity, so this closure
  // never needs to be recreated, and `handleComponent` below stays the same
  // function reference forever.
  const handleTapDragHandle = useCallback(() => {
    if (!ref || typeof ref === "function") {
      return;
    }
    ref.current?.snapToIndex(1);
  }, [ref]);

  const renderHandle = useCallback(() => <SheetDragHandle onPress={handleTapDragHandle} />, [handleTapDragHandle]);

  return (
    <BottomSheet
      ref={ref}
      index={0}
      snapPoints={SHEET_SNAP_POINTS}
      animatedIndex={animatedIndex}
      onChange={onIndexChange}
      enableDynamicSizing={false}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      backgroundStyle={styles.background}
      handleComponent={renderHandle}
    >
      <View style={styles.segmentRow}>
        {(["notes", "qa"] as const).map((tab) => (
          <Pressable
            key={tab}
            onPress={() => onHistoryTabChange(tab)}
            style={[styles.segmentOption, historyTab === tab && styles.segmentOptionActive]}
          >
            <Text style={[styles.segmentText, historyTab === tab && styles.segmentTextActive]}>
              {tab === "notes" ? "Notes" : "QA History"}
            </Text>
          </Pressable>
        ))}
      </View>
      {historyTab === "notes" ? notesContent : qaContent}
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
    alignItems: "center",
  },
  dragHandleHitArea: {
    paddingTop: spacing.sm,
    paddingBottom: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  dragHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
  segmentRow: {
    flexDirection: "row",
    backgroundColor: "#1C1C1E",
    borderRadius: radius.pill,
    padding: 3,
    marginHorizontal: spacing.base,
    marginBottom: spacing.sm,
  },
  segmentOption: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 7,
    borderRadius: radius.pill,
  },
  segmentOptionActive: {
    backgroundColor: colors.accent,
  },
  segmentText: {
    color: "rgba(235,235,245,0.6)",
    fontSize: 13,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: colors.onAccent,
  },
});
