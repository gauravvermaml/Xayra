import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { AudioPlayerControls } from "./AudioPlayerControls";
import { colors } from "../constants/theme";
import { useAudioPlayerControls } from "../services/audio/player";
import { deleteNote, getNoteById, type Note } from "../services/notes/noteManager";
import { copyTextWithFeedback } from "../utils/clipboard";

/** Not in the shared theme: a backdrop scrim is a one-off for modals, not a
 * reusable design-system token. */
const backdropColor = "rgba(2, 6, 23, 0.6)";

export type NoteDetailModalProps = {
  noteId: string | null;
  visible: boolean;
  onClose: () => void;
  /** Called after the note is successfully deleted, so the caller can refresh its own list/state. */
  onDeleted?: (noteId: string) => void;
};

function formatTimestamp(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function NoteDetailModal({ noteId, visible, onClose, onDeleted }: NoteDetailModalProps) {
  const [note, setNote] = useState<Note | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // The embedded AudioPlayerControls manages its own playback hook
  // internally; this second subscription (same uri, same shared player) is
  // just so the delete flow can pause playback before the note is gone.
  const player = useAudioPlayerControls(note?.audioUri ?? "");

  useEffect(() => {
    if (!visible || !noteId) {
      setNote(null);
      setLoadError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    getNoteById(noteId)
      .then((result) => {
        if (cancelled) return;
        setNote(result);
        if (!result) {
          setLoadError("This note could not be found — it may have already been deleted.");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : "Failed to load note.");
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [visible, noteId]);

  const handleDelete = () => {
    if (!note) return;
    const targetId = note.id;

    Alert.alert(
      "Delete Note",
      "Are you sure you want to permanently delete this note?",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            player.pause();
            void deleteNote(targetId)
              .then(() => {
                onClose();
                onDeleted?.(targetId);
              })
              .catch((err) => {
                Alert.alert(
                  "Delete Error",
                  err instanceof Error ? err.message : "Failed to delete note."
                );
              });
          },
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.headerTitle}>Note</Text>
            <Pressable
              onPress={onClose}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={styles.closeButton}
            >
              <Text style={styles.closeButtonText}>✕</Text>
            </Pressable>
          </View>

          {isLoading && (
            <ActivityIndicator style={styles.loading} color={colors.textMuted} />
          )}

          {!isLoading && loadError && <Text style={styles.errorText}>{loadError}</Text>}

          {!isLoading && note && (
            <>
              <View style={styles.metaRow}>
                <Text style={styles.timestamp}>{formatTimestamp(note.createdAt)}</Text>
                <View style={styles.statusBadge}>
                  <Text style={styles.statusBadgeText}>{note.status}</Text>
                </View>
              </View>

              <ScrollView style={styles.transcriptScroll}>
                <Pressable
                  onLongPress={() =>
                    void copyTextWithFeedback(note.content || note.transcript || "")
                  }
                >
                  <Text style={styles.transcript} selectable>
                    {note.content || note.transcript || "(empty note)"}
                  </Text>
                </Pressable>
              </ScrollView>

              <AudioPlayerControls audioUri={note.audioUri ?? ""} style={styles.player} />

              <Pressable
                onPress={handleDelete}
                style={({ pressed }) => [styles.deleteButton, pressed && styles.deleteButtonPressed]}
              >
                <Text style={styles.deleteButtonText}>Delete Note</Text>
              </Pressable>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: backdropColor,
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: colors.background,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: 0,
    paddingHorizontal: 20,
    paddingTop: 10,
    paddingBottom: 28,
    maxHeight: "80%",
  },
  handle: {
    alignSelf: "center",
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.border,
    marginBottom: 14,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  headerTitle: {
    color: colors.textPrimary,
    fontSize: 18,
    fontWeight: "700",
  },
  closeButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.surface,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButtonText: {
    color: colors.textMuted,
    fontSize: 14,
  },
  loading: {
    marginVertical: 24,
  },
  errorText: {
    color: colors.danger,
    fontSize: 14,
    marginVertical: 16,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 14,
  },
  timestamp: {
    color: colors.textMuted,
    fontSize: 13,
  },
  statusBadge: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  statusBadgeText: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    textTransform: "uppercase",
  },
  transcriptScroll: {
    maxHeight: 220,
    marginBottom: 16,
  },
  transcript: {
    color: colors.textPrimary,
    fontSize: 16,
    lineHeight: 23,
  },
  player: {
    marginBottom: 20,
  },
  deleteButton: {
    backgroundColor: colors.danger,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: "center",
  },
  deleteButtonPressed: {
    opacity: 0.85,
  },
  deleteButtonText: {
    color: colors.background,
    fontSize: 15,
    fontWeight: "700",
  },
});
