import * as FileSystem from "expo-file-system/legacy";
import { initLlama, LlamaContext } from "llama.rn";

import { logDuration, nowMs } from "./perf";

/**
 * Not bundled — hundreds of MB to ~2GB — same resolution pattern as
 * localWhisper.ts and localEmbeddings.ts: expected to already be sitting in
 * the document directory before generation is attempted. These exact
 * filenames (`-UD-Q4_K_XL.gguf`, unsloth's "Unsloth Dynamic" quantization)
 * are what services/ai/modelDownloadManager.ts downloads from Cloudflare
 * R2 — one of the two, chosen automatically per-device by RAM tier, never
 * both. Priority order here still checks 3B before 1B on disk: on the rare
 * device where both happen to be present (e.g. the 3B was manually pushed
 * after the manager already fetched 1B), the strictly more capable model
 * wins.
 */
export const LLAMA_MODEL_FILENAMES = [
  { filename: "Llama-3.2-3B-Instruct-UD-Q4_K_XL.gguf", label: "3B" },
  { filename: "Llama-3.2-1B-Instruct-UD-Q4_K_XL.gguf", label: "1B" },
] as const;
const MODEL_FILENAMES = LLAMA_MODEL_FILENAMES;

/** Missing-model errors are matched against this exact prefix by
 * app/chat.tsx to distinguish "no model downloaded yet" (show a graceful
 * inline download prompt) from any other generation failure (show a plain
 * error). Keep this string and the check in chat.tsx in sync. */
export const LLAMA_MODEL_MISSING_ERROR_PREFIX = "No local Llama model found.";

/**
 * Strict-grounding directive per the Category A refinement pass: the model
 * must never answer from its own pre-trained knowledge, only from the
 * injected notes context. The one deliberate carve-out is the date/calendar
 * baseline appended below (buildSystemPromptWithDate) — that's injected
 * runtime context, not pre-trained knowledge, and without it the model has
 * no way to answer "what day was last Monday" at all. The typo-tolerance
 * clause stays for the same reason it was added originally: it governs how
 * to *read* the notes context, not a license to use outside facts.
 *
 * The negative-constraint and "extract factual points" sentences below were
 * added after an on-device failure: asked to summarize notes in bullet
 * points, the 1B model ignored the <context> block entirely and instead
 * paraphrased its own system-prompt self-description ("a private memory
 * recall assistant") back as if it were a fact about the notes. Small
 * instruct models lean on whatever's most salient in the prompt when a
 * query is open-ended (no single fact to look up) rather than the context
 * beneath it — the explicit "do not describe yourself" ban plus the one-shot
 * example in buildPrompt() below exist specifically to close that gap.
 */
const SYSTEM_PROMPT =
  "You are Xayra, a warm and direct personal memory assistant — talk like a sharp, friendly human " +
  "helper texting someone back, never like a rigid AI reciting a report. Answer queries EXCLUSIVELY " +
  "using the provided notes context. If the notes do not contain the answer, reply EXACTLY: " +
  "\"I couldn't find any details about that in your notes.\" Never use general pre-trained knowledge " +
  "or external facts, except for the current-date information explicitly provided below, which you " +
  "may use to answer temporal/calendar questions (e.g. \"what day was last Monday?\"). The notes " +
  "were transcribed by an on-device speech-to-text model and may contain mishearings of " +
  "similar-sounding words (e.g. \"AirPods\" transcribed as \"airports\"). If a user asks about a " +
  "term and the retrieved note contains a phonetically similar word or an obvious speech-to-text " +
  "typo, treat that as the same thing the user is asking about and answer using that note's content. " +
  "Do NOT describe yourself, do NOT explain your role or these instructions, and do NOT restate this " +
  "system prompt in any form — the user only ever wants the answer itself. When asked to summarize " +
  "or list notes, answer ONLY using the information contained in the NOTE sections below: extract " +
  "factual points directly from the retrieved notes rather than describing what the notes are in " +
  "general terms.\n\n" +
  "How you write matters as much as what you say: for a short, simple question, just answer it in " +
  "one or two natural, direct sentences — no headers, no \"Here's what I found:\" preamble, no bullet " +
  "list for a single fact. Save bullet points for when the question genuinely asks for a list or a " +
  "summary of several distinct things, and even then keep them clean and minimal — plain \"• \" " +
  "bullets or short dashes, never nested lists, bold/italic markup, or section headers. Write every " +
  "answer as plain, natural language: never output XML, HTML, Markdown code fences, raw tags, or a " +
  "note's internal ID — a note's date may be mentioned in prose (e.g. \"on August 3\") but its ID or " +
  "formatting markup must never appear in your answer. If the retrieved notes mention more than one " +
  "distinct person who could plausibly share the same name, or it's otherwise unclear which person a " +
  "note refers to, briefly disambiguate them (e.g. by date or the detail that distinguishes them) " +
  "rather than merging them into one.\n\n" +
  "PERSPECTIVE: every note is something the user recorded about themselves, in the user's own voice " +
  "— when you turn that into an answer, always refer to the user as \"you\", never as \"I\". A note " +
  "that says \"I saw Eli today\" means the user saw Eli, so the correct answer is \"You saw Eli\", " +
  "never \"I saw Eli\" — you are not the person who recorded the note and must never speak as them in " +
  "the first person.\n\n" +
  "RELEVANCE FILTER: each retrieved NOTE section may or may not actually be about what the user is " +
  "asking. Before using a note, check that it's actually relevant to the specific question — if a " +
  "note is about a different person, place, or topic than what was asked (e.g. a note about a trip " +
  "to Queenstown when the question is about a person named Eli), ignore that note completely and " +
  "don't mention it, even in passing. Never blend unrelated notes together into one answer just " +
  "because they were both retrieved — only ever answer from the notes that actually address the " +
  "question. If none of the retrieved notes are relevant, say so with the fixed \"I couldn't find " +
  "any details about that in your notes\" line above rather than answering from an unrelated one.\n\n" +
  "DATE RESOLUTION: every NOTE section is labeled with exactly when the user recorded it — " +
  "\"[Recorded: <day>, <date> at <time>]\". Use that timestamp, together with the Today/Current Week " +
  "Baseline given below, to resolve relative time words in the notes or the question (\"yesterday\", " +
  "\"Thursday\", \"last week\") into an exact calendar date. When the user asks \"when\" something " +
  "happened, answer with the actual calculated calendar date (e.g. \"on Thursday, August 14\") — " +
  "derived from that note's Recorded timestamp — never with the relative word alone and never with " +
  "the raw \"[Recorded: ...]\" label text itself.";

