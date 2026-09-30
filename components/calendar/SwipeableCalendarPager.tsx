import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { InteractionManager, StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { stepSelectedDate, type CalendarLayoutMode } from "../../services/calendar/dateRange";

/** Same feel as CalendarBody's own plain "jump on release" swipe (used by
 * Week/Work Week/Month — see its doc comment for why those don't use this
 * component): either threshold alone commits the page turn. */
const SWIPE_TRANSLATION_THRESHOLD = 50;
const SWIPE_VELOCITY_THRESHOLD = 400;
const SETTLE_SPRING = { damping: 26, stiffness: 260, mass: 0.9 };
const COMMIT_DURATION = 220;
/** The window always keeps exactly the previous/current/next page mounted
 * (offsets -1/0/1) — see this file's own top doc comment for why a wider
 * buffer isn't needed for v1. */
const MIN_OFFSET = -1;
const MAX_OFFSET = 1;

type MountedPage = { date: string; offset: number };

/** Stable reference for non-current panes' `onScrollYChange` — see
 * `PageScrollSync`'s own doc comment for why only the current page ever
 * needs a real one. */
function NOOP_SCROLL_CHANGE(): void {}

function initialWindow(mode: CalendarLayoutMode, selectedDate: string): MountedPage[] {
  return [
    { date: stepSelectedDate(mode, selectedDate, -1), offset: -1 },
    { date: selectedDate, offset: 0 },
    { date: stepSelectedDate(mode, selectedDate, 1), offset: 1 },
  ];
}

/** Shifts every mounted page's offset by `-delta` (delta = +1 for a forward
 * commit, -1 for a backward one) and drops anything that falls outside the
 * [-1, 1] window — see this file's own top doc comment for the full
 * reasoning. The page that lands on offset 0 after a forward commit is
 * always the SAME entry that was already sitting at offset 1 a moment
 * earlier — already mounted, already committed, zero new native cost. */
function shiftWindow(pages: MountedPage[], delta: number): MountedPage[] {
  return pages.map((page) => ({ ...page, offset: page.offset - delta })).filter((page) => page.offset >= MIN_OFFSET && page.offset <= MAX_OFFSET);
}

/** Passed to `renderPage` for every mounted page — lets Day/Week/Work Week
 * (the only layouts with an hourly vertical scroll) share ONE scroll
 * position across pages instead of each independently defaulting to
 * "an hour before now." See `renderPage`'s own doc comment below for why
 * this exists. Month has no comparable per-time-of-day scroll, so its
 * `renderGridForDate` branch in CalendarBody.tsx just ignores this. */
export type PageScrollSync = {
  /** `null` until the user has actually scrolled a page — until then, each
   * page keeps using its own wall-clock-based default, which all start in
   * agreement anyway (same formula, same clock) so there's nothing to
   * override yet. */
  initialScrollY: number | null;
  /** Only ever wired up for the CURRENT (offset 0) page — see the render
   * body below. Neighbor/preview panes are non-interactive
   * (`pointerEvents="none"`) and could never generate a real scroll event
   * to report anyway. */
  onScrollYChange: (y: number) => void;
};

export type SwipeableCalendarPagerProps = {
  mode: CalendarLayoutMode;
  selectedDate: string;
  onNext: () => void;
  onPrevious: () => void;
  /** Renders one REAL page for an arbitrary date — always real, never an
   * approximation. Must be a pure function of `pageSelectedDate` (no
   * reliance on the outer `selectedDate`) so a mounted neighbor page keeps
   * showing correct content no matter when its own commit happens relative
   * to the user's current position.
   *
   * `scrollSync`: live on-device report — swiping to a new Week/Work
   * Week/Day page reset the vertical scroll to "an hour before now" instead
   * of keeping whatever time-of-day the user had been looking at (e.g.
   * scrolled to 6 PM, swipe forward, land back at the morning). Root cause:
   * this pager's keyed window means a genuinely NEW page (one never mounted
   * before) is a fresh component instance with its own fresh default — the
   * OLD, pre-rewrite architecture never had this problem because the
   * "current" page was always the SAME persisted instance across date
   * changes, so its own scroll position simply never reset. `scrollSync`
   * restores that behavior explicitly: the current page reports its scroll
   * position up via `onScrollYChange`, and any newly-mounted page (a brand
   * new neighbor entering the window, or a full resync after an arrow tap)
   * is handed that same value as its own starting position instead of
   * recomputing "now" independently. */
  renderPage: (pageSelectedDate: string, scrollSync: PageScrollSync) => ReactNode;
  /** Fires continuously while dragging (and while a commit/cancel animation
   * is still resolving) with the REAL date of whichever page is currently
   * more than halfway across the frame, or `null` while still mostly on the
   * current page. CalendarBody uses this to keep CalendarDateNavigator's
   * own date/month label in sync with whatever is actually visible
   * mid-drag, instead of only updating once the swipe fully commits — live
   * user correction: the header previously only ever reflected the
   * committed `selectedDate`, so it visibly lagged behind the grid content
   * it sits directly above, which already tracks the finger continuously.
   *
   * Reports an actual date string, not a relative offset for the caller to
   * re-derive against its own `selectedDate` — a first version did exactly
   * that (`-1 | 0 | 1`) and it produced two live, on-device bugs at once:
   * the sign was inverted relative to drag direction (dragging toward the
   * previous month, partway through, showed the label for the NEXT month
   * instead), and independently, a one-frame race between `selectedDate`
   * updating and the offset resetting to 0 made the header flash the wrong
   * month right at landing. Reporting the real date read directly off the
   * already-mounted target page removes both bug classes by construction:
   * there's no sign to get backwards, and if the reset lags by a frame
   * after commit, the stale value is simply the SAME date `selectedDate`
   * just became, not a wrong one. */
  onPreviewChange?: (date: string | null) => void;
};

/**
 * Continuous 1:1-finger-tracking swipe between calendar pages, used for all
 * four grid views (Day/Work Week/Week/Month).
 *
 * SECOND real architecture for Week/Work Week/Month (Day was always this
 * simple — three real pages, permanently mounted, cheap enough that keeping
 * them alive was never the issue). History, because it matters for anyone
 * touching this again:
 *
 *  1. First attempt: all three panes always real, for every mode. Reverted
 *     to Day-only after live timing showed WeekGridLayout's/MonthLayout's
 *     own native commit cost (~500ms on this hardware) made three
 *     simultaneous real mounts per commit visibly janky.
 *  2. Ghost-preview era: a lightweight, hand-matched visual stand-in
 *     (CalendarGhostPage.tsx, since deleted) stood in for the neighbor
 *     panes, with only the CURRENT page ever real. This produced FIVE
 *     rounds of "one element doesn't match the real thing" bugs (geometry,
 *     scroll offset, dots, `isToday`, task chips, selection circles) — an
 *     unbounded audit surface, because there were structurally TWO
 *     different representations of the same page that had to be kept
 *     hand-in-sync forever.
 *  3. Live adb-logcat timing (one swipe traced end to end, real numbers,
 *     not guesses) found the ACTUAL remaining lag wasn't the ghost/real
 *     swap's visual mismatch at all: it was that the real page for the
 *     TARGET date didn't start mounting until `onNext`/`onPrevious` fired
 *     (i.e. after the drag's own 220ms settle animation had already
 *     finished) — a ~500-600ms native commit paid entirely AFTER the user
 *     released their finger, which is what read as "header/reminders/
 *     highlighting all pop in late" and "flickers on landing." A separate,
 *     also-real bug compounded this: the header-preview mechanism below
 *     was, before a `React.memo` fix (see CalendarBody.tsx's
 *     `renderGridForDate`), causing the ALREADY-SETTLED on-screen page to
 *     needlessly re-render and re-commit too — confirmed fixed via the same
 *     trace method (three render cascades per swipe down to one), but the
 *     ~500-600ms real-mount-at-commit-time cost remained, because it's
 *     structural, not a rendering bug.
 *  4. THIS version: no ghosts at all. A small keyed window of ALWAYS-REAL
 *     pages (`MountedPage[]`, keyed by date) is kept mounted at all times.
 *     Critically, the page that becomes the new CURRENT page after a commit
 *     is never a fresh mount — it's the exact same persisted component
 *     instance that was already sitting, fully committed, at the adjacent
 *     offset a moment before (see `shiftWindow` above). The only new native
 *     work a commit ever triggers is mounting the BRAND NEW far edge that
 *     enters the window — and that page is positioned off-screen and its
 *     mount is deferred via `InteractionManager.runAfterInteractions` (see
 *     the effect below), so its cost is paid during the user's own idle
 *     dwell time between swipes, not on the gesture that would otherwise be
 *     blocked by it. Because every page is now genuinely the real
 *     component, there is no second representation to keep in sync —
 *     the "does this element match the real one" audit problem is closed
 *     by construction, not by chasing one more mismatch.
 *
 *     Trade-off, accepted deliberately: swiping fast enough, repeatedly, to
 *     outrun the deferred mount (i.e. before its `runAfterInteractions`
 *     callback has had a chance to run) can still show a brief blank pane
 *     for that one over-hasty extra swipe. This is a rare edge case, not the
 *     common path — worth confirming on-device, not worth a wider
 *     pre-mounted buffer unless real usage actually hits it.
 *
 * The reset-to-zero on commit is deliberately a `useLayoutEffect` keyed on
 * the `selectedDate` PROP, not inline in the gesture's completion callback.
 * If `translateX` were reset the moment `onNext`/`onPrevious` fires, there'd
 * be one visible frame where the transform is back at 0 but the window's
 * offsets hadn't shifted yet (React hasn't re-rendered with the shifted
 * window yet) — a flash back to the previous page before snapping forward
 * again. Instead, the transform stays parked at the fully-swiped position
 * (showing what was already the correct next/previous page's content)
 * until `selectedDate` itself actually changes; only then does this effect
 * fire and reset the transform, at which point the window has already
 * shifted so the page now at offset 0 is the same content, so the reset is
 * invisible.
 *
 * Side panes render with `pointerEvents="none"` — they're previews only,
 * never meant to receive taps while mid-drag or at rest.
 *
 * Wrapped in `React.memo`: this component's parent (CalendarBody) also owns
 * `previewOffset` state that this pager itself drives (via
 * `onPreviewChange`, below) purely to update the date-header label live
 * during a drag. Without this memo, every one of THIS component's own
 * `onPreviewChange` calls would re-render CalendarBody, which would in turn
 * re-render this component and its entire page subtree — see point 3 above,
 * this is the bug that fix closed. With this memo plus `renderGridForDate`
 * itself being a stable `useCallback` in CalendarBody, a `previewOffset`
 * update only touches CalendarDateNavigator — this component's props never
 * actually change because of it, so React skips re-rendering it and
 * everything below entirely.
 */
export const SwipeableCalendarPager = memo(function SwipeableCalendarPager({
  mode,
  selectedDate,
  onNext,
  onPrevious,
  renderPage,
  onPreviewChange,
}: SwipeableCalendarPagerProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const [mountedPages, setMountedPages] = useState<MountedPage[]>(() => initialWindow(mode, selectedDate));
  // Tracks the last `selectedDate` this component has resynced `mountedPages`
  // for — see the render-time check below for why this exists at all.
  const [syncedDate, setSyncedDate] = useState(selectedDate);
  // A plain ref, not state — see `PageScrollSync`'s own doc comment. Only
  // ever needs to be READ at the moment a new page mounts (itself a state
  // update, which already re-renders), so writing to it on every scroll
  // tick must not itself trigger a re-render.
  const lastScrollYRef = useRef<number | null>(null);
  const handleScrollYChange = useCallback((y: number) => {
    lastScrollYRef.current = y;
  }, []);
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const widthShared = useSharedValue(0);

  useLayoutEffect(() => {
    translateX.value = 0;
  }, [selectedDate, translateX]);

  // Keeps `mountedPages` correctly centered on `selectedDate` no matter WHY
  // it changed. A gesture-driven commit already guarantees this (see
  // `shiftWindow`: the entry that lands on offset 0 is exactly
  // `stepSelectedDate(mode, oldSelectedDate, ±1)`, the same value the
  // parent computes for its own `selectedDate` update) — for that case the
  // check below is a same-reference no-op. But `selectedDate` can also
  // change WITHOUT ever going through this component's own gesture at all —
  // the header's own prev/next arrow buttons and "Today" call `onNext`/
  // `onPrevious`/`onSelectDate` directly, bypassing the swipe entirely. Live
  // on-device report: arrow taps in Week/Work Week updated the header label
  // but left the grid showing the old range for a visible beat before
  // catching up. A full resync (not a ±1 shift, since "Today" can jump by an
  // arbitrary number of pages) is required either way.
  //
  // This runs DURING RENDER, not in a `useEffect` — deliberately. A first
  // version did this resync in an effect, which only fires AFTER the header
  // (driven directly by the `selectedDate` prop, no window to resync) has
  // already committed and painted — live on-device, that showed as exactly
  // the reported delay: header changes instantly, grid catches up a beat
  // later once the effect fires and its own re-render (plus the one
  // genuinely new page's real mount) completes. Calling `setState`
  // synchronously in the render body, guarded by `syncedDate` so it only
  // fires once per actual `selectedDate` change, is React's own documented
  // pattern for this — React re-renders immediately with the corrected
  // state before anything paints, so the header and the grid land in the
  // SAME commit instead of two visibly separate ones.
  if (selectedDate !== syncedDate) {
    setSyncedDate(selectedDate);
    setMountedPages((prev) => {
      const current = prev.find((page) => page.offset === 0);
      if (current && current.date === selectedDate) {
        return prev;
      }
      return initialWindow(mode, selectedDate);
    });
  }

  // Backfills whichever of offset -1/1 the last commit's shift dropped off
  // the far edge — see `shiftWindow` and this file's own top doc comment.
  // Deferred via `runAfterInteractions` so this new page's real native
  // mount cost lands during idle time between swipes, never blocking the
  // gesture/settle animation that's still resolving when this effect first
  // fires right after a commit.
  useEffect(() => {
    const haveOffsets = new Set(mountedPages.map((page) => page.offset));
    const missingOffsets = ([MIN_OFFSET, MAX_OFFSET] as const).filter((offset) => !haveOffsets.has(offset));
    if (missingOffsets.length === 0) {
      return;
    }
    const task = InteractionManager.runAfterInteractions(() => {
      setMountedPages((prev) => {
        const existingDates = new Set(prev.map((page) => page.date));
        const additions = missingOffsets
          .map((offset) => ({ offset, date: stepSelectedDate(mode, selectedDate, offset) }))
          .filter((page) => !existingDates.has(page.date));
        return additions.length > 0 ? [...prev, ...additions] : prev;
      });
    });
    return () => task.cancel();
  }, [mountedPages, mode, selectedDate]);

  const handleCommitNext = useCallback(() => {
    setMountedPages((prev) => shiftWindow(prev, 1));
    onNext();
  }, [onNext]);

  const handleCommitPrevious = useCallback(() => {
    setMountedPages((prev) => shiftWindow(prev, -1));
    onPrevious();
  }, [onPrevious]);

  // Looks up the REAL date of whichever mounted page sits at `offset` — see
  // `onPreviewChange`'s own doc comment above for why this reports an
  // actual date rather than the raw offset itself. `mountedPages` is closed
  // over from render scope; this is only ever invoked via `runOnJS` from
  // the worklet below, so it always runs on the JS thread where that's safe
  // to read.
  const notifyPreview = (offset: -1 | 0 | 1) => {
    if (offset === 0) {
      onPreviewChange?.(null);
      return;
    }
    const page = mountedPages.find((entry) => entry.offset === offset);
    onPreviewChange?.(page ? page.date : null);
  };

  // Continuously derives which page is more than halfway visible from the
  // SAME `translateX`/`widthShared` the drag/commit animation already
  // drives — no separate gesture logic, just watching the one value that
  // already represents "how far across the frame are we." Fires through
  // BOTH an active drag and the commit/cancel animation's own settle, so
  // the header flips in step with the visual motion rather than waiting for
  // the formal `onNext`/`onPrevious` commit at the very end of it.
  //
  // Sign matches `mountedPages`' own offset convention (+1 = next, -1 =
  // previous), not "which way did translateX move" naively — `commitNext`
  // drives translateX NEGATIVE to bring the offset=+1 (next) page into
  // view, so a negative translateX crossing the halfway mark means the
  // NEXT page is what's now showing, hence `return 1` there (and
  // symmetrically `return -1` for the positive/previous case). An earlier
  // version had these two swapped — worked fine for the drag itself (which
  // never reads this value), but fed CalendarBody's date-preview logic the
  // exact opposite direction, live-reported: dragging toward the previous
  // month showed the NEXT month's label partway through.
  useAnimatedReaction(
    () => {
      "worklet";
      const width = widthShared.value;
      if (width <= 0) {
        return 0;
      }
      if (translateX.value <= -width / 2) {
        return 1;
      }
      if (translateX.value >= width / 2) {
        return -1;
      }
      return 0;
    },
    (current, previous) => {
      if (current !== previous) {
        runOnJS(notifyPreview)(current as -1 | 0 | 1);
      }
    }
  );

  const handleLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    widthShared.value = width;
    setContainerWidth(width);
  };

  // `activeOffsetX`/`failOffsetY` unchanged from the old CalendarBody
  // gesture — see its prior doc comment: lets a horizontal drag coexist
  // with each page's own vertical ScrollView and any nested task-card taps.
  const panGesture = Gesture.Pan()
    .activeOffsetX([-20, 20])
    .failOffsetY([-15, 15])
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((event) => {
      translateX.value = startX.value + event.translationX;
    })
    .onEnd((event) => {
      const width = widthShared.value;
      if (width <= 0) {
        translateX.value = withSpring(0, SETTLE_SPRING);
        return;
      }
      const commitNext = event.translationX <= -SWIPE_TRANSLATION_THRESHOLD || event.velocityX <= -SWIPE_VELOCITY_THRESHOLD;
      const commitPrevious = event.translationX >= SWIPE_TRANSLATION_THRESHOLD || event.velocityX >= SWIPE_VELOCITY_THRESHOLD;
      if (commitNext) {
        translateX.value = withTiming(-width, { duration: COMMIT_DURATION }, (finished) => {
          if (finished) runOnJS(handleCommitNext)();
        });
      } else if (commitPrevious) {
        translateX.value = withTiming(width, { duration: COMMIT_DURATION }, (finished) => {
          if (finished) runOnJS(handleCommitPrevious)();
        });
      } else {
        translateX.value = withSpring(0, SETTLE_SPRING);
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <GestureDetector gesture={panGesture}>
      <View style={styles.frame} onLayout={handleLayout}>
        <Animated.View style={[styles.track, animatedStyle]}>
          {containerWidth > 0 ? (
            mountedPages.map(({ date, offset }) => (
              <View
                key={date}
                pointerEvents={offset === 0 ? undefined : "none"}
                style={[styles.page, { width: containerWidth, left: offset * containerWidth }]}
              >
                {renderPage(date, {
                  initialScrollY: lastScrollYRef.current,
                  onScrollYChange: offset === 0 ? handleScrollYChange : NOOP_SCROLL_CHANGE,
                })}
              </View>
            ))
          ) : (
            <View style={styles.fallbackPage}>
              {renderPage(selectedDate, { initialScrollY: lastScrollYRef.current, onScrollYChange: handleScrollYChange })}
            </View>
          )}
        </Animated.View>
      </View>
    </GestureDetector>
  );
});

const styles = StyleSheet.create({
  frame: {
    flex: 1,
    overflow: "hidden",
  },
  track: {
    flex: 1,
    position: "relative",
  },
  page: {
    position: "absolute",
    top: 0,
    bottom: 0,
  },
  // Used only for the one frame before the first `onLayout` measurement
  // lands — lets the current page render immediately at mount instead of
  // waiting on a measured width to render at all.
  fallbackPage: {
    flex: 1,
  },
});
