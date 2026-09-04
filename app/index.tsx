import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Dimensions, Image, Keyboard, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import BottomSheet from "@gorhom/bottom-sheet";
import { useSharedValue } from "react-native-reanimated";

import { CentralRecorderCanvas, type RecorderCanvasState } from "../components/CentralRecorderCanvas";
import { ChatSheetContent } from "../components/ChatSheetContent";
import { ComposeBar } from "../components/ComposeBar";
import { HistorySheet, SHEET_SNAP_POINTS, type HistoryTab } from "../components/HistorySheet";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { NotesSheetContent, type DisplayNote } from "../components/NotesSheetContent";
import { showToast } from "../components/Toast";
import { asrRouter } from "../services/ai/asrRouter";
import { prewarmEngines } from "../services/ai/enginePrewarmer";
import { classifyIntent } from "../services/ai/intentRouter";
import { useChatSession } from "../services/ai/useChatSession";
import { useActiveMode, type ActiveModeUtteranceHandler } from "../services/audio/activeMode";
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

// Percentage snap points (SHEET_SNAP_POINTS = ['20%', '50%', '90%']) are the
// bottom sheet's own geometry; ComposeBar is a sibling rendered outside it
// (see that component's doc comment), so it needs an approximate pixel
// equivalent of the 20% resting point to float just below the sheet's drag
// handle rather than at an unrelated fixed offset. Approximate is fine —
// this only affects where an overlay sits relative to a sheet edge, not any
// data or gesture logic.
const SHEET_REST_HEIGHT_PX = Dimensions.get("window").height * 0.2;
/** ComposeBar's own row height + the drag-handle stub's hit area above it. */
const COMPOSE_BAR_TOP_OFFSET = 76;

