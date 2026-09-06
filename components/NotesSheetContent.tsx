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
  /** Device's safe-area bottom inset — Build 20 SCROLL CONTENT CLEARANCE:
   * added as extra trailing padding (on top of an 80px margin) so the last
   * card can scroll clear of the solid Android nav bar instead of ending up
   * clipped behind it. */
  bottomInset: number;
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
  bottomInset,
}: NotesSheetContentProps) {
  return (
    <BottomSheetFlatList
      style={styles.list}
      contentContainerStyle={[
        styles.listContent,
        notes.length === 0 && styles.listContentEmpty,
        { paddingBottom: bottomInset + 80 },
      ]}
      data={notes}
      keyExtractor={(item) => item.id}
      ListEmptyComponent={
        <View style={styles.emptyState}>
          {/* Build 26 EMPTY STATE UI BRANDING: the generic 🔍/🎙 glyphs are
              gone — the empty state now leans entirely on the Xayra logo
              button already visible above the drawer (CentralRecorderCanvas)
              rather than a second, redundant icon here. Search still gets
              its own icon-free copy; only the record-mode text changed. */}
          <Text style={styles.emptyText}>{isSearchActive ? "No matching notes yet." : "No notes recorded yet."}</Text>
          <Text style={styles.emptySubtext}>
            {isSearchActive ? "Try a different search term." : "Tap Xayra to record your first voice note"}
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
