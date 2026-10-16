import { useCallback, useRef, useState } from "react";
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
  BackupAccountMismatchError,
  ExtraPrivacyKeyNeededError,
  ProtectionChangeUnfinishedError,
  RecoveryCodeIncorrectError,
  RecoveryCodeRequiredError,
  backupToDrive,
  enterExtraPrivacyCode,
  getBackupProtectionStatus,
  removeOlderGoogleOnlyBackups,
  switchBackToStandardProtection,
  type BackupProtectionStatus,
  getSyncStatus,
  restoreFromDrive,
  signInWithGoogle,
  signOutFromGoogle,
  switchBackupsToSignedInAccount,
  type SyncStatus,
} from "../services/sync/driveSync";
import { showToast } from "../components/Toast";
import { ExtraPrivacySetup, RecoveryCodePrompt, showRestoreResult } from "../components/ExtraPrivacyFlows";
import { restoreWithRecoveryCode } from "../services/sync/codeRestore";
import { checkVaultAgainstLegacy, getLegacyCopyStatus, removeLegacyCopy } from "../services/vault/legacyCopy";
import { userFacingMessage } from "../services/errors/userMessage";

/**
 * Speech-to-text engine and AI chat model management used to live here too
 * (a Whisper Base/Tiny picker, a Llama chat-model download card) — both are
 * gone. Xayra now downloads Whisper Base, the embedding model, and a
 * RAM-tiered Llama chat model automatically in the background (see
 * services/ai/modelDownloadManager.ts) with no user-facing choice or manual
 * download step, so there's nothing left here for either of them to manage.
 */

