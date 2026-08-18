import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useFocusEffect } from "expo-router";
import * as Crypto from "expo-crypto";

import { CentralMicButton } from "../components/CentralMicButton";
import { NoteDetailModal } from "../components/NoteDetailModal";
import { ViewToggle } from "../components/ViewToggle";
import { asrRouter } from "../services/ai/asrRouter";
import { generateRAGAnswer, type RagCitation } from "../services/ai/rag";
import { useVoiceRecorder } from "../services/audio/recorder";
import { speakText, stopSpeech } from "../services/audio/tts";
import { isSilentTranscript } from "../services/notes/noteManager";

const colors = {
  background: "#0f172a",
  surface: "#1e293b",
  surfaceAlt: "#27324a",
  border: "#334155",
  textPrimary: "#f8fafc",
  textMuted: "#94a3b8",
  accent: "#6366f1",
  danger: "#f87171",
};

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
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const recorder = useVoiceRecorder();

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
      // Smart modality: a typed question gets a silent text answer; a
      // spoken question gets the answer read back aloud too.
      if (source === "voice") {
        playMessageSpeech({ id: assistantId, text: answer.text });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to get a response.";
      updateMessage(assistantId, {
        text: `Sorry, something went wrong: ${message}`,
        isStreaming: false,
      });
      Alert.alert("Chat Error", message);
    } finally {
      setIsSending(false);
    }
  }, [input, isSending, updateMessage, playMessageSpeech]);

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
          <Text style={styles.title}>Remi</Text>
          <Text style={styles.subtitle}>Ask questions about your voice notes.</Text>

          <ViewToggle active="chat" />

          <CentralMicButton
            state={isRecordingVoice ? "recording" : isTranscribingVoice ? "busy" : "idle"}
            onPress={handleMicPress}
            disabled={isSending || isTranscribingVoice || recorder.isTransitioning}
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
                <Text style={styles.bubbleText}>
                  {item.text}
                  {item.isStreaming && item.text.length === 0 ? "…" : ""}
                </Text>
                {item.isStreaming && item.text.length > 0 && (
                  <ActivityIndicator
                    style={styles.streamingIndicator}
                    color={colors.textMuted}
                    size="small"
                  />
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

          <View style={styles.inputBar}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask about your notes…"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              editable={!isSending && !isRecordingVoice && !isTranscribingVoice}
              multiline
              returnKeyType="send"
              onSubmitEditing={() => handleSend()}
            />
            <Pressable
              onPress={() => handleSend()}
              disabled={isSending || !input.trim()}
              style={({ pressed }) => [
                styles.sendButton,
                (isSending || !input.trim()) && styles.sendButtonDisabled,
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
    paddingHorizontal: 24,
    paddingTop: 32,
  },
  title: {
    color: colors.textPrimary,
    fontSize: 28,
    fontWeight: "700",
  },
  subtitle: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 4,
    marginBottom: 20,
  },
  messageList: {
    flex: 1,
  },
  emptyText: {
    color: colors.textMuted,
    fontSize: 14,
    marginTop: 24,
    textAlign: "center",
  },
  bubble: {
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginBottom: 10,
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
  bubbleText: {
    color: colors.textPrimary,
    fontSize: 15,
    lineHeight: 21,
  },
  streamingIndicator: {
    marginTop: 6,
    alignSelf: "flex-start",
  },
  speakerButton: {
    alignSelf: "flex-start",
    marginTop: 10,
  },
  speakerButtonText: {
    color: colors.accent,
    fontSize: 12,
    fontWeight: "600",
  },
  citationRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 10,
  },
  citationChip: {
    backgroundColor: colors.surfaceAlt,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  citationChipText: {
    color: colors.textMuted,
    fontSize: 12,
    fontWeight: "600",
  },
  voiceStatusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingBottom: 8,
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
    borderRadius: 999,
    paddingHorizontal: 10,
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
    gap: 10,
    paddingVertical: 12,
  },
  input: {
    flex: 1,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    color: colors.textPrimary,
    fontSize: 15,
    maxHeight: 120,
  },
  sendButton: {
    backgroundColor: colors.accent,
    borderRadius: 14,
    paddingHorizontal: 18,
    paddingVertical: 12,
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
    color: colors.textPrimary,
    fontSize: 14,
    fontWeight: "600",
  },
});
