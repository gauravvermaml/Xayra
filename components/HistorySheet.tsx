import { forwardRef, useCallback } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, { type BottomSheetProps } from "@gorhom/bottom-sheet";
import Animated, { FadeIn, FadeOut, Layout, type SharedValue } from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";

import { ModelDownloadCard } from "./ModelDownloadCard";
import { colors, radius, spacing } from "../constants/theme";
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
 * The MONOCHROMATIC GLASS container's own "fully expanded" 88% state is
 * deliberately NOT a third entry here — an earlier version of this feature
 * added "88%" to this array and reached it via `snapToIndex(2)`, which
 * reintroduced exactly the class of bug Build 24 fixed: because it was a
 * real configured snap point, the sheet's own pan gesture could drag to it
 * too — a plain swipe-up from 50% (not just the micro-chip tap) could reach
 * it, and worse, a slow/partial swipe could leave the sheet sitting at some
 * in-between height, visibly exposing a sliver of the record button behind
 * it. Both were real, reported, on-device bugs, not theoretical.
 *
 * The fix: 88% is reached ONLY via `@gorhom/bottom-sheet`'s own
 * `snapToPosition` API (see app/index.tsx's `handleToggleExpand`) — "snap to
 * a position out of provided `snapPoints`," which the library treats as a
 * temporary, gesture-UNREACHABLE position. Since it's never in this array,
 * the pan gesture's own range stays hard-clamped to [20%, 50%] exactly as
 * Build 24 intended — there is nothing to drag past 50% to, full stop — and
 * the ONLY path to 88% is one discrete, always-fully-animated call the
 * micro-chip's `onPress` makes. A partial/interrupted state is no longer
 * possible because there's no gesture involved in reaching it at all.
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
  /** Device's safe-area top inset — applied as extra `marginTop` on
   * `textContainerBox` ONLY while `isExpanded` is true, pushing the box's
   * own outer edge (not its internal padding — see CHIP_CONTENT_CLEARANCE
   * below for why those stay separate) down below the status bar for the
   * 88% expanded stage. */
  topInset: number;
  /** True only while the monochromatic glass box is in its 88% expanded
   * stage — owned by app/index.tsx as its own boolean (see that file's
   * `isTextBoxExpanded`) rather than derived from the sheet's own snap
   * index, since 88% is deliberately NOT a real snap index here (see
   * SHEET_SNAP_POINTS's doc comment above) — the sheet's own `onChange`
   * never reports an index for it. */
  isExpanded: boolean;
  /** Micro-chip toggle (top-right of `textContainerBox`) between the 50%
   * (idle) and 88% (expanded) stages — owned by app/index.tsx since it's the
   * one holding `sheetRef` and calling `snapToPosition`/`snapToIndex`. */
  onToggleExpand: () => void;
  /** Spring physics shared with every `snapToIndex`/`snapToPosition` call
   * this sheet makes (both app/index.tsx's own calls and the drag-handle tap
   * here), via `@gorhom/bottom-sheet`'s own `animationConfigs` prop — so the
   * 50%<->88% micro-chip transition decelerates with the exact same feel as
   * every other snap this sheet already does, rather than the library's
   * default spring. */
  animationConfigs?: BottomSheetProps["animationConfigs"];
};

/**
 * Sticky Apple-Maps-style bottom sheet: true jet-black background so it
 * reads as part of the same canvas as the screen behind it. Two
 * gesture-reachable snap points (see SHEET_SNAP_POINTS) — the 50% stage is
 * what `app/index.tsx` snaps to automatically while an ASK-classified
 * request is processing, and is also as far as any manual swipe can ever
 * go. A third, 88% "expanded" stage exists ONLY as a `snapToPosition` target
 * the micro-chip toggle reaches programmatically — see SHEET_SNAP_POINTS's
 * own doc comment for why it's deliberately not a real snap point. At 50%
 * (segment cards visible) or 88% (segment cards hidden) alike, a Notes/QA
 * History segment control filters which scrollable list is shown inside the
 * monochromatic glass box; both segments' underlying state (`allNotes` in
 * app/index.tsx, and the chat session from services/ai/useChatSession.ts)
 * lives above this component either way, so switching segments never loses
 * anything, only which is visible.
 */
