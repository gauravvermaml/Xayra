import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  GoogleSignin,
  isSuccessResponse,
  type User,
} from "@react-native-google-signin/google-signin";
import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

import { closeDatabase, getRawDatabase } from "../../db/client";
import { getOrCreateDatabaseKey, setDatabaseKey } from "../crypto/keyManager";

/**
 * op-sqlite (and SQLite's own VFS underneath it — `VACUUM INTO`, in
 * particular) deals exclusively in bare OS filesystem paths, never `file://`
 * URIs; `expo-file-system` is the opposite and requires the `file://`
 * scheme on every call. Every path that crosses between the two needs an
 * explicit conversion — silently passing one style where the other is
 * expected fails without a helpful error (SQLite would just try to create a
 * file literally named `file:...`).
 */
function toFileUri(barePath: string): string {
  return barePath.startsWith("file://") ? barePath : `file://${barePath}`;
}
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
 * Captures everything available about a failed native Google Sign-In call —
 * `error.code`/`error.message`/`error.toString()` plus a prefix of the
 * configured `webClientId` — so a `DEVELOPER_ERROR` (or any other opaque
 * native failure) can actually be diagnosed from what's on screen/in logs
 * instead of guessing.
 */
function formatSignInDiagnostics(err: unknown): string {
  const code = (err as { code?: string | number } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  const toStringValue = err instanceof Error ? err.toString() : String(err);
  const webClientIdPrefix = WEB_CLIENT_ID.slice(0, WEB_CLIENT_ID_LOG_PREFIX_LENGTH);
  return `code=${code ?? "unknown"} | message=${message} | toString=${toStringValue} | webClientId≈${webClientIdPrefix}…`;
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
          "Android OAuth client in Google Cloud Console — check whether this is a debug or release " +
          "build and confirm its SHA-1 (`keytool -list -v -keystore <path-to-keystore>`) is added " +
          `there, alongside a matching Web OAuth client ID configured in services/sync/driveSync.ts.\n\n${diagnostics}`
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

/**
 * Backs up the notes database to the signed-in Google account's private
 * appData folder. Two files are written: `remi_backup.db` (a consistent
 * SQLCipher-encrypted snapshot, taken via `VACUUM INTO` rather than copying
 * the live file — the live file can be mid-write, `VACUUM INTO` guarantees a
 * clean point-in-time copy) and `remi_backup.key` (the raw database
 * encryption key, needed on restore since SQLCipher can't be opened without
 * the exact key it was written with).
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
export async function backupToDrive(): Promise<BackupRecord> {
  const accessToken = await requireAccessToken();

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
    return record;
  } finally {
    // The key file in particular must not linger on disk unencrypted any
    // longer than it takes to upload it.
    await deleteIfExists(snapshotUri);
    await deleteIfExists(keyFileUri);
  }
}

/**
 * Restores the notes database from the signed-in Google account's Drive
 * backup, swapping it in for the local database and re-keying so the
 * restored (possibly foreign-device-encrypted) file can actually be opened.
 * Closes and lets the caller re-open the database connection — callers
 * should refresh any note lists immediately after this resolves.
 */
export async function restoreFromDrive(): Promise<void> {
  const accessToken = await requireAccessToken();

  const dbFile = await findAppDataFile(accessToken, BACKUP_DB_FILENAME);
  const keyFile = await findAppDataFile(accessToken, BACKUP_KEY_FILENAME);
  if (!dbFile || !keyFile) {
    throw new NoBackupFoundError();
  }

  const downloadedDbUri = `${FileSystem.cacheDirectory}remi-restore-snapshot-${Crypto.randomUUID()}.sqlite`;
  const downloadedKeyUri = `${FileSystem.cacheDirectory}remi-restore-key-${Crypto.randomUUID()}.txt`;

  try {
    await Promise.all([
      downloadFileContent(accessToken, dbFile.id, downloadedDbUri),
      downloadFileContent(accessToken, keyFile.id, downloadedKeyUri),
    ]);
    const restoredKey = (await FileSystem.readAsStringAsync(downloadedKeyUri)).trim();
    if (!restoredKey) {
      throw new DriveSyncError("Downloaded backup key was empty.");
    }

    // Capture the live database's on-disk path before closing it — once
    // closed there's no handle left to ask. op-sqlite returns a bare OS
    // path here (see toFileUri/toBarePath above), so every FileSystem call
    // below needs it converted to a file:// URI first.
    const rawDb = await getRawDatabase();
    const dbFileUri = toFileUri(rawDb.getDbPath());
    closeDatabase();

    await deleteIfExists(dbFileUri);
    // A rollback-journal/WAL side-car left over from the *old* database
    // would otherwise sit next to the freshly-restored file and could be
    // mistaken for its own journal on next open.
    await deleteIfExists(`${dbFileUri}-wal`);
    await deleteIfExists(`${dbFileUri}-shm`);
    await deleteIfExists(`${dbFileUri}-journal`);
    await FileSystem.copyAsync({ from: downloadedDbUri, to: dbFileUri });

    await setDatabaseKey(restoredKey);
    // The next getDatabase()/getRawDatabase() call lazily reopens against
    // the swapped file and the restored key — that's the
    // "re-initializes vector/database context" step; there is no separate
    // explicit reinit call to make.
  } finally {
    await deleteIfExists(downloadedDbUri);
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
