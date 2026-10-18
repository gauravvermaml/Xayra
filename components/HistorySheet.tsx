import { createContext, forwardRef, useCallback, useContext, useMemo } from "react";
import { type LayoutChangeEvent, Pressable, StyleSheet, useWindowDimensions, View } from "react-native";
import BottomSheet, { BottomSheetFooter, type BottomSheetFooterProps, type BottomSheetProps } from "@gorhom/bottom-sheet";
import Animated, { interpolate, type SharedValue, useAnimatedStyle } from "react-native-reanimated";

import { ModelDownloadCard } from "./ModelDownloadCard";
import { createExpandOverdragGestureHandlersHook } from "./useExpandOverdragGestureHandlers";
import { spacing } from "../constants/theme";
import { xayraColors } from "../constants/xayraTheme";
import type { ModelDownloadStatus } from "../services/ai/modelDownloadManager";
import { devTiming } from "../services/ai/perf";

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
 * machine (its own content area has no library-imposed height ceiling to
 * fight, unlike a real stage of this sheet would).
 *
 * ONE HANDLE, NOT TWO — live product correction: an earlier version of this
 * gave the 50%-100% transition its OWN separate handle, rendered inside the
 * tray's own glass box below. At the 50% resting stage that put two handles
 * on screen simultaneously (this sheet's own, above the compose bar, and
 * the tray's), and a user could easily grab the WRONG one expecting it to
 * collapse the sheet back to its peek. The fix: this sheet's own
 * `handleComponent` (`SheetDragHandle`, below) is now the ONLY handle for
 * the ENTIRE 20%-50%-100% range — dragging it up past 50%, without
 * releasing, continues seamlessly into `expandProgress` via a custom
 * `gestureEventsHandlersHook` (`useExpandOverdragGestureHandlers.ts` — see
 * its own doc comment for exactly how it hooks into the library's own
 * gesture internals without replacing them). The tray's glass box below no
 * longer renders any handle of its own at all.
 */
export const SHEET_SNAP_POINTS = ["20%", "50%"];

/** Xayra 2.0 (Option B): the expanded stage, unchanged. The rest stage is no
 * longer a percentage — it's the measured content height (`restHeight`):
 * handle + compose field + dock. SHEET_SNAP_POINTS stays only as the source
 * of the full-screen drag distance (app/index.tsx), which is unchanged. */
export const SHEET_HALF_SNAP_POINT = "50%";
/** The drag handle's rendered height (8 + 5 + 7, see styles below). */
export const SHEET_HANDLE_HEIGHT = 20;

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
      <Pressable
        onPress={onPress}
        // 20dp row + 14dp above and below = a 48dp touch target.
        hitSlop={14}
        accessibilityRole="button"
        accessibilityLabel="Tray handle. Tap to open, drag to resize"
        style={styles.dragHandleHitArea}
      >
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
  /** True while the compose bar's text input is focused and not yet
   * submitted (app/index.tsx's `isComposing`) — hides the glass box (list +
   * its ModelDownloadCard) even at an expanded `sheetIndex`, WITHOUT
   * changing the sheet's own snap index. Kept deliberately separate from
   * `sheetIndex`/IDLE PEEK ISOLATION above: an earlier attempt tried to get
   * the same "hide the list while typing" result by force-collapsing the
   * sheet to index 0 on focus, but that broke the sheet's own
   * keyboard-avoidance — the compose bar stopped reliably clearing the
   * keyboard, a regression on a mechanism (`android_keyboardInputMode`
   * "adjustResize" + this sheet's own index-1 auto-peek) that took real
   * on-device debugging to get right in the first place (see this file's
   * own long-standing keyboard comments below). Leaving the sheet at
   * whichever index it's actually at and only hiding the CONTENT keeps that
   * proven-working keyboard behavior completely untouched. */
  contentHidden?: boolean;
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
  /** Rest snap point in px, measured by app/index.tsx (handle + compose
   * field + gap + dock). */
  restHeight: number;
  /** The dock, rendered as the sheet's footer (bottom-pinned at every
   * stage); null while typing. */
  footer: React.ReactNode | null;
  /** The footer's measured height (bottom inset included) — the body ends
   * above it, so the list and its last item never run under the dock. */
  footerHeight: number;
  /** True on constrained screens (measured reading viewport at 50% below
   * app/index.tsx's minimum): the dock fades out as the tray rises to 50%
   * and the list takes its space, both tracking the tray's live position —
   * no jump. Back at rest the dock is fully there again. */
  footerYieldsAtHalf: boolean;
  /** The compose header's rendered height. */
  onHeaderLayout: (height: number) => void;
  /** Shared 0..1 progress this sheet's own handle drives once a drag
   * continues past its highest (50%) snap point — see
   * useExpandOverdragGestureHandlers.ts's own doc comment for the full
   * mechanism, and SHEET_SNAP_POINTS's above for why the "expanded,
   * full-screen" state it drives toward (`ExpandedTextOverlay`, rendered by
   * app/index.tsx) isn't a stage of this sheet at all. */
  expandProgress: SharedValue<number>;
  /** Pixels of continued drag past the highest snap point mapped to
   * `expandProgress`'s full 0..1 range — same value `ExpandedTextOverlay`'s
   * own closing handle uses for the reverse direction. */
  expandDragDistance: number;
  /** Fires once a drag past the highest snap point settles toward 1 (open)
   * or 0 (still collapsed) — see useExpandOverdragGestureHandlers.ts's own
   * `onExpandSettle` doc comment for why this fires on the release
   * DECISION, not once the spring animation finishes. */
  onExpandSettle: (expanded: boolean) => void;
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
 * request is processing, and is also the sheet's own configured ceiling;
 * dragging its handle past that continues into `expandProgress` instead
 * (ONE HANDLE, NOT TWO — see SHEET_SNAP_POINTS's own doc comment). `content`
 * (Q&A/"Recent Answers" history) sits inside the monochromatic glass box,
 * unchanged — `ExpandedTextOverlay`, the state that handle drags toward, is
 * a separate, full-screen component app/index.tsx renders outside this
 * sheet entirely.
 */
export const HistorySheet = forwardRef<BottomSheet, HistorySheetProps>(function HistorySheet(
  {
    composeBarSlot,
    content,
    onIndexChange,
    animatedIndex,
    sheetIndex,
    contentHidden,
    modelDownload,
    bottomInset,
    restHeight,
    footer,
    footerHeight,
    footerYieldsAtHalf,
    onHeaderLayout,
    expandProgress,
    expandDragDistance,
    onExpandSettle,
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

  // ONE HANDLE, NOT TWO (see SHEET_SNAP_POINTS's own doc comment) — this
  // hook wraps the library's own default handle-gesture behavior so that
  // dragging THIS sheet's handle past 50%, without releasing, continues
  // driving `expandProgress` instead of just rubber-banding and springing
  // back. Memoized on its (all effectively stable — a SharedValue, a
  // useCallback'd function, a constant number) inputs so `<BottomSheet>`
  // receives the same `gestureEventsHandlersHook` reference across renders,
  // the same way its own `handleComponent` (`renderHandle`, below) does —
  // see useExpandOverdragGestureHandlers.ts's own doc comment for the full
  // mechanism.
  const expandGestureHandlersHook = useMemo(
    () => createExpandOverdragGestureHandlersHook({ expandProgress, expandDragDistance, onExpandSettle }),
    [expandProgress, expandDragDistance, onExpandSettle]
  );

  const renderHandle = useCallback(() => <SheetDragHandle onPress={handleTapDragHandle} />, [handleTapDragHandle]);

  const snapPoints = useMemo(() => [restHeight, SHEET_HALF_SNAP_POINT], [restHeight]);

  // TRAY SCROLL FIX (Xayra 2.0 Stage 4.2): gorhom bounds its content area
  // only with a Reanimated-animated `height` style (sheet height minus the
  // handle). On this stack (RN 0.86, Reanimated 4, New Architecture) that
  // animated height never reaches layout: measured on-device, a flex:1 child
  // of gorhom's content container laid out at 1318dp instead of ~437dp, so
  // the list was laid out at its full content height (1154dp for nine notes)
  // and had nothing to scroll — the sheet only clipped it. The full-screen
  // overlay's list scrolled because its parent has a static, bounded height.
  // This gives the sheet's own children that same static bound: the content
  // height at the 50% (highest) stage — half the window, which is what gorhom
  // resolves "50%" against, minus the handle. Snap points, gestures and the
  // library are untouched; at the rest stage the body is hidden anyway.
  const { height: windowHeight } = useWindowDimensions();
  const contentAreaHeight = Math.max(0, windowHeight * 0.5 - SHEET_HANDLE_HEIGHT);

  // The dock as the sheet's footer: gorhom keeps it pinned to the bottom of
  // the visible sheet at every stage. Omitted entirely while typing.
  // gorhom treats `footerComponent` as a component type, so its identity
  // must never change while shown (a new function would remount the dock on
  // every keystroke elsewhere on the screen). The dock element reaches it
  // through FooterContext instead.
  const renderFooter = useCallback(
    (props: BottomSheetFooterProps) => (
      <BottomSheetFooter {...props}>
        <FooterSlot />
      </BottomSheetFooter>
    ),
    []
  );
  const handleHeaderLayout = useCallback(
    (e: LayoutChangeEvent) => onHeaderLayout(Math.round(e.nativeEvent.layout.height)),
    [onHeaderLayout]
  );
  const footerVisible = footer !== null;
  const footerHiddenAtHalf = footerYieldsAtHalf && sheetIndex === 1;
  // Body bottom padding: the dock's height, or — when it yields at 50% —
  // interpolated with the live tray position down to the inset alone.
  const bodyPaddingStyle = useAnimatedStyle(() => {
    if (!footerVisible) return { paddingBottom: bottomInset };
    if (!footerYieldsAtHalf) return { paddingBottom: footerHeight };
    return {
      paddingBottom: interpolate(animatedIndex.value, [0, 1], [footerHeight, bottomInset], "clamp"),
    };
  });
  const footerFadeStyle = useAnimatedStyle(() => ({
    opacity: footerYieldsAtHalf ? interpolate(animatedIndex.value, [0.4, 1], [1, 0], "clamp") : 1,
  }));

  const footerContent = footerVisible ? (
    <Animated.View
      style={footerFadeStyle}
      pointerEvents={footerHiddenAtHalf ? "none" : "auto"}
      importantForAccessibility={footerHiddenAtHalf ? "no-hide-descendants" : "auto"}
      accessibilityElementsHidden={footerHiddenAtHalf}
    >
      {footer}
    </Animated.View>
  ) : null;

  return (
    <FooterContext.Provider value={footerContent}>
    <BottomSheet
      ref={ref}
      index={0}
      snapPoints={snapPoints}
      footerComponent={footerVisible ? renderFooter : undefined}
      animatedIndex={animatedIndex}
      onChange={onIndexChange}
      onAnimate={(from: number, to: number) => devTiming("VoiceAskTiming", "tray animation start", { from, to })}
      enableDynamicSizing={false}
      keyboardBehavior="interactive"
      // "restore" (the library's own default-adjacent option — snap back to
      // wherever the sheet was before the keyboard opened, once it closes)
      // was live here until ComposeBar.tsx started calling
      // `Keyboard.dismiss()` on every submit. That's the whole point of this
      // component's own snapToIndex(1) call inside routeFreeformInput
      // (app/index.tsx) firing on submit — the sheet is supposed to STAY
      // open at 50% to reveal the note-saved confirmation/streaming answer
      // — but a real blur event now fires moments later as the keyboard
      // actually finishes closing, and "restore" would then independently
      // snap the sheet right back down to wherever it was before typing
      // started, undoing that reveal out from under it. "none" leaves blur
      // with no sheet-position opinion of its own; every snap on this sheet
      // is already deliberately driven by app/index.tsx's own explicit
      // calls (drag handle, backdrop tap, keyboard focus, post-submit
      // reveal) — the sheet never needs to guess a position for itself.
      keyboardBlurBehavior="none"
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
      gestureEventsHandlersHook={expandGestureHandlersHook}
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
      <View style={{ height: contentAreaHeight }}>
      <View style={styles.header} onLayout={handleHeaderLayout}>
        {composeBarSlot}
      </View>

      {/* IDLE PEEK ISOLATION, REVISED — was a full conditional mount/unmount
          (`{sheetIndex > 0 && !contentHidden && (<View>...)}`), which is
          exactly what caused a real, live-reported bug: `content`'s list
          (`BottomSheetFlatList`, in NotesSheetContent/ChatSheetContent)
          registers its native scroll handle with this sheet's OWN internal
          gesture coordinator via a one-shot `useEffect`
          (`useScrollableSetter.ts` in @gorhom/bottom-sheet's own source —
          calls `findNodeHandle(ref.current)` exactly once and never retries).
          Mounting the list LATE (only once the sheet reaches its expanded
          stage) raced that native ref not being attached yet at the moment
          that effect ran, silently failing the registration — the list would
          then show a scrollbar/respond to nothing until some UNRELATED state
          change (confirmed on-device: opening and closing the note-detail
          popup) happened to force a remount that finally won the race.
          Always mounting `content` from this sheet's very first render (so
          its scrollable ref registers correctly long before the user ever
          expands it) fixes this at the root. `pointerEvents="none"` plus
          `opacity: 0` (styles.bodyHidden) at index 0 restores two of the
          original three IDLE PEEK ISOLATION guarantees — can't steal a stray
          touch, invisible — the third (fully absent from the tree/a11y
          tree) is a deliberately accepted, minor trade-off against an actual
          functional bug. PADDING & CLEARANCE: `body`'s `marginTop` (16dp,
          below) is a real flex margin, not a clipping trick — the list can
          structurally never render behind the sticky header above it. */}
      <Animated.View
        style={[
          styles.body,
          // The body ends at the dock's top edge: the list's last item and
          // the download card stay above it. The bottom safe-area inset is
          // part of the dock's measured height — counted once, there. With
          // no dock (typing — the body is hidden then anyway) it's the inset.
          bodyPaddingStyle,
          (sheetIndex === 0 || contentHidden) && styles.bodyHidden,
        ]}
        pointerEvents={sheetIndex === 0 || contentHidden ? "none" : undefined}
      >
        {/* Monochromatic glass container: one translucent, bordered box
            rather than the list rendering directly against the sheet's
            own jet-black background. No handle of its own — see
            SHEET_SNAP_POINTS's own doc comment for why (ONE HANDLE, NOT
            TWO): the sheet's own handle above (`handleComponent`) now
            covers the whole 20%-50%-100% range via
            `expandGestureHandlersHook`, so this box is just its plain
            padded content, same as any other flex box in this app. */}
        <View style={styles.textContainerBox}>{content}</View>

        <ModelDownloadCard modelDownload={modelDownload} />
      </Animated.View>
      </View>
    </BottomSheet>
    </FooterContext.Provider>
  );
});

const FooterContext = createContext<React.ReactNode | null>(null);

function FooterSlot() {
  return <>{useContext(FooterContext)}</>;
}

const styles = StyleSheet.create({
  // Xayra 2.0: the reading tray is a quiet slate surface lifted off the
  // black canvas by its colour and a faint top edge — no card, no shadow.
  background: {
    backgroundColor: xayraColors.surface,
    borderTopLeftRadius: 26,
    borderTopRightRadius: 26,
    borderTopWidth: 1,
    borderColor: xayraColors.lineStrong,
  },
  handleWrap: {
    alignItems: "center",
  },
  // 8 + 5 + 7 = 20dp, the same height as before, so the compose field (and
  // with it the keyboard clearance) sits exactly where it did.
  dragHandleHitArea: {
    paddingTop: spacing.sm,
    paddingBottom: 7,
    paddingHorizontal: spacing.xl,
  },
  dragHandle: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: xayraColors.handle,
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
  // See the render body's own IDLE PEEK ISOLATION comment — this is what
  // visually hides `content` at the collapsed peek stage now that it's
  // always mounted, rather than a full unmount.
  bodyHidden: {
    opacity: 0,
  },
  // Xayra 2.0: borderless — the list sits straight on the tray surface (the
  // old translucent bordered "glass" box is gone). `flex: 1` and
  // `overflow: "hidden"` keep the scrollable list filling and clipped.
  textContainerBox: {
    flex: 1,
    position: "relative",
    overflow: "hidden",
  },
});
