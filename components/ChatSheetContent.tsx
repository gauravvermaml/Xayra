import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  Animated,
  FlatList,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BottomSheetFlatList } from "@gorhom/bottom-sheet";
import { Feather } from "@expo/vector-icons";

import { MarkdownText } from "./MarkdownText";
import { devTiming } from "../services/ai/perf";
import { classifyListDrag, upwardReleaseSpeed, type DragSample } from "../utils/trayGesture";
import { useReduceMotion } from "../hooks/useReduceMotion";
import { NoteCard } from "./NoteCard";
import { RelatedNotesSection } from "./RelatedNotesSection";
import { Chip } from "./ui/Chip";
import { Pill } from "./ui/Pill";
import { XText } from "./ui/XText";
import { ASK_STARTER_PROMPTS, NOTES_EMPTY_TITLE, RECORD_EMPTY_SUBTEXT } from "../constants/copy";
import { spacing } from "../constants/theme";
import { MIN_TOUCH_TARGET, xayraColors, xayraRadius, xayraType } from "../constants/xayraTheme";
import { allowCellularDownloadAndResume, resumeDownloads, type ModelDownloadStatus } from "../services/ai/modelDownloadManager";
import {
  getPipelineStage,
  getPipelineStageLabel,
  PIPELINE_STAGE_LABELS,
  subscribeToPipelineStage,
  type PipelineStage,
} from "../services/ai/pipelineStage";

/** Ask progress stages this row shows (its single progress surface). */
const ASK_PROGRESS_STAGES: ReadonlySet<PipelineStage> = new Set<PipelineStage>(["transcribing", "retrieving", "answering"]);

function currentAskProgressLabel(): string {
  const stage = getPipelineStage("chat");
  return (stage && ASK_PROGRESS_STAGES.has(stage) && getPipelineStageLabel("chat")) || PIPELINE_STAGE_LABELS.retrieving;
}
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
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    // "Remove animations": a steady cursor instead of a blink.
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0, duration: 450, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 450, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);

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
  // Words come from the Ask's own progress owner (pipelineStage.ts
  // AskProgress): retrieval, then "Found N related memories · Piecing it
  // together…", then the inference phrases. This row only observes; it
  // owns no timers.
  const [stage, setStage] = useState(currentAskProgressLabel);
  const opacity = useRef(new Animated.Value(1)).current;
  const reduceMotion = useReduceMotion();

  useEffect(() => {
    // QA Phase 3, P2-2: this row only ever reflects the "chat" flow — a
    // concurrent note save on the Home screen ("note" flow) can no longer
    // overwrite this label. See pipelineStage.ts's own doc comment.
    return subscribeToPipelineStage("chat", (next, label) => {
      if (next && ASK_PROGRESS_STAGES.has(next) && label) {
        setStage(label);
      }
    });
  }, []);

  useEffect(() => {
    // "Remove animations": the words alone, no pulse.
    if (reduceMotion) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.4, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [opacity, reduceMotion]);

  // A polite live region: TalkBack reads each real stage as it changes
  // (retrieving → "Found N related memories…" → answering), never per frame.
  return (
    <Animated.Text accessibilityLiveRegion="polite" style={[styles.streamingStartText, { color, opacity }]}>
      {stage}
    </Animated.Text>
  );
}

