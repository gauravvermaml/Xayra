/**
 * "Export my notes" (services/export/exportData.ts): the file's text, and
 * that it's written only to the folder the user picks — no copy in the
 * app's storage, nothing written when the picker is cancelled, a partial
 * file removed on failure. Synthetic notes only.
 */
const mockWrites: { uri: string; length: number }[] = [];
const mockDeletes: string[] = [];
const mockPicker = { granted: true, directoryUri: "content://picked/folder" };
let mockFailWrite = false;

jest.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///data/app/docs/",
  cacheDirectory: "file:///data/app/cache/",
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: jest.fn(async () => mockPicker),
    createFileAsync: jest.fn(async (dir: string, name: string) => `${dir}/${encodeURIComponent(name)}.txt`),
  },
  writeAsStringAsync: jest.fn(async (uri: string, text: string) => {
    if (mockFailWrite) throw new Error("disk full");
    mockWrites.push({ uri, length: text.length });
  }),
  deleteAsync: jest.fn(async (uri: string) => {
    mockDeletes.push(uri);
  }),
}));
jest.mock("../services/notes/noteManager", () => ({
  listNotes: jest.fn(async () => [
    { id: "n1", content: "Booked the dentist for Tuesday.", transcript: null, createdAt: Date.parse("2026-10-20T09:00:00Z") / 1000 },
    { id: "n2", content: "", transcript: "Water the plants.", createdAt: Date.parse("2026-10-22T18:30:00Z") / 1000 },
  ]),
}));
jest.mock("../services/todos/todoManager", () => ({
  listAllToDos: jest.fn(async () => [
    { id: "t1", text: "Call Mum", actionDate: "2026-10-25", toDate: null, notificationTime: "09:00", isCompleted: false, recurrence: "weekly", recurrenceInterval: 2, createdAt: "", noteId: null, googleCalendarEventId: null },
    { id: "t2", text: "Pay rent", actionDate: "2026-10-23", toDate: null, notificationTime: "08:00", isCompleted: true, recurrence: "none", recurrenceInterval: 1, createdAt: "", noteId: null, googleCalendarEventId: null },
  ]),
}));

import { exportFileName, exportToChosenFolder, formatExport } from "../services/export/exportData";

beforeEach(() => {
  mockWrites.length = 0;
  mockDeletes.length = 0;
  mockPicker.granted = true;
  mockFailWrite = false;
});

describe("export file", () => {
  it("lists notes newest first, then to-dos, and says it isn't encrypted", async () => {
    const { listNotes } = require("../services/notes/noteManager");
    const { listAllToDos } = require("../services/todos/todoManager");
    const text = formatExport(await listNotes(), await listAllToDos(), new Date(2026, 9, 23, 14, 5));
    expect(text).toMatch(/^Xayra export\nCreated 2026-10-23 14:05\. This file is not encrypted\./);
    expect(text.indexOf("Water the plants.")).toBeLessThan(text.indexOf("Booked the dentist"));
    expect(text).toContain("NOTES (2)");
    expect(text).toContain("TO-DOS (2)");
    expect(text).toContain("[x] Pay rent (2026-10-23 at 08:00)");
    expect(text).toContain("[ ] Call Mum (2026-10-25 at 09:00, repeats every 2 weeks)");
  });

  it("names the file by date", () => {
    expect(exportFileName(new Date(2026, 9, 23))).toBe("Xayra export 2026-10-23");
  });
});

describe("export privacy", () => {
  it("writes only into the folder the user picked — never the app's own storage or cache", async () => {
    expect(await exportToChosenFolder(new Date(2026, 9, 23))).toEqual({ kind: "saved", notes: 2, todos: 2 });
    expect(mockWrites).toHaveLength(1);
    expect(mockWrites[0].uri.startsWith("content://picked/folder/")).toBe(true);
    expect(mockWrites.some((w) => w.uri.startsWith("file:///data/app/"))).toBe(false);
  });

  it("cancelling the folder picker writes nothing", async () => {
    mockPicker.granted = false;
    expect(await exportToChosenFolder()).toEqual({ kind: "cancelled" });
    expect(mockWrites).toEqual([]);
  });

  it("a failed write removes the partly created file instead of leaving it", async () => {
    mockFailWrite = true;
    expect(await exportToChosenFolder(new Date(2026, 9, 23))).toEqual({ kind: "failed" });
    expect(mockDeletes).toEqual(["content://picked/folder/Xayra%20export%202026-10-23.txt"]);
  });

  it("the export code never uploads or shares anything by itself", () => {
    const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "services", "export", "exportData.ts"), "utf8");
    expect(src).not.toMatch(/fetch\(|Share\.|Sharing|uploadAsync|drive|console\.(log|warn|error)/);
  });
});
