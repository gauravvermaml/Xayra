import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Image, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import BottomSheet from "@gorhom/bottom-sheet";
import { useSharedValue } from "react-native-reanimated";

import { CentralRecorderCanvas, type RecorderCanvasState } from "../components/CentralRecorderCanvas";
import { ChatSheetContent, type ChatSheetContentHandle } from "../components/ChatSheetContent";
import { getSheetPeekHeight, HistorySheet } from "../components/HistorySheet";
import { ModeSwitcherPill, type SheetMode } from "../components/ModeSwitcherPill";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { NotesSheetContent, type DisplayNote } from "../components/NotesSheetContent";
import { asrRouter } from "../services/ai/asrRouter";
import { useActiveMode, type ActiveModeUtteranceHandler } from "../services/audio/activeMode";
import { isAudioTooShort } from "../services/audio/wav";
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakTextAndWait } from "../services/audio/tts";
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

/**
 * Unified Apple-Maps-style home screen. Notes and Chat are two *modes* of
 * the same jet-black canvas + sticky search sheet, switched via the floating
 * [Notes | Chat] pill. There is deliberately only ONE recording pipeline
 * (below) and ONE text-entry surface (the sheet's header compose bar —
 * see HistorySheet) shared by both modes.
 */
export default function HomeScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const recorder = useVoiceRecorder();

  const [mode, setMode] = useState<SheetMode>("notes");
  const modeRef = useRef(mode);
  modeRef.current = mode;

  const [inputText, setInputText] = useState("");
  const [allNotes, setAllNotes] = useState<Note[]>([]);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [processingState, setProcessingState] = useState<"idle" | "processing">("idle");
  const [isTranscribingChatVoice, setIsTranscribingChatVoice] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>({ isConnected: false });
  const [isRestoring, setIsRestoring] = useState(false);

  const sheetRef = useRef<BottomSheet>(null);
  const chatContentRef = useRef<ChatSheetContentHandle>(null);
  const sheetAnimatedIndex = useSharedValue(0);

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

  // ---- The single shared recording pipeline ---------------------------
  //
  // Both a manual tap on the center button AND Active Mode's hands-free
  // loop (long-press to engage — see the note on that below) funnel through
  // the exact same two branches: "finished an utterance in Notes mode" save
  // it as a note; "finished an utterance in Chat mode" ask it as a question.
  // Neither path is special-cased relative to the other. Both also share the
  // same BLANK AUDIO & SILENCE GUARD: a too-short recording, or a transcript
  // Whisper itself flags as blank/silent, is discarded before it ever
  // reaches a note row or a chat bubble — nothing is created, nothing is
  // sent to Llama, and the UI just resets to idle as if nothing happened.

  const finishNotesUtterance = useCallback(
    async (audioUri: string) => {
      if (await isAudioTooShort(audioUri)) {
        return;
      }
      const { transcript, whisperModelId } = await asrRouter.transcribe(audioUri);
      if (isSilentTranscript(transcript)) {
        return;
      }
      try {
        const note = await createVoiceNote(audioUri, transcript, whisperModelId ?? null);
        await refreshNotes();
        if (note.status !== "embedded") {
          setError(null);
        }
      } catch (err) {
        // createVoiceNote's own near-empty-file guard (EmptyRecordingError)
        // and its post-transcribe silence check (SilentRecordingError) are
        // both "there was nothing here," not a real failure — same silent
        // discard as the checks above, not an alert.
        if (!(err instanceof EmptyRecordingError) && !(err instanceof SilentRecordingError)) {
          throw err;
        }
      }
    },
    [refreshNotes]
  );

  const finishChatUtterance = useCallback(async (audioUri: string) => {
    if (await isAudioTooShort(audioUri)) {
      return;
    }
    const { transcript } = await asrRouter.transcribe(audioUri);
    if (isSilentTranscript(transcript)) {
      return;
    }
    await chatContentRef.current?.submitQuery(transcript.trim(), "voice");
  }, []);

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
        setProcessingState("processing");
        try {
          if (modeRef.current === "notes") {
            await finishNotesUtterance(audioUri);
          } else {
            setIsTranscribingChatVoice(true);
            await finishChatUtterance(audioUri);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
          Alert.alert("Recording Error", message);
        } finally {
          setProcessingState("idle");
          setIsTranscribingChatVoice(false);
        }
      } else {
        // Requirement 5: tapping to start recording collapses the sheet to
        // its peek height immediately, putting full attention on the
        // waveform rather than whatever was scrolled/expanded a moment ago.
        sheetRef.current?.snapToIndex(0);
        asrRouter.startListening();
        await recorder.startRecording();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Recording failed.");
    }
  }, [recorder, finishNotesUtterance, finishChatUtterance]);

  // Active/hands-free Mode: a long-press on the center button (see
  // CentralRecorderCanvas's onLongPress below) engages the SAME continuous
  // listen-until-silence loop already built for this app (services/audio/
  // activeMode.ts), rather than a dedicated "Handsfree Mode" toggle button —
  // there is deliberately no such button rendered anywhere on this screen.
  //
  // Worth being explicit about a real gap: this is NOT wake-word ("Hey
  // Xayra") activation. No keyword-spotting engine (e.g. Porcupine, a
  // trained wake-word model) exists in this codebase, and building one is a
  // separate, materially larger undertaking than everything else in this
  // redesign combined — it has NOT been implemented here. What IS wired end
  // to end: once engaged (by long-press), the mic stays open, auto-segments
  // on silence (VAD), and each finished utterance drives the exact same
  // finishNotesUtterance/finishChatUtterance pipeline as a manual tap —
  // satisfying the "manual tap and hands-free trigger the same pipeline"
  // half of the requirement without the wake-word half.
  const handleActiveModeUtterance: ActiveModeUtteranceHandler = useCallback(
    async (audioUri, reportState) => {
      try {
        if (modeRef.current === "notes") {
          await finishNotesUtterance(audioUri);
          reportState("speaking");
          await speakTextAndWait("Saved.");
        } else {
          await finishChatUtterance(audioUri);
          reportState("speaking");
        }
      } catch (err) {
        console.error("[ActiveMode] Failed to handle utterance", err);
      }
    },
    [finishNotesUtterance, finishChatUtterance]
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

  const handleLongPressCenterButton = useCallback(() => {
    sheetRef.current?.snapToIndex(0);
    void activeMode.toggle().catch((err) => {
      Alert.alert("Hands-free Error", err instanceof Error ? err.message : String(err));
    });
  }, [activeMode]);

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
    // Dev-only convenience, not user-facing UI on this screen anymore —
    // exposed as a global so it's still reachable from the debugger console
    // during development without a permanent button cluttering the canvas.
    (globalThis as { __purgeAllNotes?: () => Promise<void> }).__purgeAllNotes = () =>
      purgeAllNotes().then(() => setAllNotes([]));
  }, []);

  // The header compose bar is now a submit-only surface (see HistorySheet) —
  // typing no longer live-filters this list, so every note is shown.
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
    : processingState === "processing" || isTranscribingChatVoice
      ? "transcribing"
      : "idle";

  const recordingStatusText = recorder.isRecording
    ? mode === "notes"
      ? "Recording… tap to stop"
      : "Listening for your question…"
    : canvasState === "transcribing"
      ? mode === "notes"
        ? "Saving voice note…"
        : "Transcribing your question…"
      : null;

  const handleSelectNote = useCallback((noteId: string) => setSelectedNoteId(noteId), []);
  const handleShowCitation = useCallback((noteId: string) => setSelectedNoteId(noteId), []);
  const handleSettingsPress = useCallback(() => router.push("/settings"), [router]);
  const handleInputFocus = useCallback(() => sheetRef.current?.snapToIndex(1), []);

  // The header compose bar's up-arrow submit — Notes mode saves a text note
  // directly (no recording involved), Chat mode asks it as a question, same
  // as a voice query would. Either way this is the ONLY text-entry surface
  // left in the app; the old per-mode input bars are gone.
  const handleSubmitText = useCallback(
    (text: string) => {
      setInputText("");
      if (modeRef.current === "notes") {
        void createTextNote(text)
          .then(() => refreshNotes())
          .catch((err) => {
            const message = err instanceof Error ? err.message : "Failed to save note.";
            setError(message);
            Alert.alert("Save Failed", message);
          });
      } else {
        void chatContentRef.current?.submitQuery(text, "text");
      }
    },
    [refreshNotes]
  );

  return (
    <View style={styles.canvas}>
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

      <View style={[styles.centerArea, { paddingBottom: getSheetPeekHeight(insets.bottom) + 24 }]}>
        <CentralRecorderCanvas
          state={canvasState}
          amplitude={recorder.amplitude}
          onPress={() => void handleRecordPress()}
          onLongPress={handleLongPressCenterButton}
          disabled={processingState === "processing" || recorder.isTransitioning}
        />
        {recordingStatusText && <Text style={styles.statusText}>{recordingStatusText}</Text>}
        {activeMode.isActive && <Text style={styles.activeModeText}>Hands-free · {activeMode.state}</Text>}
        {error && <Text style={styles.errorText}>{error}</Text>}
      </View>

      <ModeSwitcherPill
        mode={mode}
        onChange={setMode}
        sheetAnimatedIndex={sheetAnimatedIndex}
        bottomOffset={getSheetPeekHeight(insets.bottom) + 12}
      />

      <HistorySheet
        ref={sheetRef}
        mode={mode}
        inputText={inputText}
        onInputChange={setInputText}
        onInputFocus={handleInputFocus}
        onSubmit={handleSubmitText}
        onSettingsPress={handleSettingsPress}
        animatedIndex={sheetAnimatedIndex}
        bottomInset={insets.bottom}
      >
        {mode === "notes" ? (
          <NotesSheetContent
            notes={displayedNotes}
            isSearchActive={false}
            onSelectNote={handleSelectNote}
            onDeleteNote={handleDeleteNote}
            isRestoring={isRestoring}
            onRestoreFromDrive={handleRestoreFromDrive}
          />
        ) : (
          <ChatSheetContent ref={chatContentRef} onShowCitation={handleShowCitation} />
        )}
      </HistorySheet>

      <NoteDetailModal
        noteId={selectedNoteId}
        visible={selectedNoteId !== null}
        onClose={() => setSelectedNoteId(null)}
        onDeleted={(noteId) => setAllNotes((prev) => prev.filter((note) => note.id !== noteId))}
      />
    </View>
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
  activeModeText: {
    color: "rgba(99,102,241,0.9)",
    fontSize: 12,
    fontWeight: "600",
  },
  errorText: {
    color: "#F87171",
    fontSize: 12,
    textAlign: "center",
    paddingHorizontal: 32,
  },
});
