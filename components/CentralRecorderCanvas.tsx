import { useEffect } from "react";
import { Dimensions, Image, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { colors } from "../constants/theme";

export type RecorderCanvasState = "idle" | "recording" | "transcribing";

export type CentralRecorderCanvasProps = {
  state: RecorderCanvasState;
  /** Live 0..1 RMS amplitude from the microphone (recorder.amplitude) — only
   * read while `state === "recording"`; ignored otherwise. */
  amplitude: number;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
};

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const WAVEFORM_WIDTH = SCREEN_WIDTH * 0.5;
const BAR_COUNT = 28;
const BAR_WIDTH = 3;
const MIN_BAR_HEIGHT = 2;
const MAX_BAR_HEIGHT = 34;

/** One bar of the waveform. All three states are driven by the same pair of
 * shared values (`amplitude`, `pulsePhase`) rather than each bar owning its
 * own animation loop — cheaper, and keeps every bar's motion visually in
 * sync with its neighbors. */
function WaveformBar({
  index,
  state,
  amplitude,
  pulsePhase,
}: {
  index: number;
  state: RecorderCanvasState;
  amplitude: SharedValue<number>;
  pulsePhase: SharedValue<number>;
}) {
  // A fixed per-bar phase offset so State A→B doesn't animate every bar to
  // the exact same height — real mic amplitude modulates a gentle sine
  // curve across the bars instead of a flat block, reading as a waveform
  // rather than a single pulsing rectangle.
  const phaseOffset = (index / BAR_COUNT) * Math.PI * 2;

  const animatedStyle = useAnimatedStyle(() => {
    if (state === "recording") {
      const wave = (Math.sin(phaseOffset) + 1) / 2; // 0..1, stable per bar
      const height =
        MIN_BAR_HEIGHT + amplitude.value * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT) * (0.35 + 0.65 * wave);
      return { height, opacity: 1 };
    }
    if (state === "transcribing") {
      // Traveling pulse: a bright band sweeps left-to-right across the line
      // once every loop, each bar brightening/growing as the band passes it.
      const distance = Math.abs(((index / (BAR_COUNT - 1)) - pulsePhase.value + 1) % 1);
      const proximity = interpolate(distance, [0, 0.12, 1], [1, 0.15, 0], "clamp");
      return {
        height: MIN_BAR_HEIGHT + proximity * (MAX_BAR_HEIGHT * 0.55 - MIN_BAR_HEIGHT),
        opacity: 0.35 + proximity * 0.65,
      };
    }
    // Idle: flat line.
    return { height: MIN_BAR_HEIGHT, opacity: 0.5 };
  });

  return <Animated.View style={[styles.bar, animatedStyle]} />;
}

/**
 * Apple-Maps-canvas center control: a perfectly round button over a
 * jet-black background, with a 50%-screen-width waveform line below it that
 * reflects the current recording pipeline state — shared by both a manual
 * tap and Active Mode's hands-free loop (see app/index.tsx), so the two
 * never show a different visual state for the same underlying pipeline.
 *
 * Build 23: the plain white disc is now the Xayra logo (`assets/xayra-
 * logo.png`) — see the `button`/`buttonLogo` styles below for how it's
 * cropped to fit the circle.
 */
