import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import BottomSheet, {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetBackdropProps,
} from "@gorhom/bottom-sheet";
import { useSafeAreaInsets } from "react-native-safe-area-context";

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

// Fixed snap point, matching HistorySheet.tsx's own proven setup — NOT
// dynamic sizing. Two earlier attempts both broke keyboardBehavior=
// "interactive" once the task TextInput's autoFocus opened the keyboard
// (first hiding the Save Task button behind it entirely, then still
// covering the input after switching to BottomSheet's own `bottomInset`
// prop) — confirmed on-device both times. Root cause: dynamic sizing
// measures BottomSheetView's content height to pick the sheet's snap point,
// and that measurement is a DIFFERENT calculation from the one
// keyboardBehavior="interactive" does to keep a focused input above the
// keyboard — anything that changes the measured content height (manual
// padding, the bottomInset prop, both tried here) feeds into the former
// without the latter accounting for it correctly, exactly the "three
// mechanisms compensating for the same keyboard" trap ComposeBar.tsx's own
// doc comment already documents from this app's Build 20 history. A FIXED
// snap point sidesteps the conflict outright: there's no content
// measurement for anything else to disagree with.
//
// (An earlier version of this file used dynamic sizing specifically to fix
// the (+) button silently failing to open the sheet under
// `enableDynamicSizing={false}` + `snapPoints={["50%"]}` — that combination
// was blamed for a full-screen freeze at the time, but the freeze's actual
// cause, found later, was an unrelated CPU-starvation bug in
// services/ai/localLlama.ts (see that file's doc comment) that was almost
// certainly what was actually observed, not this sizing combination. Now
// that the real cause is fixed, reverting to fixed sizing is safe and is
// what actually fixes the keyboard-avoidance conflict dynamic sizing
// introduced.)
//
// "90%", not "50%": `keyboardBehavior="interactive"` only translates the
// SHEET as a whole — it has no way to scroll a specific focused field into
// view within it, which is a separate concern `BottomSheetScrollView` alone
// doesn't solve automatically either (confirmed on-device: the task input
// stayed hidden behind the keyboard with a "50%" sheet + scrollable content,
// even though the sheet's own title showed above the keyboard fine). A
// keyboard on Android routinely covers ~40-50% of the screen, so a 50%-tall
// sheet simply doesn't have the vertical budget for its own top content to
// clear it without perfect interactive math this combination doesn't
// reliably deliver. "90%" sidesteps needing that math to be exact at all:
// the title and input sit near the top of a near-full-screen sheet, with
// enough plain, unconditional headroom above any keyboard height this
// device will ever show, independent of whatever `interactive` does or
// doesn't do correctly.
const SNAP_POINTS = ["90%"];

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
 * Content is `BottomSheetScrollView`, not `BottomSheetView`/a plain `View` —
 * see its own doc comment at the render site for why a scrollable content
 * container, not a rigid block, is what actually lets the focused field
 * clear the Android keyboard.
 *
 * Monochromatic Glass styling per spec: translucent near-black background,
 * a barely-there white border, no blur (this app never uses `expo-blur` —
 * every "glass" surface elsewhere, e.g. HistorySheet's `textContainerBox`,
 * is a flat translucent color over the jet-black canvas, not a real blur).
 */
export function AddTodoBottomSheet({ visible, onClose, onSave }: AddTodoBottomSheetProps) {
  const insets = useSafeAreaInsets();
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
        snapPoints={SNAP_POINTS}
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
        {/* BottomSheetScrollView, not a plain View — the sheet's fixed 50%
            height plus the Android keyboard (itself routinely ~40-50% of
            the screen) leaves no room for every field to be simultaneously
            visible above the keyboard purely by shifting a rigid block; a
            scrollable content container is what actually lets
            keyboardBehavior="interactive" bring whichever field is focused
            into view, the standard @gorhom/bottom-sheet pattern for a form
            longer than "fits trivially above any keyboard." Confirmed
            on-device that a plain `View` here left the task TextInput
            hidden behind the keyboard even after the sheet itself
            correctly showed its title above it — there was simply nowhere
            left for the input to go without scrolling. */}
        <BottomSheetScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
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

          {/* Bottom safe-area (Android nav/gesture bar) clearance, applied
              as plain padding on its own trailing wrapper — exactly
              HistorySheet.tsx's own ModelDownloadCard pattern — rather than
              folded into `content`'s or an ancestor's height. Nothing here
              feeds into a content-height measurement that keyboard
              avoidance also depends on, so it can't reintroduce the earlier
              conflict. */}
          <View style={{ paddingBottom: insets.bottom }}>
            <Pressable
              onPress={handleSave}
              disabled={!canSave}
              style={[styles.saveButton, !canSave && styles.saveButtonDisabled]}
            >
              <Text style={styles.saveButtonText}>Save Task</Text>
            </Pressable>
          </View>
        </BottomSheetScrollView>
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
    // No `flex: 1` — this is a ScrollView content container now (see the
    // BottomSheetScrollView doc comment at its render site), which should
    // size to its own content, not stretch to fill the sheet.
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
