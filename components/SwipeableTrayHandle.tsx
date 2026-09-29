import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { runOnJS, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";

/** Same feel as this app's other swipe-to-commit gestures (e.g. the
 * calendar's own swipe-to-navigate) — either threshold alone decides which
 * way the release settles: a short fast flick and a slow deliberate drag
 * both count. */
const SWIPE_VELOCITY_THRESHOLD = 500;
/** Same spring physics as HistorySheet's own native 0%→50% sheet bounce
 * (`sheetAnimationConfigs` in app/index.tsx) — the point of driving this
 * handle continuously at all is that the 50%↔100% transition should feel
 * like the SAME gesture language as that native drag, not a different one. */
const SETTLE_SPRING = { damping: 24, stiffness: 260, mass: 0.9, overshootClamping: false };

function clamp01(value: number): number {
  "worklet";
  return Math.min(1, Math.max(0, value));
}

export type SwipeableTrayHandleProps = {
  /** Shared 0 (collapsed, at the tray)..1 (fully expanded, full screen)
   * progress this handle DRIVES CONTINUOUSLY while dragging — up increases
   * it, down decreases it, regardless of which handle (the tray's own, or
   * the full overlay's own) is doing the dragging. Both handles share the
   * SAME value (owned by app/index.tsx, passed down to both), which is what
   * makes a drag started on one surface and released still coherent with
   * whatever the other surface is doing with that same number. */
  progress: SharedValue<number>;
  /** Pixels of vertical drag mapped to the full 0..1 range — pass the same
   * value to both handles sharing a `progress`. app/index.tsx sizes this off
   * the real sheet's own 0%-50% travel distance for a consistent feel. */
  dragDistance: number;
  /** Fires via `runOnJS` the instant a release's settle DIRECTION is
   * decided (not once the spring finishes) — e.g. so app/index.tsx can hide
   * the floating pill cluster right as an "opening" drag is released,
   * rather than waiting out the settle animation first. */
  onSettle: (expanded: boolean) => void;
  style?: StyleProp<ViewStyle>;
};

/**
 * A plain drag-handle pill — same look as this app's other handles (e.g.
 * HistorySheet.tsx's own outer `SheetDragHandle`) — that continuously
 * tracks a vertical drag into `progress` and springs it the rest of the way
 * to 0 or 1 on release, based on which side of the midpoint it ended up on
 * (a fast flick in either direction overrides that and commits immediately
 * in the flick's direction, regardless of how far the drag actually got).
 *
 * This is the actual fix for "the 50%↔100% transition doesn't feel like
 * the 0%↔50% one" — two earlier versions of this file used a discrete
 * threshold-then-`onCommit` model (drag past X px, THEN fire a callback
 * that triggers an independent mount/fade-in animation), which never felt
 * like a real drag no matter how the entrance animation was tuned, because
 * nothing on screen actually followed the finger during the gesture itself.
 * `@gorhom/bottom-sheet` can't be asked to do this directly — its content
 * area is capped at the highest *configured* snap point regardless of the
 * frame's live position, confirmed twice on-device (see HistorySheet.tsx's
 * own SHEET_SNAP_POINTS doc comment) — so `progress` instead drives a
 * hand-built animated surface (ExpandedTextOverlay.tsx) entirely outside
 * the bottom-sheet library, the same way SwipeableCalendarPager.tsx drives
 * the calendar's own continuous swipe outside a plain `ScrollView`.
 *
 * Used for BOTH the 50% tray's "expand" handle (HistorySheet.tsx) and the
 * full-screen overlay's "collapse" handle (ExpandedTextOverlay.tsx) —
 * deliberately the same up-increases/down-decreases sign convention on
 * both, which is what lets them share one `progress` value coherently: the
 * tray's handle starts a drag from `progress === 0`, the overlay's from
 * `progress === 1`, but the gesture math itself doesn't need to know which.
 */
export function SwipeableTrayHandle({ progress, dragDistance, onSettle, style }: SwipeableTrayHandleProps) {
  const startProgress = useSharedValue(0);

  const gesture = Gesture.Pan()
    .onStart(() => {
      startProgress.value = progress.value;
    })
    .onUpdate((event) => {
      // Dragging UP (negative translationY) increases progress toward 1;
      // dragging DOWN decreases it toward 0 — see this file's own doc
      // comment for why that convention is shared by both call sites.
      progress.value = clamp01(startProgress.value - event.translationY / dragDistance);
    })
    .onEnd((event) => {
      const flickOpen = event.velocityY <= -SWIPE_VELOCITY_THRESHOLD;
      const flickClose = event.velocityY >= SWIPE_VELOCITY_THRESHOLD;
      const target = flickOpen ? 1 : flickClose ? 0 : progress.value >= 0.5 ? 1 : 0;
      progress.value = withSpring(target, SETTLE_SPRING);
      runOnJS(onSettle)(target === 1);
    });

  return (
    <GestureDetector gesture={gesture}>
      <View style={[styles.row, style]}>
        <View style={styles.pill} />
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  row: {
    alignItems: "center",
  },
  pill: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.3)",
  },
});
