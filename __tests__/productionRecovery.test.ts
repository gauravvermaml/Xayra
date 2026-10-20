/**
 * "Recover my notes" is available in every build, production included — but
 * only for a vault whose key is genuinely gone. Cancelled or locked-out
 * prompts and storage errors keep the ordinary Unlock retry, so recovery can
 * never stand in for normal authentication.
 */
import * as fs from "fs";
import * as path from "path";

jest.mock("../services/crypto/keyManager", () => {
  class AuthenticationFailedError extends Error {
    reason: string;
    constructor(reason: string) {
      super(reason);
      this.reason = reason;
    }
  }
  class DatabaseKeyError extends Error {
    kind: string;
    constructor(kind: string) {
      super(kind);
      this.kind = kind;
    }
  }
  return { AuthenticationFailedError, DatabaseKeyError };
});

import { AuthenticationFailedError, DatabaseKeyError } from "../services/crypto/keyManager";
import { canRecoverOriginalVault, vaultLockReasonFor, type VaultLockReason } from "../services/crypto/vaultLockState";

const NEVER: VaultLockReason[] = [
  "userCancelled",
  "systemCancelled",
  "timeout",
  "lockout",
  "lockoutPermanent",
  "keyUnavailable",
  "databaseError",
  "encryptionUnavailable",
  "vaultConflict",
  "insufficientStorage",
  "migrationFailed",
];

it("is offered for a missing or invalidated key (SecureStore returns no key for an existing vault)", () => {
  const reason = vaultLockReasonFor(new (DatabaseKeyError as unknown as new (k: string) => Error)("missing"));
  expect(reason).toBe("keyMissing");
  expect(canRecoverOriginalVault(reason)).toBe(true);
});

it.each(NEVER)("is not offered for %s", (reason) => {
  expect(canRecoverOriginalVault(reason)).toBe(false);
});

it("a cancelled prompt or an unreadable key store never leads to recovery", () => {
  const cancelled = vaultLockReasonFor(new (AuthenticationFailedError as unknown as new (r: string) => Error)("userCancelled"));
  const unavailable = vaultLockReasonFor(new (DatabaseKeyError as unknown as new (k: string) => Error)("unavailable"));
  expect(canRecoverOriginalVault(cancelled)).toBe(false);
  expect(canRecoverOriginalVault(unavailable)).toBe(false);
  expect(canRecoverOriginalVault(null)).toBe(false);
});

it("the root layout offers it in every build — no development-package gate", () => {
  const layout = fs.readFileSync(path.join(__dirname, "..", "app", "_layout.tsx"), "utf8");
  expect(layout).toMatch(/const recoveryAvailable = canRecoverOriginalVault\(lockReason\);/);
  expect(layout).not.toMatch(/isRunningDevPackage/);
});
