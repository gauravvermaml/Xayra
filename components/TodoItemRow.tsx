import { StyleSheet, Text, View } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";
import Animated, { FadeOutDown, LinearTransition } from "react-native-reanimated";
import { Feather } from "@expo/vector-icons";

import { colors, radius, spacing, typography } from "../constants/theme";
import { DEFAULT_NOTIFICATION_TIME } from "../db/schema";
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

// Reinstated from the Phase 2 Step 2 stub (see components/TodosOverlay.tsx's git history)
// after the user flagged its absence: Step 3's redesign replaced the whole
// row and dropped this due-date/frequency line without an equivalent
// replacement. `actionDate` is a plain YYYY-MM-DD string (db/schema.ts) —
// parsed into local-time components, not `new Date(str)`, for the same
// UTC-off-by-one-day reason todoManager.ts's own date math avoids it.
function formatActionDate(actionDate: string): string {
  const [year, month, day] = actionDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/** Phase 2 Step 4: "📅 27 Sep – 10 Oct 2026" for a to-do with a `toDate` —
 * day+abbreviated-month for both ends (manually spelled out, same
 * locale-independence reasoning as `formatCreatedDate` above), with the
 * year shown once at the end rather than duplicated on both sides. Only
 * ever called when `toDate` is non-null — see this row's own render site. */
function formatDateRange(fromIso: string, toIso: string): string {
  const [, fromMonth, fromDay] = fromIso.split("-").map(Number);
  const [toYear, toMonth, toDay] = toIso.split("-").map(Number);
  const from = `${fromDay} ${MONTH_ABBREVIATIONS[fromMonth - 1]}`;
  const to = `${toDay} ${MONTH_ABBREVIATIONS[toMonth - 1]}`;
  return `📅 ${from} – ${to} ${toYear}`;
}

/** "15:30" -> "3:30 PM" for the reminder-time badge below. Duplicated from
 * components/AddTodoBottomSheet.tsx's identical formatter rather than
 * shared — small enough, in a different component tree, that a cross-file
 * util would cost more to navigate than the few duplicated lines. */
function formatTime12h(hhmm: string): string {
  const [hour, minute] = hhmm.split(":").map(Number);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

const RECURRENCE_UNIT_LABELS: Record<Exclude<ToDo["recurrence"], "none">, string> = {
  daily: "day",
  weekly: "week",
  monthly: "month",
};

/** "Repeats daily" for the plain interval-1 case (the common one), else
 * "Every 2 weeks" — interval is only ever meaningfully > 1 via
 * transformationEngine.ts's `resolveRecurrenceInterval` (e.g. "every second
 * Monday", "quarterly"), so this only shows the more verbose phrasing when
 * there's actually a real cadence to communicate. */
function formatRecurrenceLabel(recurrence: ToDo["recurrence"], interval: number): string {
  if (recurrence === "none") {
    return "";
  }
  if (interval <= 1) {
    return `Repeats ${recurrence}`;
  }
  return `Every ${interval} ${RECURRENCE_UNIT_LABELS[recurrence]}s`;
}

export type TodoItemRowProps = {
  item: ToDo;
  /** Checkbox tap — the parent owns the drop-animation/undo-snackbar
   * lifecycle (see components/TodosOverlay.tsx's `handleCheck`); this component only ever
   * reports the intent, never calls completeToDo itself. */
  onCheck: (item: ToDo) => void;
  /** Long-press — unchanged escape hatch from Phase 2 Step 2 for a to-do a
   * plain "complete" tap can't get rid of (e.g. wrongly tagged recurring). */
  onLongPressDelete: (item: ToDo) => void;
  /** Only ever called when `item.noteId` is set (the citation link is only
   * rendered in that case) — see components/TodosOverlay.tsx for how it opens
   * NoteDetailModal. */
  onOpenSourceNote: (noteId: string) => void;
  /** Edit-pen tap — opens components/AddTodoBottomSheet.tsx pre-filled with
   * this item's full state (text, dates, time, recurrence), not just its
   * text. Phase 2 Step 4 follow-up: an earlier version of this row did its
   * own lightweight inline text-only edit (a plain TextInput swapped in for
   * the Text), but that had no way to reach any of the fields Step 4 added —
   * reusing the same sheet the Add flow already has, in an "editing" mode,
   * covers every field with one surface instead of building a second,
   * narrower one just for this row. See TodosOverlay.tsx's `editingTodo`
   * state for how the sheet is told which mode it's in. */
  onEditDetails: (item: ToDo) => void;
};

/**
 * One row in the "Your To-Dos" list (Phase 2 Step 3's production redesign of
 * the Step 2 stub). Monochromatic glass card matching the app's established
 * translucent-box language (see HistorySheet.tsx's `textContainerBox` for
 * the same visual family), with two content lines: a micro-header (creation
 * date + optional source-note citation) and the main row (checkbox, task
 * text, edit pen). The edit pen opens the full Add/Edit sheet pre-filled
 * with this item — see `onEditDetails`'s own doc comment.
 *
 * TOUCHABLE HARMONIZATION: every tappable element here is
 * `TouchableOpacity` from `react-native-gesture-handler`, not plain
 * `Pressable`/`TouchableOpacity` from `react-native`. This app's root layout
 * (app/_layout.tsx) wraps everything in `GestureHandlerRootView`, and this
 * screen also mounts `@gorhom/bottom-sheet` (components/AddTodoBottomSheet.tsx),
 * which is itself built entirely on react-native-gesture-handler's native
 * gesture recognizers. Mixing the plain-RN responder system (what
 * `Pressable` uses) with RNGH's native touch-dispatch takeover in the same
 * gesture-handler root is a known source of responder-negotiation issues on
 * Android — using RNGH touchables everywhere under this root keeps every
 * tap resolved through the same gesture arena as the bottom sheet's own
 * pan/tap handlers, rather than two independent systems racing over the
 * same touch stream.
 *
 * `Animated.View`'s `exiting`/`layout` props are what make the "drop on
 * check" behavior in components/TodosOverlay.tsx actually visible: that screen filters a
 * checked item out of the list it passes to `FlatList` immediately (so the
 * completion logic and undo timer are unaffected by animation timing), and
 * Reanimated intercepts this component's unmount to play `FadeOutDown`
 * before it's actually removed, while `LinearTransition` smoothly closes the
 * gap in the sibling rows above/below it. Both work with a plain `FlatList`
 * (no `Animated.FlatList` needed) since it's this row's own mount/unmount
 * Reanimated is hooking into, not anything list-virtualization-specific.
 */
export function TodoItemRow({ item, onCheck, onLongPressDelete, onOpenSourceNote, onEditDetails }: TodoItemRowProps) {
  return (
    <Animated.View exiting={FadeOutDown.duration(280)} layout={LinearTransition.duration(220)} style={styles.card}>
      <TouchableOpacity onLongPress={() => onLongPressDelete(item)} delayLongPress={600} activeOpacity={1}>
        <View style={styles.metaRow}>
          <Text style={styles.metaText}>{formatCreatedDate(item.createdAt)}</Text>
          {item.noteId && (
            <TouchableOpacity onPress={() => onOpenSourceNote(item.noteId as string)} hitSlop={8}>
              <Text style={styles.sourceLink}>🎙️ Source Note</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.mainRow}>
          <TouchableOpacity
            onPress={() => onCheck(item)}
            hitSlop={10}
            style={styles.checkbox}
            accessibilityRole="checkbox"
            accessibilityLabel={`Mark "${item.text}" as done`}
          />

          <Text style={styles.taskText}>{item.text}</Text>

          <TouchableOpacity onPress={() => onEditDetails(item)} hitSlop={10} style={styles.editButton}>
            <Feather name="edit-2" size={16} color={colors.textMuted} />
          </TouchableOpacity>
        </View>

        <Text style={styles.dueText}>
          {item.toDate ? formatDateRange(item.actionDate, item.toDate) : formatActionDate(item.actionDate)}
          {item.recurrence !== "none" ? ` · ${formatRecurrenceLabel(item.recurrence, item.recurrenceInterval)}` : ""}
        </Text>
        {/* Phase 2 Step 4: only shown when an explicit time was actually
            stated/picked — see db/schema.ts's DEFAULT_NOTIFICATION_TIME doc
            comment. A to-do with no explicit time still fires its
            notification at 5 AM (the default), it just doesn't clutter
            every single row with a badge for it. */}
        {item.notificationTime !== DEFAULT_NOTIFICATION_TIME && (
          <Text style={styles.timeBadge}>⏰ {formatTime12h(item.notificationTime)}</Text>
        )}
      </TouchableOpacity>
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
  editButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  dueText: {
    color: colors.textMuted,
    ...typography.caption,
    marginTop: spacing.sm,
  },
  timeBadge: {
    color: colors.accent,
    ...typography.caption,
    fontWeight: "600",
    marginTop: spacing.xs,
  },
});
