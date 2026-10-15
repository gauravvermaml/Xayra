import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  GoogleSignin,
  isSuccessResponse,
  statusCodes,
  type User,
} from "@react-native-google-signin/google-signin";
import { getRuntimePackageName, getSigningSha1Fingerprint } from "expo-app-signature";
import { Platform } from "react-native";

import { assertNetworkFeatureAllowed } from "../dev/disposableVault";
import { DriveSyncError, NotSignedInError } from "./driveErrors";
import { NETWORK_MESSAGE } from "../errors/userMessage";
import { rebindBackupAccount } from "../backup/backupAccount";
import {
  activateExtraPrivacy,
  collectRecoveryKeyCandidates,
  getAccountProtection,
  hasGoogleOnlyBackups,
  joinWithRecoveryCode,
  replaceRecoveryCode,
  restoreExtraKeyFromEscrow,
  restoreLatestBackup,
  retireStandardBackups,
  runEncryptedBackup,
  switchToStandard,
  type RetireResult,
} from "../backup/backupService";
import { readLocalProtection, type ProtectionState } from "../backup/protection";
import { setAccessTokenRefresher } from "../backup/driveAppData";

// Long backup and protection operations can outlive an access token; the
// encrypted backup asks for a fresh one on a 401 (driveAppData.ts).
setAccessTokenRefresher(async (stale) => {
  await GoogleSignin.clearCachedAccessToken(stale).catch(() => undefined);
  return (await GoogleSignin.getTokens()).accessToken;
});

/**
 * `drive.appdata` is deliberately the only Drive scope ever requested. Files
 * created under it live in a hidden per-app folder that isn't visible in the
 * user's normal Drive UI and isn't readable by any other app or Drive client
 * — it's the narrowest scope Google offers for "let this app keep its own
 * private data in my Drive," which is exactly this feature and nothing more
 * (no access to the user's other Drive files, ever).
 */
const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

/**
 * `calendar.events` (not the broader `calendar` scope) — narrowest scope
 * that permits creating/updating/deleting events, matching this same file's
 * "narrowest scope that does the job" philosophy above. Declared here (this
 * file is the one and only place `GoogleSignin.configure()` is called, and
 * already the de facto shared Google Sign-In owner — see `getGreetingFirstName`
 * for an existing example of another feature piggybacking on this same
 * signed-in session) even though it's consumed by services/sync/calendarSync.ts,
 * not this file's own Drive logic. It is NOT listed in `configure()`'s scopes
 * (those are requested at sign-in): calendarSync.ts requests it with
 * `GoogleSignin.addScopes`, only the first time a user taps "Send to
 * Calendar".
 */
export const CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events";



const LAST_BACKUP_STORAGE_KEY = "remi.driveSync.lastBackup";
const AUTO_SYNC_WIFI_STORAGE_KEY = "remi.driveSync.autoSyncOnWifi";

// Defined in driveErrors.ts to break a load-order crash (see that file).
export { DriveSyncError, NoBackupFoundError, NotSignedInError } from "./driveErrors";
export { BackupAccountMismatchError } from "../backup/backupAccount";
export {
  ExtraPrivacyKeyNeededError,
  ProtectionChangeUnfinishedError,
  RecoveryCodeIncorrectError,
  RecoveryCodeRequiredError,
} from "../backup/backupErrors";
export type { RetireResult } from "../backup/backupService";

/**
 * Live data-loss incident, fixed 2026-09-16, superseded by a proper delta
 * backup design (see `backupToDrive()`'s own doc comment) rather than left
 * as a warn-before-overwrite guard: a user uninstalled the dev build on
 * their Pixel 9, installed the Play Store tester build (a fresh app
 * identity — its local encrypted database starts genuinely empty), then
 * backed up. `backupToDrive()` used to unconditionally `VACUUM INTO`
 * whatever was in the LOCAL database and overwrite the remote file with it
 * wholesale, no matter how empty the local database was or how much real
 * data the remote backup already held — so backing up with 0 local notes
 * permanently replaced a real, populated backup with an empty one. An
 * earlier version of this fix added a confirm-before-overwrite dialog; per
 * explicit user direction, that was replaced with the fix below instead,
 * which makes the destructive case structurally impossible rather than
 * just confirmed: backup is now additive-only, so 0 local notes can never
 * remove anything already in Drive, regardless of whether anyone confirms
 * it or not.
 */

