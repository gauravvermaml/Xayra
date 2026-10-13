/**
 * Compatibility layer: turns an error from a biometric-gated SecureStore read
 * into an authentication outcome. The ONLY place that interprets SecureStore
 * error contents — every other module branches on the typed errors in
 * keyManager.ts.
 *
 * What expo-secure-store 57.x (Android) actually gives JS, verified in its
 * source and on device:
 *  - `code` (structured, Expo-generated from the native exception class):
 *    `ERR_AUTHENTICATION` for every biometric outcome; other failures carry
 *    `ERR_DECRYPT`, `ERR_ENCRYPT`, `ERR_KEY_STORE`, `ERR_WRITE`, ... Reliable
 *    because release builds don't minify (no `android.enableMinifyInReleaseBuilds`).
 *  - NO structured BiometricPrompt error code. `AuthenticationPrompt.kt`
 *    flattens it into the message: "Could not Authenticate the user: <type>.
 *    <errString>", where <type> is one of a fixed set of English constants
 *    written by Expo (`convertErrorCode`) and <errString> is Android's
 *    localized, OEM-specific text. Guard failures (`AuthenticationHelper.kt`)
 *    are "Could not Authenticate the user: <guard text>".
 *
 * So the sub-reason has to come from the message, and only from <type>:
 * Expo-authored, not localized, identical across OEMs and Android versions.
 * <errString> is never read. The match is exact against the table below; an
 * unrecognised type — a new Android error, a future Expo rewording, a
 * missing message — returns `null`, which callers treat as an unexpected
 * key-retrieval failure (retry offered), never as a cancellation and never
 * as success. `__tests__/unlockErrors.test.ts` asserts these strings still
 * exist in the installed expo-secure-store source, so an upgrade that
 * changes them fails CI instead of silently reclassifying.
 *
 * A failed fingerprint isn't an outcome: BiometricPrompt shows "Not
 * recognised" and keeps the prompt open; repeated failures end in Lockout.
 */
export type UnlockFailureReason =
  /** The user dismissed the prompt (Cancel button, back, tap outside). */
  | "userCancelled"
  /** Android dismissed it — e.g. the app left the foreground mid-prompt. */
  | "systemCancelled"
  /** The prompt timed out with no interaction. */
  | "timeout"
  /** Too many failed attempts; biometrics paused for ~30s. */
  | "lockout"
  /** Biometrics blocked until the device is unlocked with PIN/pattern/password. */
  | "lockoutPermanent";

export const SECURE_STORE_AUTH_CODE = "ERR_AUTHENTICATION";
export const SECURE_STORE_AUTH_PREFIX = "Could not Authenticate the user: ";

/** Exact <type> strings from expo-secure-store's Kotlin source. */
export const SECURE_STORE_AUTH_TYPES: Readonly<Record<string, UnlockFailureReason>> = {
  // BiometricPrompt.ERROR_USER_CANCELED and ERROR_NEGATIVE_BUTTON
  "User canceled the authentication": "userCancelled",
  // BiometricPrompt.ERROR_CANCELED (5) has no entry in convertErrorCode, so
  // it arrives as its "unknown" fallback.
  "Unknown error (code: 5)": "systemCancelled",
  "Cannot display biometric prompt when the app is not in the foreground": "systemCancelled",
  // BiometricPrompt.ERROR_TIMEOUT
  Timeout: "timeout",
  // BiometricPrompt.ERROR_LOCKOUT / ERROR_LOCKOUT_PERMANENT
  Lockout: "lockout",
  "Lockout permanent": "lockoutPermanent",
};

function messageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string") {
    return (err as { message: string }).message;
  }
  return typeof err === "string" ? err : "";
}

function codeOf(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

/** `null` = not a recognised authentication outcome. */
export function classifyUnlockFailure(err: unknown): UnlockFailureReason | null {
  const code = codeOf(err);
  // A structured non-auth code (ERR_DECRYPT, ERR_KEY_STORE, ...) settles it.
  if (code !== undefined && code !== SECURE_STORE_AUTH_CODE) {
    return null;
  }
  const message = messageOf(err);
  const start = message.indexOf(SECURE_STORE_AUTH_PREFIX);
  if (start < 0) {
    return null;
  }
  // <type> runs to the first ". " (before <errString>); a guard message has
  // no errString, at most a trailing period.
  const rest = message.slice(start + SECURE_STORE_AUTH_PREFIX.length);
  const separator = rest.indexOf(". ");
  const type = (separator >= 0 ? rest.slice(0, separator) : rest).trim().replace(/\.$/, "");
  return Object.prototype.hasOwnProperty.call(SECURE_STORE_AUTH_TYPES, type) ? SECURE_STORE_AUTH_TYPES[type] : null;
}
