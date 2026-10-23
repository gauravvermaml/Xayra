/**
 * Restore merge rules (services/backup/restoreMerge.ts) — pure, synthetic
 * records only.
 */
import {
  newestPerId,
  planNoteRestore,
  planToDoRestore,
  versionsById,
  type NoteVersion,
  type ToDoVersion,
} from "../services/backup/restoreMerge";

const note = (id: string, content: string, updatedAt: number | null): NoteVersion => ({ id, content, transcript: null, updatedAt });
const todo = (id: string, text: string, updatedAt: number | null, extra: Partial<ToDoVersion> = {}): ToDoVersion => ({
  id,
  text,
  actionDate: "2026-11-02",
  toDate: null,
  notificationTime: "09:00",
  isCompleted: false,
  recurrence: "none",
  recurrenceInterval: 1,
  noteId: null,
  updatedAt,
  ...extra,
});
/** One verified backup holding exactly these versions. */
const backups = <R extends { id: string }>(...heads: R[][]) => versionsById(heads);

describe("notes", () => {
  it("a newer backup copy replaces an older phone copy that is itself backed up", () => {
    const phone = note("n1", "Booked the dentist", 100);
    const cloud = note("n1", "Booked the dentist for Tuesday", 200);
    const plan = planNoteRestore([phone], [cloud], backups([phone], [cloud]));
    expect(plan.updates).toEqual([cloud]);
    expect(plan.conflicts).toEqual([]);
  });

  it("a newer phone copy is kept over an older backup copy", () => {
    const phone = note("n1", "edited on the phone", 300);
    const cloud = note("n1", "original", 200);
    expect(planNoteRestore([phone], [cloud], backups([cloud]))).toEqual({ updates: [], conflicts: [] });
  });

  it("the same text is never touched, whatever the timestamps say", () => {
    expect(planNoteRestore([note("n1", "same", 100)], [note("n1", "same", 999)], backups([note("n1", "same", 999)]))).toEqual({ updates: [], conflicts: [] });
  });

  it("equal timestamps with different text: the phone's is kept and reported", () => {
    const plan = planNoteRestore([note("n1", "phone", 200)], [note("n1", "cloud", 200)], backups([note("n1", "phone", 100)]));
    expect(plan).toEqual({ updates: [], conflicts: [{ id: "n1", reason: "same-time-different-content" }] });
  });

  it("a phone change that is in no backup is never overwritten — even by a 'newer' copy (a copy time can be later than an edit)", () => {
    const phone = note("n1", "edited, not yet backed up", 150);
    const cloud = note("n1", "older text, copied into the backup later", 200);
    const plan = planNoteRestore([phone], [cloud], backups([cloud]));
    expect(plan).toEqual({ updates: [], conflicts: [{ id: "n1", reason: "phone-change-not-backed-up" }] });
  });

  it("a backup copy without a timestamp (older backups) never replaces anything", () => {
    const plan = planNoteRestore([note("n1", "phone", 100)], [note("n1", "cloud", null)], backups([note("n1", "phone", 100)]));
    expect(plan).toEqual({ updates: [], conflicts: [{ id: "n1", reason: "backup-has-no-time" }] });
  });

  it("records only in the backup are left to the insert path; records only on the phone are kept", () => {
    const plan = planNoteRestore([note("phoneOnly", "x", 1)], [note("cloudOnly", "y", 2)], backups([note("cloudOnly", "y", 2)]));
    expect(plan).toEqual({ updates: [], conflicts: [] });
  });

  it("repeating the restore changes nothing (idempotent)", () => {
    const phone = note("n1", "old", 100);
    const cloud = note("n1", "new", 200);
    const first = planNoteRestore([phone], [cloud], backups([phone], [cloud]));
    const afterFirst = first.updates.map((u) => ({ ...u }));
    expect(planNoteRestore(afterFirst, [cloud], backups([phone], [cloud]))).toEqual({ updates: [], conflicts: [] });
  });
});

describe("to-dos", () => {
  it("a newer backup copy replaces the whole to-do: text, date, completion and recurrence together", () => {
    const phone = todo("t1", "Water plants", 1_000, { recurrence: "weekly", isCompleted: false });
    const cloud = todo("t1", "Water plants and herbs", 2_000, { recurrence: "daily", recurrenceInterval: 2, isCompleted: true, actionDate: "2026-11-05" });
    expect(planToDoRestore([phone], [cloud], backups([phone], [cloud])).updates).toEqual([cloud]);
  });

  it("a newer phone copy is kept", () => {
    expect(planToDoRestore([todo("t1", "phone", 3_000)], [todo("t1", "cloud", 2_000)], backups([todo("t1", "cloud", 2_000)])).updates).toEqual([]);
  });

  it("a change to completion alone counts as a difference", () => {
    const phone = todo("t1", "Call Mum", 1_000);
    const cloud = todo("t1", "Call Mum", 2_000, { isCompleted: true });
    expect(planToDoRestore([phone], [cloud], backups([phone], [cloud])).updates).toEqual([cloud]);
  });

  it("equal timestamps with different content: kept and reported", () => {
    const plan = planToDoRestore([todo("t1", "a", 5)], [todo("t1", "b", 5)], backups([todo("t1", "a", 5)]));
    expect(plan.conflicts).toEqual([{ id: "t1", reason: "same-time-different-content" }]);
  });

  describe("to-dos from before timestamps existed", () => {
    it("a backup copy without a timestamp never replaces the phone's", () => {
      const plan = planToDoRestore([todo("t1", "phone", null)], [todo("t1", "cloud", null)], backups([todo("t1", "phone", null)]));
      expect(plan).toEqual({ updates: [], conflicts: [{ id: "t1", reason: "backup-has-no-time" }] });
    });

    it("a stamped backup copy replaces an unstamped phone copy that is backed up (it changed after timestamps existed)", () => {
      const phone = todo("t1", "old", null);
      const cloud = todo("t1", "changed later", 2_000);
      expect(planToDoRestore([phone], [cloud], backups([phone], [cloud])).updates).toEqual([cloud]);
    });

    it("…but not when the phone's unstamped version is in no backup", () => {
      const plan = planToDoRestore([todo("t1", "never backed up", null)], [todo("t1", "cloud", 2_000)], backups([todo("t1", "cloud", 2_000)]));
      expect(plan.conflicts).toEqual([{ id: "t1", reason: "phone-change-not-backed-up" }]);
    });
  });
});

describe("several phones' backups (heads), newest first", () => {
  it("each record's newest version is chosen across heads", () => {
    const fromA = [note("n1", "A's newer edit", 300), note("a1", "only A", 10)];
    const fromB = [note("n1", "B's older copy", 200), note("b1", "only B", 20)];
    expect(newestPerId([fromB, fromA]).sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      note("a1", "only A", 10),
      note("b1", "only B", 20),
      note("n1", "A's newer edit", 300),
    ]);
  });

  it("a copy without a timestamp loses to one with; a tie keeps the newest head's copy", () => {
    expect(newestPerId([[note("n1", "untimed", null)], [note("n1", "timed", 1)]])).toEqual([note("n1", "timed", 1)]);
    expect(newestPerId([[note("n1", "newest head", 5)], [note("n1", "older head", 5)]])).toEqual([note("n1", "newest head", 5)]);
  });

  it("the phone's version counts as backed up when ANY head holds it", () => {
    const phone = note("n1", "B's version", 200);
    const newest = note("n1", "A's newer edit", 300);
    expect(planNoteRestore([phone], [newest], backups([newest], [phone])).updates).toEqual([newest]);
  });
});
