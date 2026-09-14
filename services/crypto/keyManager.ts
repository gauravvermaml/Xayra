import * as Crypto from "expo-crypto";
import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

const DB_ENCRYPTION_KEY_ID = "silent-confidant.db-encryption-key";
const KEY_BYTE_LENGTH = 32;

export class AuthenticationFailedError extends Error {
  constructor(message = "Biometric authentication failed.") {
    super(message);
    this.name = "AuthenticationFailedError";
  }
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
 * from the call below, which the catch here normalizes into
 * `AuthenticationFailedError` so callers get the same distinguishable
 * error type as before.
 */
async function readOrCreateKey(biometricAvailable: boolean): Promise<string> {
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

  try {
    const existingKey = await SecureStore.getItemAsync(DB_ENCRYPTION_KEY_ID, secureStoreOptions);
    if (existingKey) {
      return existingKey;
    }

    const randomBytes = await Crypto.getRandomBytesAsync(KEY_BYTE_LENGTH);
    const newKey = toHex(randomBytes);

    await SecureStore.setItemAsync(DB_ENCRYPTION_KEY_ID, newKey, secureStoreOptions);

    return newKey;
  } catch (err) {
    if (biometricAvailable) {
      throw new AuthenticationFailedError(err instanceof Error ? err.message : String(err));
    }
    throw err;
  }
}

let cachedEphemeralKey: string | null = null;

/**
 * Last-resort key used only when SecureStore itself is unusable (seen on
 * some emulator images with a broken Keystore). Not persisted, so notes
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
 * Returns the database encryption key, generating and storing it in the
 * hardware keystore/keychain on first call.
 *
 * When biometrics/a passcode are enrolled, every read/write is gated behind
 * a biometric prompt. On emulators and devices with nothing enrolled, the
 * key is still stored via SecureStore (still encrypted at rest by the OS
 * keystore) but without the authentication gate, so local development
 * never needs enrolled biometrics.
 */
export async function getOrCreateDatabaseKey(): Promise<string> {
  const biometricAvailable = await isBiometricAuthAvailable();

  try {
    return await readOrCreateKey(biometricAvailable);
  } catch (err) {
    if (biometricAvailable) {
      // Authentication was available but failed (cancelled, lockout, etc.)
      // — that should surface to the caller, not be papered over.
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