export function CentralRecorderCanvas({
  state,
  amplitude,
  onPress,
  onLongPress,
  disabled,
}: CentralRecorderCanvasProps) {
  const amplitudeShared = useSharedValue(0);
  const pulsePhase = useSharedValue(0);

  useEffect(() => {
    amplitudeShared.value = withTiming(state === "recording" ? amplitude : 0, { duration: 80 });
  }, [amplitude, state, amplitudeShared]);

  useEffect(() => {
    if (state === "transcribing") {
      pulsePhase.value = 0;
      pulsePhase.value = withRepeat(
        withTiming(1, { duration: 1400, easing: Easing.linear }),
        -1,
        false
      );
    } else {
      pulsePhase.value = 0;
    }
  }, [state, pulsePhase]);

  const buttonScaleStyle = useAnimatedStyle(() => ({
    transform: [{ scale: state === "recording" ? 1 + amplitudeShared.value * 0.06 : 1 }],
  }));

  return (
    <View style={styles.wrapper}>
      {/* 3D elevated rim: a slightly larger, darker-edged disc sitting behind
          the flat white button reads as a raised bezel without needing a
          gradient library — the rim's own drop shadow plus a subtle inset
          highlight ring is what sells the "tactile" depth. */}
      <View style={styles.rim}>
        <Animated.View style={buttonScaleStyle}>
          <Pressable
            onPress={onPress}
            onLongPress={onLongPress}
            disabled={disabled}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            style={({ pressed }) => [
              styles.button,
              // Build 23: with the logo image filling the button, this tint
              // now shows only as a ring/wash behind and around the image's
              // own edges (the image itself doesn't recolor) — still a real,
              // visible recording-state signal, just a more subtle one than
              // it was against a plain white disc.
              state === "recording" && styles.buttonRecording,
              // Build 20: `disabled` is also true while transcribing/
              // classifying (see app/index.tsx's `processingState`), but the
              // button should keep its full-strength look through that state
              // rather than dimming — the waveform's own traveling pulse
              // (CentralRecorderCanvas's "transcribing" branch) is what
              // communicates "working" here, not opacity. The opacity dim is
              // reserved for other disabled reasons (recorder.isTransitioning
              // while otherwise idle).
              disabled && state !== "transcribing" && styles.buttonDisabled,
              pressed && styles.buttonPressed,
            ]}
          >
            {/* Build 23 REPLACE WHITE CENTRAL BUTTON WITH XAYRA LOGO ASSET:
                the source file (assets/xayra-logo.png) is landscape
                (971×602) with the emblem+wordmark centered — `cover` scales
                it to fill this circle vertically and center-crops the
                leftover horizontal padding symmetrically, which keeps the
                emblem and the "Xayra" text beneath it both fully intact
                (they occupy the image's full height) while filling the
                button edge-to-edge with no letterboxing. `button`'s own
                `overflow: "hidden"` + `borderRadius` is what actually clips
                this rectangular image into a circle. */}
            <Image source={require("../assets/xayra-logo.png")} style={styles.buttonLogo} resizeMode="cover" />
          </Pressable>
        </Animated.View>
      </View>

      {/* States A (idle) and D (complete) are both just "not currently doing
          anything" from this component's point of view — the waveform row
          isn't rendered at all for either, not merely flattened, so the
          canvas shows only the button when there's nothing live to show. */}
      {state !== "idle" && (
        <View style={styles.waveform} pointerEvents="none">
          {Array.from({ length: BAR_COUNT }).map((_, index) => (
            <WaveformBar key={index} index={index} state={state} amplitude={amplitudeShared} pulsePhase={pulsePhase} />
          ))}
        </View>
      )}
    </View>
  );
}

// 1.3x over the button's previous ~70dp core.
const BUTTON_SIZE = 90;
const RIM_SIZE = Math.round(BUTTON_SIZE * 1.2);

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
    gap: 18,
  },
  rim: {
    width: RIM_SIZE,
    height: RIM_SIZE,
    borderRadius: RIM_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0A0A0A",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.14)",
    shadowColor: "#000000",
    shadowOpacity: 0.9,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 14,
  },
  button: {
    width: BUTTON_SIZE,
    height: BUTTON_SIZE,
    borderRadius: BUTTON_SIZE / 2,
    // Build 23: was solid white behind the old plain disc; now sits behind
    // the logo image as a fallback color for the brief gap before it loads,
    // and shows at the button's very edge if the image's own cover-crop
    // ever leaves a sub-pixel seam. Matches the app's own accent color
    // rather than white, both because the logo asset's own background is a
    // purple similar to this and because a white ring is no longer the
    // button's identity — the logo is.
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    // Required to actually clip the rectangular <Image> below into this
    // circle — without it, RN doesn't apply the parent's borderRadius as a
    // clip mask to children by default.
    overflow: "hidden",
    shadowColor: colors.accent,
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 0 },
  },
  buttonLogo: {
    width: "100%",
    height: "100%",
  },
  buttonRecording: {
    backgroundColor: colors.danger,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  buttonPressed: {
    opacity: 0.9,
  },
  waveform: {
    width: WAVEFORM_WIDTH,
    height: MAX_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: BAR_WIDTH / 2,
    backgroundColor: "#FFFFFF",
  },
});
