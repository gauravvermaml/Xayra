import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, { BottomSheetBackdrop, BottomSheetTextInput, type BottomSheetBackdropProps } from "@gorhom/bottom-sheet";

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

const SNAP_POINTS = ["50%"];

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
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={SNAP_POINTS}
      // Required whenever explicit `snapPoints` are given — v5 defaults this
      // to `true`, which sizes the sheet from measured content height and
      // ignores `snapPoints` entirely. Without it, `snapToIndex(0)` resolves
      // against a height that was never established, so the sheet never
      // visibly opens even though the (+) button's own onPress does fire
      // (confirmed on-device: HistorySheet.tsx sets this same prop for the
      // same reason).
      enableDynamicSizing={false}
      enablePanDownToClose
      onClose={handleSheetClosed}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.background}
      handleIndicatorStyle={styles.handleIndicator}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <View style={styles.content}>
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
      </View>
    </BottomSheet>
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
    flex: 1,
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
