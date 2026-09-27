import {
  enumerateRangeDates,
  filterToDosByRange,
  getDateRangeForMode,
  groupToDosByDate,
  isToDoInRange,
  startOfWeek,
  startOfWorkWeek,
  stepSelectedDate,
  type CalendarLayoutMode,
} from "../services/calendar/dateRange";

// Minimal shape — every function under test only ever reads
// actionDate/toDate/notificationTime, so a full ToDo isn't needed here.
type FakeToDo = { id: string; actionDate: string; toDate: string | null; notificationTime: string };

function makeToDo(id: string, actionDate: string, toDate: string | null = null, notificationTime = "09:00"): FakeToDo {
  return { id, actionDate, toDate, notificationTime };
}

describe("getDateRangeForMode — layout state switches", () => {
  it("Day: a single-day range equal to the selected date", () => {
    expect(getDateRangeForMode("day", "2026-09-25")).toEqual({ start: "2026-09-25", end: "2026-09-25" });
  });

  it("Work Week: Monday-Friday of the week containing the selected date", () => {
    // 2026-09-25 is a Friday.
    expect(getDateRangeForMode("work_week", "2026-09-25")).toEqual({ start: "2026-09-21", end: "2026-09-25" });
  });

  it("Week: Sunday-Saturday of the week containing the selected date", () => {
    expect(getDateRangeForMode("week", "2026-09-25")).toEqual({ start: "2026-09-20", end: "2026-09-26" });
  });

  it("Month: the first-to-last day of the selected date's month", () => {
    expect(getDateRangeForMode("month", "2026-09-25")).toEqual({ start: "2026-09-01", end: "2026-09-30" });
  });

  it("Month: correctly handles February in a leap year", () => {
    expect(getDateRangeForMode("month", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });

  it("Schedule: null — not a navigable range", () => {
    expect(getDateRangeForMode("schedule", "2026-09-25")).toBeNull();
  });

  it("switching between every mode for the same anchor date produces a distinct range each time", () => {
    const modes: CalendarLayoutMode[] = ["day", "work_week", "week", "month"];
    const ranges = modes.map((mode) => JSON.stringify(getDateRangeForMode(mode, "2026-09-25")));
    expect(new Set(ranges).size).toBe(modes.length);
  });
});

describe("startOfWorkWeek — weekend anchoring", () => {
  it("anchors a Saturday forward to the following Monday, not backward", () => {
    // 2026-09-26 is a Saturday.
    expect(startOfWorkWeek("2026-09-26")).toBe("2026-09-28");
  });

  it("anchors a Sunday forward to the next day's Monday", () => {
    // 2026-09-27 is a Sunday.
    expect(startOfWorkWeek("2026-09-27")).toBe("2026-09-28");
  });

  it("a weekday anchors to its own week's Monday", () => {
    // 2026-09-24 is a Thursday.
    expect(startOfWorkWeek("2026-09-24")).toBe("2026-09-21");
  });
});

describe("startOfWeek", () => {
  it("a Sunday anchors to itself", () => {
    expect(startOfWeek("2026-09-20")).toBe("2026-09-20");
  });
});

describe("stepSelectedDate — Previous/Next navigation", () => {
  it("Day mode steps by one day", () => {
    expect(stepSelectedDate("day", "2026-09-25", 1)).toBe("2026-09-26");
    expect(stepSelectedDate("day", "2026-09-25", -1)).toBe("2026-09-24");
  });

  it("Work Week and Week modes both step by a whole week", () => {
    expect(stepSelectedDate("work_week", "2026-09-25", 1)).toBe("2026-10-02");
    expect(stepSelectedDate("week", "2026-09-25", -1)).toBe("2026-09-18");
  });

  it("Month mode steps by a whole calendar month, including across a year boundary", () => {
    // Anchors to day 1 of the target month — Month view only cares which
    // month is showing, never the exact day within it (see shiftIsoMonth's
    // own doc comment), so the day-of-month is deliberately not preserved.
    expect(stepSelectedDate("month", "2026-12-15", 1)).toBe("2027-01-01");
    expect(stepSelectedDate("month", "2026-01-15", -1)).toBe("2025-12-01");
  });

  it("Month mode does not overflow on a day that doesn't exist in the target month", () => {
    // Jan 31 -> Feb should not silently roll into March.
    expect(stepSelectedDate("month", "2026-01-31", 1)).toBe("2026-02-01");
  });

  it("Schedule mode is a no-op — it has no navigable concept", () => {
    expect(stepSelectedDate("schedule", "2026-09-25", 1)).toBe("2026-09-25");
    expect(stepSelectedDate("schedule", "2026-09-25", -1)).toBe("2026-09-25");
  });
});

describe("isToDoInRange / filterToDosByRange — date range filtering", () => {
  const range = { start: "2026-09-21", end: "2026-09-25" };

  it("includes a single-day to-do whose actionDate falls inside the range", () => {
    expect(isToDoInRange(makeToDo("a", "2026-09-23"), range)).toBe(true);
  });

  it("excludes a single-day to-do entirely outside the range", () => {
    expect(isToDoInRange(makeToDo("a", "2026-09-30"), range)).toBe(false);
    expect(isToDoInRange(makeToDo("a", "2026-09-01"), range)).toBe(false);
  });

  it("includes a to-do exactly on the range's boundary dates", () => {
    expect(isToDoInRange(makeToDo("a", "2026-09-21"), range)).toBe(true);
    expect(isToDoInRange(makeToDo("a", "2026-09-25"), range)).toBe(true);
  });

  it("includes a multi-day to-do that starts before the range and ends inside it", () => {
    expect(isToDoInRange(makeToDo("a", "2026-09-18", "2026-09-22"), range)).toBe(true);
  });

  it("includes a multi-day to-do that starts inside the range and ends after it", () => {
    expect(isToDoInRange(makeToDo("a", "2026-09-24", "2026-09-30"), range)).toBe(true);
  });

  it("includes a multi-day to-do that fully spans the range on both sides", () => {
    expect(isToDoInRange(makeToDo("a", "2026-09-01", "2026-09-30"), range)).toBe(true);
  });

  it("excludes a multi-day to-do that ends before the range starts", () => {
    expect(isToDoInRange(makeToDo("a", "2026-09-01", "2026-09-10"), range)).toBe(false);
  });

  it("filterToDosByRange keeps only the overlapping to-dos, in order", () => {
    const todos = [makeToDo("keep-1", "2026-09-22"), makeToDo("drop", "2026-09-30"), makeToDo("keep-2", "2026-09-25")];
    expect(filterToDosByRange(todos, range).map((t) => t.id)).toEqual(["keep-1", "keep-2"]);
  });

  it("filterToDosByRange with a null range (Schedule view) returns everything unfiltered", () => {
    const todos = [makeToDo("a", "2020-01-01"), makeToDo("b", "2099-12-31")];
    expect(filterToDosByRange(todos, null)).toEqual(todos);
  });
});

describe("groupToDosByDate", () => {
  it("groups by actionDate and sorts groups ascending by date", () => {
    const todos = [makeToDo("later", "2026-09-25"), makeToDo("earlier", "2026-09-20")];
    const groups = groupToDosByDate(todos);
    expect(groups.map((g) => g.date)).toEqual(["2026-09-20", "2026-09-25"]);
  });

  it("sorts items within a date group by notificationTime ascending", () => {
    const todos = [
      makeToDo("pm", "2026-09-25", null, "18:00"),
      makeToDo("am", "2026-09-25", null, "07:30"),
      makeToDo("noon", "2026-09-25", null, "12:00"),
    ];
    const [group] = groupToDosByDate(todos);
    expect(group.items.map((t) => t.id)).toEqual(["am", "noon", "pm"]);
  });

  it("a multi-day to-do is grouped only under its start date (actionDate) by default", () => {
    const todos = [makeToDo("spanning", "2026-09-20", "2026-09-25")];
    const groups = groupToDosByDate(todos);
    expect(groups).toHaveLength(1);
    expect(groups[0].date).toBe("2026-09-20");
  });

  it("returns an empty array for an empty input", () => {
    expect(groupToDosByDate([])).toEqual([]);
  });

  describe("expandRange=true — the grid layouts' own usage", () => {
    it("spans a multi-day to-do across every date from actionDate to toDate inclusive", () => {
      const todos = [makeToDo("spanning", "2026-09-20", "2026-09-23")];
      const groups = groupToDosByDate(todos, true);
      expect(groups.map((g) => g.date)).toEqual(["2026-09-20", "2026-09-21", "2026-09-22", "2026-09-23"]);
      expect(groups.every((g) => g.items[0].id === "spanning")).toBe(true);
    });

    it("still groups a single-day to-do (no toDate) under just its actionDate", () => {
      const todos = [makeToDo("single-day", "2026-09-20")];
      const groups = groupToDosByDate(todos, true);
      expect(groups).toHaveLength(1);
      expect(groups[0].date).toBe("2026-09-20");
    });

    it("lets a spanning to-do and a same-day one coexist correctly on a shared date", () => {
      const todos = [makeToDo("spanning", "2026-09-20", "2026-09-22"), makeToDo("one-off", "2026-09-21")];
      const groups = groupToDosByDate(todos, true);
      const middleDay = groups.find((g) => g.date === "2026-09-21");
      expect(middleDay?.items.map((t) => t.id).sort()).toEqual(["one-off", "spanning"]);
    });
  });
});

describe("enumerateRangeDates", () => {
  it("produces every date in an inclusive range, ascending", () => {
    expect(enumerateRangeDates({ start: "2026-09-23", end: "2026-09-25" })).toEqual([
      "2026-09-23",
      "2026-09-24",
      "2026-09-25",
    ]);
  });

  it("a single-day range produces exactly one date", () => {
    expect(enumerateRangeDates({ start: "2026-09-25", end: "2026-09-25" })).toEqual(["2026-09-25"]);
  });

  it("a Work Week range produces exactly 5 dates, a Week range exactly 7", () => {
    const workWeek = getDateRangeForMode("work_week", "2026-09-25")!;
    const week = getDateRangeForMode("week", "2026-09-25")!;
    expect(enumerateRangeDates(workWeek)).toHaveLength(5);
    expect(enumerateRangeDates(week)).toHaveLength(7);
  });
});
