import { useLayoutEffect, useState, type ReactNode } from "react";
import { StyleSheet, View, type LayoutChangeEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming } from "react-native-reanimated";

import { stepSelectedDate, type CalendarLayoutMode } from "../../services/calendar/dateRange";

/** Same feel as CalendarBody's own plain "jump on release" swipe (used by
 * Week/Work Week/Month — see its doc comment for why those don't use this
 * component): either threshold alone commits the page turn. */
const SWIPE_TRANSLATION_THRESHOLD = 50;
const SWIPE_VELOCITY_THRESHOLD = 400;
const SETTLE_SPRING = { damping: 26, stiffness: 260, mass: 0.9 };
const COMMIT_DURATION = 220;

export type SwipeableCalendarPagerProps = {
  mode: CalendarLayoutMode;
  selectedDate: string;
  onNext: () => void;
  onPrevious: () => void;
  /** Renders one full page for an arbitrary date — called for the current
   * page and for the permanently-mounted previous/next panes. Must be a
   * pure function of its date argument (no reliance on outer `selectedDate`)
   * so the neighboring panes are real, correctly-dated content rather than
   * copies of the current page. */
  renderPage: (pageSelectedDate: string) => ReactNode;
};

/**
 * Continuous 1:1-finger-tracking swipe between calendar pages — currently
 * used for Day view only (see CalendarBody.tsx's own doc comment for why
 * Week/Work Week/Month use a plain jump-on-release swipe instead: their
 * real layouts measured at ~500ms of native render cost per page on this
 * hardware, a pre-existing cost unrelated to this component, that a
 * continuous drag's promise of instant continuity made newly obvious).
 *
 * The previous/current/next pages are all permanently mounted — device-
 * tested fine for Day's single-column hourly layout (cheap enough that
 * keeping three alive at once and updating them on every commit is no
 * different in cost from the old single-page `onNext`/`onPrevious`
 * navigation this replaces).
 *
 * The reset-to-zero on commit is deliberately a `useLayoutEffect` keyed on
 * the `selectedDate` PROP, not inline in the gesture's completion callback.
 * If `translateX` were reset the moment `onNext`/`onPrevious` fires, there'd
 * be one visible frame where the transform is back at 0 but the "current"
 * slot's props still reflect the OLD date (React hasn't re-rendered with
 * the new `selectedDate` yet) — a flash back to the previous page before
 * snapping forward again. Instead, the transform stays parked at the fully-
 * swiped position (showing what was already the correct next/previous
 * page's content) until `selectedDate` itself actually changes; only then
 * does this effect fire and reset the transform, at which point the
 * "current" slot has already re-rendered with that same content, so the
 * reset is invisible.
 *
 * Side panes render with `pointerEvents="none"` — they're previews only,
 * never meant to receive taps while mid-drag or at rest.
 */
export function SwipeableCalendarPager({ mode, selectedDate, onNext, onPrevious, renderPage }: SwipeableCalendarPagerProps) {
  const [containerWidth, setContainerWidth] = useState(0);
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);
  const widthShared = useSharedValue(0);

  useLayoutEffect(() => {
    translateX.value = 0;
  }, [selectedDate, translateX]);

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
          if (finished) runOnJS(onNext)();
        });
      } else if (commitPrevious) {
        translateX.value = withTiming(width, { duration: COMMIT_DURATION }, (finished) => {
          if (finished) runOnJS(onPrevious)();
        });
      } else {
        translateX.value = withSpring(0, SETTLE_SPRING);
      }
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const previousDate = stepSelectedDate(mode, selectedDate, -1);
  const nextDate = stepSelectedDate(mode, selectedDate, 1);

  return (
    <GestureDetector gesture={panGesture}>
      <View style={styles.frame} onLayout={handleLayout}>
        <Animated.View style={[styles.track, animatedStyle]}>
          {containerWidth > 0 && (
            <View pointerEvents="none" style={[styles.page, { width: containerWidth, left: -containerWidth }]}>
              {renderPage(previousDate)}
            </View>
          )}
          <View style={containerWidth > 0 ? [styles.page, { width: containerWidth, left: 0 }] : styles.fallbackPage}>
            {renderPage(selectedDate)}
          </View>
          {containerWidth > 0 && (
            <View pointerEvents="none" style={[styles.page, { width: containerWidth, left: containerWidth }]}>
              {renderPage(nextDate)}
            </View>
          )}
        </Animated.View>
      </View>
    </GestureDetector>
  );
}

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
