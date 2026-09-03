import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ActivityIndicator, Alert, Animated, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import * as Crypto from "expo-crypto";

import { MarkdownText } from "./MarkdownText";
import { colors, radius, spacing, typography } from "../constants/theme";
import { LLAMA_MODEL_MISSING_ERROR_PREFIX } from "../services/ai/localLlama";
import { allowCellularDownloadAndResume, resumeDownloads, useModelDownload } from "../services/ai/modelDownloadManager";
import { generateRAGAnswer, type RagCitation } from "../services/ai/rag";
import { speakText, stopSpeech } from "../services/audio/tts";
import { copyTextWithFeedback } from "../utils/clipboard";

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

/** How often buffered streaming tokens are flushed into visible state — 80ms
 * is frequent enough that the text still reads as a smooth live stream, but
 * coalesces what would otherwise be many dozens of per-token re-renders per
 * second into ~12 batched ones. */
const STREAM_FLUSH_INTERVAL_MS = 80;

/** Shown above the input box only before the first message of a session. */
const STARTER_PROMPTS = ["Summarize my latest notes", "What did I record about work?", "List my recent tasks"] as const;

export type ChatSheetContentHandle = {
  /** Feeds a voice-transcribed question through the same send pipeline as
   * typing + tapping Send — called by the shell (app/index.tsx) after the
   * shared center-button recording pipeline transcribes a query while Chat
   * mode is active. Also speaks the answer back, since a spoken question
   * getting a silent text-only answer would be a broken hands-free loop. */
  submitVoiceQuery: (transcript: string) => Promise<void>;
};

export type ChatSheetContentProps = {
  onShowCitation: (noteId: string) => void;
  /** Whether the model-setup status card / starter chips should treat a
   * question as sendable right now — surfaced so the shell can also gate
   * the center button (no point starting a voice question the model isn't
   * ready to answer). */
  onModelReadyChange?: (isReady: boolean) => void;
};