let configured = false;

/**
 * The OAuth 2.0 "Web application" client ID from the same Google Cloud
 * Console project as the Android client below — required by
 * `GoogleSignin.configure()` for `addScopes`/token exchange to work
 * reliably on Android (without it, `getTokens()` can return an identity
 * token that the Drive API rejects as insufficiently scoped). This is a
 * public identifier (safe to ship in the client, unlike a client *secret*),
 * but it's still project-specific and must be swapped for a real value
 * before Drive backup will work — same placeholder pattern as
 * `iosUrlScheme` in app.json.
 */
const WEB_CLIENT_ID = "275985105011-2rr1beo5b1j34fc8vh181rtvuhjs8mb6.apps.googleusercontent.com";

/**
 * NOTE on `app.json`: this requires a real OAuth 2.0 "Android" client ID
 * registered in Google Cloud Console (Drive API enabled, client tied to
 * this app's package name + release/debug signing SHA-1) before sign-in
 * will work at all — that's an external, account-specific setup step no
 * amount of code here can perform. Until it's done, `signIn()` below fails
 * with a native `DEVELOPER_ERROR`/`SIGN_IN_REQUIRED`-style error, not a bug
 * in this file.
 */
/** Exported so services/sync/calendarSync.ts can ensure the shared
 * GoogleSignin SDK state is initialized before its own `addScopes`/
 * `getTokens` calls — this file remains the one and only place
 * `GoogleSignin.configure()` itself is ever called, avoiding two files each
 * configuring the SDK independently (which risks one silently clobbering
 * the other's scopes list). */
export function ensureConfigured(): void {
  if (configured) {
    return;
  }
  if (WEB_CLIENT_ID.startsWith("REPLACE_WITH_")) {
    console.warn(
      "[DriveSync] GoogleSignin webClientId is still the placeholder value — replace WEB_CLIENT_ID " +
        "in services/sync/driveSync.ts with this project's real Web OAuth client ID from Google Cloud " +
        "Console before shipping Drive backup."
    );
  }
  GoogleSignin.configure({
    // No API scopes at sign-in (identity only). Scopes listed here ARE
    // requested by `signIn()`: listing Calendar put a Calendar checkbox on the
    // Drive consent screen, and unticking it looped sign-in. Each feature
    // instead asks for its own scope once, with `requestScope` — Drive when
    // backup is connected, Calendar on the first "Send to Calendar" — and a
    // scope left unticked is reported, never asked for again in a loop.
    scopes: [],
    webClientId: WEB_CLIENT_ID,
    // Requests a server auth code alongside the normal sign-in so a refresh
    // token is available — without this, some Play Services versions only
    // hand back a short-lived access token, and `getTokens()` silently
    // starts failing once it expires with no way to renew it without
    // re-prompting the account picker.
    offlineAccess: true,
  });
  configured = true;
}

/** Number of leading characters of `webClientId` surfaced in diagnostic
 * logs — enough to eyeball "is this even the right project's client ID"
 * without printing the whole (still-public, but no reason to be careless)
 * identifier. */
const WEB_CLIENT_ID_LOG_PREFIX_LENGTH = 15;

/**
 * Reads the *running* APK's actual package name and signing-certificate
 * SHA-1 straight from `PackageManager` (via the local `expo-app-signature`
 * native module — see modules/app-signature/), rather than trusting
 * app.json's `android.package` or a keystore file on disk that may not be
 * the one that actually signed this particular install. This is exactly
 * what has to match the Android OAuth client registered in Google Cloud
 * Console for sign-in to work at all, so a `DEVELOPER_ERROR` can be
 * root-caused by eyeballing this against that console entry instead of
 * guessing which keystore/build produced the installed APK.
 *
 * Android-only (there's no APK signing certificate on iOS) — returns a
 * clear "n/a" pair there rather than throwing, so diagnostics still render.
 */