/** Shown only before the first message of a session. Tapping one submits it
 * exactly like typing it into the compose bar. */

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
  /** Space after the list's last item. In the tray the body already ends
   * at the dock's top edge (HistorySheet), so this is just breathing room;
   * the full-screen overlay passes the bottom safe-area inset plus room. The
   * inset is counted once, by whichever container owns the bottom edge. */
  listBottomPadding: number;
  /** True only when rendered inside `ExpandedTextOverlay` — a plain
   * full-screen View, NOT a real `<BottomSheet>`. See
   * NotesSheetContent.tsx's identical prop for why `BottomSheetFlatList`
   * throws ("'useBottomSheetInternal' cannot be used out of the
   * BottomSheet!") when rendered there, and why a plain RN `FlatList` is
   * the right (and simpler) choice for a static full-screen overlay with
   * no sheet-drag gesture to coordinate with. */
  usePlainList?: boolean;
  /** A quick upward fling on the list (Redmi uplift Stage 2): the tray
   * opens the full-screen view. Slow drags just scroll. */
  onFlingUp?: () => void;
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
  listBottomPadding,
  usePlainList,
  onFlingUp,
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

  // Ask mode keeps the newest exchange in view — but only when a NEW
  // exchange arrives. It used to scroll to the top on every content-size
  // change, which includes the list measuring more rows as you scroll down:
  // a downward scroll moved a little, then snapped back to the top (Redmi
  // uplift Stage 2 — the "spring-back" that blocked scrolling).
  const newestExchangeId = mode === "ask" && messages.length > 0 ? messages[messages.length - (messages.length % 2 === 0 ? 2 : 1)]?.id : null;
  useEffect(() => {
    if (newestExchangeId) scrollToTop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newestExchangeId]);

  // Fling detection on the tray's own list (not the full-screen overlay's).
  const dragStartRef = useRef<DragSample | null>(null);
  const handleScrollBeginDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    dragStartRef.current = { offsetY: e.nativeEvent.contentOffset.y, at: Date.now() };
  };
  const handleScrollEndDrag = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const start = dragStartRef.current;
    dragStartRef.current = null;
    if (!start) return;
    const velocityY = e.nativeEvent.velocity?.y ?? 0;
    const result = classifyListDrag(
      start,
      { offsetY: e.nativeEvent.contentOffset.y, at: Date.now() },
      upwardReleaseSpeed(velocityY, Platform.OS)
    );
    devTiming("TrayGesture", "list drag end", {
      result: result ?? "none",
      moved: Math.round(e.nativeEvent.contentOffset.y - start.offsetY),
      ms: Date.now() - start.at,
      velocityY: Math.round(velocityY * 100) / 100,
    });
    if (result === "flingUp") onFlingUp?.();
  };

  const handleAllowCellularDownload = () => {
    void allowCellularDownloadAndResume();
  };
  const handleResumeDownload = () => {
    void resumeDownloads();
  };

  const messageListContentContainerStyle = { paddingBottom: listBottomPadding };

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
        <Text style={styles.emptyTitle}>{NOTES_EMPTY_TITLE}</Text>
        <Text style={styles.notesEmptySubtext}>{RECORD_EMPTY_SUBTEXT}</Text>
        <Pressable
          onPress={onRestoreFromDrive}
          disabled={isRestoring}
          accessibilityRole="link"
          style={({ pressed }) => [styles.restoreLinkRow, pressed && styles.pressed]}
        >
          {isRestoring ? (
            <ActivityIndicator color={xayraColors.lilac} size="small" />
          ) : (
            <Text style={styles.restoreLinkText}>Already have a backup? Restore vault from Google Drive</Text>
          )}
        </Pressable>
      </View>
    ) : (
      // Starter prompts sit directly under the intro line, at the top of the
      // tray. They used to render after the flex:1 list — i.e. at the bottom
      // of the sheet's full-height content — which is below what's visible
      // at the tray's 20%/50% snaps. This list empty state only renders
      // before anything has been asked, which is exactly when they apply.
      <View style={styles.askEmptyState}>
        <Text style={styles.emptyText}>Ask anything — answers are grounded in your recorded notes.</Text>
        {isModelReady && (
          <View testID="ask-starter-prompts" style={styles.starterChipRow}>
            {ASK_STARTER_PROMPTS.map((prompt) => (
              <Chip key={prompt} label={prompt} onPress={() => onSubmitStarterPrompt(prompt)} disabled={isSending} />
            ))}
          </View>
        )}
      </View>
    );

  const renderItem = ({ item, index }: { item: DrawerListItem; index: number }) => {
    if (item.kind === "note") {
      const note = item.note;
      return (
        <NoteCard
          appearance="xayra"
          content={note.content}
          audioUri={note.audioUri}
          createdAt={note.createdAt}
          onPress={() => onShowCitation(note.id)}
          onDelete={() => onDeleteNote(note.id)}
        />
      );
    }

    const message = item.message;
    // A voice Ask's question turn before transcription returns has no text
    // yet — show nothing rather than placeholder words; its answer bubble
    // (with the progress line) is already there.
    if (message.pending) return null;
    const isUser = message.role === "user";
    // Xayra 2.0: borderless turns — a sentence-case label over plain text,
    // no bubbles. A hairline separates one exchange from the older one
    // below it (exchanges are newest-first; each starts with its question).
    return (
      <Pressable
        onLongPress={() => void copyTextWithFeedback(message.text)}
        disabled={message.text.trim().length === 0}
        style={[styles.turn, isUser ? styles.turnUser : styles.turnAssistant]}
      >
        {isUser && index > 0 && <View style={styles.exchangeDivider} />}
        <XText variant="roleLabel" color={isUser ? "textFaint" : "lilac"} style={styles.roleLabel}>
          {isUser ? "You" : "Xayra"}
        </XText>
        {message.isStreaming && message.text.length === 0 ? (
          <View style={styles.streamingStartRow}>
            <StreamingStageLabel color={xayraColors.textMuted} />
          </View>
        ) : isUser ? (
          <XText variant="question">{message.text}</XText>
        ) : (
          <View>
            {/* Build 22: explicit selectable={false} — MarkdownText
                defaults to true, which inside this BottomSheetFlatList
                let a drag starting on a message be captured as
                text-selection instead of list scroll. */}
            <MarkdownText text={message.text} color={xayraColors.text} selectable={false} variant="answer" />
            {message.isStreaming && <StreamingCursor color={xayraColors.lilac} />}
          </View>
        )}
        {/* Shown only under the "couldn't verify" fallback — see RelatedNotesSection. */}
        <RelatedNotesSection notes={message.relatedNotes ?? []} onOpen={onShowCitation} />
        {!isUser && !message.isStreaming && message.text.length > 0 && (
          <View style={styles.actionRow}>
            <Pill
              label={speakingMessageId === message.id ? "Stop" : "Listen"}
              accessibilityLabel={speakingMessageId === message.id ? "Stop speaking" : "Listen to this answer"}
              icon={
                <Feather
                  name={speakingMessageId === message.id ? "square" : "volume-2"}
                  size={17}
                  color={xayraColors.text}
                />
              }
              onPress={() => onToggleSpeech(message)}
            />
            {message.citations?.map((citation) => (
              <Chip
                key={citation.noteId}
                label={`[Note ${citation.index}]`}
                accessibilityLabel={`Open source note ${citation.index}`}
                onPress={() => onShowCitation(citation.noteId)}
              />
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
          onScrollBeginDrag={onFlingUp ? handleScrollBeginDrag : undefined}
          onScrollEndDrag={onFlingUp ? handleScrollEndDrag : undefined}
          ListEmptyComponent={emptyComponent}
          renderItem={renderItem}
        />
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
          <Pressable
            onPress={handleAllowCellularDownload}
            accessibilityRole="button"
            style={({ pressed }) => [styles.chatModelDownloadButton, pressed && styles.pressed]}
          >
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
          <Pressable
            onPress={handleResumeDownload}
            accessibilityRole="button"
            style={({ pressed }) => [styles.chatModelDownloadButton, pressed && styles.pressed]}
          >
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
    paddingHorizontal: 20,
  },
  messageList: {
    flex: 1,
  },
  pressed: {
    opacity: 0.7,
  },
  // Empty states sit at the top of the tray, in the same rhythm as the list.
  emptyText: {
    ...xayraType.guidance,
    color: xayraColors.textMuted,
    marginTop: spacing.sm,
    textAlign: "center",
    paddingHorizontal: spacing.sm,
  },
  emptyTitle: {
    ...xayraType.question,
    color: xayraColors.textSoft,
    textAlign: "center",
  },
  notesEmptyState: {
    alignItems: "center",
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  notesEmptySubtext: {
    ...xayraType.meta,
    fontSize: 14,
    lineHeight: 20,
    color: xayraColors.textMuted,
    marginTop: spacing.xs,
    textAlign: "center",
  },
  restoreLinkRow: {
    marginTop: spacing.md,
    minHeight: MIN_TOUCH_TARGET,
    justifyContent: "center",
    alignItems: "center",
  },
  restoreLinkText: {
    ...xayraType.chip,
    color: xayraColors.lilacText,
    textAlign: "center",
  },
  turn: {
    paddingHorizontal: 4,
  },
  turnUser: {
    marginBottom: 14,
  },
  turnAssistant: {
    marginBottom: 4,
  },
  exchangeDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: xayraColors.line,
    marginTop: 12,
    marginBottom: 16,
  },
  roleLabel: {
    marginBottom: 4,
  },
  streamingStartRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    minHeight: 26,
  },
  streamingStartText: {
    ...xayraType.cue,
    color: xayraColors.textMuted,
  },
  actionRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 8,
    marginTop: 4,
    marginBottom: 8,
  },
  chatModelPrompt: {
    backgroundColor: xayraColors.field,
    borderRadius: xayraRadius.card,
    padding: spacing.base,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  chatModelPromptTitle: {
    ...xayraType.question,
    fontWeight: "600",
    color: xayraColors.text,
  },
  chatModelPromptBody: {
    ...xayraType.meta,
    fontSize: 14,
    lineHeight: 20,
    color: xayraColors.textMuted,
    marginBottom: spacing.sm,
  },
  chatModelDownloadButton: {
    backgroundColor: xayraColors.teal,
    borderRadius: xayraRadius.pill,
    minHeight: MIN_TOUCH_TARGET,
    alignItems: "center",
    justifyContent: "center",
  },
  chatModelDownloadButtonText: {
    ...xayraType.chip,
    fontWeight: "600",
    color: "#000000",
  },
  askEmptyState: {
    alignItems: "center",
    gap: spacing.base,
  },
  starterChipRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: spacing.sm,
  },
});
