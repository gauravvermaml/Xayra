import { Pressable, StyleSheet, View } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";

export type ExpandedTextOverlayProps = {
  /** Device's safe-area top inset — pads the box's own top edge so it
   * stops softly below the status bar, matching the original spec's intent
   * for the 88% "expanded" stage. */
  topInset: number;
  /** Device's safe-area bottom inset — pads the box's own bottom edge so it
   * stops just above the Android nav bar rather than running under it. */
  bottomInset: number;
  onClose: () => void;
  /** Whichever list (Recorded notes or Searched notes) is currently active
   * — rendered as a fresh element here, independent of HistorySheet's own
   * copy of the same content (see this file's own doc comment for why). */
  children: React.ReactNode;
};

/**
 * MONOCHROMATIC GLASS — FULL-SCREEN EXPANDED STAGE.
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
 * since this overlay is opaque and covers the whole screen, nothing about
 * that matters visually. This also directly satisfies two related asks:
 * the compose bar and drag handle (both owned by the sheet) are structurally
 * impossible to see here since they're a different component entirely, and
 * a `flex: 1` box inside a plain (non-bottom-sheet) container tracks its
 * real parent height on every frame with no library-imposed ceiling — it
 * genuinely fills from just below the status bar to just above the nav bar.
 */
export function ExpandedTextOverlay({ topInset, bottomInset, onClose, children }: ExpandedTextOverlayProps) {
  return (
    <Animated.View entering={FadeIn.duration(200)} exiting={FadeOut.duration(150)} style={styles.overlay}>
      <View style={[styles.box, { marginTop: topInset + 16, marginBottom: bottomInset + 16 }]}>
        <Pressable onPress={onClose} hitSlop={8} style={styles.microChip}>
          <Feather name="x" size={18} color="#E2E8F0" />
        </Pressable>
        {/* CHIP CLEARANCE: same fixed offset (chip's own 44px bottom edge +
            a 12px gap) as HistorySheet's own idle-stage box, so the gap
            between the chip and the first card reads identically whether
            the box is at its 50% or its fully expanded stage. */}
        <View style={styles.listClearance}>{children}</View>
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
    paddingTop: 40,
  },
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
    zIndex: 10,
  },
});
