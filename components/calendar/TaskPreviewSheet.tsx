import { useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import BottomSheet, { BottomSheetBackdrop, BottomSheetView, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, spacing } from "../../constants/theme";
import type { ToDo } from "../../services/todos/todoManager";
import { CalendarTaskCard } from "./CalendarTaskCard";

export type TaskPreviewSheetProps = {
  /** null (the common at-rest state) keeps the sheet closed and its content
   * unrendered — same pattern as AddTodoBottomSheet's `editingTodo` and
   * CalendarDayTray's `date`. */
  item: ToDo | null;
  onClose: () => void;
  /** Tapping the card itself — opens the full edit sheet. The caller is
   * expected to close this preview at the same time (see TodosOverlay.tsx's
   * wiring) so the two sheets never both try to be open at once. */
  onOpenTask: (item: ToDo) => void;
  onCheckTask: (item: ToDo) => void;
  onOpenSourceNote: (noteId: string) => void;
  onLongPressDelete: (item: ToDo) => void;
  onSendToCalendar: (item: ToDo) => void;
};

/**
 * Week/Work Week's own "tap a reminder -> see its card, tap the card -> full
 * edit sheet" step — the same two-step pattern Month view already has via
 * CalendarDayTray (tap a date -> that day's cards -> tap a card -> edit),
 * just scoped to a single task instead of a whole day's list. Needed because
 * Week/Work Week show reminders directly inline in the grid, as tiny
 * single-line "micro" chips (see CalendarTaskCard's own doc comment) with no
 * "tap the date first" step to hang a preview off of — tapping the chip
 * itself has to be what opens this.
 *
 * Renders the exact same "full" `CalendarTaskCard` Schedule view and the
 * Month day-panel use, so the reminder actually becomes readable (real
 * title, time, recurrence, source-note link, delete button) before
 * committing to the heavier multi-field edit sheet.
 *
 * No `snapPoints`/`enableDynamicSizing` override, unlike AddTodoBottomSheet
 * — that file's own doc comment explains why dynamic sizing broke there
 * (a focused text input's keyboard fighting the sheet's own height
 * measurement); this sheet has no text input at all, just one static card,
 * so v5's default dynamic sizing is safe here and gives a snug,
 * content-sized sheet instead of an oversized fixed one.
 *
 * `insets.bottom` padding on the content is required, not optional — same
 * bug class this codebase has hit and fixed several times before (Day view,
 * the Week/Work Week grid, all needed it explicitly): a dynamically-sized
 * sheet measures its OWN content height and has no innate awareness of the
 * Android nav bar sitting on top of wherever that puts its bottom edge.
 * Confirmed on-device without this: the card's lower half (delete icon
 * included) rendered behind the nav bar, unreachable.
 */
export function TaskPreviewSheet({
  item,
  onClose,
  onOpenTask,
  onCheckTask,
  onOpenSourceNote,
  onLongPressDelete,
  onSendToCalendar,
}: TaskPreviewSheetProps) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);

  useEffect(() => {
    if (item) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [item]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} pressBehavior="close" />
    ),
    []
  );

  return (
    // Defensive belt-and-suspenders on top of @gorhom/bottom-sheet's own
    // internal pointerEvents toggling — same fix, same reasoning, as
    // AddTodoBottomSheet.tsx's own identical wrapper (see that file's doc
    // comment): BottomSheetBackdrop's `pointerEvents` correction to "none" is
    // driven by a `useAnimatedReaction` that writes through an `isMounted`
    // ref set in a `useEffect` — on this sheet's very first mount, that
    // reaction's initial evaluation can race ahead of the effect and get
    // silently dropped, leaving the backdrop's default pointerEvents="auto"
    // (its un-corrected initial state) stuck full-screen and touch-blocking
    // until a real open/close cycle runs once. Confirmed live on-device as
    // the actual root cause of the To-Dos search bar being untappable right
    // after opening the screen, and working again only after first opening
    // this exact sheet once (Week/Work Week's reminder-tap preview) — this
    // sheet was the one place that earlier fix was missed. This outer View
    // makes the guarantee explicit and independent of the library's internal
    // state, regardless of whether its own animated reaction has settled.
    <View pointerEvents={item ? "auto" : "none"} style={StyleSheet.absoluteFill}>
      <BottomSheet
        ref={sheetRef}
        index={-1}
        enablePanDownToClose
        onClose={onClose}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
      >
        <BottomSheetView style={[styles.content, { paddingBottom: insets.bottom + spacing.lg }]}>
          {item && (
            <CalendarTaskCard
              item={item}
              variant="full"
              onPress={onOpenTask}
              onCheck={onCheckTask}
              onOpenSourceNote={onOpenSourceNote}
              onLongPressDelete={onLongPressDelete}
              onSendToCalendar={onSendToCalendar}
            />
          )}
        </BottomSheetView>
      </BottomSheet>
    </View>
  );
}

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
});
