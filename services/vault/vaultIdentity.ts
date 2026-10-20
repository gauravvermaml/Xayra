import * as Crypto from "expo-crypto";
import * as FileSystem from "expo-file-system/legacy";

/**
 * This phone's vault identity and, for the running process, its vault key.
 *
 * - `vaultId`: a random id stored OUTSIDE the encrypted vault
 *   (files/vault-identity.json, not secret), so it can still be read when the
 *   vault is locked — recovery uses it to find this phone's own key entry in
 *   the Google Drive backup. Created once, never changed.
 * - The session vault key: the hex key the vault was opened with in this
 *   process (vaultActivation.ts sets it), so a backup can record this phone's
 *   key entry without a second fingerprint prompt. Held in memory only, like
 *   the open database connection itself already holds it.
 */

const IDENTITY_URI = () => `${FileSystem.documentDirectory}vault-identity.json`;
const UUID = /^[0-9a-f-]{36}$/;

export async function readVaultId(): Promise<string | null> {
  try {
    const info = await FileSystem.getInfoAsync(IDENTITY_URI());
    if (!info.exists) return null;
    const parsed = JSON.parse(await FileSystem.readAsStringAsync(IDENTITY_URI())) as { version?: number; vaultId?: string };
    return parsed.version === 1 && typeof parsed.vaultId === "string" && UUID.test(parsed.vaultId) ? parsed.vaultId : null;
  } catch {
    return null;
  }
}

export async function getOrCreateVaultId(): Promise<string> {
  const existing = await readVaultId();
  if (existing) return existing;
  const vaultId = Crypto.randomUUID().toLowerCase();
  const tmp = `${IDENTITY_URI()}.tmp`;
  await FileSystem.writeAsStringAsync(tmp, JSON.stringify({ version: 1, vaultId, createdAt: new Date().toISOString() }));
  await FileSystem.moveAsync({ from: tmp, to: IDENTITY_URI() });
  const written = await readVaultId();
  if (written !== vaultId) {
    throw new Error("Couldn't record this phone's vault identity.");
  }
  return vaultId;
}

let sessionVaultKeyHex: string | null = null;

/** Called by vaultActivation.ts with the key the normal vault was opened with. */
export function setSessionVaultKey(hexKey: string): void {
  sessionVaultKeyHex = hexKey;
}

export function getSessionVaultKey(): string | null {
  return sessionVaultKeyHex;
}
