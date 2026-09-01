import { useEffect, useState } from "react";
import * as Device from "expo-device";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";

import { resetWhisperContext } from "./localWhisper";
import { downloadEmbeddingAssets, isEmbeddingModelDownloaded } from "./embeddingModel";
import { LLAMA_MODEL_FILENAMES } from "./localLlama";
import { downloadWhisperModel, isWhisperModelDownloaded } from "./whisperModels";
import { readPreferences, writePreferences } from "../settings/preferences";

/**
 * Replaces the old first-launch onboarding picker and per-model Settings
 * cards: every local model Xayra needs (Whisper Base, the ONNX embedding
 * model, and a RAM-tiered Llama chat model) now downloads automatically in
 * the background, gated only on network type and — for cellular — explicit
 * user consent. `initModelDownloads()` is called once from app/_layout.tsx;
 * every screen that cares about progress reads it via `useModelDownload()`.
 */

const R2_BASE_URL = "https://pub-1620753009f6480ba336c118dbff9ad1.r2.dev";

const LLAMA_1B_FILENAME = LLAMA_MODEL_FILENAMES.find((m) => m.label === "1B")!.filename;
const LLAMA_3B_FILENAME = LLAMA_MODEL_FILENAMES.find((m) => m.label === "3B")!.filename;

/** Below this, a device is treated as memory-constrained (the Galaxy A50
 * this project tests on is 4GB) and gets the smaller model; at or above it,
 * a device is treated as a modern flagship (Pixel-class, 8GB+) and gets the
 * more capable one. */
const RAM_TIER_THRESHOLD_BYTES = 7 * 1024 * 1024 * 1024;

/**
 * Approximate download sizes, measured directly off the R2 bucket
 * (`curl -I`) rather than trusted from a spec sheet — actual bytes were
 * ~0.78GB (1B) and ~1.92GB (3B) at the time of writing, both usefully close
 * to but not exactly the round "~1.2GB"/"~1.9GB" figures sometimes quoted
 * for these files elsewhere; used only to (a) weight the combined progress
 * bar across three very differently-sized assets and (b) show a human
 * label before the real download has started reporting bytes.
 */
const WHISPER_APPROX_BYTES = 142_000_000;
const EMBEDDING_APPROX_BYTES = 34_231_000;
const LLAMA_1B_APPROX_BYTES = 834_000_000;
const LLAMA_3B_APPROX_BYTES = 2_061_000_000;

export type ModelDownloadState = "idle" | "downloading" | "ready" | "error" | "cellular_blocked";

export type ModelDownloadStatus = {
  state: ModelDownloadState;
  /** 0–100, combined across all three assets (Whisper + embeddings + chat model). */
  progress: number;
  /** Human-readable size of just the chat model for this device's RAM tier
   * (e.g. "0.8 GB") — what the cellular-blocked callout and Settings show,
   * since that's the one asset actually big enough for a user to care about
   * before agreeing to burn mobile data on it. */
  chatModelSizeLabel: string;
  error: string | null;
};

function formatGigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

type LlamaTier = { filename: string; approxBytes: number; sizeLabel: string };

/** `Device.totalMemory` can legitimately come back `null` (unsupported
 * platform/OS version) — in that case, default to the smaller model rather
 * than gambling a low-end device can handle the 3B one. */
function resolveLlamaTier(): LlamaTier {
  const totalMemory = Device.totalMemory;
  if (totalMemory !== null && totalMemory !== undefined && totalMemory >= RAM_TIER_THRESHOLD_BYTES) {
    return {
      filename: LLAMA_3B_FILENAME,
      approxBytes: LLAMA_3B_APPROX_BYTES,
      sizeLabel: formatGigabytes(LLAMA_3B_APPROX_BYTES),
    };
  }
  return {
    filename: LLAMA_1B_FILENAME,
    approxBytes: LLAMA_1B_APPROX_BYTES,
    sizeLabel: formatGigabytes(LLAMA_1B_APPROX_BYTES),
  };
}

function chatModelPath(filename: string): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return `${dir}${filename}`;
}

async function isChatModelDownloaded(filename: string): Promise<boolean> {
  const info = await FileSystem.getInfoAsync(chatModelPath(filename));
  return info.exists;
}

/** Same atomic-download pattern used by whisperModels.ts/embeddingModel.ts:
 * download to a `.download` sibling, only move it into place on success. */
