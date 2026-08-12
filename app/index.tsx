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
import { useFocusEffect } from "expo-router";

import { NoteCard } from "../components/NoteCard";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { ViewToggle } from "../components/ViewToggle";
import { useVoiceRecorder } from "../services/audio/recorder";
import {
  createVoiceNote,
  deleteNote,
  hybridSearchNotes,
  listNotes,
  purgeAllNotes,
  type HybridSearchResult,
  type Note,
} from "../services/notes/noteManager";

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
  const recorder = useVoiceRecorder();
  const [processingState, setProcessingState] = useState<ProcessingState>("idle");
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<HybridSearchResult[]>([]);
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshNotes = useCallback(async () => {
    try {
      const notes = await listNotes();
      setAllNotes(notes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notes.");
    }
  }, []);

  // Re-query on every focus (e.g. switching back from the Chat tab), not
  // just on mount — op-sqlite state can change from actions taken while
  // this screen wasn't visible.
  useFocusEffect(
    useCallback(() => {
      void refreshNotes();
    }, [refreshNotes])
  );

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
        void createVoiceNote(audioUri)
          .then(() => refreshNotes())
          .catch((err) => {
            console.error("[RecordError]", err, err?.stack);
            const message = err?.message || String(err);
            setError(message);
            Alert.alert("Recording Error", message);
          })
          .finally(() => setProcessingState("idle"));
      } else {
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
        <Text style={styles.title}>Silent Confidant</Text>
        <Text style={styles.subtitle}>
          Your notes, kept between you and your device.
        </Text>

        <ViewToggle active="notes" />

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

        <View style={styles.recordRow}>
          <Pressable
            onPress={handleRecordPress}
            disabled={processingState === "processing" || recorder.isTransitioning}
            hitSlop={{ top: 16, bottom: 16, left: 16, right: 16 }}
            style={({ pressed }) => [
              styles.recordButton,
              recorder.isRecording && styles.recordButtonActive,
              pressed && styles.recordButtonPressed,
            ]}
          >
            {processingState === "processing" || recorder.isTransitioning ? (
              <ActivityIndicator color={colors.textPrimary} size="small" />
            ) : (
              <View style={recorder.isRecording ? styles.stopIcon : styles.micDot} />
            )}
          </Pressable>
          <Text
            style={[styles.recordRowLabel, recorder.isRecording && styles.recordRowLabelActive]}
          >
            {recorder.isRecording
              ? "Recording… tap to stop"
              : processingState === "processing"
                ? "Saving voice note…"
                : "Tap to record a voice note"}
          </Text>
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
              <Text style={styles.emptyText}>
                {isSearchActive ? "No matching notes yet." : "No notes recorded yet."}
              </Text>
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
  recordRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 16,
  },
  recordButton: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.accent,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: colors.accent,
    shadowOpacity: 0.4,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  recordButtonActive: {
    backgroundColor: colors.danger,
    shadowColor: colors.danger,
  },
  recordButtonPressed: {
    opacity: 0.85,
  },
  micDot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.textPrimary,
  },
  stopIcon: {
    width: 16,
    height: 16,
    borderRadius: 3,
    backgroundColor: colors.textPrimary,
  },
  recordRowLabel: {
    color: colors.textMuted,
    fontSize: 14,
    fontWeight: "600",
    flexShrink: 1,
  },
  recordRowLabelActive: {
    color: colors.danger,
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
