import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect, useRouter } from "expo-router";
import * as Crypto from "expo-crypto";

import { ActiveModePill } from "../components/ActiveModePill";
import { CentralMicButton } from "../components/CentralMicButton";
import { MarkdownText } from "../components/MarkdownText";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { ViewToggle } from "../components/ViewToggle";
import { colors, radius, spacing, typography } from "../constants/theme";
import { asrRouter } from "../services/ai/asrRouter";
import { downloadLlamaModel, LLAMA_MODEL_SIZE_LABEL } from "../services/ai/llamaModel";
import { LLAMA_MODEL_MISSING_ERROR_PREFIX } from "../services/ai/localLlama";
import { generateRAGAnswer, type RagCitation } from "../services/ai/rag";
import { useActiveMode, type ActiveModeUtteranceHandler } from "../services/audio/activeMode";
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakText, speakTextAndWait, stopSpeech } from "../services/audio/tts";
import { isSilentTranscript } from "../services/notes/noteManager";

/** Blinking "▋" cursor shown at the end of a message still streaming in
 * from local Llama — a quiet visual cue that generation is live, not stalled. */
function StreamingCursor({ color }: { color: string }) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.Text style={{ color, opacity }}>{"▋"}</Animated.Text>;
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: RagCitation[];
  isStreaming?: boolean;
};

function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

