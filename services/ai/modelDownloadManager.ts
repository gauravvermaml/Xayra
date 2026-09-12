import { useEffect, useState } from "react";
import * as Device from "expo-device";
import { getCpuCoreCount } from "expo-device-cpu";
import { deleteNativeFile, enqueueDownload, queryDownload } from "expo-download-bridge";
import * as FileSystem from "expo-file-system/legacy";
import * as Network from "expo-network";

import { downloadEmbeddingAssets, isEmbeddingModelDownloaded } from "./embeddingModel";
import {
  attemptThreadEscalation,
  attemptTierUpgrade,
  computeInferenceThreadCount,
  LLAMA_MODEL_FILENAMES,
  prewarmLocalLlama,
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
 * model, and a RAM-tiered Llama chat model) now downloads automatically in
 * the background — through the Cloudflare Worker CDN proxy at
 * MODEL_CDN_BASE_URL (see modelCdn.ts) rather than hitting Hugging Face/R2
 * directly — gated only on network type and, for cellular, explicit user
 * consent. `initModelDownloads()` is called once from app/_layout.tsx; every
 * screen that cares about progress reads it via `useModelDownload()`.
 */

const LLAMA_1B_FILENAME = LLAMA_MODEL_FILENAMES.find((m) => m.label === "1B")!.filename;
const LLAMA_3B_FILENAME = LLAMA_MODEL_FILENAMES.find((m) => m.label === "3B")!.filename;

/**
 * Below this, a device doesn't have room for the 3B model regardless of how
 * fast its CPU is — a hard prerequisite for even ATTEMPTING an upgrade, kept
 * from the original RAM-only design. What changed (see
 * [[ram-tier-bad-proxy-for-cpu]] in project memory): RAM used to be treated
 * as SUFFICIENT on its own to hand a device the 3B model outright. Measured
 * on-device that this is wrong — a Redmi Note 8 Pro (7.48 GiB RAM, qualifies
 * under this exact threshold) took 12+ minutes for its first retrieval on
 * the 3B model, because its CPU (a 2019 mid-range chipset, further limited
 * to 2 inference threads by the freeze-fix in localLlama.ts) can't sustain
 * it. RAM now only gates whether an upgrade is worth TRYING; real measured
 * throughput (services/ai/modelPerformanceTracker.ts) decides whether it's
 * worth KEEPING — see `maybeAttemptTierUpgrade()` below.
 */
const RAM_FLOOR_FOR_3B_BYTES = 7 * 1024 * 1024 * 1024;

/** A device's real 1B throughput needs to comfortably clear the "usable"
 * floor by roughly this multiple before an upgrade attempt is even worth
 * the 2GB download — llama.cpp decode speed on a given device scales
 * roughly with parameter count for CPU-bound generation, so a device
 * barely clearing MIN_USABLE_TOKENS_PER_SECOND at 1B almost certainly won't
 * clear it at 3B at all. Deliberately a rough heuristic, not a precise
 * prediction — the actual keep/reject decision always comes from a real
 * measured trial on the 3B model itself (see `attemptTierUpgrade` in
 * localLlama.ts), never from this estimate alone; this constant only
 * decides whether that trial (and its 2GB download) is worth attempting.
 */
const MIN_1B_SPEED_MULTIPLE_TO_ATTEMPT_UPGRADE = 3;

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

type LlamaTier = { filename: string; approxBytes: number; sizeLabel: string; label: string };

const TIER_1B: LlamaTier = {
  filename: LLAMA_1B_FILENAME,
  approxBytes: LLAMA_1B_APPROX_BYTES,
  sizeLabel: formatGigabytes(LLAMA_1B_APPROX_BYTES),
  label: "1B",
};
const TIER_3B: LlamaTier = {
  filename: LLAMA_3B_FILENAME,
  approxBytes: LLAMA_3B_APPROX_BYTES,
  sizeLabel: formatGigabytes(LLAMA_3B_APPROX_BYTES),
  label: "3B",
};

/**
 * The tier a device with NEITHER model on disk downloads — always 1B. See
 * [[ram-tier-bad-proxy-for-cpu]]: RAM alone used to pick 3B for any device
 * over the 7 GiB threshold, which handed at least one real device a 12+
 * minute first retrieval. 1B is fast on effectively any device that can run
 * an LLM at all; `maybeAttemptTierUpgrade()` is the only path that ever
 * moves a device to 3B, gated on real measured performance rather than RAM.
 */
function resolveDefaultLlamaTier(): LlamaTier {
  return TIER_1B;
}

/**
 * The tier THIS device is actually using right now — prefers 3B if it's
 * already on disk (a device that already passed its upgrade trial, or was
 * manually pushed one via adb), otherwise the 1B default. Async because it
 * has to check disk, unlike `resolveDefaultLlamaTier()` — used at startup
 * (`runInitialCheck`) so an already-upgraded device doesn't get its working
 * 3B model discarded and re-downloaded as 1B on a later launch.
 */
async function resolveActiveLlamaTier(): Promise<LlamaTier> {
  return (await isChatModelDownloaded(TIER_3B.filename)) ? TIER_3B : TIER_1B;
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
  chatModelSizeLabel: resolveDefaultLlamaTier().sizeLabel,
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
    // See maybeAttemptTierUpgrade's/maybeAttemptThreadEscalation's own doc
    // comments — both are cheap no-ops for most calls, and deliberately
    // fired from this same "just became ready" hook as prewarmLocalLlama so
    // they only ever run at a quiet moment. SEQUENCED, not fired
    // concurrently (both `void`'d separately would race): both mutate the
    // same shared Llama context singleton (release + reload), so running
    // them at the same time risked one's reload clobbering the other's
    // in-flight trial. Thread escalation running after any tier-upgrade
    // resolves is also the right order semantically — it should measure
    // against whichever model tier is actually active by then.
    void (async () => {
      await maybeAttemptTierUpgrade();
      await maybeAttemptThreadEscalation();
    })();
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
  await beginDownloads(await resolveActiveLlamaTier());
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
  await beginDownloads(await resolveActiveLlamaTier());
}

