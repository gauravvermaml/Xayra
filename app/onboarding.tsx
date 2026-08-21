import { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { colors, elevation, radius, spacing, typography } from "../constants/theme";
import { downloadWhisperModel, WHISPER_MODELS, type WhisperModelId } from "../services/ai/whisperModels";
import { writePreferences } from "../services/settings/preferences";

const CARD_ORDER: WhisperModelId[] = ["base", "tiny"];

export default function OnboardingScreen() {
  const router = useRouter();
  const [selected, setSelected] = useState<WhisperModelId>("base");
  const [isDownloading, setIsDownloading] = useState(false);
  const [progress, setProgress] = useState(0);

  const finishOnboarding = useCallback(async () => {
    await writePreferences({ onboardingComplete: true });
    router.replace("/");
  }, [router]);

  const handleDownload = useCallback(async () => {
    setIsDownloading(true);
    setProgress(0);
    try {
      await downloadWhisperModel(selected, setProgress);
      await finishOnboarding();
    } catch (err) {
      Alert.alert(
        "Download Failed",
        err instanceof Error ? err.message : "Failed to download the transcription engine."
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
          Xayra transcribes voice notes entirely on your device. Pick which local Whisper engine to
          download — you can switch anytime in Settings.
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
            <Text style={styles.progressLabel}>{Math.round(progress * 100)}%</Text>
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
  progressLabel: {
    color: colors.textMuted,
    ...typography.caption,
    marginTop: spacing.xs,
    textAlign: "right",
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
