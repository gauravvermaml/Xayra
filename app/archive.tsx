import { useCallback, useRef, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";

import { NoteDetailModal } from "../components/NoteDetailModal";
import { NotesSheetContent, type DisplayNote } from "../components/NotesSheetContent";
import { colors, spacing, typography } from "../constants/theme";
import { deleteNote, listNotes, retryPendingEmbeddings, type Note } from "../services/notes/noteManager";
import { getSyncStatus, restoreFromDrive, signInWithGoogle, type SyncStatus } from "../services/sync/driveSync";

/**
 * Archive — the home screen's former "Recorded notes" card, demoted to its
 * own screen entirely (see the "Quiet Corner" placement discussion): the
 * app's whole premise is "record, then just ask later," so a scrollable
 * list of raw past recordings has no business competing for space on the
 * landing screen. It's still real, still one tap away — via the new
 * icon-plus-popover next to the To-Dos pill (app/index.tsx) — just no
 * longer something you see every time you open the app.
 *
 * Everything here (state, refresh, delete, Drive restore) is lifted
 * verbatim from what used to live in app/index.tsx alongside the home
 * screen's own NotesSheetContent instance — this screen owns that state
 * now instead. app/index.tsx keeps its own separate, much smaller
 * `selectedNoteId`/`NoteDetailModal` pair for opening a note from a chat
 * citation chip; that's a different, still-live use case this screen
 * doesn't touch.
 */
export default function ArchiveScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [notes, setNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ isConnected: false });
  const [isRestoring, setIsRestoring] = useState(false);

  const refreshNotes = useCallback(async () => {
    try {
      setNotes(await listNotes());
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

  useFocusEffect(
    useCallback(() => {
      void refreshNotes();
      void refreshSyncStatus();
      void retryPendingEmbeddings().then((count) => {
        if (count > 0) {
          void refreshNotes();
        }
      });
    }, [refreshNotes, refreshSyncStatus])
  );

  // Same re-entrancy guard as the original app/index.tsx implementation —
  // see that history for why a plain ref (not just the `isRestoring` state
  // the link disables on) is what actually closes the double-tap race.
  const isRestoringRef = useRef(false);
  const handleRestoreFromDrive = useCallback(() => {
    if (isRestoringRef.current) {
      return;
    }
    isRestoringRef.current = true;
    void (async () => {
      setIsRestoring(true);
      setError(null);
      try {
        if (!syncStatus.isConnected) {
          await signInWithGoogle();
        }
        const { message } = await restoreFromDrive();
        await refreshNotes();
        await refreshSyncStatus();
        Alert.alert("Vault Restored", message);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to restore from Google Drive.";
        setError(message);
        Alert.alert("Restore Failed", message);
      } finally {
        isRestoringRef.current = false;
        setIsRestoring(false);
      }
    })();
  }, [syncStatus.isConnected, refreshNotes, refreshSyncStatus]);

  const handleSelectNote = useCallback((noteId: string) => setSelectedNoteId(noteId), []);

  const handleDeleteNote = useCallback((noteId: string) => {
    Alert.alert("Delete Note", "Are you sure you want to permanently delete this note?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteNote(noteId)
            .then(() => setNotes((prev) => prev.filter((note) => note.id !== noteId)))
            .catch((err) => {
              const message = err instanceof Error ? err.message : "Failed to delete note.";
              setError(message);
              Alert.alert("Delete Error", message);
            });
        },
      },
    ]);
  }, []);

  const displayedNotes: DisplayNote[] = notes.map((note) => ({
    id: note.id,
    content: note.content,
    audioUri: note.audioUri,
    transcriptionModel: note.transcriptionModel,
    createdAt: note.createdAt,
  }));

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
        >
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Archive</Text>
        <Text style={styles.subtitle}>Every thought you've ever recorded, exactly as captured.</Text>
      </View>

      {error && <Text style={styles.errorText}>{error}</Text>}

      <NotesSheetContent
        notes={displayedNotes}
        isSearchActive={false}
        onSelectNote={handleSelectNote}
        onDeleteNote={handleDeleteNote}
        isRestoring={isRestoring}
        onRestoreFromDrive={handleRestoreFromDrive}
        bottomInset={insets.bottom}
        usePlainList
      />

      <NoteDetailModal
        noteId={selectedNoteId}
        visible={selectedNoteId !== null}
        onClose={() => setSelectedNoteId(null)}
        onDeleted={() => {
          setSelectedNoteId(null);
          void refreshNotes();
        }}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
    marginBottom: spacing.md,
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
  subtitle: {
    color: colors.textMuted,
    ...typography.caption,
    marginTop: spacing.xs,
  },
  errorText: {
    color: colors.danger,
    fontSize: 13,
    paddingHorizontal: spacing.xl,
    marginBottom: spacing.sm,
  },
});
