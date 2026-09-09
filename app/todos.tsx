import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AddTodoBottomSheet } from "../components/AddTodoBottomSheet";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { TodoItemRow } from "../components/TodoItemRow";
import { colors, spacing, typography } from "../constants/theme";
import type { Recurrence } from "../db/schema";
import { useToDos } from "../hooks/useToDos";
import type { ToDo } from "../services/todos/todoManager";

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/** How long the checked-off row stays gone-but-not-yet-really-completed
 * before its "Undo" window expires and the DB write actually happens. */
const UNDO_WINDOW_MS = 3000;

/**
 * Production "Your To-Dos" screen (Phase 2 Step 3) — replaces the Step 2
 * stub. New in this pass: a real header with an Add (+) entry point, source-
 * note citations, in-place task editing, and drop-on-check completion with
 * an undo window instead of an immediate, irreversible `completeToDo` call.
 *
 * DROP-ON-CHECK / UNDO DESIGN: only ONE completion is ever "pending" (mid
 * undo-window) at a time, matching the common Gmail-archive-style pattern —
 * checking a second item while the first's snackbar is still showing
 * immediately commits the first (see `flushPending`) rather than trying to
 * track multiple concurrent undo timers and stacking snackbars, which the
 * spec never asked for and would add real complexity for a case (checking
 * several items within the same 3-second window) that's rare in practice.
 * The pending item is filtered out of the list handed to `FlatList`
 * immediately on check (not after the undo window), which is what lets
 * TodoItemRow's own `exiting` animation actually play — see that
 * component's doc comment for why this works with a plain `FlatList`.
 */
export default function TodosScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { todos, pendingCount, addToDo, updateToDo, completeToDo, deleteToDo } = useToDos();

  const [isAddVisible, setIsAddVisible] = useState(false);
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);

  const pendingRef = useRef<{ id: string; timeoutId: ReturnType<typeof setTimeout> } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [pendingText, setPendingText] = useState("");

  /** Commits whatever completion is currently mid-undo-window right away —
   * called both when a new checkbox tap needs the previous one out of the
   * way, and when this screen unmounts, so a pending completion can never
   * be silently lost by navigating away inside the 3-second window. */
  const flushPending = useCallback(() => {
    const current = pendingRef.current;
    if (!current) {
      return;
    }
    clearTimeout(current.timeoutId);
    pendingRef.current = null;
    setPendingId(null);
    void completeToDo(current.id);
  }, [completeToDo]);

  const handleCheck = useCallback(
    (item: ToDo) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      flushPending();

      const timeoutId = setTimeout(() => {
        pendingRef.current = null;
        setPendingId(null);
        void completeToDo(item.id);
      }, UNDO_WINDOW_MS);

      pendingRef.current = { id: item.id, timeoutId };
      setPendingId(item.id);
      setPendingText(item.text);
    },
    [flushPending, completeToDo]
  );

  // Commits any still-pending completion if the user navigates away inside
  // the 3-second undo window — otherwise the setTimeout above would still
  // fire later and complete it silently off-screen, which is harmless
  // functionally but means a completion the user never actually confirmed
  // "stuck" could go through without them present to see or undo it.
  useEffect(() => {
    return () => flushPending();
  }, [flushPending]);

  const handleUndo = useCallback(() => {
    const current = pendingRef.current;
    if (!current) {
      return;
    }
    clearTimeout(current.timeoutId);
    pendingRef.current = null;
    setPendingId(null);
  }, []);

  const handleLongPressDelete = useCallback(
    (item: ToDo) => {
      Alert.alert("Delete this to-do?", `"${item.text}"`, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void deleteToDo(item.id) },
      ]);
    },
    [deleteToDo]
  );

  const handleSaveText = useCallback(
    (id: string, text: string) => {
      void updateToDo(id, { text });
    },
    [updateToDo]
  );


  const handleAddTodo = useCallback(
    (text: string, recurrence: Recurrence) => {
      void addToDo(text, todayIso(), recurrence);
    },
    [addToDo]
  );

  // Filters the pending (mid-undo-window) item out immediately — see this
  // screen's own doc comment above for why that's what makes the drop
  // animation and the undo window independent of each other.
  const visibleTodos = useMemo(() => todos.filter((item) => item.id !== pendingId), [todos, pendingId]);

  const renderItem = useCallback(
    ({ item }: { item: ToDo }) => (
      <TodoItemRow
        item={item}
        onCheck={handleCheck}
        onLongPressDelete={handleLongPressDelete}
        onOpenSourceNote={setViewingNoteId}
        onSaveText={handleSaveText}
      />
    ),
    [handleCheck, handleLongPressDelete, handleSaveText]
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
        >
          <Feather name="chevron-left" size={24} color={colors.textPrimary} />
        </Pressable>

        <View style={styles.headerTitleWrap}>
          <Text style={styles.title}>Your To-Dos</Text>
          <Text style={styles.subtitle}>{pendingCount === 0 ? "Nothing pending" : `${pendingCount} pending`}</Text>
        </View>

        <Pressable
          onPress={() => setIsAddVisible(true)}
          hitSlop={12}
          style={({ pressed }) => [styles.headerButton, pressed && styles.headerButtonPressed]}
        >
          <Feather name="plus" size={24} color={colors.textPrimary} />
        </Pressable>
      </View>

      <FlatList
        data={visibleTodos}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={styles.listContent}
        ItemSeparatorComponent={() => <View style={styles.itemGap} />}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            To-dos extracted from your notes — or added directly — will show up here.
          </Text>
        }
      />

      {pendingId && (
        <View style={[styles.snackbar, { bottom: insets.bottom + spacing.lg }]}>
          <Text style={styles.snackbarText} numberOfLines={1}>
            Completed "{pendingText}"
          </Text>
          <Pressable onPress={handleUndo} hitSlop={8}>
            <Text style={styles.snackbarUndo}>UNDO</Text>
          </Pressable>
        </View>
      )}

      <AddTodoBottomSheet visible={isAddVisible} onClose={() => setIsAddVisible(false)} onSave={handleAddTodo} />

      <NoteDetailModal noteId={viewingNoteId} visible={viewingNoteId !== null} onClose={() => setViewingNoteId(null)} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.base,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
  },
  headerButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  headerButtonPressed: {
    opacity: 0.6,
  },
  headerTitleWrap: {
    flex: 1,
    alignItems: "center",
  },
  title: {
    color: colors.textPrimary,
    ...typography.heading,
  },
  subtitle: {
    color: colors.textMuted,
    ...typography.caption,
    marginTop: 2,
  },
  listContent: {
    paddingBottom: 120,
    paddingHorizontal: 16,
  },
  itemGap: {
    height: spacing.sm,
  },
  emptyText: {
    color: colors.textMuted,
    ...typography.body,
    textAlign: "center",
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  snackbar: {
    position: "absolute",
    left: spacing.xl,
    right: spacing.xl,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    backgroundColor: "rgba(28, 28, 30, 0.96)",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.base,
    gap: spacing.base,
  },
  snackbarText: {
    flex: 1,
    color: colors.textPrimary,
    fontSize: 14,
  },
  snackbarUndo: {
    color: colors.accent,
    fontSize: 14,
    fontWeight: "700",
  },
});
