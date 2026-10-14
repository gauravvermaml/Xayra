import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, spacing, typography } from "../constants/theme";
import {
  DISPOSABLE_CONFIRMATION,
  enterDisposableModeOnNextStart,
  getResolvedVaultMode,
  isDisposableModeSetForNextStart,
  isRunningDevPackage,
  leaveDisposableModeOnNextStart,
} from "../services/dev/disposableVault";

/**
 * Xayra Dev-only control for the disposable test vault
 * (services/dev/disposableVault.ts). Opening this screen — e.g. via
 * `xayra-dev://dev-vault` — changes nothing; switching needs the button AND
 * the confirmation dialog, and only takes effect on the next start. In any
 * other package the screen renders a notice and no controls.
 */
export default function DevVaultScreen() {
  const devPackage = isRunningDevPackage();
  const activeNow = getResolvedVaultMode() === "disposable";
  const [setForNextStart, setSetForNextStart] = useState<boolean | null>(null);

  useEffect(() => {
    if (!devPackage) return;
    void isDisposableModeSetForNextStart().then(setSetForNextStart);
  }, [devPackage]);

  const confirmEnter = useCallback(() => {
    Alert.alert(
      "Use a disposable test vault?",
      "On the next start, Xayra Dev opens an empty, separate test vault with its own key. Your normal vault, its key and its reminders aren't opened or changed. Test notes are erased every time the app restarts, and Google Drive and Calendar are switched off.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Use test vault",
          style: "destructive",
          onPress: () => {
            void enterDisposableModeOnNextStart(DISPOSABLE_CONFIRMATION)
              .then(() => setSetForNextStart(true))
              .catch((err: unknown) => Alert.alert("Not switched", err instanceof Error ? err.message : String(err)));
          },
        },
      ]
    );
  }, []);

  const cancelOrLeave = useCallback(() => {
    void leaveDisposableModeOnNextStart()
      .then(() => setSetForNextStart(false))
      .catch((err: unknown) => Alert.alert("Not switched", err instanceof Error ? err.message : String(err)));
  }, []);

  if (!devPackage) {
    return (
      <SafeAreaView style={styles.screen}>
        <Text style={styles.title}>Unavailable</Text>
        <Text style={styles.body}>Disposable test vaults are only available in Xayra Dev.</Text>
      </SafeAreaView>
    );
  }

  const restartHint = "Close Xayra Dev from Recents and reopen it to switch.";
  let status: string;
  if (activeNow) {
    status = setForNextStart === false ? `Leaving the test vault. ${restartHint}` : "You're in a disposable test vault.";
  } else {
    status = setForNextStart ? `The test vault starts next time. ${restartHint}` : "You're in your normal vault.";
  }

  return (
    <SafeAreaView style={styles.screen}>
      <Text style={styles.title}>Disposable test vault</Text>
      <Text style={styles.body}>
        A separate, empty vault for destructive testing. Its notes are erased whenever the app restarts. It never opens
        your normal vault or its key, its reminders are kept apart from yours, and Drive and Calendar are off.
      </Text>
      <Text style={styles.status}>{status}</Text>
      {setForNextStart === null ? null : setForNextStart ? (
        <Pressable onPress={cancelOrLeave} accessibilityRole="button" style={styles.secondaryButton}>
          <Text style={styles.secondaryLabel}>{activeNow ? "Return to normal vault" : "Cancel switch"}</Text>
        </Pressable>
      ) : activeNow ? null : (
        <Pressable onPress={confirmEnter} accessibilityRole="button" style={styles.button}>
          <Text style={styles.buttonLabel}>Use a disposable test vault…</Text>
        </Pressable>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background, padding: spacing.lg },
  title: { ...typography.title, color: colors.textPrimary, marginBottom: spacing.sm },
  body: { ...typography.body, color: colors.textSecondary, marginBottom: spacing.lg },
  status: { ...typography.body, color: colors.textPrimary, marginBottom: spacing.lg },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  buttonLabel: { ...typography.body, color: colors.background, fontWeight: "600" },
  secondaryButton: {
    borderColor: colors.textSecondary,
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: spacing.md,
    alignItems: "center",
    marginBottom: spacing.lg,
  },
  secondaryLabel: { ...typography.body, color: colors.textPrimary },
});
