import * as FileSystem from "expo-file-system/legacy";

import { readPreferences, writePreferences } from "../settings/preferences";

export type WhisperModelId = "base" | "tiny";

export type WhisperModelInfo = {
  id: WhisperModelId;
  filename: string;
  label: string;
  sizeLabel: string;
  description: string;
  downloadUrl: string;
};

/**
 * Both files are the official whisper.cpp GGML conversions, hosted by the
 * whisper.cpp project itself on Hugging Face — same source a manual
 * `adb push` setup would have pulled from.
 */
export const WHISPER_MODELS: Record<WhisperModelId, WhisperModelInfo> = {
  base: {
    id: "base",
    filename: "ggml-base.en.bin",
    label: "Accurate Engine",
    sizeLabel: "142MB",
    description:
      "Higher Accuracy: Better for technical words and accents (uses slightly more storage).",
    downloadUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
  },
  tiny: {
    id: "tiny",
    filename: "ggml-tiny.en.bin",
    label: "Fast Engine",
    sizeLabel: "75MB",
    description: "Fast & Lightweight: Transcribes speech instantly using minimal battery.",
    downloadUrl: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
  },
};

export const WHISPER_MODEL_IDS = Object.keys(WHISPER_MODELS) as WhisperModelId[];

export function getWhisperModelPath(id: WhisperModelId): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return `${dir}${WHISPER_MODELS[id].filename}`;
}

export async function isWhisperModelDownloaded(id: WhisperModelId): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(getWhisperModelPath(id));
  return info.exists;
}

export async function getDownloadedWhisperModels(): Promise<WhisperModelId[]> {
  const flags = await Promise.all(
    WHISPER_MODEL_IDS.map(async (id) => ((await isWhisperModelDownloaded(id)) ? id : null))
  );
  return flags.filter((id): id is WhisperModelId => id !== null);
}

/**
 * Resolves the model that should actually be used for the next
 * transcription: the user's saved preference if that file is still present,
 * otherwise whichever downloaded model is found first, otherwise `null`
 * (nothing downloaded — caller should direct the user to setup).
 */
export async function getActiveWhisperModel(): Promise<WhisperModelId | null> {
  const prefs = await readPreferences();
  const preferred = prefs.activeWhisperModel as WhisperModelId | null;
  if (preferred && WHISPER_MODELS[preferred] && (await isWhisperModelDownloaded(preferred))) {
    return preferred;
  }
  const downloaded = await getDownloadedWhisperModels();
  return downloaded[0] ?? null;
}

export async function setActiveWhisperModel(id: WhisperModelId): Promise<void> {
  await writePreferences({ activeWhisperModel: id });
}

export type DownloadProgressCallback = (fraction: number) => void;

/**
 * Downloads to a `.download` sibling file first and only moves it into
 * place on success, so a killed app or a network drop mid-download can
 * never leave a truncated file at the real model path masquerading as a
 * complete one.
 */
export async function downloadWhisperModel(
  id: WhisperModelId,
  onProgress?: DownloadProgressCallback
): Promise<void> {
  const dest = getWhisperModelPath(id);
  const tmpDest = `${dest}.download`;

  const resumable = FileSystem.createDownloadResumable(
    WHISPER_MODELS[id].downloadUrl,
    tmpDest,
    {},
    (progress) => {
      if (progress.totalBytesExpectedToWrite > 0) {
        onProgress?.(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
      }
    }
  );

  try {
    const result = await resumable.downloadAsync();
    if (!result || result.status !== 200) {
      throw new Error(`Download failed (HTTP ${result?.status ?? "unknown"}).`);
    }
    await FileSystem.moveAsync({ from: tmpDest, to: dest });
  } catch (err) {
    await FileSystem.deleteAsync(tmpDest, { idempotent: true });
    throw err instanceof Error ? err : new Error(String(err));
  }

  await setActiveWhisperModel(id);
}

/** Deletes a downloaded model's file. If it was the active model, falls
 * back to whatever else is still downloaded (or clears the preference). */
export async function deleteWhisperModel(id: WhisperModelId): Promise<void> {
  await FileSystem.deleteAsync(getWhisperModelPath(id), { idempotent: true });

  const prefs = await readPreferences();
  if (prefs.activeWhisperModel === id) {
    const remaining = await getDownloadedWhisperModels();
    await writePreferences({ activeWhisperModel: remaining[0] ?? null });
  }
}
