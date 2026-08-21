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

let whisperContextPromise: Promise<{ context: WhisperContext; modelId: WhisperModelId }> | null = null;
let loadedModelId: WhisperModelId | null = null;

/**
 * Models aren't bundled into the app (they're tens/hundreds of MB) — the
 * user downloads one via the first-launch onboarding screen or
 * Settings > Voice Recognition (services/ai/whisperModels.ts), which writes
 * it into the document directory and records it as the active model.
 */
async function resolveModelPath(): Promise<{ path: string; modelId: WhisperModelId }> {
  if (!FileSystem.documentDirectory) {
    throw new Error("No writable document directory available on this platform.");
  }

  const modelId = await getActiveWhisperModel();
  if (!modelId) {
    throw new Error(
      "No local Whisper model downloaded. Open Settings > Voice Recognition to download a transcription engine before recording."
    );
  }

  return { path: getWhisperModelPath(modelId), modelId };
}

/** Called after switching the active model in Settings so the next
 * transcription loads the newly-selected engine instead of reusing the
 * previous one's already-initialized native context. */
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
 * Transcribes a local audio file entirely on-device via whisper.cpp — no
 * network round-trip, no OpenAI API key. Callers are expected to run the
 * result through `isSilentTranscript()` (services/notes/noteManager.ts)
 * themselves, same as the OpenAI-backed `transcribeAudio()` before it;
 * importing it here would create a cycle (noteManager -> localWhisper ->
 * noteManager). Returns which model produced the transcript so callers can
 * persist it as note metadata.
 */
export async function transcribeAudioLocal(fileUri: string): Promise<LocalTranscriptionResult> {
  const start = nowMs();
  const { context, modelId } = await getWhisperContext();
  const { promise } = context.transcribe(fileUri, { language: "en" });
  const { result } = await promise;
  logDuration("Whisper STT transcription", start);
  return { transcript: result.trim(), modelId };
}
