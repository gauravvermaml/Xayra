import * as FileSystem from "expo-file-system/legacy";

import { DriveSyncError } from "../sync/driveErrors";

/**
 * Which Google account this phone's vault backs up to and restores from.
 * Bound on the first successful backup or restore; afterwards a different
 * signed-in account is refused for both, so notes are never merged into, or
 * restored from, someone else's Drive by accident. Switching is an explicit
 * choice (`rebindBackupAccount`). Stores only Google's stable account id —
 * no email, no tokens. files/backup-account.json.
 */

const BINDING_URI = () => `${FileSystem.documentDirectory}backup-account.json`;

export class BackupAccountMismatchError extends DriveSyncError {
  constructor() {
    super(
      "This phone backs up to a different Google account. Switch back to that account, or choose to use this account for backups instead."
    );
    this.name = "BackupAccountMismatchError";
  }
}

export async function readBoundAccountId(): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(BINDING_URI());
    if (!info.exists) return null;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(BINDING_URI())) as { version?: number; accountId?: string };
    return parsed.version === 1 && typeof parsed.accountId === "string" && parsed.accountId ? parsed.accountId : null;
  } catch {
    // Unreadable binding: treat as "bound to someone else" — never as unbound.
    return "unreadable";
  }
}

export async function assertAccountAllowed(accountId: string): Promise<void> {
  const bound = await readBoundAccountId();
  if (bound !== null && bound !== accountId) {
    throw new BackupAccountMismatchError();
  }
}

async function writeBinding(accountId: string): Promise<void> {
  const tmp = `${BINDING_URI()}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify({ version: 1, accountId, boundAt: new Date().toISOString() }));
  await FileSystem.moveAsync({ from: tmp, to: BINDING_URI() });
}

/** Binds an unbound phone after its first verified backup or restore. */
export async function bindIfUnbound(accountId: string): Promise<void> {
  if ((await readBoundAccountId()) === null) {
    await writeBinding(accountId);
  }
}

/** The user explicitly chose to back up to the signed-in account instead. */
export async function rebindBackupAccount(accountId: string): Promise<void> {
  await writeBinding(accountId);
}
