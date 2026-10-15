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

