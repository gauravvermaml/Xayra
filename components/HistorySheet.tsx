import { forwardRef, useCallback } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import BottomSheet, { type BottomSheetProps } from "@gorhom/bottom-sheet";
import type { SharedValue } from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";

import { ModelDownloadCard } from "./ModelDownloadCard";
import { spacing } from "../constants/theme";
import type { ModelDownloadStatus } from "../services/ai/modelDownloadManager";

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
 * Two stages, same as Build 24 — resting peek (just the compose bar) and a
 * single 50% expanded stage. That stays a hard, gesture-reachable ceiling:
 * `snapPoints` below still lists only these two.
 *
 * The MONOCHROMATIC GLASS container's own "fully expanded" stage is NOT a
 * third stage of THIS sheet at all — two earlier attempts tried exactly
 * that (first a real "88%" `snapPoints` entry, reachable by gesture and not
 * just the intended micro-chip tap; then `snapToPosition("88%")`, a
 * gesture-unreachable temporary position outside `snapPoints`) and both
 * failed on-device for different reasons: the first let a plain swipe-up
 * reach it and could leave the sheet at some partial in-between height; the
 * second couldn't give its content real full-screen height at all, because
 * `@gorhom/bottom-sheet`'s own `BottomSheetContent.tsx` deliberately caps
 * the content area at the highest *configured* snap point regardless of
 * where a `snapToPosition` call visually moves the outer frame — the box's
 * own fill stopped at the 50%-equivalent height no matter what.
 *
 * The actual fix: the expanded stage is a completely separate, plain
 * full-screen overlay (`components/ExpandedTextOverlay.tsx`), rendered by
 * app/index.tsx as an ordinary sibling of `<HistorySheet>` — not a stage of
 * this sheet at all, and entirely outside `@gorhom/bottom-sheet`'s state
 * machine. This sheet's own gesture range genuinely never exceeds 50%
 * (nothing above it is even a concept this component has anymore), and the
 * overlay's plain `flex: 1` box has no library-imposed content-height
 * ceiling to fight. This component's own micro-chip (see below) only ever
 * shows the arrow and only ever calls `onToggleExpand` — it has no "expanded"
 * state of its own to render.
 */
export const SHEET_SNAP_POINTS = ["20%", "50%"];

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
  /** Build 21 — STICKY DRAWER HEADER: a pre-built `<ComposeBar />` element,
   * rendered here as an ordinary child inside `<BottomSheet>`, directly below
   * the drag handle and above the history content. Passed as a `ReactNode`
   * rather than constructed in this file for the same reason `content`
   * already is — app/index.tsx owns all of its state and callbacks, this
   * file only decides where it's positioned. See ComposeBar.tsx's own doc
   * comment for why rendering it this way (a plain prop/child, never
   * `handleComponent`) doesn't reintroduce the Build 18 keyboard-focus-drop
   * bug. */
  composeBarSlot: React.ReactNode;
  /** The sheet's one scrollable list — Q&A history ("Recent Answers"). Used
   * to show a Notes/QA segment toggle with a second list alongside this one
   * ("Recorded notes"); that card was demoted off the landing screen
   * entirely as of the "Quiet Corner" pass (see app/archive.tsx) — there's
   * only ever one list here now. */
  content: React.ReactNode;
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
  /** Build 25 CARD POSITIONING: rendered once here, beneath whichever
      list is currently visible — see ModelDownloadCard.tsx's own doc
      comment for why this replaced the old QA-tab-only setup bar. */
  modelDownload: ModelDownloadStatus;
  /** Device's safe-area bottom inset — same Build 20 SCROLL CONTENT
      CLEARANCE pattern already used by NotesSheetContent/ChatSheetContent's
      own `bottomInset` prop. `ModelDownloadCard` sits OUTSIDE either
      scrollable list, as a plain flex sibling at the bottom of `body`, so it
      needs this applied directly — confirmed on-device (a Build 25
      screenshot showed the card's subtitle clipped flush against the
      Android nav bar without it). */
  bottomInset: number;
  /** Opens `ExpandedTextOverlay` (owned and rendered by app/index.tsx,
   * entirely outside this sheet) — this component's own micro-chip
   * (top-right of `textContainerBox`) only ever shows the arrow and only
   * ever calls this; it has no "expanded" state of its own to track or
   * render (see SHEET_SNAP_POINTS's doc comment above for why). */
  onToggleExpand: () => void;
  /** Spring physics shared with every `snapToIndex` call this sheet makes,
   * via `@gorhom/bottom-sheet`'s own `animationConfigs` prop — so every snap
   * (backdrop tap, auto-peek on submit, keyboard focus, drag-handle tap)
   * decelerates with the same soft, native-feeling curve. */
  animationConfigs?: BottomSheetProps["animationConfigs"];
};

