import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import Animated, { FadeOutDown, LinearTransition } from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";

import { colors, radius, spacing, typography } from "../constants/theme";
import type { ToDo } from "../services/todos/todoManager";

const MONTH_ABBREVIATIONS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "Created 9 Sep" — day-then-month, spelled out manually rather than via
 * `toLocaleDateString` so the word order matches the spec exactly regardless
 * of device locale (`toLocaleDateString` would give "Sep 9" on an en-US
 * device, "9 Sep" on an en-GB one, etc.). */
function formatCreatedDate(createdAtIso: string): string {
  const d = new Date(createdAtIso);
  return `Created ${d.getDate()} ${MONTH_ABBREVIATIONS[d.getMonth()]}`;
}

export type TodoItemRowProps = {
  item: ToDo;
  /** Checkbox tap — the parent owns the drop-animation/undo-snackbar
   * lifecycle (see app/todos.tsx's `handleCheck`); this component only ever
   * reports the intent, never calls completeToDo itself. */
  onCheck: (item: ToDo) => void;
  /** Long-press — unchanged escape hatch from Phase 2 Step 2 for a to-do a
   * plain "complete" tap can't get rid of (e.g. wrongly tagged recurring). */
  onLongPressDelete: (item: ToDo) => void;
  /** Only ever called when `item.noteId` is set (the citation link is only
   * rendered in that case) — see app/todos.tsx for how it opens
   * NoteDetailModal. */
  onOpenSourceNote: (noteId: string) => void;
  onSaveText: (id: string, text: string) => void;
};

/**
 * One row in the "Your To-Dos" list (Phase 2 Step 3's production redesign of
 * the Step 2 stub). Monochromatic glass card matching the app's established
 * translucent-box language (see HistorySheet.tsx's `textContainerBox` for
 * the same visual family), with two content lines: a micro-header (creation
 * date + optional source-note citation) and the main row (checkbox, task
 * text or its in-place editor, edit pen).
 *
 * `Animated.View`'s `exiting`/`layout` props are what make the "drop on
 * check" behavior in app/todos.tsx actually visible: that screen filters a
 * checked item out of the list it passes to `FlatList` immediately (so the
 * completion logic and undo timer are unaffected by animation timing), and
 * Reanimated intercepts this component's unmount to play `FadeOutDown`
 * before it's actually removed, while `LinearTransition` smoothly closes the
 * gap in the sibling rows above/below it. Both work with a plain `FlatList`
 * (no `Animated.FlatList` needed) since it's this row's own mount/unmount
 * Reanimated is hooking into, not anything list-virtualization-specific.
 */
export function TodoItemRow({ item, onCheck, onLongPressDelete, onOpenSourceNote, onSaveText }: TodoItemRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(item.text);

  const commitEdit = () => {
    setIsEditing(false);
    const trimmed = draftText.trim();
    if (trimmed && trimmed !== item.text) {
      onSaveText(item.id, trimmed);
    } else {
      // Reverts a blank/unchanged draft back to the saved text rather than
      // letting an emptied TextInput persist as this row's next render.
      setDraftText(item.text);
    }
  };

  return (
    <Animated.View exiting={FadeOutDown.duration(280)} layout={LinearTransition.duration(220)} style={styles.card}>
      <Pressable onLongPress={() => onLongPressDelete(item)} delayLongPress={600}>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{formatCreatedDate(item.createdAt)}</Text>
          {item.noteId && (
            <Pressable onPress={() => onOpenSourceNote(item.noteId as string)} hitSlop={8}>
              <Text style={styles.sourceLink}>🎙️ Source Note</Text>
            </Pressable>
          )}
        </View>

        <View style={styles.mainRow}>
          <Pressable
            onPress={() => onCheck(item)}
            hitSlop={10}
            style={styles.checkbox}
            accessibilityRole="checkbox"
            accessibilityLabel={`Mark "${item.text}" as done`}
          />

          {isEditing ? (
            <TextInput
              value={draftText}
              onChangeText={setDraftText}
              autoFocus
              onBlur={commitEdit}
              onSubmitEditing={commitEdit}
              returnKeyType="done"
              style={styles.taskInput}
            />
          ) : (
            <Text style={styles.taskText}>{item.text}</Text>
          )}

          <Pressable onPress={() => setIsEditing(true)} hitSlop={10} style={styles.editButton}>
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </Pressable>
        </View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    borderColor: "rgba(255, 255, 255, 0.1)",
    borderWidth: 1,
    borderRadius: 16,
    padding: 14,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: spacing.sm,
  },
  metaText: {
    color: colors.textMuted,
    ...typography.caption,
  },
  sourceLink: {
    color: colors.accent,
    ...typography.caption,
    fontWeight: "600",
  },
  mainRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  taskText: {
    flex: 1,
    color: colors.textPrimary,
    ...typography.body,
  },
  taskInput: {
    flex: 1,
    color: colors.textPrimary,
    ...typography.body,
    padding: 0,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderStrong,
  },
  editButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
});
