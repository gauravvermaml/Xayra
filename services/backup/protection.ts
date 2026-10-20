import * as FileSystem from "expo-file-system/legacy";

import { readProtectedSecret, writeProtectedSecret } from "../crypto/keyManager";
import * as db from "./backupDb";
import type { BackupKey } from "./backupFormat";

/**
 * This phone's side of Extra Privacy.
 *
 * - Local protection record (files/backup-protection.json, not secret): the
 *   mode this phone last established, and whether activation finished. The
 *   account-wide mode lives in Google Drive (newest xayra2-mode-*.json); this
 *   record only drives this phone's UI and never overrides the account.
 * - The Extra Privacy backup key, fingerprint-protected in SecureStore like
 *   the vault key, so backups need a fingerprint, not the recovery code.
 * - Local escrow (files/vault-escrow.db): a SQLCipher file whose passphrase is
 *   the recovery code, holding this phone's vault key and the Extra Privacy
 *   key — so after a fingerprint change the code alone can reopen this phone's
 *   vault, even offline. Without the code it's unreadable.
 */

export type ProtectionState = {
  mode: "standard" | "extra";
  keyId?: string;
  state?: "activating" | "active";
  /** A code replacement committed on this phone (escrow under the new code)
   * whose older keyring epochs, below this one, still need removing. */
  retireBelowEpoch?: number;
  updatedAt?: string;
};

const RECORD_URI = () => `${FileSystem.documentDirectory}backup-protection.json`;
const ESCROW_NAME = "vault-escrow.db";
const docsBare = () => (FileSystem.documentDirectory ?? "").replace(/^file:\/\//, "").replace(/\/$/, "");
const EXTRA_KEY_ID = "xayra.backup.extra-privacy-key";

export async function readLocalProtection(): Promise<ProtectionState> {
  try {
    if (!(await FileSystem.getInfoAsync(RECORD_URI())).exists) return { mode: "standard" };
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(RECORD_URI())) as ProtectionState & { version?: number };
    return parsed.version === 1 && (parsed.mode === "standard" || parsed.mode === "extra") ? parsed : { mode: "standard" };
  } catch {
    return { mode: "standard" };
  }
}

export async function writeLocalProtection(state: ProtectionState): Promise<void> {
  const tmp = `${RECORD_URI()}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify({ version: 1, ...state, updatedAt: new Date().toISOString() }));
  await FileSystem.moveAsync({ from: tmp, to: RECORD_URI() });
}

/** Fingerprint prompt. Null when this phone doesn't hold an Extra Privacy key. */
export async function readExtraKey(): Promise<BackupKey | null> {
  const raw = await readProtectedSecret(EXTRA_KEY_ID);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { keyId?: string; key?: string };
    return typeof parsed.keyId === "string" && typeof parsed.key === "string" && /^[0-9a-f]{64}$/.test(parsed.key)
      ? { keyId: parsed.keyId, key: parsed.key, mode: "extra" }
      : null;
  } catch {
    return null;
  }
}

export async function storeExtraKey(key: BackupKey): Promise<void> {
  await writeProtectedSecret(EXTRA_KEY_ID, JSON.stringify({ keyId: key.keyId, key: key.key }));
}

export type EscrowContents = { vaultKeyHex: string; vaultId: string; extraKey: BackupKey | null };

/** Writes the escrow under the recovery code: built beside it, verified, then
 * renamed into place, so an interruption never leaves a half-written escrow. */
export async function writeEscrow(recoveryCode: string, contents: EscrowContents): Promise<void> {
  const dir = docsBare();
  const tmpName = `${ESCROW_NAME}.tmp`;
  await FileSystem.deleteAsync(`file://${dir}/${tmpName}`, { idempotent: true });
  await db.writeSecretContainer(dir, tmpName, recoveryCode, {
    vault_key: contents.vaultKeyHex,
    vault_id: contents.vaultId,
    extra_key_id: contents.extraKey?.keyId ?? "",
    extra_key: contents.extraKey?.key ?? "",
  });
  const check = await db.readSecretContainer(dir, tmpName, recoveryCode);
  if (check?.vault_key !== contents.vaultKeyHex) {
    throw new Error("The recovery copy on this phone didn't verify.");
  }
  await FileSystem.moveAsync({ from: `file://${dir}/${tmpName}`, to: `file://${dir}/${ESCROW_NAME}` });
}

/** Null when there is no escrow or the code doesn't open it. */
export async function readEscrow(recoveryCode: string): Promise<EscrowContents | null> {
  const dir = docsBare();
  if (!(await FileSystem.getInfoAsync(`file://${dir}/${ESCROW_NAME}`)).exists) return null;
  const values = await db.readSecretContainer(dir, ESCROW_NAME, recoveryCode);
  if (!values || !/^[0-9a-f]{64}$/.test(values.vault_key ?? "")) return null;
  return {
    vaultKeyHex: values.vault_key,
    vaultId: values.vault_id ?? "",
    extraKey: values.extra_key_id && values.extra_key ? { keyId: values.extra_key_id, key: values.extra_key, mode: "extra" } : null,
  };
}
