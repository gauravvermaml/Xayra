import { RecoveryCodeIncorrectError } from "../backup/backupErrors";
import { userFacingMessage } from "../errors/userMessage";
import { restoreFromDrive, type RestoreResult } from "./driveSync";

/**
 * A restore with the recovery code (an Extra Privacy backup), as both
 * Settings and Archive offer it through `RecoveryCodePrompt`. The restore
 * itself is the one in backupService (merge-only: it adds what's missing and
 * never removes or overwrites notes on this phone); this only turns its
 * outcome into what the prompt shows. A wrong code or a failed restore leaves
 * the phone's notes exactly as they were.
 */
export type CodeRestoreOutcome =
  | { kind: "restored"; result: RestoreResult }
  | { kind: "wrongCode"; message: string }
  | { kind: "failed"; message: string };

export async function restoreWithRecoveryCode(
  code: string,
  restore: (options: { recoveryCode: string }) => Promise<RestoreResult> = restoreFromDrive
): Promise<CodeRestoreOutcome> {
  try {
    return { kind: "restored", result: await restore({ recoveryCode: code }) };
  } catch (err) {
    if (err instanceof RecoveryCodeIncorrectError) {
      return { kind: "wrongCode", message: err.message };
    }
    return { kind: "failed", message: `${userFacingMessage(err, "The backup couldn't be restored.")} Nothing was changed.` };
  }
}
