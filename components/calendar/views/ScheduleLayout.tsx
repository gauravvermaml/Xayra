import { useMemo } from "react";
import { SectionList, StyleSheet, Text, View } from "react-native";

import { colors, spacing, typography } from "../../../constants/theme";
import { groupToDosByDate, todayIso } from "../../../services/calendar/dateRange";
import type { ToDo } from "../../../services/todos/todoManager";
import { CalendarTaskCard } from "../CalendarTaskCard";

const WEEKDAY_NAMES = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"] as const;
const MONTH_ABBR = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"] as const;

/** "FRIDAY, 25 SEP" — matches the spec's exact banner wording, with "TODAY"
 * substituted in place of the weekday name when the section is today's own
 * date (a small, honest touch mainstream calendar apps also do, and free
 * given `groupToDosByDate` already keys sections by real ISO dates). */
function formatSectionHeader(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  const label = iso === todayIso() ? "TODAY" : WEEKDAY_NAMES[date.getDay()];
  return `${label}, ${day} ${MONTH_ABBR[month - 1]}`;
}

export type ScheduleLayoutProps = {
  todos: ToDo[];
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onOpenSourceNote: (noteId: string) => void;
  onLongPressDelete: (item: ToDo) => void;
};

/**
 * Continuous vertical feed, sticky "FRIDAY, 25 SEP"-style section banners
 * per date — a real `SectionList` (not a hand-rolled flattened array),
 * which gives `stickySectionHeadersEnabled` for free rather than building
 * sticky-header behavior by hand. This is the natural evolution of what
 * used to be TodosOverlay's own flat, ungrouped `FlatList` — grouping by
 * date is the one thing this view adds beyond that.
 *
 * Not range-scoped, unlike the four grid layouts (Day/Work Week/Week/
 * Month) — `groupToDosByDate` runs on whatever `todos` this already
 * received (already keyword-filtered by the caller), and only dates that
 * actually have a to-do produce a section, per the spec's explicit "only
 * displays dates that have tasks."
 */
export function ScheduleLayout({
  todos,
  onOpenTask,
  onCheckTask,
  onOpenSourceNote,
  onLongPressDelete,
}: ScheduleLayoutProps) {
  const sections = useMemo(
    () => groupToDosByDate(todos).map((group) => ({ title: group.date, data: group.items })),
    [todos]
  );

  return (
    <SectionList
      sections={sections}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled
      contentContainerStyle={styles.listContent}
      renderSectionHeader={({ section }) => (
        <View style={styles.sectionHeader}>
          <Text style={styles.sectionHeaderText}>{formatSectionHeader(section.title)}</Text>
        </View>
      )}
      renderItem={({ item }) => (
        <View style={styles.cardWrap}>
          <CalendarTaskCard
            item={item}
            variant="full"
            onPress={onOpenTask}
            onCheck={onCheckTask}
            onOpenSourceNote={onOpenSourceNote}
            onLongPressDelete={onLongPressDelete}
          />
        </View>
      )}
      ItemSeparatorComponent={() => <View style={styles.itemGap} />}
      ListEmptyComponent={<Text style={styles.emptyText}>No to-dos to show yet.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  listContent: {
    paddingBottom: 120,
    paddingHorizontal: spacing.base,
  },
  sectionHeader: {
    backgroundColor: colors.background,
    paddingVertical: spacing.sm,
  },
  sectionHeaderText: {
    color: colors.textMuted,
    ...typography.label,
    letterSpacing: 0.6,
  },
  cardWrap: {
    marginBottom: spacing.xs,
  },
  itemGap: {
    height: spacing.xs,
  },
  emptyText: {
    color: colors.textMuted,
    ...typography.body,
    textAlign: "center",
    marginTop: spacing.xxl,
  },
});