export const ChatSheetContent = forwardRef<ChatSheetContentHandle, ChatSheetContentProps>(function ChatSheetContent(
  { onShowCitation, onModelReadyChange },
  ref
) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const listRef = useRef<React.ElementRef<typeof BottomSheetFlatList<ChatMessage>>>(null);

  const modelDownload = useModelDownload();
  const isModelReady = modelDownload.status === "ready";

  useEffect(() => {
    onModelReadyChange?.(isModelReady);
  }, [isModelReady, onModelReadyChange]);

  const isChatModelMissingError = useCallback(
    (err: unknown) => err instanceof Error && err.message.startsWith(LLAMA_MODEL_MISSING_ERROR_PREFIX),
    []
  );

  const handleAllowCellularDownload = useCallback(() => {
    void allowCellularDownloadAndResume().catch((err) => {
      Alert.alert("Download Failed", err instanceof Error ? err.message : "Failed to start the download.");
    });
  }, []);

  const handleResumeDownload = useCallback(() => {
    void resumeDownloads().catch((err) => {
      Alert.alert("Resume Failed", err instanceof Error ? err.message : "Failed to resume the download.");
    });
  }, []);

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }, []);

  const playMessageSpeech = useCallback((message: Pick<ChatMessage, "id" | "text">) => {
    setSpeakingMessageId(message.id);
    const clearIfCurrent = () => setSpeakingMessageId((current) => (current === message.id ? null : current));
    void speakText(message.text, { onDone: clearIfCurrent, onStopped: clearIfCurrent, onError: clearIfCurrent });
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

  const runRagExchange = useCallback(
    async (query: string): Promise<{ assistantId: string; text: string }> => {
      const userMessage: ChatMessage = { id: Crypto.randomUUID(), role: "user", text: query };
      const assistantId = Crypto.randomUUID();
      const assistantMessage: ChatMessage = { id: assistantId, role: "assistant", text: "", isStreaming: true };
      setMessages((prev) => [...prev, userMessage, assistantMessage]);

      let pendingText = "";
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      const flushPendingText = () => {
        flushTimer = null;
        if (!pendingText) {
          return;
        }
        const textToAppend = pendingText;
        pendingText = "";
        setMessages((prev) =>
          prev.map((message) => (message.id === assistantId ? { ...message, text: message.text + textToAppend } : message))
        );
      };

      try {
        const answer = await generateRAGAnswer(query, (chunk) => {
          pendingText += chunk;
          if (!flushTimer) {
            flushTimer = setTimeout(flushPendingText, STREAM_FLUSH_INTERVAL_MS);
          }
        });
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        updateMessage(assistantId, { text: answer.text, citations: answer.citations, isStreaming: false });
        return { assistantId, text: answer.text };
      } catch (err) {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (isChatModelMissingError(err)) {
          updateMessage(assistantId, {
            text: "The on-device chat model isn't downloaded yet — Xayra downloads it automatically over Wi-Fi.",
            isStreaming: false,
          });
          throw err;
        }
        const message = err instanceof Error ? err.message : "Failed to get a response.";
        updateMessage(assistantId, { text: `Sorry, something went wrong: ${message}`, isStreaming: false });
        throw err;
      }
    },
    [updateMessage, isChatModelMissingError]
  );

  const handleSend = useCallback(
    async (overrideText?: string, source: "text" | "voice" = "text") => {
      const query = (overrideText ?? input).trim();
      if (!query || isSending || !isModelReady) {
        return;
      }

      void stopSpeech();
      setSpeakingMessageId(null);

      if (overrideText === undefined) {
        setInput("");
      }
      setIsSending(true);

      try {
        const { assistantId, text } = await runRagExchange(query);
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
    },
    [input, isSending, isModelReady, runRagExchange, playMessageSpeech, isChatModelMissingError]
  );

  useImperativeHandle(ref, () => ({
    submitVoiceQuery: (transcript: string) => handleSend(transcript, "voice"),
  }));

  return (
    <View style={styles.container}>
      <BottomSheetFlatList
        ref={listRef}
        style={styles.messageList}
        data={messages}
        keyExtractor={(item) => item.id}
        onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Ask anything — answers are grounded in your recorded notes.</Text>
        }
        renderItem={({ item }) => (
          <Pressable
            onLongPress={() => void copyTextWithFeedback(item.text)}
            disabled={item.text.trim().length === 0}
            style={[styles.bubble, item.role === "user" ? styles.bubbleUser : styles.bubbleAssistant]}
          >
            <Text style={styles.roleLabel}>{item.role === "user" ? "You" : "Xayra"}</Text>
            {item.isStreaming && item.text.length === 0 ? (
              <View style={styles.streamingStartRow}>
                <ActivityIndicator color={colors.textMuted} size="small" />
                <Text style={styles.streamingStartText}>Thinking…</Text>
              </View>
            ) : (
              <View style={styles.bubbleTextWrap}>
                <MarkdownText text={item.text} color={item.role === "user" ? colors.onAccent : colors.textPrimary} />
                {item.isStreaming && <StreamingCursor color={item.role === "user" ? colors.onAccent : colors.accent} />}
              </View>
            )}
            {item.role === "assistant" && !item.isStreaming && item.text.length > 0 && (
              <Pressable onPress={() => handleToggleSpeech(item)} style={styles.speakerButton}>
                <Text style={styles.speakerButtonText}>{speakingMessageId === item.id ? "⏹ Stop" : "🔊 Listen"}</Text>
              </Pressable>
            )}
            {!!item.citations?.length && (
              <View style={styles.citationRow}>
                {item.citations.map((citation) => (
                  <Pressable key={citation.noteId} onPress={() => onShowCitation(citation.noteId)} style={styles.citationChip}>
                    <Text style={styles.citationChipText}>[Note {citation.index}]</Text>
                  </Pressable>
                ))}
              </View>
            )}
          </Pressable>
        )}
      />

      {messages.length === 0 && isModelReady && (
        <View style={styles.starterChipRow}>
          {STARTER_PROMPTS.map((prompt) => (
            <Pressable
              key={prompt}
              onPress={() => void handleSend(prompt)}
              disabled={isSending}
              style={({ pressed }) => [styles.starterChip, pressed && styles.starterChipPressed]}
            >
              <Text style={styles.starterChipText}>{prompt}</Text>
            </Pressable>
          ))}
        </View>
      )}

      {modelDownload.status === "downloading" && (
        <View style={styles.setupStatusBar}>
          <View style={styles.setupStatusTrack}>
            <View style={[styles.setupStatusFill, { width: `${Math.round(modelDownload.progressPercent)}%` }]} />
          </View>
          <Text style={styles.setupStatusText}>Preparing Xayra… {Math.round(modelDownload.progressPercent)}%</Text>
          <Text style={styles.setupStatusSubtext}>
            {modelDownload.downloadedMB} MB / {modelDownload.totalMB} MB • {modelDownload.speedMBps} MB/s •{" "}
            {modelDownload.etaSeconds}s remaining
          </Text>
        </View>
      )}

      {modelDownload.status === "cellular_blocked" && (
        <View style={styles.chatModelPrompt}>
          <Text style={styles.chatModelPromptTitle}>Chat model needed</Text>
          <Text style={styles.chatModelPromptBody}>
            To chat with Xayra, you need to download the Xayra chat model (~{modelDownload.chatModelSizeLabel}). You're
            not on Wi-Fi right now — Xayra waits for Wi-Fi automatically, or you can use mobile data instead.
          </Text>
          <Pressable onPress={handleAllowCellularDownload} style={styles.chatModelDownloadButton}>
            <Text style={styles.chatModelDownloadButtonText}>Download over Mobile Data</Text>
          </Pressable>
        </View>
      )}

      {(modelDownload.status === "error" || modelDownload.status === "paused_offline") && (
        <View style={styles.chatModelPrompt}>
          <Text style={styles.chatModelPromptTitle}>
            {modelDownload.status === "paused_offline" ? "Download Paused" : "Setup Interrupted"}
          </Text>
          <Text style={styles.chatModelPromptBody}>
            {modelDownload.downloadedMB} MB of {modelDownload.totalMB} MB saved on disk.
          </Text>
          <Pressable onPress={handleResumeDownload} style={styles.chatModelDownloadButton}>
            <Text style={styles.chatModelDownloadButtonText}>Resume Download</Text>
          </Pressable>
        </View>
      )}

      <View style={styles.inputBar}>
        <TextInput
          value={input}
          onChangeText={setInput}
          placeholder="Ask about your notes…"
          placeholderTextColor={colors.textMuted}
          style={styles.input}
          editable={!isSending && isModelReady}
          contextMenuHidden={false}
          multiline
          returnKeyType="send"
          onSubmitEditing={() => handleSend()}
        />
        <Pressable
          onPress={() => handleSend()}
          disabled={isSending || !input.trim() || !isModelReady}
          style={({ pressed }) => [
            styles.sendButton,
            (isSending || !input.trim() || !isModelReady) && styles.sendButtonDisabled,
            pressed && styles.sendButtonPressed,
          ]}
        >
          {isSending ? <ActivityIndicator color={colors.textPrimary} size="small" /> : <Text style={styles.sendButtonText}>Send</Text>}
        </Pressable>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: spacing.base,
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
    backgroundColor: "#1C1C1E",
    borderColor: "rgba(255,255,255,0.1)",
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
  bubbleTextWrap: {},
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
    backgroundColor: "#2C2C2E",
    borderColor: "rgba(255,255,255,0.1)",
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
  inputBar: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: spacing.sm + 2,
    paddingVertical: spacing.md,
  },
  input: {
    flex: 1,
    backgroundColor: "#1C1C1E",
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
    backgroundColor: "#1C1C1E",
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
  starterChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginBottom: spacing.sm,
  },
  starterChip: {
    backgroundColor: "#1C1C1E",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.base,
    paddingVertical: spacing.sm + 2,
  },
  starterChipPressed: {
    backgroundColor: "#2C2C2E",
  },
  starterChipText: {
    color: colors.textSecondary,
    fontSize: 13,
    fontWeight: "600",
  },
  setupStatusBar: {
    backgroundColor: "#1C1C1E",
    borderRadius: radius.lg,
    padding: spacing.sm + 2,
    marginBottom: spacing.sm,
  },
  setupStatusTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: "#2C2C2E",
    overflow: "hidden",
    marginBottom: spacing.xs,
  },
  setupStatusFill: {
    height: "100%",
    backgroundColor: colors.accent,
    borderRadius: 3,
  },
  setupStatusText: {
    color: colors.textMuted,
    ...typography.caption,
    textAlign: "center",
  },
  setupStatusSubtext: {
    color: colors.textMuted,
    fontSize: 11,
    textAlign: "center",
    marginTop: 2,
    opacity: 0.8,
  },
});