/**
 * Sticky Apple-Maps-style bottom sheet: true jet-black background so it
 * reads as part of the same canvas as the screen behind it. Two
 * gesture-reachable snap points (see SHEET_SNAP_POINTS) — the 50% stage is
 * what `app/index.tsx` snaps to automatically while an ASK-classified
 * request is processing, and is also as far as any manual swipe can ever
 * go. `content` (Q&A/"Recent Answers" history) sits inside the
 * monochromatic glass box; its own micro-chip opens `ExpandedTextOverlay` —
 * a separate, full-screen component app/index.tsx renders outside this
 * sheet entirely; see SHEET_SNAP_POINTS's doc comment above for why that
 * state doesn't live here.
 */
export const HistorySheet = forwardRef<BottomSheet, HistorySheetProps>(function HistorySheet(
  {
    composeBarSlot,
    content,
    onIndexChange,
    animatedIndex,
    sheetIndex,
    modelDownload,
    bottomInset,
    onToggleExpand,
    animationConfigs,
  },
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
      animationConfigs={animationConfigs}
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
          sticky header renders nothing at all — not the glass box, not the
          list inside it. Both only mount once the sheet reaches its
          expanded 50% stage. PADDING & CLEARANCE: `body`'s `marginTop`
          (16dp, below) is a real flex margin, not a clipping trick — the
          list can structurally never render behind the sticky header above
          it (there's no absolute positioning or negative margin anywhere in
          this tree that could cause that), so this gap holds regardless of
          scroll position or sheet index, matching the Apple Maps
          reference. */}
      {sheetIndex > 0 && (
        <View style={styles.body}>
          {/* Monochromatic glass container: one translucent, bordered box
              rather than the list rendering directly against the sheet's
              own jet-black background. This box's own micro-chip only ever
              shows the arrow and only ever calls `onToggleExpand` — the
              "expanded, full-screen" state it opens is
              `ExpandedTextOverlay`, a completely separate component
              app/index.tsx renders outside this sheet (see
              SHEET_SNAP_POINTS's doc comment above for why). */}
          <View style={styles.textContainerBox}>
            <Pressable onPress={onToggleExpand} hitSlop={8} style={styles.microChip}>
              <Feather name="arrow-up-right" size={18} color="#E2E8F0" />
            </Pressable>
            {/* CHIP CLEARANCE: found on-device — the chip (top:12, 32px tall,
                so it occupies the box's own top 12-44px) was overlapping the
                very top of the first message card, since the box's own 16px
                padding alone wasn't enough clearance below it. This fixed
                extra top offset (chip's own 44px bottom edge + a 12px gap)
                reserves real layout space above the list instead, so
                content structurally starts below the chip rather than
                merely being visually covered by it. `ExpandedTextOverlay`
                uses this exact same offset for its own copy of this box, so
                the gap reads identically in both places. */}
            <View style={styles.listClearance}>{content}</View>
          </View>

          <View style={{ paddingBottom: bottomInset }}>
            <ModelDownloadCard modelDownload={modelDownload} />
          </View>
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
    // above and the list content that starts here — matches the Apple Maps
    // reference screenshot's spacing between its search bar and its "Find
    // Nearby" result grid.
    marginTop: 16,
  },
  // MONOCHROMATIC GLASS: a single translucent, subtly-bordered box wrapping
  // the Q&A history list — `flex: 1` and `overflow: "hidden"` are additive
  // to the requested spec (not part of it), needed for a real scrollable
  // list to actually fill the box's height and for its content to respect
  // the box's own rounded corners.
  textContainerBox: {
    flex: 1,
    position: "relative",
    backgroundColor: "rgba(18, 18, 26, 0.65)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 18,
    padding: 16,
    overflow: "hidden",
  },
  // CHIP CLEARANCE (see the render-side comment above): 44 (chip's own
  // bottom edge, relative to the box's outer top) + 12 (breathing room)
  // rounded to 40, on top of the box's own 16px padding — 56px total from
  // the box's top edge to the first list item, a clean 12px gap below the
  // chip.
  listClearance: {
    flex: 1,
    paddingTop: 40,
  },
  // Floating micro-chip toggle, top-right corner of textContainerBox.
  microChip: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
    justifyContent: "center",
    // Sits above the list content it's layered on top of.
    zIndex: 10,
  },
});
