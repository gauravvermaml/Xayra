import * as FileSystem from "expo-file-system/legacy";
// whisper.rn@0.7.2's package.json "exports" map has no root "." entry (only
// "./*" subpath patterns), so the bare "whisper.rn" specifier fails strict
// exports resolution (Node, and TS's "bundler" moduleResolution) with
// ERR_PACKAGE_PATH_NOT_EXPORTED. "whisper.rn/index" hits the "./*" pattern
// and resolves correctly — verified against the installed package.
import { initWhisper, type WhisperContext } from "whisper.rn/index";

import { logDuration, nowMs } from "./perf";
import { getActiveWhisperModel, getWhisperModelPath, type WhisperModelId } from "./whisperModels";

export type LocalTranscriptionResult = {
  transcript: string;
  modelId: WhisperModelId;
};

/**
 * whisper.cpp's own literal marker for a non-speech segment — "[BLANK_AUDIO]"
 * confirmed on-device (a real Handsfree recording came back as "Hey Xayra,
 * can you remind me to call Papa tonight at 6 p.m. [BLANK_AUDIO]"), plus its
 * documented siblings ("[SILENCE]", "[MUSIC]", "[NOISE]", "[INAUDIBLE]",
 * "(silence)"/parenthesized forms — see services/notes/noteManager.ts's own
 * BLANK_AUDIO_MARKER_PATTERN doc comment for why both bracket styles are
 * handled). Whisper emits one of these as its own transcript SEGMENT for a
 * trailing/leading silent stretch of an otherwise-real recording — a distinct
 * case from noteManager.ts's `isSilentTranscript`, which only ever asks
 * "is the WHOLE transcript nothing"; that check alone let a genuinely
 * transcribed note through with this marker still glued onto the end. This
 * strips just the marker (wherever in the string it lands), not the
 * surrounding real speech.
 */
const NON_SPEECH_MARKER_PATTERN =
  /[([]\s*(?:blank_audio|silence|music|noise|inaudible|applause|laughter)\s*[)\]]/gi;

function stripNonSpeechMarkers(text: string): string {
  return text.replace(NON_SPEECH_MARKER_PATTERN, " ").replace(/\s+/g, " ").trim();
}

let whisperContextPromise: Promise<{ context: WhisperContext; modelId: WhisperModelId }> | null = null;
let loadedModelId: WhisperModelId | null = null;

/**
 * A count, not a boolean — recordings can be transcribed back-to-back before
 * the first finishes (two notes in quick succession), so a simple flag one
 * call clears could go false while another is still genuinely in flight.
 * Whisper and Llama are two entirely separate native engines with no shared
 * queue of their own (unlike Llama's completions, which already serialize
 * through localLlama.ts's priority queue), so nothing stops them running at
 * the exact same moment and splitting the CPU between them — this exists so
 * `transformationEngine.ts`'s background to-do extraction can check it and
 * hold off starting while a transcription the user is actively watching a
 * "Transcribing..." spinner for is still using the CPU (see
 * `waitForTranscriptionIdleIfNeeded()` there, mirroring this file's own
 * thermal-gate pattern). Never gates transcription itself in the other
 * direction — a person waiting on their own note should never be delayed by
 * a background job they don't know is running.
 */
let activeTranscriptionCount = 0;

export function isTranscriptionInProgress(): boolean {
  return activeTranscriptionCount > 0;
}

/**
 * Not bundled into the app (tens/hundreds of MB) — downloaded automatically
 * in the background shortly after first launch (see
 * services/ai/modelDownloadManager.ts) rather than through any user-facing
 * picker. This still throws if a recording happens to be attempted before
 * that background download finishes; on most devices the native
 * (Tier 1) speech recognizer in asrRouter.ts covers that gap in the
 * meantime, same as it always has.
 */
async function resolveModelPath(): Promise<{ path: string; modelId: WhisperModelId }> {
  if (!FileSystem.documentDirectory) {
    throw new Error("No writable document directory available on this platform.");
  }

  const modelId = await getActiveWhisperModel();
  if (!modelId) {
    throw new Error(
      "No local Whisper model downloaded yet. Xayra downloads it automatically in the background " +
        "over Wi-Fi shortly after first launch — try again in a moment, or connect to Wi-Fi if you " +
        "haven't yet."
    );
  }

  return { path: getWhisperModelPath(), modelId };
}

/** Called once the background download completes so the next transcription
 * picks up the newly-downloaded model instead of replaying a cached
 * "not downloaded yet" rejection from before it existed. */
export function resetWhisperContext(): void {
  whisperContextPromise = null;
  loadedModelId = null;
}

