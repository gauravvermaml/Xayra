import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";

import { MarkdownText } from "./MarkdownText";
import { NoteCard } from "./NoteCard";
import { colors, radius, spacing, typography } from "../constants/theme";
import { allowCellularDownloadAndResume, resumeDownloads, type ModelDownloadStatus } from "../services/ai/modelDownloadManager";
import { PIPELINE_STAGE_LABELS, subscribeToPipelineStage } from "../services/ai/pipelineStage";
import type { ChatMessage } from "../services/ai/useChatSession";
import type { Note } from "../services/notes/noteManager";
import { copyTextWithFeedback } from "../utils/clipboard";

/** One row of this drawer's list — either a note (Record mode) or a chat
 * message (Ask mode). See this file's own top-level doc comment for why
 * both live in ONE persistent list now instead of two separately-mounted
 * ones. */
type DrawerListItem = { kind: "note"; note: Note } | { kind: "message"; message: ChatMessage };

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

/**
 * Replaces the old bare `ActivityIndicator` + static "Thinking…" — shows
 * what's ACTUALLY happening (see services/ai/pipelineStage.ts) via the same
 * gentle fade-loop `StreamingCursor` above already uses, so the row reads as
 * "working," not "stalled," without a literal spinning wheel. Falls back to
 * "Thinking…" for the brief instant before the first real stage (retrieval)
 * has been reported yet, or on the rare answer with an empty note context
 * that skips straight to generation.
 */
function StreamingStageLabel({ color }: { color: string }) {
  const [stage, setStage] = useState(() => PIPELINE_STAGE_LABELS.retrieving);
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    // QA Phase 3, P2-2: this row only ever reflects the "chat" flow — a
    // concurrent note save on the Home screen ("note" flow) can no longer
    // overwrite this label. See pipelineStage.ts's own doc comment.
    return subscribeToPipelineStage("chat", (next) => {
      if (next === "retrieving" || next === "answering") {
        setStage(PIPELINE_STAGE_LABELS[next]);
      }
    });
  }, []);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return <Animated.Text style={[styles.streamingStartText, { color, opacity }]}>{stage}</Animated.Text>;
}

/** Shown only before the first message of a session. Tapping one submits it
 * exactly like typing it into the compose bar. */
const STARTER_PROMPTS = ["Summarize my latest notes", "What did I record about work?", "List my recent tasks"] as const;

export type ChatSheetContentProps = {
  /** Record shows the notes list (newest first); Ask shows Q&A history,
   * newest EXCHANGE first too (see the `data` useMemo below for how a
   * question+answer pair's own internal order stays question-then-answer
   * even though exchanges themselves are reversed). Both render through the
   * SAME persistent FlatList instance — see this file's own top-level doc
   * comment for why that's load-bearing, not a style choice. */
  mode: "record" | "ask";
  /** Record-mode data — ignored while `mode === "ask"`. */
  notes: Note[];
  onDeleteNote: (noteId: string) => void;
  isRestoring: boolean;
  onRestoreFromDrive: () => void;
  /** Ask-mode data — ignored while `mode === "record"`. */
  messages: ChatMessage[];
  isSending: boolean;
  speakingMessageId: string | null;
  modelDownload: ModelDownloadStatus;
  isModelReady: boolean;
  onSubmitStarterPrompt: (text: string) => void;
  onToggleSpeech: (message: ChatMessage) => void;
  /** Opens a note's detail view — a chat citation-chip tap (Ask mode) and a
   * row tap in the notes list (Record mode) both call this. */
  onShowCitation: (noteId: string) => void;
  /** Device's safe-area bottom inset — Build 20 SCROLL CONTENT CLEARANCE:
   * added as extra trailing padding (on top of an 80px margin) so the last
   * message can scroll clear of the solid Android nav bar instead of ending
   * up clipped behind it. */
  bottomInset: number;
  /** True only when rendered inside `ExpandedTextOverlay` — a plain
   * full-screen View, NOT a real `<BottomSheet>`. See
   * NotesSheetContent.tsx's identical prop for why `BottomSheetFlatList`
   * throws ("'useBottomSheetInternal' cannot be used out of the
   * BottomSheet!") when rendered there, and why a plain RN `FlatList` is
   * the right (and simpler) choice for a static full-screen overlay with
   * no sheet-drag gesture to coordinate with. */
  usePlainList?: boolean;
};

