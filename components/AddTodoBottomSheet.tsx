import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetTextInput,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";

import { colors, radius, spacing, typography } from "../constants/theme";
import { RECURRENCE_OPTIONS, type Recurrence } from "../db/schema";

export type AddTodoBottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  onSave: (text: string, recurrence: Recurrence) => void;
};

const RECURRENCE_PICKER_LABELS: Record<Recurrence, string> = {
  none: "None",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

// No fixed `snapPoints` array — this sheet uses dynamic sizing (the
// library's default: `enableDynamicSizing` is `true` unless explicitly
// turned off) so it sizes itself to its actual measured content instead of
// a hardcoded percentage. A first attempt explicitly set
// `enableDynamicSizing={false}` with `snapPoints={["50%"]}` to fix the (+)
// button silently failing to open the sheet — that combination did open the
// sheet, but also reproducibly froze the ENTIRE /todos screen (checkbox,
// edit, back, scroll — everything) on-device, confirmed by reverting it and
// retesting on a completely fresh install/Metro cache: the freeze followed
// this prop combination, not any other code on the screen. Plain dynamic
// sizing with no snapPoints is the standard "on-demand sheet sized to its
// form" pattern and doesn't hit whatever native layout contention the fixed-
// percentage + disabled-dynamic-sizing combination triggered on this device.

/**
 * On-demand "Add a to-do" sheet — a plain `<BottomSheet>` (not
 * `BottomSheetModal`) closed by default (`index={-1}`) and driven open/shut
 * by the `visible` prop, the same pattern HistorySheet.tsx already
 * establishes for this library in this app. Deliberately not
 * `BottomSheetModal`: that variant needs a `BottomSheetModalProvider`
 * wrapped around the app in app/_layout.tsx, which nothing else in this
 * codebase uses yet — a plain `BottomSheet` with `backdropComponent` gets
 * the same tap-outside-to-dismiss modal behavior without that extra global
 * wiring.
 *
 * Monochromatic Glass styling per spec: translucent near-black background,
 * a barely-there white border, no blur (this app never uses `expo-blur` —
 * every "glass" surface elsewhere, e.g. HistorySheet's `textContainerBox`,
 * is a flat translucent color over the jet-black canvas, not a real blur).
 */
export function AddTodoBottomSheet({ visible, onClose, onSave }: AddTodoBottomSheetProps) {
  const sheetRef = useRef<BottomSheet>(null);
  const [text, setText] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("none");

  useEffect(() => {
    if (visible) {
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [visible]);

  // Fires on every way the sheet actually closes — backdrop tap, swipe-down,
  // or this component's own `sheetRef.current?.close()` call after a save —
  // so form state always resets exactly once, from a single path, rather
  // than every closing gesture needing its own reset call.
  const handleSheetClosed = useCallback(() => {
    setText("");
    setRecurrence("none");
    onClose();
  }, [onClose]);

  const canSave = text.trim().length > 0;

  const handleSave = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    onSave(trimmed, recurrence);
    sheetRef.current?.close();
  }, [text, recurrence, onSave]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} appearsOnIndex={0} disappearsOnIndex={-1} opacity={0.6} pressBehavior="close" />
    ),
    []
  );

  return (
    // Defensive belt-and-suspenders on top of @gorhom/bottom-sheet's own
    // internal pointerEvents toggling (BottomSheetBackdrop already flips
    // itself to pointerEvents="none" via a useAnimatedReaction on
    // animatedIndex reaching disappearsOnIndex, and BottomSheetHostingContainer
    // itself is pointerEvents="box-none" — verified in the library's own
    // source). This outer View makes the guarantee explicit and independent
    // of the library's internal state: while this sheet is closed, NOTHING
    // in this subtree — sheet, backdrop, handle — can intercept a touch
    // meant for whatever's underneath (TodosOverlay's FlatList), regardless
    // of whether the library's own animated reaction has settled yet.
    <View pointerEvents={visible ? "auto" : "none"} style={StyleSheet.absoluteFill}>
      <BottomSheet
        ref={sheetRef}
        index={-1}
        enablePanDownToClose
        onClose={handleSheetClosed}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.background}
        handleIndicatorStyle={styles.handleIndicator}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        <BottomSheetView style={styles.content}>
          <Text style={styles.title}>New To-Do</Text>

          <BottomSheetTextInput
            value={text}
            onChangeText={setText}
            placeholder="What do you need to do?"
            placeholderTextColor="rgba(235,235,245,0.45)"
            style={styles.input}
            autoFocus
            returnKeyType="done"
          />

          <Text style={styles.sectionLabel}>Repeats</Text>
          <View style={styles.recurrenceRow}>
            {RECURRENCE_OPTIONS.map((option) => (
              <Pressable
                key={option}
                onPress={() => setRecurrence(option)}
                style={[styles.recurrenceOption, recurrence === option && styles.recurrenceOptionActive]}
              >
                <Text style={[styles.recurrenceText, recurrence === option && styles.recurrenceTextActive]}>
                  {RECURRENCE_PICKER_LABELS[option]}
                </Text>
              </Pressable>
            ))}
          </View>

          <Pressable
            onPress={handleSave}
            disabled={!canSave}
            style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
          >
            <Text style={styles.saveButtonText}>Save Task</Text>
          </Pressable>
        </BottomSheetView>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  background: {
    backgroundColor: "rgba(18, 18, 26, 0.94)",
    borderColor: "rgba(255, 255, 255, 0.12)",
    borderWidth: 1,
    borderRadius: 20,
  },
  handleIndicator: {
    backgroundColor: "rgba(255, 255, 255, 0.3)",
    width: 36,
  },
  content: {
    // No `flex: 1` — dynamic sizing (see this file's top-of-file doc
    // comment) measures this view's own natural content height to size the
    // sheet, which a flex:1 child (stretching to fill an as-yet-undefined
    // available height) defeats.
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
    gap: spacing.md,
  },
  title: {
    color: colors.textPrimary,
    ...typography.heading,
  },
  input: {
    backgroundColor: "rgba(255, 255, 255, 0.08)",
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.12)",
    color: colors.textPrimary,
    fontSize: 15,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.md,
  },
  sectionLabel: {
    color: colors.textMuted,
    ...typography.label,
    marginTop: spacing.sm,
  },
  recurrenceRow: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  recurrenceOption: {
    flex: 1,
    alignItems: "center",
    paddingVertical: spacing.sm,
    borderRadius: radius.pill,
    backgroundColor: "rgba(255, 255, 255, 0.06)",
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.1)",
  },
  recurrenceOptionActive: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  recurrenceText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  recurrenceTextActive: {
    color: colors.onAccent,
  },
  saveButton: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
    alignItems: "center",
  },
  saveButtonDisabled: {
    backgroundColor: "rgba(99,102,241,0.35)",
  },
  saveButtonText: {
    color: colors.onAccent,
    fontSize: 15,
    fontWeight: "700",
  },
});
