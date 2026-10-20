import { Pressable, StyleSheet, Text, View } from "react-native";

import { spacing } from "../constants/theme";
import { MIN_TOUCH_TARGET, xayraColors, xayraType } from "../constants/xayraTheme";
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
  return <NoteRows label="Related notes" kind="related" notes={notes} onOpen={onOpen} />;
}

/**
 * The notes a VERIFIED answer rests on (RagAnswer.citations) — "Sources",
 * same rows as Related notes, so a summary or any grounded answer shows
 * what it came from, dated (Redmi uplift Stage 3; it was a row of bare
 * "[Note N]" chips beside Listen). Only ever given citations that passed
 * Grounding v1 — never related notes.
 */
export function SourcesSection({ notes, onOpen }: { notes: RagCitation[]; onOpen: (noteId: string) => void }) {
  return <NoteRows label="Sources" kind="source" notes={notes} onOpen={onOpen} />;
}

function NoteRows({
  label,
  kind,
  notes,
  onOpen,
}: {
  label: string;
  kind: "related" | "source";
  notes: RagCitation[];
  onOpen: (noteId: string) => void;
}) {
  if (notes.length === 0) {
    return null;
  }
  return (
    <View style={styles.section}>
      <Text style={styles.label}>{label}</Text>
      {notes.map((note) => (
        <Pressable
          key={note.noteId}
          testID={`${kind}-note-${note.noteId}`}
          accessibilityRole="button"
          accessibilityLabel={`${kind === "source" ? "Source" : "Related"} note, ${formatRecordedAt(note.createdAt)}`}
          accessibilityHint="Opens the note"
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
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
    gap: 2,
  },
  // Sentence case, like every other label in Xayra 2.0.
  label: {
    ...xayraType.roleLabel,
    color: xayraColors.textFaint,
  },
  row: {
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    paddingVertical: spacing.xs,
  },
  date: {
    ...xayraType.chip,
    color: xayraColors.lilacText,
  },
  excerpt: {
    ...xayraType.meta,
    fontSize: 14,
    lineHeight: 20,
    color: xayraColors.textMuted,
  },
});
