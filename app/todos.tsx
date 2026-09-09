import { Alert, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

import { colors, radius, spacing, typography } from "../constants/theme";
import { useToDos } from "../hooks/useToDos";
import type { ToDo } from "../services/todos/todoManager";

function formatActionDate(actionDate: string): string {
  // actionDate is a plain YYYY-MM-DD string (see db/schema.ts's `todos` table
  // doc comment) — parsed as local-time components, not `new Date(str)`,
  // for the same UTC-off-by-one-day reason todoManager.ts's own date math
  // avoids it.
  const [year, month, day] = actionDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

const RECURRENCE_LABELS: Record<ToDo["recurrence"], string> = {
  none: "",
  daily: "Repeats daily",
  weekly: "Repeats weekly",
  monthly: "Repeats monthly",
};

/**
 * Phase 2 Step 2: a minimal but fully functional list so the "To-Dos" pill's
 * navigation and the useToDos hook's reactive updates (including background
 * auto-extraction landing here on next focus) are testable end-to-end right
 * now. Richer editing/creation UI is Step 3's scope — this is deliberately
 * plain: tap a row's checkbox to complete it, long-press to delete.
 */
export default function TodosScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { todos, pendingCount, completeToDo, deleteToDo } = useToDos();

  // Urgent on-device fix: the extraction model occasionally misclassifies a
  // one-off task as recurring (see this screen's git history for the
  // investigation). A recurring to-do respawns its next occurrence every
  // time it's completed, so a plain checkbox tap can never actually get rid
  // of one that was tagged recurring by mistake — this is the only way out
  // for that case. Long-press (not a plain tap, and not a swipe, which this
  // list doesn't otherwise use for anything) is the standard "reveal a
  // destructive action" gesture across both platforms' own apps, always
  // behind a confirmation since there's no undo.
  const handleLongPressRow = (item: ToDo) => {
    Alert.alert("Delete this to-do?", `"${item.text}"`, [
      { text: "Cancel", style: "cancel" },
      { text: "Delete", style: "destructive", onPress: () => void deleteToDo(item.id) },
    ]);
  };

  const renderItem = ({ item }: { item: ToDo }) => (
    <Pressable
      onLongPress={() => handleLongPressRow(item)}
      delayLongPress={600}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <Pressable
        onPress={() => void completeToDo(item.id)}
        hitSlop={8}
        style={styles.checkbox}
      />
      <View style={styles.rowText}>
        <Text style={styles.rowTask}>{item.text}</Text>
        <Text style={styles.rowMeta}>
          {formatActionDate(item.actionDate)}
          {item.recurrence !== "none" ? ` · ${RECURRENCE_LABELS[item.recurrence]}` : ""}
        </Text>
      </View>
    </Pressable>
  );

  return (
    <SafeAreaView style={styles.safeArea} edges={["top", "left", "right"]}>
      <View style={styles.header}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={({ pressed }) => [styles.backButton, pressed && styles.backButtonPressed]}
        >
          <Text style={styles.backButtonText}>‹ Back</Text>
        </Pressable>
        <Text style={styles.title}>Your To-Dos</Text>
        <Text style={styles.subtitle}>
          {pendingCount === 0 ? "Nothing pending" : `${pendingCount} pending`}
        </Text>
      </View>

      <FlatList
        data={todos}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        contentContainerStyle={[styles.listContent, { paddingBottom: Math.max(insets.bottom + 40, 48) }]}
        ListEmptyComponent={
          <Text style={styles.emptyText}>
            To-dos extracted from your notes — or added directly — will show up here.
          </Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  header: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
    marginBottom: spacing.lg,
  },
  backButton: {
    alignSelf: "flex-start",
    marginBottom: spacing.md,
    paddingVertical: spacing.xs,
  },
  backButtonPressed: {
    opacity: 0.6,
  },
  backButtonText: {
    color: colors.accent,
    fontSize: 15,
    fontWeight: "600",
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
  },
  subtitle: {
    color: colors.textMuted,
    ...typography.caption,
    marginTop: spacing.xs,
  },
  listContent: {
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.base,
  },
  rowPressed: {
    backgroundColor: colors.surfaceElevated,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  rowText: {
    flex: 1,
    gap: 2,
  },
  rowTask: {
    color: colors.textPrimary,
    ...typography.body,
  },
  rowMeta: {
    color: colors.textMuted,
    ...typography.caption,
  },
  emptyText: {
    color: colors.textMuted,
    ...typography.body,
    textAlign: "center",
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
});
