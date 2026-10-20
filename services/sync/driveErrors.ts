/**
 * Google Drive/Calendar error types, kept in their own dependency-free module.
 *
 * They used to live in driveSync.ts, but driveSync → todoManager →
 * calendarSync → driveSync is an import cycle, and calendarSync's
 * `class CalendarSyncError extends DriveSyncError` runs while modules load:
 * whenever driveSync happened to load first, DriveSyncError was still
 * undefined and the app crashed at startup ("undefined is not a
 * constructor"). Defining the classes here removes that load-order
 * dependency. driveSync.ts re-exports them, so importers are unchanged.
 */
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


/** A plain message for a failed Google API response (the raw status and body
 * go to development logs at the call site, never to the screen). */
export function googleStatusMessage(service: "Google Drive" | "Google Calendar", status: number, body = ""): string {
  if (status === 401) {
    return `${service} didn't accept this phone's sign-in. Disconnect and reconnect your Google account in Settings, then try again.`;
  }
  if (status === 403 && /storageQuotaExceeded/i.test(body)) {
    return "Your Google Drive storage is full. Free up space in Google Drive, then try again.";
  }
  if (status === 429 || (status === 403 && /rateLimit/i.test(body)) || status >= 500) {
    return `${service} is busy right now. Try again in a few minutes.`;
  }
  if (status === 403) {
    return `${service} refused access for Xayra. Disconnect and reconnect your Google account in Settings, then try again.`;
  }
  if (status === 404) {
    return `Something Xayra expected in ${service} wasn't found. Try again in a moment.`;
  }
  return `${service} didn't accept the request. Try again in a few minutes.`;
}
