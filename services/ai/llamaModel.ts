import * as FileSystem from "expo-file-system/legacy";

import { LLAMA_MANAGED_MODEL_FILENAME } from "./localLlama";

/** hugging-quants' official GGUF conversion of Meta's Llama-3.2-1B-Instruct,
 * Q4_K_M quantized — same source a manual `adb push` setup would use. */
const MODEL_URL =
  "https://huggingface.co/hugging-quants/Llama-3.2-1B-Instruct-Q4_K_M-GGUF/resolve/main/llama-3.2-1b-instruct-q4_k_m.gguf";

export const LLAMA_MODEL_SIZE_LABEL = "770MB";

function modelPath(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return `${dir}${LLAMA_MANAGED_MODEL_FILENAME}`;
}

export async function isLlamaModelDownloaded(): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(modelPath());
  return info.exists;
}

export type DownloadProgressCallback = (fraction: number) => void;

/** Same atomic-download pattern as whisperModels.ts / embeddingModel.ts —
 * downloads to a `.download` sibling and only moves it into place once
 * complete, so an interrupted ~770MB download never leaves a truncated file
 * masquerading as a usable model. */
export async function downloadLlamaModel(onProgress?: DownloadProgressCallback): Promise<void> {
  const dest = modelPath();
  const tmpDest = `${dest}.download`;

  const resumable = FileSystem.createDownloadResumable(MODEL_URL, tmpDest, {}, (progress) => {
    if (progress.totalBytesExpectedToWrite > 0) {
      onProgress?.(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
    }
  });

  try {
    const result = await resumable.downloadAsync();
    if (!result || result.status !== 200) {
      throw new Error(`Chat model download failed (HTTP ${result?.status ?? "unknown"}).`);
    }
    await FileSystem.moveAsync({ from: tmpDest, to: dest });
  } catch (err) {
    await FileSystem.deleteAsync(tmpDest, { idempotent: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

export async function deleteLlamaModel(): Promise<void> {
  await FileSystem.deleteAsync(modelPath(), { idempotent: true });
}
