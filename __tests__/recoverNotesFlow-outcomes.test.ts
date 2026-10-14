/**
 * Every way a recovery check can fail tells the user nothing was changed —
 * and only a proven match leads on to the confirm step.
 */
jest.mock("../services/crypto/keyManager", () => ({}));
jest.mock("../services/recovery/originalVaultRecovery", () => ({}));
jest.mock("../services/sync/driveSync", () => ({}));

const { outcomeForProbe } = require("../components/RecoverNotesFlow");

describe("outcomeForProbe", () => {
  it("a match has no failure outcome (it goes on to the confirm step)", () => {
    expect(outcomeForProbe({ kind: "match", journalMode: "delete" })).toBeNull();
  });

  it.each([
    { kind: "doesNotOpen" },
    { kind: "corrupt" },
    { kind: "malformedKey" },
    { kind: "noVault" },
    { kind: "insufficientStorage", neededBytes: 300 * 1024 * 1024, freeBytes: 100 * 1024 * 1024 },
    { kind: "copyFailed" },
  ])("%o explains itself and says nothing was changed", (result) => {
    const outcome = outcomeForProbe(result);
    expect(outcome?.title.length).toBeGreaterThan(0);
    expect(outcome?.detail).toMatch(/Nothing was changed\.$/);
  });

  it("states how much space to free", () => {
    const outcome = outcomeForProbe({ kind: "insufficientStorage", neededBytes: 300 * 1024 * 1024, freeBytes: 100 * 1024 * 1024 });
    expect(outcome?.detail).toContain("200 MB");
  });
});
