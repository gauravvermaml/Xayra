import { useState } from "react";
import { Image, ScrollView, StyleSheet, Text, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDecay,
  withRepeat,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

/**
 * Isolated visual/physics prototype — no production imports, no shared
 * state, no wiring into app/index.tsx, HistorySheet.tsx, or the calendar
 * system. A representative gallery (one faithful example per control/
 * surface/gesture type found in the Step 1 audit), not a literal clone of
 * those files' full logic — colors/radii below are the REAL values pulled
 * from app/index.tsx and HistorySheet.tsx, not invented. Safe to delete any
 * time; nothing else imports from this file. Reachable at /design-sandbox
 * (Expo Router auto-registers every file under app/), same pattern as
 * app/dev-seed.tsx.
 */

// ---- The five physics protocols, as named constants (spec values, not
// guessed) ----
const PRESS_SPRING = { mass: 0.5, stiffness: 200, damping: 12 };
const OVERLAY_SPRING = { mass: 0.6, stiffness: 140, damping: 18 };
const RADIUS_SMALL = 12;
const RADIUS_LARGE = 20;

function lightTap() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}
function successTap() {
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
}

export default function DesignSandboxScreen() {
  return (
    <ScrollView style={styles.canvas} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={styles.screenTitle}>Design Sandbox</Text>

      <Text style={styles.sectionLabel}>Interactive Controls</Text>
      <RecordButtonPrototype />
      <View style={styles.pillRow}>
        <IconButtonPrototype />
        <PillPrototype label="To-Dos (3)" />
        <PillPrototype label="🎧 Handsfree" active />
      </View>
      <SegmentedPillPrototype />
      <TaskRowPrototype />

      <Text style={styles.sectionLabel}>Data Surfaces</Text>
      <GlassHistoryCardPrototype />
      <VoiceNoteCardPrototype />

      <Text style={styles.sectionLabel}>Swipe/Gesture Regions</Text>
      <CalendarSwipeStripPrototype />
      <OverlayPopTriggerPrototype />
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------
// 2. THE TACTILE GLOW & BOUNCE ENGINE — the record button clone
// ---------------------------------------------------------------------------
function RecordButtonPrototype() {
  const [isRecording, setIsRecording] = useState(false);
  const scale = useSharedValue(1);
  const breathe = useSharedValue(0);

  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      scale.value = withTiming(0.94, { duration: 80, easing: Easing.out(Easing.quad) });
    })
    .onFinalize(() => {
      scale.value = withSpring(1, PRESS_SPRING);
    })
    .onEnd(() => {
      runOnJS(setIsRecording)(!isRecording);
      runOnJS(lightTap)();
    });

  // Idle: a static, soft ambient halo. Recording: a continuous breathing
  // loop (Reanimated `withRepeat`) expanding/fading a solid white glow.
  breathe.value = isRecording
    ? withRepeat(withTiming(1, { duration: 1100, easing: Easing.inOut(Easing.sin) }), -1, true)
    : withTiming(0, { duration: 200 });

  const buttonAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const glowAnimatedStyle = useAnimatedStyle(() => ({
    opacity: isRecording ? 0.15 + breathe.value * 0.35 : 0.12,
    transform: [{ scale: 1 + (isRecording ? breathe.value * 0.35 : 0) }],
  }));

  return (
    <View style={styles.recordButtonWrap}>
      <Animated.View style={[styles.recordGlow, glowAnimatedStyle]} />
      <GestureDetector gesture={tapGesture}>
        <Animated.View style={[styles.recordButton, buttonAnimatedStyle]}>
          {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
          <Image source={require("../assets/icon.png")} style={styles.recordButtonLogo} resizeMode="contain" />
        </Animated.View>
      </GestureDetector>
      <Text style={styles.recordButtonCaption}>{isRecording ? "Tap to stop" : "Tap to test the glow"}</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 1. THE SOFT CORNER PROTOCOL + 5. HAPTICS — small controls
// ---------------------------------------------------------------------------
function IconButtonPrototype() {
  const scale = useSharedValue(1);
  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      scale.value = withTiming(0.9, { duration: 70 });
    })
    .onFinalize(() => {
      scale.value = withSpring(1, PRESS_SPRING);
    })
    .onEnd(() => runOnJS(lightTap)());
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <GestureDetector gesture={tapGesture}>
      <Animated.View style={[styles.iconButton, animatedStyle]}>
        <Text style={styles.iconButtonText}>•••</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function PillPrototype({ label, active = false }: { label: string; active?: boolean }) {
  const scale = useSharedValue(1);
  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      scale.value = withTiming(0.95, { duration: 70 });
    })
    .onFinalize(() => {
      scale.value = withSpring(1, PRESS_SPRING);
    })
    .onEnd(() => runOnJS(lightTap)());
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <GestureDetector gesture={tapGesture}>
      <Animated.View style={[styles.pill, active && styles.pillActive, animatedStyle]}>
        <Text style={[styles.pillText, active && styles.pillTextActive]}>{label}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function SegmentedPillPrototype() {
  const [selected, setSelected] = useState<"record" | "ask">("record");
  return (
    <View style={styles.segmentedPill}>
      {(["record", "ask"] as const).map((mode) => (
        <SegmentOption key={mode} label={mode === "record" ? "Record" : "Ask"} active={selected === mode} onPress={() => setSelected(mode)} />
      ))}
    </View>
  );
}

function SegmentOption({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const scale = useSharedValue(1);
  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      scale.value = withTiming(0.92, { duration: 70 });
    })
    .onFinalize(() => {
      scale.value = withSpring(1, PRESS_SPRING);
    })
    .onEnd(() => {
      runOnJS(onPress)();
      runOnJS(lightTap)();
    });
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <GestureDetector gesture={tapGesture}>
      <Animated.View style={[styles.segmentOption, active && styles.segmentOptionActive, animatedStyle]}>
        <Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text>
      </Animated.View>
    </GestureDetector>
  );
}

