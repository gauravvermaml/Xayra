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
import { DEFAULT_NOTIFICATION_TIME, RECURRENCE_OPTIONS, type Recurrence } from "../db/schema";
import type { ToDo } from "../services/todos/todoManager";

export type AddTodoBottomSheetProps = {
  visible: boolean;
  onClose: () => void;
  onSave: (text: string, actionDate: string, toDate: string | null, notificationTime: string, recurrence: Recurrence) => void;
  /**
   * Phase 2 Step 4 follow-up: when set, this sheet opens pre-filled with an
   * EXISTING to-do's full state instead of blank defaults — the same
   * `onSave` callback fires either way (with whatever the fields currently
   * are), and it's the caller's job (components/TodosOverlay.tsx) to decide
   * whether that means `addToDo` or `updateToDo`, since this component has
   * no DB access of its own. Null/undefined means "adding a new to-do," the
   * original behavior.
   */
  editingTodo?: ToDo | null;
};

const RECURRENCE_PICKER_LABELS: Record<Recurrence, string> = {
  none: "None",
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

function formatIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayIso(): string {
  return formatIsoDate(new Date());
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  date.setDate(date.getDate() + days);
  return formatIsoDate(date);
}

/** Manual-entry validation for the "Custom" date field: exactly
 * YYYY-MM-DD, and the pieces have to form a real calendar date — e.g.
 * "2026-02-30" is the right shape but not a real day, and `new Date`
 * would silently roll it over into March rather than reject it. */
function isValidIsoDate(value: string): boolean {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return false;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

/** Quick-pick chips for the common cases, plus a "Custom" chip that reveals
 * a plain typed YYYY-MM-DD field for everything else. A full calendar
 * widget (e.g. `@react-native-community/datetimepicker`) would need a new
 * native dependency and the prebuild/run:android cycle that entails — not
 * worth it for a field that, per the user's own use case, is very often
 * just "today" or "tomorrow" anyway. Revisit with a real native picker if
 * "Custom" turns out to be the common case in practice. */
const DATE_PRESETS: { label: string; getIso: (today: string) => string }[] = [
  { label: "Today", getIso: (today) => today },
  { label: "Tomorrow", getIso: (today) => addDays(today, 1) },
  { label: "Next week", getIso: (today) => addDays(today, 7) },
];

/** Phase 2 Step 4: optional end-of-range date, relative to whatever
 * `actionDate` is currently selected (not to today) — "+3 days" from a
 * to-do already set for "Next week" should land 3 days past THAT date, not
 * back near today. "None" (the default) means a plain single-day to-do,
 * the common case. */
const TO_DATE_PRESETS: { label: string; getIso: (fromIso: string) => string | null }[] = [
  { label: "None", getIso: () => null },
  { label: "+3 days", getIso: (fromIso) => addDays(fromIso, 3) },
  { label: "+1 week", getIso: (fromIso) => addDays(fromIso, 7) },
];

/** Phase 2 Step 4: same quick-pick-plus-custom pattern as the date presets
 * above, for the reminder's time-of-day. "5:00 AM" is
 * DEFAULT_NOTIFICATION_TIME itself, included as a preset so a user who
 * opened "Custom" by mistake (or wants to explicitly confirm the default)
 * has a one-tap way back to it. */
const TIME_PRESETS: { label: string; value: string }[] = [
  { label: "5:00 AM", value: DEFAULT_NOTIFICATION_TIME },
  { label: "9:00 AM", value: "09:00" },
  { label: "6:00 PM", value: "18:00" },
];

/** Manual-entry validation for the "Custom" time field: exactly HH:MM,
 * 24-hour, with real hour/minute ranges (00–23 / 00–59) — mirrors
 * isValidIsoDate's shape-plus-range approach above rather than trusting the
 * regex alone. */
function isValidTime(value: string): boolean {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match !== null;
}

/** "15:30" -> "3:30 PM" — this file's own display format for the time
 * picker's preview text; components/TodoItemRow.tsx has its own identical
 * formatter for the saved badge (kept separate rather than shared, same
 * "small enough to duplicate, not worth a cross-component util for" call as
 * this file's other small formatters). */
function formatTime12h(hhmm: string): string {
  const [hour, minute] = hhmm.split(":").map(Number);
  const period = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

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
export function AddTodoBottomSheet({ visible, onClose, onSave, editingTodo = null }: AddTodoBottomSheetProps) {
  const insets = useSafeAreaInsets();
  const sheetRef = useRef<BottomSheet>(null);
  const [text, setText] = useState("");
  const [recurrence, setRecurrence] = useState<Recurrence>("none");
  // `actionDate` always holds the resolved ISO date that will actually be
  // saved. `isCustomDate` just tracks which chip is visually selected —
  // "Custom" doesn't get its own iso value until the typed field is valid,
  // so `actionDate` stays whatever it last was (defaulting to today) until
  // then, rather than saving with an empty/invalid date.
  const [actionDate, setActionDate] = useState(todayIso());
  const [isCustomDate, setIsCustomDate] = useState(false);
  const [customDateText, setCustomDateText] = useState("");

  // Phase 2 Step 4: optional end-of-range date. `toDate` is null by default
  // (plain single-day to-do) — unlike `actionDate`, "no value selected" is
  // itself a valid, common, default state here, not just a transient one
  // before a chip is tapped.
  const [toDate, setToDate] = useState<string | null>(null);
  const [isCustomToDate, setIsCustomToDate] = useState(false);
  const [customToDateText, setCustomToDateText] = useState("");

  // Phase 2 Step 4: reminder time-of-day, same quick-pick-plus-custom shape
  // as the date fields above.
  const [notificationTime, setNotificationTime] = useState(DEFAULT_NOTIFICATION_TIME);
  const [isCustomTime, setIsCustomTime] = useState(false);
  const [customTimeText, setCustomTimeText] = useState("");

  useEffect(() => {
    if (visible) {
      if (editingTodo) {
        // Pre-fills every field from the existing to-do, not just text —
        // the whole point of this prop (see its own doc comment). Each
        // "isCustomX" flag is derived by checking whether the saved value
        // matches one of that field's own presets; if it doesn't, the
        // corresponding "Custom" chip is what should show as active, with
        // its typed field seeded from the real value (never a normal-
        // looking empty state a resumed edit shouldn't have).
        setText(editingTodo.text);
        setRecurrence(editingTodo.recurrence);

        const today = todayIso();
        setActionDate(editingTodo.actionDate);
        const matchesDatePreset = DATE_PRESETS.some((preset) => preset.getIso(today) === editingTodo.actionDate);
        setIsCustomDate(!matchesDatePreset);
        setCustomDateText(editingTodo.actionDate);

        setToDate(editingTodo.toDate);
        const matchesToDatePreset = TO_DATE_PRESETS.some(
          (preset) => preset.getIso(editingTodo.actionDate) === editingTodo.toDate
        );
        setIsCustomToDate(!matchesToDatePreset);
        setCustomToDateText(editingTodo.toDate ?? "");

        setNotificationTime(editingTodo.notificationTime);
        const matchesTimePreset = TIME_PRESETS.some((preset) => preset.value === editingTodo.notificationTime);
        setIsCustomTime(!matchesTimePreset);
        setCustomTimeText(editingTodo.notificationTime);
      }
      sheetRef.current?.snapToIndex(0);
    } else {
      sheetRef.current?.close();
    }
  }, [visible, editingTodo]);

  // Fires on every way the sheet actually closes — backdrop tap, swipe-down,
  // or this component's own `sheetRef.current?.close()` call after a save —
  // so form state always resets exactly once, from a single path, rather
  // than every closing gesture needing its own reset call.
  const handleSheetClosed = useCallback(() => {
    setText("");
    setRecurrence("none");
    setActionDate(todayIso());
    setIsCustomDate(false);
    setCustomDateText("");
    setToDate(null);
    setIsCustomToDate(false);
    setCustomToDateText("");
    setNotificationTime(DEFAULT_NOTIFICATION_TIME);
    setIsCustomTime(false);
    setCustomTimeText("");
    onClose();
  }, [onClose]);

  const handlePresetPress = useCallback((iso: string) => {
    setIsCustomDate(false);
    setActionDate(iso);
  }, []);

  const handleCustomPress = useCallback(() => {
    setIsCustomDate(true);
    // Seed the field with whatever's already selected so switching to
    // "Custom" from "Tomorrow" doesn't drop what the user already picked.
    setCustomDateText(actionDate);
  }, [actionDate]);

  const handleCustomDateChange = useCallback((value: string) => {
    setCustomDateText(value);
    if (isValidIsoDate(value)) {
      setActionDate(value);
    }
  }, []);

  const isCustomDateInvalid = isCustomDate && customDateText.length > 0 && !isValidIsoDate(customDateText);

  const handleToDatePresetPress = useCallback(
    (iso: string | null) => {
      setIsCustomToDate(false);
      setToDate(iso);
    },
    []
  );

  const handleCustomToDatePress = useCallback(() => {
    setIsCustomToDate(true);
    setCustomToDateText(toDate ?? "");
  }, [toDate]);

  const handleCustomToDateChange = useCallback((value: string) => {
    setCustomToDateText(value);
    if (isValidIsoDate(value)) {
      setToDate(value);
    }
  }, []);

  // Shape-valid AND not before the start date — a range ending before it
  // begins is nonsensical regardless of whether "2026-09-05" is itself a
  // real calendar date. Only checked while "Custom" is active and non-empty
  // (an empty field mid-typing isn't an error yet, same convention as the
  // action-date field's own `isCustomDateInvalid`).
  const isCustomToDateInvalid =
    isCustomToDate &&
    customToDateText.length > 0 &&
    (!isValidIsoDate(customToDateText) || customToDateText < actionDate);

  const handleTimePresetPress = useCallback((value: string) => {
    setIsCustomTime(false);
    setNotificationTime(value);
  }, []);

  const handleCustomTimePress = useCallback(() => {
    setIsCustomTime(true);
    setCustomTimeText(notificationTime);
  }, [notificationTime]);

  const handleCustomTimeChange = useCallback((value: string) => {
    setCustomTimeText(value);
    if (isValidTime(value)) {
      setNotificationTime(value);
    }
  }, []);

  const isCustomTimeInvalid = isCustomTime && customTimeText.length > 0 && !isValidTime(customTimeText);

  const canSave =
    text.trim().length > 0 && !isCustomDateInvalid && !isCustomToDateInvalid && !isCustomTimeInvalid;

  const handleSave = useCallback(() => {
    const trimmed = text.trim();
    if (!trimmed || isCustomDateInvalid || isCustomToDateInvalid || isCustomTimeInvalid) {
      return;
    }
    onSave(trimmed, actionDate, toDate, notificationTime, recurrence);
    sheetRef.current?.close();
  }, [
    text,
    actionDate,
    toDate,
    notificationTime,
    recurrence,
    isCustomDateInvalid,
    isCustomToDateInvalid,
    isCustomTimeInvalid,
    onSave,
  ]);

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
          <Text style={styles.title}>{editingTodo ? "Edit To-Do" : "New To-Do"}</Text>

          <BottomSheetTextInput
            value={text}
            onChangeText={setText}
            placeholder="What do you need to do?"
            placeholderTextColor="rgba(235,235,245,0.45)"
            style={styles.input}
            autoFocus
            returnKeyType="done"
          />

          <Text style={styles.sectionLabel}>Remind me on</Text>
          <View style={styles.recurrenceRow}>
            {DATE_PRESETS.map((preset) => {
              const iso = preset.getIso(todayIso());
              const isActive = !isCustomDate && actionDate === iso;
              return (
                <Pressable
                  key={preset.label}
                  onPress={() => handlePresetPress(iso)}
                  style={[styles.recurrenceOption, isActive && styles.recurrenceOptionActive]}
                >
                  <Text style={[styles.recurrenceText, isActive && styles.recurrenceTextActive]}>
                    {preset.label}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={handleCustomPress}
              style={[styles.recurrenceOption, isCustomDate && styles.recurrenceOptionActive]}
            >
              <Text style={[styles.recurrenceText, isCustomDate && styles.recurrenceTextActive]}>Custom</Text>
            </Pressable>
          </View>
          {isCustomDate && (
            <>
              <BottomSheetTextInput
                value={customDateText}
                onChangeText={handleCustomDateChange}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="rgba(235,235,245,0.45)"
                style={[styles.input, isCustomDateInvalid && styles.inputInvalid]}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
              {isCustomDateInvalid && <Text style={styles.errorText}>Enter a valid date as YYYY-MM-DD.</Text>}
            </>
          )}

          {/* Phase 2 Step 4: optional end-of-range date. "None" is the
              active chip whenever `toDate` is null, covering both "never
              touched this section" and "picked None explicitly" — there's
              no third state to distinguish. */}
          <Text style={styles.sectionLabel}>To Date (optional)</Text>
          <View style={styles.recurrenceRow}>
            {TO_DATE_PRESETS.map((preset) => {
              const iso = preset.getIso(actionDate);
              const isActive = !isCustomToDate && toDate === iso;
              return (
                <Pressable
                  key={preset.label}
                  onPress={() => handleToDatePresetPress(iso)}
                  style={[styles.recurrenceOption, isActive && styles.recurrenceOptionActive]}
                >
                  <Text style={[styles.recurrenceText, isActive && styles.recurrenceTextActive]}>
                    {preset.label}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={handleCustomToDatePress}
              style={[styles.recurrenceOption, isCustomToDate && styles.recurrenceOptionActive]}
            >
              <Text style={[styles.recurrenceText, isCustomToDate && styles.recurrenceTextActive]}>Custom</Text>
            </Pressable>
          </View>
          {isCustomToDate && (
            <>
              <BottomSheetTextInput
                value={customToDateText}
                onChangeText={handleCustomToDateChange}
                placeholder="YYYY-MM-DD"
                placeholderTextColor="rgba(235,235,245,0.45)"
                style={[styles.input, isCustomToDateInvalid && styles.inputInvalid]}
                keyboardType="numbers-and-punctuation"
                maxLength={10}
              />
              {isCustomToDateInvalid && (
                <Text style={styles.errorText}>Enter a valid date on or after the start date.</Text>
              )}
            </>
          )}

          {/* Phase 2 Step 4: reminder time-of-day. Only shown as a badge on
              the saved row (components/TodoItemRow.tsx) when it's NOT the
              5 AM default — see that file's own DEFAULT_NOTIFICATION_TIME
              check — so leaving this untouched is a deliberate, silent
              "use the default" rather than something that needs its own
              explicit confirmation here. */}
          <Text style={styles.sectionLabel}>Notification Time</Text>
          <View style={styles.recurrenceRow}>
            {TIME_PRESETS.map((preset) => {
              const isActive = !isCustomTime && notificationTime === preset.value;
              return (
                <Pressable
                  key={preset.label}
                  onPress={() => handleTimePresetPress(preset.value)}
                  style={[styles.recurrenceOption, isActive && styles.recurrenceOptionActive]}
                >
                  <Text style={[styles.recurrenceText, isActive && styles.recurrenceTextActive]}>
                    {preset.label}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={handleCustomTimePress}
              style={[styles.recurrenceOption, isCustomTime && styles.recurrenceOptionActive]}
            >
              <Text style={[styles.recurrenceText, isCustomTime && styles.recurrenceTextActive]}>Custom</Text>
            </Pressable>
          </View>
          {isCustomTime && (
            <>
              <BottomSheetTextInput
                value={customTimeText}
                onChangeText={handleCustomTimeChange}
                placeholder="HH:MM (24-hour)"
                placeholderTextColor="rgba(235,235,245,0.45)"
                style={[styles.input, isCustomTimeInvalid && styles.inputInvalid]}
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
              {isCustomTimeInvalid ? (
                <Text style={styles.errorText}>Enter a valid 24-hour time as HH:MM.</Text>
              ) : (
                customTimeText.length > 0 && (
                  <Text style={styles.timePreviewText}>{formatTime12h(notificationTime)}</Text>
                )
              )}
            </>
          )}

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
              <Text style={styles.saveButtonText}>{editingTodo ? "Save Changes" : "Save Task"}</Text>
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
  inputInvalid: {
    borderColor: colors.danger,
  },
  errorText: {
    color: colors.danger,
    fontSize: 12,
    marginTop: -spacing.sm,
  },
  timePreviewText: {
    color: colors.textMuted,
    fontSize: 12,
    marginTop: -spacing.sm,
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
