import { open, type DB } from "@op-engineering/op-sqlite";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  GoogleSignin,
  isSuccessResponse,
  type User,
} from "@react-native-google-signin/google-signin";
import { getRuntimePackageName, getSigningSha1Fingerprint } from "expo-app-signature";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";
import { Platform } from "react-native";

import { getRawDatabase } from "../../db/client";
import { getOrCreateDatabaseKey } from "../crypto/keyManager";
import { listNotes, mergeMissingNotes, type CloudNoteRecord } from "../notes/noteManager";
import { listAllToDos, mergeMissingToDos, type CloudToDoRecord } from "../todos/todoManager";
import type { Recurrence } from "../../db/schema";

/**
 * op-sqlite (and SQLite's own VFS underneath it — `VACUUM INTO`, `open()`'s
 * `location`, etc.) deals exclusively in bare OS filesystem paths, never
 * `file://` URIs; `expo-file-system` is the opposite and requires the
 * `file://` scheme on every call. Every path that crosses between the two
 * needs an explicit conversion — silently passing one style where the other
 * is expected fails without a helpful error (SQLite would just try to
 * create a file literally named `file:...`).
 */
function toBarePath(uriOrPath: string): string {
  return uriOrPath.startsWith("file://") ? uriOrPath.slice("file://".length) : uriOrPath;
}

/**
 * `drive.appdata` is deliberately the only scope ever requested. Files
 * created under it live in a hidden per-app folder that isn't visible in the
 * user's normal Drive UI and isn't readable by any other app or Drive client
 * — it's the narrowest scope Google offers for "let this app keep its own
 * private data in my Drive," which is exactly this feature and nothing more
 * (no access to the user's other Drive files, ever).
 */
const DRIVE_APPDATA_SCOPE = "https://www.googleapis.com/auth/drive.appdata";

const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files";

const BACKUP_DB_FILENAME = "remi_backup.db";
const BACKUP_KEY_FILENAME = "remi_backup.key";

const LAST_BACKUP_STORAGE_KEY = "remi.driveSync.lastBackup";
const AUTO_SYNC_WIFI_STORAGE_KEY = "remi.driveSync.autoSyncOnWifi";

export class DriveSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DriveSyncError";
  }
}

export class NotSignedInError extends DriveSyncError {
  constructor() {
    super("Not connected to Google Drive. Connect an account first.");
    this.name = "NotSignedInError";
  }
}

export class NoBackupFoundError extends DriveSyncError {
  constructor() {
    super("No backup was found in this Google account's Drive.");
    this.name = "NoBackupFoundError";
  }
}

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
function ensureConfigured(): void {
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
    scopes: [DRIVE_APPDATA_SCOPE],
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
 * Wraps a Google Sign-In call so a failure surfaces with everything needed
 * to actually diagnose it — the raw native code/message/toString() and the
 * configured `webClientId` prefix — appended to whichever message reaches
 * the UI's `Alert.alert` (see app/settings.tsx's `handleConnect`), rather
 * than the SDK's bare, unhelpful native error. An expected, already-clear
 * `DriveSyncError` (e.g. "sign-in was cancelled") passes through untouched;
 * diagnostics are only appended to genuine unexpected native failures.
 */
async function withDeveloperErrorHandling<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (err instanceof DriveSyncError) {
      throw err;
    }

    const diagnostics = formatSignInDiagnostics(err);
    console.error("[DriveSync] Google Sign-In failed —", diagnostics);

    if (isDeveloperError(err)) {
      throw new DriveSyncError(
        "Google Sign-In configuration error (DEVELOPER_ERROR). This almost always means the SHA-1 " +
          "certificate fingerprint of this build doesn't match what's registered for this app's " +
          "Android OAuth client in Google Cloud Console. The \"Runtime SHA-1\" below was read directly " +
          "off the installed APK, not guessed from a keystore file — add it (and \"Package Name\") to " +
          `an Android OAuth client in the same Google Cloud project as the Web Client ID below.\n\n${diagnostics}`
      );
    }
    throw new DriveSyncError(`Google Sign-In failed.\n\n${diagnostics}`);
  }
}