/**
 * The sheet's ONE drawer list — Record mode's notes and Ask mode's Q&A
 * history both render through this single component now, deliberately
 * NEVER unmounting/remounting its own FlatList just because `mode` toggles
 * (only `data`/`renderItem` change). This replaced an earlier version where
 * app/index.tsx swapped between this component and a separate
 * `NotesSheetContent` instance depending on mode — a real, confirmed
 * on-device bug: switching between two independently-mounted
 * `BottomSheetFlatList`s in the same `<BottomSheet>` slot left the newly-
 * mounted one unable to scroll at the sheet's 50% stage (it scrolled fine
 * once expanded to `ExpandedTextOverlay`'s plain full-screen View, which
 * has no competing sheet-drag gesture to coordinate with at all — the one
 * clean diagnostic that pointed at the swap itself, not general container
 * styling, as the cause). `@gorhom/bottom-sheet` tracks exactly one
 * "registered scrollable" per sheet for gesture coordination; keeping a
 * single persistent list sidesteps whatever specific internal state that
 * hand-off was corrupting, rather than chasing the exact mechanism inside
 * a third-party library's gesture internals.
 *
 * services/ai/useChatSession.ts owns the actual conversation state/logic —
 * this file stays purely presentational.
 */
export function ChatSheetContent({
  mode,
  notes,
  onDeleteNote,
  isRestoring,
  onRestoreFromDrive,
  messages,
  isSending,
  speakingMessageId,
  modelDownload,
  isModelReady,
  onSubmitStarterPrompt,
  onToggleSpeech,
  onShowCitation,
  bottomInset,
  usePlainList,
}: ChatSheetContentProps) {
  // Two separate, exactly-typed refs rather than one shared union-typed
  // ref — `FlatList` and `BottomSheetFlatList` both expose `scrollToOffset`,
  // but their ref types aren't structurally assignable to each other, so
  // TypeScript rejects a single ref used as both. Only one of the two ever
  // actually mounts for a given instance's lifetime (`usePlainList` is a
  // constant prop), so exactly one of these is ever populated.
  const plainListRef = useRef<FlatList<DrawerListItem>>(null);
  const sheetListRef = useRef<React.ElementRef<typeof BottomSheetFlatList<DrawerListItem>>>(null);
  // Ask-mode only: keep the newest exchange (including live "thinking"/
  // streaming state) pinned at the TOP as it arrives — Ask's list is
  // newest-exchange-first (see the `data` useMemo below), matching Record
  // mode's own newest-first notes list, so "bring the latest into view"
  // means scrolling to offset 0, not to the end. Never wired up at all while
  // `mode === "record"` (see the FlatList props below) — Record's notes list
  // doesn't grow at the top the same way mid-render.
  const scrollToTop = () => {
    plainListRef.current?.scrollToOffset({ offset: 0, animated: true });
    sheetListRef.current?.scrollToOffset({ offset: 0, animated: true });
  };

  const handleAllowCellularDownload = () => {
    void allowCellularDownloadAndResume();
  };
  const handleResumeDownload = () => {
    void resumeDownloads();
  };

  const messageListContentContainerStyle = { paddingBottom: bottomInset + 80 };

  const data: DrawerListItem[] = useMemo(() => {
    if (mode === "record") {
      return notes.map((note) => ({ kind: "note" as const, note }));
    }
    // Newest exchange first, matching Record mode's own newest-first notes
    // list (live product decision — see BACKLOG.md's now-resolved "Ask mode:
    // auto-scroll" entry). useChatSession.ts always appends a user message
    // immediately followed by its assistant placeholder in one call
    // (`[...prev, userMessage, assistantMessage]`), so `messages` is a flat
    // array of consecutive [question, answer] pairs in chronological order.
    // Reversing that array directly would also flip each PAIR's own
    // internal order (the answer would render above its own question), so
    // this groups into pairs first, reverses the GROUP order, then flattens
    // — each exchange still reads question-then-answer top to bottom, it's
    // just the newest exchange that sits above older ones.
    const exchanges: ChatMessage[][] = [];
    for (let i = 0; i < messages.length; i += 2) {
      exchanges.push(messages.slice(i, i + 2));
    }
    return exchanges
      .reverse()
      .flat()
      .map((message) => ({ kind: "message" as const, message }));
  }, [mode, notes, messages]);

  const emptyComponent =
    mode === "record" ? (
      // Same copy/structure as NotesSheetContent.tsx's own empty state —
      // duplicated rather than imported since that component no longer
      // renders here at all (see this file's own top-level doc comment);
      // Archive.tsx still uses NotesSheetContent directly and keeps its own
      // copy of this same empty state in sync independently.
      <View style={styles.notesEmptyState}>
        <Text style={styles.emptyText}>No notes recorded yet.</Text>
        <Text style={styles.notesEmptySubtext}>Tap Xayra to record your first voice note</Text>
        <Pressable onPress={onRestoreFromDrive} disabled={isRestoring} style={styles.restoreLinkRow}>
          {isRestoring ? (
            <ActivityIndicator color={colors.accent} size="small" />
          ) : (
            <Text style={styles.restoreLinkText}>Already have a backup? Restore vault from Google Drive</Text>
          )}
        </Pressable>
      </View>
    ) : (
      <Text style={styles.emptyText}>Ask anything — answers are grounded in your recorded notes.</Text>
    );

  const renderItem = ({ item }: { item: DrawerListItem }) => {
    if (item.kind === "note") {
      const note = item.note;
      return (
        <NoteCard
          content={note.content}
          audioUri={note.audioUri}
          createdAt={note.createdAt}
          onPress={() => onShowCitation(note.id)}
          onDelete={() => onDeleteNote(note.id)}
        />
      );
    }

    const message = item.message;
    return (
      <Pressable
        onLongPress={() => void copyTextWithFeedback(message.text)}
        disabled={message.text.trim().length === 0}
        style={[styles.bubble, message.role === "user" ? styles.bubbleUser : styles.bubbleAssistant]}
      >
        <Text style={styles.roleLabel}>{message.role === "user" ? "You" : "Xayra"}</Text>
        {message.isStreaming && message.text.length === 0 ? (
          <View style={styles.streamingStartRow}>
            <StreamingStageLabel color={colors.textMuted} />
          </View>
        ) : (
          <View style={styles.bubbleTextWrap}>
            {/* Build 22: explicit selectable={false} — MarkdownText
                defaults to true, which inside this BottomSheetFlatList
                let a drag starting on a message bubble be captured as
                text-selection instead of list scroll. */}
            <MarkdownText
              text={message.text}
              color={message.role === "user" ? colors.onAccent : colors.textPrimary}
              selectable={false}
            />
            {message.isStreaming && (
              <StreamingCursor color={message.role === "user" ? colors.onAccent : colors.accent} />
            )}
          </View>
        )}
        {message.role === "assistant" && !message.isStreaming && message.text.length > 0 && (
          <Pressable onPress={() => onToggleSpeech(message)} style={styles.speakerButton}>
            <Text style={styles.speakerButtonText}>{speakingMessageId === message.id ? "⏹ Stop" : "🔊 Listen"}</Text>
          </Pressable>
        )}
        {!!message.citations?.length && (
          <View style={styles.citationRow}>
            {message.citations.map((citation) => (
              <Pressable key={citation.noteId} onPress={() => onShowCitation(citation.noteId)} style={styles.citationChip}>
                <Text style={styles.citationChipText}>[Note {citation.index}]</Text>
              </Pressable>
            ))}
          </View>
        )}
      </Pressable>
    );
  };

  return (
    <View style={styles.container}>
      {usePlainList ? (
        <FlatList
          ref={plainListRef}
          style={styles.messageList}
          contentContainerStyle={messageListContentContainerStyle}
          data={data}
          keyExtractor={(item) => (item.kind === "note" ? item.note.id : item.message.id)}
          onContentSizeChange={mode === "ask" ? scrollToTop : undefined}
          ListEmptyComponent={emptyComponent}
          renderItem={renderItem}
        />
      ) : (
        <BottomSheetFlatList
          ref={sheetListRef}
          style={styles.messageList}
          contentContainerStyle={messageListContentContainerStyle}
          data={data}
          keyExtractor={(item) => (item.kind === "note" ? item.note.id : item.message.id)}
          onContentSizeChange={mode === "ask" ? scrollToTop : undefined}
          ListEmptyComponent={emptyComponent}
          renderItem={renderItem}
        />
      )}

      {mode === "ask" && messages.length === 0 && isModelReady && (
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

      {/* Build 25: the "downloading" progress card used to render here —
          it's now components/ModelDownloadCard.tsx, rendered once by
          HistorySheet.tsx beneath whichever list is showing, Notes or QA
          alike, rather than duplicated per-tab. */}

      {mode === "ask" && modelDownload.status === "cellular_blocked" && (
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

      {mode === "ask" && (modelDownload.status === "error" || modelDownload.status === "paused_offline") && (
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
  // Record-mode empty state — same copy/shape as NotesSheetContent.tsx's own
  // (Archive still uses that component directly and keeps this in sync
  // independently; see this file's DrawerListItem/emptyComponent doc
  // comments for why the two copies exist).
  notesEmptyState: {
    alignItems: "center",
    paddingTop: spacing.xxl,
    paddingHorizontal: spacing.lg,
  },
  notesEmptySubtext: {
    color: colors.textMuted,
    fontSize: 13,
    marginTop: spacing.xs,
    textAlign: "center",
  },
  restoreLinkRow: {
    marginTop: spacing.lg,
    alignItems: "center",
  },
  restoreLinkText: {
    color: colors.accent,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
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
});
