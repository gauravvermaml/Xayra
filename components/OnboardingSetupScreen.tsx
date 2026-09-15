import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { AnimatedEmoji } from "./AnimatedEmoji";
import { colors, radius, spacing, typography } from "../constants/theme";
import { checkMemoryBeforeOnboarding, LOW_MEMORY_WARNING_MESSAGE, watchForMemoryPressure } from "../services/ai/memoryGuard";
import { resumeDownloads, runOnboardingThreadCalibration, useModelDownload } from "../services/ai/modelDownloadManager";
import { markSetupComplete } from "../services/settings/appSettings";
import { showSetupCompleteNotification } from "../services/notifications/setupCompleteNotification";
import { readPreferences, writePreferences } from "../services/settings/preferences";

/**
 * "One Door, Opens Once" onboarding — the whole point (see this feature's
 * own design discussion) is that the user never crosses into the rest of
 * the app until Whisper, the embedding model, AND the Llama chat model are
 * ALL on disk and warm. app/_layout.tsx's root guard renders this in place
 * of the normal Stack until `onComplete` fires; there is no partial/locked
 * state of the real app to peek at from here. Crossing that door is now an
 * explicit tap on the "Start Capturing Thoughts ✨" button once everything
 * is ready, rather than an automatic hand-off after a timed pause — the
 * underlying setup work is still 100% automatic either way, only the very
 * last "ok, go" step became a deliberate user action instead of one that
 * just happens to them.
 *
 * The last checklist row ("Locking in 100% offline privacy...") is
 * deliberately COSMETIC pacing, not a real measured step — by the time the
 * three real downloads finish, `prewarmLocalLlama()` has already been
 * triggered by modelDownloadManager's own `setStatus` side effect, so
 * there's no separate real "warm-up" operation left for this screen to
 * await. It exists purely so the transition from "99% downloaded" to
 * "ready" doesn't feel like it happened suspiciously instantly.
 *
 * "Tuning quick-recall for your device" (the row above it) is NOT cosmetic
 * — it runs a real, bounded, cancellable thread-count calibration trial
 * (`runOnboardingThreadCalibration()`, services/ai/modelDownloadManager.ts)
 * before the user has asked a single real question. See that function and
 * `attemptOptimisticThreadCalibration()` (localLlama.ts) for the full
 * reasoning: this app's real target users are 2023+ flagship-class devices,
 * so the first thing ever tried on a fresh install is an OPTIMISTIC thread
 * count, not the old conservative default — a capable device gets its best
 * real speed from its very first genuine query onward, at the cost of a few
 * extra seconds here, in a screen the user is already waiting through for
 * model downloads anyway, never on the question that actually matters to
 * how the app is judged. This step's on-screen duration genuinely varies by
 * device as a result (bounded by a hard timeout inside that trial) — it is
 * not the same fixed `COSMETIC_STEP_DURATION_MS` pause the row below it
 * still uses.
 *
 * Warm, human-centered copy + `AnimatedEmoji` (pulse/rotate/bounce, built on
 * React Native's own `Animated` API) throughout this screen are a
 * deliberate product/tone pass — the underlying setup logic and step
 * sequencing are unchanged from before.
 */

type CosmeticStep = { key: string; label: string };
const COSMETIC_STEPS: CosmeticStep[] = [
  { key: "warmup", label: "✨ Tuning quick-recall for your device" },
  { key: "sandbox", label: "🛡️ Locking in 100% offline privacy" },
];
const COSMETIC_STEP_DURATION_MS = 1100;

/**
 * Build 40 onboarding resilience — see services/ai/memoryGuard.ts's own doc
 * comment for the full three-layer picture (this screen owns layers 1, 2,
 * and the visible half of layer 3; modelDownloadManager.ts's
 * `runOnboardingThreadCalibration` owns the other half). None of this can
 * PREVENT Android's low-memory killer from reaping this process — no app
 * gets a vote in that — it only guarantees the user is told what's
 * happening instead of watching a silent freeze, and is never left with
 * zero way forward.
 *
 * How long setup is allowed to run (measured from `onboardingStartedAt`,
 * persisted so it survives a process kill and relaunch — this is real
 * elapsed wall-clock time, not "time since this particular app instance
 * started") before the "Continue with safe settings" escape hatch appears.
 * Generous enough that a genuinely slow download or a single retried
 * calibration attempt never trips it; short enough that a user isn't left
 * waiting anywhere near the "stuck for hours" a repeated-kill loop could
 * otherwise cause.
 */