/**
 * Opportunistic 1B -> 3B upgrade, gated on real measured performance rather
 * than RAM alone — see [[ram-tier-bad-proxy-for-cpu]] for why. Called from
 * `setStatus`'s existing "just became ready" hook (same trigger as
 * `prewarmLocalLlama`), so it only ever runs at a quiet moment — right after
 * boot with everything already warm, or right after a fresh download
 * finishes — never mid-answer. A no-op, cheaply, for the large majority of
 * calls: most of the early return conditions below are the common case
 * (already decided, not enough history yet, doesn't have the RAM for it).
 */
async function maybeAttemptTierUpgrade(): Promise<void> {
  const prefs = await readPreferences();
  if (prefs.tier3BStatus !== "not_attempted") {
    return;
  }

  const totalMemory = Device.totalMemory;
  const hasRamFor3B = totalMemory !== null && totalMemory !== undefined && totalMemory >= RAM_FLOOR_FOR_3B_BYTES;
  if (!hasRamFor3B) {
    return;
  }

  if (await isChatModelDownloaded(TIER_3B.filename)) {
    // A 3B file already on disk with tier3BStatus still "not_attempted"
    // means one of: a device from before this feature existed (this whole
    // file used to hand out 3B by RAM alone — see [[ram-tier-bad-proxy-for-cpu]]),
    // or one manually pushed via adb. Deliberately NOT run through a real
    // trial here the way a fresh upgrade is — trusted as-is, since that
    // would need a 1B fallback file downloaded first just to have something
    // to fall back to, for what's expected to be a rare legacy/manual case
    // rather than anything a real post-this-fix install ever hits. Marked
    // "accepted" so this check doesn't re-run on every boot, not because it
    // was actually measured.
    await writePreferences({ tier3BStatus: "accepted" });
    return;
  }

  const averageTokensPerSecond = await getAverageTokensPerSecond();
  if (averageTokensPerSecond === null) {
    return; // Not enough real 1B usage history yet to judge anything from.
  }
  if (averageTokensPerSecond < MIN_USABLE_TOKENS_PER_SECOND * MIN_1B_SPEED_MULTIPLE_TO_ATTEMPT_UPGRADE) {
    // This device's 1B speed itself isn't fast enough to suggest 3B (roughly
    // 3x heavier per-token) would land anywhere near usable — not worth a
    // 2GB download to find out. Not marked "rejected": a future firmware/
    // thermal-management change (or just cooler real-world conditions) could
    // change this, so it's worth re-checking on a later boot rather than
    // closing the door permanently the way an actual failed trial does.
    return;
  }

  const netState = await Network.getNetworkStateAsync();
  if (netState.type !== Network.NetworkStateType.WIFI) {
    return; // Re-checked on every "ready" transition; no separate listener needed.
  }

  const candidatePath = chatModelPath(TIER_3B.filename);
  try {
    await downloadFileViaSystemManager(
      "llama",
      `${MODEL_CDN_BASE_URL}/${TIER_3B.filename}`,
      TIER_3B.filename,
      candidatePath,
      "Xayra: on-device intelligence engine upgrade",
      () => {} // Silent — this is a background upgrade attempt, not the onboarding download the UI already has a progress bar for.
    );
  } catch {
    // A failed download here isn't the user-facing "error" state the main
    // onboarding flow surfaces — this device just keeps using its working 1B
    // model and gets another chance on a later boot (tier3BStatus is still
    // "not_attempted").
    return;
  }

  const fallbackPath = chatModelPath(TIER_1B.filename);
  const { passed, tokensPerSecond } = await attemptTierUpgrade(candidatePath, "3B", fallbackPath, "1B");
  await resetPerformanceSamples(); // A throughput history from one model size says nothing about another.

  if (passed) {
    await writePreferences({ tier3BStatus: "accepted" });
    // deleteNativeFile, not FileSystem.deleteAsync — both paths here are
    // ordinary FileSystem.documentDirectory paths, so deleteAsync would
    // actually work fine in this specific case, but this module already
    // standardized on the native delete for every file this tier-management
    // code touches (see downloadFileViaSystemManager's own doc comment).
    deleteNativeFile(fallbackPath);
    setStatus({ chatModelSizeLabel: TIER_3B.sizeLabel });
    console.log(`[ModelTier] Upgraded to 3B — measured ${tokensPerSecond.toFixed(1)} tok/s.`);
  } else {
    await writePreferences({ tier3BStatus: "rejected" });
    deleteNativeFile(candidatePath);
    console.log(`[ModelTier] Rejected 3B — measured ${tokensPerSecond.toFixed(1)} tok/s, below usable floor. Staying on 1B.`);
  }
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
 * Same shape as `maybeAttemptTierUpgrade()` right above, deliberately: a
 * cheap RAM/core-count/history pre-filter gates whether a real trial is even
 * worth running, then a real measured trial (`attemptThreadEscalation` in
 * localLlama.ts) decides whether to keep it — never a static guess alone.
 * Fired from the same "just became ready" hook, sequenced after any
 * tier-upgrade attempt (see that call site's own comment for why this can't
 * run concurrently with it).
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
  const isModernEnough = totalMemory !== null && totalMemory !== undefined && totalMemory >= RAM_FLOOR_FOR_3B_BYTES;
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
  const tier = await resolveActiveLlamaTier();
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
