import * as Crypto from "expo-crypto";
import { getRuntimePackageName } from "expo-app-signature";
import * as FileSystem from "expo-file-system/legacy";

/**
 * Disposable test vault — a Xayra Dev-only testing mode, fully isolated from
 * the normal vault:
 *  - Only a development package (Xayra Dev, or the emulator-only Xayra Test)
 *    can ever enter it. The check reads the
 *    INSTALLED package from Android at runtime (expo-app-signature), not the
 *    build config, so production can't enter it by deep link, a stray marker
 *    file or a misconfiguration.
 *  - Entering needs an explicit in-app confirmation (app/dev-vault.tsx) that
 *    writes a marker file; the mode is resolved once per app process, so a
 *    switch takes effect on the next start (db/client.ts caches the
 *    connection for the process).
 *  - Its own database file in its own folder, and its own key: random, held
 *    in memory only, never written to SecureStore. Notes don't survive a
 *    restart, and the normal vault and its key are never opened.
 *  - Its reminders use their own notification namespace
 *    (todoNotifications.ts); Drive and Calendar refuse to run in it.
 */
export type VaultMode = "normal" | "disposable";

export const DEV_PACKAGE = "com.anonymous.silentconfidant.dev";
/** Development packages: Xayra Dev, and the emulator-only "Xayra Test"
 * (privately signed, for Google Drive recovery testing — see app.config.js). */
export const DEV_PACKAGES: readonly string[] = [DEV_PACKAGE, "com.anonymous.silentconfidant.devtest"];
export const DISPOSABLE_MARKER_URI = `${FileSystem.documentDirectory}dev-disposable-vault.json`;
export const DISPOSABLE_VAULT_DIR_URI = `${FileSystem.documentDirectory}disposable-vault/`;
export const DISPOSABLE_DATABASE_NAME = "xayra-disposable.sqlite";
const MARKER_VERSION = 1;

/** The phrase the confirmation UI passes; anything else is refused. */
export const DISPOSABLE_CONFIRMATION = "use-disposable-test-vault";

export class DisposableModeError extends Error {
  constructor(feature: string) {
    super(`${feature} isn't available in a disposable test vault.`);
    this.name = "DisposableModeError";
  }
}

/** True only for a development package as Android reports it right now. A
 * failed read counts as "not Dev" — the safe direction. */
export function isRunningDevPackage(): boolean {
  try {
    return DEV_PACKAGES.includes(getRuntimePackageName());
  } catch {
    return false;
  }
}

let resolvedMode: VaultMode | null = null;
let resolving: Promise<VaultMode> | null = null;

async function readMarker(): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(DISPOSABLE_MARKER_URI);
    if (!info.exists) {
      return false;
    }
    const marker = JSON.parse(await FileSystem.readAsStringAsync(DISPOSABLE_MARKER_URI)) as {
      version?: unknown;
      package?: unknown;
    };
    // The marker must name the package reading it.
    return marker.version === MARKER_VERSION && marker.package === getRuntimePackageName();
  } catch {
    // Unreadable or malformed marker: stay on the normal vault.
    return false;
  }
}

/**
 * This process's vault mode, decided once. Production never reads the
 * marker; Xayra Dev is disposable only with a valid marker.
 */
export function resolveVaultMode(): Promise<VaultMode> {
  if (resolvedMode) {
    return Promise.resolve(resolvedMode);
  }
  if (!resolving) {
    resolving = (async (): Promise<VaultMode> => {
      const mode: VaultMode = isRunningDevPackage() && (await readMarker()) ? "disposable" : "normal";
      resolvedMode = mode;
      return mode;
    })();
  }
  return resolving;
}

/** The mode once resolved; `"normal"` before then. Disposable data only
 * exists after resolution, so callers acting on vault data see the real mode. */
export function getResolvedVaultMode(): VaultMode {
  return resolvedMode ?? "normal";
}

/** Whether the next start will open a disposable vault (Dev screen status). */
export async function isDisposableModeSetForNextStart(): Promise<boolean> {
  return isRunningDevPackage() && (await readMarker());
}

/** Called only by the confirmation UI. Writes the marker; takes effect on the
 * next app start. Refused outside Xayra Dev or without the confirmation. */
export async function enterDisposableModeOnNextStart(confirmation: string): Promise<void> {
  if (!isRunningDevPackage()) {
    throw new Error("Disposable test vaults are only available in Xayra Dev.");
  }
  if (confirmation !== DISPOSABLE_CONFIRMATION) {
    throw new Error("Disposable test vault needs explicit confirmation.");
  }
  await FileSystem.writeAsStringAsync(
    DISPOSABLE_MARKER_URI,
    JSON.stringify({ version: MARKER_VERSION, package: getRuntimePackageName(), confirmedAt: new Date().toISOString() })
  );
}

/** Removes the marker so the next start opens the normal vault. Touches
 * nothing else — normal data was never involved. */
export async function leaveDisposableModeOnNextStart(): Promise<void> {
  await FileSystem.deleteAsync(DISPOSABLE_MARKER_URI, { idempotent: true });
}

/** Throws if this process is a disposable vault — guards Drive and Calendar. */
export async function assertNetworkFeatureAllowed(feature: string): Promise<void> {
  if ((await resolveVaultMode()) === "disposable") {
    throw new DisposableModeError(feature);
  }
}

let disposableKey: string | null = null;

/** The disposable vault's key: random per process, in memory only. */
export async function getDisposableVaultKey(): Promise<string> {
  if (!disposableKey) {
    const bytes = await Crypto.getRandomBytesAsync(32);
    disposableKey = Array.from(bytes)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return disposableKey;
}

const DISPOSABLE_FILE_SUFFIXES = ["", "-journal", "-wal", "-shm"];

/**
 * Readies the disposable folder for a new session: the previous session's
 * files are unreadable (their key died with that process), so they're
 * removed. Only paths inside the disposable folder are ever touched.
 * Returns op-sqlite's bare directory path for `open({ location })`.
 */
export async function prepareDisposableVaultStorage(): Promise<string> {
  await FileSystem.makeDirectoryAsync(DISPOSABLE_VAULT_DIR_URI, { intermediates: true });
  for (const suffix of DISPOSABLE_FILE_SUFFIXES) {
    const uri = `${DISPOSABLE_VAULT_DIR_URI}${DISPOSABLE_DATABASE_NAME}${suffix}`;
    if (!uri.startsWith(DISPOSABLE_VAULT_DIR_URI)) {
      throw new Error("Refusing to touch a file outside the disposable vault folder.");
    }
    await FileSystem.deleteAsync(uri, { idempotent: true });
  }
  return DISPOSABLE_VAULT_DIR_URI.replace(/^file:\/\//, "").replace(/\/$/, "");
}
