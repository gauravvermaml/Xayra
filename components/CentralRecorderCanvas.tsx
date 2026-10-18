import { useEffect } from "react";
import { Dimensions, Image, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  interpolate,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import * as Haptics from "expo-haptics";

import { Orbit } from "./ui/Orbit";
import { xayraColors } from "../constants/xayraTheme";

export type RecorderCanvasState = "idle" | "listening" | "recording" | "transcribing";

export type CentralRecorderCanvasProps = {
  state: RecorderCanvasState;
  /** Live 0..1 RMS amplitude from the microphone (recorder.amplitude) — only
   * read while `state === "recording"`; ignored otherwise. */
  amplitude: number;
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  /** The emblem zone's current size in dp (glow, orbit and emblem scale
   * together inside it). Driven by app/index.tsx from the measured space
   * between the header and the tray, so it follows the tray as it moves. */
  zoneSize: SharedValue<number>;
  /** Spoken name: what a tap and a long-press do in the current mode. */
  accessibilityLabel: string;
  /** Responsive tiers (app/index.tsx): the decorative orbit is reduced
   * first when space is short… */
  orbitDetail?: "full" | "reduced";
  /** …and the emblem is hidden only when even its smallest size can't fit
   * beside the essential controls. Hidden = not rendered, not focusable. */
  hidden?: boolean;
};

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const WAVEFORM_WIDTH = SCREEN_WIDTH * 0.5;
const BAR_COUNT = 28;
const BAR_WIDTH = 3;
const MIN_BAR_HEIGHT = 2;
const MAX_BAR_HEIGHT = 34;

/** Live on-device report + root-caused: `recorder.amplitude` (real RMS from
 * `computeRms`, wav.ts) is technically correct — a literal 0..1 ratio of the
 * loudest possible sample — but normal speech at ordinary phone-mic distance
 * only ever reaches a small fraction of full-scale (this codebase already
 * documented and fixed the exact same characteristic for the SAVED WAV file,
 * via `normalizePcmGain` in wav.ts — that gain is applied only once, after
 * recording finishes, never to the live per-chunk value this component
 * reads). Linearly mapping that raw value straight to bar height is why the
 * waveform looked almost perfectly flat during real, audible speech.
 *
 * The fix belongs HERE, not in `computeRms` itself — `activeMode.ts` also
 * calls `computeRms` directly, for Handsfree's own VAD/noise-floor
 * calibration, which is tuned to that exact raw scale and must not shift.
 *
 * FIRST attempt used a fixed gain + power-curve (guessed constants tuned to
 * an assumed "typical" raw RMS range). Live on-device report: it overcorrected
 * — normal speech now saturated the visual value to ~1.0 well within ordinary
 * speaking volume, so the waveform just looked like a dense, near-maxed wall
 * of bars with barely any visible quiet-vs-loud contrast. A fixed constant
 * was always going to be fragile here anyway — `normalizePcmGain`'s own doc
 * comment already establishes that raw mic level is genuinely
 * distance/device-dependent, not a fixed characteristic to hardcode a gain
 * against.
 *
 * REAL fix: normalize live against THIS RECORDING's own loudest moment so
 * far — the same "peak-normalize relative to this take's own peak"
 * philosophy `normalizePcmGain` already uses for the saved file, just
 * applied incrementally instead of after the fact. Self-calibrates to
 * whatever mic sensitivity/distance/environment this specific recording
 * actually has, so quiet-vs-loud contrast stays visible regardless. The
 * peak decays slowly (`PEAK_DECAY`) rather than only ever increasing, so
 * one early loud moment (a cough, a door) doesn't permanently flatten the
 * visual range for the rest of a long recording — plain AGC-style
 * behavior. `MIN_PEAK_FLOOR` stops near-silence at the very start (before
 * any real signal has been observed) from being divided by a near-zero
 * peak and reading as falsely loud. */
const MIN_PEAK_FLOOR = 0.03;
const PEAK_DECAY = 0.995;

const CENTER_INDEX = (BAR_COUNT - 1) / 2;

/** 1 at the center bar, 0 at the outer edges, smooth cosine falloff between
 * — a genuine "symmetrical equalizer" shape (tallest in the middle, shorter
 * toward both ends), not the double-humped shape a full-cycle sine across
 * the whole row previously produced. Fixed per bar, never time-varying —
 * see this file's own top doc comment on why NOTHING here maps to a
 * timestamp or index-over-time; only `amplitude`/`activity` (both live,
 * externally driven values) determine how tall this shape currently is. */
function centerFalloff(index: number): number {
  const distance = Math.abs(index - CENTER_INDEX) / CENTER_INDEX; // 0 at center, 1 at edges
  return Math.cos(distance * (Math.PI / 2));
}

/** One bar of the waveform.
 *
 * `recording`: a genuine ROLLING HISTORY — THIRD rewrite of this state.
 * Round 1 (a symmetric "equalizer" shape, every bar showing the SAME live
 * amplitude scaled by its own fixed position) was live-reported as "a
 * static bell curve... not how premium apps behave" — replaced with this
 * ring-buffer mechanic. Round 2 tried to smooth each buffer shift by
 * calling `withTiming` INLINE inside this worklet's own return expression,
 * on a plain computed local rather than a persistent shared value's own
 * `.value` being reassigned — confirmed via temporary diagnostic logging to
 * produce `NaN` for every bar's height, rendering the whole waveform blank.
 * Removing that smoothing fixed the blank-render bug, but left every buffer
 * shift snapping discretely — live-reported as "blocky, Tetris-like
 * movement instead of a fluid river of sound."
 *
 * THIS version smooths correctly: each bar owns its OWN persistent
 * `displayedLevel` shared value (below), and a `useAnimatedReaction`
 * assigns `displayedLevel.value = withTiming(target, ...)` whenever
 * `history.value[index]`'s target changes — an ASSIGNMENT to a real shared
 * value, the actually-supported pattern, not an inline expression. This
 * worklet then only ever READS `displayedLevel.value` — a plain, safe
 * read, never a fresh `withTiming` call — so every bar glides smoothly
 * between one buffer shift and the next instead of popping.
 *
 * `history` itself: a fixed-size ring buffer a new (peak-normalized) sample
 * gets pushed onto (oldest dropped) on every incoming audio chunk (see the
 * effect below in the parent). Index 0 is the oldest still-retained sample
 * (left edge), the last index is the newest (right edge) — new data enters
 * on the right and scrolls left as it ages, same convention as a real
 * oscilloscope/DAW waveform.
 *
 * `transcribing`: no live audio exists once recording has stopped, so
 * there's no history to roll — `activity` (a synthetic breathing
 * oscillation, same idiom as `glowPhase`'s Handsfree glow below) scales a
 * fixed, symmetric `centerFalloff` shape as a whole. Unchanged from the
 * previous round. */
function WaveformBar({
  index,
  state,
  history,
  activity,
}: {
  index: number;
  state: RecorderCanvasState;
  history: SharedValue<number[]>;
  activity: SharedValue<number>;
}) {
  const shape = centerFalloff(index); // 0..1, fixed for this bar's position — transcribing only
  // This bar's own smoothly-animating displayed level — see this
  // function's own doc comment for why the smoothing lives HERE (an
  // assignment inside `useAnimatedReaction`) and not inline inside
  // `useAnimatedStyle` below.
  const displayedLevel = useSharedValue(0);

  useAnimatedReaction(
    () => history.value[index] ?? 0,
    (current, previous) => {
      if (current !== previous) {
        // Over-damped spring (ζ≈1.5, no bounce/overshoot), not a fixed-
        // duration ease — live on-device report: a 180ms `withTiming` still
        // read as "stepped," because it fully settles between one buffer
        // shift and the next (chunks arrive ~100-200ms apart), producing a
        // repeating settle-then-jump pattern even though each individual
        // transition was itself smooth. A spring never "arrives and waits"
        // the same way — retargeting it mid-motion (which happens
        // constantly here) blends continuously into the new target instead
        // of restarting a fresh ease each time, which is what actually
        // reads as one continuous glide rather than discrete steps.
        displayedLevel.value = withSpring(current, { damping: 26, stiffness: 120, mass: 0.6 });
      }
    }
  );

  const animatedStyle = useAnimatedStyle(() => {
    if (state === "recording") {
      const level = Math.max(0, Math.min(1, displayedLevel.value));
      const height = MIN_BAR_HEIGHT + level * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT);
      return { height, opacity: 1 };
    }
    if (state === "transcribing") {
      // No live audio exists once recording has stopped — `activity` is a
      // synthetic breathing value (0..1, oscillating smoothly), the same
      // "slow breathe in and out" idiom this file already uses for the
      // Handsfree listening glow (`glowPhase`, below), not a new mechanic.
      // Every bar breathes together, in place — the shape scales as a
      // whole, it never shifts sideways.
      const level = activity.value;
      const height = MIN_BAR_HEIGHT + level * (MAX_BAR_HEIGHT * 0.6 - MIN_BAR_HEIGHT) * (0.3 + 0.7 * shape);
      return { height, opacity: 0.45 + level * 0.55 };
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
 * Xayra 2.0 (Halo + Orbit): the button is the original full-colour emblem
 * (`assets/splash-icon-round.png`, unaltered) inside a restrained orbit and
 * soft glow; a teal ring marks Handsfree listening. Press physics, haptics,
 * long-press and the waveform are unchanged.
 */
export function CentralRecorderCanvas({
  state,
  amplitude,
  onPress,
  onLongPress,
  disabled,
  zoneSize,
  accessibilityLabel,
  orbitDetail = "full",
  hidden = false,
}: CentralRecorderCanvasProps) {
  // Looping motion (the Handsfree ring's breathing, the processing
  // waveform's pulse) holds still when the system asks for reduced motion.
  const reduceMotion = useReducedMotion();
  // Ring buffer of this recording's most recent (peak-normalized) samples,
  // oldest at index 0 (left) to newest at the last index (right) — see
  // WaveformBar's own doc comment for why this replaced a single shared
  // amplitude scalar. Reassigned wholesale (never mutated in place) on every
  // incoming chunk, which is what makes every dependent `useAnimatedStyle`
  // correctly re-run — Reanimated tracks shared-value reference changes.
  const history = useSharedValue<number[]>(new Array(BAR_COUNT).fill(0));
  // This recording's own running loudest-moment-so-far — see MIN_PEAK_FLOOR/
  // PEAK_DECAY's own doc comment above for why amplitude is normalized
  // against this instead of a fixed guessed gain. Reset to the floor
  // whenever a fresh recording starts (the effect below).
  const runningPeak = useSharedValue(MIN_PEAK_FLOOR);
  // Synthetic "how alive does this look right now" value for the
  // transcribing/processing state — see WaveformBar's own doc comment for
  // why this replaced a traveling, index-mapped `pulsePhase`.
  const activity = useSharedValue(0);
  // Handsfree "awake and listening" glow: a slow breathing opacity pulse on
  // a soft accent-colored ring behind the button, distinct from the
  // recording waveform (which only appears once actual speech is being
  // captured — see the render below). Opacity, not shadowRadius/elevation,
  // is what's animated: shadow properties don't interpolate reliably on
  // Android, but opacity on a plain overlay view does on both platforms,
  // the same reasoning buttonHighlight below already relies on.
  const glowPhase = useSharedValue(0);
  // Build 39 "make it feel 3D, not a sticker": 0 at rest, 1 while a finger is
  // actually down. Snaps up fast (a real button shouldn't feel laggy to
  // depress) and springs back with real overshoot on release (the "comes
  // back up" the user asked for) rather than a linear ease — see
  // buttonAnimatedStyle below for what it actually drives.
  const pressedProgress = useSharedValue(0);
  const handlePressIn = () => {
    // Design-sandbox pass: the depress/spring-back physics and highlight
    // dimming below already made this feel tactile — the one thing missing
    // was a physical click to go with it. Fires on press-IN (not onPress),
    // same moment the depress animation starts, so it reads as simultaneous
    // with the visual "click" rather than a delayed afterthought on release.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    pressedProgress.value = withTiming(1, { duration: 80, easing: Easing.out(Easing.quad) });
  };
  const handlePressOut = () => {
    pressedProgress.value = withSpring(0, { damping: 9, stiffness: 220, mass: 0.6 });
  };

  useEffect(() => {
    if (state !== "recording") {
      // Reset for the NEXT recording — each take gets its own fresh
      // loudest-moment reference and a clean, silent history, not ones
      // carried over from a previous recording taken from a different
      // distance/environment.
      runningPeak.value = MIN_PEAK_FLOOR;
      history.value = new Array(BAR_COUNT).fill(0);
      return;
    }
    // See MIN_PEAK_FLOOR/PEAK_DECAY's own doc comment above for why this
    // normalizes against the recording's OWN observed peak rather than a
    // fixed guessed gain.
    runningPeak.value = Math.max(amplitude, runningPeak.value * PEAK_DECAY, MIN_PEAK_FLOOR);
    const level = Math.min(1, amplitude / runningPeak.value);
    // Push the newest sample onto the right, drop the oldest off the left —
    // a plain ring buffer. This is the ONLY place JS touches `history` at
    // all; every bar's own animation runs off this shared value purely on
    // the UI thread from here on (see WaveformBar's own doc comment).
    history.value = [...history.value.slice(1), level];
  }, [amplitude, state, history, runningPeak]);

  useEffect(() => {
    if (state === "transcribing" && !reduceMotion) {
      // Breathing, not a one-way repeating ramp — `true` as the third
      // `withRepeat` argument reverses each cycle (0->1->0->1...) instead of
      // snapping back to 0, the exact same idiom `glowPhase` below already
      // uses for the Handsfree listening glow. This value never maps to a
      // bar INDEX (see WaveformBar's own doc comment) — every bar reads it
      // directly and moves together.
      activity.value = withRepeat(withTiming(1, { duration: 700, easing: Easing.inOut(Easing.sin) }), -1, true);
    } else {
      activity.value = withTiming(state === "transcribing" ? 0.6 : 0, { duration: 200 });
    }
  }, [state, activity, reduceMotion]);

  useEffect(() => {
    if (state === "listening" && !reduceMotion) {
      // `true` as the third arg makes withRepeat reverse each cycle
      // (0->1->0->1...) instead of snapping back to 0, which is what makes
      // this read as breathing rather than a sawtooth flash.
      glowPhase.value = withRepeat(
        withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.sin) }),
        -1,
        true
      );
    } else {
      glowPhase.value = withTiming(state === "listening" ? 0.6 : 0, { duration: 200 });
    }
  }, [state, glowPhase, reduceMotion]);

  // Build 39: was scale-only (the recording-amplitude pulse). Now also
  // shrinks slightly and nudges down on press, and — the actual "3D" part —
  // the highlight sheen (buttonHighlight below) dims as it depresses, as if
  // the glossy top surface is tilting away from the light. Multiplying the
  // two scale sources (rather than picking one) means a press during active
  // recording still shrinks a little further from wherever the amplitude
  // pulse currently has it, instead of the press fighting/overriding it.
  const buttonScaleStyle = useAnimatedStyle(() => {
    // Newest sample in the history buffer (the right-most bar's own value)
    // is "right now" — same value the pulse used to read off the old single
    // shared amplitude scalar.
    const currentLevel = state === "recording" ? history.value[history.value.length - 1] ?? 0 : 0;
    const recordingPulse = state === "recording" ? 1 + currentLevel * 0.06 : 1;
    const pressScale = interpolate(pressedProgress.value, [0, 1], [1, 0.93]);
    const pressTranslateY = interpolate(pressedProgress.value, [0, 1], [0, 3]);
    return {
      transform: [{ scale: recordingPulse * pressScale }, { translateY: pressTranslateY }],
    };
  });

  // The Handsfree ring: teal, present only while Handsfree is listening,
  // breathing gently (still under reduced motion — see glowPhase above).
  const handsfreeRingStyle = useAnimatedStyle(() => ({
    opacity: state === "listening" ? interpolate(glowPhase.value, [0, 1], [0.55, 1]) : 0,
    transform: [{ scale: interpolate(glowPhase.value, [0, 1], [1, 1.04]) }],
  }));

  // Everything inside the zone is drawn once at ZONE_BASE and scaled to the
  // live zone size, so glow, orbit and emblem keep their proportions.
  const zoneStyle = useAnimatedStyle(() => ({ width: zoneSize.value, height: zoneSize.value }));
  const zoneContentStyle = useAnimatedStyle(() => {
    const offset = (zoneSize.value - ZONE_BASE) / 2;
    return {
      transform: [{ translateX: offset }, { translateY: offset }, { scale: zoneSize.value / ZONE_BASE }],
    };
  });

  return (
    <View style={styles.wrapper}>
      <Animated.View style={zoneStyle}>
        {!hidden && (
        <Animated.View style={[styles.zoneContent, zoneContentStyle]}>
          <View pointerEvents="none" style={styles.glow}>
            <Svg width={GLOW_SIZE} height={GLOW_SIZE} accessible={false} importantForAccessibility="no-hide-descendants">
              <Defs>
                <RadialGradient id="emblemGlow" cx="50%" cy="50%" r="50%">
                  <Stop offset="0" stopColor="#9684E8" stopOpacity={0.2} />
                  <Stop offset="0.62" stopColor="#8FD6CF" stopOpacity={0.04} />
                  <Stop offset="1" stopColor="#000000" stopOpacity={0} />
                </RadialGradient>
              </Defs>
              <Circle cx={GLOW_SIZE / 2} cy={GLOW_SIZE / 2} r={GLOW_SIZE / 2} fill="url(#emblemGlow)" />
            </Svg>
          </View>
          <View pointerEvents="none" style={styles.orbit}>
            <Orbit size={ORBIT_SIZE} detail={orbitDetail} />
          </View>
          <Animated.View pointerEvents="none" style={[styles.handsfreeRing, handsfreeRingStyle]} />
          <Animated.View style={[styles.emblemWrap, buttonScaleStyle]}>
            <Pressable
              testID="central-emblem"
              onPress={onPress}
              onLongPress={onLongPress}
              onPressIn={handlePressIn}
              onPressOut={handlePressOut}
              disabled={disabled}
              hitSlop={16}
              accessibilityRole="button"
              accessibilityLabel={accessibilityLabel}
              // Dimmed only for a genuine start/stop race — never while
              // processing, where the waveform says "working" instead.
              style={[styles.emblem, disabled && state !== "transcribing" && styles.emblemDisabled]}
            >
              {/* The original emblem artwork, unaltered: no tint, overlay or
                  crop — the file is already a full-colour circle. */}
              <Image source={require("../assets/splash-icon-round.png")} style={styles.emblemImage} />
            </Pressable>
          </Animated.View>
        </Animated.View>
        )}
      </Animated.View>

      {/* Idle and Handsfree-listening show no bars: the waveform means "your
          voice is being captured now" (recording) or "working on it". */}
      {state !== "idle" && state !== "listening" && (
        <View style={styles.waveform} pointerEvents="none">
          {Array.from({ length: BAR_COUNT }).map((_, index) => (
            <WaveformBar key={index} index={index} state={state} history={history} activity={activity} />
          ))}
        </View>
      )}
    </View>
  );
}

/** The design size of the emblem zone (canvas row P: 248dp at rest on a
 * 390 x 844 phone). Its contents scale with the live zone size. */
export const ZONE_BASE = 248;
const EMBLEM_SIZE = Math.round(ZONE_BASE * 0.532);
const GLOW_SIZE = Math.round(ZONE_BASE * 1.3);
const ORBIT_SIZE = Math.round(ZONE_BASE * 1.5);
const HANDSFREE_RING_SIZE = Math.round(ZONE_BASE * 0.76);
/** Height the waveform row adds under the zone while recording/processing. */
export const WAVEFORM_ROW_HEIGHT = 18 + MAX_BAR_HEIGHT;

const centred = (size: number) => ({
  position: "absolute" as const,
  left: (ZONE_BASE - size) / 2,
  top: (ZONE_BASE - size) / 2,
  width: size,
  height: size,
});

const styles = StyleSheet.create({
  wrapper: {
    alignItems: "center",
    justifyContent: "center",
  },
  zoneContent: {
    position: "absolute",
    left: 0,
    top: 0,
    width: ZONE_BASE,
    height: ZONE_BASE,
  },
  glow: centred(GLOW_SIZE),
  orbit: centred(ORBIT_SIZE),
  handsfreeRing: {
    ...centred(HANDSFREE_RING_SIZE),
    borderRadius: HANDSFREE_RING_SIZE / 2,
    borderWidth: 1.5,
    borderColor: "rgba(143,214,207,0.55)",
    backgroundColor: "rgba(143,214,207,0.06)",
  },
  emblemWrap: centred(EMBLEM_SIZE),
  emblem: {
    width: EMBLEM_SIZE,
    height: EMBLEM_SIZE,
    borderRadius: EMBLEM_SIZE / 2,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  emblemImage: {
    width: "100%",
    height: "100%",
  },
  emblemDisabled: {
    opacity: 0.5,
  },
  waveform: {
    width: WAVEFORM_WIDTH,
    height: MAX_BAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: BAR_WIDTH / 2,
    backgroundColor: xayraColors.lilac,
  },
});