function readRuntimeSigningInfo(): { packageName: string; sha1: string } {
  if (Platform.OS !== "android") {
    return { packageName: "n/a (iOS)", sha1: "n/a (iOS)" };
  }
  try {
    return {
      packageName: getRuntimePackageName() || "unknown",
      sha1: getSigningSha1Fingerprint() ?? "unavailable",
    };
  } catch (err) {
    // The native module itself failing to read should never block surfacing
    // the rest of the sign-in diagnostics.
    console.error("[DriveSync] Failed to read runtime signing info —", err);
    return { packageName: "error reading package name", sha1: "error reading SHA-1" };
  }
}

/**
 * Captures everything available about a failed native Google Sign-In call —
 * `error.code`/`error.message`/`error.toString()`, the running APK's actual
 * package name and signing SHA-1, plus a prefix of the configured
 * `webClientId` — so a `DEVELOPER_ERROR` (or any other opaque native
 * failure) can actually be diagnosed from what's on screen/in logs instead
 * of guessing.
 */
function formatSignInDiagnostics(err: unknown): string {
  const code = (err as { code?: string | number } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  const toStringValue = err instanceof Error ? err.toString() : String(err);
  const webClientIdPrefix = WEB_CLIENT_ID.slice(0, WEB_CLIENT_ID_LOG_PREFIX_LENGTH);
  const { packageName, sha1 } = readRuntimeSigningInfo();
  return (
    `Package Name: ${packageName}\n` +
    `Runtime SHA-1: ${sha1}\n` +
    `Web Client ID: ${webClientIdPrefix}…\n` +
    `Native Error: code=${code ?? "unknown"} | message=${message} | toString=${toStringValue}`
  );
}

/**
 * `DEVELOPER_ERROR` (native Android status code 10) is this library's most
 * common — and most opaque — failure: it almost always means the SHA-1
 * fingerprint of the build's signing certificate doesn't match what's
 * registered against the Android OAuth client in Google Cloud Console (a
 * debug-keystore SHA-1 registered but a release-signed APK installed, or
 * vice versa, is the usual cause). Neither this library's `statusCodes` nor
 * its error objects consistently expose a typed constant for it across
 * versions, so detection here matches on the raw native code/message rather
 * than a single well-typed check.
 */
function isDeveloperError(err: unknown): boolean {
  if (!(err instanceof Error)) {
    return false;
  }
  const code = (err as { code?: string | number }).code;
  return (
    String(code) === "10" ||
    String(code).toUpperCase() === "DEVELOPER_ERROR" ||
    /developer_error/i.test(err.message)
  );
}

/**
 * Wraps a Google Sign-In call so a failure is diagnosable from the log — the
 * raw native code/message/toString(), package name, runtime SHA-1 and the
 * configured `webClientId` prefix — while the user sees only a plain message
 * (`signInFailureMessage`). An expected, already-clear `DriveSyncError`
 * (e.g. "sign-in was cancelled") passes through untouched.
 *
 * Exported so services/sync/calendarSync.ts's own scope-request call gets
 * the same `DEVELOPER_ERROR` handling instead of a bare native error —
 * it's the identical failure mode (a SHA-1/OAuth-client mismatch), just
 * possibly hit for the first time by a user who already had Drive working.
 */
export async function withDeveloperErrorHandling<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof DriveSyncError) {
      throw err;
    }

    // The diagnostics (package name, runtime SHA-1, client-id prefix, native
    // code) go to the log only, never to the screen. A DEVELOPER_ERROR there
    // means this build's SHA-1 isn't registered on the Android OAuth client.
    const diagnostics = formatSignInDiagnostics(err);
    console.error("[DriveSync] Google Sign-In failed —", diagnostics);
    throw new DriveSyncError(signInFailureMessage(err));
  }
}

