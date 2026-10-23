import { RESTORE_KEPT_ITEMS_SENTENCE, restoreSummary, restoreTitle } from "../services/sync/restoreSummary";

const FROM = "your backup of 23 Oct 2026";

describe("restore summary", () => {
  it("added and updated records", () => {
    expect(restoreSummary({ from: FROM, addedNotes: 2, addedTodos: 1, updatedNotes: 1 })).toBe(
      "Restored 2 notes and 1 to-do from your backup of 23 Oct 2026. Updated 1 note to a newer version from it."
    );
    expect(restoreSummary({ from: FROM, addedNotes: 0, addedTodos: 0, updatedTodos: 2 })).toBe(
      "Updated 2 to-dos to a newer version from your backup of 23 Oct 2026."
    );
  });

  it("kept items are mentioned, and the phone is never said to have everything", () => {
    const kept = restoreSummary({ from: FROM, addedNotes: 0, addedTodos: 0, conflicts: 3 });
    expect(kept).toBe(`Restore completed. ${RESTORE_KEPT_ITEMS_SENTENCE}`);
    expect(kept).not.toMatch(/already include everything/);
    expect(restoreSummary({ from: FROM, addedNotes: 1, addedTodos: 0, conflicts: 1 })).toBe(
      `Restore completed. Restored 1 note from your backup of 23 Oct 2026. ${RESTORE_KEPT_ITEMS_SENTENCE}`
    );
  });

  it("nothing to do", () => {
    expect(restoreSummary({ from: FROM, addedNotes: 0, addedTodos: 0, updatedNotes: 0, updatedTodos: 0, conflicts: 0 })).toBe(
      "Your notes already include everything in your backup of 23 Oct 2026."
    );
  });

  it("the title is 'Already up to date' only when nothing was added, updated or kept", () => {
    expect(restoreTitle({ restoredCount: 0, restoredToDoCount: 0 })).toBe("Already up to date");
    expect(restoreTitle({ restoredCount: 0, restoredToDoCount: 0, updatedCount: 1 })).toBe("Notes restored");
    expect(restoreTitle({ restoredCount: 0, restoredToDoCount: 0, keptCount: 2 })).toBe("Restore completed");
    expect(restoreTitle({ restoredCount: 1, restoredToDoCount: 0, keptCount: 2 })).toBe("Notes restored");
  });
});
