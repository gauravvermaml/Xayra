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

/**
 * Google Drive backup and restore are paused: the vault is now SQLCipher-
 * encrypted, and the legacy backup format (a plaintext snapshot with its key
 * uploaded beside it) must not carry encrypted-vault data, nor be overwritten.
 * The protected format (recovery-code-wrapped key) replaces it in a later
 * stage. The legacy Drive files are left exactly as they are.
 */
export class BackupPausedError extends DriveSyncError {
  readonly title: string;

  constructor(action: "backup" | "restore") {
    super(
      action === "backup"
        ? "Google Drive backup is paused while Xayra moves to protected, encrypted backups. Your notes are encrypted on this phone, and your existing Drive backup is left as it is. Nothing was uploaded."
        : "Restoring from Google Drive is paused while Xayra moves to protected, encrypted backups. Your existing Drive backup is left as it is, and nothing on this phone was changed."
    );
    this.name = "BackupPausedError";
    this.title = action === "backup" ? "Backup paused" : "Restore paused";
  }
}

/** While true, backupToDrive()/restoreFromDrive() refuse before any network
 * or file work. Lifted only when the recovery-code-protected format ships. */
export const DRIVE_BACKUP_PAUSED = true;
