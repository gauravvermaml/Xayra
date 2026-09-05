import { useCallback, useRef, useState } from "react";
import * as Crypto from "expo-crypto";

import { LLAMA_MODEL_MISSING_ERROR_PREFIX } from "./localLlama";
import { useModelDownload, type ModelDownloadStatus } from "./modelDownloadManager";
import { generateRAGAnswer, type RagCitation } from "./rag";
import { speakText, stopSpeech } from "../audio/tts";

export type ChatMessage = {
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

export type ChatSession = {
  messages: ChatMessage[];
  isSending: boolean;
  speakingMessageId: string | null;
  modelDownload: ModelDownloadStatus;
  isModelReady: boolean;
  /** Runs `text` through the RAG pipeline exactly as if it had been typed
   * into the compose bar and submitted — `source: "voice"` additionally
   * speaks the answer back once it lands (fire-and-forget: doesn't wait for
   * the speech itself to finish), since a spoken question getting a silent
   * text-only answer would be a broken hands-free loop. */
  submitQuery: (text: string, source?: "text" | "voice") => Promise<void>;
  /** The same RAG exchange `submitQuery` runs, minus any TTS side effect —
   * for callers (Active/hands-free Mode's continuous loop) that need to
   * control speech playback themselves, specifically so they can `await`
   * the speech actually *finishing* before re-arming the mic. `submitQuery`
   * can't be reused for that: its own speech is fire-and-forget, which
   * would let the mic re-arm mid-sentence and transcribe the assistant's
   * own voice as the next "question" (no echo cancellation exists here). */
  ask: (text: string) => Promise<{ text: string }>;
  toggleSpeech: (message: Pick<ChatMessage, "id" | "text">) => void;
};

/**
 * Owns the entire chat/RAG conversation — message history, streaming,
 * TTS playback state — as a hook living in app/index.tsx rather than inside
 * ChatSheetContent, so the conversation survives ChatSheetContent being
 * unmounted when the sheet's Notes/QA History segment control switches away
 * from "QA History" (see components/HistorySheet.tsx). ChatSheetContent
 * itself is now purely presentational, rendering whatever this hook hands it.
 */
export function useChatSession(): ChatSession {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);

  // Build 25: `isSending` (React state) is what the UI reads, but it's the
  // wrong thing to guard re-entrancy on — a `useCallback` closure captures
  // whatever `isSending` was at the time IT was created, and two calls into
  // `ask`/`submitQuery` landing close enough together (e.g. a duplicate STT
  // "result" event, see app/index.tsx's ATOMIC VOICE LOCK) can both read the
  // same stale "false" before either call's `setIsSending(true)` has
  // actually committed and re-rendered a fresh closure. A plain ref is
  // checked and set synchronously, with no such window — this is what
  // actually closes the "double RAG response" race, not just app/index.tsx's
  // own guard one layer up (which stays too, as a second line of defense).
  const isSendingRef = useRef(false);

  const modelDownload = useModelDownload();
  const isModelReady = modelDownload.status === "ready";

  const isChatModelMissingError = useCallback(
    (err: unknown) => err instanceof Error && err.message.startsWith(LLAMA_MODEL_MISSING_ERROR_PREFIX),
    []
  );

  const updateMessage = useCallback((id: string, patch: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((message) => (message.id === id ? { ...message, ...patch } : message)));
  }, []);

  const playMessageSpeech = useCallback((message: Pick<ChatMessage, "id" | "text">) => {
    setSpeakingMessageId(message.id);
    const clearIfCurrent = () => setSpeakingMessageId((current) => (current === message.id ? null : current));
    void speakText(message.text, { onDone: clearIfCurrent, onStopped: clearIfCurrent, onError: clearIfCurrent });
  }, []);

  const toggleSpeech = useCallback(
    (message: Pick<ChatMessage, "id" | "text">) => {
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

  const ask = useCallback(
    async (rawText: string): Promise<{ text: string }> => {
      const query = rawText.trim();
      if (!query || isSendingRef.current || !isModelReady) {
        return { text: "" };
      }
      isSendingRef.current = true;
      void stopSpeech();
      setSpeakingMessageId(null);
      setIsSending(true);
      try {
        const { text } = await runRagExchange(query);
        return { text };
      } catch {
        return { text: "" };
      } finally {
        isSendingRef.current = false;
        setIsSending(false);
      }
    },
    [isModelReady, runRagExchange]
  );

  const submitQuery = useCallback(
    async (rawText: string, source: "text" | "voice" = "text") => {
      const query = rawText.trim();
      if (!query || isSendingRef.current || !isModelReady) {
        return;
      }

      isSendingRef.current = true;
      void stopSpeech();
      setSpeakingMessageId(null);
      setIsSending(true);

      try {
        const { assistantId, text } = await runRagExchange(query);
        if (source === "voice") {
          playMessageSpeech({ id: assistantId, text });
        }
      } catch {
        // Errors are already recorded into the assistant bubble by
        // runRagExchange — nobody here needs to Alert on top of that.
      } finally {
        isSendingRef.current = false;
        setIsSending(false);
      }
    },
    [isModelReady, runRagExchange, playMessageSpeech]
  );

  return { messages, isSending, speakingMessageId, modelDownload, isModelReady, submitQuery, ask, toggleSpeech };
}
