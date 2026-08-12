import { useCallback, useRef, useState } from "react";
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
import * as Crypto from "expo-crypto";

import { NoteDetailModal } from "../components/NoteDetailModal";
import { ViewToggle } from "../components/ViewToggle";
import { generateRAGAnswer, type RagCitation } from "../services/ai/rag";

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

export default function ChatScreen() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const listRef = useRef<FlatList<ChatMessage>>(null);

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) =>
      prev.map((message) => (message.id === id ? { ...message, ...patch } : message))
    );
  }, []);

  const handleShowCitation = useCallback((citation: RagCitation) => {
    setSelectedNoteId(citation.noteId);
  }, []);

  const handleSend = useCallback(async () => {
    const query = input.trim();
    if (!query || isSending) {
      return;
    }

    setInput("");
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
  }, [input, isSending, updateMessage]);

  return (
    <SafeAreaView style={styles.safeArea}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        keyboardVerticalOffset={12}
      >
        <View style={styles.container}>
          <Text style={styles.title}>Silent Confidant</Text>
          <Text style={styles.subtitle}>Ask questions about your voice notes.</Text>

          <ViewToggle active="chat" />

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

          <View style={styles.inputBar}>
            <TextInput
              value={input}
              onChangeText={setInput}
              placeholder="Ask about your notes…"
              placeholderTextColor={colors.textMuted}
              style={styles.input}
              editable={!isSending}
              multiline
              returnKeyType="send"
              onSubmitEditing={handleSend}
            />
            <Pressable
              onPress={handleSend}
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