/**
 * Unified, zero-friction Xayra canvas. There is no manual Record/Ask mode
 * toggle anymore — every submission (typed or spoken) is classified as
 * RECORD or ASK by services/ai/intentRouter.ts and routed automatically.
 * There is exactly one text-entry surface (ComposeBar, deliberately
 * rendered outside the bottom sheet — see its own doc comment for why) and
 * exactly one recording pipeline, shared by manual taps and Handsfree Mode.
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

  const handleRestoreFromDrive = useCallback(() => {
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
        setIsRestoring(false);
      }
    })();
  }, [syncStatus.isConnected, refreshNotes, refreshSyncStatus]);

  // ---- Unified intent routing --------------------------------------------
  //
  // Every submission — typed into ComposeBar, or spoken (manual tap or
  // Handsfree) — funnels through here. Nothing upstream decides RECORD vs
  // ASK anymore; classifyIntent() does, on the actual text, every time.

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
   * playing; see `ask`/`submitQuery`'s own distinction for that). */
  const routeFreeformInput = useCallback(
    async (text: string, audioUri: string | null, whisperModelId: string | null): Promise<{ intent: "RECORD" | "ASK" }> => {
      setProcessingState("processing");
      // Requirement 1: ASK auto-peeks to 50% to show the answer card;
      // RECORD snaps back to the resting peek once saved (see routeRecord).
      // Snapping to the halfway point immediately, before classification
      // even resolves, means the sheet is already moving instead of
      // sitting frozen during the (usually sub-second, but not free)
      // classification step.
      sheetRef.current?.snapToIndex(1);
      try {
        const intent = await classifyIntent(text);
        setProcessingLabel(intent === "RECORD" ? "note" : "query");
        if (intent === "RECORD") {
          await routeRecord(text, audioUri, whisperModelId);
        } else {
          // Requirement 2: ASK flips the active tab to QA History so the
          // streaming answer is what's actually visible once the sheet
          // reaches its 50% auto-peek, rather than leaving Notes selected
          // underneath it.
          setHistoryTab("qa");
          sheetRef.current?.snapToIndex(1);
          await chatSession.submitQuery(text, audioUri ? "voice" : "text");
        }
        return { intent };
      } finally {
        setProcessingState("idle");
        setProcessingLabel(null);
      }
    },
    [routeRecord, chatSession]
  );

  // ---- The single shared recording pipeline ------------------------------
  //
  // Both a manual tap on the center button AND Handsfree Mode's continuous
  // loop funnel through this exact function — see its own note on the
  // "Hey Xayra" gap below.

  const finishUtterance = useCallback(
    async (audioUri: string, reportState?: (state: "processing" | "speaking") => void) => {
      if (await isAudioTooShort(audioUri)) {
        return;
      }
      const { transcript, whisperModelId } = await asrRouter.transcribe(audioUri);
      if (isSilentTranscript(transcript)) {
        return;
      }

      reportState?.("processing");
      const { intent } = await routeFreeformInput(transcript.trim(), audioUri, whisperModelId ?? null);

      reportState?.("speaking");
      if (intent === "RECORD") {
        await speakTextAndWait("Saved.");
      } else {
        // Deliberately NOT chatSession's own (fire-and-forget) speech —
        // Handsfree Mode needs to actually wait for playback to finish
        // before ActiveModeManager re-arms the mic, or it would transcribe
        // the assistant's own voice as the next "question" (no echo
        // cancellation exists here). `ask()` runs the same RAG exchange
        // with no speech side effect of its own, so this is the only
        // speech that happens.
        const { text } = await chatSession.ask(transcript.trim());
        if (text) {
          await speakTextAndWait(text);
        }
      }
    },
    [routeFreeformInput, chatSession]
  );

  const handleRecordPress = useCallback(async () => {
    if (recorder.isTransitioning) {
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
        // Requirement 5 (carried over): tapping to start recording
        // collapses the sheet to its resting peek immediately.
        sheetRef.current?.snapToIndex(0);
        asrRouter.startListening();
        await recorder.startRecording();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed.");
    }
  }, [recorder, finishUtterance]);

  // ---- Handsfree Mode -----------------------------------------------------
  //
  // A REAL GAP, stated plainly: there is no "Hey Xayra" wake-word engine in
  // this codebase. Keyword-spotting (e.g. Porcupine, or a trained wake-word
  // model) is a separate, materially larger undertaking — a model asset, an
  // always-on low-power audio pipeline distinct from the full recorder —
  // that has NOT been built here. What Handsfree Mode actually is: the
  // 🎧 toggle below engages the existing continuous listen-until-silence
  // loop (services/audio/activeMode.ts) manually; once engaged, every
  // utterance it detects drives the exact same finishUtterance pipeline as
  // a manual tap, satisfying "the same pipeline for both triggers" without
  // the wake-word half.
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
        await finishUtterance(audioUri, reportState);
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
    void activeMode.toggle().catch((err) => {
      Alert.alert("Handsfree Error", err instanceof Error ? err.message : String(err));
    });
  }, [activeMode]);

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
      <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
        <View style={styles.brandRow}>
          {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
          <Image source={require("../assets/icon.png")} style={styles.brandLogo} resizeMode="contain" />
          <Text style={styles.brandTitle}>Xayra</Text>
          <View style={styles.headerSpacer} />
          <Pressable
            onPress={handleToggleHandsfree}
            style={[styles.handsfreeButton, activeMode.isActive && styles.handsfreeButtonActive]}
          >
            <Text style={styles.handsfreeButtonText}>
              🎧 {activeMode.isActive ? `Handsfree · ${activeMode.state}` : "Handsfree"}
            </Text>
          </Pressable>
        </View>
        <Text style={styles.brandSubtitle}>
          Tap to record your thoughts, later bring back your memories by tapping Xayra....
        </Text>
      </View>

      <View style={[styles.centerArea, { paddingBottom: 220 }]}>
        <CentralRecorderCanvas
          state={canvasState}
          amplitude={recorder.amplitude}
          onPress={() => void handleRecordPress()}
          onLongPress={handleLongPressCenterButton}
          disabled={processingState === "processing" || recorder.isTransitioning}
        />
        {recordingStatusText && <Text style={styles.statusText}>{recordingStatusText}</Text>}
        {error && <Text style={styles.errorText}>{error}</Text>}
      </View>

      <HistorySheet
        ref={sheetRef}
        historyTab={historyTab}
        onHistoryTabChange={setHistoryTab}
        animatedIndex={sheetAnimatedIndex}
        sheetIndex={sheetIndex}
        bottomInset={insets.bottom}
        onIndexChange={handleSheetIndexChange}
        notesContent={
          <NotesSheetContent
            notes={displayedNotes}
            isSearchActive={false}
            onSelectNote={handleSelectNote}
            onDeleteNote={handleDeleteNote}
            isRestoring={isRestoring}
            onRestoreFromDrive={handleRestoreFromDrive}
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
          />
        }
      />

      <ComposeBar
        inputText={inputText}
        onInputChange={setInputText}
        onInputFocus={handleInputFocus}
        onSubmit={handleSubmitText}
        onSettingsPress={handleSettingsPress}
        bottom={Math.max(insets.bottom + 8, SHEET_REST_HEIGHT_PX - COMPOSE_BAR_TOP_OFFSET)}
      />

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
  headerSpacer: {
    flex: 1,
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
  handsfreeButton: {
    backgroundColor: "rgba(28,28,30,0.7)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  handsfreeButtonActive: {
    backgroundColor: "rgba(99,102,241,0.35)",
    borderColor: "#6366F1",
  },
  handsfreeButtonText: {
    color: "#FFFFFF",
    fontSize: 12,
    fontWeight: "600",
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
});
