import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Dimensions, Image, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import * as FileSystem from "expo-file-system/legacy";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import BottomSheet, { useBottomSheetSpringConfigs } from "@gorhom/bottom-sheet";
import Animated, { FadeIn, FadeOut, interpolate, useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { CentralRecorderCanvas, type RecorderCanvasState } from "../components/CentralRecorderCanvas";
import { ChatSheetContent } from "../components/ChatSheetContent";
import { ComposeBar } from "../components/ComposeBar";
import { ExpandedTextOverlay } from "../components/ExpandedTextOverlay";
import { HistorySheet, SHEET_SNAP_POINTS } from "../components/HistorySheet";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { showToast } from "../components/Toast";
import { TodosOverlay } from "../components/TodosOverlay";
import { colors } from "../constants/theme";
import { useToDos } from "../hooks/useToDos";
import { asrRouter } from "../services/ai/asrRouter";
import { prewarmEngines } from "../services/ai/enginePrewarmer";
import { cancelActiveLlamaCompletion } from "../services/ai/localLlama";
import {
  PIPELINE_STAGE_LABELS,
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
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakTextAndWait } from "../services/audio/tts";
import { playWakeChime } from "../services/audio/wakeChime";
import { isAudioTooShort } from "../services/audio/wav";
import {
  countNotes,
  createTextNote,
  createVoiceNote,
  EmptyRecordingError,
  isSilentTranscript,
  retryPendingEmbeddings,
  retryPendingExtractions,
  SilentRecordingError,
} from "../services/notes/noteManager";
import { getGreetingFirstName } from "../services/sync/driveSync";
import { getTimeBasedGreeting } from "../utils/greeting";

/** Screen goes idle-with-mic-open for this long with zero detected speech
 * before Handsfree auto-disengages — a safety/battery guard, not a UX
 * nicety: an accidental activation left running in a pocket would otherwise
 * keep the mic (and the screen, via ActiveModeManager's own keep-awake) on
 * indefinitely. */
const HANDSFREE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/** How long the launch greeting ("Good morning, ...") stays up before
 * cross-fading into the header's normal persistent subtitle. */
const GREETING_VISIBLE_MS = 3500;

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
// stage isn't a real index — see `handleToggleExpand` below — so
// `sheetAnimatedIndex` simply never reports anything past 1), which is fine:
// what actually hides the record button behind the sheet at 88% is the
// sheet's own real rendered height sitting on top of it in z-order, not
// this padding value.
const SCREEN_HEIGHT = Dimensions.get("window").height;
const SHEET_HEIGHTS_PX = SHEET_SNAP_POINTS.map(
  (point) => (parseFloat(point) / 100) * SCREEN_HEIGHT
) as [number, number];
/** Clean breathing room kept between the record button and the sheet's top
 * edge, on top of the sheet's own current height — Build 20 BUTTON
 * CLEARANCE, most visible when the sheet auto-peeks to Index 1 (50%) while
 * an ASK request is in flight. */
const CENTER_AREA_BREATHING_ROOM_PX = 40;

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
  // navigation state — same conditional-mount pattern as
  // `isTextBoxExpanded`/`ExpandedTextOverlay` below.
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
  const [inputMode, setInputMode] = useState<"record" | "ask">("record");
  const [inputText, setInputText] = useState("");
  // True from the moment the compose input is focused until it's either
  // blurred (handleInputBlur) or submitted (handleSubmitText) — passed to
  // HistorySheet as `contentHidden` so the "Recent Answers" list (and its
  // glass box) disappears the instant typing starts, without touching the
  // sheet's own snap index/keyboard-avoidance at all. See handleInputFocus's
  // own doc comment for why this is deliberately NOT done by changing which
  // index the sheet snaps to.
  const [isComposing, setIsComposing] = useState(false);
  // The one remaining use for this pair on the home screen: opening a note
  // from a chat citation chip (handleShowCitation below). The home screen's
  // own full notes list/browse/delete/Drive-restore state moved to
  // app/archive.tsx entirely — see the "Quiet Corner" placement discussion.
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [processingState, setProcessingState] = useState<"idle" | "processing">("idle");
  const [processingLabel, setProcessingLabel] = useState<"note" | "query" | null>(null);
  // Real, granular pipeline progress (see services/ai/pipelineStage.ts) —
  // "Hearing you out", "Finding where this belongs", etc. — read here so the
  // recorder canvas's status line can show what's ACTUALLY happening right
  // now instead of one static label for the whole save/query. Falls back to
  // `processingLabel`'s older generic text below whenever no specific stage
  // is set (e.g. the brief gap right after one stage clears and before the
  // next one starts).
  //
  // QA Phase 3, P2-2 fix: this canvas can be showing either a RECORD
  // ("note" flow) or an ASK-by-voice ("chat" flow, since an ASK-intent
  // utterance is routed through the same `chatSession.ask()`/`rag.ts` path
  // Chat's own typed queries use) operation, decided by `inputMode` before
  // `finishUtterance` even starts — so both flows are subscribed to
  // unconditionally, and `processingLabel` (already captured at the same
  // moment as `inputMode`, see `finishUtterance` below) picks which one is
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
  const sheetAnimatedIndex = useSharedValue(0);
  // Mirrors sheetAnimatedIndex into plain JS state — HistorySheet needs this
  // (not just the Reanimated shared value) to actually skip rendering its
  // body at index 0 (see STRICT LAYOUT HIERARCHY), which has to be a real
  // React conditional, not something achievable from a UI-thread value alone.
  const [sheetIndex, setSheetIndex] = useState(0);
  const handleSheetIndexChange = useCallback((index: number) => setSheetIndex(index), []);

  // MONOCHROMATIC GLASS EXPAND/COLLAPSE: the micro-chip toggle opens/closes
  // `ExpandedTextOverlay` — a plain, full-screen component rendered further
  // down as an ordinary sibling of `<HistorySheet>`, completely independent
  // of the sheet's own snap-point state machine. Two earlier versions tried
  // to make this a literal stage OF the sheet itself (a real "88%" snap
  // point, then a `snapToPosition("88%")` excursion) — see
  // HistorySheet.tsx's SHEET_SNAP_POINTS doc comment for exactly what broke
  // both times. Because the overlay is a plain opaque full-screen View, not
  // a sheet stage, nothing else in this file needs to know or care about
  // `isTextBoxExpanded` — the sheet just stays wherever it already was
  // (always 50%, since that's the only place the chip that opens this
  // lives) underneath it.
  const [isTextBoxExpanded, setIsTextBoxExpanded] = useState(false);
  const handleToggleExpand = useCallback(() => setIsTextBoxExpanded((prev) => !prev), []);

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

  // Build 20 BUTTON CLEARANCE: the center canvas's own bottom padding tracks
  // the sheet's live height (same interpolation approach as ComposeBar's
  // PINNED DRAWER HEADER below) plus a fixed breathing-room margin, so the
  // record button never ends up crowded against — or covered by — the sheet
  // once it auto-peeks to 50% during an ASK request.
  const centerAreaAnimatedStyle = useAnimatedStyle(() => ({
    paddingBottom: interpolate(
      sheetAnimatedIndex.value,
      [0, 1],
      SHEET_HEIGHTS_PX.map((heightPx) => heightPx + CENTER_AREA_BREATHING_ROOM_PX),
      "clamp"
    ),
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
    bottom: interpolate(sheetAnimatedIndex.value, [0, 1], SHEET_HEIGHTS_PX, "clamp") + 16,
  }));

  // BACKDROP TAP TO DISMISS: tapping anywhere on the canvas outside the
  // sheet/compose bar/center button (all of which are Pressables of their
  // own, and so claim a tap before it ever reaches this one) drops the
  // keyboard and returns the sheet to its resting peek. Both calls are
  // harmless no-ops when already dismissed/collapsed, so this doesn't need
  // to first check whether either is actually open.
  const handleBackdropPress = useCallback(() => {
    Keyboard.dismiss();
    sheetRef.current?.snapToIndex(0);
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
      // Quick-menu "Archived notes (N)" label — count only, silent on
      // failure like the recovery passes above (not worth surfacing an
      // error for a label refresh).
      void countNotes()
        .then(setNotesCount)
        .catch(() => {});
    }, [])
  );

  // ---- Explicit mode routing ----------------------------------------------
  //
  // Every submission — typed into ComposeBar, or spoken (manual tap or
  // Handsfree) — funnels through here. There is no classification step:
  // `inputMode` (set only by the user tapping the Record/Ask pill) decides
  // RECORD vs ASK outright, every time, with zero exceptions in either
  // direction (RECORD never calls the RAG/Llama pipeline; ASK never writes
  // a note).

  const routeRecord = useCallback(
    async (text: string, audioUri: string | null, whisperModelId: string | null) => {
      try {
        const note = audioUri
          ? await createVoiceNote(audioUri, text, whisperModelId)
          : await createTextNote(text);
        showToast("Saved thought to memory");
        sheetRef.current?.snapToIndex(0);
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
    },
    []
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
      whisperModelId: string | null
    ): Promise<{ intent: "RECORD" | "ASK"; answerText?: string }> => {
      setProcessingState("processing");
      // ASK auto-peeks to 50% to show the answer card; RECORD snaps back to
      // the resting peek once saved (see routeRecord). Snapped immediately —
      // there's no classification step to wait on anymore, but the sheet
      // still moves right away rather than only after the note/answer
      // pipeline finishes.
      sheetRef.current?.snapToIndex(1);
      const intent: "RECORD" | "ASK" = inputMode === "record" ? "RECORD" : "ASK";
      try {
        setProcessingLabel(intent === "RECORD" ? "note" : "query");
        if (intent === "RECORD") {
          await routeRecord(text, audioUri, whisperModelId);
          return { intent };
        }
        if (audioUri) {
          // Voice-sourced: run the RAG exchange via `ask()`, which has no
          // speech side effect of its own — the caller (finishUtterance)
          // needs to actually await playback finishing before Handsfree
          // re-arms the mic, which `submitQuery`'s own fire-and-forget
          // speech can't provide. This is now the ONLY RAG call for a voice
          // query — see this function's doc comment above.
          const { text: answerText } = await chatSession.ask(text);
          return { intent, answerText };
        }
        await chatSession.submitQuery(text, "text");
        return { intent };
      } finally {
        setProcessingState("idle");
        setProcessingLabel(null);
      }
    },
    [inputMode, routeRecord, chatSession]
  );

  // ---- The single shared recording pipeline ------------------------------
  //
  // Both a manual tap on the center button AND Handsfree Mode's continuous
  // loop funnel through this exact function — see its own note on the
  // "Hey Xayra" gap below.

  // Build 25 ATOMIC VOICE LOCK: fixes a real double-submission/double-RAG-
  // response bug. `isProcessingVoiceQueryRef` is a plain ref, not React
  // state — checked and set SYNCHRONOUSLY, immune to the render-batching
  // window that made the previous guard (useChatSession's `isSending`
  // STATE, read from a `useCallback` closure) unreliable: two calls into
  // `finishUtterance`/`chatSession.ask()` landing close enough together
  // could both read the same stale "not sending yet" closure before either
  // call's `setIsSending(true)` had actually committed and re-rendered,
  // letting both proceed and run the RAG pipeline twice for one utterance.
  // (useChatSession.ts's `ask`/`submitQuery` now also guard on their own
  // ref for the same reason — this is defense in depth, not either/or.)
  const isProcessingVoiceQueryRef = useRef(false);
  // Belt-and-suspenders against a second, LATER call for what's really the
  // same phrase (e.g. a duplicate "result" event firing after the first one
  // already completed processing, rather than while it was still in
  // flight — the ref above alone wouldn't catch that since it's already
  // been released by then). Normalized (trimmed + lowercased) so trivial
  // casing/whitespace differences between two events reporting "the same"
  // utterance don't defeat the match.
  const lastVoiceQueryRef = useRef<{ normalizedText: string; at: number } | null>(null);
  const DUPLICATE_VOICE_QUERY_WINDOW_MS = 3000;

  // Build 39 "stop, don't execute this": set the instant a user re-taps the
  // center button while something's already processing (see
  // handleRecordPress below). Checked at the one checkpoint that actually
  // matters for a note (right after transcription resolves, before a note
  // is ever created or a query ever routed) — a plain ref, not state, since
  // it has to be visible synchronously inside `finishUtterance`'s own
  // still-running closure, not on the next render.
  const cancelRequestedRef = useRef(false);

  const finishUtterance = useCallback(
    async (
      audioUri: string,
      reportState?: (state: "processing" | "speaking") => void,
      options?: { isHandsfree?: boolean }
    ) => {
      // TEXT-ONLY STORAGE (enforced, no exceptions): this raw WAV
      // (services/audio/recorder.ts, written to documentDirectory/recordings/)
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
        // showing nothing at all rather than the "Hearing you out" stage
        // that's genuinely happening right now. `inputMode` is already
        // known (the user chose Record/Ask before ever tapping the mic), so
        // it's safe to set the label this early.
        setProcessingState("processing");
        setProcessingLabel(inputMode === "record" ? "note" : "query");
        // QA Phase 3, P2-2: tag this write with the flow THIS utterance
        // actually belongs to (known upfront from `inputMode`, per the
        // comment above), not a shared untagged value — see the
        // `noteStage`/`chatStage` split above for the read side of this
        // fix. Re-derived (not hoisted into a shared variable) so it stays
        // correct even across the `try`/`finally` block boundary below.
        setPipelineStage(inputMode === "record" ? "note" : "chat", "transcribing");
        cancelRequestedRef.current = false;
        const { transcript, whisperModelId } = await asrRouter.transcribe(audioUri);
        if (cancelRequestedRef.current) {
          // The user tapped cancel while transcription was still running —
          // transcription itself has no interrupt API (whisper.cpp runs to
          // completion once started), but nothing REQUIRES acting on its
          // result once it's back. Bailing here means no note is ever
          // created and no query is ever routed — the cleanest possible
          // "as if it never happened" for this stage, since there's nothing
          // to undo yet.
          showToast("Cancelled");
          return;
        }
        if (isSilentTranscript(transcript)) {
          if (options?.isHandsfree) {
            console.log(`[Handsfree] Rejected — transcript counted as silent: "${transcript}"`);
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
        // DIAGNOSTIC: the actual transcript text is otherwise never logged
        // anywhere (asrRouter.ts only logs which tier/timing, not the
        // string itself), and the audio that produced it is deleted right
        // after this — without this log, a rejected Handsfree utterance
        // leaves literally no trace of what Whisper actually heard, making
        // "why did it reject this" undiagnosable after the fact. adb logcat
        // only, never sent anywhere.
        console.log(`[Handsfree] Rejected — no wake word match in transcript: "${transcript}"`);
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
      if (isProcessingVoiceQueryRef.current || isDuplicateOfRecent) {
        return;
      }
      isProcessingVoiceQueryRef.current = true;
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
        const { intent, answerText } = await routeFreeformInput(transcript.trim(), audioUri, whisperModelId ?? null);

        reportState?.("speaking");
        if (intent === "RECORD") {
          await speakTextAndWait("Saved.");
        } else if (answerText) {
          // Deliberately NOT chatSession's own (fire-and-forget) speech —
          // Handsfree Mode needs to actually wait for playback to finish
          // before ActiveModeManager re-arms the mic, or it would transcribe
          // the assistant's own voice as the next "question" (no echo
          // cancellation exists here). `routeFreeformInput` already ran the
          // RAG exchange via `ask()` (no speech side effect of its own) and
          // handed back the answer text — this is the only speech that
          // happens, and the only RAG call that happened; see this bug's
          // full writeup on `routeFreeformInput`'s own doc comment above.
          await speakTextAndWait(answerText);
        }
      } finally {
        isProcessingVoiceQueryRef.current = false;
      }
      } finally {
        // Always — see this function's opening comment. `idempotent: true`
        // makes this a safe no-op if the file was somehow already gone.
        await FileSystem.deleteAsync(audioUri, { idempotent: true }).catch(() => {});
        // Safety net for every early-return path above (too-short/silent/
        // no-wake-word/duplicate) that flips processing state on at the top
        // of this function but never reaches `routeFreeformInput`'s own
        // matching reset below — without this, one of those rejections
        // would leave the canvas stuck on "Hearing you out" forever. A
        // no-op on the normal success path, where routeFreeformInput's own
        // `finally` has already reset all three.
        setProcessingState("idle");
        setProcessingLabel(null);
        // Matches the flow this same utterance's "transcribing" write above
        // used — see that comment for why this is re-derived from
        // `inputMode` rather than shared via a variable across the
        // try/finally boundary.
        setPipelineStage(inputMode === "record" ? "note" : "chat", null);
      }
    },
    [routeFreeformInput, chatSession, inputMode]
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
        await finishUtterance(audioUri, reportState, { isHandsfree: true });
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
  const recorderStopRef = useRef(recorder.stopRecording);
  recorderStopRef.current = recorder.stopRecording;
  useFocusEffect(
    useCallback(() => {
      return () => {
        void recorderStopRef.current();
      };
    }, [])
  );

  // ---- The single shared recording pipeline (manual tap) -----------------
  //
  // Declared here, after `activeMode` exists, specifically so it can guard
  // against the single-native-session collision described above.
  const handleRecordPress = useCallback(async () => {
    if (recorder.isTransitioning || activeMode.isActive) {
      return;
    }
    // Build 39 "stop, don't execute this": a tap while something's already
    // processing (not recording, not idle) means cancel, not "start a new
    // recording" — the canvas is deliberately no longer disabled during
    // this window (see its own `disabled` prop comment) specifically so
    // this tap can land. `cancelRequestedRef` is checked at the one point
    // in finishUtterance where a note/query would otherwise get created;
    // `cancelActiveLlamaCompletion()` additionally cuts an already-running
    // RAG answer off immediately rather than letting it keep generating for
    // several more seconds before the cancellation is even noticed.
    if (processingState === "processing") {
      cancelRequestedRef.current = true;
      cancelActiveLlamaCompletion();
      return;
    }
    setError(null);
    try {
      if (recorder.isRecording) {
        const audioUri = await recorder.stopRecording();
        if (!audioUri) {
          return;
        }
        try {
          await finishUtterance(audioUri);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          Alert.alert("Recording Error", message);
        }
      } else {
        // Tapping to start recording collapses the sheet to its resting
        // peek immediately.
        sheetRef.current?.snapToIndex(0);
        // Build 39: `recorder.startRecording()` now runs FIRST, not after
        // `asrRouter.startListening()` — confirmed on-device (Pixel 9) that
        // Tier 1 (native on-device speech recognition) failed with
        // "no-speech" on every single attempt, always silently falling back
        // to Whisper. `recorder.startRecording()` calls expo-audio's
        // `setAudioModeAsync()` to (re)configure the device's whole audio
        // session for recording — reconfiguring that session WHILE Tier 1's
        // SpeechRecognizer session was already open and listening (the old
        // order) is a plausible way to starve it of real audio input:
        // Android's audio focus can hand off exclusively to whichever
        // client most recently claimed the session, cutting Tier 1 off from
        // audio before it ever heard anything. Starting the PCM recorder
        // first means the audio session is already stable by the time Tier
        // 1 opens its own session on top of it, instead of an already-open
        // Tier 1 session getting the rug pulled out from under it.
        await recorder.startRecording();
        asrRouter.startListening();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed.");
    }
  }, [recorder, activeMode.isActive, finishUtterance, processingState]);

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

  const handleToggleHandsfree = useCallback(() => {
    // The other half of the mutual-exclusion fix above: refuse to engage
    // Handsfree (and steal the one native capture session) while a manual
    // recording is already using it. Only guards the *engage* direction —
    // disengaging Handsfree is always allowed, same as it always was.
    if (!activeMode.isActive && (recorder.isRecording || recorder.isTransitioning)) {
      showToast("Finish your current recording first.");
      return;
    }
    void activeMode.toggle().catch((err) => {
      Alert.alert("Handsfree Error", err instanceof Error ? err.message : String(err));
    });
  }, [activeMode, recorder.isRecording, recorder.isTransitioning]);

  const handleLongPressCenterButton = handleToggleHandsfree;

  const canvasState: RecorderCanvasState = recorder.isRecording
    ? "recording"
    : processingState === "processing"
      ? "transcribing"
      : activeMode.isActive && activeMode.state === "listening"
        ? "listening"
        : "idle";

  // Prefers the real, granular pipeline stage (see pipelineStage.ts) —
  // "Hearing you out", "Reading through your notes", etc. — falling back to
  // the older generic label only for the brief gap between one stage
  // clearing and the next one starting (e.g. right after a note finishes
  // embedding and before the pipeline as a whole has finished unwinding).
  const recordingStatusText = recorder.isRecording
    ? "Recording… tap to stop"
    : canvasState === "transcribing"
      ? // Build 39: "tap to cancel" appended here, not baked into
        // PIPELINE_STAGE_LABELS itself — those labels are shared with
        // ChatSheetContent's own streaming row (which has no cancel
        // gesture of its own), so the hint only belongs on this specific
        // status line.
        `${
          pipelineStage
            ? PIPELINE_STAGE_LABELS[pipelineStage]
            : processingLabel === "note"
              ? "Transcribing your thought..."
              : "Searching your thoughts..."
        } · tap to cancel`
      : null;

  // Opens a citation chip's source note from the chat view — the one
  // remaining "view a note" path on this screen, unrelated to Archive's own
  // full browse/delete list (app/archive.tsx).
  const handleShowCitation = useCallback((noteId: string) => setSelectedNoteId(noteId), []);
  const handleSettingsPress = useCallback(() => router.push("/settings"), [router]);
  const handleOpenArchive = useCallback(() => router.push("/archive"), [router]);
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
    sheetRef.current?.snapToIndex(1);
    setIsComposing(true);
  }, []);
  // Blur (tapping away without submitting) un-hides the list again — a
  // submission does the same via handleSubmitText/finishUtterance below,
  // since submitting never blurs the input (`blurOnSubmit={false}`,
  // ComposeBar.tsx) and the post-submit reveal needs the list visible
  // regardless.
  const handleInputBlur = useCallback(() => setIsComposing(false), []);

  const handleSelectMode = useCallback((mode: "record" | "ask") => {
    setInputMode(mode);
  }, []);

  const handleSubmitText = useCallback(
    (text: string) => {
      setInputText("");
      setIsComposing(false);
      void routeFreeformInput(text, null, null).catch((err) => {
        const message = err instanceof Error ? err.message : "Something went wrong.";
        setError(message);
        Alert.alert("Failed", message);
      });
    },
    [routeFreeformInput]
  );

  if (!isReady) {
    return <View style={styles.canvas} />;
  }

  return (
    <Pressable style={styles.canvas} onPress={handleBackdropPress}>
      {/* Build 23 CLEAN TOP BRAND HEADER: back to just the logo/title (plus
          its subtitle) — no pills, no cogwheel. Both moved out: the cogwheel
          returned to ComposeBar's row (see that component), and Handsfree +
          the Record/Ask pill now float above the drawer instead (below). */}
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.brandRow}>
          {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
          <Image source={require("../assets/icon.png")} style={styles.brandLogo} resizeMode="contain" />
          <Text style={styles.brandTitle}>Xayra</Text>
        </View>
        {showGreeting ? (
          <Animated.Text key="greeting" entering={FadeIn} exiting={FadeOut} style={styles.brandSubtitle}>
            {greetingText}
          </Animated.Text>
        ) : (
          <Animated.Text key="subtitle" entering={FadeIn} style={styles.brandSubtitle}>
            Tap to record your thoughts, later bring back your memories by tapping Xayra....
          </Animated.Text>
        )}
      </View>

      <Animated.View style={[styles.centerArea, centerAreaAnimatedStyle]}>
        <CentralRecorderCanvas
          state={canvasState}
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
          // Build 39: no longer disabled while `processingState ===
          // "processing"` — tapping during that window is now the "stop,
          // don't execute this" gesture (see handleRecordPress's own
          // cancel branch below), not a dead tap. Only genuinely mid-
          // transition (a start/stop call already in flight) still disables
          // it, since that's a real race, not a deliberate user action to
          // support.
          disabled={recorder.isTransitioning}
        />
        {recordingStatusText && <Text style={styles.statusText}>{recordingStatusText}</Text>}
        {error && <Text style={styles.errorText}>{error}</Text>}
      </Animated.View>

      {/* Build 23 POSITION FLOATING PILLS: Handsfree + the Record/Ask mode
          pill float in a single right-aligned cluster directly above the
          bottom sheet drawer, tracking the sheet's live height (see
          drawerFloatingStackAnimatedStyle above) so it stays above the
          drawer at every snap index instead of only at the 20% rest peek.

          Hidden entirely while the glass box is at its 88% expanded stage:
          `drawerFloatingStackAnimatedStyle` tracks `sheetAnimatedIndex`,
          which never reports anything past its 50%-height value during that
          stage (see this screen's own SHEET_HEIGHTS_PX comment for why) —
          confirmed on-device, this cluster stayed pinned at the 50%
          position and visibly overlapped the now-much-taller box's note
          cards instead of floating cleanly above it. Rather than build a
          second, independent animated position purely to track an
          overshoot state the user isn't even meant to interact with these
          controls during (they're browsing/reading, not recording, while
          expanded — the chip's own "x" is right there to get back), hiding
          the cluster removes the collision outright. */}
      {/* Also hidden while TodosOverlay is open (isTodosVisible) — plain
          sibling paint order alone didn't reliably keep this Animated.View
          (entering/exiting FadeIn/FadeOut) behind the overlay on-device;
          not mounting it at all while the overlay is up is the same
          defensive pattern already used for isTextBoxExpanded above,
          applied for the same reason. */}
      {!isTextBoxExpanded && !isTodosVisible && (
        <Animated.View
          entering={FadeIn.duration(150)}
          exiting={FadeOut.duration(120)}
          pointerEvents="box-none"
          style={[styles.drawerFloatingStack, { right: 24 }, drawerFloatingStackAnimatedStyle]}
        >
          {/* "Quiet Corner" pass: Archive and Settings are both deliberate,
              infrequent visits — never something reached for mid-recording —
              so they don't get their own permanent pills in this cluster.
              One small icon, inline with To-Dos (the cluster's own
              least-frequent existing member), opens a two-row popover
              instead. Record/Ask/Handsfree below are unchanged. */}
          <View style={styles.topRow}>
            <Pressable ref={quickMenuButtonRef} onPress={handleOpenQuickMenu} hitSlop={10} style={styles.quickMenuButton}>
              <Text style={styles.quickMenuButtonText}>•••</Text>
            </Pressable>
            <Pressable onPress={() => setIsTodosVisible(true)} style={styles.todosPill}>
              <Text style={styles.todosPillText}>
                {pendingCount > 0 ? `To-Dos (${pendingCount})` : "To-Dos"}
              </Text>
            </Pressable>
          </View>

          <Pressable
            onPress={handleToggleHandsfree}
            style={[styles.handsfreePill, activeMode.isActive && styles.handsfreePillActive]}
          >
            <Text style={[styles.handsfreePillText, activeMode.isActive && styles.handsfreePillTextActive]}>
              🎧 {activeMode.isActive ? `Handsfree · ${activeMode.state}` : "Handsfree"}
            </Text>
          </Pressable>

          <View style={styles.modePill}>
            {(["record", "ask"] as const).map((mode) => (
              <Pressable
                key={mode}
                onPress={() => handleSelectMode(mode)}
                style={[styles.modePillOption, inputMode === mode && styles.modePillOptionActive]}
              >
                <Text style={[styles.modePillText, inputMode === mode && styles.modePillTextActive]}>
                  {mode === "record" ? "Record" : "Ask"}
                </Text>
              </Pressable>
            ))}
          </View>
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
        onToggleExpand={handleToggleExpand}
        animationConfigs={sheetAnimationConfigs}
        composeBarSlot={
          <ComposeBar
            inputText={inputText}
            onInputChange={setInputText}
            onInputFocus={handleInputFocus}
            onInputBlur={handleInputBlur}
            onSubmit={handleSubmitText}
            placeholder={inputMode === "record" ? "Type your thoughts..." : "Search your thoughts..."}
          />
        }
        content={
          <ChatSheetContent
            messages={chatSession.messages}
            isSending={chatSession.isSending}
            speakingMessageId={chatSession.speakingMessageId}
            modelDownload={chatSession.modelDownload}
            isModelReady={chatSession.isModelReady}
            onSubmitStarterPrompt={(prompt) => void chatSession.submitQuery(prompt, "text")}
            onToggleSpeech={chatSession.toggleSpeech}
            onShowCitation={handleShowCitation}
            bottomInset={insets.bottom}
          />
        }
      />

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
          a stage of `<HistorySheet>`. Builds its OWN fresh ChatSheetContent
          element (not the same instance passed to `<HistorySheet>` above)
          since only one of the two copies is ever actually mounted at a
          time — this one, while expanded; HistorySheet's own copy,
          otherwise. Only ever Q&A content now — the Notes/QA segment choice
          this once branched on is gone along with the home screen's own
          Notes list (see app/archive.tsx). */}
      {isTextBoxExpanded && (
        <ExpandedTextOverlay topInset={insets.top} bottomInset={insets.bottom} onClose={handleToggleExpand}>
          <ChatSheetContent
            messages={chatSession.messages}
            isSending={chatSession.isSending}
            speakingMessageId={chatSession.speakingMessageId}
            modelDownload={chatSession.modelDownload}
            isModelReady={chatSession.isModelReady}
            onSubmitStarterPrompt={(prompt) => void chatSession.submitQuery(prompt, "text")}
            onToggleSpeech={chatSession.toggleSpeech}
            onShowCitation={handleShowCitation}
            bottomInset={insets.bottom}
            usePlainList
          />
        </ExpandedTextOverlay>
      )}

      <NoteDetailModal
        noteId={selectedNoteId}
        visible={selectedNoteId !== null}
        onClose={() => setSelectedNoteId(null)}
        onDeleted={() => setSelectedNoteId(null)}
      />

      {/* Rendered last so it paints above absolutely everything — header,
          center button, floating pills, the sheet, even ExpandedTextOverlay
          — matching that overlay's own z-order reasoning. See
          components/TodosOverlay.tsx's doc comment for why this is a plain
          sibling overlay rather than a pushed route. */}
      {isTodosVisible && <TodosOverlay onClose={() => setIsTodosVisible(false)} />}

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
          {/* Anchored to the icon's actual measured position (quickMenuAnchor),
              not a fixed corner — grows UPWARD (bottom-anchored, per the
              screen-height math below) since the icon sits low on screen,
              and right-aligns its own right edge to the icon's, so it never
              spills off the right edge of the screen. */}
          <View
            style={[
              styles.quickMenuPopover,
              {
                right: Dimensions.get("window").width - (quickMenuAnchor.x + quickMenuAnchor.width),
                bottom: Dimensions.get("window").height - quickMenuAnchor.y + 8,
              },
            ]}
          >
            <Pressable
              style={({ pressed }) => [styles.quickMenuRow, pressed && styles.quickMenuRowPressed]}
              onPress={() => {
                setIsQuickMenuOpen(false);
                handleOpenArchive();
              }}
            >
              <Text style={styles.quickMenuRowText}>🗄️ Archived notes ({notesCount})</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.quickMenuRow, pressed && styles.quickMenuRowPressed]}
              onPress={() => {
                setIsQuickMenuOpen(false);
                handleSettingsPress();
              }}
            >
              <Text style={styles.quickMenuRowText}>⚙️ Settings</Text>
            </Pressable>
          </View>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  canvas: {
    flex: 1,
    // True jet black — see the redesign's explicit CANVAS requirement.
    backgroundColor: "#000000",
  },
  header: {
    paddingHorizontal: 24,
    paddingBottom: 4,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  brandLogo: {
    width: 26,
    height: 26,
    borderRadius: 6,
  },
  brandTitle: {
    color: "#FFFFFF",
    fontSize: 22,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  brandSubtitle: {
    color: "rgba(235,235,245,0.55)",
    fontSize: 13,
    marginTop: 4,
    lineHeight: 18,
  },
  // Build 23 POSITION FLOATING PILLS: Handsfree + the Record/Ask pill,
  // right-aligned, floating above the drawer — `bottom` is animated (see
  // drawerFloatingStackAnimatedStyle) to track the sheet's live height so
  // this stays above the drawer at every snap index, not just its resting
  // peek. No text input lives in here (that's ComposeBar's job, inside the
  // sheet), so unlike Build 20's ComposeBar this has no keyboard-avoidance
  // of its own to fight with anything — just a plain shared-value
  // interpolation against the sheet's own index.
  drawerFloatingStack: {
    position: "absolute",
    alignItems: "flex-end",
    zIndex: 25,
    elevation: 25,
  },
  // Order here is visual top-to-bottom: To-Dos, then Handsfree, then the
  // Record/Ask pill. Styled as a plain dark pill, deliberately unstyled by
  // pendingCount (no accent tint at >0) — the badge NUMBER inside the label
  // is the whole affordance per spec, not a color change on top of it.
  // Wraps the new "•••" quick-menu icon and the To-Dos pill side by side —
  // inline, not stacked as its own row, so the cluster's total height
  // doesn't grow past what it was before this pass (see the "Quiet Corner"
  // placement discussion for why inline-with-To-Dos won out over a plain
  // 4th stacked row).
  topRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 10, // gap above the Handsfree pill
  },
  quickMenuButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(28, 28, 30, 0.85)",
    borderColor: "rgba(255,255,255,0.1)",
  },
  quickMenuButtonText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#8E8E93",
    letterSpacing: 1,
  },
  todosPill: {
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    backgroundColor: "rgba(28, 28, 30, 0.85)",
    borderColor: "rgba(255,255,255,0.1)",
  },
  todosPillText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#8E8E93",
  },
  handsfreePill: {
    marginBottom: 10, // gap above the Record/Ask pill
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderWidth: 1,
    // OFF state, per spec.
    backgroundColor: "rgba(28, 28, 30, 0.85)",
    borderColor: "rgba(255,255,255,0.1)",
  },
  handsfreePillActive: {
    // ON state, per spec.
    backgroundColor: "#635BFF",
    borderColor: "#635BFF",
  },
  handsfreePillText: {
    fontSize: 12,
    fontWeight: "600",
    color: "#8E8E93",
  },
  handsfreePillTextActive: {
    color: "#FFFFFF",
  },
  modePill: {
    flexDirection: "row",
    backgroundColor: "#1C1C1E",
    borderRadius: 999,
    padding: 3,
  },
  modePillOption: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  modePillOptionActive: {
    backgroundColor: colors.accent,
  },
  modePillText: {
    color: "rgba(235,235,245,0.6)",
    fontSize: 12,
    fontWeight: "600",
  },
  modePillTextActive: {
    color: colors.onAccent,
  },
  centerArea: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  statusText: {
    color: "rgba(255,255,255,0.7)",
    fontSize: 13,
    fontWeight: "600",
  },
  errorText: {
    color: "#F87171",
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: 32,
  },
  navBarInset: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "#1C1C1E",
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
    minWidth: 168,
    backgroundColor: "#1C1C1E",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
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
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 10,
    marginHorizontal: 4,
  },
  quickMenuRowPressed: {
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  quickMenuRowText: {
    color: "#F8FAFC",
    fontSize: 15,
    fontWeight: "600",
  },
});