export type DriveUser = {
  email: string;
  displayName: string | null;
};

function toDriveUser(user: User): DriveUser {
  return { email: user.user.email, displayName: user.user.name };
}

/**
 * Opens the native Google account picker and requests the `drive.appdata`
 * scope. `addScopes` after `signIn` is deliberate belt-and-suspenders: on
 * some Play-Services versions, sign-in (identity) and API-scope
 * authorization are handled as separate steps under the hood, and skipping
 * this can leave `getTokens()` returning a token that's valid for identity
 * but rejected by the Drive API with an insufficient-scope error.
 */
export async function signInWithGoogle(): Promise<DriveUser> {
  ensureConfigured();
  return withDeveloperErrorHandling(async () => {
    await GoogleSignin.hasPlayServices();
    const response = await GoogleSignin.signIn();
    if (!isSuccessResponse(response)) {
      throw new DriveSyncError("Google sign-in was cancelled.");
    }
    await GoogleSignin.addScopes({ scopes: [DRIVE_APPDATA_SCOPE] });
    return toDriveUser(response.data);
  });
}

/** Revokes Drive access and clears the local session — deliberately does
 * NOT touch any local notes/database, only the sync connection itself. */
export async function signOutFromGoogle(): Promise<void> {
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

async function requireAccessToken(): Promise<string> {
  if (!GoogleSignin.getCurrentUser()) {
    throw new NotSignedInError();
  }
  const { accessToken } = await GoogleSignin.getTokens();
  return accessToken;
}

type DriveFile = { id: string; name: string; modifiedTime?: string; size?: string };

async function driveFetch(url: string, accessToken: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DriveSyncError(`Google Drive request failed (${res.status}): ${body || res.statusText}`);
  }
  return res;
}

async function findAppDataFile(accessToken: string, filename: string): Promise<DriveFile | null> {
  const query = encodeURIComponent(`name = '${filename}' and trashed = false`);
  const url =
    `${DRIVE_FILES_ENDPOINT}?spaces=appDataFolder&fields=files(id,name,modifiedTime,size)` +
    `&q=${query}`;
  const res = await driveFetch(url, accessToken);
  const json = (await res.json()) as { files?: DriveFile[] };
  return json.files?.[0] ?? null;
}

/** Creates an empty file record in the hidden appData folder, returning its
 * new file id. Content is uploaded separately via `uploadFileContent`. */
async function createAppDataFile(accessToken: string, filename: string): Promise<string> {
  const res = await driveFetch(DRIVE_FILES_ENDPOINT, accessToken, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: filename, parents: ["appDataFolder"] }),
  });
  const json = (await res.json()) as { id: string };
  return json.id;
}

/** Streams `localFileUri`'s bytes directly from disk as the request body —
 * deliberately not read into a JS string/base64 first, so this stays cheap
 * in memory regardless of how large the notes database grows. */
async function uploadFileContent(
  accessToken: string,
  fileId: string,
  localFileUri: string
): Promise<void> {
  const result = await FileSystem.uploadAsync(
    `${DRIVE_UPLOAD_ENDPOINT}/${fileId}?uploadType=media`,
    localFileUri,
    {
      httpMethod: "PATCH",
      uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
      },
    }
  );
  if (result.status < 200 || result.status >= 300) {
    throw new DriveSyncError(`Google Drive upload failed (${result.status}): ${result.body}`);
  }
}

