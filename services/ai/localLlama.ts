import * as FileSystem from "expo-file-system/legacy";
import { initLlama, LlamaContext } from "llama.rn";

import { logDuration, nowMs } from "./perf";

/** Not bundled — hundreds of MB to ~2GB — same resolution pattern as
 * localWhisper.ts and localEmbeddings.ts: expected to already be sitting in
 * the document directory before generation is attempted. Priority order
 * mirrors localWhisper.ts's MODEL_FILENAMES pattern: the 3B model is
 * materially more capable (see the AirPods answer-consistency issue this
 * project hit at 1B) and is preferred whenever a device has it pushed;
 * falls back to the 1B model, which is smaller and still ships as the
 * baseline every device is expected to have. */
const MODEL_FILENAMES = [
  { filename: "llama-3.2-3b-instruct-q4_k_m.gguf", label: "3B" },
  { filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf", label: "1B" },
] as const;

/**
 * Strict-grounding directive per the Category A refinement pass: the model
 * must never answer from its own pre-trained knowledge, only from the
 * injected notes context. The one deliberate carve-out is the date/calendar
 * baseline appended below (buildSystemPromptWithDate) — that's injected
 * runtime context, not pre-trained knowledge, and without it the model has
 * no way to answer "what day was last Monday" at all. The typo-tolerance
 * clause stays for the same reason it was added originally: it governs how
 * to *read* the notes context, not a license to use outside facts.
 */
const SYSTEM_PROMPT =
  "You are Remi, a private memory recall assistant. Answer queries EXCLUSIVELY using the provided " +
  "notes context. If the notes do not contain the answer, reply EXACTLY: \"I couldn't find any " +
  "mention of that in your saved notes.\" Never use general pre-trained knowledge or external facts, " +
  "except for the current-date information explicitly provided below, which you may use to answer " +
  "temporal/calendar questions (e.g. \"what day was last Monday?\"). The notes were transcribed by " +
  "an on-device speech-to-text model and may contain mishearings of similar-sounding words (e.g. " +
  "\"AirPods\" transcribed as \"airports\"). If a user asks about a term and the retrieved note " +
  "contains a phonetically similar word or an obvious speech-to-text typo, treat that as the same " +
  "thing the user is asking about and answer using that note's content.";

const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/**
 * A 1B-parameter model doing weekday arithmetic purely from a single "today
 * is X" sentence reliably gets it wrong (miscounts days, picks the wrong
 * week). Spelling out this week's Monday-through-today mapping explicitly
 * turns "what date was last Monday" from arithmetic the model has to
 * perform into a lookup, which is far more reliable at this model size.
 */
function buildCalendarBaseline(now: Date): string {
  const todayIndex = now.getDay(); // 0=Sunday .. 6=Saturday
  const daysSinceMonday = (todayIndex + 6) % 7; // 0=Monday .. 6=Sunday

  const lines: string[] = [];
  for (let offset = 0; offset <= daysSinceMonday; offset++) {
    const d = new Date(now);
    d.setDate(now.getDate() - (daysSinceMonday - offset));
    const label = WEEKDAY_NAMES[d.getDay()];
    const dateStr = d.toLocaleDateString("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const isToday = offset === daysSinceMonday;
    lines.push(isToday ? `- Today (${label}): ${dateStr}` : `- This ${label}: ${dateStr}`);
  }
  return lines.join("\n");
}

/**
 * Built fresh on every call, not memoized alongside SYSTEM_PROMPT — the
 * llama context itself is long-lived (see getContext()), so baking today's
 * date in once at first load would leave every later answer using a stale
 * date. Without this, the model has no way to resolve relative-time
 * questions ("last Monday", "yesterday", "this month") and hallucinates one.
 */
function buildSystemPromptWithDate(): string {
  const now = new Date();
  const today = now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  return (
    `${SYSTEM_PROMPT}\n\n` +
    `Today is ${today}.\n` +
    `Current Week Baseline:\n${buildCalendarBaseline(now)}\n\n` +
    "Use this baseline for all relative-time questions. For dates before this week " +
    '(e.g. "last Monday" when today is itself Monday), count backward from the baseline ' +
    "above rather than guessing."
  );
}

/** Llama-3.2's instruct template stop marker — ends every turn. Without this
 * in `stop`, generation would run past the assistant's turn and start
 * hallucinating a fake next user turn. */
const EOT_TOKEN = "<|eot_id|>";

/** Low, near-deterministic temperature — RAG answers should be a consistent
 * read of the retrieved notes, not creative writing. At the default
 * temperature this 1B model gave contradictory answers to near-identical
 * rephrasings of the same question against the same note (observed
 * on-device: "you didn't mention AirPods" vs "yes, you mentioned AirPods"
 * back to back). Not 0 exactly, since some sampling still helps it recover
 * from a bad first token rather than deterministically repeating a mistake. */
const GENERATION_TEMPERATURE = 0.1;

let contextPromise: Promise<LlamaContext> | null = null;

type ResolvedModel = { path: string; label: (typeof MODEL_FILENAMES)[number]["label"] };

async function resolveModelPath(): Promise<ResolvedModel> {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }

  for (const { filename, label } of MODEL_FILENAMES) {
    const path = `${dir}${filename}`;
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      return { path, label };
    }
  }

  throw new Error(
    `No local Llama model found. Place ${MODEL_FILENAMES.map((m) => m.filename).join(" or ")} ` +
      `in ${dir} before generating an answer.`
  );
}

/**
 * Loading the GGUF model is expensive, so the context is created once and
 * reused across calls. If creation fails, the next call retries instead of
 * replaying a cached rejection forever.
 */
async function getContext(): Promise<LlamaContext> {
  if (!contextPromise) {
    const coldStart = nowMs();
    contextPromise = resolveModelPath()
      .then(({ path, label }) => {
        console.log(`[Llama] Initialized Model: ${label} (q4_k_m)`);
        return initLlama({ model: path, n_ctx: 4096, n_threads: 4 });
      })
      .then((context) => {
        logDuration("Llama cold-start (GGUF model load from disk)", coldStart);
        return context;
      });
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
  const contextReadyStart = nowMs();
  const context = await getContext();
  logDuration("Llama context ready (warm reuse if already loaded)", contextReadyStart);

  const fullPrompt = buildPrompt(prompt, contextXml);

  const generationStart = nowMs();
  let firstTokenLogged = false;

  const result = await context.completion(
    {
      prompt: fullPrompt,
      n_predict: 512,
      temperature: GENERATION_TEMPERATURE,
      stop: [EOT_TOKEN, "<|end_of_text|>"],
    },
    (data) => {
      if (data.token) {
        if (!firstTokenLogged) {
          firstTokenLogged = true;
          logDuration("Llama time-to-first-token (TTFT)", generationStart);
        }
        onToken(data.token);
      }
    }
  );

  logDuration("Llama total generation time", generationStart);
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
