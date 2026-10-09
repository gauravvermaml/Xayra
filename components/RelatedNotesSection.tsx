import { Pressable, StyleSheet, Text, View } from "react-native";

import { colors, spacing } from "../constants/theme";
import type { RagCitation } from "../services/ai/rag";

/** Same format as the note screen's own timestamp ("7 Oct 2026, 9:32 pm"). */
function formatRecordedAt(createdAt: number): string {
  return new Date(createdAt * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The notes shown to the model when no verified answer came back (see
 * RagAnswer.relatedNotes) — one "Related notes" section, one tappable row
 * per note, each with its own recorded date and a one-line excerpt. At most
 * three rows: only notes in the model's context qualify, and rag.ts's
 * CONTEXT_NOTE_LIMIT is 3.
 *
 * Deliberately not the "[Note N]" citation chips: these notes did NOT
 * verify an answer — they are the user's own notes on the topic, offered
 * to check themselves.
 */
export function RelatedNotesSection({ notes, onOpen }: { notes: RagCitation[]; onOpen: (noteId: string) => void }) {
  if (notes.length === 0) {
    return null;
  }
  return (
    <View style={styles.section}>
      <Text style={styles.label}>Related notes</Text>
      {notes.map((note) => (
        <Pressable
          key={note.noteId}
          testID={`related-note-${note.noteId}`}
          accessibilityRole="button"
          onPress={() => onOpen(note.noteId)}
          style={styles.row}
        >
          <Text style={styles.date}>{formatRecordedAt(note.createdAt)}</Text>
          <Text style={styles.excerpt} numberOfLines={1}>
            {note.content}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: spacing.sm + 2,
    gap: spacing.xs,
  },
  label: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  row: {
    paddingVertical: spacing.xs,
  },
  date: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
  },
  excerpt: {
    color: colors.textMuted,
    fontSize: 12,
  },
});
