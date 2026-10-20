import * as FileSystem from "expo-file-system/legacy";

/**
 * Whether the on-device SpeechRecognizer (Tier 1) runs alongside each manual
 * recording. OFF by default: PCM + local Whisper is Xayra's primary offline
 * transcription (Gate B decision — on the emulator Android silenced the
 * recognizer on every recording, so it never produced a transcript and only
 * delayed Whisper). The emulator-only Xayra Test package can switch it back
 * on for experiments via `files/dev-tier1.json` (`{"concurrentTier1": true}`),
 * written by the dev-mic-harness route.
 */

const XAYRA_TEST_PACKAGE = "com.anonymous.silentconfidant.devtest";
const CONFIG_FILE = `${FileSystem.documentDirectory}dev-tier1.json`;

const DEFAULT_CONCURRENT_TIER1 = false;

let concurrentTier1 = DEFAULT_CONCURRENT_TIER1;

function isXayraTest(): boolean {
  try {
    // Required lazily: a local native module, absent under Jest.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getRuntimePackageName } = require("expo-app-signature") as { getRuntimePackageName: () => string };
    return getRuntimePackageName() === XAYRA_TEST_PACKAGE;
  } catch {
    return false;
  }
}

export function isConcurrentTier1Enabled(): boolean {
  return concurrentTier1;
}

/** Reads the Xayra Test override, if any. Everywhere else: the default. */
export async function loadTier1Config(): Promise<void> {
  if (!isXayraTest()) return;
  try {
    const info = await FileSystem.getInfoAsync(CONFIG_FILE);
    if (!info.exists) {
      concurrentTier1 = DEFAULT_CONCURRENT_TIER1;
      return;
    }
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(CONFIG_FILE)) as { concurrentTier1?: boolean };
    concurrentTier1 = typeof parsed.concurrentTier1 === "boolean" ? parsed.concurrentTier1 : DEFAULT_CONCURRENT_TIER1;
  } catch {
    concurrentTier1 = DEFAULT_CONCURRENT_TIER1;
  }
}

/** Xayra Test only: switches concurrent Tier 1 for experiments. */
export async function setConcurrentTier1ForXayraTest(enabled: boolean): Promise<boolean> {
  if (!isXayraTest()) return false;
  if (enabled === DEFAULT_CONCURRENT_TIER1) {
    await FileSystem.deleteAsync(CONFIG_FILE, { idempotent: true });
  } else {
    await FileSystem.writeAsStringAsync(CONFIG_FILE, JSON.stringify({ concurrentTier1: enabled }));
  }
  concurrentTier1 = enabled;
  return true;
}
