import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

import { classifyUnlockFailure, type UnlockFailureReason } from "./unlockErrors";

const DB_ENCRYPTION_KEY_ID = "silent-confidant.db-encryption-key";
const KEY_BYTE_LENGTH = 32;

/** The key stayed locked because biometric authentication didn't complete
 * (see unlockErrors.ts). Nothing was created, changed or deleted. */
export class AuthenticationFailedError extends Error {
  readonly reason: UnlockFailureReason;

  constructor(reason: UnlockFailureReason, message = "Biometric authentication failed.") {
    super(message);
    this.name = "AuthenticationFailedError";
    this.reason = reason;
  }
}

/**
 * The key couldn't be read, for a reason other than authentication. Nothing
 * was created, changed or deleted.
 *  - `"unavailable"`: SecureStore/Keystore failed (or reported an
 *    authentication result unlockErrors.ts doesn't recognise). Retryable.
 *  - `"missing"`: SecureStore returned no key, but a vault already exists —
 *    the key was lost (e.g. Android permanently invalidated it after a new
 *    fingerprint was enrolled). A new key would never open that vault, so
 *    one is deliberately NOT minted.
 */
export class DatabaseKeyError extends Error {
  readonly kind: "unavailable" | "missing";
  readonly cause: unknown;

  constructor(kind: "unavailable" | "missing", cause?: unknown) {
    super(kind === "missing" ? "The database key is missing." : "The database key could not be read.");
    this.name = "DatabaseKeyError";
    this.kind = kind;
    this.cause = cause;
  }
}

