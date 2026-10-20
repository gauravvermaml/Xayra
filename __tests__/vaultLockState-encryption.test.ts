/**
 * Vault preparation failures (services/vault/vaultErrors.ts) map to their own
 * lock states, so the splash explains them instead of a generic error.
 */
jest.mock("../services/crypto/keyManager", () => ({
  AuthenticationFailedError: class extends Error {},
  DatabaseKeyError: class extends Error {},
}));

import { isExpectedLockReason, vaultLockReasonFor } from "../services/crypto/vaultLockState";
import { VaultStateError } from "../services/vault/vaultErrors";

it.each([
  ["encryptionUnavailable", "encryptionUnavailable"],
  ["conflict", "vaultConflict"],
  ["insufficientStorage", "insufficientStorage"],
  ["migrationFailed", "migrationFailed"],
] as const)("%s → %s, reported as a fault", (kind, reason) => {
  const mapped = vaultLockReasonFor(new VaultStateError(kind, "x"));
  expect(mapped).toBe(reason);
  expect(isExpectedLockReason(mapped)).toBe(false);
});