export default function ChatScreen() {
  const router = useRouter();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [chatModelMissing, setChatModelMissing] = useState(false);
  const [isDownloadingChatModel, setIsDownloadingChatModel] = useState(false);
  const [chatModelDownloadProgress, setChatModelDownloadProgress] = useState(0);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const recorder = useVoiceRecorder();

  const isChatModelMissingError = useCallback(
    (err: unknown) => err instanceof Error && err.message.startsWith(LLAMA_MODEL_MISSING_ERROR_PREFIX),
    []
  );

  const handleDownloadChatModel = useCallback(async () => {
    setIsDownloadingChatModel(true);
    setChatModelDownloadProgress(0);
    try {
      await downloadLlamaModel(setChatModelDownloadProgress);
      setChatModelMissing(false);
    } catch (err) {
      Alert.alert("Download Failed", err instanceof Error ? err.message : "Failed to download the chat model.");
    } finally {
      setIsDownloadingChatModel(false);
    }
  }, []);

  // Derived, not duplicated: recorder.isRecording is already the source of
  // truth for whether we're actively recording a voice query.
  const isRecordingVoice = recorder.isRecording;

  // Ticks a mm:ss counter while recording; recorder itself doesn't expose
  // elapsed time, so this is a plain 1s interval gated on isRecordingVoice.
  useEffect(() => {
    if (!isRecordingVoice) {
      setRecordingDuration(0);
      return;
    }
    const intervalId = setInterval(() => {
      setRecordingDuration((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(intervalId);
  }, [isRecordingVoice]);

  // Always read the latest recorder from a ref inside the focus-effect
  // cleanup below, rather than depending on `recorder` directly — the hook
  // returns a new object every render, which would otherwise re-run the
  // focus effect (and its cleanup) on every render instead of only on
  // blur/unmount.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;

  // Stops any in-progress recording, and any in-progress TTS narration, if
  // the user switches to the Notes tab (or otherwise navigates away) —
  // instead of leaving the native recording session dangling or having the
  // assistant keep talking on a screen that's no longer visible.
  useFocusEffect(
    useCallback(() => {
      return () => {
        if (recorderRef.current.isRecording) {
          asrRouter.cancelListening();
          void recorderRef.current.stopRecording();
        }
        void stopSpeech();
      };
    }, [])
  );

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === id ? { ...message, ...patch } : message))
    );
  }, []);

  const handleShowCitation = useCallback((citation: RagCitation) => {
    setSelectedNoteId(citation.noteId);
  }, []);

  // Shared by auto-read-on-completion and the manual speaker-button replay,
  // so both agree on how `speakingMessageId` gets set/cleared. Guards each
  // callback against a stale close-over: if the user replays a different
  // message before this one's utterance naturally finishes, `onDone`/
  // `onStopped` firing late shouldn't clear the *new* message's speaking state.
  const playMessageSpeech = useCallback((message: Pick<ChatMessage, "id" | "text">) => {
    setSpeakingMessageId(message.id);
    const clearIfCurrent = () =>
      setSpeakingMessageId((current) => (current === message.id ? null : current));
    void speakText(message.text, {
      onDone: clearIfCurrent,
      onStopped: clearIfCurrent,
      onError: clearIfCurrent,
    });
  }, []);

  const handleToggleSpeech = useCallback(
    (message: ChatMessage) => {
      if (speakingMessageId === message.id) {
        void stopSpeech();
        setSpeakingMessageId(null);
      } else {
        playMessageSpeech(message);
      }
    },
    [speakingMessageId, playMessageSpeech]
  );

  // Shared by the manual send flow and Active Mode: adds the user/assistant
  // message pair, streams the RAG answer in, and updates the assistant
  // message with either the final answer or an error string. Throws after
  // recording the error message, so callers can each decide how to surface
  // the failure (Alert for the manual flow, silent log for Active Mode).
  const runRagExchange = useCallback(
    async (query: string): Promise<{ assistantId: string; text: string }> => {
      const userMessage: ChatMessage = {
        id: Crypto.randomUUID(),
        role: "user",
        text: query,
      };
      const assistantId = Crypto.randomUUID();
      const assistantMessage: ChatMessage = {
        id: assistantId,
        role: "assistant",
        text: "",
        isStreaming: true,
      };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);

      try {
        const answer = await generateRAGAnswer(query, (chunk) => {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantId
                ? { ...message, text: message.text + chunk }
                : message
            )
          );
        });
        updateMessage(assistantId, {
          text: answer.text,
          citations: answer.citations,
          isStreaming: false,
        });
        return { assistantId, text: answer.text };
      } catch (err) {
        if (isChatModelMissingError(err)) {
          setChatModelMissing(true);
          updateMessage(assistantId, {
            text: "The on-device chat model isn't downloaded yet — see the prompt below to get started.",
            isStreaming: false,
          });
          throw err;
        }
        const message = err instanceof Error ? err.message : "Failed to get a response.";
        updateMessage(assistantId, {
          text: `Sorry, something went wrong: ${message}`,
          isStreaming: false,
        });
        throw err;
      }
    },
    [updateMessage, isChatModelMissingError]
  );

  const handleSend = useCallback(async (overrideText?: string, source: "text" | "voice" = "text") => {
    const query = (overrideText ?? input).trim();
    if (!query || isSending) {
      return;
    }

    // A new question always interrupts whatever the assistant was reading
    // out loud from a previous answer.
    void stopSpeech();
    setSpeakingMessageId(null);

    // Only clear the typed draft when actually sending it — a voice query
    // (overrideText) shouldn't wipe out whatever the user had typed.
    if (overrideText === undefined) {
      setInput("");
    }
    setIsSending(true);

    try {
      const { assistantId, text } = await runRagExchange(query);
      // Smart modality: a typed question gets a silent text answer; a
      // spoken question gets the answer read back aloud too.
      if (source === "voice") {
        playMessageSpeech({ id: assistantId, text });
      }
    } catch (err) {
      if (!isChatModelMissingError(err)) {
        Alert.alert("Chat Error", err instanceof Error ? err.message : "Failed to get a response.");
      }
    } finally {
      setIsSending(false);
    }
  }, [input, isSending, runRagExchange, playMessageSpeech, isChatModelMissingError]);

  // Active/"Shower" Mode's per-utterance handler: transcribe, run the RAG
  // exchange (which already appends it to the visible chat transcript),
  // then speak the answer and — critically — actually wait for the speech
  // to finish before returning, so ActiveModeManager doesn't re-arm the mic
  // while the assistant is still talking (no echo cancellation exists here,
  // so the mic would otherwise transcribe the app's own voice as the next
  // "question"). Errors are logged, not Alert'd, for the same
  // don't-interrupt-a-hands-free-loop reason as the Notes tab.
  const handleActiveModeUtterance: ActiveModeUtteranceHandler = useCallback(
    async (audioUri, reportState) => {
      try {
        const { transcript } = await asrRouter.transcribe(audioUri);
        if (isSilentTranscript(transcript)) {
          return;
        }
        const { text } = await runRagExchange(transcript.trim());
        reportState("speaking");
        await speakTextAndWait(text);
      } catch (err) {
        console.error("[ActiveMode] Failed to answer", err);
      }
    },
    [runRagExchange]
  );
  const activeMode = useActiveMode(handleActiveModeUtterance);

  const handleToggleActiveMode = useCallback(() => {
    void activeMode.toggle().catch((err) => {
      Alert.alert("Active Mode Error", err instanceof Error ? err.message : String(err));
    });
  }, [activeMode]);

  // useActiveMode's own unmount cleanup already stops the manager, but this
  // mirrors the recorder/TTS focus-loss cleanup above for the same reason:
  // don't leave a hands-free mic session dangling if focus is lost without
  // an immediate unmount.
  const activeModeStopRef = useRef(activeMode.stop);
  activeModeStopRef.current = activeMode.stop;
  useFocusEffect(
    useCallback(() => {
      return () => {
        void activeModeStopRef.current();
      };
    }, [])
  );

  const handleMicPress = useCallback(async () => {
    if (recorder.isTransitioning) {
      return;
    }

    if (recorder.isRecording) {
      const uri = await recorder.stopRecording();
      if (!uri) {
        return;
      }

      setIsTranscribingVoice(true);
      try {
        const { transcript } = await asrRouter.transcribe(uri);
        if (isSilentTranscript(transcript)) {
          Alert.alert(
            "No Speech Detected",
            "We couldn't hear anything in that recording. Please try again."
          );
          return;
        }
        await handleSend(transcript.trim(), "voice");
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to transcribe your question.";
        Alert.alert("Transcription Error", message);
      } finally {
        setIsTranscribingVoice(false);
      }
    } else {
      // A voice question and TTS narration should never overlap.
      void stopSpeech();
      setSpeakingMessageId(null);
      asrRouter.startListening();
      // recorder.startRecording() already alerts internally on failure
      // (permissions denied, native error, etc.) — nothing extra needed here.
      await recorder.startRecording().catch(() => {});
    }
  }, [recorder, handleSend]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "android" ? "height" : "padding"}
        keyboardVerticalOffset={12}
      >
        <View style={styles.container}>
          <View style={styles.headerRow}>
            <View style={styles.headerTextGroup}>
              <View style={styles.brandRow}>
                {/* eslint-disable-next-line @typescript-eslint/no-require-imports */}
                <Image source={require("../assets/icon.png")} style={styles.brandLogo} resizeMode="contain" />
                <Text style={styles.title}>Xayra</Text>
              </View>
              <Text style={styles.subtitle}>Ask questions about your voice notes.</Text>
            </View>
            <Pressable
              onPress={() => router.push("/settings")}
              hitSlop={12}
              style={({ pressed }) => [styles.settingsButton, pressed && styles.settingsButtonPressed]}
            >
              <Text style={styles.settingsButtonIcon}>⚙</Text>
            </Pressable>
          </View>

          <ViewToggle active="chat" />

          <ActiveModePill
            isActive={activeMode.isActive}
            state={activeMode.state}
            onPress={handleToggleActiveMode}
            disabled={isRecordingVoice || recorder.isTransitioning}
          />

          <CentralMicButton
            state={isRecordingVoice ? "recording" : isTranscribingVoice ? "busy" : "idle"}
            onPress={handleMicPress}
            disabled={isSending || isTranscribingVoice || recorder.isTransitioning || activeMode.isActive}
          />

          <FlatList
            ref={listRef}
            style={styles.messageList}
            data={messages}
            keyExtractor={(item) => item.id}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
            ListEmptyComponent={
              <Text style={styles.emptyText}>
                Ask anything — answers are grounded in your recorded notes.
              </Text>
            }
            renderItem={({ item }) => (
              <View
                style={[
                  styles.bubble,
                  item.role === "user" ? styles.bubbleUser : styles.bubbleAssistant,
                ]}
              >
                <Text style={styles.roleLabel}>{item.role === "user" ? "You" : "Xayra"}</Text>
                {item.isStreaming && item.text.length === 0 ? (
                  <View style={styles.streamingStartRow}>
                    <ActivityIndicator color={colors.textMuted} size="small" />
                    <Text style={styles.streamingStartText}>Thinking…</Text>
                  </View>
                ) : (
                  <View style={styles.bubbleTextWrap}>
                    <MarkdownText
                      text={item.text}
                      color={item.role === "user" ? colors.onAccent : colors.textPrimary}
                    />
                    {item.isStreaming && (
                      <StreamingCursor
                        color={item.role === "user" ? colors.onAccent : colors.accent}
                      />
                    )}
                  </View>
                )}
                {item.role === "assistant" && !item.isStreaming && item.text.length > 0 && (
                  <Pressable
                    onPress={() => handleToggleSpeech(item)}
                    style={styles.speakerButton}
                  >
                    <Text style={styles.speakerButtonText}>
                      {speakingMessageId === item.id ? "⏹ Stop" : "🔊 Listen"}
                    </Text>
                  </Pressable>
                )}
                {!!item.citations?.length && (
                  <View style={styles.citationRow}>
                    {item.citations.map((citation) => (
                      <Pressable
                        key={citation.noteId}
                        onPress={() => handleShowCitation(citation)}
                        style={styles.citationChip}
                      >
                        <Text style={styles.citationChipText}>[Note {citation.index}]</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            )}
          />

          {(isRecordingVoice || isTranscribingVoice) && (
            <View style={styles.voiceStatusRow}>
              <View style={styles.voiceStatusDot} />
              <Text style={styles.voiceStatusText}>
                {isRecordingVoice
                  ? `Listening… ${formatDuration(recordingDuration)}`
                  : "Transcribing your question…"}
              </Text>
              {isRecordingVoice && (
                <Pressable
                  onPress={() => {
                    asrRouter.restartListening();
                    void recorder.cancelAndRestart();
                    setRecordingDuration(0);
                  }}
                  disabled={recorder.isTransitioning}
                  style={styles.resetButton}
                >
                  <Text style={styles.resetButtonText}>Reset</Text>
                </Pressable>
              )}
            </View>
          )}

          {chatModelMissing && (
            <View style={styles.chatModelPrompt}>
              <Text style={styles.chatModelPromptTitle}>Chat model not downloaded</Text>
              <Text style={styles.chatModelPromptBody}>
                Answering questions needs the on-device Llama chat model ({LLAMA_MODEL_SIZE_LABEL}, one-time
                download).
              </Text>
              {isDownloadingChatModel ? (
                <View style={styles.chatModelProgressWrap}>
                  <View style={styles.chatModelProgressTrack}>
                    <View
                      style={[
                        styles.chatModelProgressFill,
                        { width: `${Math.round(chatModelDownloadProgress * 100)}%` },
                      ]}
                    />
                  </View>
                  <Text style={styles.chatModelProgressLabel}>
                    {Math.round(chatModelDownloadProgress * 100)}%
                  </Text>
                </View>
              ) : (
                <Pressable onPress={() => void handleDownloadChatModel()} style={styles.chatModelDownloadButton}>
                  <Text style={styles.chatModelDownloadButtonText}>Download Chat Model</Text>
                </Pressable>
              )}
            </View>
          )}

          <View style={styles.inputBar}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask about your notes…"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              editable={!isSending && !isRecordingVoice && !isTranscribingVoice && !activeMode.isActive}
              multiline
              returnKeyType="send"
              onSubmitEditing={() => handleSend()}
            />
            <Pressable
              onPress={() => handleSend()}
              disabled={isSending || !input.trim() || activeMode.isActive}
              style={({ pressed }) => [
                styles.sendButton,
                (isSending || !input.trim() || activeMode.isActive) && styles.sendButtonDisabled,
                pressed && styles.sendButtonPressed,
              ]}
            >
              {isSending ? (
                <ActivityIndicator color={colors.textPrimary} size="small" />
              ) : (
                <Text style={styles.sendButtonText}>Send</Text>
              )}
            </Pressable>
          </View>
        </View>
      </KeyboardAvoidingView>

      <NoteDetailModal
        noteId={selectedNoteId}
        visible={selectedNoteId !== null}
        onClose={() => setSelectedNoteId(null)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: colors.background,
  },
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl,
  },
  headerRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    justifyContent: "space-between",
  },
  headerTextGroup: {
    flex: 1,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  brandLogo: {
    width: 28,
    height: 28,
    borderRadius: radius.sm,
  },
  settingsButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.md,
  },
  settingsButtonPressed: {
    backgroundColor: colors.surfaceElevated,
  },
  settingsButtonIcon: {
    color: colors.textSecondary,
    fontSize: 17,
  },
  title: {
    color: colors.textPrimary,
    ...typography.title,
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
    marginBottom: spacing.lg,
  },
  messageList: {
    flex: 1,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: spacing.xl,
    textAlign: "center",
    paddingHorizontal: spacing.lg,
  },
  bubble: {
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm + 2,
    marginBottom: spacing.sm + 2,
    maxWidth: "88%",
  },
  bubbleUser: {
    backgroundColor: colors.accent,
    alignSelf: "flex-end",
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    alignSelf: "flex-start",
    borderBottomLeftRadius: 4,
  },
  roleLabel: {
    color: colors.textMuted,
    fontSize: 10,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.6,
    marginBottom: 3,
  },
  bubbleTextWrap: {
    // Block container for MarkdownText's mix of Text/View children plus the
    // trailing streaming cursor — must be a View, not Text, since Markdown
    // bullets/code blocks render as Views and can't nest inside RN <Text>.
  },
  streamingStartRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  streamingStartText: {
    color: colors.textMuted,
    fontSize: 13,
    fontStyle: "italic",
  },
  speakerButton: {
    alignSelf: "flex-start",
    marginTop: spacing.sm + 2,
  },
  speakerButtonText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "600",
  },
  citationRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs + 2,
    marginTop: spacing.sm + 2,
  },
  citationChip: {
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
  },
  citationChipText: {
    color: colors.textSecondary,
    fontSize: 12,
    fontWeight: "600",
  },
  voiceStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingBottom: spacing.sm,
  },
  voiceStatusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: colors.danger,
  },
  voiceStatusText: {
    color: colors.danger,
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
  },
  resetButton: {
    borderColor: colors.danger,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    marginLeft: "auto",
  },
  resetButtonText: {
    color: colors.danger,
    fontSize: 12,
    fontWeight: "700",
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.base - 2,
    paddingVertical: spacing.sm + 2,
    color: colors.textPrimary,
    fontSize: 15,
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.lg - 2,
    paddingVertical: spacing.md,
    alignItems: "center",
    justifyContent: "center",
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
  sendButtonPressed: {
    opacity: 0.85,
  },
  sendButtonText: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: "600",
  },
  chatModelPrompt: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.lg,
    padding: spacing.base,
    marginBottom: spacing.sm,
  },
  chatModelPromptTitle: {
    color: colors.textPrimary,
    ...typography.heading,
    marginBottom: spacing.xs,
  },
  chatModelPromptBody: {
    color: colors.textMuted,
    fontSize: 13,
    marginBottom: spacing.md,
  },
  chatModelDownloadButton: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  chatModelDownloadButtonText: {
    color: colors.onAccent,
    fontSize: 14,
    fontWeight: "700",
  },
  chatModelProgressWrap: {
    marginBottom: spacing.xs,
  },
  chatModelProgressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.surfaceElevated,
    overflow: "hidden",
  },
  chatModelProgressFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  chatModelProgressLabel: {
    color: colors.textMuted,
    ...typography.caption,
    marginTop: spacing.xs,
    textAlign: "right",
  },
});
