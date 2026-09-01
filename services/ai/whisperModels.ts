import * as FileSystem from "expo-file-system/legacy";

import { MODEL_CDN_BASE_URL } from "./modelCdn";

/**
 * Base is the one and only local Whisper engine Xayra ships — the earlier
 * Base/Tiny choice (and its onboarding picker, Settings switch/delete UI,
 * and the NoteCard "switch engine" nudge) was removed in favor of always
 * downloading and using the more accurate model automatically in the
 * background (see modelDownloadManager.ts). Kept as a literal-string type
 * rather than deleted outright since `services/notes/noteManager.ts` still
 * stores which engine transcribed a given note as free-form metadata, and
 * `WhisperModelId` documents that "base" is the only value it can be now.
 */
export type WhisperModelId = "base";

const WHISPER_BASE_FILENAME = "ggml-base.en.bin";

/**
 * Routed through the same Cloudflare Worker CDN proxy as the Llama chat
 * model (see modelCdn.ts) rather than fetched directly from Hugging Face —
 * one consistent, resumable-download-friendly, uncapped source for every
 * model file Xayra needs, instead of two different origins with two
 * different reliability/rate-limit profiles.
 */
const DOWNLOAD_URL = `${MODEL_CDN_BASE_URL}/ggml-base.en.bin`;

export function getWhisperModelPath(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return `${dir}${WHISPER_BASE_FILENAME}`;
}

export async function isWhisperModelDownloaded(): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(getWhisperModelPath());
  return info.exists;
}

/** There's only ever one engine now, so "the active model" is just "is it
 * downloaded" — kept as its own function (rather than inlining the check at
 * every call site) so localWhisper.ts's resolveModelPath() reads the same
 * way it did when there was a real choice to resolve. */
export async function getActiveWhisperModel(): Promise<WhisperModelId | null> {
  return (await isWhisperModelDownloaded()) ? "base" : null;
}

/** `bytesWritten`/`bytesTotal` (raw, not just the derived `fraction`) are
 * passed through so callers — namely modelDownloadManager.ts — can compute
 * real speed/ETA telemetry from actual observed bytes instead of estimating
 * from a fixed approximate file size. */
export type DownloadProgressCallback = (fraction: number, bytesWritten: number, bytesTotal: number) => void;

/**
 * Downloads to a `.download` sibling file first and only moves it into
 * place on success, so a killed app or a network drop mid-download can
 * never leave a truncated file at the real model path masquerading as a
 * complete one.
 */
export async function downloadWhisperModel(onProgress?: DownloadProgressCallback): Promise<void> {
  const dest = getWhisperModelPath();
  const tmpDest = `${dest}.download`;

  const resumable = FileSystem.createDownloadResumable(DOWNLOAD_URL, tmpDest, {}, (progress) => {
    if (progress.totalBytesExpectedToWrite > 0) {
      onProgress?.(
        progress.totalBytesWritten / progress.totalBytesExpectedToWrite,
        progress.totalBytesWritten,
        progress.totalBytesExpectedToWrite
      );
    }
  });

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
}
