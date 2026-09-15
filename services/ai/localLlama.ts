import { getCpuCoreCount } from "expo-device-cpu";
import * as FileSystem from "expo-file-system/legacy";
import { initLlama, LlamaContext, type CompletionParams, type NativeCompletionResult, type TokenData } from "llama.rn";

import { isTranscriptionInProgress } from "./localWhisper";
import { MIN_USABLE_TOKENS_PER_SECOND, recordCompletionSpeed } from "./modelPerformanceTracker";
import { logDuration, nowMs } from "./perf";
import { readPreferences } from "../settings/preferences";

/**
 * Sizes the inference thread pool to the ACTUAL device, not a number tuned
 * for whichever phone happened to be on the test bench. This replaces a
 * flat `n_threads: 4` whose own doc comment assumed the Galaxy A50 this
 * project has been testing on "has 4 usable cores" — wrong: `getCpuCoreCount()`
 * (modules/device-cpu, backed by Android's `Runtime.getRuntime().availableProcessors()`)
 * confirms it's actually an 8-core chip (Exynos 9610, 4×Cortex-A73 +
 * 4×Cortex-A53). That "4" was coincidentally already only half the device's
 * cores, and it was STILL enough for a GBNF-grammar-constrained to-do
 * extraction to run 140+ seconds and starve the OS's own input-dispatch and
 * render threads of CPU time for that entire stretch — an "everything is
 * frozen, no crash, no exception" symptom that survived a long series of
 * UI-layer fixes, because the real cause was never in the UI at all.
 *
 * This context is shared by both interactive RAG chat and the background
 * to-do extraction (services/ai/transformationEngine.ts), via one
 * serialized completion queue (runQueuedLlamaCompletion below) — llama.rn's
 * thread pool is attached once when the context loads and is NOT
 * reconfigurable per completion call (confirmed against llama.rn's own
 * native source: a per-call `n_threads` in CompletionParams updates a
 * stored params struct that nothing ever re-applies to the live threadpool
 * via `llama_set_n_threads`, so it's silently a no-op — an earlier version
 * of this fix tried exactly that, tuned for extraction alone, before this
 * was discovered). One shared value has to be conservative enough to cover
 * BOTH — including a background task nobody's watching a spinner for — so a
 * FIXED PROPORTION of the device's cores, not a fixed thread count, is what
 * generalizes: even reserving half (this device's actual real-world
 * behavior for months) already froze the whole app, so this reserves three
 * quarters of the device's cores for the OS/UI, using at most a quarter for
 * inference — 1 thread on a 4-core device, 2 on this 8-core one, 4 on a
 * 16-core device, and so on. This does trade some completion speed (both
 * chat and extraction genuinely run slower) for the one property that
 * actually matters more: the app staying responsive while either runs. If
 * the native call ever fails, 2 threads is a safe floor for an unknown
 * device.
 *
 * THE SAME FLAW THE RAM-ONLY TIER HEURISTIC HAD: a Pixel 9 (8-9 cores) and
 * this exact Galaxy A50 (8 cores, 2019 budget Exynos) get the IDENTICAL "2
 * threads" from this formula, despite one being a modern flagship with
 * cores to spare and the other being the specific device that froze at
 * DOUBLE that thread count. Confirmed on-device: a Pixel 9 tester (12GB
 * RAM, otherwise idle) measured ~2-minute retrievals with only 48 notes —
 * consistent with this same 2-thread starvation, not a device that's
 * actually slow. Core count alone can't tell these two devices apart any
 * more than RAM alone could tell a capable device from an incapable one
 * for model-tier selection (see [[ram-tier-bad-proxy-for-cpu]]) — so this
 * function no longer tries to guess harder from static specs. It still
 * returns this same conservative default, UNCHANGED, unless
 * `maybeAttemptThreadEscalation()` (services/ai/modelDownloadManager.ts)
 * has already run a REAL trial on THIS device and measured a higher
 * thread count as genuinely, meaningfully faster — see that function and
 * `attemptThreadEscalation()` below for the measured-not-guessed escalation
 * this now defers to, mirroring `attemptTierUpgrade`'s own trial/keep/
 * rollback shape exactly.
 */
export async function computeInferenceThreadCount(): Promise<number> {
  const prefs = await readPreferences();
  if (prefs.llamaThreadCount !== null) {
    return prefs.llamaThreadCount;
  }
  const cores = getCpuCoreCount();
  if (!cores) {
    return 2;
  }
  return Math.max(1, Math.floor(cores / 4));
}

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
/**
 * Build 38 PREFIX HARMONIZATION: this exact string (word-for-word,
 * including its trailing "\n\n") is also the opening of
 * transformationEngine.ts's extraction system prompt — see
 * `SHARED_XAYRA_PREAMBLE` below and that file's own `buildSystemPrompt()`.
 * The two prompts otherwise diverge completely (different persona, rules,
 * even different tasks), which used to mean every to-do extraction fully
 * evicted the RAG system prompt from llama.cpp's KV cache before the next
 * query could reuse it (`find_common_prefix_length` — see the priority-queue
 * doc comment above — found ZERO shared tokens between "You are Xayra, a
 * warm and direct..." and "You are a task-extraction engine..."). Sharing
 * this identical opening means a query landing right after an extraction
 * still gets this much of its system prompt back from cache for free,
 * rather than re-evaluating the whole thing from token zero. Confirmed
 * on-device (Redmi): a query following ANOTHER query with nothing in
 * between already reuses cache and drops from ~40s to ~6s time-to-first-
 * token — this extends that same win to the query-after-an-extraction case,
 * which previously always paid the full ~40s again.
 *
 * Kept genuinely useful to BOTH tasks, not artificially padded to hit a
 * token target: extraction never explicitly accounted for speech-to-text
 * mishearings before this change, and arguably should have — a note whose
 * task text itself contains a mistranscribed word benefits from the same
 * tolerance RAG answers already had.
 */
