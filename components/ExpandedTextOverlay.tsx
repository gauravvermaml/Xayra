import { useState } from "react";
import { StyleSheet, View } from "react-native";
import Animated, { interpolate, runOnJS, useAnimatedReaction, useAnimatedStyle, type SharedValue } from "react-native-reanimated";

import { SwipeableTrayHandle } from "./SwipeableTrayHandle";

export type ExpandedTextOverlayProps = {
  /** Device's safe-area top inset — pads the box's own top edge so it
   * stops softly below the status bar, matching the original spec's intent
   * for the 88% "expanded" stage. */
  topInset: number;
  /** Device's safe-area bottom inset — pads the box's own bottom edge so it
   * stops just above the Android nav bar rather than running under it. */
  bottomInset: number;
  /** Shared 0 (hidden, at the tray)..1 (fully expanded) progress — see
   * SwipeableTrayHandle.tsx's own doc comment for the full gesture
   * contract. Drives this component's own position/opacity continuously;
   * app/index.tsx owns the value and keeps this component mounted
   * permanently (not conditionally on some "isExpanded" boolean) so a drag
   * can be tracked from its very first pixel rather than only reacting
   * after a release. */
  progress: SharedValue<number>;
  /** Pixels of drag mapped to `progress`'s full 0..1 range — same value
   * HistorySheet.tsx's own tray handle uses for the same `progress`. Also
   * doubles as this component's own "how far off-screen to sit at
   * `progress === 0`" offset — see this file's own doc comment below. */
  dragDistance: number;
  /** Fires once a drag on this component's own (closing) handle settles
   * toward 0 (closed) or 1 (still expanded) — see SwipeableTrayHandle.tsx's
   * own `onSettle` doc comment for why this fires on the release DECISION,
   * not once the spring animation finishes. */
  onSettle: (expanded: boolean) => void;
  /** Whichever list (Recorded notes or Searched notes) is currently active
   * — rendered as a fresh element here, independent of HistorySheet's own
   * copy of the same content (see this file's own doc comment for why). */
  children: React.ReactNode;
};

/** Below this, the overlay is fully hidden and non-interactive, and its
 * (real, potentially not-cheap) `children` aren't mounted at all — matches
 * the render cost this component had at rest back when it was
 * conditionally mounted outright, while still letting `progress` start
 * tracking a drag from its very first pixel of movement. */
const INTERACTIVE_THRESHOLD = 0.01;
/** Opacity ramps in over just the first sliver of the drag, on top of the
 * continuous position tracking below — pure position alone (no fade) looks
 * acceptable by itself, since this box and the tray beneath it share the
 * same dark glass palette, but a quick fade removes any risk of a visible
 * seam right as `children` mounts in at `INTERACTIVE_THRESHOLD`. */
const OPACITY_RAMP_END = 0.15;