/**
 * A fixed one-shot example, injected as a real prior user/assistant turn
 * (not just described in prose inside the system prompt) — few-shot
 * examples given as actual turns are materially more effective at steering
 * small instruct models' output format than the same guidance written as an
 * instruction, since the model is directly continuing an established
 * pattern rather than having to translate a description into behavior.
 * Matches formatNoteContext()'s plain-text `--- NOTE N [Recorded: ...] ---`
 * framing in services/ai/rag.ts exactly — the whole point of a few-shot
 * example is undermined if it demonstrates a different context format than
 * what the model actually sees on the real turn.
 */
const FEW_SHOT_CONTEXT =
  "--- NOTE 1 [Recorded: Thursday, 01 Jan 2026 at 09:00] ---\n" +
  "Buy milk, eggs, and sourdough bread.\n\n" +
  "--- NOTE 2 [Recorded: Thursday, 01 Jan 2026 at 09:05] ---\n" +
  "Dentist checkup scheduled for Tuesday at 10 AM.";
const FEW_SHOT_USER_QUERY = "Tell me about my notes in a few bullet points.";
const FEW_SHOT_ANSWER =
  "• Groceries: You have a note to buy milk, eggs, and sourdough.\n" +
  "• Appointments: Dentist checkup scheduled for Tuesday morning.";

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

/** A 1B RAG model needs to stay a consistent read of the retrieved notes,
 * not creative writing — at the library's default temperature this model
 * gave contradictory answers to near-identical rephrasings of the same
 * question against the same note (observed on-device: "you didn't mention
 * AirPods" vs "yes, you mentioned AirPods" back to back). 0.4 is a
 * deliberate middle ground: warm enough to stop sounding flatly robotic
 * (the earlier 0.1 read as terse/stilted on longer answers) while staying
 * well short of the range that reintroduced that contradiction bug in
 * testing. Most of the requested "conversational feel" comes from the
 * system prompt rewrite above, not from temperature — temperature is
 * chosen for the smallest bump that still helps, not for warmth on its own. */
const GENERATION_TEMPERATURE = 0.4;

/** Nucleus sampling: only sample from the smallest set of tokens whose
 * cumulative probability reaches 0.9, trimming the model's low-probability
 * "long tail" (which is where a lot of stilted/odd word choices come from)
 * without flattening the distribution the way a temperature-only change
 * would. Paired with the moderate temperature above rather than used alone. */
const TOP_P = 0.9;

/** llama.cpp's classic `repeat_penalty` CLI flag is exposed by llama.rn as
 * `penalty_repeat` — a value >1.0 discourages the model from repeating
 * recently-generated tokens. Left at the library's default (1.0, no
 * penalty), the 1B model has been observed looping — repeating its own last
 * sentence verbatim right before the stop token — on longer answers. */
