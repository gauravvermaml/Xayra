import * as FileSystem from "expo-file-system/legacy";

export type Preferences = {
  /** Set once the user explicitly taps "Download over Mobile Data" on the
   * cellular-blocked callout (see services/ai/modelDownloadManager.ts) —
   * persisted so that consent, once given, survives app restarts instead of
   * asking again on every launch that happens to still be off Wi-Fi. */
  allowCellularDownloads: boolean;
  /** Android DownloadManager download IDs for the whisper/llama phases
   * currently (or most recently) in flight via modules/download-bridge —
   * keyed by phase name. Persisted so that if this app's process is killed
   * mid-download (expected — the onboarding screen explicitly invites the
   * user to minimize/background it) and later relaunched, JS re-attaches to
   * the SAME system-owned DownloadManager record via `queryDownload()`
   * instead of enqueueing a duplicate transfer. Cleared once a phase
   * reaches "successful" or a terminal "failed". */
  nativeDownloadIds: Partial<Record<"whisper" | "llama", number>>;
  /** Recent real-world tokens/sec samples from actual completions (RAG
   * answers and to-do extractions), most recent last — see
   * services/ai/modelPerformanceTracker.ts. Deliberately NOT a one-shot
   * synthetic benchmark: a single measurement taken right after a cold
   * model load can be misleadingly fast (before sustained-load thermal
   * throttling kicks in — confirmed on-device, see
   * [[ram-tier-bad-proxy-for-cpu]]) or misleadingly slow (competing with
   * other onboarding work still finishing). A short rolling window of real
   * usage is a much more honest signal of what this device can actually
   * sustain. */
  performanceSamples: number[];
  /** Whether this device has ever attempted, and how it fared on, an
   * opportunistic upgrade from the default 1B model to the 3B one — see
   * `maybeAttemptTierUpgrade()` in modelDownloadManager.ts. "rejected" is
   * permanent for this install: a device whose real 3B throughput came in
   * under the usable floor isn't worth re-trying, since the underlying CPU
   * doesn't change. */
  tier3BStatus: "not_attempted" | "rejected" | "accepted";
  /** `null` (the default, for every device) means "use
   * `computeInferenceThreadCount()`'s conservative quarter-of-cores
   * formula" — a fixed number here is a MEASURED override, only ever
   * written by `maybeAttemptThreadEscalation()` (modelDownloadManager.ts)
   * after a real on-device trial proved it's genuinely faster than this
   * device's own prior baseline (see `attemptThreadEscalation()` in
   * localLlama.ts). Confirmed on a Pixel 9 (12GB RAM, 8+ cores): the flat
   * quarter-of-cores formula was tuned against a 2019 budget 8-core chip
   * that froze at HALF its cores, and gives that exact same "2 threads" to
   * a modern flagship with cores to spare — a ~2-minute retrieval on
   * hardware that should easily clear a few seconds. */
  llamaThreadCount: number | null;
  /** Same shape/semantics as `tier3BStatus`, for the thread-escalation
   * trial above — "rejected" is permanent for this install for the same
   * reason (the CPU/core layout doesn't change between launches). */
  threadEscalationStatus: "not_attempted" | "rejected" | "accepted";
  /**
   * Build 40 onboarding resilience: set to `true` immediately before
   * `runOnboardingThreadCalibration()` starts its trial, cleared back to
   * `false` the moment it finishes (success OR falling back) — see that
   * function in modelDownloadManager.ts. Found still `true` on a fresh
   * launch means the LAST attempt never got to clear it, which only
   * happens if the app process died mid-trial (confirmed on-device: this
   * app killed by Android's low-memory killer during exactly this step,
   * on a Pixel 9 with ordinary background apps open — see
   * services/ai/memoryGuard.ts). A device that just proved it can't afford
   * the heavier optimistic attempt shouldn't be asked to gamble on it
   * again immediately — the next attempt goes straight to the safe
   * conservative default instead.
   */
  onboardingCalibrationAttemptInFlight: boolean;
  /**
   * Build 40 onboarding resilience: set once, the FIRST time onboarding's
   * completion sequence ever starts for this install — never overwritten
   * after that, including across a process kill and relaunch. Lets
   * OnboardingSetupScreen measure real elapsed wall-clock time since setup
   * genuinely began, even if the app has been killed and restarted several
   * times in between, so a "this is taking unusually long — continue with
   * safe settings?" escape hatch can appear based on truth rather than
   * resetting its own clock every time the process happens to restart.
   */
  onboardingStartedAt: number | null;
};

const DEFAULT_PREFERENCES: Preferences = {
  allowCellularDownloads: false,
  nativeDownloadIds: {},
  performanceSamples: [],
  tier3BStatus: "not_attempted",
  llamaThreadCount: null,
  threadEscalationStatus: "not_attempted",
  onboardingCalibrationAttemptInFlight: false,
  onboardingStartedAt: null,
};

function preferencesPath(): string {
  const dir = FileSystem.documentDirectory;
  if (!dir) {
    throw new Error("No writable document directory available on this platform.");
  }
  return `${dir}preferences.json`;
}

/**
 * Preferences are small and read constantly (every Whisper transcription
 * checks the active model), so the parsed object is cached in memory after
 * the first read/write rather than re-reading the file every time.
 */
let cache: Preferences | null = null;

export async function readPreferences(): Promise<Preferences> {
  if (cache) {
    return cache;
  }
  let loaded: Preferences;
  try {
    const raw = await FileSystem.readAsStringAsync(preferencesPath());
    loaded = { ...DEFAULT_PREFERENCES, ...JSON.parse(raw) };
  } catch {
    // No prefs file yet (first launch) — fall back to defaults.
    loaded = { ...DEFAULT_PREFERENCES };
  }
  cache = loaded;
  return loaded;
}

/**
 * Build 41 P1 fix (qa/05-consolidated-triage.md P1-2): this used to be a
 * bare, unguarded read-modify-write against the shared `cache` — two
 * overlapping calls could both read the same pre-write snapshot before
 * either committed, silently discarding whichever patch landed first (a
 * classic lost-update race). Confirmed concretely: `modelDownloadManager.ts`'s
 * tier-upgrade/thread-escalation chain and `OnboardingSetupScreen.tsx`'s own
 * calibration call are both triggered off the exact same `"ready"`
 * transition with nothing sequencing them, and `recordCompletionSpeed()`
 * (fires after every completed RAG answer or extraction) can land at the
 * same moment as any other writer during ordinary use.
 *
 * Serialized via a simple promise-chain mutex — every call now waits for
 * every earlier call to fully SETTLE (success or failure) before its own
 * read-modify-write begins, closing the race entirely. This is a plain
 * JS-catchable-in-principle race (the process never stops running while it
 * happens), not a durable/resumable design problem — a mutex is the whole
 * fix, unlike `onboardingCalibrationAttemptInFlight`'s own dead-man's-switch
 * design, which exists for the genuinely different problem of surviving a
 * whole-process kill.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

export function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const run = async (): Promise<Preferences> => {
    const current = await readPreferences();
    const next = { ...current, ...patch };
    cache = next;
    await FileSystem.writeAsStringAsync(preferencesPath(), JSON.stringify(next));
    return next;
  };
  const result = writeQueue.then(run, run);
  // Keep the queue alive regardless of THIS write's own outcome, so the next
  // caller waits for this one to SETTLE (not just to succeed) before its own
  // turn starts.
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}
