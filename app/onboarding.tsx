import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { colors, elevation, radius, spacing, typography } from "../constants/theme";
import { downloadEmbeddingAssets } from "../services/ai/embeddingModel";
import { downloadWhisperModel, WHISPER_MODELS, type WhisperModelId } from "../services/ai/whisperModels";
import { writePreferences } from "../services/settings/preferences";

const CARD_ORDER: WhisperModelId[] = ["base", "tiny"];

/** Coarse weighting for the combined progress bar: the selected Whisper
 * engine (75-142MB) dominates the embedding model (~34MB), so it gets the
 * larger share of the bar rather than splitting evenly. */
const WHISPER_PHASE_WEIGHT = 0.75;
const EMBEDDING_PHASE_WEIGHT = 1 - WHISPER_PHASE_WEIGHT;

export default function OnboardingScreen() {
  const router = useRouter();
  const [selected, setSelected] = useState<WhisperModelId>("base");
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [downloadPhase, setDownloadPhase] = useState<"engine" | "search">("engine");

  const finishOnboarding = useCallback(async () => {
    await writePreferences({ onboardingComplete: true });
    router.replace("/");
  }, [router]);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    setProgress(0);
    setDownloadPhase("engine");
    try {
      await downloadWhisperModel(selected, (fraction) => setProgress(fraction * WHISPER_PHASE_WEIGHT));
      setDownloadPhase("search");
      await downloadEmbeddingAssets((fraction) =>
        setProgress(WHISPER_PHASE_WEIGHT + fraction * EMBEDDING_PHASE_WEIGHT)
      );
      await finishOnboarding();
    } catch (err) {
      Alert.alert(
        "Download Failed",
        err instanceof Error ? err.message : "Failed to download the required on-device models."
      );
    } finally {
      setIsDownloading(false);
    }
  }, [selected, finishOnboarding]);

  const handleSkip = useCallback(() => {
    Alert.alert(
      "Skip Setup?",
      "Voice notes will rely on your device's built-in speech recognition until you download an on-device engine in Settings > Voice Recognition.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Skip", style: "destructive", onPress: () => void finishOnboarding() },
      ]
    );
  }, [finishOnboarding]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <Text style={styles.eyebrow}>ONE-TIME SETUP</Text>
        <Text style={styles.title}>Choose your transcription engine</Text>
        <Text style={styles.subtitle}>
          Xayra transcribes and searches voice notes entirely on your device. Pick which local
          transcription engine to download — the semantic search model downloads alongside it
          automatically. You can switch engines anytime in Settings.
        </Text>

        <View style={styles.cards}>
          {CARD_ORDER.map((id) => {
            const model = WHISPER_MODELS[id];
            const isSelected = selected === id;
            return (
              <Pressable
                key={id}
                onPress={() => !isDownloading && setSelected(id)}
                style={[styles.card, isSelected && styles.cardSelected]}
              >
                <View style={styles.cardHeaderRow}>
                  <View style={[styles.radio, isSelected && styles.radioSelected]}>
                    {isSelected && <View style={styles.radioDot} />}
                  </View>
                  <Text style={styles.cardLabel}>{model.label}</Text>
                </View>
                <Text style={styles.cardSize}>{model.sizeLabel}</Text>
                <Text style={styles.cardDescription}>{model.description}</Text>
              </Pressable>
            );
          })}
        </View>

        {isDownloading && (
          <View style={styles.progressWrap}>
            <View style={styles.progressTrack}>
              <View style={[styles.progressFill, { width: `${Math.round(progress * 100)}%` }]} />
            </View>
            <View style={styles.progressLabelRow}>
              <Text style={styles.progressPhaseText}>
                {downloadPhase === "engine" ? "Downloading transcription engine…" : "Downloading search model…"}
              </Text>
              <Text style={styles.progressLabel}>{Math.round(progress * 100)}%</Text>
            </View>
          </View>
        )}

        <Pressable
          onPress={handleDownload}
          disabled={isDownloading}
          style={({ pressed }) => [
            styles.primaryButton,
            pressed && styles.buttonPressed,
            isDownloading && styles.buttonDisabled,
          ]}
        >
          {isDownloading ? (
            <ActivityIndicator color={colors.onAccent} size="small" />
          ) : (
            <Text style={styles.primaryButtonText}>
              Download {WHISPER_MODELS[selected].label.split(" (")[0]} Engine
            </Text>
          )}
        </Pressable>

        <Pressable onPress={handleSkip} disabled={isDownloading} hitSlop={12} style={styles.skipButton}>
          <Text style={styles.skipButtonText}>Skip for now</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
  },
  eyebrow: {
    color: colors.accent,
    ...typography.caption,
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: spacing.sm,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
    marginBottom: spacing.sm,
  },
  subtitle: {
    color: colors.textMuted,
    ...typography.body,
    marginBottom: spacing.xl,
  },
  cards: {
    gap: spacing.md,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  cardSelected: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.accent,
    ...elevation.card,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    marginBottom: spacing.xs,
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    borderColor: colors.borderStrong,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.sm,
  },
  radioSelected: {
    borderColor: colors.accent,
  },
  radioDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
  cardLabel: {
    color: colors.textPrimary,
    ...typography.heading,
    flexShrink: 1,
  },
  cardSize: {
    color: colors.textMuted,
    ...typography.caption,
    marginLeft: 26,
    marginBottom: spacing.xs,
  },
  cardDescription: {
    color: colors.textSecondary,
    ...typography.body,
    marginLeft: 26,
  },
  progressWrap: {
    marginTop: spacing.xl,
  },
  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceElevated,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  progressLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  progressPhaseText: {
    color: colors.textMuted,
    ...typography.caption,
  },
  progressLabel: {
    color: colors.textMuted,
    ...typography.caption,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.xl,
  },
  primaryButtonText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: "700",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  skipButton: {
    alignSelf: "center",
    marginTop: spacing.lg,
    paddingVertical: spacing.sm,
  },
  skipButtonText: {
    color: colors.textMuted,
    fontSize: 13,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});
