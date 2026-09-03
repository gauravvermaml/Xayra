import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";

import { NoteCard } from "./NoteCard";
import { colors, spacing } from "../constants/theme";

export type DisplayNote = {
  id: string;
  content: string;
  audioUri: string | null;
  transcriptionModel: string | null;
  createdAt: number;
};

export type NotesSheetContentProps = {
  notes: DisplayNote[];
  isSearchActive: boolean;
  onSelectNote: (noteId: string) => void;
  onDeleteNote: (noteId: string) => void;
  isRestoring: boolean;
  onRestoreFromDrive: () => void;
};

/** The sheet's Notes-mode scrollable content — a `BottomSheetFlatList`, not a
 * plain RN `FlatList`: only the gesture-handler-aware list keeps the sheet's
 * own drag-to-expand/collapse gesture and the list's own scroll gesture from
 * fighting each other. */
export function NotesSheetContent({
  notes,
  isSearchActive,
  onSelectNote,
  onDeleteNote,
  isRestoring,
  onRestoreFromDrive,
}: NotesSheetContentProps) {
  return (
    <BottomSheetFlatList
      style={styles.list}
      contentContainerStyle={[styles.listContent, notes.length === 0 && styles.listContentEmpty]}
      data={notes}
      keyExtractor={(item) => item.id}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          <Text style={styles.emptyIcon}>{isSearchActive ? "🔍" : "🎙"}</Text>
          <Text style={styles.emptyText}>{isSearchActive ? "No matching notes yet." : "No notes recorded yet."}</Text>
          <Text style={styles.emptySubtext}>
            {isSearchActive ? "Try a different search term." : "Tap the microphone to record your first voice note."}
          </Text>
          {!isSearchActive && (
            <Pressable onPress={onRestoreFromDrive} disabled={isRestoring} style={styles.restoreLinkRow}>
              {isRestoring ? (
                <ActivityIndicator color={colors.accent} size="small" />
              ) : (
                <Text style={styles.restoreLinkText}>Already have a backup? Restore vault from Google Drive</Text>
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
          onPress={() => onSelectNote(item.id)}
          onDelete={() => onDeleteNote(item.id)}
        />
      )}
    />
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: spacing.base,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xxl,
  },
  listContentEmpty: {
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
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  emptySubtext: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.xs,
    textAlign: "center",
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
});