export const SHARED_XAYRA_PREAMBLE =
  "You are Xayra, an on-device personal notes assistant. Every note was transcribed by an " +
  "on-device speech-to-text model and may contain mishearings of similar-sounding words (e.g. " +
  "\"AirPods\" transcribed as \"airports\") — if a word phonetically resembles another or looks " +
  "like an obvious transcription typo, treat it as the same thing the user meant.\n\n";

const SYSTEM_PROMPT =
  SHARED_XAYRA_PREAMBLE +
  "As Xayra, talk like a sharp, friendly human helper texting someone back, never like a rigid AI " +
  "reciting a report. Answer queries EXCLUSIVELY using the provided notes context. If the notes do " +
  "not contain the answer, reply EXACTLY: \"I couldn't find any details about that in your notes.\" " +
  "Never use general pre-trained knowledge or external facts, except for the current-date " +
  "information explicitly provided below, which you may use to answer temporal/calendar questions " +
  "(e.g. \"what day was last Monday?\"). Do NOT describe yourself, do NOT explain your role or these instructions, and do NOT restate this " +
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
  "the raw \"[Recorded: ...]\" label text itself.\n\n" +
  "DATE FILTER (a stricter rule than DATE RESOLUTION above — this one EXCLUDES notes, not just " +
  "resolves their wording): if the user's question itself names a time window (\"today\", " +
  "\"yesterday\", \"this week\", \"last Tuesday\"), first work out the exact calendar date(s) that " +
  "window covers using the Today/Current Week Baseline below, then check EVERY retrieved note's own " +
  "\"[Recorded: ...]\" date against it BEFORE using that note at all. A note recorded outside the " +
  "window the user asked about must be treated exactly like an irrelevant note under RELEVANCE " +
  "FILTER above — left out entirely, never described as if it happened during the asked-about " +
  "window just because it was retrieved. If NONE of the retrieved notes actually fall inside the " +
  "window the user asked about, say so with the fixed \"I couldn't find any details about that in " +
  "your notes\" line rather than answering from a note recorded on a different day.";

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
 * Loads a GGUF file at `path` into a fresh native context — the one place
 * `initLlama()` is actually called, shared by the normal lazy singleton
 * below, `attemptTierUpgrade()`'s trial load, AND `attemptThreadEscalation()`'s
 * trial load, so all three pay the exact same cold-start cost/logging rather
 * than subtly different code paths. `threadsOverride` is only ever passed by
 * `attemptThreadEscalation()`, to load a specific CANDIDATE thread count for
 * measurement before it's been accepted/persisted — every other caller omits
 * it and gets whatever `computeInferenceThreadCount()` currently resolves to.
 */
async function loadContext(path: string, label: string, threadsOverride?: number): Promise<LlamaContext> {
  const coldStart = nowMs();
  console.log(`[Llama] Initialized Model: ${label} (q4_k_m)`);
  const threads = threadsOverride ?? (await computeInferenceThreadCount());
  // Build 26: `use_mmap: true` maps the GGUF file straight into the
  // process's address space instead of reading it into a heap buffer — the
  // OS page-caches it, so a released-then-reloaded context (or a second cold
  // start after a background app kill) is materially faster to reload since
  // the pages are often still resident. (Named `use_mmap`, not `useMmap` —
  // llama.rn's option names mirror llama.cpp's own C API snake_case, same as
  // n_ctx/n_threads below.)
  const context = await initLlama({ model: path, n_ctx: 4096, n_threads: threads, use_mmap: true });
  logDuration("Llama cold-start (GGUF model load from disk)", coldStart);
  return context;
}

/**
 * Loading the GGUF model is expensive, so the context is created once and
 * reused across calls. If creation fails, the next call retries instead of
 * replaying a cached rejection forever.
 */
async function getContext(): Promise<LlamaContext> {
  if (!contextPromise) {
    contextPromise = resolveModelPath().then(({ path, label }) => loadContext(path, label));
    contextPromise.catch(() => {
      contextPromise = null;
    });
  }
  return contextPromise;
}

/** A moderate 32-token trial generation — long enough that llama.cpp's
 * `predicted_per_second` reflects real sustained decode speed rather than
 * fixed per-call overhead (the 1-token prewarm completion is too short for
 * this), short enough not to burn several more minutes on a device that's
 * about to fail the trial anyway. */
const TRIAL_N_PREDICT = 32;

/**
 * Opportunistic 1B -> 3B upgrade trial — see
 * services/ai/modelDownloadManager.ts's `maybeAttemptTierUpgrade()` for the
 * eligibility gating (RAM floor + real 1B performance history) that decides
 * WHETHER to call this at all. Deliberately releases the current (1B)
 * context BEFORE loading the candidate, rather than briefly holding both
 * multi-hundred-MB-to-multi-GB models resident at once — this device class
 * is exactly the kind where that could tip into OOM territory (confirmed
 * on-device: a lone 3B context alone already sits around 3.6GB RSS). The
 * cost is a real (if brief) window with no usable context if the trial
 * fails and the fallback reload is still in flight — acceptable since this
 * only ever runs at a quiet moment (see the caller), never mid-answer.
 *
 * Runs as a `runExclusiveLlamaTask()` job (see that function's own doc
 * comment), not by calling `releaseLocalLlama()` directly — releasing the
 * shared context is only safe once nothing else can possibly still be
 * mid-completion on it, which only the shared queue itself can guarantee.
 */
