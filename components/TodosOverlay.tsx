import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, FlatList, StyleSheet, Text, View } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AddTodoBottomSheet } from "./AddTodoBottomSheet";
import { NoteDetailModal } from "./NoteDetailModal";
import { TodoItemRow } from "./TodoItemRow";
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

export type TodosOverlayProps = {
  onClose: () => void;
};

/**
 * Production "Your To-Dos" screen — a full-screen overlay on app/index.tsx
 * (mounted only while its pill's tap has set the parent's visibility state
 * true, same conditional-mount pattern as ExpandedTextOverlay.tsx), NOT a
 * pushed expo-router route the way this used to be (app/todos.tsx, now
 * deleted).
 *
 * WHY AN OVERLAY, NOT A ROUTE — this is the one load-bearing fact about this
 * file's existence: a route reached via `router.push` is a *pushed* screen
 * in this app's react-native-screens-backed stack, and on Android, any extra
 * window (an IME popup, a native `<Modal>` — it doesn't matter which)
 * gaining and then losing focus while a pushed screen is on top reproducibly
 * left that screen's native Fragment never reclaiming touch input again —
 * checkbox, edit, plus, back, scroll, all dead, confirmed via `adb logcat`
 * showing raw touch events still dispatching at the OS level while nothing
 * reached React. This was reproduced multiple independent ways on-device
 * (opening/closing the source-note citation modal; even a stray OS keyboard
 * suggestion strip appearing and being dismissed with the hardware back
 * button) and confirmed absent on `/index` itself — the ROOT screen, never
 * pushed onto itself — which uses this exact same NoteDetailModal in the
 * exact same way with zero issue, all session. Rendering this screen as a
 * plain sibling of the root screen's own content (this file), instead of a
 * separate pushed route, sidesteps the whole bug class: there's no pushed
 * Fragment for a keyboard or Modal to ever leave stranded. Local
 * `NoteDetailModal` usage below (rather than the routed `/note/[id]` this
 * app briefly used) is deliberately restored to plain local state for the
 * same reason — it's exactly as safe here as it already is on `/index`.
 */
export function TodosOverlay({ onClose }: TodosOverlayProps) {
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
   * be silently lost by closing the overlay inside the 3-second window. */
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

  // Commits any still-pending completion if this overlay closes inside the
  // 3-second undo window — otherwise the setTimeout above would still fire
  // later and complete it silently off-screen.
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
    <View style={styles.overlay}>
      <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
        <View style={styles.header}>
          <TouchableOpacity onPress={onClose} hitSlop={12} activeOpacity={0.6} style={styles.headerButton}>
            <Feather name="chevron-left" size={24} color={colors.textPrimary} />
          </TouchableOpacity>

          <View style={styles.headerTitleWrap}>
            <Text style={styles.title}>Your To-Dos</Text>
            <Text style={styles.subtitle}>{pendingCount === 0 ? "Nothing pending" : `${pendingCount} pending`}</Text>
          </View>

          <TouchableOpacity
            onPress={() => setIsAddVisible(true)}
            hitSlop={12}
            activeOpacity={0.6}
            style={styles.headerButton}
          >
            <Feather name="plus" size={24} color={colors.textPrimary} />
          </TouchableOpacity>
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
            <TouchableOpacity onPress={handleUndo} hitSlop={8} activeOpacity={0.6}>
              <Text style={styles.snackbarUndo}>UNDO</Text>
            </TouchableOpacity>
          </View>
        )}

        <AddTodoBottomSheet visible={isAddVisible} onClose={() => setIsAddVisible(false)} onSave={handleAddTodo} />

        <NoteDetailModal
          noteId={viewingNoteId}
          visible={viewingNoteId !== null}
          onClose={() => setViewingNoteId(null)}
        />
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    // Written out directly rather than via StyleSheet.absoluteFillObject —
    // matching ExpandedTextOverlay.tsx's own note that this RN version's
    // type declarations don't expose that helper.
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
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
