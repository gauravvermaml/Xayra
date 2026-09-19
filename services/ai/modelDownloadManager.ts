import { useEffect, useState } from "react";
import * as Device from "expo-device";
import { getCpuCoreCount } from "expo-device-cpu";
import { deleteNativeFile, enqueueDownload, queryDownload } from "expo-download-bridge";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";

import { downloadEmbeddingAssets, isEmbeddingModelDownloaded } from "./embeddingModel";
import {
  attemptOptimisticThreadCalibration,
  attemptThreadEscalation,
  CHAT_MODEL,
  computeInferenceThreadCount,
  prewarmLocalLlama,
  RETIRED_CHAT_MODEL_FILENAMES,
} from "./localLlama";
import { resetWhisperContext } from "./localWhisper";
import { MODEL_CDN_BASE_URL } from "./modelCdn";
import { getAverageTokensPerSecond, MIN_USABLE_TOKENS_PER_SECOND, resetPerformanceSamples } from "./modelPerformanceTracker";
import { getWhisperModelPath, isWhisperModelDownloaded, WHISPER_BASE_FILENAME } from "./whisperModels";
import { readPreferences, writePreferences } from "../settings/preferences";
import { syncDownloadNotification } from "../notifications/downloadNotification";

/**
 * Replaces the old first-launch onboarding picker and per-model Settings
 * cards: every local model Xayra needs (Whisper Base, the ONNX embedding
 * model, and the single Qwen2.5-1.5B chat model) now downloads automatically
 * in the background — through the Cloudflare Worker CDN proxy at
 * MODEL_CDN_BASE_URL (see modelCdn.ts) rather than hitting Hugging Face/R2
 * directly — gated only on network type and, for cellular, explicit user
 * consent. `initModelDownloads()` is called once from app/_layout.tsx; every
 * screen that cares about progress reads it via `useModelDownload()`.
 */

/**
 * A rough "is this a modern enough device to be worth running an
 * optimisation trial on" floor, used only by `maybeAttemptThreadEscalation()`
 * below. It was originally the RAM gate for the 1B -> 3B model-tier ladder;
 * that ladder is gone (there is one permanent production model now), but the
 * same threshold remains a reasonable proxy for "has headroom to spare" when
 * deciding whether to spend a trial completion measuring more threads.
 */
const RAM_FLOOR_FOR_TRIALS_BYTES = 7 * 1024 * 1024 * 1024;

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
/** Measured against the live Worker with a real GET — see the comment above.
 * scripts/sync-model-to-r2.sh prints this number after every upload. */
const CHAT_MODEL_APPROX_BYTES = 1_117_320_736;

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
  /** Human-readable size of the chat model (e.g. "1.0 GB") — shown on the
   * cellular-blocked callout, since that's the one asset actually big enough
   * for a user to weigh before agreeing to burn mobile data on it. */
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

const CHAT_MODEL_SIZE_LABEL = formatGigabytes(CHAT_MODEL_APPROX_BYTES);

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
  chatModelSizeLabel: CHAT_MODEL_SIZE_LABEL,
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
    // See maybeAttemptThreadEscalation's own doc comment — a cheap no-op for
    // most calls, and deliberately fired from this same "just became ready"
    // hook as prewarmLocalLlama so it only ever runs at a quiet moment. It
    // used to be sequenced behind a 1B -> 3B model-tier trial that mutated
    // the same shared context; with one permanent model there is no tier
    // trial left for it to race with or order against.
    void maybeAttemptThreadEscalation();
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

/**
 * Build 42 P2-5 fix (qa/05-consolidated-triage.md P2-5, found live during
 * Phase 1 device verification): a plain, non-hook snapshot read for callers
 * that aren't React components — `useModelDownload()` above needs a
 * component to attach its `useEffect` to, which `asrRouter.ts` isn't. Used
 * to warn the user once per session that a still-in-progress download may
 * be slowing down transcription, rather than leaving that slowdown
 * unexplained (nothing coordinates the DownloadManager transfer's I/O with
 * Whisper's own CPU-bound inference — confirmed on-device: a transcription
 * measured 8.9s against this app's own ~4.3s baseline while a Llama
 * download was still active).
 */
