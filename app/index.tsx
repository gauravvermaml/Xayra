import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Dimensions, Image, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import BottomSheet from "@gorhom/bottom-sheet";
import Animated, { interpolate, useAnimatedStyle, useSharedValue } from "react-native-reanimated";

import { CentralRecorderCanvas, type RecorderCanvasState } from "../components/CentralRecorderCanvas";
import { ChatSheetContent } from "../components/ChatSheetContent";
import { ComposeBar } from "../components/ComposeBar";
import { HistorySheet, SHEET_SNAP_POINTS, type HistoryTab } from "../components/HistorySheet";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { NotesSheetContent, type DisplayNote } from "../components/NotesSheetContent";
import { showToast } from "../components/Toast";
import { colors } from "../constants/theme";
import { asrRouter } from "../services/ai/asrRouter";
import { prewarmEngines } from "../services/ai/enginePrewarmer";
import { useChatSession } from "../services/ai/useChatSession";
import { containsWakeWord, useActiveMode, type ActiveModeUtteranceHandler } from "../services/audio/activeMode";
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakTextAndWait } from "../services/audio/tts";
import { isAudioTooShort } from "../services/audio/wav";
import {
  createTextNote,
  createVoiceNote,
  deleteNote,
  EmptyRecordingError,
  isSilentTranscript,
  listNotes,
  purgeAllNotes,
  retryPendingEmbeddings,
  SilentRecordingError,
  type Note,
} from "../services/notes/noteManager";
import { getSyncStatus, restoreFromDrive, signInWithGoogle, type SyncStatus } from "../services/sync/driveSync";

/** Screen goes idle-with-mic-open for this long with zero detected speech
 * before Handsfree auto-disengages — a safety/battery guard, not a UX
 * nicety: an accidental activation left running in a pocket would otherwise
 * keep the mic (and the screen, via ActiveModeManager's own keep-awake) on
 * indefinitely. */
const HANDSFREE_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

