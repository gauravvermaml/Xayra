import { useCallback } from "react";
import {
  GESTURE_SOURCE,
  useBottomSheetInternal,
  useGestureEventsHandlersDefault,
  type GestureEventHandlerCallbackType,
  type GestureEventsHandlersHookType,
} from "@gorhom/bottom-sheet";
import { runOnJS, useSharedValue, withSpring, type SharedValue } from "react-native-reanimated";

/** Same spring physics as HistorySheet's own native 0%→50% sheet bounce
 * (`sheetAnimationConfigs` in app/index.tsx) — the whole point of this file
 * is that dragging past 50% should feel like the SAME gesture as dragging
 * from 0% to 50%, not a different one. */
const SETTLE_SPRING = { damping: 24, stiffness: 260, mass: 0.9, overshootClamping: false };
const FLICK_VELOCITY_THRESHOLD = 500;

export type ExpandOverdragGestureHandlersParams = {
  /** Shared 0..1 progress this drives — see SwipeableTrayHandle.tsx's own
   * doc comment for the full contract (this file drives the SAME value that
   * component's "close" handle also drives, from the other direction). */
  expandProgress: SharedValue<number>;
  /** Pixels of continued drag PAST the sheet's own highest snap point
   * mapped to the full 0..1 range — same value passed to
   * ExpandedTextOverlay.tsx's own handle for the reverse direction. */
  expandDragDistance: number;
  /** Fires via `runOnJS` the instant a release decides to commit to fully
   * expanded (true) or fall back to the plain 50% tray (false) — never
   * fires at all for an ordinary drag that never left the sheet's own
   * normal 20%-50% range. */
  onExpandSettle: (expanded: boolean) => void;
};

/**
 * Builds a `gestureEventsHandlersHook` for `<BottomSheet>` — a public
 * customization point the library exposes specifically for this kind of
 * extension (see its own `types.d.ts`: `GestureEventsHandlersHookType`) —
 * that lets ONE continuous drag on the sheet's own native handle span its
 * normal 20%-50% range AND, without releasing, keep going up into
 * `expandProgress`'s custom 50%-100% range, with no visible seam between
 * the two.
 *
 * WHY THIS EXISTS: live product correction. The first version of this
 * feature gave the 50%-100% transition its OWN separate handle, rendered
 * inside the tray's own glass box — but at the 50% resting stage, that put
 * TWO handles on screen at once (the sheet's own, above the compose bar,
 * and the tray's own, inside the box), and a user could easily reach for
 * the WRONG one expecting it to collapse the sheet back down to its peek,
 * when it actually only drove the 50%-100% direction. The fix removes the
 * second handle entirely — HistorySheet.tsx's tray no longer renders one at
 * all — and extends the SHEET's OWN existing handle to cover the whole
 * range instead, exactly matching the spec: one handle, the same feel
 * throughout.
 *
 * HOW IT WORKS: this wraps `useGestureEventsHandlersDefault` (the library's
 * OWN implementation, called directly here) rather than replacing it —
 * every existing behavior (keyboard-blur-on-drag, scrollable-position
 * locking, the sheet's own 20%-50% snapping) runs completely unmodified.
 * The only addition: while the drag HANDLE (never the scrollable CONTENT —
 * `GESTURE_SOURCE.HANDLE` specifically) is active, this independently
 * recomputes the RAW, un-clamped drag position from the same
 * `payload.translationY` the library itself receives (not the library's own
 * `animatedPosition`, which the default handler clamps to the highest snap
 * point once a drag continues past it — reading the clamped value would
 * make it impossible to tell "just reached 50%" from "dragged 300px past
 * 50%"). Whatever that raw position sits BEYOND the highest configured snap
 * point becomes `expandProgress`, linearly, over `expandDragDistance`
 * pixels — a true 1:1 finger-tracked feel, deliberately NOT the library's
 * own `enableOverDrag` (a small resisted rubber-band meant for a few pixels
 * of "give," tuned nowhere near usable for spanning another half a screen —
 * confirmed by reading its resistance formula in
 * `useGestureEventsHandlersDefault.tsx`). `enableOverDrag` is intentionally
 * left OFF: with it off, the library clamps `animatedPosition` to the
 * highest snap point for the whole time this file's own math is in the
 * overdrag range, which is exactly what's wanted — the real sheet sits
 * rock-still at 50%, visually, while `ExpandedTextOverlay` grows on top
 * of it.
 *
 * On release, if the raw drag ever went past 50% at all
 * (`expandProgress > 0`), this decides independently — a fast upward flick,
 * or having crossed the halfway mark — whether to spring `expandProgress`
 * the rest of the way to 1 (and report `onExpandSettle(true)`) or back to 0
 * (`onExpandSettle(false)`), via the library's own `onExpandSettle` doc
 * comment contract). The real sheet's OWN release logic (`defaultOnEnd`,
 * called regardless, unmodified) always settles back to one of ITS OWN
 * configured snap points — never higher than 50% — completely independent
 * of whatever this file just decided for `expandProgress`.
 */