function TaskRowPrototype() {
  const [checked, setChecked] = useState(false);
  const checkScale = useSharedValue(1);
  const checkGesture = Gesture.Tap()
    .onBegin(() => {
      checkScale.value = withTiming(0.85, { duration: 70 });
    })
    .onFinalize(() => {
      checkScale.value = withSpring(1, PRESS_SPRING);
    })
    .onEnd(() => {
      runOnJS(setChecked)(!checked);
      runOnJS(successTap)();
    });
  const checkAnimatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: checkScale.value }] }));

  return (
    <View style={styles.taskRow}>
      <GestureDetector gesture={checkGesture}>
        <Animated.View style={[styles.checkbox, checked && styles.checkboxChecked, checkAnimatedStyle]} />
      </GestureDetector>
      <Text style={[styles.taskRowText, checked && styles.taskRowTextChecked]}>Renew car registration</Text>
      <Text style={styles.deleteIcon}>🗑️</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// DATA SURFACES — real colors from HistorySheet.tsx's own "monochromatic
// glass" box and the earlier voice-note card, with the soft-corner radii
// applied.
// ---------------------------------------------------------------------------
function GlassHistoryCardPrototype() {
  return (
    <View style={styles.glassCard}>
      <View style={styles.glassMicroChip}>
        <Feather name="arrow-up-right" size={16} color="#E2E8F0" />
      </View>
      <Text style={styles.glassCardTitle}>Recent Answers</Text>
      <Text style={styles.glassCardBody}>"What did I say about the Queenstown trip?" — 3 notes found.</Text>
    </View>
  );
}

function VoiceNoteCardPrototype() {
  return (
    <View style={styles.card}>
      <Text style={styles.timestampText}>2:45 PM · Today</Text>
      <Text style={styles.cardTitle}>Grocery run</Text>
      <Text style={styles.cardBody}>
        Bought milk, eggs, and bread. Need to also pick up coffee filters before the weekend.
      </Text>
      <View style={styles.bulletList}>
        <Text style={styles.bulletItem}>•  Milk, eggs, bread</Text>
        <Text style={styles.bulletItem}>•  Coffee filters</Text>
        <Text style={styles.bulletItem}>•  Check pantry for pasta</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 4. THE FLUID CALENDAR SWIPE ENGINE — 1:1 finger tracking + momentum decay
// ---------------------------------------------------------------------------
const DAY_CHIP_WIDTH = 64;
const DAYS = ["S", "M", "T", "W", "T", "F", "S"];
const STRIP_MIN = -(DAY_CHIP_WIDTH * (DAYS.length - 4));
const STRIP_MAX = 0;

function CalendarSwipeStripPrototype() {
  const translateX = useSharedValue(0);
  const startX = useSharedValue(0);

  const panGesture = Gesture.Pan()
    .onStart(() => {
      startX.value = translateX.value;
    })
    .onUpdate((event) => {
      // 1:1 tracking with the finger while dragging.
      translateX.value = startX.value + event.translationX;
    })
    .onEnd((event) => {
      // Momentum-decay coast on release, clamped so it can't fling off
      // the strip's real bounds.
      translateX.value = withDecay({
        velocity: event.velocityX,
        clamp: [STRIP_MIN, STRIP_MAX],
        deceleration: 0.995,
      });
      runOnJS(successTap)();
    });

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  return (
    <View style={styles.swipeStripFrame}>
      <GestureDetector gesture={panGesture}>
        <Animated.View style={[styles.swipeStripTrack, animatedStyle]}>
          {DAYS.map((label, index) => (
            <View key={index} style={[styles.dayChip, index === 2 && styles.dayChipToday]}>
              <Text style={styles.dayChipLabel}>{label}</Text>
              <Text style={[styles.dayChipNumber, index === 2 && styles.dayChipNumberToday]}>{20 + index}</Text>
            </View>
          ))}
        </Animated.View>
      </GestureDetector>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 3. FLUID PAGE & OVERLAY OPENING — scale 0.95->1.0 + fade, organic pop-out
// ---------------------------------------------------------------------------
function OverlayPopTriggerPrototype() {
  const [open, setOpen] = useState(false);
  const progress = useSharedValue(0);

  const openOverlay = () => {
    setOpen(true);
    progress.value = withSpring(1, OVERLAY_SPRING);
    lightTap();
  };
  const closeOverlay = () => {
    progress.value = withTiming(0, { duration: 120 }, (finished) => {
      if (finished) runOnJS(setOpen)(false);
    });
  };

  const overlayAnimatedStyle = useAnimatedStyle(() => ({
    opacity: progress.value,
    transform: [{ scale: 0.95 + progress.value * 0.05 }],
  }));

  const triggerGesture = Gesture.Tap().onEnd(() => runOnJS(openOverlay)());

  return (
    <View>
      <GestureDetector gesture={triggerGesture}>
        <View style={styles.overlayTrigger}>
          <Text style={styles.overlayTriggerText}>Tap to pop a panel open</Text>
        </View>
      </GestureDetector>

      {open && (
        <Animated.View style={[styles.popoverSurface, overlayAnimatedStyle]}>
          <Text style={styles.quickMenuRowText}>🗄️ Archived notes (12)</Text>
          <Text style={[styles.quickMenuRowText, { marginTop: 10 }]}>⚙️ Settings</Text>
          <View style={styles.overlayCloseGesture}>
            <GestureDetector gesture={Gesture.Tap().onEnd(() => runOnJS(closeOverlay)())}>
              <Text style={styles.overlayCloseText}>Close</Text>
            </GestureDetector>
          </View>
        </Animated.View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    backgroundColor: "#000000",
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 80,
    gap: 12,
  },
  screenTitle: {
    color: "#FFFFFF",
    fontSize: 24,
    fontWeight: "700",
    marginBottom: 4,
  },
  sectionLabel: {
    color: "#8E8E93",
    fontSize: 13,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginTop: 24,
    marginBottom: 4,
  },

  // -- Record button --
  recordButtonWrap: {
    alignItems: "center",
    justifyContent: "center",
    height: 180,
  },
  recordGlow: {
    position: "absolute",
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: "#FFFFFF",
  },
  recordButton: {
    width: 88,
    height: 88,
    borderRadius: 44,
    backgroundColor: "#FFFFFF",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 12,
  },
  recordButtonLogo: {
    width: 48,
    height: 48,
    borderRadius: RADIUS_SMALL,
  },
  recordButtonCaption: {
    color: "#8E8E93",
    fontSize: 12,
    marginTop: 12,
  },

  // -- Small controls (Soft Corner Protocol: 12px) --
  pillRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  iconButton: {
    width: 32,
    height: 32,
    borderRadius: RADIUS_SMALL,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    backgroundColor: "rgba(28, 28, 30, 0.85)",
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#8E8E93",
  },
  pill: {
    borderRadius: RADIUS_SMALL,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderWidth: 1,
    backgroundColor: "rgba(28, 28, 30, 0.85)",
    borderColor: "rgba(255,255,255,0.1)",
  },
  pillActive: {
    backgroundColor: "#635BFF",
    borderColor: "#635BFF",
  },
  pillText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#8E8E93",
  },
  pillTextActive: {
    color: "#FFFFFF",
  },
  segmentedPill: {
    flexDirection: "row",
    backgroundColor: "#1C1C1E",
    borderRadius: RADIUS_SMALL,
    padding: 4,
    alignSelf: "flex-start",
  },
  segmentOption: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: RADIUS_SMALL - 4,
  },
  segmentOptionActive: {
    backgroundColor: "#635BFF",
  },
  segmentText: {
    color: "rgba(235,235,245,0.6)",
    fontSize: 13,
    fontWeight: "600",
  },
  segmentTextActive: {
    color: "#FFFFFF",
  },
  taskRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: "#1C1C1E",
    borderRadius: RADIUS_SMALL,
    padding: 14,
  },
  checkbox: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.3)",
  },
  checkboxChecked: {
    backgroundColor: "#635BFF",
    borderColor: "#635BFF",
  },
  taskRowText: {
    flex: 1,
    color: "#FFFFFF",
    fontSize: 14,
    fontWeight: "500",
  },
  taskRowTextChecked: {
    color: "#8E8E93",
    textDecorationLine: "line-through",
  },
  deleteIcon: {
    fontSize: 14,
    opacity: 0.6,
  },

  // -- Data surfaces (Soft Corner Protocol: 16-24px for card sheets) --
  glassCard: {
    backgroundColor: "rgba(18, 18, 26, 0.65)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderRadius: RADIUS_LARGE,
    padding: 16,
  },
  glassMicroChip: {
    position: "absolute",
    top: 12,
    right: 12,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  glassCardTitle: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "700",
    marginBottom: 6,
  },
  glassCardBody: {
    color: "#8E8E93",
    fontSize: 13,
    lineHeight: 19,
  },
  card: {
    backgroundColor: "#1C1C1E",
    borderRadius: RADIUS_LARGE,
    padding: 20,
  },
  timestampText: {
    color: "#8E8E93",
    fontSize: 12,
    fontWeight: "500",
    marginBottom: 12,
  },
  cardTitle: {
    color: "#FFFFFF",
    fontSize: 20,
    fontWeight: "700",
    marginBottom: 8,
  },
  cardBody: {
    color: "#8E8E93",
    fontSize: 15,
    lineHeight: 21,
    marginBottom: 16,
  },
  bulletList: {
    gap: 6,
  },
  bulletItem: {
    color: "#8E8E93",
    fontSize: 14,
    lineHeight: 20,
  },

  // -- Calendar swipe strip --
  swipeStripFrame: {
    height: 72,
    borderRadius: RADIUS_LARGE,
    backgroundColor: "#1C1C1E",
    overflow: "hidden",
    justifyContent: "center",
  },
  swipeStripTrack: {
    flexDirection: "row",
    paddingHorizontal: 8,
  },
  dayChip: {
    width: DAY_CHIP_WIDTH,
    alignItems: "center",
    gap: 4,
  },
  dayChipToday: {},
  dayChipLabel: {
    color: "#8E8E93",
    fontSize: 11,
  },
  dayChipNumber: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    width: 30,
    height: 30,
    borderRadius: 15,
    textAlign: "center",
    textAlignVertical: "center",
  },
  dayChipNumberToday: {
    backgroundColor: "#635BFF",
    color: "#FFFFFF",
    overflow: "hidden",
  },

  // -- Overlay pop trigger --
  overlayTrigger: {
    backgroundColor: "#1C1C1E",
    borderRadius: RADIUS_LARGE,
    padding: 16,
    alignItems: "center",
  },
  overlayTriggerText: {
    color: "#8E8E93",
    fontSize: 14,
    fontWeight: "600",
  },
  popoverSurface: {
    marginTop: 12,
    backgroundColor: "#1C1C1E",
    borderRadius: RADIUS_LARGE,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
    padding: 16,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 12,
  },
  quickMenuRowText: {
    color: "#F8FAFC",
    fontSize: 15,
    fontWeight: "600",
  },
  overlayCloseGesture: {
    marginTop: 14,
    alignItems: "flex-end",
  },
  overlayCloseText: {
    color: "#635BFF",
    fontSize: 13,
    fontWeight: "700",
  },
});