export async function attemptTierUpgrade(
  candidatePath: string,
  candidateLabel: string,
  fallbackPath: string,
  fallbackLabel: string
): Promise<{ passed: boolean; tokensPerSecond: number }> {
  return runExclusiveLlamaTask(async () => {
    await releaseLocalLlama();

    const candidateContext = await loadContext(candidatePath, candidateLabel);
    const result = await candidateContext.completion({ prompt: WARMUP_PROMPT, n_predict: TRIAL_N_PREDICT }, () => {});
    const tokensPerSecond = result.timings?.predicted_per_second ?? 0;
    const passed = tokensPerSecond >= MIN_USABLE_TOKENS_PER_SECOND;

    if (passed) {
      // Promote the already-loaded, already-warm trial context to be the new
      // shared singleton — avoids paying a second full load for the exact
      // model that just proved itself.
      contextPromise = Promise.resolve(candidateContext);
    } else {
      await candidateContext.release();
      contextPromise = loadContext(fallbackPath, fallbackLabel);
      contextPromise.catch(() => {
        contextPromise = null;
      });
      await contextPromise;
    }

    return { passed, tokensPerSecond };
  });
}

/**
 * A device needs to beat its own current baseline by at least this multiple
 * for a thread-escalation trial to count as a real, meaningful win — not
 * merely "above `MIN_USABLE_TOKENS_PER_SECOND`" the way `attemptTierUpgrade`
 * checks. The two questions are genuinely different: tier upgrade asks "is
 * 3B usable at all," a fixed absolute bar; thread escalation asks "did
 * MORE THREADS help THIS device," which only a comparison against this same
 * device's own prior measured speed can answer — a device already well
 * above the usable floor could still be pushed backwards by over-threading
 * (contention, thermal throttling from sustaining more cores at once), and
 * comparing only against the fixed floor would miss that regression
 * entirely. 1.3x (not just >1.0x) leaves room for ordinary run-to-run noise
 * — a candidate that's merely "about the same" isn't worth having traded
 * away 2+ more cores of OS/UI headroom for.
 */
const THREAD_ESCALATION_MIN_IMPROVEMENT_MULTIPLE = 1.3;

/**
 * Opportunistic thread-count escalation trial — see
 * services/ai/modelDownloadManager.ts's `maybeAttemptThreadEscalation()` for
 * the eligibility gating (RAM floor, minimum core count, real throughput
 * history at the CURRENT thread count) that decides WHETHER to call this at
 * all. Mirrors `attemptTierUpgrade()`'s exact trial/keep/rollback shape,
 * applied to `n_threads` instead of model size: load a candidate thread
 * count, run one real trial completion, keep it only if it's a genuine,
 * meaningful win over this device's own prior measured baseline — otherwise
 * reload at the previous (already-known-safe) thread count and leave this
 * device on its existing default, permanently (the caller marks this
 * "rejected" — same reasoning as a failed tier trial: the underlying CPU/
 * core layout doesn't change between app launches, so there's nothing to
 * gain by re-trying the same candidate later).
 *
 * Runs as a `runExclusiveLlamaTask()` job — see that function's own doc
 * comment for why this can never call `releaseLocalLlama()` directly.
 */
export async function attemptThreadEscalation(
  candidateThreads: number,
  baselineTokensPerSecond: number
): Promise<{ passed: boolean; tokensPerSecond: number }> {
  return runExclusiveLlamaTask(async () => {
    const { path, label } = await resolveModelPath();
    const previousThreads = await computeInferenceThreadCount();

    await releaseLocalLlama();

    const candidateContext = await loadContext(path, label, candidateThreads);
    const result = await candidateContext.completion({ prompt: WARMUP_PROMPT, n_predict: TRIAL_N_PREDICT }, () => {});
    const tokensPerSecond = result.timings?.predicted_per_second ?? 0;
    const passed = tokensPerSecond >= baselineTokensPerSecond * THREAD_ESCALATION_MIN_IMPROVEMENT_MULTIPLE;

    if (passed) {
      contextPromise = Promise.resolve(candidateContext);
    } else {
      await candidateContext.release();
      contextPromise = loadContext(path, label, previousThreads);
      contextPromise.catch(() => {
        contextPromise = null;
      });
      await contextPromise;
    }

    return { passed, tokensPerSecond };
  });
}

/** How long an onboarding-time calibration trial is allowed to run before
 * it's treated as "this device struggled" and cut off — see
 * `attemptOptimisticThreadCalibration()`'s own doc comment. Generous enough
 * that a genuinely capable device (this app's actual target user base)
 * finishes in a small fraction of this; short enough that a device which
 * can't handle the optimistic thread count doesn't stall onboarding for
 * anywhere near the ~2-minute delays this whole feature exists to
 * prevent. */
const CALIBRATION_TIMEOUT_MS = 12_000;

