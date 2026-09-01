import { useEffect, useState } from "react";
import * as Device from "expo-device";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";

import { downloadEmbeddingAssets, isEmbeddingModelDownloaded } from "./embeddingModel";
import { LLAMA_MODEL_FILENAMES } from "./localLlama";
import { resetWhisperContext } from "./localWhisper";
import { MODEL_CDN_BASE_URL } from "./modelCdn";
import { downloadWhisperModel, isWhisperModelDownloaded } from "./whisperModels";
import { readPreferences, writePreferences } from "../settings/preferences";

/**
 * Replaces the old first-launch onboarding picker and per-model Settings
 * cards: every local model Xayra needs (Whisper Base, the ONNX embedding
 * model, and a RAM-tiered Llama chat model) now downloads automatically in
 * the background — through the Cloudflare Worker CDN proxy at
 * MODEL_CDN_BASE_URL (see modelCdn.ts) rather than hitting Hugging Face/R2
 * directly — gated only on network type and, for cellular, explicit user
 * consent. `initModelDownloads()` is called once from app/_layout.tsx; every
 * screen that cares about progress reads it via `useModelDownload()`.
 */

const LLAMA_1B_FILENAME = LLAMA_MODEL_FILENAMES.find((m) => m.label === "1B")!.filename;
const LLAMA_3B_FILENAME = LLAMA_MODEL_FILENAMES.find((m) => m.label === "3B")!.filename;

/** Below this, a device is treated as memory-constrained (the Galaxy A50
 * this project tests on is 4GB) and gets the smaller model; at or above it,
 * a device is treated as a modern flagship (Pixel-class, 8GB+) and gets the
 * more capable one. */
const RAM_TIER_THRESHOLD_BYTES = 7 * 1024 * 1024 * 1024;

/**
 * Byte counts measured directly against the live Worker (`curl` a real GET,
 * not a HEAD — the Worker's HEAD responses omit `Content-Length`, but a
 * real GET, which is what expo-file-system's downloader actually issues,
 * returns the correct one) rather than trusted from a spec sheet. These are
 * used as the initial/fallback size estimate for a phase before its own
 * download has reported a real `Content-Length` — see `onPhaseProgress`
 * below, which swaps in the real number the moment it's known.
 */
const WHISPER_APPROX_BYTES = 147_964_211;
const EMBEDDING_APPROX_BYTES = 34_231_000;
const LLAMA_1B_APPROX_BYTES = 834_203_680;
const LLAMA_3B_APPROX_BYTES = 2_060_886_464;

const BYTES_PER_MB = 1024 * 1024;

export type ModelDownloadState = "idle" | "downloading" | "ready" | "error" | "cellular_blocked";

export type ModelDownloadStatus = {
  status: ModelDownloadState;
  /** 0–100, combined across every model that actually needs downloading. */
  progressPercent: number;
  downloadedMB: number;
  totalMB: number;
  /** Smoothed (not instantaneous-per-tick) throughput — see `recordSpeedSample`. */
  speedMBps: number;
  /** 0 whenever speed is unknown/zero (just started, or paused) — deliberately
   * never NaN/Infinity, so it's always safe to interpolate directly into UI text. */
  etaSeconds: number;
  /** Human-readable size of just the chat model for this device's RAM tier
   * (e.g. "0.8 GB") — shown on the cellular-blocked callout, since that's
   * the one asset actually big enough for a user to weigh before agreeing
   * to burn mobile data on it. */
  chatModelSizeLabel: string;
  error: string | null;
};

function formatGigabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function bytesToMB(bytes: number): number {
  // One decimal place — enough precision to look "live" without jittering
  // wildly on every progress tick.
  return Math.round((bytes / BYTES_PER_MB) * 10) / 10;
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

type PhaseProgressCallback = (fraction: number, bytesWritten: number, bytesTotal: number) => void;

/** Same atomic-download pattern used by whisperModels.ts/embeddingModel.ts:
 * download to a `.download` sibling, only move it into place on success. */
async function downloadChatModel(filename: string, onProgress: PhaseProgressCallback): Promise<void> {
  const dest = chatModelPath(filename);
  const tmpDest = `${dest}.download`;

  const resumable = FileSystem.createDownloadResumable(
    `${MODEL_CDN_BASE_URL}/${filename}`,
    tmpDest,
    {},
    (progress) => {
      if (progress.totalBytesExpectedToWrite > 0) {
        onProgress(
          progress.totalBytesWritten / progress.totalBytesExpectedToWrite,
          progress.totalBytesWritten,
          progress.totalBytesExpectedToWrite
        );
      }
    }
  );

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
  status: "idle",
  progressPercent: 0,
  downloadedMB: 0,
  totalMB: 0,
  speedMBps: 0,
  etaSeconds: 0,
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

// ---- Telemetry (speed/ETA/MB) ---------------------------------------------
//
// Three phases (whisper -> embedding -> llama) are downloaded sequentially,
// but reported as ONE continuous "Preparing Xayra" progress bar rather than
// three separate ones — these track running totals across all three so
// downloadedMB/totalMB/progressPercent never jump backward at a phase
// boundary, and speed is smoothed (not recomputed raw on every single
// progress tick) so it reads as a stable number instead of jittering.

type PhaseName = "whisper" | "embedding" | "llama";
const ALL_PHASES: PhaseName[] = ["whisper", "embedding", "llama"];

let phaseApproxTotals: Record<PhaseName, number> = {
  whisper: WHISPER_APPROX_BYTES,
  embedding: EMBEDDING_APPROX_BYTES,
  llama: LLAMA_1B_APPROX_BYTES,
};
let phaseRealTotals: Partial<Record<PhaseName, number>> = {};
let phaseCompleted = new Set<PhaseName>();

let lastSampleTimeMs = 0;
let lastSampleBytes = 0;
let smoothedSpeedBytesPerSec = 0;

/** Below this, a fresh instantaneous-speed sample is skipped in favor of
 * reusing the previous smoothed value — guards against a near-zero elapsed
 * time producing a huge (or Infinity) speed spike from dividing by
 * something close to zero. */
const MIN_SAMPLE_INTERVAL_MS = 250;
/** Exponential smoothing weight for each new sample — low enough that one
 * noisy tick (a brief stall, a burst) doesn't yank the displayed number
 * around, high enough that it still visibly responds within a second or two. */
const SPEED_SMOOTHING_ALPHA = 0.3;

function phaseTotal(phase: PhaseName): number {
  return phaseRealTotals[phase] ?? phaseApproxTotals[phase];
}

function totalBytesAcrossPendingPhases(): number {
  return ALL_PHASES.filter((p) => !isPhaseSkippedEntirely(p)).reduce((sum, p) => sum + phaseTotal(p), 0);
}

function completedBytesBeforeCurrentPhase(): number {
  return ALL_PHASES.filter((p) => phaseCompleted.has(p) && !isPhaseSkippedEntirely(p)).reduce(
    (sum, p) => sum + phaseTotal(p),
    0
  );
}

/** Phases that were already downloaded before this run started are excluded
 * from the "how much is there to download" total entirely — a user who
 * already has Whisper downloaded shouldn't see its ~140MB counted toward a
 * total they're not actually waiting on. Tracked separately from
 * `phaseCompleted` (which also includes phases finished *during* this run). */
let phasesSkippedEntirely = new Set<PhaseName>();
function isPhaseSkippedEntirely(phase: PhaseName): boolean {
  return phasesSkippedEntirely.has(phase);
}

function resetTelemetry(tier: LlamaTier): void {
  phaseApproxTotals = {
    whisper: WHISPER_APPROX_BYTES,
    embedding: EMBEDDING_APPROX_BYTES,
    llama: tier.approxBytes,
  };
  phaseRealTotals = {};
  phaseCompleted = new Set<PhaseName>();
  phasesSkippedEntirely = new Set<PhaseName>();
  lastSampleTimeMs = 0;
  lastSampleBytes = 0;
  smoothedSpeedBytesPerSec = 0;
}

/** Records one new (time, bytes) sample and derives a smoothed speed —
 * called on every phase progress tick and once more at completion. Safe by
 * construction: `etaSeconds`/`speedMBps` are 0 (never NaN/Infinity) until
 * at least one real sample interval has elapsed. */
function updateTelemetry(writtenBytes: number, totalBytes: number): void {
  const now = Date.now();
  if (lastSampleTimeMs > 0) {
    const elapsedMs = now - lastSampleTimeMs;
    if (elapsedMs >= MIN_SAMPLE_INTERVAL_MS) {
      const deltaBytes = Math.max(0, writtenBytes - lastSampleBytes);
      const instantBytesPerSec = (deltaBytes / elapsedMs) * 1000;
      smoothedSpeedBytesPerSec =
        smoothedSpeedBytesPerSec <= 0
          ? instantBytesPerSec
          : smoothedSpeedBytesPerSec * (1 - SPEED_SMOOTHING_ALPHA) + instantBytesPerSec * SPEED_SMOOTHING_ALPHA;
      lastSampleTimeMs = now;
      lastSampleBytes = writtenBytes;
    }
  } else {
    lastSampleTimeMs = now;
    lastSampleBytes = writtenBytes;
  }

  const safeSpeedBytesPerSec = Number.isFinite(smoothedSpeedBytesPerSec) && smoothedSpeedBytesPerSec > 0
    ? smoothedSpeedBytesPerSec
    : 0;
  const remainingBytes = Math.max(0, totalBytes - writtenBytes);
  const etaSeconds =
    safeSpeedBytesPerSec > 0 && Number.isFinite(remainingBytes / safeSpeedBytesPerSec)
      ? Math.round(remainingBytes / safeSpeedBytesPerSec)
      : 0;
  const progressPercent = totalBytes > 0 ? Math.min(100, Math.max(0, (writtenBytes / totalBytes) * 100)) : 0;

  setStatus({
    progressPercent,
    downloadedMB: bytesToMB(writtenBytes),
    totalMB: bytesToMB(totalBytes),
    speedMBps: bytesToMB(safeSpeedBytesPerSec),
    etaSeconds,
  });
}

function onPhaseProgress(phase: PhaseName, fraction: number, bytesWritten: number, bytesTotal: number): void {
  if (bytesTotal > 0) {
    phaseRealTotals[phase] = bytesTotal;
  }
  const currentPhaseTotal = phaseTotal(phase);
  // `bytesTotal > 0` means this tick carried real data (whisper/llama always
  // do; the embedding phase's brief vocab-file step doesn't, and reports
  // 0/0 — see embeddingModel.ts). Fall back to the fraction against the
  // phase's known/approx total in that case, rather than showing 0 bytes.
  const currentPhaseBytes = bytesTotal > 0 ? bytesWritten : fraction * currentPhaseTotal;

  updateTelemetry(completedBytesBeforeCurrentPhase() + currentPhaseBytes, totalBytesAcrossPendingPhases());
}

// ---- Network / consent -----------------------------------------------------

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
  const [whisperDone, embeddingDone, llamaDone] = await Promise.all([
    isWhisperModelDownloaded(),
    isEmbeddingModelDownloaded(),
    isChatModelDownloaded(tier.filename),
  ]);

  resetTelemetry(tier);
  if (whisperDone) {
    phaseCompleted.add("whisper");
    phasesSkippedEntirely.add("whisper");
  }
  if (embeddingDone) {
    phaseCompleted.add("embedding");
    phasesSkippedEntirely.add("embedding");
  }
  if (llamaDone) {
    phaseCompleted.add("llama");
    phasesSkippedEntirely.add("llama");
  }

  setStatus({ status: "downloading", error: null });
  updateTelemetry(completedBytesBeforeCurrentPhase(), totalBytesAcrossPendingPhases());

  try {
    if (!whisperDone) {
      await downloadWhisperModel((fraction, bytesWritten, bytesTotal) =>
        onPhaseProgress("whisper", fraction, bytesWritten, bytesTotal)
      );
      resetWhisperContext();
      phaseCompleted.add("whisper");
    }

    if (!embeddingDone) {
      await downloadEmbeddingAssets((fraction, bytesWritten, bytesTotal) =>
        onPhaseProgress("embedding", fraction, bytesWritten, bytesTotal)
      );
      phaseCompleted.add("embedding");
    }

    if (!llamaDone) {
      await downloadChatModel(tier.filename, (fraction, bytesWritten, bytesTotal) =>
        onPhaseProgress("llama", fraction, bytesWritten, bytesTotal)
      );
      phaseCompleted.add("llama");
    }

    const totalBytes = totalBytesAcrossPendingPhases();
    updateTelemetry(totalBytes, totalBytes);
    setStatus({ status: "ready", progressPercent: 100, error: null });
  } catch (err) {
    setStatus({ status: "error", error: err instanceof Error ? err.message : String(err) });
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
    setStatus({ status: "ready", progressPercent: 100, error: null });
    return;
  }

  const prefs = await readPreferences();
  const netState = await Network.getNetworkStateAsync();
  const onWifi = netState.type === Network.NetworkStateType.WIFI;

  if (onWifi || prefs.allowCellularDownloads) {
    await beginDownloads(tier);
    return;
  }

  setStatus({ status: "cellular_blocked", progressPercent: 0, error: null });
  watchForWifiThenResume(tier);
}