const ESCAPE_HATCH_TIMEOUT_MS = 3 * 60 * 1000;

function formatEta(etaSeconds: number): string {
  if (etaSeconds <= 0) {
    return "";
  }
  const minutes = Math.ceil(etaSeconds / 60);
  return minutes <= 1 ? " · under a minute left" : ` · about ${minutes} min left`;
}

type StepRowState = "done" | "active" | "pending";

/**
 * `key={state}` on the icon is what makes the two animated states actually
 * animate: React remounts a fresh element (rather than patching props onto
 * the same one) whenever `state` changes, so `AnimatedEmoji`'s "bounce"
 * (one-shot, plays on mount — see its own doc comment) fires exactly at the
 * moment a row flips to "done", and "rotate" naturally restarts cleanly if a
 * row ever re-enters "active" rather than continuing a stale loop.
 */
function StepRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: StepRowState;
  detail?: string;
}) {
  return (
    <View style={styles.stepRow}>
      {state === "done" ? (
        <AnimatedEmoji key={state} emoji="✓" type="bounce" size={15} style={[styles.stepIcon, styles.stepIconDone]} />
      ) : state === "active" ? (
        <AnimatedEmoji key={state} emoji="⏳" type="rotate" size={15} style={styles.stepIcon} />
      ) : (
        <Text style={styles.stepIcon}>○</Text>
      )}
      <View style={styles.stepTextColumn}>
        <Text style={[styles.stepLabel, state === "pending" && styles.stepLabelPending]}>{label}</Text>
        {detail ? <Text style={styles.stepDetail}>{detail}</Text> : null}
      </View>
    </View>
  );
}