type BusyAction = "connect" | "backup" | "disconnect" | "restore" | "wipe" | "privacy" | "legacy" | null;
type CodePrompt = { purpose: "restore" | "join"; busy: boolean; error: string | null } | null;

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
  // The unencrypted database from before the update to encryption, if still here.
  const [legacyCopyPresent, setLegacyCopyPresent] = useState(false);
  const [isLoadingStatus, setIsLoadingStatus] = useState(true);
  const [busyAction, setBusyAction] = useState<BusyAction>(null);
  const [notesStoredLocally, setNotesStoredLocally] = useState<number | null>(null);
  const [protection, setProtection] = useState<BackupProtectionStatus>({ account: null, local: { mode: "standard" }, googleOnlyBackups: null });
  const [setupMode, setSetupMode] = useState<"activate" | "replace" | null>(null);
  const [codePrompt, setCodePrompt] = useState<CodePrompt>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const [syncStatus, notes, protectionStatus, legacy] = await Promise.all([
        getSyncStatus(),
        listNotes(),
        getBackupProtectionStatus(),
        getLegacyCopyStatus().catch(() => ({ present: false, bytes: 0 })),
      ]);
      setStatus(syncStatus);
      setProtection(protectionStatus);
      setLegacyCopyPresent(legacy.present);
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
      Alert.alert("Connection Failed", userFacingMessage(err, "Failed to connect to Google Drive."));
    } finally {
      setBusyAction(null);
    }
  }, [refreshStatus]);

  // A different Google account than the one this phone backs up to: never
  // merge or restore across accounts silently — the user chooses.
  const offerAccountSwitch = useCallback((retry: () => void) => {
    Alert.alert(
      "Different Google account",
      "This phone backs up to a different Google account. Switch back to that account to keep using its backup, or use the account you're signed in with from now on.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Use this account",
          onPress: () => {
            void switchBackupsToSignedInAccount()
              .then(retry)
              .catch((err: unknown) => Alert.alert("Couldn't switch accounts", userFacingMessage(err, "Nothing was changed.")));
          },
        },
      ]
    );
  }, []);

  // backupToDrive() resolves only after the new encrypted generation was
  // downloaded back, decrypted and checked (services/backup/backupService.ts),
  // so "Backup verified" is never shown for a backup that didn't happen.
  const handleBackupNow = useCallback(async () => {
    setBusyAction("backup");
    try {
      const { message, skipped } = await backupToDrive();
      await refreshStatus();
      Alert.alert(skipped ? "Already backed up" : "Backup verified", message);
    } catch (err) {
      if (err instanceof BackupAccountMismatchError) {
        offerAccountSwitch(() => void handleBackupNowRef.current?.());
        return;
      }
      if (err instanceof ExtraPrivacyKeyNeededError) {
        setCodePrompt({ purpose: "join", busy: false, error: null });
        return;
      }
      Alert.alert(
        "Backup didn't finish",
        `${userFacingMessage(err, "Couldn't back up to Google Drive.")} Your previous backup is unchanged.`
      );
    } finally {
      setBusyAction(null);
    }
  }, [refreshStatus, offerAccountSwitch]);
  const handleBackupNowRef = useRef<(() => Promise<void>) | null>(null);
  handleBackupNowRef.current = handleBackupNow;

  // Merge restore: only adds what this phone doesn't have; reports success
  // only after every backed-up note is confirmed present.
  const handleRestoreNotes = useCallback(async () => {
    setBusyAction("restore");
    try {
      const result = await restoreFromDrive();
      await refreshStatus();
      showRestoreResult(result);
    } catch (err) {
      if (err instanceof BackupAccountMismatchError) {
        offerAccountSwitch(() => void handleRestoreNotesRef.current?.());
        return;
      }
      if (err instanceof RecoveryCodeRequiredError) {
        setCodePrompt({ purpose: "restore", busy: false, error: null });
        return;
      }
      Alert.alert("Restore didn't finish", userFacingMessage(err, "Couldn't restore notes from Google Drive."));
    } finally {
      setBusyAction(null);
    }
  }, [refreshStatus, offerAccountSwitch]);
  const handleRestoreNotesRef = useRef<(() => Promise<void>) | null>(null);
  handleRestoreNotesRef.current = handleRestoreNotes;

  // Recovery code entered for a restore (Extra Privacy backup) or to give this
  // phone the Extra Privacy key. The code stays in memory for this call only.
  const handleCodeSubmit = useCallback(
    async (code: string) => {
      const purpose = codePrompt?.purpose;
      setCodePrompt((p) => (p ? { ...p, busy: true, error: null } : p));
      try {
        if (purpose === "restore") {
          const outcome = await restoreWithRecoveryCode(code);
          if (outcome.kind !== "restored") {
            setCodePrompt((p) => (p ? { ...p, busy: false, error: outcome.message } : p));
            return;
          }
          setCodePrompt(null);
          showRestoreResult(outcome.result);
        } else {
          await enterExtraPrivacyCode(code);
          setCodePrompt(null);
          Alert.alert("Extra Privacy is on for this phone", "This phone can back up with Extra Privacy now. Your fingerprint is all it needs from here on.");
        }
        await refreshStatus();
      } catch (err) {
        const message =
          err instanceof RecoveryCodeIncorrectError
            ? err.message
            : `${userFacingMessage(err, "Something went wrong.")} Nothing was changed.`;
        setCodePrompt((p) => (p ? { ...p, busy: false, error: message } : p));
      }
    },
    [codePrompt, refreshStatus]
  );

  const handleRemoveOlderBackups = useCallback(() => {
    Alert.alert(
      "Remove older backups?",
      "This removes the backups made before Extra Privacy, which Google account access alone can open, including the older unencrypted backup from earlier versions of Xayra. Your newest Extra Privacy backup is checked again first and is kept. Removing them can't recall copies that were already downloaded elsewhere.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove older backups",
          style: "destructive",
          onPress: () => {
            setBusyAction("privacy");
            void removeOlderGoogleOnlyBackups(true)
              .then((r) =>
                Alert.alert(
                  "Older backups removed",
                  `Removed ${r.generations} older backup${r.generations === 1 ? "" : "s"}${r.legacyFiles ? " and the older unencrypted backup" : ""}. Only backups locked with your recovery code remain.`
                )
              )
              .catch((err: unknown) =>
                Alert.alert("Nothing was removed", userFacingMessage(err, "Couldn't remove older backups."))
              )
              .finally(() => {
                setBusyAction(null);
                void refreshStatus();
              });
          },
        },
      ]
    );
  }, [refreshStatus]);

  const handleSwitchToStandard = useCallback(() => {
    Alert.alert(
      "Switch back to Standard Protection?",
      "New backups will be restorable with your Google account alone, and anyone with enough access to your Google account could read them. Backups made with Extra Privacy still need your recovery code.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Switch",
          onPress: () => {
            setBusyAction("privacy");
            void switchBackToStandardProtection()
              .then(() => Alert.alert("Standard Protection is on", "A new backup was created and checked. Your fingerprint still opens Xayra."))
              .catch((err: unknown) =>
                err instanceof ProtectionChangeUnfinishedError
                  ? Alert.alert("Standard Protection is on", err.message)
                  : Alert.alert("Nothing was switched", `${userFacingMessage(err, "Couldn't switch.")} Extra Privacy is still on.`)
              )
              .finally(() => {
                setBusyAction(null);
                void refreshStatus();
              });
          },
        },
      ]
    );
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
                Alert.alert("Error", userFacingMessage(err, "Failed to disconnect."));
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
  // Removing the old unencrypted copy: only after a verified Google Drive
  // backup (a copy you can restore) and a check of the encrypted notes; only
  // the old file set is deleted (services/vault/legacyCopy.ts).
  const removeOldCopy = useCallback(async () => {
    setBusyAction("legacy");
    try {
      const removal = await removeLegacyCopy();
      if (removal.failed.length === 0) {
        Alert.alert("Old copy removed", "The old unencrypted copy was deleted from this phone. Your encrypted notes and your Google Drive backups weren't changed.");
      } else if (removal.removed.length === 0) {
        Alert.alert("Nothing was removed", "The old copy couldn't be deleted. Your notes and backups weren't changed. Try again later.");
      } else {
        Alert.alert(
          "Only partly removed",
          `${removal.removed.length} of ${removal.removed.length + removal.failed.length} files of the old copy were deleted; ${removal.failed.length} couldn't be. Try again to remove the rest. Your encrypted notes and backups weren't changed.`
        );
      }
    } finally {
      setBusyAction(null);
      void refreshStatus();
    }
  }, [refreshStatus]);

  const handleRemoveLegacyCopy = useCallback(() => {
    Alert.alert(
      "Remove the old unencrypted copy?",
      "Before this version, Xayra stored your notes without encryption, and that original copy is still on this phone. Xayra will first back up to Google Drive and check that backup, then check your encrypted notes, and only then delete the old copy. Your encrypted notes and your Google Drive backups aren't touched. Deleting a file doesn't guarantee it can never be recovered from the phone's storage.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Continue",
          onPress: () => {
            if (!status.isConnected) {
              Alert.alert("Back up first", "Connect Google Drive and back up first, so you have a copy you can restore. Then remove the old copy. Nothing was removed.");
              return;
            }
            setBusyAction("legacy");
            void (async () => {
              try {
                await backupToDrive();
                const coverage = await checkVaultAgainstLegacy();
                setBusyAction(null);
                if (coverage.missingNotes + coverage.missingTodos === 0) {
                  await removeOldCopy();
                  return;
                }
                Alert.alert(
                  "Some items will be gone for good",
                  `The old copy has ${coverage.missingNotes} note${coverage.missingNotes === 1 ? "" : "s"} and ${coverage.missingTodos} to-do${coverage.missingTodos === 1 ? "" : "s"} that aren't in Xayra any more, usually ones you deleted since the update. Removing the old copy removes them for good.`,
                  [
                    { text: "Keep the old copy", style: "cancel" },
                    { text: "Remove", style: "destructive", onPress: () => void removeOldCopy() },
                  ]
                );
              } catch (err) {
                setBusyAction(null);
                Alert.alert("Nothing was removed", userFacingMessage(err, "The old copy was kept because the checks didn't finish."));
              }
            })();
          },
        },
      ]
    );
  }, [status.isConnected, removeOldCopy]);

  // Deleting everything local also removes the old unencrypted copy, when
  // it's still here: no new backup is required (the user means to delete),
  // keys and recovery information for the kept vault are untouched, and
  // each part's outcome is reported as it actually happened.
  const handleWipeAllNotes = useCallback(() => {
    Alert.alert(
      "Delete All Notes",
      legacyCopyPresent
        ? "This permanently deletes every note, recording and search index on this phone, and the old unencrypted copy of your notes and to-dos left from before the update to encryption. Your to-dos in Xayra are kept. Existing Google Drive backups aren't deleted. This cannot be undone."
        : "This permanently deletes every note, recording and search index on this phone. Your to-dos are kept. Existing Google Drive backups aren't deleted. This cannot be undone.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete Everything",
          style: "destructive",
          onPress: () => {
            setBusyAction("wipe");
            void (async () => {
              let notesError: unknown = null;
              try {
                await purgeAllNotes();
              } catch (err) {
                notesError = err;
              }
              const legacy = legacyCopyPresent ? await removeLegacyCopy().catch(() => null) : { removed: [], failed: [] };
              await refreshStatus();
              setBusyAction(null);
              const legacyFullyRemoved = legacy !== null && legacy.failed.length === 0;
              const legacyNote = legacyCopyPresent
                ? legacyFullyRemoved
                  ? " The old unencrypted copy was deleted too."
                  : " The old unencrypted copy couldn't be fully deleted; try Delete All Notes again."
                : "";
              if (notesError) {
                Alert.alert("Notes weren't deleted", `${userFacingMessage(notesError, "Failed to delete local notes.")}${legacyNote}`);
              } else if (!legacyCopyPresent) {
                showToast("All notes deleted. Your to-dos and Drive backups are kept.");
              } else {
                Alert.alert(
                  legacyFullyRemoved ? "Deleted" : "Notes deleted, old copy not fully removed",
                  `Every note, recording and search index on this phone was deleted.${legacyNote} Your to-dos were kept, and your Google Drive backups weren't deleted.`
                );
              }
            })();
          },
        },
      ]
    );
  }, [refreshStatus, legacyCopyPresent]);

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

              {protection.account === "extra" ? (
                <Text style={styles.metaText}>
                  Backs up to a hidden Xayra folder in your Google Drive, locked with your recovery
                  code (Extra Privacy). New backups open only with that code, or on one of your phones
                  that already holds the key — not by Google, and not by us. Backups made before Extra
                  Privacy stay readable with Google account access until you remove them.
                </Text>
              ) : (
                <Text style={styles.metaText}>
                  Backs up an encrypted copy of your notes to a hidden Xayra folder in your Google
                  Drive. The key to that copy is also kept in your Google account, so you can restore
                  with just your account — and anyone with enough access to your Google account could
                  read it.
                </Text>
              )}

              {/* "Auto-sync on Wi-Fi" is hidden until automatic backup really
                  exists and is tested. The stored preference is left as it is
                  (driveSync.ts getAutoSyncOnWifi) — nothing reads it. */}

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
                Optional encrypted backup to a hidden Xayra folder in your Google Drive. Your notes
                stay only on this phone unless you back them up.
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

        {status.isConnected ? (
          <>
            <Text style={[styles.groupLabel, styles.sectionSpacing]}>Privacy & Security</Text>
            <View style={styles.card}>
              <Text style={styles.cardTitle}>Extra Privacy</Text>
              <Text style={styles.metaText}>
                {protection.account === "extra"
                  ? protection.local.mode === "extra" && protection.local.keyId
                    ? protection.local.state === "activating"
                      ? "Finishing setup. Tap Back Up Now to complete it."
                      : "On. Your backups are locked with your recovery code. Your fingerprint still opens Xayra every day."
                    : "On for your account. Enter your recovery code once on this phone to keep backing up."
                  : "Off. Your backups use Standard Protection: restorable with your Google account alone. Turn on Extra Privacy to also require a recovery code that only you keep."}
              </Text>
              {protection.account === "extra" ? (
                protection.local.mode === "extra" && protection.local.keyId ? (
                  <>
                    <Pressable
                      onPress={() => setSetupMode("replace")}
                      disabled={busyAction !== null}
                      style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed]}
                    >
                      <Text style={styles.secondaryButtonText}>Replace recovery code</Text>
                    </Pressable>
                    {protection.googleOnlyBackups !== false ? (
                      <Pressable
                        onPress={handleRemoveOlderBackups}
                        disabled={busyAction !== null}
                        style={({ pressed }) => [styles.secondaryButton, styles.privacyButtonGap, pressed && styles.buttonPressed]}
                      >
                        <Text style={styles.secondaryButtonText}>Remove older Google-only backups</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={handleSwitchToStandard}
                      disabled={busyAction !== null}
                      style={({ pressed }) => [styles.secondaryButton, styles.privacyButtonGap, pressed && styles.buttonPressed]}
                    >
                      <Text style={styles.secondaryButtonText}>Switch back to Standard Protection</Text>
                    </Pressable>
                  </>
                ) : (
                  <Pressable
                    onPress={() => setCodePrompt({ purpose: "join", busy: false, error: null })}
                    disabled={busyAction !== null}
                    style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
                  >
                    <Text style={styles.primaryButtonText}>Enter recovery code</Text>
                  </Pressable>
                )
              ) : (
                <Pressable
                  onPress={() => setSetupMode("activate")}
                  disabled={busyAction !== null}
                  style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed]}
                >
                  <Text style={styles.primaryButtonText}>Turn on Extra Privacy</Text>
                </Pressable>
              )}
              {busyAction === "privacy" ? <ActivityIndicator color={colors.textMuted} style={styles.cardLoading} /> : null}
            </View>
          </>
        ) : null}

        <ExtraPrivacySetup
          visible={setupMode !== null}
          mode={setupMode ?? "activate"}
          onClose={() => {
            setSetupMode(null);
            void refreshStatus();
          }}
        />
        <RecoveryCodePrompt
          visible={codePrompt !== null}
          title={codePrompt?.purpose === "restore" ? "Enter your recovery code" : "Use Extra Privacy on this phone"}
          detail={
            codePrompt?.purpose === "restore"
              ? "Your backup is locked with Extra Privacy. Enter the recovery code you saved to restore it."
              : "Your backups use Extra Privacy. Enter your recovery code once so this phone can keep backing up."
          }
          busy={codePrompt?.busy ?? false}
          error={codePrompt?.error ?? null}
          onSubmit={(code) => void handleCodeSubmit(code)}
          onCancel={() => setCodePrompt(null)}
        />

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
            Your notes, to-dos and search index are stored encrypted on this phone. Any older voice recordings kept
            with notes are in Xayra's private storage but aren't encrypted. Deleting here removes everything from this
            phone right away; it doesn't delete a Google Drive backup.
          </Text>
          {legacyCopyPresent ? (
            <>
              <Text style={[styles.metaText, styles.privacyButtonGap]}>
                You updated from an earlier version, and the original unencrypted copy of your notes is still in Xayra's
                private storage on this phone.
              </Text>
              <Pressable
                onPress={handleRemoveLegacyCopy}
                disabled={busyAction !== null}
                style={({ pressed }) => [styles.secondaryButton, styles.privacyButtonGap, pressed && styles.buttonPressed]}
              >
                {busyAction === "legacy" ? (
                  <ActivityIndicator color={colors.accent} size="small" />
                ) : (
                  <Text style={styles.secondaryButtonText}>Remove the old unencrypted copy</Text>
                )}
              </Pressable>
            </>
          ) : null}
          <Pressable
            onPress={handleWipeAllNotes}
            disabled={busyAction !== null || (notesStoredLocally === 0 && !legacyCopyPresent)}
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
  privacyButtonGap: { marginTop: spacing.sm },

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
