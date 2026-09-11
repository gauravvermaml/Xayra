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
};

const DEFAULT_PREFERENCES: Preferences = {
  allowCellularDownloads: false,
  nativeDownloadIds: {},
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