/**
 * Runs exactly once, from `OnboardingSetupScreen.tsx`'s "Tuning quick-recall
 * for your device" step, before the user has asked a single real question —
 * NOT the conservative-then-escalate design `attemptThreadEscalation` above
 * is, and deliberately so. Product call, not a technical default: this
 * app's real target users are 2023+ flagship-class devices, not the 2019
 * budget phones this codebase also keeps around for edge-case testing, so
 * the FIRST thing tried is optimistic (reserve only 2 cores for the OS, use
 * everything else for inference), not the safe default — earning your way
 * DOWN from ambitious is the design, not earning your way up from
 * conservative. A capable device (the common case) gets its best real
 * thread count from its very first genuine query onward, with zero extra
 * wait added to that query — the whole calibration cost lands inside a
 * setup screen the user is already waiting through for model downloads,
 * never on an interaction that actually matters to how the app is judged.
 *
 * Bounded and cancellable, not a blind gamble: `stopCompletion()` (llama.rn)
 * lets a stalling trial be cut off cleanly rather than left to hang
 * onboarding — a genuinely weak device that slips through this app's real
 * user base still completes setup normally, just on the same conservative
 * quarter-of-cores default this app always used, with a second chance
 * later via `maybeAttemptThreadEscalation()` (modelDownloadManager.ts) once
 * it has real usage history to measure against — that function's own
 * conservative-then-escalate design is exactly right as a SECOND-CHANCE
 * safety net, just wrong as the very first thing every device tries.
 *
 * Runs as a `runExclusiveLlamaTask()` job, not by calling
 * `releaseLocalLlama()` directly — confirmed on-device why this matters:
 * an earlier version of this function called it directly and hung the app
 * during onboarding, no error, no crash, just a `release()` call that
 * never returned, because `prewarmLocalLlama()`'s own 1-token warm-up
 * completion was still in-flight on the very context this function was
 * simultaneously trying to tear down. See `runExclusiveLlamaTask()`'s own
 * doc comment for the full explanation.
 */
export async function attemptOptimisticThreadCalibration(): Promise<
  { calibrated: true; threads: number; tokensPerSecond: number } | { calibrated: false }
