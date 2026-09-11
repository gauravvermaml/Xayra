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
};

const DEFAULT_PREFERENCES: Preferences = {
  allowCellularDownloads: false,
  nativeDownloadIds: {},
  performanceSamples: [],
  tier3BStatus: "not_attempted",
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

export async function writePreferences(patch: Partial<Preferences>): Promise<Preferences> {
  const current = await readPreferences();
  const next = { ...current, ...patch };
  cache = next;
  await FileSystem.writeAsStringAsync(preferencesPath(), JSON.stringify(next));
  return next;
}
