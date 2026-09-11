import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing, typography } from "../constants/theme";
import { resumeDownloads, useModelDownload } from "../services/ai/modelDownloadManager";
import { markSetupComplete } from "../services/settings/appSettings";
import { showSetupCompleteNotification } from "../services/notifications/setupCompleteNotification";

/**
 * "One Door, Opens Once" onboarding — the whole point (see this feature's
 * own design discussion) is that the user never crosses into the rest of
 * the app until Whisper, the embedding model, AND the Llama chat model are
 * ALL on disk and warm. app/_layout.tsx's root guard renders this in place
 * of the normal Stack until `onComplete` fires; there is no partial/locked
 * state of the real app to peek at from here.
 *
 * The last two checklist rows ("Warming up" / "Finalizing privacy sandbox")
 * are deliberately COSMETIC pacing, not a real measured step — by the time
 * the three real downloads finish, `prewarmLocalLlama()` has already been
 * triggered by modelDownloadManager's own `setStatus` side effect, so
 * there's no separate real "warm-up" operation left for this screen to
 * await. They exist purely so the transition from "99% downloaded" to
 * "ready" doesn't feel like it happened suspiciously instantly.
 */

type CosmeticStep = { key: string; label: string };
const COSMETIC_STEPS: CosmeticStep[] = [
  { key: "warmup", label: "Warming up local inference pipeline" },
  { key: "sandbox", label: "Finalizing local privacy sandbox" },
];
const COSMETIC_STEP_DURATION_MS = 1100;

function formatEta(etaSeconds: number): string {
  if (etaSeconds <= 0) {
    return "";
  }
  const minutes = Math.ceil(etaSeconds / 60);
  return minutes <= 1 ? " · under a minute left" : ` · about ${minutes} min left`;
}

type StepRowState = "done" | "active" | "pending";

function StepRow({
  label,
  state,
  detail,
}: {
  label: string;
  state: StepRowState;
  detail?: string;
}) {
  const icon = state === "done" ? "✓" : state === "active" ? "⏳" : "○";
  return (
    <View style={styles.stepRow}>
      <Text style={[styles.stepIcon, state === "done" && styles.stepIconDone]}>{icon}</Text>
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
  const [isReadyPillShown, setIsReadyPillShown] = useState(false);
  const completionStarted = useRef(false);

  useEffect(() => {
    if (modelDownload.status !== "ready" || completionStarted.current) {
      return;
    }
    completionStarted.current = true;

    let cancelled = false;
    async function runCompletionSequence() {
      for (let i = 0; i < COSMETIC_STEPS.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, COSMETIC_STEP_DURATION_MS));
        if (cancelled) return;
        setCosmeticStepIndex(i + 1);
      }
      await new Promise((resolve) => setTimeout(resolve, COSMETIC_STEP_DURATION_MS));
      if (cancelled) return;

      await markSetupComplete();
      void showSetupCompleteNotification();
      setIsReadyPillShown(true);
      // Brief beat on the "Xayra Ready" pill before handing off to the
      // normal app, rather than an instant cut the moment it appears.
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (cancelled) return;
      onComplete();
    }
    void runCompletionSequence();

    return () => {
      cancelled = true;
    };
  }, [modelDownload.status, onComplete]);

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
        <Text style={styles.title}>🧠 Setting Up Xayra On-Device Intelligence</Text>
        <Text style={styles.body}>
          All processing happens locally on your hardware. Zero cloud leaks. Zero external servers.
        </Text>
        <Text style={styles.body}>
          Feel free to minimize the app — we'll notify you the second Xayra is 100% ready.
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

        <View style={styles.divider} />

        <StepRow label="Speech-to-Text Engine (Whisper)" state={modelDownload.phasesReady.whisper ? "done" : "active"} />
        <StepRow
          label="Local Database & Security Vault"
          state={modelDownload.phasesReady.embedding ? "done" : modelDownload.phasesReady.whisper ? "active" : "pending"}
        />
        <StepRow
          label="AI Intelligence Engine"
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

        {isReadyPillShown && (
          <View style={styles.readyPill}>
            <Text style={styles.readyPillText}>Xayra Ready</Text>
          </View>
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
  title: {
    ...typography.heading,
    color: colors.textPrimary,
    marginBottom: spacing.md,
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
  readyPill: {
    alignSelf: "center",
    marginTop: spacing.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.success,
  },
  readyPillText: {
    ...typography.label,
    color: "#08221A",
  },
});