> {
  const cores = getCpuCoreCount();
  const conservativeThreads = cores ? Math.max(1, Math.floor(cores / 4)) : 2;
  if (!cores || cores < 3) {
    return { calibrated: false }; // Nothing to gain — reserving 2 cores leaves this device no real headroom to try.
  }

  const candidateThreads = Math.max(1, cores - 2);
  if (candidateThreads <= conservativeThreads) {
    return { calibrated: false };
  }

  return runExclusiveLlamaTask(async () => {
    const { path, label } = await resolveModelPath();
    await releaseLocalLlama();
    const candidateContext = await loadContext(path, label, candidateThreads);

    const completionPromise = candidateContext.completion({ prompt: WARMUP_PROMPT, n_predict: TRIAL_N_PREDICT }, () => {});
    const timedOut = await Promise.race([
      completionPromise.then(() => false),
      new Promise<true>((resolve) => setTimeout(() => resolve(true), CALIBRATION_TIMEOUT_MS)),
    ]);

    if (timedOut) {
      // Cuts the actual native work short rather than leaving it running in
      // the background — without this, a struggling device would keep
      // burning CPU on the abandoned trial underneath whatever runs next.
      await candidateContext.stopCompletion().catch(() => {});
      // The real completion may still resolve or reject shortly after being
      // asked to stop — swallow it here so it can't surface as an unhandled
      // rejection later, unobserved. Its result is discarded either way.
      await completionPromise.catch(() => {});
      await candidateContext.release().catch(() => {});
      contextPromise = loadContext(path, label, conservativeThreads);
      contextPromise.catch(() => {
        contextPromise = null;
      });
      await contextPromise;
      return { calibrated: false };
    }

    const result = await completionPromise;
    const tokensPerSecond = result.timings?.predicted_per_second ?? 0;
    if (tokensPerSecond < MIN_USABLE_TOKENS_PER_SECOND) {
      // Finished inside the timeout but still not genuinely usable —
      // unlikely (a device this slow almost always times out first
      // instead), but handled the same way as a timeout for safety: fall
      // back, don't keep it.
      await candidateContext.release().catch(() => {});
      contextPromise = loadContext(path, label, conservativeThreads);
      contextPromise.catch(() => {
        contextPromise = null;
      });
      await contextPromise;
      return { calibrated: false };
    }

    contextPromise = Promise.resolve(candidateContext);
    return { calibrated: true, threads: candidateThreads, tokensPerSecond };
  });
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
 * Exposes the same shared, lazily-loaded llama.cpp context RAG answers use
 * to other on-device services that need raw completions of their own —
 * currently services/ai/transformationEngine.ts's to-do extraction pass.
 * Deliberately the same singleton as generateLocalRAGAnswer() below rather
 * than a second `initLlama()` call: a phone can't spare the memory for two
 * multi-GB GGUF models resident at once, and every caller sharing one
 * context also means whichever ran last keeps the model warm for the next.
 */
export async function getSharedLlamaContext(): Promise<LlamaContext> {
  return getContext();
}

/**
 * A native llama.cpp context allows exactly one in-flight `completion()` at
 * a time — a second call while one is already running throws natively
 * ("context is busy"). That was a non-issue back when RAG generation was the
 * only caller (one answer requested at a time, by definition), but
 * transformationEngine.ts's background to-do extraction changed that: saving
 * several notes in quick succession fires several `extractToDosFromText`
 * calls concurrently, all racing on this one shared context.
 *
 * Confirmed on-device (Phase 2 Step 2 testing): saving 5 notes back-to-back
 * (4 text, 1 voice) produced only 1 extracted to-do — the other 4 each hit
 * "context is busy" mid-completion, which transformationEngine.ts's own
 * catch-and-return-[] swallowed silently (correctly, per its own
 * never-block-note-saving contract) with no visible symptom beyond the
 * missing to-dos themselves.
 *
 * Fixed by queuing every completion through one shared queue rather than
 * calling `context.completion()` directly from more than one place — every
 * caller now waits its turn instead of racing.
 *
 * Upgraded from a plain FIFO chain to a PRIORITY queue after a second
 * on-device finding: a live "Ask" answer queued strictly behind several
 * already-pending background to-do extractions waited several extra minutes
 * for its turn, even though the user was actively watching a "Thinking..."
 * spinner and the extractions had no one waiting on them at all.
 * `runQueuedLlamaCompletion`'s `priority` param lets `generateLocalRAGAnswer()`
 * (a person is actively watching) jump ahead of any not-yet-started
 * `transformationEngine.ts` extraction (no one waiting, tolerates being
 * delayed) already sitting in the queue — the same "interactive requests
 * preempt queued background work" pattern used by production LLM-serving
 * systems, adapted to what a single mobile llama.cpp context actually allows.
 *
 * Upgraded a THIRD time after an on-device report (Redmi, Build 35): a live
 * query still waited out a background extraction that had already started
 * running before the query arrived — reordering the WAITING list can't help
 * a job that's already mid-generation. llama.cpp has no API to pause/resume
 * an in-flight completion (that needs KV-cache save/restore machinery this
 * library doesn't expose), but `stopCompletion()` (llama.rn) can cut one
 * short. `enqueue()` now calls it on an in-flight BACKGROUND completion the
 * instant an interactive one arrives; `processCompletionQueue()` recognizes
 * the resulting early settle as a preemption (not a real result) and
 * re-enqueues the same background job to retry from scratch once the
 * context is free again, rather than resolving its caller with a truncated
 * answer. A background extraction is a bounded, restartable, idempotent
 * task (transformationEngine.ts re-derives to-dos from the note's full text
 * every time), so replaying it from the top costs nothing but a little
 * extra CPU time — never a wrong or partial result.
 */
/**
 * Build 39: thrown when a completion the USER explicitly asked to stop
 * (via `cancelActiveLlamaCompletion()`) settles — as opposed to a genuine
 * model/native error. Callers (generateRAGAnswer/rag.ts) catch this
 * specifically to skip showing a broken/partial answer and skip speaking
 * anything, rather than surfacing it as a failure toast.
 */
export class LlamaCancelledError extends Error {
  constructor(message = "Cancelled by user.") {
    super(message);
    this.name = "LlamaCancelledError";
  }
}

type CompletionPriority = "interactive" | "background";

type QueuedCompletion = {
  kind: "completion";
  params: CompletionParams;
  onToken?: (data: TokenData) => void;
  resolve: (result: NativeCompletionResult) => void;
  reject: (err: unknown) => void;
  /** Set true by `enqueue()` the moment this job is preempted mid-run by an
   * arriving interactive job (see `processCompletionQueue()` below). Lets the
   * settle handler tell "cut short on purpose, retry it" apart from "a real
   * result/error" without needing a second out-of-band signal. */
  preempted?: boolean;
  /** Set true by `cancelActiveLlamaCompletion()` (Build 39) — the user
   * themselves asked for this exact answer to stop, as opposed to being
   * bumped by a higher-priority job. Unlike `preempted`, this does NOT
   * retry: the caller never wanted this completion to finish at all, so the
   * settle handler rejects with `LlamaCancelledError` instead. */
  userCancelled?: boolean;
};

/**
 * A second job kind sharing this same queue — see `runExclusiveLlamaTask()`
 * below for why. `run()` gets no context handed to it: a task that needs one
 * (as every current caller does) resolves it itself, since the whole reason
 * a task exists is to RECONFIGURE that context (release + reload at a
 * different thread count), not just read the existing one.
 */
type QueuedTask = {
  kind: "task";
  run: () => Promise<unknown>;
  resolve: (result: unknown) => void;
  reject: (err: unknown) => void;
};

type QueuedJob = QueuedCompletion | QueuedTask;

let isCompletionRunning = false;
/** The job currently executing, plus the context it's running on once
 * resolved — tracked specifically so `enqueue()` can reach in and call
 * `stopCompletion()` on an in-flight BACKGROUND completion the moment an
 * interactive job arrives (see this block's own doc comment above). `null`
 * whenever nothing is running, or the running job is a `QueuedTask` (a
 * release/reload sequence is never a preemption candidate — nothing should
 * ever interrupt it mid-flight). */
let runningCompletion: { job: QueuedCompletion; priority: CompletionPriority; context: LlamaContext | null } | null =
  null;

/** Kept sorted: every "interactive" job before every "background" job;
 * stable (FIFO) within the same priority. A newly-arrived interactive job
 * is spliced in ahead of any waiting background jobs, and — new in Build
 * 36 — also preempts a background completion already running, rather than
 * only ones still waiting (see this whole block's own doc comment). */
const waitingCompletions: { priority: CompletionPriority; job: QueuedJob }[] = [];

/**
 * Build 41 hardening fix, found live during Phase 1 on-device verification
 * (qa/06-phase-execution-roadmap.md): llama.rn's own `.d.ts` types
 * `stopCompletion()` as always returning `Promise<void>`, but confirmed
 * on-device that it can genuinely return `undefined` at runtime instead
 * (a native JSI-bridge edge case, not something this app's TS types can see
 * coming) — calling `.catch()` directly on that throws synchronously
 * ("Cannot read property 'catch' of undefined"), and since this call sits
 * inside `enqueue()`'s own synchronous body, that throw propagated all the
 * way out through `runExclusiveLlamaTask()`'s `new Promise(executor)` and
 * silently failed the whole task (a synchronous throw inside a Promise
 * executor becomes that promise's rejection). This existed since Build 36's
 * original preemption fix but was never reachable in practice until Build
 * 41's `releaseLocalLlamaOnBackground()` — the first "interactive"-priority
 * job that can genuinely arrive at ANY moment, including while a background
 * extraction is actively running, which is exactly the condition that
 * triggers this preemption path. `Promise.resolve(...)` guarantees a real
 * thenable regardless of what the underlying call returns; the outer
 * try/catch additionally guards against `stopCompletion()` itself throwing
 * synchronously rather than returning a rejected promise — either way, this
 * call is already best-effort/fire-and-forget by design.
 */
function safelyStopCompletion(context: LlamaContext): void {
  try {
    void Promise.resolve(context.stopCompletion()).catch(() => {});
  } catch {
    // Swallowed — see this function's own doc comment.
  }
}

function enqueue(priority: CompletionPriority, job: QueuedJob): void {
  if (priority === "interactive") {
    const firstBackgroundIndex = waitingCompletions.findIndex((w) => w.priority === "background");
    const insertAt = firstBackgroundIndex === -1 ? waitingCompletions.length : firstBackgroundIndex;
    waitingCompletions.splice(insertAt, 0, { priority, job });

    if (runningCompletion && runningCompletion.priority === "background" && runningCompletion.context) {
      runningCompletion.job.preempted = true;
      // Fire-and-forget: the cut-short completion settles on its own turn
      // (see processCompletionQueue's "completion" branch), which is what
      // actually frees the queue for this interactive job — nothing here
      // needs to await it.
      safelyStopCompletion(runningCompletion.context);
    }
  } else {
    waitingCompletions.push({ priority, job });
  }
  processCompletionQueue();
}

function processCompletionQueue(): void {
  if (isCompletionRunning) {
    return;
  }
  const next = waitingCompletions.shift();
  if (!next) {
    return;
  }
  isCompletionRunning = true;
  const { job, priority } = next;

  if (job.kind === "completion") {
    runningCompletion = { job, priority, context: null };
  }

  const settled: Promise<void> =
    job.kind === "completion"
      ? getContext()
          .then((context) => {
            if (runningCompletion?.job === job) {
              runningCompletion.context = context;
            }
            return context.completion(job.params, job.onToken);
          })
          .then((result) => {
            if (job.userCancelled) {
              // The user themselves asked this exact answer to stop — never
              // retry, never resolve with whatever partial text streamed
              // before the cut. See LlamaCancelledError's own doc comment.
              job.reject(new LlamaCancelledError());
              return;
            }
            if (job.preempted) {
              // Cut short on purpose to let an interactive job through, not
              // a real result — replay the same job from scratch instead of
              // resolving its caller with a truncated answer. Pushed to the
              // BACK of its own priority band (plain `enqueue`, not spliced
              // to the front) so a retried background job can't starve
              // whatever interactive work is now running ahead of it.
              job.preempted = false;
              enqueue(priority, job);
              return;
            }
            // Real-world throughput telemetry — see modelPerformanceTracker.ts.
            // Skips the throwaway single-token prewarm completion
            // (n_predict: 1): one predicted token is too noisy a sample, and
            // native `timings` for it is dominated by fixed per-call
            // overhead rather than sustained decode speed.
            // `predicted_per_second` comes straight from llama.cpp's own
            // native timing, not a derived JS wall-clock measurement, so it
            // isn't polluted by this queue's own wait time.
            if (job.params.n_predict !== 1 && result.timings) {
              void recordCompletionSpeed(result.timings.predicted_per_second);
            }
            job.resolve(result);
          }, (err) => {
            if (job.userCancelled) {
              job.reject(new LlamaCancelledError());
              return;
            }
            if (job.preempted) {
              // stopCompletion() rejecting instead of resolving is just as
              // much "cut short on purpose" as a resolve — retry either way.
              job.preempted = false;
              enqueue(priority, job);
              return;
            }
            job.reject(err);
          })
      : job.run().then(job.resolve, job.reject);

  void settled.finally(() => {
    isCompletionRunning = false;
    runningCompletion = null;
    processCompletionQueue();
  });
}

/**
 * Runs a completion against the shared context, queued against every other
 * pending completion (see the priority-queue doc comment above). Exported so
 * transformationEngine.ts's to-do extraction (`priority: "background"`)
 * shares the same queue as RAG generation (`priority: "interactive"`) below,
 * rather than calling `context.completion()` directly.
 */
export function runQueuedLlamaCompletion(
  params: CompletionParams,
  priority: CompletionPriority,
  onToken?: (data: TokenData) => void
): Promise<NativeCompletionResult> {
  return new Promise((resolve, reject) => {
    enqueue(priority, { kind: "completion", params, onToken, resolve, reject });
  });
}

/**
 * Build 39: lets the UI stop whatever RAG answer is CURRENTLY GENERATING
 * the moment a user realizes they misspoke and wants it to not go through
 * — see app/index.tsx's "tap the record button again to cancel" handler.
 * A no-op if nothing is running, or if what's running is a background
 * extraction/task rather than the user's own interactive query (this is
 * deliberately scoped to "cancel MY OWN in-flight answer," never someone
 * else's background work). Marking `userCancelled` here, rather than
 * rejecting directly, is what lets `processCompletionQueue()`'s own settle
 * handler turn the native cut-short into a clean `LlamaCancelledError`
 * instead of resolving with whatever partial text had streamed so far.
 */
export function cancelActiveLlamaCompletion(): void {
  if (runningCompletion && runningCompletion.priority === "interactive" && runningCompletion.context) {
    runningCompletion.job.userCancelled = true;
    void runningCompletion.context.stopCompletion().catch(() => {});
  }
}

/**
 * Runs an arbitrary async task with EXCLUSIVE access to the shared Llama
 * context — no regular completion (RAG answer, background extraction, the
 * app-boot prewarm) can start while it's running, and it never starts while
 * one of those is already running. Exists specifically for
 * `attemptOptimisticThreadCalibration()`/`attemptThreadEscalation()` below,
 * both of which need to `releaseLocalLlama()` and reload a candidate
 * context — an operation that is NOT safe to run concurrently with a
 * regular completion (see this whole block's own doc comment above: a
 * native llama.cpp context allows exactly one in-flight operation at a
 * time, and releasing one out from under an in-flight completion is worse
 * than the "context is busy" error that motivated this queue in the first
 * place — confirmed on-device: it hung the app during onboarding, no
 * error, no crash, just a `release()` call that never returned, because
 * `prewarmLocalLlama()`'s own 1-token warm-up completion was still
 * in-flight on the very context being torn down). Routing the whole
 * release-reload-trial sequence through this same queue, instead of
 * calling `releaseLocalLlama()` directly, is what actually fixes that: by
 * the time this task's turn comes up, nothing else can possibly be
 * mid-completion on the context it's about to tear down.
 */
export function runExclusiveLlamaTask<T>(task: () => Promise<T>, priority: CompletionPriority = "interactive"): Promise<T> {
  return new Promise((resolve, reject) => {
    enqueue(priority, {
      kind: "task",
      run: task,
      // Safe: this Promise's own executor is the only caller of these, and
      // `T` here is always exactly what `task()` resolves with — the
      // `unknown` typing on `QueuedTask` only exists so one shared queue
      // array can hold task jobs of different result types side by side.
      resolve: resolve as (result: unknown) => void,
      reject,
    });
  });
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
  await getContext();
  logDuration("Llama context ready (warm reuse if already loaded)", contextReadyStart);

  const fullPrompt = buildPrompt(prompt, noteContext);
  // Character count only, never content — this is what actually explains a
  // slow TTFT below: prefill (reading the prompt) scales with how much of
  // it there is, on every device, unlike decode speed which depends on the
  // specific chip. Left in permanently (not a temporary debug log) since
  // without it, a length-vs-latency correlation is invisible after the fact
  // for any future report like this one.
  console.log(`[Llama] Prompt length: ${fullPrompt.length} chars`);

  const generationStart = nowMs();
  let firstTokenLogged = false;

  const result = await runQueuedLlamaCompletion(
    {
      prompt: fullPrompt,
      n_predict: 512,
      temperature: GENERATION_TEMPERATURE,
      top_p: TOP_P,
      penalty_repeat: REPEAT_PENALTY,
      stop: [EOT_TOKEN, "<|end_of_text|>"],
    },
    "interactive", // a person is actively watching this — jumps ahead of any queued background extraction
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

/** A minimal, throwaway prompt for the silent warm-up pass below — real
 * instruct-template turn markers so llama.cpp exercises the actual
 * generation path, not a bare string it would reject or mishandle. */
const WARMUP_PROMPT =
  "<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\nHi<|eot_id|>" +
  "<|start_header_id|>assistant<|end_header_id|>\n\n";

/**
 * Fire-and-forget: loads the GGUF model into native memory AND runs one
 * silent, 1-token dummy generation ahead of the first real question, so
 * neither cost lands on the user's first real "Ask". Build 26 INVESTIGATE
 * INFERENCE STALL: `getContext()` alone (Build 25 and earlier) only loads
 * the model's weights — llama.cpp's KV-cache allocation and thread-pool
 * spin-up are lazily initialized on the first real `completion()` call
 * instead, which is why a query submitted right after a fresh model
 * download still paid several extra seconds of latency the "cold-start"
 * timing log never accounted for. This throwaway `n_predict: 1` completion
 * (its output is discarded — `() => {}` ignores every token) forces that
 * machinery to spin up here, off the user's critical path, so by the time
 * they actually tap "Ask" the context is already fully hot.
 *
 * Runs on whichever native thread llama.rn's own `completion()` uses (not
 * the JS thread) — same as every other call into the model — so this never
 * blocks the UI. Swallows its own error — a model not downloaded yet, or a
 * corrupt file, is exactly what the real call will surface properly when
 * it's actually needed; prewarming has nobody to report a failure to.
 *
 * Called from two places (see services/ai/enginePrewarmer.ts for app-launch
 * prewarm, and modelDownloadManager.ts's `setStatus` for the moment a
 * download that just finished flips status to "ready") — both routes
 * through this one function, so app-boot-with-model-already-present and
 * download-completes-live are covered by the same warm-up path.
 */
/**
 * Build 26 fix, found on-device: with two independent call sites now
 * triggering this (app-mount prewarm AND modelDownloadManager's "just
 * became ready" hook), both firing at boot when the model is already on
 * disk raced to run the dummy `completion()` below on the SAME shared
 * context at once — llama.rn allows only one in-flight completion per
 * context, so the loser failed with "Context is busy" (visible in the
 * Metro log). Deduping here, the same pattern `getContext()` itself already
 * uses for context creation, means every caller shares one warm-up
 * in-flight promise instead of racing independent attempts.
 */
let warmupPromise: Promise<void> | null = null;

/**
 * Build 38 REAL-PREFIX PREWARM: `WARMUP_PROMPT` above is deliberately a
 * throwaway one-word prompt — fine for `attemptTierUpgrade`/
 * `attemptThreadEscalation`'s trial completions, which only need to measure
 * DECODE speed and want the smallest possible prompt so their trial finishes
 * quickly. But using it here, for the actual production warm-up, bought
 * this app nothing toward the real cost a user's first query pays: "Hi"
 * shares zero tokens with the real RAG system prompt, so the KV cache this
 * warm-up populates was never reused by anything.
 *
 * `buildPrompt("", "")` instead runs the ENTIRE real system prompt + date
 * baseline + few-shot exchange — everything that's identical on every query
 * for the rest of this calendar day — through prefill once, silently, at
 * boot. The empty query/note-context arguments mean the prompt tokenizes
 * identically to a real query up through the end of the few-shot exchange,
 * then diverges (empty vs. real retrieved notes + question) exactly where
 * genuinely query-specific content has to start regardless. `find_common_
 * prefix_length` (see the priority-queue doc comment above) then reuses
 * everything up to that divergence point on the user's actual first
 * question — the same mechanism already confirmed on-device to take a
 * second query's time-to-first-token from ~40s to ~6s, now extended to
 * cover the FIRST query of a session too, not just the second.
 */
function buildCacheWarmupPrompt(): string {
  return buildPrompt("", "");
}

/**
 * Build 38 regression, found on-device the same day this prewarm got
 * heavier: making the boot-time warm-up run the REAL system prompt instead
 * of a throwaway "Hi" means it now costs roughly what a cold first query
 * used to (~30-40s of prefill on the Redmi) — cheap before, genuinely
 * expensive now. A user who starts recording within that window has their
 * Whisper transcription running on the SAME CPU at the SAME time as this
 * warm-up's heavy prefill, with nothing coordinating the two — confirmed
 * on-device: a transcription that normally takes ~4.3s took 24.4s while
 * this warm-up was in flight alongside it. `transformationEngine.ts`
 * already has this exact yield-to-transcription pattern for background
 * to-do extraction (`waitForTranscriptionIdleIfNeeded`) — this mirrors it
 * for the same reason: a transcription is always something a user is
 * actively watching a "Hearing you out" stage for; this warm-up never is,
 * so it's the one that should wait, never the reverse.
 *
 * Build 42 P2-1 fix (qa/05-consolidated-triage.md P2-1): the original
 * schedule totaled only 6 seconds — less than the 24.4s worst case this
 * very doc comment already documented, meaning the gate could give up and
 * let the warm-up proceed while the transcription it exists to protect was
 * still running. Extended to comfortably exceed that measured worst case;
 * still terminates rather than waiting forever for a transcription that
 * never finishes.
 */
// Exported for the same test-only reason as transformationEngine.ts's
// identical TRANSCRIPTION_RECHECK_DELAYS_MS.
export const WARMUP_TRANSCRIPTION_RECHECK_DELAYS_MS = [1000, 2000, 3000, 5000, 8000, 10000];

async function waitForTranscriptionIdleBeforeWarmup(): Promise<void> {
  for (const delayMs of WARMUP_TRANSCRIPTION_RECHECK_DELAYS_MS) {
    if (!isTranscriptionInProgress()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  // Proceeds regardless after the retries — this is a nice-to-have
  // deferral, never a dependency the warm-up can be blocked on forever by a
  // transcription that (for whatever reason) never finishes.
}

export async function prewarmLocalLlama(): Promise<void> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      await waitForTranscriptionIdleBeforeWarmup();
      // "background": nothing is waiting on a warm-up itself, though in
      // practice it only ever runs at boot when the queue's already empty.
      await runQueuedLlamaCompletion({ prompt: buildCacheWarmupPrompt(), n_predict: 1 }, "background", () => {});
    })();
    // Same reset-on-failure as getContext()'s own contextPromise — a failed
    // warm-up (model not downloaded yet, a corrupt file) shouldn't poison
    // every later call site into skipping the warm-up forever once the
    // real condition is fixed.
    warmupPromise.catch(() => {
      warmupPromise = null;
    });
  }
  try {
    await warmupPromise;
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

/**
 * Build 41 P0 fix (qa/05-consolidated-triage.md P0-4): the only safe way to
 * release the shared context in response to the app backgrounding — see
 * `runExclusiveLlamaTask()`'s own doc comment above for why calling
 * `releaseLocalLlama()` directly already hung the app once (a warm-up
 * completion in flight on the very context being torn down). Routes the
 * release through the same exclusive-task queue every other release/reload
 * sequence already uses, so by the time this runs, nothing else can possibly
 * be mid-completion on the context.
 *
 * Priority is deliberately `"interactive"`, not `"background"`: if a
 * background job (e.g. to-do extraction) is currently running, this is
 * allowed to preempt it — the extraction is idempotent and cheap to retry
 * later, and getting memory back promptly on backgrounding matters more
 * than letting an unattended background job finish on schedule. If an
 * INTERACTIVE completion (a live RAG answer someone is actually watching)
 * is running, `enqueue()`'s own preemption logic never touches it — this
 * task simply waits in queue for that answer to finish naturally before
 * releasing, exactly as it should: backgrounding the app must never cut off
 * an answer already being generated for the user.
 */
export function releaseLocalLlamaOnBackground(): Promise<void> {
  return runExclusiveLlamaTask(() => releaseLocalLlama(), "interactive");
}
