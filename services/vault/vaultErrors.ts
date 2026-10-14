/**
 * Why the encrypted vault couldn't be made ready. Every kind leaves the
 * legacy plaintext database exactly as it was; none deletes or recreates a
 * committed vault.
 *  - `encryptionUnavailable`: this build has no SQLCipher. Nothing is opened.
 *  - `conflict`: what's on disk doesn't match any safe state (e.g. a pointer
 *    without its vault). Fails closed; never falls back to a plaintext file.
 *  - `insufficientStorage`: not enough free space to migrate safely.
 *  - `migrationFailed`: a migration step failed (copy, export, verification,
 *    rename, pointer write). The next attempt starts again from the untouched
 *    legacy database.
 */
export type VaultStateErrorKind = "encryptionUnavailable" | "conflict" | "insufficientStorage" | "migrationFailed";

export class VaultStateError extends Error {
  readonly kind: VaultStateErrorKind;
  /** Short machine-readable reason for logs (never contains note text). */
  readonly detail: string;
  readonly neededBytes?: number;

  constructor(kind: VaultStateErrorKind, detail: string, options: { neededBytes?: number; cause?: unknown } = {}) {
    super(`Vault ${kind}: ${detail}`);
    this.name = "VaultStateError";
    this.kind = kind;
    this.detail = detail;
    this.neededBytes = options.neededBytes;
    if (options.cause !== undefined) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