/**
 * initWhisper() loads the GGML model into native memory — expensive, so the
 * context is created once and reused across every transcription call rather
 * than per-recording. If initialization fails, or the active model has
 * changed since the context was created, the next call (re)loads instead of
 * being stuck replaying a cached rejection or a stale engine.
 */
async function getWhisperContext(): Promise<{ context: WhisperContext; modelId: WhisperModelId }> {
  const currentModelId = await getActiveWhisperModel();
  if (whisperContextPromise && loadedModelId !== null && loadedModelId !== currentModelId) {
    resetWhisperContext();
  }

  if (!whisperContextPromise) {
    const coldStart = nowMs();
    whisperContextPromise = resolveModelPath()
      .then(async ({ path, modelId }) => {
        const context = await initWhisper({ filePath: path });
        loadedModelId = modelId;
        logDuration(`Whisper cold-start (${modelId} model load from disk)`, coldStart);
        return { context, modelId };
      });
    whisperContextPromise.catch(() => {
      whisperContextPromise = null;
      loadedModelId = null;
    });
  }
  return whisperContextPromise;
}

/**
 * whisper.cpp's `initial_prompt` mechanism (exposed here via whisper.rn's
 * `prompt` option) — text fed to the decoder as prior context BEFORE it
 * starts transcribing the actual audio, biasing its language-model
 * probabilities toward words/spellings that appear in the prompt without
 * those words needing to be in the model's training vocabulary at all. This
 * is the real fix for a confirmed on-device failure mode: "Xayra" is an
 * invented brand name, and saying "Hey Xayra, ..." got transcribed as "his
 * error, ..." / "Here is the error, ..." / "Here's that up, ..." — the
 * common-English-phrase bias winning outright over an out-of-vocabulary
 * word, badly enough that no "xayra"-like token survived AT ALL for
 * activeMode.ts's fuzzy wake-word matcher to catch (confirmed: the SAME
 * phrase said as just "Xayra, ..." with no leading "Hey" transcribed
 * correctly as "Zaira, ..." every time — this is specifically a "Hey" +
 * OOV-word combination problem). Priming the decoder with the exact
 * spelling up front costs nothing extra (no bigger model, no extra
 * inference pass) and is exactly what this whisper.cpp feature exists for.
 */
const INITIAL_PROMPT = "Xayra";

/**
 * Transcribes a local audio file entirely on-device via whisper.cpp — no
 * network round-trip, no OpenAI API key. Callers are expected to run the
 * result through `isSilentTranscript()` (services/notes/noteManager.ts)
 * themselves, same as the OpenAI-backed `transcribeAudio()` before it;
 * importing it here would create a cycle (noteManager -> localWhisper ->
 * noteManager). Returns which model produced the transcript so callers can
 * persist it as note metadata.
 */
/**
 * Silent, best-effort warm-up: loads the Whisper GGML model into native
 * memory at app boot (called from services/ai/enginePrewarmer.ts, alongside
 * the SQLite and Llama warm-ups already there) rather than leaving it to be
 * paid the moment a user actually taps record. Whisper was the one engine
 * this codebase prewarmed nothing for — every real note's "first
 * transcription of the session felt slow" complaint traced back to this
 * exact cold-start cost (`getWhisperContext()`'s own doc comment), paid at
 * the single worst possible moment: the first time a user is actually
 * waiting on it. For the common case (open the app, look around, THEN
 * record), this eliminates that cost entirely rather than just labeling it
 * better; a genuinely instant first tap still pays it, which is what
 * pipelineStage.ts's "Hearing you out" stage exists to make visible rather
 * than hidden behind a bare, unexplained pause.
 */
export async function prewarmLocalWhisper(): Promise<void> {
  try {
    await getWhisperContext();
  } catch (err) {
    // Same "don't poison the app over a missing/corrupt model" contract as
    // every other caller here — the model may simply not be downloaded yet
    // (a fresh install still mid-onboarding-download), which is normal, not
    // an error worth surfacing.
    console.warn("[Whisper] Prewarm skipped:", err instanceof Error ? err.message : err);
  }
}

export async function transcribeAudioLocal(fileUri: string): Promise<LocalTranscriptionResult> {
  const start = nowMs();
  activeTranscriptionCount += 1;
  try {
    const { context, modelId } = await getWhisperContext();
    const { promise } = context.transcribe(fileUri, { language: "en", prompt: INITIAL_PROMPT });
    const { result } = await promise;
    logDuration("Whisper STT transcription", start);
    return { transcript: stripNonSpeechMarkers(result), modelId };
  } finally {
    activeTranscriptionCount -= 1;
  }
}