/** What the user sees when Google sign-in fails. */
function signInFailureMessage(err: unknown): string {
  const code = String((err as { code?: string | number } | null)?.code ?? "");
  if (code === statusCodes.SIGN_IN_CANCELLED || code === "12501") return "Google sign-in was cancelled.";
  if (code === statusCodes.IN_PROGRESS) return "Google sign-in is already open. Finish it, then try again.";
  if (code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
    return "Google sign-in needs Google Play services. Update Google Play services, then try again.";
  }
  if (code === "7" || /network/i.test(err instanceof Error ? err.message : "")) {
    return NETWORK_MESSAGE;
  }
  if (isDeveloperError(err)) {
    return "Google sign-in isn't working in this version of Xayra. Please update Xayra from Google Play, then try again.";
  }
  return "Google sign-in didn't finish. Check your internet connection and try again.";
}

/**
 * Asks for `scope` (Google's incremental consent) and confirms it was granted:
 * Google's consent screen lets the user untick each permission, and a
 * sign-in that "succeeds" without it would only fail later with a 403.
 */
export async function requestScope(scope: string): Promise<boolean> {
  let response: Awaited<ReturnType<typeof GoogleSignin.addScopes>>;
  try {
    response = await GoogleSignin.addScopes({ scopes: [scope] });
  } catch (err) {
    // Declining on the consent screen rejects with code "addScopes" ("Failed
    // to add scopes.") on Android, rather than returning "cancelled".
    if (String((err as { code?: unknown } | null)?.code) === "addScopes") return false;
    throw err;
  }
  if (response?.type === "success") return response.data.scopes.includes(scope);
  return GoogleSignin.getCurrentUser()?.scopes.includes(scope) ?? false;
}

/** Drive backup can't work without its folder permission: when it was left
 * unticked, this phone stays disconnected and says why. */
async function requireDriveScope(): Promise<void> {
  if (await requestScope(DRIVE_APPDATA_SCOPE)) return;
  await GoogleSignin.signOut().catch(() => undefined);
  throw new DriveSyncError(
    "Xayra needs permission to use its own hidden folder in your Google Drive. Connect again and allow Google Drive access to back up."
  );
}

export type DriveUser = {
  email: string;
  displayName: string | null;
};

function toDriveUser(user: User): DriveUser {
  return { email: user.user.email, displayName: user.user.name };
}

/**
 * Opens the native Google account picker (identity only), then asks for the
 * `drive.appdata` scope and confirms it was granted (`requireDriveScope`).
 * Without that scope `getTokens()` returns a token the Drive API rejects, so
 * a declined scope leaves this phone disconnected with a plain message.
 */
export async function signInWithGoogle(): Promise<DriveUser> {
  // The Google session is shared with the normal vault; a disposable test
  // vault must not change it.
  await assertNetworkFeatureAllowed("Google sign-in");
  ensureConfigured();
  return withDeveloperErrorHandling(async () => {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw new DriveSyncError("Google sign-in was cancelled.");
    }
    await requireDriveScope();
    return toDriveUser(response.data);
  });
}

/**
 * Original-vault recovery (services/recovery/originalVaultRecovery.ts) runs
 * before the vault opens, so it needs its own sign-in: a silent sign-in with
 * the account Google already remembers, then — only when `interactive` — the
 * account picker. `null` means no remembered account and no picker requested.
 * Uses the same Drive appData scope as backup; touches no Drive files.
 */
