import { useEffect, useState } from "react";
import * as Device from "expo-device";
import { enqueueDownload, queryDownload } from "expo-download-bridge";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";

import { downloadEmbeddingAssets, isEmbeddingModelDownloaded } from "./embeddingModel";
import { LLAMA_MODEL_FILENAMES, prewarmLocalLlama } from "./localLlama";
import { resetWhisperContext } from "./localWhisper";
import { MODEL_CDN_BASE_URL } from "./modelCdn";
import { getWhisperModelPath, isWhisperModelDownloaded, WHISPER_BASE_FILENAME } from "./whisperModels";
import { readPreferences, writePreferences } from "../settings/preferences";
import { syncDownloadNotification } from "../notifications/downloadNotification";

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

export type ModelDownloadState =
  | "idle"
  | "downloading"
  | "ready"
  | "error"
  | "cellular_blocked"
  /** The whisper/llama phase (see `downloadFileViaSystemManager`) is paused
   * by Android's own DownloadManager, almost always for a connectivity
   * reason — distinct from "error" so the UI can say "paused, we'll resume
   * automatically" instead of implying something actually went wrong.
   * DownloadManager resumes it on its own the moment connectivity returns;
   * no user action, JS-side listener, or `resumeDownloads()` call required —
   * the poll loop in `downloadFileViaSystemManager` just keeps polling and
   * flips this back to "downloading" once `query()` reports "running" again. */
  | "paused_offline";

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
  /** Which of the three real download phases have actually landed on disk —
   * exposed so screens/OnboardingSetupScreen.tsx's step checklist can show
   * genuine per-step "Ready" state instead of only the combined progress
   * bar (whisper/embedding typically finish in a couple of minutes, long
   * before the llama phase does, and that difference is worth showing). */
  phasesReady: { whisper: boolean; embedding: boolean; llama: boolean };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  phasesReady: { whisper: false, embedding: false, llama: false },
  error: null,
};

