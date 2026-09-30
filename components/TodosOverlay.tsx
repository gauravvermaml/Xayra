import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, StyleSheet, Text, TextInput, View } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { AddTodoBottomSheet } from "./AddTodoBottomSheet";
import { CalendarBody } from "./calendar/CalendarBody";
import { CalendarViewSelector } from "./calendar/CalendarViewSelector";
import { TaskPreviewSheet } from "./calendar/TaskPreviewSheet";
import { NoteDetailModal } from "./NoteDetailModal";
import { showToast } from "./Toast";
import { colors, radius, spacing, typography } from "../constants/theme";
import type { Recurrence } from "../db/schema";
import { useCalendarViewStore } from "../hooks/useCalendarViewStore";
import { useToDos } from "../hooks/useToDos";
import { matchesKeywordSearch } from "../services/search/keywordMatch";
import type { ToDo } from "../services/todos/todoManager";

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
  const {
    todos,
    allTodos,
    pendingCount,
    addToDo,
    updateToDo,
    completeToDo,
    deleteToDo,
    sendToDoToCalendar,
    removeToDoFromCalendar,
  } = useToDos();
  const {
    layoutMode,
    setLayoutMode,
    selectedDate,
    setSelectedDate,
    activeRange,
    goToToday,
    goToPrevious,
    goToNext,
  } = useCalendarViewStore();

  const [isAddVisible, setIsAddVisible] = useState(false);
  // Phase 2 Step 4 follow-up: the same AddTodoBottomSheet doubles as the
  // full-detail editor — set to a to-do to open it pre-filled (see
  // handleSheetClose below for how the two modes actually get told apart
  // by `handleSaveTodo`). Null in every other state, including while adding
  // a brand-new one (`isAddVisible` covers that case instead).
  const [editingTodo, setEditingTodo] = useState<ToDo | null>(null);
  const [viewingNoteId, setViewingNoteId] = useState<string | null>(null);
  // Week/Work Week's own two-step tap: tapping a reminder chip in the grid
  // opens this single-task preview card first (see TaskPreviewSheet.tsx's
  // own doc comment for why those two views specifically need it), rather
  // than jumping straight into the full multi-field edit sheet the way
  // Day/Month already do.
  const [previewTodo, setPreviewTodo] = useState<ToDo | null>(null);
  // Plain client-side keyword filter — this app's to-do count is small
  // enough (extracted from notes + manually added) that a full search
  // index would be overkill; a simple case-insensitive substring match
  // against each to-do's own text is what users actually asked for here.
  const [searchQuery, setSearchQuery] = useState("");

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
      // `deleteToDo` (todoManager.ts) cascades to the linked Calendar event
      // too, if this to-do was ever sent there — the message says so up
      // front, live-requested, rather than deleting it silently as a side
      // effect the user only discovers later.
      const message = item.googleCalendarEventId
        ? `"${item.text}"\n\nThis will also remove it from your Google Calendar.`
        : `"${item.text}"`;
      Alert.alert("Delete this to-do?", message, [
        { text: "Cancel", style: "cancel" },
        { text: "Delete", style: "destructive", onPress: () => void deleteToDo(item.id) },
      ]);
    },
    [deleteToDo]
  );

  // The calendar-icon button's on/off toggle (CalendarTaskCard.tsx) — same
  // confirm-then-act shape as `handleLongPressDelete` above, added per
  // explicit request: besides the standard "don't act on an accidental tap"
  // reason every other destructive/state-changing action here already gets,
  // the confirm dialog's own wording doubles as inline education for anyone
  // who doesn't already know what a plain calendar icon means — no separate
  // onboarding/tooltip needed.
  //
  // Unlike every other action in this file, the actual network call
  // (`sendToDoToCalendar`/`removeToDoFromCalendar`) can throw — a real
  // network/auth request, not just a local DB write — so this still needs
  // its own try/catch on top of the confirm step, surfaced via the same
  // `Alert.alert` pattern the rest of this screen already uses for
  // user-facing errors. `showToast` on success (the same mechanism Settings
  // already uses for Drive backup/restore results) closes a separate gap a
  // live on-device report caught: with only the icon's own outline->filled
  // change as feedback, a user genuinely couldn't tell the action had
  // worked at all without leaving the app to check Google Calendar
  // directly.
  const handleSendToCalendar = useCallback(
    (item: ToDo) => {
      const wasLinked = Boolean(item.googleCalendarEventId);
      const runAction = () => {
        const action = wasLinked ? removeToDoFromCalendar(item.id) : sendToDoToCalendar(item.id);
        action
          .then(() => {
            showToast(wasLinked ? "Removed from Google Calendar" : "Sent to Google Calendar");
          })
          .catch((err) => {
            Alert.alert(
              wasLinked ? "Couldn't remove from Calendar" : "Couldn't send to Calendar",
              err instanceof Error ? err.message : String(err)
            );
          });
      };

      Alert.alert(
        wasLinked ? "Remove from Google Calendar?" : "Add to Google Calendar?",
        wasLinked
          ? `"${item.text}" will be removed from your Google Calendar. This won't delete the to-do itself.`
          : `"${item.text}" will be added as an event on your Google Calendar.`,
        [
          { text: "Cancel", style: "cancel" },
          { text: wasLinked ? "Remove" : "Add", style: wasLinked ? "destructive" : "default", onPress: runAction },
        ]
      );
    },
    [sendToDoToCalendar, removeToDoFromCalendar]
  );

  const handleEditDetails = useCallback((item: ToDo) => {
    setEditingTodo(item);
  }, []);

  const handlePreviewTask = useCallback((item: ToDo) => {
    setPreviewTodo(item);
  }, []);

  // Tapping the preview card itself — closes the preview and opens the real
  // edit sheet, completing Week/Work Week's two-step (see
  // TaskPreviewSheet.tsx's own doc comment). The check/delete actions below
  // close the preview too, rather than leaving it open over a task that's
  // about to disappear or change state out from under it.
  const handleOpenFromPreview = useCallback(
    (item: ToDo) => {
      setPreviewTodo(null);
      handleEditDetails(item);
    },
    [handleEditDetails]
  );

  const handleCheckFromPreview = useCallback(
    (item: ToDo) => {
      setPreviewTodo(null);
      handleCheck(item);
    },
    [handleCheck]
  );

  const handleDeleteFromPreview = useCallback(
    (item: ToDo) => {
      setPreviewTodo(null);
      handleLongPressDelete(item);
    },
    [handleLongPressDelete]
  );

  // Closes the preview too, same as check/delete above — its `item` prop is
  // a snapshot taken when the preview opened, so it wouldn't otherwise pick
  // up the fresh `googleCalendarEventId` this action just changed, leaving
  // the icon showing the wrong state until the sheet were closed anyway.
  const handleSendToCalendarFromPreview = useCallback(
    (item: ToDo) => {
      setPreviewTodo(null);
      handleSendToCalendar(item);
    },
    [handleSendToCalendar]
  );

  // The four grid layouts all receive the SAME `onOpenTask` from
  // CalendarBody — Day/Week/Work Week all route through the preview card
  // now (live-requested: Day used to go straight to the full edit sheet,
  // inconsistent with the other two); Month keeps its own separate
  // two-step via the day panel below instead of this preview sheet.
  const handleGridOpenTask = layoutMode === "month" ? handleEditDetails : handlePreviewTask;

  // One handler for both the Add and Edit sheets, since they're the same
  // component in two modes (see `editingTodo`'s own doc comment) — branches
  // on whether an existing to-do is being edited to decide addToDo vs
  // updateToDo, the one place that distinction actually needs to be made.
  const handleSaveTodo = useCallback(
    (text: string, actionDate: string, toDate: string | null, notificationTime: string, recurrence: Recurrence) => {
      if (editingTodo) {
        void updateToDo(editingTodo.id, { text, actionDate, toDate, notificationTime, recurrence });
      } else {
        void addToDo({ text, actionDate, toDate, notificationTime, recurrence });
      }
    },
    [editingTodo, addToDo, updateToDo]
  );

  const handleSheetClose = useCallback(() => {
    setIsAddVisible(false);
    setEditingTodo(null);
  }, []);

  // Filters the pending (mid-undo-window) item out immediately — see this
  // screen's own doc comment above for why that's what makes the drop
  // animation and the undo window independent of each other. The search
  // filter is applied in the same pass rather than a second `.filter()`
  // call, since both narrow the same base list down to what's shown.
  //
  // matchesKeywordSearch (services/search/keywordMatch.ts) supports a
  // "+"-separated AND query ("soccer+eli" — every term must appear
  // somewhere in the text) alongside the plain single-keyword substring
  // match this used to do inline.
  const visibleTodos = useMemo(
    () => todos.filter((item) => item.id !== pendingId && matchesKeywordSearch(item.text, searchQuery)),
    [todos, pendingId, searchQuery]
  );

  // Same undo-window/search narrowing as `visibleTodos` above, sourced from
  // `allTodos` (pending + completed) instead — feeds the calendar GRID
  // views only (see CalendarBody's `calendarTodos` prop). Computed even
  // while `isSearching`, though CalendarBody never actually renders it in
  // that state (search always forces ScheduleLayout, which reads `todos`) —
  // harmless, and simpler than conditioning this on isSearching too.
  const visibleAllTodos = useMemo(
    () => allTodos.filter((item) => item.id !== pendingId && matchesKeywordSearch(item.text, searchQuery)),
    [allTodos, pendingId, searchQuery]
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

        {/* Calendar View System — spec placement: the layout-mode dropdown
            sits directly below the header and immediately above the search
            input; the sticky date navigator + active grid layout
            (CalendarBody) sit below the search bar instead, since neither
            is contiguous with the selector. See CalendarBody.tsx's own doc
            comment for why it's split this way. */}
        <View style={styles.selectorRow}>
          <CalendarViewSelector mode={layoutMode} onChange={setLayoutMode} />
        </View>

        <View style={styles.searchBar}>
          <Feather name="search" size={16} color={colors.textMuted} />
          <TextInput
            value={searchQuery}
            onChangeText={setSearchQuery}
            placeholder="Search"
            placeholderTextColor={colors.textMuted}
            style={styles.searchInput}
            returnKeyType="search"
            autoCorrect={false}
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery("")} hitSlop={8} activeOpacity={0.6}>
              <Feather name="x" size={16} color={colors.textMuted} />
            </TouchableOpacity>
          )}
        </View>

        <CalendarBody
          mode={layoutMode}
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          activeRange={activeRange}
          onPrevious={goToPrevious}
          onNext={goToNext}
          onToday={goToToday}
          todos={visibleTodos}
          calendarTodos={visibleAllTodos}
          isSearching={searchQuery.trim().length > 0}
          // Search results always render as Schedule-style cards (see
          // CalendarBody's own doc comment) regardless of which grid mode is
          // selected, so they open straight to edit — the preview-card step
          // only applies to Week/Work Week's own inline grid chips.
          onOpenTask={searchQuery.trim().length > 0 ? handleEditDetails : handleGridOpenTask}
          onCheckTask={handleCheck}
          onOpenSourceNote={setViewingNoteId}
          onLongPressDelete={handleLongPressDelete}
          onSendToCalendar={handleSendToCalendar}
        />

        <TaskPreviewSheet
          item={previewTodo}
          onClose={() => setPreviewTodo(null)}
          onOpenTask={handleOpenFromPreview}
          onCheckTask={handleCheckFromPreview}
          onOpenSourceNote={setViewingNoteId}
          onLongPressDelete={handleDeleteFromPreview}
          onSendToCalendar={handleSendToCalendarFromPreview}
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

        <AddTodoBottomSheet
          visible={isAddVisible || editingTodo !== null}
          onClose={handleSheetClose}
          onSave={handleSaveTodo}
          editingTodo={editingTodo}
        />

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
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    marginHorizontal: spacing.base,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.base,
    height: 40,
    borderRadius: radius.pill,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  searchInput: {
    flex: 1,
    color: colors.textPrimary,
    ...typography.body,
    fontSize: 15,
    padding: 0,
  },
  selectorRow: {
    paddingHorizontal: spacing.base,
    marginBottom: spacing.md,
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