export function createExpandOverdragGestureHandlersHook({
  expandProgress,
  expandDragDistance,
  onExpandSettle,
}: ExpandOverdragGestureHandlersParams): GestureEventsHandlersHookType {
  return function useExpandOverdragGestureHandlers() {
    const {
      handleOnStart: defaultOnStart,
      handleOnChange: defaultOnChange,
      handleOnEnd: defaultOnEnd,
      handleOnFinalize: defaultOnFinalize,
    } = useGestureEventsHandlersDefault();
    const { animatedPosition, animatedDetentsState } = useBottomSheetInternal();

    // Where THIS drag started, captured independently of the library's own
    // private start-position bookkeeping (a closed-over value inside
    // `useGestureEventsHandlersDefault.tsx`, not exposed via
    // `useBottomSheetInternal`) — duplicating just this one field is simpler
    // and safer than trying to reach into that private state.
    const dragStartPosition = useSharedValue(0);

    const handleOnStart: GestureEventHandlerCallbackType = useCallback(
      (source, payload) => {
        "worklet";
        if (source === GESTURE_SOURCE.HANDLE) {
          dragStartPosition.value = animatedPosition.value;
        }
        defaultOnStart(source, payload);
      },
      [defaultOnStart, animatedPosition, dragStartPosition]
    );

    const handleOnChange: GestureEventHandlerCallbackType = useCallback(
      (source, payload) => {
        "worklet";
        defaultOnChange(source, payload);
        if (source === GESTURE_SOURCE.HANDLE) {
          const highestSnapPoint = animatedDetentsState.value.highestDetentPosition;
          if (highestSnapPoint !== undefined) {
            const rawDraggedPosition = dragStartPosition.value + payload.translationY;
            const overdragPx = Math.max(0, highestSnapPoint - rawDraggedPosition);
            expandProgress.value = Math.min(1, overdragPx / expandDragDistance);
          }
        }
      },
      [defaultOnChange, animatedDetentsState, dragStartPosition, expandProgress]
    );

    const handleOnEnd: GestureEventHandlerCallbackType = useCallback(
      (source, payload) => {
        "worklet";
        if (source === GESTURE_SOURCE.HANDLE) {
          const settledProgress = expandProgress.value;
          // Only ever fires for a drag that genuinely entered the overdrag
          // range at all — an ordinary 20%-50% release (`settledProgress`
          // still exactly 0) leaves `expandProgress`/`onExpandSettle`
          // untouched, since there's nothing to settle.
          if (settledProgress > 0) {
            const flickOpen = payload.velocityY <= -FLICK_VELOCITY_THRESHOLD;
            const shouldExpand = flickOpen || settledProgress >= 0.5;
            expandProgress.value = withSpring(shouldExpand ? 1 : 0, SETTLE_SPRING);
            runOnJS(onExpandSettle)(shouldExpand);
          }
        }
        defaultOnEnd(source, payload);
      },
      [defaultOnEnd, expandProgress]
    );

    const handleOnFinalize: GestureEventHandlerCallbackType = useCallback(
      (source, payload) => {
        "worklet";
        defaultOnFinalize(source, payload);
      },
      [defaultOnFinalize]
    );

    return { handleOnStart, handleOnChange, handleOnEnd, handleOnFinalize };
  };
}
