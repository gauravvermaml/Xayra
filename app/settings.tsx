import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import Constants from "expo-constants";

import { colors, radius, spacing, typography } from "../constants/theme";
import { listNotes, purgeAllNotes } from "../services/notes/noteManager";
import {
  backupToDrive,
  BackupWouldReplaceExistingBackupError,
  getAutoSyncOnWifi,
  getSyncStatus,
  restoreFromDrive,
  setAutoSyncOnWifi,
  signInWithGoogle,
  signOutFromGoogle,
  type SyncStatus,
} from "../services/sync/driveSync";
import { showToast } from "../components/Toast";

/**
 * Speech-to-text engine and AI chat model management used to live here too
 * (a Whisper Base/Tiny picker, a Llama chat-model download card) — both are
 * gone. Xayra now downloads Whisper Base, the embedding model, and a
 * RAM-tiered Llama chat model automatically in the background (see
 * services/ai/modelDownloadManager.ts) with no user-facing choice or manual
 * download step, so there's nothing left here for either of them to manage.
 */

type BusyAction = "connect" | "backup" | "disconnect" | "restore" | "wipe" | null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Build 25 SUB-VERSIONING: reads app.json's `version`/`android.versionCode`
 * straight from Constants rather than a second hardcoded copy of either — so
 * this label can never drift out of sync with app.json the way a literal
 * string would the next time either number changes. */
const APP_VERSION = Constants.expoConfig?.version ?? "1.0.0";
const APP_VERSION_CODE = Constants.expoConfig?.android?.versionCode ?? 0;
const VERSION_LABEL = `v${APP_VERSION} (Build ${APP_VERSION_CODE})`;

