import { AuthenticationFailedError, DatabaseKeyError } from "./keyManager";
import type { UnlockFailureReason } from "./unlockErrors";

/**
 * Why the vault is still closed after an unlock attempt — one explicit state
 * per outcome, each with a retry (app/_layout.tsx, components/AppSplashScreen.tsx).
 */
export type VaultLockReason =
  | UnlockFailureReason
  /** SecureStore/Keystore failed, or an unrecognised authentication result. */
  | "keyUnavailable"
  /** A vault exists but its key is gone; no replacement key is minted. */
  | "keyMissing"
  /** The key was obtained but opening/initialising the database failed. */
  | "databaseError";

/** Maps whatever an unlock attempt threw to its lock state. Anything not
 * typed by keyManager is a database failure — never an authentication one. */
export function vaultLockReasonFor(err: unknown): VaultLockReason {
  if (err instanceof AuthenticationFailedError) {
    return err.reason;
  }
  if (err instanceof DatabaseKeyError) {
    return err.kind === "missing" ? "keyMissing" : "keyUnavailable";
  }
  return "databaseError";
}

/** Outcomes the user caused or can wait out — not faults worth an error log. */
export function isExpectedLockReason(reason: VaultLockReason): boolean {
  return (
    reason === "userCancelled" ||
    reason === "systemCancelled" ||
    reason === "timeout" ||
    reason === "lockout" ||
    reason === "lockoutPermanent"
  );
}

/**
 * Wraps an unlock attempt so at most one runs at a time — and so at most one
 * biometric prompt can be showing, however fast Unlock is tapped. A call
 * while one is in flight returns `null` and starts nothing; once the attempt
 * settles (resolved or rejected) the next call starts a fresh one.
 */
export function singleFlight<T>(attempt: () => Promise<T>): () => Promise<T> | null {
  let inFlight = false;
  return () => {
    if (inFlight) {
      return null;
    }
    inFlight = true;
    let running: Promise<T>;
    try {
      running = attempt();
    } catch (err) {
      running = Promise.reject(err);
    }
    return running.finally(() => {
      inFlight = false;
    });
  };
}
