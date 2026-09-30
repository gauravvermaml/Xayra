import { useMemo } from "react";
import { StyleSheet, Text, View } from "react-native";
// RNGH's own FlatList, not plain react-native's `SectionList` — see this
// file's own top doc comment for why: `CalendarTaskCard`'s own
// `TouchableOpacity` (also from react-native-gesture-handler) doesn't
// negotiate touch/scroll gestures with a plain RN scroll container, the
// same class of bug this codebase has hit and fixed identically for
// DayLayout/WeekGridLayout's own ScrollViews. RNGH exports `FlatList` but
// not `SectionList`, so the date grouping is rebuilt on top of a flat row
// array instead — see this file's own doc comment for why it does NOT use
// `stickyHeaderIndices` despite the flat-row shape making that prop look
// tempting.
import { FlatList } from "react-native-gesture-handler";

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

type FlatRow = { key: string; header: string } | { key: string; item: ToDo };

export type ScheduleLayoutProps = {
  todos: ToDo[];
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onOpenSourceNote: (noteId: string) => void;
  onLongPressDelete: (item: ToDo) => void;
};

/**
 * Continuous vertical feed, "FRIDAY, 25 SEP"-style date banners interleaved
 * as their own rows in a flat `FlatList` — NOT a real `SectionList` (see
 * this file's own import comment for why: a live on-device report — the
 * list showed a scrollbar, meaning its own layout/content-size math was
 * already correct, but dragging it did nothing — traced to `SectionList`'s
 * legacy responder-based scrolling never receiving the gesture because
 * each row's `CalendarTaskCard` uses gesture-handler's own
 * `TouchableOpacity`, which claims touches through a completely different,
 * non-interoperating gesture system). This is the same fix
 * DayLayout.tsx/WeekGridLayout.tsx already needed for their own
 * ScrollViews, applied to a list instead.
 *
 * The headers do NOT stick to the top while scrolling (a real, accepted
 * regression from the old `SectionList`'s `stickySectionHeadersEnabled`) —
 * a first version tried `stickyHeaderIndices` on this same FlatList, which
 * crashed the app on-device with a native Fabric mounting exception
 * (`addViewAt: failed to insert view`, caused by an `IndexOutOfBoundsException`
 * in `ViewGroup.originalAddInArray`). Root cause: `stickyHeaderIndices`'
 * "pull this child out and render it as a pinned overlay" behavior is
 * implemented at the native view-manager level specifically for React
 * Native's OWN `ScrollView`; `react-native-gesture-handler`'s `FlatList`
 * renders through its own separate native scroll-view class (confirmed by
 * grepping its source — it doesn't reference `stickyHeaderIndices`
 * anywhere), so that native reparenting never happens correctly and the
 * Fabric shadow tree ends up disagreeing with the actual native view
 * hierarchy about how many children a container has. If sticky headers are
 * wanted back, the safe way is a hand-built overlay (track scroll offset,
 * render a separate absolutely-positioned header showing whichever date is
 * currently at the top) — not this prop, on this list.
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
  const rows = useMemo(() => {
    const flat: FlatRow[] = [];
    for (const group of groupToDosByDate(todos)) {
      flat.push({ key: `header-${group.date}`, header: group.date });
      for (const item of group.items) {
        flat.push({ key: item.id, item });
      }
    }
    return flat;
  }, [todos]);

  return (
    <FlatList
      style={styles.list}
      data={rows}
      keyExtractor={(row) => row.key}
      contentContainerStyle={styles.listContent}
      renderItem={({ item: row }) =>
        "header" in row ? (
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionHeaderText}>{formatSectionHeader(row.header)}</Text>
          </View>
        ) : (
          <View style={styles.cardWrap}>
            <CalendarTaskCard
              item={row.item}
              variant="full"
              onPress={onOpenTask}
              onCheck={onCheckTask}
              onOpenSourceNote={onOpenSourceNote}
              onLongPressDelete={onLongPressDelete}
            />
          </View>
        )
      }
      ListEmptyComponent={<Text style={styles.emptyText}>No to-dos to show yet.</Text>}
    />
  );
}

const styles = StyleSheet.create({
  // Without this, the list has no bounded height of its own along the main
  // axis — its parent's `flex: 1` (CalendarBody.tsx's `styles.body`) stretches
  // it cross-axis, but the list still needs an explicit `flex: 1` (or fixed
  // height) on ITSELF to know what counts as "off-screen."
  list: {
    flex: 1,
  },
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
  // Carries both the "gap below each card" and "gap below/above a header"
  // spacing that `ItemSeparatorComponent` used to provide — a flat row list
  // can't use that prop as cleanly (it'd also insert a gap between a header
  // and its own first card), so each row owns its own trailing space
  // instead.
  cardWrap: {
    marginBottom: spacing.xs,
  },
  emptyText: {
    color: colors.textMuted,
    ...typography.body,
    textAlign: "center",
    marginTop: spacing.xxl,
  },
});