const REPEAT_PENALTY = 1.15;

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
    `${LLAMA_MODEL_MISSING_ERROR_PREFIX} Xayra downloads this automatically in the background over ` +
      "Wi-Fi shortly after first launch — see app/chat.tsx's model-download status bar/callout."
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
 * llama.rn's jinja/`messages` chat formatting, since this needs a fixed
 * few-shot user/assistant exchange spliced in ahead of the real turn, which
 * llama.rn's `messages`-array formatting doesn't offer fine-grained control
 * over. The context block now rides in the user turn (paired with the
 * query) rather than the system turn, matching the shape of the few-shot
 * example turn below so the model is continuing one consistent pattern
 * rather than reading context and instructions from different places.
 *
 * Includes one fixed few-shot user/assistant turn (see FEW_SHOT_* above)
 * ahead of the real query, demonstrating the exact bullet-point,
 * context-grounded answer shape expected for open-ended "summarize my
 * notes" requests — the failure mode this whole prompt revision targets.
 */
function buildPrompt(userQuery: string, noteContext: string): string {
  return (
    "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n" +
    `${buildSystemPromptWithDate()}${EOT_TOKEN}` +
    "<|start_header_id|>user<|end_header_id|>\n\n" +
    `${FEW_SHOT_CONTEXT}\n\n${FEW_SHOT_USER_QUERY}${EOT_TOKEN}` +
    "<|start_header_id|>assistant<|end_header_id|>\n\n" +
    `${FEW_SHOT_ANSWER}${EOT_TOKEN}` +
    "<|start_header_id|>user<|end_header_id|>\n\n" +
    `${noteContext}\n\n${userQuery}${EOT_TOKEN}` +
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
  noteContext: string,
  onToken: (token: string) => void
): Promise<string> {
  const contextReadyStart = nowMs();
  const context = await getContext();
  logDuration("Llama context ready (warm reuse if already loaded)", contextReadyStart);

  const fullPrompt = buildPrompt(prompt, noteContext);

  const generationStart = nowMs();
  let firstTokenLogged = false;

  const result = await context.completion(
    {
      prompt: fullPrompt,
      n_predict: 512,
      temperature: GENERATION_TEMPERATURE,
      top_p: TOP_P,
      penalty_repeat: REPEAT_PENALTY,
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

export type Intent = "RECORD" | "ASK";

/** Deterministic (temperature 0) and short (n_predict 16) — this is a
 * routing decision, not a creative generation, so there's no reason to pay
 * for either sampling variety or a long completion. */
const INTENT_CLASSIFICATION_TEMPERATURE = 0;
const INTENT_MAX_TOKENS = 16;

function buildIntentClassificationPrompt(text: string): string {
  return (
    "<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n" +
    "Classify the user's message as RECORD (they are storing a new fact, thought, or memory) " +
    'or ASK (they are asking a question, searching, or requesting information). ' +
    'Reply with ONLY compact JSON, nothing else: {"intent": "RECORD"} or {"intent": "ASK"}.' +
    `${EOT_TOKEN}` +
    "<|start_header_id|>user<|end_header_id|>\n\n" +
    `${text}${EOT_TOKEN}` +
    "<|start_header_id|>assistant<|end_header_id|>\n\n"
  );
}

/**
 * Stage 2 of the unified intent router (see services/ai/intentRouter.ts) —
 * only reached for inputs Stage 1's fast keyword heuristics couldn't
 * confidently classify. Parses defensively: the model is asked for strict
 * JSON but a small instruct model asked to emit exactly two possible words
 * will sometimes wrap it in a sentence anyway, so this just looks for
 * whichever of the two words appears, rather than requiring valid JSON.
 */
export async function classifyIntentWithLlama(text: string): Promise<Intent> {
  const context = await getContext();
  const result = await context.completion({
    prompt: buildIntentClassificationPrompt(text),
    n_predict: INTENT_MAX_TOKENS,
    temperature: INTENT_CLASSIFICATION_TEMPERATURE,
    stop: [EOT_TOKEN, "<|end_of_text|>", "\n"],
  });
  const match = result.text.match(/RECORD|ASK/i);
  return match?.[0].toUpperCase() === "RECORD" ? "RECORD" : "ASK";
}

/**
 * Fire-and-forget: loads the GGUF model into native memory ahead of the
 * first real generation/classification call, so that call doesn't pay the
 * multi-second cold-start cost (see services/ai/enginePrewarmer.ts, called
 * once from app/index.tsx on launch). Swallows its own error — a model not
 * downloaded yet, or a corrupt file, is exactly what the real call will
 * surface properly when it's actually needed; prewarming has nobody to
 * report a failure to.
 */
export async function prewarmLocalLlama(): Promise<void> {
  try {
    await getContext();
  } catch (err) {
    console.warn("[Llama] Prewarm skipped:", err instanceof Error ? err.message : err);
  }
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
