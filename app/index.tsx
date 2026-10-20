import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent } from "react-native";
import { Alert, AppState, Dimensions, Image, Keyboard, PixelRatio, Pressable, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { getRecordingPermissionsAsync } from "expo-audio";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import BottomSheet, { useBottomSheetSpringConfigs } from "@gorhom/bottom-sheet";
import { Feather } from "@expo/vector-icons";
import Animated, {
  FadeIn,
  FadeOut,
  interpolate,
  useAnimatedStyle,
  useDerivedValue,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import {
  CentralRecorderCanvas,
  WAVEFORM_ROW_HEIGHT,
  type RecorderCanvasState,
} from "../components/CentralRecorderCanvas";
import { ChatSheetContent } from "../components/ChatSheetContent";
import { CancelProcessingButton } from "../components/CancelProcessingButton";
import { RecordingActions } from "../components/RecordingActions";
import { ComposeBar } from "../components/ComposeBar";
import { ExpandedTextOverlay } from "../components/ExpandedTextOverlay";
import { HandsfreeTypingStatus } from "../components/HandsfreeTypingStatus";
import { HistorySheet, SHEET_HANDLE_HEIGHT, SHEET_SNAP_POINTS } from "../components/HistorySheet";
import { HomeDock, type HandsfreeDisplayState } from "../components/HomeDock";
import { settleExpandProgress } from "../components/SwipeableTrayHandle";
import { useHardwareBack } from "../hooks/useHardwareBack";
import { decideHomeBack, type HomeBackState } from "../utils/backNavigation";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { showToast } from "../components/Toast";
import { TodosOverlay } from "../components/TodosOverlay";
import { SegmentedControl } from "../components/ui/SegmentedControl";
import { XText } from "../components/ui/XText";
import { HOME_SUBTITLE } from "../constants/copy";
import { MIN_TOUCH_TARGET, xayraColors, xayraRadius, xayraType } from "../constants/xayraTheme";
import { useLaunchShortcut } from "../hooks/useLaunchShortcut";
import { useToDos } from "../hooks/useToDos";
import { asrRouter } from "../services/ai/asrRouter";
import { cancelActiveLlamaCompletion } from "../services/ai/localLlama";
import { devTiming } from "../services/ai/perf";
import { discardVoiceAskReservation, reserveVoiceAsk, type VoiceAskReservation } from "../services/ai/voiceAsk";
import { ProcessingJob } from "../services/ai/processingJob";
import { prewarmEngines } from "../services/ai/enginePrewarmer";
import {
  setPipelineStage,
  subscribeToPipelineStage,
  type PipelineStage,
} from "../services/ai/pipelineStage";
import { useChatSession } from "../services/ai/useChatSession";
import {
  containsWakeWord,
  useActiveMode,
  WAKE_PHRASE_DISPLAY,
  type ActiveModeUtteranceHandler,
} from "../services/audio/activeMode";
import {
  initializeToDoNotifications,
  subscribeToToDoNotificationTap,
} from "../services/notifications/todoNotifications";
import {
  cancelProcessing,
  centralStatusText,
  decideCentralTap,
  idleTapCue,
  recordCompletionSpeech,
  ManualUtteranceController,
  recordingActionsFor,
  type ManualUtteranceSnapshot,
  type UtteranceMode,
} from "../services/audio/manualUtterance";
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakTextAndWait, stopSpeech } from "../services/audio/tts";
import { interruptHandsfreeWork, mayHandsfreeSpeak } from "../services/audio/handsfreeInterrupt";
import { playWakeChime } from "../services/audio/wakeChime";
import { cleanupOrphanRecordings } from "../services/audio/recordingCleanup";
import { isAudioTooShort } from "../services/audio/wav";
import {
  countNotes,
  createTextNote,
  createVoiceNote,
  deleteNote,
  EmptyRecordingError,
  isSilentTranscript,
  listNoteAudioUris,
  listNotes,
  retryPendingEmbeddings,
  retryPendingExtractions,
  SilentRecordingError,
  type Note,
} from "../services/notes/noteManager";
import { isMicInUse } from "../services/audio/audioInputState";
import { busyMessage } from "../services/audio/micSession";
import { CANCEL_STOP_FAILED_MESSAGE, clearCancelStopError } from "../utils/micErrors";
import { useMicSnapshot } from "../hooks/useMicSnapshot";
import {
  canAdoptShortcutMode,
  decideShortcutLaunch,
  peekPendingShortcut,
  type PendingShortcut,
} from "../services/shortcuts/launchShortcut";
import { wordCount } from "../services/logging/redact";
import { getGreetingFirstName } from "../services/sync/driveSync";
import { getTimeBasedGreeting } from "../utils/greeting";
import { emblemFit, FULL_EMBLEM_TIER, sameEmblemTier, type EmblemTier } from "../utils/emblemLayout";
import { dockYieldsAtHalf as dockYieldsAtHalfFor } from "../utils/readingViewport";
import { userFacingMessage } from "../services/errors/userMessage";

/** Screen goes idle-with-mic-open for this long with zero detected speech
 * before Handsfree auto-disengages — a safety/battery guard, not a UX
 * nicety: an accidental activation left running in a pocket would otherwise
 * keep the mic (and the screen, via ActiveModeManager's own keep-awake) on
 * indefinitely. */
const HANDSFREE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** Vertical gap between the central button and the status lines under it. */
const CENTER_AREA_GAP_PX = 10;
/** The "Tap to finish" hint sits this much closer to the status line. */
const STATUS_HINT_OFFSET = -4;
/** How long the compose field stays non-editable after To-Dos closes by
 * hardware Back, unless touched first (see `isComposeGuarded`). */
const COMPOSE_UNCOVER_DELAY_MS = 400;

/** Emblem zone limits (canvas row P): full size at the tray's rest stage,
 * the compact answer-ready size at 50%, and a floor below which it stops
 * shrinking. The actual size comes from the measured space (see zone0/zone1). */
const EMBLEM_ZONE_MAX_REST = 248;
const EMBLEM_ZONE_MAX_HALF = 168;
const EMBLEM_ZONE_MIN = 64;
/** Extra room, as a multiple of the zone, kept for the orbit rings that
 * reach beyond it — full orbit, and the reduced one (no dotted ring or teal
 * arc) used first when space is short. */
const ORBIT_ROOM = 1.22;
const ORBIT_ROOM_REDUCED = 1.12;
/** Responsive priority (approved): below these zone sizes, first the orbit
 * is reduced, then the optional "Tap to …" cue goes, then the emblem
 * shrinks to EMBLEM_ZONE_MIN; only if even that can't fit is it hidden. */
const ORBIT_REDUCE_BELOW = 132;
const CUE_DROP_BELOW = 96;
/** Width of the outer orbit arcs relative to the zone (r 176 of 390 in a
 * box 1.5x the zone), and the side gutter they stay inside. */
const ORBIT_SPAN = 1.36;
const ORBIT_SIDE_GUTTER = 16;
/** Gap between the Record/Ask switch and the tray's top edge. */
const MODE_SWITCH_BOTTOM_GAP = 12;
/** Until the switch has been measured (first frame only). */
const MODE_SWITCH_FALLBACK_HEIGHT = 50;

/** Soft red on black for the inline error line (6.9:1). */
const ERROR_TEXT = "#F2A5A5";

const MODE_SEGMENTS = [
  { key: "record", label: "Record" },
  { key: "ask", label: "Ask" },
] as const;

/** Breathing room after the tray list's last item (the body already ends at
 * the dock's top edge), and after the full-screen list's (plus the inset). */
const TRAY_LIST_END_PADDING = 16;
const OVERLAY_LIST_END_PADDING = 24;


const QUICK_MENU_GUTTER = 12;
/** The More menu opens toward the free side of its button and stays inside
 * the screen's side gutter. */
function quickMenuPosition(anchor: { x: number; y: number; width: number; height: number }) {
  const { width, height } = Dimensions.get("window");
  const right = Math.max(QUICK_MENU_GUTTER, width - (anchor.x + anchor.width));
  return anchor.y > height / 2
    ? { right, bottom: height - anchor.y + 8 }
    : { right, top: anchor.y + anchor.height + 6 };
}

/** How long the launch greeting ("Good morning, ...") stays up before
 * cross-fading into the header's normal persistent subtitle. */
const GREETING_VISIBLE_MS = 3500;

/** Design-sandbox pass: the quick-menu popover's pop-out entrance —
 * approved spring config (mass 0.6, stiffness 140, damping 18) driving BOTH
 * opacity and scale together. A plain `FadeIn.springify()` can't do this:
 * its `withInitialValues` override is typed to opacity only, since `FadeIn`
 * is an opacity-only preset — combining a scale requires a custom worklet
 * entrance function instead (Reanimated's own documented escape hatch for
 * "animate more than one property together"), not a chained builder. */
const QUICK_MENU_POP_SPRING = { damping: 18, stiffness: 140, mass: 0.6 };
function quickMenuPopIn() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ scale: 0.95 }] },
    animations: {
      opacity: withSpring(1, QUICK_MENU_POP_SPRING),
      transform: [{ scale: withSpring(1, QUICK_MENU_POP_SPRING) }],
    },
  };
}

/** To-Dos pill tap opening `TodosOverlay`.
 *
 * Deliberately NOT `sheetAnimationConfigs`'s tuple (damping 24/stiffness
 * 260/mass 0.9) despite that one being labeled "the sheet's own bounce"
 * elsewhere in this app (`ExpandedTextOverlay`'s entrance,
 * `SwipeableTrayHandle`'s settle) — live testing here found it doesn't
 * actually read as bouncy at all, and the damping-ratio math explains why:
 * ζ = damping / (2·√(stiffness·mass)) ≈ 0.78 for that tuple, and
 * `QUICK_MENU_POP_SPRING` above works out to ζ ≈ 0.98 — both close enough to
 * critically damped (ζ = 1) that neither one visibly overshoots its target;
 * they're tuned for a smooth, quick, CONTROLLED settle (right for a sheet
 * mid-drag, or a small popover), not a perceptible bounce. This tuple
 * targets ζ ≈ 0.52 instead — genuinely underdamped, so it actually
 * overshoots and settles back, which is what "soft bounce" actually needs.
 * Paired with a real 80px `translateY` range, not a subtle scale change —
 * a separate, earlier lesson (ExpandedTextOverlay's own first entrance
 * attempt used an 8% scale change and the overshoot was imperceptible even
 * with a truly bouncy spring; the visual AMPLITUDE has to be large enough
 * to show it, independent of getting the physics right). Also used by
 * AddTodoBottomSheet.tsx's own `animationConfigs` (the "+" button's sheet)
 * for the same requested feel — kept as a separate local copy there rather
 * than a shared import, matching this file's own established per-file
 * spring-constant convention (see `QUICK_MENU_POP_SPRING`,
 * `sheetAnimationConfigs`). */
const TODOS_OVERLAY_SPRING = { damping: 14, stiffness: 180, mass: 1 };
function todosOverlayPopIn() {
  "worklet";
  return {
    initialValues: { opacity: 0, transform: [{ translateY: 80 }] },
    animations: {
      opacity: withSpring(1, TODOS_OVERLAY_SPRING),
      transform: [{ translateY: withSpring(0, TODOS_OVERLAY_SPRING) }],
    },
  };
}

// Percentage snap points (SHEET_SNAP_POINTS = ['20%', '50%'] — see
// HistorySheet.tsx's own doc comment for why the monochromatic glass box's
// 88% "expanded" stage is deliberately NOT a third entry here) are the
// bottom sheet's own geometry, expressed as strings for @gorhom/bottom-sheet.
// The center canvas's own bottom clearance (BUTTON CLEARANCE — Build 20) and
// the floating pill cluster above the drawer (Build 23) both need the same
// values as plain pixel numbers to interpolate against the sheet's live
// animated index, so they're derived here once, from SHEET_SNAP_POINTS
// itself, rather than each hardcoding the split independently. Both stay
// pinned at their 50%-height values throughout the 88% expanded stage (that
// stage isn't a real sheet index — see `expandProgress` below — so
// `sheetAnimatedIndex` simply never reports anything past 1), which is fine:
// what actually hides the record button behind the sheet at 88% is the
// sheet's own real rendered height sitting on top of it in z-order, not
// this padding value.
const SCREEN_HEIGHT = Dimensions.get("window").height;
/** The legacy 20%/50% heights — kept ONLY to derive EXPAND_DRAG_DISTANCE
 * below, so the full-screen drag keeps exactly the travel it had (274dp on
 * a 914dp screen). The tray's real rest height is measured (Option B). */
const SHEET_HEIGHTS_PX = SHEET_SNAP_POINTS.map(
  (point) => (parseFloat(point) / 100) * SCREEN_HEIGHT
) as [number, number];
/** Option B rest stage = handle + compose field + this gap + dock. */
const REST_FIELD_DOCK_GAP = 12;
/** The sheet body's own top margin between the compose field and the list
 * (HistorySheet) — part of the measured reading-viewport calculation. */
const SHEET_BODY_MARGIN_TOP = 16;
/** First-frame estimates until the field and dock have been measured. */
const COMPOSE_HEADER_FALLBACK = 48;
const DOCK_ROW_FALLBACK = 74;
/** Pixels of drag the tray's own "expand" handle and the full-screen
 * overlay's own "collapse" handle both map their full 0..1 progress across
 * — deliberately the SAME distance the real sheet travels between its two
 * configured snap points (its own native drag), not an arbitrary or
 * screen-height-derived number, so the 50%↔100% gesture takes the same
 * amount of finger travel to feel "settled" as the sheet's own 20%↔50% one
 * does. See SwipeableTrayHandle.tsx's own doc comment for the full gesture
 * design this feeds. */
const EXPAND_DRAG_DISTANCE = SHEET_HEIGHTS_PX[1] - SHEET_HEIGHTS_PX[0];
/** Breathing room between the emblem area and the Record/Ask switch above
 * the tray — Build 20 BUTTON CLEARANCE, now measured from the switch. */
const CENTER_AREA_BREATHING_ROOM_PX = 12;

