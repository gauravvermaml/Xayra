import { useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";

import { AudioPlayerControls } from "../../components/AudioPlayerControls";
import { colors } from "../../constants/theme";
import { useAudioPlayerControls } from "../../services/audio/player";
import { deleteNote, getNoteById, type Note } from "../../services/notes/noteManager";
import { copyTextWithFeedback } from "../../utils/clipboard";

function formatTimestamp(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

/**
 * Source-note citation screen, opened from a to-do's "🎙️ Source Note" link
 * (components/TodoItemRow.tsx / app/todos.tsx). This exists as a real routed
 * screen — presented natively as a modal via app/_layout.tsx's
 * `<Stack.Screen name="note/[id]" options={{ presentation: "modal" }} />`,
 * the same pattern already used for `/settings` — instead of reusing
 * components/NoteDetailModal.tsx's locally-toggled RN `<Modal>` directly on
 * `/todos`.
 *
 * That distinction is load-bearing, not stylistic: `/todos` is a screen
 * reached via `router.push`, i.e. a non-root screen inside this app's
 * react-native-screens-backed stack. Opening and closing RN's own `<Modal>`
 * on top of a *pushed* screen is a known Android bug — the underlying
 * screen's native Fragment never properly regains input focus afterward, so
 * every touch keeps dispatching at the OS level (confirmed via `adb logcat`
 * — `ViewPostIme` events kept firing) but never reaches React again: no
 * checkbox, no edit, no back button, no scroll, permanently, until the app
 * is killed and relaunched. Reproduced and isolated on-device by ruling out
 * every other suspect first (the Add-to-do sheet, Reanimated's exit/layout
 * row animations) — the freeze persisted through removing all of them and
 * only stopped when RN's `<Modal>` was removed from the picture entirely.
 * `components/NoteDetailModal.tsx` itself is untouched and still used as-is
 * by `app/index.tsx`, which is the ROOT screen — never pushed onto itself —
 * so it never hits this bug there.
 *
 * A real native modal presentation (this file's approach) is react-native-
 * screens' own Screen/Fragment transition, not a plain RN `Modal` layered on
 * top of one, which is exactly what avoids the conflict.
 */
export default function NoteDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [note, setNote] = useState<Note | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const player = useAudioPlayerControls(note?.audioUri ?? "");

  useEffect(() => {
    if (!id) {
      setIsLoading(false);
      setLoadError("No note specified.");
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setLoadError(null);

    getNoteById(id)
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
  }, [id]);

  const handleDelete = () => {
    if (!note) return;
    const targetId = note.id;

    Alert.alert("Delete Note", "Are you sure you want to permanently delete this note?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          player.pause();
          void deleteNote(targetId)
            .then(() => router.back())
            .catch((err) => {
              Alert.alert("Delete Error", err instanceof Error ? err.message : "Failed to delete note.");
            });
        },
      },
    ]);
  };

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right", "bottom"]}>
      <View style={styles.handle} />

      <View style={styles.header}>
        <Text style={styles.headerTitle}>Note</Text>
        <Pressable
          onPress={() => router.back()}
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={styles.closeButton}
        >
          <Text style={styles.closeButtonText}>✕</Text>
        </Pressable>
      </View>

      {isLoading && <ActivityIndicator style={styles.loading} color={colors.textMuted} />}

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
            <Pressable onLongPress={() => void copyTextWithFeedback(note.content || note.transcript || "")}>
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
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
    paddingHorizontal: 20,
    paddingTop: 10,
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
    flex: 1,
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
