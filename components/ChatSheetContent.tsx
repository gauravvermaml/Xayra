import { useEffect, useRef } from "react";
import { ActivityIndicator, Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";

import { MarkdownText } from "./MarkdownText";
import { colors, radius, spacing, typography } from "../constants/theme";
import { allowCellularDownloadAndResume, resumeDownloads, type ModelDownloadStatus } from "../services/ai/modelDownloadManager";
import type { ChatMessage } from "../services/ai/useChatSession";
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

/** Shown only before the first message of a session. Tapping one submits it
 * exactly like typing it into the compose bar. */
const STARTER_PROMPTS = ["Summarize my latest notes", "What did I record about work?", "List my recent tasks"] as const;

export type ChatSheetContentProps = {
  messages: ChatMessage[];
  isSending: boolean;
  speakingMessageId: string | null;
  modelDownload: ModelDownloadStatus;
  isModelReady: boolean;
  onSubmitStarterPrompt: (text: string) => void;
  onToggleSpeech: (message: ChatMessage) => void;
  onShowCitation: (noteId: string) => void;
  /** Device's safe-area bottom inset — Build 20 SCROLL CONTENT CLEARANCE:
   * added as extra trailing padding (on top of an 80px margin) so the last
   * message can scroll clear of the solid Android nav bar instead of ending
   * up clipped behind it. */
  bottomInset: number;
};

/**
 * The sheet's "QA History" segment content — purely presentational (see
 * services/ai/useChatSession.ts for the actual conversation state/logic,
 * which lives in app/index.tsx so it survives this component being
 * unmounted whenever the segment control switches to "Notes").
 */
export function ChatSheetContent({
  messages,
  isSending,
  speakingMessageId,
  modelDownload,
  isModelReady,
  onSubmitStarterPrompt,
  onToggleSpeech,
  onShowCitation,
  bottomInset,
}: ChatSheetContentProps) {
  const listRef = useRef<React.ElementRef<typeof BottomSheetFlatList<ChatMessage>>>(null);

  const handleAllowCellularDownload = () => {
    void allowCellularDownloadAndResume();
  };
  const handleResumeDownload = () => {
    void resumeDownloads();
  };

  return (
    <View style={styles.container}>
      <BottomSheetFlatList
        ref={listRef}
        style={styles.messageList}
        contentContainerStyle={{ paddingBottom: bottomInset + 80 }}
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
                {/* Build 22: explicit selectable={false} — MarkdownText
                    defaults to true, which inside this BottomSheetFlatList
                    let a drag starting on a message bubble be captured as
                    text-selection instead of list scroll. */}
                <MarkdownText
                  text={item.text}
                  color={item.role === "user" ? colors.onAccent : colors.textPrimary}
                  selectable={false}
                />
                {item.isStreaming && <StreamingCursor color={item.role === "user" ? colors.onAccent : colors.accent} />}
              </View>
            )}
            {item.role === "assistant" && !item.isStreaming && item.text.length > 0 && (
              <Pressable onPress={() => onToggleSpeech(item)} style={styles.speakerButton}>
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
              onPress={() => onSubmitStarterPrompt(prompt)}
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
    </View>
  );
}

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
