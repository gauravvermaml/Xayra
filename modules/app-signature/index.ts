import { requireNativeModule } from "expo-modules-core";

/**
 * Diagnostics-only native module: reads the *currently running* APK's
 * signing certificate SHA-1 fingerprint and package name straight from
 * `PackageManager` at runtime, so a Google Sign-In `DEVELOPER_ERROR` can be
 * root-caused ("this exact installed build's SHA-1 vs. what's registered in
 * Google Cloud Console") instead of guessed at from a keystore file on disk
 * that may not be the one that actually signed the running APK.
 *
 * Android-only — iOS has no APK signing certificate, so both functions are
 * unavailable there (see `services/sync/driveSync.ts`, which only calls
 * these behind a Platform.OS === "android" check).
 */
const AppSignatureModule = requireNativeModule<{
  getSigningSha1Fingerprint(): string | null;
  getPackageName(): string;
}>("AppSignature");

/** Colon-separated uppercase hex SHA-1 (e.g. "AB:CD:...") of the running
 * APK's signing certificate, or `null` if it couldn't be read (should not
 * happen on a real device/emulator, but native `PackageManager` calls are
 * defensively wrapped native-side). */
export function getSigningSha1Fingerprint(): string | null {
  return AppSignatureModule.getSigningSha1Fingerprint();
}

/** The running app's actual package name, read from `Context`, not the
 * hardcoded value in app.json — catches the (rare but real) case where a
 * build was installed under a different applicationId than expected. */
export function getRuntimePackageName(): string {
  return AppSignatureModule.getPackageName();
}