async function downloadChatModel(filename: string, onProgress: (fraction: number) => void): Promise<void> {
  const dest = chatModelPath(filename);
  const tmpDest = `${dest}.download`;

  const resumable = FileSystem.createDownloadResumable(`${R2_BASE_URL}/${filename}`, tmpDest, {}, (progress) => {
    if (progress.totalBytesExpectedToWrite > 0) {
      onProgress(progress.totalBytesWritten / progress.totalBytesExpectedToWrite);
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

type Listener = (status: ModelDownloadStatus) => void;
let listeners: Listener[] = [];
let currentStatus: ModelDownloadStatus = {
  state: "idle",
  progress: 0,
  chatModelSizeLabel: resolveLlamaTier().sizeLabel,
  error: null,
};

function setStatus(patch: Partial<ModelDownloadStatus>): void {
  currentStatus = { ...currentStatus, ...patch };
  listeners.forEach((listener) => listener(currentStatus));
}

/**
 * Plain module-level pub/sub rather than React context — mirrors the same
 * choice made for the copy-to-clipboard toast (components/Toast.tsx):
 * screens that need this (Chat, Settings) don't share a close-enough common
 * ancestor to make a context provider worth the ceremony for one value.
 */
function subscribe(listener: Listener): () => void {
  listeners.push(listener);
  listener(currentStatus);
  return () => {
    listeners = listeners.filter((l) => l !== listener);
  };
}

/** Live download status for the on-device models (Whisper, embeddings,
 * Llama chat model) — see app/chat.tsx for how each state renders. */
export function useModelDownload(): ModelDownloadStatus {
  const [status, setStatusState] = useState(currentStatus);
  useEffect(() => subscribe(setStatusState), []);
  return status;
}

let networkChangeSubscription: { remove: () => void } | null = null;

function stopWatchingForWifi(): void {
  networkChangeSubscription?.remove();
  networkChangeSubscription = null;
}

/** While blocked on cellular, keep listening so Wi-Fi becoming available
 * later (without the user ever tapping anything) resumes automatically —
 * consistent with "silent" background delivery rather than requiring the
 * user to re-open the app once they're back on Wi-Fi. */
function watchForWifiThenResume(tier: LlamaTier): void {
  stopWatchingForWifi();
  networkChangeSubscription = Network.addNetworkStateListener((event) => {
    if (event.type === Network.NetworkStateType.WIFI) {
      stopWatchingForWifi();
      void beginDownloads(tier);
    }
  });
}

async function beginDownloads(tier: LlamaTier): Promise<void> {
  setStatus({ state: "downloading", progress: 0, error: null });

  const totalBytes = WHISPER_APPROX_BYTES + EMBEDDING_APPROX_BYTES + tier.approxBytes;
  const whisperWeight = WHISPER_APPROX_BYTES / totalBytes;
  const embeddingWeight = EMBEDDING_APPROX_BYTES / totalBytes;
  const llamaWeight = tier.approxBytes / totalBytes;
  let completedWeight = 0;

  try {
    if (!(await isWhisperModelDownloaded())) {
      await downloadWhisperModel((fraction) => setStatus({ progress: (completedWeight + fraction * whisperWeight) * 100 }));
      resetWhisperContext();
    }
    completedWeight += whisperWeight;
    setStatus({ progress: completedWeight * 100 });

    if (!(await isEmbeddingModelDownloaded())) {
      await downloadEmbeddingAssets((fraction) =>
        setStatus({ progress: (completedWeight + fraction * embeddingWeight) * 100 })
      );
    }
    completedWeight += embeddingWeight;
    setStatus({ progress: completedWeight * 100 });

    if (!(await isChatModelDownloaded(tier.filename))) {
      await downloadChatModel(tier.filename, (fraction) =>
        setStatus({ progress: (completedWeight + fraction * llamaWeight) * 100 })
      );
    }

    setStatus({ state: "ready", progress: 100, error: null });
  } catch (err) {
    setStatus({ state: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

export async function allowCellularDownloadAndResume(): Promise<void> {
  await writePreferences({ allowCellularDownloads: true });
  stopWatchingForWifi();
  await beginDownloads(resolveLlamaTier());
}

let initStarted = false;

/**
 * Call once, at app launch (see app/_layout.tsx) — safe to call more than
 * once (a no-op after the first call) since Fast Refresh re-evaluates root
 * modules during development.
 */
export function initModelDownloads(): void {
  if (initStarted) {
    return;
  }
  initStarted = true;
  void runInitialCheck();
}

async function runInitialCheck(): Promise<void> {
  const tier = resolveLlamaTier();
  setStatus({ chatModelSizeLabel: tier.sizeLabel });

  const [whisperReady, embeddingReady, chatReady] = await Promise.all([
    isWhisperModelDownloaded(),
    isEmbeddingModelDownloaded(),
    isChatModelDownloaded(tier.filename),
  ]);
  if (whisperReady && embeddingReady && chatReady) {
    setStatus({ state: "ready", progress: 100, error: null });
    return;
  }

  const prefs = await readPreferences();
  const netState = await Network.getNetworkStateAsync();
  const onWifi = netState.type === Network.NetworkStateType.WIFI;

  if (onWifi || prefs.allowCellularDownloads) {
    await beginDownloads(tier);
    return;
  }

  setStatus({ state: "cellular_blocked", progress: 0, error: null });
  watchForWifiThenResume(tier);
}