/**
 * MONOCHROMATIC GLASS — FULL-SCREEN EXPANDED STAGE, CONTINUOUSLY DRAG-
 * TRACKED.
 *
 * A real, deliberate architecture change from this feature's first version:
 * that version tried to reach "88%" by asking `@gorhom/bottom-sheet` itself
 * to grow past its own configured `snapPoints` via `snapToPosition`. Found
 * on-device, and confirmed by reading the library's own source
 * (`BottomSheetContent.tsx`): the CONTENT AREA height it hands to children
 * is deliberately capped at the highest *configured* snap point
 * (`animatedSheetHeight = containerHeight - highestDetentPosition`, where
 * `highestDetentPosition` comes from `snapPoints`, not the live position) —
 * that calculation only extends past the configured max for its own
 * keyboard-avoidance cases, never for an arbitrary `snapToPosition` target.
 * The outer sheet FRAME visually moved to 88% correctly, but the inner
 * content stayed clipped (by the library's own `overflow: "hidden"` content
 * wrapper) at the 50% height — which is exactly the "container only fills
 * the upper half" bug reported on-device, and not something fixable by any
 * styling on our side, since the clip happens in an ancestor we don't own.
 *
 * The fix: stop asking the bottom sheet to do this at all. This is a plain,
 * ordinary full-screen React Native overlay — `position: absolute` covering
 * the entire canvas, rendered as a sibling of `<HistorySheet>` in
 * app/index.tsx, completely independent of the sheet's own snap-point state
 * machine. The sheet itself is left exactly where it was (50%) underneath;
 * this overlay simply grows to cover it.
 *
 * SECOND real architecture change, on top of the first: this component used
 * to be conditionally MOUNTED on an `isExpanded` boolean, entering with a
 * `FadeIn`/scale-spring "pop" once a separate threshold-swipe gesture
 * (elsewhere) decided to commit. Live user testing rejected that outright —
 * no matter how the pop's own spring was tuned, it never felt like the SAME
 * gesture as the sheet's own native 0%-50% drag, because nothing on screen
 * actually followed the finger during the swipe itself; the pop only ever
 * happened AFTER release. This version is instead ALWAYS mounted (whenever
 * the tray itself would be) and driven continuously by `progress`:
 *  - `transform.translateY` interpolates from `dragDistance` (roughly
 *    aligning this box's top edge with the TRAY's own top edge, at
 *    `progress === 0`) down to `0` (fully in place, `progress === 1`) —
 *    `dragDistance` is deliberately the SAME distance the drag gesture maps
 *    across (see SwipeableTrayHandle.tsx), not a separately chosen number,
 *    so the two stay geometrically consistent by construction.
 *  - `opacity` only ramps in over the first `OPACITY_RAMP_END` of that
 *    range, and the real `children` only mount once `progress` clears
 *    `INTERACTIVE_THRESHOLD` — this component's OWN wrapper (backdrop + box
 *    + handle) is cheap enough to keep permanently mounted, but its
 *    children are exactly as expensive as before, so they stay
 *    conditionally mounted to preserve the old at-rest cost profile.
 * The net effect: dragging the tray's own handle (HistorySheet.tsx) or this
 * component's own closing handle both manipulate the SAME `progress` value
 * continuously, and this box visibly tracks the finger the whole time,
 * genuinely matching the sheet's own native drag feel rather than
 * approximating it with a tuned entrance animation.
 */
export function ExpandedTextOverlay({ topInset, bottomInset, progress, dragDistance, onSettle, children }: ExpandedTextOverlayProps) {
  const [interactive, setInteractive] = useState(false);

  useAnimatedReaction(
    () => progress.value > INTERACTIVE_THRESHOLD,
    (isInteractive, wasInteractive) => {
      if (isInteractive !== wasInteractive) {
        runOnJS(setInteractive)(isInteractive);
      }
    }
  );

  const containerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, OPACITY_RAMP_END], [0, 1], "clamp"),
    transform: [{ translateY: (1 - progress.value) * dragDistance }],
  }));

  return (
    <Animated.View pointerEvents={interactive ? "auto" : "none"} style={[styles.overlay, containerStyle]}>
      <View style={[styles.box, { marginTop: topInset + 16, marginBottom: bottomInset + 16 }]}>
        {/* Same handle component as HistorySheet.tsx's own tray — dragging
            it down continuously drives the SAME `progress` value back
            toward 0, collapsing this box back into the tray. */}
        <SwipeableTrayHandle progress={progress} dragDistance={dragDistance} onSettle={onSettle} style={styles.closeHandleRow} />
        {/* `listClearance`'s padding matches HistorySheet.tsx's own tray
            exactly — see that file's `listClearance`/`trayHandleRow` styles
            for the full reasoning. `children` only mounts once interactive
            (see this file's own top doc comment for why). */}
        <View style={styles.listClearance}>{interactive ? children : null}</View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    // Written out directly rather than via StyleSheet.absoluteFillObject —
    // this RN version's own type declarations don't expose that helper.
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Jet black, matching HistorySheet's own sheet background — the whole
    // point is that this reads as "the sheet, just bigger," not a visually
    // distinct layer.
    backgroundColor: "#000000",
  },
  box: {
    flex: 1,
    marginHorizontal: 16,
    position: "relative",
    backgroundColor: "rgba(18, 18, 26, 0.65)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: 18,
    padding: 16,
    overflow: "hidden",
  },
  listClearance: {
    flex: 1,
    paddingTop: 4,
  },
  closeHandleRow: {
    paddingTop: 4,
    paddingBottom: 8,
  },
});