export default function SettingsScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [status, setStatus] = useState<SyncStatus>({ isConnected: false });
  const [autoSyncOnWifi, setAutoSyncOnWifiState] = useState(false);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notesStoredLocally, setNotesStoredLocally] = useState<number | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const [syncStatus, autoSync, notes] = await Promise.all([
        getSyncStatus(),
        getAutoSyncOnWifi(),
        listNotes(),
      ]);
      setStatus(syncStatus);
      setAutoSyncOnWifiState(autoSync);
      // A plain count, not "vector index size" or any other internal
      // storage detail — the one number a non-technical user actually wants
      // here is "how many of my notes are safely on this device."
      setNotesStoredLocally(notes.length);
    } catch (err) {
      console.error("[Settings] Failed to load sync status", err);
    } finally {
      setIsLoadingStatus(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshStatus();
    }, [refreshStatus])
  );

  const handleConnect = useCallback(async () => {
    setBusyAction("connect");
    try {
      await signInWithGoogle();
      await refreshStatus();
    } catch (err) {
      Alert.alert("Connection Failed", err instanceof Error ? err.message : "Failed to connect to Google Drive.");
    } finally {
      setBusyAction(null);
    }
  }, [refreshStatus]);

  // Live data-loss report, fixed 2026-09-16 (see
  // BackupWouldReplaceExistingBackupError's own doc comment in
  // driveSync.ts): a fresh/reinstalled app has 0 local notes by
  // definition, and backupToDrive() used to overwrite a real remote backup
  // with that emptiness completely silently. It now throws this specific
  // error instead of uploading — surfaced here as an explicit, scary,
  // named confirmation rather than folded into the generic failure alert
  // below, since "proceed anyway" is a real, permanent-data-loss choice
  // that deserves its own dialog, not a checkbox buried in an error toast.
  const confirmReplaceExistingBackup = useCallback(
    (err: BackupWouldReplaceExistingBackupError) => {
      Alert.alert(
        "This Device Has No Notes",
        `A backup from ${formatTimestamp(err.remoteBackup.modifiedTime)} already exists in this account's Google Drive. Backing up now would permanently erase it and replace it with nothing — this cannot be undone.\n\nIf you're trying to bring your existing notes onto this device, tap "Restore / Sync Notes" instead.`,
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Replace Backup Anyway",
            style: "destructive",
            onPress: () => {
              setBusyAction("backup");
              void backupToDrive({ force: true })
                .then(async () => {
                  await refreshStatus();
                  Alert.alert("Backup Complete", "Your notes vault has been backed up to Google Drive.");
                })
                .catch((forceErr) => {
                  Alert.alert(
                    "Backup Failed",
                    forceErr instanceof Error ? forceErr.message : "Failed to back up to Google Drive."
                  );
                })
                .finally(() => setBusyAction(null));
            },
          },
        ]
      );
    },
    [refreshStatus]
  );

  const handleBackupNow = useCallback(async () => {
    setBusyAction("backup");
    try {
      await backupToDrive();
      await refreshStatus();
      Alert.alert("Backup Complete", "Your notes vault has been backed up to Google Drive.");
    } catch (err) {
      if (err instanceof BackupWouldReplaceExistingBackupError) {
        confirmReplaceExistingBackup(err);
        return;
      }
      Alert.alert("Backup Failed", err instanceof Error ? err.message : "Failed to back up to Google Drive.");
    } finally {
      setBusyAction(null);
    }
  }, [refreshStatus, confirmReplaceExistingBackup]);

  // Delta/merge restore (see driveSync.ts's restoreFromDrive): safe to tap
  // repeatedly and safe even with local notes already on the device — it
  // only ever adds notes this device doesn't already have, never overwrites
  // or duplicates. `refreshStatus` re-fetches `notesStoredLocally` too, so
  // the count on screen reflects the merge immediately.
  const handleRestoreNotes = useCallback(async () => {
    setBusyAction("restore");
    try {
      const { message } = await restoreFromDrive();
      await refreshStatus();
      showToast(message);
    } catch (err) {
      Alert.alert(
        "Restore Failed",
        err instanceof Error ? err.message : "Failed to restore notes from Google Drive."
      );
    } finally {
      setBusyAction(null);
    }
  }, [refreshStatus]);

  const handleDisconnect = useCallback(() => {
    Alert.alert(
      "Disconnect Google Drive",
      "This stops future backups but does not delete your existing backup or any local notes. Continue?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Disconnect",
          style: "destructive",
          onPress: () => {
            setBusyAction("disconnect");
            void signOutFromGoogle()
              .then(refreshStatus)
              .catch((err) => {
                Alert.alert("Error", err instanceof Error ? err.message : "Failed to disconnect.");
              })
              .finally(() => setBusyAction(null));
          },
        },
      ]
    );
  }, [refreshStatus]);

  // DATA DELETION & PRIVACY COMPLIANCE: the only user-facing path in the app
  // that irreversibly wipes every note, embedding, FTS row, and on-disk
  // audio file (purgeAllNotes() already did all of that — it just had no UI
  // in front of it before this, only a globalThis.__purgeAllNotes debug
  // hook reachable from a JS console). Double-confirmed (a plain destructive
  // Alert, matching handleDisconnect's own pattern) since there's no undo —
  // this is deliberately more final than "Disconnect Google Drive" above,
  // which only ever stops future syncing.
  const handleWipeAllNotes = useCallback(() => {
    Alert.alert(
      "Delete All Notes",
      "This permanently deletes every note, recording, and search index on this device. This cannot be undone. Your Google Drive backup (if any) is not affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Everything",
          style: "destructive",
          onPress: () => {
            setBusyAction("wipe");
            void purgeAllNotes()
              .then(async () => {
                await refreshStatus();
                showToast("All local notes deleted.");
              })
              .catch((err) => {
                Alert.alert("Error", err instanceof Error ? err.message : "Failed to delete local notes.");
              })
              .finally(() => setBusyAction(null));
          },
        },
      ]
    );
  }, [refreshStatus]);

  const handleToggleAutoSync = useCallback((next: boolean) => {
    setAutoSyncOnWifiState(next);
    void setAutoSyncOnWifi(next);
  }, []);

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 40, 48) },
        ]}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Pressable
            onPress={() => router.back()}
            hitSlop={12}
            style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
          >
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Settings</Text>
        </View>

        <Text style={styles.groupLabel}>Cloud Backup</Text>
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <View style={styles.statusDotWrap}>
              <View
                style={[
                  styles.statusDot,
                  status.isConnected ? styles.statusDotConnected : styles.statusDotDisconnected,
                ]}
              />
            </View>
            <View style={styles.cardHeaderTextGroup}>
              <Text style={styles.cardTitle}>Private Google Drive Backup</Text>
              <Text style={styles.cardSubtitle}>
                {isLoadingStatus
                  ? "Checking connection…"
                  : status.isConnected
                    ? status.email
                    : "Not connected"}
              </Text>
            </View>
          </View>

          {isLoadingStatus ? (
            <ActivityIndicator color={colors.textMuted} style={styles.cardLoading} />
          ) : status.isConnected ? (
            <>
              <View style={styles.divider} />

              <Text style={styles.metaText}>
                Stores an encrypted backup in your personal Google Drive that only Xayra can read
                — no one else, not even Google, can open it.
              </Text>

              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Auto-sync on Wi-Fi</Text>
                <Switch
                  value={autoSyncOnWifi}
                  onValueChange={handleToggleAutoSync}
                  trackColor={{ false: colors.border, true: colors.accent }}
                  thumbColor={colors.textPrimary}
                />
              </View>

              <View style={styles.modelButtonRow}>
                <Pressable
                  onPress={handleBackupNow}
                  disabled={busyAction !== null}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    styles.modelButtonFlex,
                    pressed && styles.buttonPressed,
                    busyAction !== null && styles.buttonDisabled,
                  ]}
                >
                  {busyAction === "backup" ? (
                    <ActivityIndicator color={colors.onAccent} size="small" />
                  ) : (
                    <Text style={styles.primaryButtonText}>Back Up Now</Text>
                  )}
                </Pressable>

                <Pressable
                  onPress={handleRestoreNotes}
                  disabled={busyAction !== null}
                  style={({ pressed }) => [
                    styles.secondaryButton,
                    styles.modelButtonFlex,
                    pressed && styles.buttonPressed,
                    busyAction !== null && styles.buttonDisabled,
                  ]}
                >
                  {busyAction === "restore" ? (
                    <ActivityIndicator color={colors.accent} size="small" />
                  ) : (
                    <Text style={styles.secondaryButtonText}>Restore / Sync Notes</Text>
                  )}
                </Pressable>
              </View>

              <Pressable
                onPress={handleDisconnect}
                disabled={busyAction !== null}
                style={({ pressed }) => [
                  styles.dangerButton,
                  pressed && styles.buttonPressed,
                  busyAction !== null && styles.buttonDisabled,
                ]}
              >
                {busyAction === "disconnect" ? (
                  <ActivityIndicator color={colors.danger} size="small" />
                ) : (
                  <Text style={styles.dangerButtonText}>Disconnect Account</Text>
                )}
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.metaText}>
                Stores an encrypted backup in your personal Google Drive that only Xayra can
                read. Your notes never leave this device until you connect Google Drive here.
              </Text>
              <Pressable
                onPress={handleConnect}
                disabled={busyAction !== null}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.buttonPressed,
                  busyAction !== null && styles.buttonDisabled,
                ]}
              >
                {busyAction === "connect" ? (
                  <ActivityIndicator color={colors.onAccent} size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>Connect Google Drive</Text>
                )}
              </Pressable>
            </>
          )}
        </View>

        <Text style={[styles.groupLabel, styles.sectionSpacing]}>Storage & Stats</Text>
        <View style={styles.card}>
          <View style={styles.metricRow}>
            <Text style={styles.metricLabel}>Notes stored locally</Text>
            <Text style={styles.metricValue}>{notesStoredLocally ?? "—"}</Text>
          </View>
          {status.isConnected && (
            <>
              <View style={styles.metricRow}>
                <Text style={styles.metricLabel}>Last backup time</Text>
                <Text style={styles.metricValue}>
                  {status.lastBackupTime ? formatTimestamp(status.lastBackupTime) : "Never"}
                </Text>
              </View>
              {status.backupSizeBytes != null && (
                <View style={styles.metricRow}>
                  <Text style={styles.metricLabel}>Backup size</Text>
                  <Text style={styles.metricValue}>{formatBytes(status.backupSizeBytes)}</Text>
                </View>
              )}
            </>
          )}
        </View>

        <Text style={[styles.groupLabel, styles.sectionSpacing]}>Data & Privacy</Text>
        <View style={styles.card}>
          <Text style={styles.metaText}>
            Every note, recording, and search index lives only in this app's own encrypted storage on this device.
            Deleting them here removes them completely and immediately — there's no server copy to also clear.
          </Text>
          <Pressable
            onPress={handleWipeAllNotes}
            disabled={busyAction !== null || notesStoredLocally === 0}
            style={({ pressed }) => [
              styles.dangerButton,
              pressed && styles.buttonPressed,
              (busyAction !== null || notesStoredLocally === 0) && styles.buttonDisabled,
            ]}
          >
            {busyAction === "wipe" ? (
              <ActivityIndicator color={colors.danger} size="small" />
            ) : (
              <Text style={styles.dangerButtonText}>Delete All Notes</Text>
            )}
          </Pressable>
        </View>

        <Text style={styles.versionFooter}>{VERSION_LABEL}</Text>
      </ScrollView>
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
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
  },
  header: {
    marginBottom: spacing.lg,
  },
  backButton: {
    alignSelf: "flex-start",
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
  },
  backButtonPressed: {
    opacity: 0.6,
  },
  backButtonText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
  },
  groupLabel: {
    color: colors.textMuted,
    ...typography.caption,
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: spacing.sm,
    marginLeft: spacing.xs,
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.xl,
    padding: spacing.lg,
  },
  cardHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
  },
  statusDotWrap: {
    width: 12,
    marginRight: spacing.md,
    alignItems: "center",
  },
  statusDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusDotConnected: {
    backgroundColor: colors.success,
  },
  statusDotDisconnected: {
    backgroundColor: colors.warning,
  },
  cardHeaderTextGroup: {
    flex: 1,
  },
  cardTitle: {
    color: colors.textPrimary,
    ...typography.heading,
  },
  cardSubtitle: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: 2,
  },
  cardLoading: {
    marginTop: spacing.lg,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginVertical: spacing.base,
  },
  metricRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  metricLabel: {
    color: colors.textMuted,
    fontSize: 13,
  },
  metricValue: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  metaText: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.md,
    marginBottom: spacing.lg,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.lg,
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: "700",
  },
  // Deliberately lighter visual weight than primaryButton — a filled accent
  // button reads as "the main action," so pairing two of them side by side
  // (Back Up / Restore) made both look equally urgent when they aren't:
  // backing up is the common, low-risk action; restoring is occasional and
  // slightly more consequential (writes into the local vault), so it gets
  // the outline treatment instead.
  secondaryButton: {
    backgroundColor: "transparent",
    borderColor: colors.accent,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  secondaryButtonText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "700",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  dangerButton: {
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
    backgroundColor: colors.dangerMuted,
    borderRadius: radius.md,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.sm,
  },
  dangerButtonText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: "700",
  },
  sectionSpacing: {
    marginTop: spacing.xl,
  },
  modelButtonRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  modelButtonFlex: {
    flex: 1,
    marginTop: 0,
  },
  versionFooter: {
    color: colors.textMuted,
    fontSize: 12,
    textAlign: "center",
    marginTop: spacing.xl,
    opacity: 0.7,
  },
});