// Percentage snap points (SHEET_SNAP_POINTS = ['20%', '50%'] as of Build 24 —
// see HistorySheet.tsx) are the bottom sheet's own geometry, expressed as
// strings for @gorhom/bottom-sheet. The center canvas's own bottom clearance
// (BUTTON CLEARANCE — Build 20) and the floating pill cluster above the
// drawer (Build 23) both need the same values as plain pixel numbers to
// interpolate against the sheet's live animated index, so they're derived
// here once, from SHEET_SNAP_POINTS itself, rather than each hardcoding the
// split independently.
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

  const [historyTab, setHistoryTab] = useState<HistoryTab>("notes");
  // Build 22 EXPLICIT MODE SWITCHING: the single source of truth for what a
  // submission does — no classification, just this. Defaults to "record"
  // (the more common action — most sessions are jotting a thought, not
  // asking a question of past ones).
  const [inputMode, setInputMode] = useState<"record" | "ask">("record");
  const [inputText, setInputText] = useState("");
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [processingState, setProcessingState] = useState<"idle" | "processing">("idle");
  const [processingLabel, setProcessingLabel] = useState<"note" | "query" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ isConnected: false });
  const [isRestoring, setIsRestoring] = useState(false);

  const sheetRef = useRef<BottomSheet>(null);
  const sheetAnimatedIndex = useSharedValue(0);
  // Mirrors sheetAnimatedIndex into plain JS state — HistorySheet needs this
  // (not just the Reanimated shared value) to actually skip rendering its
  // body at index 0 (see STRICT LAYOUT HIERARCHY), which has to be a real
  // React conditional, not something achievable from a UI-thread value alone.
  const [sheetIndex, setSheetIndex] = useState(0);
  const handleSheetIndexChange = useCallback((index: number) => setSheetIndex(index), []);

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

  const refreshNotes = useCallback(async () => {
    try {
      setAllNotes(await listNotes());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load notes.");
    }
  }, []);

  const refreshSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await getSyncStatus());
    } catch (err) {
      console.error("[Sync] Failed to load status", err);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void refreshNotes();
      void refreshSyncStatus();
      void retryPendingEmbeddings().then((count) => {
        if (count > 0) {
          void refreshNotes();
        }
      });
    }, [refreshNotes, refreshSyncStatus])
  );

  // Security audit finding: this had no re-entrancy guard of its own — only
  // the `isRestoring` REACT STATE the "Restore from Drive" link disables on
  // (see NotesSheetContent). Exactly the same closure-staleness window
  // documented on `useChatSession`'s `isSendingRef` applies here: a fast
  // double-tap can fire this callback twice before `setIsRestoring(true)`
  // has actually committed and re-rendered the disabled button, letting both
  // calls race into `restoreFromDrive()` → `mergeMissingNotes()` at once.
  // `INSERT OR IGNORE` there stops a duplicate *note* row either way, but the
  // two calls' own fire-and-forget embedding passes would then both try to
  // embed the same newly-restored notes concurrently. A plain ref is
  // checked and set synchronously, with no such window — same fix shape as
  // every other duplicate-execution guard in this file.
  const isRestoringRef = useRef(false);
  const handleRestoreFromDrive = useCallback(() => {
    if (isRestoringRef.current) {
      return;
    }
    isRestoringRef.current = true;
    void (async () => {
      setIsRestoring(true);
      setError(null);
      try {
        if (!syncStatus.isConnected) {
          await signInWithGoogle();
        }
        const { message } = await restoreFromDrive();
        await refreshNotes();
        await refreshSyncStatus();
        Alert.alert("Vault Restored", message);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to restore from Google Drive.";
        setError(message);
        Alert.alert("Restore Failed", message);
      } finally {
        isRestoringRef.current = false;
        setIsRestoring(false);
      }
    })();
  }, [syncStatus.isConnected, refreshNotes, refreshSyncStatus]);

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
        await refreshNotes();
        showToast("Saved thought to memory");
        setHistoryTab("notes");
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
        // ASK flips the active tab to QA History so the streaming answer
        // is what's actually visible once the sheet reaches its 50%
        // auto-peek, rather than leaving Notes selected underneath it.
        setHistoryTab("qa");
        sheetRef.current?.snapToIndex(1);
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

  const finishUtterance = useCallback(
    async (
      audioUri: string,
      reportState?: (state: "processing" | "speaking") => void,
      options?: { isHandsfree?: boolean }
    ) => {
      if (await isAudioTooShort(audioUri)) {
        return;
      }
      const { transcript, whisperModelId } = await asrRouter.transcribe(audioUri);
      if (isSilentTranscript(transcript)) {
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
        showToast("Ignored — wake word \"Xayra\" not detected");
        return;
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
    },
    [routeFreeformInput, chatSession]
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

  const activeModeStopRef = useRef(activeMode.stop);
  activeModeStopRef.current = activeMode.stop;
  useFocusEffect(
    useCallback(() => {
      return () => {
        void activeModeStopRef.current();
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
        asrRouter.startListening();
        await recorder.startRecording();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed.");
    }
  }, [recorder, activeMode.isActive, finishUtterance]);

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

  const handleDeleteNote = useCallback((noteId: string) => {
    Alert.alert("Delete Note", "Are you sure you want to permanently delete this note?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void deleteNote(noteId)
            .then(() => setAllNotes((prev) => prev.filter((note) => note.id !== noteId)))
            .catch((err) => {
              const message = err instanceof Error ? err.message : "Failed to delete note.";
              setError(message);
              Alert.alert("Delete Error", message);
            });
        },
      },
    ]);
  }, []);

  useEffect(() => {
    if (!__DEV__) {
      return;
    }
    (globalThis as { __purgeAllNotes?: () => Promise<void> }).__purgeAllNotes = () =>
      purgeAllNotes().then(() => setAllNotes([]));
  }, []);

  const displayedNotes: DisplayNote[] = useMemo(
    () =>
      allNotes.map((note) => ({
        id: note.id,
        content: note.content,
        audioUri: note.audioUri,
        transcriptionModel: note.transcriptionModel,
        createdAt: note.createdAt,
      })),
    [allNotes]
  );

  const canvasState: RecorderCanvasState = recorder.isRecording
    ? "recording"
    : processingState === "processing"
      ? "transcribing"
      : "idle";

  const recordingStatusText = recorder.isRecording
    ? "Recording… tap to stop"
    : canvasState === "transcribing"
      ? processingLabel === "note"
        ? "Transcribing your thought..."
        : "Searching your thoughts..."
      : null;

  const handleSelectNote = useCallback((noteId: string) => setSelectedNoteId(noteId), []);
  const handleShowCitation = useCallback((noteId: string) => setSelectedNoteId(noteId), []);
  const handleSettingsPress = useCallback(() => router.push("/settings"), [router]);
  const handleInputFocus = useCallback(() => sheetRef.current?.snapToIndex(1), []);

  // Build 23 SYNCHRONIZE MODE PILLS WITH DRAWER TABS: tapping a mode pill
  // sets both the deterministic routing mode AND which drawer segment is
  // showing, in one action — Record -> "Recorded notes", Ask -> "Searched
  // notes". These were two independent state variables before (inputMode
  // drove routing, historyTab drove the drawer, only ever linked indirectly
  // through routeFreeformInput's own post-submission tab flip); this handler
  // is the single place that keeps them in lockstep the moment the pill
  // itself is tapped, before any submission happens at all.
  const handleSelectMode = useCallback((mode: "record" | "ask") => {
    setInputMode(mode);
    setHistoryTab(mode === "record" ? "notes" : "qa");
  }, []);

  // Build 29 fix: the Build 23 comment above claimed inputMode/historyTab
  // stayed "in lockstep the moment the pill itself is tapped" — true only
  // for the floating [Record|Ask] pill. HistorySheet's own drawer segment
  // pill ("Recorded notes"/"Searched notes") was wired straight to the raw
  // `setHistoryTab` setter, which flips which list is visible but leaves
  // `inputMode` — and with it the floating pill's highlighted state —
  // untouched. Concretely: tap the floating pill to "Record", then tap the
  // drawer's "Searched notes" segment to browse old Q&A; the drawer now
  // correctly shows QA history, but the floating pill still highlights
  // "Record", and the NEXT submission (compose bar or mic) would silently
  // try to save a note instead of asking a question — routeFreeformInput
  // only ever reads `inputMode`, which never moved. Mirrors handleSelectMode
  // in the other direction so BOTH pills — and the routing they drive —
  // move together regardless of which one the user actually taps.
  const handleHistoryTabChange = useCallback((tab: HistoryTab) => {
    setHistoryTab(tab);
    setInputMode(tab === "notes" ? "record" : "ask");
  }, []);

  const handleSubmitText = useCallback(
    (text: string) => {
      setInputText("");
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
        <Text style={styles.brandSubtitle}>
          Tap to record your thoughts, later bring back your memories by tapping Xayra....
        </Text>
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
          disabled={processingState === "processing" || recorder.isTransitioning}
        />
        {recordingStatusText && <Text style={styles.statusText}>{recordingStatusText}</Text>}
        {error && <Text style={styles.errorText}>{error}</Text>}
      </Animated.View>

      {/* Build 23 POSITION FLOATING PILLS: Handsfree + the Record/Ask mode
          pill float in a single right-aligned cluster directly above the
          bottom sheet drawer, tracking the sheet's live height (see
          drawerFloatingStackAnimatedStyle above) so it stays above the
          drawer at every snap index instead of only at the 20% rest peek. */}
      <Animated.View
        pointerEvents="box-none"
        style={[styles.drawerFloatingStack, { right: 24 }, drawerFloatingStackAnimatedStyle]}
      >
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

      <HistorySheet
        ref={sheetRef}
        historyTab={historyTab}
        onHistoryTabChange={handleHistoryTabChange}
        animatedIndex={sheetAnimatedIndex}
        sheetIndex={sheetIndex}
        onIndexChange={handleSheetIndexChange}
        modelDownload={chatSession.modelDownload}
        bottomInset={insets.bottom}
        composeBarSlot={
          <ComposeBar
            inputText={inputText}
            onInputChange={setInputText}
            onInputFocus={handleInputFocus}
            onSubmit={handleSubmitText}
            placeholder={inputMode === "record" ? "Type your thoughts..." : "Search your thoughts..."}
            onSettingsPress={handleSettingsPress}
          />
        }
        notesContent={
          <NotesSheetContent
            notes={displayedNotes}
            isSearchActive={false}
            onSelectNote={handleSelectNote}
            onDeleteNote={handleDeleteNote}
            isRestoring={isRestoring}
            onRestoreFromDrive={handleRestoreFromDrive}
            bottomInset={insets.bottom}
          />
        }
        qaContent={
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

      <NoteDetailModal
        noteId={selectedNoteId}
        visible={selectedNoteId !== null}
        onClose={() => setSelectedNoteId(null)}
        onDeleted={(noteId) => setAllNotes((prev) => prev.filter((note) => note.id !== noteId))}
      />
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
  // Order here is visual top-to-bottom: Handsfree, then the Record/Ask pill.
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
});