function toAccessError(err: unknown): Error {
  const reason = classifyUnlockFailure(err);
  if (reason) {
    return new AuthenticationFailedError(reason, err instanceof Error ? err.message : undefined);
  }
  return new DatabaseKeyError("unavailable", err);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Emulators and devices with nothing enrolled can't satisfy a
 * `requireAuthentication`-gated SecureStore read/write — it throws instead
 * of prompting. Callers check this first to decide whether to gate at all.
 *
 * Build 38 briefly skipped this gate in `__DEV__` too, to unblock testing
 * across repeated fresh-install cycles on the Redmi/Pixel 9 — reverted in
 * Build 39 at the user's explicit request now that testing is wrapping up:
 * biometric protection should behave identically in every build, dev or
 * production, going forward. (Build 40's live debugging session used a
 * second, deliberately uncommitted local re-bypass here to get through
 * adb-driven relaunches that can't complete a real fingerprint scan — that
 * bypass has been reverted now that the session's finished; this function
 * must never special-case `__DEV__`.)
 */
async function isBiometricAuthAvailable(): Promise<boolean> {
  try {
    const [hasHardware, isEnrolled] = await Promise.all([
      LocalAuthentication.hasHardwareAsync(),
      LocalAuthentication.isEnrolledAsync(),
    ]);
    return hasHardware && isEnrolled;
  } catch {
    return false;
  }
}

/**
 * Build 38 fix: this used to ALSO call an explicit
 * `LocalAuthentication.authenticateAsync()` prompt before ever touching
 * SecureStore — but `requireAuthentication: true` below already gates the
 * SecureStore read/write itself behind its own native biometric prompt at
 * the OS/Keystore level. The two were fully redundant: a user had to
 * unlock TWICE for one database-key access, with the first prompt never
 * protecting anything the second didn't already cover on its own.
 * Confirmed as real friction during testing on both the Redmi and Pixel 9.
 * Removing the separate prompt cuts this to the one SecureStore already
 * requires — the exact same security guarantee (the key is still
 * completely inaccessible without a successful biometric check), just
 * without asking twice. A cancelled/failed SecureStore auth still throws
 * from the call below; the catch here turns a recognised authentication
 * outcome (cancel, lockout — unlockErrors.ts) into `AuthenticationFailedError`
 * with its reason, and rethrows anything else unchanged.
 */
async function readOrCreateKey(biometricAvailable: boolean, allowCreate: boolean): Promise<string> {
  // Only gate the SecureStore item behind biometrics when they're actually
  // enrolled; otherwise `requireAuthentication` would throw on every call.
  const secureStoreOptions: SecureStore.SecureStoreOptions = biometricAvailable
    ? {
        requireAuthentication: true,
        authenticationPrompt: "Unlock Xayra",
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }
    : {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      };

  // Classified whatever `biometricAvailable` said: the stored item carries
  // its own requireAuthentication flag, so SecureStore can still prompt.
  let existingKey: string | null;
  try {
    existingKey = await SecureStore.getItemAsync(DB_ENCRYPTION_KEY_ID, secureStoreOptions);
  } catch (err) {
    throw toAccessError(err);
  }
  if (existingKey) {
    return existingKey;
  }

  // SecureStore also returns null when an existing key is unusable
  // (permanently invalidated, out of sync with the Keystore). Minting a
  // replacement then would overwrite the stored item and still never open
  // the existing vault, so a key is only ever created when there is no vault.
  if (!allowCreate) {
    throw new DatabaseKeyError("missing");
  }

  const randomBytes = await Crypto.getRandomBytesAsync(KEY_BYTE_LENGTH);
  const newKey = toHex(randomBytes);
  try {
    await SecureStore.setItemAsync(DB_ENCRYPTION_KEY_ID, newKey, secureStoreOptions);
  } catch (err) {
    throw toAccessError(err);
  }
  return newKey;
}

let cachedEphemeralKey: string | null = null;

/**
 * Last-resort key used only on a first run (no vault yet) without enrolled
 * biometrics, when SecureStore itself is unusable (seen on some emulator
 * images with a broken Keystore). Not persisted, so notes
 * won't survive an app restart in that case — but the app keeps working
 * instead of every note insertion failing.
 */
function ephemeralFallbackKey(): string {
  if (!cachedEphemeralKey) {
    cachedEphemeralKey = toHex(Crypto.getRandomBytes(KEY_BYTE_LENGTH));
  }
  return cachedEphemeralKey;
}

/**
 * Returns the database encryption key. A new key is generated and stored
 * only when `allowCreate` is set — which db/client.ts does only when no
 * encrypted database file exists yet. Every other caller (and every retry)
 * can only read. Never deletes or replaces a stored key.
 *
 * Throws `AuthenticationFailedError` (cancel/timeout/lockout — retry with a
 * fresh prompt) or `DatabaseKeyError` (key unreadable or missing).
 *
 * When biometrics/a passcode are enrolled, every read/write is gated behind
 * a biometric prompt. On emulators and devices with nothing enrolled, the
 * key is still stored via SecureStore (still encrypted at rest by the OS
 * keystore) but without the authentication gate, so local development
 * never needs enrolled biometrics.
 */
export async function getOrCreateDatabaseKey({ allowCreate = false }: { allowCreate?: boolean } = {}): Promise<string> {
  const biometricAvailable = await isBiometricAuthAvailable();

  try {
    return await readOrCreateKey(biometricAvailable, allowCreate);
  } catch (err) {
    if (biometricAvailable || !allowCreate || err instanceof AuthenticationFailedError) {
      // Authentication failed, or a vault already exists: surface it. An
      // ephemeral key could never open an existing vault.
      throw err;
    }
    console.warn(
      "[keyManager] SecureStore unavailable, falling back to an ephemeral in-memory database key:",
      err
    );
    return ephemeralFallbackKey();
  }
}

/** Destroys the stored encryption key. Irreversible: without it the
 * encrypted database can never be decrypted again. */
export async function destroyDatabaseKey(): Promise<void> {
  await SecureStore.deleteItemAsync(DB_ENCRYPTION_KEY_ID);
  cachedEphemeralKey = null;
}

/**
 * Overwrites the stored database encryption key — used by
 * services/sync/driveSync.ts when restoring a backup, since the restored
 * `.db` file was encrypted with whatever key was current on the device that
 * created the backup, not this device's own (normally randomly-generated,
 * never-leaves-the-device) key. Without this, a restored backup would be
 * undecryptable: SQLCipher has no way to open a file with the wrong key.
 */
export async function setDatabaseKey(key: string): Promise<void> {
  const biometricAvailable = await isBiometricAuthAvailable();
  const secureStoreOptions: SecureStore.SecureStoreOptions = biometricAvailable
    ? {
        requireAuthentication: true,
        authenticationPrompt: "Unlock Xayra",
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }
    : {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      };
  await SecureStore.setItemAsync(DB_ENCRYPTION_KEY_ID, key, secureStoreOptions);
  cachedEphemeralKey = null;
}