function setStatus(patch: Partial<ModelDownloadStatus>): void {
  const previousStatus = currentStatus.status;
  currentStatus = { ...currentStatus, ...patch };
  listeners.forEach((listener) => listener(currentStatus));
  // Build 25 SYSTEM NOTIFICATION: mirrors every status change into the
  // Android notification shade — see downloadNotification.ts for why this
  // is a fire-and-forget, permission-optional side effect rather than
  // something awaited or allowed to affect the download itself.
  syncDownloadNotification(currentStatus);
  // Build 26 AUTO-WARMUP: fires the instant the chat model actually becomes
  // usable — either `beginDownloads` finishing a live download, or
  // `runInitialCheck` finding it already on disk at boot — rather than
  // waiting for the user's first "Ask" to pay the full cold-start cost (see
  // prewarmLocalLlama's own doc comment for what "warm" actually means as
  // of Build 26). `previousStatus !== "ready"` guards against re-firing on
  // every later status read once the app is already warm and idle.
  if (currentStatus.status === "ready" && previousStatus !== "ready") {
    void prewarmLocalLlama();
  }
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

/** Read into `ModelDownloadStatus.phasesReady` — see its own doc comment. */
function snapshotPhasesReady(): ModelDownloadStatus["phasesReady"] {
  return {
    whisper: phaseCompleted.has("whisper"),
    embedding: phaseCompleted.has("embedding"),
    llama: phaseCompleted.has("llama"),
  };
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

// ---- Android DownloadManager-backed phases ---------------------------------
//
// Whisper and the Llama chat model — the two large, slow, Worker-CDN-hosted
// phases the "One Door, Opens Once" onboarding screen explicitly invites the
// user to minimize/background the app during (see app/_layout.tsx's root
// guard and screens/OnboardingSetupScreen.tsx) — are handed to Android's own
// system DownloadManager (modules/download-bridge) rather than run inside
// this app's React Native process. DownloadManager is a real OS service:
// once enqueued, the transfer survives this app's process being frozen,
// killed, or even a device reboot, which expo-file-system's
// DownloadResumable (still used below by the small, fast embedding phase —
// see embeddingModel.ts) cannot offer, since that's still ultimately driven
// by this app's own process. DownloadManager also already retries/resumes
// on its own when connectivity drops mid-transfer (status flips to "paused"
// with a PAUSED_WAITING_FOR_NETWORK reason, then back to "running" once the
// network returns) — so, unlike the old in-process implementation this
// replaced, nothing here needs to catch a network error and manually
// arrange a resume; the poll loop below just keeps polling and mirrors
// "paused" into the same `status: "paused_offline"` the UI already knows
// how to render.

const NATIVE_POLL_INTERVAL_MS = 750;

/** DownloadManager writes into this app's app-private *external* files
 * directory (see DownloadBridgeModule.kt's doc comment) — never the same
 * directory as `FileSystem.documentDirectory`, which every other service in
 * this app reads model files from. Moves the finished file across that
 * boundary once DownloadManager reports success. */
async function moveIntoDocumentDirectory(sourceUri: string, dest: string): Promise<void> {
  try {
    await FileSystem.moveAsync({ from: sourceUri, to: dest });
  } catch {
    // A plain rename can fail crossing storage volumes on some Android
    // versions/vendors — copy+delete always works, since both sides are
    // ordinary paths this app already has read/write access to.
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    await FileSystem.deleteAsync(sourceUri, { idempotent: true });
  }
}

async function clearPersistedNativeDownloadId(phaseKey: "whisper" | "llama"): Promise<void> {
  const prefs = await readPreferences();
  const { [phaseKey]: _removed, ...remaining } = prefs.nativeDownloadIds;
  await writePreferences({ nativeDownloadIds: remaining });
}

/**
 * Enqueues (or, if this app's process was killed and relaunched mid-download,
 * re-attaches to) a DownloadManager transfer and polls it to completion.
 * Never throws for a connectivity drop — DownloadManager handles that
 * itself; only a genuine terminal failure (`"failed"`/`"not_found"`) throws.
 */
async function downloadFileViaSystemManager(
  phaseKey: "whisper" | "llama",
  url: string,
  destFilename: string,
  dest: string,
  title: string,
  onProgress: PhaseProgressCallback
): Promise<void> {
  const prefs = await readPreferences();
  let downloadId = prefs.nativeDownloadIds[phaseKey];
  if (downloadId === undefined) {
    downloadId = enqueueDownload(url, destFilename, title);
    await writePreferences({ nativeDownloadIds: { ...prefs.nativeDownloadIds, [phaseKey]: downloadId } });
  }

  for (;;) {
    const result = queryDownload(downloadId);

    if (result.status === "successful") {
      await clearPersistedNativeDownloadId(phaseKey);
      if (!result.localUri) {
        throw new Error(`${phaseKey} download reported successful with no local file.`);
      }
      await moveIntoDocumentDirectory(result.localUri, dest);
      onProgress(1, result.bytesTotal || 1, result.bytesTotal || 1);
      return;
    }

    if (result.status === "failed" || result.status === "not_found") {
      await clearPersistedNativeDownloadId(phaseKey);
      throw new Error(`${phaseKey} download failed (DownloadManager status "${result.status}", reason ${result.reason}).`);
    }

    // "pending" | "running" | "paused" | "unknown" — all still in flight;
    // DownloadManager itself decides when/whether to retry a "paused" one.
    if (result.status === "paused" && currentStatus.status !== "paused_offline") {
      setStatus({ status: "paused_offline", error: null });
    } else if (result.status !== "paused" && currentStatus.status === "paused_offline") {
      setStatus({ status: "downloading", error: null });
    }

    if (result.bytesTotal > 0) {
      onProgress(result.bytesDownloaded / result.bytesTotal, result.bytesDownloaded, result.bytesTotal);
    }

    await delay(NATIVE_POLL_INTERVAL_MS);
  }
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

  setStatus({ status: "downloading", error: null, phasesReady: snapshotPhasesReady() });
  updateTelemetry(completedBytesBeforeCurrentPhase(), totalBytesAcrossPendingPhases());

  try {
    if (!whisperDone) {
      await downloadFileViaSystemManager(
        "whisper",
        `${MODEL_CDN_BASE_URL}/${WHISPER_BASE_FILENAME}`,
        WHISPER_BASE_FILENAME,
        getWhisperModelPath(),
        "Xayra: speech-to-text engine",
        (fraction, bytesWritten, bytesTotal) => onPhaseProgress("whisper", fraction, bytesWritten, bytesTotal)
      );
      resetWhisperContext();
      phaseCompleted.add("whisper");
      setStatus({ phasesReady: snapshotPhasesReady() });
    }

    if (!embeddingDone) {
      await downloadEmbeddingAssets((fraction, bytesWritten, bytesTotal) =>
        onPhaseProgress("embedding", fraction, bytesWritten, bytesTotal)
      );
      phaseCompleted.add("embedding");
      setStatus({ phasesReady: snapshotPhasesReady() });
    }

    if (!llamaDone) {
      await downloadFileViaSystemManager(
        "llama",
        `${MODEL_CDN_BASE_URL}/${tier.filename}`,
        tier.filename,
        chatModelPath(tier.filename),
        "Xayra: on-device intelligence engine",
        (fraction, bytesWritten, bytesTotal) => onPhaseProgress("llama", fraction, bytesWritten, bytesTotal)
      );
      phaseCompleted.add("llama");
      setStatus({ phasesReady: snapshotPhasesReady() });
    }

    const totalBytes = totalBytesAcrossPendingPhases();
    updateTelemetry(totalBytes, totalBytes);
    setStatus({ status: "ready", progressPercent: 100, error: null });
  } catch (err) {
    // Unlike the old in-process downloader, reaching here means a genuine
    // terminal failure — DownloadManager already retries transient/offline
    // conditions on its own (see downloadFileViaSystemManager's doc
    // comment), so there's no separate "paused, will auto-resume" branch to
    // handle here the way OfflineDownloadError used to require.
    setStatus({ status: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

export async function allowCellularDownloadAndResume(): Promise<void> {
  await writePreferences({ allowCellularDownloads: true });
  stopWatchingForWifi();
  await beginDownloads(resolveLlamaTier());
}

/**
 * Retries setup after a `status: "error"`. Safe to call any time —
 * `beginDownloads` always re-checks which phases are already complete, and
 * for a whisper/llama phase whose DownloadManager transfer is still present
 * (id persisted in `nativeDownloadIds` — see `downloadFileViaSystemManager`),
 * re-attaches to that SAME system-owned download and continues from wherever
 * it actually is rather than re-streaming bytes that already landed. `status:
 * "paused_offline"` never reaches this at all — DownloadManager resumes that
 * case on its own with no user action. Wired to the "Resume Download" button
 * in ChatSheetContent.tsx.
 */
export async function resumeDownloads(): Promise<void> {
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
    setStatus({
      status: "ready",
      progressPercent: 100,
      error: null,
      phasesReady: { whisper: true, embedding: true, llama: true },
    });
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
