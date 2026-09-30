import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { TouchableOpacity } from "react-native-gesture-handler";

import { colors, radius, spacing, typography } from "../../constants/theme";
import { DEFAULT_REMINDER_TIME } from "../../db/schema";
import { todayIso } from "../../services/calendar/dateRange";
import type { ToDo } from "../../services/todos/todoManager";

/** "15:30" -> "3:30 PM". Duplicated from TodoItemRow.tsx/AddTodoBottomSheet.tsx's
 * identical formatter rather than imported/shared — small enough, and in a
 * different component tree, that this codebase's own established convention
 * (see AddTodoBottomSheet.tsx's matching comment) is to duplicate rather
 * than add a cross-file util for a few lines. */
function formatTime12h(hhmm: string): string {
  const [hour, minute] = hhmm.split(":").map(Number);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

export type CalendarTaskCardProps = {
  item: ToDo;
  onPress: (item: ToDo) => void;
  onCheck: (item: ToDo) => void;
  /** Preserves TodoItemRow.tsx's existing "🎙️ Source Note" citation link and
   * long-press-to-delete gesture — real, pre-existing functionality that
   * would otherwise silently regress for any to-do extracted from a note
   * now that Schedule view (this card's "full" variant) replaces
   * TodosOverlay's old flat list. Both are optional since the compact grid
   * chips (Day/Week columns) don't have room for either. */
  onOpenSourceNote?: (noteId: string) => void;
  onLongPressDelete?: (item: ToDo) => void;
  /** Explicit "Send to Calendar" toggle (BACKLOG.md's "Push to-dos to Google
   * Calendar") — omitted the same way `onOpenSourceNote`/`onLongPressDelete`
   * are for "compact"/"micro" variants, which have no room for it. Fires
   * regardless of whether `item.googleCalendarEventId` is already set —
   * the button itself is the on/off toggle (see its own render below), not
   * a one-shot "send" action. */
  onSendToCalendar?: (item: ToDo) => void;
  /** "compact" — Day view's floating chips only, which have real width to
   * spare: checkbox + title + time chip + recurrence icon. "full" —
   * Schedule view and Month's day panel: the fuller treatment (recurrence
   * label spelled out, an overdue badge, the source-note link, a delete
   * button). "micro" — Week AND Work Week's grid columns: plain single-line
   * text, nothing else. A real on-device screenshot showed "compact" (then
   * used by Work Week too) overflowing badly — a checkbox, a truncated
   * title, a wrapped time string and an emoji stacked into a slot with no
   * room for any of it. Per explicit correction: a grid chip that small
   * shows ONLY the reminder text, sized to fit as many characters as the
   * column allows (native `numberOfLines={1}` ellipsis truncation handles
   * the actual "how many characters fit" measurement — see "micro"'s own
   * render below); completing or deleting a "micro" card requires opening
   * it, or using Schedule/Day/Month instead. All three variants read from
   * the same real fields — see this component's own top-level doc comment
   * for why no priority/category field is rendered here at all. */
  variant?: "compact" | "full" | "micro";
  /** Explicit size/position override for absolutely-positioned timeline
   * placement (DayColumnTimeline.tsx/DayLayout.tsx) — a plain percentage
   * width here, not `flex`, deliberately: this card's root is a
   * `react-native-gesture-handler` `TouchableOpacity`, which MonthLayout.tsx
   * (see its own doc comment) confirmed does not reliably propagate `flex`
   * sizing to its native view on Android. A resolved percentage/pixel width
   * from the caller sidesteps that instead of risking the same collapse. */
  style?: StyleProp<ViewStyle>;
};

/**
 * One task, rendered consistently everywhere the calendar system shows a
 * to-do — Day/Week/WorkWeek columns, Month's day tray, and Schedule's
 * full-width feed all render this same component rather than each layout
 * inventing its own card. Tapping anywhere on the card (outside the
 * checkbox) opens the app's existing detail/edit surface
 * (`AddTodoBottomSheet` in edit mode, via `onEditDetails` — see
 * TodosOverlay.tsx for the wiring) per the spec's explicit requirement that
 * every layout mode share one task detail view. The checkbox is a separate
 * nested touchable, the same pattern this app's old TodoItemRow.tsx (now
 * deleted — this component replaces it) established, so a tap there
 * completes the to-do instead of opening the detail sheet.
 *
 * NOTE ON MISSING FIELDS: the spec asked for "category accent chips" and
 * "priority badges," but `ToDo` (services/todos/todoManager.ts) has no
 * category or priority field — this app's to-dos are extracted from plain
 * spoken/typed notes, not entered against a schema with either concept.
 * Rather than inventing fake data, this substitutes the real signals the
 * model actually has: a recurrence chip (🔁) where the category chip would
 * go, and an "Overdue" badge (real, computed from actionDate vs. today)
 * where a priority badge would go — both flagged here so a future revisit
 * with a real category/priority field can find this decision.
 */
export function CalendarTaskCard({
  item,
  onPress,
  onCheck,
  onOpenSourceNote,
  onLongPressDelete,
  onSendToCalendar,
  variant = "compact",
  style,
}: CalendarTaskCardProps) {
  // Compares against DEFAULT_REMINDER_TIME (1 PM — see its own doc comment
  // in db/schema.ts), not the historical DEFAULT_NOTIFICATION_TIME (5 AM):
  // that's the value a NEW to-do actually defaults to today when nothing
  // was ever specified, from both the voice-extraction pipeline and the
  // manual add-to-do form. Comparing against the stale 5 AM constant here
  // would show a "1:00 PM" time chip on every silently-defaulted to-do as
  // if the user had explicitly chosen it.
  const hasExplicitTime = item.notificationTime !== DEFAULT_REMINDER_TIME;
  const isOverdue = !item.isCompleted && item.actionDate < todayIso();
  const isRecurring = item.recurrence !== "none";

  if (variant === "micro") {
    return (
      <TouchableOpacity
        onPress={() => onPress(item)}
        onLongPress={onLongPressDelete ? () => onLongPressDelete(item) : undefined}
        delayLongPress={600}
        activeOpacity={0.7}
        style={[styles.microCard, { borderLeftColor: isOverdue ? colors.danger : colors.accent }, style]}
      >
        {/* Text only — no checkbox, no time, no recurrence icon; a Week/Work
         * Week column has room for one line of title and nothing else. How
         * many characters actually fit isn't computed here at all: RN's own
         * text layout measures real glyph widths for whatever font/density
         * the device has, and `numberOfLines={1}` + `ellipsizeMode="tail"`
         * truncates with "…" the instant it overflows — the same mechanism
         * every native app relies on, not a hand-rolled character count
         * that would need to know the exact font metrics to be correct. */}
        <Text style={styles.microText} numberOfLines={1} ellipsizeMode="tail">
          {item.text}
        </Text>
      </TouchableOpacity>
    );
  }

  return (
    <TouchableOpacity
      onPress={() => onPress(item)}
      onLongPress={onLongPressDelete ? () => onLongPressDelete(item) : undefined}
      delayLongPress={600}
      activeOpacity={0.7}
      style={[
        styles.card,
        { borderLeftColor: isOverdue ? colors.danger : colors.accent },
        variant === "full" && styles.cardFull,
        style,
      ]}
    >
      <TouchableOpacity
        onPress={() => onCheck(item)}
        hitSlop={10}
        style={styles.checkbox}
        accessibilityRole="checkbox"
        accessibilityLabel={`Mark "${item.text}" as done`}
      />
      <View style={styles.body}>
        <Text style={styles.text} numberOfLines={variant === "full" ? 2 : 1}>
          {item.text}
        </Text>
        <View style={styles.chipRow}>
          {hasExplicitTime && <Text style={styles.timeChip}>{formatTime12h(item.notificationTime)}</Text>}
          {isRecurring && <Text style={styles.recurrenceChip}>🔁</Text>}
          {variant === "full" && isOverdue && <Text style={styles.overdueChip}>Overdue</Text>}
        </View>
        {variant === "full" && item.noteId && onOpenSourceNote && (
          <TouchableOpacity onPress={() => onOpenSourceNote(item.noteId as string)} hitSlop={8}>
            <Text style={styles.sourceLink}>🎙️ Source Note</Text>
          </TouchableOpacity>
        )}
      </View>
      {variant === "full" && onSendToCalendar && (
        // On/off toggle, not a one-shot "send" — tapping again once linked
        // removes it from Calendar (BACKLOG.md's own recorded decision).
        // 🗓️ (outline-reading emoji) vs 📅 (filled) is the only signal for
        // which state it's in; dimmed further via `opacity` when linked so
        // the two are distinguishable even for someone who can't tell the
        // two calendar emoji apart at a glance.
        <TouchableOpacity
          onPress={() => onSendToCalendar(item)}
          hitSlop={10}
          style={styles.calendarButton}
          accessibilityRole="button"
          accessibilityLabel={
            item.googleCalendarEventId ? `Remove "${item.text}" from Google Calendar` : `Send "${item.text}" to Google Calendar`
          }
        >
          <Text style={[styles.calendarIcon, item.googleCalendarEventId && styles.calendarIconActive]}>
            {item.googleCalendarEventId ? "📅" : "🗓️"}
          </Text>
        </TouchableOpacity>
      )}
      {variant === "full" && onLongPressDelete && (
        // Explicit, visible delete affordance — long-press-to-delete (the
        // card's own onLongPress above) still works too, but it's a hidden
        // gesture nobody discovers on their own. Reuses the exact same
        // confirm-then-delete callback (TodosOverlay.tsx's
        // handleLongPressDelete already shows an "Are you sure?" Alert
        // before actually deleting), just triggered by a tap instead of a
        // long press. Only on "full" (Schedule + the Month day-tray) —
        // Day/Week/Work Week's compact/micro grid cells are too narrow for
        // a second touch target, and already have their own long-press.
        <TouchableOpacity
          onPress={() => onLongPressDelete(item)}
          hitSlop={10}
          style={styles.deleteButton}
          accessibilityRole="button"
          accessibilityLabel={`Delete "${item.text}"`}
        >
          <Text style={styles.deleteIcon}>🗑️</Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    // Bright left accent line — `borderLeftColor` is set inline per-card
    // (accent, or danger when overdue) since it depends on the item, not a
    // fixed value a static stylesheet entry could hold.
    borderLeftWidth: 3,
    borderRadius: radius.md,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  cardFull: {
    borderRadius: radius.lg,
    padding: spacing.md,
  },
  microCard: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderLeftWidth: 3,
    borderRadius: radius.sm,
    paddingHorizontal: 2,
    paddingVertical: 1,
    justifyContent: "center",
  },
  microText: {
    color: colors.textPrimary,
    fontSize: 10,
  },
  checkbox: {
    width: 18,
    height: 18,
    marginTop: 2,
    borderRadius: radius.sm - 2,
    borderWidth: 2,
    borderColor: colors.borderStrong,
  },
  body: {
    flex: 1,
    gap: spacing.xs,
  },
  text: {
    color: colors.textPrimary,
    ...typography.caption,
    fontSize: 13,
  },
  chipRow: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  timeChip: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "700",
  },
  recurrenceChip: {
    fontSize: 11,
  },
  overdueChip: {
    color: colors.danger,
    backgroundColor: colors.dangerMuted,
    fontSize: 10,
    fontWeight: "700",
    paddingHorizontal: spacing.xs,
    paddingVertical: 1,
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  sourceLink: {
    color: colors.accent,
    fontSize: 11,
    fontWeight: "600",
  },
  calendarButton: {
    alignSelf: "flex-start",
    marginLeft: spacing.xs,
    padding: 2,
  },
  calendarIcon: {
    fontSize: 14,
    opacity: 0.6,
  },
  calendarIconActive: {
    opacity: 1,
  },
  deleteButton: {
    alignSelf: "flex-start",
    marginLeft: spacing.xs,
    padding: 2,
  },
  deleteIcon: {
    fontSize: 14,
    opacity: 0.6,
  },
});
