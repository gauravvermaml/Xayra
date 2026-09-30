import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, Text, View } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, spacing, typography } from "../../constants/theme";
import { formatFullDate } from "../../services/calendar/dateRange";
import type { ToDo } from "../../services/todos/todoManager";
import { CalendarTaskCard } from "./CalendarTaskCard";

export type WeekDayPreviewSheetProps = {
  /** null (the common at-rest state) keeps the sheet closed and its content
   * unrendered — same pattern as TaskPreviewSheet.tsx's own `item`. */
  date: string | null;
  /** Already resolved by the caller (CalendarBody.tsx) to `date`'s own
   * to-dos — this component doesn't do any of its own date filtering. */
  todos: ToDo[];
  onClose: () => void;
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onOpenSourceNote: (noteId: string) => void;
  onLongPressDelete: (item: ToDo) => void;
  onSendToCalendar: (item: ToDo) => void;
};

/**
 * Week/Work Week's own "tap a day header -> see that day's full reminder
 * list" — live-requested to be a real draggable bottom sheet (spring open on
 * tap, drag the handle down to dismiss), NOT MonthLayout.tsx's always-visible
 * inline panel below the grid. Deliberately different from Month's own
 * pattern: Month's grid cells are tiny and the panel IS the natural detail
 * view for whatever's selected, but here the hourly timeline is the primary
 * content competing for the same screen space — a dismissible sheet lets a
 * user peek at a day's list without permanently giving up timeline space,
 * and matches the "spring up / drag down, fluid" feel already established
 * everywhere else in this app that uses `@gorhom/bottom-sheet`
 * (TaskPreviewSheet.tsx, AddTodoBottomSheet.tsx) — reusing that exact
 * mechanism here (rather than a bespoke animation) is what makes it feel
 * consistent with "so many other places in the app," not a coincidence.
 *
 * Mounted ONCE in CalendarBody.tsx (not inside WeekGridLayout.tsx itself),
 * specifically because WeekGridLayout is a PAGE component that
 * SwipeableCalendarPager.tsx mounts up to three times at once (current +
 * pre-mounted neighbors, see that file's own doc comment) — a sheet living
 * inside it would exist three times over, one per mounted page. Living in
 * CalendarBody.tsx instead, alongside the pager as a sibling, keeps exactly
 * one instance regardless of how many grid pages are mounted underneath it.
 *
 * Fixed `snapPoints={["50%"]}` (a real "lower half," not dynamic content
 * sizing) rather than TaskPreviewSheet.tsx's `enableDynamicSizing` default —
 * a day's full to-do list can run long enough to need its own scroll
 * (`BottomSheetScrollView`, real gesture-integrated scrolling, not a plain
 * `ScrollView` — see AddTodoBottomSheet.tsx's own import comment for why
 * that distinction matters inside a bottom sheet), which a dynamically-sized
 * sheet would fight measuring correctly for an unbounded item count.
 *
 * Defensive `pointerEvents` wrapper included from the start, not bolted on
 * after a live bug report — see TaskPreviewSheet.tsx's own doc comment
 * (Build 54) for the exact `@gorhom/bottom-sheet` backdrop race this guards
 * against: its `pointerEvents` correction to "none" can silently fail on a
 * sheet's very first mount, leaving an invisible full-screen touch-blocker
 * until the sheet opens once for real. Every new sheet in this codebase
 * should get this wrapper up front from now on, per that bug's own
 * "general lesson" note.
 */
export function WeekDayPreviewSheet({
  date,
  todos,
  onClose,
  onOpenTask,
  onCheckTask,
  onOpenSourceNote,
  onLongPressDelete,
  onSendToCalendar,
}: WeekDayPreviewSheetProps) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (date) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [date]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} pressBehavior="close" />
    ),
    []
  );

  return (
    <View pointerEvents={date ? "auto" : "none"} style={StyleSheet.absoluteFill}>
      <BottomSheet
        ref={sheetRef}
        index={-1}
        snapPoints={SNAP_POINTS}
        enableDynamicSizing={false}
        enablePanDownToClose
        onClose={onClose}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
      >
        <BottomSheetScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + spacing.lg }]}
          showsVerticalScrollIndicator={false}
        >
          {date && <Text style={styles.title}>{formatFullDate(date)}</Text>}
          {todos.length === 0 ? (
            <Text style={styles.emptyText}>Nothing scheduled this day.</Text>
          ) : (
            <View style={styles.list}>
              {todos.map((item) => (
                <CalendarTaskCard
                  key={item.id}
                  item={item}
                  variant="full"
                  onPress={onOpenTask}
                  onCheck={onCheckTask}
                  onOpenSourceNote={onOpenSourceNote}
                  onLongPressDelete={onLongPressDelete}
                  onSendToCalendar={onSendToCalendar}
                />
              ))}
            </View>
          )}
        </BottomSheetScrollView>
      </BottomSheet>
    </View>
  );
}

const SNAP_POINTS = ["50%"];

const styles = StyleSheet.create({
  sheetBackground: {
    backgroundColor: colors.surfaceElevated,
  },
  handleIndicator: {
    backgroundColor: colors.borderStrong,
  },
  content: {
    paddingHorizontal: spacing.base,
  },
  title: {
    color: colors.textPrimary,
    ...typography.heading,
    marginBottom: spacing.md,
  },
  list: {
    gap: spacing.sm,
  },
  emptyText: {
    color: colors.textMuted,
    ...typography.body,
    marginTop: spacing.lg,
    textAlign: "center",
  },
});
