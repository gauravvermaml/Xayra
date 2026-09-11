import { requireNativeModule } from "expo-modules-core";

/**
 * Hands a large model download to Android's own system DownloadManager
 * service instead of running it inside this app's React Native process —
 * see the native module's own doc comment (DownloadBridgeModule.kt) for why:
 * a multi-hour first-run download during Xayra's "One Door, Opens Once"
 * onboarding screen explicitly invites the user to minimize/background the
 * app, which kills an in-process expo-file-system DownloadResumable the
 * moment Android freezes it. DownloadManager survives that (and even a
 * reboot) because the OS itself owns the transfer.
 *
 * Android-only, matching this app's platform scope — see
 * modules/device-cpu/index.ts and modules/app-signature/index.ts for the
 * same pattern.
 */
const DownloadBridgeModule = requireNativeModule<{
  enqueue(url: string, destFilename: string, title: string): number;
  query(downloadId: number): string;
  cancel(downloadId: number): void;
  deleteFile(path: string): void;
}>("DownloadBridge");

export type NativeDownloadStatus =
  | "pending"
  | "running"
  | "paused"
  | "successful"
  | "failed"
  | "not_found"
  | "unknown";

export type NativeDownloadQueryResult = {
  status: NativeDownloadStatus;
  bytesDownloaded: number;
  bytesTotal: number;
  /** `file://`-style URI DownloadManager wrote the finished file to, inside
   * this app's app-private external-files directory — null until the
   * download reaches a state that has one. Never the same directory as
   * `FileSystem.documentDirectory`; the caller must move it there itself. */
  localUri: string | null;
  /** One of DownloadManager's `ERROR_*`/`PAUSED_*` int constants — only
   * meaningful when `status` is "failed" or "paused"; 0 otherwise. */
  reason: number;
};

/** Enqueues `url` for download into this app's app-private external-files
 * directory (NOT FileSystem.documentDirectory — DownloadManager can't write
 * there) under `destFilename`, and returns the DownloadManager-assigned
 * download ID to poll via `queryDownload()`. */
export function enqueueDownload(url: string, destFilename: string, title: string): number {
  return DownloadBridgeModule.enqueue(url, destFilename, title);
}

/** Polls the current state of a download previously started with
 * `enqueueDownload()` — safe to call at any point, including after this
 * app's process was killed and relaunched, since the download ID is
 * resolved against Android's own system DownloadManager record, not
 * anything this app's process was holding in memory. */
export function queryDownload(downloadId: number): NativeDownloadQueryResult {
  return JSON.parse(DownloadBridgeModule.query(downloadId)) as NativeDownloadQueryResult;
}

/** Cancels and removes a download's DownloadManager record. */
export function cancelDownload(downloadId: number): void {
  DownloadBridgeModule.cancel(downloadId);
}

/**
 * Deletes a plain file path natively — specifically for cleaning up a
 * finished download in this app's app-private external-files directory
 * after the caller has already copied it into `FileSystem.documentDirectory`.
 * NOT a replacement for `FileSystem.deleteAsync` in general: use this only
 * for a path DownloadManager itself wrote (via `enqueueDownload`), since
 * expo-file-system's own `deleteAsync` rejects paths outside its own
 * sandboxed directories with an "isn't deletable" error — confirmed
 * on-device — even though this app has full OS-level write access to them.
 */
export function deleteNativeFile(path: string): void {
  DownloadBridgeModule.deleteFile(path);
}
