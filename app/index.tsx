import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { ActiveModePill } from "../components/ActiveModePill";
import { CentralMicButton } from "../components/CentralMicButton";
import { NoteCard } from "../components/NoteCard";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { SmartNudgeBanner } from "../components/SmartNudgeBanner";
import { ViewToggle } from "../components/ViewToggle";
import { colors, radius, spacing, typography } from "../constants/theme";
import { asrRouter } from "../services/ai/asrRouter";
import { onEmbeddingDownloadProgress } from "../services/ai/embeddingModel";
import { useActiveMode, type ActiveModeUtteranceHandler } from "../services/audio/activeMode";
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakTextAndWait } from "../services/audio/tts";
import {
  createVoiceNote,
  deleteNote,
  isSilentTranscript,
  listNotes,
  purgeAllNotes,
  retryPendingEmbeddings,
  type Note,
} from "../services/notes/noteManager";
import { readPreferences } from "../services/settings/preferences";
import {
  getSyncStatus,
  restoreFromDrive,
  signInWithGoogle,
  type SyncStatus,
} from "../services/sync/driveSync";

const NUDGE_BANNER_MIN_NOTES = 5;

type ProcessingState = "idle" | "processing";
type DisplayNote = {
  id: string;
  content: string;
  audioUri: string | null;
  transcriptionModel: string | null;
  createdAt: number;
};

