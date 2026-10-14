/**
 * The vault state machine (services/vault/vaultState.ts): every combination
 * of on-disk facts maps to one safe action, and no combination opens or
 * rebuilds from plaintext once encryption has been established.
 */
import { classifyHeader, decideVaultAction, type FileKind, type VaultFacts } from "../services/vault/vaultState";
import { toRawSqlcipherKey } from "../services/vault/vaultKey";

jest.mock("../services/crypto/keyManager", () => ({
  isWellFormedDatabaseKey: (key: string) => /^[0-9a-f]{64}$/.test(key),
}));

const base: VaultFacts = {
  sqlcipherAvailable: true,
  legacy: "absent",
  vault: "absent",
  vaultDirExists: false,
  pointer: "absent",
  marker: false,
};
const facts = (over: Partial<VaultFacts>): VaultFacts => ({ ...base, ...over });
const KINDS: FileKind[] = ["absent", "empty", "plaintext", "encrypted", "unknown"];

describe("decideVaultAction", () => {
  it("no SQLCipher: fails closed whatever is on disk", () => {
    for (const legacy of KINDS) {
      for (const vault of KINDS) {
        expect(decideVaultAction(facts({ sqlcipherAvailable: false, legacy, vault, pointer: "valid", marker: true }))).toEqual({
          kind: "fail",
          reason: "encryptionUnavailable",
          detail: "sqlcipherMissing",
        });
      }
    }
  });

  it("fresh install: create", () => {
    expect(decideVaultAction(base)).toEqual({ kind: "create", discardUncommitted: false });
  });

  it("legacy plaintext (or empty) and nothing committed: migrate", () => {
    expect(decideVaultAction(facts({ legacy: "plaintext" }))).toEqual({ kind: "migrate", discardUncommitted: false });
    expect(decideVaultAction(facts({ legacy: "empty" }))).toEqual({ kind: "migrate", discardUncommitted: false });
  });

  it("an uncommitted vault from an interrupted attempt is discarded and rebuilt", () => {
    for (const vault of KINDS) {
      const d = decideVaultAction(facts({ legacy: "plaintext", vault, vaultDirExists: true }));
      expect(d).toEqual({ kind: "migrate", discardUncommitted: true });
    }
    expect(decideVaultAction(facts({ vault: "encrypted", vaultDirExists: true }))).toEqual({ kind: "create", discardUncommitted: true });
  });

  it("committed (valid pointer + encrypted vault): open; the legacy file is irrelevant", () => {
    for (const legacy of KINDS) {
      expect(decideVaultAction(facts({ legacy, vault: "encrypted", vaultDirExists: true, pointer: "valid", marker: true }))).toEqual({
        kind: "open",
        ensureMarker: false,
      });
    }
  });

  it("pointer committed but marker missing (crash between them): open and set the marker", () => {
    expect(decideVaultAction(facts({ vault: "encrypted", vaultDirExists: true, pointer: "valid" }))).toEqual({ kind: "open", ensureMarker: true });
  });

  it("once established, never falls back to plaintext — every inconsistency fails closed", () => {
    const conflicts: [Partial<VaultFacts>, string][] = [
      [{ pointer: "valid", vault: "absent", legacy: "plaintext", marker: true }, "pointerVaultAbsent"],
      [{ pointer: "valid", vault: "empty", legacy: "plaintext" }, "pointerVaultEmpty"],
      [{ pointer: "valid", vault: "unknown", legacy: "plaintext" }, "pointerVaultUnknown"],
      [{ pointer: "valid", vault: "plaintext", legacy: "plaintext" }, "vaultNotEncrypted"],
      [{ pointer: "invalid", vault: "encrypted", legacy: "plaintext" }, "pointerInvalid"],
      [{ marker: true, legacy: "plaintext" }, "markerWithoutPointer"],
      [{ marker: true, vault: "encrypted", vaultDirExists: true }, "markerWithoutPointer"],
      [{ marker: true }, "markerWithoutPointer"],
      [{ legacy: "encrypted" }, "legacyEncrypted"],
      [{ legacy: "unknown" }, "legacyUnknown"],
    ];
    for (const [over, detail] of conflicts) {
      expect(decideVaultAction(facts(over))).toEqual({ kind: "fail", reason: "conflict", detail });
    }
  });

  it("exhaustive: no state ever yields an action that opens a plaintext vault or rebuilds over a commitment", () => {
    for (const legacy of KINDS)
      for (const vault of KINDS)
        for (const vaultDirExists of [false, true])
          for (const pointer of ["absent", "valid", "invalid"] as const)
            for (const marker of [false, true]) {
              const d = decideVaultAction({ sqlcipherAvailable: true, legacy, vault, vaultDirExists, pointer, marker });
              if (d.kind === "open") expect(vault).toBe("encrypted");
              if (d.kind === "migrate" || d.kind === "create") {
                expect(pointer).toBe("absent");
                expect(marker).toBe(false);
              }
              if (d.kind === "migrate") expect(["plaintext", "empty"]).toContain(legacy);
              if (d.kind === "create") expect(legacy).toBe("absent");
            }
  });
});

describe("classifyHeader", () => {
  it("recognises plaintext SQLite, empty, short and random headers", () => {
    expect(classifyHeader(4096, "SQLite format 3\u0000")).toBe("plaintext");
    expect(classifyHeader(0, "")).toBe("empty");
    expect(classifyHeader(10, "SQLite for")).toBe("unknown");
    expect(classifyHeader(4096, "Â\u0010ÜDÕI\u0004\u0002ã°æ¨@cb2")).toBe("encrypted");
  });
});

describe("toRawSqlcipherKey", () => {
  it("wraps a 64-hex key in SQLCipher's raw-key blob syntax (67 bytes)", () => {
    const key = "0123456789abcdef".repeat(4);
    const raw = toRawSqlcipherKey(key);
    expect(raw).toBe(`x'${key}'`);
    expect(raw).toHaveLength(67);
  });

  it("refuses anything that isn't 64 lowercase hex characters", () => {
    for (const bad of ["", "abc", "A".repeat(64), "g".repeat(64), "a".repeat(63), "a".repeat(65), `x'${"a".repeat(64)}'`]) {
      expect(() => toRawSqlcipherKey(bad)).toThrow();
    }
  });
});