export async function signInForRecovery({ interactive }: { interactive: boolean }): Promise<DriveUser | null> {
  await assertNetworkFeatureAllowed("Google sign-in");
  ensureConfigured();
  return withDeveloperErrorHandling(async () => {
    await GoogleSignin.hasPlayServices();
    const silent = await GoogleSignin.signInSilently();
    if (silent.type === "success") {
      await requireDriveScope();
      return toDriveUser(silent.data);
    }
    if (!interactive) {
      return null;
    }
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw new DriveSyncError("Google sign-in was cancelled.");
    }
    await requireDriveScope();
    return toDriveUser(response.data);
  });
}

/** "Use a different account" during recovery: forgets the remembered account
 * on this phone (no Drive changes, no access revoked) and opens the picker. */
export async function switchRecoveryAccount(): Promise<DriveUser> {
  await assertNetworkFeatureAllowed("Google sign-in");
  ensureConfigured();
  return withDeveloperErrorHandling(async () => {
    await GoogleSignin.signOut();
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw new DriveSyncError("Google sign-in was cancelled.");
    }
    await requireDriveScope();
    return toDriveUser(response.data);
  });
}

/**
 * Vault keys that might reopen this phone's own vault after its fingerprint-
 * protected key was lost — this phone's encrypted device entry first, then
 * the account's other entries, then the legacy plaintext key file. Downloaded
 * into memory only; each is just a candidate that originalVaultRecovery.ts
 * proves on a copy. Never writes to Drive.
 */
export async function fetchRecoveryKeyCandidates(options: { recoveryCode?: string } = {}): Promise<string[]> {
  await assertNetworkFeatureAllowed("Google Drive restore");
  // With a recovery code, the local escrow works even when signed out.
  const token = GoogleSignin.getCurrentUser() ? await requireAccessToken() : options.recoveryCode ? null : await requireAccessToken();
  return collectRecoveryKeyCandidates(token, options);
}

/** After recovery with the code: puts the Extra Privacy key back behind the
 * fingerprint from this phone's escrow. */
export async function restoreExtraPrivacyKeyAfterRecovery(code: string): Promise<boolean> {
  return restoreExtraKeyFromEscrow(code);
}

/** Revokes Drive access and clears the local session — deliberately does
 * NOT touch any local notes/database, only the sync connection itself. */
export async function signOutFromGoogle(): Promise<void> {
  await assertNetworkFeatureAllowed("Google sign-out");
  ensureConfigured();
  try {
    await GoogleSignin.revokeAccess();
  } catch {
    // Already revoked, or never actually had access — signOut() below still
    // needs to run to clear the local session either way.
  }
  await GoogleSignin.signOut();
  await AsyncStorage.removeItem(LAST_BACKUP_STORAGE_KEY);
}

type BackupRecord = { time: string; sizeBytes: number };

async function readLastBackupRecord(): Promise<BackupRecord | null> {
  const raw = await AsyncStorage.getItem(LAST_BACKUP_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as BackupRecord;
  } catch {
    return null;
  }
}

async function writeLastBackupRecord(record: BackupRecord): Promise<void> {
  await AsyncStorage.setItem(LAST_BACKUP_STORAGE_KEY, JSON.stringify(record));
}

export type SyncStatus = {
  isConnected: boolean;
  email?: string;
  lastBackupTime?: string;
  backupSizeBytes?: number;
};

export async function getSyncStatus(): Promise<SyncStatus> {
  ensureConfigured();
  const currentUser = GoogleSignin.getCurrentUser();
  if (!currentUser) {
    return { isConnected: false };
  }
  const record = await readLastBackupRecord();
  return {
    isConnected: true,
    email: currentUser.user.email,
    lastBackupTime: record?.time,
    backupSizeBytes: record?.sizeBytes,
  };
}

/**
 * Best-effort first name for the home screen's greeting (see app/index.tsx)
 * — reads whatever the currently signed-in Google account (from Drive
 * backup sign-in) already reports, with zero extra sign-in flow or
 * permission of its own. Returns null before a first sign-in, or if the
 * account has no display name set, so the greeting can fall back to a
 * name-less form rather than showing "undefined" or an empty string.
 * Synchronous-feeling on purpose (no network call) — `getCurrentUser()`
 * just reads the cached session GoogleSignin already holds.
 */
