import { forwardRef, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, { type BottomSheetProps } from "@gorhom/bottom-sheet";
import type { SharedValue } from "react-native-reanimated";

import { colors, radius, spacing } from "../constants/theme";

/**
 * Build 24 STRICTLY CAP BOTTOM SHEET AT 50% MAX HEIGHT: the old third stage
 * ("90%", full expansion for browsing history) is gone — not just unused,
 * removed from this array entirely. `@gorhom/bottom-sheet` lets a user's own
 * drag/swipe gesture pull the sheet open to any configured snap point
 * regardless of what index the app last set programmatically — the app only
 * ever called `snapToIndex(0)`/`snapToIndex(1)` itself, but a manual drag
 * could still reach the 90% point that was sitting in this array, and once
 * there, the sticky header (ComposeBar) and the floating pill cluster above
 * the drawer (app/index.tsx) both ended up crowded into or past the status
 * bar — confirmed from an on-device screenshot, not assumed. Removing the
 * snap point outright is what makes 50% a real ceiling: there is physically
 * nothing left to drag to above it, for a gesture or for any future
 * programmatic snap.
 *
 * Two stages now: resting peek (just the compose bar) and a single
 * expanded stage — both the "AI request in flight" auto-peek and full
 * history browsing share this one 50% stage rather than having their own
 * separate heights.
 */
export const SHEET_SNAP_POINTS = ["20%", "50%"];

export type HistoryTab = "notes" | "qa";

/**
 * A trivial, permanently-stable component — no props that change on every
 * keystroke or every render ever reach it — passed directly as
 * `handleComponent`. This is intentionally the ONLY thing living in the
 * bottom sheet's `handleComponent` slot. As of Build 21, ComposeBar DOES
 * live inside the sheet (see `composeBarSlot` below) — but it's rendered as
 * an ordinary child/prop, never through `handleComponent`, precisely
 * because that render-prop slot re-creates its subtree whenever its
 * function reference changes, which typing into a TextInput living there
 * would do on every character (see ComposeBar.tsx's own doc comment).
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
  /** Build 21 — STICKY DRAWER HEADER: a pre-built `<ComposeBar />` element,
   * rendered here as an ordinary child inside `<BottomSheet>`, directly below
   * the drag handle and above the segment pills/history content. Passed as a
   * `ReactNode` rather than constructed in this file for the same reason
   * `notesContent`/`qaContent` already are — app/index.tsx owns all of its
   * state and callbacks, this file only decides where it's positioned. See
   * ComposeBar.tsx's own doc comment for why rendering it this way (a plain
   * prop/child, never `handleComponent`) doesn't reintroduce the Build 18
   * keyboard-focus-drop bug. */
  composeBarSlot: React.ReactNode;
  notesContent: React.ReactNode;
  qaContent: React.ReactNode;
  onIndexChange?: BottomSheetProps["onChange"];
  animatedIndex: SharedValue<number>;
  /** Current snap index, tracked in JS state (app/index.tsx) alongside
   * `animatedIndex` — needed here to actually NOT RENDER the segment pill
   * and history content at index 0 (IDLE PEEK ISOLATION), rather than just
   * relying on the sheet's own height clipping them out of view. A value
   * that's merely invisible-by-clipping can still be measured, still steal
   * a stray touch, and still show up in the accessibility tree — actually
   * not mounting it at index 0 avoids all three. `composeBarSlot` is exempt
   * from this — it's the one thing that IS visible at index 0 (see below). */
  sheetIndex: number;
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
  { historyTab, onHistoryTabChange, composeBarSlot, notesContent, qaContent, onIndexChange, animatedIndex, sheetIndex },
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
      // Build 22.2 — the actual fix for "search bar shoots to the top status
      // bar on focus" (confirmed on-device, contradicting Build 22's
      // assumption that this was already working). Root cause, found in
      // @gorhom/bottom-sheet's own source
      // (src/components/bottomSheet/BottomSheet.tsx): keyboardBehavior=
      // "interactive" computes its OWN target position while the keyboard is
      // shown — `highestDetentPosition - keyboardHeightInContainer`, clamped
      // to a floor of 0 — and that computed position wins over whatever
      // index our own onFocus handler explicitly snapped to. The library
      // skips that override ONLY on Android when this prop is explicitly
      // "adjustResize" — which we never set, even though app.json's
      // android.softwareKeyboardLayoutMode is already "resize" at the OS
      // window level. Those are two different settings the library checks
      // independently; app.json's controls the window, this one controls
      // whether THIS library's internal keyboard math runs at all. Without
      // it, `highestDetentPosition` (a small number back when 90% was the
      // top snap point — it starts near the top of the screen) minus the
      // keyboard's height (larger) went negative and clamped to 0 —
      // literally pinning the sheet's top edge to the top of the screen.
      // Setting this to match app.json's own window mode makes the library
      // stand down and leaves our explicit `snapToIndex(1)` (ComposeBar's
      // onFocus, via app/index.tsx's handleInputFocus) as the only thing
      // controlling the sheet's position on focus. Still needed after Build
      // 24 removed the 90% snap point (50% is now `highestDetentPosition`
      // instead) — this prop is what stops the library's own keyboard math
      // from running AT ALL, independent of which value that math would
      // have produced.
      android_keyboardInputMode="adjustResize"
      backgroundStyle={styles.background}
      handleComponent={renderHandle}
    >
      {/* Build 21 STICKY DRAWER HEADER: always rendered, at every snap
          index — this, plus the drag handle above (handleComponent), is
          deliberately the ONLY thing visible at the 20% resting peek (IDLE
          PEEK ISOLATION). It's a normal flex child now, in-flow above the
          segment pills/history content below, which is what actually
          guarantees PREVENT OVERLAP: cards can't render under or behind the
          search input if the search input owns real, non-absolute layout
          space above them rather than floating over an independently-scrolled
          list.
          LOCK KEYBOARD FOCUS SNAP TO 50%: the `<BottomSheetTextInput>`
          inside `composeBarSlot` (ComposeBar.tsx) has an explicit `onFocus`
          handler wired up from app/index.tsx's `handleInputFocus`, which
          calls `sheetRef.current?.snapToIndex(1)` on every focus — but that
          call alone was NOT sufficient (confirmed on a physical device: the
          sheet still pinned to the very top instead). The actual fix is
          `android_keyboardInputMode="adjustResize"` on `<BottomSheet>`
          above — see the long comment on that prop for the real root cause;
          this `onFocus` call only does anything useful once that prop stops
          the library's own keyboard math from overriding it. */}
      <View style={styles.header}>{composeBarSlot}</View>

      {/* IDLE PEEK ISOLATION (cont.): at index 0 (20%), everything below the
          sticky header renders nothing at all — not the segment pill, not
          either history list. Both only mount once the sheet reaches its
          (now sole, Build 24) expanded 50% stage. PADDING & CLEARANCE:
          `body`'s `marginTop` (16dp, below) is a
          real flex margin, not a clipping trick — the segment pills/list can
          structurally never render behind the sticky header above them
          (there's no absolute positioning or negative margin anywhere in
          this tree that could cause that), so this gap holds regardless of
          scroll position or sheet index, matching the Apple Maps
          reference. */}
      {sheetIndex > 0 && (
        <View style={styles.body}>
          <View style={styles.segmentRow}>
            {(["notes", "qa"] as const).map((tab) => (
              <Pressable
                key={tab}
                onPress={() => onHistoryTabChange(tab)}
                style={[styles.segmentOption, historyTab === tab && styles.segmentOptionActive]}
              >
                {/* Labels only — the underlying "notes"/"qa" identifiers
                    (HistoryTab, state, routing) are unchanged; this is a
                    display-text rename, not a rename of what the tabs are. */}
                <Text style={[styles.segmentText, historyTab === tab && styles.segmentTextActive]}>
                  {tab === "notes" ? "Recorded notes" : "Searched notes"}
                </Text>
              </Pressable>
            ))}
          </View>
          {historyTab === "notes" ? notesContent : qaContent}
        </View>
      )}
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
  // No vertical padding of its own — ComposeBar's row already has a fixed
  // 40dp height, and the drag handle above (handleComponent) already
  // carries its own top/bottom hit-area padding. This wrapper exists so
  // `composeBarSlot` has a stable, named place in the sheet's flex flow.
  header: {},
  body: {
    flex: 1,
    // PADDING & CLEARANCE: 16dp gap between the sticky header (search bar)
    // above and the segment pills/list content that starts here — matches
    // the Apple Maps reference screenshot's spacing between its search bar
    // and its "Find Nearby" result grid.
    marginTop: 16,
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
