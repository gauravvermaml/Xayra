import { env } from "../../config/env";
import { hybridSearchNotes, type HybridSearchResult } from "../notes/noteManager";

const CHAT_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const CHAT_MODEL = "gpt-4o-mini";
const CONTEXT_NOTE_LIMIT = 5;

const SYSTEM_PROMPT =
  "You are Silent Confidant, a private voice note AI. Answer the user's question strictly based on the provided voice note context. If the answer is not in the notes, state that clearly.";

export type RagCitation = {
  /** 1-based position matching the "[Note N]" label shown in the UI. */
  index: number;
  noteId: string;
  content: string;
  createdAt: number;
};

export type RagAnswer = {
  text: string;
  citations: RagCitation[];
};

function formatNoteDate(createdAt: number): string {
  return new Date(createdAt * 1000).toISOString().slice(0, 10);
}

/** `content` is the source of truth, but falls back to `transcript` in case
 * a row was written before both columns were kept in sync (see noteManager). */
function resolveNoteText(note: HybridSearchResult): string {
  return note.content || note.transcript || "";
}

function formatNoteContext(notes: HybridSearchResult[]): string {
  return notes
    .map(
      (note) =>
        `[Note ID: ${note.id} | Date: ${formatNoteDate(note.createdAt)}]\n${resolveNoteText(note)}`
    )
    .join("\n\n");
}

/**
 * Retrieves the top matching notes via hybrid search, grounds a chat
 * completion in them, and streams the answer token-by-token through
 * `onChunk` as it arrives. Resolves with the full text plus the citation
 * list once the stream ends.
 */
export async function generateRAGAnswer(
  userQuery: string,
  onChunk?: (chunk: string) => void
): Promise<RagAnswer> {
  const notes = await hybridSearchNotes(userQuery, CONTEXT_NOTE_LIMIT);

  const citations: RagCitation[] = notes.map((note, i) => ({
    index: i + 1,
    noteId: note.id,
    content: resolveNoteText(note),
    createdAt: note.createdAt,
  }));

  const contextBlock =
    notes.length > 0 ? formatNoteContext(notes) : "No relevant voice notes were found.";

  const messages = [
    { role: "system" as const, content: SYSTEM_PROMPT },
    {
      role: "user" as const,
      content: `Voice note context:\n${contextBlock}\n\nQuestion: ${userQuery}`,
    },
  ];

  console.log("[RAG Prompt Context]", SYSTEM_PROMPT, contextBlock);

  const text = await streamChatCompletion(messages, onChunk);
  return { text, citations };
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * Streams an OpenAI chat completion via XMLHttpRequest rather than
 * fetch+ReadableStream: RN's fetch body-streaming support is inconsistent
 * across engine/version combinations, while XHR's incrementally-growing
 * `responseText` (delivered through `onprogress`) is the long-established,
 * reliable way to consume SSE in React Native.
 */
function streamChatCompletion(
  messages: ChatMessage[],
  onChunk?: (chunk: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let fullText = "";
    let processedLength = 0;
    // Holds a trailing, not-yet-newline-terminated line across progress
    // events, since a single SSE "data: {...}" line can be split mid-chunk.
    let buffer = "";

    xhr.open("POST", CHAT_ENDPOINT);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Authorization", `Bearer ${env.OPENAI_API_KEY}`);

    xhr.onprogress = () => {
      buffer += xhr.responseText.slice(processedLength);
      processedLength = xhr.responseText.length;

      let newlineIndex: number;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (!line.startsWith("data:")) {
          continue;
        }
        const payload = line.slice("data:".length).trim();
        if (payload === "[DONE]" || payload === "") {
          continue;
        }

        try {
          const parsed = JSON.parse(payload) as {
            choices?: { delta?: { content?: string } }[];
          };
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            fullText += delta;
            onChunk?.(delta);
          }
        } catch {
          // Shouldn't happen once buffered on newlines, but a malformed
          // line shouldn't take down the whole stream.
        }
      }
    };

    xhr.onerror = () => reject(new Error("Chat request failed (network error)."));

    xhr.onload = () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Chat request failed (${xhr.status}): ${xhr.responseText}`));
        return;
      }
      resolve(fullText);
    };

    xhr.send(
      JSON.stringify({
        model: CHAT_MODEL,
        messages,
        stream: true,
      })
    );
  });
}
