import * as FileSystem from "expo-file-system/legacy";

export const EMBEDDING_MODEL_FILENAME = "bge-small-en-v1.5-quantized.onnx";
export const EMBEDDING_VOCAB_FILENAME = "bge-small-en-v1.5-vocab.txt";

const MODEL_URL = "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/onnx/model_quantized.onnx";
const VOCAB_URL = "https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/main/vocab.txt";

/** Rough sizes used only to weight the combined progress bar between the two
 * files (the model dwarfs the vocab) — not relied on for correctness. */
const MODEL_APPROX_BYTES = 34_000_000;
const VOCAB_APPROX_BYTES = 231_000;
const MODEL_WEIGHT = MODEL_APPROX_BYTES / (MODEL_APPROX_BYTES + VOCAB_APPROX_BYTES);
const VOCAB_WEIGHT = 1 - MODEL_WEIGHT;

/**
 * onnxruntime-react-native's native `InferenceSession.create()` expects a
 * plain filesystem path, not a `file://` URI — `expo-file-system`'s
 * `documentDirectory` (and therefore every path built from it in this file)
 * is a `file://...` URI, so callers passing a path into the ONNX runtime
 * must strip the prefix first or native model loading fails.
 */
export function toNativeFilePath(path: string): string {
  return path.startsWith("file://") ? path.slice("file://".length) : path;
}

function documentDir(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return dir;
}

function modelPath(): string {
  return `${documentDir()}${EMBEDDING_MODEL_FILENAME}`;
}

function vocabPath(): string {
  return `${documentDir()}${EMBEDDING_VOCAB_FILENAME}`;
}

export async function isEmbeddingModelDownloaded(): Promise<boolean> {
  const [modelInfo, vocabInfo] = await Promise.all([
    FileSystem.getInfoAsync(modelPath()),
    FileSystem.getInfoAsync(vocabPath()),
  ]);
  return modelInfo.exists && vocabInfo.exists;
}

/** Downloads to a `.download` sibling and only moves it into place on
 * success — same atomicity guarantee as whisperModels.ts's downloader, so a
 * killed app or dropped connection mid-download never leaves a truncated
 * file masquerading as a complete one. Skips a file that's already present. */
async function downloadFile(url: string, dest: string): Promise<void> {
  const info = await FileSystem.getInfoAsync(dest);
  if (info.exists) {
    return;
  }
  const tmpDest = `${dest}.download`;
  try {
    const result = await FileSystem.downloadAsync(url, tmpDest);
    if (result.status !== 200) {
      throw new Error(`Download failed (HTTP ${result.status}).`);
    }
    await FileSystem.moveAsync({ from: tmpDest, to: dest });
  } catch (err) {
    await FileSystem.deleteAsync(tmpDest, { idempotent: true });
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** `bytesWritten`/`bytesTotal` describe only the ONNX model file itself
 * (the dominant ~34MB of the two files this downloads) — unset (0) during
 * the brief final vocab-file step, which has no granular byte progress of
 * its own. Callers wanting real-bytes telemetry (modelDownloadManager.ts)
 * should treat 0/0 as "no new byte data this tick," not "download stalled." */
export type DownloadProgressCallback = (fraction: number, bytesWritten: number, bytesTotal: number) => void;

/**
 * Downloads both the ONNX embedding model and its tokenizer vocab, in that
 * order (model first, since it's what actually gates `generateEmbeddingLocal`
 * — the vocab load is comparatively instant). Reports one combined 0..1
 * progress across both files rather than two separate bars.
 */
export async function downloadEmbeddingAssets(onProgress?: DownloadProgressCallback): Promise<void> {
  const modelAlreadyPresent = (await FileSystem.getInfoAsync(modelPath())).exists;
  if (!modelAlreadyPresent) {
    const tmpDest = `${modelPath()}.download`;
    const resumable = FileSystem.createDownloadResumable(MODEL_URL, tmpDest, {}, (progress) => {
      if (progress.totalBytesExpectedToWrite > 0) {
        onProgress?.(
          (progress.totalBytesWritten / progress.totalBytesExpectedToWrite) * MODEL_WEIGHT,
          progress.totalBytesWritten,
          progress.totalBytesExpectedToWrite
        );
      }
    });
    try {
      const result = await resumable.downloadAsync();
      if (!result || result.status !== 200) {
        throw new Error(`Embedding model download failed (HTTP ${result?.status ?? "unknown"}).`);
      }
      await FileSystem.moveAsync({ from: tmpDest, to: modelPath() });
    } catch (err) {
      await FileSystem.deleteAsync(tmpDest, { idempotent: true });
      throw err instanceof Error ? err : new Error(String(err));
    }
  }
  onProgress?.(MODEL_WEIGHT, 0, 0);

  await downloadFile(VOCAB_URL, vocabPath());
  onProgress?.(MODEL_WEIGHT + VOCAB_WEIGHT, 0, 0);
}

type ProgressListener = (fraction: number) => void;
let progressListeners: ProgressListener[] = [];

/** Lets UI (Notes/Chat screens) show live progress for a download that was
 * triggered automatically by the embedding service itself rather than by a
 * direct user action — see localEmbeddings.ts's `ensureEmbeddingAssets()`. */
export function onEmbeddingDownloadProgress(listener: ProgressListener): () => void {
  progressListeners.push(listener);
  return () => {
    progressListeners = progressListeners.filter((l) => l !== listener);
  };
}

function notifyProgress(fraction: number): void {
  progressListeners.forEach((listener) => listener(fraction));
}

let ensurePromise: Promise<void> | null = null;

/**
 * Idempotent, concurrency-safe "make sure the embedding model is on disk"
 * check: a no-op if it's already there, otherwise downloads it once even if
 * called from multiple in-flight embedding requests at the same time (e.g.
 * saving several notes in quick succession).
 */
export async function ensureEmbeddingAssets(): Promise<void> {
  if (await isEmbeddingModelDownloaded()) {
    return;
  }
  if (!ensurePromise) {
    ensurePromise = downloadEmbeddingAssets(notifyProgress).catch((err) => {
      ensurePromise = null;
      throw err;
    });
  }
  return ensurePromise;
}