export function getGreetingFirstName(): string | null {
  try {
    ensureConfigured();
    const currentUser = GoogleSignin.getCurrentUser();
    const fullName = currentUser?.user.name;
    if (!fullName) {
      return null;
    }
    // First name only — "Good morning, Gaurav Singh Verma" reads like a
    // form letter; "Good morning, Gaurav" reads like a greeting.
    return fullName.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

export async function getAutoSyncOnWifi(): Promise<boolean> {
  return (await AsyncStorage.getItem(AUTO_SYNC_WIFI_STORAGE_KEY)) === "true";
}

export async function setAutoSyncOnWifi(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(AUTO_SYNC_WIFI_STORAGE_KEY, enabled ? "true" : "false");
}

/** Exported for services/sync/calendarSync.ts — `getTokens()` returns a
 * single access token valid for whatever scopes have actually been granted
 * on this signed-in session, Drive and Calendar alike, so there's no
 * separate per-scope token-fetch mechanism needed. */
export async function requireAccessToken(): Promise<string> {
  if (!GoogleSignin.getCurrentUser()) {
    throw new NotSignedInError();
  }
  const { accessToken } = await GoogleSignin.getTokens();
  return accessToken;
}

function currentAccountId(): string {
  const id = GoogleSignin.getCurrentUser()?.user.id;
  if (!id) {
    throw new NotSignedInError();
  }
  return id;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export type BackupResult = {
  /** No upload happened: the last verified backup already matched. */
  skipped: boolean;
  sizeBytes: number;
  verifiedAt: string;
  /** Ready-to-display summary (shown only after verification succeeded). */
  message: string;
};

/**
 * Encrypted Google Drive backup (services/backup/backupService.ts): a new,
 * independently verified generation in the hidden app-data folder. Resolves
 * only after the generation was downloaded back, decrypted and checked;
 * anything less throws, so the UI never reports a backup that didn't happen.
 * Legacy remi_backup.* files are never written.
 */
export async function backupToDrive(): Promise<BackupResult> {
  // A disposable test vault must never reach the real Drive backup.
  await assertNetworkFeatureAllowed("Google Drive backup");
  const token = await requireAccessToken();
  const outcome = await runEncryptedBackup({ token, accountId: currentAccountId() });
  await writeLastBackupRecord({ time: outcome.verifiedAt, sizeBytes: outcome.sizeBytes });
  const total = `${plural(outcome.counts.notes, "note")} and ${plural(outcome.counts.todos, "to-do")}`;
  if (outcome.skipped) {
    return {
      skipped: true,
      sizeBytes: outcome.sizeBytes,
      verifiedAt: outcome.verifiedAt,
      message: `Nothing new to back up. Your last verified backup (${formatDate(outcome.verifiedAt)}) already has everything on this phone — ${total}.`,
    };
  }
  let detail: string;
  if (outcome.firstBackup) {
    detail = `Your encrypted backup now holds ${total}.`;
  } else {
    const parts = [
      outcome.added.notes ? `added ${plural(outcome.added.notes, "note")}` : "",
      outcome.added.todos ? `added ${plural(outcome.added.todos, "to-do")}` : "",
      outcome.added.updatedNotes ? `updated ${plural(outcome.added.updatedNotes, "edited note")}` : "",
      outcome.added.updatedTodos ? `updated ${plural(outcome.added.updatedTodos, "to-do")}` : "",
    ].filter(Boolean);
    detail = parts.length
      ? `${parts.join(", ").replace(/^./, (c) => c.toUpperCase())}. Your backup holds ${total}.`
      : `Your backup holds ${total}.`;
  }
  return { skipped: false, sizeBytes: outcome.sizeBytes, verifiedAt: outcome.verifiedAt, message: `Backup verified. ${detail}` };
}

export type RestoreResult = {
  restoredCount: number;
  restoredToDoCount: number;
  /** Ready-to-display summary — see app/settings.tsx. */
  message: string;
};

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "an earlier date" : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/**
 * Restores the newest verified encrypted backup into this phone's vault —
 * a merge that only adds what's missing. Falls back to the legacy backup
 * (read-only) when the account has no encrypted one. Throws unless every
 * backed-up note is confirmed present afterwards.
 */
export async function restoreFromDrive(options: { recoveryCode?: string } = {}): Promise<RestoreResult> {
  await assertNetworkFeatureAllowed("Google Drive restore");
  const token = await requireAccessToken();
  const outcome = await restoreLatestBackup({ token, accountId: currentAccountId() }, options);
  const from = outcome.source === "legacy" ? "your older backup" : `your backup of ${formatDate(outcome.backupDate)}`;
  const parts = [
    outcome.restoredNotes ? plural(outcome.restoredNotes, "note") : "",
    outcome.restoredTodos ? plural(outcome.restoredTodos, "to-do") : "",
  ].filter(Boolean);
  return {
    restoredCount: outcome.restoredNotes,
    restoredToDoCount: outcome.restoredTodos,
    message: parts.length ? `Restored ${parts.join(" and ")} from ${from}.` : `Your notes already include everything in ${from}.`,
  };
}

/** The user chose to back up to the signed-in account instead of the one
 * this phone was bound to (backupAccount.ts). */
export async function switchBackupsToSignedInAccount(): Promise<void> {
  await rebindBackupAccount(currentAccountId());
}

// ---------------------------------------------------------------------------
// Extra Privacy (services/backup/backupService.ts)

export type BackupProtectionStatus = {
  /** The account-wide mode, when signed in (Drive is authoritative). */
  account: "standard" | "extra" | null;
  /** This phone's last established state. */
  local: ProtectionState;
  /** Extra Privacy only: whether older Google-only backups remain to remove
   * (null when unknown — the option stays available then). */
  googleOnlyBackups: boolean | null;
};

export async function getBackupProtectionStatus(): Promise<BackupProtectionStatus> {
  const local = await readLocalProtection();
  if (!GoogleSignin.getCurrentUser()) return { account: null, local, googleOnlyBackups: null };
  try {
    const token = await requireAccessToken();
    const account = (await getAccountProtection(token)).mode;
    const googleOnlyBackups = account === "extra" ? await hasGoogleOnlyBackups(token).catch(() => null) : null;
    return { account, local, googleOnlyBackups };
  } catch {
    return { account: null, local, googleOnlyBackups: null };
  }
}

async function context(): Promise<{ token: string; accountId: string }> {
  await assertNetworkFeatureAllowed("Google Drive backup");
  return { token: await requireAccessToken(), accountId: currentAccountId() };
}

/** Resolves only once the recovery-code-protected backup is verified and the
 * account has switched to Extra Privacy. */
export async function turnOnExtraPrivacy(recoveryCode: string): Promise<void> {
  const outcome = await activateExtraPrivacy(await context(), recoveryCode);
  await writeLastBackupRecord({ time: outcome.verifiedAt, sizeBytes: outcome.sizeBytes });
}

/** `oldCodeRemoved` false: the new code is active, and the old one stops
 * working after the next backup. */
export async function replaceExtraPrivacyCode(newRecoveryCode: string): Promise<{ oldCodeRemoved: boolean }> {
  return replaceRecoveryCode(await context(), newRecoveryCode);
}

export async function enterExtraPrivacyCode(recoveryCode: string): Promise<void> {
  await joinWithRecoveryCode(await context(), recoveryCode);
}

export async function removeOlderGoogleOnlyBackups(includeLegacy: boolean): Promise<RetireResult> {
  return retireStandardBackups(await context(), { includeLegacy });
}

export async function switchBackToStandardProtection(): Promise<void> {
  const outcome = await switchToStandard(await context());
  await writeLastBackupRecord({ time: outcome.verifiedAt, sizeBytes: outcome.sizeBytes });
}
