import * as FileSystem from "expo-file-system/legacy";

/**
 * Whether the on-device SpeechRecognizer (Tier 1) runs alongside each manual
 * recording. On (the existing behaviour) everywhere, except that the
 * emulator-only Xayra Test package can switch it off for experiments via
 * `files/dev-tier1.json` (`{"concurrentTier1": false}`), written by the
 * dev-mic-harness route. Gate B: comparing Tier 1 on and off.
 */

const XAYRA_TEST_PACKAGE = "com.anonymous.silentconfidant.devtest";
const CONFIG_FILE = `${FileSystem.documentDirectory}dev-tier1.json`;

let concurrentTier1 = true;

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

/** Reads the Xayra Test override, if any. Everywhere else: on. */
export async function loadTier1Config(): Promise<void> {
  if (!isXayraTest()) return;
  try {
    const info = await FileSystem.getInfoAsync(CONFIG_FILE);
    if (!info.exists) {
      concurrentTier1 = true;
      return;
    }
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(CONFIG_FILE)) as { concurrentTier1?: boolean };
    concurrentTier1 = parsed.concurrentTier1 !== false;
  } catch {
    concurrentTier1 = true;
  }
}

/** Xayra Test only: switches concurrent Tier 1 for experiments. */
export async function setConcurrentTier1ForXayraTest(enabled: boolean): Promise<boolean> {
  if (!isXayraTest()) return false;
  if (enabled) {
    await FileSystem.deleteAsync(CONFIG_FILE, { idempotent: true });
  } else {
    await FileSystem.writeAsStringAsync(CONFIG_FILE, JSON.stringify({ concurrentTier1: false }));
  }
  concurrentTier1 = enabled;
  return true;
}
