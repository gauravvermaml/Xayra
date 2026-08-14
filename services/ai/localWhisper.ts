import * as FileSystem from "expo-file-system/legacy";
// whisper.rn@0.7.2's package.json "exports" map has no root "." entry (only
// "./*" subpath patterns), so the bare "whisper.rn" specifier fails strict
// exports resolution (Node, and TS's "bundler" moduleResolution) with
// ERR_PACKAGE_PATH_NOT_EXPORTED. "whisper.rn/index" hits the "./*" pattern
// and resolves correctly — verified against the installed package.
import { initWhisper, type WhisperContext } from "whisper.rn/index";

/** Preferred first — tiny is smaller/faster, prioritized for lower on-device
 * latency; falls back to the more accurate base model if that's what's present. */
const MODEL_FILENAMES = ["ggml-tiny.en.bin", "ggml-base.en.bin"] as const;

let whisperContextPromise: Promise<WhisperContext> | null = null;

/**
 * Models aren't bundled into the app (they're tens/hundreds of MB) — the
 * user or a setup step drops one into the document directory ahead of time.
 */
async function resolveModelPath(): Promise<string> {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }

  for (const filename of MODEL_FILENAMES) {
    const path = `${dir}${filename}`;
    const info = await FileSystem.getInfoAsync(path);
    if (info.exists) {
      return path;
    }
  }

  throw new Error(
    `No local Whisper model found. Place ${MODEL_FILENAMES.join(" or ")} in ${dir} before transcribing on-device.`
  );
}

/**
 * initWhisper() loads the GGML model into native memory — expensive, so the
 * context is created once and reused across every transcription call rather
 * than per-recording. If initialization fails, the next call retries instead
 * of being stuck replaying a cached rejection.
 */
async function getWhisperContext(): Promise<WhisperContext> {
  if (!whisperContextPromise) {
    whisperContextPromise = resolveModelPath().then((filePath) => initWhisper({ filePath }));
    whisperContextPromise.catch(() => {
      whisperContextPromise = null;
    });
  }
  return whisperContextPromise;
}

/**
 * Transcribes a local audio file entirely on-device via whisper.cpp — no
 * network round-trip, no OpenAI API key. Callers are expected to run the
 * result through `isSilentTranscript()` (services/notes/noteManager.ts)
 * themselves, same as the OpenAI-backed `transcribeAudio()` before it;
 * importing it here would create a cycle (noteManager -> localWhisper ->
 * noteManager).
 */
export async function transcribeAudioLocal(fileUri: string): Promise<string> {
  const context = await getWhisperContext();
  const { promise } = context.transcribe(fileUri, { language: "en" });
  const { result } = await promise;
  return result.trim();
}
