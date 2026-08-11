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

async function promptBiometric(promptMessage: string): Promise<void> {
  const result = await LocalAuthentication.authenticateAsync({
    promptMessage,
    disableDeviceFallback: false,
    cancelLabel: "Cancel",
  });
  if (!result.success) {
    throw new AuthenticationFailedError();
  }
}

async function readOrCreateKey(biometricAvailable: boolean): Promise<string> {
  if (biometricAvailable) {
    await promptBiometric("Unlock Silent Confidant");
  }

  // Only gate the SecureStore item behind biometrics when they're actually
  // enrolled; otherwise `requireAuthentication` would throw on every call.
  const secureStoreOptions: SecureStore.SecureStoreOptions = biometricAvailable
    ? {
        requireAuthentication: true,
        authenticationPrompt: "Unlock Silent Confidant",
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }
    : {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      };

  const existingKey = await SecureStore.getItemAsync(DB_ENCRYPTION_KEY_ID, secureStoreOptions);
  if (existingKey) {
    return existingKey;
  }

  const randomBytes = await Crypto.getRandomBytesAsync(KEY_BYTE_LENGTH);
  const newKey = toHex(randomBytes);

  await SecureStore.setItemAsync(DB_ENCRYPTION_KEY_ID, newKey, secureStoreOptions);

  return newKey;
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