export const HistorySheet = forwardRef<BottomSheet, HistorySheetProps>(function HistorySheet(
  {
    historyTab,
    onHistoryTabChange,
    composeBarSlot,
    notesContent,
    qaContent,
    onIndexChange,
    animatedIndex,
    sheetIndex,
    modelDownload,
    bottomInset,
    topInset,
    isExpanded,
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
          sticky header renders nothing at all — not the segment pill, not
          either history list. Both only mount once the sheet reaches its
          expanded 50% stage, or the glass box's own 88% expanded stage.
          PADDING & CLEARANCE: `body`'s `marginTop` (16dp, below) is a
          real flex margin, not a clipping trick — the segment pills/list can
          structurally never render behind the sticky header above them
          (there's no absolute positioning or negative margin anywhere in
          this tree that could cause that), so this gap holds regardless of
          scroll position or sheet index, matching the Apple Maps
          reference.

          `|| isExpanded` — found on-device: while `snapToPosition("88%")`
          holds the sheet at a position outside `snapPoints`, the library's
          own `onChange`/`animatedIndex` index math (it interpolates against
          an internal extra point mapping full container height to index
          -1 — see @gorhom/bottom-sheet's BottomSheet.tsx) does NOT simply
          clamp at the highest real snap index the way it does for an
          in-range position; near-full-height positions like 88% pull the
          reported index down toward that -1 anchor instead. `sheetIndex`
          landing at 0 (or lower) here made this condition go false the
          instant the box expanded, unmounting the entire glass box,
          chip, and list mid-transition — confirmed directly on-device (a
          screenshot showed the sheet visually at 88% with nothing rendered
          below the sticky header at all). `isExpanded` is this component's
          own explicit, JS-state-driven signal for "the glass box is
          supposed to be visible right now" and is never subject to that
          index math at all, so it's authoritative here regardless of what
          `sheetIndex` reports during the excursion. */}
      {(sheetIndex > 0 || isExpanded) && (
        <View style={styles.body}>
          {/* MONOCHROMATIC GLASS — TWO-STATE VISIBILITY: State A (50%, idle)
              shows the tab-selection cards above the glass box; State B (88%,
              expanded) hides them entirely, giving the box the full sheet
              height to itself. `FadeIn`/`FadeOut` (mount/unmount transitions)
              plus `layout={Layout.springify()}` on the glass box below (a
              layout-CHANGE transition, not mount/unmount) are what let this
              conditional unmount and the box's resulting height change both
              animate smoothly instead of jump-cutting. */}
          {!isExpanded && (
            <Animated.View
              entering={FadeIn.duration(180)}
              exiting={FadeOut.duration(140)}
              style={styles.segmentRow}
            >
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
            </Animated.View>
          )}

          {/* Monochromatic glass container: wraps whichever list is active
              in one translucent, bordered box rather than either list
              rendering directly against the sheet's own jet-black
              background. `layout={Layout.springify()}` animates the box's
              own height/position change as the segment row above mounts or
              unmounts, and as the sheet itself moves between the 50%/88%
              stages — both are ordinary layout changes from this box's
              perspective, not something it needs to know the cause of.
              `marginTop` (not `paddingTop`) is what shifts the whole box
              down to clear the status bar while expanded — kept as an OUTER
              offset, deliberately separate from the box's own internal
              `padding: 16`, so the chip-to-content clearance below stays
              identical in both states instead of the status-bar inset
              silently changing it too. */}
          <Animated.View
            layout={Layout.springify()}
            style={[styles.textContainerBox, isExpanded && { marginTop: topInset + 16 }]}
          >
            {/* Floating micro-chip toggle: arrow-up-right (State A) expands
                to 88%; x (State B) — same chip, same position — collapses
                back to 50%, restoring the tab cards and reverting the icon.
                One Pressable/one icon swap, not two separate buttons, so
                there's exactly one source of truth for "what does tapping
                this chip do right now." */}
            <Pressable onPress={onToggleExpand} hitSlop={8} style={styles.microChip}>
              <Feather name={isExpanded ? "x" : "arrow-up-right"} size={18} color="#E2E8F0" />
            </Pressable>
            {/* CHIP CLEARANCE: found on-device — the chip (top:12, 32px tall,
                so it occupies the box's own top 12-44px) was overlapping the
                very top of the first note/message card, since the box's own
                16px padding alone wasn't enough clearance below it. This
                fixed extra top offset (chip's own 44px bottom edge + a 12px
                gap) reserves real layout space above the list instead, so
                content structurally starts below the chip rather than
                merely being visually covered by it. Applied as its own
                wrapper (not baked into the box's `padding`) so it stays
                exactly the same in both the idle and expanded states — see
                the box's own `marginTop` comment above for why the two are
                kept independent. */}
            <View style={styles.listClearance}>{historyTab === "notes" ? notesContent : qaContent}</View>
          </Animated.View>

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
  // MONOCHROMATIC GLASS: a single translucent, subtly-bordered box wrapping
  // whichever list (notes or QA) is currently active — `flex: 1` and
  // `overflow: "hidden"` are additive to the requested spec (not part of
  // it), needed for a real scrollable list to actually fill the box's
  // height and for its content to respect the box's own rounded corners.
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
