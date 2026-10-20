import { DriveSyncError } from "../sync/driveErrors";

/** The newest backup is Extra Privacy-protected and this phone doesn't hold
 * its key: the recovery code is needed (restore, or joining this phone). */
export class RecoveryCodeRequiredError extends DriveSyncError {
  constructor() {
    super("Your backup is protected by Extra Privacy. Enter your recovery code to continue.");
    this.name = "RecoveryCodeRequiredError";
  }
}

/** The code didn't open the protected backup key (wrong code, or a typo the
 * check characters didn't catch). Nothing was changed. */
export class RecoveryCodeIncorrectError extends DriveSyncError {
  constructor() {
    super("That recovery code doesn't unlock this backup. Check it and try again. Nothing was changed.");
    this.name = "RecoveryCodeIncorrectError";
  }
}

/** Extra Privacy is on for this account but this phone hasn't been given the
 * key yet; backing up needs the recovery code once. Nothing was uploaded. */
export class ExtraPrivacyKeyNeededError extends DriveSyncError {
  constructor() {
    super("Your backups use Extra Privacy. Enter your recovery code on this phone once to keep backing up. Nothing was uploaded.");
    this.name = "ExtraPrivacyKeyNeededError";
  }
}

/** A protection change committed (the account switched mode) but its final
 * step — marking the new backup verified — didn't finish. The account is in
 * the new mode; the next backup completes it. */
export class ProtectionChangeUnfinishedError extends DriveSyncError {
  constructor(public readonly mode: "standard" | "extra") {
    super(
      `${mode === "extra" ? "Extra Privacy" : "Standard Protection"} is on, but the last check of the new backup didn't finish. Tap Back Up Now to finish it.`
    );
    this.name = "ProtectionChangeUnfinishedError";
  }
}
