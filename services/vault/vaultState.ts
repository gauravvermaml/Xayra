/**
 * The vault activation state machine, as a pure function of what's on disk.
 *
 * Every launch re-derives the state from facts — never from the migration
 * journal alone, and never assuming the pointer and the journal were written
 * together. The rules that make this crash-safe:
 *
 *  1. Nothing the user writes reaches an encrypted vault before its pointer
 *     is committed: the app only opens a vault through a committed pointer.
 *     So an uncommitted vault (no pointer) is always a derived copy, safe to
 *     discard and rebuild.
 *  2. The pointer (files/vault-pointer.json, written temp-then-rename) is the
 *     single commit point. Once it exists, the legacy plaintext database is
 *     never opened again.
 *  3. The marker (a SecureStore flag) is set only after the pointer, as a
 *     second, independent witness that encryption was established. Marker
 *     without pointer means the pointer was lost: fail closed, never rebuild
 *     from (possibly stale) plaintext.
 *  4. The legacy plaintext database is never written, moved or deleted.
 *  5. A plaintext header where an encrypted vault should be is never opened.
 */

/** What a database file's first 16 bytes say. */
export type FileKind = "absent" | "empty" | "plaintext" | "encrypted" | "unknown";

export type PointerState = "absent" | "valid" | "invalid";

export type VaultFacts = {
  sqlcipherAvailable: boolean;
  /** databases/silent-confidant.sqlite — the pre-encryption vault. */
  legacy: FileKind;
  /** files/vault/xayra.sqlite. */
  vault: FileKind;
  /** files/vault/ exists (even without a database inside). */
  vaultDirExists: boolean;
  pointer: PointerState;
  marker: boolean;
};

export type VaultDecision =
  /** Open the committed vault. `ensureMarker`: the pointer exists but the
   * marker write didn't happen yet (crash between the two) — set it. */
  | { kind: "open"; ensureMarker: boolean }
  /** Build an encrypted copy of the legacy plaintext vault and commit it.
   * `discardUncommitted`: remove a previous attempt's uncommitted vault first. */
  | { kind: "migrate"; discardUncommitted: boolean }
  /** No vault anywhere: create a new encrypted one and commit it. */
  | { kind: "create"; discardUncommitted: boolean }
  | { kind: "fail"; reason: "encryptionUnavailable" | "conflict"; detail: string };

export function decideVaultAction(facts: VaultFacts): VaultDecision {
  if (!facts.sqlcipherAvailable) {
    return { kind: "fail", reason: "encryptionUnavailable", detail: "sqlcipherMissing" };
  }
  if (facts.pointer === "invalid") {
    return { kind: "fail", reason: "conflict", detail: "pointerInvalid" };
  }
  if (facts.pointer === "valid") {
    if (facts.vault === "encrypted") {
      return { kind: "open", ensureMarker: !facts.marker };
    }
    if (facts.vault === "plaintext") {
      return { kind: "fail", reason: "conflict", detail: "vaultNotEncrypted" };
    }
    return { kind: "fail", reason: "conflict", detail: `pointerVault${capitalize(facts.vault)}` };
  }
  // No pointer: nothing is committed.
  if (facts.marker) {
    return { kind: "fail", reason: "conflict", detail: "markerWithoutPointer" };
  }
  const discardUncommitted = facts.vaultDirExists || facts.vault !== "absent";
  if (facts.legacy === "plaintext" || facts.legacy === "empty") {
    return { kind: "migrate", discardUncommitted };
  }
  if (facts.legacy === "absent") {
    return { kind: "create", discardUncommitted };
  }
  return { kind: "fail", reason: "conflict", detail: `legacy${capitalize(facts.legacy)}` };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const SQLITE_HEADER = "SQLite format 3\u0000";

/** Classifies a database file from its size and first bytes (as a binary
 * string). A random-looking header is "encrypted" — only opening it with
 * the key can prove it isn't merely corrupt. */
export function classifyHeader(size: number, firstBytes: string): FileKind {
  if (size === 0) return "empty";
  if (size < 16 || firstBytes.length < 16) return "unknown";
  return firstBytes.slice(0, 16) === SQLITE_HEADER ? "plaintext" : "encrypted";
}