/**
 * Build 22 — REVERT TO EXPLICIT MODE SWITCHING: the automatic RECORD/ASK
 * classification introduced in Build 18 (a regex + Llama micro-prompt
 * router, `services/ai/intentRouter.ts`) is gone — deleted, not just
 * unused, along with its Llama-side `classifyIntentWithLlama` half in
 * localLlama.ts. Routing is now 100% deterministic, driven entirely by the
 * explicit `[ Record | Ask ]` pill in the floating control stack (see
 * `inputMode` state below): every submission, typed or spoken, does exactly
 * what the active pill says and nothing else — no classification step, no
 * model call, no ambiguity to get wrong. This was a deliberate reversal of
 * Build 18's premise, not a bug fix to it; both are legitimate product
 * directions; automatic classification occasionally guessed wrong on
 * ambiguous input (e.g. "do laundry" vs "did I do laundry"), and this trades
 * that occasional-miss convenience for the predictability of the user always
 * knowing exactly what a submission will do before they make it.
 *
 * There is exactly one text-entry surface (ComposeBar, rendered inside the
 * bottom sheet as its sticky header — see that component's own doc comment)
 * and exactly one recording pipeline, shared by manual taps and Handsfree
 * Mode.
 */
/** Orphan-recording cleanup runs once per app process (see the focus effect). */
let didCleanupRecordingsThisLaunch = false;

