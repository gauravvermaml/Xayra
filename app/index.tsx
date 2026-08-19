import { useCallback, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
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
import { asrRouter } from "../services/ai/asrRouter";
import { useActiveMode, type ActiveModeUtteranceHandler } from "../services/audio/activeMode";
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakTextAndWait } from "../services/audio/tts";
import {
  createVoiceNote,
  deleteNote,
  hybridSearchNotes,
  isSilentTranscript,
  listNotes,
  purgeAllNotes,
  type HybridSearchResult,
  type Note,
} from "../services/notes/noteManager";
import {
  getSyncStatus,
  restoreFromDrive,
  signInWithGoogle,
  type SyncStatus,
} from "../services/sync/driveSync";

const NUDGE_BANNER_MIN_NOTES = 5;

const colors = {
  background: "#0f172a",
  surface: "#1e293b",
  border: "#334155",
  textPrimary: "#f8fafc",
  textMuted: "#94a3b8",
  accent: "#6366f1",
  danger: "#f87171",
};

type ProcessingState = "idle" | "processing";
type DisplayNote = { id: string; content: string; audioUri: string | null; score?: number };

export default function HomeScreen() {
  const router = useRouter();
  const recorder = useVoiceRecorder();
  const [processingState, setProcessingState] = useState<ProcessingState>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<HybridSearchResult[]>([]);
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ isConnected: false });
  const [isNudgeDismissed, setIsNudgeDismissed] = useState(false);
  const [isRestoring, setIsRestoring] = useState(false);

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
        const { transcript } = await asrRouter.transcribe(audioUri);
        if (isSilentTranscript(transcript)) {
          return;
        }
        await createVoiceNote(audioUri, transcript);
        await refreshNotes();
        reportState("speaking");
        await speakTextAndWait("Saved.");
      } catch (err) {
        console.error("[ActiveMode] Failed to save note", err);
      }
    },
    [refreshNotes]
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
          .then(({ transcript }) => createVoiceNote(audioUri, transcript))
          .then(() => refreshNotes())
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
  }, [recorder, refreshNotes]);

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
                setResults((prev) => prev.filter((note) => note.id !== noteId));
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
                setResults([]);
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

  const handleSearchChange = useCallback(async (text: string) => {
    setSearchQuery(text);
    if (!text.trim()) {
      setResults([]);
      return;
    }
    setIsSearching(true);
    try {
      const matches = await hybridSearchNotes(text);
      setResults(matches);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed.");
    } finally {
      setIsSearching(false);
    }
  }, []);

  const isSearchActive = searchQuery.trim().length > 0;
  const displayedNotes: DisplayNote[] = isSearchActive
    ? results.map((note) => ({
        id: note.id,
        content: note.content,
        audioUri: note.audioUri,
        score: note.score,
      }))
    : allNotes.map((note) => ({ id: note.id, content: note.content, audioUri: note.audioUri }));

  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.container}>
        <View style={styles.headerRow}>
          <View style={styles.headerTextGroup}>
            <Text style={styles.title}>Remi</Text>
            <Text style={styles.subtitle}>
              Your notes, kept between you and your device.
            </Text>
          </View>
          <Pressable
            onPress={() => router.push("/settings")}
            hitSlop={12}
            style={styles.settingsButton}
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
              {recorder.isRecording ? "Recording… tap mic to stop" : "Saving voice note…"}
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
            onChangeText={handleSearchChange}
            placeholder="Search your notes…"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
          />
          {isSearching && <ActivityIndicator color={colors.textMuted} size="small" />}
        </View>

        {error && <Text style={styles.errorText}>{error}</Text>}

        <Pressable onPress={handlePurgeAll} style={styles.purgeButton}>
          <Text style={styles.purgeButtonText}>Clear all notes (dev)</Text>
        </Pressable>

        <FlatList
          style={styles.results}
          data={displayedNotes}
          keyExtractor={(item) => item.id}
          ListEmptyComponent={
            !isSearching ? (
              <View>
                <Text style={styles.emptyText}>
                  {isSearchActive ? "No matching notes yet." : "No notes recorded yet."}
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
            ) : null
          }
          renderItem={({ item }) => (
            <NoteCard
              content={item.content}
              audioUri={item.audioUri}
              score={item.score}
              onPress={() => setSelectedNoteId(item.id)}
              onDelete={() => handleDeleteNote(item.id)}
            />
          )}
        />

        <NoteDetailModal
          noteId={selectedNoteId}
          visible={selectedNoteId !== null}
          onClose={() => setSelectedNoteId(null)}
          onDeleted={(noteId) => {
            setResults((prev) => prev.filter((note) => note.id !== noteId));
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
    paddingHorizontal: 24,
    paddingTop: 32,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  headerTextGroup: {
    flex: 1,
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
    marginLeft: 12,
  },
  settingsButtonIcon: {
    color: colors.textMuted,
    fontSize: 17,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
    marginBottom: 20,
  },
  restoreLinkRow: {
    marginTop: 16,
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
    borderRadius: 14,
    paddingHorizontal: 16,
    height: 48,
  },
  searchIcon: {
    color: colors.textMuted,
    fontSize: 18,
    marginRight: 8,
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 16,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    marginTop: 12,
  },
  results: {
    flex: 1,
    marginTop: 12,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 24,
    textAlign: "center",
  },
  recordingStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    marginTop: -8,
    marginBottom: 12,
  },
  recordingStatusText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "600",
  },
  resetButton: {
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  resetButtonText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "700",
  },
  purgeButton: {
    alignSelf: "flex-end",
    marginTop: 14,
  },
  purgeButtonText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "600",
    textDecorationLine: "underline",
  },
});
