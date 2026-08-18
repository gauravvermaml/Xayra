import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import {
  backupToDrive,
  getAutoSyncOnWifi,
  getSyncStatus,
  setAutoSyncOnWifi,
  signInWithGoogle,
  signOutFromGoogle,
  type SyncStatus,
} from "../services/sync/driveSync";

const colors = {
  background: "#0f172a",
  surface: "#1e293b",
  surfaceAlt: "#27324a",
  border: "#334155",
  textPrimary: "#f8fafc",
  textMuted: "#94a3b8",
  accent: "#6366f1",
  danger: "#f87171",
  success: "#34d399",
};

type BusyAction = "connect" | "backup" | "disconnect" | null;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export default function SettingsScreen() {
  const router = useRouter();
  const [status, setStatus] = useState<SyncStatus>({ isConnected: false });
  const [autoSyncOnWifi, setAutoSyncOnWifiState] = useState(false);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const [syncStatus, autoSync] = await Promise.all([getSyncStatus(), getAutoSyncOnWifi()]);
      setStatus(syncStatus);
      setAutoSyncOnWifiState(autoSync);
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

  const handleBackupNow = useCallback(async () => {
    setBusyAction("backup");
    try {
      await backupToDrive();
      await refreshStatus();
      Alert.alert("Backup Complete", "Your notes vault has been backed up to Google Drive.");
    } catch (err) {
      Alert.alert("Backup Failed", err instanceof Error ? err.message : "Failed to back up to Google Drive.");
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

  const handleToggleAutoSync = useCallback((next: boolean) => {
    setAutoSyncOnWifiState(next);
    void setAutoSyncOnWifi(next);
  }, []);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backButton}>
            <Text style={styles.backButtonText}>‹ Back</Text>
          </Pressable>
          <Text style={styles.title}>Settings</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.cardTitle}>Cloud Backup & Restore</Text>

          {isLoadingStatus ? (
            <ActivityIndicator color={colors.textMuted} style={styles.cardLoading} />
          ) : status.isConnected ? (
            <>
              <View style={styles.statusRow}>
                <View style={[styles.statusDot, styles.statusDotConnected]} />
                <Text style={styles.statusTextConnected}>Connected — {status.email}</Text>
              </View>
              <Text style={styles.metaText}>
                {status.lastBackupTime
                  ? `Last backup: ${formatTimestamp(status.lastBackupTime)}` +
                    (status.backupSizeBytes != null ? ` · ${formatBytes(status.backupSizeBytes)}` : "")
                  : "No backup yet on this device."}
              </Text>

              <Pressable
                onPress={handleBackupNow}
                disabled={busyAction !== null}
                style={({ pressed }) => [
                  styles.primaryButton,
                  pressed && styles.buttonPressed,
                  busyAction !== null && styles.buttonDisabled,
                ]}
              >
                {busyAction === "backup" ? (
                  <ActivityIndicator color={colors.background} size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>Back Up Now</Text>
                )}
              </Pressable>

              <View style={styles.toggleRow}>
                <Text style={styles.toggleLabel}>Auto-Sync on Wi-Fi</Text>
                <Switch
                  value={autoSyncOnWifi}
                  onValueChange={handleToggleAutoSync}
                  trackColor={{ false: colors.border, true: colors.accent }}
                />
              </View>

              <Pressable
                onPress={handleDisconnect}
                disabled={busyAction !== null}
                style={({ pressed }) => [styles.dangerButton, pressed && styles.buttonPressed]}
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
              <View style={styles.statusRow}>
                <View style={styles.statusDot} />
                <Text style={styles.statusText}>Status: Local Only (Unprotected)</Text>
              </View>
              <Text style={styles.metaText}>
                Your notes never leave this device unless you connect a backup destination.
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
                  <ActivityIndicator color={colors.background} size="small" />
                ) : (
                  <Text style={styles.primaryButtonText}>Connect Google Drive</Text>
                )}
              </Pressable>
            </>
          )}
        </View>
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
    paddingHorizontal: 24,
    paddingTop: 32,
  },
  header: {
    marginBottom: 24,
  },
  backButton: {
    alignSelf: "flex-start",
    marginBottom: 12,
  },
  backButtonText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: "700",
  },
  card: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 16,
    padding: 18,
  },
  cardTitle: {
    color: colors.textPrimary,
    fontSize: 17,
    fontWeight: "700",
    marginBottom: 14,
  },
  cardLoading: {
    marginVertical: 12,
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.textMuted,
  },
  statusDotConnected: {
    backgroundColor: colors.success,
  },
  statusText: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "600",
  },
  statusTextConnected: {
    color: colors.success,
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  metaText: {
    color: colors.textMuted,
    fontSize: 13,
    marginBottom: 16,
  },
  primaryButton: {
    backgroundColor: colors.accent,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    color: colors.background,
    fontSize: 15,
    fontWeight: "700",
  },
  buttonPressed: {
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
    marginBottom: 18,
  },
  toggleLabel: {
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
  dangerButton: {
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    paddingVertical: 13,
    alignItems: "center",
    justifyContent: "center",
  },
  dangerButtonText: {
    color: colors.danger,
    fontSize: 15,
    fontWeight: "700",
  },
});