export function getCurrentModelDownloadStatus(): ModelDownloadStatus {
  return currentStatus;
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
  llama: CHAT_MODEL_APPROX_BYTES,
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

function resetTelemetry(): void {
  phaseApproxTotals = {
    whisper: WHISPER_APPROX_BYTES,
    embedding: EMBEDDING_APPROX_BYTES,
    llama: CHAT_MODEL_APPROX_BYTES,
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
    // A plain rename fails crossing storage volumes on this device (external
    // files dir -> internal documentDirectory) — confirmed on-device — so
    // fall back to copy+delete. The delete half uses the native
    // deleteNativeFile(), NOT FileSystem.deleteAsync(): expo-file-system's
    // own deleteAsync validates its target is inside one of ITS sandboxed
    // directories and rejects this external-storage path with "isn't
    // deletable" — confirmed on-device — even though the app has full
    // OS-level write access to it (this module's own DownloadManager
    // transfer wrote it there in the first place).
    await FileSystem.copyAsync({ from: sourceUri, to: dest });
    deleteNativeFile(sourceUri);
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
function watchForWifiThenResume(): void {
  stopWatchingForWifi();
  networkChangeSubscription = Network.addNetworkStateListener((event) => {
    if (event.type === Network.NetworkStateType.WIFI) {
      stopWatchingForWifi();
      void beginDownloads();
    }
  });
}

/**
 * Build 41 P1 fix (qa/05-consolidated-triage.md P1-3/P1-6): `beginDownloads()`
 * had no re-entrancy guard at all — `watchForWifiThenResume()`'s listener
 * and `allowCellularDownloadAndResume()` could both invoke it concurrently
 * (e.g. a user taps "Download over Mobile Data" at the exact moment Wi-Fi
 * also becomes available on its own), each independently calling
 * `enqueueDownload()` for the same phase before either had seen the other's
 * `nativeDownloadIds` write — producing two separate Android DownloadManager
 * transfers for the same file, with the one whose id lost the
 * `writePreferences()` race (see preferences.ts's own P1-2 fix) permanently
 * orphaned. This guard closes the concurrent-caller race directly. It does
 * NOT close the narrower kill-timing variant (a process kill in the gap
 * between `enqueueDownload()` returning an id and that id actually being
 * persisted) — that would need either a synchronous, atomic pairing of
 * "start the native transfer" with "record that we did," or a way to query
 * DownloadManager for an existing transfer by destination filename with no
 * persisted id at all, neither of which this fix attempts; noted here so
 * that gap isn't mistaken for closed.
 */
let downloadInProgress = false;

async function beginDownloads(): Promise<void> {
  if (downloadInProgress) {
    console.log("[ModelDownload] beginDownloads() called while one is already in progress — ignoring the duplicate trigger.");
    return;
  }
  downloadInProgress = true;
  try {
    await beginDownloadsInner();
  } finally {
    downloadInProgress = false;
  }
}

async function beginDownloadsInner(): Promise<void> {
  const [whisperDone, embeddingDone, llamaDone] = await Promise.all([
    isWhisperModelDownloaded(),
    isEmbeddingModelDownloaded(),
    isChatModelDownloaded(CHAT_MODEL.filename),
  ]);

  resetTelemetry();
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
        `${MODEL_CDN_BASE_URL}/${CHAT_MODEL.filename}`,
        CHAT_MODEL.filename,
        chatModelPath(CHAT_MODEL.filename),
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
  await beginDownloads();
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
  await beginDownloads();
}

/**
 * A device needs at least this many logical cores before a thread-escalation
 * trial is even considered — the candidate thread count below reserves a
 * hard floor of 2 full cores for OS/UI no matter what (never fewer than the
 * `computeInferenceThreadCount()` default already reserves on an 8-core
 * device), so this also guarantees there's real room to escalate INTO
 * without immediately violating that floor on a small-core device where
 * "double the threads" would leave nothing for the OS.
 */
const MIN_CORES_FOR_THREAD_ESCALATION = 6;

/**
 * Opportunistic thread-count escalation — see `computeInferenceThreadCount()`
 * in localLlama.ts for the full root-cause writeup this exists to fix: a
 * fixed quarter-of-cores formula, tuned against a 2019 budget 8-core chip
 * that froze at HALF that many threads, hands the exact same starved thread
 * count to a modern flagship with cores to spare (confirmed on-device: a
 * Pixel 9, 12GB RAM, measuring ~2-minute retrievals on just 48 notes).
 *
 * Same trial/keep/rollback shape the retired 1B -> 3B model-tier upgrade
 * used, applied to thread count instead of model size: a cheap
 * RAM/core-count/history pre-filter gates whether a real trial is even worth
 * running, then a real measured trial (`attemptThreadEscalation` in
 * localLlama.ts) decides whether to keep it — never a static guess alone.
 * Fired from the "just became ready" hook in `setStatus`.
 */
async function maybeAttemptThreadEscalation(): Promise<void> {
  const prefs = await readPreferences();
  if (prefs.threadEscalationStatus !== "not_attempted") {
    return;
  }

  const totalMemory = Device.totalMemory;
  // Same "not worth guessing on hardware we already have direct freeze
  // evidence for" floor already trusted for the 1B->3B tier decision above
  // — the original freeze device (a 4GB Galaxy A50) doesn't clear this at
  // all, and the Redmi Note 8 Pro that barely does (7.48GB) never actually
  // regressed from the existing default in on-device testing, since a
  // rejected trial here always reloads back to it.
  const isModernEnough = totalMemory !== null && totalMemory !== undefined && totalMemory >= RAM_FLOOR_FOR_TRIALS_BYTES;
  if (!isModernEnough) {
    return;
  }

  const cores = getCpuCoreCount();
  if (!cores || cores < MIN_CORES_FOR_THREAD_ESCALATION) {
    return;
  }

  const averageTokensPerSecond = await getAverageTokensPerSecond();
  if (averageTokensPerSecond === null) {
    return; // Not enough real usage history yet at the current thread count to judge anything from.
  }

  const currentThreads = await computeInferenceThreadCount();
  // Doubling is the escalation step (matching the "one step at a time, then
  // measure" caution `maybeAttemptTierUpgrade` also uses) — capped so at
  // least 2 full cores are always left for the OS/UI, the exact reservation
  // the original freeze-fix already proved necessary.
  const candidateThreads = Math.min(cores - 2, currentThreads * 2);
  if (candidateThreads <= currentThreads) {
    return; // No headroom left to try more without dropping below that reservation.
  }

  const { passed, tokensPerSecond } = await attemptThreadEscalation(candidateThreads, averageTokensPerSecond);
  await resetPerformanceSamples(); // A throughput history from one thread count says nothing about another.

  if (passed) {
    await writePreferences({ llamaThreadCount: candidateThreads, threadEscalationStatus: "accepted" });
    console.log(
      `[ThreadTuning] Escalated to ${candidateThreads} threads — measured ${tokensPerSecond.toFixed(1)} tok/s (was ~${averageTokensPerSecond.toFixed(1)} at ${currentThreads}).`
    );
  } else {
    await writePreferences({ threadEscalationStatus: "rejected" });
    console.log(
      `[ThreadTuning] Rejected ${candidateThreads}-thread trial — measured ${tokensPerSecond.toFixed(1)} tok/s, not meaningfully faster than the ~${averageTokensPerSecond.toFixed(1)} baseline at ${currentThreads}. Staying at ${currentThreads} threads.`
    );
  }
}

/**
 * Thin persistence wrapper around localLlama.ts's
 * `attemptOptimisticThreadCalibration()` — called ONCE from
 * `OnboardingSetupScreen.tsx`'s "Tuning quick-recall for your device" step,
 * deliberately NOT from the "just became ready" hook `maybeAttemptTierUpgrade`/
 * `maybeAttemptThreadEscalation` share above. This one runs BEFORE the user
 * has asked a single real question — optimistic-first, not conservative-
 * then-earn-your-way-up — see that function's own doc comment for the full
 * reasoning (this app's real target users are 2023+ flagship-class devices,
 * so the FIRST thing tried should assume that, not a 2019 budget phone).
 *
 * Marking `threadEscalationStatus: "accepted"` on success short-circuits
 * `maybeAttemptThreadEscalation` from later re-checking a device that's
 * already sitting at its optimistic ceiling (there'd be no headroom left to
 * escalate INTO anyway — the math there already guards against that, this
 * just avoids the wasted check). Leaving it "not_attempted" on a failed/
 * timed-out calibration is equally deliberate: it's what lets that
 * function's own conservative-then-escalate path give a device a second,
 * later chance once it has real usage history to measure against, exactly
 * as if this optimistic attempt had never run at all.
 */
/**
 * Build 40 resilience layer (see services/ai/memoryGuard.ts's own doc
 * comment for the full three-layer picture): `onboardingCalibrationAttemptInFlight`
 * is set to `true` right before the real trial starts and cleared back to
 * `false` the moment it finishes, success or fallback — found still `true`
 * on THIS call means last attempt's flag never got cleared, which only
 * happens if the process was killed mid-trial. Rather than gamble on the
 * same heavier optimistic path again immediately (risking the exact same
 * kill a second or third time in a row), this attempt goes straight to the
 * known-safe conservative thread count — a device that just proved it
 * can't currently afford the aggressive attempt should get INTO the app
 * working, not keep retrying the thing that didn't work.
 *
 * `skipOptimistic` is the other half of this same safety net, set by
 * OnboardingSetupScreen.tsx's own pre-flight check (services/ai/memoryGuard.ts)
 * — if the SYSTEM already reports being low on memory before this even
 * starts, there's no reason to try the heavier path at all and risk being
 * the straw that gets this process killed; go straight to conservative,
 * same as if a previous attempt had already proven it necessary.
 */
export async function runOnboardingThreadCalibration(skipOptimistic = false): Promise<void> {
  const prefs = await readPreferences();
  if (prefs.onboardingCalibrationAttemptInFlight || skipOptimistic) {
    const cores = getCpuCoreCount();
    const conservativeThreads = cores ? Math.max(1, Math.floor(cores / 4)) : 2;
    await writePreferences({
      llamaThreadCount: conservativeThreads,
      threadEscalationStatus: "rejected",
      onboardingCalibrationAttemptInFlight: false,
    });
    console.log(
      skipOptimistic
        ? `[ThreadTuning] Device already reported low memory before calibration — using the safe ${conservativeThreads}-thread default directly.`
        : "[ThreadTuning] Previous calibration attempt never completed (process likely killed mid-trial) — " +
            `skipping straight to the safe ${conservativeThreads}-thread default this time.`
    );
    return;
  }

  await writePreferences({ onboardingCalibrationAttemptInFlight: true });
  const result = await attemptOptimisticThreadCalibration();
  if (result.calibrated) {
    await writePreferences({
      llamaThreadCount: result.threads,
      threadEscalationStatus: "accepted",
      onboardingCalibrationAttemptInFlight: false,
    });
    console.log(
      `[ThreadTuning] Onboarding calibration accepted — ${result.threads} threads, measured ${result.tokensPerSecond.toFixed(1)} tok/s.`
    );
  } else {
    await writePreferences({ onboardingCalibrationAttemptInFlight: false });
    console.log("[ThreadTuning] Onboarding calibration declined or timed out — staying on the conservative default.");
  }
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

/**
 * Deletes chat models this app used to ship but no longer loads.
 *
 * A device that already completed setup on a pre-cutover build has a
 * Llama-3.2 1B or 3B GGUF (0.8–2.0 GB) sitting in the document directory.
 * Nothing in the app reads those filenames any more, and an APK update never
 * touches the document directory, so without this they would stay on disk
 * permanently — on top of the ~1.07 GB the new model is about to download.
 * Runs before the readiness check rather than after, so the reclaimed space
 * is available to that download on the devices that need it most.
 *
 * Deliberately best-effort and never fatal: a failure here costs disk space,
 * which is not a reason to block setup.
 */
async function deleteRetiredChatModels(): Promise<void> {
  await Promise.all(
    RETIRED_CHAT_MODEL_FILENAMES.map(async (filename) => {
      try {
        const path = chatModelPath(filename);
        const info = await FileSystem.getInfoAsync(path);
        if (info.exists) {
          await FileSystem.deleteAsync(path, { idempotent: true });
          console.log(`[ModelDownload] Removed retired chat model: ${filename}`);
        }
      } catch (err) {
        console.warn(`[ModelDownload] Could not remove retired chat model ${filename}:`, err);
      }
    })
  );
}

async function runInitialCheck(): Promise<void> {
  setStatus({ chatModelSizeLabel: CHAT_MODEL_SIZE_LABEL });
  await deleteRetiredChatModels();

  const [whisperReady, embeddingReady, chatReady] = await Promise.all([
    isWhisperModelDownloaded(),
    isEmbeddingModelDownloaded(),
    isChatModelDownloaded(CHAT_MODEL.filename),
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
    await beginDownloads();
    return;
  }

  setStatus({ status: "cellular_blocked", progressPercent: 0, error: null });
  watchForWifiThenResume();
}