async function downloadFileContent(
  accessToken: string,
  fileId: string,
  destinationUri: string
): Promise<void> {
  const result = await FileSystem.downloadAsync(
    `${DRIVE_FILES_ENDPOINT}/${fileId}?alt=media`,
    destinationUri,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  if (result.status < 200 || result.status >= 300) {
    throw new DriveSyncError(`Google Drive download failed (${result.status})`);
  }
}

async function findOrCreateAppDataFile(accessToken: string, filename: string): Promise<string> {
  const existing = await findAppDataFile(accessToken, filename);
  return existing ? existing.id : createAppDataFile(accessToken, filename);
}

async function deleteIfExists(uri: string): Promise<void> {
  await FileSystem.deleteAsync(uri, { idempotent: true });
}

function toCloudNoteRecord(note: { id: string; content: string; transcript: string | null; transcriptionModel: string | null; createdAt: number }): CloudNoteRecord {
  return {
    id: note.id,
    content: note.content,
    transcript: note.transcript,
    transcriptionModel: note.transcriptionModel,
    createdAt: note.createdAt,
  };
}

function toCloudToDoRecord(todo: {
  id: string;
  text: string;
  actionDate: string;
  toDate: string | null;
  notificationTime: string;
  isCompleted: boolean;
  recurrence: Recurrence;
  recurrenceInterval: number;
  createdAt: string;
  noteId: string | null;
}): CloudToDoRecord {
  return {
    id: todo.id,
    text: todo.text,
    actionDate: todo.actionDate,
    toDate: todo.toDate,
    notificationTime: todo.notificationTime,
    isCompleted: todo.isCompleted,
    recurrence: todo.recurrence,
    recurrenceInterval: todo.recurrenceInterval,
    createdAt: todo.createdAt,
    noteId: todo.noteId,
  };
}

/**
 * Inserts whichever of `notes` aren't already present (by id) into
 * `targetDb`'s own `notes` table — the exact mirror-image of
 * `noteManager.ts`'s `mergeMissingNotes` (cloud → local), used here for the
 * local → cloud direction instead. Deliberately NOT reusing
 * `mergeMissingNotes` itself: that function is tied to the app's own LIVE
 * local database (`getRawDatabase()`) and has a real side effect (kicking
 * off embedding generation) that must never run against a downloaded,
 * about-to-be-re-uploaded backup copy — this only ever INSERTs rows, never
 * anything else, so the merged file can only ever be a superset of what
 * `targetDb` already had.
 */
async function insertMissingNoteRows(targetDb: DB, notes: CloudNoteRecord[]): Promise<number> {
  const existingIdsResult = await targetDb.execute("SELECT id FROM notes");
  const existingIds = new Set(existingIdsResult.rows.map((row) => row.id as string));
  const missing = notes.filter((note) => !existingIds.has(note.id));
  if (missing.length === 0) {
    return 0;
  }
  const insertedAt = Math.floor(Date.now() / 1000);
  await targetDb.transaction(async (tx) => {
    for (const note of missing) {
      await tx.execute(
        `INSERT OR IGNORE INTO notes (id, content, audio_uri, transcript, status, transcription_model, created_at, updated_at)
         VALUES (?, ?, NULL, ?, 'transcribed', ?, ?, ?)`,
        [note.id, note.content, note.transcript, note.transcriptionModel, note.createdAt, insertedAt]
      );
    }
  });
  return missing.length;
}

/** Mirror-image of `insertMissingNoteRows`, for the `todos` table — same
 * INSERT shape `todoManager.ts`'s `mergeMissingToDos` uses, deliberately not
 * reused for the same reason (that function's local-notification
 * side effect must never fire against a backup copy). */
async function insertMissingToDoRows(targetDb: DB, todos: CloudToDoRecord[]): Promise<number> {
  const existingIdsResult = await targetDb.execute("SELECT id FROM todos");
  const existingIds = new Set(existingIdsResult.rows.map((row) => row.id as string));
  const missing = todos.filter((todo) => !existingIds.has(todo.id));
  if (missing.length === 0) {
    return 0;
  }
  await targetDb.transaction(async (tx) => {
    for (const todo of missing) {
      await tx.execute(
        `INSERT OR IGNORE INTO todos
           (id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          todo.id,
          todo.text,
          todo.actionDate,
          todo.toDate,
          todo.notificationTime,
          todo.isCompleted ? 1 : 0,
          todo.recurrence,
          todo.recurrenceInterval,
          todo.createdAt,
          todo.noteId,
        ]
      );
    }
  });
  return missing.length;
}

function formatBackupMessage(addedNoteCount: number, addedToDoCount: number): string {
  const parts: string[] = [];
  if (addedNoteCount > 0) {
    parts.push(`${addedNoteCount} note${addedNoteCount === 1 ? "" : "s"}`);
  }
  if (addedToDoCount > 0) {
    parts.push(`${addedToDoCount} to-do${addedToDoCount === 1 ? "" : "s"}`);
  }
  return parts.length === 0 ? "Everything is already backed up!" : `Added ${parts.join(" and ")} to your Drive backup.`;
}

export type BackupResult = {
  sizeBytes: number;
  addedNoteCount: number;
  addedToDoCount: number;
  /** Ready-to-display summary, e.g. for an Alert — see app/settings.tsx. */
  message: string;
};

/**
 * Backs up the notes database to the signed-in Google account's private
 * appData folder — a true DELTA backup, not a wholesale overwrite.
 *
 * Live data-loss incident, fixed 2026-09-16 (superseding an earlier
 * warn-before-overwrite version of this fix, per explicit user direction):
 * this used to `VACUUM INTO` the LOCAL database and upload it directly,
 * overwriting whatever was already in Drive — so a freshly-reinstalled
 * app with 0 local notes silently replaced a real, populated backup with
 * an empty one. Now: if a remote backup already exists, this downloads it,
 * inserts whichever local notes/to-dos aren't already in it (by id — the
 * same merge logic `restoreFromDrive()` already uses in the opposite
 * direction), and re-uploads that merged result. The merge step is
 * INSERT-only — it can only ever add rows to the downloaded copy, never
 * remove or overwrite any — so 0 local notes now structurally CANNOT lose
 * anything already in Drive; it just adds nothing. Two local notes against
 * 15 already in Drive correctly becomes 17, not 2. Only when NO remote
 * backup exists yet (a genuinely fresh account) does this upload a plain
 * local snapshot directly, since there's nothing to merge with.
 *
 * Two files live in the hidden appData folder either way: `remi_backup.db`
 * (the SQLCipher-encrypted snapshot — `VACUUM INTO` rather than copying the
 * live file, since the live file can be mid-write and `VACUUM INTO`
 * guarantees a clean point-in-time copy) and `remi_backup.key` (the raw
 * database encryption key, needed on restore since SQLCipher can't be
 * opened without the exact key it was written with). The merge path never
 * needs to re-upload the key: it opens and writes to the downloaded backup
 * using the key IT was already encrypted with, so that file stays valid
 * under the same key throughout.
 *
 * Security tradeoff, stated plainly: normally this app's database key never
 * leaves the device's hardware-backed keystore (see keyManager.ts). Backing
 * it up to Drive — even to the hidden, per-app `appDataFolder` that only
 * this app and this Google account can reach — means the backup's real
 * protection becomes "whoever has OAuth access to this Google account,"
 * not "whoever has the device." That's a deliberate, necessary tradeoff:
 * without shipping the key alongside the data, a restore on a new device
 * (whose keystore would mint an unrelated fresh key) could never decrypt
 * the restored file, defeating the point of a backup.
 */
export async function backupToDrive(): Promise<BackupResult> {
  const accessToken = await requireAccessToken();

  const [dbFile, keyFile] = await Promise.all([
    findAppDataFile(accessToken, BACKUP_DB_FILENAME),
    findAppDataFile(accessToken, BACKUP_KEY_FILENAME),
  ]);

  if (dbFile && keyFile) {
    return mergeLocalIntoExistingRemoteBackup(accessToken, dbFile.id, keyFile.id);
  }
  return uploadFreshLocalSnapshot(accessToken);
}

/** The merge path — see `backupToDrive()`'s own doc comment for the full
 * design and why this is what actually fixes the live data-loss incident. */
async function mergeLocalIntoExistingRemoteBackup(
  accessToken: string,
  dbFileId: string,
  keyFileId: string
): Promise<BackupResult> {
  const mergeId = Crypto.randomUUID();
  const downloadedDbFilename = `remi-backup-merge-download-${mergeId}.sqlite`;
  const downloadedDbUri = `${FileSystem.cacheDirectory}${downloadedDbFilename}`;
  const downloadedKeyUri = `${FileSystem.cacheDirectory}remi-backup-merge-key-${mergeId}.txt`;
  const mergedSnapshotUri = `${FileSystem.cacheDirectory}remi-backup-merged-snapshot-${mergeId}.sqlite`;

  let mergeDb: DB | null = null;
  try {
    await Promise.all([
      downloadFileContent(accessToken, dbFileId, downloadedDbUri),
      downloadFileContent(accessToken, keyFileId, downloadedKeyUri),
    ]);
    const remoteKey = (await FileSystem.readAsStringAsync(downloadedKeyUri)).trim();
    if (!remoteKey) {
      throw new DriveSyncError("Downloaded backup key was empty.");
    }

    // Writable (unlike restoreFromDrive's read-only open) — this connection
    // exists specifically to ADD rows to it.
    mergeDb = open({
      name: downloadedDbFilename,
      location: toBarePath(FileSystem.cacheDirectory ?? ""),
      encryptionKey: remoteKey,
    });

    const [localNotes, localToDos] = await Promise.all([listNotes(), listAllToDos()]);
    const addedNoteCount = await insertMissingNoteRows(mergeDb, localNotes.map(toCloudNoteRecord));
    const addedToDoCount = await insertMissingToDoRows(mergeDb, localToDos.map(toCloudToDoRecord));

    // VACUUM INTO again here, exactly like the fresh-snapshot path below —
    // guarantees every just-inserted row is flushed into one clean file
    // (not left sitting in a WAL side-car) before its bytes are read for
    // upload, rather than relying on close()'s own checkpoint behavior.
    await deleteIfExists(mergedSnapshotUri);
    await mergeDb.execute("VACUUM INTO ?", [toBarePath(mergedSnapshotUri)]);
    mergeDb.close();
    mergeDb = null;

    const snapshotInfo = await FileSystem.getInfoAsync(mergedSnapshotUri);
    if (!snapshotInfo.exists) {
      throw new DriveSyncError("Failed to create a merged database snapshot to back up.");
    }

    await uploadFileContent(accessToken, dbFileId, mergedSnapshotUri);
    // remi_backup.key is deliberately NOT re-uploaded — the merged file is
    // still encrypted under the exact key it was downloaded and opened
    // with, so the existing remote key file is already correct.

    const record: BackupRecord = {
      time: new Date().toISOString(),
      sizeBytes: snapshotInfo.exists ? snapshotInfo.size : 0,
    };
    await writeLastBackupRecord(record);
    return {
      sizeBytes: record.sizeBytes,
      addedNoteCount,
      addedToDoCount,
      message: formatBackupMessage(addedNoteCount, addedToDoCount),
    };
  } finally {
    mergeDb?.close();
    await deleteIfExists(downloadedDbUri);
    // SQLCipher/SQLite side-car files the write connection may have left
    // behind — same cleanup restoreFromDrive's own read-only connection
    // goes through.
    await deleteIfExists(`${downloadedDbUri}-wal`);
    await deleteIfExists(`${downloadedDbUri}-shm`);
    await deleteIfExists(`${downloadedDbUri}-journal`);
    await deleteIfExists(downloadedKeyUri);
    await deleteIfExists(mergedSnapshotUri);
  }
}

/** No remote backup exists yet — nothing to merge with, so this uploads a
 * plain local snapshot directly (the original, pre-2026-09-16 behavior,
 * kept only for this one genuinely-safe case: an account with no existing
 * backup has nothing a fresh upload could possibly overwrite). */
async function uploadFreshLocalSnapshot(accessToken: string): Promise<BackupResult> {
  const snapshotUri = `${FileSystem.cacheDirectory}remi-backup-snapshot.sqlite`;
  const keyFileUri = `${FileSystem.cacheDirectory}remi-backup-key.txt`;

  try {
    await deleteIfExists(snapshotUri);
    const db = await getRawDatabase();
    await db.execute("VACUUM INTO ?", [toBarePath(snapshotUri)]);

    const snapshotInfo = await FileSystem.getInfoAsync(snapshotUri);
    if (!snapshotInfo.exists) {
      throw new DriveSyncError("Failed to create a local database snapshot to back up.");
    }

    const encryptionKey = await getOrCreateDatabaseKey();
    await FileSystem.writeAsStringAsync(keyFileUri, encryptionKey);

    const [dbFileId, keyFileId] = await Promise.all([
      findOrCreateAppDataFile(accessToken, BACKUP_DB_FILENAME),
      findOrCreateAppDataFile(accessToken, BACKUP_KEY_FILENAME),
    ]);
    await uploadFileContent(accessToken, dbFileId, snapshotUri);
    await uploadFileContent(accessToken, keyFileId, keyFileUri);

    const record: BackupRecord = {
      time: new Date().toISOString(),
      sizeBytes: snapshotInfo.exists ? snapshotInfo.size : 0,
    };
    await writeLastBackupRecord(record);
    const [localNotes, localToDos] = await Promise.all([listNotes(), listAllToDos()]);
    return {
      sizeBytes: record.sizeBytes,
      addedNoteCount: localNotes.length,
      addedToDoCount: localToDos.length,
      message: formatBackupMessage(localNotes.length, localToDos.length),
    };
  } finally {
    // The key file in particular must not linger on disk unencrypted any
    // longer than it takes to upload it.
    await deleteIfExists(snapshotUri);
    await deleteIfExists(keyFileUri);
  }
}

export type RestoreResult = {
  /** Number of notes actually inserted — 0 means the local vault already had
   * every note the cloud backup does (not an error, just nothing to do). */
  restoredCount: number;
  /** Number of to-dos actually inserted — see `mergeMissingToDos`. Restored
   * separately from `restoredCount` (notes) since the two are unrelated
   * counts that can each independently be zero. */
  restoredToDoCount: number;
  /** Ready-to-display summary, e.g. for a toast — see app/settings.tsx. */
  message: string;
};

/**
 * Delta/merge restore: downloads the signed-in account's Drive backup and
 * opens it as a second, read-only op-sqlite connection (keyed with the
 * backup's own encryption key, downloaded alongside it) rather than closing
 * and swapping out the live database the way a full restore would. Every
 * note in the backup is diffed against this device's local note ids —
 * `mergeMissingNotes` (services/notes/noteManager.ts) inserts only the ones
 * missing locally and kicks off background re-embedding for them — so a
 * restore run on a device that already has notes (e.g. reinstalling after
 * keeping local notes, or restoring on a second device that's also been
 * recording independently) can never overwrite or duplicate anything
 * already here. The live database is never closed and stays fully usable
 * throughout.
 */
export async function restoreFromDrive(): Promise<RestoreResult> {
  const accessToken = await requireAccessToken();

  const dbFile = await findAppDataFile(accessToken, BACKUP_DB_FILENAME);
  const keyFile = await findAppDataFile(accessToken, BACKUP_KEY_FILENAME);
  if (!dbFile || !keyFile) {
    throw new NoBackupFoundError();
  }

  const restoreId = Crypto.randomUUID();
  // A real filename (not a fixed one, unlike backupToDrive's snapshot) since
  // it's opened by op-sqlite's `name`/`location` pair below rather than only
  // ever touched via expo-file-system — two concurrent restores (shouldn't
  // happen from this UI, but cheap to make safe) can't collide on one name.
  const backupDbFilename = `remi-restore-snapshot-${restoreId}.sqlite`;
  const downloadedDbUri = `${FileSystem.cacheDirectory}${backupDbFilename}`;
  const downloadedKeyUri = `${FileSystem.cacheDirectory}remi-restore-key-${restoreId}.txt`;

  let backupDb: DB | null = null;
  try {
    await Promise.all([
      downloadFileContent(accessToken, dbFile.id, downloadedDbUri),
      downloadFileContent(accessToken, keyFile.id, downloadedKeyUri),
    ]);
    const restoredKey = (await FileSystem.readAsStringAsync(downloadedKeyUri)).trim();
    if (!restoredKey) {
      throw new DriveSyncError("Downloaded backup key was empty.");
    }

    // `location` is a bare directory path, matched to the bare `file://`-stripped
    // cache directory the file was just downloaded into (see toBarePath above) —
    // op-sqlite, like SQLCipher generally, works in OS paths, never file:// URIs.
    backupDb = open({
      name: backupDbFilename,
      location: toBarePath(FileSystem.cacheDirectory ?? ""),
      encryptionKey: restoredKey,
      readOnly: true,
    });

    const cloudRows = await backupDb.execute(
      "SELECT id, content, transcript, transcription_model, created_at FROM notes"
    );
    const cloudNotes: CloudNoteRecord[] = cloudRows.rows.map((row) => ({
      id: row.id as string,
      content: (row.content as string) || (row.transcript as string) || "",
      transcript: (row.transcript as string | null) ?? null,
      transcriptionModel: (row.transcription_model as string | null) ?? null,
      createdAt: row.created_at as number,
    }));

    // The `VACUUM INTO` snapshot backupToDrive() writes is a byte-for-byte
    // copy of the whole encrypted database, so the backup already contains
    // every to-do row alongside notes — nothing extra to change on the
    // backup side, only on this restore side, which (before this) only ever
    // read the `notes` table back out and silently dropped every to-do a
    // backup carried.
    const cloudToDoRows = await backupDb.execute(
      "SELECT id, text, action_date, to_date, notification_time, is_completed, recurrence, recurrence_interval, created_at, note_id FROM todos"
    );
    const cloudToDos: CloudToDoRecord[] = cloudToDoRows.rows.map((row) => ({
      id: row.id as string,
      text: row.text as string,
      actionDate: row.action_date as string,
      toDate: (row.to_date as string | null) ?? null,
      notificationTime: (row.notification_time as string | null) || "05:00",
      isCompleted: Boolean(row.is_completed),
      recurrence: (row.recurrence as Recurrence) || "none",
      recurrenceInterval: Number(row.recurrence_interval) || 1,
      createdAt: row.created_at as string,
      noteId: (row.note_id as string | null) ?? null,
    }));

    const restoredCount = await mergeMissingNotes(cloudNotes);
    // Restored after notes, not in parallel — a restored to-do's `note_id`
    // may point at a note this same restore just inserted, and there's no
    // ordering guarantee otherwise needed beyond "the note row exists by the
    // time anything reads it" (see db/schema.ts's `noteId` doc comment: a
    // to-do citing a missing note already degrades gracefully, so this isn't
    // load-bearing correctness, just the more sensible order).
    const restoredToDoCount = await mergeMissingToDos(cloudToDos);

    const parts: string[] = [];
    if (restoredCount > 0) {
      parts.push(`${restoredCount} note${restoredCount === 1 ? "" : "s"}`);
    }
    if (restoredToDoCount > 0) {
      parts.push(`${restoredToDoCount} to-do${restoredToDoCount === 1 ? "" : "s"}`);
    }

    return {
      restoredCount,
      restoredToDoCount,
      message: parts.length === 0 ? "Everything is already up to date!" : `Restored ${parts.join(" and ")}.`,
    };
  } finally {
    backupDb?.close();
    await deleteIfExists(downloadedDbUri);
    // SQLCipher/SQLite side-car files the backup connection may have left
    // behind — same cleanup backupToDrive's own snapshot goes through.
    await deleteIfExists(`${downloadedDbUri}-wal`);
    await deleteIfExists(`${downloadedDbUri}-shm`);
    await deleteIfExists(`${downloadedDbUri}-journal`);
    await deleteIfExists(downloadedKeyUri);
  }
}

export type BackupMetadata = { modifiedTime: string; sizeBytes: number };

/** Reads the remote backup's metadata without downloading its content —
 * used by the Settings screen to show "last backup" info independent of
 * (and as a sanity check against) the locally-cached AsyncStorage record. */
export async function getBackupMetadata(): Promise<BackupMetadata | null> {
  const accessToken = await requireAccessToken();
  const dbFile = await findAppDataFile(accessToken, BACKUP_DB_FILENAME);
  if (!dbFile) {
    return null;
  }
  const res = await driveFetch(
    `${DRIVE_FILES_ENDPOINT}/${dbFile.id}?fields=modifiedTime,size`,
    accessToken
  );
  const json = (await res.json()) as { modifiedTime: string; size?: string };
  return { modifiedTime: json.modifiedTime, sizeBytes: json.size ? Number(json.size) : 0 };
}
