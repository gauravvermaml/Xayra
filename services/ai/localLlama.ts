import * as FileSystem from "expo-file-system/legacy";
import { initLlama, LlamaContext } from "llama.rn";

/** Not bundled — tens of MB — same resolution pattern as localWhisper.ts and
 * localEmbeddings.ts: expected to already be sitting in the document
 * directory before generation is attempted. */
const MODEL_FILENAME = "Llama-3.2-1B-Instruct-Q4_K_M.gguf";

const SYSTEM_PROMPT =
  "You are Silent Confidant, a private voice note AI. Answer the user's question strictly based on the provided voice note context. If the answer is not in the notes, state that clearly.";

/**
 * Built fresh on every call, not memoized alongside SYSTEM_PROMPT — the
 * llama context itself is long-lived (see getContext()), so baking today's
 * date in once at first load would leave every later answer using a stale
 * date. Without this, the model has no way to resolve relative-time
 * questions ("last Monday", "yesterday", "this month") and hallucinates one.
 */
function buildSystemPromptWithDate(): string {
  const today = new Date().toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  return (
    `${SYSTEM_PROMPT}\n\n` +
    `Current Date & Time: ${today}. Use this as the baseline date whenever the ` +
    'question refers to a relative time (e.g. "last Monday", "yesterday", "this month").'
  );
}

/** Llama-3.2's instruct template stop marker — ends every turn. Without this
 * in `stop`, generation would run past the assistant's turn and start
 * hallucinating a fake next user turn. */
const EOT_TOKEN = "<|eot_id|>";

let contextPromise: Promise<LlamaContext> | null = null;

function resolveModelPath(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return `${dir}${MODEL_FILENAME}`;
}

async function requireModelExists(): Promise<string> {
  const path = resolveModelPath();
  const info = await FileSystem.getInfoAsync(path);
  if (!info.exists) {
    throw new Error(
      `${MODEL_FILENAME} not found. Place it in the app's document directory ` +
        `(${FileSystem.documentDirectory}) before generating an answer.`
    );
  }
  return path;
}

/**
 * Loading the GGUF model is expensive, so the context is created once and
 * reused across calls. If creation fails, the next call retries instead of
 * replaying a cached rejection forever.
 */
async function getContext(): Promise<LlamaContext> {
  if (!contextPromise) {
    contextPromise = requireModelExists().then((model) =>
      initLlama({ model, n_ctx: 4096, n_threads: 4 })
    );
    contextPromise.catch(() => {
      contextPromise = null;
    });
  }
  return contextPromise;
}

/**
 * Builds a raw Llama-3.2 instruct-template prompt by hand — headers,
 * `<|eot_id|>` turn separators, and the trailing assistant header that
 * primes the model to start generating — rather than going through
 * llama.rn's jinja/`messages` chat formatting, since the RAG context block
 * needs to sit inside the system turn alongside the system prompt.
 */
function buildPrompt(userQuery: string, contextXml: string): string {
  return (
    "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n" +
    `${buildSystemPromptWithDate()}\n\n${contextXml}${EOT_TOKEN}` +
    "<|start_header_id|>user<|end_header_id|>\n\n" +
    `${userQuery}${EOT_TOKEN}` +
    "<|start_header_id|>assistant<|end_header_id|>\n\n"
  );
}

/**
 * Generates a RAG answer entirely on-device via a local GGUF model — no
 * network round-trip, no OpenAI API key. Streams each token to `onToken` as
 * it's produced (for live UI updates) and resolves with the full text once
 * generation completes.
 */
export async function generateLocalRAGAnswer(
  prompt: string,
  contextXml: string,
  onToken: (token: string) => void
): Promise<string> {
  const context = await getContext();
  const fullPrompt = buildPrompt(prompt, contextXml);

  const result = await context.completion(
    {
      prompt: fullPrompt,
      n_predict: 512,
      stop: [EOT_TOKEN, "<|end_of_text|>"],
    },
    (data) => {
      if (data.token) {
        onToken(data.token);
      }
    }
  );

  return result.text.trim();
}

/**
 * Releases the native llama context and its underlying memory (KV cache,
 * loaded weights). Call on unmount of whatever screen owns the RAG flow —
 * an un-released context keeps a multi-GB model resident until the app
 * process dies.
 */
export async function releaseLocalLlama(): Promise<void> {
  if (!contextPromise) {
    return;
  }
  const pending = contextPromise;
  contextPromise = null;
  const context = await pending.catch(() => null);
  await context?.release();
}
