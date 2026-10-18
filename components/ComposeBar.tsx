import { memo, useEffect, useRef, useState } from "react";
import { Keyboard, type LayoutChangeEvent, PixelRatio, Platform, Pressable, StyleSheet, View } from "react-native";
import { BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { Feather } from "@expo/vector-icons";

import { spacing } from "../constants/theme";
import { MIN_TOUCH_TARGET, xayraColors, xayraType } from "../constants/xayraTheme";
import { composeClearance } from "../utils/composeClearance";

/** Live-requested cap: past this many lines, earlier lines scroll up out of
 * view instead of the box growing further, so the line currently being
 * typed always stays visible. Kept in exact agreement with `input`'s own
 * `lineHeight` below — see `numberOfLines` on the TextInput itself for the
 * other half of this. */
const MAX_INPUT_LINES = 5;
/** Xayra 2.0 compose type: DM Sans 16/22 (fixed size — never shrunk). */
const INPUT_LINE_HEIGHT = 22;
/** The input's own vertical padding, set explicitly so its one-line height
 * is predictable (Android's default EditText padding was ~21dp and varied
 * with font scale). Keeps the one-line field no taller than before at any
 * text size, so keyboard clearance is never reduced by the restyle. */
const INPUT_PADDING_VERTICAL = 5;
const INPUT_MAX_HEIGHT = INPUT_LINE_HEIGHT * MAX_INPUT_LINES + 2 * INPUT_PADDING_VERTICAL;
const SEARCH_BAR_MIN_HEIGHT = 48;
const SEND_BUTTON_SIZE = 40;
/** Kept between the field's bottom edge and the keyboard's top edge. */
const KEYBOARD_MARGIN = 8;
/** The 20% -> 50% focus snap can still be settling when the keyboard reports
 * itself shown, so the field is measured again once it has. */
const SETTLE_REMEASURE_MS = 300;

type InputCap = { lines: number; maxHeight: number };
const DEFAULT_CAP: InputCap = { lines: MAX_INPUT_LINES, maxHeight: INPUT_MAX_HEIGHT };

export type ComposeBarProps = {
  inputText: string;
  onInputChange: (text: string) => void;
  onInputFocus: () => void;
  /** Fires when the input loses focus (tapping away, not submitting —
   * `blurOnSubmit={false}` below means a submit never triggers this on its
   * own). Used by app/index.tsx to re-reveal the history list that gets
   * hidden while composing — see its own `isComposing` doc comment. */
  onInputBlur: () => void;
  onSubmit: (text: string) => void;
  /** Build 22 DYNAMIC SEARCH PLACEHOLDER: driven by app/index.tsx's explicit
   * Record/Ask pill state — "Type your thoughts..." while Record is active,
   * "Search your thoughts..." while Ask is active. This component has no
   * opinion of its own on which mode is active; it just renders whatever
   * string it's given. */
  placeholder: string;
  /** Picks the leading icon: a pencil for Record (writing a note), a
   * magnifier for Ask (searching your notes). Presentation only. */
  mode: "record" | "ask";
};

/**
 * The app's ONE text-entry surface (see Requirement 3 — "unify input bar").
 *
 * Build 21 — UNIFY DRAWER HEADER: this now lives INSIDE `<BottomSheet>`,
 * rendered by HistorySheet as a sticky header row above the segment
 * pill/history content (see that file), not as a floating sibling
 * positioned with manual bottom/transform math against the sheet's height —
 * that Build 20 approach and Build 19's `useAnimatedKeyboard()` follow logic
 * before it are both gone. The bug that motivated them (see below) is fixed
 * at its actual root now instead of being chased with more positioning math.
 *
 * Root cause of the Build 20 "search bar shoots to the top of the screen on
 * focus" bug: THREE separate mechanisms were all compensating for the same
 * keyboard at once — Android's `windowSoftInputMode="resize"` (already
 * shrinks the whole window), `@gorhom/bottom-sheet`'s own
 * `keyboardBehavior="interactive"` (already translates the sheet), and this
 * component's own `useAnimatedKeyboard()`-driven `translateY` on top of
 * both. Stacking three keyboard offsets on one element is what sent it flying
 * off-screen. The fix is to let ONE thing own keyboard avoidance: the sheet
 * itself. Because this component is now a normal child inside `<BottomSheet>`
 * — not positioned independently at all — it moves as part of the sheet's
 * own single, unified upward translation, with no separate compensation of
 * its own left to conflict with it.
 *
 * That does mean solving the ORIGINAL keyboard-focus-drop bug (Build
 * 18 — typing more than one character silently blurred the input) a
 * different way than "keep this component fully outside the sheet," since
 * that's no longer true. The original diagnosis was specific to
 * `handleComponent`: it's a render *function* the bottom-sheet library
 * invokes directly, and passing it a reference that changes identity across
 * renders (an inline arrow recreated by a parent re-render, e.g. on every
 * keystroke) makes the library treat it as a different component and
 * remount the whole subtree underneath it. This component is deliberately
 * NOT passed through `handleComponent` — HistorySheet renders it as an
 * ordinary `ReactNode` prop (`composeBarSlot`), the exact same mechanism
 * `notesContent`/`qaContent` already use safely in that file. A JSX element
 * passed as a normal prop/child is diffed by React's ordinary
 * reconciliation (same element type in the same tree position keeps its
 * instance, full stop) — it never goes through whatever special handling
 * `handleComponent` gets internally, so recreating the `<ComposeBar />`
 * element on every keystroke (which app/index.tsx still does, same as it
 * always has) is exactly as safe here as `notesContent` already was.
 *
 * The other half of the real fix: `TextInput` from "react-native" is
 * swapped for `@gorhom/bottom-sheet`'s own `BottomSheetTextInput`, a
 * near-drop-in wrapper that reports focus/blur into the sheet's internal
 * keyboard-tracking state. Without it, the sheet has no reliable way to know
 * an input *inside* it is focused, which undermines `keyboardBehavior`
 * needing to compensate at all correctly. Wrapped in `memo` so a value-only
 * prop change elsewhere in app/index.tsx (unrelated state) can't re-render
 * this either.
 *
 * Build 22 moved the settings gear out of this row into a floating
 * Handsfree/Record-Ask/Settings stack in app/index.tsx; Build 23 moved it
 * back here, restoring `[ 🔍 Search or type... | ↑ ] [ ⚙️ ]` as the row's
 * layout. It's gone again as of the "Quiet Corner" pass — a tester
 * consistently mis-tapped Settings while reaching for the submit arrow
 * right next to it, two similarly-sized circles touching in one row. Settings
 * now lives in the icon-plus-popover next to the To-Dos pill (app/index.tsx),
 * physically apart from anything the user is actively tapping mid-compose —
 * this row is just `[ 🔍 Search or type... | ↑ ]` again.
 */
export const ComposeBar = memo(function ComposeBar({
  inputText,
  onInputChange,
  onInputFocus,
  onInputBlur,
  onSubmit,
  placeholder,
  mode,
}: ComposeBarProps) {
  const canSubmit = inputText.trim().length > 0;
  // Focus ring only — presentation; focus handling itself is the parent's.
  const [isFocused, setIsFocused] = useState(false);
  const handleFocus = () => {
    setIsFocused(true);
    onInputFocus();
  };
  const handleBlur = () => {
    setIsFocused(false);
    onInputBlur();
  };

  // Build 22 FIX DUPLICATE SUBMISSIONS: guards the window between a submit
  // firing and the parent's cleared `inputText` prop actually landing back
  // here. Without it, a fast double-tap on the submit button (or a quirky
  // double-fire of the keyboard's "send" action) could call `onSubmit` twice
  // with the exact same text before React ever re-renders this component
  // with the parent's `inputText=""` update, re-processing an identical
  // query/note. Re-armed the moment the prop confirms the clear — not a
  // content-based "block this exact string" guard, which would wrongly stop
  // a legitimately repeated question asked again later.
  const hasPendingSubmitRef = useRef(false);
  useEffect(() => {
    if (inputText === "") {
      hasPendingSubmitRef.current = false;
    }
  }, [inputText]);

  const handleSubmit = () => {
    if (hasPendingSubmitRef.current || !canSubmit) {
      return;
    }
    hasPendingSubmitRef.current = true;
    // Ask: the keyboard closes so the answer has room. Record: it stays up
    // with the input focused (`blurOnSubmit={false}`), so the next note can
    // be typed straight away — closing it after every note broke consecutive
    // entry, and the layout jump it caused (the Record/Ask pill moving
    // ~600px down) made a tap aimed at Ask right after a note land elsewhere.
    if (mode === "ask") {
      Keyboard.dismiss();
    }
    onSubmit(inputText.trim());
  };

  // While the keyboard is open, the field may only grow as far as the space
  // actually left above it (see utils/composeClearance.ts for why the tray
  // itself doesn't move). The cap is recomputed only on keyboard show/hide —
  // never from layout or typing — so growing the field can't feed back into
  // it. The input's one-line height (text plus Android's own padding, which
  // varies with font scale) is the smallest height it has laid out at; it's
  // kept in a ref, so recording it never re-renders.
  const searchBarRef = useRef<View>(null);
  const oneLineRef = useRef<{ fontScale: number; height: number } | null>(null);
  const [cap, setCap] = useState<InputCap>(DEFAULT_CAP);
  const handleInputLayout = (e: LayoutChangeEvent) => {
    const fontScale = PixelRatio.getFontScale();
    const { height } = e.nativeEvent.layout;
    const known = oneLineRef.current;
    if (!known || known.fontScale !== fontScale || height < known.height) {
      oneLineRef.current = { fontScale, height };
    }
  };
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let keyboardTop: number | null = null;
    const measure = () => {
      const node = searchBarRef.current;
      if (!node || keyboardTop === null) return;
      const top = keyboardTop;
      node.measureInWindow((_x, y) => {
        if (keyboardTop !== top) return; // keyboard moved or closed since
        const fontScale = PixelRatio.getFontScale();
        const lineHeight = INPUT_LINE_HEIGHT * fontScale;
        const known = oneLineRef.current;
        const { lines, maxHeight } = composeClearance({
          keyboardTop: top,
          containerTop: y,
          containerPadding: spacing.xs,
          containerMinHeight: SEARCH_BAR_MIN_HEIGHT,
          margin: KEYBOARD_MARGIN,
          lineHeight,
          oneLineHeight: known && known.fontScale === fontScale ? known.height : lineHeight,
          maxLines: MAX_INPUT_LINES,
          maxHeight: INPUT_MAX_HEIGHT,
        });
        // Same values -> keep the same object, so React skips the re-render.
        setCap((prev) => (prev.lines === lines && prev.maxHeight === maxHeight ? prev : { lines, maxHeight }));
      });
    };
    const clearTimer = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = null;
    };
    const showSub = Keyboard.addListener(showEvent, (e) => {
      keyboardTop = e.endCoordinates.screenY;
      clearTimer();
      measure();
      settleTimer = setTimeout(measure, SETTLE_REMEASURE_MS);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      keyboardTop = null;
      clearTimer();
      setCap(DEFAULT_CAP);
    });
    return () => {
      clearTimer();
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <View ref={searchBarRef} testID="compose-field" style={[styles.searchBar, isFocused && styles.searchBarFocused]}>
          <Feather
            testID="compose-mode-icon"
            name={mode === "record" ? "edit-3" : "search"}
            size={20}
            color={xayraColors.textMuted}
            style={styles.searchIcon}
          />
          <BottomSheetTextInput
            value={inputText}
            onChangeText={onInputChange}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder={placeholder}
            placeholderTextColor={xayraColors.textMuted}
            cursorColor={xayraColors.lilac}
            selectionColor={xayraColors.lilacSoft}
            style={[styles.input, cap !== DEFAULT_CAP && { maxHeight: cap.maxHeight }]}
            onLayout={handleInputLayout}
            multiline
            // Android-specific: for a multiline TextInput, this is what
            // actually caps the box to N lines' worth of height and makes it
            // internally scroll beyond that (auto-scrolling to keep the
            // caret/newest line visible) — a plain style `maxHeight` alone
            // didn't reliably cap growth on-device. `MAX_INPUT_LINES` and
            // `input`'s explicit `lineHeight` below are kept in exact
            // agreement so the two mechanisms describe the same 5 lines.
            //
            // While the keyboard is open both are lowered together (`cap`),
            // so on a short screen the box starts scrolling earlier instead
            // of reaching under the keyboard.
            numberOfLines={cap.lines}
            textAlignVertical="top"
            blurOnSubmit={false}
          />
          {/* Submitting is the dedicated arrow button below ONLY — not the
              keyboard's return key. `returnKeyType="send"` (removed) hid the
              keyboard's own newline "enter" glyph and hijacked Enter to
              submit instead of inserting a line break, which is exactly the
              live-reported bug ("no enter button, can't write multiple
              lines"). Same pattern chat composers (WhatsApp, Telegram, etc.)
              use: Enter always inserts a newline, the arrow is the only way
              to send. The keyboard is still dismissed by handleSubmit itself
              (Keyboard.dismiss()) on that explicit tap. */}
          <Pressable
            onPress={handleSubmit}
            disabled={!canSubmit}
            hitSlop={(MIN_TOUCH_TARGET - SEND_BUTTON_SIZE) / 2}
            testID="compose-submit"
            accessibilityRole="button"
            accessibilityLabel={mode === "ask" ? "Ask" : "Save note"}
            accessibilityState={{ disabled: !canSubmit }}
            style={({ pressed }) => [
              styles.submitButton,
              canSubmit ? styles.submitButtonReady : styles.submitButtonDisabled,
              pressed && styles.submitButtonPressed,
            ]}
          >
            <Feather name="arrow-up" size={20} color={canSubmit ? "#000000" : xayraColors.teal} />
          </Pressable>
        </View>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  // No more position:absolute/zIndex/elevation — this is now an ordinary
  // flex child inside HistorySheet's sticky header, in normal document flow
  // above the segment pills/history content, so there's nothing left for it
  // to visually collide with (see HISTORYSHEET's own PREVENT OVERLAP note).
  container: {
    paddingHorizontal: spacing.base,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  searchBar: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: xayraColors.field,
    borderRadius: SEARCH_BAR_MIN_HEIGHT / 2,
    borderWidth: 1,
    borderColor: xayraColors.lineStrong,
    paddingLeft: spacing.base,
    paddingRight: spacing.xs,
    // `minHeight` (was a fixed `height: 40`) plus vertical padding, not a
    // fixed height — `multiline` above means this box needs to actually grow
    // as the user types more lines, the same way any chat composer's input
    // does, instead of clipping everything past the first line.
    minHeight: SEARCH_BAR_MIN_HEIGHT,
    paddingVertical: spacing.xs,
  },
  searchBarFocused: {
    borderColor: "rgba(143,214,207,0.55)",
  },
  searchIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    ...xayraType.input,
    color: xayraColors.text,
    paddingVertical: INPUT_PADDING_VERTICAL,
    paddingHorizontal: 0,
    // Explicit, not left to the platform default — `numberOfLines` on the
    // TextInput itself (the prop that actually enforces the line cap on
    // Android) needs to agree with this exactly, or the two disagree about
    // where the last line ends.
    lineHeight: INPUT_LINE_HEIGHT,
    // Lowered inline while the keyboard leaves less room (`cap`).
    maxHeight: INPUT_MAX_HEIGHT,
  },
  submitButton: {
    width: SEND_BUTTON_SIZE,
    height: SEND_BUTTON_SIZE,
    borderRadius: SEND_BUTTON_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.sm,
  },
  submitButtonReady: {
    backgroundColor: xayraColors.teal,
  },
  submitButtonDisabled: {
    backgroundColor: xayraColors.tealSoft,
  },
  submitButtonPressed: {
    opacity: 0.75,
  },
});
