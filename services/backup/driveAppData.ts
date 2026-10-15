import * as FileSystem from "expo-file-system/legacy";

import { DriveSyncError } from "../sync/driveErrors";

/**
 * Minimal Google Drive v3 helpers for the hidden app-data folder, used by the
 * encrypted backup (services/backup/). Every call takes the access token from
 * the caller (services/sync/driveSync.ts owns sign-in). Files are only ever
 * CREATED — never overwritten — so an interrupted upload can't replace an
 * earlier file; the only deletions are of files this run itself just created
 * and nothing references.
 */

const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FIELDS = "id,name,size,md5Checksum,createdTime,modifiedTime,appProperties";

export type AppDataFile = {
  id: string;
  name: string;
  size?: string;
  md5Checksum?: string;
  createdTime?: string;
  modifiedTime?: string;
  appProperties?: Record<string, string>;
};

/**
 * Access tokens expire after about an hour, and a backup or protection change
 * can outlive one. On a 401 the token is refreshed once (driveSync.ts registers
 * the refresher) and the request retried; later calls made with the old token
 * use the refreshed one.
 */
let refreshToken: ((stale: string) => Promise<string>) | null = null;
const refreshed = new Map<string, string>();

export function setAccessTokenRefresher(refresher: (stale: string) => Promise<string>): void {
  refreshToken = refresher;
}

function current(token: string): string {
  return refreshed.get(token) ?? token;
}

async function renew(token: string): Promise<string | null> {
  if (!refreshToken) return null;
  const fresh = await refreshToken(current(token));
  refreshed.set(token, fresh);
  return fresh;
}

async function call(url: string, token: string, init?: RequestInit): Promise<Response> {
  const send = (t: string) => fetch(url, { ...init, headers: { ...init?.headers, Authorization: `Bearer ${t}` } });
  let res = await send(current(token));
  if (res.status === 401) {
    const fresh = await renew(token);
    if (fresh) res = await send(fresh);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new DriveSyncError(`Google Drive request failed (${res.status}): ${body.slice(0, 300) || res.statusText}`);
  }
  return res;
}

/** Every app-data file whose name starts with `prefix` (paged). */
export async function listAppDataFiles(token: string, prefix: string): Promise<AppDataFile[]> {
  const q = encodeURIComponent(`name contains '${prefix.replace(/'/g, "")}' and trashed = false`);
  const out: AppDataFile[] = [];
  let pageToken = "";
  do {
    const url = `${FILES}?spaces=appDataFolder&pageSize=200&fields=nextPageToken,files(${FIELDS})&q=${q}${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const json = (await (await call(url, token)).json()) as { files?: AppDataFile[]; nextPageToken?: string };
    out.push(...(json.files ?? []).filter((file) => file.name.startsWith(prefix)));
    pageToken = json.nextPageToken ?? "";
  } while (pageToken);
  return out;
}

export async function getAppDataFile(token: string, id: string): Promise<AppDataFile> {
  return (await (await call(`${FILES}/${id}?fields=${FIELDS}`, token)).json()) as AppDataFile;
}

async function createRecord(token: string, name: string, appProperties: Record<string, string>): Promise<string> {
  const res = await call(FILES, token, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, parents: ["appDataFolder"], appProperties }),
  });
  return ((await res.json()) as { id: string }).id;
}

/** Best-effort removal of a file THIS run created and nothing references. */
export async function deleteOwnUnreferencedFile(token: string, id: string): Promise<void> {
  try {
    await call(`${FILES}/${id}`, token, { method: "DELETE" });
  } catch {
    // An orphan is harmless: nothing points at it, and restore ignores it.
  }
}

/** Creates a NEW file and streams a local file into it (never read into JS). */
export async function createFileFromDisk(
  token: string,
  name: string,
  localUri: string,
  appProperties: Record<string, string>
): Promise<string> {
  const id = await createRecord(token, name, appProperties);
  try {
    const upload = (t: string) =>
      FileSystem.uploadAsync(`${UPLOAD}/${id}?uploadType=media`, localUri, {
        httpMethod: "PATCH",
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/octet-stream" },
      });
    let result = await upload(current(token));
    if (result.status === 401) {
      const fresh = await renew(token);
      if (fresh) result = await upload(fresh);
    }
    if (result.status < 200 || result.status >= 300) {
      throw new DriveSyncError(`Google Drive upload failed (${result.status}).`);
    }
  } catch (err) {
    await deleteOwnUnreferencedFile(token, id);
    throw err;
  }
  return id;
}

/** Creates a NEW small JSON file. */
export async function createJsonFile(
  token: string,
  name: string,
  value: unknown,
  appProperties: Record<string, string>
): Promise<string> {
  const id = await createRecord(token, name, appProperties);
  try {
    await call(`${UPLOAD}/${id}?uploadType=media`, token, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  } catch (err) {
    await deleteOwnUnreferencedFile(token, id);
    throw err;
  }
  return id;
}

export async function downloadToDisk(token: string, id: string, destinationUri: string): Promise<void> {
  const download = (t: string) =>
    FileSystem.downloadAsync(`${FILES}/${id}?alt=media`, destinationUri, { headers: { Authorization: `Bearer ${t}` } });
  let result = await download(current(token));
  if (result.status === 401) {
    const fresh = await renew(token);
    if (fresh) result = await download(fresh);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new DriveSyncError(`Google Drive download failed (${result.status}).`);
  }
}

/** Downloads a small file into memory, refusing anything over `maxBytes`. */
export async function downloadText(token: string, id: string, maxBytes = 64 * 1024): Promise<string> {
  const text = await (await call(`${FILES}/${id}?alt=media`, token)).text();
  if (text.length > maxBytes) {
    throw new DriveSyncError("A backup file is larger than expected.");
  }
  return text;
}

export async function setAppProperties(token: string, id: string, appProperties: Record<string, string>): Promise<void> {
  await call(`${FILES}/${id}?fields=id`, token, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ appProperties }),
  });
}

/**
 * Deletes an app-data file the USER explicitly chose to retire (e.g. older
 * Standard backups after Extra Privacy was verified). Never called by
 * automatic code paths.
 */
export async function deleteAppDataFile(token: string, id: string): Promise<void> {
  await call(`${FILES}/${id}`, token, { method: "DELETE" });
}