export default function HomeScreen() {
  const router = useRouter();
  const recorder = useVoiceRecorder();
  const [processingState, setProcessingState] = useState<ProcessingState>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ isConnected: false });
  const [isNudgeDismissed, setIsNudgeDismissed] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);
  const [embeddingDownloadProgress, setEmbeddingDownloadProgress] = useState<number | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  // A quiet, self-dismissing banner (distinct from `error`'s red styling)
  // for non-blocking status like "saved without a vector index while
  // offline" — informational, never something the user needs to act on.
  const showInfoMessage = useCallback((message: string) => {
    setInfoMessage(message);
    setTimeout(() => {
      setInfoMessage((current) => (current === message ? null : current));
    }, 4000);
  }, []);

  // Surfaces progress for the embedding model auto-download that
  // localEmbeddings.ts's ensureEmbeddingAssets() triggers transparently the
  // first time a note is saved without it already present — a quiet global
  // subscription rather than something wired through every save call site.
  useEffect(() => {
    return onEmbeddingDownloadProgress((fraction) => {
      setEmbeddingDownloadProgress(fraction < 1 ? fraction : null);
    });
  }, []);

  // First-launch only (not on every focus): if the user hasn't completed or
  // explicitly skipped the Whisper engine setup, send them there before
  // they can try to record and hit the "no model" error instead.
  useEffect(() => {
    void readPreferences().then((prefs) => {
      if (!prefs.onboardingComplete) {
        router.replace("/onboarding");
      }
    });
  }, [router]);

  const refreshNotes = useCallback(async () => {
    try {
      const notes = await listNotes();
      setAllNotes(notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notes.");
    }
  }, []);

  const refreshSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await getSyncStatus());
    } catch (err) {
      console.error("[Sync] Failed to load status", err);
    }
  }, []);

  // Re-query on every focus (e.g. switching back from the Chat tab), not
  // just on mount — op-sqlite state can change from actions taken while
  // this screen wasn't visible.
  useFocusEffect(
    useCallback(() => {
      void refreshNotes();
      void refreshSyncStatus();
      // Cheap, instant no-op while offline/model-not-downloaded (see
      // retryPendingEmbeddings' own guard) — only actually does work once
      // the embedding model is available, catching up any notes saved
      // while it wasn't.
      void retryPendingEmbeddings().then((count) => {
        if (count > 0) {
          void refreshNotes();
        }
      });
    }, [refreshNotes, refreshSyncStatus])
  );

  const handleRestoreFromDrive = useCallback(async () => {
    setIsRestoring(true);
    setError(null);
    try {
      if (!syncStatus.isConnected) {
        await signInWithGoogle();
      }
      await restoreFromDrive();
      await refreshNotes();
      await refreshSyncStatus();
      Alert.alert("Vault Restored", "Your notes have been restored from Google Drive.");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to restore from Google Drive.";
      setError(message);
      Alert.alert("Restore Failed", message);
    } finally {
      setIsRestoring(false);
    }
  }, [syncStatus.isConnected, refreshNotes, refreshSyncStatus]);

  // Active/"Shower" Mode's per-utterance handler: transcribe, save, speak a
  // short confirmation. Errors are swallowed rather than surfaced via Alert
  // — a hands-free loop shouldn't interrupt itself with a dialog the user
  // may not be in a position to dismiss (wet hands, phone across the room).
  // ActiveModeManager re-arms the mic regardless of whether this throws.
  const handleActiveModeUtterance: ActiveModeUtteranceHandler = useCallback(
    async (audioUri, reportState) => {
      try {
        const { transcript, whisperModelId } = await asrRouter.transcribe(audioUri);
        if (isSilentTranscript(transcript)) {
          return;
        }
        const note = await createVoiceNote(audioUri, transcript, whisperModelId ?? null);
        await refreshNotes();
        if (note.status !== "embedded") {
          showInfoMessage("Note saved. It'll become searchable once you're back online.");
        }
        reportState("speaking");
        await speakTextAndWait("Saved.");
      } catch (err) {
        console.error("[ActiveMode] Failed to save note", err);
      }
    },
    [refreshNotes, showInfoMessage]
  );
  const activeMode = useActiveMode(handleActiveModeUtterance);

  const handleToggleActiveMode = useCallback(() => {
    void activeMode.toggle().catch((err) => {
      Alert.alert("Active Mode Error", err instanceof Error ? err.message : String(err));
    });
  }, [activeMode]);

  const handleRecordPress = useCallback(async () => {
    console.log("[RecordButton] Tapped");
    if (recorder.isTransitioning) {
      return;
    }
    setError(null);
    try {
      if (recorder.isRecording) {
        const audioUri = await recorder.stopRecording();
        if (!audioUri) {
          return;
        }
        setProcessingState("processing");
        void asrRouter
          .transcribe(audioUri)
          .then(({ transcript, whisperModelId }) => createVoiceNote(audioUri, transcript, whisperModelId ?? null))
          .then((note) => {
            if (note.status !== "embedded") {
              showInfoMessage("Note saved. It'll become searchable once you're back online.");
            }
            return refreshNotes();
          })
          .catch((err) => {
            console.error("[RecordError]", err, err?.stack);
            const message = err?.message || String(err);
            setError(message);
            Alert.alert("Recording Error", message);
          })
          .finally(() => setProcessingState("idle"));
      } else {
        asrRouter.startListening();
        await recorder.startRecording();
      }
    } catch (err) {
      // recorder.startRecording()/stopRecording() already alert on failure;
      // still log the full stack here so it's visible in one place.
      console.error("[RecordError]", err, (err as Error | undefined)?.stack);
      setError(err instanceof Error ? err.message : "Recording failed.");
    }
  }, [recorder, refreshNotes, showInfoMessage]);

  const handleDeleteNote = useCallback((noteId: string) => {
    Alert.alert(
      "Delete Note",
      "Are you sure you want to permanently delete this note?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void deleteNote(noteId)
              .then(() => {
                setAllNotes((prev) => prev.filter((note) => note.id !== noteId));
              })
              .catch((err) => {
                const message = err instanceof Error ? err.message : "Failed to delete note.";
                setError(message);
                Alert.alert("Delete Error", message);
              });
          },
        },
      ]
    );
  }, []);

  const handlePurgeAll = useCallback(() => {
    Alert.alert(
      "Clear All Notes",
      "Dev utility: permanently deletes every note, embedding, and audio file. Are you sure?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear All",
          style: "destructive",
          onPress: () => {
            void purgeAllNotes()
              .then(() => {
                setAllNotes([]);
              })
              .catch((err) => {
                const message = err instanceof Error ? err.message : "Failed to clear notes.";
                setError(message);
                Alert.alert("Clear Error", message);
              });
          },
        },
      ]
    );
  }, []);

  const isSearchActive = searchQuery.trim().length > 0;

  // Instant, local, client-side filter — no network/model round-trip and
  // nothing that can spin forever. This replaces the previous
  // `hybridSearchNotes` call (vector + FTS via op-sqlite), which needed the
  // on-device embedding model to compute a query vector on every keystroke:
  // if that model wasn't downloaded yet or the device was offline, the
  // search bar's spinner would sit there indefinitely with no results and
  // no error. Every note the list already has loaded (`allNotes`) is right
  // there in memory, so a plain case-insensitive substring match against
  // each note's text is both correct for "find the note with this word in
  // it" and unconditionally fast — no field in the Note type is called
  // "title", so this matches against the note's content (falling back to
  // its raw transcript, same fallback rag.ts uses) — the only real text a
  // note has.
  const displayedNotes: DisplayNote[] = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    const source = query
      ? allNotes.filter((note) => (note.content || note.transcript || "").toLowerCase().includes(query))
      : allNotes;
    return source.map((note) => ({
      id: note.id,
      content: note.content,
      audioUri: note.audioUri,
      transcriptionModel: note.transcriptionModel,
      createdAt: note.createdAt,
    }));
  }, [allNotes, searchQuery]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <View style={styles.headerTextGroup}>
            <View style={styles.brandRow}>
              {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
              <Image source={require("../assets/icon.png")} style={styles.brandLogo} resizeMode="contain" />
              <Text style={styles.title}>Xayra</Text>
            </View>
            <Text style={styles.subtitle}>
              Your notes, kept between you and your device.
            </Text>
          </View>
          <Pressable
            onPress={() => router.push("/settings")}
            hitSlop={12}
            style={({ pressed }) => [styles.settingsButton, pressed && styles.settingsButtonPressed]}
          >
            <Text style={styles.settingsButtonIcon}>⚙</Text>
          </Pressable>
        </View>

        <ViewToggle active="notes" />

        <ActiveModePill
          isActive={activeMode.isActive}
          state={activeMode.state}
          onPress={handleToggleActiveMode}
          disabled={recorder.isRecording || recorder.isTransitioning}
        />

        {allNotes.length >= NUDGE_BANNER_MIN_NOTES && !syncStatus.isConnected && !isNudgeDismissed && (
          <SmartNudgeBanner
            onConnect={() => {
              setIsNudgeDismissed(true);
              router.push("/settings");
            }}
            onDismiss={() => setIsNudgeDismissed(true)}
          />
        )}

        <CentralMicButton
          state={
            recorder.isRecording ? "recording" : processingState === "processing" ? "busy" : "idle"
          }
          onPress={handleRecordPress}
          disabled={processingState === "processing" || recorder.isTransitioning || activeMode.isActive}
        />

        {(recorder.isRecording || processingState === "processing") && (
          <View style={styles.recordingStatusRow}>
            <Text style={styles.recordingStatusText}>
              {recorder.isRecording
                ? "Recording… tap mic to stop"
                : embeddingDownloadProgress !== null
                  ? `Setting up smart search… ${Math.round(embeddingDownloadProgress * 100)}%`
                  : "Saving voice note…"}
            </Text>
            {recorder.isRecording && (
              <Pressable
                onPress={() => {
                  asrRouter.restartListening();
                  void recorder.cancelAndRestart();
                }}
                disabled={recorder.isTransitioning}
                style={styles.resetButton}
              >
                <Text style={styles.resetButtonText}>Reset</Text>
              </Pressable>
            )}
          </View>
        )}

        <View style={styles.searchBar}>
          <Text style={styles.searchIcon}>⌕</Text>
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search your notes…"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
          />
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}
        {infoMessage && <Text style={styles.infoText}>{infoMessage}</Text>}

        {__DEV__ && (
          <Pressable onPress={handlePurgeAll} style={styles.purgeButton}>
            <Text style={styles.purgeButtonText}>Clear all notes (dev)</Text>
          </Pressable>
        )}

        {displayedNotes.length > 0 && (
          <View style={styles.sectionHeaderRow}>
            <Text style={styles.sectionHeader}>
              {isSearchActive ? "Matching notes" : "Recent notes"}
            </Text>
            <Text style={styles.sectionCount}>{displayedNotes.length}</Text>
          </View>
        )}

        <FlatList
          style={styles.results}
          contentContainerStyle={displayedNotes.length === 0 && styles.resultsEmptyContainer}
          data={displayedNotes}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={styles.emptyIcon}>{isSearchActive ? "🔍" : "🎙"}</Text>
              <Text style={styles.emptyText}>
                {isSearchActive ? "No matching notes yet." : "No notes recorded yet."}
              </Text>
              <Text style={styles.emptySubtext}>
                {isSearchActive
                  ? "Try a different search term."
                  : "Tap the mic below to record your first note."}
              </Text>
              {!isSearchActive && (
                <Pressable
                  onPress={handleRestoreFromDrive}
                  disabled={isRestoring}
                  style={styles.restoreLinkRow}
                >
                  {isRestoring ? (
                    <ActivityIndicator color={colors.accent} size="small" />
                  ) : (
                    <Text style={styles.restoreLinkText}>
                      Already have a backup? Restore vault from Google Drive
                    </Text>
                  )}
                </Pressable>
              )}
            </View>
          }
          renderItem={({ item }) => (
            <NoteCard
              content={item.content}
              audioUri={item.audioUri}
              createdAt={item.createdAt}
              transcriptionModel={item.transcriptionModel}
              onPress={() => setSelectedNoteId(item.id)}
              onDelete={() => handleDeleteNote(item.id)}
              onSwitchEngine={() => router.push("/settings")}
            />
          )}
        />

        <NoteDetailModal
          noteId={selectedNoteId}
          visible={selectedNoteId !== null}
          onClose={() => setSelectedNoteId(null)}
          onDeleted={(noteId) => {
            setAllNotes((prev) => prev.filter((note) => note.id !== noteId));
          }}
        />
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
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  headerTextGroup: {
    flex: 1,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  brandLogo: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
  },
  settingsButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.md,
  },
  settingsButtonPressed: {
    backgroundColor: colors.surfaceElevated,
  },
  settingsButtonIcon: {
    color: colors.textSecondary,
    fontSize: 17,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
    marginBottom: spacing.lg,
  },
  sectionHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.md,
    marginBottom: spacing.sm,
  },
  sectionHeader: {
    color: colors.textSecondary,
    ...typography.subheading,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  sectionCount: {
    color: colors.textMuted,
    ...typography.caption,
  },
  restoreLinkRow: {
    marginTop: spacing.lg,
    alignItems: "center",
  },
  restoreLinkText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base,
    height: 48,
  },
  searchIcon: {
    color: colors.textMuted,
    fontSize: 18,
    marginRight: spacing.sm,
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 16,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginTop: spacing.md,
  },
  infoText: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.md,
  },
  results: {
    flex: 1,
  },
  resultsEmptyContainer: {
    flexGrow: 1,
  },
  emptyState: {
    alignItems: "center",
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  emptyIcon: {
    fontSize: 32,
    marginBottom: spacing.sm,
    opacity: 0.7,
  },
  emptyText: {
    color: colors.textSecondary,
    ...typography.subheading,
    textAlign: "center",
  },
  emptySubtext: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.xs,
    textAlign: "center",
  },
  recordingStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.md,
    marginTop: -8,
    marginBottom: spacing.md,
  },
  recordingStatusText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  resetButton: {
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
  },
  resetButtonText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "700",
  },
  purgeButton: {
    alignSelf: "flex-end",
    marginTop: spacing.md,
  },
  purgeButtonText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});