export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const recorder = useVoiceRecorder();
  const chatSession = useChatSession();
  // Only the count is used on this screen (the pill's badge) — TodosOverlay
  // owns its own useToDos() instance for the full list, refetched
  // independently whenever it's mounted.
  const { pendingCount } = useToDos();
  // The To-Dos screen is a full-screen overlay rendered as a sibling of this
  // screen's own content (see components/TodosOverlay.tsx's doc comment for
  // why it's deliberately NOT a pushed expo-router route) rather than
  // navigation state — conditionally mounted the same way `ExpandedTextOverlay`
  // used to be, before it became a permanently-mounted, continuously-dragged
  // surface (see `expandProgress` below).
  const [isTodosVisible, setIsTodosVisible] = useState(false);
  // "Quiet Corner" pass: Archive/Settings' shared entry point — a small
  // popover anchored to the "•••" icon that opens it (quickMenuAnchor
  // below), rendered as a conditionally-mounted sibling View (see its own
  // render-site doc comment for why this can never be a real native
  // `<Modal>` — TodosOverlay below hit the exact same bug class). An
  // earlier version was a plain slide-up action sheet instead, to avoid
  // needing to track the icon's own on-screen position at all — replaced
  // after feedback that a full-width sheet read as an unrelated system
  // tray rather than a menu belonging to that specific icon.
  const [isQuickMenuOpen, setIsQuickMenuOpen] = useState(false);
  // For the "Archived notes (N)" quick-menu label below — a count only,
  // via countNotes() (noteManager.ts), not a full listNotes() load this
  // screen has no other use for.
  const [notesCount, setNotesCount] = useState(0);
  // Measured at the moment the "•••" icon is actually tapped (not derived
  // from any static layout value) — the icon lives inside an
  // Animated.View whose position is driven by Reanimated on the UI thread
  // (drawerFloatingStackAnimatedStyle), so `measureInWindow` on the real
  // native node is what lets the popover below anchor to wherever the icon
  // ACTUALLY is on screen right now, without this file needing to
  // duplicate that animation's math itself.
  const quickMenuButtonRef = useRef<View>(null);
  const [quickMenuAnchor, setQuickMenuAnchor] = useState<{
    x: number;
    y: number;
    width: number;
    height: number;
  } | null>(null);
  const handleOpenQuickMenu = useCallback(() => {
    quickMenuButtonRef.current?.measureInWindow((x, y, width, height) => {
      setQuickMenuAnchor({ x, y, width, height });
      setIsQuickMenuOpen(true);
    });
  }, []);

  // Cold-start layout guard (Requirement 3): the header/compose bar/sheet
  // all depend on `insets` for correct placement — rendering them before
  // insets are actually measured is what causes a visible jump/shift a
  // frame or two after first paint. Nothing meaningful is lost by waiting
  // one tick: the canvas (pure black, no inset-dependent layout) is already
  // on screen immediately.
  const [isReady, setIsReady] = useState(false);
  useEffect(() => {
    setIsReady(true);
  }, []);

  useEffect(() => {
    prewarmEngines();
  }, []);

  // Launch greeting — computed once per mount (a fresh app open), shown in
  // place of the header's normal subtitle for a few seconds, then
  // cross-fades into it. Deliberately transient, not a permanent banner —
  // see "Quiet Corner" (quiet-corner-ui-overhaul memory): this home screen
  // was carefully decluttered, and a greeting that never goes away would
  // work against that. `getGreetingFirstName()` reads whatever Google
  // account is already signed in for Drive backup (no new sign-in flow) and
  // returns null before a first sign-in, in which case the greeting simply
  // omits the name rather than showing a placeholder.
  const [greetingText] = useState(() => getTimeBasedGreeting(getGreetingFirstName()));
  const [showGreeting, setShowGreeting] = useState(true);
  useEffect(() => {
    const timer = setTimeout(() => setShowGreeting(false), GREETING_VISIBLE_MS);
    return () => clearTimeout(timer);
  }, []);

  // Phase 2 Step 4: requests the Android notification permission and primes
  // the reminder channel/tap-listener up front at app startup, rather than
  // only lazily the first time a to-do happens to be saved (see
  // services/notifications/todoNotifications.ts's own doc comment).
  useEffect(() => {
    void initializeToDoNotifications();
  }, []);

  // Tapping a to-do reminder notification opens Xayra directly to the
  // To-Dos overlay — there's no per-item deep view yet (see
  // subscribeToToDoNotificationTap's own doc comment), so every tap just
  // opens the overlay, same as tapping the To-Dos pill would.
  useEffect(() => {
    return subscribeToToDoNotificationTap(() => {
      setIsTodosVisible(true);
    });
  }, []);

  // Build 22 EXPLICIT MODE SWITCHING: the single source of truth for what a
  // submission does — no classification, just this. Defaults to "record"
  // (the more common action — most sessions are jotting a thought, not
  // asking a question of past ones).
  // A launcher shortcut that opened the app sets the starting mode, so the
  // first frame already shows it (no Record→Ask flip after render).
  const [inputMode, setInputMode] = useState<UtteranceMode>(() => peekPendingShortcut()?.mode ?? "record");
  // Read only at the moment Handsfree hands an utterance off — every
  // utterance then carries that mode explicitly (see finishUtterance).
  const inputModeRef = useRef(inputMode);
  inputModeRef.current = inputMode;
  const [inputText, setInputText] = useState("");
  // True from the moment the compose input is focused until it's either
  // blurred (handleInputBlur) or submitted (handleSubmitText) — passed to
  // HistorySheet as `contentHidden` so the "Recent Answers" list (and its
  // glass box) disappears the instant typing starts, without touching the
  // sheet's own snap index/keyboard-avoidance at all. See handleInputFocus's
  // own doc comment for why this is deliberately NOT done by changing which
  // index the sheet snaps to.
  const [isComposing, setIsComposing] = useState(false);
  // Keyboard on screen — true also after a typed Record send, which keeps
  // the keyboard up while `isComposing` clears. "Typing" for the dock and
  // the Handsfree status means either.
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const keyboardVisibleRef = useRef(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => {
      keyboardVisibleRef.current = true;
      setIsKeyboardVisible(true);
    });
    const hide = Keyboard.addListener("keyboardDidHide", () => {
      keyboardVisibleRef.current = false;
      setIsKeyboardVisible(false);
      // Redmi uplift Stage 2: the tray kept the position it was pushed to
      // while the keyboard was up (a keyboard's height too high — the dock,
      // switch and emblem all followed it; reproduced on the emulator). A
      // re-snap to the same stage, once the keyboard is gone, recomputes it
      // against the full screen. The stage itself never changes here.
      requestAnimationFrame(() => sheetRef.current?.snapToIndex(requestedSheetIndexRef.current));
    });
    // A keyboard-hidden event missed while the app was away must not keep
    // the screen in its typing layout (dock hidden) after coming back.
    const appState = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      const visible = Keyboard.isVisible();
      keyboardVisibleRef.current = visible;
      setIsKeyboardVisible(visible);
    });
    return () => {
      show.remove();
      hide.remove();
      appState.remove();
    };
  }, []);
  const isTyping = isComposing || isKeyboardVisible;
  // Opens a note from either a chat citation chip (handleShowCitation below)
  // or a tap on a row in the Record-mode notes list (`notes` below) — same
  // modal either way.
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  // Record-mode drawer content: the sheet shows this list (newest first —
  // listNotes() already queries `ORDER BY created_at DESC`) instead of
  // Ask-mode's Q&A history. Reintroduced per explicit request — the
  // "Quiet Corner" pass (see quiet-corner-ui-overhaul memory) had moved the
  // full notes browse/search/Drive-restore experience to app/archive.tsx
  // entirely and left this screen showing the SAME "Ask anything..." chat
  // placeholder regardless of which mode was selected, which read as a bug
  // once both modes existed side by side: a user in Record mode has no
  // reason to see an Ask-mode empty state. This is deliberately the
  // read/delete slice only, not the full Archive feature set — no search bar,
  // and "Restore from Drive" (ChatSheetContent's own Record-mode empty-state
  // link) hands off to Archive rather than duplicating its Google-Sign-In/
  // restore flow here (see handleRestoreFromDriveShortcut below).
  const [notes, setNotes] = useState<Note[]>([]);
  const [processingState, setProcessingState] = useState<"idle" | "processing">("idle");
  const [processingLabel, setProcessingLabel] = useState<"note" | "query" | null>(null);
  // Real, granular pipeline progress (see services/ai/pipelineStage.ts) —
  // "Got it", "Finding where this belongs", etc. — read here so the
  // recorder canvas's status line can show what's ACTUALLY happening right
  // now instead of one static label for the whole save/query. Shows "Got
  // it" whenever no specific stage is set (e.g. the brief gap right after
  // one stage clears and before the next one starts).
  //
  // QA Phase 3, P2-2 fix: this canvas can be showing either a RECORD
  // ("note" flow) or an ASK-by-voice ("chat" flow, since an ASK-intent
  // utterance is routed through the same `chatSession.ask()`/`rag.ts` path
  // Chat's own typed queries use) operation, decided by the utterance's own
  // frozen mode before `finishUtterance` even starts — so both flows are
  // subscribed to unconditionally, and `processingLabel` (set from that same
  // mode, see `finishUtterance` below) picks which one is
  // actually THIS screen's own in-flight operation. Without this split, a
  // typed query submitted from Chat while this screen has its own voice
  // note mid-save would have overwritten this canvas's "note" stage with
  // Chat's unrelated "chat" stage the instant `rag.ts` set it — exactly the
  // cross-flow overwrite `qa/05-consolidated-triage.md`'s P2-2 describes.
  const [noteStage, setNoteStage] = useState<PipelineStage | null>(null);
  const [chatStage, setChatStage] = useState<PipelineStage | null>(null);
  useEffect(() => subscribeToPipelineStage("note", setNoteStage), []);
  useEffect(() => subscribeToPipelineStage("chat", setChatStage), []);
  const pipelineStage = processingLabel === "query" ? chatStage : noteStage;
  const [error, setError] = useState<string | null>(null);

  const sheetRef = useRef<BottomSheet>(null);
  /** Every app-driven tray snap: remembers the stage asked for. */
  const snapSheet = useCallback((index: number) => {
    requestedSheetIndexRef.current = index;
    sheetRef.current?.snapToIndex(index);
  }, []);
  const sheetAnimatedIndex = useSharedValue(0);
  // Mirrors sheetAnimatedIndex into plain JS state — HistorySheet needs this
  // (not just the Reanimated shared value) to actually skip rendering its
  // body at index 0 (see STRICT LAYOUT HIERARCHY), which has to be a real
  // React conditional, not something achievable from a UI-thread value alone.
  const [sheetIndex, setSheetIndex] = useState(0);
  const sheetIndexRef = useRef(0);
  // The stage the tray was last asked to reach (by the app or a gesture) —
  // what a re-snap after the keyboard closes restores, so it never undoes a
  // snap still animating (e.g. the collapse a recording starts with).
  const requestedSheetIndexRef = useRef(0);
  const handleSheetIndexChange = useCallback((index: number) => {
    sheetIndexRef.current = index;
    requestedSheetIndexRef.current = index;
    setSheetIndex(index);
  }, []);

  // MONOCHROMATIC GLASS EXPAND/COLLAPSE: `expandProgress` (0 = tray, 1 =
  // fully expanded) is dragged continuously by BOTH the tray's own handle
  // (HistorySheet.tsx) and the full-screen overlay's own handle
  // (ExpandedTextOverlay.tsx, always mounted now — see its own doc comment
  // for why) — see SwipeableTrayHandle.tsx's doc comment for the full
  // gesture design. Two earlier versions tried to make the expanded stage a
  // literal stage OF the sheet itself (a real "88%" snap point, then a
  // `snapToPosition("88%")` excursion), and a third used a discrete
  // threshold-swipe that only triggered a separate fade-in after release —
  // see HistorySheet.tsx's SHEET_SNAP_POINTS doc comment for exactly what
  // broke each time. `isTextBoxExpanded` (plain JS state, unchanged in
  // spirit from before) still exists for the few things that need a simple
  // yes/no — hiding the floating pill cluster below — updated via
  // `handleExpandSettle`, fired the instant a drag's release DECIDES which
  // way it's settling, not once the spring animation actually finishes.
  // The dock's anchor (Redmi uplift Stage 2): the canvas height measured
  // while the keyboard is down. The dock is drawn at the bottom of that, so
  // the keyboard or any tray movement can never lift it — with the keyboard
  // up it simply sits underneath.
  const [stableCanvasHeight, setStableCanvasHeight] = useState(0);
  const handleCanvasLayout = useCallback((e: LayoutChangeEvent) => {
    const height = Math.round(e.nativeEvent.layout.height);
    setStableCanvasHeight((prev) => (!keyboardVisibleRef.current || height > prev ? height : prev));
  }, []);

  const [isTextBoxExpanded, setIsTextBoxExpanded] = useState(false);
  const expandProgress = useSharedValue(0);
  const handleExpandSettle = useCallback((expanded: boolean) => setIsTextBoxExpanded(expanded), []);
  // An upward fling on the 50% tray's conversation opens the full-screen
  // view (Redmi uplift Stage 2) — the same end state as dragging the handle
  // past halfway. Only from the 50% stage. (A downward drag at the top of
  // the list already settles the tray: gorhom hands it to the sheet.)
  const handleConversationFlingUp = useCallback(() => {
    if (sheetIndexRef.current !== 1) return;
    expandProgress.value = withTiming(1, { duration: 240 });
    setIsTextBoxExpanded(true);
  }, [expandProgress]);

  // ---- Android Back (Stage 5c) ---------------------------------------------
  // The topmost thing open closes first; only a home screen with nothing
  // open hands Back to Android (see utils/backNavigation.ts). The keyboard
  // and native modals (NoteDetailModal) receive Back before this listener.
  const todosBackRef = useRef<(() => boolean) | null>(null);
  // The compose field is non-editable while To-Dos covers it, and — only
  // when To-Dos was closed by hardware Back — for a moment after: Back takes
  // the window out of touch mode, and as To-Dos' focused field unmounts
  // Android moves focus to the next editable field, the compose field,
  // which raised the tray into compose mode (seen on the emulator). A touch
  // close never triggers that, so it never arms the guard; and a real touch
  // on the field ends the guard at once and focuses it (Stage 5d — before,
  // a quick tap right after closing was swallowed).
  const [isComposeGuarded, setIsComposeGuarded] = useState(false);
  const endComposeGuard = useCallback(() => setIsComposeGuarded(false), []);
  useEffect(() => {
    if (!isComposeGuarded) return;
    const timer = setTimeout(() => setIsComposeGuarded(false), COMPOSE_UNCOVER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isComposeGuarded]);
  const backStateRef = useRef<HomeBackState>({
    quickMenuOpen: false,
    todosOpen: false,
    fullScreenOpen: false,
    composing: false,
    trayRaised: false,
  });
  backStateRef.current = {
    quickMenuOpen: isQuickMenuOpen,
    todosOpen: isTodosVisible,
    fullScreenOpen: isTextBoxExpanded,
    composing: isComposing,
    // `sheetIndex` changes when a snap settles, so a Back pressed while the
    // tray is still settling down to rest collapses it again (a no-op)
    // rather than skipping straight to the system's Back.
    trayRaised: sheetIndex > 0,
  };
  useHardwareBack(() => {
    switch (decideHomeBack(backStateRef.current)) {
      case "close-quick-menu":
        setIsQuickMenuOpen(false);
        return true;
      case "todos":
        if (!todosBackRef.current?.()) {
          setIsComposeGuarded(true);
          setIsTodosVisible(false);
        }
        return true;
      case "collapse-full-screen":
        settleExpandProgress(expandProgress, false, handleExpandSettle);
        return true;
      case "end-composing":
        // Blurs the field; the draft text is untouched.
        Keyboard.dismiss();
        return true;
      case "collapse-tray":
        snapSheet(0);
        return true;
      case "system":
        return false;
    }
  });

  // Shared spring physics for every snapToIndex call this sheet makes
  // (`@gorhom/bottom-sheet`'s own `animationConfigs` prop, applied uniformly
  // to the sheet's whole imperative API) — so every snap (backdrop tap,
  // auto-peek on submit, keyboard focus, drag-handle tap) decelerates with
  // the same soft, native-feeling curve, rather than the library's stiffer
  // built-in default.
  const sheetAnimationConfigs = useBottomSheetSpringConfigs({
    damping: 24,
    stiffness: 260,
    mass: 0.9,
    overshootClamping: false,
  });

  // ---- Option B: the tray's rest height is its measured content ----------
  // handle + compose field + gap + dock (the dock's height includes the
  // bottom safe-area inset — counted once, there). Measurements that arrive
  // while typing (a growing multiline field, keyboard animation) are held
  // and applied once typing ends, so the rest snap point never moves under
  // the keyboard or mid-animation.
  const [composeHeaderHeight, setComposeHeaderHeight] = useState(COMPOSE_HEADER_FALLBACK);
  const [dockHeight, setDockHeight] = useState(DOCK_ROW_FALLBACK + insets.bottom);
  const isTypingRef = useRef(false);
  isTypingRef.current = isTyping;
  const pendingHeaderHeightRef = useRef<number | null>(null);
  const handleComposeHeaderLayout = useCallback((height: number) => {
    if (isTypingRef.current) {
      pendingHeaderHeightRef.current = height;
      return;
    }
    // A fresh measurement outside typing supersedes anything held from
    // typing — otherwise the effect below could apply the stale value after
    // it (the two arrive in either order once typing ends) and leave the
    // rest tray shorter than its field.
    pendingHeaderHeightRef.current = null;
    setComposeHeaderHeight(height);
  }, []);
  useEffect(() => {
    if (!isTyping && pendingHeaderHeightRef.current !== null) {
      setComposeHeaderHeight(pendingHeaderHeightRef.current);
      pendingHeaderHeightRef.current = null;
    }
  }, [isTyping]);
  const handleDockHeight = useCallback((height: number) => {
    if (height > 0) setDockHeight(height);
  }, []);
  const restHeight = Math.round(SHEET_HANDLE_HEIGHT + composeHeaderHeight + REST_FIELD_DOCK_GAP + dockHeight);
  // The 50% stage, unchanged — read from the live window (gorhom resolves
  // "50%" against the live container, so a resize must move both together).
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const sheetHalfPx = windowHeight * 0.5;
  // On constrained screens the dock yields at 50% (utils/readingViewport.ts):
  // all measured — the 50% height, handle, compose field, body margin, dock.
  const dockYieldsAtHalf = dockYieldsAtHalfFor({
    halfHeight: sheetHalfPx,
    handleHeight: SHEET_HANDLE_HEIGHT,
    composeHeaderHeight,
    bodyMarginTop: SHEET_BODY_MARGIN_TOP,
    dockHeight,
  });
  const sheetHalfPxValue = useSharedValue(sheetHalfPx);
  useEffect(() => {
    sheetHalfPxValue.value = sheetHalfPx;
  }, [sheetHalfPx, sheetHalfPxValue]);
  const sheetRestPx = useSharedValue(restHeight);
  useEffect(() => {
    sheetRestPx.value = withTiming(restHeight, { duration: 220 });
  }, [restHeight, sheetRestPx]);

  // Xayra 2.0: the Record/Ask switch sits centred just above the tray and
  // follows it (drawerFloatingStackAnimatedStyle below). Its measured height
  // feeds the centre area's clearance, so the emblem never runs into it.
  const modeSwitchReserve = useSharedValue(MODE_SWITCH_FALLBACK_HEIGHT + MODE_SWITCH_BOTTOM_GAP + CENTER_AREA_BREATHING_ROOM_PX);
  const [modeSwitchHeight, setModeSwitchHeight] = useState(MODE_SWITCH_FALLBACK_HEIGHT);
  const handleModeSwitchLayout = useCallback(
    (e: LayoutChangeEvent) => setModeSwitchHeight(Math.round(e.nativeEvent.layout.height)),
    []
  );
  useEffect(() => {
    modeSwitchReserve.value = modeSwitchHeight + MODE_SWITCH_BOTTOM_GAP + CENTER_AREA_BREATHING_ROOM_PX;
  }, [modeSwitchHeight, modeSwitchReserve]);

  // Build 20 BUTTON CLEARANCE: the center canvas's own bottom padding tracks
  // the sheet's live height plus the Record/Ask switch above it, so the
  // emblem never ends up crowded against — or covered by — either one once
  // the sheet auto-peeks to 50% during an ASK request.
  const centerAreaAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom:
      interpolate(sheetAnimatedIndex.value, [0, 1], [sheetRestPx.value, sheetHalfPxValue.value], "clamp") +
      modeSwitchReserve.value,
  }));

  // Build 23 POSITION FLOATING PILLS (live-tracked): found by testing on a
  // physical device — a fixed `bottom: SHEET_HEIGHTS_PX[0] + margin` (the
  // sheet's RESTING height only) put the Handsfree/Record-Ask cluster
  // exactly where intended at the 20% peek, but once the sheet expanded
  // further the cluster stayed put and ended up floating on top of note/chat
  // cards instead of above the drawer. Same fix as BUTTON CLEARANCE just
  // above: track the sheet's actual live height via the same
  // `sheetAnimatedIndex`/`SHEET_HEIGHTS_PX` interpolation, not just its rest
  // value. This has none of Build 20 ComposeBar's keyboard-tracking risk —
  // there's no text input or keyboard interaction in this stack at all, just
  // a plain shared-value interpolation against the sheet's own index.
  const drawerFloatingStackAnimatedStyle = useAnimatedStyle(() => ({
    bottom:
      interpolate(sheetAnimatedIndex.value, [0, 1], [sheetRestPx.value, sheetHalfPxValue.value], "clamp") +
      MODE_SWITCH_BOTTOM_GAP,
    // Gone as soon as the full-screen view starts opening (Redmi uplift
    // Stage 2: on Android the elevated switch painted over the growing
    // full-screen tray mid-drag).
    opacity: interpolate(expandProgress.value, [0, 0.08], [1, 0], "clamp"),
  }));

  // The emblem zone takes the space actually left between the header and
  // the switch at each tray stage (measured centre-area height), less what
  // sits under it (cue/status, plus the waveform and Cancel while working),
  // within the canvas's limits. Two targets, interpolated live with the
  // tray's position, so it resizes in step with a drag or snap.
  const [centerRegionHeight, setCenterRegionHeight] = useState(0);
  const handleCenterAreaLayout = useCallback(
    (e: LayoutChangeEvent) => setCenterRegionHeight(Math.round(e.nativeEvent.layout.height)),
    []
  );
  const zoneRest = useSharedValue(EMBLEM_ZONE_MAX_HALF);
  const zoneHalf = useSharedValue(EMBLEM_ZONE_MAX_HALF);
  const emblemZoneSize = useDerivedValue(() =>
    interpolate(sheetAnimatedIndex.value, [0, 1], [zoneRest.value, zoneHalf.value], "clamp")
  );

  // BACKDROP TAP TO DISMISS: tapping anywhere on the canvas outside the
  // sheet/compose bar/center button (all of which are Pressables of their
  // own, and so claim a tap before it ever reaches this one) drops the
  // keyboard and returns the sheet to its resting peek. Both calls are
  // harmless no-ops when already dismissed/collapsed, so this doesn't need
  // to first check whether either is actually open.
  //
  // Not while the full-screen view is open (Redmi uplift Stage 2): nothing
  // behind it is backdrop, but a touch on its list's empty space (a short
  // list doesn't claim the touch) fell through to this canvas — and since
  // the canvas is the whole screen, even a swipe counted as a press. It
  // quietly collapsed the tray underneath, so closing the full-screen view
  // landed on the rest stage instead of the 50% tray it opened from.
  const isTextBoxExpandedRef = useRef(false);
  isTextBoxExpandedRef.current = isTextBoxExpanded;
  const handleBackdropPress = useCallback(() => {
    if (isTextBoxExpandedRef.current) return;
    Keyboard.dismiss();
    snapSheet(0);
  }, []);

  // Catches up any note saved while the embedding model wasn't available
  // (offline first run, etc.) — independent of whether the user ever opens
  // Archive (app/archive.tsx), since RAG/Ask search quality depends on
  // every note eventually being embedded regardless of whether its list is
  // ever browsed. Archive's own focus effect runs this again too (cheap,
  // harmless) so newly-restored/embedded notes show up promptly there.
  //
  // Build 41 P0 fix: retryPendingExtractions() is the sibling recovery pass
  // for to-do extraction (qa/05-consolidated-triage.md P0-2) — same trigger
  // point as the embedding catch-up above, so a note whose extraction died
  // mid-flight (process killed) gets picked back up the next time this
  // screen gains focus, same as an un-embedded note already does.
  useFocusEffect(
    useCallback(() => {
      void retryPendingEmbeddings();
      void retryPendingExtractions();
      // Once per app launch, after the vault is open: removes recordings a
      // killed process left behind (never audio a note still links to) —
      // see services/audio/recordingCleanup.ts.
      if (!didCleanupRecordingsThisLaunch) {
        didCleanupRecordingsThisLaunch = true;
        void cleanupOrphanRecordings(listNoteAudioUris).catch(() => {});
      }
      // Quick-menu "Archived notes (N)" label — count only, silent on
      // failure like the recovery passes above (not worth surfacing an
      // error for a label refresh).
      void countNotes()
        .then(setNotesCount)
        .catch(() => {});
      // Record-mode drawer list (see `notes` state's own doc comment) —
      // same silent-on-failure treatment; a stale list for one focus cycle
      // isn't worth surfacing an error banner for.
      void listNotes()
        .then(setNotes)
        .catch(() => {});
    }, [])
  );

  const refreshNotes = useCallback(() => {
    void listNotes()
      .then(setNotes)
      .catch(() => {});
  }, []);

  // ---- Explicit mode routing ----------------------------------------------
  //
  // Every submission — typed into ComposeBar, or spoken (manual tap or
  // Handsfree) — funnels through here. There is no classification step:
  // the Record/Ask pill decides RECORD vs ASK outright, every time, with
  // zero exceptions in either direction (RECORD never calls the RAG/Llama
  // pipeline; ASK never writes a note). The mode is captured when the
  // submission begins (typed submit, manual recording start, Handsfree
  // hand-off) and passed down explicitly — nothing downstream re-reads the
  // pill, so switching it mid-transcription can't change what an
  // already-started utterance means.

  const routeRecord = useCallback(
    async (text: string, audioUri: string | null, whisperModelId: string | null): Promise<boolean> => {
      // Only a note actually written counts as saved — a near-empty or
      // silent recording is discarded, and must not be announced as saved.
      let savedNote = false;
      try {
        const note = audioUri
          ? await createVoiceNote(audioUri, text, whisperModelId)
          : await createTextNote(text);
        showToast("Saved thought to memory");
        // Back to the resting peek — unless the keyboard is open (typed notes
        // keep it up for the next one): the peek sits behind the keyboard, so
        // snapping there hid the input and its Send button.
        if (!Keyboard.isVisible()) snapSheet(0);
        savedNote = true;
        // So the Record-mode drawer list shows the new note immediately,
        // not just after the next screen-focus refresh.
        refreshNotes();
        if (note.status !== "embedded") {
          setError(null);
        }
      } catch (err) {
        // "There was nothing here" (near-empty audio, Whisper flagged it
        // silent after the fact) is a silent discard, not a failure —
        // see the BLANK AUDIO & SILENCE GUARD requirement.
        if (!(err instanceof EmptyRecordingError) && !(err instanceof SilentRecordingError)) {
          throw err;
        }
      }
      return savedNote;
    },
    [refreshNotes]
  );

  /** Shared by ComposeBar's typed submit and both voice paths. `audioUri`
   * is null for a typed submission (nothing to attach if it turns out to be
   * a RECORD). Returns once fully handled — including, for ASK, once the
   * RAG answer has finished streaming in (not once speech has finished
   * playing; see `ask`/`submitQuery`'s own distinction for that).
   *
   * Security audit finding (real duplicate-query bug, confirmed on-device):
   * a voice ASK used to run the ENTIRE RAG pipeline twice for one spoken
   * question. This function's ASK branch called `chatSession.submitQuery`
   * (which itself runs the full RAG exchange and appends a user+assistant
   * message pair) — but `finishUtterance` below THEN called `chatSession.ask`
   * a second time on the very same transcript once this returned, appending
   * a second, redundant user+assistant pair and re-running local Llama
   * generation from scratch (confirmed in a live device log: two full
   * "SQLite-vec + FTS5 search retrieval" + "Llama total generation" cycles
   * back to back for one utterance). Neither of `useChatSession`'s own
   * re-entrancy refs caught this because the two calls are strictly
   * sequential, not concurrent — this was never the race those guard
   * against. Fixed by having this function itself call the side-effect-free
   * `ask()` for a voice-sourced query and hand the answer text back to the
   * caller to speak — `finishUtterance` no longer calls `ask()` on its own,
   * so the RAG pipeline now runs exactly once per utterance. A typed
   * (non-voice) ASK is unaffected: it still goes through `submitQuery`,
   * which never had this problem since ComposeBar's submit handler never
   * called `ask()` afterward. */
  const routeFreeformInput = useCallback(
    async (
      text: string,
      audioUri: string | null,
      whisperModelId: string | null,
      mode: UtteranceMode,
      job: ProcessingJob,
      voiceAsk?: VoiceAskReservation
    ): Promise<{ intent: "RECORD" | "ASK"; saved?: boolean; answerText?: string; assistantId?: string }> => {
      if (job.cancelled) return { intent: mode === "record" ? "RECORD" : "ASK" };
      setProcessingState("processing");
      // ASK auto-peeks to 50% to show the answer card; RECORD snaps back to
      // the resting peek once saved (see routeRecord). Snapped immediately —
      // there's no classification step to wait on anymore, but the sheet
      // still moves right away rather than only after the note/answer
      // pipeline finishes. A manual voice Ask already raised it when its
      // recording ended — not again, so a manual drag isn't overridden.
      if (!voiceAsk) snapSheet(1);
      const intent: "RECORD" | "ASK" = mode === "record" ? "RECORD" : "ASK";
      try {
        setProcessingLabel(intent === "RECORD" ? "note" : "query");
        if (intent === "RECORD") {
          // Point of no return: from here the note is written, so Cancel
          // stops being offered (a write in progress can't be un-done
          // cleanly). A job cancelled before this point never saves.
          if (!job.commit()) return { intent, saved: false };
          if (currentJobRef.current === job) setCancellableJobId(null);
          const saved = await routeRecord(text, audioUri, whisperModelId);
          return { intent, saved };
        }
        // Generation already running is stopped on cancel; one not started
        // yet is skipped (rag.ts), and a finished answer is discarded.
        job.onCancel(() => cancelActiveLlamaCompletion());
        if (audioUri) {
          // Voice-sourced: run the RAG exchange via `ask()`, which has no
          // speech side effect of its own — the caller (finishUtterance)
          // needs to actually await playback finishing before Handsfree
          // re-arms the mic, which `submitQuery`'s own fire-and-forget
          // speech can't provide. This is now the ONLY RAG call for a voice
          // query — see this function's doc comment above.
          const { assistantId, text: answerText } = await chatSession.ask(text, job, voiceAsk?.pending);
          return { intent, answerText, assistantId };
        }
        await chatSession.submitQuery(text, "text", job);
        return { intent };
      } finally {
        // Only the job that still owns the screen may reset it — a
        // cancelled job unwinding late must not clear a newer job's state.
        if (currentJobRef.current === job) {
          setProcessingState("idle");
          setProcessingLabel(null);
        }
      }
    },
    [routeRecord, chatSession]
  );

  // ---- The single shared recording pipeline ------------------------------
  //
  // Both a manual tap on the center button AND Handsfree Mode's continuous
  // loop funnel through this exact function — see its own note on the
  // "Hey Xayra" gap below.

  // Build 25 ATOMIC VOICE LOCK: fixes a real double-submission/double-RAG-
  // response bug. `processingVoiceJobRef` is a plain ref, not React
  // state — checked and set SYNCHRONOUSLY, immune to the render-batching
  // window that made the previous guard (useChatSession's `isSending`
  // STATE, read from a `useCallback` closure) unreliable: two calls into
  // `finishUtterance`/`chatSession.ask()` landing close enough together
  // could both read the same stale "not sending yet" closure before either
  // call's `setIsSending(true)` had actually committed and re-rendered,
  // letting both proceed and run the RAG pipeline twice for one utterance.
  // (useChatSession.ts's `ask`/`submitQuery` now also guard on their own
  // ref for the same reason — this is defense in depth, not either/or.)
  // Holds the job that owns the lock, so a CANCELLED job still unwinding
  // never blocks the next utterance.
  const processingVoiceJobRef = useRef<ProcessingJob | null>(null);
  // Belt-and-suspenders against a second, LATER call for what's really the
  // same phrase (e.g. a duplicate "result" event firing after the first one
  // already completed processing, rather than while it was still in
  // flight — the ref above alone wouldn't catch that since it's already
  // been released by then). Normalized (trimmed + lowercased) so trivial
  // casing/whitespace differences between two events reporting "the same"
  // utterance don't defeat the match.
  const lastVoiceQueryRef = useRef<{ normalizedText: string; at: number } | null>(null);
  const DUPLICATE_VOICE_QUERY_WINDOW_MS = 3000;

  // The processing job that currently owns the screen (see
  // services/ai/processingJob.ts). Cancel acts on it synchronously; a job
  // that's been cancelled or replaced can never touch the UI again.
  // `cancellableJobId` drives whether Cancel is offered.
  // A manual voice Ask's reserved tray bubble, from capture end until
  // finishUtterance takes it (see VoiceAskReservation).
  const pendingVoiceAskRef = useRef<VoiceAskReservation | null>(null);
  const chatSessionRef = useRef(chatSession);
  chatSessionRef.current = chatSession;
  const discardVoiceAsk = useCallback((reservation: VoiceAskReservation) => {
    discardVoiceAskReservation(reservation, chatSessionRef.current.discardPendingAsk);
  }, []);

  const currentJobRef = useRef<ProcessingJob | null>(null);
  // The job of the Handsfree utterance in flight (never a manual one), and
  // the Handsfree jobs the user has explicitly stopped.
  const handsfreeJobRef = useRef<ProcessingJob | null>(null);
  const interruptedHandsfreeJobsRef = useRef(new WeakSet<ProcessingJob>());
  const [cancellableJobId, setCancellableJobId] = useState<number | null>(null);
  const beginJob = useCallback(() => {
    const job = new ProcessingJob();
    currentJobRef.current = job;
    setCancellableJobId(job.id);
    return job;
  }, []);
  const endJob = useCallback((job: ProcessingJob | null) => {
    if (!job || currentJobRef.current !== job) return;
    currentJobRef.current = null;
    setCancellableJobId(null);
    setProcessingState("idle");
    setProcessingLabel(null);
  }, []);

  const finishUtterance = useCallback(
    async (
      audioUri: string,
      mode: UtteranceMode,
      reportState?: (state: "processing" | "speaking") => void,
      options?: { isHandsfree?: boolean; onRouted?: () => void; voiceAsk?: VoiceAskReservation }
    ) => {
      const voiceAsk = options?.voiceAsk;
      let job: ProcessingJob | null = null;
      // TEXT-ONLY STORAGE (enforced, no exceptions): this raw WAV
      // (services/audio/recorder.ts, written to the cache folder's recordings/)
      // is ALWAYS deleted once this function is done with it, regardless of
      // outcome — a RECORD intent no longer keeps its audio around for
      // in-app playback (services/notes/noteManager.ts's `createVoiceNote`
      // now persists every note with `audio_uri = NULL`, transcript text
      // only), and an ASK-intent voice query's audio was never attached to
      // any saved row to begin with. Every early return below (too-short/
      // silent/no-wake-word/duplicate-utterance) also falls through to the
      // same `finally` block, so there is no path through this function that
      // leaves the file on disk.
      try {
        if (await isAudioTooShort(audioUri)) {
          // DIAGNOSTIC — see the wake-word rejection log below for why this
          // is worth logging: without it, a recording discarded THIS early
          // (before Whisper ever runs) leaves no trace of why at all.
          if (options?.isHandsfree) {
            console.log("[Handsfree] Rejected — audio too short to transcribe");
          }
          return;
        }
        // Set BEFORE transcription starts, not after (routeFreeformInput
        // below used to be the only place these flipped, which only ran
        // once transcription had already finished) — otherwise the canvas
        // sat at "idle" for the entire real Whisper cold-start/transcribe
        // window, the single biggest real delay a user actually feels,
        // showing nothing at all rather than the transcription stage
        // that's genuinely happening right now. `mode` is this utterance's
        // own frozen Record/Ask choice, so it's safe to set the label this
        // early.
        job = beginJob();
        const thisJob = job;
        if (options?.isHandsfree) handsfreeJobRef.current = thisJob;
        // A cancelled utterance releases its manual-utterance slot at once
        // (the mic is already closed by now), so the central button works
        // again without waiting for Whisper/RAG to unwind.
        thisJob.onCancel(() => options?.onRouted?.());
        // Cancel clears the reserved answer bubble and its progress at once.
        if (voiceAsk) thisJob.onCancel(() => discardVoiceAsk(voiceAsk));
        setProcessingState("processing");
        setProcessingLabel(mode === "record" ? "note" : "query");
        // QA Phase 3, P2-2: tag this write with the flow THIS utterance
        // actually belongs to, not a shared untagged value — see the
        // `noteStage`/`chatStage` split above for the read side of this fix.
        // (A manual voice Ask's transcription progress is already owned and
        // shown in the tray — see onCaptureEnd.)
        if (!voiceAsk) setPipelineStage(mode === "record" ? "note" : "chat", "transcribing");
        if (voiceAsk) devTiming("VoiceAskTiming", "transcription start");
        const { transcript, whisperModelId } = await asrRouter.transcribe(audioUri, thisJob);
        if (voiceAsk) devTiming("VoiceAskTiming", "transcription complete", { chars: transcript.length, cancelled: thisJob.cancelled });
        if (thisJob.cancelled) {
          // Cancelled during transcription: the UI already returned to idle
          // and said "Cancelled" on the tap itself — nothing is routed,
          // saved or spoken.
          return;
        }
        if (isSilentTranscript(transcript)) {
          if (options?.isHandsfree) {
            // Metadata only — never the transcript itself (privacy rule).
            console.log(`[Handsfree] Rejected — transcript counted as silent (${transcript.length} chars)`);
          }
          return;
        }
      // Build 25 STRICT DUAL-MODE WAKE-WORD GATEKEEPER: scoped to Handsfree
      // only — see containsWakeWord's own doc comment
      // (services/audio/activeMode.ts) for why manual recordings are exempt
      // (a short manual note is a deliberate choice, not noise) and why this
      // is stricter than Build 24's word-count leniency. Runs BEFORE either
      // branch `routeFreeformInput` can take — Record's SQLite insert and
      // Ask's RAG query alike — so a wake-word-free transcript never reaches
      // either pipeline: no note saved, no query run, no card appended to
      // "Recorded notes" or "Searched notes".
      if (options?.isHandsfree && !containsWakeWord(transcript)) {
        // DIAGNOSTIC, metadata only: what was heard is never logged (the
        // privacy rule covers every build), but its size still tells a
        // "heard nothing useful" rejection apart from "heard a sentence
        // without the wake word".
        console.log(
          `[Handsfree] Rejected — no wake word match (${wordCount(transcript)} words, ${transcript.length} chars)`
        );
        showToast(`Ignored — say "${WAKE_PHRASE_DISPLAY}" to be heard`);
        return;
      }

      // Wake word confirmed. See wakeChime.ts's own doc comment for why this
      // fires HERE (right after the transcript-based check passes) rather
      // than at the start of listening — this app's wake-word detection is
      // retrospective, not a live acoustic trigger, so there is no earlier
      // moment that actually knows the wake word was said.
      if (options?.isHandsfree) {
        playWakeChime();
      }

      // Build 25 ATOMIC VOICE LOCK (cont.): both checks happen BEFORE any
      // async work starts, and the lock is claimed synchronously in the same
      // breath — nothing here awaits between reading and setting either ref.
      const normalizedText = transcript.trim().toLowerCase();
      const now = Date.now();
      const previous = lastVoiceQueryRef.current;
      const isDuplicateOfRecent =
        !!previous && previous.normalizedText === normalizedText && now - previous.at < DUPLICATE_VOICE_QUERY_WINDOW_MS;
      // A cancelled job still unwinding doesn't hold the lock.
      const lockHolder = processingVoiceJobRef.current;
      if ((lockHolder && !lockHolder.cancelled) || isDuplicateOfRecent) {
        return;
      }
      processingVoiceJobRef.current = thisJob;
      // "Immediately clear the active transcription buffer the exact
      // millisecond the phrase is accepted" (per the task): this app has no
      // separate live transcription-buffer state to clear (asrRouter.
      // transcribe() already hands back one final string, not a stream this
      // component accumulates into) — the equivalent here is recording
      // exactly which phrase was just accepted, at this exact instant,
      // before any routing/saving/RAG work begins, so a second event for
      // that same phrase has something to be compared against immediately.
      lastVoiceQueryRef.current = { normalizedText, at: now };

      try {
        reportState?.("processing");
        const { intent, saved, answerText, assistantId } = await routeFreeformInput(
          transcript.trim(),
          audioUri,
          whisperModelId ?? null,
          mode,
          thisJob,
          voiceAsk
        );
        if (thisJob.cancelled) {
          return;
        }
        // Saved / answered: speaking the result below no longer holds a
        // manual utterance open.
        options?.onRouted?.();

        // "speaking" is reported only when something is actually about to be
        // spoken — Handsfree's status must never say "speaking" in silence.
        // Nothing is spoken for a Handsfree utterance the user stopped — not
        // even "Saved." for a note whose write had already committed.
        if (options?.isHandsfree && !mayHandsfreeSpeak(thisJob, interruptedHandsfreeJobsRef.current)) {
          return;
        }
        // A Cancel from here on also silences whatever this job starts
        // saying.
        thisJob.onCancel(() => void stopSpeech());
        if (intent === "RECORD") {
          // Spoken only when a note was really written (it used to be said
          // even when the recording was discarded as empty/silent).
          const completion = recordCompletionSpeech(saved);
          if (completion) {
            reportState?.("speaking");
            await speakTextAndWait(completion);
          }
        } else if (answerText && assistantId) {
          reportState?.("speaking");
          // `chatSession.speakMessageAndWait` — not chatSession's other
          // (fire-and-forget) speech path, and not a raw `speakTextAndWait`
          // call either. Handsfree Mode needs to actually wait for playback
          // to finish before ActiveModeManager re-arms the mic, or it would
          // transcribe the assistant's own voice as the next "question" (no
          // echo cancellation exists here) — `routeFreeformInput` already
          // ran the RAG exchange via `ask()` (no speech side effect of its
          // own) and handed back the answer text, so this is still the only
          // speech that happens. But a raw `speakTextAndWait` call here
          // (the previous version of this code) never touched
          // `useChatSession`'s own `speakingMessageId` state at all — live
          // bug: the chat bubble's "Listen"/"Stop" button stayed stuck on
          // "Listen" for the entire time Xayra was actually talking, since
          // nothing ever marked that specific message as the one currently
          // speaking. `speakMessageAndWait` is the awaitable sibling of the
          // button's own `toggleSpeech`, keeping that state correctly in
          // sync while still giving Handsfree the same "wait for it to
          // finish" guarantee a raw call would have.
          await chatSession.speakMessageAndWait({ id: assistantId, text: answerText });
        }
      } finally {
        if (processingVoiceJobRef.current === thisJob) processingVoiceJobRef.current = null;
      }
      } finally {
        // Always — see this function's opening comment. `idempotent: true`
        // makes this a safe no-op if the file was somehow already gone.
        await FileSystem.deleteAsync(audioUri, { idempotent: true }).catch(() => {});
        // A reservation that never became a question (silent, too short,
        // duplicate, cancelled, failed) goes; one ask() took over stays.
        if (voiceAsk) discardVoiceAsk(voiceAsk);
        // Safety net for every early-return path above (too-short/silent/
        // no-wake-word/duplicate): resets the screen — but only if this job
        // still owns it (a cancelled or superseded job never touches it).
        if (!job || currentJobRef.current === job) {
          setPipelineStage(mode === "record" ? "note" : "chat", null);
        }
        if (job && handsfreeJobRef.current === job) handsfreeJobRef.current = null;
        if (job) endJob(job);
        else {
          setProcessingState("idle");
          setProcessingLabel(null);
        }
      }
    },
    [routeFreeformInput, chatSession, beginJob, endJob, discardVoiceAsk]
  );

  // ---- Handsfree Mode -----------------------------------------------------
  //
  // A REAL GAP, stated plainly: there is no "Hey Xayra" wake-word engine in
  // this codebase, still. Keyword-spotting (e.g. Porcupine, or a trained
  // wake-word model) is a separate, materially larger undertaking — a model
  // asset, an always-on low-power audio pipeline distinct from the full
  // recorder — that has NOT been built here, in Build 22 or any build before
  // it. What Handsfree Mode actually is, and remains: the 🎧 toggle below
  // engages the existing continuous listen-until-silence loop
  // (services/audio/activeMode.ts) manually, no spoken phrase required to
  // start it — once engaged, it's ALREADY listening continuously and
  // ALREADY auto-detects when an utterance starts and ends via RMS-threshold
  // VAD (see ActiveModeManager), with no manual tap needed per utterance.
  // That part was never broken; there was never a wake-word gate for it to
  // pass through in the first place.
  //
  // What WAS genuinely broken, and is fixed below: @fugood/react-native-
  // audio-pcm-stream (see the native module comment in
  // services/audio/activeMode.ts and its patch in patches/) supports exactly
  // ONE capture session at a time — a hard native constraint, not a
  // configurable limit. Nothing before Build 22 stopped the manual record
  // button and Handsfree's continuous session from both trying to own that
  // one native session at once: tapping the center button while Handsfree
  // was engaged would start a second, competing `AudioRecord.init()`/
  // `.start()` on top of the one ActiveModeManager already had open,
  // corrupting or silently killing whichever session lost that race — from
  // the outside, this looks exactly like "Handsfree stopped listening" or
  // "the continuous mic loop doesn't actually work." `handleRecordPress`
  // below now refuses to start a manual recording while Handsfree is
  // active, and `handleToggleHandsfree` refuses to engage Handsfree while a
  // manual recording is in flight — the one native session is now always
  // exclusively owned by whichever pipeline is actually running.
  //
  // The 10-minute no-speech auto-timeout (see armHandsfreeTimeout below) was
  // independently re-checked and is correct as-is: armed the instant
  // Handsfree engages, and re-armed on every utterance ActiveModeManager
  // actually detects speech for (every call into handleActiveModeUtterance
  // only happens when `finalizeUtterance()`'s own `hadSpeech` guard passed —
  // see activeMode.ts), so an actively-used session never times out
  // mid-conversation. Nothing needed fixing there.
  //
  // Build 24: `finishUtterance` below is now called with
  // `{ isHandsfree: true }` from handleActiveModeUtterance specifically so it
  // can run the (still non-acoustic — see activeMode.ts's own long comment)
  // post-transcription ambient-noise filter that the RMS-threshold VAD above
  // can't do on its own: a short, wake-word-free transcript from this path
  // gets discarded before it's ever routed or saved, which is what actually
  // stops room noise from turning into "(silence)" notes.
  //
  // Set below, once armHandsfreeTimeout exists — read through a ref here to
  // avoid a circular dependency (armHandsfreeTimeout needs `activeMode`,
  // which is only created by passing handleActiveModeUtterance into
  // useActiveMode below).
  const armHandsfreeTimeoutRef = useRef<() => void>(() => {});

  const handleActiveModeUtterance: ActiveModeUtteranceHandler = useCallback(
    async (audioUri, reportState) => {
      // Every call here means ActiveModeManager actually detected speech
      // (see its own hadSpeech guard) — re-arm the no-speech safety timeout
      // so an actively-used session never times out mid-conversation.
      armHandsfreeTimeoutRef.current();
      try {
        await finishUtterance(audioUri, inputModeRef.current, reportState, { isHandsfree: true });
      } catch (err) {
        console.error("[Handsfree] Failed to handle utterance", err);
      }
    },
    [finishUtterance]
  );
  const activeMode = useActiveMode(handleActiveModeUtterance);

  // Build 42 P3-b fix (qa/05-consolidated-triage.md P3-b): this cleanup
  // stops a plain manual recording on blur — navigating to Archive while a
  // Home-screen recording was still running left it capturing invisibly in
  // the background, where Archive's own note playback could then run
  // concurrently with it (a cross-screen instance of the same "single
  // active audio source" gap P1-1's fixes close elsewhere). `stopRecording()`
  // itself no-ops if nothing is recording, so this is safe to call
  // unconditionally.
  //
  // Live user report, fixed 2026-09-16: this used to ALSO stop Handsfree
  // (`activeMode.stop()`) on the exact same blur — so engaging Handsfree,
  // then navigating to Archive/Settings/To-Dos, silently turned it back off
  // with no visible feedback. Handsfree is a deliberately hands-free,
  // ongoing mode (the whole point is not needing to stay on the Home
  // screen); a manual recording is a short, actively-watched foreground
  // action, so the two don't warrant the same on-navigate behavior.
  // Removing Handsfree's stop-on-blur here does NOT reopen the cross-screen
  // echo hazard P3-b was built to prevent: `AudioPlayerControls.tsx`'s
  // `isMicInUse()` guard (P1-1c) already blocks any note's "Listen" button
  // — on Archive or anywhere else — while Handsfree is active, independent
  // of which screen is currently focused. The only real, separate case
  // that still correctly turns Handsfree off is leaving the app entirely
  // (`useActiveMode()`'s own `AppState` listener, P2-3) — untouched here.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const finishUtteranceRef = useRef(finishUtterance);
  finishUtteranceRef.current = finishUtterance;

  // ---- Manual voice utterance (central button) ----------------------------
  //
  // Tap → speak → finishes on its own after trailing silence (or on a
  // second tap while recording) → transcribe → save/answer. The controller
  // freezes Record/Ask when recording starts and carries it through; see
  // services/audio/manualUtterance.ts. Created once; it reaches the
  // recorder and pipeline through refs so it always calls the latest ones.
  const [manualUtterance, setManualUtterance] = useState<ManualUtteranceSnapshot>({ phase: "idle", mode: null });
  const manualControllerRef = useRef<ManualUtteranceController | null>(null);
  if (!manualControllerRef.current) {
    manualControllerRef.current = new ManualUtteranceController({
      startRecording: (options) => recorderRef.current.startRecording(options),
      stopRecording: () => recorderRef.current.stopRecording(),
      // Cancel during recording: the native recognizer started alongside
      // the recording goes too, and no audio file is ever written.
      discardRecording: async () => {
        // Throws, leaving the recording as it was, if the microphone
        // couldn't be told to stop — then the recognizer keeps going too.
        await recorderRef.current.discardRecording();
        asrRouter.cancelListening();
      },
      onCancelCleanupError: (err) => {
        console.warn("[Recorder] Stopping the microphone failed while cancelling", err);
        setError(CANCEL_STOP_FAILED_MESSAGE);
      },
      processUtterance: async (audioUri, mode, trigger, release) => {
        if (__DEV__) {
          console.log(`[Recorder] Finished by ${trigger === "silence" ? "trailing silence" : "tap"} (${mode})`);
        }
        const voiceAsk = pendingVoiceAskRef.current ?? undefined;
        pendingVoiceAskRef.current = null;
        try {
          await finishUtteranceRef.current(audioUri, mode, undefined, { onRouted: release, voiceAsk });
        } catch (err) {
          const message = userFacingMessage(err, "Something went wrong. Try again.");
          setError(message);
          Alert.alert("Recording Error", message);
        }
      },
      onChange: setManualUtterance,
      onError: (err) => setError(userFacingMessage(err, "Recording failed.")),
      // VOICE ASK: the moment the recording ends, the tray rises (once) and
      // its answer bubble appears with "Got it…" — the single surface for
      // this Ask's whole wait, transcription included. Record is untouched.
      onCaptureEnd: (mode) => {
        if (mode !== "ask") return;
        devTiming("VoiceAskTiming", "capture end — tray snap requested");
        pendingVoiceAskRef.current = reserveVoiceAsk(mode, {
          beginPendingAsk: () => chatSessionRef.current.beginPendingAsk(),
          raiseTray: () => snapSheet(1),
        });
      },
      onCaptureDiscarded: () => {
        // Nothing to transcribe: the recognizer started alongside this
        // recording has no use either (Gate B — it used to be left running).
        asrRouter.cancelListening();
        const reservation = pendingVoiceAskRef.current;
        pendingVoiceAskRef.current = null;
        if (reservation) discardVoiceAsk(reservation);
      },
    });
  }
  const manualController = manualControllerRef.current;
  // If this screen unmounts mid-utterance (e.g. the activity is re-created),
  // that utterance must die with it — never finish or be processed by a
  // screen nobody can see. (The recorder hook closes the mic itself.)
  useEffect(
    () => () => {
      const controller = manualControllerRef.current;
      const phase = controller?.snapshot.phase;
      if (phase === "starting" || phase === "recording") asrRouter.cancelListening();
      controller?.dispose();
    },
    []
  );

  useFocusEffect(
    useCallback(() => {
      return () => {
        // Leaving the screen mid-recording cancels it exactly like the
        // Cancel button: never transcribed, no audio file written. (Once
        // capture has ended, processing carries on as before.)
        void manualControllerRef.current?.cancel();
      };
    }, [])
  );

  // ---- The single shared recording pipeline (manual tap) -----------------
  //
  // Declared here, after `activeMode` exists, specifically so it can guard
  // against the single-native-session collision described above.
  // Cancel, split in two (see services/ai/processingJob.ts):
  //  A. Right now, on the tap: the screen returns to idle, Cancel goes
  //     away and "Cancelled" shows — never waiting on Whisper/RAG.
  //  B. Underneath: cancelling the job starts the real aborts it supports
  //     (Whisper decode, LLM generation) and releases the manual utterance;
  //     everything else it was doing finishes into a discarded result.
  // The explicit Cancel button and a tap during Handsfree's processing
  // both come here.
  const handleCancelProcessing = useCallback(() => {
    const job = currentJobRef.current;
    if (!cancelProcessing(job)) return;
    // A recognizer still waiting to be asked for this utterance's
    // transcript never will be (Gate B).
    asrRouter.cancelListening();
    currentJobRef.current = null;
    setCancellableJobId(null);
    setProcessingState("idle");
    setProcessingLabel(null);
    showToast("Cancelled");
  }, []);

  // Cancel DURING RECORDING (Stage 5a) — distinct from the processing
  // Cancel above: closes the microphone and throws the utterance away
  // before anything is transcribed, saved or asked. The id pins it to the
  // recording the button was shown for; if that recording already finished
  // (a tap or trailing silence won the race), this does nothing.
  const handleCancelRecording = useCallback(
    (utteranceId: number) => {
      void manualController.cancel(utteranceId).then((cancelled) => {
        if (!cancelled) return;
        showToast("Cancelled");
        // A retried Cancel worked: its own earlier "couldn't stop" message
        // no longer applies. Any other error is left alone.
        setError(clearCancelStopError);
      });
    },
    [manualController]
  );

  // Finish from the compact control shown only when the emblem is hidden
  // (constrained screens): the same manual completion as tapping the
  // emblem, pinned to the recording it was shown for.
  const handleFinishRecording = useCallback(
    (utteranceId: number) => {
      void manualController.finish("tap", utteranceId);
    },
    [manualController]
  );

  // The one way a manual utterance starts — a central-button tap or a
  // launcher shortcut — with the mode it will mean.
  // Ends text entry before any voice capture starts (manual or Handsfree):
  // the keyboard closes and the field leaves compose mode. The draft text
  // is kept.
  const endComposingForCapture = useCallback(() => {
    Keyboard.dismiss();
    setIsComposing(false);
  }, []);

  const startManualUtterance = useCallback(
    async (mode: UtteranceMode) => {
      setError(null);
      // Recording and composing are never both live: a recording started
      // while the compose field had focus used to leave the keyboard up and
      // the screen in two states at once — dock gone, Record/Ask stranded in
      // the tray, recording controls hidden under it (Redmi uplift 1C,
      // reproduced on the emulator).
      endComposingForCapture();
      // Starting a recording collapses the sheet to its resting peek
      // immediately.
      snapSheet(0);
      try {
        // Build 39: the PCM recorder starts FIRST, then Tier 1 — confirmed
        // on-device (Pixel 9) that reconfiguring the audio session
        // (`setAudioModeAsync`, inside startRecording) while Tier 1's
        // SpeechRecognizer was already listening starved it of audio.
        await manualController.start(mode);
        // Not for a start that was cancelled (or failed) on the way.
        if (manualController.snapshot.phase === "recording") asrRouter.startListening();
      } catch (err) {
        setError(userFacingMessage(err, "Recording failed."));
      }
    },
    [manualController, endComposingForCapture]
  );

  const handleRecordPress = useCallback(async () => {
    const action = decideCentralTap({
      manualPhase: manualController.snapshot.phase,
      isProcessing: processingState === "processing",
      // A Handsfree start in flight already owns the microphone.
      isHandsfreeActive: activeMode.isActive || activeMode.isStarting,
      isRecorderTransitioning: recorder.isTransitioning,
    });
    switch (action) {
      case "finish-manual":
        // The manual "finish now" override — recording otherwise finishes
        // itself after trailing silence.
        await manualController.finish("tap");
        return;
      case "ignore":
        // Processing a manual or typed submission: a tap no longer
        // cancels. Recording now finishes on its own, so a habitual second
        // tap can land just after it did — cancelling is the explicit
        // Cancel action's job (handleCancelProcessing).
        return;
      case "cancel-handsfree-processing":
        // Build 39/48, unchanged for Handsfree: a tap during Handsfree's own
        // transcribing/answering cancels it. Checked before the Handsfree
        // capture branch so it isn't swallowed by it.
        handleCancelProcessing();
        return;
      case "cancel-handsfree-capture":
        // Build 48 fix #2, unchanged: a tap while Handsfree is capturing an
        // utterance discards it (a no-op if no speech has been detected
        // yet). Also what keeps a manual recording from competing for the
        // one native capture session while Handsfree owns it.
        if (activeMode.cancelCurrentUtterance()) {
          showToast("Cancelled");
        }
        return;
      case "start-manual":
        await startManualUtterance(inputMode);
        return;
    }
  }, [manualController, processingState, activeMode, recorder.isTransitioning, inputMode, startManualUtterance, handleCancelProcessing]);

  // ---- Launcher shortcuts ("Record with Xayra" / "Ask Xayra") -------------
  //
  // A shortcut carries its own mode and, when it's safe, starts the same
  // manual utterance a central tap does — so the user just speaks. See
  // services/shortcuts/launchShortcut.ts (decideShortcutLaunch) for when it
  // only selects the mode instead, and plugins/withAppShortcuts.js for the
  // shortcuts themselves. State is read through refs because the decision
  // runs after an await.
  const processingStateRef = useRef(processingState);
  processingStateRef.current = processingState;
  const isHandsfreeActiveRef = useRef(activeMode.isActive);
  isHandsfreeActiveRef.current = activeMode.isActive;
  const [isFocused, setIsFocused] = useState(false);
  useFocusEffect(
    useCallback(() => {
      setIsFocused(true);
      return () => setIsFocused(false);
    }, [])
  );
  const handleLaunchShortcut = useCallback(
    async (shortcut: PendingShortcut) => {
      let micPermissionGranted = false;
      try {
        micPermissionGranted = (await getRecordingPermissionsAsync()).granted;
      } catch {
        // Unknown → treat as not granted: the user's tap then goes through
        // the normal permission prompt.
      }
      const action = decideShortcutLaunch({
        manualPhase: manualController.snapshot.phase,
        isProcessing: processingStateRef.current === "processing",
        isRecorderBusy: recorderRef.current.isRecording || recorderRef.current.isTransitioning,
        isHandsfreeActive: isHandsfreeActiveRef.current,
        isMicInUse: isMicInUse(),
        micPermissionGranted,
      });
      switch (action) {
        case "start":
          setInputMode(shortcut.mode);
          await startManualUtterance(shortcut.mode);
          return;
        case "select-only":
          setInputMode(shortcut.mode);
          showToast(shortcut.mode === "record" ? "Tap Xayra to record" : "Tap Xayra to ask");
          return;
        case "busy":
          showToast("Xayra is busy — finish or cancel the current one first.");
          return;
        case "handsfree":
          showToast(`Handsfree is on — say "${WAKE_PHRASE_DISPLAY}"`);
          return;
      }
    },
    [manualController, startManualUtterance]
  );
  // A warm launch's link lands before the app is visible: adopt its mode
  // right away (unless an utterance, processing or Handsfree is active), so
  // the first visible frame already shows it.
  const handleShortcutArrived = useCallback(
    (shortcut: PendingShortcut) => {
      const canAdopt = canAdoptShortcutMode({
        manualPhase: manualController.snapshot.phase,
        isProcessing: processingStateRef.current === "processing",
        isRecorderBusy: recorderRef.current.isRecording || recorderRef.current.isTransitioning,
        isHandsfreeActive: isHandsfreeActiveRef.current,
        isMicInUse: isMicInUse(),
      });
      if (canAdopt) setInputMode(shortcut.mode);
    },
    [manualController]
  );
  useLaunchShortcut({
    enabled: isReady && isFocused,
    onShortcut: (s) => void handleLaunchShortcut(s),
    onArrive: handleShortcutArrived,
  });


  // 10-minute no-speech safety timeout (Requirement 5) — armed the moment
  // Handsfree engages, and re-armed on every utterance ActiveModeManager
  // actually detects speech for (every call into handleActiveModeUtterance
  // above only happens when it heard something), so an actively-used
  // session never times out mid-conversation.
  const handsfreeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearHandsfreeTimeout = useCallback(() => {
    if (handsfreeTimeoutRef.current) {
      clearTimeout(handsfreeTimeoutRef.current);
      handsfreeTimeoutRef.current = null;
    }
  }, []);
  const armHandsfreeTimeout = useCallback(() => {
    clearHandsfreeTimeout();
    handsfreeTimeoutRef.current = setTimeout(() => {
      void activeMode.stop();
      showToast("Handsfree turned off after 10 minutes of silence.");
    }, HANDSFREE_IDLE_TIMEOUT_MS);
  }, [clearHandsfreeTimeout, activeMode]);
  armHandsfreeTimeoutRef.current = armHandsfreeTimeout;

  useEffect(() => {
    if (activeMode.isActive) {
      armHandsfreeTimeout();
    } else {
      clearHandsfreeTimeout();
    }
    return clearHandsfreeTimeout;
  }, [activeMode.isActive, armHandsfreeTimeout, clearHandsfreeTimeout]);

  // Explicit Stop (dock, typing strip, long-press) stops the Handsfree
  // interaction in progress, not just the listening (Stage 5b correction):
  // the Handsfree-owned job is cancelled where it still can be — never a
  // manual one — speech it started stops, and nothing more is spoken for
  // it. A note whose write already committed stays saved; an answer already
  // in the history stays there.
  const interruptHandsfree = useCallback(() => {
    interruptHandsfreeWork({
      handsfreeJob: handsfreeJobRef.current,
      interrupted: interruptedHandsfreeJobsRef.current,
      isSpeaking: activeMode.state === "speaking",
      stopSpeech: () => void stopSpeech(),
      onCancelled: (job) => {
        if (currentJobRef.current !== job) return;
        currentJobRef.current = null;
        setCancellableJobId(null);
        setProcessingState("idle");
        setProcessingLabel(null);
      },
    });
  }, [activeMode.state]);

  const stopHandsfreeExplicitly = useCallback(() => {
    interruptHandsfree();
    void activeMode.stop().then((stopped) => {
      if (!stopped) showToast("Couldn’t stop the microphone. Tap Handsfree to try again.");
    });
  }, [activeMode, interruptHandsfree]);

  const handleToggleHandsfree = useCallback(() => {
    if (activeMode.isActive || activeMode.isStarting) {
      stopHandsfreeExplicitly();
      return;
    }
    // The other half of the mutual-exclusion fix above: refuse to engage
    // Handsfree (and steal the one native capture session) while a manual
    // recording is already using it. Only guards the *engage* direction —
    // disengaging Handsfree is always allowed, same as it always was.
    if (!activeMode.isActive && (recorder.isRecording || recorder.isTransitioning)) {
      showToast("Finish your current recording first.");
      return;
    }
    endComposingForCapture();
    void activeMode.toggle().catch((err) => {
      Alert.alert("Handsfree Error", userFacingMessage(err, "Something went wrong. Try again."));
    });
  }, [activeMode, recorder.isRecording, recorder.isTransitioning, stopHandsfreeExplicitly, endComposingForCapture]);

  const handleLongPressCenterButton = handleToggleHandsfree;

  // Right after a manual recording finishes (by silence or tap) the
  // recorder is still draining its last chunk; show it as processing at
  // once so the hand-off is visible.
  const isManualStopping =
    manualUtterance.phase === "processing" && (recorder.isRecording || recorder.isTransitioning);
  // Cancelling acknowledges at once: the listening visuals go while the
  // microphone closes underneath.
  const canvasState: RecorderCanvasState = manualUtterance.phase === "cancelling"
    ? "idle"
    : isManualStopping
    ? "transcribing"
    : recorder.isRecording
    ? "recording"
    : processingState === "processing"
      ? "transcribing"
      : activeMode.isActive && activeMode.state === "listening" && !activeMode.stopFailed
        ? "listening"
        : "idle";

  // Listening copy only while the mic is capturing; once capture ends,
  // "Got it", then the real pipeline stages (see centralStatusText).
  // While the microphone's native release is unconfirmed or failed, the
  // status line says so rather than implying the microphone is off (Gate B).
  const micSnapshot = useMicSnapshot();
  const micNotice =
    micSnapshot.phase === "releaseUnconfirmed" || micSnapshot.phase === "releaseFailed"
      ? busyMessage(micSnapshot.phase)
      : null;
  const recordingStatusText = micNotice ?? centralStatusText({
    phase: isManualStopping
      ? "stopping"
      : canvasState === "recording"
        ? "recording"
        : canvasState === "transcribing"
          ? "processing"
          : "idle",
    pipelineStage,
    isHandsfreeActive: activeMode.isActive,
    // From the moment a manual voice Ask's recording ends, its progress
    // lives in the tray (Cancel stays under the button).
    isVoiceAskInTray: manualUtterance.mode === "ask" && manualUtterance.phase === "processing",
  });
  // When nothing is happening, say what a tap will do in the current mode.
  const idleCue = idleTapCue({
    canvasState,
    manualPhase: manualUtterance.phase,
    isHandsfreeActive: activeMode.isActive,
    mode: inputMode,
  });
  const showCancelProcessing = canvasState === "transcribing" && !activeMode.isActive && cancellableJobId !== null;
  const recordingUtteranceId = manualController.utteranceId;
  // Record/Ask can't change while a manual utterance is in flight — its
  // meaning was frozen when recording began.
  const isModeLocked = manualUtterance.phase !== "idle";

  // Emblem zone targets (see emblemZoneSize). Recomputed only when the
  // measured space or what sits under the emblem changes — never per frame.
  // Responsive priority per tray stage: reduce the orbit, then drop the
  // optional cue, then shrink the emblem, and hide it only when even the
  // smallest emblem can't fit beside the essential controls.
  const isEmblemBusy = canvasState === "recording" || canvasState === "transcribing";
  const isManualRecording = canvasState === "recording";
  // The status line's measured height: at large text it wraps ("Listening…
  // I'll finish when you're done" takes two lines at 200%), which a
  // one-line estimate under-counts — enough to push Cancel into the switch.
  const [statusTextHeight, setStatusTextHeight] = useState(0);
  const handleStatusTextLayout = useCallback((e: LayoutChangeEvent) => {
    const height = Math.round(e.nativeEvent.layout.height);
    setStatusTextHeight((prev) => (prev === height ? prev : height));
  }, []);
  const [emblemTiers, setEmblemTiers] = useState<{ rest: EmblemTier; half: EmblemTier }>({
    rest: FULL_EMBLEM_TIER,
    half: FULL_EMBLEM_TIER,
  });
  useEffect(() => {
    if (centerRegionHeight === 0) return;
    const textLine = (xayraType.cue.lineHeight ?? 20) * PixelRatio.getFontScale();
    const statusLines = Math.max(textLine, statusTextHeight);
    // Essential under the emblem: the status line (as measured), plus the
    // waveform and Cancel while working. Optional: the idle "Tap to …" cue,
    // or while recording the "Tap to finish" hint (Stage 5a: Cancel now
    // shows during recording too, so the hint is what gives way first).
    const essentialBelow = isEmblemBusy
      ? CENTER_AREA_GAP_PX + statusLines + WAVEFORM_ROW_HEIGHT + CENTER_AREA_GAP_PX + MIN_TOUCH_TARGET
      : 0;
    const hintLine = (xayraType.meta.lineHeight ?? 18) * PixelRatio.getFontScale() + STATUS_HINT_OFFSET;
    const cueBelow = isManualRecording
      ? CENTER_AREA_GAP_PX + hintLine
      : isEmblemBusy
        ? 0
        : CENTER_AREA_GAP_PX + textLine;
    const reserve = modeSwitchHeight + MODE_SWITCH_BOTTOM_GAP + CENTER_AREA_BREATHING_ROOM_PX;
    // The outer orbit arcs span ORBIT_SPAN x the zone; keep them inside the
    // screen's side gutters too.
    const widthCap = (windowWidth - 2 * ORBIT_SIDE_GUTTER) / ORBIT_SPAN;
    const fit = (sheetPx: number, max: number) =>
      emblemFit({
        available: centerRegionHeight - sheetPx - reserve - essentialBelow,
        cueHeight: cueBelow,
        maxZone: Math.min(max, widthCap),
        minZone: EMBLEM_ZONE_MIN,
        reduceOrbitBelow: ORBIT_REDUCE_BELOW,
        dropCueBelow: CUE_DROP_BELOW,
        orbitRoom: ORBIT_ROOM,
        reducedOrbitRoom: ORBIT_ROOM_REDUCED,
      });
    const rest = fit(restHeight, EMBLEM_ZONE_MAX_REST);
    const half = fit(sheetHalfPx, EMBLEM_ZONE_MAX_HALF);
    zoneRest.value = withTiming(Math.round(rest.zone), { duration: 220 });
    zoneHalf.value = withTiming(Math.round(half.zone), { duration: 220 });
    setEmblemTiers((prev) =>
      sameEmblemTier(prev.rest, rest.tier) && sameEmblemTier(prev.half, half.tier) ? prev : { rest: rest.tier, half: half.tier }
    );
  }, [
    centerRegionHeight,
    modeSwitchHeight,
    isEmblemBusy,
    isManualRecording,
    statusTextHeight,
    windowWidth,
    restHeight,
    sheetHalfPx,
    zoneRest,
    zoneHalf,
  ]);
  const emblemTier = sheetIndex === 0 ? emblemTiers.rest : emblemTiers.half;
  // Cancel while a manual recording is capturing (Handsfree keeps its own
  // tap-to-discard); Finish beside it only when the emblem is hidden.
  const recordingActions = recordingActionsFor({
    isCapturing: canvasState === "recording" && manualUtterance.phase === "recording",
    isHandsfreeActive: activeMode.isActive,
    emblemHidden: emblemTier.hidden,
  });

  const emblemLabel = activeMode.isActive
    ? "Handsfree is on. Long-press to turn it off"
    : canvasState === "recording"
      ? "Recording. Tap to finish"
      : inputMode === "ask"
        ? "Tap to ask. Long-press for Handsfree"
        : "Tap to record. Long-press for Handsfree";

  // Stop from the typing status: the existing controller's own stop.
  const handleStopHandsfree = stopHandsfreeExplicitly;
  const handsfreeDisplayState: HandsfreeDisplayState = activeMode.isStarting
    ? "starting"
    : activeMode.stopFailed
      ? "stopFailed"
      : activeMode.state;

  // The dock element, memoised so it's only re-created when what it shows
  // changes (HistorySheet hands it to the sheet's footer).
  const handleOpenTodos = useCallback(() => setIsTodosVisible(true), []);
  const dock = useMemo(
    () => (
      <HomeDock
        ref={quickMenuButtonRef}
        handsfreeActive={activeMode.isActive || activeMode.isStarting}
        handsfreeState={handsfreeDisplayState}
        pendingCount={pendingCount}
        bottomInset={insets.bottom}
        onHandsfree={handleToggleHandsfree}
        onTodos={handleOpenTodos}
        onMore={handleOpenQuickMenu}
        onHeightChange={handleDockHeight}
      />
    ),
    [activeMode.isActive, activeMode.isStarting, activeMode.state, pendingCount, insets.bottom, handleToggleHandsfree, handleOpenTodos, handleOpenQuickMenu, handleDockHeight]
  );

  const isDockShown = !isTyping && !isTextBoxExpanded;
  const dockHiddenAtHalf = dockYieldsAtHalf && sheetIndex === 1;
  const dockFadeStyle = useAnimatedStyle(() => ({
    opacity: dockYieldsAtHalf ? interpolate(sheetAnimatedIndex.value, [0.4, 1], [1, 0], "clamp") : 1,
  }));

  // Opens a note's detail modal — shared by a chat citation chip's tap AND
  // a row tap in the Record-mode notes list (ChatSheetContent's
  // `onShowCitation` prop is reused for both, same `(noteId: string) => void`
  // shape either way).
  const handleShowCitation = useCallback((noteId: string) => setSelectedNoteId(noteId), []);
  const handleSettingsPress = useCallback(() => router.push("/settings"), [router]);
  const handleOpenArchive = useCallback(() => router.push("/archive"), [router]);
  // Same confirm-then-delete flow as Archive's own handleDeleteNote — kept
  // in sync deliberately (this is the one place besides Archive a note can
  // be deleted from).
  const handleDeleteNote = useCallback((noteId: string) => {
    Alert.alert("Delete Note", "Are you sure you want to permanently delete this note?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteNote(noteId)
            .then(() => setNotes((prev) => prev.filter((note) => note.id !== noteId)))
            .catch((err) => {
              const message = userFacingMessage(err, "Failed to delete note.");
              Alert.alert("Delete Error", message);
            });
        },
      },
    ]);
  }, []);
  // ChatSheetContent's Record-mode empty state always renders a "Restore
  // from Drive" link — rather than duplicating Archive's whole Google-Sign-
  // In/restoreFromDrive/sync-status flow here for what's otherwise a
  // compact, read/delete-only list, this just hands off to the screen that
  // already has it built and working.
  const handleRestoreFromDriveShortcut = useCallback(() => router.push("/archive"), [router]);
  // Sheet still snaps to index 1 on focus — same as always, and load-bearing:
  // this is the mechanism (paired with `android_keyboardInputMode=
  // "adjustResize"` in HistorySheet.tsx) that took real on-device debugging
  // to get the compose bar reliably clearing the keyboard at all. A first
  // attempt at the "hide the list while typing" fix below force-collapsed to
  // index 0 instead, which broke that — the compose bar stopped rising
  // above the keyboard properly. The list is now hidden via `isComposing` +
  // HistorySheet's `contentHidden` prop instead, entirely independent of
  // which index the sheet is actually at.
  const handleInputFocus = useCallback(() => {
    snapSheet(1);
    setIsComposing(true);
  }, []);
  // Blur (tapping away without submitting) un-hides the list again — a
  // submission does the same via handleSubmitText/finishUtterance below,
  // since submitting never blurs the input (`blurOnSubmit={false}`,
  // ComposeBar.tsx) and the post-submit reveal needs the list visible
  // regardless.
  const handleInputBlur = useCallback(() => setIsComposing(false), []);

  const handleSelectMode = useCallback((mode: UtteranceMode) => {
    if (manualControllerRef.current?.snapshot.phase !== "idle") {
      return;
    }
    setInputMode(mode);
  }, []);

  const handleSubmitText = useCallback(
    (text: string) => {
      setInputText("");
      setIsComposing(false);
      const job = beginJob();
      void routeFreeformInput(text, null, null, inputMode, job)
        .catch((err) => {
          if (job.cancelled) return;
          const message = userFacingMessage(err, "Something went wrong.");
          setError(message);
          Alert.alert("Failed", message);
        })
        .finally(() => endJob(job));
    },
    [routeFreeformInput, inputMode, beginJob, endJob]
  );

  if (!isReady) {
    return <View style={styles.canvas} />;
  }

  return (
    <>
    {/* `pointerEvents="none"` (not just `disabled`) on this backdrop while
        TodosOverlay is open — live on-device report: this backdrop stayed
        fully mounted and touchable underneath TodosOverlay (a plain
        absolute-positioned overlay, not a real native Modal/window), and its
        own `onPress` was firing on taps meant for TodosOverlay's own search
        bar — confirmed via temporary diagnostic logging (`Keyboard.dismiss()`
        firing right after the search bar's own `onFocus`, killing the
        keyboard before it could ever show). `disabled` alone would only stop
        THIS Pressable's own `onPress` — it doesn't block descendants, so the
        record button nested inside `CentralRecorderCanvas` below could still
        independently receive the same kind of stray touch; `pointerEvents="none"`
        structurally blocks the whole subtree instead.
        CRITICAL: TodosOverlay/quickMenu must be siblings OUTSIDE this
        Pressable (moved out to the `<>` below), not children of it — an
        earlier version of this fix nested them inside the same Pressable and
        `pointerEvents="none"` blocked TodosOverlay's own subtree too,
        freezing the entire To-Dos screen (no scroll, no tap, nothing). */}
    <Pressable
      style={styles.canvas}
      onLayout={handleCanvasLayout}
      onPress={handleBackdropPress}
      pointerEvents={isTodosVisible ? "none" : "auto"}
      // A tap-to-dismiss surface only: not an accessibility element, so it
      // doesn't swallow the header, emblem and switch into one giant focus
      // stop (TalkBack reads and focuses them individually instead). "no"
      // hides only this node, never its children.
      accessible={false}
      focusable={false}
      importantForAccessibility="no"
    >
      {/* Xayra 2.0 header: centred mark and guidance only — Handsfree, To-Dos
          and More live in the tray's dock (HomeDock). */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.brandRow}>
          {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
          <Image source={require("../assets/icon.png")} style={styles.brandLogo} resizeMode="contain" />
          <XText variant="wordmark" accessibilityRole="header">
            Xayra
          </XText>
        </View>
        {showGreeting ? (
          <Animated.Text key="greeting" entering={FadeIn} exiting={FadeOut} style={styles.brandSubtitle}>
            {greetingText}
          </Animated.Text>
        ) : (
          <Animated.Text key={`subtitle-${inputMode}`} entering={FadeIn} style={styles.brandSubtitle}>
            {HOME_SUBTITLE[inputMode]}
          </Animated.Text>
        )}
      </View>

      <Animated.View style={[styles.centerArea, centerAreaAnimatedStyle]} onLayout={handleCenterAreaLayout}>
        <CentralRecorderCanvas
          state={canvasState}
          zoneSize={emblemZoneSize}
          orbitDetail={emblemTier.orbit}
          hidden={emblemTier.hidden}
          accessibilityLabel={emblemLabel}
          amplitude={recorder.amplitude}
          onPress={() => void handleRecordPress()}
          onLongPress={handleLongPressCenterButton}
          // NOT gated on activeMode.isActive: RN's Pressable disables BOTH
          // onPress and onLongPress together, and onLongPress here is what
          // toggles Handsfree back OFF — disabling the button while
          // Handsfree is active would remove that gesture as a way to turn
          // it off again. handleRecordPress's own early-return already
          // refuses to start a competing manual recording in that state
          // (see the wake-word/Handsfree mutual-exclusion fix above); that
          // guard alone is the actual fix, and doesn't need this prop's help.
          //
          // Not disabled while processing — a tap then is handled (or
          // deliberately ignored) by decideCentralTap. Only genuinely mid-
          // transition (a start/stop call already in flight) still disables
          // it, since that's a real race, not a deliberate user action to
          // support.
          disabled={recorder.isTransitioning}
        />
        {recordingStatusText && (
          // Polite live region: "Listening…", "Got it" and Record's real
          // stages are announced as they change.
          <Text style={styles.statusText} onLayout={handleStatusTextLayout} accessibilityLiveRegion="polite">
            {recordingStatusText}
          </Text>
        )}
        {idleCue && !micNotice && emblemTier.cue && (
          <Text testID="idle-tap-cue" style={styles.statusText}>
            {idleCue}
          </Text>
        )}
        {canvasState === "recording" && emblemTier.cue && <Text style={styles.statusHint}>Tap to finish</Text>}
        {showCancelProcessing && <CancelProcessingButton onCancel={handleCancelProcessing} />}
        {recordingActions.cancel && (
          <RecordingActions
            mode={manualUtterance.mode}
            showFinish={recordingActions.finish}
            onFinish={() => handleFinishRecording(recordingUtteranceId)}
            onCancel={() => handleCancelRecording(recordingUtteranceId)}
          />
        )}
        {error && <Text style={styles.errorText}>{error}</Text>}
      </Animated.View>

      {/* The Record/Ask switch, centred directly above the tray and tracking
          its live height (drawerFloatingStackAnimatedStyle), so it stays
          above the tray at every snap index. Hidden in the full-screen
          reading overlay and under To-Dos — same reasons as the floating
          cluster it replaces (sibling paint order alone didn't reliably keep
          it behind either). */}
      {!isTextBoxExpanded && !isTodosVisible && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(120)}
          pointerEvents="box-none"
          onLayout={handleModeSwitchLayout}
          style={[styles.modeSwitchRow, drawerFloatingStackAnimatedStyle]}
        >
          {/* The dock is hidden while typing (and, on constrained screens,
              at 50%); an active Handsfree session stays visible here — real
              state and a working Stop. */}
          {activeMode.isActive && (isTyping || (dockYieldsAtHalf && sheetIndex === 1)) && (
            <HandsfreeTypingStatus state={handsfreeDisplayState} onStop={handleStopHandsfree} />
          )}
          <SegmentedControl
            segments={MODE_SEGMENTS}
            value={inputMode}
            onChange={handleSelectMode}
            disabled={isModeLocked}
            accessibilityLabel="Mode"
          />
        </Animated.View>
      )}

      <HistorySheet
        ref={sheetRef}
        animatedIndex={sheetAnimatedIndex}
        sheetIndex={sheetIndex}
        contentHidden={isComposing}
        onIndexChange={handleSheetIndexChange}
        modelDownload={chatSession.modelDownload}
        bottomInset={insets.bottom}
        restHeight={restHeight}
        reserveFooter={isDockShown}
        gesturesEnabled={!isTextBoxExpanded}
        footerHeight={dockHeight}
        footerYieldsAtHalf={dockYieldsAtHalf}
        onHeaderLayout={handleComposeHeaderLayout}
        expandProgress={expandProgress}
        expandDragDistance={EXPAND_DRAG_DISTANCE}
        onExpandSettle={handleExpandSettle}
        animationConfigs={sheetAnimationConfigs}
        composeBarSlot={
          <ComposeBar
            inputText={inputText}
            onInputChange={setInputText}
            onInputFocus={handleInputFocus}
            onInputBlur={handleInputBlur}
            onSubmit={handleSubmitText}
            placeholder={inputMode === "record" ? "Type your thoughts…" : "Search your thoughts…"}
            mode={inputMode}
            sheetIndex={sheetIndex}
            covered={isTodosVisible || isComposeGuarded}
            onCoveredTouch={endComposeGuard}
          />
        }
        // Record mode shows the notes list (newest first); Ask mode keeps
        // the Q&A history it always has — both through ChatSheetContent's
        // own single persistent list now (see that file's own top-level doc
        // comment for why swapping between two separately-mounted scrollable
        // components here broke scrolling at this sheet's 50% stage,
        // confirmed on-device).
        content={
          <ChatSheetContent
            mode={inputMode}
            notes={notes}
            onDeleteNote={handleDeleteNote}
            isRestoring={false}
            onRestoreFromDrive={handleRestoreFromDriveShortcut}
            messages={chatSession.messages}
            isSending={chatSession.isSending}
            speakingMessageId={chatSession.speakingMessageId}
            modelDownload={chatSession.modelDownload}
            isModelReady={chatSession.isModelReady}
            onSubmitStarterPrompt={(prompt) => void chatSession.submitQuery(prompt, "text")}
            onToggleSpeech={chatSession.toggleSpeech}
            onShowCitation={handleShowCitation}
            listBottomPadding={TRAY_LIST_END_PADDING}
            onFlingUp={handleConversationFlingUp}
          />
        }
      />

      {/* The dock: a fixed screen element anchored to the bottom of the
          keyboard-down canvas (Redmi uplift Stage 2) — never the tray's
          footer, so recording, processing, the tray, the keyboard or a
          stale keyboard-era layout can't lift it. Hidden while typing and
          in the full-screen view, as before. */}
      {isDockShown && (
        <Animated.View
          pointerEvents={dockHiddenAtHalf ? "none" : "box-none"}
          importantForAccessibility={dockHiddenAtHalf ? "no-hide-descendants" : "auto"}
          accessibilityElementsHidden={dockHiddenAtHalf}
          style={[
            styles.dockAnchor,
            stableCanvasHeight > 0 ? { top: stableCanvasHeight - dockHeight } : { bottom: 0 },
            dockFadeStyle,
          ]}
        >
          {dock}
        </Animated.View>
      )}

      {/* Build 20 HARDENED NAV BAR SURFACE: app.json's
          android.navigationBarColor already sets #1C1C1E at the OS level,
          but Android 15+ increasingly ignores app-set nav-bar colors under
          enforced edge-to-edge (an OS behavior no config value can override
          — see PROJECT_STATE_HANDOFF.md's Build 19 section). This in-app
          View is the second line of defense: a solid #1C1C1E block docked to
          the actual bottom safe-area inset, painted above everything else on
          the canvas (it's the last sibling here, and the bottom sheet itself
          — now the sole owner of ComposeBar's position, see Build 21 — has
          no reason to paint above it), so the surface behind the system nav
          buttons reads correctly even on a device where the OS-level color
          is ignored. */}
      <View pointerEvents="none" style={[styles.navBarInset, { height: insets.bottom }]} />

      {/* MONOCHROMATIC GLASS — FULL-SCREEN EXPANDED STAGE: a plain, opaque
          overlay covering the entire canvas, rendered as the last real
          sibling here so it paints on top of absolutely everything —
          header, center button, floating pills, the sheet itself, even the
          nav-bar inset strip above. See ExpandedTextOverlay.tsx's own doc
          comment for why this is a separate component entirely rather than
          a stage of `<HistorySheet>`, and for why it's ALWAYS mounted now
          (driven continuously by `expandProgress`) rather than conditionally
          on `isTextBoxExpanded` the way it used to be — dragging needs to
          track from the first pixel, not just react after a release. Builds
          its OWN fresh content element (not the same instance passed to
          `<HistorySheet>` above) — both stay mounted simultaneously now
          (unlike before), but only one is ever actually VISIBLE at a time,
          gated by `expandProgress` inside ExpandedTextOverlay itself. Same
          Record/Ask mode split as HistorySheet's own `content` prop above —
          expanding from the notes list should keep showing notes, not
          suddenly switch to Q&A history. */}
      <ExpandedTextOverlay
        topInset={insets.top}
        bottomInset={insets.bottom}
        progress={expandProgress}
        dragDistance={EXPAND_DRAG_DISTANCE}
        onSettle={handleExpandSettle}
      >
        <ChatSheetContent
          mode={inputMode}
          notes={notes}
          onDeleteNote={handleDeleteNote}
          isRestoring={false}
          onRestoreFromDrive={handleRestoreFromDriveShortcut}
          messages={chatSession.messages}
          isSending={chatSession.isSending}
          speakingMessageId={chatSession.speakingMessageId}
          modelDownload={chatSession.modelDownload}
          isModelReady={chatSession.isModelReady}
          onSubmitStarterPrompt={(prompt) => void chatSession.submitQuery(prompt, "text")}
          onToggleSpeech={chatSession.toggleSpeech}
          onShowCitation={handleShowCitation}
          listBottomPadding={insets.bottom + OVERLAY_LIST_END_PADDING}
          usePlainList
        />
      </ExpandedTextOverlay>

      <NoteDetailModal
        noteId={selectedNoteId}
        visible={selectedNoteId !== null}
        onClose={() => setSelectedNoteId(null)}
        onDeleted={() => setSelectedNoteId(null)}
        onUpdated={refreshNotes}
      />
    </Pressable>

      {/* Rendered last so it paints above absolutely everything — header,
          center button, floating pills, the sheet, even ExpandedTextOverlay
          — matching that overlay's own z-order reasoning. See
          components/TodosOverlay.tsx's doc comment for why this is a plain
          sibling overlay rather than a pushed route.
          MUST be a sibling of the canvas Pressable above, not nested inside
          it — see that Pressable's own doc comment for why (pointerEvents
          "none" on the parent would otherwise block this overlay's entire
          subtree too, freezing To-Dos completely). */}
      {isTodosVisible && (
        <Animated.View entering={todosOverlayPopIn} exiting={FadeOut.duration(150)} style={styles.todosOverlayWrap}>
          <TodosOverlay onClose={() => setIsTodosVisible(false)} backRef={todosBackRef} />
        </Animated.View>
      )}

      {/* "Quiet Corner" quick menu — Archive + Settings, opened from the
          small "•••" icon next to the To-Dos pill.
          NOT a real native `<Modal>` — a plain conditionally-mounted
          sibling `<View>` overlay instead, same pattern as TodosOverlay
          above (see that component's own doc comment for the full
          root-cause writeup, worth reading before touching this again): on
          this app's Android/react-native-screens stack, any extra native
          window — an IME popup, a native `<Modal>` — gaining and then
          losing focus while a PUSHED route (router.push, e.g. Settings or
          Archive below) comes up on top reproducibly leaves that pushed
          screen's Fragment never reclaiming touch input again. This quick
          menu's whole job is "close, then immediately push a route" — the
          exact trigger for that bug — so it inherits TodosOverlay's fix:
          a plain View, never `<Modal>`. Confirmed broken on-device with the
          native-Modal version: Settings' own Back button went dead the
          instant it was reached from here. */}
      {isQuickMenuOpen && quickMenuAnchor && (
        <View style={styles.quickMenuBackdropView} pointerEvents="box-none">
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setIsQuickMenuOpen(false)} />
          {/* Anchored to the More button's actual measured position
              (quickMenuAnchor): opens upward from the dock (downward if the
              button is ever in the top half), right-aligned to it and kept
              inside the screen's side gutter. */}
          {/* Design-sandbox pass: this used to pop into existence with zero
              animation — the one overlay in this file with no entrance
              transition at all. Fluid pop-out spring (scale 0.95->1.0 +
              fade), same physics approved in the sandbox prototype. Only the
              inner surface animates, not quickMenuBackdropView above — that
              outer View is just an invisible tap-to-dismiss catcher, nothing
              to animate. */}
          <Animated.View
            entering={quickMenuPopIn}
            exiting={FadeOut.duration(120)}
            style={[
              styles.quickMenuPopover,
              quickMenuPosition(quickMenuAnchor),
            ]}
          >
            <Pressable
              accessibilityRole="menuitem"
              style={({ pressed }) => [styles.quickMenuRow, pressed && styles.quickMenuRowPressed]}
              onPress={() => {
                setIsQuickMenuOpen(false);
                handleOpenArchive();
              }}
            >
              <Feather name="archive" size={18} color={xayraColors.textSoft} />
              <Text style={styles.quickMenuRowText}>Archived notes ({notesCount})</Text>
            </Pressable>
            <Pressable
              accessibilityRole="menuitem"
              style={({ pressed }) => [styles.quickMenuRow, pressed && styles.quickMenuRowPressed]}
              onPress={() => {
                setIsQuickMenuOpen(false);
                handleSettingsPress();
              }}
            >
              <Feather name="settings" size={18} color={xayraColors.textSoft} />
              <Text style={styles.quickMenuRowText}>Settings</Text>
            </Pressable>
          </Animated.View>
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    // True jet black — see the redesign's explicit CANVAS requirement.
    backgroundColor: "#000000",
  },
  // Written out directly rather than via StyleSheet.absoluteFillObject —
  // matching ExpandedTextOverlay.tsx's own note that this RN version's type
  // declarations don't expose that helper. TodosOverlay's own root is
  // ALSO position:absolute/zero-inset, so this wrapper and its child share
  // the exact same full-screen bounds — this one exists purely to carry
  // `todosOverlayPopIn`'s translateY/opacity animation on mount/unmount.
  todosOverlayWrap: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  header: {
    paddingHorizontal: 12,
    paddingBottom: 4,
    alignItems: "center",
    gap: 8,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 9,
  },
  brandLogo: {
    width: 28,
    height: 28,
    borderRadius: 7,
  },
  brandSubtitle: {
    ...xayraType.guidance,
    color: xayraColors.textMuted,
    textAlign: "center",
    maxWidth: 320,
    paddingHorizontal: 12,
  },
  modeSwitchRow: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    gap: 10,
    zIndex: 25,
    elevation: 25,
  },
  centerArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: CENTER_AREA_GAP_PX,
  },
  statusText: {
    ...xayraType.cue,
    color: xayraColors.textMuted,
    textAlign: "center",
    paddingHorizontal: 24,
  },
  statusHint: {
    ...xayraType.meta,
    color: xayraColors.textFaint,
    marginTop: STATUS_HINT_OFFSET,
  },
  errorText: {
    ...xayraType.meta,
    color: ERROR_TEXT,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  dockAnchor: {
    position: "absolute",
    left: 0,
    right: 0,
  },
  navBarInset: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: xayraColors.surface,
    // Above ComposeBar's own zIndex/elevation (20, see that component) —
    // this strip must win the bottom edge even when the compose bar's
    // sheet-tracked position brings it this low on screen.
    zIndex: 30,
    elevation: 30,
  },
  quickMenuBackdropView: {
    // Written out directly rather than via StyleSheet.absoluteFillObject —
    // same note as TodosOverlay.tsx/ExpandedTextOverlay.tsx: this RN
    // version's type declarations don't expose that helper. No
    // background tint here (unlike a real action-sheet scrim) — an
    // anchored popover reads as "part of the pill cluster," not a
    // separate modal moment; the Pressable inside still covers the full
    // screen purely to catch an outside tap and dismiss.
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  // Anchored via quickMenuAnchor (measured from the real "•••" icon at tap
  // time) — `right`/`bottom` are set inline at the render site, not here.
  quickMenuPopover: {
    position: "absolute",
    minWidth: 208,
    backgroundColor: xayraColors.dock,
    borderRadius: xayraRadius.card,
    borderWidth: 1,
    borderColor: xayraColors.lineStrong,
    paddingVertical: 6,
    // Same shadow language as NoteDetailModal/other floating surfaces in
    // this app — a popover specifically needs to visibly lift off the
    // canvas behind it, more than the always-docked pill cluster does.
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 12,
  },
  quickMenuRow: {
    minHeight: MIN_TOUCH_TARGET,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    borderRadius: 12,
    marginHorizontal: 6,
  },
  quickMenuRowPressed: {
    backgroundColor: xayraColors.line,
  },
  quickMenuRowText: {
    ...xayraType.chip,
    fontSize: 15,
    color: xayraColors.text,
  },
});