export function OnboardingSetupScreen({ onComplete }: { onComplete: () => void }) {
  const modelDownload = useModelDownload();
  const [cosmeticStepIndex, setCosmeticStepIndex] = useState(0);
  // Renamed from the old isReadyPillShown: this now gates a real tappable
  // "Start Capturing Thoughts ✨" button rather than a passive pill that
  // auto-advanced past itself — see the completion sequence below, which no
  // longer calls `onComplete()` on a timer. The user crossing the "One
  // Door" is now an explicit, deliberate tap rather than something that
  // just happens to them after a pause; the setup work finishing is still
  // fully automatic either way.
  const [isReadyToStart, setIsReadyToStart] = useState(false);
  const completionStarted = useRef(false);

  // Build 40 onboarding resilience — see memoryGuard.ts's own doc comment
  // for the full three-layer picture. Purely informational; nothing here
  // blocks or pauses the underlying setup work, which keeps running
  // regardless — the point is the user is never left guessing why
  // something might be slow or might need a retry.
  const [memoryWarning, setMemoryWarning] = useState<string | null>(null);
  const [showEscapeHatch, setShowEscapeHatch] = useState(false);

  useEffect(() => {
    let unmounted = false;
    // QA Phase 3, P3-1 fix: this used to be declared *inside* the async
    // IIFE below and "cleared" by returning `() => clearTimeout(timer)`
    // from it — but that return value is the IIFE's own resolved value,
    // never awaited or captured anywhere, so React never called it. The
    // timer was never actually cleared on unmount; it was harmless only
    // because its own callback re-checks `unmounted` before doing anything.
    // Hoisting it to this outer scope lets the real cleanup below
    // (line ~181's `return () => { ... }`) clear it directly.
    let escapeHatchTimer: ReturnType<typeof setTimeout> | undefined;
    const stopWatching = watchForMemoryPressure(() => {
      if (!unmounted) {
        setMemoryWarning(LOW_MEMORY_WARNING_MESSAGE);
      }
    });

    // Escape hatch timer: measured from the FIRST time onboarding ever
    // started for this install, persisted so a process kill and relaunch
    // doesn't reset the clock — this has to reflect real elapsed time
    // across possibly several attempts, not just how long the current
    // process instance has been alive.
    void (async () => {
      const prefs = await readPreferences();
      const startedAt = prefs.onboardingStartedAt ?? Date.now();
      if (prefs.onboardingStartedAt === null) {
        await writePreferences({ onboardingStartedAt: startedAt });
      }
      const remaining = ESCAPE_HATCH_TIMEOUT_MS - (Date.now() - startedAt);
      if (unmounted) return;
      if (remaining <= 0) {
        setShowEscapeHatch(true);
        return;
      }
      escapeHatchTimer = setTimeout(() => {
        if (!unmounted) setShowEscapeHatch(true);
      }, remaining);
    })();

    return () => {
      unmounted = true;
      stopWatching();
      clearTimeout(escapeHatchTimer);
    };
  }, []);

  const handleContinueAnyway = async () => {
    // Skips straight to "done" with whatever thread setting is currently
    // in effect (the safe conservative default if calibration never got a
    // chance to run or accept anything) — the whole point of this button
    // is getting the user into a working app now, not making them wait
    // through the remaining cosmetic steps too.
    await markSetupComplete();
    onComplete();
  };

  useEffect(() => {
    if (modelDownload.status !== "ready" || completionStarted.current) {
      return;
    }
    completionStarted.current = true;

    let cancelled = false;
    async function runCompletionSequence() {
      // Layer 1 of the memory-pressure defense (memoryGuard.ts): a
      // pre-flight check right before the heaviest, most failure-prone
      // step. If the system already reports being low on memory, skip the
      // optimistic thread trial entirely (same safe fallback used when a
      // PREVIOUS attempt didn't survive) rather than risk being the straw
      // that gets this process killed, and let the user know why.
      const memoryCheck = checkMemoryBeforeOnboarding();
      if (!memoryCheck.safe) {
        setMemoryWarning(memoryCheck.message);
      }

      // Step 0, "Tuning quick-recall for your device" — a REAL calibration
      // trial, not a fixed cosmetic pause; see this file's own doc comment
      // above for why. Internally bounded/cancellable (localLlama.ts's
      // CALIBRATION_TIMEOUT_MS), so this never blocks setup from
      // completing even on a device the optimistic attempt doesn't suit.
      await runOnboardingThreadCalibration(!memoryCheck.safe);
      if (cancelled) return;
      setCosmeticStepIndex(1);

      // Step 1, "Locking in 100% offline privacy" — still cosmetic pacing,
      // see this file's own doc comment for why.
      await new Promise((resolve) => setTimeout(resolve, COSMETIC_STEP_DURATION_MS));
      if (cancelled) return;
      setCosmeticStepIndex(2);

      await new Promise((resolve) => setTimeout(resolve, COSMETIC_STEP_DURATION_MS));
      if (cancelled) return;

      await markSetupComplete();
      void showSetupCompleteNotification();
      setIsReadyToStart(true);
    }
    void runCompletionSequence();

    return () => {
      cancelled = true;
    };
  }, [modelDownload.status]);

  const llamaActive = modelDownload.status === "downloading" && modelDownload.phasesReady.embedding;
  const llamaDetail =
    modelDownload.phasesReady.llama
      ? undefined
      : `${modelDownload.downloadedMB.toFixed(0)} MB / ${modelDownload.totalMB.toFixed(0)} MB` +
        (modelDownload.speedMBps > 0 ? ` · ${modelDownload.speedMBps.toFixed(1)} MB/s` : "") +
        formatEta(modelDownload.etaSeconds);

  const isPaused = modelDownload.status === "paused_offline";
  const isError = modelDownload.status === "error";

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <View style={styles.titleRow}>
          <AnimatedEmoji emoji="🧠" type="pulse" size={19} style={styles.titleEmoji} />
          <Text style={styles.title}>Preparing Xayra - Your Pocket Companion</Text>
        </View>
        <Text style={styles.body}>
          Everything Xayra needs is loading directly onto your phone so your thoughts and notes
          stay 100% private. Feel free to minimize the app—we’ll notify you the moment it’s ready!
        </Text>

        {isPaused && (
          <View style={styles.pausedBanner}>
            <Text style={styles.pausedText}>Waiting for a network connection — this will resume automatically.</Text>
          </View>
        )}

        {isError && (
          <View style={styles.errorBanner}>
            <Text style={styles.errorText}>
              {modelDownload.error ?? "Setup was interrupted."}
            </Text>
            <Pressable style={styles.retryButton} onPress={() => void resumeDownloads()}>
              <Text style={styles.retryButtonText}>Retry</Text>
            </Pressable>
          </View>
        )}

        {memoryWarning && !isReadyToStart && (
          <View style={styles.pausedBanner}>
            <Text style={styles.pausedText}>{memoryWarning}</Text>
          </View>
        )}

        <View style={styles.divider} />

        <StepRow
          label="🎙️ Setting up hands-free voice listener"
          state={modelDownload.phasesReady.whisper ? "done" : "active"}
        />
        <StepRow
          label="🔐 Building your encrypted private vault"
          state={modelDownload.phasesReady.embedding ? "done" : modelDownload.phasesReady.whisper ? "active" : "pending"}
        />
        <StepRow
          label="⏳ Loading Xayra's memory engine"
          state={modelDownload.phasesReady.llama ? "done" : llamaActive ? "active" : "pending"}
          detail={llamaDetail}
        />
        <StepRow
          label={COSMETIC_STEPS[0].label}
          state={cosmeticStepIndex > 0 ? "done" : modelDownload.phasesReady.llama ? "active" : "pending"}
        />
        <StepRow
          label={COSMETIC_STEPS[1].label}
          state={cosmeticStepIndex > 1 ? "done" : cosmeticStepIndex === 1 ? "active" : "pending"}
        />

        {isReadyToStart && (
          <Pressable
            style={({ pressed }) => [styles.startButton, pressed && styles.startButtonPressed]}
            onPress={onComplete}
          >
            <Text style={styles.startButtonText}>Start Capturing Thoughts ✨</Text>
          </Pressable>
        )}

        {/* Build 40 onboarding resilience, layer 3's visible half — see
            memoryGuard.ts's own doc comment. Only ever appears after
            several minutes of real elapsed time (survives a process kill
            and relaunch, see this file's own escape-hatch timer above), and
            only while setup genuinely hasn't finished yet — never a
            competing button alongside the normal "Start Capturing
            Thoughts" above. */}
        {showEscapeHatch && !isReadyToStart && (
          <>
            <Text style={styles.escapeHatchHint}>
              This is taking longer than usual — you can jump in now with safe default settings, or keep waiting.
            </Text>
            <Pressable
              style={({ pressed }) => [styles.escapeHatchButton, pressed && styles.startButtonPressed]}
              onPress={() => void handleContinueAnyway()}
            >
              <Text style={styles.escapeHatchButtonText}>Continue with Safe Settings</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  card: {
    width: "100%",
    maxWidth: 440,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.xl,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.md,
  },
  titleEmoji: {
    marginRight: spacing.xs,
  },
  title: {
    ...typography.heading,
    color: colors.textPrimary,
    flexShrink: 1,
  },
  body: {
    ...typography.body,
    color: colors.textSecondary,
    marginBottom: spacing.sm,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginVertical: spacing.lg,
  },
  pausedBanner: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentMuted,
  },
  pausedText: {
    ...typography.caption,
    color: colors.textPrimary,
  },
  errorBanner: {
    marginTop: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.dangerMuted,
  },
  errorText: {
    ...typography.caption,
    color: colors.textPrimary,
    marginBottom: spacing.sm,
  },
  retryButton: {
    alignSelf: "flex-start",
    paddingVertical: spacing.xs,
    paddingHorizontal: spacing.base,
    borderRadius: radius.pill,
    backgroundColor: colors.danger,
  },
  retryButtonText: {
    ...typography.label,
    color: colors.textPrimary,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  stepIcon: {
    width: 24,
    fontSize: 15,
    color: colors.textMuted,
  },
  stepIconDone: {
    color: colors.success,
  },
  stepTextColumn: {
    flex: 1,
  },
  stepLabel: {
    ...typography.subheading,
    color: colors.textPrimary,
  },
  stepLabelPending: {
    color: colors.textMuted,
  },
  stepDetail: {
    ...typography.caption,
    color: colors.textSecondary,
    marginTop: 2,
  },
  startButton: {
    alignSelf: "stretch",
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
    alignItems: "center",
  },
  startButtonPressed: {
    opacity: 0.85,
  },
  startButtonText: {
    ...typography.label,
    color: "#08221A",
  },
  escapeHatchHint: {
    ...typography.caption,
    color: colors.textSecondary,
    textAlign: "center",
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  escapeHatchButton: {
    alignSelf: "stretch",
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceElevated,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: "center",
  },
  escapeHatchButtonText: {
    ...typography.label,
    color: colors.textPrimary,
  },
});
