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

  let newKey: string;
  try {
    newKey = toHex(await Crypto.getRandomBytesAsync(KEY_BYTE_LENGTH));
  } catch (err) {
    throw new DatabaseKeyError("unavailable", err);
  }
  // The key is returned — and so a vault created — only once it is stored.
  try {
    await SecureStore.setItemAsync(DB_ENCRYPTION_KEY_ID, newKey, secureStoreOptions);
  } catch (err) {
    throw toAccessError(err);
  }
  return newKey;
}

/**
 * Returns the database encryption key. A new key is generated and stored
 * only when `allowCreate` is set — which db/client.ts does only when no
 * encrypted database file exists yet. Every other caller (and every retry)
 * can only read. Never deletes or replaces a stored key.
 *
 * Throws `AuthenticationFailedError` (cancel/timeout/lockout — retry with a
 * fresh prompt) or `DatabaseKeyError` (key unreadable, missing, or couldn't
 * be created and stored).
 *
 * There is no in-memory fallback: a vault is only ever created with a key
 * that was successfully persisted, so notes can't silently vanish on the next
 * restart. (Disposable test vaults have their own, separate key lifecycle —
 * services/dev/disposableVault.ts — and never come through here.)
 *
 * When biometrics/a passcode are enrolled, every read/write is gated behind
 * a biometric prompt. On emulators and devices with nothing enrolled, the
 * key is still stored via SecureStore (still encrypted at rest by the OS
 * keystore) but without the authentication gate, so local development
 * never needs enrolled biometrics.
 */
export async function getOrCreateDatabaseKey({ allowCreate = false }: { allowCreate?: boolean } = {}): Promise<string> {
  const biometricAvailable = await isBiometricAuthAvailable();
  return readOrCreateKey(biometricAvailable, allowCreate);
}

/** Destroys the stored encryption key. Irreversible: without it the
 * encrypted database can never be decrypted again. */
export async function destroyDatabaseKey(): Promise<void> {
  await SecureStore.deleteItemAsync(DB_ENCRYPTION_KEY_ID);
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
}

/** The format every key this app creates has (see `toHex`): 32 bytes as
 * lowercase hex. A recovered key must match it before anything else. */
export function isWellFormedDatabaseKey(key: string): boolean {
  return /^[0-9a-f]{64}$/.test(key);
}

/** A recovered key wasn't installed: it was malformed, or a readable key is
 * already stored (which recovery must never overwrite). Nothing changed. */
export class RecoveredKeyRefusedError extends Error {
  readonly reason: "malformed" | "keyAlreadyStored";

  constructor(reason: "malformed" | "keyAlreadyStored") {
    super(reason === "malformed" ? "The recovered key isn't a valid Xayra key." : "A key is already stored on this phone.");
    this.name = "RecoveredKeyRefusedError";
    this.reason = reason;
  }
}

/**
 * Original-vault recovery (services/recovery/originalVaultRecovery.ts):
 * stores a key that has ALREADY been proven to open a copy of this phone's
 * vault, using the same biometric-gated SecureStore entry as normal.
 *
 * - Refuses a malformed key.
 * - Refuses if SecureStore can still return a key — recovery only ever fills
 *   a missing or permanently invalidated entry, never replaces a working one.
 *   (In those states the read returns nothing without prompting.)
 * - The write itself shows the fingerprint prompt. Cancel/lockout surfaces as
 *   `AuthenticationFailedError`, other failures as `DatabaseKeyError`; there is
 *   no retry here, and nothing is deleted or generated on any path.
 */
export async function installRecoveredDatabaseKey(key: string): Promise<void> {
  if (!isWellFormedDatabaseKey(key)) {
    throw new RecoveredKeyRefusedError("malformed");
  }
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

  let existing: string | null;
  try {
    existing = await SecureStore.getItemAsync(DB_ENCRYPTION_KEY_ID, secureStoreOptions);
  } catch (err) {
    throw toAccessError(err);
  }
  if (existing) {
    throw new RecoveredKeyRefusedError("keyAlreadyStored");
  }

  try {
    await SecureStore.setItemAsync(DB_ENCRYPTION_KEY_ID, key, secureStoreOptions);
  } catch (err) {
    throw toAccessError(err);
  }
}

async function protectedOptions(): Promise<SecureStore.SecureStoreOptions> {
  return (await isBiometricAuthAvailable())
    ? { requireAuthentication: true, authenticationPrompt: "Unlock Xayra", keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
    : { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY };
}

/**
 * Other fingerprint-protected secrets (the Extra Privacy backup key — see
 * services/backup/protection.ts): same SecureStore protection as the vault
 * key, same error classification (`AuthenticationFailedError` /
 * `DatabaseKeyError("unavailable")`). `null` means not stored or permanently
 * invalidated.
 */
export async function readProtectedSecret(id: string): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(id, await protectedOptions());
  } catch (err) {
    throw toAccessError(err);
  }
}

export async function writeProtectedSecret(id: string, value: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(id, value, await protectedOptions());
  } catch (err) {
    throw toAccessError(err);
  }
}
